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
  "https://fundasmile.net",
  "https://www.fundasmile.net",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Serve uploads folder and public =====
app.use("/uploads", express.static(uploadsDir));
app.use(express.static(path.join(__dirname, "public")));

// ===== Session =====
app.set("trust proxy", 1);
app.use(
  session({
    secret: process.env.SESSION_SECRET || "supersecretkey",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    },
  })
);

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
  iD_Verifications: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0", // ✅ Correct sheet for ID Verification
};

// ===== SendGrid =====
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const sendEmail = async ({ to, subject, text, html }) => {
  if (!process.env.SENDGRID_API_KEY || !process.env.EMAIL_FROM) return;
  try {
    await sgMail.send({ to, from: process.env.EMAIL_FROM, subject, text, html });
    console.log(`✅ Email sent to ${to}`);
  } catch (err) {
    console.error("SendGrid error:", err);
  }
};

// ===== Helper Functions =====
async function saveToSheet(sheetId, sheetName, values) {
  return sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

async function getSheetValues(sheetId, range) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });
  return data.values || [];
}

function rowsToObjects(values) {
  if (!values || values.length < 1) return [];
  const headers = values[0];
  return values.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i] || ""));
    return obj;
  });
}

// ===== Multer (File Upload) =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ===== EXISTING ENDPOINTS =====
// ... all your signup, signin, check-session, signout, volunteer, waitlist, campaign, donate, verify-id endpoints remain unchanged ...

// ===== NEW ENDPOINT: Get ID Verifications for Dashboard =====
app.get("/api/get-verifications", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.iD_Verifications, "ID_Verifications!A:E");
    const allVerifications = rowsToObjects(values);
    const userVerifications = allVerifications.filter(
      (v) => v.Email.toLowerCase() === req.session.user.email.toLowerCase()
    );
    res.json({ success: true, verifications: userVerifications });
  } catch (err) {
    console.error("get-verifications error:", err);
    res.status(500).json({ success: false, message: "Error fetching verifications" });
  }
});

// ===== NEW ENDPOINT: Get User Campaigns for Dashboard =====
app.get("/api/campaigns", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.campaigns, "Campaigns!A:H");
    const allCampaigns = rowsToObjects(values);
    const userCampaigns = allCampaigns
      .filter((c) => c.Email.toLowerCase() === req.session.user.email.toLowerCase())
      .map((c) => ({
        title: c.Title || "",
        status: c.Status || "Pending",
        imageUrl: c.ImageUrl || "",
      }));
    res.json({ success: true, campaigns: userCampaigns });
  } catch (err) {
    console.error("campaigns error:", err);
    res.status(500).json({ success: false, message: "Error fetching campaigns" });
  }
});

// ===== Catch-all =====
app.all("/api/*", (req, res) =>
  res.status(404).json({ success: false, message: "API route not found" })
);

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
