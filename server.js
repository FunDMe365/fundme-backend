// ==================== SERVER.JS - JOYFUND BACKEND ====================

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { google } = require("googleapis");
const Stripe = require("stripe");
const cors = require("cors");
const mailjetLib = require("node-mailjet");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

// -------------------- DEBUG ENV --------------------
console.log("🔑 MAILJET_API_KEY:", process.env.MAILJET_API_KEY ? "Loaded" : "Missing");
console.log("🔒 MAILJET_API_SECRET:", process.env.MAILJET_API_SECRET ? "Loaded" : "Missing");
console.log("☁️ CLOUDINARY_CLOUD_NAME:", process.env.CLOUDINARY_CLOUD_NAME ? "Loaded" : "Missing");
console.log("☁️ CLOUDINARY_API_KEY:", process.env.CLOUDINARY_API_KEY ? "Loaded" : "Missing");
console.log("☁️ CLOUDINARY_API_SECRET:", process.env.CLOUDINARY_API_SECRET ? "Loaded" : "Missing");

// -------------------- CLOUDINARY --------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "",
  api_key: process.env.CLOUDINARY_API_KEY || "",
  api_secret: process.env.CLOUDINARY_API_SECRET || "",
});

// -------------------- APP --------------------
const app = express();
const PORT = process.env.PORT || 5000;

// -------------------- CORS --------------------
const allowedOrigins = [
  "https://fundasmile.net",
  "https://fundme-backend.onrender.com",
  "http://localhost:5000",
  "http://127.0.0.1:5000"
];

app.use(cors({
  origin: (origin, callback) => {
    if(!origin) return callback(null,true);
    if(allowedOrigins.includes(origin)) return callback(null,true);
    callback(new Error("CORS not allowed"));
  },
  credentials:true,
  methods:["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders:["Content-Type","Authorization"]
}));
app.options("*", cors());

// -------------------- MIDDLEWARE --------------------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended:true }));

// -------------------- SESSION --------------------
app.set("trust proxy",1);
app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave:false,
  saveUninitialized:false,
  cookie:{
    httpOnly:true,
    secure: process.env.NODE_ENV==="production"?true:false,
    sameSite: process.env.NODE_ENV==="production"?"none":"lax",
    maxAge:1000*60*60*24*7
  }
}));

// -------------------- STRIPE --------------------
const stripe = Stripe(process.env.STRIPE_SECRET_KEY||"");

// -------------------- MAILJET --------------------
let mailjetClient = null;
if(process.env.MAILJET_API_KEY && process.env.MAILJET_API_SECRET){
  mailjetClient = mailjetLib.apiConnect(
    process.env.MAILJET_API_KEY,
    process.env.MAILJET_API_SECRET
  );
} else {
  console.warn("⚠️ Mailjet API_KEY or API_SECRET missing. Emails will not be sent.");
}

async function sendMailjetEmail(subject, htmlContent){
  if(!mailjetClient){
    console.warn("⚠️ Mailjet not configured, skipping email:", subject);
    return;
  }
  try{
    await mailjetClient.post("send", {'version':'v3.1'}).request({
      Messages:[{
        From: { Email: process.env.MAILJET_SENDER_EMAIL, Name:"JoyFund INC" },
        To: [{ Email: process.env.NOTIFY_EMAIL }],
        Subject: subject,
        HTMLPart: htmlContent
      }]
    });
  }catch(err){ console.error("Mailjet error:",err); }
}

// -------------------- GOOGLE SHEETS --------------------
let sheets;
try{
  if(process.env.GOOGLE_CREDENTIALS_JSON){
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials:creds,
      scopes:["https://www.googleapis.com/auth/spreadsheets"]
    });
    sheets = google.sheets({version:"v4",auth});
    console.log("✅ Google Sheets initialized");
  } else { console.warn("⚠️ GOOGLE_CREDENTIALS_JSON missing; Sheets disabled."); }
}catch(err){ console.error("❌ Google Sheets init failed", err.message); }

