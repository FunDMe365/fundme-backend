require('dotenv').config();
process.env.DEBUG_URL = '';
const express = require("express");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
const cors = require("cors");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 5000;

// ===== CORS Setup =====
app.use(cors({
  origin: ["https://fundasmile.net", "http://localhost:3000"],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  credentials: true
}));

app.options("*", cors());

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Session Setup =====
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // set to true if using HTTPS
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
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ"
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

// ===== Helpers =====
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
    [name, email, hashedPassword, new Date().toISOString()]
  );
}

async function verifyUser(email, password) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!A:C"
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

  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Email and password required." });
  }

  try {
    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ success: false, error: "Invalid email or password." });

    // Save user info in session
    req.session.user = { name: user.name, email: user.email };
    res.json({ success: true, message: "Signed in successfully." });

  } catch (err) {
    console.error("Signin error:", err.message);
    res.status(500).json({ success: false, error: "Server error." });
  }
});

// --- Dashboard ---
app.get("/api/dashboard", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, error: "Not authenticated" });
  }
  const { name, email } = req.session.user;
  res.json({
    success: true,
    name,
    email,
    campaigns: 0,
    donations: 0,
    recentActivity: []
  });
});

// --- Sign Out ---
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/signin.html");
});

// --- Volunteer Submission ---
app.post("/submit-volunteer", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ success: false, error: "All fields are required." });
  try {
    await saveToSheet(SPREADSHEET_IDS.volunteers, "Volunteers", [name, email, city, message, new Date().toISOString()]);
    await sendConfirmationEmail({
      to: email,
      subject: "Thank you for applying as a JoyFund Volunteer!",
      text: `Hi ${name}, thank you for applying.`,
      html: `<p>Hi ${name}, thank you for applying.</p>`
    });
    await sendConfirmationEmail({
      to: process.env.ZOHO_USER,
      subject: `New Volunteer Application: ${name}`,
      text: `A new volunteer has applied:\nName: ${name}\nEmail: ${email}\nCity: ${city}\nMessage: ${message}`
    });
    res.json({ success: true, message: "Volunteer application submitted successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Street Team Submission ---
app.post("/submit-streetteam", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ success: false, error: "All fields are required." });
  try {
    await saveToSheet(SPREADSHEET_IDS.streetteam, "StreetTeam", [name, email, city, message, new Date().toISOString()]);
    await sendConfirmationEmail({
      to: email,
      subject: "Thank you for joining the JoyFund Street Team!",
      text: `Hi ${name}, thank you for joining.`,
      html: `<p>Hi ${name}, thank you for joining.</p>`
    });
    await sendConfirmationEmail({
      to: process.env.ZOHO_USER,
      subject: `New Street Team Application: ${name}`,
      text: `A new Street Team member has applied:\nName: ${name}\nEmail: ${email}\nCity: ${city}\nMessage: ${message}`
    });
    res.json({ success: true, message: "Street Team application submitted successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Waitlist Submission ---
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email || !reason) return res.status(400).json({ success: false, message: "Name, email, and reason are required." });
  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [name, email, source||"N/A", reason, new Date().toISOString()]);
    await sendConfirmationEmail({
      to: email,
      subject: "Welcome to the JoyFund Waitlist!",
      text: `Hi ${name}, welcome to the waitlist!`,
      html: `<p>Hi ${name}, welcome to the waitlist!</p>`
    });
    await sendConfirmationEmail({
      to: process.env.ZOHO_USER,
      subject: `New Waitlist Sign-Up: ${name}`,
      text: `A new person joined the waitlist:\nName: ${name}\nEmail: ${email}\nSource: ${source || "N/A"}\nReason: ${reason}`
    });
    res.json({ success: true, message: "Successfully joined the waitlist!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
