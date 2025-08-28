require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// =======================
// MongoDB connection
// =======================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err.message));

// =======================
// Nodemailer transporter
// =======================
const emailEnabled = process.env.EMAIL_ENABLED !== 'false';
let transporter;

if (emailEnabled) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    },
    tls: { rejectUnauthorized: false }
  });

  transporter.verify()
    .then(() => console.log('✅ Email transporter ready'))
    .catch(err => console.error('❌ Email transporter error:', err));
} else {
  console.log('⚠️ Email sending disabled (EMAIL_ENABLED=false)');
}

// =======================
// Google Sheets setup
// =======================
// ================= GOOGLE SHEETS AUTH =================
const { google } = require("googleapis");

let sheetsClient;
async function initGoogleSheets() {
  try {
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // 🔑 fix newline issue
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    await auth.authorize();
    sheetsClient = google.sheets({ version: "v4", auth });
    console.log("✅ Google Sheets client ready");
  } catch (err) {
    console.error("❌ Google Sheets setup error:", err);
  }
}
initGoogleSheets();

// =======================
// Waitlist submission
// =======================
app.post('/api/waitlist', async (req, res) => {
  const { name, email, source, reason } = req.body;

  if (!name || !email || !reason) {
    return res.status(400).json({ message: 'Missing required fields.' });
  }

  try {
    console.log('📥 Incoming submission:', { name, email, source, reason });

    if (!sheetsClient) throw new Error('Sheets client not initialized');

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: process.env.SHEET_RANGE,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[new Date().toLocaleString(), name, email, source || '', reason]]
      }
    });
    console.log('✅ Saved to Google Sheets');

    if (emailEnabled && transporter) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: '🎉 You joined the JoyFund waitlist!',
        html: `<p>Hi ${name},</p>
               <p>Thank you for joining the JoyFund INC. waitlist. We'll keep you updated!</p>
               <p>– JoyFund Team</p>`
      });
      console.log('✅ Confirmation email sent');
    }

    res.json({ message: '🎉 Successfully joined the waitlist!' });
  } catch (err) {
    console.error('❌ Waitlist submission error:', err.message);
    res.status(500).json({ message: '❌ Could not submit. Please try again later.' });
  }
});

// =======================
// Start server
// =======================
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
