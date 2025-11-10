require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const Stripe = require("stripe");
const cors = require("cors");
const mailjet = require("node-mailjet");
const multer = require("multer");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;

// ==================== ✅ CONFIG ====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Serve static files like campaign images
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// CORS for your frontend domains
app.use(cors({
  origin: ["https://fundasmile.net", "http://localhost:5500"],
  credentials: true
}));

// Session
app.use(session({
  secret: process.env.SESSION_SECRET || "joyfund-secret",
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // true if using HTTPS
}));

// Multer for file uploads
const upload = multer({ dest: "uploads/" });

// Stripe
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Mailjet
const mj = mailjet.connect(process.env.MJ_APIKEY_PUBLIC, process.env.MJ_APIKEY_PRIVATE);

// ==================== ✅ MOCK DATABASE ====================
const users = [];
const campaigns = [];
const donations = [];
const waitlist = [];

// ==================== ✅ HELPERS ====================
function sendMailjetEmail(toEmail, subject, text) {
  return mj.post("send", { version: "v3.1" }).request({
    Messages: [
      {
        From: { Email: "noreply@joyfund.com", Name: "JoyFund INC" },
        To: [{ Email: toEmail }],
        Subject: subject,
        TextPart: text
      }
    ]
  });
}

// ==================== ✅ AUTH ROUTES ====================
app.post("/api/signup", async (req, res) => {
  const { email, password, name } = req.body;
  if(users.find(u => u.email === email)) return res.json({ success: false, message: "Email exists" });
  const hash = await bcrypt.hash(password, 10);
  const newUser = { email, password: hash, name };
  users.push(newUser);
  req.session.user = { email, name };
  res.json({ success: true, user: { email, name } });
});

app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email);
  if(!user) return res.status(401).json({ success: false, message: "Invalid credentials" });
  const match = await bcrypt.compare(password, user.password);
  if(!match) return res.status(401).json({ success: false, message: "Invalid credentials" });
  req.session.user = { email: user.email, name: user.name };
  res.json({ success: true, user: { email: user.email, name: user.name } });
});

app.post("/api/logout", (req,res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get("/api/check-session", (req,res) => {
  res.json({ loggedIn: !!req.session.user, user: req.session.user || null });
});

// ==================== ✅ WAITLIST ====================
app.post("/api/waitlist", (req,res) => {
  const { name, email, source, reason } = req.body;
  waitlist.push({ name, email, source, reason, createdAt: new Date() });
  res.json({ success: true });
});

app.post("/api/send-waitlist-email", async (req,res) => {
  const { name, email, source, reason } = req.body;
  try {
    await sendMailjetEmail("admin@joyfund.com", "New Waitlist Submission", `Name: ${name}\nEmail: ${email}\nSource: ${source}\nReason: ${reason}`);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==================== ✅ CAMPAIGNS ====================
app.get("/api/campaigns", (req,res) => {
  res.json({ success: true, campaigns });
});

app.post("/api/create-campaign", upload.single("image"), (req,res) => {
  const user = req.session.user;
  if(!user) return res.status(401).json({ success:false, message:"You must be signed in" });

  const { title, description, goal, category } = req.body;
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : "";
  const campaignId = "camp_" + Date.now();

  const newCampaign = {
    campaignId,
    title,
    description,
    goal,
    category,
    imageUrl,
    status: "verified",
    createdAt: new Date(),
    createdBy: user.email
  };
  campaigns.push(newCampaign);

  // Mailjet notification
  sendMailjetEmail("admin@joyfund.com", "New Campaign Created", `Campaign "${title}" created by ${user.email}`);

  res.json({ success: true, campaign: newCampaign });
});

// ==================== ✅ ID VERIFICATION ====================
app.post("/api/verify-id", upload.single("idDocument"), (req,res) => {
  const user = req.session.user;
  if(!user) return res.status(401).json({ success: false, message: "You must be signed in" });
  if(!req.file) return res.status(400).json({ success:false, message:"ID file missing" });

  // Mock: store ID path
  user.idDocument = `/uploads/${req.file.filename}`;

  // Mailjet notification
  sendMailjetEmail("admin@joyfund.com", "New ID Verification Submitted", `User ${user.email} submitted an ID document.`);

  res.json({ success: true });
});

// ==================== ✅ DONATIONS & STRIPE ====================
app.post("/api/donations", (req,res) => {
  const user = req.session.user;
  if(!user) return res.status(401).json({ success:false, message:"Sign in required" });

  const { campaignId, amount } = req.body;
  donations.push({ campaignId, amount, donor: user.email, createdAt: new Date() });

  res.json({ success:true });
});

app.post("/api/create-checkout-session/:campaignId", async (req,res) => {
  const { campaignId } = req.params;
  const { amount, successUrl, cancelUrl } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `Donation to ${campaignId}` },
          unit_amount: Math.round(amount*100),
        },
        quantity: 1
      }],
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl
    });
    res.json({ sessionId: session.id });
  } catch(err) {
    console.error("Stripe session error:", err);
    res.status(500).json({ success:false, message: err.message });
  }
});

// ==================== ✅ START SERVER ====================
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
