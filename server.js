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
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 5000;

// ===== Ensure uploads folder exists =====
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ===== Stripe Setup =====
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ===== CORS =====
const allowedOrigins = [
  "https://fundasmile.net",
  "https://www.fundasmile.net",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
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
  volunteers: "1O_y1yDiYfO0RT8eGwBMtaiPWYYvSR8jIDIdZkZPlvNA",
  streetteam: "1dPz1LqQq6SKjZIwsgIpQJdQzdmlOV7YrOZJjHqC4Yg8",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ",
  campaigns: "1XSS-2WJpzEhDe6RHBb8rt_6NNWNqdFpVTUsRa3TNCG8",
};

// ===== SendGrid =====
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

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

async function saveUser({ name, email, password }) {
  const hash = await bcrypt.hash(password, 10);
  await saveToSheet(SPREADSHEET_IDS.users, "Users", [
    new Date().toISOString(),
    name,
    email,
    hash,
    "false", // unverified
  ]);
}

// ===== VERIFY USER FUNCTION =====
async function verifyUser(email, password) {
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "Users!A:E",
    });

    const row = (data.values || []).find(
      (r) => r[2]?.toLowerCase() === email.toLowerCase()
    );

    if (!row) return false;

    const passwordMatch = await bcrypt.compare(password, row[3]);
    if (!passwordMatch) return false;

    return {
      name: row[1],
      email: row[2],
      verified: row[4] === "true",
      verificationStatus: row[4] === "true" ? "Verified" : "Pending",
    };
  } catch (err) {
    console.error("verifyUser error:", err);
    throw err;
  }
}

// ===== Multer (File Upload) =====
const storage = multer.diskStorage({
  destination: uploadsDir,
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
  } catch (err) {
    console.error("Signup error:", err);
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
      return res.status(401).json({ success: false, error: "Invalid credentials." });

    // Save session
    req.session.user = user;

    // Inform user about verification status
    const message = user.verified
      ? "Signed in successfully!"
      : "Signed in! ⚠️ Your account is pending ID verification.";

    res.json({ success: true, message, profile: user });
  } catch (err) {
    console.error("Signin error:", err);
    res.status(500).json({ success: false, error: "Server error." });
  }
});

app.get("/api/profile", (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ success: false, error: "Not authenticated." });
  res.json({ success: true, profile: req.session.user });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ success: true });
});

// ===== ID VERIFICATION =====
app.post("/api/verify-id", upload.single("idPhoto"), async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ success: false, error: "Not authenticated" });

  try {
    const idPhoto = req.file?.filename;
    if (!idPhoto)
      return res.status(400).json({ success: false, error: "ID photo is required." });

    const baseUrl =
      process.env.NODE_ENV === "production"
        ? process.env.BACKEND_BASE_URL || "https://fundme-backend.onrender.com"
        : `http://localhost:${PORT}`;

    const idPhotoUrl = `${baseUrl}/uploads/${idPhoto}`;

    console.log("SESSION:", req.session.user);
console.log("FILE:", req.file);
console.log("Attempting to save ID verification to sheet...");

    console.log("Saving ID Verification for user:", req.session.user.email);
    await saveToSheet(SPREADSHEET_IDS.users, "ID_Verifications", [
      new Date().toISOString(),
      req.session.user.email,
      idPhotoUrl,
      "Pending",
    ]);

    res.json({ success: true, message: "ID verification submitted successfully!" });
  } catch (err) {
    console.error("ID verification error:", err);
    res.status(500).json({ success: false, error: "Failed to submit verification." });
  }
});

// Get ID verification status for logged-in user
app.get("/api/id-verification-status", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ success: false, error: "Not authenticated." });

  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "ID_Verifications!A:D", // timestamp, email, idPhotoUrl, status
    });

    const rows = data.values || [];
    const userEmail = req.session.user.email.trim().toLowerCase();

    // Find the matching row by email
    const row = rows.find(r => (r[1] || "").trim().toLowerCase() === userEmail);

    if (!row) {
      return res.json({
        success: true,
        status: "Not submitted",
        idPhotoUrl: null,
      });
    }

    // Return whatever status the sheet has
    res.json({
      success: true,
      status: row[3] || "Pending", // default to Pending if missing
      idPhotoUrl: row[2] || null,
    });
  } catch (err) {
    console.error("Fetch ID verification status error:", err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch ID verification status.",
    });
  }
});
// ===== CAMPAIGNS =====
app.post("/api/campaigns", upload.single("image"), async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ success: false, error: "Not authenticated" });

  if (!req.session.user.verified)
    return res
      .status(403)
      .json({ success: false, error: "ID verification required" });

  try {
    const { title, description, goal, category } = req.body;
    if (!title || !description || !goal || !category)
      return res
        .status(400)
        .json({ success: false, error: "All fields required." });

    const id = Date.now().toString();
    const baseUrl =
      process.env.NODE_ENV === "production"
        ? process.env.BACKEND_BASE_URL || "https://fundme-backend.onrender.com"
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
    console.error("Create campaign error:", err);require("dotenv").config();
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
const fs = require("fs");

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
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

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
};

