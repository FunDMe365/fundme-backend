const express = require("express");
const bodyParser = require("body-parser");
const nodemailer = require("nodemailer");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// ===== CORS Setup =====
app.use(cors({
  origin: ["https://fundasmile.net", "http://localhost:3000"],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  credentials: true
}));

// Ensure Express handles preflight OPTIONS requests
app.options("*", cors());

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Example signup route
app.post("/api/signup", (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.json({ success: false, error: "All fields are required." });
  }

  // For now, just respond with success (you can connect DB later)
  res.json({ success: true, message: "User signed up successfully." });
});

// Example signin route
app.post("/api/signin", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.json({ success: false, error: "Email and password required." });
  }

  // For now, accept any signin attempt (replace with DB validation later)
  res.json({ success: true, message: "Signed in successfully." });
});

// Keep your other form handlers (waitlist, volunteer, street team, etc.)
// --- unchanged ---

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
