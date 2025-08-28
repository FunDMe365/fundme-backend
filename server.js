require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const { google } = require("googleapis");
const mongoose = require("mongoose");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --------------------
// MongoDB Connection
// --------------------
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

// --------------------
// Email Transporter
// --------------------
let transporter;
if (process.env.EMAIL_ENABLED === "true") {
  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  transporter.verify((err, success) => {
    if (err) console.error("❌ Email transporter error:", err);
    else console.log("✅ Email transporter ready");
  });
}

// --------------------
// Google Sheets Setup
// --------------------
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_KEY_JSON);

const sheetsClient = new google.auth.JWT(
  serviceAccount.client_email,
  null,
  serviceAccount.private_key.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/spreadsheets"]
);

const sheets = google.sheets({ version: "v4", auth: sheetsClient });

sheetsClient.authorize((err, tokens) => {
  if (err) console.error("❌ Google Sheets auth error:", err);
  else console.log("✅ Google Sheets authentication ready");
});

// --------------------
// Waitlist Route
// --------------------
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;

  if (!name || !email || !reason) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Add to Google Sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: process.env.SHEET_RANGE,
      valueInputOption: "RAW",
      requestBody: {
        values: [[new Date().toLocaleString(), name, email, source, reason]],
      },
    });

    // Send confirmation email
    if (process.env.EMAIL_ENABLED === "true") {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: "🎉 You joined the JoyFund Waitlist!",
        text: `Hi ${name},\n\nThanks for joining the JoyFund waitlist! We'll keep you updated on all joyful campaigns.\n\n– JoyFund INC.`,
      });
    }

    res.json({ message: "🎉 Successfully joined the waitlist!" });
  } catch (err) {
    console.error("❌ Waitlist submission error:", err);
    res.status(500).json({ error: "Failed to submit waitlist." });
  }
});

// --------------------
// Start Server
// --------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
