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
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
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
    await sgMail.send({
      to,
      from: process.env.EMAIL_FROM,
      subject,
      text,
      html,
    });
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

// ===== Multer =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}${path.extname(file.originalname)}`),
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
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "Users!A:E",
    });
    const allUsers = data.values || [];
    const userRow = allUsers.find(
      (r) => r[2]?.toLowerCase() === email.toLowerCase()
    );
    if (!userRow) return false;
    const passwordMatch = await bcrypt.compare(password, userRow[3]);
    if (!passwordMatch) return false;

    const { data: verData } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "ID_Verifications!A:E",
    });
    const verRows = (verData.values || []).filter(
      (r) => r[1]?.toLowerCase() === email.toLowerCase()
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
      reason,
    ]);

    await sendEmail({
      to: process.env.EMAIL_FROM,
      subject: `New Waitlist Submission from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\nSource: ${source}\nReason: ${reason}`,
      html: `<p><strong>Name:</strong> ${name}</p>
             <p><strong>Email:</strong> ${email}</p>
             <p><strong>Source:</strong> ${source}</p>
             <p><strong>Reason:</strong> ${reason}</p>`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Waitlist save error:", err);
    res.status(500).json({ success: false, message: "Failed to submit waitlist." });
  }
});

// ===== Verify ID Route =====
app.post("/api/verify-id", upload.single("idImage"), async (req, res) => {
  try {
    if (!req.session.user) return res.status(401).json({ success: false, message: "Not signed in." });
    if (!req.file) return res.status(400).json({ success: false, message: "ID image is required" });

    const { email, name } = req.session.user;
    const filename = req.file.filename;

    await saveToSheet(SPREADSHEET_IDS.users, "ID_Verifications", [
      new Date().toISOString(),
      email,
      name,
      "Submitted",
      filename,
    ]);

    await sendEmail({
      to: process.env.EMAIL_FROM,
      subject: `New ID Verification Submitted by ${name}`,
      text: `Name: ${name}\nEmail: ${email}\nID File: ${filename}`,
      html: `<p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><p><strong>ID File:</strong> ${filename}</p>`,
    });

    res.json({ success: true, message: "ID verification submitted", image: `/uploads/${filename}` });
  } catch (err) {
    console.error("verify-id route error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ===== Get Verifications =====
app.get("/api/get-verifications", async (req, res) => {
  try {
    if (!req.session.user) return res.json({ success: false, message: "Not logged in" });
    const { email } = req.session.user;

    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "ID_Verifications!A:E",
    });

    const rows = data.values || [];
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

// ===== Admin Route: Update Verification Status =====
app.post("/api/update-verification-status", async (req, res) => {
  try {
    const { email, status } = req.body;
    if (!email || !status)
      return res.status(400).json({ success: false, message: "Missing email or status" });

    const range = "ID_Verifications!A:E";
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range,
    });

    const rows = data.values || [];
    const rowIndex = rows.findIndex((r) => r[1]?.toLowerCase() === email.toLowerCase());
    if (rowIndex === -1)
      return res.status(404).json({ success: false, message: "Record not found" });

    const updateRange = `ID_Verifications!D${rowIndex + 1}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: updateRange,
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

// ===== Stripe Checkout =====
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

// ===== Create Campaign Route =====
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ success: false, message: "You must be signed in." });
    }

    const { title, creatorEmail, goal, category, description } = req.body;
    if (!title || !creatorEmail || !goal || !category || !description) {
      return res.status(400).json({ success: false, message: "All fields are required." });
    }

    let imageFilename = "";
    if (req.file) {
      imageFilename = req.file.filename;
    }

    // Save campaign to Google Sheets
    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      new Date().toISOString(),
      title,
      creatorEmail,
      goal,
      category,
      description,
      imageFilename,
      "Active"
    ]);

    // Notify admin
    await sendEmail({
      to: process.env.EMAIL_FROM,
      subject: `New Campaign Created: ${title}`,
      text: `Title: ${title}\nCreator: ${creatorEmail}\nGoal: $${goal}\nCategory: ${category}\nDescription: ${description}`,
      html: `<p><strong>Title:</strong> ${title}</p>
             <p><strong>Creator:</strong> ${creatorEmail}</p>
             <p><strong>Goal:</strong> $${goal}</p>
             <p><strong>Category:</strong> ${category}</p>
             <p><strong>Description:</strong> ${description}</p>`
    });

    res.json({ success: true });
  } catch (err) {
    console.error("create-campaign error:", err);
    res.status(500).json({ success: false, message: "Failed to create campaign." });
  }
});

// ===== Get All Campaigns =====
app.get("/api/campaigns", async (req, res) => {
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:H", // Adjust columns if needed
    });

    const rows = data.values || [];
    const campaigns = rows.map((r) => ({
      createdAt: r[0],
      title: r[1],
      creatorEmail: r[2],
      goal: r[3],
      category: r[4],
      description: r[5],
      imageUrl: r[6] ? `/uploads/${r[6]}` : null,
      status: r[7] || "Active",
    }));

    res.json({ success: true, campaigns });
  } catch (err) {
    console.error("get campaigns error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch campaigns" });
  }
});

// ===== Catch-all API 404 =====
app.all("/api/*", (req, res) =>
  res.status(404).json({ success: false, message: "API route not found" })
);

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
