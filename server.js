require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const sgMail = require("@sendgrid/mail");
const Stripe = require("stripe"); // ✅ Stripe added

const app = express();
const PORT = process.env.PORT || 5000;

// ===== Stripe Setup =====
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ===== CORS Setup =====
app.use(cors({
  origin: ["https://fundasmile.net", "http://localhost:3000"],
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  credentials: true
}));
app.options("*", cors());

// ===== Middleware =====
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Session Setup =====
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    collectionName: 'sessions'
  }),
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: 'none',
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  }
}));

// ===== Google Sheets Setup =====
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
  scopes: SCOPES
});
const sheets = google.sheets({ version: "v4", auth });

// ===== Spreadsheet IDs =====
const SPREADSHEET_IDS = {
  users: "1i9pAQ0xOpv1GiDqqvE5pSTWKtA8VqPDpf8nWDZPC4B0",
  volunteers: "1O_y1yDiYfO0RT8eGwBMtaiPWYYvSR8jIDIdZkZPlvNA",
  streetteam: "1dPz1LqQq6SKjZIwsgIpQJdQzdmlOV7YrOZJjHqC4Yg8",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ"
};

// ===== SendGrid Setup =====
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ===== Email Helper =====
async function sendEmail({ to, subject, html }) {
  try {
    const msg = {
      to,
      from: process.env.EMAIL_USER,
      subject,
      html
    };
    const response = await sgMail.send(msg);
    console.log(`✅ Email sent to ${to}:`, response[0].statusCode);
    return true;
  } catch (error) {
    if (error.response && error.response.body) {
      console.error("❌ SendGrid error:", error.response.body);
    } else {
      console.error("❌ SendGrid error:", error.message);
    }
    return false;
  }
}

