// ==================== SERVER.JS - JOYFUND BACKEND ====================
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const crypto = require("crypto");
const Stripe = require("stripe");
const cloudinary = require("cloudinary").v2;
const cors = require("cors");
const fs = require("fs");

const mongoose = require("./db");
const db = mongoose.connection;

db.on("error", console.error.bind(console, "MongoDB connection error:"));
db.once("open", () => {
  console.log("✅ MongoDB native db ready");
});

// ==================== ENV VARIABLES ====================
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = "joyfund";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "mk_1S3ksM0qKIo9Xb6efUvOzm2B";
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const MAILJET_API_KEY = process.env.MAILJET_API_KEY;
const MAILJET_API_SECRET = process.env.MAILJET_API_SECRET;

const FRONTEND_URL = process.env.FRONTEND_URL || "https://fundasmile.net";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "FunDMe$123";
const SESSION_SECRET = process.env.SESSION_SECRET || "supersecretkey";

// ==================== APP ====================
const app = express();
app.set("trust proxy", 1); // important on Render/behind proxy

// ==================== CORS (must be before routes) ====================
const allowedOrigins = [
  "https://fundasmile.net",
  "https://www.fundasmile.net"
];

const corsOptions = {
  origin: function(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS blocked: " + origin));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // ✅ this is the fix


// ==================== MIDDLEWARE ====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ==================== PRODUCTION-READY SESSION ====================
const MongoStore = require("connect-mongo");

app.set("trust proxy", 1);

app.use(session({
  name: "connect.sid",          // ✅ single cookie name (or change to "joyfund.sid")
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
}));

// ==================== CLOUDINARY ====================
if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET
  });
}

const storage = multer.memoryStorage();
const upload = multer({ storage });

