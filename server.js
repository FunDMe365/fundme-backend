// ==================== SERVER.JS - FULL JOYFUND BACKEND ====================

const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const multer = require("multer");
const crypto = require("crypto");
const Stripe = require("stripe");
const { google } = require("googleapis");
const mailjetLib = require("node-mailjet");
const cloudinary = require("cloudinary").v2;
require("dotenv").config();

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "FunDMe$123";

const app = express();
const PORT = process.env.PORT || 5000;

// -------------------- CORS --------------------
const cors = require("cors");
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(o => o.trim())
  .filter(o => o.length > 0);

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("CORS not allowed: " + origin));
  },
  credentials: true
}));

app.options("*", cors({ origin: allowedOrigins, credentials: true }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// -------------------- BODY PARSER --------------------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// -------------------- SESSION --------------------
app.set('trust proxy', 1);
app.use(session({
  name: 'sessionId',
  secret: process.env.SESSION_SECRET || 'supersecretkey',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 24
  }
}));

// -------------------- STRIPE --------------------
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");

// ==================== HELPER FUNCTION ====================
function calculateDonationSplit(donationAmount) {
  const stripeFee = donationAmount * 0.027 + 0.30; // Stripe fee
  const joyFundFee = donationAmount * 0.05;        // JoyFund fee
  const campaignAmount = donationAmount - stripeFee - joyFundFee;

  return {
    donationAmount,
    stripeFee,
    joyFundFee,
    campaignAmount,
    timestamp: new Date(),
  };
}

// ==================== STRIPE CHECKOUT SESSION ====================
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { amount, successUrl, cancelUrl } = req.body;

    if (!campaignId || !amount || !successUrl || !cancelUrl) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    const amountInCents = Math.round(amount * 100);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `Donation to campaign ${campaignId}` },
          unit_amount: amountInCents,
        },
        quantity: 1
      }],
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { campaignId, donationAmount: amount }
    });

    res.json({ success: true, sessionId: session.id });

  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ success: false, message: "Failed to create checkout session" });
  }
});

// ==================== STRIPE WEBHOOK ====================
app.post("/webhook", express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const donationAmount = session.metadata.donationAmount
      ? parseFloat(session.metadata.donationAmount)
      : 0;

    const split = calculateDonationSplit(donationAmount);
    console.log("Donation split recorded:", split);
  }

  res.status(200).json({ received: true });
});

// -------------------- MAILJET --------------------
let mailjetClient = null;
if (process.env.MAILJET_API_KEY && process.env.MAILJET_API_SECRET) {
  mailjetClient = mailjetLib.apiConnect(process.env.MAILJET_API_KEY, process.env.MAILJET_API_SECRET);
}
async function sendMailjetEmail(subject, htmlContent, toEmail) {
  if (!mailjetClient) return;
  try {
    await mailjetClient.post("send", { version: "v3.1" }).request({
      Messages: [{
        From: { Email: process.env.MAILJET_SENDER_EMAIL || process.env.EMAIL_FROM || "admin@fundasmile.net", Name: "JoyFund INC" },
        To: [{ Email: toEmail || process.env.NOTIFY_EMAIL }],
        Subject: subject,
        HTMLPart: htmlContent
      }]
    });
  } catch (err) { console.error("Mailjet error:", err); }
}

// -------------------- GOOGLE SHEETS --------------------
let sheets;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    sheets = google.sheets({ version: "v4", auth });
  }
} catch (err) { console.error("Google Sheets init failed", err.message); }

async function getSheetValues(spreadsheetId, range) {
  if (!sheets || !spreadsheetId) return [];
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function appendSheetValues(spreadsheetId, range, values) {
  if (!sheets || !spreadsheetId) throw new Error("Sheets not initialized or missing spreadsheetId");
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    resource: { values }
  });
}

// -------------------- MULTER --------------------
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ==================== LIVE VISITOR TRACKING ====================
const liveVisitors = {};

app.post("/api/track-visitor", (req, res) => {
  try {
    const { visitorId, page } = req.body;
    if (!visitorId) return res.status(400).json({ success: false, message: "Missing visitorId" });

    const now = Date.now();
    liveVisitors[visitorId] = now;

    for (const id in liveVisitors) {
      if (now - liveVisitors[id] > 30000) delete liveVisitors[id];
    }

    res.json({ success: true, activeCount: Object.keys(liveVisitors).length });
  } catch (err) {
    console.error("Visitor tracking error:", err);
    res.status(500).json({ success: false });
  }
});

// ==================== USERS & AUTH ====================
async function getUsers() {
  if (!process.env.USERS_SHEET_ID) return [];
  const rows = await getSheetValues(process.env.USERS_SHEET_ID, "A:D");
  return rows.map(r => ({
    joinDate: r[0],
    name: r[1],
    email: r[2],
    password: r[3]
  }));
}

app.post("/api/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });
    const users = await getUsers();
    const emailLower = email.trim().toLowerCase();
    if (users.some(u => u.email.toLowerCase() === emailLower)) return res.status(409).json({ error: "Email already exists" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const timestamp = new Date().toISOString();
    await appendSheetValues(process.env.USERS_SHEET_ID, "A:D", [[timestamp, name, emailLower, hashedPassword]]);
    req.session.user = { name, email: emailLower, joinDate: timestamp };
    res.json({ ok: true, loggedIn: true, user: req.session.user });
  } catch (err) { console.error(err); res.status(500).json({ error: "Signup failed" }); }
});

