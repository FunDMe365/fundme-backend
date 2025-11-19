// ==================== SERVER.JS - JOYFUND FULL FEATURE ====================

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

const allowedOrigins = process.env.ALLOWED_ORIGINS.split(",");
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error("CORS not allowed"));
  },
  credentials: true
}));

// Handle OPTIONS preflight for all routes
app.options("*", cors({ origin: allowedOrigins, credentials: true }));

// -------------------- BODY PARSER --------------------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// -------------------- SESSION --------------------
app.set('trust proxy', 1);
app.use(session({
  name: 'sessionId',
  secret: process.env.SESSION_SECRET || 'supersecretkey',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
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
        From: { Email: process.env.MAILJET_SENDER_EMAIL, Name: "JoyFund INC" },
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
  if (!sheets) return [];
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function appendSheetValues(spreadsheetId, range, values) {
  if (!sheets) throw new Error("Sheets not initialized");
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    resource: { values }
  });
}

async function findRowAndUpdateOrAppend(spreadsheetId, rangeCols, matchColIndex, matchValue, updatedValues) {
  if (!sheets) throw new Error("Sheets not initialized");
  const rows = await getSheetValues(spreadsheetId, rangeCols);
  const rowIndex = rows.findIndex(r => (r[matchColIndex] || "").toString().trim().toLowerCase() === (matchValue || "").toString().trim().toLowerCase());

  if (rowIndex === -1) {
    await appendSheetValues(spreadsheetId, rangeCols, [updatedValues]);
    return { action: "appended", row: rows.length + 1 };
  } else {
    const rowNumber = rowIndex + 1;
    const startCol = rangeCols.split("!")[1].charAt(0);
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

app.post("/api/logout", (req, res) => {
  req.session.destroy(err => err ? res.status(500).json({ error: "Logout failed" }) : res.json({ ok: true }));
});

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
    await appendSheetValues(process.env.STREET_TEAM_SHEET_ID, "StreetTeam!A:E", [[timestamp, name, email.toLowerCase(), city, hoursAvailable || ""]]);
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
    const activeCampaigns = rows.filter(r => r[6] && ["Approved", "active"].includes(r[6]))
      .map(r => ({
        campaignId: r[0],
        title: r[1],
        creator: r[2],
        goal: parseFloat(r[3]),
        description: r[4],
        category: r[5],
        status: r[6],
        createdAt: r[7],
        imageUrl: r[8] || "https://placehold.co/400x200?text=No+Image"
      }));
    res.json({ success: true, campaigns: activeCampaigns });
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// -------------------- CAMPAIGN SEARCH --------------------
app.get("/api/search-campaigns", async (req, res) => {
  try {
    const { category, minGoal, maxGoal } = req.query;
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I");
    let campaigns = rows.filter(r => r[6] && ["Approved", "active"].includes(r[6]))
      .map(r => ({
        campaignId: r[0],
        title: r[1],
        creator: r[2],
        goal: parseFloat(r[3]),
        description: r[4],
        category: r[5],
        status: r[6],
        createdAt: r[7],
        imageUrl: r[8] || "https://placehold.co/400x200?text=No+Image"
      }));

    if (category) campaigns = campaigns.filter(c => c.category.toLowerCase() === category.toLowerCase());
    if (minGoal) campaigns = campaigns.filter(c => c.goal >= parseFloat(minGoal));
    if (maxGoal) campaigns = campaigns.filter(c => c.goal <= parseFloat(maxGoal));

    res.json({ success: true, campaigns });
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// -------------------- STRIPE CHECKOUT --------------------
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { amount, successUrl, cancelUrl } = req.body;
    if (!amount || !successUrl || !cancelUrl) return res.status(400).json({ error: "Missing fields" });

    const amountCents = Math.round(amount * 100);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `JoyFund Donation - ${campaignId}` },
          unit_amount: amountCents
        },
        quantity: 1
      }],
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl
    });

    res.json({ sessionId: session.id });
  } catch (err) { console.error(err); res.status(500).json({ error: "Failed to create checkout session" }); }
});

