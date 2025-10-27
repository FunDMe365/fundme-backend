require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const sgMail = require("@sendgrid/mail");
const Stripe = require("stripe");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;

// ===== Ensure uploads folder exists =====
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ===== Stripe Setup =====
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ===== Allowed Origins =====
const allowedOrigins = [
  "https://fundasmile.net",
  "https://www.fundasmile.net",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

// ===== CORS =====
const corsOptions = {
  origin: function(origin, callback) {
    if (!origin) return callback(null, true); // allow curl or mobile apps
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // handle global preflight

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Serve uploads folder and public =====
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "public")));

// ===== Session =====
app.set("trust proxy", 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24 * 30, // persist 30 days until logout
  },
}));

// ===== Google Sheets =====
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON || "{}"),
  scopes: SCOPES,
});
const sheets = google.sheets({ version: "v4", auth });

const SPREADSHEET_IDS = {
  users: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
  campaigns: "1XSS-2WJpzEhDe6RHBb8rt_6NNWNqdFpVTUsRa3TNCG8",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
  donations: "1C_xhW-dh3yQ7MpSoDiUWeCC2NNVWaurggia-f1z0YwA",
  idVerifications: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
};

// ===== SendGrid =====
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const sendEmail = async ({ to, subject, text, html }) => {
  if (!process.env.SENDGRID_API_KEY || !process.env.EMAIL_FROM) return;
  try {
    await sgMail.send({ to, from: process.env.EMAIL_FROM, subject, text, html });
    console.log(`✅ Email sent to ${to}`);
  } catch (err) {
    console.error("SendGrid error:", err);
  }
};

// ===== Helper Functions =====
async function saveToSheet(sheetId, sheetName, values) {
  return sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

// convert rows (array-of-arrays) to array of objects using header row
function rowsToObjects(values) {
  if (!values || values.length < 1) return [];
  const headers = values[0].map(h => (h || "").toString().trim());
  const rows = values.slice(1).map(r => r.map(c => (c || "").toString().trim()))
    .filter(r => r.some(c => c !== ""));
  return rows.map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h || `col${i}`] = r[i] || "");
    return obj;
  });
}

// helper to get sheet values
async function getSheetValues(sheetId, range) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });
  return data.values || [];
}

// ===== Multer =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ===== Admin detection =====
// Set ADMIN_EMAILS environment variable to a comma-separated list of admin emails (lowercased)
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// middleware to require admin
function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
  if (!req.session.user.isAdmin) return res.status(403).json({ success: false, message: "Admin access required" });
  next();
}

// ===== User Helpers =====
async function saveUser({ name, email, password }) {
  const hash = await bcrypt.hash(password, 10);
  await saveToSheet(SPREADSHEET_IDS.users, "Users", [
    new Date().toISOString(),
    name,
    email,
    hash,
    "false"
  ]);

  await sendEmail({
    to: process.env.EMAIL_FROM,
    subject: `New Signup: ${name}`,
    text: `New user signed up:\nName: ${name}\nEmail: ${email}`,
    html: `<p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p>`,
  });
}

async function verifyUser(email, password) {
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "Users!A:E",
    });
    const allUsers = data.values || [];
    const userRow = allUsers.find((r) => r[2]?.toLowerCase() === email.toLowerCase());
    if (!userRow) return false;
    const passwordMatch = await bcrypt.compare(password, userRow[3]);
    if (!passwordMatch) return false;

    // Check verification status
    const { data: verData } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "ID_Verifications!A:E",
    });
    const verRows = (verData.values || []).filter((r) => r[1]?.toLowerCase() === email.toLowerCase());
    const latestVer = verRows.length ? verRows[verRows.length - 1] : null;
    const verificationStatus = latestVer ? latestVer[3] : "Not submitted";
    const verified = verificationStatus === "Approved";

    return { name: userRow[1], email: userRow[2], verified, verificationStatus };
  } catch (err) {
    console.error("verifyUser error:", err);
    return false;
  }
}

