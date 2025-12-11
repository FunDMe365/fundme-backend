// ==================== SERVER.JS - COMPLETE JOYFUND BACKEND ====================
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const crypto = require("crypto");
const Stripe = require("stripe");
const { google } = require("googleapis");
const cloudinary = require("cloudinary").v2;
require("dotenv").config();
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "FunDMe$123";

const app = express();
const PORT = process.env.PORT || 5000;

// -------------------- CORS --------------------
const cors = require("cors");
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(o => o.trim())
  .filter(o => o.length > 0);

const corsOptions = {
  origin: function(origin, callback) {
    if (!origin) return callback(null, true); // allow non-browser requests (mobile, curl)
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("CORS not allowed: " + origin));
  },
  credentials: true
};
app.use(cors(corsOptions));

// -------------------- BODY PARSER --------------------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// -------------------- SESSION --------------------
app.set('trust proxy', 1); // required if behind a proxy (like Render)
app.use(session({
  name: 'sessionId',
  secret: process.env.SESSION_SECRET || 'supersecretkey',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production", // false for local dev
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  }
}));

// -------------------- STRIPE --------------------
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = Stripe(process.env.STRIPE_SECRET_KEY);
} else {
  console.warn("Warning: STRIPE_SECRET_KEY not set. Stripe routes will fail until provided.");
}

// ==================== STRIPE CHECKOUT SESSION ====================
app.post("/api/create-checkout-session/:campaignId?", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ success: false, message: "Stripe not configured" });

    const campaignId = req.params.campaignId || req.body.campaignId;
    const { amount, successUrl, cancelUrl } = req.body;
    if (!campaignId || !amount || !successUrl || !cancelUrl) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    const amountInCents = Math.round(Number(amount) * 100);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `Donation to campaign ${campaignId}` },
          unit_amount: amountInCents,
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

// -------------------- MAILJET --------------------
const Mailjet = require("node-mailjet");

// Initialize mailjet client once
const mailjetClient = process.env.MAILJET_API_KEY && process.env.MAILJET_API_SECRET
  ? Mailjet.connect(process.env.MAILJET_API_KEY, process.env.MAILJET_API_SECRET)
  : null;

/**
 * Send an email via Mailjet
 * @param {string} subject - Email subject
 * @param {string} htmlContent - HTML content of the email
 * @param {string} toEmail - Recipient email
 */
async function sendMailjetEmail(subject, htmlContent, toEmail) {
  if (!mailjetClient) {
    console.warn("Mailjet not configured; email would be sent with subject:", subject, "to:", toEmail);
    return;
  }

  try {
    await mailjetClient.post("send", { version: "v3.1" }).request({
      Messages: [{
        From: { 
          Email: process.env.MAILJET_SENDER_EMAIL || process.env.EMAIL_FROM || "admin@joyfund.net",
          Name: "JoyFund INC"
        },
        To: [{ Email: toEmail || process.env.NOTIFY_EMAIL }],
        Subject: subject,
        HTMLPart: htmlContent
      }]
    });
  } catch (err) {
    console.error("Mailjet error:", err);
  }
}

// Optional test route to verify email sending
app.post("/api/send-test-email", async (req, res) => {
  const { to, subject, html } = req.body;
  try {
    await sendMailjetEmail(subject || "Test Email", html || "<p>This is a test.</p>", to);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to send email" });
  }
});

// -------------------- GOOGLE SHEETS --------------------
let sheets = null;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    sheets = google.sheets({ version: "v4", auth });
  } else {
    console.warn("GOOGLE_CREDENTIALS_JSON not present - Sheets disabled.");
  }
} catch (err) { console.error("Google Sheets init failed", err && err.message); }

async function getSheetValues(spreadsheetId, range) {
  try {
    if (!sheets || !spreadsheetId) return [];
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return res.data.values || [];
  } catch (err) {
    console.error("getSheetValues error:", err && err.message);
    return [];
  }
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

// -------------------- MULTER --------------------
const storage = multer.memoryStorage();
const upload = multer({ storage });

// -------------------- CLOUDINARY --------------------
if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
} else {
  console.warn("Cloudinary not fully configured. Image uploads will fail without CLOUDINARY env vars.");
}

function safeImageUrl(url) {
  if (!url || url.toString().trim() === "") return "https://placehold.co/400x200?text=No+Image";
  return url;
}

// ==================== LIVE VISITOR TRACKING ====================
const liveVisitors = {};
app.post("/api/track-visitor", (req, res) => {
  try {
    const { visitorId } = req.body;
    if (!visitorId) return res.status(400).json({ success: false, message: "Missing visitorId" });
    const now = Date.now();
    liveVisitors[visitorId] = now;
    for (const id in liveVisitors) {
      if (now - liveVisitors[id] > 30000) delete liveVisitors[id];
    }
    res.json({ success: true, activeCount: Object.keys(liveVisitors).length });
  } catch (err) {
    console.error("Visitor tracking error:", err);
    res.status(500).json({ success: false });
  }
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
  } catch (err) { console.error(err); res.status(500).json({ error: "Signup failed" }); }
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
  } catch (err) { console.error(err); res.status(500).json({ error: "Signin failed" }); }
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
    await sendMailjetEmail("Password Reset", `<p>Click <a href="${process.env.FRONTEND_URL}/reset-password?token=${token}">here</a> to reset your password. Expires in 1 hour.</p>`, email);
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
    await appendSheetValues(process.env.USERS_SHEET_ID, "A:D", [[new Date().toISOString(), email, email, hashedPassword]]);
    res.json({ ok: true, message: "Password reset successful" });
  } catch (err) { console.error(err); res.status(500).json({ error: "Failed to reset password" }); }
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
  } catch (err) { console.error(err); res.status(500).json({ success: false }); }
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

