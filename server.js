// =======================
// JoyFund / FunDaSmile Backend Server
// =======================

const express = require("express");
const path = require("path");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const app = express();

// -----------------------
// Middleware
// -----------------------
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// -----------------------
// Helper for saving JSON
// -----------------------
function saveJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}
function readJSON(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8") || "[]");
  } catch {
    return [];
  }
}

// -----------------------
// WAITLIST FORM
// -----------------------
app.post("/api/waitlist", (req, res) => {
  try {
    const { name, email } = req.body;
    console.log("🟢 Waitlist submission:", name, email);

    const file = path.join(__dirname, "waitlist.json");
    const existing = readJSON(file);
    existing.push({ name, email, createdAt: new Date().toISOString() });
    saveJSON(file, existing);

    return res.json({ success: true, message: "Waitlist submission received" });
  } catch (err) {
    console.error("❌ Waitlist error:", err);
    res.status(500).json({ error: "Server error submitting waitlist" });
  }
});

// -----------------------
// VOLUNTEER FORM
// -----------------------
app.post("/api/volunteer", (req, res) => {
  try {
    const { name, email, interest } = req.body;
    console.log("🟢 Volunteer submission:", name, email, interest);

    const file = path.join(__dirname, "volunteers.json");
    const existing = readJSON(file);
    existing.push({ name, email, interest, createdAt: new Date().toISOString() });
    saveJSON(file, existing);

    return res.json({ success: true, message: "Volunteer submission received" });
  } catch (err) {
    console.error("❌ Volunteer error:", err);
    res.status(500).json({ error: "Server error submitting volunteer form" });
  }
});

// -----------------------
// CONTACT FORM
// -----------------------
app.post("/api/contact", (req, res) => {
  try {
    const { name, email, message } = req.body;
    console.log("🟢 Contact form submission:", name, email, message);

    const file = path.join(__dirname, "contacts.json");
    const existing = readJSON(file);
    existing.push({ name, email, message, createdAt: new Date().toISOString() });
    saveJSON(file, existing);

    return res.json({ success: true, message: "Message received" });
  } catch (err) {
    console.error("❌ Contact error:", err);
    res.status(500).json({ error: "Server error submitting contact form" });
  }
});

// -----------------------
// USER SIGNUP
// -----------------------
app.post("/api/signup", (req, res) => {
  try {
    const { email, password } = req.body;
    console.log("🟢 New user signup:", email);

    const file = path.join(__dirname, "users.json");
    const existing = readJSON(file);

    if (existing.find((u) => u.email === email)) {
      return res.status(400).json({ error: "Email already registered" });
    }

    existing.push({ email, password, createdAt: new Date().toISOString() });
    saveJSON(file, existing);

    return res.json({ success: true, message: "User registered successfully" });
  } catch (err) {
    console.error("❌ Signup error:", err);
    res.status(500).json({ error: "Server error during signup" });
  }
});

// -----------------------
// USER LOGIN
// -----------------------
app.post("/api/login", (req, res) => {
  try {
    const { email, password } = req.body;
    const file = path.join(__dirname, "users.json");
    const existing = readJSON(file);
    const user = existing.find((u) => u.email === email && u.password === password);

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    console.log("✅ User logged in:", email);
    return res.json({ success: true, message: "Login successful" });
  } catch (err) {
    console.error("❌ Login error:", err);
    res.status(500).json({ error: "Server error during login" });
  }
});

// -----------------------
// CREATE CAMPAIGN
// -----------------------
app.post("/api/campaigns", (req, res) => {
  try {
    const { title, description, goal, category, endDate, location } = req.body;

    if (!title || !description || !goal) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const newCampaign = {
      id: Date.now().toString(),
      title,
      description,
      goal,
      raised: 0,
      category: category || "General",
      endDate: endDate || "",
      location: location || "",
      createdAt: new Date().toISOString(),
    };

    console.log("🎉 New Campaign Created:", newCampaign);

    const file = path.join(__dirname, "campaigns.json");
    const existing = readJSON(file);
    existing.push(newCampaign);
    saveJSON(file, existing);

    return res.json({ success: true, id: newCampaign.id });
  } catch (err) {
    console.error("❌ Campaign creation error:", err);
    res.status(500).json({ error: "Server error creating campaign" });
  }
});

// -----------------------
// FETCH ALL CAMPAIGNS
// -----------------------
app.get("/api/campaigns", (req, res) => {
  try {
    const file = path.join(__dirname, "campaigns.json");
    const campaigns = readJSON(file);
    return res.json(campaigns);
  } catch (err) {
    console.error("❌ Error fetching campaigns:", err);
    res.status(500).json({ error: "Error fetching campaigns" });
  }
});

// -----------------------
// DEFAULT HOME ROUTE
// -----------------------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// -----------------------
// START SERVER
// -----------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 JoyFund / FunDaSmile backend running on port ${PORT}`);
});
