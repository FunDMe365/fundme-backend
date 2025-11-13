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
const crypto = require("crypto"); // For secure token generation

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

// -------------------- STRIPE CHECKOUT --------------------
const stripe = Stripe(process.env.STRIPE_SECRET_KEY||"");

// -------------------- STRIPE CHECKOUT --------------------
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { amount, successUrl, cancelUrl } = req.body;
    if (!amount || !successUrl || !cancelUrl) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Amount in cents
    const amountCents = Math.round(amount * 100);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `JoyFund Donation - ${campaignId}` },
          unit_amount: amountCents,
        },
        quantity: 1
      }],
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

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

// -------------------- MULTER --------------------
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

    const uploadResult = await new Promise((resolve,reject)=>{
      const stream = cloudinary.uploader.upload_stream({ folder: "joyfund/id-verifications" }, (err,result)=>{ if(err) reject(err); else resolve(result); });
      stream.end(req.file.buffer);
    });

    const fileUrl = uploadResult.secure_url;
    const timestamp = new Date().toLocaleString();
    const updatedRow=[timestamp,user.email.toLowerCase(),user.name,"Pending",fileUrl];

    await findRowAndUpdateOrAppend(spreadsheetId,"ID_Verifications!A:E",1,user.email,updatedRow);
    await sendMailjetEmail(process.env.NOTIFY_EMAIL, "New ID Verification Submitted", `<p>${user.name} (${user.email}) submitted an ID at ${timestamp}</p>`);

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

// -------------------- PASSWORD RESET --------------------

// Request reset link
app.post("/api/request-password-reset", async (req, res) => {
  const { email } = req.body;
  if(!email) return res.status(400).json({ success:false, message:"Email required" });
  try{
    const users = await getUsers();
    const userRowIndex = users.findIndex(u=>u[2] && u[2].trim().toLowerCase()===email.trim().toLowerCase());
    if(userRowIndex===-1) return res.status(404).json({ success:false, message:"Email not found" });

    // Generate token
    const token = crypto.randomBytes(32).toString("hex");
    const expiry = Date.now() + 3600*1000; // 1 hour
    users[userRowIndex][4] = token;  // column E (index 4) = token
    users[userRowIndex][5] = expiry; // column F (index 5) = expiry timestamp

    // Save updated row
    const spreadsheetId = process.env.USERS_SHEET_ID;
    const startCol = "A"; // starts at column A
    const endCol = "F";
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range:`A${userRowIndex+1}:${endCol}${userRowIndex+1}`,
      valueInputOption:"USER_ENTERED",
      resource:{ values: [users[userRowIndex]] }
    });

    const resetUrl = `${process.env.FRONTEND_URL || "https://fundasmile.net"}/reset-password.html?token=${token}&email=${encodeURIComponent(email)}`;

    await sendMailjetEmail(email, "JoyFund Password Reset", `<p>Click <a href="${resetUrl}">here</a> to reset your password. This link expires in 1 hour.</p>`);

    res.json({ success:true, message:"Password reset email sent" });
  }catch(err){
    console.error(err);
    res.status(500).json({ success:false, message:"Failed to request password reset" });
  }
});

// Reset password
app.post("/api/reset-password", async (req, res) => {
  const { email, token, newPassword } = req.body;
  if(!email || !token || !newPassword) return res.status(400).json({ success:false, message:"Missing fields" });
  try{
    const users = await getUsers();
    const userRowIndex = users.findIndex(u=>u[2] && u[2].trim().toLowerCase()===email.trim().toLowerCase());
    if(userRowIndex===-1) return res.status(404).json({ success:false, message:"Email not found" });

    const savedToken = users[userRowIndex][4];
    const expiry = users[userRowIndex][5];

    if(savedToken !== token || Date.now() > expiry) return res.status(400).json({ success:false, message:"Invalid or expired token" });

    const hashed = await bcrypt.hash(newPassword, 10);
    users[userRowIndex][3] = hashed; // password column

    // Remove token and expiry
    users[userRowIndex][4] = "";
    users[userRowIndex][5] = "";

    // Save updated row
    const spreadsheetId = process.env.USERS_SHEET_ID;
    const startCol = "A";
    const endCol = "F";
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range:`A${userRowIndex+1}:${endCol}${userRowIndex+1}`,
      valueInputOption:"USER_ENTERED",
      resource:{ values: [users[userRowIndex]] }
    });

    res.json({ success:true, message:"Password updated successfully" });

  }catch(err){
    console.error(err);
    res.status(500).json({ success:false, message:"Failed to reset password" });
  }
});

// -------------------- CAMPAIGNS --------------------
// ... keep all your original /api/create-campaign, /api/campaigns, /api/update-campaign, /api/public-campaigns, /api/search-campaigns routes exactly as before
// Your original code remains here intact for all other features

// -------------------- START SERVER --------------------
app.listen(PORT,()=>console.log(`🚀 JoyFund backend running on port ${PORT}`));
