// ==================== SERVER.JS - FULL JOYFUND BACKEND ====================

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
require("dotenv").config();

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "FunDMe$123";

const app = express();
const PORT = process.env.PORT || 5000;

// -------------------- CORS --------------------
const cors = require("cors");
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

if (allowedOrigins.length === 0) {
  app.use(cors({ origin: true, credentials: true }));
  app.options("*", cors({ origin: true, credentials: true }));
} else {
  app.use(
    cors({
      origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error("CORS not allowed: " + origin));
      },
      credentials: true,
    })
  );
  app.options("*", cors({ origin: allowedOrigins, credentials: true }));
}

// -------------------- BODY PARSER --------------------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// -------------------- SESSION --------------------
app.set("trust proxy", 1);
app.use(
  session({
    name: "sessionId",
    secret: process.env.SESSION_SECRET || "supersecretkey",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

// -------------------- STRIPE --------------------
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");

// -------------------- MAILJET --------------------
let mailjetClient = null;
if (process.env.MAILJET_API_KEY && process.env.MAILJET_API_SECRET) {
  mailjetClient = mailjetLib.apiConnect(
    process.env.MAILJET_API_KEY,
    process.env.MAILJET_API_SECRET
  );
}

async function sendMailjetEmail(subject, htmlContent, toEmail) {
  if (!mailjetClient) return;
  try {
    await mailjetClient
      .post("send", { version: "v3.1" })
      .request({
        Messages: [
          {
            From: {
              Email:
                process.env.MAILJET_SENDER_EMAIL ||
                process.env.EMAIL_FROM ||
                "admin@fundasmile.net",
              Name: "JoyFund INC",
            },
            To: [{ Email: toEmail || process.env.NOTIFY_EMAIL }],
            Subject: subject,
            HTMLPart: htmlContent,
          },
        ],
      });
  } catch (err) {
    console.error("Mailjet error:", err);
  }
}

// -------------------- GOOGLE SHEETS --------------------
let sheets;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    sheets = google.sheets({ version: "v4", auth });
  }
} catch (err) {
  console.error("Google Sheets init failed", err.message);
}

async function getSheetValues(spreadsheetId, range) {
  if (!sheets || !spreadsheetId) return [];
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function appendSheetValues(spreadsheetId, range, values) {
  if (!sheets || !spreadsheetId) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });
}

async function findRowAndUpdateOrAppend(
  spreadsheetId,
  rangeCols,
  matchColIndex,
  matchValue,
  updatedValues
) {
  const rows = await getSheetValues(spreadsheetId, rangeCols);
  const rowIndex = rows.findIndex(
    (r) =>
      (r[matchColIndex] || "").toString().trim().toLowerCase() ===
      (matchValue || "").toString().trim().toLowerCase()
  );
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
      resource: { values: [updatedValues] },
    });
    return { action: "updated", row: rowNumber };
  }
}

// -------------------- MULTER --------------------
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ==========================
// LIVE VISITOR TRACKING
// ==========================
const activeVisitors = {}; // { visitorId: timestamp }
const VISITOR_TIMEOUT = 60 * 1000; // 1 minute

app.post("/api/track-visitor", (req, res) => {
  const { visitorId, page, role, ignoreCount } = req.body;
  if (!visitorId) return res.status(400).json({ success: false });

  const now = Date.now();
  if (!ignoreCount && role !== "admin" && page !== "admin-dashboard") {
    activeVisitors[visitorId] = now;
  }

  for (const id in activeVisitors) {
    if (now - activeVisitors[id] > VISITOR_TIMEOUT) delete activeVisitors[id];
  }

  res.json({ success: true, activeCount: Object.keys(activeVisitors).length });
});

// ==================== USERS & AUTH ====================
async function getUsers() {
  if (!process.env.USERS_SHEET_ID) return [];
  const rows = await getSheetValues(process.env.USERS_SHEET_ID, "A:D");
  return rows.map((r) => ({
    joinDate: r[0],
    name: r[1],
    email: r[2],
    password: r[3],
  }));
}

