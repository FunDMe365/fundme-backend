// ==================== SERVER.JS - JOYFUND BACKEND ====================
const express = require("express");
require("dotenv").config();
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const crypto = require("crypto");
const Stripe = require("stripe");
const cloudinary = require("cloudinary").v2;
const mongoose = require('./db');
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
    console.log('✅ MongoDB native db ready');
});
const cors = require("cors");
const fs = require("fs");
require("dotenv").config();

// ==================== ENV VARIABLES ====================
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI; // ensure DB name in URI matches "JoyFund"
const DB_NAME = "JoyFund";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "mk_1S3ksM0qKIo9Xb6efUvOzm2B";
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const MAILJET_API_KEY = process.env.MAILJET_API_KEY;
const MAILJET_API_SECRET = process.env.MAILJET_API_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://fundasmile.net";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "FunDMe$123";
const SESSION_SECRET = process.env.SESSION_SECRET || "supersecretkey";

// ==================== APP ====================
const app = express();

// ==================== PRODUCTION-READY SESSION & CORS ====================
const MongoStore = require("connect-mongo").default;

app.use(session({
  name: "sessionId",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,

  // ✅ Use same client mongoose is using
  store: MongoStore.create({
    clientPromise: mongoose.connection.asPromise().then(() => mongoose.connection.getClient()),
    dbName: DB_NAME,
    collectionName: "sessions",
    ttl: 14 * 24 * 60 * 60
  }),

  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge: 14 * 24 * 60 * 60 * 1000
  }
}));

// ==================== CLOUDINARY ====================
if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
    cloudinary.config({ cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET });
}

const storage = multer.memoryStorage();
const upload = multer({ storage });

// ==================== STRIPE ====================
const stripe = Stripe(STRIPE_SECRET_KEY);

// ==================== MAILJET ====================
const Mailjet = require('node-mailjet');
const mailjetClient = MAILJET_API_KEY && MAILJET_API_SECRET ? Mailjet.connect(MAILJET_API_KEY, MAILJET_API_SECRET) : null;
async function sendMailjetEmail(subject, htmlContent, toEmail) {
    if (!mailjetClient) return;
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

// ==================== MONGO ====================

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

// Sign up a new user
app.post('/api/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ error: "Missing fields" });
        }

        const usersCollection = db.db('JoyFund').collection('Users');
        const existing = await usersCollection.findOne({ Email: { $regex: `^${email}$`, $options: 'i' } });
        if (existing) return res.status(400).json({ error: "Email already exists" });

        const hashed = await bcrypt.hash(password, 10);
        const newUser = {
            Name: name,
            Email: email,
            PasswordHash: hashed,
            JoinDate: new Date()
        };

        await usersCollection.insertOne(newUser);
        req.session.user = {
            name: newUser.Name,
            email: newUser.Email,
            joinDate: newUser.JoinDate
        };

        res.json({ ok: true, loggedIn: true, user: req.session.user });
    } catch (err) {
        console.error("Signup error:", err);
        res.status(500).json({ error: "Signup failed" });
    }
});

// Sign in an existing user
app.post("/api/signin", async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ error: "Missing fields" });

        const usersCollection = db.collection("Users");

        const user = await usersCollection.findOne({
            Email: { $regex: `^${email}$`, $options: "i" }
        });

        if (!user) {
            console.log("Signin failed: user not found for email", email);
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const match = await bcrypt.compare(password, user.PasswordHash);
        if (!match) {
            console.log("Signin failed: password mismatch");
            return res.status(401).json({ error: "Invalid credentials" });
        }

        req.session.user = {
            name: user.Name,
            email: user.Email,
            joinDate: user.JoinDate
        };

        console.log("Signin success:", user.Email);
        res.json({ ok: true, loggedIn: true, user: req.session.user });
    } catch (err) {
        console.error("Signin error:", err);
        res.status(500).json({ error: "Signin failed" });
    }
});

