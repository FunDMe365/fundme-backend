require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const sgMail = require("@sendgrid/mail");
const Stripe = require("stripe");
const path = require("path");
const multer = require("multer");
const fs = require("fs");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;

// ===== Ensure uploads folder exists =====
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ===== Stripe Setup =====
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ===== CORS =====
const allowedOrigins = [
  "https://joyfund.org",
  "https://www.joyfund.org",
  "https://fundasmile.net",  // <--- added your frontend
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors()); // handle preflight

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "public")));

// ===== Session =====
app.set("trust proxy", 1); // if behind proxy like Render
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));

// ===== Google Sheets =====
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
let auth, sheets;
try {
  auth = new google.auth.GoogleAuth({
    credentials: {
      type: process.env.GOOGLE_TYPE,
      project_id: process.env.GOOGLE_PROJECT_ID,
      private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g,"\n"),
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      client_id: process.env.GOOGLE_CLIENT_ID,
      auth_uri: process.env.GOOGLE_AUTH_URI,
      token_uri: process.env.GOOGLE_TOKEN_URI,
      auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_CERT_URL,
      client_x509_cert_url: process.env.GOOGLE_CLIENT_CERT_URL
    },
    scopes: SCOPES
  });
  sheets = google.sheets({version:"v4", auth});
} catch(e) { console.warn("⚠️ Google Sheets not configured.", e); }

// ===== Sheet IDs =====
const SPREADSHEET_IDS = {
  users: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
  campaigns: "1XSS-2WJpzEhDe6RHBb8rt_6NNWNqdFpVTUsRa3TNCG8",
  donations: "1C_xhW-dh3yQ7MpSoDiUWeCC2NNVWaurggia-f1z0YwA",
  volunteers: "1fCvuVLlPr1UzPaUhIkWMiQyC0pOGkBkYo-KkPshwW7s",
  idVerifications: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0"
};

// ===== SendGrid =====
if(process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
async function sendEmail({to,subject,text,html}) {
  if(!process.env.SENDGRID_API_KEY||!process.env.EMAIL_FROM) return;
  try { await sgMail.send({to,from:process.env.EMAIL_FROM,subject,text,html}); } 
  catch(err){ console.error("SendGrid error:",err); }
}

// ===== Helpers =====
async function saveToSheet(sheetId,sheetName,values){
  return sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range:`${sheetName}!A:Z`,
    valueInputOption:"RAW",
    requestBody:{values:[values]}
  });
}
async function getSheetValues(sheetId,range){
  const {data} = await sheets.spreadsheets.values.get({spreadsheetId:sheetId,range});
  return data.values||[];
}
function rowsToObjects(values){
  if(!values||values.length<1) return [];
  const headers=values[0];
  return values.slice(1).map(row=>{
    const obj={};
    headers.forEach((h,i)=>obj[h]=row[i]||"");
    return obj;
  });
}

