// ==================== SERVER.JS - JOYFUND BACKEND ====================
require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const crypto = require("crypto");
const WAITLIST_COLLECTION = "waitlist";
const Stripe = require("stripe");
const cloudinary = require("cloudinary").v2;
const cors = require("cors");
const fs = require("fs");
const { ObjectId } = require("mongodb");

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
app.set("trust proxy", 1);
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

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

async function getIdentityStatus(email) {
  if (!email) return "Not Submitted";

  const cleanEmail = String(email).trim().toLowerCase();
  const emailExactI = new RegExp("^" + cleanEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");

  const latest = await db.collection("ID_Verifications")
    .find({ $or: [{ email: emailExactI }, { Email: emailExactI }] })
    .sort({ ReviewedAt: -1, createdAt: -1, CreatedAt: -1, _id: -1 })
    .limit(1)
    .toArray();

  const row = latest[0];
  if (!row) return "Not Submitted";
  return row.Status ?? row.status ?? "Pending";
}

async function isIdentityApproved(email) {
  if (!email) return false;

  const cleanEmail = String(email).trim().toLowerCase();
  const emailExactI = new RegExp("^" + cleanEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");

  const row = await db.collection("ID_Verifications").findOne({
    Status: "Approved",
    $or: [{ email: emailExactI }, { Email: emailExactI }]
  });

  return !!row;
}

async function requireVerifiedIdentity(req, res, next) {
  try {
    const userEmail = req.session?.user?.email;
    if (!userEmail) {
      return res.status(401).json({ success: false, message: "Not logged in" });
    }

    const ok = await isIdentityApproved(userEmail);
    if (!ok) {
      return res.status(403).json({ success: false, message: "Identity not verified" });
    }

    next();
  } catch (err) {
    console.error("requireVerifiedIdentity error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
}



// ==================== MIDDLEWARE ====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ==================== PRODUCTION-READY SESSION ====================
const MongoStorePkg = require("connect-mongo");
const MongoStore = MongoStorePkg.default || MongoStorePkg;

// ✅ Reuse the already-connected Mongoose/Mongo client
app.use(session({
  name: "connect.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  store: MongoStore.create({
    client: db.getClient(),          // ✅ key fix: no separate mongoUrl auth
    dbName: "joyfund",               // optional but nice
    collectionName: "sessions"
  }),
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
    // ✅ IMPORTANT: Stripe secret key MUST start with "sk_"
    if (!STRIPE_SECRET_KEY || !STRIPE_SECRET_KEY.startsWith("sk_")) {
      console.error("❌ STRIPE_SECRET_KEY is missing or invalid (must start with sk_)");
      return res.status(500).json({ error: "Stripe secret key not configured" });
    }

    const campaignId = String(req.params.campaignId || "").trim();

    // Amount comes from frontend in dollars
    const amount = Number(req.body.amount);
    if (!amount || !isFinite(amount) || amount < 1) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // Use your real domain(s) for redirects
    const successUrl = "https://fundasmile.net/donation-success.html?session_id={CHECKOUT_SESSION_ID}";
    const cancelUrl = "https://fundasmile.net/donation-cancelled.html";

    // ✅ Special case: mission donation (no MongoDB lookup)
    if (campaignId.toLowerCase() === "mission") {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "JOYFUND Mission" },
              unit_amount: Math.round(amount * 100),
            },
            quantity: 1,
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { type: "mission" },
      });

      return res.json({ url: session.url });
    }

    // ✅ Otherwise: normal campaign donation flow (optional)
    // If you don’t want campaign donations here, you can remove this block.
    // If you DO, make sure this lookup matches your schema.
const campaign = await db.collection("Campaigns").findOne({
  $or: [
    { _id: ObjectId.isValid(campaignId) ? new ObjectId(campaignId) : campaignId },
    { Id: campaignId }
  ]
});

if (!campaign) {
  return res.status(404).json({ error: "Campaign not found" });
}
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: campaign.title || campaign.Title || "JOYFUND Campaign" },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { type: "campaign", campaignId: String(campaign._id) },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("❌ Stripe checkout error:", err?.message || err, err);
    return res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ==================== MAILJET ====================
