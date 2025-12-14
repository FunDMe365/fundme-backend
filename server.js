// ==================== SERVER.JS - COMPLETE JOYFUND BACKEND (MONGODB FULL) ====================
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const crypto = require("crypto");
const Stripe = require("stripe");
const { google } = require("googleapis");
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const Mailjet = require("node-mailjet");

// -------------------- MONGOOSE --------------------
const mongoURI = process.env.MONGO_URI || "mongodb+srv://fundasmile365:fundasmile365@joyfund365.gvihjsw.mongodb.net/joyfund?retryWrites=true&w=majority";
mongoose.connect(mongoURI)
  .then(() => console.log("✅ Connected to MongoDB successfully"))
  .catch(err => console.error("❌ MongoDB connection error:", err));

// -------------------- SCHEMAS --------------------
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  joinDate: String,
  resetToken: String,
  resetExpiry: Number
});

const campaignSchema = new mongoose.Schema({
  title: String,
  goal: Number,
  description: String,
  category: String,
  email: String,
  status: { type: String, default: "pending" },
  created: String,
  image: String
});

const donationSchema = new mongoose.Schema({
  name: String,
  email: String,
  amount: Number,
  campaignId: String,
  timestamp: String
});

const waitlistSchema = new mongoose.Schema({ name: String, email: String });
const volunteerSchema = new mongoose.Schema({ name: String, email: String, role: String, availability: String, timestamp: String });
const streetTeamSchema = new mongoose.Schema({ name: String, email: String, city: String, hoursAvailable: String, timestamp: String });
const idVerificationSchema = new mongoose.Schema({ name: String, email: String, imageURL: String, timestamp: String });

const User = mongoose.model("User", userSchema);
const Campaign = mongoose.model("Campaign", campaignSchema);
const Donation = mongoose.model("Donation", donationSchema);
const Waitlist = mongoose.model("Waitlist", waitlistSchema);
const Volunteer = mongoose.model("Volunteer", volunteerSchema);
const StreetTeam = mongoose.model("StreetTeam", streetTeamSchema);
const IDVerification = mongoose.model("IDVerification", idVerificationSchema);

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
  } catch (err) { console.error("getSheetValues error:", err && err.message); return []; }
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

// -------------------- STRIPE --------------------
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) stripe = Stripe(process.env.STRIPE_SECRET_KEY);
else console.warn("Warning: STRIPE_SECRET_KEY not set. Stripe routes will fail until provided.");

// -------------------- MAILJET --------------------
const mailjetClient = process.env.MAILJET_API_KEY && process.env.MAILJET_API_SECRET
  ? Mailjet.connect(process.env.MAILJET_API_KEY, process.env.MAILJET_API_SECRET)
  : null;

async function sendMailjetEmail(subject, htmlContent, toEmail) {
  if (!mailjetClient) { console.warn("Mailjet not configured; email would be sent with subject:", subject, "to:", toEmail); return; }
  try {
    await mailjetClient.post("send", { version: "v3.1" }).request({
      Messages: [{
        From: { Email: process.env.MAILJET_SENDER_EMAIL || process.env.EMAIL_FROM || "admin@joyfund.net", Name: "JoyFund INC" },
        To: [{ Email: toEmail || process.env.NOTIFY_EMAIL }],
        Subject: subject,
        HTMLPart: htmlContent
      }]
    });
  } catch (err) { console.error("Mailjet error:", err); }
}

// -------------------- EXPRESS --------------------
const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(o => o.trim())
  .filter(o => o.length > 0);

if (!allowedOrigins.includes("https://fundasmile.net")) {
  console.warn("ALLOWED_ORIGINS does not include https://fundasmile.net — add in env vars if needed.");
}

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("CORS not allowed: " + origin));
  },
  credentials: true
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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

const storage = multer.memoryStorage();
const upload = multer({ storage });

// -------------------- LIVE VISITOR TRACKING --------------------
const liveVisitors = {};
app.post("/api/track-visitor", (req, res) => {
  const { visitorId } = req.body;
  if (!visitorId) return res.status(400).json({ success: false, message: "Missing visitorId" });
  const now = Date.now();
  liveVisitors[visitorId] = now;
  for (const id in liveVisitors) if (now - liveVisitors[id] > 30000) delete liveVisitors[id];
  res.json({ success: true, activeCount: Object.keys(liveVisitors).length });
});

// -------------------- USERS & AUTH --------------------
app.post("/api/signup", async (req,res)=>{
  try{
    const { name, email, password } = req.body;
    if(!name || !email || !password) return res.status(400).json({ error:"Missing fields" });
    const emailLower = email.trim().toLowerCase();
    if(await User.findOne({ email: emailLower })) return res.status(409).json({ error:"Email already exists" });
    const hashedPassword = await bcrypt.hash(password,10);
    const timestamp = new Date().toISOString();
    const newUser = await User.create({ name, email: emailLower, password: hashedPassword, joinDate: timestamp });
    req.session.user = { name, email: emailLower, joinDate: timestamp };
    res.json({ ok:true, loggedIn:true, user:req.session.user });
  } catch(err){ console.error(err); res.status(500).json({ error:"Signup failed" }); }
});