// -------------------- ID VERIFICATION --------------------
app.post("/api/verify-id", upload.single("idImage"), async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).json({ success: false, message: "Sign in required" });

    if (!req.file) return res.status(400).json({ success: false, message: "ID image required" });

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder: "joyfund/id-verification" }, (err, result) => err ? reject(err) : resolve(result));
      stream.end(req.file.buffer);
    });

    await appendSheetValues(process.env.ID_VERIFICATION_SHEET_ID, "A:C", [[new Date().toISOString(), user.email, uploadResult.secure_url]]);
    res.json({ success: true, message: "ID submitted", imageUrl: uploadResult.secure_url });
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// ==================== DASHBOARD ROUTES ====================

// 1. User campaigns
app.get("/api/my-campaigns", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).json({ success: false, message: "Sign in required" });
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I");
    const myCampaigns = rows.filter(r => r[2] && r[2].toLowerCase() === user.email.toLowerCase())
      .map(r => ({
        campaignId: r[0],
        title: r[1],
        creator: r[2],
        goal: parseFloat(r[3]),
        description: r[4],
        category: r[5],
        status: r[6],
        createdAt: r[7],
        imageUrl: r[8] || "https://placehold.co/400x200?text=No+Image"
      }));
    res.json({ success: true, campaigns: myCampaigns });
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// 2. User donations
app.get("/api/donations", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).json({ success: false, message: "Sign in required" });
    const rows = await getSheetValues(process.env.DONATIONS_SHEET_ID, "A:E");
    const myDonations = rows.filter(r => r[1] && r[1].toLowerCase() === user.email.toLowerCase())
      .map(r => ({ donationId: r[0], donorEmail: r[1], campaignId: r[2], amount: parseFloat(r[3]), donatedAt: r[4] }));
    res.json({ success: true, donations: myDonations });
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

// 3. User verifications
app.get("/api/my-verifications", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).json({ success: false, message: "Sign in required" });

    // Pull all columns including Status and ID Photo URL
    const rows = await getSheetValues(process.env.ID_VERIFICATION_SHEET_ID, "ID_Verifications!A:E");

    const myVerifications = rows
      .filter(r => r[1] && r[1].toLowerCase() === user.email.toLowerCase())
      .map(r => ({
        submittedAt: r[0],
        email: r[1],
        name: r[2],
        status: r[3] || "Pending",       // Column D
        idImageUrl: r[4] || null         // Column E
      }));

    res.json({ success: true, verifications: myVerifications });
  } catch (err) {
    console.error("Error fetching verifications:", err);
    res.status(500).json({ success: false });
  }
});



// ==================== ADMIN & ANALYTICS ADDITIONS (GOOGLE SHEETS ONLY) ====================
// The block below is appended to your existing server.js (keeps everything above intact).
// It adds admin authentication, admin session routes, dashboard stats, visitor logging middleware,
// user / campaign / verification management endpoints for admin, all using Google Sheets only.

// -------------------- SAFETY: ensure sheets are initialized --------------------
if (!sheets) {
  console.warn("Warning: Google Sheets not initialized. Admin routes that read/write Sheets will fail until GOOGLE_CREDENTIALS_JSON is set.");
}

// -------------------- VISITOR TRACKING MIDDLEWARE --------------------
// This will append a simple row to your VISITORS_SHEET_ID for GET /api requests that are public (not admin).
// Each row: [timestamp, ip, path, userAgent, userEmail]
app.use(async (req, res, next) => {
  try {
    // Only log GET calls to /api that are not admin endpoints and not internal health checks
    if (req.method === "GET" && req.path.startsWith("/api") && !req.path.startsWith("/api/admin") && !req.path.startsWith("/api/check-session")) {
      if (process.env.VISITORS_SHEET_ID && sheets) {
        const timestamp = new Date().toISOString();
        const ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress || req.ip || "";
        const path = req.path;
        const ua = req.get("User-Agent") || "";
        const email = req.session && req.session.user ? req.session.user.email : "";
        // Try to append, but don't block the request if it fails
        appendSheetValues(process.env.VISITORS_SHEET_ID, "Visitors!A:E", [[timestamp, ip, path, ua, email]]).catch(err => {
          // swallow error but log for debugging
          console.error("Visitor log failed:", err && err.message ? err.message : err);
        });
      }
    }
  } catch (err) {
    console.error("Visitor middleware error:", err && err.message ? err.message : err);
  } finally {
    next();
  }
});

