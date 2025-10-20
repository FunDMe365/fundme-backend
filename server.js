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

// ===== FIXED verifyUser function =====
async function verifyUser(email, password) {
  try {
    const { data: userData } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "Users!A:E",
    });

    const allUsers = userData.values || [];

    // Find user row (ignore empty rows)
    const userRow = allUsers.find((row) => row[2] && row[2].toLowerCase() === email.toLowerCase());
    if (!userRow) return false;

    // Ensure password column exists
    const storedHash = userRow[3];
    if (!storedHash) return false;

    const passwordMatch = await bcrypt.compare(password, storedHash);
    if (!passwordMatch) return false;

    // Fetch latest verification
    const { data: verData } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "ID_Verifications!A:D",
    });
    const verRows = (verData.values || []).filter((r) => r[1] && r[1].toLowerCase() === email.toLowerCase());
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

// ===== AUTH ROUTES =====
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ success: false, message: "All fields required." });
  try {
    await saveUser({ name, email, password });
    res.json({ success: true, message: "Account created!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error creating account." });
  }
});

app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: "Email & password required." });
  try {
    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ success: false, error: "Invalid credentials." });
    req.session.user = user;
    await new Promise((r) => req.session.save(r));
    const message = user.verified ? "Signed in successfully!" : "Signed in! ⚠️ Your account is pending ID verification.";
    res.json({ success: true, message, profile: user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Server error." });
  }
});

// ===== CHECK SESSION =====
app.get("/api/check-session", async (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  try {
    const email = req.session.user.email;
    const { data: verData } = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_IDS.users, range: "ID_Verifications!A:D" });
    const verRows = (verData.values || []).filter((r) => r[1]?.toLowerCase() === email.toLowerCase());
    const latestVer = verRows.length ? verRows[verRows.length - 1] : null;
    const verificationStatus = latestVer ? latestVer[3] : "Not submitted";
    const verified = verificationStatus === "Approved";
    req.session.user.verificationStatus = verificationStatus;
    req.session.user.verified = verified;
    await new Promise((r) => req.session.save(r));
    res.json({ loggedIn: true, profile: req.session.user });
  } catch (err) {
    console.error(err);
    res.json({ loggedIn: true, profile: req.session.user, warning: "Could not fetch latest verification status" });
  }
});

// ===== LOGOUT =====
app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ success: false, message: "Logout failed" });
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

// ===== ID VERIFICATION =====
app.post("/api/verify-id", upload.single("idPhoto"), async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
    if (!req.file) return res.status(400).json({ success: false, message: "ID photo required" });
    const { name, email } = req.session.user;
    const photoUrl = `/uploads/${req.file.filename}`;
    await saveToSheet(SPREADSHEET_IDS.users, "ID_Verifications", [new Date().toISOString(), email, name, "Pending", photoUrl]);
    req.session.user.verificationStatus = "Pending";
    req.session.user.verified = false;
    await new Promise((r) => req.session.save(r));
    res.json({ success: true, message: "ID submitted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== CREATE CAMPAIGN =====
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });

    const email = req.session.user.email;
    const { data: verData } = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_IDS.users, range: "ID_Verifications!A:D" });
    const verRows = (verData.values || []).filter((r) => r[1]?.toLowerCase() === email.toLowerCase());
    const latestVer = verRows.length ? verRows[verRows.length - 1] : null;
    const verificationStatus = latestVer ? latestVer[3] : "Not submitted";
    const verified = verificationStatus === "Approved";
    req.session.user.verificationStatus = verificationStatus;
    req.session.user.verified = verified;
    await new Promise((r) => req.session.save(r));

    if (!verified) return res.status(403).json({ success: false, message: "ID verification required" });

    const { title, goal, description, category } = req.body;
    if (!title || !description || !category) return res.status(400).json({ success: false, message: "Title, description, and category required" });

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : "";
    const campaignId = Date.now().toString();

    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      campaignId, title, email, goal || "", description, category, "Pending", new Date().toISOString(), imageUrl
    ]);

    res.json({ success: true, message: "Campaign created!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== USER CAMPAIGNS =====
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
      status: row[6],
      created: row[7],
      image: row[8] ? `${req.protocol}://${req.get("host")}${row[8]}` : ""
    }));
    res.json({ success: true, campaigns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== PUBLIC APPROVED CAMPAIGNS =====
app.get("/api/campaigns", async (req, res) => {
  try {
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_IDS.campaigns, range: "Campaigns!A:I" });
    const campaigns = (data.values || []).filter((row) => row[6] === "Approved").map((row) => ({
      id: row[0],
      title: row[1],
      goal: row[3],
      description: row[4],
      category: row[5],
      status: row[6],
      created: row[7],
      image: row[8] ? `${req.protocol}://${req.get("host")}${row[8]}` : ""
    }));
    res.json({ success: true, campaigns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== STRIPE CHECKOUT FOR INDIVIDUAL CAMPAIGNS =====
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  try {
    const campaignId = req.params.campaignId;
    const { amount } = req.body;

    if (!amount || amount < 1) return res.status(400).json({ success: false, message: "Invalid donation amount" });

    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:I"
    });

    const row = (data.values || []).find(r => r[0] === campaignId);
    if (!row) return res.status(404).json({ success: false, message: "Campaign not found" });

    const campaignTitle = row[1];
    const campaignDescription = row[4] || "";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: campaignTitle, description: campaignDescription },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${req.protocol}://${req.get("host")}/thankyou.html?campaignId=${campaignId}`,
      cancel_url: `${req.protocol}://${req.get("host")}/campaigns.html`,
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
