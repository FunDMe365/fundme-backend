require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
const cors = require("cors");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 5000;

// ===== CORS Setup =====
app.use(cors({
  origin: ["https://fundasmile.net", "http://localhost:3000"],
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  credentials: true
}));
app.options("*", cors());

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Session Setup =====
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    collectionName: 'sessions'
  }),
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: 'none',
    maxAge: 1000 * 60 * 60 * 24
  }
}));

// ===== Google Sheets Setup =====
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
  scopes: SCOPES
});
const sheets = google.sheets({ version: "v4", auth });

// ===== Spreadsheet IDs =====
const SPREADSHEET_IDS = {
  users: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
  volunteers: "1O_y1yDiYfO0RT8eGwBMtaiPWYYvSR8jIDIdZkZPlvNA",
  streetteam: "1dPz1LqQq6SKjZIwsgIpQJdQzdmlOV7YrOZJjHqC4Yg8",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ"
};

// ===== Nodemailer Setup (TLS 587) =====
const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.ZOHO_USER,
    pass: process.env.ZOHO_APP_PASSWORD
  },
  tls: {
    rejectUnauthorized: false
  }
});

// ===== Helper Functions =====
async function saveToSheet(sheetId, sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] }
  });
}

async function sendConfirmationEmail({ to, subject, text, html }) {
  try {
    await transporter.sendMail({
      from: `"JoyFund INC." <${process.env.ZOHO_USER}>`,
      to,
      subject,
      text,
      html
    });
  } catch (err) {
    console.error(`Email sending failed to ${to}:`, err.message);
  }
}

async function saveUser({ name, email, password }) {
  const hashedPassword = await bcrypt.hash(password, 10);
  await saveToSheet(
    SPREADSHEET_IDS.users,
    "Users",
    [name, email, hashedPassword, new Date().toISOString()]
  );
}

async function verifyUser(email, password) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!A:C"
  });
  const rows = response.data.values || [];
  const userRow = rows.find(row => row[1] === email);
  if (!userRow) return false;
  const match = await bcrypt.compare(password, userRow[2]);
  return match ? { name: userRow[0], email: userRow[1] } : false;
}

// ===== Routes =====

// --- Sign Up ---
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ success: false, message: "Name, email, and password are required." });

  try {
    await saveUser({ name, email, password });

    // Send confirmation emails asynchronously (won’t block response)
    sendConfirmationEmail({
      to: email,
      subject: "Welcome to JoyFund!",
      text: `Hi ${name},\n\nYour account was successfully created!`,
      html: `<p>Hi ${name},</p><p>Your account was successfully created!</p>`
    });

    sendConfirmationEmail({
      to: process.env.ADMIN_EMAIL,
      subject: "New User Signup",
      text: `New signup: ${name} (${email})`,
      html: `<p>New signup: <strong>${name}</strong> (${email})</p>`
    });

    res.json({ success: true, message: "Account created successfully!" });
  } catch (err) {
    console.error("Signup error:", err.message);
    res.status(500).json({ success: false, message: "Error creating account." });
  }
});

// --- Waitlist Submission ---
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email || !source || !reason) return res.status(400).json({ success: false, error: "All fields are required." });

  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [name, email, source, reason, new Date().toISOString()]);

    // Send emails asynchronously
    sendConfirmationEmail({
      to: email,
      subject: "Welcome to the JoyFund Waitlist!",
      text: `Hi ${name},\n\nThank you for joining the JoyFund waitlist!`,
      html: `<p>Hi ${name},</p><p>Thank you for joining the JoyFund waitlist!</p>`
    });

    sendConfirmationEmail({
      to: process.env.ADMIN_EMAIL,
      subject: "New Waitlist Submission",
      text: `New waitlist submission:\nName: ${name}\nEmail: ${email}\nSource: ${source}\nReason: ${reason}`,
      html: `<p>New waitlist submission:</p>
             <ul>
               <li><strong>Name:</strong> ${name}</li>
               <li><strong>Email:</strong> ${email}</li>
               <li><strong>Source:</strong> ${source}</li>
               <li><strong>Reason:</strong> ${reason}</li>
             </ul>`
    });

    res.json({ success: true, message: "🎉 Successfully joined the waitlist! Check your email for confirmation." });
  } catch (err) {
    console.error("Waitlist error:", err.message);
    res.status(500).json({ success: false, error: "Failed to save to waitlist. Please try again later." });
  }
});

// --- Other routes remain unchanged ---
// Signin, Dashboard, Profile, Messages, Logout remain exactly as before

// ===== Start Server =====
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
