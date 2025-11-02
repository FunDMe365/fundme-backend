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
  "https://fundasmile.net",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

app.options("*", cors());

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "public")));

// ===== Session =====
app.set("trust proxy", 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 1000*60*60*24*30
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
  await saveToSheet(SPREADSHEET_IDS.users,"Users",[new Date().toISOString(),name,email,hash]);
}

async function verifyUser(email,password){
  try {
    const data = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_IDS.users, range: "Users!A:D" });
    const allUsers = data.data.values || [];
    const userRow = allUsers.find(r => r[2]?.toLowerCase() === email.toLowerCase());
    if(!userRow) return false;
    const passwordMatch = await bcrypt.compare(password,userRow[3]);
    if(!passwordMatch) return false;

    return {name:userRow[1], email:userRow[2]};
  } catch(err){ console.error("verifyUser error:",err); return false; }
}

// ===== Routes =====

// --- Signup ---
app.post("/api/signup", async(req,res)=>{
  const {name,email,password}=req.body;
  if(!name||!email||!password) return res.status(400).json({success:false,message:"All fields required"});
  try{ 
    await saveUser({name,email,password}); 
    res.json({success:true}); 
  } catch(err){ 
    console.error(err); 
    res.status(500).json({success:false}); 
  }
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

// ===== The rest of your routes (waitlist, campaigns, Stripe, etc.) remain unchanged =====
// You can copy them from your previous server.js without modification

// ===== Start Server =====
app.listen(PORT,()=>console.log(`🚀 JoyFund backend running on port ${PORT}`));