// -------------------- ADMIN AUTH ROUTES --------------------
app.post("/admin-login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, message: "Missing username or password" });

    // If you later move admin credentials to environment, update checks here
    const valid = (username === ADMIN_USERNAME && password === ADMIN_PASSWORD)
      || (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD && username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD);

    if (!valid) return res.status(401).json({ success: false, message: "Invalid credentials" });

    // Create admin session
    req.session.isAdmin = true;
    req.session.adminUsername = username;
    // Optional: store login time
    const loginAt = new Date().toISOString();
    if (process.env.ADMIN_LOGS_SHEET_ID && sheets) {
      appendSheetValues(process.env.ADMIN_LOGS_SHEET_ID, "AdminLogs!A:D", [[loginAt, username, req.ip || "", "login"]]).catch(e => console.error("Admin log write failed:", e && e.message ? e.message : e));
    }

    res.json({ success: true, message: "Admin logged in" });
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ success: false, message: "Admin login failed" });
  }
});

app.get("/admin-session", (req, res) => {
  try {
    const isAdmin = !!req.session.isAdmin;
    res.json({ loggedIn: isAdmin, admin: isAdmin ? { username: req.session.adminUsername || ADMIN_USERNAME } : null });
  } catch (err) {
    console.error("Admin session check error:", err);
    res.status(500).json({ loggedIn: false });
  }
});

app.post("/admin-logout", (req, res) => {
  try {
    const username = req.session && req.session.adminUsername;
    req.session.isAdmin = false;
    req.session.adminUsername = null;
    req.session.save && req.session.save(() => {});
    if (process.env.ADMIN_LOGS_SHEET_ID && sheets) {
      appendSheetValues(process.env.ADMIN_LOGS_SHEET_ID, "AdminLogs!A:D", [[new Date().toISOString(), username || "admin", req.ip || "", "logout"]]).catch(e => console.error("Admin log write failed:", e && e.message ? e.message : e));
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Admin logout error:", err);
    res.status(500).json({ success: false });
  }
});

// -------------------- REQUIRE ADMIN MIDDLEWARE --------------------
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ success: false, message: "Admin authentication required" });
}

// -------------------- ADMIN DASHBOARD / STATS ROUTES --------------------
// These endpoints read from your existing sheets and return aggregated stats.

// Helper to safely get rows length
async function safeRowCount(sheetId, range) {
  try {
    const rows = await getSheetValues(sheetId, range);
    return rows.length || 0;
  } catch (err) {
    return 0;
  }
}

// Total users
app.get("/admin-stats/total-users", requireAdmin, async (req, res) => {
  try {
    const total = await safeRowCount(process.env.USERS_SHEET_ID, "A:D");
    res.json({ success: true, totalUsers: total });
  } catch (err) {
    console.error("total-users error:", err);
    res.status(500).json({ success: false });
  }
});

// Total campaigns
app.get("/admin-stats/total-campaigns", requireAdmin, async (req, res) => {
  try {
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I");
    res.json({ success: true, totalCampaigns: rows.length });
  } catch (err) {
    console.error("total-campaigns error:", err);
    res.status(500).json({ success: false });
  }
});

// Active campaigns
app.get("/admin-stats/active-campaigns", requireAdmin, async (req, res) => {
  try {
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I");
    const active = rows.filter(r => r[6] && ["Approved", "active"].includes((r[6] || "").toString().toLowerCase() ? r[6] : r[6]) || ["Approved", "active"].includes(r[6])).length;
    // safer compute:
    const activeCount = rows.filter(r => r[6] && ["approved", "active"].includes((r[6] || "").toString().toLowerCase())).length;
    res.json({ success: true, activeCampaigns: activeCount });
  } catch (err) {
    console.error("active-campaigns error:", err);
    res.status(500).json({ success: false });
  }
});

// Closed campaigns
app.get("/admin-stats/closed-campaigns", requireAdmin, async (req, res) => {
  try {
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I");
    const closedCount = rows.filter(r => r[6] && ["closed", "completed"].includes((r[6] || "").toString().toLowerCase())).length;
    res.json({ success: true, closedCampaigns: closedCount });
  } catch (err) {
    console.error("closed-campaigns error:", err);
    res.status(500).json({ success: false });
  }
});

