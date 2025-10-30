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

// ===== Multer (File Upload) =====
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ===== USER SIGNUP =====
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ success: false, message: "Missing fields" });

  try {
    const values = await getSheetValues(SPREADSHEET_IDS.users, "Users!A:D");
    const users = rowsToObjects(values);
    if (users.find((u) => u.Email.toLowerCase() === email.toLowerCase()))
      return res.status(400).json({ success: false, message: "Email already registered" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const joinDate = new Date().toISOString().split("T")[0];
    await saveToSheet(SPREADSHEET_IDS.users, "Users", [joinDate, name, email, hashedPassword]);
    req.session.user = { name, email, isAdmin: false };
    req.session.save((err) => {
      if (err) return res.status(500).json({ success: false, message: "Session error" });
      res.json({ success: true, user: { name, email } });
    });
  } catch (err) {
    console.error("signup error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== USER SIGNIN =====
app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: "Missing email or password" });

  try {
    const values = await getSheetValues(SPREADSHEET_IDS.users, "Users!A:D");
    const users = rowsToObjects(values);
    const user = users.find((u) => u.Email.toLowerCase() === email.toLowerCase());
    if (!user) return res.status(401).json({ success: false, message: "Invalid email or password" });

    const match = await bcrypt.compare(password, user.PasswordHash || "");
    if (!match) return res.status(401).json({ success: false, message: "Invalid email or password" });

    req.session.user = { name: user.Name, email: user.Email, isAdmin: false };
    req.session.save((err) => {
      if (err) return res.status(500).json({ success: false, message: "Session error" });
      res.json({ success: true, user: { name: user.Name, email: user.Email } });
    });
  } catch (err) {
    console.error("signin error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ===== CHECK SESSION =====
app.get("/api/check-session", (req, res) => {
  if (req.session.user) res.json({ loggedIn: true, user: req.session.user });
  else res.json({ loggedIn: false });
});

// ===== SIGNOUT =====
app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ success: false, message: "Logout failed" });
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

// ===== WAITLIST & VOLUNTEER =====
app.post("/api/volunteer", async (req, res) => {
  const { name, email, city, state, reason } = req.body;
  if (!name || !email) return res.status(400).json({ success: false, message: "Missing fields" });
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
  if (!name || !email) return res.status(400).json({ success: false, message: "Missing fields" });
  try {
    const date = new Date().toLocaleString();
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [date, name, email, source || "", reason || ""]);
    res.json({ success: true, message: "Added to waitlist!" });
  } catch (err) {
    console.error("Waitlist error:", err);
    res.status(500).json({ success: false, message: "Error saving to sheet" });
  }
});

// ===== CAMPAIGNS =====
app.post("/api/campaigns", upload.single("image"), async (req, res) => {
  const { name, email, title, description, goal } = req.body;

  // Check if user has ID verified
  try {
    const idValues = await getSheetValues(SPREADSHEET_IDS.iD_Verifications, "ID_Verifications!A:E");
    const verifications = rowsToObjects(idValues);
    const userVerification = verifications.find(v => v.Email === email);
    if (userVerification && userVerification.Status !== "Approved") {
      return res.status(400).json({ success: false, message: "You must verify your ID before creating a campaign." });
    }
  } catch(err) {
    console.error("Verification check error:", err);
  }

  const imageUrl = req.file ? `/uploads/${req.file.filename}` : "";
  try {
    const date = new Date().toLocaleString();
    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [date, name, email, title, description, goal, imageUrl, "Pending"]);
    res.json({ success: true, message: "Campaign submitted successfully" });
  } catch (err) {
    console.error("Campaign error:", err);
    res.status(500).json({ success: false, message: "Error saving campaign" });
  }
});

// ===== ID VERIFICATION =====
app.post("/api/verify-id", upload.single("idDocument"), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, message: "Not logged in" });
  if (!req.file) return res.status(400).json({ success: false, message: "No ID file uploaded" });

  try {
    const date = new Date().toLocaleString();
    const imageUrl = `/uploads/${req.file.filename}`;
    await saveToSheet(SPREADSHEET_IDS.iD_Verifications, "ID_Verifications", [date, req.session.user.email, req.session.user.name, "Pending", imageUrl]);
    res.json({ success: true, message: "ID submitted successfully", imageUrl, status: "Pending" });
  } catch (err) {
    console.error("ID verification error:", err);
    res.status(500).json({ success: false, message: "Error saving verification" });
  }
});

// ===== DASHBOARD DATA =====
app.get("/api/get-verifications", async (req, res) => {
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.iD_Verifications, "ID_Verifications!A:E");
    res.json({ success: true, verifications: rowsToObjects(values) });
  } catch (err) {
    console.error("get-verifications error:", err);
    res.status(500).json({ success: false, message: "Error fetching verifications" });
  }
});

app.get("/api/campaigns", async (req, res) => {
  try {
    const values = await getSheetValues(SPREADSHEET_IDS.campaigns, "Campaigns!A:H");
    res.json({ success: true, campaigns: rowsToObjects(values) });
  } catch (err) {
    console.error("campaigns fetch error:", err);
    res.status(500).json({ success: false, message: "Error fetching campaigns" });
  }
});

// ===== DONATIONS & CHECKOUT =====

// Create Stripe Checkout session for both campaigns and general donations
app.post("/api/create-checkout-session/:type", async (req, res) => {
  const { type } = req.params; // type = campaignId or 'mission'
  const { amount, donorEmail } = req.body;

  if (!amount || !donorEmail) return res.status(400).json({ success: false, message: "Missing fields" });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: type === "mission" ? "Donation to JoyFund Mission" : `Donation to Campaign ${type}` },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL || "https://fundasmile.net"}/success.html`,
      cancel_url: `${process.env.FRONTEND_URL || "https://fundasmile.net"}/cancel.html`,
      customer_email: donorEmail,
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error("Checkout session error:", err);
    res.status(500).json({ success: false, message: "Error creating checkout session" });
  }
});

// ===== Catch-All =====
app.all("/api/*", (req, res) => res.status(404).json({ success: false, message: "API route not found" }));

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
