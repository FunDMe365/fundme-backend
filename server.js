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
    if (!origin) return callback(null, true);
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
      maxAge: 1000 * 60 * 60 * 24 * 30,
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
};

// ===== Visitor Count =====
let siteVisitors = 0;
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/admin")) siteVisitors++;
  next();
});

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

// ===== USER SIGNIN =====
app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: "Missing email or password" });

  try {
    const values = await getSheetValues(SPREADSHEET_IDS.users, "Users!A:D");
    const users = rowsToObjects(values);

    const user = users.find(u => u.Email.toLowerCase() === email.toLowerCase());
    if (!user) return res.status(401).json({ success: false, message: "Invalid email or password" });

    const match = await bcrypt.compare(password, user.PasswordHash || "");
    if (!match) return res.status(401).json({ success: false, message: "Invalid email or password" });

    req.session.user = { name: user.Name, email: user.Email, isAdmin: false };
    req.session.save(err => {
      if (err) return res.status(500).json({ success: false, message: "Session error" });
      res.json({ success: true, user: { name: user.Name, email: user.Email } });
    });
  } catch (err) {
    console.error("signin error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== USER SIGNUP =====
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ success: false, message: "Name, email, and password are required" });

  try {
    const values = await getSheetValues(SPREADSHEET_IDS.users, "Users!A:D");
    const users = rowsToObjects(values);

    if (users.find(u => u.Email.toLowerCase() === email.toLowerCase()))
      return res.status(400).json({ success: false, message: "Email already registered" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const joinDate = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

    await saveToSheet(SPREADSHEET_IDS.users, "Users", [joinDate, name, email, hashedPassword]);

    // Log in immediately
    req.session.user = { name, email, isAdmin: false };
    req.session.save(err => {
      if (err) return res.status(500).json({ success: false, message: "Session error" });
      res.json({ success: true, user: { name, email } });
    });
  } catch (err) {
    console.error("signup error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== ADMIN ROUTES =====
// ... all admin routes remain the same

// ===== Catch-all API 404 =====
app.all("/api/*", (req, res) =>
  res.status(404).json({ success: false, message: "API route not found" })
);

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
