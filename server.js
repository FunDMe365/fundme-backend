// server.js - complete, ready-to-run (replace your existing server.js with this)
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
const path = require("path");
const multer = require("multer");
const fs = require("fs");

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

// Serve uploaded images (ensure folder exists)
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

// ===== Session Setup =====
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI, collectionName: 'sessions' }),
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
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON || "{}"),
  scopes: SCOPES
});
const sheets = google.sheets({ version: "v4", auth });

// ===== Spreadsheet IDs =====
// Keep these as you had them; update env if you want later
const SPREADSHEET_IDS = {
  users: process.env.SPREADSHEET_USERS || "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
  volunteers: process.env.SPREADSHEET_VOLUNTEERS || "1O_y1yDiYfO0RT8eGwBMtaiPWYYvSR8jIDIdZkZPlvNA",
  streetteam: process.env.SPREADSHEET_STREETTEAM || "1dPz1LqQq6SKjZIwsgIpQJdQzdmlOV7YrOZJjHqC4Yg8",
  waitlist: process.env.SPREADSHEET_WAITLIST || "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
  campaigns: process.env.SPREADSHEET_CAMPAIGNS || "1XSS-2WJpzEhDe6RHBb8rt_6NNWNqdFpVTUsRa3TNCG8"
};

// ===== SendGrid Setup =====
sgMail.setApiKey(process.env.SENDGRID_API_KEY || "");

// ===== Helpers =====
async function sendEmail({ to, subject, html }) {
  try {
    if (!process.env.SENDGRID_API_KEY) {
      console.warn("SendGrid API key not set; skipping email to", to);
      return false;
    }
    await sgMail.send({ to, from: process.env.EMAIL_USER, subject, html });
    return true;
  } catch (err) {
    console.error("SendGrid error:", err.response?.body || err.message);
    return false;
  }
}

async function saveToSheet(sheetId, sheetName, values) {
  if (!sheetId) throw new Error("Missing sheetId");
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] }
  });
}

async function saveUser({ name, email, password }) {
  const hash = await bcrypt.hash(password, 10);
  await saveToSheet(SPREADSHEET_IDS.users, "Users", [new Date().toISOString(), name, email, hash]);
}

async function verifyUser(email, password) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!A:D"
  });
  const rows = data.values || [];
  const row = rows.find(r => r[2] && r[2].toLowerCase() === email.toLowerCase());
  if (!row) return false;
  const match = await bcrypt.compare(password, row[3]);
  return match ? { name: row[1], email: row[2] } : false;
}

// ===== Multer Setup for Campaign Images =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// ===== Routes =====

// Sign Up
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ success: false, message: "Name, email, and password required." });
  try {
    await saveUser({ name, email, password });
    res.json({ success: true, message: "Account created!" });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ success: false, message: "Error creating account." });
  }
});

// Sign In
app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: "Email & password required." });
  try {
    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ success: false, error: "Invalid credentials." });
    req.session.user = { name: user.name, email: user.email };
    res.json({ success: true, message: "Signed in!" });
  } catch (err) {
    console.error("Signin error:", err);
    res.status(500).json({ success: false, error: "Server error." });
  }
});

// Profile
app.get("/api/profile", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  res.json({ success: true, profile: req.session.user });
});

// Profile Update
app.post("/api/profile/update", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  const { name, email, password } = req.body;
  try {
    const hash = password ? await bcrypt.hash(password, 10) : "";
    await saveToSheet(SPREADSHEET_IDS.users, "Users", [new Date().toISOString(), name, email, hash]);
    req.session.user = { name, email };
    res.json({ success: true, message: "Profile updated!" });
  } catch (err) {
    console.error("Profile update error:", err);
    res.status(500).json({ success: false, error: "Update failed." });
  }
});

// Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Waitlist
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email || !source || !reason) return res.status(400).json({ success: false, error: "All fields required." });
  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [name, email, source, reason, new Date().toISOString()]);
    sendEmail({ to: email, subject: "Welcome to the Waitlist", html: `<p>Hi ${name}, you're on the waitlist!</p>` });
    res.json({ success: true, message: "Joined waitlist!" });
  } catch (err) {
    console.error("Waitlist error:", err);
    res.status(500).json({ success: false, error: "Failed to save." });
  }
});

// Volunteers & Street Team
app.post("/submit-volunteer", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ success: false, error: "All fields required" });
  try {
    await saveToSheet(SPREADSHEET_IDS.volunteers, "Volunteers", [name, email, city, message, new Date().toISOString()]);
    res.json({ success: true, message: "Volunteer submitted!" });
  } catch (err) {
    console.error("Volunteer error:", err);
    res.status(500).json({ success: false, error: "Failed to submit volunteer." });
  }
});

app.post("/submit-streetteam", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ success: false, error: "All fields required" });
  try {
    await saveToSheet(SPREADSHEET_IDS.streetteam, "StreetTeam", [name, email, city, message, new Date().toISOString()]);
    res.json({ success: true, message: "Street Team submitted!" });
  } catch (err) {
    console.error("Street Team error:", err);
    res.status(500).json({ success: false, error: "Failed to submit Street Team." });
  }
});

