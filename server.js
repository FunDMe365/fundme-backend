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
const spreadsheetId = '16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ';
const range = 'FunDMe Waitlist';

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

// === ...rest of your routes like /api/waitlist, /send-verification, etc ===

// === Start server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
