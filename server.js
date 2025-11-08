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
  origin: function(origin, callback){
    // allow requests with no origin (like mobile apps, Postman)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS policy: Not allowed by origin ' + origin));
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
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");

// ==================== Mailjet ====================
const mailjetClient = mailjet.apiConnect(
  process.env.MAILJET_API_KEY || "",
  process.env.MAILJET_API_SECRET || ""
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
  console.error("❌ Google Sheets initialization failed", err && err.message);
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

/**
 * Find a row matching `matchValue` in column index `matchColIndex` (0-based) inside the sheet range (e.g. "A:D").
 * If found, update the row (columns will be overwritten with provided updatedValues array length).
 * If not found, append a new row by using appendSheetValues.
 *
 * @param {string} spreadsheetId
 * @param {string} rangeCols - like "A:D" or "A:G" (no sheet name)
 * @param {number} matchColIndex - 0-based index of column to match against
 * @param {string} matchValue
 * @param {Array} updatedValues - full row array to write (length should match columns)
 */
async function findRowAndUpdateOrAppend(spreadsheetId, rangeCols, matchColIndex, matchValue, updatedValues) {
  if (!sheets) throw new Error("Google Sheets not initialized");
  // Read current sheet values
  const rows = await getSheetValues(spreadsheetId, rangeCols);
  // Find matching row index
  const rowIndex = rows.findIndex(r => (r[matchColIndex] || "").toString().trim().toLowerCase() === (matchValue || "").toString().trim().toLowerCase());

  if (rowIndex === -1) {
    // Append new row
    await appendSheetValues(spreadsheetId, rangeCols, [updatedValues]);
    return { action: "appended", row: rows.length + 1 };
  } else {
    // Update the found row
    // Compute the update range: e.g. A{row}:D{row}
    const [startCol, endCol] = rangeCols.split(":");
    const rowNumber = rowIndex + 1; // sheets are 1-indexed
    const updateRange = `${startCol}${rowNumber}:${endCol}${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: updateRange,
      valueInputOption: "USER_ENTERED",
      resource: { values: [updatedValues] }
    });
    return { action: "updated", row: rowNumber };
  }
}

// ==================== USERS ====================
async function getUsers() {
  if (!process.env.USERS_SHEET_ID) return [];
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
      htmlUser = `<h2 style="color:#ff69b4;">Hi ${firstName}!</h2><p>You're now officially on our <strong>JoyFund Waitlist</strong>! 🎊</p><p>${festiveLine}</p>`;
      textUser = `Welcome aboard, ${firstName}! You're now part of JoyFund’s mission to spread joy!`;
      break;
    case "volunteer":
      subjectAdmin = "🙌 New Volunteer Application!";
      subjectUser = `🌟 Thank You for Volunteering, ${firstName}!`;
      htmlUser = `<h2 style="color:#87cefa;">Hi ${firstName}!</h2><p>We’re so happy you’re joining our volunteer family! 🌈</p><p>${festiveLine}</p>`;
      textUser = `Hi ${firstName}, thank you for joining our volunteers! Together we’ll make the world brighter!`;
      break;
    case "streetteam":
      subjectAdmin = "🚀 New Street Team Submission!";
      subjectUser = `🎤 Welcome to the Street Team, ${firstName}!`;
      htmlUser = `<h2 style="color:#ffa500;">Hey ${firstName}!</h2><p>Thanks for joining the <strong>JoyFund Street Team</strong>! 🎶</p><p>${festiveLine}</p>`;
      textUser = `Hey ${firstName}, thanks for joining the Street Team! Let’s spread the word and smiles together!`;
      break;
    case "donation":
      subjectAdmin = "💖 New Donation Received!";
      subjectUser = `🌟 Thank You, ${firstName}!`;
      htmlUser = `<h2 style="color:#32cd32;">Dear ${firstName},</h2><p>Your generosity lights up the world! 🌍</p><p>${festiveLine}</p>`;
      textUser = `Dear ${firstName}, thank you for your kind donation! Your support keeps the joy alive!`;
      break;
    default:
      subjectAdmin = "📬 New Notification";
      subjectUser = `Hello, ${firstName}`;
      htmlUser = `<p>${festiveLine}</p>`;
      textUser = `Notification from JoyFund.`;
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
    console.error("Mailjet email error:", err && err.message);
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
    console.error("waitlist error:", err && err.message);
    res.status(500).json({ error: "Failed to save to waitlist" });
  }
});

// ==================== ID VERIFICATION ROUTES ====================
/**
 * POST /api/verify-id
 * Body: { email: string, verified: boolean, notes?: string }
 * - Updates existing row by email or appends a new verification row.
 * - Spreadsheet columns assumed: Timestamp | Email | Verified | Notes
 */
app.post("/api/verify-id", async (req, res) => {
  try {
    if (!sheets) return res.status(500).json({ error: "Sheets not initialized" });
    const { email, verified, notes } = req.body;
    if (!email || typeof verified === "undefined") {
      return res.status(400).json({ error: "Missing email or verified flag" });
    }

    const spreadsheetId = process.env.ID_VERIFICATIONS_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ error: "VERIFY_SHEET_ID not configured" });

    const verifiedText = verified ? "TRUE" : "FALSE";
    const timestamp = new Date().toLocaleString();

    // Columns: A: Timestamp, B: Email, C: Verified, D: Notes
    const updatedRow = [timestamp, email.trim().toLowerCase(), verifiedText, notes || ""];

    const result = await findRowAndUpdateOrAppend(spreadsheetId, "A:D", 1, email, updatedRow);
    console.log("verify-id result:", result);

    res.json({ ok: true, action: result.action, row: result.row });
  } catch (err) {
    console.error("verify-id error:", err && err.message);
    res.status(500).json({ error: "Failed to verify ID" });
  }
});

