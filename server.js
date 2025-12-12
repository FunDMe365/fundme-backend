// ==================== SERVER.JS - COMPLETE JOYFUND BACKEND (PATCHED) ====================
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
const SHEET_ID = process.env.IDS_SHEET_ID;
if (!SHEET_ID) console.warn("IDS_SHEET_ID env variable is not set!");
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "FunDMe$123";

const app = express();
const PORT = process.env.PORT || 5000;

const fs = require("fs");
const path = require("path");

// Load users from a JSON file (or use in-memory array if you prefer)
const usersFile = path.join(__dirname, "users.json");
let users = [];

// Load users at startup
try {
  if (fs.existsSync(usersFile)) {
    users = JSON.parse(fs.readFileSync(usersFile, "utf-8"));
  }
} catch (err) {
  console.error("Failed to load users.json:", err);
}

// -------------------- CORS --------------------
const cors = require("cors");
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(o => o.trim())
  .filter(o => o.length > 0);

if (!allowedOrigins.includes("https://fundasmile.net")) {
  console.warn("ALLOWED_ORIGINS does not include https://fundasmile.net — make sure to add it in your environment variables if your frontend is served there.");
}

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
// IMPORTANT: body parser must be registered BEFORE any routes that use req.body
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

// ===== VERIFY ID ROUTE =====
app.post("/api/verify-id", upload.single("idFile"), async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).json({ success: false, message: "You must be signed in." });
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

    let idPhotoUrl = "";
    if (process.env.CLOUDINARY_API_KEY) {
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "joyfund/id-verifications" },
          (err, result) => (err ? reject(err) : resolve(result))
        );
        stream.end(req.file.buffer);
      });
      if (uploadResult?.secure_url) idPhotoUrl = uploadResult.secure_url;
    }

    const newRow = [
      new Date().toLocaleString(), // TimeStamp
      user.email,                  // Email
      user.name || "",             // Name
      "Pending",                   // Status
      idPhotoUrl                   // ID Photo URL
    ];

    await appendSheetValues(SHEET_ID, "ID_Verifications!A:E", [newRow]);

    console.log("ID verification added:", newRow);

    res.json({ success: true, message: "ID submitted successfully", file: req.file.filename });
  } catch (err) {
    console.error("Error in verify-id route:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});
// ==================== ID VERIFICATION ====================
app.get("/api/id-verifications", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).json([]);
    if (!process.env.IDS_SHEET_ID) return res.status(500).json([]);

    // Read all relevant columns from the ID_Verifications tab
    const rows = await getSheetValues(process.env.IDS_SHEET_ID, "ID_Verifications!A:E");

    const headers = ["TimeStamp", "Email", "Name", "Status", "ID Photo URL"];

    // Map rows to objects and filter for current user
    const userRows = rows
      .map(r => {
        const obj = {};
        headers.forEach((h, i) => obj[h] = r[i] || "");

        // Normalize Status
        if (!["Verified","Pending","Denied"].includes(obj.Status)) obj.Status = "Pending";

        // Add frontend-friendly property
        obj.IDPhotoURL = obj["ID Photo URL"] || "";

        return obj;
      })
      .filter(v => v.Email && v.Email.toLowerCase() === user.email.toLowerCase());

    res.json(userRows);
  } catch (err) {
    console.error("ID verification error:", err);
    res.status(500).json([]);
  }
});

// ==================== UPDATE PROFILE (robust) ====================
app.post("/api/update-profile", (req, res) => {
  try {
    const { userId, name, email, phone } = req.body || {};

    if (!userId) {
      return res.status(400).json({ success: false, message: "User ID is required" });
    }

    // ensure users array loaded
    if (!Array.isArray(users)) users = [];

    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Update fields
    if (name) users[userIndex].name = name;
    if (email) users[userIndex].email = email;
    if (phone) users[userIndex].phone = phone;

    // Save back to JSON file
    try {
      fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
    } catch (err) {
      console.error("Failed to save users.json:", err);
      return res.status(500).json({ success: false, message: "Failed to save profile" });
    }

    res.json({ success: true, message: "Profile updated successfully", user: users[userIndex] });
  } catch (err) {
    console.error("Update profile route error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ==================== DONATIONS ROUTE (added) ====================
// Returns JSON array of donations.
// Priority: donations.json (local file) -> Google Sheets (if DONATIONS_SHEET_ID configured) -> []
app.get("/api/donations", async (req, res) => {
  try {
    const donationsFile = path.join(__dirname, "donations.json");
    if (fs.existsSync(donationsFile)) {
      const raw = fs.readFileSync(donationsFile, "utf8");
      const parsed = JSON.parse(raw || "[]");
      return res.json(parsed);
    }

    // Fallback to Google Sheets if configured
    if (process.env.DONATIONS_SHEET_ID && sheets) {
      const rows = await getSheetValues(process.env.DONATIONS_SHEET_ID, "A:Z");
      // Basic mapping: return rows as objects with the row arrays
      const donations = rows.map(r => ({ raw: r }));
      return res.json(donations);
    }

    // Default: empty array
    res.json([]);
  } catch (err) {
    console.error("Error loading donations:", err);
    res.status(500).json([]);
  }
});

// ==================== START SERVER ====================
app.listen(PORT, ()=>console.log(`JoyFund backend running on port ${PORT}`));
