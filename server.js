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

// ===== STATIC UPLOADS ROUTE (visible site-wide) =====
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
    const userRow = allUsers.find((row) => row[2] && row[2].toLowerCase() === email.toLowerCase());
    if (!userRow) return false;
    const storedHash = userRow[3];
    if (!storedHash) return false;

    const passwordMatch = await bcrypt.compare(password, storedHash);
    if (!passwordMatch) return false;

    const { data: verData } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "ID_Verifications!A:D",
    });
    const verRows = (verData.values || []).filter(
      (r) => r[1] && r[1].toLowerCase() === email.toLowerCase()
    );
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

// ===== AUTH ROUTES (signup/signin/check/logout/etc) =====
// ✅ SIGN-IN ROUTE WITH DEBUG LOGS
app.post("/api/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log("🟢 Sign-in attempt:", email);

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const sheet = doc.sheetsByTitle["Users"];
    const rows = await sheet.getRows();

    // Log column names and a sample row
    console.log("🟢 Sheet columns:", Object.keys(rows[0] || {}));
    console.log("🟢 First user row:", rows[0] ? rows[0]._rawData : "No rows found");

    // Find user
    const user = rows.find(row => row.Email === email || row.email === email);
    console.log("🟢 Matched user:", user ? user.Email || user.email : "None found");

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials (email not found)." });
    }

    // Compare passwords (case-sensitive for now)
    if (user.Password !== password && user.password !== password) {
      console.log("🔴 Password mismatch");
      return res.status(401).json({ error: "Invalid credentials (password mismatch)." });
    }

    // Success
    req.session.user = {
      email: user.Email || user.email,
      name: user.Name || user.name || "",
      id: user.ID || user.id || ""
    };

    console.log("✅ Login successful for:", user.Email || user.email);

    res.status(200).json({
      message: "Login successful",
      user: {
        email: user.Email || user.email,
        name: user.Name || user.name || "",
        id: user.ID || user.id || ""
      }
    });
  } catch (error) {
    console.error("❌ Sign-in error:", error);
    res.status(500).json({ error: "Failed to sign in." });
  }
});

// ===== PUBLIC APPROVED CAMPAIGNS =====
app.get("/api/campaigns", async (req, res) => {
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:I",
    });
    const campaigns = (data.values || [])
      .filter((row) => row[6] === "Approved")
      .map((row) => ({
        id: row[0],
        title: row[1],
        goal: row[3],
        description: row[4],
        category: row[5],
        status: row[6],
        created: row[7],
        image: row[8]
          ? `${req.protocol}://${req.get("host")}${
              row[8].startsWith("/") ? row[8] : "/" + row[8]
            }`
          : "",
      }));
    res.json({ success: true, campaigns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== STRIPE CHECKOUT (Campaign Donations) =====
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  try {
    const campaignId = req.params.campaignId;
    let { amount } = req.body;
    amount = Number(amount);
    if (!amount || amount < 1) amount = 1;

    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:I",
    });

    const row = (data.values || []).find((r) => r[0] === campaignId);
    if (!row)
      return res.status(404).json({ success: false, message: "Campaign not found" });

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
      success_url: `https://fundasmile.net/thankyou.html?campaignId=${campaignId}`,
      cancel_url: `https://fundasmile.net/campaigns.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to create checkout session" });
  }
});

// ===== ✅ FIXED: JoyFund Mission Donation =====
app.post("/api/donate-mission", async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount < 1)
    return res.status(400).json({ message: "Invalid donation amount." });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "JoyFund Mission Donation" },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: "https://fundasmile.net/thankyou.html",
      cancel_url: "https://fundasmile.net/",
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Mission donation error:", err);
    res.status(500).json({ message: "Failed to start donation session." });
  }
});

// ===== SERVE PUBLIC FILES =====
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
