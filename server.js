// ==================== SERVER.JS - JOYFUND BACKEND (MONGODB) ====================

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
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

// ==================== CONFIG ====================
const PORT = process.env.PORT || 5000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "FunDMe$123";
const MONGO_URI = "mongodb+srv://fundasmile:fundasmile@joyfund.gvihjsw.mongodb.net/?appName=JoyFund";

// ==================== APP ====================
const app = express();

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
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  }
}));

// ==================== MONGO CONNECTION ====================
const client = new MongoClient(MONGO_URI);
let db;
async function connectDB() {
  await client.connect();
  db = client.db("joyfund");
  console.log("Connected to MongoDB");
}
connectDB().catch(console.error);

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
  return url || '';
}

// ==================== STRIPE ====================
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!stripe) console.warn("Stripe not configured");

// ==================== LIVE VISITORS ====================
const liveVisitors = {};
app.post("/api/track-visitor", (req,res)=>{
  try{
    const { visitorId } = req.body;
    if(!visitorId) return res.status(400).json({success:false,message:"Missing visitorId"});
    const now = Date.now();
    liveVisitors[visitorId]=now;
    for(const id in liveVisitors){
      if(now - liveVisitors[id] > 30000) delete liveVisitors[id];
    }
    res.json({success:true,activeCount:Object.keys(liveVisitors).length});
  }catch(err){console.error(err);res.status(500).json({success:false});}
});

// ==================== AUTH ====================
app.post("/api/signup", async(req,res)=>{
  try{
    const { name,email,password } = req.body;
    if(!name||!email||!password) return res.status(400).json({success:false,message:"Missing fields"});
    const hashedPassword = await bcrypt.hash(password,10);
    const user = { name,email:email.toLowerCase(),password:hashedPassword, joinDate: new Date() };
    await db.collection("Users").insertOne(user);
    req.session.user = { name:user.name,email:user.email,joinDate:user.joinDate };
    res.json({ok:true,loggedIn:true,user:req.session.user});
  }catch(err){console.error(err);res.status(500).json({error:"Signup failed"});}
});

app.post("/api/signin", async(req,res)=>{
  try{
    const { email,password } = req.body;
    const user = await db.collection("Users").findOne({ email: email.toLowerCase() });
    if(!user) return res.status(401).json({error:"Invalid credentials"});
    const match = await bcrypt.compare(password,user.password);
    if(!match) return res.status(401).json({error:"Invalid credentials"});
    req.session.user={name:user.name,email:user.email,joinDate:user.joinDate};
    res.json({ok:true,loggedIn:true,user:req.session.user});
  }catch(err){console.error(err);res.status(500).json({error:"Signin failed"});}
});

app.get("/api/check-session", (req,res)=>{
  res.json({loggedIn:!!req.session.user, user:req.session.user||null});
});

app.post("/api/logout", (req,res)=>{
  req.session.destroy(err=>err?res.status(500).json({success:false}):res.json({success:true}));
});

// ==================== ADMIN ====================
function requireAdmin(req,res,next){ if(req.session && req.session.admin) return next(); res.status(403).json({success:false,message:"Forbidden"}); }
app.post("/api/admin-login", (req,res)=>{
  const { username,password } = req.body;
  if(username===ADMIN_USERNAME && password===ADMIN_PASSWORD){ req.session.admin=true; return res.json({success:true}); }
  res.status(401).json({success:false,message:"Invalid credentials"});
});
app.post("/api/admin-logout", (req,res)=>{ req.session.destroy(err=>err?res.status(500).json({success:false}):res.json({success:true})); });
app.get("/api/admin-check", (req,res)=>{ res.json({admin:!!(req.session && req.session.admin)}); });

// ==================== CAMPAIGNS ====================
app.post("/api/create-campaign", upload.single("image"), async(req,res)=>{
  try{
    const { title,goal,description,category,email } = req.body;
    if(!title||!goal||!description||!category||!email) return res.status(400).json({success:false,message:"Missing required fields"});
    if(!req.file) return res.status(400).json({success:false,message:"No image uploaded"});
    const cloudRes = await new Promise((resolve,reject)=>{
      const stream = cloudinary.uploader.upload_stream({ folder:"joyfund/campaigns", use_filename:true, unique_filename:true }, (err,result)=>err?reject(err):resolve(result));
      stream.end(req.file.buffer);
    });
    const campaign = { title,email,goal,description,category,status:"pending",createdAt:new Date(),imageURL:cloudRes.secure_url };
    const result = await db.collection("Campaigns").insertOne(campaign);
    res.json({success:true,message:"Campaign created",imageURL:cloudRes.secure_url});
  }catch(err){console.error(err);res.status(500).json({success:false,message:err.message});}
});

