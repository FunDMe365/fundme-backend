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
  .map(o => o.trim())
  .filter(o => o.length > 0);

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("CORS not allowed: " + origin));
  },
  credentials: true
}));

app.options("*", cors({ origin: allowedOrigins, credentials: true }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

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
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 24
  }
}));

// -------------------- STRIPE --------------------
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");

// ==================== STRIPE CHECKOUT SESSION ====================
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { amount, successUrl, cancelUrl } = req.body;
    if (!campaignId || !amount || !successUrl || !cancelUrl) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    // Convert amount to cents
    const amountInCents = Math.round(amount * 100);

    // Create Stripe Checkout session
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

    res.json({ success: true, sessionId: session.id });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ success: false, message: "Failed to create checkout session" });
  }
});


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

// ==================== VISITOR TRACKING ====================
async function logVisitor(page) {
  try {
    if (!process.env.VISITOR_SHEET_ID) return;
    const timestamp = new Date().toISOString();
    return await appendSheetValues(process.env.VISITOR_SHEET_ID, "A:D", [[timestamp, page || "/", "visitor", ""]]);
  } catch (err) { console.error("Visitor logging failed:", err.message); }
}

app.use(async (req, res, next) => {
  const page = req.path;
  if (!page.startsWith("/api") && !page.startsWith("/admin") && !page.startsWith("/public")) {
    try { await logVisitor(page); } catch (err) { console.error(err.message); }
  }
  next();
});

// ==================== USERS & AUTH ====================
async function getUsers() {
  if (!process.env.USERS_SHEET_ID) return [];
  const rows = await getSheetValues(process.env.USERS_SHEET_ID, "A:D");
  return rows.map(r => ({
    joinDate: r[0],
    name: r[1],
    email: r[2],
    password: r[3]
  }));
}

app.post("/api/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
    const users = await getUsers();
    const emailLower = email.trim().toLowerCase();
    if (users.some(u => u.email.toLowerCase() === emailLower)) return res.status(409).json({ error: "Email already exists" });
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
    const user = users.find(u => u.email.toLowerCase() === inputEmail);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const match = await bcrypt.compare(password, user.password || "");
    if (!match) return res.status(401).json({ error: "Invalid credentials" });
    req.session.user = { name: user.name, email: user.email, joinDate: user.joinDate };
    res.json({ ok: true, loggedIn: true, user: req.session.user });
  } catch (err) { console.error(err); res.status(500).json({ error: "Signin failed" }); }
});

// CHECK SESSION
app.get("/api/check-session", (req, res) => {
  if (req.session.user) {
    const u = req.session.user;
    return res.json({
      loggedIn: true,
      user: u,
      name: u.name || null,
      email: u.email || null,
      joinDate: u.joinDate || null
    });
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

// ==================== CAMPAIGNS ====================
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).json({ success: false });
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

app.get("/api/my-campaigns", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).json({ campaigns: [] });

    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I");
    const campaigns = rows.filter(r => (r[2]||"").toLowerCase() === user.email.toLowerCase())
      .map(r => ({
        campaignId: r[0],
        title: r[1],
        creator: r[2],
        goal: r[3],
        description: r[4],
        category: r[5],
        status: r[6],
        createdAt: r[7],
        imageUrl: r[8] || "https://placehold.co/400x200?text=No+Image"
      }));
    res.json({ success: true, campaigns });
  } catch(err){ console.error(err); res.status(500).json({ campaigns: [] }); }
});

app.get("/api/public-campaigns", async (req,res)=>{
  try {
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID,"A:I");
    const campaigns = rows.filter(r=>["Approved","active"].includes(r[6])).map(r=>({
      campaignId:r[0],title:r[1],creator:r[2],goal:r[3],description:r[4],category:r[5],status:r[6],createdAt:r[7],imageUrl:r[8]||"https://placehold.co/400x200?text=No+Image"
    }));
    res.json({success:true,campaigns});
  } catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// ==================== USER VERIFICATIONS ====================
app.get("/api/my-verifications", async (req, res) => {
  try {
    const userEmail = req.session?.user?.email?.toLowerCase();
    if (!userEmail) return res.status(401).json({ success: false, verifications: [] });
    const rows = await getSheetValues(process.env.ID_VERIFICATION_SHEET_ID, "ID_Verifications!A:E");
    const trimmedRows = rows.map(r => r.map(cell => (cell || "").toString().trim()));
    const verifications = trimmedRows
      .filter(r => (r[1] || "").toLowerCase() === userEmail)
      .map(r => ({ timestamp: r[0], email: r[1], status: r[3] || "Pending", idImageUrl: r[4] || "" }));
    res.json({ success: true, verifications });
  } catch (err) {
    console.error("Error fetching verifications:", err);
    res.status(500).json({ success: false, verifications: [] });
  }
});

// ==================== ADMIN ROUTES ====================
function requireAdmin(req, res, next) {
  if (req.session.admin) return next();
  res.status(403).json({ success: false });
}

// ------------------- ADMIN LOGIN -------------------
app.post("/admin-login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false });
});

// ------------------- ADMIN SESSION CHECK -------------------
app.get("/admin-check", (req, res) => {
  res.json({ admin: !!req.session.admin });
});

// ------------------- ADMIN LOGOUT -------------------
app.post("/admin-logout", (req, res) => {
  req.session.destroy(err =>
    err ? res.status(500).json({ success: false }) : res.json({ success: true })
  );
});


// ==================== DONATIONS / STRIPE CHECKOUT ====================
app.post("/api/create-checkout-session/:campaignId", async (req,res)=>{
  try{
    const {amount} = req.body;
    const {campaignId} = req.params;
    if(!amount||!campaignId) return res.status(400).json({error:"Missing fields"});
    const session = await stripe.checkout.sessions.create({
      payment_method_types:["card"],
      line_items:[{price_data:{currency:"usd",product_data:{name:"Donation for "+campaignId},unit_amount:Math.round(parseFloat(amount)*100)},quantity:1}],
      mode:"payment",
      success_url:`${process.env.FRONTEND_URL}/donation-success`,
      cancel_url:`${process.env.FRONTEND_URL}/donate/${campaignId}`
    });
    res.json({url:session.url});
  } catch(err){ console.error(err); res.status(500).json({error:"Stripe session failed"}); }
});

// ==================== START SERVER ====================
app.listen(PORT, () => { console.log(`JoyFund backend running on port ${PORT}`); });

// ========================================================================
