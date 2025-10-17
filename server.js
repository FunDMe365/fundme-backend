require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 5000;

// ===== Ensure uploads folder exists =====
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ===== CORS =====
const allowedOrigins = [
  "https://fundasmile.net",
  "https://www.fundasmile.net",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

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
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24,
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
};

// ===== Helper =====
async function saveToSheet(sheetId, sheetName, values) {
  try {
    return await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:Z`,
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });
  } catch (err) {
    console.error(`Google Sheets error [${sheetName}]:`, err);
    throw err;
  }
}

// ===== Multer =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

// ===== AUTH =====
async function saveUser({ name, email, password }) {
  const hash = await bcrypt.hash(password, 10);
  await saveToSheet(SPREADSHEET_IDS.users, "Users", [
    new Date().toISOString(), name, email, hash, "false"
  ]);
}

async function verifyUser(email, password) {
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_IDS.users, range: "Users!A:E" });
  const row = (data.values || []).find(r => r[2]?.toLowerCase() === email.toLowerCase());
  if (!row) return false;
  const match = await bcrypt.compare(password, row[3]);
  return match ? { name: row[1], email: row[2], verified: row[4] === "true" } : false;
}

app.post("/api/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ success: false, message: "All fields required" });
    await saveUser({ name, email, password });
    res.json({ success: true, message: "Account created!" });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.post("/api/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: "Email & password required" });
    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ success: false, message: "Invalid credentials" });
    req.session.user = user;
    res.json({ success: true, message: "Signed in!" });
  } catch (err) {
    console.error("Signin error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

app.get("/api/profile", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated" });
  res.json({ success: true, profile: req.session.user });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ===== ID VERIFICATION =====
app.post("/api/verify-id", upload.single("idPhoto"), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated" });

  try {
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: "ID photo is required" });

    const baseUrl = process.env.NODE_ENV === "production" ? process.env.BACKEND_BASE_URL || "https://fundme-backend.onrender.com" : `http://localhost:${PORT}`;
    const idPhotoUrl = `${baseUrl}/uploads/${file.filename}`;

    console.log("Submitting ID verification for:", req.session.user.email);
    await saveToSheet(SPREADSHEET_IDS.users, "ID_Verifications", [
      new Date().toISOString(), req.session.user.email, idPhotoUrl, "Pending"
    ]);

    res.json({ success: true, message: "ID verification submitted!" });
  } catch (err) {
    console.error("ID Verification failed:", err);
    res.status(500).json({ success: false, error: "Failed to submit verification" });
  }
});

// ===== CAMPAIGNS =====
app.post("/api/campaigns", upload.single("image"), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated" });
  if (!req.session.user.verified) return res.status(403).json({ success: false, error: "ID verification required" });

  try {
    const { title, description, goal, category } = req.body;
    if (!title || !description || !goal || !category) return res.status(400).json({ success: false, error: "All fields required" });

    const id = Date.now().toString();
    const baseUrl = process.env.NODE_ENV === "production" ? process.env.BACKEND_BASE_URL || "https://fundme-backend.onrender.com" : `http://localhost:${PORT}`;
    const imageUrl = req.file ? `${baseUrl}/uploads/${req.file.filename}` : "";

    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      id, title, req.session.user.email, goal, description, category, "Active", new Date().toISOString(), imageUrl
    ]);

    res.json({ success: true, message: "Campaign created!", id, imageUrl });
  } catch (err) {
    console.error("Create campaign failed:", err);
    res.status(500).json({ success: false, error: "Failed to create campaign" });
  }
});

// ===== START SERVER =====
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
