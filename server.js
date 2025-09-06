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
app.use(cors({
  origin: ["https://fundasmile.net", "http://localhost:3000"],
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  credentials: true
}));
app.options("*", cors());

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Session Setup =====
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    collectionName: 'sessions'
  }),
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: 'none',
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
async function saveToSheet(sheetId, sheetName, values) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:Z`,
      valueInputOption: "RAW",
      requestBody: { values: [values] }
    });
  } catch (err) {
    console.error(`Error saving to ${sheetName}:`, err.message);
    throw err;
  }
}

async function sendConfirmationEmail({ to, subject, text, html }) {
  try {
    await transporter.sendMail({
      from: `"JoyFund INC." <${process.env.ZOHO_USER}>`,
      to,
      subject,
      text,
      html
    });
  } catch (err) {
    console.error(`Error sending email to ${to}:`, err.message);
    throw err;
  }
}

async function saveUser({ name, email, password }) {
  const hashedPassword = await bcrypt.hash(password, 10);
  await saveToSheet(
    SPREADSHEET_IDS.users,
    "Users",
    [new Date().toISOString(), name, email, hashedPassword]
  );
}

async function verifyUser(email, password) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!B:D"
  });
  const rows = response.data.values || [];
  const userRow = rows.find(row => row[1] === email);
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

    req.session.user = { name: user.name, email: user.email };
    res.json({ success: true, message: "Signed in successfully." });
  } catch (err) {
    console.error("Signin error:", err.message);
    res.status(500).json({ success: false, error: "Server error." });
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
      range: "Users!A:C"
    });
    const rows = response.data.values || [];
    const userRow = rows.find(row => row[2] === req.session.user.email);
    const joinDate = userRow ? userRow[0] : null;

    res.json({
      success: true,
      profile: {
        name: req.session.user.name,
        email: req.session.user.email,
        joinDate
      }
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
      range: "Users!A:C"
    });
    const rows = response.data.values || [];
    const idx = rows.findIndex(row => row[2] === req.session.user.email);
    if (idx === -1) return res.status(404).json({ success: false, error: "User not found." });

    if (name) req.session.user.name = name;
    if (email) req.session.user.email = email;

    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      rows[idx] = [
        rows[idx][0], // joinDate
        name || rows[idx][1],
        email || rows[idx][2],
        hashedPassword
      ];
    } else {
      rows[idx][1] = name || rows[idx][1];
      rows[idx][2] = email || rows[idx][2];
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: `Users!A${idx + 1}:C${idx + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: [rows[idx]] }
    });

    res.json({ success: true, message: "Profile updated.", profile: req.session.user });
  } catch (err) {
    console.error("Profile update error:", err.message);
    res.status(500).json({ success: false, error: "Server error updating profile." });
  }
});

// ===== Frontend-friendly profile route =====
app.get("/get-profile", (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  const { name, email } = req.session.user;
  const joinDate = req.session.user.joinDate || "2025-01-01";
  res.json({ loggedIn: true, name, email, joinDate });
});

// --- Delete Account ---
app.post("/api/delete-account", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "Users!A:C"
    });
    const rows = response.data.values || [];
    const idx = rows.findIndex(row => row[2] === req.session.user.email);
    if (idx === -1) return res.status(404).json({ success: false, error: "User not found." });

    rows.splice(idx, 1);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: `Users!A1:C${rows.length + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: rows }
    });

    req.session.destroy();
    res.json({ success: true, message: "Account deleted successfully." });
  } catch (err) {
    console.error("Delete account error:", err.message);
    res.status(500).json({ success: false, error: "Server error deleting account." });
  }
});

// --- Messages ---
app.get("/api/messages", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  if (!req.session.messages) req.session.messages = [];
  res.json({ success: true, messages: req.session.messages });
});
app.post("/api/messages", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  const { text } = req.body;
  if (!text) return res.status(400).json({ success: false, error: "Message text is required." });
  if (!req.session.messages) req.session.messages = [];
  req.session.messages.push({ text, timestamp: new Date().toISOString() });
  res.json({ success: true, message: "Message added.", messages: req.session.messages });
});

// --- Logout ---
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/signin.html");
});

// ===== Campaigns & Donations =====

// Fetch all campaigns
app.get("/api/campaigns", async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:F"
    });
    const rows = response.data.values || [];
    const campaigns = rows.map(row => ({
      title: row[0],
      description: row[1],
      goal: parseFloat(row[2]),
      raised: parseFloat(row[3] || 0),
      creatorEmail: row[4],
      createdAt: row[5]
    }));
    res.json({ success: true, campaigns });
  } catch (err) {
    console.error("Fetch campaigns error:", err);
    res.status(500).json({ success: false, error: "Unable to fetch campaigns." });
  }
});

// Create new campaign
app.post("/api/campaigns", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  const { title, description, goal } = req.body;
  if (!title || !description || !goal) return res.status(400).json({ success: false, error: "All fields required." });
  try {
    const newCampaign = [
      title,
      description,
      parseFloat(goal),
      0,
      req.session.user.email,
      new Date().toISOString()
    ];
    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", newCampaign);
    res.json({ success: true, message: "Campaign created!", campaign: newCampaign });
  } catch (err) {
    console.error("Create campaign error:", err);
    res.status(500).json({ success: false, error: "Failed to create campaign." });
  }
});

// Donate to a campaign
app.post("/api/campaigns/donate", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  const { title, amount } = req.body;
  if (!title || !amount) return res.status(400).json({ success: false, error: "Title and amount required." });
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:D"
    });
    const rows = response.data.values || [];
    const idx = rows.findIndex(row => row[0] === title);
    if (idx === -1) return res.status(404).json({ success: false, error: "Campaign not found." });

    rows[idx][3] = parseFloat(rows[idx][3] || 0) + parseFloat(amount);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: `Campaigns!A${idx + 1}:D${idx + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: [rows[idx]] }
    });

    res.json({ success: true, message: "Donation successful!", raised: rows[idx][3] });
  } catch (err) {
    console.error("Donate error:", err);
    res.status(500).json({ success: false, error: "Failed to process donation." });
  }
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