app.post("/api/signin", async (req,res)=>{
  try{
    const { email, password } = req.body;
    if(!email || !password) return res.status(400).json({ error:"Missing fields" });
    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if(!user) return res.status(401).json({ error:"Invalid credentials" });
    const match = await bcrypt.compare(password, user.password || "");
    if(!match) return res.status(401).json({ error:"Invalid credentials" });
    req.session.user = { name:user.name, email:user.email, joinDate:user.joinDate };
    res.json({ ok:true, loggedIn:true, user:req.session.user });
  }catch(err){ console.error(err); res.status(500).json({ error:"Signin failed" }); }
});

app.get("/api/check-session",(req,res)=>res.json(req.session.user?{loggedIn:true,user:req.session.user}:{loggedIn:false,user:null}));
app.post("/api/logout",(req,res)=>req.session.destroy(err=>err?res.status(500).json({error:"Logout failed"}):res.json({ok:true})));

// -------------------- PASSWORD RESET --------------------
app.post("/api/request-reset", async (req,res)=>{
  try{
    const { email } = req.body;
    if(!email) return res.status(400).json({ error:"Missing email" });
    const token = crypto.randomBytes(20).toString("hex");
    const expiry = Date.now() + 3600000;
    const user = await User.findOne({ email: email.toLowerCase() });
    if(!user) return res.status(404).json({ error:"User not found" });
    user.resetToken = token;
    user.resetExpiry = expiry;
    await user.save();
    await sendMailjetEmail("Password Reset", `<p>Click <a href="${process.env.FRONTEND_URL}/reset-password?token=${token}">here</a> to reset your password. Expires in 1 hour.</p>`, email);
    res.json({ ok:true, message:"Reset email sent" });
  }catch(err){ console.error(err); res.status(500).json({ error:"Failed to request reset" }); }
});

app.post("/api/reset-password", async (req,res)=>{
  try{
    const { token, newPassword } = req.body;
    if(!token || !newPassword) return res.status(400).json({ error:"Missing fields" });
    const user = await User.findOne({ resetToken: token, resetExpiry: { $gt: Date.now() } });
    if(!user) return res.status(400).json({ error:"Invalid or expired token" });
    user.password = await bcrypt.hash(newPassword,10);
    user.resetToken = null;
    user.resetExpiry = null;
    await user.save();
    res.json({ ok:true, message:"Password reset successful" });
  }catch(err){ console.error(err); res.status(500).json({ error:"Failed to reset password" }); }
});

// -------------------- WAITLIST --------------------
app.post('/waitlist', async (req,res)=>{
  try{ const { name, email } = req.body; const entry = await Waitlist.create({ name, email }); res.status(200).json({ success:true, message:'Added to waitlist', entry }); }catch(err){ console.error(err); res.status(500).json({ success:false, message:'Error adding to waitlist' }); }
});

// -------------------- VOLUNTEERS / STREET TEAM --------------------
app.post("/api/volunteer", async (req,res)=>{
  try{
    const { name,email,role,availability } = req.body;
    if(!name || !email || !role) return res.status(400).json({ success:false });
    const timestamp = new Date().toLocaleString();
    await Volunteer.create({ name,email,role,availability:availability||"", timestamp });
    await sendMailjetEmail("New Volunteer Submission", `<p>${name} (${email}) signed up as volunteer for ${role} at ${timestamp}. Availability: ${availability||"N/A"}</p>`);
    res.json({ success:true });
  }catch(err){ console.error(err); res.status(500).json({ success:false }); }
});

app.post("/api/street-team", async (req,res)=>{
  try{
    const { name,email,city,hoursAvailable } = req.body;
    if(!name || !email || !city) return res.status(400).json({ success:false });
    const timestamp = new Date().toLocaleString();
    await StreetTeam.create({ name,email,city,hoursAvailable:hoursAvailable||"", timestamp });
    await sendMailjetEmail("New Street Team Submission", `<p>${name} (${email}) joined street team in ${city} at ${timestamp}. Hours: ${hoursAvailable||"N/A"}</p>`);
    res.json({ success:true });
  }catch(err){ console.error(err); res.status(500).json({ success:false }); }
});

// -------------------- ADMIN --------------------
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "FunDMe$123";
function requireAdmin(req,res,next){ if(req.session && req.session.admin) return next(); res.status(403).json({ success:false,message:"Forbidden" }); }

app.post("/api/admin-login",(req,res)=>{
  const { username,password } = req.body;
  if(username===ADMIN_USERNAME && password===ADMIN_PASSWORD){ req.session.admin=true; return res.json({ success:true }); }
  res.status(401).json({ success:false,message:"Invalid credentials" });
});

app.get("/api/admin-check",(req,res)=>res.json({ admin: !!(req.session && req.session.admin) }));
app.post("/api/admin-logout",(req,res)=>req.session.destroy(err=>err?res.status(500).json({success:false}):res.json({success:true})));

