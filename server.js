// ==================== SERVER.JS - JOYFUND FULL FEATURE FIXED + LIVE VISITOR TRACKING ====================

const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const multer = require("multer");
const crypto = require("crypto");
const Stripe = require("stripe");
const { google } = require("googleapis");
const mailjetLib = require("node-mailjet");
const cloudinary = require("cloudinary").v2;

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "FunDMe$123"; // change later
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// -------------------- CORS --------------------
const cors = require("cors");
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true); // allow non-browser requests like Postman/server-to-server
    if (allowedOrigins.length === 0) return callback(null, true); // no restrictions if none set
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("CORS not allowed"));
  },
  credentials: true
}));
app.options("*", cors({ origin: allowedOrigins.length ? allowedOrigins : true, credentials: true }));

// -------------------- BODY PARSER --------------------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// -------------------- SESSION --------------------
app.set('trust proxy', 1); // behind proxies (render, etc)
app.use(session({
  name: 'sessionId',
  secret: process.env.SESSION_SECRET || 'supersecretkey',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 24
  }
}));

// -------------------- STRIPE --------------------
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");

// -------------------- MAILJET --------------------
let mailjetClient = null;
if (process.env.MAILJET_API_KEY && process.env.MAILJET_API_SECRET) {
  mailjetClient = mailjetLib.apiConnect(process.env.MAILJET_API_KEY, process.env.MAILJET_API_SECRET);
}
async function sendMailjetEmail(subject, htmlContent, toEmail) {
  if (!mailjetClient) return;
  try {
    await mailjetClient.post("send", { version: "v3.1" }).request({
      Messages: [{
        From: { Email: process.env.MAILJET_SENDER_EMAIL || process.env.EMAIL_FROM || "admin@fundasmile.net", Name: "JoyFund INC" },
        To: [{ Email: toEmail || process.env.NOTIFY_EMAIL }],
        Subject: subject,
        HTMLPart: htmlContent
      }]
    });
  } catch (err) { console.error("Mailjet error:", err); }
}

// -------------------- GOOGLE SHEETS --------------------
let sheets;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    sheets = google.sheets({ version: "v4", auth });
  }
} catch (err) { console.error("Google Sheets init failed", err.message); }

async function getSheetValues(spreadsheetId, range) {
  if (!sheets || !spreadsheetId) return [];
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function appendSheetValues(spreadsheetId, range, values) {
  if (!sheets || !spreadsheetId) throw new Error("Sheets not initialized or missing spreadsheetId");
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    resource: { values }
  });
}

