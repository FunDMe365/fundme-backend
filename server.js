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
const stripe = Stripe(process.env.STRIPE_SECRET_KEY); // LIVE key from Render env

// ===== CORS =====
const allowedOrigins = [
  "https://fundasmile.net",
  "https://www.fundasmile.net",
];
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
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
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ===== Helper Functions =====
async function saveToSheet(sheetId, sheetName, values) {
  return sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

// ===== Multer =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ===== User Helpers =====
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
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "Users!A:E",
    });
    const allUsers = data.values || [];
    const userRow = allUsers.find((r) => r[2]?.toLowerCase() === email.toLowerCase());
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
  } catch (err) {
    console.error("verifyUser error:", err);
    return false;
  }
}

// ===== Volunteer / Street Team Submission =====
app.post("/api/volunteer", async (req, res) => {
  const { name, email, role, message } = req.body;

  if (!name || !email || !role || !message) {
    return res.status(400).json({ success: false, message: "All fields are required." });
  }

  try {
    // Save to Google Sheet
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Volunteers", [
      new Date().toISOString(),
      name,
      email,
      role,
      message,
    ]);

    res.json({ success: true, message: "Thank you for volunteering!" });
  } catch (err) {
    console.error("Volunteer submission error:", err);
    res.status(500).json({ success: false, message: "Failed to submit. Try again later." });
  }
});


// ===== Auth Routes =====
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ success: false, message: "All fields required." });
  try { await saveUser({ name, email, password }); res.json({ success: true }); }
  catch (err) { console.error(err); res.status(500).json({ success: false }); }
});

app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  const user = await verifyUser(email, password);
  if (!user) return res.status(401).json({ success: false, message: "Invalid credentials" });
  req.session.user = user;
  await new Promise((r) => req.session.save(r));
  res.json({ success: true, profile: user });
});

app.get("/api/check-session", (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, profile: req.session.user });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ success: false });
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

// ===== Campaign Routes =====
app.get("/api/my-campaigns", async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });

    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_IDS.campaigns, range: "Campaigns!A:I" });
    const campaigns = (data.values || []).filter((row) => row[2] === req.session.user.email).map((row) => ({
      id: row[0],
      title: row[1],
      goal: row[3],
      description: row[4],
      category: row[5],
      status: row[6] === "Approved" ? "Active" : row[6],
      created: row[7],
      imageUrl: row[8] ? `/${row[8]}` : ""
    }));

    res.json({ success: true, campaigns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to load campaigns" });
  }
});

// ===== Stripe Checkout (Live) =====
app.post('/api/create-checkout-session/:id', async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;

  if (!amount || amount < 1) return res.status(400).json({ success: false, message: "Invalid donation amount." });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Donation for ${id}` },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: 'https://www.fundasmile.net/thankyou.html',
      cancel_url: 'https://www.fundasmile.net/cancel.html',
    });

    res.json({ id: session.id });
  } catch (error) {
    console.error("Stripe live session error:", error);
    res.status(500).json({ success: false, message: "Unable to process donation at this time." });
  }
});

// ===== Serve static frontend AFTER API routes =====
app.use(express.static(path.join(__dirname, "public")));

// ===== Waitlist Route =====
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email || !source || !reason)
    return res.status(400).json({ success: false, message: "All fields are required." });

  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [
      new Date().toISOString(),
      name,
      email,
      source,
      reason
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error("Waitlist save error:", err);
    res.status(500).json({ success: false, message: "Failed to submit waitlist." });
  }
});

// ===== Catch-all for API 404 =====
app.all("/api/*", (req, res) => {
  res.status(404).json({ success: false, message: "API route not found" });
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
