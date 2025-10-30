// server.js
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

// ===== Allowed Origins & CORS =====
const allowedOrigins = [
  "https://fundasmile.net",
  "https://www.fundasmile.net",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // allow server-side requests, curl, etc.
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options("*", corsOptions);

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

// ===== Google Sheets Setup =====
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
  idVerifications: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
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

// ===== Helper Functions for Sheets =====
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

  // optional notification
  await sendEmail({
    to: process.env.EMAIL_FROM,
    subject: `New Signup: ${name}`,
    text: `New user signed up:\nName: ${name}\nEmail: ${email}`,
    html: `<p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p>`,
  });
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

    // check ID verification status from ID_Verifications sheet
    const { data: verData } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.idVerifications || SPREADSHEET_IDS.idVerifications,
      range: "ID_Verifications!A:E",
    }).catch(() => ({ data: { values: [] } }));
    const verRows = (verData.values || []).filter((r) => r[1]?.toLowerCase() === email.toLowerCase());
    const latestVer = verRows.length ? verRows[verRows.length - 1] : null;
    const verificationStatus = latestVer ? latestVer[3] : "Not submitted";
    const verified = verificationStatus === "Approved";

    return { name: userRow[1], email: userRow[2], verified, verificationStatus };
  } catch (err) {
    console.error("verifyUser error:", err);
    return false;
  }
}

// ===== Auth Routes =====
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ success: false, message: "All fields required." });
  try {
    // simple check if email exists
    const values = await getSheetValues(SPREADSHEET_IDS.users, "Users!A:E");
    const users = rowsToObjects(values);
    if (users.find((u) => u.Email && u.Email.toLowerCase() === email.toLowerCase())) {
      return res.status(400).json({ success: false, message: "Email already registered" });
    }

    await saveUser({ name, email, password });
    req.session.user = { name, email, isAdmin: false };
    req.session.save(() => res.json({ success: true, user: { name, email } }));
  } catch (err) {
    console.error("signup error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Preflight for signin
app.options("/api/signin", cors(corsOptions));

app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, message: "Email and password required." });
  try {
    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ success: false, message: "Invalid credentials" });

    req.session.user = user;
    req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30; // 30 days
    req.session.save(() => res.json({ success: true, profile: user }));
  } catch (err) {
    console.error("signin error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.post("/api/signout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/check-session", (req, res) => {
  if (req.session.user) res.json({ loggedIn: true, user: req.session.user });
  else res.json({ loggedIn: false });
});

// ===== Volunteers / Waitlist / Campaign Submission =====
app.post("/api/volunteer", async (req, res) => {
  const { name, email, city, state, reason } = req.body;
  if (!name || !email) return res.status(400).json({ success: false, message: "Missing name or email" });
  try {
    const date = new Date().toLocaleString();
    await saveToSheet(SPREADSHEET_IDS.volunteers, "Volunteers", [date, name, email, city || "", state || "", reason || ""]);
    res.json({ success: true, message: "Volunteer submission received!" });
  } catch (err) {
    console.error("Volunteer error:", err);
    res.status(500).json({ success: false, message: "Error saving volunteer" });
  }
});

app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email) return res.status(400).json({ success: false, message: "Missing name or email" });
  try {
    const date = new Date().toLocaleString();
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [date, name, email, source || "", reason || ""]);
    res.json({ success: true, message: "Added to waitlist!" });
  } catch (err) {
    console.error("Waitlist error:", err);
    res.status(500).json({ success: false, message: "Error saving to sheet" });
  }
});

app.post("/api/campaigns", upload.single("image"), async (req, res) => {
  // Public route for submitting a campaign (requires session in some flows)
  try {
    const { name, email, title, description, goal } = req.body;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : "";
    const date = new Date().toLocaleString();

    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      date,
      name || "",
      email || "",
      title || "",
      description || "",
      goal || "",
      imageUrl,
      "Pending",
    ]);

    res.json({ success: true, message: "Campaign submitted successfully" });
  } catch (err) {
    console.error("Campaign error:", err);
    res.status(500).json({ success: false, message: "Error saving campaign" });
  }
});

// ===== Get Campaigns (for frontend campaigns page) =====
app.get("/api/campaigns", async (req, res) => {
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.campaigns, "Campaigns!A:H");
    const campaigns = rowsToObjects(values).map((c, idx) => {
      // ensure expected keys exist; original sheet header should define columns
      return {
        id: c.Id || c.id || `row-${idx + 1}`,
        title: c.Title || c.title || c["Campaign Title"] || "",
        email: c.Email || c.email || c["Creator Email"] || "",
        goal: c.Goal || c.goal || c["Goal"] || "0",
        description: c.Description || c.description || c["Description"] || "",
        category: c.Category || c.category || "",
        status: c.Status || c.status || "Pending",
        createdAt: c.CreatedAt || c.createdAt || c["Created At"] || "",
        imageUrl: c.ImageUrl || c.imageUrl || "",
      };
    });
    res.json({ success: true, campaigns });
  } catch (err) {
    console.error("get-campaigns error:", err);
    res.status(500).json({ success: false, campaigns: [] });
  }
});