const Mailjet = require("node-mailjet");

const mailjetClient =
  process.env.MAILJET_API_KEY && process.env.MAILJET_API_SECRET
    ? Mailjet.connect(process.env.MAILJET_API_KEY, process.env.MAILJET_API_SECRET)
    : null;

const FROM_EMAIL =
  process.env.EMAIL_FROM ||
  process.env.MAILJET_SENDER_EMAIL ||
  "admin@joyfund.net";

const FROM_NAME =
  process.env.MAILJET_SENDER_NAME || "JoyFund INC";

const ADMIN_EMAIL =
  process.env.ADMIN_EMAIL ||
  process.env.NOTIFY_EMAIL ||
  process.env.EMAIL_TO;

async function sendMailjet({ toEmail, toName, subject, html }) {
  if (!mailjetClient) {
    console.warn("⚠️ Mailjet not configured (missing API key/secret).");
    return;
  }
  if (!toEmail) return;

  console.log("📧 Mailjet sending:", {
    from: FROM_EMAIL,
    toEmail,
    subject,
    hasHtml: !!html,
    mailjetConfigured: !!mailjetClient
  });

  try {
    await mailjetClient.post("send", { version: "v3.1" }).request({
      Messages: [
        {
          From: { Email: FROM_EMAIL, Name: FROM_NAME },
          To: [{ Email: toEmail, Name: toName || "" }],
          Subject: subject,
          HTMLPart: html
        }
      ]
    });
  } catch (err) {
    console.error("Mailjet error:", err);
  }
}

