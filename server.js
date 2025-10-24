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
    if (!origin || allowedOrigins.indexOf(origin) !== -1) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
};
app.use(cors(corsOptions));

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Serve uploads folder =====
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
  try {
    return await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:Z`,
      valueInputOption: "RAW",
      requestBody: { values: [values] },
    });
  } catch (err) {
    console.error(`saveToSheet error (${sheetName}):`, err);
    throw err;
  }
}

async function readSheet(sheetId, sheetName) {
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:Z`,
    });
    return data.values || [];
  } catch (err) {
    console.error(`readSheet error (${sheetName}):`, err);
    return [];
  }
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
  await sendEmail({
    to: process.env.EMAIL_FROM,
    subject: `New Signup: ${name}`,
    text: `New user signed up:\nName: ${name}\nEmail: ${email}`,
    html: `<p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p>`,
  });
}

async function verifyUser(email, password) {
  const users = await readSheet(SPREADSHEET_IDS.users, "Users");
  const userRow = users.find((r) => r[2]?.toLowerCase() === email.toLowerCase());
  if (!userRow) return false;
  const passwordMatch = await bcrypt.compare(password, userRow[3]);
  if (!passwordMatch) return false;

  const verifications = await readSheet(SPREADSHEET_IDS.users, "ID_Verifications");
  const userVer = verifications
    .filter((r) => r[1]?.toLowerCase() === email.toLowerCase())
    .pop();
  const verificationStatus = userVer ? userVer[3] : "Not submitted";
  const verified = verificationStatus === "Approved";

  return {
    name: userRow[1],
    email: userRow[2],
    verified,
    verificationStatus,
  };
}

// ===== Auth Routes =====
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ success: false, message: "All fields required." });
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

// ===== Verify ID Route =====
app.post("/api/verify-id", upload.single("idImage"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "ID image is required" });

    const { email, name } = req.body;
    const filename = req.file.filename;
    const idImageUrl = `/uploads/${filename}`;

    await saveToSheet(SPREADSHEET_IDS.users, "ID_Verifications", [
      new Date().toISOString(),
      email,
      name || "",
      "Submitted",
      filename,
    ]);

    await sendEmail({
      to: process.env.EMAIL_FROM,
      subject: `New ID Verification Submitted by ${name || email}`,
      text: `Name: ${name || "N/A"}\nEmail: ${email}\nID File: ${filename}`,
      html: `<p><strong>Name:</strong> ${name || "N/A"}</p><p><strong>Email:</strong> ${email}</p><p><strong>ID File:</strong> ${filename}</p>`,
    });

    res.json({ success: true, message: "ID verification submitted", image: idImageUrl });
  } catch (err) {
    console.error("verify-id route error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ===== Get Verifications Route =====
app.get("/api/get-verifications", async (req, res) => {
  try {
    if (!req.session.user) return res.json({ success: false, message: "Not logged in" });

    const { email } = req.session.user;
    const rows = await readSheet(SPREADSHEET_IDS.users, "ID_Verifications");
    const verifications = rows
      .filter((r) => r[1]?.toLowerCase() === email.toLowerCase())
      .map((r) => ({
        date: r[0],
        email: r[1],
        name: r[2],
        status: r[3] || "Not submitted",
        idImageUrl: r[4] ? `/uploads/${r[4]}` : null,
      }));

    res.json({ success: true, verifications });
  } catch (err) {
    console.error("get-verifications error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== Update Verification Status Route =====
app.post("/api/update-verification-status", async (req, res) => {
  try {
    const { email, status } = req.body;
    if (!email || !status)
      return res.status(400).json({ success: false, message: "Missing email or status" });

    const rows = await readSheet(SPREADSHEET_IDS.users, "ID_Verifications");
    const rowIndex = rows.findIndex((r) => r[1]?.toLowerCase() === email.toLowerCase());
    if (rowIndex === -1)
      return res.status(404).json({ success: false, message: "Record not found" });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: `ID_Verifications!D${rowIndex + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: [[status]] },
    });

    await sendEmail({
      to: email,
      subject: `Your ID Verification has been ${status}`,
      text: `Your ID verification status was updated to: ${status}`,
      html: `<p>Your ID verification status was updated to: <strong>${status}</strong>.</p>`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("update-verification-status error:", err);
    res.status(500).json({ success: false, message: "Failed to update verification" });
  }
});

// ===== Stripe Checkout Route =====
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { amount, successUrl, cancelUrl } = req.body;
    if (!amount || !successUrl || !cancelUrl)
      return res.status(400).json({ success: false, message: "Missing fields" });

    const amountCents = Math.round(amount * 100);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `Donation for ${campaignId}` },
          unit_amount: amountCents,
        },
        quantity: 1,
      }],
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    await sendEmail({
      to: process.env.EMAIL_FROM,
      subject: `New Donation: $${amount} for ${campaignId}`,
      text: `A new donation of $${amount} was made for ${campaignId}.`,
      html: `<p>A new donation of <strong>$${amount}</strong> was made for <strong>${campaignId}</strong>.</p>`,
    });

    res.json({ success: true, sessionId: session.id });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).json({ success: false, message: "Failed to create checkout session" });
  }
});

// ===== Catch-all API 404 =====
app.all("/api/*", (req, res) =>
  res.status(404).json({ success: false, message: "API route not found" })
);

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
