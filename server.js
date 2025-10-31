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

// ===== Allowed Origins =====
const allowedOrigins = [
  "https://fundasmile.net",
  "https://www.fundasmile.net",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

// ===== CORS =====
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Serve uploads and static files =====
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
  idVerifications: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
};

// ===== SendGrid =====
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const sendEmail = async ({ to, subject, text, html }) => {
  try {
    await sgMail.send({ to, from: process.env.EMAIL_FROM, subject, text, html });
    console.log(`✅ Email sent to ${to}`);
  } catch (err) {
    console.error("SendGrid error:", err);
  }
};

// ===== Helper Functions =====
async function saveToSheet(sheetId, sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}
async function getSheetValues(sheetId, range) {
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  return data.values || [];
}

// ===== Multer (File Upload) =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ===== USER SIGNUP =====
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

// ===== Verify User for Signin =====
async function verifyUser(email, password) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!A:E",
  });
  const users = data.values || [];
  const userRow = users.find((r) => r[2]?.toLowerCase() === email.toLowerCase());
  if (!userRow) return false;

  const passwordMatch = await bcrypt.compare(password, userRow[3]);
  if (!passwordMatch) return false;

  return { name: userRow[1], email: userRow[2] };
}

// ===== AUTH ROUTES =====
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ success: false, message: "All fields required." });

  try {
    await saveUser({ name, email, password });
    await sendEmail({
      to: email,
      subject: "Welcome to FunDMe!",
      html: `<p>Hello ${name},</p><p>Thank you for signing up!</p>`,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("signup error:", err);
    res.status(500).json({ success: false, message: "Signup failed." });
  }
});

app.options("/api/signin", cors(corsOptions));

app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, message: "Email and password required." });

  try {
    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ success: false, message: "Invalid credentials" });

    req.session.user = user;
    res.json({ success: true, profile: user });
  } catch (err) {
    console.error("signin error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.post("/api/signout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/check-session", (req, res) => {
  res.json({ loggedIn: !!req.session.user, user: req.session.user || null });
});

// ===== WAITLIST =====
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email)
    return res.status(400).json({ success: false, message: "Name and email required." });

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
    console.error("waitlist error:", err);
    res.status(500).json({ success: false, message: "Error saving to waitlist." });
  }
});

// ===== CREATE CAMPAIGN =====
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ success: false, message: "Not logged in" });

  const { title, goal, category, description } = req.body;
  if (!title || !goal || !category || !description)
    return res.status(400).json({ success: false, message: "All fields required." });

  try {
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : "";
    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      new Date().toISOString(),
      req.session.user.name,
      req.session.user.email,
      title,
      description,
      goal,
      category,
      imageUrl,
      "Pending",
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error("create-campaign error:", err);
    res.status(500).json({ success: false, message: "Failed to create campaign." });
  }
});

// ===== STRIPE DONATION =====
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  const { campaignId } = req.params;
  const { amount, donorEmail } = req.body;
  if (!amount || !campaignId)
    return res.status(400).json({ success: false, message: "Missing fields." });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name:
                campaignId === "mission"
                  ? "General FunDMe Donation"
                  : `Donation to Campaign ${campaignId}`,
            },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL || "https://fundasmile.net"}/thankyou.html`,
      cancel_url: `${process.env.FRONTEND_URL || "https://fundasmile.net"}/index.html`,
      customer_email: donorEmail,
      metadata: { campaignId, amount },
    });

    res.json({ success: true, sessionId: session.id });
  } catch (err) {
    console.error("checkout-session error:", err);
    res.status(500).json({ success: false, message: "Failed to create checkout session." });
  }
});

// ===== LOG DONATION =====
app.post("/api/log-donation", async (req, res) => {
  const { campaignId, title, amount, timestamp } = req.body;
  if (!campaignId || !title || !amount || !timestamp)
    return res.status(400).json({ success: false, message: "Missing fields." });

  try {
    await saveToSheet(SPREADSHEET_IDS.donations, "Donations", [
      timestamp,
      campaignId,
      title,
      amount,
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error("log-donation error:", err);
    res.status(500).json({ success: false, message: "Failed to log donation." });
  }
});

// ===== VOLUNTEER FORM =====
app.post("/api/volunteer", async (req, res) => {
  const { name, email, interest } = req.body;
  if (!name || !email)
    return res.status(400).json({ success: false, message: "All fields required." });

  try {
    await saveToSheet(SPREADSHEET_IDS.volunteers, "Volunteers", [
      new Date().toISOString(),
      name,
      email,
      interest || "",
    ]);
    res.json({ success: true });
  } catch (err) {
    console.error("volunteer error:", err);
    res.status(500).json({ success: false, message: "Error saving volunteer." });
  }
});

// ===== CATCH-ALL =====
app.all("/api/*", (req, res) =>
  res.status(404).json({ success: false, message: "API route not found" })
);

// ===== START SERVER =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
