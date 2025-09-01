require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");
const bcrypt = require("bcrypt"); // for password hashing

const app = express();

// ===== CORS Setup =====
app.use(cors({
  origin: function(origin, callback){
    // allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if(['https://fundasmile.net','http://localhost:3000'].indexOf(origin) === -1){
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());

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
  volunteers: "1O_y1yDiYfO0RT8eGwBMtaiPWYYvSR8jIDIdZkZPlvNA",
  streetteam: "1dPz1LqQq6SKjZIwsgIpQJdQzdmlOV7YrOZJjHqC4Yg8",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
  users: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0"
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

// ===== User Helpers =====
async function saveUser({ name, email, password }) {
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await saveToSheet(
      SPREADSHEET_IDS.users,
      "Users",
      [name, email, hashedPassword, new Date().toISOString()]
    );
    console.log(`User ${email} saved successfully.`);
  } catch (err) {
    console.error(`Error saving user ${email}:`, err.message);
    throw err;
  }
}

async function verifyUser(email, password) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "Users!A:C"
    });
    const rows = response.data.values || [];
    const userRow = rows.find(row => row[1] === email);
    if (!userRow) return false;

    const hashedPassword = userRow[2];
    const match = await bcrypt.compare(password, hashedPassword);
    return match ? { name: userRow[0], email: userRow[1] } : false;
  } catch (err) {
    console.error(`Error verifying user ${email}:`, err.message);
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

// ===== HTML Templates =====
function waitlistTemplate(name) {
  return `<html>...your waitlist HTML here...</html>`;
}
function volunteerTemplate(name) {
  return `<html>...your volunteer HTML here...</html>`;
}
function streetTeamTemplate(name) {
  return `<html>...your street team HTML here...</html>`;
}

// ===== Routes =====

// Volunteer
app.post("/submit-volunteer", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) {
    return res.status(400).json({ success: false, error: "All fields are required." });
  }
  try {
    await saveToSheet(SPREADSHEET_IDS.volunteers, "Volunteers", [name, email, city, message, new Date().toISOString()]);
    await sendConfirmationEmail({ to: email, subject: "Thank you for applying as a JoyFund Volunteer!", text: `Hi ${name}, ...`, html: volunteerTemplate(name) });
    await sendConfirmationEmail({ to: process.env.ZOHO_USER, subject: `New Volunteer Application: ${name}`, text: `A new volunteer has applied:\nName: ${name}\nEmail: ${email}\nCity: ${city}\nMessage: ${message}` });
    res.json({ success: true, message: "Volunteer application submitted successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Street Team
app.post("/submit-streetteam", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) {
    return res.status(400).json({ success: false, error: "All fields are required." });
  }
  try {
    await saveToSheet(SPREADSHEET_IDS.streetteam, "StreetTeam", [name, email, city, message, new Date().toISOString()]);
    await sendConfirmationEmail({ to: email, subject: "Thank you for joining the JoyFund Street Team!", text: `Hi ${name}, ...`, html: streetTeamTemplate(name) });
    await sendConfirmationEmail({ to: process.env.ZOHO_USER, subject: `New Street Team Application: ${name}`, text: `A new Street Team member has applied:\nName: ${name}\nEmail: ${email}\nCity: ${city}\nMessage: ${message}` });
    res.json({ success: true, message: "Street Team application submitted successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Waitlist
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email || !reason) {
    return res.status(400).json({ success: false, message: "Name, email, and reason are required." });
  }
  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [name, email, source||"N/A", reason, new Date().toISOString()]);
    await sendConfirmationEmail({ to: email, subject: "Welcome to the JoyFund Waitlist!", text: `Hi ${name}, ...`, html: waitlistTemplate(name) });
    await sendConfirmationEmail({ to: process.env.ZOHO_USER, subject: `New Waitlist Sign-Up: ${name}`, text: `A new person joined the waitlist:\nName: ${name}\nEmail: ${email}\nSource: ${source || "N/A"}\nReason: ${reason}` });
    res.json({ success: true, message: "Successfully joined the waitlist!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// User Signup
app.post("/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: "Name, email, and password are required." });
  }
  try {
    await saveUser({ name, email, password });
    res.json({ success: true, message: "Account created successfully!", user: { name, email } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
