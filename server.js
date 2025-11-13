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
const crypto = require("crypto");

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
  credentials:true
}));

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
  mailjetClient = mailjetLib.apiConnect(process.env.MAILJET_API_KEY, process.env.MAILJET_API_SECRET);
}
async function sendMailjetEmail(toEmail, subject, htmlContent){
  if(!mailjetClient) return;
  try{
    await mailjetClient.post("send", {'version':'v3.1'}).request({
      Messages:[{
        From: { Email: process.env.MAILJET_SENDER_EMAIL, Name:"JoyFund INC" },
        To: [{ Email: toEmail }],
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
  }
}catch(err){ console.error("Google Sheets init failed", err.message); }

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
  const rows = await getSheetValues(spreadsheetId,rangeCols);
  const rowIndex = rows.findIndex(r=>(r[matchColIndex]||"").toString().trim().toLowerCase() === (matchValue||"").toString().trim().toLowerCase());

  if(rowIndex===-1){
    await appendSheetValues(spreadsheetId,rangeCols,[updatedValues]);
    return {action:"appended",row:rows.length+1};
  }else{
    const rowNumber = rowIndex+1;
    const startCol = rangeCols.split("!")[1].charAt(0);
    const endCol = String.fromCharCode(startCol.charCodeAt(0) + updatedValues.length - 1);
    const updateRange = `${rangeCols.split("!")[0]}!${startCol}${rowNumber}:${endCol}${rowNumber}`;
    await sheets.spreadsheets.values.update({spreadsheetId,range:updateRange,valueInputOption:"USER_ENTERED",resource:{values:[updatedValues]}});
    return {action:"updated",row:rowNumber};
  }
}

// -------------------- MULTER --------------------
const storage = multer.memoryStorage();
const upload = multer({ storage });

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
    const match = await bcrypt.compare(password,(userRow[3]||"").trim());
    if(!match) return res.status(401).json({error:"Invalid credentials"});
    req.session.user = { name:userRow[1], email:userRow[2], joinDate:userRow[0] };
    res.json({ ok:true, user:req.session.user });
  }catch(err){ res.status(500).json({error:"Server error"}); }
});

app.get("/api/check-session",(req,res)=>{ 
  if(req.session.user) res.json({loggedIn:true,user:req.session.user}); 
  else res.json({loggedIn:false}); 
});

app.post("/api/logout",(req,res)=>{ 
  req.session.destroy(err=>{ if(err) return res.status(500).json({error:"Failed to logout"}); res.json({ok:true}); }); 
});

// -------------------- RESET PASSWORD --------------------
// request reset
app.post("/api/request-reset-password", async (req,res)=>{
  try{
    const { email } = req.body;
    if(!email) return res.status(400).json({ error:"Email required" });

    const users = await getUsers();
    const userRow = users.find(u => (u[2]||"").trim().toLowerCase() === email.trim().toLowerCase());
    if(!userRow) return res.status(404).json({ error:"User not found" });

    const token = crypto.randomBytes(32).toString("hex");
    const expiration = Date.now() + 3600*1000; // 1 hour

    const updatedRow = [...userRow];
    updatedRow[4] = token; // reset token
    updatedRow[5] = expiration; // token expiration timestamp

    await findRowAndUpdateOrAppend(process.env.USERS_SHEET_ID,"A:D",2,email,updatedRow);

    const resetLink = `${process.env.FRONTEND_URL}/update-password.html?token=${token}&email=${encodeURIComponent(email)}`;

    await sendMailjetEmail(email,"JoyFund Password Reset",
      `<p>You requested a password reset. Click <a href="${resetLink}">here</a> to reset your password. This link expires in 1 hour.</p>`
    );

    res.json({ success:true, message:"Reset link sent" });
  }catch(err){ console.error(err); res.status(500).json({ error:"Failed to send reset link" }); }
});

