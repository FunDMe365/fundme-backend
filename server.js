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
app.set('trust proxy', 1); // needed for secure cookies behind proxies
app.use(cors({
  origin: ["https://fundasmile.net"], // only your frontend
  methods: ["GET","POST","PUT","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
  credentials: true
}));
app.options("*", cors());

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Session Setup =====
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    collectionName: 'sessions'
  }),
  cookie: {
    secure: process.env.NODE_ENV === "production", // true for HTTPS
    httpOnly: true,
    sameSite: 'none', // required for cross-site cookies
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
async function saveToSheet(spreadsheetId, sheetName, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

async function saveUser({ name, email, password }) {
  const hashedPassword = await bcrypt.hash(password, 10);
  await saveToSheet(
    SPREADSHEET_IDS.users,
    "Users",
    [new Date().toISOString(), name, email.toLowerCase().trim(), hashedPassword]
  );
}

async function verifyUser(email, password) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!B:D" // B=name, C=email, D=password hash
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
    if (!user) return res.status(401).json({ success: false, error: "Invalid email or password." });

    req.session.user = { name: user.name, email: user.email };
    res.json({ success: true, message: "Signed in successfully." });
  } catch (err) {
    console.error("Signin error:", err);
    res.status(500).json({ success: false, error: "Server error." });
  }
});

// --- Check Session ---
app.get("/check-session", (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, name: req.session.user.name, email: req.session.user.email });
  } else {
    res.json({ loggedIn: false });
  }
});

// --- Dashboard ---
app.get("/api/dashboard", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  const { name, email } = req.session.user;
  res.json({ success: true, name, email, campaigns: 0, donations: 0, recentActivity: [] });
});

// --- Profile ---
app.get("/api/profile", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "Users!A:D"
    });
    const rows = response.data.values || [];

    const normalizedEmail = req.session.user.email.toLowerCase().trim();
    const userRow = rows.find(row => row[2].toLowerCase().trim() === normalizedEmail);
    const joinDate = userRow ? userRow[0] : null;

    res.json({
      success: true,
      profile: { name: req.session.user.name, email: req.session.user.email, joinDate }
    });
  } catch (err) {
    console.error("Profile fetch error:", err);
    res.status(500).json({ success: false, error: "Server error fetching profile." });
  }
});

app.post("/api/profile", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  const { name, email, password } = req.body;
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "Users!A:D"
    });
    const rows = response.data.values || [];

    const normalizedEmail = req.session.user.email.toLowerCase().trim();
    const idx = rows.findIndex(row => row[2].toLowerCase().trim() === normalizedEmail);
    if (idx === -1) return res.status(404).json({ success: false, error: "User not found." });

    if (name) req.session.user.name = name;
    if (email) req.session.user.email = email;

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      rows[idx] = [
        rows[idx][0],
        name || rows[idx][1],
        email ? email.toLowerCase().trim() : rows[idx][2],
        hashedPassword
      ];
    } else {
      rows[idx][1] = name || rows[idx][1];
      rows[idx][2] = email ? email.toLowerCase().trim() : rows[idx][2];
    }

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

// --- Logout ---
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/signin.html");
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
