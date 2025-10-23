// server.js — Stable version with all working routes (images + dashboard)

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 5000;

// ===== Middleware =====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Static Paths =====

// ✅ Serve uploads folder correctly
const uploadsPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath);
app.use("/uploads", express.static(uploadsPath));

// ✅ Serve frontend (public folder)
const publicPath = path.join(__dirname, "public");
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
}

// ===== Multer for File Uploads =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsPath),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

// ===== Temporary In-Memory Campaign Storage =====
// (Replace with DB or Google Sheets sync later)
let campaigns = [];
let users = []; // to track signup dates (for “Member Since”)

// ===== Routes =====

// 🟢 Create Campaign
app.post("/api/create-campaign", upload.single("image"), (req, res) => {
  const { title, description, goal, category, creator } = req.body;
  const imagePath = req.file ? `/uploads/${req.file.filename}` : "";

  const newCampaign = {
    id: Date.now().toString(),
    title,
    description,
    goal,
    category,
    image: imagePath,
    creator,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  campaigns.push(newCampaign);
  res.json({ success: true, campaign: newCampaign });
});

// 🟢 Get All Campaigns (Dashboard + Campaigns Page)
app.get("/api/my-campaigns", (req, res) => {
  res.json({ campaigns });
});

// 🟢 Approve Campaign
app.post("/api/approve-campaign/:id", (req, res) => {
  const { id } = req.params;
  const campaign = campaigns.find((c) => c.id === id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  campaign.status = "approved";
  res.json({ success: true, campaign });
});

// 🟢 Delete Campaign
app.delete("/api/delete-campaign/:id", (req, res) => {
  const { id } = req.params;
  campaigns = campaigns.filter((c) => c.id !== id);
  res.json({ success: true });
});

// 🟢 Manage Campaign (view/edit a single campaign)
app.get("/api/manage-campaign/:id", (req, res) => {
  const { id } = req.params;
  const campaign = campaigns.find((c) => c.id === id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  res.json({ campaign });
});

// 🟢 Update Campaign Info (edit title, description, goal, etc.)
app.put("/api/update-campaign/:id", (req, res) => {
  const { id } = req.params;
  const { title, description, goal, category } = req.body;

  const campaign = campaigns.find((c) => c.id === id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  if (title) campaign.title = title;
  if (description) campaign.description = description;
  if (goal) campaign.goal = goal;
  if (category) campaign.category = category;

  res.json({ success: true, campaign });
});

// 🟢 Create a New User (for “Member Since” tracking)
app.post("/api/signup", (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const existingUser = users.find((u) => u.email === email);
  if (existingUser) return res.json({ success: true, user: existingUser });

  const newUser = {
    email,
    joinedAt: new Date().toISOString(),
  };
  users.push(newUser);

  res.json({ success: true, user: newUser });
});

// 🟢 Get “Member Since” info
app.get("/api/member-since/:email", (req, res) => {
  const { email } = req.params;
  const user = users.find((u) => u.email === email);
  if (!user) return res.status(404).json({ error: "User not found" });

  res.json({ email: user.email, joinedAt: user.joinedAt });
});

// 🟢 Donation (Stripe placeholder)
app.post("/api/create-checkout-session/:id", (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });

  // Placeholder URL for Stripe Checkout
  res.json({ url: `https://checkout.stripe.com/pay/test-session-${id}` });
});

// 🟢 Serve Frontend Homepage
app.get("/", (req, res) => {
  const indexPath = path.join(publicPath, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.send("Backend is running. Frontend not found.");
  }
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
