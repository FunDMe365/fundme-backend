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
const cron = require("node-cron");

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

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
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
  allowedHeaders: ["Content-Type", "Authorization"],
  exposedHeaders: ["set-cookie"]
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

// ==================== JOYBOOST HELPERS ====================
const JOYBOOST_REQUESTS = "JoyBoost_Requests";
const JOYBOOST_SETTINGS = "JoyBoost_Settings"; // per-campaign
const CAMPAIGN_VIEWS = "CampaignViews";

function now() { return new Date(); }

function safeLower(s) { return String(s || "").trim().toLowerCase(); }

function daysBetween(a, b) {
  const ms = Math.abs(new Date(b).getTime() - new Date(a).getTime());
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// ==================== JOYBOOST: RESOLVE CAMPAIGN BY ANY ID ====================
async function findCampaignByAnyId(campaignIdRaw) {
  const campaignId = String(campaignIdRaw || "").trim();
  if (!campaignId) return null;

  const idVariants = [{ Id: campaignId }, { id: campaignId }];
  if (ObjectId.isValid(campaignId)) idVariants.unshift({ _id: new ObjectId(campaignId) });

  return db.collection("Campaigns").findOne({ $or: idVariants });
}

function normalizeJoyBoostSetting(doc) {
  if (!doc) return null;
  return {
    _id: String(doc._id),
    campaignId: doc.campaignId,
    isActive: !!doc.isActive,
    featured: !!doc.featured,
    seoTitle: doc.seoTitle || "",
    seoDescription: doc.seoDescription || "",
    shareBlurb: doc.shareBlurb || "",
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    rewrittenIntro: doc.rewrittenIntro || "",
    campaignTitle: doc.campaignTitle || "",
    campaignOwnerEmail: doc.campaignOwnerEmail || "",
    updatedAt: doc.updatedAt || null,
    createdAt: doc.createdAt || null,
    lastCheckinSentAt: doc.lastCheckinSentAt || null
  };
}


// ==================== STRIPE ====================
const stripe = Stripe(STRIPE_SECRET_KEY);

// ==================== STRIPE WEBHOOK (REQUIRED FOR RELIABLE DONATION SAVES) ====================
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Stripe webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // ✅ 1) Checkout completed (donations + JoyBoost subscription signups)
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
	  
	  // ================== JOYBOOST APPROVAL PAYMENT (ONE-TIME) ==================
if (session.mode === "payment" && session.metadata?.type === "joyboost") {
  const requestId = session.metadata.joyboostRequestId;

  if (requestId && ObjectId.isValid(requestId)) {
    await db.collection(JOYBOOST_REQUESTS).updateOne(
      { _id: new ObjectId(requestId) },
      {
        $set: {
          paid: true,
          paidAt: new Date(),
          paidStripeSessionId: session.id,
          paidAmount: (session.amount_total || 0) / 100
        }
      }
    );

    console.log("✅ JoyBoost approval payment received for request:", requestId);
  }
}


      // ================== JOYBOOST SUBSCRIPTION ==================
      if (session.mode === "subscription" && session.metadata?.product === "joyboost") {
        const userId = session.metadata.userId;
        const subscriptionId = session.subscription;

        if (userId) {
          await db.collection("Users").updateOne(
            { _id: ObjectId.isValid(userId) ? new ObjectId(userId) : userId },
            {
              $set: {
                joyboostActive: true,
                joyboostSubscriptionId: subscriptionId,
                joyboostStartedAt: new Date()
              }
            }
          );
        }

        console.log("✅ JoyBoost activated for user:", userId);
      }

      // ================== DONATION RECORDING ==================
		if (!(session.metadata?.type === "joyboost")) {
		const exists = await db.collection("Donations").findOne({ stripeSessionId: session.id });

		if (!exists && session.payment_status === "paid") {
        const email = session.customer_details?.email || null;
        const name = session.customer_details?.name || null;
        const chargedAmount = (session.amount_total || 0) / 100;

        const originalDonation = session.metadata?.originalDonation || null;
        const campaignId = session.metadata?.campaignId || null;
        const campaignTitle = session.metadata?.campaignTitle || null;

        const originalNum = Number(originalDonation);
        const originalAmount = Number.isFinite(originalNum) ? originalNum : null;

        await db.collection("Donations").insertOne({
          stripeSessionId: session.id,
          campaignId,
          campaignTitle,

          date: new Date(),
          name,
          email,
          amount: originalAmount ?? chargedAmount,

          originalDonation,
          chargedAmount,
          currency: session.currency,
          createdAt: new Date(),
          source: "stripe_webhook"
        });

        console.log("✅ Donation recorded via webhook:", session.id);
      } else {
        console.log("ℹ️ Donation already recorded or not paid:", session.id, session.payment_status);
		  }   // closes: if (!exists && session.payment_status === "paid")
		}     // closes: if (!(session.metadata?.type === "joyboost"))
      }

    // ✅ 2) Subscription canceled (turn JoyBoost OFF)
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;

      await db.collection("Users").updateOne(
        { joyboostSubscriptionId: sub.id },
        { $set: { joyboostActive: false, joyboostCanceledAt: new Date() } }
      );

      console.log("🛑 JoyBoost canceled:", sub.id);
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("❌ Webhook handler error:", err);
    return res.status(500).json({ received: false });
  }
});

