// ==================== SERVER.JS JOYFUND BACKEND ====================
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcryptjs"); // use bcryptjs for better compatibility
const multer = require("multer");
const crypto = require("crypto");
const Stripe = require("stripe");
const { google } = require("googleapis");
const mailjetLib = require("node-mailjet");
const cloudinary = require("cloudinary").v2;
const { GoogleSpreadsheet } = require("google-spreadsheet");
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

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("CORS not allowed: " + origin));
  },
  credentials: true,
  optionsSuccessStatus: 200
}));
app.options("*", cors({ origin: allowedOrigins.length ? allowedOrigins : true, credentials: true }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) stripe = Stripe(process.env.STRIPE_SECRET_KEY);
else console.warn("Warning: STRIPE_SECRET_KEY not set. Stripe routes will fail.");

// -------------------- MAILJET --------------------
let mailjetClient = null;
if (process.env.MAILJET_API_KEY && process.env.MAILJET_API_SECRET) {
  mailjetClient = mailjetLib.apiConnect(process.env.MAILJET_API_KEY, process.env.MAILJET_API_SECRET);
}
async function sendMailjetEmail(subject, htmlContent, toEmail) {
  if (!mailjetClient) return console.warn("Mailjet not configured; email:", subject, toEmail);
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
  } else console.warn("GOOGLE_CREDENTIALS_JSON not present - Sheets disabled.");
} catch (err) { console.error("Google Sheets init failed", err && err.message); }

async function getSheetValues(spreadsheetId, range) {
  if (!sheets || !spreadsheetId) return [];
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return res.data.values || [];
  } catch (err) { console.error("getSheetValues error:", err); return []; }
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

async function updateSheetValues(spreadsheetId, range, values) {
  if (!sheets || !spreadsheetId) throw new Error("Sheets not initialized or missing spreadsheetId");
  await sheets.spreadsheets.values.update({
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
}

function safeImageUrl(url) {
  if (!url || url.toString().trim() === "") return "https://placehold.co/400x200?text=No+Image";
  return url;
}

// ==================== LIVE VISITOR TRACKING ====================
const liveVisitors = {};
app.post("/api/track-visitor", (req, res) => {
  const { visitorId } = req.body;
  if (!visitorId) return res.status(400).json({ success: false });
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
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
  const users = await getUsers();
  const emailLower = email.trim().toLowerCase();
  if (users.some(u => (u.email || "").toLowerCase() === emailLower)) return res.status(409).json({ error: "Email exists" });
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
  const user = users.find(u => (u.email || "").toLowerCase() === email.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const match = await bcrypt.compare(password, user.password || "");
  if (!match) return res.status(401).json({ error: "Invalid credentials" });
  req.session.user = { name: user.name, email: user.email, joinDate: user.joinDate };
  res.json({ ok: true, loggedIn: true, user: req.session.user });
});

app.get("/api/check-session", (req, res) => res.json({ loggedIn: !!req.session.user, user: req.session.user || null }));
app.post("/api/logout", (req, res) => req.session.destroy(err => err ? res.status(500).json({ error: "Logout failed" }) : res.json({ ok: true })));

// ==================== PASSWORD RESET ====================
app.post("/api/request-reset", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Missing email" });
  const token = crypto.randomBytes(20).toString("hex");
  const expiry = Date.now() + 3600000;
  await appendSheetValues(process.env.USERS_SHEET_ID, "E:G", [[email.toLowerCase(), token, expiry]]);
  await sendMailjetEmail("Password Reset", `<p>Click <a href="${process.env.FRONTEND_URL}/reset-password?token=${token}">here</a> to reset your password. Expires in 1 hour.</p>`, email);
  res.json({ ok: true, message: "Reset email sent" });
});

app.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: "Missing fields" });
  const rows = await getSheetValues(process.env.USERS_SHEET_ID, "E:G");
  const row = rows.find(r => r[1] === token && r[2] && parseInt(r[2], 10) > Date.now());
  if (!row) return res.status(400).json({ error: "Invalid/expired token" });
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  const email = row[0];
  await appendSheetValues(process.env.USERS_SHEET_ID, "A:D", [[new Date().toISOString(), email, email, hashedPassword]]);
  res.json({ ok: true, message: "Password reset successful" });
});

