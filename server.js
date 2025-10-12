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

const app = express();
const PORT = process.env.PORT || 5000;

// ===== Stripe Setup =====
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ===== CORS Setup =====
app.use(cors({
  origin: ["https://fundasmile.net", "http://localhost:3000"],
  methods: ["GET", "POST", "PUT", "OPTIONS", "DELETE"],
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
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
  campaigns: "1XSS-2WJpzEhDe6RHBb8rt_6NNWNqdFpVTUsRa3TNCG8"
};

// ===== SendGrid Setup =====
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ===== Email Helper =====
async function sendEmail({ to, subject, html }) {
  try {
    const msg = { to, from: process.env.EMAIL_USER, subject, html };
    await sgMail.send(msg);
    return true;
  } catch (error) {
    console.error("SendGrid error:", error.response?.body || error.message);
    return false;
  }
}

// ===== Helper Functions =====
async function saveToSheet(sheetId, sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] }
  });
}

async function saveUser({ name, email, password }) {
  const hashedPassword = await bcrypt.hash(password, 10);
  await saveToSheet(SPREADSHEET_IDS.users, "Users", [new Date().toISOString(), name, email, hashedPassword]);
}

async function verifyUser(email, password) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!A:D"
  });
  const rows = response.data.values || [];
  const userRow = rows.find(row => row[2]?.toLowerCase() === email.toLowerCase());
  if (!userRow) return false;
  const match = await bcrypt.compare(password, userRow[3]);
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
    res.json({ success: true, message: "Signed in successfully." });
  } catch {
    res.status(500).json({ success: false, error: "Server error." });
  }
});

// --- Dashboard ---
app.get("/api/dashboard", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, error: "Email is required." });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:F"
    });

    const rows = response.data.values || [];
    if (rows.length < 2) return res.json({ success: true, campaigns: 0, donations: 0, recentActivity: [] });

    const headers = rows[0];
    const dataRows = rows.slice(1);

    const userCampaigns = dataRows.filter(r => r[2]?.trim().toLowerCase() === email.toLowerCase());
    const formattedCampaigns = userCampaigns.map(r => ({ id: r[0], title: r[1], email: r[2], goal: r[3], description: r[4], status: r[5] || "Active" }));

    res.json({
      success: true,
      email,
      campaigns: formattedCampaigns.length,
      donations: 0,
      recentActivity: formattedCampaigns.slice(-3).reverse(),
      allCampaigns: formattedCampaigns
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to fetch dashboard data." });
  }
});

// --- Profile ---
app.get("/api/profile", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  res.json({ success: true, profile: req.session.user });
});

// --- Waitlist ---
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email || !source || !reason) return res.status(400).json({ success: false, error: "All fields are required." });
  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [name, email, source, reason, new Date().toISOString()]);
    sendEmail({ to: email, subject: "Welcome to JoyFund Waitlist", html: `<h1>Hi ${name}, you're on the waitlist!</h1>` });
    res.json({ success: true, message: "Joined waitlist!" });
  } catch {
    res.status(500).json({ success: false, error: "Failed to save to waitlist." });
  }
});

// --- Volunteers ---
app.post("/submit-volunteer", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ success: false, error: "All fields are required." });
  try {
    await saveToSheet(SPREADSHEET_IDS.volunteers, "Volunteers", [name, email, city, message, new Date().toISOString()]);
    res.json({ success: true, message: "Volunteer submitted!" });
  } catch {
    res.status(500).json({ success: false, error: "Failed to submit volunteer." });
  }
});

// --- Street Team ---
app.post("/submit-streetteam", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ success: false, error: "All fields are required." });
  try {
    await saveToSheet(SPREADSHEET_IDS.streetteam, "StreetTeam", [name, email, city, message, new Date().toISOString()]);
    res.json({ success: true, message: "Street Team submitted!" });
  } catch {
    res.status(500).json({ success: false, error: "Failed to submit Street Team." });
  }
});

// --- Logout ---
app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// --- Messages ---
app.get("/api/messages", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  if (!req.session.messages) req.session.messages = [];
  res.json({ success: true, messages: req.session.messages });
});
app.post("/api/messages", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  const { text } = req.body;
  if (!text) return res.status(400).json({ success: false, error: "Message text required." });
  if (!req.session.messages) req.session.messages = [];
  req.session.messages.push({ text, timestamp: new Date().toISOString() });
  res.json({ success: true, message: "Message added.", messages: req.session.messages });
});

// --- Stripe ---
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 100) return res.status(400).json({ success: false, error: "Invalid donation amount." });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [{ price_data: { currency: "usd", product_data: { name: "Donation to JoyFund" }, unit_amount: amount }, quantity: 1 }],
      success_url: "https://fundasmile.net/thankyou.html",
      cancel_url: "https://fundasmile.net/cancel.html"
    });
    res.json({ success: true, url: session.url });
  } catch {
    res.status(500).json({ success: false, error: "Payment failed." });
  }
});

// --- Campaigns ---
app.post("/api/campaigns", async (req, res) => {
  try {
    const { title, description, goal, category, email } = req.body;
    if (!title || !description || !goal || !category || !email) return res.status(400).json({ success: false, error: "All fields required." });
    const id = Date.now().toString();
    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [id, title, description, goal, category, email, new Date().toISOString()]);
    res.json({ success: true, message: "Campaign created!", id });
  } catch {
    res.status(500).json({ success: false, error: "Failed to create campaign." });
  }
});

app.get("/api/campaigns", async (req, res) => {
  try {
    const result = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_IDS.campaigns, range: "Campaigns!A:G" });
    const rows = result.data.values || [];
    const campaigns = rows.slice(1).map(r => ({ id: r[0], title: r[1], description: r[2], goal: r[3], category: r[4], email: r[5], dateCreated: r[6] }));
    res.json({ success: true, campaigns });
  } catch {
    res.status(500).json({ success: false, error: "Failed to fetch campaigns." });
  }
});

app.delete("/api/campaigns/:id", async (req, res) => {
  const campaignId = req.params.id;
  try {
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_IDS.campaigns, range: "Campaigns!A:G" });
    const rows = response.data.values || [];
    const dataRows = rows.slice(1);
    const index = dataRows.findIndex(r => r[0] === campaignId);
    if (index === -1) return res.status(404).json({ success: false, error: "Campaign not found." });

    const sheetRow = index + 2;
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      requestBody: { requests: [{ deleteDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: sheetRow - 1, endIndex: sheetRow } } }] }
    });

    res.json({ success: true, message: "Campaign deleted successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to delete campaign." });
  }
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
