require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const mongoose = require('mongoose');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// === MongoDB Setup ===
mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000
})
.then(() => console.log('✅ Connected to MongoDB'))
.catch(err => {
  console.error('❌ MongoDB connection error:', err.message);
  process.exit(1);
});

// === Nodemailer Setup ===
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Verify transporter
transporter.verify((err, success) => {
  if (err) {
    console.error('❌ Email transporter error:', err);
  } else {
    console.log('✅ Email transporter ready');
  }
});

// === Google Sheets Setup ===
let googleCredentials;
try {
  googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  googleCredentials.private_key = googleCredentials.private_key.replace(/\\n/g, '\n');
} catch (err) {
  console.error('❌ Invalid GOOGLE_CREDENTIALS JSON:', err);
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials: googleCredentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

// === Example Route: Waitlist Form Submission ===
app.post('/waitlist', async (req, res) => {
  const { name, email } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  try {
    // Append to Google Sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:B',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[name, email, new Date().toISOString()]]
      }
    });

    // Send confirmation email
    await transporter.sendMail({
      from: `"FunDMe" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'You are on the Waitlist!',
      text: `Hi ${name},\n\nThanks for joining the FunDMe waitlist! 🎉\n\nWe’ll keep you updated.\n\n- The FunDMe Team`
    });

    res.status(200).json({ message: '✅ Successfully added to waitlist!' });
  } catch (err) {
    console.error('❌ Error in /waitlist route:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// === Start Server ===
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