// ===== SendGrid =====
if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

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
    "false", // verified default
  ]);
}

async function verifyUser(email, password) {
  const { data: userData } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!A:E",
  });

  const userRow = (userData.values || []).find(r => r[2]?.toLowerCase() === email.toLowerCase());
  if (!userRow) return false;

  const passwordMatch = await bcrypt.compare(password, userRow[3]);
  if (!passwordMatch) return false;

  // Check latest ID verification
  const { data: verData } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "ID_Verifications!A:D",
  });

  const verRows = (verData.values || []).filter(r => r[1]?.toLowerCase() === email.toLowerCase());
  const latestVer = verRows.length ? verRows[verRows.length - 1] : null;
  const verificationStatus = latestVer ? latestVer[3] : "Pending";
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
    const message = user.verified
      ? "Signed in successfully!"
      : "Signed in! ⚠️ Your account is pending ID verification.";

    res.json({ success: true, message, profile: user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Server error." });
  }
});

app.get("/api/profile", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  res.json({ success: true, profile: req.session.user });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ success: true });
});

// ===== ID Verification =====
app.post("/api/verify-id", upload.single("idPhoto"), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });

  try {
    const idPhoto = req.file?.filename;
    if (!idPhoto) return res.status(400).json({ success: false, error: "ID photo is required." });

    const baseUrl = process.env.NODE_ENV === "production"
      ? process.env.BACKEND_BASE_URL || "https://fundme-backend.onrender.com"
      : `http://localhost:${PORT}`;
    const idPhotoUrl = `${baseUrl}/uploads/${idPhoto}`;

    await saveToSheet(SPREADSHEET_IDS.users, "ID_Verifications", [
      new Date().toISOString(),
      req.session.user.email,
      idPhotoUrl,
      "Pending",
    ]);

    res.json({ success: true, message: "ID verification submitted successfully!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to submit verification." });
  }
});

// ===== Campaigns =====
app.post("/api/campaigns", upload.single("image"), async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  if (!req.session.user.verified) return res.status(403).json({ success: false, error: "ID verification required." });

  try {
    const { title, description, goal, category } = req.body;
    if (!title || !description || !goal || !category) return res.status(400).json({ success: false, error: "All fields required." });

    const id = Date.now().toString();
    const baseUrl = process.env.NODE_ENV === "production"
      ? process.env.BACKEND_BASE_URL || "https://fundme-backend.onrender.com"
      : `http://localhost:${PORT}`;
    const imageUrl = req.file ? `${baseUrl}/uploads/${req.file.filename}` : "";

    await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", [
      id,
      title,
      req.session.user.email,
      goal,
      description,
      category,
      "Pending", // default to pending approval
      new Date().toISOString(),
      imageUrl,
    ]);

    res.json({ success: true, message: "Campaign created!", id, imageUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to create campaign." });
  }
});

// ===== Pending Campaigns for Admin =====
app.get("/api/pending-campaigns", async (req, res) => {
  // For now, any authenticated user can fetch pending campaigns
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });

  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:I",
    });

    const campaigns = (data.values || []).map(r => ({
      id: r[0],
      title: r[1],
      creatorEmail: r[2],
      goal: r[3],
      description: r[4],
      category: r[5],
      status: r[6],
      createdAt: r[7],
      imageUrl: r[8] || "",
    }));

    const pending = campaigns.filter(c => c.status === "Pending");
    res.json({ success: true, campaigns: pending });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to fetch pending campaigns." });
  }
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

    res.status(500).json({ success: false, error: "Failed to create campaign" });
  }
});

// ===== START SERVER =====
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