// ==================== WAITLIST / VOLUNTEERS / STREET TEAM ====================
app.post("/api/waitlist", async (req, res) => {
  const { name, email, reason } = req.body;
  if (!name || !email) return res.status(400).json({ success: false });
  const timestamp = new Date().toLocaleString();
  await appendSheetValues(process.env.WAITLIST_SHEET_ID, "Waitlist!A:D", [[timestamp, name, email.toLowerCase(), reason || ""]]);
  await sendMailjetEmail("New Waitlist Submission", `<p>${name} (${email}) joined the waitlist at ${timestamp}. Reason: ${reason || "N/A"}</p>`);
  res.json({ success: true });
});

app.post("/api/volunteer", async (req, res) => {
  const { name, email, role, availability } = req.body;
  if (!name || !email || !role) return res.status(400).json({ success: false });
  const timestamp = new Date().toLocaleString();
  await appendSheetValues(process.env.VOLUNTEERS_SHEET_ID, "Volunteers!A:E", [[timestamp, name, email.toLowerCase(), role, availability || ""]]);
  await sendMailjetEmail("New Volunteer Submission", `<p>${name} (${email}) signed up as volunteer for ${role} at ${timestamp}. Availability: ${availability || "N/A"}</p>`);
  res.json({ success: true });
});

app.post("/api/street-team", async (req, res) => {
  const { name, email, city, hoursAvailable } = req.body;
  if (!name || !email || !city) return res.status(400).json({ success: false });
  const timestamp = new Date().toLocaleString();
  await appendSheetValues(process.env.STREETTEAM_SHEET_ID, "StreetTeam!A:E", [[timestamp, name, email.toLowerCase(), city, hoursAvailable || ""]]);
  await sendMailjetEmail("New Street Team Submission", `<p>${name} (${email}) joined street team in ${city} at ${timestamp}. Hours: ${hoursAvailable || "N/A"}</p>`);
  res.json({ success: true });
});

// ==================== ADMIN ROUTES ====================
function requireAdmin(req,res,next){ if(req.session && req.session.admin) return next(); res.status(403).json({success:false}); }
app.post("/api/admin-login", (req,res)=>{
  const {username,password}=req.body;
  if(username===ADMIN_USERNAME && password===ADMIN_PASSWORD){ req.session.admin=true; return res.json({success:true}); }
  res.status(401).json({success:false,message:"Invalid credentials"});
});
app.get("/api/admin-check",(req,res)=>res.json({admin:!!(req.session && req.session.admin)}));
app.post("/api/admin-logout",(req,res)=>req.session.destroy(err=>err?res.status(500).json({success:false}):res.json({success:true})));

// ==================== CAMPAIGNS ROUTES ====================
app.post("/api/create-campaign", upload.single("image"), async (req,res)=>{
  try{
    const { title, description, goal } = req.body;
    if (!req.session.user) return res.status(401).json({success:false,message:"Login required"});
    if (!title || !description || !goal) return res.status(400).json({success:false,message:"Missing fields"});
    let imageUrl = safeImageUrl("");
    if(req.file && cloudinary.config().cloud_name){
      const result = await cloudinary.uploader.upload_stream({ folder: "campaigns" }, (err, resCloud) => { if(err) console.error(err); else imageUrl=resCloud.secure_url; });
    }
    const timestamp = new Date().toISOString();
    await appendSheetValues(process.env.CAMPAIGNS_SHEET_ID,"A:G",[[timestamp,title,description,goal,req.session.user.email,"Pending",imageUrl]]);
    res.json({success:true});
  }catch(err){console.error(err);res.status(500).json({success:false,message:"Campaign creation failed"});}
});

