require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const Stripe = require("stripe");
const cors = require("cors");
const mailjet = require("node-mailjet");
const multer = require("multer");
const fs = require("fs");

const app = express();
const path = require("path");
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
const PORT = process.env.PORT || 5000;

// ==================== ✅ CORS CONFIG ==================== 
const allowedOrigins = [
  "https://fundasmile.net", 
  "https://fundme-backend.onrender.com", 
  "http://localhost:5000", 
  "http://127.0.0.1:5000"
];

app.use(cors({ 
  origin: function(origin, callback) {
    if (!origin) return callback(null, true); // allow Postman, mobile apps 
    if (allowedOrigins.includes(origin)) return callback(null, true); 
    return callback(new Error('CORS policy: Not allowed by origin ' + origin)); 
  }, 
  credentials: true 
}));

app.options("*", cors({ origin: allowedOrigins, credentials: true }));

app.use((req, res, next) => { 
  const origin = req.headers.origin; 
  if (allowedOrigins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin); 
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"); 
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization"); 
  res.setHeader("Access-Control-Allow-Credentials", "true"); 
  if (req.method === "OPTIONS") return res.sendStatus(200); 
  next(); 
});

// ==================== Middleware ==================== 
app.use(bodyParser.json()); 
app.use(bodyParser.urlencoded({ extended: true }));

// ==================== ✅ SESSION CONFIG ====================
app.set("trust proxy", 1); // for Render/HTTPS
app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" ? true : false, // secure only in prod
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax", // cross-site in prod
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

// ==================== Stripe & Mailjet ====================
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");
const mailjetClient = mailjet.apiConnect(
  process.env.MAILJET_API_KEY || "",
  process.env.MAILJET_API_SECRET || ""
);

// ==================== Google Sheets ====================
let sheets;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    sheets = google.sheets({ version: "v4", auth });
    console.log("✅ Google Sheets initialized");
  } else {
    console.warn("⚠️ GOOGLE_CREDENTIALS_JSON not provided; Sheets disabled.");
  }
} catch (err) {
  console.error("❌ Google Sheets init failed", err && err.message);
}

// ==================== Helpers ====================
async function getSheetValues(spreadsheetId, range) {
  if (!sheets) return [];
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function appendSheetValues(spreadsheetId, range, values) {
  if (!sheets) throw new Error("Sheets not initialized");
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });
}