async function findRowAndUpdateOrAppend(spreadsheetId, rangeCols, matchColIndex, matchValue, updatedValues) {
  if (!sheets || !spreadsheetId) throw new Error("Sheets not initialized or missing spreadsheetId");
  const rows = await getSheetValues(spreadsheetId, rangeCols);
  const rowIndex = rows.findIndex(r => (r[matchColIndex] || "").toString().trim().toLowerCase() === (matchValue || "").toString().trim().toLowerCase());
  if (rowIndex === -1) {
    await appendSheetValues(spreadsheetId, rangeCols, [updatedValues]);
    return { action: "appended", row: rows.length + 1 };
  } else {
    const rowNumber = rowIndex + 1;
    // derive start column letter from rangeCols (e.g., "Sheet1!A:D")
    const sheetPart = rangeCols.split("!")[1] || "A";
    const startCol = sheetPart.charAt(0);
    const endCol = String.fromCharCode(startCol.charCodeAt(0) + updatedValues.length - 1);
    const updateRange = `${rangeCols.split("!")[0]}!${startCol}${rowNumber}:${endCol}${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: updateRange,
      valueInputOption: "USER_ENTERED",
      resource: { values: [updatedValues] }
    });
    return { action: "updated", row: rowNumber };
  }
}

// -------------------- MULTER --------------------
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ==================== LIVE VISITOR TRACKING ====================
async function logVisitor(page) {
  try {
    if (!process.env.VISITOR_SHEET_ID) return;
    const timestamp = new Date().toISOString();
    return await appendSheetValues(process.env.VISITOR_SHEET_ID, "A:D", [
      [timestamp, page || "/", "visitor", ""]
    ]);
  } catch (err) {
    console.error("Visitor logging failed:", err.message);
  }
}

// Middleware to log public page visits only
app.use(async (req, res, next) => {
  const page = req.path;

  // Only log real public pages, skip admin, api, and static files
  if (!page.startsWith("/api") && !page.startsWith("/admin") && !page.startsWith("/public")) {
    try {
      await logVisitor(page);
    } catch (err) {
      console.error("Visitor logging failed:", err.message);
    }
  }

  next();
});

// ==================== USERS & AUTH ====================
async function getUsers() {
  if (!process.env.USERS_SHEET_ID) return [];
  return getSheetValues(process.env.USERS_SHEET_ID, "A:D");
}

app.post("/api/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
    const users = await getUsers();
    const emailLower = email.trim().toLowerCase();
    if (users.some(u => u[2] && u[2].trim().toLowerCase() === emailLower)) return res.status(409).json({ error: "Email already exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const timestamp = new Date().toISOString();
    await appendSheetValues(process.env.USERS_SHEET_ID, "A:D", [[timestamp, name, emailLower, hashedPassword]]);
    req.session.user = { name, email: emailLower, joinDate: timestamp };
    res.json({ ok: true, loggedIn: true, user: req.session.user });
  } catch (err) { console.error(err); res.status(500).json({ error: "Signup failed" }); }
});

app.post("/api/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });
    const users = await getUsers();
    const inputEmail = email.trim().toLowerCase();
    const userRow = users.find(u => u[2] && u[2].trim().toLowerCase() === inputEmail);
    if (!userRow) return res.status(401).json({ error: "Invalid credentials" });
    const match = await bcrypt.compare(password, (userRow[3] || "").trim());
    if (!match) return res.status(401).json({ error: "Invalid credentials" });
    req.session.user = { name: userRow[1], email: userRow[2], joinDate: userRow[0] };
    res.json({ ok: true, loggedIn: true, user: req.session.user });
  } catch (err) { console.error(err); res.status(500).json({ error: "Signin failed" }); }
});

app.get("/api/check-session", (req, res) => res.json({ loggedIn: !!req.session.user, user: req.session.user || null }));
app.post("/api/logout", (req, res) => req.session.destroy(err => err ? res.status(500).json({ error: "Logout failed" }) : res.json({ ok: true })));

// ==================== PASSWORD RESET ====================
app.post("/api/request-reset", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Missing email" });
    const token = crypto.randomBytes(20).toString("hex");
    const expiry = Date.now() + 3600000;
    await appendSheetValues(process.env.USERS_SHEET_ID, "E:G", [[email.toLowerCase(), token, expiry]]);
    await sendMailjetEmail(
      "Password Reset",
      `<p>Click <a href="${process.env.FRONTEND_URL}/reset-password?token=${token}">here</a> to reset your password. Expires in 1 hour.</p>`,
      email
    );
    res.json({ ok: true, message: "Reset email sent" });
  } catch (err) { console.error(err); res.status(500).json({ error: "Failed to request reset" }); }
});

app.post("/api/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: "Missing fields" });
    const rows = await getSheetValues(process.env.USERS_SHEET_ID, "E:G");
    const row = rows.find(r => r[1] === token && r[2] && parseInt(r[2], 10) > Date.now());
    if (!row) return res.status(400).json({ error: "Invalid or expired token" });
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const email = row[0];
    await findRowAndUpdateOrAppend(process.env.USERS_SHEET_ID, "A:D", 2, email, [row[0], row[1], row[2], hashedPassword]);
    res.json({ ok: true, message: "Password reset successful" });
  } catch (err) { console.error(err); res.status(500).json({ error: "Failed to reset password" }); }
});

// ==================== WAITLIST / VOLUNTEERS / STREET TEAM ====================
app.post("/api/waitlist", async (req, res) => {
  try {
    const { name, email, reason } = req.body;
    if (!name || !email) return res.status(400).json({ success: false, message: "Missing name or email" });
    const timestamp = new Date().toLocaleString();
    await appendSheetValues(process.env.WAITLIST_SHEET_ID, "Waitlist!A:D", [[timestamp, name, email.toLowerCase(), reason || ""]]);
    await sendMailjetEmail("New Waitlist Submission", `<p>${name} (${email}) joined the waitlist at ${timestamp}. Reason: ${reason || "N/A"}</p>`);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: "Failed to submit waitlist" }); }
});

app.post("/api/volunteer", async (req, res) => {
  try {
    const { name, email, role, availability } = req.body;
    if (!name || !email || !role) return res.status(400).json({ success: false });
    const timestamp = new Date().toLocaleString();
    await appendSheetValues(process.env.VOLUNTEERS_SHEET_ID, "Volunteers!A:E", [[timestamp, name, email.toLowerCase(), role, availability || ""]]);
    await sendMailjetEmail("New Volunteer Submission", `<p>${name} (${email}) signed up as volunteer for ${role} at ${timestamp}. Availability: ${availability || "N/A"}</p>`);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

app.post("/api/street-team", async (req, res) => {
  try {
    const { name, email, city, hoursAvailable } = req.body;
    if (!name || !email || !city) return res.status(400).json({ success: false });
    const timestamp = new Date().toLocaleString();
    await appendSheetValues(process.env.STREETTEAM_SHEET_ID, "StreetTeam!A:E", [[timestamp, name, email.toLowerCase(), city, hoursAvailable || ""]]);
    await sendMailjetEmail("New Street Team Submission", `<p>${name} (${email}) joined street team in ${city} at ${timestamp}. Hours: ${hoursAvailable || "N/A"}</p>`);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// ==================== CAMPAIGNS ====================
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).json({ success: false, message: "Sign in required" });

    const { title, goal, description, category } = req.body;
    if (!title || !goal || !description || !category) return res.status(400).json({ success: false });

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    const campaignId = Date.now().toString();
    let imageUrl = "https://placehold.co/400x200?text=No+Image";

    if (req.file) {
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder: "joyfund/campaigns" }, (err, result) => err ? reject(err) : resolve(result));
        stream.end(req.file.buffer);
      });
      imageUrl = uploadResult.secure_url;
    }

    const createdAt = new Date().toISOString();
    const status = "Pending";
    const newCampaignRow = [campaignId, title, user.email.toLowerCase(), goal, description, category, status, createdAt, imageUrl];
    await appendSheetValues(spreadsheetId, "A:I", [newCampaignRow]);

    await sendMailjetEmail("New Campaign Submitted", `<p>${user.name} (${user.email}) submitted a campaign titled "${title}"</p>`);
    res.json({ success: true, message: "Campaign submitted", campaignId });
  } catch (err) { console.error(err); res.status(500).json({ success: false, message: "Failed to create campaign" }); }
});

app.get("/api/public-campaigns", async (req, res) => {
  try {
    if (!sheets) return res.status(500).json({ success: false });
    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    const rows = await getSheetValues(spreadsheetId, "A:I");
    const activeCampaigns = rows.filter(r => r[6] && ["Approved", "active"].includes(String(r[6]).toLowerCase() === String(r[6]) ? r[6] : r[6]))
      .map(r => ({
        campaignId: r[0],
        title: r[1],
        creator: r[2],
        goal: parseFloat(r[3]) || 0,
        description: r[4],
        category: r[5],
        status: r[6],
        createdAt: r[7],
        imageUrl: r[8] || "https://placehold.co/400x200?text=No+Image"
      }));
    res.json({ success: true, campaigns: activeCampaigns });
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// -------------------- DASHBOARD / USER ROUTES --------------------

// GET /api/donations
// Returns donations from Stripe (primary) and optionally from a DONATIONS_SHEET_ID.
// Accessible to admin OR signed-in users. If user is signed-in and not admin, returns donations for campaigns they created.
app.get("/api/donations", async (req, res) => {
  try {
    // allow admin to see all; normal user sees donations related to their campaigns only
    const isAdmin = !!req.session?.admin;
    const userEmail = req.session?.user?.email?.toLowerCase();

    // fetch stripe historical donations (similar to admin dashboard logic)
    let stripeDonations = [];
    if (stripe) {
      try {
        const list = await stripe.paymentIntents.list({ limit: 100 });
        stripeDonations = list.data.map(d => ({
          id: d.id,
          amount: (d.amount || 0) / 100,
          currency: d.currency,
          status: d.status,
          customer_email: d.customer_email || "N/A",
          campaignId: d.metadata?.campaignId || "Mission",
          created: new Date((d.created || 0) * 1000).toISOString()
        }));
      } catch (sErr) {
        console.error("Stripe fetch failed:", sErr.message);
      }
    }

    // optionally include donations stored in a Google Sheet
    let sheetDonations = [];
    if (process.env.DONATIONS_SHEET_ID && sheets) {
      const rows = await getSheetValues(process.env.DONATIONS_SHEET_ID, "A:Z");
      // assume columns: timestamp, donorName, donorEmail, amount, currency, campaignId, note...
      sheetDonations = rows.map(r => ({
        timestamp: r[0],
        donorName: r[1],
        donorEmail: r[2],
        amount: parseFloat(r[3]) || 0,
        currency: r[4] || "USD",
        campaignId: r[5] || "Mission",
        note: r[6] || ""
      }));
    }

    // if not admin, filter donations to only those linked to campaigns created by the user
    if (!isAdmin && userEmail) {
      // get user's campaigns
      const campaignRows = process.env.CAMPAIGNS_SHEET_ID && sheets ? await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I") : [];
      const userCampaignIds = campaignRows
        .filter(r => (r[2] || "").toLowerCase() === userEmail)
        .map(r => String(r[0])); // campaignId is column A

      stripeDonations = stripeDonations.filter(d => !d.campaignId || userCampaignIds.includes(String(d.campaignId)));
      sheetDonations = sheetDonations.filter(d => !d.campaignId || userCampaignIds.includes(String(d.campaignId)));
    }

    res.json({ success: true, stripe: stripeDonations, sheet: sheetDonations });
  } catch (err) {
    console.error("GET /api/donations error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch donations" });
  }
});

// GET /api/my-verifications
// Returns ID verification rows for the currently signed-in user (by email).
app.get("/api/my-verifications", async (req, res) => {
  try {
    const userEmail = req.session?.user?.email?.toLowerCase();
    if (!userEmail) return res.status(401).json({ success: false, message: "Sign in required" });

    if (!process.env.ID_VERIFICATION_SHEET_ID || !sheets) {
      return res.json({ success: true, verifications: [] });
    }

    // read the ID verification sheet (assumed columns: Email, Status, ID Photo URL, ...)
    const rows = await getSheetValues(process.env.ID_VERIFICATION_SHEET_ID, "A:Z");
    const userRows = rows
      .map((r, idx) => ({ rowIndex: idx + 1, row: r }))
      .filter(rObj => (rObj.row[0] || "").toLowerCase() === userEmail)
      .map(rObj => ({
        rowIndex: rObj.rowIndex,
        email: rObj.row[0],
        status: rObj.row[1] || "",
        idPhotoUrl: rObj.row[2] || ""
      }));

    res.json({ success: true, verifications: userRows });
  } catch (err) {
    console.error("GET /api/my-verifications error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch verifications" });
  }
});

// GET /api/my-campaigns
// Returns campaigns created by the signed-in user
app.get("/api/my-campaigns", async (req, res) => {
  try {
    const userEmail = req.session?.user?.email?.toLowerCase();
    if (!userEmail) return res.status(401).json({ success: false, message: "Sign in required" });

    if (!process.env.CAMPAIGNS_SHEET_ID || !sheets) {
      return res.json({ success: true, campaigns: [] });
    }

    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I");
    const myCampaigns = rows
      .filter(r => (r[2] || "").toLowerCase() === userEmail)
      .map(r => ({
        campaignId: r[0],
        title: r[1],
        creator: r[2],
        goal: parseFloat(r[3]) || 0,
        description: r[4],
        category: r[5],
        status: r[6],
        createdAt: r[7],
        imageUrl: r[8] || "https://placehold.co/400x200?text=No+Image"
      }));

    res.json({ success: true, campaigns: myCampaigns });
  } catch (err) {
    console.error("GET /api/my-campaigns error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch campaigns" });
  }
});

// ==================== ADMIN ROUTES ====================
function requireAdmin(req, res, next) {
  if (req.session.admin) return next();
  res.status(403).json({ success: false, message: "Admin access required" });
}

// ADMIN LOGIN / SESSION / LOGOUT
app.post("/admin-login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.admin = { username };
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, message: "Invalid credentials" });
});

app.get("/admin-session", (req, res) => {
  res.json({ isAdmin: !!req.session.admin, admin: req.session.admin || null });
});

app.post("/admin-logout", (req, res) => {
  req.session.admin = null;
  res.json({ success: true });
});

// ADMIN DASHBOARD
app.get("/admin/dashboard", requireAdmin, async (req, res) => {
  try {
    const users = await getSheetValues(process.env.USERS_SHEET_ID, "A:D");
    const campaigns = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I");
    const waitlist = await getSheetValues(process.env.WAITLIST_SHEET_ID, "Waitlist!A:D");
    const volunteers = await getSheetValues(process.env.VOLUNTEERS_SHEET_ID, "Volunteers!A:E");
    const streetTeam = await getSheetValues(process.env.STREETTEAM_SHEET_ID, "StreetTeam!A:E");
    const verifications = await getSheetValues(process.env.ID_VERIFICATION_SHEET_ID, "A:C");

    let stripePayments = { data: [] };
    try {
      stripePayments = await stripe.paymentIntents.list({ limit: 100 });
    } catch (sErr) {
      console.error("Stripe list error:", sErr.message);
    }

    const historicalDonations = (stripePayments.data || []).map(d => ({
      id: d.id,
      amount: d.amount / 100,
      currency: d.currency,
      status: d.status,
      customer_email: d.customer_email || "N/A",
      campaignId: d.metadata?.campaignId || "Mission",
      created: new Date(d.created * 1000).toISOString()
    }));

    res.json({ success: true, users, campaigns, waitlist, volunteers, streetTeam, verifications, historicalDonations });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ==================== START SERVER ====================
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