async function getSheetValues(spreadsheetId,range){ 
  if(!sheets) return []; 
  const res = await sheets.spreadsheets.values.get({spreadsheetId,range}); 
  return res.data.values||[]; 
}

async function appendSheetValues(spreadsheetId,range,values){ 
  if(!sheets) throw new Error("Sheets not initialized"); 
  await sheets.spreadsheets.values.append({spreadsheetId,range,valueInputOption:"USER_ENTERED",resource:{values}}); 
}

async function findRowAndUpdateOrAppend(spreadsheetId,rangeCols,matchColIndex,matchValue,updatedValues){
  if(!sheets) throw new Error("Sheets not initialized");
  let sheetName="",range="";
  if(rangeCols.includes("!")) [sheetName,range] = rangeCols.split("!");
  else range = rangeCols;

  const rows = await getSheetValues(spreadsheetId,rangeCols);
  const rowIndex = rows.findIndex(r=>(r[matchColIndex]||"").toString().trim().toLowerCase() === (matchValue||"").toString().trim().toLowerCase());

  if(rowIndex===-1){
    await appendSheetValues(spreadsheetId,rangeCols,[updatedValues]);
    return {action:"appended",row:rows.length+1};
  }else{
    const [startCol,endCol] = range.split(":");
    const rowNumber = rowIndex+1;
    const updateRange = sheetName? `${sheetName}!${startCol}${rowNumber}:${endCol}${rowNumber}`:`${startCol}${rowNumber}:${endCol}${rowNumber}`;
    await sheets.spreadsheets.values.update({spreadsheetId,range:updateRange,valueInputOption:"USER_ENTERED",resource:{values:[updatedValues]}});
    return {action:"updated",row:rowNumber};
  }
}

// -------------------- USERS --------------------
async function getUsers(){ 
  if(!process.env.USERS_SHEET_ID) return []; 
  return getSheetValues(process.env.USERS_SHEET_ID,"A:D"); 
}

// -------------------- SIGN-IN / SESSION --------------------
app.post("/api/signin",async(req,res)=>{
  const { email,password } = req.body;
  if(!email||!password) return res.status(400).json({error:"Missing email or password"});
  try{
    const users = await getUsers();
    const inputEmail = email.trim().toLowerCase();
    const userRow = users.find(u=>u[2] && u[2].trim().toLowerCase()===inputEmail);
    if(!userRow) return res.status(401).json({error:"Invalid credentials"});
    const storedHash = (userRow[3]||"").trim();
    const match = await bcrypt.compare(password,storedHash);
    if(!match) return res.status(401).json({error:"Invalid credentials"});
    req.session.user = { name:userRow[1], email:userRow[2], joinDate:userRow[0] };
    res.json({ ok:true, user:req.session.user });
  }catch(err){ console.error("signin error:",err); res.status(500).json({error:"Server error"}); }
});

app.get("/api/check-session",(req,res)=>{ 
  if(req.session.user) res.json({loggedIn:true,user:req.session.user}); 
  else res.json({loggedIn:false}); 
});

app.post("/api/logout",(req,res)=>{ 
  req.session.destroy(err=>{ if(err) return res.status(500).json({error:"Failed to logout"}); res.json({ok:true}); }); 
});

// -------------------- MULTER MEMORY STORAGE --------------------
const storage = multer.memoryStorage();
const upload = multer({ storage });

