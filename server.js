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
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true
}));

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Sessions =====
app.set("trust proxy", 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));

// ===== Google Sheets =====
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON || "{}"),
  scopes: SCOPES,
});
const sheets = google.sheets({ version: "v4", auth });

// ===== SendGrid =====
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ===== Helper: Save to Sheets =====
async function saveToSheet(sheetId, sheetName, values) {
  return sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

// ===== Multer Setup =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ===== Admin Credentials =====
const ADMIN_CREDENTIALS = {
  username: "Admin",
  password: "FunDMe$123"
};

// ✅ ===== Admin Routes =====

// Serve login or dashboard depending on session
app.get("/admin", (req, res) => {
  if (req.session.isAdmin) {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
  } else {
    res.sendFile(path.join(__dirname, "public", "admin-login.html"));
  }
});

// Admin login route
app.post("/admin-login", (req, res) => {
  const { username, password } = req.body;
  if (
    username?.toLowerCase() === ADMIN_CREDENTIALS.username.toLowerCase() &&
    password === ADMIN_CREDENTIALS.password
  ) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  } else {
    return res.status(401).json({ success: false, message: "Invalid credentials" });
  }
});

// Admin session check
app.get("/admin-session", (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

// Admin logout
app.post("/admin-logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ===== Serve static files AFTER defining admin routes =====
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "public")));

// ✅ ===== Example existing user routes (keep your existing logic here) =====

// Example donation route (leave your current one if it’s already working)
app.post("/api/create-checkout-session/mission", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: "JoyFund General Donation" },
          unit_amount: 1000,
        },
        quantity: 1,
      }],
      success_url: "https://fundasmile.net/success.html",
      cancel_url: "https://fundasmile.net/cancel.html",
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(400).json({ error: err.message });
  }
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
