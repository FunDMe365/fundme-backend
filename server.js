// server.js

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");
const app = express();

app.use(cors());
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ✅ Serve static files correctly
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ✅ Ensure uploads folder exists
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// ✅ Multer storage setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({ storage });

// ✅ Campaign data storage
let campaigns = [];
let approvedCampaigns = [];

// ✅ Create campaign
app.post("/api/create-campaign", upload.single("image"), (req, res) => {
  const { title, description, goal } = req.body;

  if (!title || !description || !goal) {
    return res.status(400).json({ message: "Missing required fields." });
  }

  const newCampaign = {
    id: Date.now().toString(),
    title,
    description,
    goal,
    raised: 0,
    status: "pending",
    image: req.file ? `/uploads/${req.file.filename}` : null,
  };

  campaigns.push(newCampaign);
  res.status(200).json({ message: "Campaign created successfully!", campaign: newCampaign });
});

// ✅ Get all campaigns
app.get("/api/campaigns", (req, res) => {
  res.json(campaigns);
});

// ✅ Approve campaign
app.post("/api/approve/:id", (req, res) => {
  const id = req.params.id;
  const campaign = campaigns.find(c => c.id === id);
  if (campaign) {
    campaign.status = "approved";
    approvedCampaigns.push(campaign);
    res.json({ message: "Campaign approved!", campaign });
  } else {
    res.status(404).json({ message: "Campaign not found" });
  }
});

// ✅ Get approved campaigns
app.get("/api/approved-campaigns", (req, res) => {
  res.json(approvedCampaigns);
});

// ✅ Delete campaign
app.delete("/api/delete-campaign/:id", (req, res) => {
  const id = req.params.id;
  campaigns = campaigns.filter(c => c.id !== id);
  approvedCampaigns = approvedCampaigns.filter(c => c.id !== id);
  res.json({ message: "Campaign deleted successfully!" });
});

// ✅ Update campaign status
app.post("/api/update-status/:id", (req, res) => {
  const { status } = req.body;
  const id = req.params.id;
  const campaign = campaigns.find(c => c.id === id);
  if (campaign) {
    campaign.status = status;
    res.json({ message: "Campaign status updated!", campaign });
  } else {
    res.status(404).json({ message: "Campaign not found" });
  }
});

// ✅ Serve frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