// -------------------- ID VERIFICATION --------------------
app.post("/api/verify-id", upload.single("idDocument"), async (req,res)=>{
  try{
    const user=req.session.user;
    if(!user) return res.status(401).json({success:false,message:"Sign in required"});
    if(!req.file) return res.status(400).json({success:false,message:"No file uploaded"});
    if(!sheets) return res.status(500).json({success:false,message:"Sheets not initialized"});

    const spreadsheetId=process.env.ID_VERIFICATIONS_SHEET_ID;
    if(!spreadsheetId) return res.status(500).json({success:false,message:"ID_VERIFICATIONS_SHEET_ID not configured"});

    // Upload to Cloudinary
    const uploadResult = await new Promise((resolve,reject)=>{
      const stream = cloudinary.uploader.upload_stream({ folder: "joyfund/id-verifications" }, (err,result)=>{ if(err) reject(err); else resolve(result); });
      stream.end(req.file.buffer);
    });

    const fileUrl = uploadResult.secure_url;

    const timestamp = new Date().toLocaleString();
    const updatedRow=[timestamp,user.email.toLowerCase(),user.name,"pending",fileUrl];
    const result = await findRowAndUpdateOrAppend(spreadsheetId,"ID_Verifications!A:E",1,user.email,updatedRow);

    await sendMailjetEmail("New ID Verification Submitted",`<p>${user.name} (${user.email}) submitted an ID at ${timestamp}</p>`);

    res.json({success:true,action:result.action,row:result.row});
  }catch(err){ console.error("verify-id error:",err); res.status(500).json({success:false,message:"Failed to submit ID verification"}); }
});

// -------------------- CREATE CAMPAIGN --------------------
app.post("/api/create-campaign", upload.single("image"), async (req,res)=>{
  try{
    const user = req.session.user;
    if(!user) return res.status(401).json({success:false,message:"Sign in required"});

    const { title,goal,description,category } = req.body;
    if(!title||!goal||!description||!category) return res.status(400).json({success:false,message:"Missing required fields"});
    if(!sheets) return res.status(500).json({success:false,message:"Sheets not initialized"});

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    if(!spreadsheetId) return res.status(500).json({success:false,message:"CAMPAIGNS_SHEET_ID not configured"});

    const campaignId = Date.now().toString();
    let imageUrl = "https://placehold.co/400x200?text=No+Image";

    if(req.file){
      const uploadResult = await new Promise((resolve,reject)=>{
        const stream = cloudinary.uploader.upload_stream({ folder: "joyfund/campaigns" }, (err,result)=>{ if(err) reject(err); else resolve(result); });
        stream.end(req.file.buffer);
      });
      imageUrl = uploadResult.secure_url;
    }

    const createdAt = new Date().toISOString();
    const status = "Pending";
    const newCampaignRow = [campaignId,title,user.email.toLowerCase(),goal,description,category,status,createdAt,imageUrl];

    await appendSheetValues(spreadsheetId,"A:I",[newCampaignRow]);
    await sendMailjetEmail("New Campaign Submitted",`<p>${user.name} (${user.email}) submitted a campaign titled "${title}"</p>`);

    res.json({success:true,message:"Campaign submitted and pending approval",campaignId});
  }catch(err){ console.error("create-campaign error:",err); res.status(500).json({success:false,message:"Failed to create campaign"}); }
});

// -------------------- FETCH CAMPAIGNS --------------------
app.get("/api/campaigns", async (req,res)=>{
  try{
    if(!req.session.user) return res.status(401).json({success:false,message:"Sign in required"});
    if(!sheets) return res.status(500).json({success:false,message:"Sheets not initialized"});
    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    const rows = await getSheetValues(spreadsheetId,"A:I");
    const campaigns = rows.map(r=>({
      campaignId:r[0], title:r[1], creator:r[2], goal:r[3], description:r[4],
      category:r[5], status:r[6], createdAt:r[7], imageUrl:r[8] || "https://placehold.co/400x200?text=No+Image"
    }));
    res.json({success:true,campaigns});
  }catch(err){ console.error("fetch campaigns error:",err); res.status(500).json({success:false,message:"Failed to fetch campaigns"}); }
});

// -------------------- OTHER ROUTES OMITTED FOR BREVITY --------------------
// (Donations, waitlist, volunteer, street team, contact, stripe, profile updates, etc. remain unchanged)

// -------------------- START SERVER --------------------
app.listen(PORT,()=>console.log(`🚀 JoyFund backend running on port ${PORT}`));