// ===== ID Verification =====
app.post("/api/verify-id", upload.single("idDocument"), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
  if (!req.file) return res.status(400).json({ success: false, message: "No ID file uploaded" });
  try {
    const date = new Date().toLocaleString();
    const imageUrl = `/uploads/${req.file.filename}`;
    await saveToSheet(SPREADSHEET_IDS.idVerifications || SPREADSHEET_IDS.idVerifications, "ID_Verifications", [
      date,
      req.session.user.email,
      req.session.user.name || "",
      "Pending",
      imageUrl,
    ]);
    res.json({ success: true, message: "ID submitted successfully", imageUrl, status: "Pending" });
  } catch (err) {
    console.error("ID verification error:", err);
    res.status(500).json({ success: false, message: "Error saving verification" });
  }
});

app.get("/api/get-verifications", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.idVerifications, "ID_Verifications!A:E");
    const verifications = rowsToObjects(values);
    // send all verifications (frontend filters to the user)
    res.json({ success: true, verifications });
  } catch (err) {
    console.error("get-verifications error:", err);
    res.status(500).json({ success: false, verifications: [] });
  }
});

// ===== Create Checkout Session (Stripe) =====
// This route supports general mission donations (campaignId === "mission") and campaign-specific donations.
// The frontend uses: POST /api/create-checkout-session/:campaignId with JSON body { amount, successUrl, cancelUrl, donorEmail? }
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  const { campaignId } = req.params;
  const { amount, successUrl, cancelUrl, donorEmail } = req.body;

  if (!amount || !successUrl || !cancelUrl) {
    return res.status(400).json({ success: false, message: "Missing required fields." });
  }

  try {
    const donationAmount = Math.round(parseFloat(amount) * 100); // cents

    const productName = campaignId === "mission" ? "General JoyFund Donation" : `Donation to Campaign ${campaignId}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: productName,
            },
            unit_amount: donationAmount,
          },
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: donorEmail || undefined,
      metadata: { campaignId, amount: donationAmount },
    });

    // Return sessionId (frontend uses stripe.redirectToCheckout({ sessionId }))
    res.json({ success: true, sessionId: session.id });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    res.status(500).json({ success: false, message: "Failed to create checkout session." });
  }
});

// Optional legacy donation route (payment intent) kept for compatibility
app.post("/api/donations", async (req, res) => {
  const { amount, email } = req.body;
  if (!amount || !email) return res.status(400).json({ success: false, message: "Missing fields" });
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(parseFloat(amount) * 100),
      currency: "usd",
      receipt_email: email,
      description: "JoyFund Donation",
    });
    res.json({ success: true, clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("Stripe donation error:", err);
    res.status(500).json({ success: false, message: "Payment failed" });
  }
});

// ===== Log Donation to Google Sheets (called by frontend before redirect) =====
app.post("/api/log-donation", async (req, res) => {
  const { campaignId, title, amount, timestamp } = req.body;
  if (!campaignId || !amount || !timestamp || !title) {
    return res.status(400).json({ success: false, message: "Missing donation fields." });
  }
  try {
    await saveToSheet(SPREADSHEET_IDS.donations, "Donations", [timestamp, campaignId, title, amount]);
    res.json({ success: true });
  } catch (err) {
    console.error("log-donation error:", err);
    res.status(500).json({ success: false, message: "Failed to log donation." });
  }
});

// ===== Manage campaigns (user-specific) =====
app.get("/api/manage-campaigns", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.campaigns, "Campaigns!A:I");
    const campaigns = rowsToObjects(values).map((row) => ({
      id: row.Id || row.id || row["Id"] || "",
      title: row.Title || row.title || "",
      email: row.Email || row.email || "",
      goal: row.Goal || row.goal || "",
      description: row.Description || row.description || "",
      category: row.Category || row.category || "",
      status: row.Status || row.status || "",
      createdAt: row.CreatedAt || row.createdAt || "",
      imageUrl: row.ImageUrl || row.imageUrl || "",
    }));
    const userCampaigns = campaigns.filter((c) => (c.email || "").toLowerCase() === (req.session.user.email || "").toLowerCase());
    res.json({ success: true, campaigns: userCampaigns });
  } catch (err) {
    console.error("manage-campaigns error:", err);
    res.status(500).json({ success: false, campaigns: [] });
  }
});

// ===== Catch-all API 404 =====
app.all("/api/*", (req, res) => res.status(404).json({ success: false, message: "API route not found" }));

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
