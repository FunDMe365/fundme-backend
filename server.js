require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const Stripe = require("stripe");
const cors = require("cors");
const mailjet = require("node-mailjet");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;

// ==================== CORS CONFIG ====================
const allowedOrigins = [
  "https://fundasmile.net",
  "https://fundme-backend.onrender.com",
  "http://localhost:5000",
  "http://127.0.0.1:5000"
];

app.use(cors({
  origin: function(origin, callback) {
    if(!origin) return callback(null,true); // allow Postman or mobile apps
    if(allowedOrigins.includes(origin)) return callback(null,true);
    callback(new Error("CORS not allowed"));
  },
  credentials:true,
  methods:["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders:["Content-Type","Authorization"]
}));

app.options("*", cors());

// ==================== MIDDLEWARE ====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended:true }));
app.use("/uploads", express.static(path.join(__dirname,"uploads")));

// ==================== SESSION ====================
app.set("trust proxy",1); // for production behind proxy
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

// ==================== STRIPE & MAILJET ====================
const stripe = Stripe(process.env.STRIPE_SECRET_KEY||"");
const mailjetClient = mailjet.apiConnect(
  process.env.MAILJET_API_KEY||"",
  process.env.MAILJET_API_SECRET||""
);

async function sendMailjetEmail(subject, htmlContent){
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

// ==================== GOOGLE SHEETS ====================
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
  } else { console.warn("⚠️ GOOGLE_CREDENTIALS_JSON not provided; Sheets disabled."); }
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

// ==================== USERS ====================
async function getUsers(){ 
  if(!process.env.USERS_SHEET_ID) return []; 
  return getSheetValues(process.env.USERS_SHEET_ID,"A:D"); 
}

// ==================== SIGN-IN / SESSION ====================
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

// ==================== UPLOAD CONFIGS ====================
const storage = multer.diskStorage({
  destination:(req,file,cb)=>{ const uploadDir = path.join(__dirname,"uploads","id-verifications"); fs.mkdirSync(uploadDir,{recursive:true}); cb(null,uploadDir); },
  filename:(req,file,cb)=>{ const timestamp = Date.now(); const sanitizedEmail = req.session.user?.email.replace(/[@.]/g,"_")||"unknown"; const ext=path.extname(file.originalname); cb(null,`${sanitizedEmail}_${timestamp}${ext}`); }
});
const upload = multer({ storage });

const campaignStorage = multer.diskStorage({
  destination:(req,file,cb)=>{ const uploadDir = path.join(__dirname,"uploads","campaigns"); fs.mkdirSync(uploadDir,{recursive:true}); cb(null,uploadDir); },
  filename:(req,file,cb)=>{ const timestamp = Date.now(); const sanitizedEmail=req.session.user?.email.replace(/[@.]/g,"_")||"unknown"; const ext=path.extname(file.originalname); cb(null,`${sanitizedEmail}_${timestamp}${ext}`); }
});
const campaignUpload = multer({ storage: campaignStorage });

// ==================== ID VERIFICATION ROUTES ====================
app.post("/api/verify-id",upload.single("idDocument"),async(req,res)=>{
  try{
    const user=req.session.user;
    if(!user||!user.email) return res.status(401).json({success:false,message:"You must be signed in"});
    if(!req.file) return res.status(400).json({success:false,message:"No file uploaded"});
    if(!sheets) return res.status(500).json({success:false,message:"Sheets not initialized"});

    const spreadsheetId=process.env.ID_VERIFICATIONS_SHEET_ID;
    if(!spreadsheetId) return res.status(500).json({success:false,message:"ID_VERIFICATIONS_SHEET_ID not configured"});

    const filePath = path.join("uploads","id-verifications",req.file.filename);
    const timestamp = new Date().toLocaleString();
    const updatedRow=[timestamp,user.email.toLowerCase(),user.name,"pending",filePath];

    const result = await findRowAndUpdateOrAppend(spreadsheetId,"ID_Verifications!A:E",1,user.email,updatedRow);

    await sendMailjetEmail("New ID Verification Submitted",`<p>${user.name} (${user.email}) submitted an ID at ${timestamp}</p>`);

    res.json({success:true,action:result.action,row:result.row});
  }catch(err){ console.error("verify-id error:",err); res.status(500).json({success:false,message:"Failed to submit ID verification"}); }
});

app.get("/api/get-verifications",async(req,res)=>{
  try{
    const user=req.session.user;
    if(!user||!user.email) return res.status(401).json({success:false,message:"Not logged in"});
    if(!sheets) return res.status(500).json({success:false,message:"Sheets not initialized"});

    const spreadsheetId=process.env.ID_VERIFICATIONS_SHEET_ID;
    if(!spreadsheetId) return res.status(500).json({success:false,message:"ID_VERIFICATIONS_SHEET_ID not configured"});

    const rows = await getSheetValues(spreadsheetId,"ID_Verifications!A:E");
    const userRows = rows.filter(r=>(r[1]||"").toLowerCase()===user.email.toLowerCase());
    const latest = userRows.length>0?userRows[userRows.length-1]:null;
    if(!latest) return res.json({success:true,verifications:[]});

    const [timestamp,email,name,status,idPhotoURL] = latest;
    res.json({success:true,verifications:[{timestamp,email,name,status:status||"pending",idImageUrl:idPhotoURL||""}]});
  }catch(err){ console.error("get-verifications error:",err); res.status(500).json({success:false,message:"Failed to read verifications"}); }
});

// ==================== CAMPAIGN ROUTES ====================
app.post("/api/create-campaign",campaignUpload.single("image"),async(req,res)=>{
  try{
    const user=req.session.user;
    if(!user||!user.email) return res.status(401).json({success:false,message:"You must be signed in"});

    const {title,goal,description,category} = req.body;
    if(!title||!goal||!description||!category) return res.status(400).json({success:false,message:"Missing required fields"});
    if(!sheets) return res.status(500).json({success:false,message:"Sheets not initialized"});

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    if(!spreadsheetId) return res.status(500).json({success:false,message:"CAMPAIGNS_SHEET_ID not configured"});

    const campaignId = Date.now().toString();
    const imageUrl = req.file? `/uploads/campaigns/${req.file.filename}`:"https://placehold.co/400x200?text=No+Image";
    const createdAt = new Date().toISOString();
    const status = "Pending";

    const newCampaignRow = [campaignId,title,user.email.toLowerCase(),goal,description,category,status,createdAt,imageUrl];
    await appendSheetValues(spreadsheetId,"A:I",[newCampaignRow]);

    await sendMailjetEmail("New Campaign Submitted",`<p>${user.name} (${user.email}) submitted a campaign titled "${title}"</p>`);

    res.json({success:true,message:"Campaign submitted and pending approval",campaignId});
  }catch(err){ console.error("create-campaign error:",err); res.status(500).json({success:false,message:"Failed to create campaign"}); }
});

app.get("/api/campaigns",async(req,res)=>{
  try{
    const user=req.session.user;
    if(!user||!user.email) return res.status(401).json({success:false,message:"Not logged in"});
    if(!sheets) return res.status(500).json({success:false,message:"Sheets not initialized"});

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    if(!spreadsheetId) return res.status(500).json({success:false,message:"CAMPAIGNS_SHEET_ID not configured"});

    const rows = await getSheetValues(spreadsheetId,"A:I");
    const campaigns = rows.filter(r=>(r[2]||"").toLowerCase()===user.email.toLowerCase()).map(r=>({
      campaignId:r[0], title:r[1], creatorEmail:r[2], goal:r[3], description:r[4], category:r[5],
      status:r[6]? r[6].charAt(0).toUpperCase()+r[6].slice(1).toLowerCase():"Pending",
      createdAt:r[7], imageUrl:r[8]||""
    }));
    res.json({success:true,campaigns});
  }catch(err){ console.error("get-campaigns error:",err); res.status(500).json({success:false,message:"Failed to get campaigns"}); }
});

// ==================== STRIPE DONATION ====================
app.post("/api/create-checkout-session",async(req,res)=>{
  const { campaignId, amount } = req.body;
  if(!campaignId||!amount) return res.status(400).json({error:"Missing campaignId or amount"});
  try{
    if(!sheets) return res.status(500).json({error:"Sheets not initialized"});
    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    const rows = await getSheetValues(spreadsheetId,"A:I");
    const campaign = rows.find(r=>r[0]===campaignId);
    if(!campaign) return res.status(404).json({error:"Campaign not found"});

    const session = await stripe.checkout.sessions.create({
      payment_method_types:["card"],
      line_items:[{
        price_data:{ currency:"usd", product_data:{name:campaign[1]}, unit_amount:parseInt(amount)*100 },
        quantity:1
      }],
      mode:"payment",
      success_url:`${process.env.FRONTEND_URL}/thankyou.html?campaignId=${campaignId}`,
      cancel_url:`${process.env.FRONTEND_URL}/campaigns.html`
    });

    res.json({url:session.url});
  }catch(err){ console.error("Stripe checkout error:",err); res.status(500).json({error:"Failed to create checkout session"}); }
});

// ==================== WAITLIST, VOLUNTEER, STREET TEAM, CONTACT ROUTES ====================
async function handleGenericSubmission(sheetId,messageTitle,bodyFields,res){
  try{
    if(!sheets) return res.status(500).json({success:false,message:"Sheets not initialized"});
    if(!sheetId) return res.status(500).json({success:false,message:`${messageTitle} SHEET_ID not configured`});
    const timestamp = new Date().toLocaleString();
    const rowValues = [timestamp,...bodyFields];
    await appendSheetValues(sheetId,"A:Z",[rowValues]);
    await sendMailjetEmail(messageTitle,`<p>${bodyFields.join(", ")} submitted at ${timestamp}</p>`);
    res.json({success:true,message:`${messageTitle} submitted successfully`});
  }catch(err){ console.error(`${messageTitle} error:`,err); res.status(500).json({success:false,message:`Failed to submit ${messageTitle}`}); }
}

app.post("/api/waitlist",(req,res)=>{
  const { name,email } = req.body;
  if(!name||!email) return res.status(400).json({success:false,message:"Missing fields"});
  handleGenericSubmission(process.env.WAITLIST_SHEET_ID,"New Waitlist Submission",[name,email],res);
});

app.post("/api/volunteer",(req,res)=>{
  const { name,email,role } = req.body;
  if(!name||!email||!role) return res.status(400).json({success:false,message:"Missing fields"});
  handleGenericSubmission(process.env.VOLUNTEER_SHEET_ID,"New Volunteer Submission",[name,email,role],res);
});

app.post("/api/streetteam",(req,res)=>{
  const { name,email,city } = req.body;
  if(!name||!email||!city) return res.status(400).json({success:false,message:"Missing fields"});
  handleGenericSubmission(process.env.STREETTEAM_SHEET_ID,"New Street Team Submission",[name,email,city],res);
});

app.post("/api/contact",(req,res)=>{
  const { name,email,message } = req.body;
  if(!name||!email||!message) return res.status(400).json({success:false,message:"Missing fields"});
  handleGenericSubmission(process.env.CONTACT_SHEET_ID,"New Contact Form Submission",[name,email,message],res);
});

// ==================== START SERVER ====================
app.listen(PORT,()=>console.log(`🚀 JoyFund backend running on port ${PORT}`));
