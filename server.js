import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import nodemailer from "nodemailer";
import { google } from "googleapis";
import fs from "fs";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// 🔹 Google Sheets setup
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_KEY_JSON);

const jwtClient = new google.auth.JWT(
  serviceAccount.client_email,
  null,
  serviceAccount.private_key,
  SCOPES
);

const sheets = google.sheets({ version: "v4", auth: jwtClient });

// 🔹 Nodemailer setup
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT),
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// 🔹 Test GET route for backend check
app.get("/", (req, res) => {
  res.send("🎉 JoyFund backend is working!");
});

// 🔹 Waitlist endpoint
app.post("/api/waitlist", async (req, res) => {
  const { name, email, reason } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: "Name and email are required." });
  }

  try {
    // Add to Google Sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      range: "Sheet1!A:D", // columns: Name | Email | Date | Reason
      valueInputOption: "RAW",
      resource: {
        values: [[name, email, new Date().toISOString(), reason || ""]],
      },
    });

    // Send confirmation email
    await transporter.sendMail({
      from: `"JoyFund INC." <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Welcome to the JoyFund Waitlist! 🎉",
      html: `
        <h2>Hi ${name},</h2>
        <p>Thank you for joining the JoyFund waitlist!</p>
        <p>We'll notify you when you can start creating campaigns and spreading joy.</p>
        <p>Stay joyful,<br/>JoyFund INC.</p>
      `,
    });

    res.json({ message: "Successfully added to waitlist and email sent!" });
  } catch (err) {
    console.error("Waitlist error:", err);
    res.status(500).json({ error: "Failed to process waitlist. Try again later." });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
