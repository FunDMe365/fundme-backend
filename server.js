// ==================== SERVER.JS - COMPLETE JOYFUND BACKEND (FULL WORKING) ====================
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const crypto = require("crypto");
const Stripe = require("stripe");
const { google } = require("googleapis");
const cloudinary = require("cloudinary").v2;
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ==================== ENV VARIABLES ====================
const SPREADSHEET_ID = process.env.CAMPAIGNS_SHEET_ID;
const SHEET_ID = process.env.IDS_SHEET_ID;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "FunDMe$123";
const PORT = process.env.PORT || 5000;

if (!SHEET_ID) console.warn("IDS_SHEET_ID env variable is not set!");

// ==================== APP ====================
const app = express();

// ==================== USERS JSON ====================
const usersFile = path.join(__dirname, "users.json");
let users = [];
try {
  if (fs.existsSync(usersFile)) {
    users = JSON.parse(fs.readFileSync(usersFile, "utf-8"));
  }
} catch (err) {
  console.error("Failed to load users.json:", err);
}

// ==================== CORS ====================
const cors = require("cors");
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(o => o.trim())
  .filter(o => o.length > 0);
if (!allowedOrigins.includes("https://fundasmile.net")) {
  console.warn("ALLOWED_ORIGINS does not include https://fundasmile.net — add it if needed.");
}
const corsOptions = {
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("CORS not allowed: " + origin));
  },
  credentials: true
};
app.use(cors(corsOptions));

// ==================== BODY PARSER ====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ==================== SESSION ====================
app.set('trust proxy', 1);
app.use(session({
  name: 'sessionId',
  secret: process.env.SESSION_SECRET || 'supersecretkey',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24
  }
}));

// ==================== STRIPE ====================
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = Stripe(process.env.STRIPE_SECRET_KEY);
} else {
  console.warn("STRIPE_SECRET_KEY not set. Stripe routes will fail.");
}

app.post("/api/create-checkout-session/:campaignId?", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ success: false, message: "Stripe not configured" });
    const campaignId = req.params.campaignId || req.body.campaignId;
    const { amount, successUrl, cancelUrl } = req.body;
    if (!campaignId || !amount || !successUrl || !cancelUrl) return res.status(400).json({ success: false, message: "Missing fields" });

    const amountInCents = Math.round(Number(amount) * 100);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `Donation to campaign ${campaignId}` },
          unit_amount: amountInCents
        },
        quantity: 1
      }],
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { campaignId }
    });
    res.json({ success: true, sessionId: session.id, campaignId });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ success: false, message: "Failed to create checkout session" });
  }
});

// ==================== MAILJET ====================
const Mailjet = require("node-mailjet");
const mailjetClient = process.env.MAILJET_API_KEY && process.env.MAILJET_API_SECRET
  ? Mailjet.connect(process.env.MAILJET_API_KEY, process.env.MAILJET_API_SECRET)
  : null;

async function sendMailjetEmail(subject, htmlContent, toEmail) {
  if (!mailjetClient) {
    console.warn("Mailjet not configured; email would be sent:", subject, toEmail);
    return;
  }
  try {
    await mailjetClient.post("send", { version: "v3.1" }).request({
      Messages: [{
        From: { Email: process.env.MAILJET_SENDER_EMAIL || "admin@joyfund.net", Name: "JoyFund INC" },
        To: [{ Email: toEmail || process.env.NOTIFY_EMAIL }],
        Subject: subject,
        HTMLPart: htmlContent
      }]
    });
  } catch (err) { console.error("Mailjet error:", err); }
}

app.post("/api/send-test-email", async (req, res) => {
  const { to, subject, html } = req.body;
  try {
    await sendMailjetEmail(subject || "Test Email", html || "<p>This is a test.</p>", to);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to send email" });
  }
});

// ==================== GOOGLE SHEETS ====================
let sheets = null;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    sheets = google.sheets({ version: "v4", auth });
  } else { console.warn("GOOGLE_CREDENTIALS_JSON not present - Sheets disabled."); }
} catch (err) { console.error("Google Sheets init failed", err); }

async function getSheetValues(spreadsheetId, range) {
  try {
    if (!sheets || !spreadsheetId) return [];
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return res.data.values || [];
  } catch (err) {
    console.error("getSheetValues error:", err);
    return [];
  }
}

async function appendSheetValues(spreadsheetId, range, values) {
  if (!sheets || !spreadsheetId) throw new Error("Sheets not initialized or missing spreadsheetId");
  await sheets.spreadsheets.values.append({
    spreadsheetId, range, valueInputOption: "USER_ENTERED", resource: { values }
  });
}

