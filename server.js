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

// ===== CORS =====
// ===== Allowed Origins =====
const allowedOrigins = [
  "https://fundasmile.net",
  "https://www.fundasmile.net",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
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

// ===== Serve uploads and public =====
// ===== Serve uploads folder and public =====
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "public")));

// ===== Session =====
app.set("trust proxy", 1);
app.use(
  session({
    secret: process.env.SESSION_SECRET || "supersecretkey",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    },
  })
);
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
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
  campaigns: "1XSS-2WJpzEhDe6RHBb8rt_6NNWNqdFpVTUsRa3TNCG8",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
  donations: "1C_xhW-dh3yQ7MpSoDiUWeCC2NNVWaurggia-f1z0YwA",
  volunteers: "1fCvuVLlPr1UzPaUhIkWMiQyC0pOGkBkYo-KkPshwW7s",
  iD_Verifications: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
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
async function getSheetValues(sheetId, range) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });
  return data.values || [];
}
function rowsToObjects(values) {
  if (!values || values.length < 1) return [];
  const headers = values[0];
  return values.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i] || ""));
    return obj;
  });
}

// ===== Multer (File Upload) =====
// ===== Multer =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ===== USER SIGNUP / SIGNIN / SESSION / LOGOUT =====
// ... (keep all routes exactly as they were when donations worked)
// No changes here — these are fully compatible with your frontend
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

// ===== WAITLIST / VOLUNTEER / CAMPAIGNS =====
app.post("/api/campaigns", upload.single("image"), async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ success: false, message: "You must be signed in to create a campaign" });
  await sendEmail({
    to: process.env.EMAIL_FROM,
    subject: `New Signup: ${name}`,
    text: `New user signed up:\nName: ${name}\nEmail: ${email}`,
    html: `<p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p>`,
  });
}

  const { name, email, title, description, goal } = req.body;
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

  // ===== Check if user's ID is approved =====
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
    const idValues = await getSheetValues(SPREADSHEET_IDS.iD_Verifications, "ID_Verifications!A:E");
    const verifications = rowsToObjects(idValues);
    const userVerification = verifications.find(
      (v) => v.Email.toLowerCase() === req.session.user.email.toLowerCase()
    );

    if (!userVerification || userVerification.Status !== "Approved") {
      return res
        .status(403)
        .json({ success: false, message: "You must have an approved ID to create a campaign" });
    }
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

    req.session.user = user;
    req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30; // 30 days
    req.session.save(() => res.json({ success: true, profile: user }));
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

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : "";
    const date = new Date().toLocaleString();
    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      date,
      name,
      email,
      campaignId, // Id
      title,
      description,
      creatorEmail,
      goal,
      imageUrl,
      description,
      category,
      "Pending",
      createdAt, // now separate column
      imageUrl
    ]);

    res.json({ success: true, message: "Campaign submitted successfully" });
    res.json({ success: true, campaignId }); 
  } catch (err) {
    console.error("create-campaign error:", err);
    res.status(500).json({ success: false, message: "Failed to create campaign." });
  }
});

// ===== Get All Campaigns =====
app.get("/api/campaigns", async (req, res) => {
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:I", 
    });

    const allCampaigns = (data.values || []).map(row => ({
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
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:I", 
    });

    const userCampaigns = (data.values || [])
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

// ===== Waitlist =====
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
    console.error("Campaign error:", err);
    res.status(500).json({ success: false, message: "Error saving campaign" });
    console.error("Waitlist error:", err);
    res.status(500).json({ success: false });
  }
});

// ===== DONATIONS & CHECKOUT =====
// Keep exactly as it was when your index.html donations were working
// This preserves compatibility with the "Donate to our Mission" button
// ===== NEW: Stripe Donation Route =====
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  const { campaignId } = req.params;
  const { amount, donorEmail } = req.body;
  const { amount, successUrl, cancelUrl } = req.body;

  if (!amount) return res.status(400).json({ success: false, message: "Missing fields" });
  if (!campaignId || !amount || !successUrl || !cancelUrl) {
    return res.status(400).json({ success: false, message: "Missing required fields." });
  }

  try {
    const donationAmount = Math.round(parseFloat(amount) * 100); // cents

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: campaignId === "mission" ? "General JoyFund Donation" : `Donation to Campaign ${campaignId}` },
            unit_amount: Math.round(amount * 100),
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: `Donation to Campaign ID: ${campaignId}`,
          },
          quantity: 1,
          unit_amount: donationAmount,
        },
      ],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL || "https://fundasmile.net"}/thankyou.html`,
      cancel_url: `${process.env.FRONTEND_URL || "https://fundasmile.net"}/index.html`,
      customer_email: donorEmail,
        quantity: 1,
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { campaignId, amount: donationAmount },
    });

    res.json({ success: true, sessionId: session.id });
  } catch (err) {
    console.error("Checkout session error:", err);
    res.status(500).json({ success: false, message: "Checkout session failed" });
    console.error("create-checkout-session error:", err);
    res.status(500).json({ success: false, message: "Failed to create checkout session." });
  }
});

// ===== Other routes (waitlist, volunteers, etc.) =====
// Keep unchanged exactly as they were
// ===== NEW: Log Donation =====
app.post("/api/log-donation", async (req, res) => {
  const { campaignId, title, amount, timestamp } = req.body;
  if (!campaignId || !amount || !timestamp || !title) {
    return res.status(400).json({ success: false, message: "Missing donation fields." });
  }

// ===== Catch-All =====
app.all("/api/*", (req, res) => res.status(404).json({ success: false, message: "API route not found" }));
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

// ===== Catch-all API 404 =====
app.all("/api/*", (req, res) =>
  res.status(404).json({ success: false, message: "API route not found" })
);

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));