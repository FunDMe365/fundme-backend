require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const sgMail = require("@sendgrid/mail");
const Stripe = require("stripe");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 5000;

console.log("Server starting...");

// ===== Ensure uploads folder exists =====
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ===== Stripe Setup =====
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ===== Allowed Origins =====
const allowedOrigins = [
  "https://fundasmile.net",
  "https://www.fundasmile.net",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

// ===== Minimal CORS fix =====
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/uploads", express.static(uploadsDir));

// ===== Session =====
app.set("trust proxy", 1);
app.use(
  session({
    secret: process.env.SESSION_SECRET || "supersecretkey",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI,
      collectionName: "sessions",
    }),
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 1000 * 60 * 60 * 24,
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
  campaigns: "1XSS-2WJpzEhDe6RHBb8rt_6NNWNqdFpVTUsRa3TNCG8",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
};

// ===== SendGrid =====
if (!process.env.SENDGRID_API_KEY) console.warn("SendGrid API Key not set!");
else sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ===== Helper Functions =====
async function saveToSheet(sheetId, sheetName, values) {
  try {
    return sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:Z`,
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });
  } catch (err) {
    console.error("Google Sheets error:", err);
    throw err;
  }
}

// ===== Multer (File Upload) =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ===== Serve images site-wide =====
app.get("/images/:filename", (req, res) => {
  const filePath = path.join(uploadsDir, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("Image not found");
  res.sendFile(filePath);
});

// ===== USER & AUTH HELPERS =====
async function saveUser({ name, email, password }) {
  const hash = await bcrypt.hash(password, 10);
  await saveToSheet(SPREADSHEET_IDS.users, "Users", [
    new Date().toISOString(),
    name,
    email,
    hash,
    "false",
  ]);
}

async function verifyUser(email, password) {
  const { data: userData } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!A:E",
  });

  const userRow = (userData.values || []).find((r) => r[2]?.toLowerCase() === email.toLowerCase());
  if (!userRow) return false;

  const passwordMatch = await bcrypt.compare(password, userRow[3]);
  if (!passwordMatch) return false;

  const { data: verData } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "ID_Verifications!A:D",
  });

  const verRows = (verData.values || []).filter((r) => r[1]?.toLowerCase() === email.toLowerCase());
  const latestVer = verRows.length ? verRows[verRows.length - 1] : null;
  const verificationStatus = latestVer ? latestVer[3] : "Not submitted";
  const verified = verificationStatus === "Approved";

  return {
    name: userRow[1],
    email: userRow[2],
    verified,
    verificationStatus,
  };
}

// ===== AUTH ROUTES =====
// signup, signin, check-session, logout — same as last working version

// ===== CREATE / VIEW CAMPAIGNS =====
// create-campaign, my-campaigns, campaigns — same as last working version

// ===== STRIPE CHECKOUT (custom amount) =====
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  try {
    const campaignId = req.params.campaignId;
    let amount = parseFloat(req.body.amount);
    if (isNaN(amount) || amount < 1) {
      return res.status(400).json({ success: false, message: "Invalid donation amount" });
    }

    // Fetch campaign details from Google Sheets
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:I"
    });

    const row = (data.values || []).find(r => r[0] === campaignId);
    if (!row) return res.status(404).json({ success: false, message: "Campaign not found" });

    const campaignTitle = row[1];
    const campaignDescription = row[4] || "";

    // Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: campaignTitle, description: campaignDescription },
            unit_amount: Math.round(amount * 100)
          },
          quantity: 1
        }
      ],
      mode: "payment",
      success_url: `${req.protocol}://${req.get("host")}/thankyou.html?campaignId=${campaignId}`,
      cancel_url: `${req.protocol}://${req.get("host")}/campaigns.html`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ success: false, message: "Failed to create checkout session" });
  }
});

// ===== STATIC FILES =====
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
