const express = require("express");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");

const app = express();
app.use(bodyParser.json());

// ====================
// 1. GOOGLE SHEETS SETUP
// ====================
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json", // your Google Service Account key
  scopes: SCOPES,
});
const sheets = google.sheets({ version: "v4", auth });

// ====================
// 2. SPREADSHEET IDS
// ====================
const SPREADSHEET_IDS = {
  volunteers: "1O_y1yDiYfO0RT8eGwBMtaiPWYYvSR8jIDIdZkZPlvNA",
  streetteam: "1dPz1LqQq6SKjZIwsgIpQJdQzdmlOV7YrOZJjHqC4Yg8",
};

// ====================
// 3. ZOHO SMTP SETUP
// ====================
const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com",
  port: 465,
  secure: true,
  auth: {
    user: "admin@fundasmile.net",
    pass: "YOUR_ZOHO_APP_PASSWORD",
  },
});

// ====================
// 4. SAVE TO SHEET HELPER
// ====================
async function saveToSheet(sheetId, sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

// ====================
// 5. ROUTES
// ====================

// Volunteer form
app.post("/submit-volunteer", async (req, res) => {
  try {
    const { name, email, phone, message } = req.body;

    // Save to Volunteers sheet
    await saveToSheet(SPREADSHEET_IDS.volunteers, "Volunteers", [
      name,
      email,
      phone,
      message,
      new Date().toISOString(),
    ]);

    // Send confirmation email
    await transporter.sendMail({
      from: '"JoyFund INC." <admin@fundasmile.net>',
      to: email,
      subject: "Thank you for applying as a JoyFund Volunteer!",
      text: `Hi ${name},

Thank you for your interest in volunteering with JoyFund INC. 
Your application has been received and our team will review it.
A team member will contact you with next steps.

- JoyFund INC. Team`,
    });

    res.json({ success: true, message: "Volunteer form submitted successfully!" });
  } catch (error) {
    console.error("Volunteer error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Street Team form
app.post("/submit-streetteam", async (req, res) => {
  try {
    const { name, email, phone, message } = req.body;

    // Save to StreetTeam sheet
    await saveToSheet(SPREADSHEET_IDS.streetteam, "StreetTeam", [
      name,
      email,
      phone,
      message,
      new Date().toISOString(),
    ]);

    // Send confirmation email
    await transporter.sendMail({
      from: '"JoyFund INC." <admin@fundasmile.net>',
      to: email,
      subject: "Thank you for joining the JoyFund Street Team!",
      text: `Hi ${name},

Thank you for joining the JoyFund INC. Street Team! 
Your signup has been received. Street Team members are welcome to 
spread the word and share our mission, but please note: Street Team 
members are not official representatives of JoyFund INC.

- JoyFund INC. Team`,
    });

    res.json({ success: true, message: "Street Team form submitted successfully!" });
  } catch (error) {
    console.error("Street Team error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Optional route for third sheet
app.post("/submit-other", async (req, res) => {
  try {
    const { name, email, message } = req.body;
    await saveToSheet(SPREADSHEET_IDS.other, "OtherTabName", [
      name,
      email,
      message,
      new Date().toISOString(),
    ]);
    res.json({ success: true, message: "Submission saved!" });
  } catch (error) {
    console.error("Other sheet error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====================
// 6. START SERVER
// ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