// ===== Multer =====
const storage = multer.diskStorage({
  destination:uploadsDir,
  filename:(req,file,cb)=>cb(null,`${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({storage});

// ===== User Functions =====
async function saveUser({name,email,password}){
  const hash = await bcrypt.hash(password,10);
  await saveToSheet(SPREADSHEET_IDS.users,"Users",[new Date().toISOString(),name,email,hash,"false"]);
}
async function verifyUser(email,password){
  try {
    const data = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_IDS.users, range: "Users!A:E" });
    const allUsers = data.data.values || [];
    const userRow = allUsers.find(r=>r[2]?.toLowerCase()===email.toLowerCase());
    if(!userRow) return false;
    const passwordMatch = await bcrypt.compare(password,userRow[3]);
    if(!passwordMatch) return false;

    // ID Verification
    const verData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_IDS.idVerifications, range: "ID_Verifications!A:E" });
    const verRows = (verData.data.values||[]).filter(r=>r[1]?.toLowerCase()===email.toLowerCase());
    const latestVer = verRows.length?verRows[verRows.length-1]:null;
    const verified = latestVer?.[3]==="Approved";
    const verificationStatus = latestVer?.[3]||"Not submitted";

    return {name:userRow[1],email:userRow[2],verified,verificationStatus};
  } catch(err){ console.error("verifyUser error:",err); return false; }
}

// ===== Routes =====

// --- Signup ---
app.post("/api/signup", async(req,res)=>{
  const {name,email,password}=req.body;
  if(!name||!email||!password) return res.status(400).json({success:false,message:"All fields required"});
  try{ await saveUser({name,email,password}); res.json({success:true}); }
  catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// --- Signin ---
app.post("/api/signin", async(req,res)=>{
  const {email,password}=req.body;
  if(!email||!password) return res.status(400).json({success:false,message:"Email and password required"});
  try{
    const user = await verifyUser(email,password);
    if(!user) return res.status(401).json({success:false,message:"Invalid credentials"});
    req.session.user = user;
    req.session.save(()=>res.json({success:true,profile:user}));
  } catch(err){ console.error("signin error:",err); res.status(500).json({success:false,message:"Internal server error"}); }
});

// --- Signout ---
app.post("/api/signout",(req,res)=>req.session.destroy(()=>res.json({success:true})));

// --- Check Session ---
app.get("/api/check-session",(req,res)=>res.json({loggedIn:!!req.session.user,user:req.session.user||null}));

// --- Waitlist ---
app.post("/api/waitlist", async(req,res)=>{
  const {name,email,source,reason}=req.body;
  if(!name||!email) return res.status(400).json({success:false,message:"Name and email required"});
  try{
    await saveToSheet(SPREADSHEET_IDS.waitlist,"Waitlist",[new Date().toISOString(),name,email,source||"",reason||""]);
    res.json({success:true});
  } catch(err){ console.error("waitlist error:",err); res.status(500).json({success:false,message:"Error saving waitlist"}); }
});

// --- ID Verification ---
app.post("/api/verify-id", upload.single("idDocument"), async(req,res)=>{
  if(!req.session.user) return res.status(401).json({success:false,message:"Not logged in"});
  const file=req.file;
  if(!file) return res.status(400).json({success:false,message:"ID document is required"});
  try{
    const fileUrl=`/uploads/${file.filename}`;
    const now = new Date().toISOString();
    await saveToSheet(SPREADSHEET_IDS.idVerifications,"ID_Verifications",[now,req.session.user.email,now,"Pending",fileUrl]);
    res.json({success:true,message:"ID submitted successfully"});
  }catch(err){ console.error("verify-id error:",err); res.status(500).json({success:false,message:"Failed to submit ID"}); }
});

// --- Campaigns ---
app.post("/api/create-campaign", upload.single("image"), async(req,res)=>{
  if(!req.session.user) return res.status(401).json({success:false,message:"Not logged in"});
  const { title, goal, category, description } = req.body;
  if(!title||!goal||!category||!description) return res.status(400).json({success:false,message:"All fields required"});
  try{
    const imageUrl = req.file?`/uploads/${req.file.filename}`:"";
    const campaignId = `CAMP-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    const date = new Date().toLocaleString();
    await saveToSheet(SPREADSHEET_IDS.campaigns,"Campaigns",[date,req.session.user.name,req.session.user.email,campaignId,title,description,req.session.user.email,goal,imageUrl,description,category,"Pending",date,imageUrl]);
    res.json({success:true,message:"Campaign submitted successfully",campaignId});
  }catch(err){ console.error("create-campaign error:",err); res.status(500).json({success:false,message:"Failed to create campaign"}); }
});

// --- Get all campaigns ---
app.get("/api/campaigns", async(req,res)=>{
  try{
    const {data} = await sheets.spreadsheets.values.get({spreadsheetId:SPREADSHEET_IDS.campaigns,range:"Campaigns!A:N"});
    const allCampaigns = (data.values||[]).map(row=>({
      id:row[3],
      title:row[4],
      creator:row[1],
      email:row[2],
      goal:row[7],
      description:row[5],
      category:row[10],
      status:row[11],
      createdAt:row[12],
      imageUrl:row[13]||""
    }));
    res.json({success:true,campaigns:allCampaigns});
  }catch(err){ console.error("get-campaigns error:",err); res.status(500).json({success:false,campaigns:[]}); }
});

// --- Stripe Checkout ---
app.post("/api/create-checkout-session/:campaignId", async(req,res)=>{
  const {campaignId}=req.params;
  const {amount,donorEmail,successUrl,cancelUrl}=req.body;
  if(!campaignId||!amount||!successUrl||!cancelUrl) return res.status(400).json({success:false,message:"Missing fields"});
  try{
    const donationAmount=Math.round(parseFloat(amount)*100);
    const session=await stripe.checkout.sessions.create({
      payment_method_types:["card"],
      line_items:[{
        price_data:{currency:"usd",product_data:{name:campaignId==="mission"?"General JoyFund Donation":`Donation to Campaign ${campaignId}`},unit_amount:donationAmount},
        quantity:1
      }],
      mode:"payment",
      success_url:successUrl,
      cancel_url:cancelUrl,
      customer_email:donorEmail,
      metadata:{campaignId,amount:donationAmount}
    });
    res.json({success:true,sessionId:session.id});
  }catch(err){ console.error("create-checkout-session error:",err); res.status(500).json({success:false,message:"Failed to create checkout session"}); }
});

// --- Log Donations ---
app.post("/api/log-donation", async(req,res)=>{
  const {campaignId,title,amount,timestamp}=req.body;
  if(!campaignId||!title||!amount||!timestamp) return res.status(400).json({success:false,message:"Missing donation fields"});
  try{
    await saveToSheet(SPREADSHEET_IDS.donations,"Donations",[timestamp,campaignId,title,amount]);
    res.json({success:true});
  }catch(err){ console.error("log-donation error:",err); res.status(500).json({success:false,message:"Failed to log donation"}); }
});

// --- Catch-all API 404 ---
app.all("/api/*",(req,res)=>res.status(404).json({success:false,message:"API route not found"}));

// ===== Start Server =====
app.listen(PORT,()=>console.log(`🚀 JoyFund backend running on port ${PORT}`));
