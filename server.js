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
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
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

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Serve uploads folder correctly =====
app.use("/uploads", express.static(uploadsDir));

// Serve public folder
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
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

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
};

// ===== SendGrid =====
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ===== Helper Functions =====
async function saveToSheet(sheetId, sheetName, values) {
  return sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

// ===== Multer =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ===== Image URL Helper =====
function getImageUrl(sheetValue) {
  if (!sheetValue || sheetValue.trim() === "") return "";
  const filename = path.basename(sheetValue);
  const filePath = path.join(uploadsDir, filename);
  if (fs.existsSync(filePath)) return `/uploads/${filename}`;
  return "";
}

// ===== User Helpers =====
async function saveUser({ name, email, password }) {
  const hash = await bcrypt.hash(password, 10);
  await saveToSheet(SPREADSHEET_IDS.users, "Users", [
    new Date().toISOString(),
    name,
    email,
    hash,
    "false",
  ]);
}

async function verifyUser(email, password) {
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "Users!A:E",
    });
    const allUsers = data.values || [];
    const userRow = allUsers.find(
      (r) => r[2]?.toLowerCase() === email.toLowerCase()
    );
    if (!userRow) return false;

    const passwordMatch = await bcrypt.compare(password, userRow[3]);
    if (!passwordMatch) return false;

    const { data: verData } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "ID_Verifications!A:D",
    });
    const verRows = (verData.values || []).filter(
      (r) => r[1]?.toLowerCase() === email.toLowerCase()
    );
    const latestVer = verRows.length ? verRows[verRows.length - 1] : null;
    const verificationStatus = latestVer ? latestVer[3] : "Not submitted";
    const verified = verificationStatus === "Approved";

    return {
      name: userRow[1],
      email: userRow[2],
      verified,
      verificationStatus,
    };
  } catch (err) {
    console.error("verifyUser error:", err);
    return false;
  }
}

// ===== Auth Routes =====
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res
      .status(400)
      .json({ success: false, message: "All fields required." });
  try {
    await saveUser({ name, email, password });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  const user = await verifyUser(email, password);
  if (!user)
    return res
      .status(401)
      .json({ success: false, message: "Invalid credentials" });
  req.session.user = user;
  await new Promise((r) => req.session.save(r));
  res.json({ success: true, profile: user });
});

app.get("/api/check-session", (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, profile: req.session.user });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ success: false });
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

// ===== Waitlist =====
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email || !source || !reason)
    return res
      .status(400)
      .json({ success: false, message: "All fields are required." });

  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [
      new Date().toISOString(),
      name,
      email,
      source,
      reason,
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error("Waitlist save error:", err);
    res.status(500).json({ success: false, message: "Failed to submit waitlist." });
  }
});

// ===== Volunteer / Street Team =====
app.post("/api/volunteer", async (req, res) => {
  const { name, email, role, message } = req.body;
  if (!name || !email || !role || !message)
    return res
      .status(400)
      .json({ success: false, message: "All fields are required." });

  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Volunteers", [
      new Date().toISOString(),
      name,
      email,
      role,
      message,
    ]);
    res.json({ success: true, message: "Thank you for volunteering!" });
  } catch (err) {
    console.error("Volunteer submission error:", err);
    res.status(500).json({ success: false, message: "Failed to submit. Try again later." });
  }
});

// ===== My campaigns (user only) =====
app.get("/api/my-campaigns", async (req, res) => {
  try {
    if (!req.session.user)
      return res.status(401).json({ success: false, message: "Not logged in" });

    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:I",
    });

    const campaigns = (data.values || [])
      .filter((row) => row[2] === req.session.user.email)
      .map((row) => ({
        id: row[0],
        title: row[1],
        goal: row[3],
        description: row[4],
        category: row[5],
        status: row[6] || "Pending",
        created: row[7],
        image: getImageUrl(row[8]),
      }));

    res.json({ success: true, campaigns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to load campaigns" });
  }
});

