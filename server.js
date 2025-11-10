require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const cors = require("cors");
const multer = require("multer");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");
const Stripe = require("stripe");

const app = express();
const PORT = process.env.PORT || 5000;

// ----------------- MIDDLEWARE -----------------
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
}));

// ----------------- MULTER -----------------
const upload = multer({ dest: "uploads/" });

// ----------------- EMAIL -----------------
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: process.env.EMAIL_SECURE === "true",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ----------------- STRIPE -----------------
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ----------------- GOOGLE SHEETS -----------------
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheetsClient = auth.getClient();
const sheets = google.sheets({ version: "v4", auth: sheetsClient });

// ----------------- ROUTES -----------------

// Health check
app.get("/", (req, res) => res.send("JoyFund backend is running"));

// ----------------- USER AUTH -----------------
let users = []; // For testing; replace with DB in production

app.post("/api/signup", async (req, res) => {
  const { email, password } = req.body;
  if (users.find(u => u.email === email)) return res.status(400).json({ message: "Email exists" });
  const hash = await bcrypt.hash(password, 10);
  const newUser = { email, password: hash };
  users.push(newUser);
  req.session.user = { email };
  res.json({ success: true });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email);
  if (!user) return res.status(400).json({ message: "User not found" });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(400).json({ message: "Wrong password" });
  req.session.user = { email };
  res.json({ success: true });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ----------------- WAITLIST -----------------
app.post("/api/waitlist", async (req, res) => {
  const { name, email } = req.body;
  try {
    // Append to Google Sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Waitlist!A:B",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[name, email, new Date().toISOString()]] }
    });
    // Send confirmation email
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "JoyFund Waitlist Confirmation",
      text: `Hi ${name}, thanks for joining the JoyFund waitlist!`
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ----------------- DONATIONS -----------------
app.post("/api/donate", async (req, res) => {
  const { amount, email } = req.body;
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount * 100,
      currency: "usd",
      receipt_email: email
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ----------------- VOLUNTEER / STREET TEAM -----------------
app.post("/api/volunteer", async (req, res) => {
  const { name, email, role } = req.body;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "Volunteers!A:C",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[name, email, role, new Date().toISOString()]] }
    });
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: "JoyFund Volunteer Confirmation",
      text: `Hi ${name}, thanks for signing up as a ${role}!`
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ----------------- CREATE CAMPAIGN -----------------
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ message: "Not logged in" });
  try {
    // You can save the uploaded image in uploads/ and store path in DB
    const { title, description, goal } = req.body;
    res.json({ success: true, message: "Campaign created" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

// ----------------- ID VERIFICATION -----------------
app.post("/api/verify-id", upload.single("idDocument"), async (req, res) => {
  const user = req.session.user;
  if (!user) return res.status(401).json({ message: "Not logged in" });
  if (!req.file) return res.status(400).json({ message: "No file uploaded" });
  // Save file and mark user as verified in DB
  res.json({ success: true, message: "ID uploaded" });
});

// ----------------- START SERVER -----------------
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
