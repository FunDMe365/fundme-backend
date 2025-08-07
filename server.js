// === Dependencies ===
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const fs = require('fs');
const { google } = require('googleapis');
require('dotenv').config();

// === Init app ===
const app = express();

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
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = '16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ';
const range = 'FunDMe Waitlist!A2:A';

// === Route: Waitlist Signup ===
app.post('/api/waitlist', (req, res) => {
  const { name, email, reason } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  const waitlistEntry = {
    name,
    email,
    reason: reason || '',
    date: new Date().toISOString()
  };

  let waitlist = [];

  try {
    if (fs.existsSync('waitlist.json')) {
      const data = fs.readFileSync('waitlist.json', 'utf8');
      waitlist = JSON.parse(data);
    }
    waitlist.push(waitlistEntry);
    fs.writeFileSync('waitlist.json', JSON.stringify(waitlist, null, 2));
    res.status(200).json({ message: 'Waitlist submission successful.' });
  } catch (err) {
    console.error('Error writing to waitlist.json:', err);
    res.status(500).json({ error: 'Failed to save waitlist entry.' });
  }
});

// === Route: Live Waitlist Count from Google Sheets ===
app.get('/api/waitlist/live', async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range
    });

    const rows = response.data.values;
    const count = rows ? rows.filter(row => row[0]?.trim()).length : 0;

    res.json({ count });
  } catch (error) {
    console.error('Google Sheets fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch live waitlist count.' });
  }
});

// === Start Server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