// ===== Helper Functions =====
async function saveToSheet(sheetId, sheetName, values) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:Z`,
      valueInputOption: "RAW",
      requestBody: { values: [values] }
    });
  } catch (err) {
    console.error(`Error saving to ${sheetName}:`, err.message);
    throw err;
  }
}

async function saveUser({ name, email, password }) {
  const hashedPassword = await bcrypt.hash(password, 10);
  await saveToSheet(
    SPREADSHEET_IDS.users,
    "Users",
    [new Date().toISOString(), name, email, hashedPassword]
  );
}

// ===== FIXED: verifyUser =====
async function verifyUser(email, password) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!A:D" // Include PasswordHash column
  });
  const rows = response.data.values || [];

  console.log("Checking credentials for:", email);

  const userRow = rows.find(row => row[2].toLowerCase() === email.toLowerCase());
  if (!userRow) {
    console.log("User not found for email:", email);
    return false;
  }

  const storedHash = userRow[3]; // Column D is PasswordHash
  console.log("Stored hash:", storedHash);

  const match = await bcrypt.compare(password, storedHash);
  console.log("Password match:", match);

  return match ? { name: userRow[1], email: userRow[2] } : false;
}

// ===== Routes =====

// --- Sign Up ---
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: "Name, email, and password are required." });
  }
  try {
    await saveUser({ name, email, password });
    res.json({ success: true, message: "Account created successfully!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Error creating account." });
  }
});

// --- Sign In ---
app.post("/api/signin", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: "Email and password required." });

  try {
    const user = await verifyUser(email, password);
    if (!user) return res.status(401).json({ success: false, error: "Invalid email or password." });

    req.session.user = { name: user.name, email: user.email };
    res.json({ success: true, message: "Signed in successfully." });
  } catch (err) {
    console.error("Signin error:", err.message);
    res.status(500).json({ success: false, error: "Server error." });
  }
});

// --- Dashboard ---
app.get("/api/dashboard", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  const { name, email } = req.session.user;
  res.json({ success: true, name, email, campaigns: 0, donations: 0, recentActivity: [] });
});

// --- Profile ---
app.get("/api/profile", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  res.json({ success: true, profile: req.session.user });
});

// ===== Waitlist Submission =====
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;

  if (!name || !email || !source || !reason) {
    return res.status(400).json({ success: false, error: "All fields are required." });
  }

  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [
      name,
      email,
      source,
      reason,
      new Date().toISOString()
    ]);

    setImmediate(async () => {
      await sendEmail({
        to: email,
        subject: "🎉 Welcome to the JoyFund Waitlist! 🌈",
        html: `
        <div style="font-family:Arial,sans-serif; text-align:center; color:#FF69B4;">
          <h1 style="color:#FF69B4;">🎊 Congratulations, ${name}! 🎊</h1>
          <p style="font-size:18px; color:#1E90FF;">You are officially on the <strong>JoyFund waitlist</strong>! 💖💙</p>
          <p style="font-size:16px;">We’re thrilled to have you join our joyful community of changemakers. Expect amazing updates and opportunities soon! 🌟</p>
          <p style="font-size:16px;">Keep spreading smiles 😄✨</p>
          <p style="margin-top:20px; font-size:14px; color:#888;">— The JoyFund Team</p>
        </div>
        `
      });

      await sendEmail({
        to: process.env.RECEIVE_EMAIL,
        subject: "New Waitlist Submission",
        html: `<p>New waitlist submission:</p>
               <ul>
                 <li><strong>Name:</strong> ${name}</li>
                 <li><strong>Email:</strong> ${email}</li>
                 <li><strong>Source:</strong> ${source}</li>
                 <li><strong>Reason:</strong> ${reason}</li>
               </ul>`
      });
    });

    res.json({ success: true, message: "🎉 Successfully joined the waitlist! Check your email for confirmation." });

  } catch (err) {
    console.error("Waitlist submission error:", err.message);
    res.status(500).json({ success: false, error: "Failed to save to waitlist. Please try again later." });
  }
});

// ===== Volunteer Submission =====
app.post("/submit-volunteer", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ success: false, error: "All fields are required." });

  try {
    await saveToSheet(SPREADSHEET_IDS.volunteers, "Volunteers", [
      name,
      email,
      city,
      message,
      new Date().toISOString()
    ]);

    setImmediate(async () => {
      await sendEmail({
        to: email,
        subject: "🎉 Volunteer Application Received! 🌟",
        html: `
          <div style="font-family:Arial,sans-serif; text-align:center; color:#FF69B4;">
            <h1 style="color:#FF69B4;">🎊 Thank you, ${name}! 🎊</h1>
            <p style="font-size:18px; color:#1E90FF;">Your application to volunteer with <strong>JoyFund INC.</strong> has been received! 💖💙</p>
            <p style="font-size:16px;">Expect updates and next steps soon! 🌟</p>
            <p style="font-size:16px;">Keep spreading joy 😄✨</p>
            <p style="margin-top:20px; font-size:14px; color:#888;">— The JoyFund Team</p>
          </div>
        `
      });

      await sendEmail({
        to: process.env.RECEIVE_EMAIL,
        subject: "New Volunteer Application",
        html: `<p>New volunteer submission:</p>
               <ul>
                 <li><strong>Name:</strong> ${name}</li>
                 <li><strong>Email:</strong> ${email}</li>
                 <li><strong>City:</strong> ${city}</li>
                 <li><strong>Message:</strong> ${message}</li>
               </ul>`
      });
    });

    res.json({ success: true, message: "✅ Volunteer application submitted successfully!" });
  } catch (err) {
    console.error("Volunteer submission error:", err.message);
    res.status(500).json({ success: false, error: "Failed to submit volunteer application." });
  }
});

// ===== Street Team Submission =====
app.post("/submit-streetteam", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) return res.status(400).json({ success: false, error: "All fields are required." });

  try {
    await saveToSheet(SPREADSHEET_IDS.streetteam, "StreetTeam", [
      name,
      email,
      city,
      message,
      new Date().toISOString()
    ]);

    setImmediate(async () => {
      await sendEmail({
        to: email,
        subject: "🎉 Street Team Application Received! 🌈",
        html: `
          <div style="font-family:Arial,sans-serif; text-align:center; color:#1E90FF;">
            <h1 style="color:#FF69B4;">🎊 Congratulations, ${name}! 🎊</h1>
            <p style="font-size:18px; color:#1E90FF;">Your application to join the <strong>JoyFund Street Team</strong> has been received! 💖💙</p>
            <p style="font-size:16px;">Next steps will arrive soon! 🌟</p>
            <p style="font-size:16px;">Keep inspiring smiles 😄✨</p>
            <p style="margin-top:20px; font-size:14px; color:#888;">— The JoyFund Team</p>
          </div>
        `
      });

      await sendEmail({
        to: process.env.RECEIVE_EMAIL,
        subject: "New Street Team Application",
        html: `<p>New Street Team submission:</p>
               <ul>
                 <li><strong>Name:</strong> ${name}</li>
                 <li><strong>Email:</strong> ${email}</li>
                 <li><strong>City:</strong> ${city}</li>
                 <li><strong>Message:</strong> ${message}</li>
               </ul>`
      });
    });

    res.json({ success: true, message: "✅ Street Team application submitted successfully!" });
  } catch (err) {
    console.error("Street Team submission error:", err.message);
    res.status(500).json({ success: false, error: "Failed to submit Street Team application." });
  }
});

// --- Logout ---
app.post("/api/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ===== Messages =====
app.get("/api/messages", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  if (!req.session.messages) req.session.messages = [];
  res.json({ success: true, messages: req.session.messages });
});

app.post("/api/messages", (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });
  const { text } = req.body;
  if (!text) return res.status(400).json({ success: false, error: "Message text is required." });

  if (!req.session.messages) req.session.messages = [];
  req.session.messages.push({ text, timestamp: new Date().toISOString() });

  res.json({ success: true, message: "Message added.", messages: req.session.messages });
});

// ===== Stripe Donation Route =====
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    let { amount } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ success: false, error: "Invalid donation amount (min $1)." });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Donation to JoyFund INC." },
            unit_amount: amount,
          },
          quantity: 1,
        },
      ],
      success_url: "https://fundasmile.net/thankyou.html",
      cancel_url: "https://fundasmile.net/cancel.html",
    });

    res.json({ success: true, url: session.url });
  } catch (error) {
    console.error("Stripe error:", error);
    res.status(500).json({ success: false, error: "Payment processing failed." });
  }
   app.post("/api/campaigns", (req, res) => {
  console.log("✅ Campaign received:", req.body);
  res.json({ message: "Campaign created successfully!" });
   });
});

// ===== Start Server =====
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
