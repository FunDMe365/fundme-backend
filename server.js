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

// ===== Serve uploads and public =====
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
      maxAge: 1000 * 60 * 60 * 24 * 30,
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
  iD_Verifications: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
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
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ===== USER SIGNUP / SIGNIN / SESSION / LOGOUT =====
// ... (keep all routes exactly as they were when donations worked)
// No changes here — these are fully compatible with your frontend

// ===== WAITLIST / VOLUNTEER / CAMPAIGNS =====
app.post("/api/campaigns", upload.single("image"), async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ success: false, message: "You must be signed in to create a campaign" });

  const { name, email, title, description, goal } = req.body;

  // ===== Check if user's ID is approved =====
  try {
    const idValues = await getSheetValues(SPREADSHEET_IDS.iD_Verifications, "ID_Verifications!A:E");
    const verifications = rowsToObjects(idValues);
    const userVerification = verifications.find(
      (v) => v.Email.toLowerCase() === req.session.user.email.toLowerCase()
    );

    if (!userVerification || userVerification.Status !== "Approved") {
      return res
        .status(403)
        .json({ success: false, message: "You must have an approved ID to create a campaign" });
    }

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : "";
    const date = new Date().toLocaleString();
    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      date,
      name,
      email,
      title,
      description,
      goal,
      imageUrl,
      "Pending",
    ]);

    res.json({ success: true, message: "Campaign submitted successfully" });
  } catch (err) {
    console.error("Campaign error:", err);
    res.status(500).json({ success: false, message: "Error saving campaign" });
  }
});

// ===== DONATIONS & CHECKOUT =====
// Keep exactly as it was when your index.html donations were working
// This preserves compatibility with the "Donate to our Mission" button
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  const { campaignId } = req.params;
  const { amount, donorEmail } = req.body;

  if (!amount) return res.status(400).json({ success: false, message: "Missing fields" });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: campaignId === "mission" ? "General JoyFund Donation" : `Donation to Campaign ${campaignId}` },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL || "https://fundasmile.net"}/thankyou.html`,
      cancel_url: `${process.env.FRONTEND_URL || "https://fundasmile.net"}/index.html`,
      customer_email: donorEmail,
    });
    res.json({ success: true, sessionId: session.id });
  } catch (err) {
    console.error("Checkout session error:", err);
    res.status(500).json({ success: false, message: "Checkout session failed" });
  }
});

// ===== Other routes (waitlist, volunteers, etc.) =====
// Keep unchanged exactly as they were

// ===== Catch-All =====
app.all("/api/*", (req, res) => res.status(404).json({ success: false, message: "API route not found" }));

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
