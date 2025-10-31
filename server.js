require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const bcrypt = require("bcrypt");
const session = require("express-session");
const { google } = require("googleapis");
const sgMail = require("@sendgrid/mail");
const Stripe = require("stripe");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "joyfund-secret",
    resave: false,
    saveUninitialized: true,
  })
);

// Serve uploads folder
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ---------- GOOGLE SHEETS (Waitlist) ----------
const auth = new google.auth.GoogleAuth({
  credentials: {
    type: "service_account",
    project_id: process.env.GOOGLE_PROJECT_ID,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// ---------- FILE UPLOAD (for campaign images, etc.) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "uploads");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  },
});

const upload = multer({ storage });

// ---------- ROUTES ----------

// ✅ Root route
app.get("/", (req, res) => {
  res.send("🎉 JoyFund Backend is running successfully!");
});

// ✅ Sign-Up
app.post("/api/signup", async (req, res) => {
  try {
    const { email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    // You can replace this with a DB insert later
    console.log("New user registered:", email);

    res.json({ success: true, message: "Signup successful for JoyFund" });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({ success: false, message: "Signup failed" });
  }
});

// ✅ Sign-In
app.post("/api/signin", async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log("Attempted login:", email);

    // Placeholder user check — replace with DB later
    const mockUser = { email: "test@joyfund.org", password: await bcrypt.hash("123456", 10) };

    const valid = await bcrypt.compare(password, mockUser.password);
    if (!valid || email !== mockUser.email) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    req.session.user = email;
    res.json({ success: true, message: "Sign-in successful for JoyFund" });
  } catch (error) {
    console.error("Sign-in error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ Stripe Donation
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { amount } = req.body; // in cents
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "JoyFund Donation",
            },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.FRONTEND_URL}/success.html`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel.html`,
    });

    res.json({ id: session.id });
  } catch (error) {
    console.error("Stripe error:", error);
    res.status(500).json({ success: false, message: "Payment error" });
  }
});

// ✅ Waitlist form (adds email to Google Sheet)
app.post("/api/waitlist", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email required" });

    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Sheet1!A:A",
      valueInputOption: "USER_ENTERED",
      resource: { values: [[email, new Date().toLocaleString()]] },
    });

    res.json({ success: true, message: "Added to JoyFund waitlist!" });
  } catch (error) {
    console.error("Waitlist error:", error);
    res.status(500).json({ success: false, message: "Waitlist submission failed" });
  }
});

// ✅ File Upload
app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    const filePath = `/uploads/${req.file.filename}`;
    res.json({ success: true, filePath });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ success: false, message: "File upload failed" });
  }
});

// ✅ Send Email via SendGrid
app.post("/api/send-email", async (req, res) => {
  try {
    const { to, subject, message } = req.body;

    const msg = {
      to,
      from: process.env.SENDGRID_SENDER,
      subject: `JoyFund - ${subject}`,
      text: message,
      html: `<p>${message}</p>`,
    };

    await sgMail.send(msg);
    res.json({ success: true, message: "Email sent successfully" });
  } catch (error) {
    console.error("Email error:", error);
    res.status(500).json({ success: false, message: "Email failed" });
  }
});

// ✅ Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true, message: "Logged out successfully" });
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 JoyFund backend running on port ${PORT}`);
});
