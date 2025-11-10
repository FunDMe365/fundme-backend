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
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
const PORT = process.env.PORT || 5000;

// ==================== ✅ CORS CONFIG ==================== 
const allowedOrigins = [
  "https://fundasmile.net", 
  "https://fundme-backend.onrender.com", 
  "http://localhost:5000", 
  "http://127.0.0.1:5000"
];

app.use(cors({ 
  origin: function(origin, callback) {
    if (!origin) return callback(null, true); // allow Postman, mobile apps 
    if (allowedOrigins.includes(origin)) return callback(null, true); 
    return callback(new Error('CORS policy: Not allowed by origin ' + origin)); 
  }, 
  credentials: true 
}));

app.options("*", cors({ origin: allowedOrigins, credentials: true }));

app.use((req, res, next) => { 
  const origin = req.headers.origin; 
  if (allowedOrigins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin); 
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"); 
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization"); 
  res.setHeader("Access-Control-Allow-Credentials", "true"); 
  if (req.method === "OPTIONS") return res.sendStatus(200); 
  next(); 
});

// ==================== Middleware ==================== 
app.use(bodyParser.json()); 
app.use(bodyParser.urlencoded({ extended: true }));

// ==================== ✅ SESSION CONFIG ==================== 
app.set("trust proxy", 1); // for Render/HTTPS
app.use(session({
  secret: process.env.SESSION_SECRET || "secret",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" ? true : false,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

// ==================== Stripe & Mailjet ====================
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");
const mailjetClient = mailjet.apiConnect(
  process.env.MAILJET_API_KEY || "",
  process.env.MAILJET_API_SECRET || ""
);

// ==================== Google Sheets ====================
let sheets;
try {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    sheets = google.sheets({ version: "v4", auth });
    console.log("✅ Google Sheets initialized");
  } else {
    console.warn("⚠️ GOOGLE_CREDENTIALS_JSON not provided; Sheets disabled.");
  }
} catch (err) {
  console.error("❌ Google Sheets init failed", err && err.message);
}

// ==================== Helpers ====================
async function getSheetValues(spreadsheetId, range) {
  if (!sheets) return [];
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function appendSheetValues(spreadsheetId, range, values) {
  if (!sheets) throw new Error("Sheets not initialized");
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    resource: { values },
  });
}

async function findRowAndUpdateOrAppend(spreadsheetId, rangeCols, matchColIndex, matchValue, updatedValues) {
  if (!sheets) throw new Error("Sheets not initialized");

  let sheetName = "";
  let range = "";
  if (rangeCols.includes("!")) [sheetName, range] = rangeCols.split("!");
  else range = rangeCols;

  const rows = await getSheetValues(spreadsheetId, rangeCols);
  const rowIndex = rows.findIndex(r => (r[matchColIndex] || "").toString().trim().toLowerCase() === (matchValue || "").toString().trim().toLowerCase());

  if (rowIndex === -1) {
    await appendSheetValues(spreadsheetId, rangeCols, [updatedValues]);
    return { action: "appended", row: rows.length + 1 };
  } else {
    const [startCol, endCol] = range.split(":");
    const rowNumber = rowIndex + 1;
    const updateRange = sheetName ? `${sheetName}!${startCol}${rowNumber}:${endCol}${rowNumber}` : `${startCol}${rowNumber}:${endCol}${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: updateRange,
      valueInputOption: "USER_ENTERED",
      resource: { values: [updatedValues] }
    });
    return { action: "updated", row: rowNumber };
  }
}

// ==================== USERS ====================
async function getUsers() {
  if (!process.env.USERS_SHEET_ID) return [];
  return getSheetValues(process.env.USERS_SHEET_ID, "A:D");
}

// ==================== SIGN IN / SESSION ====================
app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing email or password" });

  try {
    const users = await getUsers();
    const inputEmail = email.trim().toLowerCase();
    const userRow = users.find(u => u[2] && u[2].trim().toLowerCase() === inputEmail);

    if (!userRow) return res.status(401).json({ error: "Invalid credentials" });

    const storedHash = (userRow[3] || "").trim();
    const match = await bcrypt.compare(password, storedHash);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    req.session.user = { name: userRow[1], email: userRow[2], joinDate: userRow[0] };
    console.log("✅ User signed in:", req.session.user);

    res.json({ ok: true, user: req.session.user });
  } catch (err) {
    console.error("signin error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/check-session", (req, res) => {
  if (req.session.user) res.json({ loggedIn: true, user: req.session.user });
  else res.json({ loggedIn: false });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Failed to logout" });
    res.json({ ok: true });
  });
});

// ==================== ✅ ID VERIFICATION ====================
// keep original storage variable name 'storage' and multer instance 'upload' (as originally)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "uploads", "id-verifications");
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const sanitizedEmail = req.session.user?.email.replace(/[@.]/g, "_") || "unknown";
    const ext = path.extname(file.originalname);
    cb(null, `${sanitizedEmail}_${timestamp}${ext}`);
  }
});
const upload = multer({ storage });

app.post("/api/verify-id", upload.single("idDocument"), async (req, res) => {
  try {
    const user = req.session.user;
    if (!user || !user.email) return res.status(401).json({ success: false, message: "You must be signed in to submit." });
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded." });
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });

    const spreadsheetId = process.env.ID_VERIFICATIONS_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ success: false, message: "ID_VERIFICATIONS_SHEET_ID not configured" });

    const filePath = path.join("uploads", "id-verifications", req.file.filename);
    const timestamp = new Date().toLocaleString();
    const updatedRow = [timestamp, user.email.toLowerCase(), user.name, "pending", filePath];

    const result = await findRowAndUpdateOrAppend(
      spreadsheetId,
      "ID_Verifications!A:E",
      1,
      user.email,
      updatedRow
    );

    console.log("verify-id result:", result);
    res.json({ success: true, action: result.action, row: result.row });
  } catch (err) {
    console.error("verify-id error:", err);
    res.status(500).json({ success: false, message: "Failed to submit ID verification" });
  }
});

app.get("/api/get-verifications", async (req, res) => {
  try {
    if (!sheets) return res.status(500).json({ success:false, message:"Sheets not initialized" });
    const user = req.session.user;
    if (!user || !user.email) return res.status(401).json({ success:false, message:"Not logged in" });

    const spreadsheetId = process.env.ID_VERIFICATIONS_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ success:false, message:"ID_VERIFICATIONS_SHEET_ID not configured" });

    const rows = await getSheetValues(spreadsheetId, "ID_Verifications!A:E");
    const userRows = rows.filter(r => (r[1]||"").toLowerCase() === user.email.toLowerCase());
    const latest = userRows.length > 0 ? userRows[userRows.length-1] : null;

    if (!latest) return res.json({ success:true, verifications: [] });

    const [timestamp, email, name, status, idPhotoURL] = latest;
    res.json({ success:true, verifications:[{ timestamp, email, name, status: status || "pending", idImageUrl: idPhotoURL || "" }] });
  } catch(err){
    console.error("get-verifications error:", err);
    res.status(500).json({ success:false, message:"Failed to read verifications" });
  }
});

// ==================== CAMPAIGN STORAGE ====================
// single declaration placed after session middleware so req.session is available in filename()
const campaignStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "uploads", "campaigns");
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const sanitizedEmail = req.session.user?.email.replace(/[@.]/g, "_") || "unknown";
    const ext = path.extname(file.originalname);
    cb(null, `${sanitizedEmail}_${timestamp}${ext}`);
  }
});
const campaignUpload = multer({ storage: campaignStorage });

// ==================== CREATE CAMPAIGN ====================
app.post("/api/create-campaign", campaignUpload.single("image"), async (req, res) => {
  try {
    const user = req.session.user;
    if (!user || !user.email)
      return res.status(401).json({ success: false, message: "You must be signed in" });

    const { title, goal, description, category } = req.body;
    if (!title || !goal || !description || !category)
      return res.status(400).json({ success: false, message: "Missing required fields" });

    // ✅ Ensure Google Sheets client is available
    if (!sheets) {
      console.error("Sheets client not initialized");
      return res.status(500).json({ success: false, message: "Sheets not initialized" });
    }

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    if (!spreadsheetId) {
      console.error("CAMPAIGNS_SHEET_ID not set in .env");
      return res.status(500).json({ success: false, message: "CAMPAIGNS_SHEET_ID not configured" });
    }

    // ✅ Create uploads folder if missing (Render resets local storage)
    const fs = require("fs");
    const path = require("path");
    const uploadDir = path.join(__dirname, "uploads", "campaigns");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    // ✅ Generate unique ID
    const campaignId = Date.now().toString();

    // ✅ Handle uploaded image
    let imageUrl = "";
    if (req.file) {
      imageUrl = `/uploads/campaigns/${req.file.filename}`;
    } else {
      imageUrl = "https://placehold.co/400x200?text=No+Image";
    }

    const createdAt = new Date().toISOString();
    const status = "Pending"; // ✅ Display properly capitalized "Pending"

    const newCampaignRow = [
      campaignId,          // Id
      title,               // Title
      user.email.toLowerCase(), // Email
      goal,                // Goal
      description,         // Description
      category,            // Category
      status,              // Status
      createdAt,           // CreatedAt
      imageUrl             // ImageURL
    ];

    // ✅ Append to Google Sheet
    await appendSheetValues(spreadsheetId, "A:I", [newCampaignRow]);

    console.log("✅ New campaign added:", newCampaignRow);
    res.json({ success: true, message: "Campaign submitted and pending approval", campaignId });

  } catch (err) {
    console.error("❌ create-campaign error:", err.message || err);
    res.status(500).json({ success: false, message: "Failed to create campaign" });
  }
});


// ==================== GET CAMPAIGNS ====================
app.get("/api/campaigns", async (req, res) => {
  try {
    if (!sheets) return res.status(500).json({ success:false, message:"Sheets not initialized" });
    const user = req.session.user;
    if (!user || !user.email) return res.status(401).json({ success:false, message:"Not logged in" });

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ success:false, message:"CAMPAIGNS_SHEET_ID not configured" });

    const rows = await getSheetValues(spreadsheetId, "A:I");
    const userCampaigns = rows
      .filter(r => (r[2]||"").toLowerCase() === user.email.toLowerCase())
      .map(r => ({
        campaignId: r[0],
        title: r[1],
        creatorEmail: r[2],
        goal: r[3],
        description: r[4],
        category: r[5],
        status: r[6] ? r[6].charAt(0).toUpperCase() + r[6].slice(1).toLowerCase() : "Pending",
        createdAt: r[7],
        imageUrl: r[8] || ""
      }));

    res.json({ success:true, campaigns: userCampaigns });
  } catch(err){
    console.error("get campaigns error:", err);
    res.status(500).json({ success:false, message:"Failed to get campaigns" });
  }
});

// ==================== STRIPE DONATION ROUTE ====================
app.post("/api/create-checkout-session", async (req, res) => {
  const { campaignId, amount } = req.body;
  if (!campaignId || !amount) return res.status(400).json({ error: "Missing campaignId or amount" });

  try {
    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    const rows = await getSheetValues(spreadsheetId, "A:I");
    const campaign = rows.find(r => r[0] === campaignId);

    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: campaign[1] },
          unit_amount: parseInt(amount) * 100,
        },
        quantity: 1
      }],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL}/thankyou.html?campaignId=${campaignId}`,
      cancel_url: `${process.env.FRONTEND_URL}/campaigns.html`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ==================== START SERVER ====================
app.listen(PORT, () => console.log(`🚀 JoyFund backend running on port ${PORT}`));