// ==================== MIDDLEWARE ====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


// ==================== PRODUCTION-READY SESSION ====================
const MongoStorePkg = require("connect-mongo");
const MongoStore = MongoStorePkg.default || MongoStorePkg;

// ✅ Reuse the already-connected Mongoose/Mongo client
app.set("trust proxy", 1);

app.use(session({
  name: "joyfund.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,

  store: MongoStore.create({
    client: mongoose.connection.getClient(),   // <-- THIS FIXES THE AUTH ERROR
    dbName: "joyfund",
    collectionName: "sessions"
  }),

  cookie: {
    secure: true,
    sameSite: "none",
    httpOnly: true,
    domain: ".fundasmile.net",
    path: "/"
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
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype);
    if (!ok) return cb(new Error("Only JPG/PNG/GIF/WEBP images are allowed."));
    cb(null, true);
  }
});

// ==================== STRIPE CHECKOUT (CAMPAIGN DONATIONS + MISSION GENERAL) ====================
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  try {
    const campaignId = String(req.params.campaignId || "").trim();
    const rawAmount = Number(req.body.amount);
    const target = Math.round(rawAmount * 100) / 100; // force 2 decimals

    if (!campaignId) {
      return res.status(400).json({ error: "Missing campaignId" });
    }

    if (!target || !isFinite(target) || target < 1) {
      return res.status(400).json({ error: "Invalid donation amount" });
    }

    // ✅ Default info (MISSION general donation)
    let donationType = "mission";
    let campaignTitle = "JoyFund Mission (General Donation)";
    let campaignDesc = "General donation supporting JoyFund’s mission.";

    // ✅ Only look up real campaigns if NOT mission
    if (campaignId !== "mission") {
      donationType = "campaign";

      // Find campaign by Mongo _id OR legacy Id field
      const idVariants = [{ Id: campaignId }, { id: campaignId }];
      if (ObjectId.isValid(campaignId)) idVariants.unshift({ _id: new ObjectId(campaignId) });

      const campaign = await db.collection("Campaigns").findOne({ $or: idVariants });
      if (!campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      campaignTitle = String(campaign.title || campaign.Title || "JoyFund Campaign").trim();
      campaignDesc = String(campaign.Description || campaign.description || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 250) || "Campaign donation via JoyFund ❤️";
    }

    // ✅ Use frontend-provided URLs safely (avoid open redirects)
    const successUrlRaw = String(req.body.successUrl || "").trim();
    const cancelUrlRaw  = String(req.body.cancelUrl || "").trim();

    const safeSuccessUrl = successUrlRaw.startsWith(FRONTEND_URL)
      ? successUrlRaw
      : `${FRONTEND_URL}/thankyou.html`;

    const safeCancelUrl = cancelUrlRaw.startsWith(FRONTEND_URL)
      ? cancelUrlRaw
      : `${FRONTEND_URL}/campaigns.html`;

       // ✅ Charge enough to cover BOTH: JoyFund 5% + Stripe fees
    // target = amount the donor wants the campaign to receive (you already validated this)
    const donation = target;

    const joyfundFeeRate = 0.02;
const stripePercent = 0.029;
const stripeFixed = 0.30;

// gross so that after Stripe fee, there’s enough to cover:
// campaign donation + JoyFund fee
const totalCharge =
  (donation * (1 + joyfundFeeRate) + stripeFixed) / (1 - stripePercent);

// Use CEIL so the campaign is never shorted due to rounding
const unitAmount = Math.max(50, Math.ceil(totalCharge * 100));

    // ✅ Create Stripe session using unitAmount
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: campaignTitle,
            description: campaignDesc
          },
          unit_amount: unitAmount
        },
        quantity: 1
      }],
      success_url: `${safeSuccessUrl}${safeSuccessUrl.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: safeCancelUrl,
      metadata: {
        donationType,
        campaignId,
        campaignTitle,
        originalDonation: target.toFixed(2),
      }
    });

    return res.json({ sessionId: session.id });
  } catch (err) {
    console.error("Stripe Error:", err);
    return res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// ✅ Confirm Stripe payment + record donation ONLY if paid
app.post("/api/confirm-donation", async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });

    // Retrieve session from Stripe (expand payment_intent for more detail if needed)
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Stripe marks paid checkouts with payment_status === "paid"
    if (session.payment_status !== "paid") {
      return res.json({ ok: false, recorded: false, status: session.payment_status });
    }

    // ✅ Idempotent insert (prevents duplicates on refresh)
    const existing = await db.collection("Donations").findOne({ stripeSessionId: sessionId });
    if (existing) {
      return res.json({ ok: true, recorded: false, message: "Already recorded" });
    }

    // Pull info from metadata you already attach in create-checkout-session
    const campaignId = session?.metadata?.campaignId || null;
    const originalDonation = session?.metadata?.originalDonation || null;

    // Amount Stripe charged (this includes fee coverage since you’re doing that)
    const chargedAmount = (session.amount_total || 0) / 100;

    await db.collection("Donations").insertOne({
      stripeSessionId: sessionId,
      campaignId,
      originalDonation,          // what donor intended (from metadata)
      chargedAmount,             // what Stripe charged
      currency: session.currency,
      createdAt: new Date(),
      source: "stripe_checkout"
    });

    return res.json({
      ok: true,
      recorded: true,
      campaignId,
      originalDonation,
      chargedAmount,
      currency: session.currency
    });
  } catch (err) {
    console.error("confirm-donation error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
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

function htmlToText(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|h1|h2|h3|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sendMailjet({ toEmail, toName, subject, html, headers = {} }) {
  if (!mailjetClient) {
    console.warn("Mailjet not configured. Skipping email.");
    return;
  }
  if (!toEmail) return;

  const fromEmail = process.env.EMAIL_FROM || FROM_EMAIL;
  const fromName = process.env.EMAIL_FROM_NAME || FROM_NAME;
  const text = htmlToText(html);

  try {
    await mailjetClient.post("send", { version: "v3.1" }).request({
      Messages: [{
        From: { Email: fromEmail, Name: fromName },
        ReplyTo: { Email: fromEmail, Name: fromName },
        To: [{ Email: toEmail, Name: toName || "" }],
        Subject: subject,
        TextPart: text,
        HTMLPart: html,
        CustomID: "joyfund",
        Headers: headers

      }]
    });
  } catch (err) {
    console.error("Mailjet send error:", err);
    // don't throw
  }
}

const EMAIL_FOOTER = `
<hr style="border:none;border-top:1px solid #eee;margin:20px 0;" />
<p style="font-size:12px;color:#888;margin-top:20px;">
  Don’t want to receive JoyFund updates? Reply with “unsubscribe”.
