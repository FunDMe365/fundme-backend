const express = require("express");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// ===== Google Sheets Setup =====
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json", // your service account JSON
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
    pass: "4ZHiGKhwMt1M"
  }
});

// ===== Helper: Save to Sheet =====
async function saveToSheet(sheetId, sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] }
  });
}

// ===== Routes =====
// Volunteer
app.post("/submit-volunteer", async (req, res) => {
  try {
    const { name, email, city, message } = req.body;
    await saveToSheet(SPREADSHEET_IDS.volunteers, "Volunteers", [
      name, email, city, message, new Date().toISOString()
    ]);

    await transporter.sendMail({
      from: '"JoyFund INC." <admin@fundasmile.net>',
      to: email,
      subject: "Thank you for applying as a JoyFund Volunteer!",
      text: `Hi ${name},

Thank you for your interest in volunteering with JoyFund INC. Your application has been received and our team will review it.
A team member will contact you with next steps.

- JoyFund INC. Team`
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Street Team
app.post("/submit-streetteam", async (req, res) => {
  try {
    const { name, email, city, message } = req.body;
    await saveToSheet(SPREADSHEET_IDS.streetteam, "StreetTeam", [
      name, email, city, message, new Date().toISOString()
    ]);

    await transporter.sendMail({
      from: '"JoyFund INC." <admin@fundasmile.net>',
      to: email,
      subject: "Thank you for joining the JoyFund Street Team!",
      text: `Hi ${name},

Thank you for joining the JoyFund INC. Street Team!
You can promote our mission and share information, but please remember: Street Team members are not official representatives of JoyFund INC.

- JoyFund INC. Team`
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
