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

// ====== NEW: CLOUDINARY IMPORTS ======
const { v2: cloudinary } = require("cloudinary");
const { CloudinaryStorage } = require("multer-storage-cloudinary");

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
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("CORS not allowed"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.options("*", cors());

// ==================== MIDDLEWARE ====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ==================== SESSION ====================
app.set("trust proxy", 1);
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

// ==================== STRIPE & MAILJET ====================
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || "");
const mailjetClient = mailjet.apiConnect(
  process.env.MAILJET_API_KEY || "",
  process.env.MAILJET_API_SECRET || ""
);

async function sendMailjetEmail(subject, htmlContent) {
  try {
    await mailjetClient.post("send", { 'version': 'v3.1' }).request({
      Messages: [{
        From: { Email: process.env.MAILJET_SENDER_EMAIL, Name: "JoyFund INC" },
        To: [{ Email: process.env.NOTIFY_EMAIL }],
        Subject: subject,
        HTMLPart: htmlContent
      }]
    });
  } catch (err) { console.error("Mailjet error:", err); }
}

// ==================== GOOGLE SHEETS ====================
// (unchanged)
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
  } else { console.warn("⚠️ GOOGLE_CREDENTIALS_JSON not provided; Sheets disabled."); }
} catch (err) { console.error("❌ Google Sheets init failed", err.message); }

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
    resource: { values }
  });
}

async function findRowAndUpdateOrAppend(spreadsheetId, rangeCols, matchColIndex, matchValue, updatedValues) {
  if (!sheets) throw new Error("Sheets not initialized");
  let sheetName = "", range = "";
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

// ==================== CLOUDINARY SETUP ====================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Cloudinary storage for ID verifications
const idStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "joyfund_id_verifications",
    allowed_formats: ["jpg", "jpeg", "png", "pdf"]
  }
});
const upload = multer({ storage: idStorage });

// Cloudinary storage for Campaigns
const campaignStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "joyfund_campaigns",
    allowed_formats: ["jpg", "jpeg", "png"],
    transformation: [{ width: 1200, height: 800, crop: "limit" }]
  }
});
const campaignUpload = multer({ storage: campaignStorage });

// ==================== SIGN-IN / SESSION ====================
// (unchanged)
// ... your signin, session, logout routes stay the same ...

// ==================== ID VERIFICATION ROUTES ====================
app.post("/api/verify-id", upload.single("idDocument"), async (req, res) => {
  try {
    const user = req.session.user;
    if (!user || !user.email) return res.status(401).json({ success: false, message: "You must be signed in" });
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });

    const spreadsheetId = process.env.ID_VERIFICATIONS_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ success: false, message: "ID_VERIFICATIONS_SHEET_ID not configured" });

    const fileUrl = req.file.path; // Cloudinary URL
    const timestamp = new Date().toLocaleString();
    const updatedRow = [timestamp, user.email.toLowerCase(), user.name, "pending", fileUrl];

    const result = await findRowAndUpdateOrAppend(spreadsheetId, "ID_Verifications!A:E", 1, user.email, updatedRow);
    await sendMailjetEmail("New ID Verification Submitted", `<p>${user.name} (${user.email}) submitted an ID at ${timestamp}</p>`);

    res.json({ success: true, action: result.action, row: result.row });
  } catch (err) {
    console.error("verify-id error:", err);
    res.status(500).json({ success: false, message: "Failed to submit ID verification" });
  }
});

// ==================== CAMPAIGN ROUTES ====================
app.post("/api/create-campaign", campaignUpload.single("image"), async (req, res) => {
  try {
    const user = req.session.user;
    if (!user || !user.email) return res.status(401).json({ success: false, message: "You must be signed in" });

    const { title, goal, description, category } = req.body;
    if (!title || !goal || !description || !category)
      return res.status(400).json({ success: false, message: "Missing required fields" });
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    if (!spreadsheetId) return res.status(500).json({ success: false, message: "CAMPAIGNS_SHEET_ID not configured" });

    const campaignId = Date.now().toString();
    const imageUrl = req.file ? req.file.path : "https://placehold.co/400x200?text=No+Image";
    const createdAt = new Date().toISOString();
    const status = "Pending";

    const newCampaignRow = [campaignId, title, user.email.toLowerCase(), goal, description, category, status, createdAt, imageUrl];
    await appendSheetValues(spreadsheetId, "A:I", [newCampaignRow]);

    await sendMailjetEmail("New Campaign Submitted", `<p>${user.name} (${user.email}) submitted a campaign titled "${title}"</p>`);

    res.json({ success: true, message: "Campaign submitted and pending approval", campaignId });
  } catch (err) {
    console.error("create-campaign error:", err);
    res.status(500).json({ success: false, message: "Failed to create campaign" });
  }
});

// The rest of your routes (waitlist, volunteer, contact, stripe, etc.) remain untouched.

// ==================== START SERVER ====================
app.listen(PORT, () => console.log(`🚀 JoyFund backend running on port ${PORT}`));