</p>
`;

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
      html: (adminHtml || "") + EMAIL_FOOTER,
      headers: {
        "List-Unsubscribe": "<mailto:admin@fundasmile.net?subject=unsubscribe>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
      }
    })
  );

  // User copy
  if (userEmail) {
    tasks.push(
      sendMailjet({
        toEmail: userEmail,
        toName: userName || "",
        subject: userSubject || `We received your ${type}`,
        html: (userHtml || "") + EMAIL_FOOTER,
        headers: {
          "List-Unsubscribe": "<mailto:admin@fundasmile.net?subject=unsubscribe>",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
        }
      })
    );
  }

  await Promise.allSettled(tasks);
}

// ==================== JOYBOOST: DAILY CHECK-IN ====================
cron.schedule("0 10 * * *", async () => { // daily at 10:00 server time
  try {
    const active = await db.collection(JOYBOOST_SETTINGS).find({ isActive: true }).toArray();

    for (const jb of active) {
      const campaignId = jb.campaignId;

      // Skip if already sent recently
      if (jb.lastCheckinSentAt && daysBetween(jb.lastCheckinSentAt, now()) < 7) continue;

      // If no donation in last 7 days, send check-in
      const since = new Date();
      since.setDate(since.getDate() - 7);

      const recentDonation = await db.collection("Donations").findOne({
        campaignId,
        createdAt: { $gte: since }
      });

      if (!recentDonation) {
        // Get owner email from JoyBoost settings (preferred), fallback to Campaigns
        let toEmail = String(jb.campaignOwnerEmail || "").trim().toLowerCase();
        let toName = "Campaign Owner";

        if (!toEmail) {
          const campaign = await findCampaignByAnyId(campaignId);
          toEmail = String(campaign?.Email ?? campaign?.email ?? "").trim().toLowerCase();
        }

        if (!toEmail) {
          toEmail = ADMIN_EMAIL; // fallback so you still get notified
          toName = "JoyFund Admin";
        }

        await sendMailjet({
          toEmail,
          toName,
          subject: `JoyBoost Check-in Needed: ${jb.campaignTitle || campaignId}`,
          html: `
            <p>Your JoyBoost campaign <b>${jb.campaignTitle || campaignId}</b> has no donations in the last 7 days.</p>
            <p>Suggested next step: refresh the story headline + repost the share blurb.</p>
            ${jb.shareBlurb ? `<hr /><p><b>Suggested share blurb:</b><br/>${jb.shareBlurb}</p>` : ""}
          `
        });

        // ✅ mark as sent so you don't spam
        await db.collection(JOYBOOST_SETTINGS).updateOne(
          { campaignId },
          { $set: { lastCheckinSentAt: now() } }
        );
      }
    }
  } catch (err) {
    console.error("JOYBOOST DAILY CHECK-IN error:", err);
  }
});

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
	
	await sendSubmissionEmails({
  type: "Signup",
  userEmail: cleanEmail,
  userName: cleanName,
  adminSubject: "New User Signup",
  userSubject: "Welcome to JoyFund 💙💗",
  adminHtml: `
    <h2>New User Signup</h2>
    <p><b>Name:</b> ${cleanName}</p>
    <p><b>Email:</b> ${cleanEmail}</p>
    <p><b>Date:</b> ${new Date().toLocaleString()}</p>
  `,
  userHtml: `
    <h2>Welcome to JoyFund 💙💗</h2>
    <p>Hi ${cleanName},</p>
    <p>Your account has been created successfully.</p>
    <p>You can log in anytime and start exploring campaigns or create one of your own.</p>
    <p>— JoyFund Team</p>
  `
});

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

// ==================== DELETE ACCOUNT ====================
// Deletes the currently logged-in user's account (and logs them out)
app.delete("/api/delete-account", async (req, res) => {
  try {
    const userEmail = req.session?.user?.email;
    if (!userEmail) {
      return res.status(401).json({ ok: false, error: "Not logged in" });
    }

    const email = String(userEmail).trim().toLowerCase();

    // ✅ delete campaigns owned by this account
    const campaignsResult = await db.collection("Campaigns").deleteMany({
      $or: [
        { Email: email },
        { email: email },
        { Email: { $regex: `^${email}$`, $options: "i" } }
      ]
    });

    // delete user
    const userResult = await db.collection("Users").deleteOne({ Email: email });

    // logout
    req.session.destroy((err) => {
      if (err) {
        console.error("delete-account session destroy error:", err);
        return res.status(500).json({ ok: false, error: "Failed to logout after deletion" });
      }

      res.clearCookie("joyfund.sid", {
  path: "/",
  secure: true,
  sameSite: "none",
  domain: ".fundasmile.net"
});


      return res.json({
        ok: true,
        deleted: userResult.deletedCount === 1,
        campaignsDeleted: campaignsResult.deletedCount
      });
    });
  } catch (err) {
    console.error("DELETE /api/delete-account error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Sign out the current user
app.post("/api/signout", (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ success: false });

    res.clearCookie("joyfund.sid", {
      path: "/",
      secure: true,
      sameSite: "none",
      domain: ".fundasmile.net"
    });

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

//=====================JOYBOOST SUBSCRRIPTION CHECKOUT=============

app.post("/api/joyboost/checkout", async (req, res) => {
  try {
    const { userId, email } = req.body; // you can pass these from frontend

    if (!process.env.JOYBOOST_PRICE_ID) {
      return res.status(500).json({ error: "Missing JOYBOOST_PRICE_ID in env" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: process.env.JOYBOOST_PRICE_ID,
          quantity: 1,
        },
      ],

      // Optional but helpful
      customer_email: email || undefined,

      // Put identifiers so your webhook can map payments -> your user
      client_reference_id: userId || undefined,
      metadata: {
        userId: userId || "",
        product: "joyboost",
      },

      success_url: `${process.env.FRONTEND_URL}/joyboost-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/joyboost.html?canceled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("JoyBoost checkout error:", err);
    res.status(500).json({ error: err.message || "Stripe error" });
  }
});