// Pending verifications
app.get("/admin-stats/pending-id-verifications", requireAdmin, async (req, res) => {
  try {
    const rows = await getSheetValues(process.env.ID_VERIFICATION_SHEET_ID, "ID_Verifications!A:E");
    const pending = rows.filter(r => !r[3] || (r[3] && r[3].toString().toLowerCase().trim() !== "approved")).length;
    res.json({ success: true, pendingVerifications: pending });
  } catch (err) {
    console.error("pending-id-verifications error:", err);
    res.status(500).json({ success: false });
  }
});

// New users today (since 00:00 UTC)
app.get("/admin-stats/new-users-today", requireAdmin, async (req, res) => {
  try {
    const rows = await getSheetValues(process.env.USERS_SHEET_ID, "A:D");
    const startOfDay = new Date();
    startOfDay.setUTCHours(0,0,0,0);
    const count = rows.filter(r => {
      const ts = r[0];
      if (!ts) return false;
      const d = new Date(ts);
      return d >= startOfDay;
    }).length;
    res.json({ success: true, newUsersToday: count });
  } catch (err) {
    console.error("new-users-today error:", err);
    res.status(500).json({ success: false });
  }
});

// Donations summary (total and count)
app.get("/admin-stats/donations-summary", requireAdmin, async (req, res) => {
  try {
    const rows = await getSheetValues(process.env.DONATIONS_SHEET_ID, "A:E");
    let total = 0;
    let count = 0;
    rows.forEach(r => {
      const amt = parseFloat(r[3]);
      if (!isNaN(amt)) { total += amt; count += 1; }
    });
    res.json({ success: true, totalDonationsAmount: total, donationsCount: count });
  } catch (err) {
    console.error("donations-summary error:", err);
    res.status(500).json({ success: false });
  }
});

// Live visitors (recent rows from Visitors sheet)
app.get("/admin-stats/visitors-live", requireAdmin, async (req, res) => {
  try {
    const rows = await getSheetValues(process.env.VISITORS_SHEET_ID, "Visitors!A:E");
    // Provide the last 100 entries for dashboard
    const last = rows.slice(-100).map(r => ({
      timestamp: r[0],
      ip: r[1],
      path: r[2],
      userAgent: r[3],
      email: r[4]
    }));
    res.json({ success: true, visitors: last });
  } catch (err) {
    console.error("visitors-live error:", err);
    res.status(500).json({ success: false });
  }
});

// Visitors today count
app.get("/admin-stats/visitors-today", requireAdmin, async (req, res) => {
  try {
    const rows = await getSheetValues(process.env.VISITORS_SHEET_ID, "Visitors!A:E");
    const startOfDay = new Date();
    startOfDay.setUTCHours(0,0,0,0);
    const count = rows.filter(r => {
      const ts = r[0];
      if (!ts) return false;
      const d = new Date(ts);
      return d >= startOfDay;
    }).length;
    res.json({ success: true, visitorsToday: count });
  } catch (err) {
    console.error("visitors-today error:", err);
    res.status(500).json({ success: false });
  }
});

// -------------------- ADMIN USER MANAGEMENT --------------------
// List users
app.get("/admin/users", requireAdmin, async (req, res) => {
  try {
    const rows = await getSheetValues(process.env.USERS_SHEET_ID, "A:E"); // include possible status column E
    const users = rows.map(r => ({
      joinDate: r[0],
      name: r[1],
      email: r[2],
      passwordHash: r[3],
      status: r[4] || "active"
    }));
    res.json({ success: true, users });
  } catch (err) {
    console.error("admin/users error:", err);
    res.status(500).json({ success: false });
  }
});

// Get single user by email
app.get("/admin/user/:email", requireAdmin, async (req, res) => {
  try {
    const email = (req.params.email || "").toString().toLowerCase();
    const rows = await getSheetValues(process.env.USERS_SHEET_ID, "A:E");
    const row = rows.find(r => r[2] && r[2].toLowerCase() === email);
    if (!row) return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, user: { joinDate: row[0], name: row[1], email: row[2], passwordHash: row[3], status: row[4] || "active" } });
  } catch (err) {
    console.error("admin/user/:email error:", err);
    res.status(500).json({ success: false });
  }
});

