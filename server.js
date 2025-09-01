require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");
const bcrypt = require("bcrypt"); // for password hashing

const app = express();

// ===== CORS Setup =====
// Allow your frontend domain (https://fundasmile.net)
app.use(cors({
  origin: ["https://fundasmile.net", "http://localhost:3000"],
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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

// ===== Helper: Save to Sheet =====
async function saveToSheet(sheetId, sheetName, values) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:Z`,
      valueInputOption: "RAW",
      requestBody: { values: [values] }
    });
    console.log(`Saved to ${sheetName} sheet successfully.`);
  } catch (err) {
    console.error(`Error saving to ${sheetName}:`, err.message);
    throw err;
  }
}

// ===== Helper: Send Email =====
async function sendConfirmationEmail({ to, subject, text, html }) {
  try {
    await transporter.sendMail({
      from: `"JoyFund INC." <${process.env.ZOHO_USER}>`,
      to,
      subject,
      text,
      html
    });
    console.log(`Email sent to ${to}`);
  } catch (err) {
    console.error(`Error sending email to ${to}:`, err.message);
    throw err;
  }
}

// ===== User Helpers =====
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

// ===== Sign-in Route =====
app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Email and password are required." });
  }

  try {
    // 1️⃣ Get all users from your Google Sheet
    const sheetRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users, // make sure you have this in your SPREADSHEET_IDS
      range: "Users!A:D" // Name | Email | Password | Date
    });

    const rows = sheetRes.data.values || [];

    // 2️⃣ Find the user by email
    const userRow = rows.find(r => r[1] === email);
    if (!userRow) {
      return res.status(401).json({ success: false, error: "User not found." });
    }

    const [name, userEmail, hashedPassword] = userRow;

    // 3️⃣ Compare password
    const match = await bcrypt.compare(password, hashedPassword);
    if (!match) {
      return res.status(401).json({ success: false, error: "Incorrect password." });
    }

    // 4️⃣ Return user info to frontend
    res.json({
      success: true,
      user: { name, email: userEmail }
    });

  } catch (err) {
    console.error("Signin error:", err.message);
    res.status(500).json({ success: false, error: "Server error." });
  }
});

// Get user's campaigns
app.post("/api/campaigns", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const sheet = await authSheets(); // function to authorize Google Sheets API
    const response = await sheet.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: "Campaigns!A:D" // Adjust columns: A=ownerEmail, B=title, C=status, D=amount
    });

    const rows = response.data.values || [];
    const userCampaigns = rows
      .filter(row => row[0] === email)
      .map(row => ({
        title: row[1],
        status: row[2],
        amount: row[3]
      }));

    res.json(userCampaigns);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch campaigns" });
  }
});

// Get user's messages
app.post("/api/messages", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const sheet = await authSheets(); // same Google Sheets authorization
    const response = await sheet.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: "Messages!A:D" // A=toEmail, B=from, C=message, D=date
    });

    const rows = response.data.values || [];
    const userMessages = rows
      .filter(row => row[0] === email)
      .map(row => ({
        from: row[1],
        text: row[2],
        date: row[3]
      }));

    res.json(userMessages);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// --- Volunteer ---
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

// --- Street Team ---
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

// --- Waitlist ---
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
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
