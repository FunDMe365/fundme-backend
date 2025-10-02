require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const sgMail = require("@sendgrid/mail");
const Stripe = require("stripe");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 5000;

// ===== Stripe Setup =====
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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
    const msg = { to, from: process.env.EMAIL_USER, subject, html };
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

// ===== JWT Middleware =====
function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, error: "No token provided." });
  const token = authHeader.split(' ')[1];
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, error: "Invalid token." });
    req.user = user;
    next();
  });
}

// ===== Routes =====

// --- Sign Up ---
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ success: false, message: "Name, email, and password are required." });
  try {
    await saveUser({ name, email, password });
    const token = jwt.sign({ name, email }, process.env.JWT_SECRET, { expiresIn: "1d" });
    res.json({ success: true, message: "Account created successfully!", token });
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
    const token = jwt.sign({ name: user.name, email: user.email }, process.env.JWT_SECRET, { expiresIn: "1d" });
    res.json({ success: true, message: "Signed in successfully.", token });
  } catch (err) {
    console.error("Signin error:", err.message);
    res.status(500).json({ success: false, error: "Server error." });
  }
});

// --- Dashboard ---
app.get("/api/dashboard", authenticateJWT, (req, res) => {
  const { name, email } = req.user;
  res.json({ success: true, name, email, campaigns: 0, donations: 0, recentActivity: [] });
});

// --- Profile ---
app.get("/api/profile", authenticateJWT, (req, res) => {
  res.json({ success: true, profile: req.user });
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

// ===== Volunteer Submission =====
app.post("/submit-volunteer", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ success: false, error: "All fields are required." });
  try {
    await saveToSheet(SPREADSHEET_IDS.volunteers, "Volunteers", [name, email, city, message, new Date().toISOString()]);
    setImmediate(async () => {
      await sendEmail({ to: email, subject: "🎉 Volunteer Application Received! 🌟", html: `<p>Thank you, ${name}!</p>` });
      await sendEmail({ to: process.env.RECEIVE_EMAIL, subject: "New Volunteer Application", html: `<p>Name: ${name}, Email: ${email}, City: ${city}, Message: ${message}</p>` });
    });
    res.json({ success: true, message: "✅ Volunteer application submitted successfully!" });
  } catch (err) {
    console.error("Volunteer submission error:", err.message);
    res.status(500).json({ success: false, error: "Failed to submit volunteer application." });
  }
});

// ===== Street Team Submission =====
app.post("/submit-streetteam", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ success: false, error: "All fields are required." });
  try {
    await saveToSheet(SPREADSHEET_IDS.streetteam, "StreetTeam", [name, email, city, message, new Date().toISOString()]);
    setImmediate(async () => {
      await sendEmail({ to: email, subject: "🎉 Street Team Application Received! 🌈", html: `<p>Thanks, ${name}!</p>` });
      await sendEmail({ to: process.env.RECEIVE_EMAIL, subject: "New Street Team Application", html: `<p>Name: ${name}, Email: ${email}, City: ${city}, Message: ${message}</p>` });
    });
    res.json({ success: true, message: "✅ Street Team application submitted successfully!" });
  } catch (err) {
    console.error("Street Team submission error:", err.message);
    res.status(500).json({ success: false, error: "Failed to submit Street Team application." });
  }
});

// ===== Messages =====
app.get("/api/messages", authenticateJWT, (req, res) => {
  if (!req.user.messages) req.user.messages = [];
  res.json({ success: true, messages: req.user.messages });
});

app.post("/api/messages", authenticateJWT, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ success: false, error: "Message text is required." });
  if (!req.user.messages) req.user.messages = [];
  req.user.messages.push({ text, timestamp: new Date().toISOString() });
  res.json({ success: true, message: "Message added.", messages: req.user.messages });
});

// ===== Stripe Donation Route =====
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 100) return res.status(400).json({ success: false, error: "Invalid donation amount (min $1)." });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Donation to JoyFund INC." },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      success_url: "https://fundasmile.net/thankyou.html",
      cancel_url: "https://fundasmile.net/cancel.html",
    });

    res.json({ success: true, url: session.url });
  } catch (error) {
    console.error("Stripe error:", error.message);
    res.status(500).json({ success: false, error: "Payment processing failed." });
  }
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