/**
 * GET /api/verify-status?email=<email>
 * Returns verification info for the given email.
 * Response: { email, verified: boolean, notes, timestamp } or { found: false }
 */
app.get("/api/verify-status", async (req, res) => {
  try {
    if (!sheets) return res.status(500).json({ error: "Sheets not initialized" });
    const email = (req.query.email || "").toString().trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Missing email query param" });

    const spreadsheetId = process.env.VERIFY_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ error: "VERIFY_SHEET_ID not configured" });

    const rows = await getSheetValues(spreadsheetId, "A:D");
    const row = rows.find(r => (r[1] || "").toString().trim().toLowerCase() === email);

    if (!row) return res.json({ found: false });

    const [timestamp = "", _email = "", verifiedRaw = "", notes = ""] = row;
    const verified = (verifiedRaw || "").toString().toLowerCase() === "true";
    res.json({ found: true, email: _email, verified, notes, timestamp });
  } catch (err) {
    console.error("verify-status error:", err && err.message);
    res.status(500).json({ error: "Failed to read verification status" });
  }
});

// ==================== CAMPAIGN ROUTES ====================
/**
 * POST /api/create-campaign
 * Body: { creatorEmail, title, description, goal }
 * - Appends a campaign row with columns: Timestamp | CreatorEmail | Title | Description | Goal | Status | CampaignId
 * - Returns { ok: true, campaignId, row }
 */
app.post("/api/create-campaign", async (req, res) => {
  try {
    if (!sheets) return res.status(500).json({ error: "Sheets not initialized" });
    const { creatorEmail, title, description, goal } = req.body;
    if (!creatorEmail || !title || !description || !goal) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ error: "CAMPAIGNS_SHEET_ID not configured" });

    // Create a campaign id
    const campaignId = `camp_${Date.now().toString(36)}_${Math.floor(Math.random() * 9000 + 1000)}`;
    const timestamp = new Date().toLocaleString();
    const status = "draft"; // or "active" depending on your flow

    // Columns A:G => Timestamp | CreatorEmail | Title | Description | Goal | Status | CampaignId
    const row = [timestamp, creatorEmail.trim().toLowerCase(), title, description, goal.toString(), status, campaignId];

    // Append the campaign
    await appendSheetValues(spreadsheetId, "A:G", [row]);
    console.log("create-campaign appended:", campaignId);

    res.json({ ok: true, campaignId, row });
  } catch (err) {
    console.error("create-campaign error:", err && err.message);
    res.status(500).json({ error: "Failed to create campaign" });
  }
});

/**
 * GET /api/campaign/:campaignId
 * - Reads the campaigns sheet and returns campaign row if found
 */
app.get("/api/campaign/:campaignId", async (req, res) => {
  try {
    if (!sheets) return res.status(500).json({ error: "Sheets not initialized" });
    const campaignId = (req.params.campaignId || "").toString().trim();
    if (!campaignId) return res.status(400).json({ error: "Missing campaignId param" });

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ error: "CAMPAIGNS_SHEET_ID not configured" });

    const rows = await getSheetValues(spreadsheetId, "A:G");
    const row = rows.find(r => (r[6] || "").toString().trim() === campaignId);

    if (!row) return res.status(404).json({ error: "Campaign not found" });

    const [timestamp, creatorEmail, title, description, goal, status, id] = row;
    res.json({ timestamp, creatorEmail, title, description, goal, status, id });
  } catch (err) {
    console.error("get campaign error:", err && err.message);
    res.status(500).json({ error: "Failed to read campaign" });
  }
});

// ==================== Start Server ====================
app.listen(PORT, () => console.log(`🚀 JoyFund backend running on port ${PORT}`));