// Messages
app.get("/api/messages", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated" });
  if (!req.session.messages) req.session.messages = [];
  res.json({ success: true, messages: req.session.messages });
});
app.post("/api/messages", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated" });
  const { text } = req.body;
  if (!text) return res.status(400).json({ success: false, error: "Message required" });
  if (!req.session.messages) req.session.messages = [];
  req.session.messages.push({ text, timestamp: new Date().toISOString() });
  res.json({ success: true, message: "Message added", messages: req.session.messages });
});

// Stripe Checkout
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { amount, campaignId } = req.body;
    if (!amount || amount < 100) return res.status(400).json({ success: false, error: "Invalid amount" });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [{
        price_data: { currency: "usd", product_data: { name: `Donation to Campaign ${campaignId || "General"}` }, unit_amount: amount },
        quantity: 1
      }],
      success_url: "https://fundasmile.net/thankyou.html",
      cancel_url: "https://fundasmile.net/cancel.html"
    });
    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ success: false, error: "Payment failed" });
  }
});

// ===== Campaigns =====

// Create campaign with optional image. If session user exists, use that email when none provided.
app.post("/api/campaigns", upload.single('image'), async (req, res) => {
  try {
    // Fields come from multipart/form-data
    let { title, description, goal, category, email } = req.body;

    // prefer authenticated session email if present
    if ((!email || email.trim() === "") && req.session.user && req.session.user.email) {
      email = req.session.user.email;
    }

    if (!title || !description || !goal || !category || !email) {
      return res.status(400).json({ success: false, error: "All fields required (title, description, goal, category, email/session)." });
    }

    const id = Date.now().toString();
    // Build image URL dynamically (works on any host)
    const imageUrl = req.file ? `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}` : "";

    // Save to sheet. Keep columns consistent with your sheet (we append 9 columns here).
    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      id,
      title,
      email,
      goal,
      description,
      category,
      "Active",
      new Date().toISOString(),
      imageUrl
    ]);

    res.json({ success: true, message: "Campaign created!", id, imageUrl });
  } catch (err) {
    console.error("Create campaign error:", err);
    res.status(500).json({ success: false, error: "Failed to create campaign" });
  }
});

// Public campaigns list
app.get("/api/campaigns", async (req, res) => {
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:I"
    });
    const rows = data.values || [];
    if (rows.length < 2) return res.json({ success: true, campaigns: [] });

    // Map rows -> objects
    const campaigns = rows.slice(1).map(r => ({
      id: r[0] || "",
      title: r[1] || "",
      email: r[2] || "",
      goal: r[3] || "",
      description: r[4] || "",
      category: r[5] || "",
      status: r[6] || "Active",
      createdAt: r[7] || "",
      imageUrl: r[8] || ""
    }));

    // Only return active campaigns to public page
    res.json({ success: true, campaigns: campaigns.filter(c => c.status === "Active") });
  } catch (err) {
    console.error("Fetch campaigns error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch campaigns" });
  }
});

// Fetch campaigns for current signed-in user
app.get("/api/my-campaigns", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated" });
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:I"
    });
    const rows = data.values || [];
    if (rows.length < 2) return res.json({ success: true, total: 0, active: 0, campaigns: [] });

    const userEmail = req.session.user.email.toLowerCase();
    const allRows = rows.slice(1);
    const userRows = allRows.filter(r => (r[2] || "").toLowerCase() === userEmail);

    const formatted = userRows.map(r => ({
      id: r[0] || "",
      title: r[1] || "",
      email: r[2] || "",
      goal: r[3] || "",
      description: r[4] || "",
      category: r[5] || "",
      status: r[6] || "Active",
      createdAt: r[7] || "",
      imageUrl: r[8] || ""
    }));

    res.json({ success: true, total: formatted.length, active: formatted.filter(c => c.status === "Active").length, campaigns: formatted });
  } catch (err) {
    console.error("My campaigns error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch user campaigns" });
  }
});

// Delete campaign (only for signed-in users)
app.delete("/api/campaigns/:id", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated" });
  const id = req.params.id;
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:A" // only need column A to find id positions
    });
    const rows = data.values || [];
    if (rows.length < 2) return res.status(404).json({ success: false, error: "Campaign not found" });

    // rows is header + data rows; find index in the returned array
    const idx = rows.findIndex(r => r[0] === id);
    if (idx === -1) return res.status(404).json({ success: false, error: "Campaign not found" });

    // idx is the array index (0-based) - header is index 0 -> sheet row number = idx + 1
    // For batchUpdate deleteDimension startIndex is 0-based row index.
    const sheetRowStart = idx; // correct to pass directly
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId: 0, // assumes campaigns is sheet index 0 — if not, set the correct sheetId
                dimension: "ROWS",
                startIndex: sheetRowStart,
                endIndex: sheetRowStart + 1
              }
            }
          }
        ]
      }
    });

    res.json({ success: true, message: "Campaign deleted" });
  } catch (err) {
    console.error("Delete campaign error:", err);
    res.status(500).json({ success: false, error: "Failed to delete campaign" });
  }
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
