const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const fs = require('fs');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();

// === CORS ===
app.use(cors({
  origin: 'https://fundasmile.netlify.app',
  methods: ['POST', 'GET'],
  credentials: false
}));

// === Middleware ===
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === Google Sheets Setup ===
const key = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const auth = new google.auth.GoogleAuth({
  credentials: key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

const spreadsheetId = '16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ'; // Your Sheet ID
const range = 'FunDMe Waitlist'; // Your sheet name or range

// === Test route returning fake count ===
app.get('/api/waitlist-count', (req, res) => {
  res.json({ count: 42 });
});

// === Live waitlist count from Google Sheets ===
app.get('/api/waitlist/live', async (req, res) => {
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const rows = response.data.values || [];
    const count = rows.length;

    res.json({ count });
  } catch (error) {
    console.error('Error fetching waitlist count from Google Sheets:', error);
    res.status(500).json({ error: 'Failed to fetch waitlist count.' });
  }
});

// === Waitlist Email Route ===
app.post('/api/waitlist', async (req, res) => {
  const { name, email, reason } = req.body;

  if (!name || !email || !reason) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_PASS
    }
  });

  const mailOptions = {
    from: process.env.GMAIL_USER,
    to: process.env.GMAIL_USER,
    subject: 'New Campaign Waitlist Signup',
    text: `Name: ${name}\nEmail: ${email}\nReason: ${reason}`
  };

  try {
    await transporter.sendMail(mailOptions);
    res.json({ success: true, message: 'Waitlist request received.' });
  } catch (error) {
    console.error('Waitlist email error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// === Local JSON fallback count ===
app.get('/api/waitlist/count/local', (req, res) => {
  try {
    const raw = fs.readFileSync('waitlist.json', 'utf-8');
    const fixedJson = `[${raw.trim().replace(/,\s*$/, '')}]`;
    const waitlist = JSON.parse(fixedJson);
    const count = waitlist.length;

    res.json({ count });
  } catch (error) {
    console.error('Error counting waitlist entries:', error);
    res.status(500).json({ error: 'Failed to read or count waitlist entries.' });
  }
});

// === Join waitlist (save to local file) ===
app.post('/join-waitlist', (req, res) => {
  const { name, email, idea } = req.body;
  const entry = { name, email, idea, date: new Date().toISOString() };

  fs.appendFile('waitlist.json', JSON.stringify(entry) + ',\n', (err) => {
    if (err) {
      console.error('Error saving waitlist entry:', err);
      return res.status(500).send('Failed to save');
    }
    res.send('Success');
  });
});

// === Verification Email ===
app.post('/send-verification', async (req, res) => {
  const { email } = req.body;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.VERIFY_USER,
      pass: process.env.VERIFY_PASS
    }
  });

  const mailOptions = {
    from: `FunDMe <${process.env.VERIFY_USER}>`,
    to: email,
    subject: 'Please verify your email address',
    text: `Hi there, please verify your email by clicking the link below:\n\nhttp://localhost:5500/verify-email.html`
  };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).send({ message: 'Verification email sent!' });
  } catch (err) {
    console.error('Verification email error:', err);
    res.status(500).send({ message: 'Failed to send email', error: err });
  }
});

// === Start server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
