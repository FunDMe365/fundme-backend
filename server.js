// === Dependencies ===
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const fs = require('fs');
require('dotenv').config();
const { google } = require('googleapis');

// === Init app ===
const app = express();
const PORT = process.env.PORT || 5000;

// === Middleware ===
app.use(cors({
  origin: 'https://fundasmile.netlify.app',
  methods: ['POST', 'GET'],
  credentials: false
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === Google Sheets Setup ===
const key = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials: key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const spreadsheetId = process.env.SPREADSHEET_ID;
const range = process.env.SHEET_RANGE;

// === Test route ===
app.get('/', (req, res) => {
  res.send('Server is running!');
});

// === Endpoint: Waitlist submission ===
app.post('/api/waitlist', async (req, res) => {
  const { name, email, reason } = req.body;
  if (!name || !email || !reason) {
    return res.status(400).json({ error: 'Please provide name, email, and reason.' });
  }

  console.log('New waitlist submission:', { name, email, reason });

  // === Append to Google Sheet ===
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      resource: { values: [[name, email, reason, new Date().toISOString()]] }
    });
  } catch (err) {
    console.error('Error writing to Google Sheets:', err);
    return res.status(500).json({ error: 'Failed to save to Google Sheets.' });
  }

  // === Send notification email ===
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.VERIFY_USER,
      pass: process.env.VERIFY_PASS
    }
  });

  const mailOptions = {
    from: process.env.VERIFY_USER,
    to: process.env.VERIFY_USER,
    subject: 'New Campaign Waitlist Signup',
    text: `Name: ${name}\nEmail: ${email}\nReason: ${reason}`
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (err) {
    console.error('Error sending email:', err);
  }

  res.json({ message: `Thanks ${name}, you've joined the waitlist!` });
});

// === Endpoint: Get live waitlist count ===
app.get('/api/waitlist/live', async (req, res) => {
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const rows = response.data.values || [];
    res.json({ count: rows.length });
  } catch (error) {
    console.error('Error fetching waitlist count from Google Sheets:', error);
    res.status(500).json({ error: 'Failed to fetch waitlist count.' });
  }
});

// === Local JSON fallback ===
app.get('/api/waitlist/count/local', (req, res) => {
  try {
    const raw = fs.readFileSync('waitlist.json', 'utf-8');
    const fixedJson = `[${raw.trim().replace(/,\s*$/, '')}]`;
    const waitlist = JSON.parse(fixedJson);
    res.json({ count: waitlist.length });
  } catch (error) {
    console.error('Error counting waitlist entries:', error);
    res.status(500).json({ error: 'Failed to read or count waitlist entries.' });
  }
});

// === Start server ===
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
