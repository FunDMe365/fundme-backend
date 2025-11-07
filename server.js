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

// ==================== ✅ CORS FIX ====================
const allowedOrigins = [
  "https://fundasmile.net",
  "https://fundme-backend.onrender.com",
  "http://localhost:5000",
  "http://127.0.0.1:5000"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));

// Handle preflight requests globally
app.options("*", cors({
  origin: allowedOrigins,
  credentials: true,
}));

// ✅ Ensure all responses include CORS headers
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ==================== Middleware ====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax"
  }
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
  if (req.session.user) res.json({ loggedIn: true, user: req.session.user });
  else res.json({ loggedIn: false });
});

// ==================== Logout ====================
app.post("/api/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Failed to logout" });
    res.json({ ok: true });
  });
});

// ==================== Festive Email Helper ====================
async function sendSubmissionEmail({ type, toAdmin, toUser, details }) {
  const firstName = toUser?.name?.split(" ")[0] || "Friend";
  const emoji = "💖🌈🎉✨🎁";
  const randomEmoji = emoji.split("")[Math.floor(Math.random() * emoji.length)];
  const festiveLine = `${randomEmoji} ${["Spreading smiles!", "Celebrating kindness!", "Making the world brighter!"][Math.floor(Math.random()*3)]}`;

  let subjectAdmin = "";
  let subjectUser = "";
  let htmlUser = "";

  switch (type) {
    case "waitlist":
      subjectAdmin = "🎉 New Waitlist Submission!";
      subjectUser = `🎈 Welcome to JoyFund, ${firstName}!`;
      htmlUser = `
        <h2 style="color:#ff69b4;">Hi ${firstName}!</h2>
        <p>You're now officially on our <strong>JoyFund Waitlist</strong>! 🎊</p>
        <p>Thank you for believing in the power of joy and community. 💕</p>
        <p>${festiveLine}</p>
      `;
      break;
    case "volunteer":
      subjectAdmin = "🙌 New Volunteer Application!";
      subjectUser = `🌟 Thank You for Volunteering, ${firstName}!`;
      htmlUser = `
        <h2 style="color:#87cefa;">Hi ${firstName}!</h2>
        <p>We’re over the moon that you’re joining our volunteer family! 🌈</p>
        <p>Your passion will help bring smiles to countless faces. 💫</p>
        <p>${festiveLine}</p>
      `;
      break;
    case "streetteam":
      subjectAdmin = "🚀 New Street Team Submission!";
      subjectUser = `🎤 Welcome to the Street Team, ${firstName}!`;
      htmlUser = `
        <h2 style="color:#ffa500;">Hey ${firstName}!</h2>
        <p>Thanks for joining the <strong>JoyFund Street Team</strong>! 🎶</p>
        <p>Your energy and creativity will help us reach new hearts and smiles! 💕</p>
        <p>${festiveLine}</p>
      `;
      break;
    case "donation":
      subjectAdmin = "💖 New Donation Received!";
      subjectUser = `🌟 Thank You, ${firstName}!`;
      htmlUser = `
        <h2 style="color:#32cd32;">Dear ${firstName},</h2>
        <p>Your generosity lights up the world! 🌍</p>
        <p>Every contribution helps JoyFund spread kindness and hope. 🌈</p>
        <p>${festiveLine}</p>
      `;
      break;
  }

  try {
    const messages = [];
    if (toAdmin) {
      messages.push({
        From: { Email: process.env.EMAIL_FROM, Name: "JoyFund INC" },
        To: [{ Email: toAdmin, Name: "JoyFund Admin" }],
        Subject: subjectAdmin,
        TextPart: details
      });
    }
    if (toUser?.email) {
      messages.push({
        From: { Email: process.env.EMAIL_FROM, Name: "JoyFund INC" },
        To: [{ Email: toUser.email, Name: firstName }],
        Subject: subjectUser,
        HTMLPart: htmlUser,
        TextPart: `Thank you ${firstName}! ${festiveLine}\n\nDetails:\n${details}`
      });
    }

    if (messages.length > 0)
      await mailjetClient.post("send", { version: "v3.1" }).request({ Messages: messages });

  } catch (err) {
    console.error("Mailjet email error:", err);
  }
}

// ==================== Waitlist ====================
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email || !source || !reason) return res.status(400).json({ error: "Missing fields" });

  try {
    if (!sheets) throw new Error("Google Sheets not initialized");
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.WAITLIST_SHEET_ID,
      range: "A:E",
      valueInputOption: "USER_ENTERED",
      resource: { values: [[new Date().toLocaleString(), name, email, source, reason]] },
    });

    const details = `Name: ${name}\nEmail: ${email}\nSource: ${source}\nReason: ${reason}`;
    await sendSubmissionEmail({
      type: "waitlist",
      toAdmin: process.env.EMAIL_TO,
      toUser: { email, name },
      details
    });

    res.json({ success: true, message: "Successfully joined the waitlist!" });
  } catch (err) {
    console.error("waitlist error:", err.message);
    res.status(500).json({ error: "Failed to save to waitlist" });
  }
});

// ==================== Volunteer ====================
app.post("/api/submit-volunteer", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ error: "Missing fields" });

  try {
    await appendSheetValues(process.env.VOLUNTEERS_SHEET_ID, "A:E", [[new Date().toLocaleString(), name, email, city, message]]);
    const details = `Name: ${name}\nEmail: ${email}\nCity: ${city}\nMessage: ${message}`;
    await sendSubmissionEmail({
      type: "volunteer",
      toAdmin: process.env.EMAIL_TO,
      toUser: { email, name },
      details
    });

    res.json({ success: true, message: "Volunteer application submitted!" });
  } catch (err) {
    console.error("volunteer error:", err.message);
    res.status(500).json({ error: "Failed to submit volunteer" });
  }
});

// ==================== Street Team ====================
app.post("/api/submit-streetteam", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ error: "Missing fields" });

  try {
    await appendSheetValues(process.env.STREETTEAM_SHEET_ID, "A:E", [[new Date().toLocaleString(), name, email, city, message]]);
    const details = `Name: ${name}\nEmail: ${email}\nCity: ${city}\nMessage: ${message}`;
    await sendSubmissionEmail({
      type: "streetteam",
      toAdmin: process.env.EMAIL_TO,
      toUser: { email, name },
      details
    });

    res.json({ success: true, message: "Street Team application submitted!" });
  } catch (err) {
    console.error("streetteam error:", err.message);
    res.status(500).json({ error: "Failed to submit street team" });
  }
});

// ==================== Donations ====================
app.post("/api/donations", async (req, res) => {
  const { email, amount, campaign } = req.body;
  if (!email || !amount || !campaign) return res.status(400).json({ error: "Missing parameters" });

  try {
    await appendSheetValues(process.env.DONATIONS_SHEET_ID, "A:D", [[new Date().toISOString(), email, amount, campaign]]);
    const details = `Email: ${email}\nAmount: $${amount}\nCampaign: ${campaign}`;
    await sendSubmissionEmail({
      type: "donation",
      toAdmin: process.env.EMAIL_TO,
      toUser: { email, name: email.split("@")[0] },
      details
    });

    res.json({ success: true, message: "Donation recorded!" });
  } catch (err) {
    console.error("donations error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== Start Server ====================
app.listen(PORT, () => console.log(`🚀 JoyFund backend running on port ${PORT}`));
