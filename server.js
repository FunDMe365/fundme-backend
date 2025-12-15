// ==================== SERVER.JS - JOYFUND BACKEND (MONGO) ====================
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Stripe = require("stripe");
const cloudinary = require("cloudinary").v2;
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");

const app = express();

// -------------------- ENV --------------------
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://fundasmile:fundasmile@joyfund.gvihjsw.mongodb.net/?appName=JoyFund";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "FunDMe$123";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "mk_1S3ksM0qKIo9Xb6efUvOzm2B";
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "";
const CLOUD_KEY = process.env.CLOUDINARY_API_KEY || "";
const CLOUD_SECRET = process.env.CLOUDINARY_API_SECRET || "";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://fundasmile.net";

// -------------------- MONGO --------------------
const client = new MongoClient(MONGO_URI);
let db;
async function connectDB() {
  try {
    await client.connect();
    db = client.db("joyfund");
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("MongoDB connection failed:", err);
  }
}
connectDB();

// -------------------- MIDDLEWARE --------------------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  name: "sessionId",
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 1000*60*60*24
  }
}));

// -------------------- CORS --------------------
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true
}));

// -------------------- STRIPE --------------------
const stripe = Stripe(STRIPE_SECRET_KEY);

// -------------------- CLOUDINARY --------------------
if(CLOUD_NAME && CLOUD_KEY && CLOUD_SECRET) {
  cloudinary.config({
    cloud_name: CLOUD_NAME,
    api_key: CLOUD_KEY,
    api_secret: CLOUD_SECRET
  });
}

// -------------------- MULTER --------------------
const upload = multer({ storage: multer.memoryStorage() });

// -------------------- HELPER --------------------
function requireLogin(req, res, next) {
  if(req.session.user) return next();
  res.status(401).json({ success:false, message:"Not logged in" });
}
function requireAdmin(req,res,next){
  if(req.session.admin) return next();
  res.status(403).json({success:false,message:"Forbidden"});
}

// -------------------- ROUTES --------------------