// Sign out the current user
app.post('/api/signout', (req, res) => {
    req.session.destroy(err => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});

// Check if the user is logged in
app.get('/api/check-session', (req, res) => {
    if (req.session.user) {
        res.json({ loggedIn: true, user: req.session.user });
    } else {
        res.json({ loggedIn: false, user: null });
    }
});

// ==================== ADMIN ====================
function requireAdmin(req,res,next){ if(req.session && req.session.admin) return next(); res.status(403).json({success:false,message:"Forbidden"}); }
app.post('/api/admin-login',(req,res)=>{
    const { username,password } = req.body;
    if(username===ADMIN_USERNAME && password===ADMIN_PASSWORD){ req.session.admin=true; return res.json({success:true}); }
    res.status(401).json({success:false,message:"Invalid credentials"});
});
app.post('/api/admin-logout',(req,res)=>{ req.session.destroy(err=>err?res.status(500).json({success:false}):res.json({success:true})); });
app.get('/api/admin-check',(req,res)=>{ res.json({ admin: !!(req.session && req.session.admin) }); });

// ==================== CAMPAIGNS ====================
app.post('/api/create-campaign', upload.single('image'), async (req,res)=>{
    try{
        const { title, goal, description, category, email } = req.body;
        if(!title||!goal||!description||!category||!email||!req.file) return res.status(400).json({success:false,message:"Missing fields"});
        const cloudRes = await cloudinary.uploader.upload_stream({ folder:'joyfund/campaigns', use_filename:true, unique_filename:true }, (err,result)=>{ if(err) throw err; return result; }).end(req.file.buffer);
        const campaignsCollection = db.collection('Campaigns');
        const campaign = { title, goal, description, category, email, status:'pending', createdAt:new Date(), imageURL: cloudRes.secure_url };
        await campaignsCollection.insertOne(campaign);
        res.json({ success:true, message:"Campaign created", imageURL: cloudRes.secure_url });
    }catch(err){ console.error(err); res.status(500).json({success:false,message:err.message}); }
});

app.get('/api/public-campaigns', async(req,res)=>{
    try{
        const rows = await db.collection('Campaigns').find({ status:'Approved' }).toArray();
        res.json({ success:true, campaigns: rows });
    }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

app.get('/api/my-campaigns', async(req,res)=>{
    try{
        const email = req.query.email?.toLowerCase();
        if(!email) return res.status(400).json({success:false,message:"Missing email"});
        const rows = await db.collection('Campaigns').find({ email }).toArray();
        res.json({ success:true, campaigns: rows });
    }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// ==================== DONATIONS ====================
app.post('/api/donation', async(req,res)=>{
    try{
        const { name,email,amount,campaignId } = req.body;
        if(!name||!email||!amount) return res.status(400).json({success:false});
        await db.collection('Donations').insertOne({ name,email,amount,campaignId, date: new Date() });
        res.json({success:true});
    }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

app.get('/api/donations', async(req,res)=>{
    try{
        const rows = await db.collection('Donations').find({}).toArray();
        res.json({success:true, donations:rows});
    }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// ==================== WAITLIST / VOLUNTEERS / STREET TEAM ====================
app.post('/api/waitlist', async(req,res)=>{
    try{
        const { name,email,reason } = req.body;
        const row = { name,email,reason, createdAt:new Date() };
        await db.collection('Waitlist').insertOne(row);
        await sendMailjetEmail("New Waitlist Submission", `<p>${name} (${email}) joined the waitlist. Reason: ${reason || 'N/A'}</p>`, process.env.NOTIFY_EMAIL);
        res.json({success:true});
    }catch(err){ console.error(err); res.status(500).json({success:false}); }
});
app.post('/api/volunteer', async(req,res)=>{
    try{
        const { name,email,role,availability } = req.body;
        const row = { name,email,role,availability, createdAt:new Date() };
        await db.collection('Volunteers').insertOne(row);
        await sendMailjetEmail("New Volunteer Submission", `<p>${name} (${email}) signed up as volunteer for ${role}.</p>`, process.env.NOTIFY_EMAIL);
        res.json({success:true});
    }catch(err){ console.error(err); res.status(500).json({success:false}); }
});
app.post('/api/street-team', async(req,res)=>{
    try{
        const { name,email,city,hoursAvailable } = req.body;
        const row = { name,email,city,hoursAvailable, createdAt:new Date() };
        await db.collection('StreetTeam').insertOne(row);
        await sendMailjetEmail("New Street Team Submission", `<p>${name} (${email}) joined street team in ${city}.</p>`, process.env.NOTIFY_EMAIL);
        res.json({success:true});
    }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// ==================== ID VERIFICATION ====================
app.post('/api/verify-id', upload.single('idFile'), async(req,res)=>{
    try{
        const { name,email } = req.body;
        if(!req.file||!name||!email) return res.status(400).json({success:false,message:"Missing fields"});
        const cloudRes = await cloudinary.uploader.upload(req.file.buffer, { folder:'joyfund/id-verifications', use_filename:true, unique_filename:true });
        await db.collection('ID_Verifications').insertOne({ name,email,url:cloudRes.secure_url, createdAt:new Date() });
        res.json({success:true,url:cloudRes.secure_url});
    }catch(err){ console.error(err); res.status(500).json({success:false,message:err.message}); }
});
app.get('/api/id-verifications', async(req,res)=>{
    try{
        const rows = await db.collection('ID_Verifications').find({}).toArray();
        res.json({success:true,data:rows});
    }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// ==================== STATIC FILES ====================
app.use(express.static('public'));

// ==================== START SERVER ====================
app.listen(PORT, ()=>console.log(`JoyFund backend running on port ${PORT}`));
