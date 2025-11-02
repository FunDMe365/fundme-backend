require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const sgMail = require("@sendgrid/mail");
const Stripe = require("stripe");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;

// ==================== Middleware ====================
app.use(cors({
  origin: "https://fundasmile.net", // frontend URL
  credentials: true,
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false,
  saveUninitialized: true,
}));

// ==================== Stripe ====================
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ==================== SendGrid ====================
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ==================== Google Sheets ====================
let sheets;
try {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheets = google.sheets({ version: "v4", auth });
  console.log("✅ Google Sheets initialized");
} catch (err) {
  console.error("❌ Google Sheets initialization failed", err.message);
}

// ==================== Helpers ====================
async function getSheetValues(spreadsheetId, range) {
  if (!sheets) return [];
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function appendSheetValues(spreadsheetId, range, values) {
  if (!sheets) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    resource: { values },
  });
}

// ==================== Users ====================
async function getUsers() {
  return getSheetValues(process.env.USERS_SHEET_ID, "A:D"); // JoinDate | Name | Email | PasswordHash
}

// Sign-in
app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing email or password" });

  try {
    const users = await getUsers();
    const userRow = users.find(u => u[2] === email);
    if (!userRow) return res.status(401).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, userRow[3]);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    req.session.user = { name: userRow[1], email: userRow[2] };
    res.json({ ok: true, user: req.session.user });
  } catch (err) {
    console.error("signin error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Check session (frontend login state)
app.get("/api/check-session", (req, res) => {
  res.json({ loggedIn: !!req.session.user });
});

// Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Failed to logout" });
    res.json({ ok: true });
  });
});

// ==================== Waitlist ====================
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email || !source || !reason) return res.status(400).json({ error: "Missing fields" });

  try {
    await appendSheetValues(process.env.WAITLIST_SHEET_ID, process.env.SHEET_RANGE || "A:D", [
      [new Date().toISOString(), name, email, source, reason]
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error("waitlist error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== Donations ====================
app.post("/api/donations", async (req, res) => {
  const { email, amount, campaign } = req.body;
  if (!email || !amount || !campaign) return res.status(400).json({ error: "Missing parameters" });

  try {
    await appendSheetValues(process.env.DONATIONS_SHEET_ID, "A:D", [
      [new Date().toISOString(), email, amount, campaign]
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error("donations error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== Stripe Checkout ====================
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  const { campaignId } = req.params;
  const { amount, successUrl, cancelUrl } = req.body;

  if (!amount || !campaignId) return res.status(400).json({ error: "Missing parameters" });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `${campaignId} Donation` },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      }],
      mode: "payment",
      success_url: successUrl || `${req.headers.origin}/thank-you.html`,
      cancel_url: cancelUrl || `${req.headers.origin}/`,
    });

    res.json({ success: true, sessionId: session.id });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ error: "Stripe checkout failed" });
  }
});

// ==================== Campaigns ====================
app.get("/api/campaigns", async (req, res) => {
  try {
    const campaigns = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:E");
    res.json({ ok: true, campaigns });
  } catch (err) {
    console.error("campaigns error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`🚀 JoyFund backend running on port ${PORT}`);
});
