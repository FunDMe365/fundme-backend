require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const Stripe = require("stripe");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;

// Ensure data folders exist for fallback storage
const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ==================== Middleware ====================
// Dynamic CORS: allow configured frontend origin(s) and common dev hosts
const allowedOrigins = [
  process.env.FRONTEND_URL,            // e.g. https://fundasmile.net or your deployed frontend
  process.env.FRONTEND_URL_2,         // optional second frontend domain
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://127.0.0.1:3000",
  "file://"
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps or curl) and file://
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    } else {
      // In production, it's better to explicitly list allowed origins.
      // For now, fail closed with a helpful message in logs.
      console.warn("Blocked CORS request from origin:", origin);
      return callback(new Error("CORS policy: This origin is not allowed"), false);
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  optionsSuccessStatus: 200
}));

// parse JSON and URL-encoded bodies
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ✅ Fixed session configuration to prevent refresh redirect
app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false, // don't save session if unmodified
  saveUninitialized: false, // only save session if something stored
  cookie: {
    httpOnly: true,
    // secure must be true in production when using HTTPS
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax"
  }
}));

// Expose uploads (if you want to serve uploaded verification files)
app.use("/uploads", express.static(UPLOADS_DIR));

// ==================== Stripe ====================
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");

// ==================== Mailjet ====================
let mailjetClient = null;
try {
  const mailjet = require("node-mailjet");
  mailjetClient = mailjet.apiConnect(
    process.env.MAILJET_API_KEY || "",
    process.env.MAILJET_API_SECRET || ""
  );
} catch (e) {
  console.warn("Mailjet not configured or missing package; email sending will be disabled.");
}

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

// Local fallback helpers for campaigns and id verifications
const CAMPAIGNS_FILE = path.join(DATA_DIR, "campaigns.json");
const ID_VERIFICATIONS_FILE = path.join(DATA_DIR, "id_verifications.json");

function readJsonFileOrEmpty(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw || "[]");
  } catch (err) {
    console.error("Failed to read JSON file:", filePath, err);
    return [];
  }
}

function safeWriteJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to write JSON file:", filePath, err);
  }
}

// ==================== Users ====================
async function getUsers() {
  // Expect spreadsheet columns: JoinDate | Name | Email | PasswordHash
  return getSheetValues(process.env.USERS_SHEET_ID, "A:D");
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

    // Ensure session is saved before responding so cookies are set properly
    req.session.save(err => {
      if (err) {
        console.error("Session save error:", err);
        return res.status(500).json({ error: "Failed to create session" });
      }
      res.json({ ok: true, user: req.session.user });
    });
  } catch (err) {
    console.error("signin error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ==================== Check Session ====================
app.get("/api/check-session", (req, res) => {
  if (req.session && req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

// ==================== Logout ====================
app.post("/api/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Session destroy error:", err);
      return res.status(500).json({ error: "Failed to logout" });
    }
    // Clear cookie on client
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

// ==================== Submission Email Helper ====================
async function sendSubmissionEmail({ toAdmin, toUser, subjectAdmin, subjectUser, textUser }) {
  try {
    if (!mailjetClient) {
      console.warn("sendSubmissionEmail: mailjet client not configured.");
      return;
    }
    const messages = [];
    if (toAdmin) {
      messages.push({
        From: { Email: process.env.EMAIL_FROM, Name: "JoyFund INC" },
        To: [{ Email: toAdmin, Name: "JoyFund Admin" }],
        Subject: subjectAdmin,
        TextPart: `New submission received:\n\n${textUser}`
      });
    }
    if (toUser) {
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
    if (!process.env.WAITLIST_SHEET_ID) throw new Error("WAITLIST_SHEET_ID not set");

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.WAITLIST_SHEET_ID,
      range: process.env.SHEET_RANGE || "A:E",
      valueInputOption: "USER_ENTERED",
      resource: { values: [[new Date().toLocaleString(), name, email, source, reason]] },
    });

    const text = `Name: ${name}\nEmail: ${email}\nSource: ${source}\nReason: ${reason}`;
    await sendSubmissionEmail({
      toAdmin: process.env.EMAIL_TO,
      toUser: { email, name },
      subjectAdmin: "New Waitlist Submission",
      subjectUser: "Your JoyFund Waitlist Submission",
      textUser: text
    });

    res.json({ success: true, message: "Successfully joined the waitlist!" });
  } catch (err) {
    console.error("waitlist error:", err.message);
    res.status(500).json({ error: "Failed to save to waitlist", details: err.message });
  }
});

// ==================== Volunteer ====================
app.post("/api/submit-volunteer", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ error: "Missing fields" });

  try {
    if (!sheets) throw new Error("Google Sheets not initialized");
    if (!process.env.VOLUNTEERS_SHEET_ID) throw new Error("VOLUNTEERS_SHEET_ID not set");

    await appendSheetValues(process.env.VOLUNTEERS_SHEET_ID, "A:E", [[new Date().toLocaleString(), name, email, city, message]]);

    const text = `Name: ${name}\nEmail: ${email}\nCity: ${city}\nMessage: ${message}`;
    await sendSubmissionEmail({
      toAdmin: process.env.EMAIL_TO,
      toUser: { email, name },
      subjectAdmin: "New Volunteer Submission",
      subjectUser: "Your JoyFund Volunteer Submission",
      textUser: text
    });

    res.json({ success: true, message: "Volunteer application submitted!" });
  } catch (err) {
    console.error("volunteer submission error:", err.message);
    res.status(500).json({ error: "Failed to submit volunteer application", details: err.message });
  }
});