// ===== Auth Routes =====
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ success: false, message: "All fields required." });
  try {
    await saveUser({ name, email, password });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ===== Preflight fix for signin =====
app.options("/api/signin", cors(corsOptions));

app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: "Email and password required." });
  try {
    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ success: false, message: "Invalid credentials" });

    // detect admin
    const isAdmin = ADMIN_EMAILS.includes(email.toLowerCase());
    const sessionUser = { ...user, isAdmin };
    req.session.user = sessionUser;
    req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30; // 30 days
    req.session.save(() => res.json({ success: true, profile: sessionUser }));
  } catch (err) {
    console.error("signin error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ===== Signout =====
app.post("/api/signout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ===== Check Session =====
app.get("/api/check-session", (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

// ===== Get Verifications =====
app.get("/api/get-verifications", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });

  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "ID_Verifications!A:E",
    });

    const allVerifications = (data.values || [])
      .filter(r => r[1]?.toLowerCase() === req.session.user.email.toLowerCase())
      .map(r => ({
        id: r[0],
        email: r[1],
        submittedAt: r[2],
        status: r[3],
        note: r[4] || "",
      }));

    res.json({ success: true, verifications: allVerifications });
  } catch (err) {
    console.error("get-verifications error:", err);
    res.status(500).json({ success: false, verifications: [] });
  }
});

// ===== ID Verification Submission =====
app.post("/api/verify-id", upload.single("idDocument"), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
  const file = req.file;
  if (!file) return res.status(400).json({ success: false, message: "ID document is required." });

  try {
    const fileUrl = `/uploads/${file.filename}`;
    const now = new Date().toISOString();

    await saveToSheet(SPREADSHEET_IDS.users, "ID_Verifications", [
      now,
      req.session.user.email,
      now,
      "Pending",
      fileUrl
    ]);

    res.json({ success: true, message: "ID submitted successfully." });
  } catch (err) {
    console.error("verify-id error:", err);
    res.status(500).json({ success: false, message: "Failed to submit ID." });
  }
});

// ===== Create Campaign (updated column order) =====
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });

  const { title, creatorEmail, goal, category, description } = req.body;
  const imageFile = req.file;

  if (!title || !creatorEmail || !goal || !category || !description) {
    return res.status(400).json({ success: false, message: "All fields are required." });
  }

  try {
    const imageUrl = imageFile ? `/uploads/${imageFile.filename}` : "";
    const campaignId = `CAMP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const createdAt = new Date().toISOString();

    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      campaignId, // Id
      title,
      creatorEmail,
      goal,
      description,
      category,
      "Pending",
      createdAt, // now separate column
      imageUrl
    ]);

    res.json({ success: true, campaignId }); 
  } catch (err) {
    console.error("create-campaign error:", err);
    res.status(500).json({ success: false, message: "Failed to create campaign." });
  }
});

// ===== Get All Campaigns (public) =====
app.get("/api/campaigns", async (req, res) => {
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.campaigns, "Campaigns!A:I");
    const allCampaigns = (values || []).map(row => ({
      id: row[0],
      title: row[1],
      email: row[2],
      goal: row[3],
      description: row[4],
      category: row[5],
      status: row[6],
      createdAt: row[7],
      imageUrl: row[8] || "",
    }));

    res.json({ success: true, campaigns: allCampaigns });
  } catch (err) {
    console.error("get-campaigns error:", err);
    res.status(500).json({ success: false, campaigns: [] });
  }
});

// ===== NEW: Manage Campaigns (user-specific) =====
app.get("/api/manage-campaigns", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.campaigns, "Campaigns!A:I");
    const userCampaigns = (values || [])
      .filter(row => row[2]?.toLowerCase() === req.session.user.email.toLowerCase())
      .map(row => ({
        id: row[0],
        title: row[1],
        email: row[2],
        goal: row[3],
        description: row[4],
        category: row[5],
        status: row[6],
        createdAt: row[7],
        imageUrl: row[8] || "",
      }));

    res.json({ success: true, campaigns: userCampaigns });
  } catch (err) {
    console.error("manage-campaigns error:", err);
    res.status(500).json({ success: false, campaigns: [] });
  }
});

// ===== Waitlist submission (public) =====
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email) return res.status(400).json({ success: false, message: "Name and email required." });

  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [
      new Date().toISOString(),
      name,
      email,
      source || "",
      reason || ""
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error("Waitlist error:", err);
    res.status(500).json({ success: false });
  }
});

// ===== NEW: Stripe Donation Route =====
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  const { campaignId } = req.params;
  const { amount, successUrl, cancelUrl } = req.body;

  if (!campaignId || !amount || !successUrl || !cancelUrl) {
    return res.status(400).json({ success: false, message: "Missing required fields." });
  }

  try {
    const donationAmount = Math.round(parseFloat(amount) * 100); // cents

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: `Donation to Campaign ID: ${campaignId}`,
          },
          unit_amount: donationAmount,
        },
        quantity: 1,
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { campaignId, amount: donationAmount },
    });

    res.json({ success: true, sessionId: session.id });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    res.status(500).json({ success: false, message: "Failed to create checkout session." });
  }
});

// ===== NEW: Log Donation =====
app.post("/api/log-donation", async (req, res) => {
  const { campaignId, title, amount, timestamp } = req.body;
  if (!campaignId || !amount || !timestamp || !title) {
    return res.status(400).json({ success: false, message: "Missing donation fields." });
  }

  try {
    await saveToSheet(SPREADSHEET_IDS.donations, "Donations", [
      timestamp,
      campaignId,
      title,
      amount
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("log-donation error:", err);
    res.status(500).json({ success: false, message: "Failed to log donation." });
  }
});

// ===== ADMIN: Get campaigns (admin) =====
app.get("/api/admin/campaigns", requireAdmin, async (req, res) => {
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.campaigns, "Campaigns!A:I");
    const campaigns = (values || []).map(row => ({
      id: row[0],
      title: row[1],
      email: row[2],
      goal: row[3],
      description: row[4],
      category: row[5],
      status: row[6],
      createdAt: row[7],
      imageUrl: row[8] || "",
    }));
    res.json({ success: true, campaigns });
  } catch (err) {
    console.error("admin get campaigns error:", err);
    res.status(500).json({ success: false, campaigns: [] });
  }
});

// ===== ADMIN: Update campaign status (approve/reject) =====
app.put("/api/admin/campaign/:id/status", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!id || !status) return res.status(400).json({ success: false, message: "Missing id or status" });

  try {
    const values = await getSheetValues(SPREADSHEET_IDS.campaigns, "Campaigns!A:I");
    const rows = values || [];
    const rowIndex = rows.findIndex(row => row[0] === id);
    if (rowIndex === -1) return res.status(404).json({ success: false, message: "Campaign not found" });

    // Update status column (index 6)
    rows[rowIndex][6] = status;

    // Write back the single row (A..I)
    const sheetRowNumber = rowIndex + 1; // sheet rows are 1-indexed
    const range = `Campaigns!A${sheetRowNumber}:I${sheetRowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [rows[rowIndex]] },
    });

    res.json({ success: true, message: "Status updated" });
  } catch (err) {
    console.error("admin update campaign status error:", err);
    res.status(500).json({ success: false, message: "Failed to update campaign status" });
  }
});