// ==================== JOYBOOST: APPLY ====================
app.post("/api/joyboost/apply", async (req, res) => {
  try {
    const { name, email, campaignId, goal, joy, notes } = req.body || {};

    if (!name || !email || !campaignId || !goal || !joy) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const doc = {
      name: String(name).trim(),
      email: safeLower(email),
      campaignId: String(campaignId).trim(),
      goal: String(goal).trim(),
      joy: String(joy).trim(),
      notes: String(notes || "").trim(),
      status: "Pending",
      createdAt: now()
    };

    await db.collection(JOYBOOST_REQUESTS).insertOne(doc);

    // Notify admin
    if (typeof sendMailjet === "function") {
      await sendMailjet({
        toEmail: ADMIN_EMAIL,
        toName: "JoyFund Admin",
        subject: "New JoyBoost Request",
        html: `
          <h2>New JoyBoost Request</h2>
          <p><b>Name:</b> ${doc.name}</p>
          <p><b>Email:</b> ${doc.email}</p>
          <p><b>Campaign ID:</b> ${doc.campaignId}</p>
          <p><b>Main goal:</b> ${doc.goal}</p>
          <p><b>Joy:</b> ${doc.joy}</p>
          <p><b>Notes:</b> ${doc.notes || "—"}</p>
          <p><b>Status:</b> ${doc.status}</p>
        `
      });
    }

    // Confirm requester
    await sendMailjet({
      toEmail: doc.email,
      toName: doc.name,
      subject: "We received your JoyBoost request 💛",
      html: `
        <p>Hi ${doc.name},</p>
        <p>We received your JoyBoost request for campaign <b>${doc.campaignId}</b>.</p>
        <p>We’ll review it and email you with next steps.</p>
        <p>— JoyFund</p>
      `
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("POST /api/joyboost/apply error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ==================== JOYBOOST: FEATURED LIST ====================
app.get("/api/joyboost/spotlight", async (req, res) => {
  try {
    const list = await db.collection(JOYBOOST_SETTINGS)
      .find({ $or: [{ featured: true }, { isActive: true }] })
      .sort({ featured: -1, updatedAt: -1, createdAt: -1 })
      .limit(20)
      .toArray();

    return res.json({ success: true, spotlight: list });
  } catch (err) {
    console.error("GET /api/joyboost/spotlight error:", err);
    return res.status(500).json({ success: false });
  }
});

// ==================== TRACK CAMPAIGN VIEW ====================
app.post("/api/track-view", async (req, res) => {
  try {
    const { campaignId } = req.body || {};
    if (!campaignId) return res.status(400).json({ ok: false });

    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    await db.collection(CAMPAIGN_VIEWS).updateOne(
      { campaignId: String(campaignId).trim(), ip, day },
      { $setOnInsert: { createdAt: now() } },
      { upsert: true }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/track-view error:", err);
    return res.status(500).json({ ok: false });
  }
});

// ==================== JOYBOOST: MOMENTUM ====================
app.get("/api/joyboost/momentum/:campaignId", async (req, res) => {
  try {
    const campaignId = String(req.params.campaignId || "").trim();
    if (!campaignId) return res.status(400).json({ success: false });

    const last14 = new Date();
    last14.setDate(last14.getDate() - 14);

    const views14 = await db.collection(CAMPAIGN_VIEWS).countDocuments({
      campaignId,
      createdAt: { $gte: last14 }
    });

    const donations14 = await db.collection("Donations").countDocuments({
      campaignId,
      createdAt: { $gte: last14 }
    });

    const totalDonations = await db.collection("Donations").aggregate([
  { $match: { campaignId } },
  {
    $group: {
      _id: "$campaignId",
      sum: {
        $sum: {
          $convert: { input: "$originalDonation", to: "double", onError: 0, onNull: 0 }
        }
      }
    }
  }
]).toArray();

    return res.json({
      success: true,
      campaignId,
      views14,
      donations14,
      totalRaised: Number(totalDonations?.[0]?.sum || 0)
    });
  } catch (err) {
    console.error("GET /api/joyboost/momentum error:", err);
    return res.status(500).json({ success: false });
  }
});



//=====================DONATION SUMMARY============
app.get("/api/dashboard/donations-summary", async (req, res) => {
  try {
    const userEmail = req.session?.user?.email;
    if (!userEmail) return res.status(401).json({ ok: false, error: "Not logged in" });

    const email = String(userEmail).trim().toLowerCase();
    const emailI = new RegExp("^" + email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");

    // 1) Find campaigns owned by this user
    const ownedCampaigns = await db.collection("Campaigns").find({
      $or: [{ Email: emailI }, { email: emailI }]
    }, {
      projection: { _id: 1, Id: 1, id: 1, Title: 1, title: 1 }
    }).toArray();

    // Build list of possible campaignId values that donations might store
    const ownedIds = new Set();
    for (const c of ownedCampaigns) {
      if (c?._id) ownedIds.add(String(c._id));
      if (c?.Id) ownedIds.add(String(c.Id));
      if (c?.id) ownedIds.add(String(c.id));
    }

    if (ownedIds.size === 0) {
      return res.json({ ok: true, totalRaised: 0, breakdown: [] });
    }

    // 2) Pull donations made TO those campaigns
    const donationsToYou = await db.collection("Donations").find({
      campaignId: { $in: Array.from(ownedIds) }
    }).toArray();

    // 3) Sum totals using originalDonation (what donor intended your campaign to receive)
    const getOriginal = (d) => {
      const n = Number(d.originalDonation ?? d.amount ?? d.Amount ?? 0);
      return Number.isFinite(n) ? n : 0;
    };

    const byCampaign = new Map();

    for (const d of donationsToYou) {
      const cid = String(d.campaignId || "");
      const amt = getOriginal(d);
      const title = d.campaignTitle || d.Title || "Untitled Campaign";

      const prev = byCampaign.get(cid) || {
        campaignId: cid,
        campaignTitle: title,
        total: 0,
        count: 0,
        lastDate: null
      };

      prev.total += amt;
      prev.count += 1;

      const dt = d.createdAt || d.CreatedAt || d.date || d.Date || null;
      const parsed = dt ? new Date(dt) : null;
      if (parsed && !isNaN(parsed.getTime())) {
        if (!prev.lastDate || parsed > new Date(prev.lastDate)) prev.lastDate = parsed.toISOString();
      }

      if (title && title !== "Untitled Campaign") prev.campaignTitle = title;

      byCampaign.set(cid, prev);
    }

    const breakdown = Array.from(byCampaign.values()).sort((a, b) => b.total - a.total);
    const totalRaised = breakdown.reduce((s, x) => s + (Number(x.total) || 0), 0);

    return res.json({ ok: true, totalRaised, breakdown });
  } catch (err) {
    console.error("GET /api/dashboard/donations-summary error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
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

app.get("/api/admin/donations", requireAdmin, async (req, res) => {
  try {
    const donations = await db.collection("Donations")
      .find({})
      .sort({ createdAt: -1, date: -1, _id: -1 })
      .limit(2000)
      .toArray();

    res.json({ success: true, donations });
  } catch (err) {
    console.error("GET /api/admin/donations error:", err);
    res.status(500).json({ success: false, message: "Failed to load donations" });
  }
});

app.get("/api/admin-check", (req, res) => {
  res.json({ admin: !!(req.session && req.session.admin) });
});

// ✅ ONE-TIME MAINTENANCE: normalize campaign owner emails to lowercase
app.post("/api/admin/normalize-campaign-emails", async (req, res) => {
  try {
    // Simple protection: require a secret header
    const key = req.headers["x-admin-key"];
    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // Normalize both Email and email fields (some old docs may use either)
    const r1 = await db.collection("Campaigns").updateMany(
      { Email: { $type: "string" } },
      [{ $set: { Email: { $toLower: "$Email" } } }]
    );

    const r2 = await db.collection("Campaigns").updateMany(
      { email: { $type: "string" } },
      [{ $set: { email: { $toLower: "$email" } } }]
    );

    return res.json({
      ok: true,
      matchedEmail: r1.matchedCount,
      modifiedEmail: r1.modifiedCount,
      matchedemail: r2.matchedCount,
      modifiedemail: r2.modifiedCount
    });
  } catch (err) {
    console.error("normalize-campaign-emails error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
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
    const idVariants = [{ Id: id }, { id: id }];
    if (ObjectId.isValid(id)) idVariants.unshift({ _id: new ObjectId(id) });

const result = await db.collection("Campaigns").findOneAndUpdate(
  { $or: idVariants },
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

// ==================== ADMIN: JOYBOOST REQUESTS ====================
app.get("/api/admin/joyboost/requests", requireAdmin, async (req, res) => {
  try {
    const requests = await db.collection(JOYBOOST_REQUESTS)
      .find({})
      .sort({ createdAt: -1 })
      .limit(1000)
      .toArray();
    return res.json({ success: true, requests });
  } catch (err) {
    console.error("GET /api/admin/joyboost/requests error:", err);
    return res.status(500).json({ success: false, message: "Failed to load requests" });
  }
});

// ==================== ADMIN: ACTIVATE/UPDATE JOYBOOST SETTINGS ====================
app.post("/api/admin/joyboost/activate", requireAdmin, async (req, res) => {
  try {
    const { campaignId, isActive, featured, seoTitle, seoDescription, shareBlurb, tags, rewrittenIntro } = req.body || {};
    if (!campaignId) return res.status(400).json({ success: false, message: "Missing campaignId" });

    const campaign = await findCampaignByAnyId(campaignId);
    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found for campaignId" });
    }

    const ownerEmail = String(campaign.Email ?? campaign.email ?? "").trim().toLowerCase();
    const campaignTitle = String(campaign.title ?? campaign.Title ?? "").trim();

    const update = {
      campaignId: String(campaignId).trim(),
      isActive: Boolean(isActive),
      featured: Boolean(featured),
      seoTitle: String(seoTitle || "").trim(),
      seoDescription: String(seoDescription || "").trim(),
      shareBlurb: String(shareBlurb || "").trim(),
      tags: Array.isArray(tags)
        ? tags.map(t => String(t).trim()).filter(Boolean)
        : String(tags || "").split(",").map(s => s.trim()).filter(Boolean),
      rewrittenIntro: String(rewrittenIntro || "").trim(),

      // ✅ store helpful campaign context
      campaignOwnerEmail: ownerEmail,
      campaignTitle: campaignTitle,

      updatedAt: now()
    };

    await db.collection(JOYBOOST_SETTINGS).updateOne(
      { campaignId: update.campaignId },
      { $set: update, $setOnInsert: { createdAt: now() } },
      { upsert: true }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("POST /api/admin/joyboost/activate error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ==================== ADMIN: JOYBOOST SETTINGS LIST ====================
app.get("/api/admin/joyboost/settings", requireAdmin, async (req, res) => {
  try {
    const rows = await db.collection(JOYBOOST_SETTINGS)
      .find({})
      .sort({ featured: -1, isActive: -1, updatedAt: -1, createdAt: -1 })
      .limit(2000)
      .toArray();

    return res.json({ success: true, settings: rows.map(normalizeJoyBoostSetting) });
  } catch (err) {
    console.error("GET /api/admin/joyboost/settings error:", err);
    return res.status(500).json({ success: false, message: "Failed to load settings" });
  }
});

app.get("/api/admin/joyboost/settings/:campaignId", requireAdmin, async (req, res) => {
  try {
    const campaignId = String(req.params.campaignId || "").trim();
    const row = await db.collection(JOYBOOST_SETTINGS).findOne({ campaignId });
    return res.json({ success: true, setting: normalizeJoyBoostSetting(row) });
  } catch (err) {
    console.error("GET /api/admin/joyboost/settings/:campaignId error:", err);
    return res.status(500).json({ success: false, message: "Failed to load setting" });
  }
});

// ==================== ADMIN: UPDATE JOYBOOST REQUEST STATUS ====================
// status: Pending | Approved | Denied
app.patch("/api/admin/joyboost/requests/:id/status", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid request id" });
    }

    const status = String(req.body.status || "").trim();
    const reason = String(req.body.reason || "").trim();

    const allowed = ["Pending", "Approved", "Denied"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const result = await db.collection(JOYBOOST_REQUESTS).findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: {
          status,
          denialReason: status === "Denied" ? reason : "",
          reviewedAt: now(),
          reviewedBy: "admin"
        }
      },
      { returnDocument: "after" }
    );

    if (!result?.value) return res.status(404).json({ success: false, message: "Not found" });

    // Optional: email applicant when Approved/Denied
    const reqDoc = result.value;
    // =====================
// APPROVED → CREATE STRIPE PAYMENT LINK + EMAIL USER
// =====================
if (status === "Approved" && reqDoc?.email) {
	// ✅ Don't send a new link if we already sent one
if (reqDoc.paymentUrl) {
  return res.json({
    success: true,
    request: reqDoc,
    message: "Payment link already sent",
    paymentUrl: reqDoc.paymentUrl
  });
}


  const session = await stripe.checkout.sessions.create({
    mode: "payment",

    line_items: [{
      price_data: {
        currency: "usd",
        product_data: { name: "JoyBoost Activation" },
        unit_amount: 5000,   // $50 – change later if needed
      },
      quantity: 1
    }],

    customer_email: reqDoc.email,

    metadata: {
      type: "joyboost",
      joyboostRequestId: String(reqDoc._id),
      campaignId: reqDoc.campaignId,
      userEmail: reqDoc.email
    },

    success_url: `${FRONTEND_URL}/joyboost-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${FRONTEND_URL}/joyboost.html?canceled=1`
  });

  const paymentUrl = session.url;

  await db.collection(JOYBOOST_REQUESTS).updateOne(
    { _id: reqDoc._id },
    {
      $set: {
        paymentUrl,
        paymentLinkSentAt: new Date(),
        stripeSessionId: session.id
      }
    }
  );

  await sendMailjet({
    toEmail: reqDoc.email,
    toName: reqDoc.name || "",
    subject: "Your JoyBoost request was approved 🎉",
    html: `
      <p>Hi ${reqDoc.name || ""},</p>
      <p>Your JoyBoost request has been approved!</p>
      <p>To activate JoyBoost, please complete your secure payment here:</p>
      <p><a href="${paymentUrl}">${paymentUrl}</a></p>
      <p>— JoyFund</p>
    `
  });
}

    return res.json({ success: true, request: result.value });
  } catch (err) {
    console.error("PATCH /api/admin/joyboost/requests/:id/status error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
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
    const { title, goal, description, category } = req.body;

const sessionEmail = req.session?.user?.email;
if (!sessionEmail) {
  return res.status(401).json({ success: false, message: "Not logged in" });
}
const email = String(sessionEmail).trim().toLowerCase();

if (!title || !goal || !description || !category || !req.file) {
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


// ==================== UPDATE CAMPAIGN (owner only) ====================
async function updateCampaignHandler(req, res) {
  try {
    const sessionEmail = req.session?.user?.email;
    if (!sessionEmail) {
      return res.status(401).json({ success: false, message: "Not logged in" });
    }

    const ownerEmail = String(sessionEmail).trim().toLowerCase();
    const ownerRegex = new RegExp(
      "^" + ownerEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
      "i"
    );

    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ success: false, message: "Missing id" });

    const { title, goal, description, category, imageUrl } = req.body || {};

    const $set = {};
    if (typeof title === "string") $set.title = title.trim();
    if (typeof goal === "string" || typeof goal === "number") $set.Goal = String(goal).trim();
    if (typeof description === "string") $set.Description = description.trim();
    if (typeof category === "string") $set.Category = category.trim();
    if (typeof imageUrl === "string" && imageUrl.trim()) $set.ImageURL = imageUrl.trim();
	
	if (req.file) {
  console.log("UPLOAD DEBUG:", {
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size
  });
}

    if (req.file) {
      const cloudRes = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "joyfund/campaigns", use_filename: true, unique_filename: true },
          (err, result) => (err ? reject(err) : resolve(result))
        );
        stream.end(req.file.buffer);
      });
      $set.ImageURL = cloudRes.secure_url;
    }

    if (Object.keys($set).length === 0) {
      return res.status(400).json({ success: false, message: "No fields to update" });
    }

    $set.UpdatedAt = new Date().toISOString();

    // 1) Find campaign by id
    const idVariants = [{ Id: id }, { id: id }];
    if (ObjectId.isValid(id)) idVariants.unshift({ _id: new ObjectId(id) });

    const campaign = await db.collection("Campaigns").findOne({ $or: idVariants });

    if (!campaign) {
      return res.status(404).json({ success: false, message: "Campaign not found" });
    }

    // 2) Ownership check (supports Email/email/OwnerEmail/ownerEmail)
    const ownerFields = [
      campaign.Email,
      campaign.email,
      campaign.OwnerEmail,
      campaign.ownerEmail
    ]
      .filter(Boolean)
      .map(v => String(v).trim().toLowerCase());

    if (!ownerFields.some(e => ownerRegex.test(e))) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to edit this campaign",
        debug: { sessionEmail: ownerEmail, ownerFields }
      });
    }

    // 3) Update using the campaign’s real _id (most reliable)
    const result = await db.collection("Campaigns").findOneAndUpdate(
      { _id: campaign._id },
      { $set },
      { returnDocument: "after" }
    );

    return res.json({ success: true, campaign: result.value });
  } catch (err) {
  console.error("update campaign error:", err);
  return res.status(500).json({
    success: false,
    message: err?.message || "Server error"
  });
}
}  // ✅ CLOSE updateCampaignHandler HERE

// IMPORTANT: must use multer for FormData
app.put("/api/update-campaign/:id", upload.single("image"), updateCampaignHandler);
app.put("/api/campaign/:id", upload.single("image"), updateCampaignHandler);
app.put("/api/campaigns/:id", upload.single("image"), updateCampaignHandler);


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
    const sessionEmail = req.session?.user?.email;
    const email = sessionEmail ? String(sessionEmail).trim().toLowerCase() : null;

    const filter = email
      ? {
          $or: [
            { email: email },
            { Email: email }
          ]
        }
      : {};

    const rows = await db.collection("Donations")
      .find(filter)
      .sort({ createdAt: 1, date: 1, _id: 1 })
      .toArray();

    res.json({ success: true, donations: rows });
  } catch (err) {
    console.error("GET /api/donations error:", err);
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

app.get("/api/debug-campaign/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();

    const idVariants = [{ Id: id }, { id: id }];
if (ObjectId.isValid(id)) idVariants.unshift({ _id: new ObjectId(id) });

const c = await db.collection("Campaigns").findOne({ $or: idVariants });


    return res.json({
      sessionEmail: req.session?.user?.email || null,
      found: !!c,
      campaign: c
        ? {
            _id: String(c._id),
            Id: c.Id || null,
            id: c.id || null,
            Email: c.Email || null,
            email: c.email || null,
            OwnerEmail: c.OwnerEmail || null,
            ownerEmail: c.ownerEmail || null,
            title: c.title || c.Title || null,
            status: c.Status || c.status || null
          }
        : null
    });
  } catch (err) {
    console.error("debug-campaign error:", err);
    return res.status(500).json({ ok: false, error: "server error" });
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

    if (!name || !email || !reason) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    const row = { name, email, role: role || "Volunteer", reason, createdAt: new Date() };
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
        <p><b>Reason:</b> ${reason || "—"}</p>
        <p><b>Date:</b> ${new Date().toLocaleString()}</p>
      `,
      userHtml: `
        <h2>Thanks for volunteering with JoyFund 💙💗</h2>
        <p>Hi ${name || ""},</p>
        <p>We received your volunteer submission. Our team will review it and reach out with next steps.</p>
        <p>— JoyFund Team</p>
      `
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("POST /api/volunteer error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/api/street-team", async (req, res) => {
  try {
    const { name, email, city, reason } = req.body;

    if (!name || !email || !city || !reason) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    const row = { name, email, city, reason, createdAt: new Date() };
    await db.collection("StreetTeam").insertOne(row);

    await sendSubmissionEmails({
      type: "Street Team",
      userEmail: email,
      userName: name,
      adminSubject: "New Street Team Submission",
      userSubject: "We received your Street Team submission",
      adminHtml: `
        <h2>New Street Team Submission</h2>
        <p><b>Name:</b> ${name || "—"}</p>
        <p><b>Email:</b> ${email || "—"}</p>
        <p><b>City:</b> ${city || "—"}</p>
        <p><b>Reason:</b> ${reason || "—"}</p>
        <p><b>Date:</b> ${new Date().toLocaleString()}</p>
      `,
      userHtml: `
        <h2>Thanks for joining the JoyFund Street Team 💙💗</h2>
        <p>Hi ${name || ""},</p>
        <p>We received your Street Team submission. Our team will review it and reach out with next steps.</p>
        <p>— JoyFund Team</p>
      `
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("POST /api/street-team error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

//====================LOGOUT=============================
app.post("/api/logout", (req, res) => {
  try {
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ ok: false, error: "Logout failed" });

      // IMPORTANT: clear the same cookie name/path your session uses
      res.clearCookie("joyfund.sid", {
  path: "/",
  secure: true,
  sameSite: "none",
  domain: ".fundasmile.net"
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

app.use((err, req, res, next) => {
  if (err && (err.message?.includes("Only JPG") || err.code === "LIMIT_FILE_SIZE")) {
    return res.status(400).json({ success: false, message: err.message || "Invalid upload" });
  }
  return next(err);
});



// ==================== STATIC FILES ====================
app.use(express.static("public"));

// ==================== START SERVER ====================
app.listen(PORT, () => console.log(`JoyFund backend running on port ${PORT}`));