// ==================== SERVER.JS - COMPLETE JOYFUND BACKEND ====================

const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const mongoose = require("mongoose");
const cors = require("cors");
const stripe = require("stripe")("mk_1S3ksM0qKIo9Xb6efUvOzm2B");
const cloudinary = require("cloudinary").v2;
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// ------------------- MIDDLEWARE -------------------
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "50mb" }));

app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretjoyfund",
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 1 day
}));

// ------------------- MONGO CONNECTION -------------------
const uri = `mongodb+srv://fundasmile:fundasmile@joyfund.gvihjsw.mongodb.net/?retryWrites=true&w=majority`;

mongoose.connect(uri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log("✅ MongoDB connected"))
.catch(err => console.error("❌ MongoDB connection error:", err));

// ------------------- CLOUDINARY CONFIG -------------------
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_API_KEY,
  api_secret: process.env.CLOUD_API_SECRET
});

// ------------------- MULTER CONFIG -------------------
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ------------------- SCHEMAS -------------------
const userSchema = new mongoose.Schema({
  email: String,
  password: String,
  name: String,
  role: { type: String, default: "user" },
  verified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const campaignSchema = new mongoose.Schema({
  title: String,
  description: String,
  goal: Number,
  raised: { type: Number, default: 0 },
  creator: String,
  createdAt: { type: Date, default: Date.now },
  image: String
});

const donationSchema = new mongoose.Schema({
  campaignId: mongoose.Types.ObjectId,
  donorEmail: String,
  amount: Number,
  createdAt: { type: Date, default: Date.now }
});

const waitlistSchema = new mongoose.Schema({
  email: String,
  createdAt: { type: Date, default: Date.now }
});

const idVerificationSchema = new mongoose.Schema({
  userEmail: String,
  idUrl: String,
  verified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);
const Campaign = mongoose.model("Campaign", campaignSchema);
const Donation = mongoose.model("Donation", donationSchema);
const Waitlist = mongoose.model("Waitlist", waitlistSchema);
const IDVerification = mongoose.model("IDVerification", idVerificationSchema);

// ------------------- ROUTES -------------------

// ------ SESSION CHECK ------
app.get("/api/check-session", (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false, user: null });
  }
});

// ------ USER AUTH ------
app.post("/api/register", async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const hashed = await bcrypt.hash(password, 12);
    const user = new User({ email, password: hashed, name });
    await user.save();
    req.session.user = { email, name };
    res.json({ success: true, user: { email, name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "User not found" });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Invalid password" });
    req.session.user = { email: user.email, name: user.name };
    res.json({ success: true, user: { email: user.email, name: user.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ------ CAMPAIGNS ------
app.get("/api/campaigns", async (req, res) => {
  const campaigns = await Campaign.find().sort({ createdAt: -1 });
  res.json(campaigns);
});

app.get("/api/campaigns/:id", async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    res.json(campaign);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/campaigns", upload.single("image"), async (req, res) => {
  try {
    const { title, description, goal, creator } = req.body;
    let imageUrl = null;
    if (req.file) {
      const result = await cloudinary.uploader.upload_stream({ resource_type: "image" }, req.file.buffer);
      imageUrl = result.secure_url;
    }
    const campaign = new Campaign({ title, description, goal, creator, image: imageUrl });
    await campaign.save();
    res.json({ success: true, campaign });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------ DONATIONS ------
app.post("/api/donate", async (req, res) => {
  try {
    const { campaignId, donorEmail, amount } = req.body;
    const donation = new Donation({ campaignId, donorEmail, amount });
    await donation.save();
    await Campaign.findByIdAndUpdate(campaignId, { $inc: { raised: amount } });
    res.json({ success: true, donation });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------ WAITLIST ------
app.post("/api/waitlist", async (req, res) => {
  try {
    const { email } = req.body;
    const existing = await Waitlist.findOne({ email });
    if (existing) return res.json({ success: false, message: "Already in waitlist" });
    const entry = new Waitlist({ email });
    await entry.save();
    res.json({ success: true, entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------ ID VERIFICATION ------
app.post("/api/id-verification", upload.single("idImage"), async (req, res) => {
  try {
    const { userEmail } = req.body;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const result = await cloudinary.uploader.upload_stream({ resource_type: "image" }, req.file.buffer);
    const verification = new IDVerification({ userEmail, idUrl: result.secure_url });
    await verification.save();
    res.json({ success: true, verification });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------ STRIPE PAYMENT INTENT ------
app.post("/api/create-payment-intent", async (req, res) => {
  try {
    const { amount } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: "usd"
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------- START SERVER -------------------
app.listen(PORT, () => {
  console.log(`🚀 JoyFund backend running on port ${PORT}`);
});
