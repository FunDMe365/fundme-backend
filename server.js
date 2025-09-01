require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");
const bcrypt = require("bcrypt"); // for password hashing

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Google Sheets Setup =====
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
  scopes: SCOPES
});
const sheets = google.sheets({ version: "v4", auth });

// ===== Spreadsheet IDs =====
const SPREADSHEET_IDS = {
  volunteers: "1O_y1yDiYfO0RT8eGwBMtaiPWYYvSR8jIDIdZkZPlvNA",
  streetteam: "1dPz1LqQq6SKjZIwsgIpQJdQzdmlOV7YrOZJjHqC4Yg8",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
  users: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0"
};

// ===== Zoho SMTP Setup =====
const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.ZOHO_USER,      
    pass: process.env.ZOHO_APP_PASSWORD
  }
});

// ===== Helper: Save to Sheet =====
async function saveToSheet(sheetId, sheetName, values) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:E`,
      valueInputOption: "RAW",
      requestBody: { values: [values] }
    });
    console.log(`Saved to ${sheetName} sheet successfully.`);
  } catch (err) {
    console.error(`Error saving to ${sheetName}:`, err.message);
    throw err;
  }
}

// ===== User Helpers =====
async function saveUser({ name, email, password }) {
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await saveToSheet(
      SPREADSHEET_IDS.users,
      "Users",
      [name, email, hashedPassword, new Date().toISOString()]
    );
    console.log(`User ${email} saved successfully.`);
  } catch (err) {
    console.error(`Error saving user ${email}:`, err.message);
    throw err;
  }
}

async function verifyUser(email, password) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "Users!A:C"
    });
    const rows = response.data.values || [];
    const userRow = rows.find(row => row[1] === email);
    if (!userRow) return false;

    const hashedPassword = userRow[2];
    const match = await bcrypt.compare(password, hashedPassword);
    return match ? { name: userRow[0], email: userRow[1] } : false;
  } catch (err) {
    console.error(`Error verifying user ${email}:`, err.message);
    throw err;
  }
}

// ===== Create User Account Route =====
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: "Name, email, and password are required." });
  }

  try {
    await saveUser({ name, email, password });
    res.json({ success: true, message: "Account created successfully!", user: { name, email } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== Frontend Fetch Snippet for Signup =====
// Use this in your signup page script
/*
const signupForm = document.getElementById('signupForm');
signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('name').value;
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('http://localhost:3000/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const data = await res.json();
    if (data.success) {
      alert('Account created! You can now log in.');
    } else {
      alert('Signup failed: ' + data.message);
    }
  } catch (err) {
    console.error(err);
    alert('An error occurred during signup.');
  }
});
*/

// ===== Existing Templates & Routes =====
// ... keep all your waitlist, volunteer, and street team routes and email templates unchanged

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
