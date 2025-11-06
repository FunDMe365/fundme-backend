require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const Stripe = require("stripe");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;

// ==================== Middleware ====================
app.use(cors({
  origin: "https://fundasmile.net",
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

// ==================== Mailjet ====================
const mailjet = require("node-mailjet");
const mailjetClient = mailjet.apiConnect(
  process.env.MAILJET_API_KEY,
  process.env.MAILJET_API_SECRET
);

// ==================== Google Sheets ====================
let sheets;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    sheets = google.sheets({ version: "v4", auth });
    console.log("✅ Google Sheets initialized");
  } else {
    console.warn("⚠️ GOOGLE_CREDENTIALS_JSON not provided; Sheets operations will fallback.");
  }
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
  if (!sheets) throw new Error("Google Sheets client not initialized");
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

// ==================== Sign In ====================
app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing email or password" });

  try {
    const users = await getUsers();
    const inputEmail = email.trim().toLowerCase();

    const userRow = users.find(u => u[2] && u[2].trim().toLowerCase() === inputEmail);
    if (!userRow) return res.status(401).json({ error: "Invalid credentials" });

    const storedHash = (userRow[3] || "").trim();
    const match = await bcrypt.compare(password, storedHash);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    req.session.user = { name: userRow[1], email: userRow[2], joinDate: userRow[0] };
    res.json({ ok: true, user: req.session.user });
  } catch (err) {
    console.error("signin error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== Check Session ====================
app.get("/api/check-session", (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

// ==================== Logout ====================
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
    if (!sheets) throw new Error("Google Sheets not initialized");

    // Append to sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.WAITLIST_SHEET_ID,
      range: process.env.SHEET_RANGE || "A:E",
      valueInputOption: "USER_ENTERED",
      resource: { values: [[new Date().toLocaleString(), name, email, source, reason]] },
    });

    // Respond success first
    res.json({ success: true, message: "Successfully joined the waitlist!" });

    // Send emails (fail silently if they fail)
    try {
      // Admin notification
      await mailjetClient.post("send", { version: "v3.1" }).request({
        Messages: [{
          From: { Email: process.env.EMAIL_FROM, Name: "JoyFund INC" },
          To: [{ Email: process.env.EMAIL_TO, Name: "JoyFund Admin" }],
          Subject: "New Waitlist Submission",
          TextPart: `Name: ${name}\nEmail: ${email}\nSource: ${source}\nReason: ${reason}`
        }]
      });

      // User confirmation
      await mailjetClient.post("send", { version: "v3.1" }).request({
        Messages: [{
          From: { Email: process.env.EMAIL_FROM, Name: "JoyFund INC" },
          To: [{ Email: email, Name: name }],
          Subject: "🎉 Thank you for joining the JoyFund Waitlist!",
          HTMLPart: `<div style="font-family:sans-serif; text-align:center; padding:20px; background:#e0f7fa; border-radius:15px;">
            <h2>Hello ${name}!</h2>
            <p>Thank you for joining the JoyFund waitlist! 💖</p>
            <p>We'll keep you updated with news and opportunities to participate.</p>
          </div>`
        }]
      });
    } catch (mailErr) {
      console.error("Mailjet email error (waitlist):", mailErr);
    }

  } catch (err) {
    console.error("waitlist error:", err);
    res.status(500).json({ error: "Failed to save to waitlist", details: err.message });
  }
});

// ==================== Donations ====================
app.post("/api/donations", async (req, res) => {
  const { email, amount, campaign } = req.body;
  if (!email || !amount || !campaign) return res.status(400).json({ error: "Missing parameters" });

  try {
    await appendSheetValues(process.env.DONATIONS_SHEET_ID, "A:D", [[new Date().toISOString(), email, amount, campaign]]);
    res.json({ success: true });

    try {
      // Admin notification
      await mailjetClient.post("send", { version: "v3.1" }).request({
        Messages: [{
          From: { Email: process.env.EMAIL_FROM, Name: "JoyFund INC" },
          To: [{ Email: process.env.EMAIL_TO, Name: "JoyFund Admin" }],
          Subject: "New Donation Received",
          TextPart: `Email: ${email}\nAmount: ${amount}\nCampaign: ${campaign}`
        }]
      });

      // Donor confirmation
      await mailjetClient.post("send", { version: "v3.1" }).request({
        Messages: [{
          From: { Email: process.env.EMAIL_FROM, Name: "JoyFund INC" },
          To: [{ Email: email, Name: email }],
          Subject: "🎉 Thank you for your donation!",
          HTMLPart: `<div style="font-family:sans-serif; text-align:center; padding:20px; background:#ffe4e1; border-radius:15px;">
            <h2>Hello!</h2>
            <p>Thank you for your generous donation of $${amount} to the ${campaign} campaign! 💖</p>
          </div>`
        }]
      });
    } catch (mailErr) {
      console.error("Mailjet email error (donation):", mailErr);
    }

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

// ==================== Volunteer Submission ====================
app.post("/api/submit-volunteer", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ error: "Missing fields" });

  try {
    await appendSheetValues(process.env.VOLUNTEER_SHEET_ID, "A:D", [[new Date().toLocaleString(), name, email, city, message]]);
    res.json({ success: true, message: "Volunteer application submitted!" });

    try {
      // Admin notification
      await mailjetClient.post("send", { version: "v3.1" }).request({
        Messages: [{
          From: { Email: process.env.EMAIL_FROM, Name: "JoyFund INC" },
          To: [{ Email: process.env.EMAIL_TO, Name: "JoyFund Admin" }],
          Subject: "New Volunteer Application",
          TextPart: `Name: ${name}\nEmail: ${email}\nCity: ${city}\nMessage: ${message}`
        }]
      });

      // User confirmation
      await mailjetClient.post("send", { version: "v3.1" }).request({
        Messages: [{
          From: { Email: process.env.EMAIL_FROM, Name: "JoyFund INC" },
          To: [{ Email: email, Name: name }],
          Subject: "🎉 Thank you for volunteering!",
          HTMLPart: `<div style="font-family:sans-serif; text-align:center; padding:20px; background:#e0f7fa; border-radius:15px;">
            <h2>Hello ${name}!</h2>
            <p>Thank you for submitting your volunteer application! 💖</p>
          </div>`
        }]
      });
    } catch (mailErr) {
      console.error("Mailjet email error (volunteer):", mailErr);
    }

  } catch (err) {
    console.error("Volunteer submission error:", err);
    res.status(500).json({ error: "Failed to submit volunteer application", details: err.message });
  }
});

// ==================== Street Team Submission ====================
app.post("/api/submit-streetteam", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ error: "Missing fields" });

  try {
    await appendSheetValues(process.env.STREETTEAM_SHEET_ID, "A:D", [[new Date().toLocaleString(), name, email, city, message]]);
    res.json({ success: true, message: "Street Team application submitted!" });

    try {
      // Admin notification
      await mailjetClient.post("send", { version: "v3.1" }).request({
        Messages: [{
          From: { Email: process.env.EMAIL_FROM, Name: "JoyFund INC" },
          To: [{ Email: process.env.EMAIL_TO, Name: "JoyFund Admin" }],
          Subject: "New Street Team Application",
          TextPart: `Name: ${name}\nEmail: ${email}\nCity: ${city}\nMessage: ${message}`
        }]
      });

      // User confirmation
      await mailjetClient.post("send", { version: "v3.1" }).request({
        Messages: [{
          From: { Email: process.env.EMAIL_FROM, Name: "JoyFund INC" },
          To: [{ Email: email, Name: name }],
          Subject: "🎉 Thank you for joining the Street Team!",
          HTMLPart: `<div style="font-family:sans-serif; text-align:center; padding:20px; background:#e0f7fa; border-radius:15px;">
            <h2>Hello ${name}!</h2>
            <p>Thank you for submitting your Street Team application! 💖</p>
          </div>`
        }]
      });
    } catch (mailErr) {
      console.error("Mailjet email error (streetteam):", mailErr);
    }

  } catch (err) {
    console.error("Street Team submission error:", err);
    res.status(500).json({ error: "Failed to submit Street Team application", details: err.message });
  }
});

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`🚀 JoyFund backend running on port ${PORT}`);
});