// ==================== STRIPE CHECKOUT (DONATIONS) ====================
const stripe = Stripe(STRIPE_SECRET_KEY);
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  try {
    const campaignId = req.params.campaignId;

    // amount in dollars from frontend
    const amount = Number(req.body.amount);
    if (!amount || !isFinite(amount) || amount < 1) {
      return res.status(400).json({ error: "Invalid donation amount" });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: "STRIPE_SECRET_KEY is not set on the backend" });
    }
    //verify campaign exists & approved
    const campaign = await db.collection("Campaigns").findOne({
      $or: [
        { Id: String(campaignId) },                 // your custom Id field
        { _id: new (require("mongodb").ObjectId)(campaignId) } // mongo _id
      ],
      Status: "Approved"
    }).catch(() => null);

    if (!campaign) {
      return res.status(404).json({ error: "Campaign not found or not approved" });
    }

    const baseSuccessUrl = req.body.successUrl || "https://fundasmile.net/thankyou.html";
    const successUrl = `${baseSuccessUrl}${baseSuccessUrl.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl  = req.body.cancelUrl  || "https://fundasmile.net/campaigns.html";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: campaign.title || "JoyFund Donation",
              description: "Donation to support a JoyFund campaign",
              images: campaign.ImageURL ? [campaign.ImageURL] : undefined
            },
            unit_amount: Math.round(amount * 100) // cents
          },
          quantity: 1
        }
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        campaignId: String(campaignId),
        campaignTitle: String(campaign.title || "")
      }
    });

    return res.json({ sessionId: session.id });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    return res.status(500).json({ error: "Failed to create checkout session" });
  }
});
// ==================== MAILJET ====================
const Mailjet = require("node-mailjet");
const mailjetClient =
  MAILJET_API_KEY && MAILJET_API_SECRET ? Mailjet.connect(MAILJET_API_KEY, MAILJET_API_SECRET) : null;

async function sendMailjetEmail(subject, htmlContent, toEmail) {
  if (!mailjetClient) return;
  try {
    await mailjetClient.post("send", { version: "v3.1" }).request({
      Messages: [{
        From: { Email: process.env.MAILJET_SENDER_EMAIL || "admin@joyfund.net", Name: "JoyFund INC" },
        To: [{ Email: toEmail || process.env.NOTIFY_EMAIL }],
        Subject: subject,
        HTMLPart: htmlContent
      }]
    });
  } catch (err) {
    console.error("Mailjet error:", err);
  }
}

// ==================== LIVE VISITOR TRACKING ====================
const liveVisitors = {};
app.post("/api/track-visitor", (req, res) => {
  const { visitorId } = req.body;
  if (!visitorId) return res.status(400).json({ success: false, message: "Missing visitorId" });

  const now = Date.now();
  liveVisitors[visitorId] = now;

  for (const id in liveVisitors) {
    if (now - liveVisitors[id] > 30000) delete liveVisitors[id];
  }

  res.json({ success: true, activeCount: Object.keys(liveVisitors).length });
});

// ==================== USERS & AUTH ====================

// Sign up a new user
app.post("/api/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const usersCollection = db.db(DB_NAME).collection("Users");
    const existing = await usersCollection.findOne({
      Email: { $regex: `^${email}$`, $options: "i" }
    });
    if (existing) return res.status(400).json({ error: "Email already exists" });

    const hashed = await bcrypt.hash(password, 10);
    const newUser = {
      Name: name,
      Email: email,
      PasswordHash: hashed,
      JoinDate: new Date()
    };

    await usersCollection.insertOne(newUser);

    req.session.user = {
      name: newUser.Name,
      email: newUser.Email,
      joinDate: newUser.JoinDate
    };

    // ✅ IMPORTANT: force session write before responding (mobile fix)
    req.session.save((err) => {
      if (err) {
        console.error("Session save error (signup):", err);
        return res.status(500).json({ error: "Session failed to save" });
      }
      return res.json({ ok: true, loggedIn: true, user: req.session.user });
    });

  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Signup failed" });
  }
});

// Sign in an existing user
app.post("/api/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });

    const usersCollection = db.collection("Users");
    const user = await usersCollection.findOne({
      Email: { $regex: `^${email}$`, $options: "i" }
    });

    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.PasswordHash);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    req.session.user = {
      name: user.Name,
      email: user.Email,
      joinDate: user.JoinDate
    };

    // ✅ IMPORTANT: force session write before responding (mobile fix)
    req.session.save((err) => {
      if (err) {
        console.error("Session save error (signin):", err);
        return res.status(500).json({ error: "Session failed to save" });
      }
      return res.json({ ok: true, loggedIn: true, user: req.session.user });
    });

  } catch (err) {
    console.error("Signin error:", err);
    res.status(500).json({ error: "Signin failed" });
  }
});

// Sign out the current user
app.post("/api/signout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true });
  });
});

// Check if the user is logged in
app.get("/api/check-session", (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false, user: null });
  }
});

// ==================== ADMIN ====================
function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(403).json({ success: false, message: "Forbidden" });
}

app.post("/api/admin-login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.admin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ success: false, message: "Invalid credentials" });
});

app.post("/api/admin-logout", (req, res) => {
  req.session.destroy(err =>
    err ? res.status(500).json({ success: false }) : res.json({ success: true })
  );
});

app.get("/api/admin-check", (req, res) => {
  res.json({ admin: !!(req.session && req.session.admin) });
});

// ==================== PUBLIC: ACTIVE CAMPAIGNS (SEARCH/LIST) ====================
app.get("/api/campaigns", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    // IMPORTANT: your Mongo collection is likely lowercase "campaigns"
    const col = db.collection("campaigns");

    // Status field in your docs appears to be "Status" (capital S)
    // Accept a couple common "active" meanings to avoid mismatches.
    const activeStatuses = ["Active", "Approved"];

    const filter = { Status: { $in: activeStatuses } };

    if (q) {
      filter.$or = [
        { title: { $regex: q, $options: "i" } },
        { Description: { $regex: q, $options: "i" } },
        { Category: { $regex: q, $options: "i" } }
      ];
    }

    const campaigns = await col
      .find(filter)
      .sort({ CreatedAt: -1 })
      .toArray();

    res.json({ ok: true, campaigns });
  } catch (err) {
    console.error("GET /api/campaigns error:", err);
    res.status(500).json({ ok: false, message: "Failed to load campaigns" });
  }
});

// ==================== CAMPAIGNS ====================
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  try {
    const { title, goal, description, category, email } = req.body;

    if (!title || !goal || !description || !category || !email || !req.file) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    // Upload to Cloudinary
    const cloudRes = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "joyfund/campaigns", use_filename: true, unique_filename: true },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(req.file.buffer);
    });

    const doc = {
      Id: String(Date.now()),
      title: String(title).trim(),
      Email: String(email).trim().toLowerCase(),
      Goal: String(goal).trim(),
      Description: String(description).trim(),
      Category: String(category).trim(),
      Status: "Pending",
      CreatedAt: new Date().toISOString(),
      ImageURL: cloudRes.secure_url
    };

    await db.collection("Campaigns").insertOne(doc);

    return res.json({ success: true, campaign: doc });
  } catch (err) {
    console.error("create-campaign error:", err);
    return res.status(500).json({ success: false, message: "Create campaign failed" });
  }
});

app.get("/api/public-campaigns", async (req, res) => {
  try {
    const rows = await db.collection("Campaigns").find({ Status: "Approved" }).toArray();
    res.json({ success: true, campaigns: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.get("/api/my-campaigns", async (req, res) => {
  try {
    // Must be logged in
    const sessionEmail = req.session?.user?.email;
    if (!sessionEmail) {
      return res.status(401).json({ success: false, message: "Not logged in" });
    }

    const email = String(sessionEmail).trim().toLowerCase();

    // Support both field names just in case (Email vs email)
    const rows = await db.collection("Campaigns")
      .find({ $or: [{ Email: email }, { email: email }] })
      .toArray();

    return res.json({ success: true, campaigns: rows });
  } catch (err) {
    console.error("my-campaigns error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ==================== DONATIONS ====================
app.post("/api/donation", async (req, res) => {
  try {
    const { name, email, amount, campaignId } = req.body;
    if (!name || !email || !amount) return res.status(400).json({ success: false });

    await db.collection("Donations").insertOne({ name, email, amount, campaignId, date: new Date() });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.get("/api/donations", async (req, res) => {
  try {
    const rows = await db.collection("Donations").find({}).toArray();
    res.json({ success: true, donations: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ==================== WAITLIST / VOLUNTEERS / STREET TEAM ====================
app.post("/api/waitlist", async (req, res) => {
  try {
    const { name, email, reason } = req.body;
    const row = { name, email, reason, createdAt: new Date() };

    await db.collection("Waitlist").insertOne(row);
    await sendMailjetEmail(
      "New Waitlist Submission",
      `<p>${name} (${email}) joined the waitlist. Reason: ${reason || "N/A"}</p>`,
      process.env.NOTIFY_EMAIL
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.post("/api/volunteer", async (req, res) => {
  try {
    const { name, email, role, availability } = req.body;
    const row = { name, email, role, availability, createdAt: new Date() };

    await db.collection("Volunteers").insertOne(row);
    await sendMailjetEmail(
      "New Volunteer Submission",
      `<p>${name} (${email}) signed up as volunteer for ${role}.</p>`,
      process.env.NOTIFY_EMAIL
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.post("/api/street-team", async (req, res) => {
  try {
    const { name, email, city, hoursAvailable } = req.body;
    const row = { name, email, city, hoursAvailable, createdAt: new Date() };

    await db.collection("StreetTeam").insertOne(row);
    await sendMailjetEmail(
      "New Street Team Submission",
      `<p>${name} (${email}) joined street team in ${city}.</p>`,
      process.env.NOTIFY_EMAIL
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

//====================LOGOUT=============================
app.post("/api/logout", (req, res) => {
  try {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ ok: false, error: "Logout failed" });

      // IMPORTANT: clear the same cookie name/path your session uses
      res.clearCookie("connect.sid", {
        path: "/",
        secure: true,
        sameSite: "none"
      });

      return res.json({ ok: true });
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Logout failed" });
  }
});

// ==================== ID VERIFICATION ====================
app.post("/api/verify-id", upload.single("idFile"), async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!req.file || !name || !email) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    // If you're uploading from buffer, you must use upload_stream as well.
    const cloudRes = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "joyfund/id-verifications", use_filename: true, unique_filename: true },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(req.file.buffer);
    });

    await db.collection("ID_Verifications").insertOne({
      name,
      email,
      url: cloudRes.secure_url,
      createdAt: new Date()
    });

    res.json({ success: true, url: cloudRes.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/id-verifications", async (req, res) => {
  try {
    const rows = await db.collection("ID_Verifications").find({}).toArray();
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ==================== STATIC FILES ====================
app.use(express.static("public"));

// ==================== START SERVER ====================
app.listen(PORT, () => console.log(`JoyFund backend running on port ${PORT}`));