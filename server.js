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
  donations: "1C_xhW-dh3yQ7MpSoDiUWeCC2NNVWaurggia-f1z0YwA",
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

// (rest of your code unchanged)

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
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: `Donation for ${campaignId}` },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
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

// ===== 💗 JoyFund Mission Donation Route =====
app.post("/api/create-joyfund-checkout", async (req, res) => {
  try {
    const { amount, successUrl, cancelUrl } = req.body;
    if (!amount || !successUrl || !cancelUrl)
      return res.status(400).json({ success: false, message: "Missing fields" });

    const amountCents = Math.round(amount * 100);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Donation to JoyFund Mission" },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    res.json({ success: true, sessionId: session.id });
  } catch (err) {
    console.error("JoyFund checkout error:", err);
    res.status(500).json({ success: false, message: "Failed to create JoyFund checkout" });
  }
});

// ===== 💗 Stripe Webhook to Log JoyFund Donations =====
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed.", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle successful payment
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      try {
        await saveToSheet(SPREADSHEET_IDS.donations, "Donations", [
          session.id, // Donation ID
          session.customer_details?.name || "Anonymous Donor",
          session.customer_details?.email || "N/A",
          "JoyFund Mission", // Campaign Title/ID
          (session.amount_total / 100).toFixed(2),
          new Date().toISOString(),
          "Stripe",
          "Completed",
          "Processed via webhook",
        ]);
        console.log(`✅ Donation recorded: ${session.id}`);
      } catch (sheetErr) {
        console.error("Error saving donation to sheet:", sheetErr);
      }
    }

    res.json({ received: true });
  }
);

// ===== Catch-all API 404 =====
app.all("/api/*", (req, res) =>
  res.status(404).json({ success: false, message: "API route not found" })
);

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
