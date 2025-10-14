require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const sgMail = require("@sendgrid/mail");
const Stripe = require("stripe");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 5000;

// ===== Stripe Setup =====
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ===== CORS Setup =====
app.use(cors({
  origin: ["https://fundasmile.net", "http://localhost:3000"],
  methods: ["GET", "POST", "PUT", "OPTIONS", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  credentials: true
}));
app.options("*", cors());

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Session Setup =====
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI, collectionName: 'sessions' }),
  cookie: { secure: process.env.NODE_ENV === "production", httpOnly: true, sameSite: 'none', maxAge: 1000 * 60 * 60 * 24 }
}));

// ===== Serve uploaded images =====
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use("/uploads", express.static(uploadsDir));

// ===== Google Sheets Setup =====
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
  scopes: SCOPES
});
const sheets = google.sheets({ version: "v4", auth });

// ===== Spreadsheet IDs =====
const SPREADSHEET_IDS = {
  users: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
  volunteers: "1O_y1yDiYfO0RT8eGwBMtaiPWYYvSR8jIDIdZkZPlvNA",
  streetteam: "1dPz1LqQq6SKjZIwsgIpQJdQzdmlOV7YrOZJjHqC4Yg8",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
  campaigns: "1XSS-2WJpzEhDe6RHBb8rt_6NNWNqdFpVTUsRa3TNCG8"
};

// ===== SendGrid Setup =====
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ===== Helpers =====
async function sendEmail({ to, subject, html }) {
  try { await sgMail.send({ to, from: process.env.EMAIL_USER, subject, html }); return true; }
  catch (err) { console.error("SendGrid error:", err.response?.body || err.message); return false; }
}

async function saveToSheet(sheetId, sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId, range: `${sheetName}!A:Z`, valueInputOption: "RAW", requestBody: { values: [values] }
  });
}

async function saveUser({ name, email, password }) {
  const hash = await bcrypt.hash(password, 10);
  await saveToSheet(SPREADSHEET_IDS.users, "Users", [new Date().toISOString(), name, email, hash]);
}

async function verifyUser(email, password) {
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_IDS.users, range: "Users!A:D" });
  const row = (data.values || []).find(r => r[2]?.toLowerCase() === email.toLowerCase());
  if (!row) return false;
  const match = await bcrypt.compare(password, row[3]);
  return match ? { name: row[1], email: row[2] } : false;
}

// ===== Multer Setup for Campaign Images =====
const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, uploadsDir); },
  filename: function (req, file, cb) { cb(null, Date.now() + path.extname(file.originalname)); }
});
const upload = multer({ storage });

// ===== Routes =====

// Sign Up
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ success: false, message: "Name, email, and password required." });
  try { await saveUser({ name, email, password }); res.json({ success: true, message: "Account created!" }); }
  catch { res.status(500).json({ success: false, message: "Error creating account." }); }
});

// Sign In
app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: "Email & password required." });
  try {
    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ success: false, error: "Invalid credentials." });
    req.session.user = { name: user.name, email: user.email };
    res.json({ success: true, message: "Signed in!" });
  } catch { res.status(500).json({ success: false, error: "Server error." }); }
});

// Profile
app.get("/api/profile", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  res.json({ success: true, profile: req.session.user });
});

// Logout
app.post("/api/logout", (req, res) => { req.session.destroy(); res.json({ success: true }); });

// Waitlist
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email || !source || !reason) return res.status(400).json({ success: false, error: "All fields required." });
  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [name,email,source,reason,new Date().toISOString()]);
    sendEmail({to:email,subject:"Waitlist",html:`Hi ${name}, you're on the waitlist!`});
    res.json({ success:true,message:"Joined waitlist!" });
  } catch { res.status(500).json({ success:false,error:"Failed to save." }); }
});

