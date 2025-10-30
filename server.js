require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
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
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
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
  volunteers: "1O_y1yDiYfO0RT8eGwBMtaiPWYYvSR8jIDIdZkZPlvNA",
};

async function fetchSheet(sheetId, range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });
  return res.data.values || [];
}

async function appendSheet(sheetId, range, values) {
  return sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

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

// ===== Multer =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ===== Admin Credentials =====
const ADMIN_CREDENTIALS = {
  username: "Admin",
  password: "FunDMe$123",
};

// ===== Admin Routes =====

// Serve admin page if logged in, otherwise login page
app.get("/admin", (req, res) => {
  if (req.session.isAdmin) {
    res.sendFile(path.join(__dirname, "public/admin.html"));
  } else {
    res.sendFile(path.join(__dirname, "public/admin-login.html"));
  }
});

// Check admin session
app.get("/admin-session", (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

// Admin login
app.post("/admin-login", (req, res) => {
  const { username, password } = req.body;
  if (
    username?.toLowerCase() === ADMIN_CREDENTIALS.username.toLowerCase() &&
    password === ADMIN_CREDENTIALS.password
  ) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: "Invalid credentials" });
  }
});

// Admin logout
app.post("/admin-logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ===== Middleware to protect admin APIs =====
function requireAdmin(req, res, next) {
  if (req.session.isAdmin) next();
  else res.status(401).json({ success: false, message: "Unauthorized" });
}

// ===== Admin API routes =====
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const vals = await fetchSheet(SPREADSHEET_IDS.users, "Sheet1!A:Z");
    const headers = vals[0] || [];
    const rows = vals.slice(1).map((r) =>
      Object.fromEntries(r.map((v, i) => [headers[i] || `col${i}`, v]))
    );
    res.json({ users: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/volunteers", requireAdmin, async (req, res) => {
  try {
    const vals = await fetchSheet(SPREADSHEET_IDS.volunteers, "Sheet1!A:Z");
    const headers = vals[0] || [];
    const rows = vals.slice(1).map((r) =>
      Object.fromEntries(r.map((v, i) => [headers[i] || `col${i}`, v]))
    );
    res.json({ volunteers: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/admin/waitlist", requireAdmin, async (req, res) => {
  try {
    const vals = await fetchSheet(SPREADSHEET_IDS.waitlist, "Sheet1!A:Z");
    const headers = vals[0] || [];
    const rows = vals.slice(1).map((r) =>
      Object.fromEntries(r.map((v, i) => [headers[i] || `col${i}`, v]))
    );
    res.json({ waitlist: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stub campaigns & donations endpoints for admin dashboard
app.get("/api/admin/campaigns", requireAdmin, async (req, res) => {
  try {
    const vals = await fetchSheet(SPREADSHEET_IDS.campaigns, "Sheet1!A:Z");
    const headers = vals[0] || [];
    const rows = vals.slice(1).map((r) =>
      Object.fromEntries(r.map((v, i) => [headers[i] || `col${i}`, v]))
    );
    res.json({ campaigns: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/admin/campaign/:id/status", requireAdmin, async (req, res) => {
  // Implement your campaign status update logic here
  res.json({ success: true });
});

app.get("/api/admin/donations", requireAdmin, async (req, res) => {
  try {
    const vals = await fetchSheet(SPREADSHEET_IDS.donations, "Sheet1!A:Z");
    const headers = vals[0] || [];
    const rows = vals.slice(1).map((r) =>
      Object.fromEntries(r.map((v, i) => [headers[i] || `col${i}`, v]))
    );
    res.json({ donations: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== Serve static files =====
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "public")));

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
