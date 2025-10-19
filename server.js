require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const sgMail = require("@sendgrid/mail");
const Stripe = require("stripe");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

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

// ===== Minimal CORS fix (handles preflight & credentials) =====
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/uploads", express.static(uploadsDir));

// ===== Session =====
app.set("trust proxy", 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    collectionName: "sessions",
  }),
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24,
  }
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
};

// ===== SendGrid =====
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ===== Helper Functions =====
async function saveToSheet(sheetId, sheetName, values) {
  try {
    return sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:Z`,
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });
  } catch (err) {
    console.error("Google Sheets error:", err);
    throw err;
  }
}

// ===== Multer (File Upload) =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

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
  const { data: userData } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!A:E",
  });

  const userRow = (userData.values || []).find(
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
}

// ===== AUTH ROUTES =====
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ success: false, message: "All fields required." });

  try {
    await saveUser({ name, email, password });
    res.json({ success: true, message: "Account created!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error creating account." });
  }
});

app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, error: "Email & password required." });

  try {
    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ success: false, error: "Invalid credentials." });

    req.session.user = user;
    await new Promise(r => req.session.save(r));

    const message = user.verified
      ? "Signed in successfully!"
      : "Signed in! ⚠️ Your account is pending ID verification.";

    res.json({ success: true, message, profile: user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Server error." });
  }
});

// ===== CHECK SESSION =====
app.get("/api/check-session", (req, res) => {
  if (req.session.user) {
    return res.json({ loggedIn: true, profile: req.session.user });
  } else {
    return res.json({ loggedIn: false });
  }
});

// ===== LOGOUT =====
app.post("/api/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ success: false, message: "Logout failed" });
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

// ===== ID VERIFICATION =====
app.post("/api/verify-id", upload.single("idPhoto"), async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });

    if (!req.file) {
      return res.status(400).json({ success: false, message: "ID photo required" });
    }

    // ✅ Use session user info instead of body
    const { name, email } = req.session.user;
    const photoUrl = `/uploads/${req.file.filename}`;

    await saveToSheet(SPREADSHEET_IDS.users, "ID_Verifications", [
      new Date().toISOString(),
      email,
      name,
      "Pending",
      photoUrl
    ]);

    // Update session
    req.session.user.verificationStatus = "Pending";
    req.session.user.verified = false;
    await new Promise(r => req.session.save(r));

    res.json({ success: true, message: "ID submitted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== PROFILE UPDATE =====
app.post("/api/profile/update", async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });

    const { name, email, password } = req.body;
    const hashed = password ? await bcrypt.hash(password, 10) : null;
    await saveToSheet(SPREADSHEET_IDS.users, "Users", [
      new Date().toISOString(),
      name,
      email,
      hashed || "",
      "false"
    ]);

    req.session.user.name = name;
    req.session.user.email = email;
    await new Promise(r => req.session.save(r));

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== DELETE ACCOUNT =====
app.delete("/api/delete-account", async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
    req.session.destroy(err => {
      if (err) return res.status(500).json({ success: false, message: "Delete failed" });
      res.clearCookie("connect.sid");
      res.json({ success: true });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== CAMPAIGNS =====
app.get("/api/my-campaigns", async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });

    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:H",
    });

    const campaigns = (data.values || []).map(r => ({
      id: r[0],
      title: r[1],
      description: r[2],
      status: r[3],
      imageUrl: r[4],
      createdAt: r[5],
      ownerEmail: r[6],
    })).filter(c => c.ownerEmail.toLowerCase() === req.session.user.email.toLowerCase());

    res.json({ success: true, campaigns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.delete("/api/campaign/:id", async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
    const campaignId = req.params.id;

    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      new Date().toISOString(),
      "Deleted",
      "",
      "Deleted",
      "",
      "",
      req.session.user.email
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== CREATE CAMPAIGN =====
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
    if (!req.session.user.verified) return res.status(403).json({ success: false, message: "ID verification required" });

    const { title, description } = req.body;
    if (!title || !description) return res.status(400).json({ success: false, message: "Title & description required" });

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : "";

    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      Date.now(),
      title,
      description,
      "Pending",
      imageUrl,
      new Date().toISOString(),
      req.session.user.email
    ]);

    res.json({ success: true, message: "Campaign created!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
