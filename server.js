require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const sgMail = require("@sendgrid/mail");
const Stripe = require("stripe");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 5000;

// ---------- CORS ----------
const allowedOrigins = [
  "https://joyfund.org",
  "http://localhost:3000",
];
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// ---------- Middleware ----------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "joyfund-secret",
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 },
  })
);

// ---------- Uploads ----------
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => `${Date.now()}-${file.originalname}`,
});
const upload = multer({ storage });

// ---------- Stripe ----------
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ---------- SendGrid ----------
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const sendEmail = async ({ to, subject, text, html }) => {
  if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_SENDER) return;
  try {
    await sgMail.send({ to, from: process.env.SENDGRID_SENDER, subject, text, html });
    console.log(`✅ Email sent to ${to}`);
  } catch (err) {
    console.error("SendGrid error:", err);
  }
};

// ---------- Google Sheets ----------
const SPREADSHEET_IDS = {
  users: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
  campaigns: "1XSS-2WJpzEhDe6RHBb8rt_6NNWNqdFpVTUsRa3TNCG8",
  donations: "1C_xhW-dh3yQ7MpSoDiUWeCC2NNVWaurggia-f1z0YwA",
  verifications: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
};

let sheets;
if (
  process.env.GOOGLE_PROJECT_ID &&
  process.env.GOOGLE_CLIENT_EMAIL &&
  process.env.GOOGLE_PRIVATE_KEY
) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: "service_account",
      project_id: process.env.GOOGLE_PROJECT_ID,
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  sheets = google.sheets({ version: "v4", auth });
} else {
  console.warn("⚠️ Google Sheets not configured. Private key missing.");
}

// ---------- Helper Functions ----------
async function saveToSheet(sheetId, sheetName, values) {
  if (!sheets) throw new Error("Google Sheets not configured");
  return sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

async function getSheetValues(sheetId, range) {
  if (!sheets) return [];
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
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

// ---------- Auth / Users ----------
async function saveUser({ name, email, password }) {
  const hash = await bcrypt.hash(password, 10);
  await saveToSheet(SPREADSHEET_IDS.users, "Users", [new Date().toISOString(), name, email, hash]);
}

async function verifyUser(email, password) {
  const values = await getSheetValues(SPREADSHEET_IDS.users, "Users!A:D");
  const row = values.find((r) => r[2]?.toLowerCase() === email.toLowerCase());
  if (!row) return false;
  const match = await bcrypt.compare(password, row[3]);
  if (!match) return false;
  return { name: row[1], email: row[2] };
}

app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ success: false });
  try {
    await saveUser({ name, email, password });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false });
  try {
    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ success: false });
    req.session.user = user;
    res.json({ success: true, profile: user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.post("/api/signout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get("/api/check-session", (req, res) => {
  res.json({ loggedIn: !!req.session.user, user: req.session.user || null });
});

// ---------- Waitlist ----------
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email) return res.status(400).json({ success: false });
  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [
      new Date().toISOString(),
      name,
      email,
      source || "",
      reason || "",
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ---------- ID Verification ----------
app.post("/api/verify-id", upload.single("idDocument"), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false });
  if (!req.file) return res.status(400).json({ success: false });
  try {
    await saveToSheet(SPREADSHEET_IDS.verifications, "ID_Verifications", [
      new Date().toISOString(),
      req.session.user.email,
      new Date().toISOString(),
      "Pending",
      `/uploads/${req.file.filename}`,
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ---------- Campaigns ----------
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false });
  const { title, goal, category, description } = req.body;
  if (!title || !goal || !category || !description) return res.status(400).json({ success: false });
  try {
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : "";
    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      new Date().toISOString(),
      req.session.user.name,
      req.session.user.email,
      title,
      description,
      category,
      goal,
      "Pending",
      imageUrl,
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.get("/api/campaigns", async (req, res) => {
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.campaigns, "Campaigns!A:I");
    const campaigns = rowsToObjects(values);
    res.json({ success: true, campaigns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ---------- Donations ----------
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { amount, donorEmail } = req.body;
    if (!amount) return res.status(400).json({ success: false });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: `JoyFund Donation - ${campaignId}` },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL}/thankyou.html`,
      cancel_url: `${process.env.FRONTEND_URL}/index.html`,
      customer_email: donorEmail,
    });

    res.json({ success: true, sessionId: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ---------- Log Donation ----------
app.post("/api/log-donation", async (req, res) => {
  const { campaignId, title, amount } = req.body;
  if (!campaignId || !title || !amount) return res.status(400).json({ success: false });
  try {
    await saveToSheet(SPREADSHEET_IDS.donations, "Donations", [new Date().toISOString(), campaignId, title, amount]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ---------- Catch-All API 404 ----------
app.all("/api/*", (req, res) => res.status(404).json({ success: false, message: "API route not found" }));

// ---------- Start Server ----------
app.listen(PORT, () => console.log(`🚀 JoyFund backend running on port ${PORT}`));