// Stripe Checkout
app.post("/api/create-checkout-session", async (req,res)=>{
  try {
    const { amount, campaignId } = req.body;
    if(!amount || amount<100) return res.status(400).json({success:false,error:"Invalid amount"});
    const session = await stripe.checkout.sessions.create({
      payment_method_types:["card"],
      mode:"payment",
      line_items:[{
        price_data:{
          currency:"usd",
          product_data:{ name:"Donation to JoyFund", metadata: { campaignId } },
          unit_amount: amount
        },
        quantity:1
      }],
      success_url:"https://fundasmile.net/thankyou.html",
      cancel_url:"https://fundasmile.net/cancel.html"
    });
    res.json({success:true,url:session.url});
  } catch { res.status(500).json({success:false,error:"Payment failed"}); }
});

// Create Campaign with optional image
app.post("/api/campaigns", upload.single("image"), async(req,res)=>{
  try {
    const {title,description,goal,category,email} = req.body;
    if(!title||!description||!goal||!category||!email) return res.status(400).json({success:false,error:"All fields required"});
    const id = Date.now().toString();
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : "";
    await saveToSheet(SPREADSHEET_IDS.campaigns,"Campaigns",[id,title,email,goal,description,category,"Active",new Date().toISOString(), imageUrl]);
    res.json({success:true,message:"Campaign created!",id, imageUrl});
  } catch { res.status(500).json({success:false,error:"Failed to create campaign"}); }
});

// Get all campaigns
app.get("/api/campaigns", async(req,res)=>{
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:J"
    });
    const rows = data.values || [];
    if(rows.length < 2) return res.json({success:true,campaigns:[]});
    const campaigns = rows.slice(1).map(r => ({
      id: r[0],
      title: r[1],
      email: r[2],
      goal: r[3],
      description: r[4],
      category: r[5],
      status: r[6],
      createdAt: r[7],
      imageUrl: r[8] || ""
    }));
    res.json({success:true,campaigns:campaigns.filter(c=>c.status==="Active")});
  } catch(err){ console.error(err); res.status(500).json({success:false,error:"Failed to fetch campaigns"}); }
});

// Get campaigns per user
app.get("/api/my-campaigns", async(req,res)=>{
  if(!req.session.user) return res.status(401).json({success:false,error:"Not authenticated"});
  try {
    const { data } = await sheets.spreadsheets.values.get({spreadsheetId:SPREADSHEET_IDS.campaigns,range:"Campaigns!A:J"});
    const rows = data.values||[];
    if(rows.length<2) return res.json({success:true,total:0,active:0,campaigns:[]});
    const userEmail = req.session.user.email.toLowerCase();
    const userRows = rows.slice(1).filter(r=>r[2]?.toLowerCase()===userEmail);
    const formatted = userRows.map(r=>({
      id:r[0], title:r[1], email:r[2], goal:r[3], description:r[4],
      category:r[5], status:r[6], imageUrl:r[8]||""
    }));
    const active = formatted.filter(c=>c.status==="Active").length;
    res.json({success:true,total:formatted.length,active,campaigns:formatted});
  } catch { res.status(500).json({success:false,error:"Failed to fetch campaigns"}); }
});

// Delete campaign
app.delete("/api/campaigns/:id", async(req,res)=>{
  if(!req.session.user) return res.status(401).json({success:false,error:"Not authenticated"});
  const id = req.params.id;
  try {
    const { data } = await sheets.spreadsheets.values.get({spreadsheetId:SPREADSHEET_IDS.campaigns,range:"Campaigns!A:F"});
    const rows = data.values||[];
    const index = rows.findIndex(r=>r[0]===id);
    if(index<1) return res.status(404).json({success:false,error:"Campaign not found"});
    const sheetRow = index; // zero-based index includes header
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId:SPREADSHEET_IDS.campaigns,
      requestBody:{requests:[{deleteDimension:{range:{sheetId:0,dimension:"ROWS",startIndex:sheetRow,endIndex:sheetRow+1}}}]}
    }); 
    res.json({success:true,message:"Campaign deleted"});
  } catch { res.status(500).json({success:false,error:"Failed to delete campaign"}); }
});

// ===== Start Server =====
app.listen(PORT,()=>console.log(`🚀 Server running on port ${PORT}`));