// update password
app.post("/api/update-password", async (req,res)=>{
  try{
    const { email,newPassword,token } = req.body;
    if(!email||!newPassword||!token) return res.status(400).json({ error:"Missing fields" });

    const users = await getUsers();
    const userRow = users.find(u => (u[2]||"").trim().toLowerCase() === email.trim().toLowerCase());
    if(!userRow) return res.status(404).json({ error:"User not found" });

    const storedToken = userRow[4];
    const tokenExp = userRow[5];

    if(token !== storedToken || Date.now() > tokenExp) return res.status(400).json({ error:"Invalid or expired token" });

    const hashedPassword = await bcrypt.hash(newPassword,12);
    const updatedRow = [...userRow];
    updatedRow[3] = hashedPassword;
    updatedRow[4] = "";
    updatedRow[5] = "";

    await findRowAndUpdateOrAppend(process.env.USERS_SHEET_ID,"A:D",2,email,updatedRow);

    res.json({ success:true, message:"Password updated successfully" });
  }catch(err){ console.error(err); res.status(500).json({ error:"Failed to update password" }); }
});

// -------------------- WAITLIST SUBMISSION --------------------
app.post("/api/waitlist", async (req, res) => {
  try {
    const { name, email, reason } = req.body;
    if (!name || !email) return res.status(400).json({ success: false, message: "Missing name or email" });
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });

    const spreadsheetId = process.env.WAITLIST_SHEET_ID;
    const timestamp = new Date().toLocaleString();
    await appendSheetValues(spreadsheetId, "Waitlist!A:D", [[timestamp, name, email.toLowerCase(), reason || ""]]);

    await sendMailjetEmail(process.env.NOTIFY_EMAIL, "New Waitlist Submission", `<p>${name} (${email}) joined the waitlist at ${timestamp}. Reason: ${reason || "N/A"}</p>`);

    res.json({ success: true, message: "Waitlist submission successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to submit waitlist" });
  }
});

// -------------------- VOLUNTEER SUBMISSION --------------------
app.post("/api/volunteer", async (req, res) => {
  try {
    const { name, email, role, availability } = req.body;
    if (!name || !email || !role) return res.status(400).json({ success: false, message: "Missing required fields" });
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });

    const spreadsheetId = process.env.VOLUNTEERS_SHEET_ID;
    const timestamp = new Date().toLocaleString();
    await appendSheetValues(spreadsheetId, "Volunteers!A:E", [[timestamp, name, email.toLowerCase(), role, availability || ""]]);

    await sendMailjetEmail(process.env.NOTIFY_EMAIL, "New Volunteer Submission", `<p>${name} (${email}) signed up as a volunteer for ${role} at ${timestamp}. Availability: ${availability || "N/A"}</p>`);

    res.json({ success: true, message: "Volunteer submission successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to submit volunteer" });
  }
});

// -------------------- STREET TEAM --------------------
app.post("/api/street-team", async (req, res) => {
  try {
    const { name, email, city, hoursAvailable } = req.body;
    if (!name || !email || !city) return res.status(400).json({ success: false, message: "Missing required fields" });
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });

    const spreadsheetId = process.env.STREET_TEAM_SHEET_ID;
    const timestamp = new Date().toLocaleString();
    await appendSheetValues(spreadsheetId, "StreetTeam!A:E", [[timestamp, name, email.toLowerCase(), city, hoursAvailable || ""]]);

    await sendMailjetEmail(process.env.NOTIFY_EMAIL, "New Street Team Submission", `<p>${name} (${email}) joined the street team in ${city} at ${timestamp}. Hours Available: ${hoursAvailable || "N/A"}</p>`);

    res.json({ success: true, message: "Street team submission successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to submit street team" });
  }
});

// -------------------- ID VERIFICATION --------------------
app.post("/api/verify-id", upload.single("idDocument"), async (req,res)=>{
  try{
    const user=req.session.user;
    if(!user) return res.status(401).json({success:false,message:"Sign in required"});
    if(!req.file) return res.status(400).json({success:false,message:"No file uploaded"});
    if(!sheets) return res.status(500).json({success:false,message:"Sheets not initialized"});

    const spreadsheetId=process.env.ID_VERIFICATIONS_SHEET_ID;

    const uploadResult = await new Promise((resolve,reject)=>{
      const stream = cloudinary.uploader.upload_stream({ folder: "joyfund/id-verifications" }, (err,result)=>{ if(err) reject(err); else resolve(result); });
      stream.end(req.file.buffer);
    });

    const fileUrl = uploadResult.secure_url;
    const timestamp = new Date().toLocaleString();
    const updatedRow=[timestamp,user.email.toLowerCase(),user.name,"Pending",fileUrl];

    await findRowAndUpdateOrAppend(spreadsheetId,"ID_Verifications!A:E",1,user.email,updatedRow);
    await sendMailjetEmail(process.env.NOTIFY_EMAIL,"New ID Verification Submitted",`<p>${user.name} (${user.email}) submitted an ID at ${timestamp}</p>`);

    res.json({success:true,message:"ID submitted",fileUrl});
  }catch(err){ res.status(500).json({success:false,message:"Failed to submit ID verification"}); }
});

