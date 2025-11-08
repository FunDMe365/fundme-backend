require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const Stripe = require("stripe");
const cors = require("cors");
const mailjet = require("node-mailjet");

const app = express();
const PORT = process.env.PORT || 5000;

// ==================== ✅ CORS CONFIG ====================
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
  credentials: true
}));

// Handle preflight requests globally
app.options("*", cors({
  origin: allowedOrigins,
  credentials: true
}));

// ✅ Always include proper CORS headers
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

// ==================== ✅ SESSION FIX ====================
app.set("trust proxy", 1); // Required for Render HTTPS cookies

app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production", // Required for HTTPS
    sameSite: "none", // Cross-origin cookie fix
    maxAge: 1000 * 60 * 60 * 24 * 7 // 1 week
  }
}));

// ==================== Stripe ====================
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ==================== Mailjet ====================
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
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    sheets = google.sheets({ version: "v4", auth });
    console.log("✅ Google Sheets initialized");
  } else {
    console.warn("⚠️ GOOGLE_CREDENTIALS_JSON not provided; Sheets operations disabled.");
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
  if (!sheets) throw new Error("Google Sheets not initialized");
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });
}

// ==================== USERS ====================
async function getUsers() {
  return getSheetValues(process.env.USERS_SHEET_ID, "A:D"); // JoinDate | Name | Email | PasswordHash
}

// ==================== SIGN IN ====================
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
    console.log("✅ User signed in:", req.session.user);

    res.json({ ok: true, user: req.session.user });
  } catch (err) {
    console.error("signin error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== CHECK SESSION ====================
app.get("/api/check-session", (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

// ==================== LOGOUT ====================
app.post("/api/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Failed to logout" });
    res.json({ ok: true });
  });
});

// ==================== FESTIVE EMAILS ====================
async function sendSubmissionEmail({ type, toAdmin, toUser, details }) {
  const firstName = toUser?.name?.split(" ")[0] || "Friend";
  const emoji = "💖🌈🎉✨🎁";
  const randomEmoji = emoji.split("")[Math.floor(Math.random() * emoji.length)];
  const festiveLine = `${randomEmoji} ${["Spreading smiles!", "Celebrating kindness!", "Making the world brighter!"][Math.floor(Math.random()*3)]}`;

  let subjectAdmin = "";
  let subjectUser = "";
  let htmlUser = "";
  let textUser = "";

  switch (type) {
    case "waitlist":
      subjectAdmin = "🎉 New Waitlist Submission!";
      subjectUser = `🎈 Welcome to JoyFund, ${firstName}!`;
      htmlUser = `
        <h2 style="color:#ff69b4;">Hi ${firstName}!</h2>
        <p>You're now officially on our <strong>JoyFund Waitlist</strong>! 🎊</p>
        <p>Thank you for believing in the power of joy and community. 💕</p>
        <p>${festiveLine}</p>`;
      textUser = `Welcome aboard, ${firstName}! You're now part of JoyFund’s mission to spread joy!`;
      break;
    case "volunteer":
      subjectAdmin = "🙌 New Volunteer Application!";
      subjectUser = `🌟 Thank You for Volunteering, ${firstName}!`;
      htmlUser = `
        <h2 style="color:#87cefa;">Hi ${firstName}!</h2>
        <p>We’re so happy you’re joining our volunteer family! 🌈</p>
        <p>Your passion helps bring smiles to countless faces. 💫</p>
        <p>${festiveLine}</p>`;
      textUser = `Hi ${firstName}, thank you for joining our volunteers! Together we’ll make the world brighter!`;
      break;
    case "streetteam":
      subjectAdmin = "🚀 New Street Team Submission!";
      subjectUser = `🎤 Welcome to the Street Team, ${firstName}!`;
      htmlUser = `
        <h2 style="color:#ffa500;">Hey ${firstName}!</h2>
        <p>Thanks for joining the <strong>JoyFund Street Team</strong>! 🎶</p>
        <p>Your energy helps us reach more hearts! 💕</p>
        <p>${festiveLine}</p>`;
      textUser = `Hey ${firstName}, thanks for joining the Street Team! Let’s spread the word and smiles together!`;
      break;
    case "donation":
      subjectAdmin = "💖 New Donation Received!";
      subjectUser = `🌟 Thank You, ${firstName}!`;
      htmlUser = `
        <h2 style="color:#32cd32;">Dear ${firstName},</h2>
        <p>Your generosity lights up the world! 🌍</p>
        <p>Every contribution helps JoyFund spread kindness and hope. 🌈</p>
        <p>${festiveLine}</p>`;
      textUser = `Dear ${firstName}, thank you for your kind donation! Your support keeps the joy alive!`;
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
        TextPart: textUser
      });
    }

    if (messages.length > 0) {
      await mailjetClient.post("send", { version: "v3.1" }).request({ Messages: messages });
    }
  } catch (err) {
    console.error("Mailjet email error:", err);
  }
}

// ==================== WAITLIST ====================
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email || !source || !reason) return res.status(400).json({ error: "Missing fields" });

  try {
    await appendSheetValues(process.env.WAITLIST_SHEET_ID, "A:E", [[new Date().toLocaleString(), name, email, source, reason]]);
    const details = `Name: ${name}\nEmail: ${email}\nSource: ${source}\nReason: ${reason}`;
    await sendSubmissionEmail({ type: "waitlist", toAdmin: process.env.EMAIL_TO, toUser: { email, name }, details });
    res.json({ success: true, message: "Successfully joined the waitlist!" });
  } catch (err) {
    console.error("waitlist error:", err.message);
    res.status(500).json({ error: "Failed to save to waitlist" });
  }
});

// ==================== Start Server ====================
app.listen(PORT, () => console.log(`🚀 JoyFund backend running on port ${PORT}`));
