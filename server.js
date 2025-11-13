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

// -------------------- STRIPE CHECKOUT --------------------
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { amount, successUrl, cancelUrl } = req.body;
    if (!amount || !successUrl || !cancelUrl) {
      return res.status(400).json({ error: "Missing required fields" });
    }
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
async function sendMailjetEmail(subject, htmlContent){
  if(!mailjetClient) return;
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

// -------------------- WAITLIST --------------------
app.post("/api/waitlist", async (req, res) => {
  try {
    const { name, email, reason } = req.body;
    if (!name || !email) return res.status(400).json({ success: false, message: "Missing name or email" });
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });
    const spreadsheetId = process.env.WAITLIST_SHEET_ID;
    const timestamp = new Date().toLocaleString();
    await appendSheetValues(spreadsheetId, "Waitlist!A:D", [[timestamp, name, email.toLowerCase(), reason || ""]]);
    await sendMailjetEmail("New Waitlist Submission", `<p>${name} (${email}) joined the waitlist at ${timestamp}. Reason: ${reason || "N/A"}</p>`);
    res.json({ success: true, message: "Waitlist submission successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to submit waitlist" });
  }
});

// -------------------- VOLUNTEER --------------------
app.post("/api/volunteer", async (req, res) => {
  try {
    const { name, email, role, availability } = req.body;
    if (!name || !email || !role) return res.status(400).json({ success: false, message: "Missing required fields" });
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });
    const spreadsheetId = process.env.VOLUNTEERS_SHEET_ID;
    const timestamp = new Date().toLocaleString();
    await appendSheetValues(spreadsheetId, "Volunteers!A:E", [[timestamp, name, email.toLowerCase(), role, availability || ""]]);
    await sendMailjetEmail("New Volunteer Submission", `<p>${name} (${email}) signed up as a volunteer for ${role} at ${timestamp}. Availability: ${availability || "N/A"}</p>`);
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
    await sendMailjetEmail("New Street Team Submission", `<p>${name} (${email}) joined the street team in ${city} at ${timestamp}. Hours Available: ${hoursAvailable || "N/A"}</p>`);
    res.json({ success: true, message: "Street team submission successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to submit street team" });
  }
});

// -------------------- USERS --------------------
async function getUsers(){ 
  if(!process.env.USERS_SHEET_ID) return []; 
  return getSheetValues(process.env.USERS_SHEET_ID,"A:F"); // includes Reset Token/Expiration
}

async function updateUserRow(rowIndex, updatedRow){
  const spreadsheetId = process.env.USERS_SHEET_ID;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `A${rowIndex+1}:F${rowIndex+1}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [updatedRow] }
  });
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

// -------------------- PASSWORD RESET --------------------

// Request password reset
app.post("/api/auth/forgot-password", async (req,res)=>{
  const { email } = req.body;
  if(!email) return res.status(400).json({message:"Email required"});
  try {
    const users = await getUsers();
    const userIndex = users.findIndex(u => (u[2]||"").trim().toLowerCase() === email.trim().toLowerCase());
    if(userIndex===-1) return res.status(404).json({message:"User not found"});

    const token = crypto.randomBytes(32).toString("hex");
    const expiration = Date.now() + 3600000; // 1 hour
    const updatedRow = [...users[userIndex]];
    updatedRow[4] = token; // Reset Token
    updatedRow[5] = expiration; // Token Expiration

    await updateUserRow(userIndex, updatedRow);

    const resetLink = `https://fundasmile.net/update-password.html?token=${token}`;

    await sendMailjetEmail(
      "JoyFund Password Reset",
      `<p>Hello ${updatedRow[1]},</p>
      <p>You requested a password reset. Click below to set a new password:</p>
      <a href="${resetLink}" target="_blank">${resetLink}</a>
      <p>If you did not request this, you can ignore this email.</p>`
    );

    res.json({message:"Password reset link sent to your email"});
  } catch(err){
    console.error("Forgot password error:",err);
    res.status(500).json({message:"Server error"});
  }
});

// Reset password using token
app.post("/api/auth/reset-password", async (req,res)=>{
  const { token, password } = req.body;
  if(!token || !password) return res.status(400).json({message:"Token and password required"});
  try{
    const users = await getUsers();
    const userIndex = users.findIndex(u => (u[4]||"")===token && (parseInt(u[5])||0) > Date.now());
    if(userIndex===-1) return res.status(400).json({message:"Invalid or expired token"});

    const hashedPassword = await bcrypt.hash(password, 10);
    const updatedRow = [...users[userIndex]];
    updatedRow[3] = hashedPassword; // update password
    updatedRow[4] = ""; // clear token
    updatedRow[5] = ""; // clear expiration

    await updateUserRow(userIndex, updatedRow);
    res.json({message:"Password successfully updated"});
  } catch(err){
    console.error("Reset password error:",err);
    res.status(500).json({message:"Server error"});
  }
});

// -------------------- MULTER --------------------
const storage = multer.memoryStorage();
const upload = multer({ storage });

// -------------------- ID VERIFICATION --------------------
// ... (your existing code remains unchanged)

// -------------------- CAMPAIGNS --------------------
// ... (your existing code remains unchanged)

// -------------------- START SERVER --------------------
app.listen(PORT,()=>console.log(`🚀 JoyFund backend running on port ${PORT}`));