app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
  const users = await getUsers();
  const emailLower = email.trim().toLowerCase();
  if (users.some((u) => u.email.toLowerCase() === emailLower)) return res.status(409).json({ error: "Email exists" });
  const hashedPassword = await bcrypt.hash(password, 10);
  const timestamp = new Date().toISOString();
  await appendSheetValues(process.env.USERS_SHEET_ID, "A:D", [[timestamp, name, emailLower, hashedPassword]]);
  req.session.user = { name, email: emailLower, joinDate: timestamp };
  res.json({ ok: true, loggedIn: true, user: req.session.user });
});

app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing fields" });
  const users = await getUsers();
  const user = users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const match = await bcrypt.compare(password, user.password || "");
  if (!match) return res.status(401).json({ error: "Invalid credentials" });
  req.session.user = { name: user.name, email: user.email, joinDate: user.joinDate };
  res.json({ ok: true, loggedIn: true, user: req.session.user });
});

app.get("/api/check-session", (req, res) => {
  if (req.session.user) return res.json({ loggedIn: true, user: req.session.user });
  res.json({ loggedIn: false, user: null });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => err ? res.status(500).json({ error: "Logout failed" }) : res.json({ ok: true }));
});

// ==================== PASSWORD RESET ====================
app.post("/api/request-reset", async (req, res) => {
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
});

app.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: "Missing fields" });
  const rows = await getSheetValues(process.env.USERS_SHEET_ID, "E:G");
  const row = rows.find((r) => r[1] === token && r[2] && parseInt(r[2], 10) > Date.now());
  if (!row) return res.status(400).json({ error: "Invalid or expired token" });
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  const email = row[0];
  await findRowAndUpdateOrAppend(process.env.USERS_SHEET_ID, "A:D", 2, email, [row[0], row[1], row[2], hashedPassword]);
  res.json({ ok: true, message: "Password reset successful" });
});

// ==================== WAITLIST / VOLUNTEERS / STREET TEAM ====================
app.post("/api/waitlist", async (req, res) => {
  const { name, email, reason } = req.body;
  if (!name || !email) return res.status(400).json({ success: false });
  const timestamp = new Date().toLocaleString();
  await appendSheetValues(process.env.WAITLIST_SHEET_ID, "Waitlist!A:D", [[timestamp, name, email.toLowerCase(), reason || ""]]);
  await sendMailjetEmail("New Waitlist Submission", `<p>${name} (${email}) joined waitlist at ${timestamp}</p>`);
  res.json({ success: true });
});

app.post("/api/volunteer", async (req, res) => {
  const { name, email, role, availability } = req.body;
  if (!name || !email || !role) return res.status(400).json({ success: false });
  const timestamp = new Date().toLocaleString();
  await appendSheetValues(process.env.VOLUNTEERS_SHEET_ID, "Volunteers!A:E", [[timestamp, name, email.toLowerCase(), role, availability || ""]]);
  await sendMailjetEmail("New Volunteer Submission", `<p>${name} (${email}) signed up as volunteer at ${timestamp}</p>`);
  res.json({ success: true });
});

app.post("/api/street-team", async (req, res) => {
  const { name, email, city, hoursAvailable } = req.body;
  if (!name || !email || !city) return res.status(400).json({ success: false });
  const timestamp = new Date().toLocaleString();
  await appendSheetValues(process.env.STREETTEAM_SHEET_ID, "StreetTeam!A:E", [[timestamp, name, email.toLowerCase(), city, hoursAvailable || ""]]);
  await sendMailjetEmail("New Street Team Submission", `<p>${name} (${email}) joined street team in ${city} at ${timestamp}</p>`);
  res.json({ success: true });
});

