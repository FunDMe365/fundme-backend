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
// MongoDB connection (non-blocking)
// =======================
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => {
    console.error('❌ MongoDB connection error (ignored):', err.message);
  });

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
// Google Sheets setup (use full service account JSON)
// =======================
let sheetsClient;
try {
  const serviceAccountJSON = process.env.GOOGLE_SERVICE_KEY_JSON;
  if (!serviceAccountJSON) throw new Error('Missing GOOGLE_SERVICE_KEY_JSON');

  const serviceAccount = JSON.parse(serviceAccountJSON);

  const auth = new google.auth.JWT(
    serviceAccount.client_email,
    null,
    serviceAccount.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );

  sheetsClient = google.sheets({ version: 'v4', auth });
  console.log('✅ Google Sheets client ready');
} catch (err) {
  console.error('❌ Google Sheets setup error:', err.message);
}

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

    // Append to Google Sheet
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

    // Send confirmation email
    if (emailEnabled && transporter) {
      try {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: email,
          subject: '🎉 You joined the JoyFund waitlist!',
          html: `<p>Hi ${name},</p>
                 <p>Thank you for joining the JoyFund INC. waitlist. We'll keep you updated!</p>
                 <p>– JoyFund Team</p>`
        });
        console.log('✅ Confirmation email sent');
      } catch (mailErr) {
        console.error('⚠️ Email send error (submission OK):', mailErr.message);
      }
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
