require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const sgMail = require("@sendgrid/mail");
const Stripe = require("stripe");
const path = require("path");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 5000;

// ===== Stripe Setup =====
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ===== CORS =====
const allowedOrigins = ["https://fundasmile.net", "https://www.fundasmile.net"];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.options("*", cors());

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static uploaded images
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ===== Session =====
app.set("trust proxy", 1); // required for HTTPS (Render)
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
      secure: true, // HTTPS required
      httpOnly: true,
      sameSite: "none", // allow cross-domain
      maxAge: 1000 * 60 * 60 * 24, // 1 day
    },
  })
);

// ===== Google Sheets =====
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
  scopes: SCOPES,
});
const sheets = google.sheets({ version: "v4", auth });

const SPREADSHEET_IDS = {
  users: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
  volunteers: "1O_y1yDiYfO0RT8eGwBMtaiPWYYvSR8jIDIdZkZPlvNA",
  streetteam: "1dPz1LqQq6SKjZIwsgIpQJdQzdmlOV7YrOZJjHqC4Yg8",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
  campaigns: "1XSS-2WJpzEhDe6RHBb8rt_6NNWNqdFpVTUsRa3TNCG8",
};

// ===== SendGrid =====
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ===== Helper Functions =====
async function saveToSheet(sheetId, sheetName, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

async function saveUser({ name, email, password }) {
  const hash = await bcrypt.hash(password, 10);
  await saveToSheet(SPREADSHEET_IDS.users, "Users", [
    new Date().toISOString(),
    name,
    email,
    hash,
  ]);
}

async function verifyUser(email, password) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!A:D",
  });
  const row = (data.values || []).find(
    (r) => r[2]?.toLowerCase() === email.toLowerCase()
  );
  if (!row) return false;
  const match = await bcrypt.compare(password, row[3]);
  return match ? { name: row[1], email: row[2] } : false;
}

// ===== Multer (File Upload) =====
const storage = multer.diskStorage({
  destination: path.join(__dirname, "uploads"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

// ===== AUTH ROUTES =====
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res
      .status(400)
      .json({ success: false, message: "All fields required." });
  try {
    await saveUser({ name, email, password });
    res.json({ success: true, message: "Account created!" });
  } catch {
    res.status(500).json({ success: false, message: "Error creating account." });
  }
});

app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res
      .status(400)
      .json({ success: false, error: "Email & password required." });
  try {
    const user = await verifyUser(email, password);
    if (!user)
      return res
        .status(401)
        .json({ success: false, error: "Invalid credentials." });
    req.session.user = user;
    res.json({ success: true, message: "Signed in!" });
  } catch {
    res.status(500).json({ success: false, error: "Server error." });
  }
});

app.get("/api/profile", (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ success: false, error: "Not authenticated." });
  res.json({ success: true, profile: req.session.user });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ===== CAMPAIGNS ROUTES =====
app.post("/api/campaigns", upload.single("image"), async (req, res) => {
  if (!req.session.user)
    return res
      .status(401)
      .json({ success: false, error: "Not authenticated" });

  try {
    const { title, description, goal, category } = req.body;
    if (!title || !description || !goal || !category)
      return res
        .status(400)
        .json({ success: false, error: "All fields required." });

    const id = Date.now().toString();
    const baseUrl =
      process.env.NODE_ENV === "production"
        ? "https://fundme-backend.onrender.com"
        : `http://localhost:${PORT}`;
    const imageUrl = req.file ? `${baseUrl}/uploads/${req.file.filename}` : "";

    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      id,
      title,
      req.session.user.email,
      goal,
      description,
      category,
      "Active",
      new Date().toISOString(),
      imageUrl,
    ]);

    res.json({ success: true, message: "Campaign created!", id, imageUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to create campaign" });
  }
});

app.get("/api/my-campaigns", async (req, res) => {
  if (!req.session.user)
    return res
      .status(401)
      .json({ success: false, error: "Not authenticated" });

  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:J",
    });
    const rows = data.values || [];
    if (rows.length < 2)
      return res.json({
        success: true,
        campaigns: [],
        total: 0,
        active: 0,
        deleted: [],
      });

    const campaigns = rows.slice(1).map((r) => ({
      id: r[0],
      title: r[1],
      email: r[2],
      goal: r[3],
      description: r[4],
      category: r[5],
      status: r[6],
      createdAt: r[7],
      imageUrl: r[8] || "",
    }));

    const myCampaigns = campaigns.filter(
      (c) => c.email === req.session.user.email
    );
    const active = myCampaigns.filter((c) => c.status === "Active");
    const deleted = myCampaigns.filter((c) => c.status === "Deleted");

    res.json({
      success: true,
      campaigns: myCampaigns,
      total: myCampaigns.length,
      active: active.length,
      deleted,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to fetch campaigns" });
  }
});

app.delete("/api/campaign/:id", async (req, res) => {
  if (!req.session.user)
    return res
      .status(401)
      .json({ success: false, error: "Not authenticated" });
  const id = req.params.id;

  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:J",
    });
    const rows = data.values || [];
    if (rows.length < 2)
      return res
        .status(404)
        .json({ success: false, error: "No campaigns found" });

    const campaignRowIndex = rows.findIndex((r) => r[0] === id);
    if (campaignRowIndex === -1)
      return res
        .status(404)
        .json({ success: false, error: "Campaign not found" });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: `Campaigns!G${campaignRowIndex + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: [["Deleted"]] },
    });

    res.json({ success: true, message: "Campaign deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to delete campaign" });
  }
});

// ===== STRIPE =====
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { amount, campaignId } = req.body;
    if (!amount || amount < 100)
      return res.status(400).json({ success: false, error: "Invalid amount" });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: `Donation to Campaign ${campaignId}` },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      success_url: "https://fundasmile.net/thankyou.html",
      cancel_url: "https://fundasmile.net/cancel.html",
    });

    res.json({ success: true, url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ success: false, error: "Payment failed" });
  }
});

// ===== START SERVER =====
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
