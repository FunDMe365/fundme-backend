require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const Stripe = require("stripe");
const cors = require("cors");
const mailjet = require("node-mailjet");

const app = express();
const PORT = process.env.PORT || 5000;

// ==================== ✅ CORS CONFIG ====================
const allowedOrigins = [
  "https://fundasmile.net",
  "https://fundme-backend.onrender.com",
  "http://localhost:5000",
  "http://127.0.0.1:5000"
];

app.use(cors({
  origin: function(origin, callback){
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

// ==================== ✅ SESSION FIX ====================
app.set("trust proxy", 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "none",
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

// Update existing row by email or append if not found
async function findRowAndUpdateOrAppend(spreadsheetId, rangeCols, matchColIndex, matchValue, updatedValues) {
  if (!sheets) throw new Error("Sheets not initialized");
  const rows = await getSheetValues(spreadsheetId, rangeCols);
  const rowIndex = rows.findIndex(r => (r[matchColIndex] || "").toString().trim().toLowerCase() === (matchValue || "").toString().trim().toLowerCase());

  if (rowIndex === -1) {
    await appendSheetValues(spreadsheetId, rangeCols, [updatedValues]);
    return { action: "appended", row: rows.length + 1 };
  } else {
    const [startCol, endCol] = rangeCols.split(":");
    const rowNumber = rowIndex + 1;
    const updateRange = `${startCol}${rowNumber}:${endCol}${rowNumber}`;
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

// ==================== SIGN IN ====================
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
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Failed to logout" });
    res.json({ ok: true });
  });
});

// ==================== ID VERIFICATION ====================
app.post("/api/verify-id", async (req, res) => {
  try {
    // DEBUG: log session & body
    console.log("Session user:", req.session.user);
    console.log("Request body:", req.body);

    const user = req.session.user;
    if (!user || !user.email) {
      return res.status(401).json({ success: false, message: "You must be signed in to submit." });
    }

    const { idPhotoURL } = req.body;
    if (!idPhotoURL) {
      return res.status(400).json({ success: false, message: "Missing ID photo URL" });
    }

    if (!sheets) {
      return res.status(500).json({ success: false, message: "Sheets not initialized" });
    }

    const spreadsheetId = process.env.ID_VERIFICATIONS_SHEET_ID;
    if (!spreadsheetId) {
      return res.status(500).json({ success: false, message: "ID_VERIFICATIONS_SHEET_ID not configured" });
    }

    const timestamp = new Date().toLocaleString();
    const updatedRow = [timestamp, user.email.toLowerCase(), user.name, "pending", idPhotoURL];

    const result = await findRowAndUpdateOrAppend(spreadsheetId, "A:E", 1, user.email, updatedRow);
    console.log("verify-id result:", result);

    res.json({ success: true, action: result.action, row: result.row });
  } catch (err) {
    console.error("verify-id error:", err);
    res.status(500).json({ success: false, message: "Failed to submit ID verification" });
  }
});


// ==================== VERIFICATION STATUS FOR DASHBOARD ====================
app.get("/api/verify-status", async (req, res) => {
  try {
    if (!sheets) return res.status(500).json({ error: "Sheets not initialized" });
    const user = req.session.user;
    if (!user || !user.email) return res.status(401).json({ found: false });

    const spreadsheetId = process.env.ID_VERIFICATIONS_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ error: "ID_VERIFICATIONS_SHEET_ID not configured" });

    const rows = await getSheetValues(spreadsheetId, "A:E");
    const row = rows.find(r => (r[1] || "").toString().trim().toLowerCase() === user.email.toLowerCase());

    if (!row) return res.json({ found: false, status: "not submitted" });

    const [timestamp, email, name, status, idPhotoURL] = row;
    res.json({ found: true, timestamp, email, name, status, idPhotoURL });
  } catch (err) {
    console.error("verify-status error:", err && err.message);
    res.status(500).json({ error: "Failed to read verification status" });
  }
});

// ==================== CAMPAIGN ROUTES ====================
app.post("/api/create-campaign", async (req, res) => {
  try {
    if (!sheets) return res.status(500).json({ error: "Sheets not initialized" });
    const { creatorEmail, title, description, goal } = req.body;
    if (!creatorEmail || !title || !description || !goal) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ error: "CAMPAIGNS_SHEET_ID not configured" });

    const campaignId = `camp_${Date.now().toString(36)}_${Math.floor(Math.random() * 9000 + 1000)}`;
    const timestamp = new Date().toLocaleString();
    const status = "draft";

    const row = [timestamp, creatorEmail.trim().toLowerCase(), title, description, goal.toString(), status, campaignId];
    await appendSheetValues(spreadsheetId, "A:G", [row]);

    console.log("create-campaign appended:", campaignId);
    res.json({ ok: true, campaignId, row });
  } catch (err) {
    console.error("create-campaign error:", err && err.message);
    res.status(500).json({ error: "Failed to create campaign" });
  }
});

app.get("/api/campaign/:campaignId", async (req, res) => {
  try {
    if (!sheets) return res.status(500).json({ error: "Sheets not initialized" });
    const campaignId = (req.params.campaignId || "").toString().trim();
    if (!campaignId) return res.status(400).json({ error: "Missing campaignId param" });

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ error: "CAMPAIGNS_SHEET_ID not configured" });

    const rows = await getSheetValues(spreadsheetId, "A:G");
    const row = rows.find(r => (r[6] || "").toString().trim() === campaignId);
    if (!row) return res.status(404).json({ error: "Campaign not found" });

    const [timestamp, creatorEmail, title, description, goal, status, id] = row;
    res.json({ timestamp, creatorEmail, title, description, goal, status, id });
  } catch (err) {
    console.error("get campaign error:", err && err.message);
    res.status(500).json({ error: "Failed to read campaign" });
  }
});

// ==================== START SERVER ====================
app.listen(PORT, () => console.log(`🚀 JoyFund backend running on port ${PORT}`));