// Disable user (set status to disabled)
app.post("/admin/user/:email/disable", requireAdmin, async (req, res) => {
  try {
    const email = (req.params.email || "").toString().toLowerCase();
    if (!email) return res.status(400).json({ success: false, message: "Missing email" });

    const rows = await getSheetValues(process.env.USERS_SHEET_ID, "A:E");
    const rowIndex = rows.findIndex(r => r[2] && r[2].toLowerCase() === email);
    if (rowIndex === -1) return res.status(404).json({ success: false, message: "User not found" });

    const newRow = rows[rowIndex].slice(0); // copy
    // ensure array length >=5 to hold status
    while (newRow.length < 5) newRow.push("");
    newRow[4] = "disabled";

    const rowNumber = rowIndex + 1;
    const updateRange = `${process.env.USERS_SHEET_ID ? "" : ""}${process.env.USERS_SHEET_ID ? process.env.USERS_SHEET_ID.split("/")[0] : ""}`; // unused but kept
    // compute update using A:E
    const startCol = "A";
    const endCol = "E";
    const spreadsheetId = process.env.USERS_SHEET_ID;
    const rangeToUpdate = `${(await (() => "Sheet1")())}`; // dummy to keep code structure; we'll compute properly below

    // Use sheets API directly to update the row
    const sheetNameRange = "A:E";
    const rowNum = rowNumber;
    const updateRangeFinal = `${process.env.USERS_SHEET_ID ? "" : ""}`; // placeholder - we'll use the common update technique
    // Proper update:
    const sheetTitle = (await (async () => {
      // Try to get the actual sheet name from env use "A:E" direct range with numbers
      return "";
    })())();

    // Simpler approach: use the same technique as findRowAndUpdateOrAppend
    const startColChar = "A";
    const endColChar = "E";
    const finalRange = `${process.env.USERS_SHEET_ID ? '' : ''}${process.env.USERS_SHEET_ID ? '' : ''}`; // unused placeholders
    // Compose the range like "Sheet1!A{row}:E{row}" - but we don't know sheet tab name. Since original code uses ranges like "A:D" (no sheet name), follow same: use `${process.env.USERS_SHEET_ID}!A${rowNum}:E${rowNum}` would be wrong because that expects sheetId value not doc ID. Instead we'll use the same pattern used in findRowAndUpdateOrAppend which used `rangeCols.split("!")[0]` - when provided "A:E" there is no sheet name. So we'll craft the direct update similar to that function:
    const updateRangeForAPI = `A${rowNum}:E${rowNum}`;

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.USERS_SHEET_ID,
      range: updateRangeForAPI,
      valueInputOption: "USER_ENTERED",
      resource: { values: [newRow] }
    });

    res.json({ success: true, message: "User disabled" });
  } catch (err) {
    console.error("admin disable user error:", err && err.message ? err.message : err);
    res.status(500).json({ success: false });
  }
});

// Enable user (set status to active)
app.post("/admin/user/:email/enable", requireAdmin, async (req, res) => {
  try {
    const email = (req.params.email || "").toString().toLowerCase();
    if (!email) return res.status(400).json({ success: false, message: "Missing email" });

    const rows = await getSheetValues(process.env.USERS_SHEET_ID, "A:E");
    const rowIndex = rows.findIndex(r => r[2] && r[2].toLowerCase() === email);
    if (rowIndex === -1) return res.status(404).json({ success: false, message: "User not found" });

    const newRow = rows[rowIndex].slice(0); // copy
    while (newRow.length < 5) newRow.push("");
    newRow[4] = "active";
    const rowNumber = rowIndex + 1;
    const updateRangeForAPI = `A${rowNumber}:E${rowNumber}`;

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.USERS_SHEET_ID,
      range: updateRangeForAPI,
      valueInputOption: "USER_ENTERED",
      resource: { values: [newRow] }
    });

    res.json({ success: true, message: "User enabled" });
  } catch (err) {
    console.error("admin enable user error:", err && err.message ? err.message : err);
    res.status(500).json({ success: false });
  }
});