// ===== Manage single campaign =====
app.get("/api/manage-campaign/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:I",
    });

    const row = (data.values || []).find((r) => r[0] === id);
    if (!row) return res.status(404).json({ success: false, message: "Campaign not found" });

    res.json({
      success: true,
      campaign: {
        id: row[0],
        title: row[1],
        goal: row[3],
        description: row[4],
        category: row[5],
        status: row[6],
        created: row[7],
        image: getImageUrl(row[8]),
      },
    });
  } catch (err) {
    console.error("Manage campaign fetch error:", err);
    res.status(500).json({ success: false, message: "Error loading campaign" });
  }
});

// ===== Delete Campaign =====
app.delete("/api/campaign/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:I",
    });

    const rows = data.values || [];
    const index = rows.findIndex((r) => r[0] === id);
    if (index === -1) return res.status(404).json({ success: false, message: "Not found" });

    const emptyRow = new Array(rows[index].length).fill("");
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: `Campaigns!A${index + 1}:I${index + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: [emptyRow] },
    });

    res.json({ success: true, message: "Campaign deleted successfully." });
  } catch (err) {
    console.error("Delete campaign error:", err);
    res.status(500).json({ success: false, message: "Error deleting campaign." });
  }
});

// ===== Member Since =====
app.get("/api/member-since", async (req, res) => {
  try {
    if (!req.session.user)
      return res.status(401).json({ success: false, message: "Not logged in" });

    const { email } = req.session.user;
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "Users!A:E",
    });

    const userRow = (data.values || []).find((r) => r[2] === email);
    if (!userRow) return res.json({ success: false, message: "User not found" });

    res.json({ success: true, memberSince: userRow[0] });
  } catch (err) {
    console.error("Member since fetch error:", err);
    res.status(500).json({ success: false });
  }
});

// ===== Public approved campaigns =====
app.get("/api/campaigns", async (req, res) => {
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:I",
    });

    const campaigns = (data.values || []).map((row) => ({
      id: row[0],
      title: row[1],
      creatorEmail: row[2],
      goal: row[3],
      description: row[4],
      category: row[5],
      status: row[6] || "Pending",
      created: row[7],
      image: getImageUrl(row[8]),
    }));

    const approved = campaigns.filter(
      (c) => (c.status || "").trim().toLowerCase() === "approved"
    );

    res.json({ success: true, campaigns: approved });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to load campaigns" });
  }
});

// ===== Create Campaign =====
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  const { title, goal, description, category, creatorEmail } = req.body;
  if (!title || !goal || !description || !category || !creatorEmail)
    return res.status(400).json({ success: false, message: "All fields are required." });

  let imageUrl = "";
  if (req.file) imageUrl = `uploads/${req.file.filename}`;

  try {
    const id = Date.now().toString();
    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      id,
      title,
      creatorEmail,
      goal,
      description,
      category,
      "Pending",
      new Date().toISOString(),
      imageUrl,
    ]);
    res.json({ success: true, message: "Campaign created successfully!", id });
  } catch (err) {
    console.error("Error creating campaign:", err);
    res.status(500).json({ success: false, message: "Failed to create campaign." });
  }
});

// ===== Stripe Checkout =====
app.post("/api/create-checkout-session/:id", async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;

  if (!amount || amount < 1)
    return res.status(400).json({ success: false, message: "Invalid donation amount." });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: `Donation for ${id}` },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: "https://www.fundasmile.net/thankyou.html",
      cancel_url: "https://www.fundasmile.net/cancel.html",
    });

    res.json({ id: session.id });
  } catch (error) {
    console.error("Stripe live session error:", error);
    res.status(500).json({ success: false, message: "Unable to process donation at this time." });
  }
});

// ===== Catch-all for API 404 =====
app.all("/api/*", (req, res) => {
  res.status(404).json({ success: false, message: "API route not found" });
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