// ==================== Street Team ====================
app.post("/api/submit-streetteam", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ error: "Missing fields" });

  try {
    if (!sheets) throw new Error("Google Sheets not initialized");
    if (!process.env.STREETTEAM_SHEET_ID) throw new Error("STREETTEAM_SHEET_ID not set");

    await appendSheetValues(process.env.STREETTEAM_SHEET_ID, "A:E", [[new Date().toLocaleString(), name, email, city, message]]);

    const text = `Name: ${name}\nEmail: ${email}\nCity: ${city}\nMessage: ${message}`;
    await sendSubmissionEmail({
      toAdmin: process.env.EMAIL_TO,
      toUser: { email, name },
      subjectAdmin: "New Street Team Submission",
      subjectUser: "Your JoyFund Street Team Submission",
      textUser: text
    });

    res.json({ success: true, message: "Street Team application submitted!" });
  } catch (err) {
    console.error("street team submission error:", err.message);
    res.status(500).json({ error: "Failed to submit street team application", details: err.message });
  }
});

// ==================== Donations ====================
app.post("/api/donations", async (req, res) => {
  const { email, amount, campaign } = req.body;
  if (!email || !amount || !campaign) return res.status(400).json({ error: "Missing parameters" });

  try {
    if (!sheets) throw new Error("Google Sheets not initialized");
    if (!process.env.DONATIONS_SHEET_ID) throw new Error("DONATIONS_SHEET_ID not set");

    await appendSheetValues(process.env.DONATIONS_SHEET_ID, "A:D", [[new Date().toISOString(), email, amount, campaign]]);

    const text = `Thank you for your donation!\n\nEmail: ${email}\nAmount: $${amount}\nCampaign: ${campaign}`;
    await sendSubmissionEmail({
      toAdmin: process.env.EMAIL_TO,
      toUser: { email, name: email.split("@")[0] },
      subjectAdmin: "New Donation Received",
      subjectUser: "Thank you for your donation!",
      textUser: text
    });

    res.json({ success: true, message: "Donation recorded!" });
  } catch (err) {
    console.error("donations error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ==================== Campaigns (new minimal routes) ====================
// GET all campaigns
app.get("/api/campaigns", async (req, res) => {
  try {
    // Prefer Google Sheets if configured
    if (sheets && process.env.CAMPAIGNS_SHEET_ID) {
      const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:E"); // adapt to your columns
      // Map rows into JSON objects lightly
      const campaigns = (rows || []).map((r, idx) => ({
        id: idx + 1,
        createdAt: r[0] || null,
        title: r[1] || "",
        owner: r[2] || "",
        goal: r[3] || "",
        description: r[4] || ""
      }));
      return res.json({ campaigns });
    }

    // Fallback to local file
    const campaigns = readJsonFileOrEmpty(CAMPAIGNS_FILE);
    res.json({ campaigns });
  } catch (err) {
    console.error("Error fetching campaigns:", err);
    res.status(500).json({ error: "Failed to load campaigns", details: err.message });
  }
});

// POST create a campaign
app.post("/api/create-campaign", async (req, res) => {
  const { title, goal, description, owner } = req.body;
  if (!title || !goal || !description || !owner) return res.status(400).json({ error: "Missing fields" });

  try {
    const newCampaign = {
      id: Date.now(),
      createdAt: new Date().toISOString(),
      title,
      owner,
      goal,
      description
    };

    if (sheets && process.env.CAMPAIGNS_SHEET_ID) {
      // Append to Google Sheet
      await appendSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:E", [[newCampaign.createdAt, newCampaign.title, newCampaign.owner, newCampaign.goal, newCampaign.description]]);
      return res.json({ ok: true, campaign: newCampaign });
    }

    // Fallback: write to local file
    const campaigns = readJsonFileOrEmpty(CAMPAIGNS_FILE);
    campaigns.push(newCampaign);
    safeWriteJsonFile(CAMPAIGNS_FILE, campaigns);

    res.json({ ok: true, campaign: newCampaign });
  } catch (err) {
    console.error("create-campaign error:", err);
    res.status(500).json({ error: "Failed to create campaign", details: err.message });
  }
});

// ==================== ID Verification (new minimal route) ====================
// Accept simple id verification submissions (no file upload parsing here).
// Expect fields: email, idType, idData (could be a URL or notes). If you'd like file uploads, we can add multer later.
app.post("/api/id-verification", async (req, res) => {
  const { email, idType, idData } = req.body;
  if (!email || !idType || !idData) return res.status(400).json({ error: "Missing fields" });

  try {
    const entry = {
      id: Date.now(),
      submittedAt: new Date().toISOString(),
      email,
      idType,
      idData
    };

    // Append to Google Sheet if configured
    if (sheets && process.env.ID_VERIFICATIONS_SHEET_ID) {
      await appendSheetValues(process.env.ID_VERIFICATIONS_SHEET_ID, "A:D", [[entry.submittedAt, email, idType, idData]]);
    } else {
      // Fallback: save to local file
      const current = readJsonFileOrEmpty(ID_VERIFICATIONS_FILE);
      current.push(entry);
      safeWriteJsonFile(ID_VERIFICATIONS_FILE, current);
    }

    // Optionally send an email
    const text = `ID verification submission:\nEmail: ${email}\nType: ${idType}\nData: ${idData}`;
    await sendSubmissionEmail({
      toAdmin: process.env.EMAIL_TO,
      toUser: { email, name: email.split("@")[0] },
      subjectAdmin: "New ID Verification Submission",
      subjectUser: "We received your ID verification",
      textUser: `Thanks! We received your ID verification submission. We'll review and get back to you.\n\n${text}`
    });

    res.json({ ok: true, message: "ID verification submitted", entry });
  } catch (err) {
    console.error("id-verification error:", err);
    res.status(500).json({ error: "Failed to submit ID verification", details: err.message });
  }
});

// ==================== Health / Root ====================
app.get("/", (req, res) => {
  res.json({ status: "ok", name: "JoyFund backend", time: new Date().toISOString() });
});

// ==================== Fallback 404 for API ====================
app.use("/api/*", (req, res) => {
  res.status(404).json({ error: "API route not found" });
});

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`🚀 JoyFund backend running on port ${PORT}`);
});