// ==================== MULTER ====================
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ==================== CLOUDINARY ====================
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
} else {
  console.warn("Cloudinary not configured. Image uploads will fail.");
}

function safeImageUrl(url) {
  if (!url || url.toString().trim() === "") return "https://placehold.co/400x200?text=No+Image";
  return url;
}

// ==================== LIVE VISITOR TRACKING ====================
const liveVisitors = {};
app.post("/api/track-visitor", (req, res) => {
  const { visitorId } = req.body;
  if (!visitorId) return res.status(400).json({ success: false, message: "Missing visitorId" });
  const now = Date.now();
  liveVisitors[visitorId] = now;
  for (const id in liveVisitors) if (now - liveVisitors[id] > 30000) delete liveVisitors[id];
  res.json({ success: true, activeCount: Object.keys(liveVisitors).length });
});

// ==================== USERS & AUTH ====================
async function getUsers() {
  if (!process.env.USERS_SHEET_ID) return [];
  const rows = await getSheetValues(process.env.USERS_SHEET_ID, "A:D");
  return rows.map(r => ({ joinDate: r[0], name: r[1], email: r[2], password: r[3] }));
}

app.post("/api/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
    const users = await getUsers();
    const emailLower = email.trim().toLowerCase();
    if (users.some(u => (u.email || "").toLowerCase() === emailLower)) return res.status(409).json({ error: "Email already exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const timestamp = new Date().toISOString();
    await appendSheetValues(process.env.USERS_SHEET_ID, "A:D", [[timestamp, name, emailLower, hashedPassword]]);
    req.session.user = { name, email: emailLower, joinDate: timestamp };
    res.json({ ok: true, loggedIn: true, user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/api/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });
    const users = await getUsers();
    const inputEmail = email.trim().toLowerCase();
    const user = users.find(u => (u.email || "").toLowerCase() === inputEmail);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const match = await bcrypt.compare(password, user.password || "");
    if (!match) return res.status(401).json({ error: "Invalid credentials" });
    req.session.user = { name: user.name, email: user.email, joinDate: user.joinDate };
    res.json({ ok: true, loggedIn: true, user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Signin failed" });
  }
});

app.get("/api/check-session", (req, res) => {
  if (req.session.user) {
    const u = req.session.user;
    return res.json({ loggedIn: true, user: u, name: u.name || null, email: u.email || null, joinDate: u.joinDate || null });
  } else {
    return res.json({ loggedIn: false, user: null });
  }
});

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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to request reset" });
  }
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
    await appendSheetValues(process.env.USERS_SHEET_ID, "A:D", [[new Date().toISOString(), email, email, hashedPassword]]);
    res.json({ ok: true, message: "Password reset successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

// ==================== WAITLIST / VOLUNTEERS / STREET TEAM ====================
app.post("/api/waitlist", async (req, res) => {
  try {
    const { name, email, reason } = req.body;
    if (!name || !email) return res.status(400).json({ success: false });
    const timestamp = new Date().toLocaleString();
    await appendSheetValues(process.env.WAITLIST_SHEET_ID, "Waitlist!A:D", [[timestamp, name, email.toLowerCase(), reason || ""]]);
    await sendMailjetEmail("New Waitlist Submission", `<p>${name} (${email}) joined the waitlist at ${timestamp}. Reason: ${reason || "N/A"}</p>`);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.post("/api/volunteer", async (req, res) => {
  try {
    const { name, email, role, availability } = req.body;
    if (!name || !email || !role) return res.status(400).json({ success: false });
    const timestamp = new Date().toLocaleString();
    await appendSheetValues(process.env.VOLUNTEERS_SHEET_ID, "Volunteers!A:E", [[timestamp, name, email.toLowerCase(), role, availability || ""]]);
    await sendMailjetEmail("New Volunteer Submission", `<p>${name} (${email}) signed up as volunteer for ${role} at ${timestamp}. Availability: ${availability || "N/A"}</p>`);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.post("/api/street-team", async (req, res) => {
  try {
    const { name, email, city, hoursAvailable } = req.body;
    if (!name || !email || !city) return res.status(400).json({ success: false });
    const timestamp = new Date().toLocaleString();
    await appendSheetValues(process.env.STREETTEAM_SHEET_ID, "StreetTeam!A:E", [[timestamp, name, email.toLowerCase(), city, hoursAvailable || ""]]);
    await sendMailjetEmail("New Street Team Submission", `<p>${name} (${email}) joined street team in ${city} at ${timestamp}. Hours: ${hoursAvailable || "N/A"}</p>`);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ==================== ADMIN ROUTES ====================
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(403).json({ success: false, message: "Forbidden" });
}

app.post("/api/admin-login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, message: "Invalid credentials" });
});

app.get("/api/admin-check", (req, res) => {
  res.json({ admin: !!(req.session && req.session.admin) });
});

app.post("/api/admin-logout", (req, res) => {
  req.session.destroy(err => err ? res.status(500).json({ success: false }) : res.json({ success: true }));
});

// ==================== CAMPAIGNS ROUTES ====================
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  try {
    const { title, goal, description, category, email } = req.body;
    if (!title || !goal || !description || !category || !email) return res.status(400).json({ success: false, message: "Missing required fields" });
    if (!req.file) return res.status(400).json({ success: false, message: "No image uploaded" });

    // Cloudinary upload
    const cloudRes = await cloudinary.uploader.upload(req.file.path, { folder: "joyfund/campaigns", use_filename: true, unique_filename: true });
    fs.unlink(req.file.path, err => { if (err) console.warn("Failed to delete local file:", err); });
    const imageURL = cloudRes.secure_url;

    // Append to Google Sheet
    const now = new Date().toISOString();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Campaigns!A:I",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [[Date.now(), title, email, goal, description, category, "pending", now, imageURL]] }
    });

    res.json({ success: true, message: "Campaign created", imageURL });
  } catch (err) {
    console.error("Create campaign failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/public-campaigns", async(req,res)=>{
  try{
    const rows = await getSheetValues(SPREADSHEET_ID,"Campaigns!A:I");
    const campaigns = rows.map(r=>({id:r[0],title:r[1],email:r[2],goal:r[3],description:r[4],category:r[5],status:r[6],date:r[7],imageURL:safeImageUrl(r[8])}));
    res.json({success:true,campaigns});
  }catch(err){console.error(err);res.status(500).json({success:false});}
});

app.get("/api/my-campaigns", async(req,res)=>{
  try{
    const email = req.query.email?.toLowerCase();
    if(!email)return res.status(400).json({success:false,message:"Missing email"});
    const rows = await getSheetValues(SPREADSHEET_ID,"Campaigns!A:I");
    const campaigns = rows.filter(r=>(r[2]||"").toLowerCase()===email).map(r=>({id:r[0],title:r[1],email:r[2],goal:r[3],description:r[4],category:r[5],status:r[6],date:r[7],imageURL:safeImageUrl(r[8])}));
    res.json({success:true,campaigns});
  }catch(err){console.error(err);res.status(500).json({success:false});}
});

// ==================== ID VERIFICATIONS ====================
app.post("/api/verify-id", upload.single("idFile"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });
    const cloudRes = await cloudinary.uploader.upload(req.file.path, { folder: "joyfund/id-verifications", use_filename: true, unique_filename: true });
    fs.unlink(req.file.path, err => { if(err) console.warn(err); });
    const now = new Date().toISOString();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Verifications!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[now, req.body.name || "", req.body.email || "", cloudRes.secure_url]] }
    });
    res.json({ success: true, url: cloudRes.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/id-verifications", async (req, res) => {
  try {
    const rows = await getSheetValues(SHEET_ID,"Verifications!A:D");
    const data = rows.map(r=>({date:r[0],name:r[1],email:r[2],url:r[3]}));
    res.json({success:true,data});
  } catch(err){console.error(err);res.status(500).json({success:false});}
});

// ==================== UPDATE PROFILE ====================
app.post("/api/update-profile", async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
    req.session.user.name = name || req.session.user.name;
    req.session.user.email = email || req.session.user.email;
    res.json({ success: true, user: req.session.user });
  } catch(err){console.error(err);res.status(500).json({success:false});}
});

// ==================== DONATIONS ====================
app.get("/api/donations", async (req, res) => {
  try{
    const rows = await getSheetValues(SPREADSHEET_ID,"Donations!A:G");
    const donations = rows.map(r=>({date:r[0],campaign:r[1],name:r[2],email:r[3],amount:r[4],method:r[5],status:r[6]}));
    res.json({success:true,donations});
  }catch(err){console.error(err);res.status(500).json({success:false});}
});

// ==================== START SERVER ====================
app.listen(PORT,()=>console.log(`JoyFund backend running on port ${PORT}`));