// ==================== CAMPAIGNS ====================
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ success: false });
  const { title, goal, description, category } = req.body;
  if (!title || !goal || !description || !category) return res.status(400).json({ success: false });

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
  const campaignId = Date.now().toString();
  const newCampaignRow = [campaignId, title, user.email.toLowerCase(), goal, description, category, status, createdAt, imageUrl];
  await appendSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I", [newCampaignRow]);

  await sendMailjetEmail("New Campaign Submitted", `<p>${user.name} (${user.email}) submitted a campaign titled "${title}"</p>`);
  res.json({ success: true, message: "Campaign submitted", campaignId });
});

app.get("/api/my-campaigns", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ campaigns: [] });
  const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I");
  const campaigns = rows.filter(r => (r[2]||"").toLowerCase() === user.email.toLowerCase()).map(r => ({
    campaignId: r[0], title: r[1], creator: r[2], goal: r[3], description: r[4], category: r[5], status: r[6], createdAt: r[7], imageUrl: r[8]||"https://placehold.co/400x200?text=No+Image"
  }));
  res.json({ success: true, campaigns });
});

app.get("/api/public-campaigns", async (req,res)=>{
  const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID,"A:I");
  const campaigns = rows.filter(r=>["Approved","active"].includes(r[6])).map(r=>({
    campaignId:r[0], title:r[1], creator:r[2], goal:r[3], description:r[4], category:r[5], status:r[6], createdAt:r[7], imageUrl:r[8]||"https://placehold.co/400x200?text=No+Image"
  }));
  res.json({success:true,campaigns});
});

// ==================== ADMIN DASHBOARD ====================
function requireAdmin(req,res,next){ if(req.session.admin) return next(); res.status(403).json({success:false}); }

app.post("/api/admin-login",(req,res)=>{
  const {username,password}=req.body;
  if(username===ADMIN_USERNAME && password===ADMIN_PASSWORD){ req.session.admin=true; return res.json({success:true}); }
  res.status(401).json({success:false,message:"Invalid credentials"});
});

app.get("/api/admin-check",(req,res)=>{ res.json({admin:!!req.session.admin}); });

app.post("/api/admin-logout",(req,res)=>{ req.session.destroy(err=>err?res.status(500).json({success:false}):res.json({success:true})); });

// Admin: users
app.get("/api/admin/users", requireAdmin, async (req,res)=>{
  const rows = await getSheetValues(process.env.USERS_SHEET_ID,"A:D");
  res.json({ users: rows });
});

// Admin: campaigns
app.get("/api/admin/campaigns", requireAdmin, async (req,res)=>{
  const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID,"A:I");
  res.json({ campaigns: rows });
});

// Admin: waitlist
app.get("/api/admin/waitlist", requireAdmin, async (req,res)=>{
  const rows = await getSheetValues(process.env.WAITLIST_SHEET_ID,"Waitlist!A:D");
  res.json({ waitlist: rows });
});

// Admin: volunteers
app.get("/api/admin/volunteers", requireAdmin, async (req,res)=>{
  const rows = await getSheetValues(process.env.VOLUNTEERS_SHEET_ID,"Volunteers!A:E");
  res.json({ volunteers: rows });
});

// Admin: street team
app.get("/api/admin/streetteam", requireAdmin, async (req,res)=>{
  const rows = await getSheetValues(process.env.STREETTEAM_SHEET_ID,"StreetTeam!A:E");
  res.json({ streetTeam: rows });
});

// Admin: live visitors
app.get("/api/admin/live-visitors", requireAdmin, (req,res)=>{
  const now = Date.now();
  for(const id in activeVisitors) if(now - activeVisitors[id] > VISITOR_TIMEOUT) delete activeVisitors[id];
  res.json({ activeCount: Object.keys(activeVisitors).length });
});

// ==================== START SERVER ====================
app.listen(PORT,()=>{console.log(`JoyFund backend running on port ${PORT}`);});
