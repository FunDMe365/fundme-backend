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

// ✅ Handle all OPTIONS (preflight) requests globally
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin);
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Credentials", "true");
  res.sendStatus(200);
});

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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
      maxAge: 1000 * 60 * 60 * 24 * 30, // persist 30 days until logout
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
  const headers = values[0].map((h) => (h || "").toString().trim());
  const rows = values
    .slice(1)
    .map((r) => r.map((c) => (c || "").toString().trim()))
    .filter((r) => r.some((c) => c !== ""));
  return rows.map((r) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h || `col${i}`] = r[i] || ""));
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
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ===== Admin detection =====
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// middleware to require admin
function requireAdmin(req, res, next) {
  if (!req.session.user)
    return res.status(401).json({ success: false, message: "Not logged in" });
  if (!req.session.user.isAdmin)
    return res.status(403).json({ success: false, message: "Admin access required" });
  next();
}

// ===== ADMIN LOGIN / LOGOUT =====
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;

  if (username === "Admin" && password === "FunDMe$123") {
    req.session.user = { name: "Admin", email: "admin@fundasmile.net", isAdmin: true };
    req.session.save((err) => {
      if (err) return res.status(500).json({ success: false, message: "Session error" });
      res.json({ success: true });
    });
  } else {
    res.status(401).json({ success: false, message: "Invalid credentials" });
  }
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ===== Auth, Campaign, Waitlist, Donation, Admin routes stay unchanged below =====

// ===== ADMIN: Get campaigns =====
app.get("/api/admin/campaigns", requireAdmin, async (req, res) => {
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.campaigns, "Campaigns!A:I");
    const campaigns = (values || []).map((row) => ({
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

// ===== ADMIN: Update campaign status =====
app.put("/api/admin/campaign/:id/status", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!id || !status)
    return res.status(400).json({ success: false, message: "Missing id or status" });

  try {
    const values = await getSheetValues(SPREADSHEET_IDS.campaigns, "Campaigns!A:I");
    const rows = values || [];
    const rowIndex = rows.findIndex((row) => row[0] === id);
    if (rowIndex === -1)
      return res.status(404).json({ success: false, message: "Campaign not found" });

    rows[rowIndex][6] = status;
    const range = `Campaigns!A${rowIndex + 1}:I${rowIndex + 1}`;
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
    const donations = (values || []).map((row) => ({
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

// ===== ADMIN: Get users =====
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

// ===== ADMIN: Get waitlist =====
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
