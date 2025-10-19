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
    origin: ["https://fundasmile.net","https://www.fundasmile.net","http://localhost:3000"],
    methods: ["GET","POST","OPTIONS"], // add OPTIONS explicitly
    allowedHeaders: ["Content-Type"],
    credentials: true
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
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ" // <--- Add your Waitlist sheet ID
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
}

async function verifyUser(email, password) {
  const { data: userData } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!A:E",
  });

  const userRow = (userData.values || []).find(
    (r) => r[2]?.toLowerCase() === email.toLowerCase()
  );
  if (!userRow) return false;

  const passwordMatch = await bcrypt.compare(password, userRow[3]);
  if (!passwordMatch) return false;

  const { data: verData } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "ID_Verifications!A:D",
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
}

// ===== AUTH ROUTES =====
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ success: false, message: "All fields required." });

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
  if (!email || !password)
    return res.status(400).json({ success: false, error: "Email & password required." });

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
    return res.status(401).json({ success: false, error: "Not authenticated." });

  try {
    const idPhoto = req.file?.filename;
    if (!idPhoto)
      return res.status(400).json({ success: false, error: "ID photo is required." });

    const baseUrl =
      process.env.NODE_ENV === "production"
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

app.get("/api/id-verification-status", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ success: false, error: "Not authenticated." });

  try {
    const userEmail = req.session.user.email.trim().toLowerCase();
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.users,
      range: "ID_Verifications!A:D",
    });

    const rows = data.values || [];
    const userRow = rows.find((r) => r[1]?.trim().toLowerCase() === userEmail);
    if (!userRow) {
      req.session.user.verified = false;
      req.session.user.verificationStatus = "Not submitted";
      return res.json({ success: true, status: "Not submitted", idPhotoUrl: null });
    }

    const status = userRow[3] || "Pending";
    const idPhotoUrl = userRow[2] || null;
    req.session.user.verificationStatus = status;
    req.session.user.verified = status.toLowerCase() === "approved";

    res.json({ success: true, status, idPhotoUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to fetch ID verification status." });
  }
});

// ===== Waitlist Route =====
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;

  if (!name || !email || !source || !reason) {
    return res.status(400).json({ success: false, message: "All fields required." });

  try {
    // 1️⃣ Save to Google Sheet
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [
      new Date().toISOString(),
      name,
      email,
      source,
      reason,
    ]);

    // 2️⃣ Send emails (if API key exists), but do NOT block response on failure
    if (process.env.SENDGRID_API_KEY) {
      try {
        const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";

        const messages = [
          {
            to: email,
            from: adminEmail,
            subject: "Successfully Joined Waitlist!",
            html: `<p>Hi ${name},</p><p>Thank you for joining the JoyFund INC waitlist! 🎉</p>`,
          },
          {
            to: adminEmail,
            from: adminEmail,
            subject: `New waitlist submission from ${name}`,
            html: `<p>${name} (${email}) just joined the waitlist.</p>`,
          },
        ];

        await sgMail.send(messages);
        console.log("SendGrid emails sent successfully");
      } catch (emailErr) {
        console.error("SendGrid email failed:", emailErr.response?.body || emailErr);
      }
    }

    // 3️⃣ Save local backup
    try {
      const localFile = path.join(__dirname, "waitlist-backup.json");
      const existing = fs.existsSync(localFile)
        ? JSON.parse(fs.readFileSync(localFile))
        : [];
      existing.push({ timestamp: new Date().toISOString(), name, email, source, reason });
      fs.writeFileSync(localFile, JSON.stringify(existing, null, 2));
      console.log("Saved waitlist entry to local backup.");
    } catch (fsErr) {
      console.error("Failed to save local backup:", fsErr);
    }

    // 4️⃣ Always respond success if Sheets worked
    res.json({
      success: true,
      message: "Successfully joined waitlist! Please check your email for updates.",
    });

  } catch (err) {
    console.error("Failed to add to waitlist:", err);
    res.status(500).json({
      success: false,
      message: "Failed to join waitlist. Please try again later.",
    });
  }
});
  }
});

// ===== Campaign Routes =====
app.get("/api/my-campaigns", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ success: false, error: "Not authenticated." });

  try {
    const userEmail = req.session.user.email.trim().toLowerCase();
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_IDS.campaigns,
      range: "Campaigns!A:I",
    });

    const rows = data.values || [];
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

    const userCampaigns = campaigns.filter((c) => c.email?.toLowerCase() === userEmail);
    res.json({ success: true, campaigns: userCampaigns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to fetch campaigns." });
  }
});

app.post("/api/campaigns", upload.single("image"), async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ success: false, error: "Not authenticated." });
  if (!req.session.user.verified)
    return res.status(403).json({ success: false, error: "ID verification required." });

  try {
    const { title, description, goal, category } = req.body;
    if (!title || !description || !goal || !category)
      return res.status(400).json({ success: false, error: "All fields required." });

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
      "Pending",
      new Date().toISOString(),
      imageUrl,
    ]);

    res.json({ success: true, message: "Campaign created!", id, imageUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Failed to create campaign." });
  }
});

app.get("/api/test-email", async (req, res) => {
  try {
    const sgMail = require("@sendgrid/mail");
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);

    const msg = {
      to: process.env.ADMIN_EMAIL,
      from: process.env.ADMIN_EMAIL,
      subject: "✅ SendGrid Test from JoyFund",
      text: "This is a test email confirming SendGrid is working correctly.",
    };

    await sgMail.send(msg);
    res.status(200).send("✅ Email sent successfully!");
  } catch (error) {
    console.error("❌ SendGrid test failed:", error);
    res.status(500).send("❌ Email test failed. Check Render logs.");
  }
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