// ===== ADMIN: Get donations =====
app.get("/api/admin/donations", requireAdmin, async (req, res) => {
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.donations, "Donations!A:D");
    // Expecting rows: timestamp, campaignId, title, amount
    const donations = (values || []).map(row => ({
      timestamp: row[0] || "",
      campaignId: row[1] || "",
      title: row[2] || "",
      amount: row[3] || "",
    }));
    res.json({ success: true, donations });
  } catch (err) {
    console.error("admin get donations error:", err);
    res.status(500).json({ success: false, donations: [] });
  }
});

// ===== ADMIN: Get users (admin) =====
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.users, "Users!A:Z");
    const users = rowsToObjects(values);
    res.json({ success: true, users });
  } catch (err) {
    console.error("admin get users error:", err);
    res.status(500).json({ success: false, users: [] });
  }
});

// ===== ADMIN: Get volunteers (admin) =====
app.get("/api/admin/volunteers", requireAdmin, async (req, res) => {
  try {
    // You previously referenced a volunteers sheet client-side; if you have an ID, add it to SPREADSHEET_IDS or adjust here
    const VOLUNTEERS_SHEET_ID = process.env.VOLUNTEERS_SHEET_ID || null;
    if (!VOLUNTEERS_SHEET_ID) return res.json({ success: true, volunteers: [] });

    const values = await getSheetValues(VOLUNTEERS_SHEET_ID, "Sheet1!A:Z");
    const volunteers = rowsToObjects(values);
    res.json({ success: true, volunteers });
  } catch (err) {
    console.error("admin get volunteers error:", err);
    res.status(500).json({ success: false, volunteers: [] });
  }
});

// ===== ADMIN: Get waitlist (admin) =====
app.get("/api/admin/waitlist", requireAdmin, async (req, res) => {
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.waitlist, "Waitlist!A:Z");
    const waitlist = rowsToObjects(values);
    res.json({ success: true, waitlist });
  } catch (err) {
    console.error("admin get waitlist error:", err);
    res.status(500).json({ success: false, waitlist: [] });
  }
});

// ===== Catch-all API 404 =====
app.all("/api/*", (req, res) =>
  res.status(404).json({ success: false, message: "API route not found" })
);

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