app.get("/api/public-campaigns", async(req,res)=>{
  try{
    const campaigns = await db.collection("Campaigns").find({ status:"Approved" }).toArray();
    res.json({success:true,campaigns});
  }catch(err){console.error(err);res.status(500).json({success:false});}
});

app.get("/api/my-campaigns", async(req,res)=>{
  try{
    const email = req.query.email?.toLowerCase();
    if(!email) return res.status(400).json({success:false,message:"Missing email"});
    const campaigns = await db.collection("Campaigns").find({ email }).toArray();
    res.json({success:true,campaigns});
  }catch(err){console.error(err);res.status(500).json({success:false});}
});

app.post("/api/delete-campaign/:id", requireAdmin, async(req,res)=>{
  try{
    const id=req.params.id;
    await db.collection("Campaigns").deleteOne({ _id:new ObjectId(id) });
    res.json({success:true});
  }catch(err){console.error(err);res.status(500).json({success:false});}
});

// ==================== DONATIONS ====================
app.post("/api/donation", async(req,res)=>{
  try{
    const { name,email,amount,campaignId } = req.body;
    if(!name||!email||!amount) return res.status(400).json({success:false});
    const donation = { name,email,amount,campaignId:campaignId||null,date:new Date() };
    await db.collection("Donations").insertOne(donation);
    res.json({success:true});
  }catch(err){console.error(err);res.status(500).json({success:false});}
});

app.get("/api/donations", async(req,res)=>{
  try{
    const donations = await db.collection("Donations").find({}).toArray();
    res.json({success:true,donations});
  }catch(err){console.error(err);res.status(500).json({success:false});}
});

// ==================== WAITLIST / VOLUNTEERS / STREET TEAM ====================
app.post("/api/waitlist", async(req,res)=>{
  try{
    const { name,email,reason } = req.body;
    const entry={ name,email,reason:reason||'', createdAt:new Date() };
    await db.collection("Waitlist").insertOne(entry);
    res.json({success:true});
  }catch(err){console.error(err);res.status(500).json({success:false});}
});
app.post("/api/volunteer", async(req,res)=>{
  try{
    const { name,email,role,availability } = req.body;
    const entry={ name,email,role,availability:availability||'', createdAt:new Date() };
    await db.collection("Volunteers").insertOne(entry);
    res.json({success:true});
  }catch(err){console.error(err);res.status(500).json({success:false});}
});
app.post("/api/street-team", async(req,res)=>{
  try{
    const { name,email,city,hoursAvailable } = req.body;
    const entry={ name,email,city,hoursAvailable:hoursAvailable||'', createdAt:new Date() };
    await db.collection("StreetTeam").insertOne(entry);
    res.json({success:true});
  }catch(err){console.error(err);res.status(500).json({success:false});}
});

// ==================== ID VERIFICATION ====================
app.post("/api/verify-id", upload.single("idFile"), async(req,res)=>{
  try{
    if(!req.file) return res.status(400).json({success:false,message:"No file uploaded"});
    const cloudRes = await new Promise((resolve,reject)=>{
      const stream = cloudinary.uploader.upload_stream({ folder:"joyfund/id-verifications", use_filename:true, unique_filename:true }, (err,result)=>err?reject(err):resolve(result));
      stream.end(req.file.buffer);
    });
    const entry={ name:req.body.name||'', email:req.body.email||'', url:cloudRes.secure_url, createdAt:new Date() };
    await db.collection("ID_Verifications").insertOne(entry);
    res.json({success:true,url:cloudRes.secure_url});
  }catch(err){console.error(err);res.status(500).json({success:false,message:err.message});}
});
app.get("/api/id-verifications", async(req,res)=>{
  try{
    const data = await db.collection("ID_Verifications").find({}).toArray();
    res.json({success:true,data});
  }catch(err){console.error(err);res.status(500).json({success:false});}
});

// ==================== STATIC FILES ====================
app.use(express.static(path.join(__dirname,"public")));

// ==================== START SERVER ====================
app.listen(PORT,()=>console.log(`JoyFund backend running on port ${PORT}`));