// one call = sends admin + user confirmation
async function sendSubmissionEmails({
  type,
  userEmail,
  userName,
  adminHtml,
  userHtml,
  adminSubject,
  userSubject
}) {
  const tasks = [];

  // Admin copy
  tasks.push(
    sendMailjet({
      toEmail: ADMIN_EMAIL,
      subject: adminSubject || `New ${type} submission`,
      html: adminHtml
    })
  );

  // User copy
  if (userEmail) {
    tasks.push(
      sendMailjet({
        toEmail: userEmail,
        toName: userName || "",
        subject: userSubject || `We received your ${type}`,
        html: userHtml
      })
    );
  }

  await Promise.allSettled(tasks);
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

    const usersCollection = db.collection("Users"); // ✅ FIXED (no db.db)

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanName = String(name).trim();

    const existing = await usersCollection.findOne({ Email: cleanEmail });
    if (existing) return res.status(400).json({ error: "Email already exists" });

    const hashed = await bcrypt.hash(String(password), 10);

    const newUser = {
      Name: cleanName,
      Email: cleanEmail,
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
app.get("/api/check-session", async (req, res) => {
  try {
    if (!req.session.user) {
      return res.json({
        loggedIn: false,
        user: null,
        identityVerified: false,
        identityStatus: "Not Submitted"
      });
    }

    const identityStatus = await getIdentityStatus(req.session.user.email);
    const identityVerified = identityStatus === "Approved";

    return res.json({
      loggedIn: true,
      user: req.session.user,
      identityVerified,
      identityStatus
    });
  } catch (err) {
    console.error("check-session error:", err);
    return res.json({
      loggedIn: false,
      user: null,
      identityVerified: false,
      identityStatus: "Not Submitted"
    });
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

// ==================== ADMIN: USERS LIST ====================
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    // ✅ Your real collection is "Users" (capital U)
    const rawUsers = await db.collection("Users")
      .find({})
      .sort({ JoinDate: -1, _id: -1 })
      .limit(2000)
      .toArray();

    // Pull latest verification per user by email (ID_Verifications stores lowercase email)
    const users = await Promise.all(rawUsers.map(async (u) => {
      const email = String(u.Email ?? u.email ?? "").trim().toLowerCase();

      let identityStatus = "Not Submitted";
let idvId = null;
let idvStatus = "Not Submitted";

if (email) {
  const emailExactI = new RegExp("^" + email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");

  const v = await db.collection("ID_Verifications")
    .find({ $or: [{ email: emailExactI }, { Email: emailExactI }] })
    .sort({ ReviewedAt: -1, createdAt: -1, CreatedAt: -1, _id: -1 })
    .limit(1)
    .toArray();

  const latest = v[0];
  if (latest) {
    idvId = String(latest._id);
    idvStatus = latest.Status ?? latest.status ?? "Pending";
    identityStatus = idvStatus;
  }
}

return {
  _id: String(u._id),
  joinDate: u.JoinDate ?? u.joinDate ?? null,
  name: u.Name ?? u.name ?? "—",
  email: u.Email ?? u.email ?? "—",
  identityStatus,

  // ✅ add these for buttons
  idvId,
  idvStatus
	};
  }));

    return res.json({ success: true, users });
  } catch (err) {
    console.error("❌ /api/admin/users error:", err);
    // TEMP: return the real error so we can finish debugging fast
    return res.status(500).json({
      success: false,
      message: "Failed to load users",
      error: String(err?.message || err)
    });
  }
});

// ==================== ADMIN: WAITLIST LIST ====================
app.get("/api/admin/waitlist", requireAdmin, async (req, res) => {
  try {
    // Your canonical merged collection is "waitlist" (lowercase)
    const waitlist = await db.collection("waitlist")
      .find({})
      .sort({ createdAt: -1 })
      .limit(1000)
      .toArray();

    return res.json({ success: true, waitlist });
  } catch (err) {
    console.error("GET /api/admin/waitlist error:", err);
    return res.status(500).json({ success: false, message: "Failed to load waitlist" });
  }
});


// ==================== ADMIN: VOLUNTEERS LIST ====================
app.get("/api/admin/volunteers", requireAdmin, async (req, res) => {
  try {
    const volunteers = await db.collection("Volunteers")
      .find({})
      .sort({ createdAt: -1 })
      .limit(1000)
      .toArray();

    return res.json({ success: true, volunteers });
  } catch (err) {
    console.error("GET /api/admin/volunteers error:", err);
    return res.status(500).json({ success: false, message: "Failed to load volunteers" });
  }
});


// Normalize campaign fields so the admin page always gets consistent keys
function normalizeCampaign(doc) {
  return {
    _id: String(doc._id),   // Mongo ID
    Id: doc.Id || null,    // 👈 ADD THIS
    title: doc.title ?? doc.Title ?? "Untitled",
    email: doc.Email ?? doc.email ?? "—",
    goal: doc.Goal ?? doc.goal ?? "—",
    status: doc.Status ?? doc.status ?? "—",
    createdAt: doc.CreatedAt ?? doc.createdAt ?? null,
    imageUrl: doc.ImageURL ?? doc.imageUrl ?? null,
    category: doc.Category ?? doc.category ?? null
  };
}

// Normalize ID verification fields
function normalizeIdv(doc) {
  return {
    _id: String(doc._id),
    name: doc.name ?? doc.Name ?? "—",
    email: doc.email ?? doc.Email ?? "—",
    url: doc.url ?? doc.URL ?? null,
    status: doc.Status ?? doc.status ?? "Pending",
    createdAt: doc.createdAt ?? doc.CreatedAt ?? null,
    reviewedAt: doc.ReviewedAt ?? null,
    reviewedBy: doc.ReviewedBy ?? null,
    denialReason: doc.DenialReason ?? null
  };
}

// ==================== ADMIN: STREET TEAM LIST ====================
app.get("/api/admin/street-team", requireAdmin, async (req, res) => {
  try {
    const streetTeam = await db.collection("StreetTeam")
      .find({})
      .sort({ createdAt: -1 })
      .limit(1000)
      .toArray();

    return res.json({ success: true, streetTeam });
  } catch (err) {
    console.error("GET /api/admin/street-team error:", err);
    return res.status(500).json({ success: false, message: "Failed to load street team" });
  }
});

// ==================== ADMIN STATS (counts) ====================
app.get("/api/admin/stats", requireAdmin, async (req, res) => {
  try {
   const [users, volunteers, streetTeam, waitlist] = await Promise.all([
  db.collection("Users").countDocuments({}),
  db.collection("Volunteers").countDocuments({}),
  db.collection("StreetTeam").countDocuments({}),
  db.collection(WAITLIST_COLLECTION).countDocuments({})
]);

const recentWaitlistArr = await db.collection(WAITLIST_COLLECTION)
  .find({})
  .sort({ createdAt: -1 })
  .limit(1)
  .toArray();

    const recentWaitlist = recentWaitlistArr[0] || null;

    return res.json({
      success: true,
      users,
      volunteers,
	  streetTeam,
      waitlist,
      recentWaitlist
    });
  } catch (err) {
    console.error("admin stats error:", err);
    return res.status(500).json({ success: false, message: "Failed to load stats" });
  }
});

// ==================== ADMIN: CAMPAIGNS ====================
// List ALL campaigns (Pending/Approved/Denied/etc.)
app.get("/api/admin/campaigns", requireAdmin, async (req, res) => {
  try {
    const rows = await db.collection("Campaigns").find({}).sort({ CreatedAt: -1 }).toArray();
    res.json({ success: true, campaigns: rows.map(normalizeCampaign) });
  } catch (err) {
    console.error("admin campaigns error:", err);
    res.status(500).json({ success: false, message: "Failed to load campaigns" });
  }
});

// Update campaign status (Approved/Denied/Closed/etc.)
app.patch("/api/admin/campaigns/:id/status", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    const { status } = req.body;

    const allowed = ["Pending", "Approved", "Denied", "Closed"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    // ✅ Match ObjectId _id, string _id, or legacy Id field
    const or = [{ _id: id }, { Id: id }];
    if (ObjectId.isValid(id)) or.unshift({ _id: new ObjectId(id) });

    const result = await db.collection("Campaigns").findOneAndUpdate(
      { $or: or },
      { $set: { Status: status, ReviewedAt: new Date(), ReviewedBy: "admin" } },
      { returnDocument: "after" }
    );

    if (!result?.value) return res.status(404).json({ success: false, message: "Not found" });

    res.json({ success: true, campaign: normalizeCampaign(result.value) });
  } catch (err) {
    console.error("admin campaign status error:", err);
    res.status(500).json({ success: false, message: "Failed to update campaign" });
  }
});

// ==================== ADMIN: ID VERIFICATIONS ====================
// List ID verifications (default Pending)
app.get("/api/admin/id-verifications", requireAdmin, async (req, res) => {
  try {
    const status = String(req.query.status || "Pending");
    const filter = status ? { Status: status } : {};
    const rows = await db.collection("ID_Verifications").find(filter).sort({ createdAt: -1 }).toArray();
    res.json({ success: true, data: rows.map(normalizeIdv) });
  } catch (err) {
    console.error("admin idv list error:", err);
    res.status(500).json({ success: false, message: "Failed to load ID verifications" });
  }
});

// Approve an ID verification
app.patch("/api/admin/id-verifications/:id/approve", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;

    const result = await db.collection("ID_Verifications").findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { Status: "Approved", ReviewedAt: new Date(), ReviewedBy: "admin" } },
      { returnDocument: "after" }
    );

    if (!result?.value) return res.status(404).json({ success: false, message: "Not found" });

    res.json({ success: true, row: normalizeIdv(result.value) });
  } catch (err) {
    console.error("admin idv approve error:", err);
    res.status(500).json({ success: false, message: "Approve failed" });
  }
});