// -------------------- CAMPAIGNS --------------------
app.post("/api/create-campaign", upload.single("image"), async (req,res)=>{
  try{
    const { title, goal, description, category, email } = req.body;
    if(!title || !goal || !description || !category || !email) return res.status(400).json({ success:false,message:"Missing required fields" });
    if(!req.file) return res.status(400).json({ success:false,message:"No image uploaded" });

    const cloudRes = await new Promise((resolve,reject)=>{ const stream = cloudinary.uploader.upload_stream({ folder:"joyfund/campaigns", use_filename:true, unique_filename:true }, (err,result)=>err?reject(err):resolve(result)); stream.end(req.file.buffer); });
    const imageURL = cloudRes.secure_url;
    const now = new Date().toISOString();
    const campaign = await Campaign.create({ title, goal, description, category, email, created:now, image:imageURL });

    if(sheets && process.env.CAMPAIGNS_SHEET_ID){
      await appendSheetValues(process.env.CAMPAIGNS_SHEET_ID,"Campaigns!A:I",[[Date.now(),title,email,goal,description,category,"pending",now,imageURL]]);
    }

    res.json({ success:true,message:"Campaign created",imageURL });
  }catch(err){ console.error("Create campaign failed:",err); res.status(500).json({ success:false,message:err.message }); }
});

app.get("/api/campaigns", async (req,res)=>{
  try{
    const campaigns = await Campaign.find({});
    res.json(campaigns);
  }catch(err){ console.error(err); res.status(500).json({}); }
});

app.post("/api/delete-campaign/:id", requireAdmin, async (req,res)=>{
  try{ await Campaign.findByIdAndDelete(req.params.id); res.json({success:true}); }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// -------------------- DONATIONS --------------------
app.post("/api/donation", async (req,res)=>{
  try{
    const { name,email,amount,campaignId } = req.body;
    if(!name || !email || !amount) return res.status(400).json({success:false});
    const timestamp = new Date().toLocaleString();
    await Donation.create({ name,email,amount,campaignId:campaignId||"", timestamp });
    if(process.env.DONATIONS_SHEET_ID) await appendSheetValues(process.env.DONATIONS_SHEET_ID,"Donations!A:E",[[timestamp,name,email,amount,campaignId||""]]);
    res.json({success:true});
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// -------------------- ID VERIFICATION --------------------
app.post("/api/verify-id", upload.single("idFile"), async (req,res)=>{
  try{
    const { name,email } = req.body;
    if(!name || !email || !req.file) return res.status(400).json({success:false,message:"Missing fields"});
    const cloudRes = await new Promise((resolve,reject)=>{ const stream = cloudinary.uploader.upload_stream({ folder:"joyfund/id-verifications", use_filename:true, unique_filename:true }, (err,result)=>err?reject(err):resolve(result)); stream.end(req.file.buffer); });
    const timestamp = new Date().toLocaleString();
    await IDVerification.create({ name,email,imageURL:cloudRes.secure_url, timestamp });
    if(SHEET_ID) await appendSheetValues(SHEET_ID,"IDVerifications!A:D",[[timestamp,name,email,cloudRes.secure_url]]);
    res.json({success:true,image:cloudRes.secure_url});
  }catch(err){ console.error(err); res.status(500).json({success:false,message:err.message}); }
});

// -------------------- STRIPE CHECKOUT --------------------
app.post("/api/create-checkout-session/:campaignId?", async (req,res)=>{
  try{
    if(!stripe) return res.status(500).json({ success:false,message:"Stripe not configured" });
    const campaignId = req.params.campaignId || req.body.campaignId;
    const { amount, successUrl, cancelUrl } = req.body;
    if(!campaignId || !amount || !successUrl || !cancelUrl) return res.status(400).json({ success:false,message:"Missing fields" });
    const amountInCents = Math.round(Number(amount)*100);
    const session = await stripe.checkout.sessions.create({
      payment_method_types:["card"],
      line_items:[{ price_data:{ currency:"usd", product_data:{ name:`Donation to campaign ${campaignId}` }, unit_amount:amountInCents }, quantity:1 }],
      mode:"payment",
      success_url:successUrl,
      cancel_url:cancelUrl,
      metadata:{ campaignId }
    });
    res.json({ success:true, sessionId:session.id, campaignId });
  }catch(err){ console.error("Stripe checkout error:",err); res.status(500).json({ success:false,message:"Failed to create checkout session" }); }
});

// -------------------- TEST EMAIL --------------------
app.post("/api/send-test-email", async (req,res)=>{
  const { to, subject, html } = req.body;
  try{ await sendMailjetEmail(subject||"Test Email", html||"<p>This is a test.</p>", to); res.json({ success:true }); }
  catch(err){ console.error(err); res.status(500).json({ success:false,message:"Failed to send email" }); }
});

// -------------------- STATIC FILES --------------------
app.use(express.static(path.join(__dirname,"public")));

// ------------------- START SERVER -------------------
app.listen(PORT,()=>console.log(`JoyFund backend running on port ${PORT}`));