app.get("/api/get-verifications", async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).json({ success: false, message: "Sign in required" });
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });

    const spreadsheetId = process.env.ID_VERIFICATIONS_SHEET_ID;
    const rows = await getSheetValues(spreadsheetId, "ID_Verifications!A:E");
    const userRows = rows.filter(r => (r[1] || "").toLowerCase() === user.email.toLowerCase());

    res.json({ success: true, verifications: userRows.map(r => ({
      timestamp: r[0],
      email: r[1],
      name: r[2],
      status: r[3] === "Approved" ? "Verified" : (r[3] || "Pending"),
      idImageUrl: r[4] || ""
    })) });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to fetch verifications" });
  }
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
    await sendMailjetEmail(process.env.NOTIFY_EMAIL,"New Campaign Submitted",`<p>${user.name} (${user.email}) submitted a campaign titled "${title}"</p>`);

    res.json({success:true,message:"Campaign submitted",campaignId});
  }catch(err){ res.status(500).json({success:false,message:"Failed to create campaign"}); }
});

// -------------------- GET USER CAMPAIGNS --------------------
app.get("/api/campaigns", async (req,res)=>{
  try{
    const user = req.session.user;
    if(!user) return res.status(401).json({success:false,message:"Sign in required"});
    if(!sheets) return res.status(500).json({success:false,message:"Sheets not initialized"});

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    const rows = await getSheetValues(spreadsheetId,"A:I");

    const userCampaigns = rows
      .filter(r => (r[2] || "").toLowerCase() === user.email.toLowerCase())
      .map(r => ({
        campaignId: r[0],
        title: r[1],
        creator: r[2],
        goal: r[3],
        description: r[4],
        category: r[5],
        status: r[6],
        createdAt: r[7],
        imageUrl: r[8]
      }));

    res.json({success:true,campaigns:userCampaigns});
  }catch(err){ res.status(500).json({success:false,message:"Failed to fetch campaigns"}); }
});

// -------------------- SEARCH CAMPAIGNS --------------------
app.get("/api/search-campaigns", async (req,res)=>{
  try{
    const { category, minGoal } = req.query;
    if(!sheets) return res.status(500).json({success:false,message:"Sheets not initialized"});

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    const rows = await getSheetValues(spreadsheetId,"A:I");

    let results = rows.map(r=>({
      campaignId: r[0],
      title: r[1],
      creator: r[2],
      goal: r[3],
      description: r[4],
      category: r[5],
      status: r[6],
      createdAt: r[7],
      imageUrl: r[8]
    }));

    if(category) results = results.filter(c=>c.category.toLowerCase()===category.toLowerCase());
    if(minGoal) results = results.filter(c=>parseFloat(c.goal)>=parseFloat(minGoal));

    res.json({success:true,campaigns:results});
  }catch(err){ res.status(500).json({success:false,message:"Failed to search campaigns"}); }
});

// -------------------- STRIPE PAYMENT --------------------
app.post("/api/donate", async (req,res)=>{
  try{
    const { campaignId,amount } = req.body;
    if(!campaignId||!amount) return res.status(400).json({success:false,message:"Missing fields"});

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    const rows = await getSheetValues(spreadsheetId,"A:I");
    const campaign = rows.find(r=>r[0]===campaignId);
    if(!campaign) return res.status(404).json({success:false,message:"Campaign not found"});

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount*100),
      currency: "usd",
      description: `Donation for campaign ${campaign[1]}`,
      receipt_email: req.session.user?.email||undefined
    });

    res.json({success:true,clientSecret:paymentIntent.client_secret});
  }catch(err){ console.error(err); res.status(500).json({success:false,message:"Payment failed"}); }
});

// -------------------- START SERVER --------------------
app.listen(PORT, ()=>{ console.log(`JoyFund backend running on port ${PORT}`); });