// -------------------- ADMIN CAMPAIGN MANAGEMENT --------------------
// List all campaigns
app.get("/admin/campaigns", requireAdmin, async (req, res) => {
  try {
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I");
    const campaigns = rows.map(r => ({
      campaignId: r[0],
      title: r[1],
      creator: r[2],
      goal: r[3],
      description: r[4],
      category: r[5],
      status: r[6],
      createdAt: r[7],
      imageUrl: r[8]
    }));
    res.json({ success: true, campaigns });
  } catch (err) {
    console.error("admin/campaigns error:", err);
    res.status(500).json({ success: false });
  }
});

// Get single campaign
app.get("/admin/campaign/:id", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I");
    const rowIndex = rows.findIndex(r => r[0] === id);
    if (rowIndex === -1) return res.status(404).json({ success: false, message: "Campaign not found" });
    const r = rows[rowIndex];
    res.json({ success: true, campaign: { campaignId: r[0], title: r[1], creator: r[2], goal: r[3], description: r[4], category: r[5], status: r[6], createdAt: r[7], imageUrl: r[8] } });
  } catch (err) {
    console.error("admin campaign fetch error:", err);
    res.status(500).json({ success: false });
  }
});

// Helper to update a campaign row
async function updateCampaignRowByIndex(spreadsheetId, rowIndex, newRow) {
  const rowNumber = rowIndex + 1;
  const updateRange = `A${rowNumber}:I${rowNumber}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: updateRange,
    valueInputOption: "USER_ENTERED",
    resource: { values: [newRow] }
  });
}

// Close campaign (set status to Closed)
app.post("/admin/campaign/:id/close", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I");
    const idx = rows.findIndex(r => r[0] === id);
    if (idx === -1) return res.status(404).json({ success: false, message: "Campaign not found" });
    const row = rows[idx].slice(0);
    while (row.length < 9) row.push("");
    row[6] = "Closed";
    await updateCampaignRowByIndex(process.env.CAMPAIGNS_SHEET_ID, idx, row);
    res.json({ success: true, message: "Campaign closed" });
  } catch (err) {
    console.error("admin campaign close error:", err);
    res.status(500).json({ success: false });
  }
});

// Open campaign (set status to Approved/active)
app.post("/admin/campaign/:id/open", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I");
    const idx = rows.findIndex(r => r[0] === id);
    if (idx === -1) return res.status(404).json({ success: false, message: "Campaign not found" });
    const row = rows[idx].slice(0);
    while (row.length < 9) row.push("");
    row[6] = "Approved";
    await updateCampaignRowByIndex(process.env.CAMPAIGNS_SHEET_ID, idx, row);
    res.json({ success: true, message: "Campaign opened/approved" });
  } catch (err) {
    console.error("admin campaign open error:", err);
    res.status(500).json({ success: false });
  }
});

// -------------------- ID VERIFICATION ADMIN ROUTES --------------------
// List verifications
app.get("/admin/verifications", requireAdmin, async (req, res) => {
  try {
    const rows = await getSheetValues(process.env.ID_VERIFICATION_SHEET_ID, "ID_Verifications!A:E");
    const verifications = rows.map(r => ({
      submittedAt: r[0],
      email: r[1],
      name: r[2],
      status: r[3] || "Pending",
      idImageUrl: r[4] || null
    }));
    res.json({ success: true, verifications });
  } catch (err) {
    console.error("admin/verifications error:", err);
    res.status(500).json({ success: false });
  }
});

// Update verification status by email (admin)
app.post("/admin/verification/:email/update-status", requireAdmin, async (req, res) => {
  try {
    const email = (req.params.email || "").toLowerCase();
    const { status, name } = req.body;
    if (!status) return res.status(400).json({ success: false, message: "Missing status" });

    const rows = await getSheetValues(process.env.ID_VERIFICATION_SHEET_ID, "ID_Verifications!A:E");
    const idx = rows.findIndex(r => r[1] && r[1].toLowerCase() === email);
    if (idx === -1) return res.status(404).json({ success: false, message: "Verification not found" });

    const row = rows[idx].slice(0);
    while (row.length < 4) row.push("");
    row[3] = status;

    const rowNumber = idx + 1;
    const updateRange = `A${rowNumber}:E${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.ID_VERIFICATION_SHEET_ID,
      range: updateRange,
      valueInputOption: "USER_ENTERED",
      resource: { values: [row] }
    });

    // Optionally notify the user by email about verification result if approved/denied
    if (process.env.MAILJET_API_KEY && process.env.MAILJET_API_SECRET) {
      try {
        await sendMailjetEmail(`ID Verification: ${status}`, `<p>Your ID verification status is now: ${status}.</p>`, email);
      } catch (e) { console.error("notify user mail error:", e && e.message ? e.message : e); }
    }

    res.json({ success: true, message: "Verification status updated" });
  } catch (err) {
    console.error("admin update verification error:", err);
    res.status(500).json({ success: false });
  }
});

