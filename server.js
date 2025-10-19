require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
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

// ===== Minimal CORS fix =====
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
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
  idVerifications: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0"
};

// ===== Stripe helper =====
async function createCheckoutSession(amount) {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [{ price_data: { currency: "usd", product_data: { name: "JoyFund Donation" }, unit_amount: amount * 100 }, quantity: 1 }],
    mode: "payment",
    success_url: process.env.SUCCESS_URL || "http://localhost:3000",
    cancel_url: process.env.CANCEL_URL || "http://localhost:3000",
  });
  return session.url;
}

// ===== Multer (File Upload) =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ===== Helper Functions =====
async function saveToSheet(sheetId, sheetName, values) {
  return sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

async function readSheet(sheetId, range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  return res.data.values || [];
}

// ===== User Helpers =====
async function saveUser({ name, email, password }) {
  const hash = await bcrypt.hash(password, 10);
  await saveToSheet(SPREADSHEET_IDS.users, "Users", [new Date().toISOString(), name, email, hash, "false"]);
}

async function verifyUser(email, password) {
  const users = await readSheet(SPREADSHEET_IDS.users, "Users!A:E");
  const userRow = users.find(u => u[2]?.toLowerCase() === email.toLowerCase());
  if (!userRow) return false;

  const match = await bcrypt.compare(password, userRow[3]);
  if (!match) return false;

  // ID verification status
  const verifications = await readSheet(SPREADSHEET_IDS.idVerifications, "ID_Verifications!A:D");
  const userVer = verifications.filter(v => v[1]?.toLowerCase() === email.toLowerCase());
  const latest = userVer.length ? userVer[userVer.length - 1] : null;
  const status = latest ? latest[3] : "Not submitted";

  return { name: userRow[1], email: userRow[2], verificationStatus: status, verified: status === "Approved" };
}

// ===== Auth Routes =====
app.post("/api/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ success: false, message: "All fields required." });
    await saveUser({ name, email, password });
    res.json({ success: true, message: "Account created!" });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: "Error creating account." }); }
});

app.post("/api/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, error: "Email & password required." });

    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ success: false, error: "Invalid credentials." });

    req.session.user = user;
    await new Promise(r => req.session.save(r));

    res.json({ success: true, profile: user, message: user.verified ? "Signed in successfully!" : "Signed in! Pending verification." });
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: "Server error." }); }
});

// Check session
app.get("/api/check-session", (req, res) => {
  if (req.session.user) return res.json({ loggedIn: true, profile: req.session.user });
  res.json({ loggedIn: false });
});

// Auth check (frontend expects this)
app.get("/api/auth/check", (req, res) => {
  if (req.session.user) return res.json({ loggedIn: true, profile: req.session.user });
  res.json({ loggedIn: false });
});

// Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ success: false, error: "Logout failed." });
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

// ===== Profile Routes =====
app.get("/api/profile", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated" });
  res.json({ success: true, profile: req.session.user });
});

app.post("/api/profile/update", async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated" });
    const { name, email, password } = req.body;
    // For simplicity, just update session (in production, update Google Sheet)
    if (name) req.session.user.name = name;
    if (email) req.session.user.email = email;
    if (password) req.session.user.password = await bcrypt.hash(password, 10);
    await new Promise(r => req.session.save(r));
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

app.delete("/api/delete-account", async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated" });
    // TODO: remove from Google Sheets
    req.session.destroy(err => {
      if (err) return res.status(500).json({ success: false, error: "Delete failed" });
      res.clearCookie("connect.sid");
      res.json({ success: true });
    });
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// ===== Campaign Routes =====
app.get("/api/my-campaigns", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated" });
  // TODO: fetch campaigns from Google Sheets filtered by req.session.user.email
  res.json({ campaigns: [] });
});

app.delete("/api/campaign/:id", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated" });
  // TODO: delete campaign by ID in Google Sheet
  res.json({ success: true });
});

// ===== Donations =====
app.post("/api/create-checkout-session", async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ success: false, error: "Invalid amount" });
  try {
    const url = await createCheckoutSession(amount);
    res.json({ url });
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: "Stripe error" }); }
});

// ===== Waitlist Submission =====
app.post("/api/waitlist", async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ success: false, error: "Name & email required" });
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [new Date().toISOString(), name, email]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// ===== ID Verification =====
app.get("/api/id-verification-status", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated" });
  // TODO: fetch latest ID verification status from Google Sheets
  res.json({ success: true, status: "Not submitted", idPhotoUrl: "" });
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
