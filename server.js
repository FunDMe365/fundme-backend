require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const sgMail = require("@sendgrid/mail");
const Stripe = require("stripe");
const cookieParser = require("cookie-parser"); // ✅ Already added

const app = express();
const PORT = process.env.PORT || 5000;

// ===== Stripe Setup =====
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ===== CORS Setup =====
app.use(cors({
  origin: "https://fundasmile.net", // ✅ exact frontend URL
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  credentials: true // ✅ allow cookies
}));
app.options("*", cors());

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser()); // ✅ Already added

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
    secure: process.env.NODE_ENV === "production", // ✅ must be true on HTTPS
    httpOnly: true,
    sameSite: 'none', // ✅ cross-site allowed
    maxAge: 1000 * 60 * 60 * 24 // 1 day
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

// ===== SendGrid Setup =====
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ===== Email Helper =====
async function sendEmail({ to, subject, html }) {
  try {
    const msg = {
      to,
      from: process.env.EMAIL_USER,
      subject,
      html
    };
    const response = await sgMail.send(msg);
    console.log(`✅ Email sent to ${to}:`, response[0].statusCode);
    return true;
  } catch (error) {
    if (error.response && error.response.body) {
      console.error("❌ SendGrid error:", error.response.body);
    } else {
      console.error("❌ SendGrid error:", error.message);
    }
    return false;
  }
}

// ===== Helper Functions =====
async function saveToSheet(sheetId, sheetName, values) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:Z`,
      valueInputOption: "RAW",
      requestBody: { values: [values] }
    });
  } catch (err) {
    console.error(`Error saving to ${sheetName}:`, err.message);
    throw err;
  }
}

async function saveUser({ name, email, password }) {
  const hashedPassword = await bcrypt.hash(password, 10);
  await saveToSheet(
    SPREADSHEET_IDS.users,
    "Users",
    [new Date().toISOString(), name, email, hashedPassword]
  );
}

async function verifyUser(email, password) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!A:D"
  });
  const rows = response.data.values || [];

  const userRow = rows.find(row => row[2].toLowerCase() === email.toLowerCase());
  if (!userRow) return false;

  const storedHash = userRow[3];
  const match = await bcrypt.compare(password, storedHash);
  return match ? { name: userRow[1], email: userRow[2] } : false;
}

// ===== Routes =====

// --- Sign Up ---
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ success: false, message: "Name, email, and password are required." });
  try {
    await saveUser({ name, email, password });
    res.json({ success: true, message: "Account created successfully!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error creating account." });
  }
});

// --- Sign In ---
app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: "Email and password required." });

  try {
    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ success: false, error: "Invalid email or password." });

    req.session.user = { name: user.name, email: user.email };
    // ✅ Ensure session is saved before sending response
    req.session.save(err => {
      if (err) {
        console.error("Session save error:", err);
        return res.status(500).json({ success: false, error: "Server error." });
      }
      res.json({ success: true, message: "Signed in successfully." });
    });
  } catch (err) {
    console.error("Signin error:", err.message);
    res.status(500).json({ success: false, error: "Server error." });
  }
});

// --- Dashboard ---
app.get("/api/dashboard", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  const { name, email } = req.session.user;
  res.json({ success: true, name, email, campaigns: 0, donations: 0, recentActivity: [] });
});

// --- Profile ---
app.get("/api/profile", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  res.json({ success: true, profile: req.session.user });
});

// ===== Waitlist Submission =====
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email || !source || !reason) return res.status(400).json({ success: false, error: "All fields are required." });

  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [name, email, source, reason, new Date().toISOString()]);

    setImmediate(async () => {
      await sendEmail({
        to: email,
        subject: "🎉 Welcome to the JoyFund Waitlist! 🌈",
        html: `<div style="font-family:Arial,sans-serif; text-align:center; color:#FF69B4;">
                <h1>🎊 Congratulations, ${name}! 🎊</h1>
                <p>You are officially on the JoyFund waitlist! 💖💙</p>
              </div>`
      });

      await sendEmail({
        to: process.env.RECEIVE_EMAIL,
        subject: "New Waitlist Submission",
        html: `<p>New waitlist submission: Name: ${name}, Email: ${email}, Source: ${source}, Reason: ${reason}</p>`
      });
    });

    res.json({ success: true, message: "🎉 Successfully joined the waitlist! Check your email for confirmation." });
  } catch (err) {
    console.error("Waitlist submission error:", err.message);
    res.status(500).json({ success: false, error: "Failed to save to waitlist. Please try again later." });
  }
});

// ===== Other Routes (Volunteer, Street Team, Messages, Stripe) =====
// ✅ No changes needed for mobile login

// ===== Start Server =====
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