// Deny an ID verification
app.patch("/api/admin/id-verifications/:id/deny", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const { reason } = req.body;

    const result = await db.collection("ID_Verifications").findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { Status: "Denied", ReviewedAt: new Date(), ReviewedBy: "admin", DenialReason: reason || "" } },
      { returnDocument: "after" }
    );

    if (!result?.value) return res.status(404).json({ success: false, message: "Not found" });

    res.json({ success: true, row: normalizeIdv(result.value) });
  } catch (err) {
    console.error("admin idv deny error:", err);
    res.status(500).json({ success: false, message: "Deny failed" });
  }
});

// ==================== PUBLIC: ACTIVE CAMPAIGNS (SEARCH/LIST) ====================
app.get("/api/campaigns", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    // IMPORTANT: your Mongo collection is likely lowercase "campaigns"
    const col = db.collection("Campaigns");

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
app.post("/api/create-campaign", requireVerifiedIdentity, upload.single("image"), async (req, res) => {
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

console.log("📧 Campaign submission email sending:", { email, from: FROM_EMAIL, admin: ADMIN_EMAIL });

await sendSubmissionEmails({
  type: "Campaign",
  userEmail: email,
  userName: "", // optional
  adminSubject: "New Campaign Submitted",
  userSubject: "Your JoyFund campaign is under review",
  adminHtml: `
    <h2>New Campaign Submitted</h2>
    <p><b>Title:</b> ${title}</p>
    <p><b>Email:</b> ${email}</p>
    <p><b>Goal:</b> ${goal}</p>
  `,
  userHtml: `
    <h2>Your campaign was submitted 💙💗</h2>
    <p>We received your campaign and it is now under review.</p>
    <p>— JoyFund Team</p>
  `
});


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

    await sendSubmissionEmails({
      type: "Donation",
      userEmail: email,
      userName: name,
      adminSubject: "New Donation Received",
      userSubject: "Thank you for your JoyFund donation 💙💗",
      adminHtml: `
        <h2>New Donation</h2>
        <p><b>Name:</b> ${name}</p>
        <p><b>Email:</b> ${email}</p>
        <p><b>Amount:</b> $${amount}</p>
      `,
      userHtml: `
        <h2>Thank you for your donation!</h2>
        <p>Hi ${name},</p>
        <p>We are deeply grateful for your $${amount} support.</p>
      `
    });

    res.json({ success: true });
  } catch (err) {
    console.error("donation error:", err);
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

// ==================== PUBLIC: WAITLIST COUNT ====================
// Used on homepage for social proof: "X people have already joined"
app.get("/api/waitlist-count", async (req, res) => {
  try {
    const count = await db.collection(WAITLIST_COLLECTION).countDocuments({});
    return res.json({ success: true, count });
  } catch (err) {
    console.error("waitlist-count error:", err);
    return res.status(500).json({ success: false, message: "Failed to get waitlist count" });
  }
});

// ==================== WAITLIST / VOLUNTEERS / STREET TEAM ====================
app.post("/api/waitlist", async (req, res) => {
  try {
    const { name, email, reason } = req.body;
    const row = { name, email, reason, createdAt: new Date() };

    await db.collection(WAITLIST_COLLECTION).insertOne(row);

    await sendSubmissionEmails({
      type: "Waitlist",
      userEmail: email,
      userName: name,
      adminSubject: "New Waitlist Submission",
      userSubject: "You’re on the JoyFund waitlist!",
      adminHtml: `
        <h2>New Waitlist Submission</h2>
        <p><b>Name:</b> ${name || "—"}</p>
        <p><b>Email:</b> ${email || "—"}</p>
        <p><b>Reason:</b> ${reason || "—"}</p>
        <p><b>Date:</b> ${new Date().toLocaleString()}</p>
      `,
      userHtml: `
        <h2>Welcome to JoyFund 💙💗</h2>
        <p>Hi ${name || ""},</p>
        <p>Thanks for joining our waitlist — we received your submission and you’re officially on the list.</p>
        <p>We’ll email you as we roll out updates and launch announcements.</p>
        <p>— JoyFund Team</p>
      `
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("waitlist error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/api/volunteer", async (req, res) => {
  try {
    const { name, email, role, reason } = req.body;
    const row = { name, email, role, availability, createdAt: new Date() };

    await db.collection("Volunteers").insertOne(row);
   await sendSubmissionEmails({
  type: "Volunteer",
  userEmail: email,
  userName: name,
  adminSubject: "New Volunteer Submission",
  userSubject: "We received your volunteer submission",
  adminHtml: `
    <h2>New Volunteer Submission</h2>
    <p><b>Name:</b> ${name || "—"}</p>
    <p><b>Email:</b> ${email || "—"}</p>
    <p><b>Role:</b> ${role || "—"}</p>
    <p><b>Availability:</b> ${availability || "—"}</p>
    <p><b>Date:</b> ${new Date().toLocaleString()}</p>
  `,
  userHtml: `
    <h2>Thanks for volunteering with JoyFund 💙💗</h2>
    <p>Hi ${name || ""},</p>
    <p>We received your volunteer submission. Our team will review it and reach out with next steps.</p>
    <p>— JoyFund Team</p>
  `
});
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

app.post("/api/street-team", async (req, res) => {
  try {
    const { name, email, city, reason } = req.body;
    const row = { name, email, city, hoursAvailable, createdAt: new Date() };

    await db.collection("StreetTeam").insertOne(row);

    await sendSubmissionEmails({
      type: "Street Team",
      userEmail: email,
      userName: name,
      adminSubject: "New Street Team Submission",
      userSubject: "Thanks for joining the JoyFund Street Team!",
      adminHtml: `
        <h2>New Street Team Submission</h2>
        <p><b>Name:</b> ${name}</p>
        <p><b>Email:</b> ${email}</p>
        <p><b>City:</b> ${city}</p>
        <p><b>Hours Available:</b> ${hoursAvailable}</p>
      `,
      userHtml: `
        <h2>Welcome to the JoyFund Street Team 💙💗</h2>
        <p>Hi ${name},</p>
        <p>We received your submission and will be in touch soon.</p>
      `
    });

    res.json({ success: true });
  } catch (err) {
    console.error("street-team error:", err);
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
    // must be logged in
    const user = req.session?.user;
    if (!user?.email) {
      return res.status(401).json({ success: false, message: "Not logged in" });
    }

    const email = String(user.email).trim().toLowerCase();
    const name = String(user.name || "").trim(); // optional

    if (!req.file) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

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
  Status: "Pending",
  createdAt: new Date()
});

await sendSubmissionEmails({
  type: "Identity Verification",
  userEmail: email,
  userName: name,
  adminSubject: "New Identity Verification Uploaded",
  userSubject: "Your ID has been received",
  adminHtml: `
    <h2>New ID Verification</h2>
    <p><b>User:</b> ${email}</p>
    <p><b>Name:</b> ${name || "—"}</p>
    <p><b>File:</b> <a href="${cloudRes.secure_url}">View upload</a></p>
    <p><b>Date:</b> ${new Date().toLocaleString()}</p>
  `,
  userHtml: `
    <h2>Thanks for verifying your identity 💙💗</h2>
    <p>Hi ${name || ""},</p>
    <p>We received your ID and will review it shortly.</p>
    <p>If we need anything else, we’ll reach out by email.</p>
    <p>— JoyFund Team</p>
  `
});
	

    return res.json({ success: true, url: cloudRes.secure_url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ==================== ID VERIFICATION: CURRENT USER (DASHBOARD) ====================
app.get("/api/id-verification/me", async (req, res) => {
  try {
    const email = req.session?.user?.email;
    if (!email) return res.status(401).json({ success: false, message: "Not logged in" });

    const cleanEmail = String(email).trim().toLowerCase();
    const emailExactI = new RegExp("^" + cleanEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");

    const latest = await db.collection("ID_Verifications")
      .find({ $or: [{ email: emailExactI }, { Email: emailExactI }] })
      .sort({ ReviewedAt: -1, createdAt: -1, CreatedAt: -1, _id: -1 })
      .limit(1)
      .toArray();

    const row = latest[0] || null;

    // normalize photo url field names
    const rawPhoto =
      row?.IDPhotoURL ||
      row?.idPhotoUrl ||
      row?.photoUrl ||
      row?.url ||
      row?.fileUrl ||
      row?.FileURL ||
      row?.IdFileUrl ||
      row?.idFile ||
      "";

    return res.json({
      success: true,
      verification: row,
      status: row?.Status || row?.status || "Pending",
      photoUrl: rawPhoto
    });
  } catch (err) {
    console.error("id-verification/me error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


// ==================== STATIC FILES ====================
app.use(express.static("public"));

// ==================== START SERVER ====================
app.listen(PORT, () => console.log(`JoyFund backend running on port ${PORT}`));