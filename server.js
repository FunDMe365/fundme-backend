// server.js
console.log("GOOGLE_CREDENTIALS_JSON loaded?", !!process.env.GOOGLE_CREDENTIALS_JSON);
console.log("ZOHO_APP_PASSWORD loaded?", !!process.env.ZOHO_APP_PASSWORD);
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Google Sheets Setup =====
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
// Use environment variable for credentials instead of a physical file
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
  scopes: SCOPES
});
const sheets = google.sheets({ version: "v4", auth });

// ===== Spreadsheet IDs =====
const SPREADSHEET_IDS = {
  volunteers: "1O_y1yDiYfO0RT8eGwBMtaiPWYYvSR8jIDIdZkZPlvNA",
  streetteam: "1dPz1LqQq6SKjZIwsgIpQJdQzdmlOV7YrOZJjHqC4Yg8"
};

// ===== Zoho SMTP Setup =====
const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com",
  port: 465,
  secure: true,
  auth: {
    user: "admin@fundasmile.net",
    pass: process.env.QpAzxRbqV0wt // store Zoho password as env var
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
async function sendConfirmationEmail(to, subject, text) {
  try {
    await transporter.sendMail({
      from: '"JoyFund INC." <admin@fundasmile.net>',
      to,
      subject,
      text
    });
    console.log(`Email sent to ${to}`);
  } catch (err) {
    console.error(`Error sending email to ${to}:`, err.message);
    throw err;
  }
}

// ===== Routes =====

// Volunteer submission
app.post("/submit-volunteer", async (req, res) => {
  console.log("Volunteer submission received:", req.body);
  const { name, email, city, message } = req.body;

  if (!name || !email || !city || !message) {
    return res.status(400).json({ success: false, error: "All fields are required." });
  }

  try {
    await saveToSheet(SPREADSHEET_IDS.volunteers, "Volunteers", [
      name, email, city, message, new Date().toISOString()
    ]);

    await sendConfirmationEmail(
      email,
      "Thank you for applying as a JoyFund Volunteer!",
      `Hi ${name},\n\nThank you for your interest in volunteering with JoyFund INC. Your application has been received and our team will review it.\nA team member will contact you with next steps.\n\n- JoyFund INC. Team`
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Street Team submission
app.post("/submit-streetteam", async (req, res) => {
  console.log("Street Team submission received:", req.body);
  const { name, email, city, message } = req.body;

  if (!name || !email || !city || !message) {
    return res.status(400).json({ success: false, error: "All fields are required." });
  }

  try {
    await saveToSheet(SPREADSHEET_IDS.streetteam, "StreetTeam", [
      name, email, city, message, new Date().toISOString()
    ]);

    await sendConfirmationEmail(
      email,
      "Thank you for joining the JoyFund Street Team!",
      `Hi ${name},\n\nThank you for joining the JoyFund INC. Street Team!\nYou can promote our mission and share information, but please remember: Street Team members are not official representatives of JoyFund INC.\n\n- JoyFund INC. Team`
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