// ---------- AUTH ----------
app.post("/api/signup", async (req,res)=>{
  try{
    const { name,email,password } = req.body;
    if(!name||!email||!password) return res.status(400).json({success:false,message:"Missing fields"});
    const hashed = await bcrypt.hash(password,10);
    const user = { name, email: email.toLowerCase(), password: hashed, createdAt: new Date() };
    await db.collection("Users").insertOne(user);
    req.session.user = { name: user.name, email: user.email, createdAt: user.createdAt };
    res.json({ok:true,loggedIn:true,user:req.session.user});
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

app.post("/api/signin", async(req,res)=>{
  try{
    const { email,password } = req.body;
    if(!email||!password) return res.status(400).json({success:false,message:"Missing fields"});
    const user = await db.collection("Users").findOne({ email: email.toLowerCase() });
    if(!user) return res.status(401).json({success:false,message:"Invalid credentials"});
    const match = await bcrypt.compare(password,user.password);
    if(!match) return res.status(401).json({success:false,message:"Invalid credentials"});
    req.session.user = { name: user.name, email:user.email, createdAt:user.createdAt };
    res.json({ok:true,loggedIn:true,user:req.session.user});
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

app.post("/api/logout", (req,res)=>{
  req.session.destroy(err=>err?res.status(500).json({success:false}):res.json({success:true}));
});

app.get("/api/check-session",(req,res)=>{
  res.json({loggedIn:!!req.session.user,user:req.session.user||null});
});

// ---------- ADMIN ----------
app.post("/api/admin-login",(req,res)=>{
  const {username,password} = req.body;
  if(username===ADMIN_USERNAME && password===ADMIN_PASSWORD){
    req.session.admin=true;
    return res.json({success:true});
  }
  res.status(401).json({success:false,message:"Invalid credentials"});
});
app.post("/api/admin-logout",(req,res)=>{ req.session.destroy(err=>err?res.status(500).json({success:false}):res.json({success:true})); });
app.get("/api/admin-check",(req,res)=>{ res.json({admin:!!req.session.admin}); });

// ---------- CAMPAIGNS ----------
app.post("/api/create-campaign", upload.single("image"), async(req,res)=>{
  try{
    const { title,goal,description,category,email } = req.body;
    if(!title||!goal||!description||!category||!email) return res.status(400).json({success:false,message:"Missing fields"});
    if(!req.file) return res.status(400).json({success:false,message:"No image"});
    const uploadRes = await cloudinary.uploader.upload_stream({ folder:"joyfund/campaigns", use_filename:true, unique_filename:true }, (err,result)=>{});
    const campaign = {
      title,goal,description,category,email: email.toLowerCase(),
      status:"pending",
      createdAt: new Date(),
      imageURL:"" // will fill after upload below
    };
    // Upload image to Cloudinary
    const stream = cloudinary.uploader.upload_stream({ folder:"joyfund/campaigns", use_filename:true, unique_filename:true }, async (err,result)=>{
      if(err) return res.status(500).json({success:false,message:err.message});
      campaign.imageURL=result.secure_url;
      await db.collection("Campaigns").insertOne(campaign);
      res.json({success:true,message:"Campaign created",campaign});
    });
    stream.end(req.file.buffer);
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

app.get("/api/public-campaigns", async(req,res)=>{
  try{
    const campaigns = await db.collection("Campaigns").find({}).toArray();
    res.json({success:true,campaigns});
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

app.get("/api/my-campaigns", requireLogin, async(req,res)=>{
  try{
    const campaigns = await db.collection("Campaigns").find({ email:req.session.user.email }).toArray();
    res.json({success:true,campaigns});
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// ---------- DONATIONS ----------
app.post("/api/donation", async(req,res)=>{
  try{
    const { name,email,amount,campaignId } = req.body;
    if(!name||!email||!amount) return res.status(400).json({success:false});
    await db.collection("Donations").insertOne({ name,email:email.toLowerCase(),amount,campaignId,createdAt:new Date() });
    res.json({success:true});
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});
app.get("/api/donations", async(req,res)=>{
  try{
    const donations = await db.collection("Donations").find({}).toArray();
    res.json({success:true,donations});
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// ---------- WAITLIST ----------
app.post("/api/waitlist", async(req,res)=>{
  try{
    const { name,email,reason } = req.body;
    if(!name||!email) return res.status(400).json({success:false});
    await db.collection("Waitlist").insertOne({ name,email:email.toLowerCase(),reason:reason||"",createdAt:new Date() });
    res.json({success:true});
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// ---------- VOLUNTEERS ----------
app.post("/api/volunteer", async(req,res)=>{
  try{
    const { name,email,role,availability } = req.body;
    if(!name||!email||!role) return res.status(400).json({success:false});
    await db.collection("Volunteers").insertOne({ name,email:email.toLowerCase(),role,availability:availability||"",createdAt:new Date() });
    res.json({success:true});
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// ---------- STREET TEAM ----------
app.post("/api/street-team", async(req,res)=>{
  try{
    const { name,email,city,hoursAvailable } = req.body;
    if(!name||!email||!city) return res.status(400).json({success:false});
    await db.collection("StreetTeam").insertOne({ name,email:email.toLowerCase(),city,hoursAvailable:hoursAvailable||"",createdAt:new Date() });
    res.json({success:true});
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// ---------- ID VERIFICATION ----------
app.post("/api/verify-id", upload.single("idFile"), async(req,res)=>{
  try{
    const { name,email } = req.body;
    if(!req.file||!name||!email) return res.status(400).json({success:false,message:"Missing fields"});
    const stream = cloudinary.uploader.upload_stream({ folder:"joyfund/id-verifications", use_filename:true, unique_filename:true }, async(err,result)=>{
      if(err) return res.status(500).json({success:false,message:err.message});
      await db.collection("ID_Verifications").insertOne({ name,email:email.toLowerCase(),url:result.secure_url,createdAt:new Date() });
      res.json({success:true,url:result.secure_url});
    });
    stream.end(req.file.buffer);
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

app.get("/api/id-verifications", async(req,res)=>{
  try{
    const data = await db.collection("ID_Verifications").find({}).toArray();
    res.json({success:true,data});
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// ---------- STATIC FILES ----------
app.use(express.static(path.join(__dirname,"public")));

// ---------- START SERVER ----------
app.listen(PORT,()=>console.log(`JoyFund backend running on port ${PORT}`));