app.post("/api/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });
    const users = await getUsers();
    const inputEmail = email.trim().toLowerCase();
    const user = users.find(u => u.email.toLowerCase() === inputEmail);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const match = await bcrypt.compare(password, user.password || "");
    if (!match) return res.status(401).json({ error: "Invalid credentials" });
    req.session.user = { name: user.name, email: user.email, joinDate: user.joinDate };
    res.json({ ok: true, loggedIn: true, user: req.session.user });
  } catch (err) { console.error(err); res.status(500).json({ error: "Signin failed" }); }
});

// -------------------- CHECK SESSION --------------------
app.get("/api/check-session", (req, res) => {
  if (req.session.user) {
    const u = req.session.user;
    return res.json({
      loggedIn: true,
      user: u,
      name: u.name || null,
      email: u.email || null,
      joinDate: u.joinDate || null
    });
  } else {
    return res.json({ loggedIn: false, user: null });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(err => err ? res.status(500).json({ error: "Logout failed" }) : res.json({ ok: true }));
});

// ==================== ID VERIFICATION ====================
app.post("/api/verify-id", upload.single("idImage"), async (req, res) => {
  try {
    const userEmail = req.session?.user?.email?.toLowerCase();
    if (!userEmail) return res.status(401).json({ success: false, message: "Not logged in" });
    if (!req.file) return res.status(400).json({ success: false, message: "No ID uploaded" });

    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "joyfund/id_verifications" },
        (err, result) => err ? reject(err) : resolve(result)
      );
      stream.end(req.file.buffer);
    });

    const timestamp = new Date().toISOString();
    const status = "Pending";
    await appendSheetValues(process.env.ID_VERIFICATION_SHEET_ID, "ID_Verifications!A:E", [
      [timestamp, userEmail, "", status, uploadResult.secure_url]
    ]);

    res.json({ success: true, message: "ID submitted successfully", idImageUrl: uploadResult.secure_url });

  } catch (err) {
    console.error("ID Verification error:", err);
    res.status(500).json({ success: false, message: "Failed to submit ID", error: err.message });
  }
});

app.get("/api/my-verifications", async (req, res) => {
  try {
    const userEmail = req.session?.user?.email?.toLowerCase();
    if (!userEmail) return res.status(401).json({ success: false, verifications: [] });
    const rows = await getSheetValues(process.env.ID_VERIFICATION_SHEET_ID, "ID_Verifications!A:E");
    const verifications = rows
      .filter(r => (r[1] || "").toLowerCase() === userEmail)
      .map(r => ({ timestamp: r[0], email: r[1], status: r[3] || "Pending", idImageUrl: r[4] || "" }));
    res.json({ success: true, verifications });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, verifications: [] });
  }
});

// ==================== CAMPAIGNS ====================
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  try {
    const user = req.session.user;
    if (!user) return res.status(401).json({ success: false });
    const { title, goal, description, category } = req.body;
    if (!title || !goal || !description || !category) return res.status(400).json({ success: false });

    let imageUrl = "https://placehold.co/400x200?text=No+Image";
    if (req.file) {
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder: "joyfund/campaigns" }, (err, result) => err ? reject(err) : resolve(result));
        stream.end(req.file.buffer);
      });
      imageUrl = uploadResult.secure_url;
    }

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    const campaignId = Date.now().toString();
    const createdAt = new Date().toISOString();
    const status = "Pending";
    const newCampaignRow = [campaignId, title, user.email.toLowerCase(), goal, description, category, status, createdAt, imageUrl];
    await appendSheetValues(spreadsheetId, "A:I", [newCampaignRow]);

    await sendMailjetEmail("New Campaign Submitted", `<p>${user.name} (${user.email}) submitted a campaign titled "${title}"</p>`);

    res.json({ success: true, message: "Campaign submitted", campaignId });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to create campaign" });
  }
});

app.get("/api/my-campaigns", async (req,res)=>{
  try{
    const user = req.session.user;
    if(!user) return res.status(401).json({ campaigns: [] });
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID, "A:I");
    const campaigns = rows.filter(r=>(r[2]||"").toLowerCase()===user.email.toLowerCase()).map(r=>({
      campaignId:r[0],title:r[1],creator:r[2],goal:r[3],description:r[4],category:r[5],status:r[6],createdAt:r[7],imageUrl:r[8]||"https://placehold.co/400x200?text=No+Image"
    }));
    res.json({ success:true, campaigns });
  }catch(err){ console.error(err); res.status(500).json({ campaigns: [] }); }
});

app.get("/api/public-campaigns", async (req,res)=>{
  try{
    const rows = await getSheetValues(process.env.CAMPAIGNS_SHEET_ID,"A:I");
    const campaigns = rows.filter(r=>["Approved","active"].includes(r[6])).map(r=>({
      campaignId:r[0],title:r[1],creator:r[2],goal:r[3],description:r[4],category:r[5],status:r[6],createdAt:r[7],imageUrl:r[8]||"https://placehold.co/400x200?text=No+Image"
    }));
    res.json({success:true,campaigns});
  }catch(err){ console.error(err); res.status(500).json({success:false}); }
});

// ==================== START SERVER ====================
app.listen(PORT, () => { console.log(`JoyFund backend running on port ${PORT}`); });
