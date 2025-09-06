require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
const cors = require("cors");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 5000;

// ===== CORS Setup =====
const allowedOrigins = ["https://fundasmile.net", "http://localhost:3000"];
app.use(cors({
  origin: function(origin, callback) {
    // allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
}));
app.options("*", cors());

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Session Setup =====
app.set('trust proxy', 1); // if behind a reverse proxy like Render
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    collectionName: 'sessions'
  }),
  cookie: {
    secure: process.env.NODE_ENV === "production", // true in production (HTTPS)
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  }
}));

// ===== Google Sheets Setup =====
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
  scopes: SCOPES
});
const sheets = google.sheets({ version: "v4", auth });

// ===== Spreadsheet IDs =====
const SPREADSHEET_IDS = {
  users: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
  volunteers: "1O_y1yDiYfO0RT8eGwBMtaiPWYYvSR8jIDIdZkZPlvNA",
  streetteam: "1dPz1LqQq6SKjZIwsgIpQJdQzdmlOV7YrOZJjHqC4Yg8",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
  campaigns: "1XSS-2WJpzEhDe6RHBb8rt_6NNWNqdFpVTUsRa3TNCG8"
};

// ===== Zoho SMTP Setup =====
const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.ZOHO_USER,
    pass: process.env.ZOHO_APP_PASSWORD
  }
});

// ===== Helper Functions =====
async function saveUser({ name, email, password }) {
  const hashedPassword = await bcrypt.hash(password, 10);
  // Save as: joinDate, name, email, passwordHash
  await saveToSheet(
    SPREADSHEET_IDS.users,
    "Users",
    [new Date().toISOString(), name, email.toLowerCase().trim(), hashedPassword]
  );
}

async function verifyUser(email, password) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!B:D" // B=name, C=email, D=hashed password
  });
  const rows = response.data.values || [];

  const normalizedEmail = email.toLowerCase().trim();
  const userRow = rows.find(row => row[1].toLowerCase().trim() === normalizedEmail);
  if (!userRow) return false;

  const match = await bcrypt.compare(password, userRow[2]);
  return match ? { name: userRow[0], email: userRow[1] } : false;
}

// ===== Routes =====

// --- Sign Up ---
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: "Name, email, and password are required." });
  }
  try {
    await saveUser({ name, email, password });
    res.json({ success: true, message: "Account created successfully!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error creating account." });
  }
});

// --- Sign In ---
app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: "Email and password required." });

  try {
    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ success: false, error: "Invalid email or password." });

    // Set session user
    req.session.user = { name: user.name, email: user.email };
    await req.session.save(); // ensures session is saved before responding

    res.json({ success: true, message: "Signed in successfully." });
  } catch (err) {
    console.error("Signin error:", err.message);
    res.status(500).json({ success: false, error: "Server error." });
  }
});

// --- Check Session (for frontend) ---
app.get("/check-session", (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, name: req.session.user.name, email: req.session.user.email });
  } else {
    res.json({ loggedIn: false });
  }
});

// ===== The rest of your routes (profile, dashboard, campaigns, etc.) remain unchanged =====

// ===== Start Server =====
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
