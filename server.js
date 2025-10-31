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

// ===== CORS Setup (fixed) =====
const allowedOrigins = [
  "https://joyfund.org",
  "https://www.joyfund.org",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn("Blocked CORS request from origin:", origin);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors()); // handle preflight

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Serve uploads and public =====
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
    maxAge: 1000 * 60 * 60 * 24 * 30,
  },
}));

// ===== Google Sheets =====
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON || "{}"),
  scopes: SCOPES,
});
const sheets = google.sheets({ version: "v4", auth });

const SPREADSHEET_IDS = {
  users: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
  campaigns: "1XSS-2WJpzEhDe6RHBb8rt_6NNWNqdFpVTUsRa3TNCG8",
  donations: "1C_xhW-dh3yQ7MpSoDiUWeCC2NNVWaurggia-f1z0YwA",
  volunteers: "1fCvuVLlPr1UzPaUhIkWMiQyC0pOGkBkYo-KkPshwW7s",
  iD_Verifications: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
};

// ===== SendGrid =====
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const sendEmail = async ({ to, subject, text, html }) => {
  if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_SENDER) return;
  try {
    await sgMail.send({ to, from: process.env.SENDGRID_SENDER, subject, text, html });
    console.log(`✅ Email sent to ${to}`);
  } catch (err) {
    console.error("SendGrid error:", err);
  }
};

// ===== Helpers =====
async function saveToSheet(sheetId, sheetName, values) {
  return sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

async function getSheetValues(sheetId, range) {
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  return data.values || [];
}

function rowsToObjects(values) {
  if (!values || values.length < 1) return [];
  const headers = values[0];
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h,i)=> obj[h]=row[i]||"");
    return obj;
  });
}

// ===== Multer =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ===== User Helpers =====
async function saveUser({ name, email, password }) {
  const hash = await bcrypt.hash(password, 10);
  await saveToSheet(SPREADSHEET_IDS.users, "Users", [new Date().toISOString(), name, email, hash, "false"]);
}

async function verifyUser(email, password) {
  try {
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_IDS.users, range: "Users!A:E" });
    const allUsers = data.values || [];
    const userRow = allUsers.find(r => r[2]?.toLowerCase() === email.toLowerCase());
    if(!userRow) return false;
    const passwordMatch = await bcrypt.compare(password,userRow[3]);
    if(!passwordMatch) return false;

    // ID verification
    const { data: verData } = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_IDS.users, range: "ID_Verifications!A:E" });
    const verRows = (verData.values||[]).filter(r=>r[1]?.toLowerCase()===email.toLowerCase());
    const latestVer = verRows.length?verRows[verRows.length-1]:null;
    const verificationStatus = latestVer ? latestVer[3] : "Not submitted";
    const verified = verificationStatus==="Approved";
    return { name: userRow[1], email: userRow[2], verified, verificationStatus };
  } catch(err){ console.error("verifyUser error:", err); return false; }
}

// ===== Auth Routes =====
app.post("/api/signup", async (req,res)=>{
  const { name,email,password } = req.body;
  if(!name||!email||!password) return res.status(400).json({success:false,message:"All fields required"});
  try{ await saveUser({ name,email,password }); res.json({success:true}); }
  catch(err){ console.error("signup error:",err); res.status(500).json({success:false}); }
});

app.options("/api/signin", cors());
app.post("/api/signin", async (req,res)=>{
  const { email,password } = req.body;
  if(!email||!password) return res.status(400).json({success:false,message:"Email and password required"});
  try{
    const user = await verifyUser(email,password);
    if(!user) return res.status(401).json({success:false,message:"Invalid credentials"});
    req.session.user = user;
    req.session.save(()=>res.json({success:true,profile:user}));
  }catch(err){ console.error("signin error:",err); res.status(500).json({success:false,message:"Internal server error"}); }
});

app.post("/api/signout",(req,res)=>{ req.session.destroy(()=>res.json({success:true})); });
app.get("/api/check-session",(req,res)=>{ res.json(req.session.user?{loggedIn:true,user:req.session.user}:{loggedIn:false}); });

// ===== Waitlist =====
app.post("/api/waitlist", async(req,res)=>{
  const { name,email,source,reason } = req.body;
  if(!name||!email) return res.status(400).json({success:false,message:"Name and email required"});
  try{ await saveToSheet(SPREADSHEET_IDS.waitlist,"Waitlist",[new Date().toISOString(),name,email,source||"",reason||""]); res.json({success:true}); }
  catch(err){ console.error("waitlist error:",err); res.status(500).json({success:false,message:"Error saving to waitlist"}); }
});

// ===== Campaigns & Donations =====
// ... (same as previous version)

app.listen(PORT,()=>console.log(`🚀 JoyFund backend running on port ${PORT}`));
