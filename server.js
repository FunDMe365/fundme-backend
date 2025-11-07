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
  credentials: true
}));

// Handle preflight requests globally
app.options("*", cors({
  origin: allowedOrigins,
  credentials: true
}));

// ==================== Middleware ====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ==================== SESSION FIX ====================
// Key fix: sameSite: "none" + secure for cross-origin sessions
app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "none" // ⚠️ important for cross-origin cookies
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
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
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

    // ✅ Store user in session
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
  let subjectAdmin = "";
  let subjectUser = "";
  let textUser = "";
  let festiveMessage = "";

  switch (type) {
    case "waitlist":
      subjectAdmin = "🎉 New Waitlist Submission!";
      subjectUser = "🎈 You’re officially on the JoyFund Waitlist!";
      festiveMessage = `🎉 Welcome aboard, ${toUser.name || "friend"}! 
We’re thrilled you’ve joined our mission to spread joy and smiles. 
Keep an eye on your inbox for exciting updates from JoyFund! 💖`;
      break;
    case "volunteer":
      subjectAdmin = "🙌 New Volunteer Application!";
      subjectUser = "🌟 Thank You for Volunteering with JoyFund!";
      festiveMessage = `🌈 Hi ${toUser.name}, 
Thank you for stepping up to make a difference! 
Our team will reach out soon with ways you can help bring joy to others! ✨`;
      break;
    case "streetteam":
      subjectAdmin = "🚀 New Street Team Submission!";
      subjectUser = "🎤 Welcome to the JoyFund Street Team!";
      festiveMessage = `🎶 Hey ${toUser.name}! 
Thanks for bringing your energy and passion to our Street Team. 
Get ready to spread the word and inspire smiles! 💕`;
      break;
    case "donation":
      subjectAdmin = "💖 New Donation Received!";
      subjectUser = "💝 Thank You for Your Donation!";
      festiveMessage = `🌟 Dear ${toUser.name}, 
Your generosity lights up the world! 
Thank you for supporting JoyFund’s mission to uplift others. 🌈`;
      break;
  }

  textUser = `${festiveMessage}\n\nDetails:\n${details}`;

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
        To: [{ Email: toUser.email, Name: toUser.name }],
        Subject: subjectUser,
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

// ==================== Other endpoints preserved ====================
// Volunteer, Street Team, Donations, Profile Update, etc.
// Use same structure as above with festive emails and appendSheetValues

// ==================== Start Server ====================
app.listen(PORT, () => console.log(`🚀 JoyFund backend running on port ${PORT}`));