async function findRowAndUpdateOrAppend(spreadsheetId, rangeCols, matchColIndex, matchValue, updatedValues) {
  if (!sheets) throw new Error("Sheets not initialized");

  let sheetName = "";
  let range = "";
  if (rangeCols.includes("!")) [sheetName, range] = rangeCols.split("!");
  else range = rangeCols;

  const rows = await getSheetValues(spreadsheetId, rangeCols);
  const rowIndex = rows.findIndex(r => (r[matchColIndex] || "").toString().trim().toLowerCase() === (matchValue || "").toString().trim().toLowerCase());

  if (rowIndex === -1) {
    await appendSheetValues(spreadsheetId, rangeCols, [updatedValues]);
    return { action: "appended", row: rows.length + 1 };
  } else {
    const [startCol, endCol] = range.split(":");
    const rowNumber = rowIndex + 1;
    const updateRange = sheetName ? `${sheetName}!${startCol}${rowNumber}:${endCol}${rowNumber}` : `${startCol}${rowNumber}:${endCol}${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: updateRange,
      valueInputOption: "USER_ENTERED",
      resource: { values: [updatedValues] }
    });
    return { action: "updated", row: rowNumber };
  }
}

// ==================== USERS ====================
async function getUsers() {
  if (!process.env.USERS_SHEET_ID) return [];
  return getSheetValues(process.env.USERS_SHEET_ID, "A:D");
}

// ==================== SIGN IN / SESSION ====================
app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing email or password" });

  try {
    const users = await getUsers();
    const inputEmail = email.trim().toLowerCase();
    const userRow = users.find(u => u[2] && u[2].trim().toLowerCase() === inputEmail);

    if (!userRow) return res.status(401).json({ error: "Invalid credentials" });

    const storedHash = (userRow[3] || "").trim();
    const match = await bcrypt.compare(password, storedHash);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    req.session.user = { name: userRow[1], email: userRow[2], joinDate: userRow[0] };
    console.log("✅ User signed in:", req.session.user);

    res.json({ ok: true, user: req.session.user });
  } catch (err) {
    console.error("signin error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/check-session", (req, res) => {
  if (req.session.user) res.json({ loggedIn: true, user: req.session.user });
  else res.json({ loggedIn: false });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Failed to logout" });
    res.json({ ok: true });
  });
});

// ==================== ✅ ID VERIFICATION ====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "uploads", "id-verifications");
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const sanitizedEmail = req.session.user?.email.replace(/[@.]/g, "_") || "unknown";
    const ext = path.extname(file.originalname);
    cb(null, `${sanitizedEmail}_${timestamp}${ext}`);
  }
});

const upload = multer({ storage });

app.post("/api/verify-id", upload.single("idDocument"), async (req, res) => {
  try {
    const user = req.session.user;
    if (!user || !user.email) return res.status(401).json({ success: false, message: "You must be signed in to submit." });
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded." });
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });

    const spreadsheetId = process.env.ID_VERIFICATIONS_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ success: false, message: "ID_VERIFICATIONS_SHEET_ID not configured" });

    const filePath = path.join("uploads", "id-verifications", req.file.filename);
    const timestamp = new Date().toLocaleString();
    const updatedRow = [timestamp, user.email.toLowerCase(), user.name, "pending", filePath];

    const result = await findRowAndUpdateOrAppend(
      spreadsheetId,
      "ID_Verifications!A:E",
      1,
      user.email,
      updatedRow
    );

    console.log("verify-id result:", result);
    res.json({ success: true, action: result.action, row: result.row });
  } catch (err) {
    console.error("verify-id error:", err);
    res.status(500).json({ success: false, message: "Failed to submit ID verification" });
  }
});

// ==================== VERIFICATION STATUS FOR DASHBOARD ====================
app.get("/api/get-verifications", async (req, res) => {
  try {
    if (!sheets) return res.status(500).json({ success:false, message:"Sheets not initialized" });
    const user = req.session.user;
    if (!user || !user.email) return res.status(401).json({ success:false, message:"Not logged in" });

    const spreadsheetId = process.env.ID_VERIFICATIONS_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ success:false, message:"ID_VERIFICATIONS_SHEET_ID not configured" });

    const rows = await getSheetValues(spreadsheetId, "ID_Verifications!A:E");
    const userRows = rows.filter(r => (r[1]||"").toLowerCase() === user.email.toLowerCase());
    const latest = userRows.length > 0 ? userRows[userRows.length-1] : null;

    if (!latest) return res.json({ success:true, verifications: [] });

    const [timestamp, email, name, status, idPhotoURL] = latest;
    res.json({ success:true, verifications:[{ timestamp, email, name, status: status || "pending", idImageUrl: idPhotoURL || "" }] });
  } catch(err){
    console.error("get-verifications error:", err);
    res.status(500).json({ success:false, message:"Failed to read verifications" });
  }
});

// ==================== GET ALL CAMPAIGNS FOR DASHBOARD ====================
app.get("/api/campaigns", async (req, res) => {
  try {
    if (!sheets) return res.status(500).json({ success:false, message:"Sheets not initialized" });
    const user = req.session.user;
    if (!user || !user.email) return res.status(401).json({ success:false, message:"Not logged in" });

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ success:false, message:"CAMPAIGNS_SHEET_ID not configured" });

    const rows = await getSheetValues(spreadsheetId, "A:G");
    const userCampaigns = rows
      .filter(r => (r[1]||"").toLowerCase() === user.email.toLowerCase())
      .map(r => ({
        timestamp: r[0],
        creatorEmail: r[1],
        title: r[2],
        description: r[3],
        goal: r[4],
        status: r[5] ? r[5].charAt(0).toUpperCase() + r[5].slice(1).toLowerCase() : "Draft",
        campaignId: r[6],
        imageUrl: r[7] || ""
      }));

    res.json({ success:true, campaigns: userCampaigns });
  } catch(err){
    console.error("get campaigns error:", err);
    res.status(500).json({ success:false, message:"Failed to get campaigns" });
  }
});
// ==================== START SERVER ====================
app.listen(PORT, () => console.log(`🚀 JoyFund backend running on port ${PORT}`));
