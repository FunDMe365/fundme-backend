// === Dependencies ===
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const fs = require('fs');
const mongoose = require('mongoose');
require('dotenv').config();
const { google } = require('googleapis');

// === Init app ===
const app = express();
const PORT = process.env.PORT || 5000;

// === Middleware ===
app.use(cors({
  origin: 'https://fundasmile.net',
  methods: ['POST','GET']
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// === MongoDB Connection ===
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error('MongoDB connection error:', err));

// === Google Sheets Setup ===
const googleCredentials = {
  type: process.env.GOOGLE_TYPE,
  project_id: process.env.GOOGLE_PROJECT_ID,
  private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // fix literal newlines
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  client_id: process.env.GOOGLE_CLIENT_ID
};

// === Google Sheets Auth & Config ===
const auth = new google.auth.GoogleAuth({
  credentials: googleCredentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const spreadsheetId = process.env.SPREADSHEET_ID;  // Your sheet ID
const range = process.env.SHEET_RANGE;             // Example: "Sheet1!A:D"

// === Nodemailer Setup ===
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// === Test Route ===
app.get('/', (req, res) => {
  res.send('Server is running!');
});

// === Waitlist Submission ===
app.post('/api/waitlist', async (req, res) => {
  const { name, email, reason } = req.body;
  if (!name || !email || !reason) {
    return res.status(400).json({ error: 'Please provide name, email, and reason.' });
  }

  console.log('New waitlist submission:', { name, email, reason });

  // --- Append to Google Sheet ---
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

  // --- Send notification email ---
  try {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.RECEIVE_EMAIL,
      subject: 'New Campaign Waitlist Signup',
      text: `Name: ${name}\nEmail: ${email}\nReason: ${reason}`
    };
    await transporter.sendMail(mailOptions);
  } catch (err) {
    console.error('Error sending email:', err);
  }

  // --- Save locally as backup ---
  try {
    const entry = { name, email, reason, date: new Date().toISOString() };
    const data = fs.existsSync('waitlist.json') ? fs.readFileSync('waitlist.json', 'utf-8') : '[]';
    const waitlist = JSON.parse(data || '[]');
    waitlist.push(entry);
    fs.writeFileSync('waitlist.json', JSON.stringify(waitlist, null, 2));
  } catch (error) {
    console.error('Error saving to local JSON:', error);
  }

  res.json({ message: `Thanks ${name}, you've joined the waitlist!` });
});

// === Get live waitlist count from Google Sheets ===
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

// === Local JSON fallback for waitlist count ===
app.get('/api/waitlist/count/local', (req, res) => {
  try {
    const raw = fs.readFileSync('waitlist.json', 'utf-8');
    const waitlist = JSON.parse(raw || '[]');
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