// -------------------- ADMIN DONATIONS ROUTES --------------------
app.get("/admin/donations", requireAdmin, async (req, res) => {
  try {
    const rows = await getSheetValues(process.env.DONATIONS_SHEET_ID, "A:E");
    const donations = rows.map(r => ({ donationId: r[0], donorEmail: r[1], campaignId: r[2], amount: parseFloat(r[3]), donatedAt: r[4] }));
    res.json({ success: true, donations });
  } catch (err) {
    console.error("admin donations error:", err);
    res.status(500).json({ success: false });
  }
});

// -------------------- ADMIN WAITLIST & VOLUNTEERS --------------------
app.get("/admin/waitlist", requireAdmin, async (req, res) => {
  try {
    const rows = await getSheetValues(process.env.WAITLIST_SHEET_ID, "Waitlist!A:D");
    const list = rows.map(r => ({ timestamp: r[0], name: r[1], email: r[2], reason: r[3] }));
    res.json({ success: true, waitlist: list });
  } catch (err) {
    console.error("admin waitlist error:", err);
    res.status(500).json({ success: false });
  }
});

app.get("/admin/volunteers", requireAdmin, async (req, res) => {
  try {
    const rows = await getSheetValues(process.env.VOLUNTEERS_SHEET_ID, "Volunteers!A:E");
    const vol = rows.map(r => ({ timestamp: r[0], name: r[1], email: r[2], role: r[3], availability: r[4] }));
    res.json({ success: true, volunteers: vol });
  } catch (err) {
    console.error("admin volunteers error:", err);
    res.status(500).json({ success: false });
  }
});

// -------------------- ADMIN LOGS (optional) --------------------
app.get("/admin/logs", requireAdmin, async (req, res) => {
  try {
    if (!process.env.ADMIN_LOGS_SHEET_ID) return res.json({ success: true, logs: [] });
    const rows = await getSheetValues(process.env.ADMIN_LOGS_SHEET_ID, "AdminLogs!A:D");
    const logs = rows.map(r => ({ timestamp: r[0], username: r[1], ip: r[2], action: r[3] }));
    res.json({ success: true, logs });
  } catch (err) {
    console.error("admin logs error:", err);
    res.status(500).json({ success: false });
  }
});

// -------------------- SECURITY NOTES --------------------
// - All admin routes use requireAdmin which checks req.session.isAdmin.
// - Admin credentials are still the hardcoded ADMIN_USERNAME/ADMIN_PASSWORD at top.
//   Move to environment variables in production: process.env.ADMIN_USERNAME / process.env.ADMIN_PASSWORD.
// - All writes use Google Sheets only as you requested (Option B). Ensure these env vars are set:
//   - VISITORS_SHEET_ID
//   - ADMIN_LOGS_SHEET_ID
//   - USERS_SHEET_ID
//   - CAMPAIGNS_SHEET_ID
//   - DONATIONS_SHEET_ID
//   - ID_VERIFICATION_SHEET_ID
//   - WAITLIST_SHEET_ID
//   - VOLUNTEERS_SHEET_ID
// - If Sheets is not initialized, admin routes will return 500. Check logs for detailed errors.

// ==================== START SERVER ====================
app.listen(PORT, () => console.log(`JoyFund backend running on port ${PORT}`));