// -- Public campaigns
app.get("/api/public-campaigns", async(req,res)=>{
  try{
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID,"A:G");
    const campaigns = rows.filter(r=>r[5]==="Approved").map(r=>({timestamp:r[0],title:r[1],description:r[2],goal:r[3],creator:r[4],status:r[5],image:r[6]}));
    res.json(campaigns);
  }catch(err){console.error(err);res.status(500).json([]);}
});

// -- User campaigns
app.get("/api/my-campaigns", async(req,res)=>{
  if(!req.session.user) return res.status(401).json([]);
  try{
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID,"A:G");
    const campaigns = rows.filter(r=>r[4]===req.session.user.email).map(r=>({timestamp:r[0],title:r[1],description:r[2],goal:r[3],creator:r[4],status:r[5],image:r[6]}));
    res.json(campaigns);
  }catch(err){console.error(err);res.status(500).json([]);}
});

// ==================== DONATIONS ====================
app.get("/api/donations", async(req,res)=>{
  try{
    const rows = await getSheetValues(process.env.DONATIONS_SHEET_ID,"A:D");
    const donations = rows.map(r=>({timestamp:r[0],campaign:r[1],donor:r[2],amount:r[3]}));
    res.json(donations);
  }catch(err){console.error(err);res.status(500).json([]);}
});

// ==================== VERIFICATIONS ====================
app.get("/api/my-verifications", async(req,res)=>{
  try{
    const user=req.session.user;
    if(!user) return res.status(401).json([{Status:"Pending",Notes:"Not logged in",PhotoURL:null}]);
    const sheetId=process.env.ID_VERIFICATION_SHEET_ID;
    const clientEmail=process.env.GOOGLE_CLIENT_EMAIL;
    const privateKey=process.env.GOOGLE_PRIVATE_KEY;
    if(!sheetId || !clientEmail || !privateKey) return res.status(500).json([{Status:"Pending",Notes:"Verification sheet not configured",PhotoURL:null}]);
    const doc = new GoogleSpreadsheet(sheetId);
    await doc.useServiceAccountAuth({client_email:clientEmail,private_key:privateKey.replace(/\\n/g,"\n")});
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle["ID_Verifications"];
    if(!sheet) return res.status(500).json([{Status:"Pending",Notes:"Sheet not found",PhotoURL:null}]);
    const rows = await sheet.getRows();
    const row = rows.find(r=>r.Email.toLowerCase()===user.email.toLowerCase());
    if(!row) return res.json([{Status:"Pending",Notes:"No verification found",PhotoURL:null}]);
    res.json([{Status:row.Status||"Pending",Notes:row.Notes||"",PhotoURL:row.PhotoURL||null}]);
  }catch(err){console.error(err);res.status(500).json([{Status:"Pending",Notes:"Error fetching verifications",PhotoURL:null}]);}
});

// ==================== STRIPE CHECKOUT ====================
app.post("/api/create-checkout-session/:campaignId?", async(req,res)=>{
  try{
    if(!stripe) return res.status(500).json({success:false,message:"Stripe not configured"});
    const campaignId=req.params.campaignId||req.body.campaignId;
    const {amount,successUrl,cancelUrl}=req.body;
    if(!campaignId||!amount||!successUrl||!cancelUrl) return res.status(400).json({success:false,message:"Missing fields"});
    const amountInCents=Math.round(Number(amount)*100);
    const session = await stripe.checkout.sessions.create({
      payment_method_types:["card"],
      line_items:[{price_data:{currency:"usd",product_data:{name:`Donation to campaign ${campaignId}`},unit_amount:amountInCents},quantity:1}],
      mode:"payment",
      success_url:successUrl,
      cancel_url:cancelUrl
    });
    res.json({id:session.id});
  }catch(err){console.error(err);res.status(500).json({success:false,message:"Stripe checkout failed"});}
});

// ==================== START SERVER ====================
app.listen(PORT,()=>console.log(`JoyFund backend running on port ${PORT}`));
