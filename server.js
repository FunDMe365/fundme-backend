require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 5000;

// ===== CORS Setup =====
app.use(cors({
  origin: ["https://fundasmile.net", "http://localhost:3000"],
  methods: ["GET","POST","PUT","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization","Accept"],
  credentials: true
}));
app.options("*", cors());

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Session Setup =====
app.set('trust proxy', 1); // Important for production behind proxy
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 24
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
async function saveToSheet(sheetId, sheetName, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:D`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

async function saveUser({ name, email, password }) {
  const hashedPassword = await bcrypt.hash(password, 10);
  await saveToSheet(SPREADSHEET_IDS.users, "Users", [
    new Date().toISOString(),
    name,
    email.toLowerCase().trim(),
    hashedPassword
  ]);
}

async function verifyUser(email, password) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!A:D"
  });
  const rows = response.data.values || [];
  const normalizedEmail = email.toLowerCase().trim();
  const userRow = rows.find(row => row[2] && row[2].toLowerCase().trim() === normalizedEmail);
  if (!userRow) return false;
  const passwordMatch = await bcrypt.compare(password, userRow[3]);
  return passwordMatch ? { name: userRow[1], email: userRow[2], joinDate: userRow[0] } : false;
}

// ===== Routes =====

// --- Sign Up ---
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ success: false, message: "Name, email, and password required." });

  try {
    await saveUser({ name, email, password });
    res.json({ success: true, message: "Account created successfully!" });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ success: false, message: "Error creating account." });
  }
});

// --- Sign In ---
app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, error: "Email and password required." });

  try {
    const user = await verifyUser(email, password);
    if (!user)
      return res.status(401).json({ success: false, error: "Invalid email or password." });

    // Set session
    req.session.user = { name: user.name, email: user.email, joinDate: user.joinDate };
    res.json({ success: true, message: "Signed in successfully." });
  } catch (err) {
    console.error("Signin error:", err);
    res.status(500).json({ success: false, error: "Server error." });
  }
});

// --- Check Session ---
app.get("/check-session", (req, res) => {
  if (req.session.user) return res.json({ loggedIn: true });
  res.json({ loggedIn: false });
});

// --- Dashboard ---
app.get("/api/dashboard", (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ success: false, error: "Not authenticated." });

  res.json({ success: true, name: req.session.user.name, email: req.session.user.email });
});

// --- Profile Routes ---
app.get("/api/profile", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ success: false, error: "Not authenticated." });

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "Users!A:D"
    });
    const rows = response.data.values || [];
    const normalizedEmail = req.session.user.email.toLowerCase().trim();
    const userRow = rows.find(row => row[2] && row[2].toLowerCase().trim() === normalizedEmail);

    res.json({
      success: true,
      profile: {
        name: req.session.user.name,
        email: req.session.user.email,
        joinDate: userRow ? userRow[0] : null
      }
    });
  } catch (err) {
    console.error("Profile fetch error:", err);
    res.status(500).json({ success: false, error: "Server error fetching profile." });
  }
});

app.post("/api/profile", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ success: false, error: "Not authenticated." });

  const { name, email, password } = req.body;

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "Users!A:D"
    });
    const rows = response.data.values || [];
    const idx = rows.findIndex(row => row[2] && row[2].toLowerCase().trim() === req.session.user.email.toLowerCase().trim());
    if (idx === -1) return res.status(404).json({ success: false, error: "User not found." });

    if (name) req.session.user.name = name;
    if (email) req.session.user.email = email;

    if (password) rows[idx][3] = await bcrypt.hash(password, 10);
    if (name) rows[idx][1] = name;
    if (email) rows[idx][2] = email.toLowerCase().trim();

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: `Users!A${idx + 1}:D${idx + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: [rows[idx]] }
    });

    res.json({ success: true, message: "Profile updated.", profile: req.session.user });
  } catch (err) {
    console.error("Profile update error:", err);
    res.status(500).json({ success: false, error: "Server error updating profile." });
  }
});

// --- Remaining routes (Delete Account, Messages, Campaigns, Donations) remain the same ---
// Include your previous implementations for them here

// ===== Start Server =====
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