// ==================== ADMIN ROUTES ====================
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(403).json({ success: false, message: "Forbidden" });
}
app.post("/api/admin-login", (req,res)=>{
  const {username,password}=req.body;
  if(username===ADMIN_USERNAME && password===ADMIN_PASSWORD){
    req.session.admin=true;
    return res.json({success:true});
  }
  res.status(401).json({success:false,message:"Invalid credentials"});
});
app.get("/api/admin-check", (req,res)=>{ res.json({admin:!!(req.session && req.session.admin)}); });
app.post("/api/admin-logout", (req,res)=>{ req.session.destroy(err=>err?res.status(500).json({success:false}):res.json({success:true})); });

// ==================== CAMPAIGNS ROUTES ====================
// -- Create Campaign
app.post("/api/create-campaign", upload.single("image"), async (req,res)=>{
  try{
    const user = req.session.user;
    if(!user) return res.status(401).json({success:false,message:"Not signed in"});
    const { title, goal, description, category } = req.body;
    if(!title || !goal || !description || !category) return res.status(400).json({success:false,message:"Missing fields"});
    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    if(!spreadsheetId) return res.status(500).json({success:false,message:"CAMPAIGNS_SHEET_ID not configured"});
    const campaignId = Date.now().toString();
    let imageUrl = safeImageUrl("");
    if(req.file && process.env.CLOUDINARY_API_KEY){
      const uploadResult = await new Promise((resolve,reject)=>{
        const stream = cloudinary.uploader.upload_stream({ folder:"joyfund/campaigns" }, (err,result)=> err?reject(err):resolve(result));
        stream.end(req.file.buffer);
      });
      if(uploadResult && uploadResult.secure_url) imageUrl = uploadResult.secure_url;
    }
    const createdAt = new Date().toISOString();
    const status = "Pending";
    const newCampaignRow = [campaignId, title, user.email.toLowerCase(), goal, description, category, status, createdAt, imageUrl];
    await appendSheetValues(spreadsheetId,"A:I",[newCampaignRow]);
    await sendMailjetEmail("New Campaign Submitted", `<p>${user.name} (${user.email}) submitted a campaign titled "${title}"</p>`);
    res.json({success:true,message:"Campaign submitted",campaignId});
  }catch(err){console.error(err);res.status(500).json({success:false,message:"Failed to create campaign"});}
});

// -- Public campaigns (Approved only)
app.get("/api/public-campaigns", async(req,res)=>{
  try{
    if(!process.env.CAMPAIGNS_SHEET_ID) return res.status(500).json([]);
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID,"A:I");
    const headers = ["Id","Title","Email","Goal","Description","Category","Status","CreatedAt","ImageURL"];
    const campaigns = rows.map(r=>{
      let obj={};
      headers.forEach((h,i)=>obj[h]=r[i]||"");
      return obj;
    }).filter(c=>c.Status==="Approved");
    res.json(campaigns);
  }catch(err){console.error(err);res.status(500).json([]);}
});

// -- User campaigns (any status)
app.get("/api/my-campaigns", async(req,res)=>{
  try{
    const user = req.session.user;
    if(!user) return res.status(401).json([]);
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID,"A:I");
    const headers = ["Id","Title","Email","Goal","Description","Category","Status","CreatedAt","ImageURL"];
    const campaigns = rows.map(r=>{
      let obj={};
      headers.forEach((h,i)=>obj[h]=r[i]||"");
      return obj;
    }).filter(c=>c.Email && c.Email.toLowerCase()===user.email.toLowerCase());
    res.json(campaigns);
  }catch(err){console.error(err);res.status(500).json([]);}
});

// ==================== ID VERIFICATION ====================
app.get("/api/id-verifications", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).json([]);
    if (!process.env.IDS_SHEET_ID) return res.status(500).json([]);

    const rows = await getSheetValues(process.env.IDS_SHEET_ID, "A:E");

    const headers = ["TimeStamp", "Email", "Name", "Status", "IDPhotoURL"];

    // Map rows to objects
    const verifications = rows.map(r => {
      let obj = {};
      headers.forEach((h, i) => {
        obj[h] = (r[i] || "").toString().trim();
      });
      return obj;
    });

    // Find the latest row for this user (assuming email is unique)
    const userVerification = verifications
      .filter(v => v.Email.toLowerCase() === user.email.toLowerCase())
      .sort((a, b) => new Date(b.TimeStamp) - new Date(a.TimeStamp))[0];

    if (!userVerification) {
      return res.json([{ Status: "Pending", IDPhotoURL: "" }]);
    }

    // Normalize status
    const statusNormalized =
      userVerification.Status.toLowerCase() === "verified" ? "Verified" : "Pending";

    res.json([{
      TimeStamp: userVerification.TimeStamp,
      Email: userVerification.Email,
      Name: userVerification.Name,
      Status: statusNormalized,
      IDPhotoURL: userVerification.IDPhotoURL
    }]);

  } catch (err) {
    console.error("ID Verification error:", err);
    res.status(500).json([{ Status: "Pending", IDPhotoURL: "" }]);
  }
});

// ==================== START SERVER ====================
app.listen(PORT, ()=>console.log(`JoyFund backend running on port ${PORT}`));
