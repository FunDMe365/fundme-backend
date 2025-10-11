require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");
const { google } = require("googleapis");
const sgMail = require("@sendgrid/mail");
const Stripe = require("stripe");
const formidable = require("formidable");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;

// Serve static files
app.use(express.static("public"));
app.use("/uploads", express.static(path.join(__dirname, "public/uploads")));

// ===== Stripe Setup =====
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ===== CORS =====
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
    maxAge: 1000 * 60 * 60 * 24
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
  users: process.env.SPREADSHEET_USERS,
  waitlist: process.env.SPREADSHEET_WAITLIST,
  volunteers: process.env.SPREADSHEET_VOLUNTEERS,
  streetteam: process.env.SPREADSHEET_STREETTEAM,
  campaigns: process.env.SPREADSHEET_CAMPAIGNS
};

// ===== SendGrid =====
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// ===== Helpers =====
async function sendEmail({ to, subject, html }) {
  try {
    await sgMail.send({ to, from: process.env.EMAIL_USER, subject, html });
  } catch (error) {
    console.error("SendGrid error:", error.message);
  }
}

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

async function verifyUser(email, password) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_IDS.users,
    range: "Users!A:D"
  });
  const rows = response.data.values || [];
  const userRow = rows.find(row => row[2].toLowerCase() === email.toLowerCase());
  if (!userRow) return false;
  const storedHash = userRow[3];
  const match = await bcrypt.compare(password, storedHash);
  return match ? { name: userRow[1], email: userRow[2] } : false;
}

// ===== Routes =====

// --- Sign Up ---
app.post("/api/signup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ success: false, message: "Name, email, and password are required." });
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
  if (!name || !email || !source || !reason) return res.status(400).json({ success: false, error: "All fields are required." });

  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [name, email, source, reason, new Date().toISOString()]);

    setImmediate(async () => {
      await sendEmail({
        to: email,
        subject: "🎉 Welcome to the JoyFund Waitlist! 🌈",
        html: `<div style="font-family:Arial,sans-serif; text-align:center; color:#FF69B4;">
                <h1>🎊 Congratulations, ${name}! 🎊</h1>
                <p>You are officially on the JoyFund waitlist! 💖💙</p>
              </div>`
      });

      await sendEmail({
        to: process.env.RECEIVE_EMAIL,
        subject: "New Waitlist Submission",
        html: `<p>New waitlist submission: Name: ${name}, Email: ${email}, Source: ${source}, Reason: ${reason}</p>`
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
    await saveToSheet(SPREADSHEET_IDS.volunteers, "Volunteers", [name, email, city, message, new Date().toISOString()]);
    setImmediate(async () => {
      await sendEmail({ to: email, subject: "🎉 Volunteer Application Received! 🌟", html: `<p>Thank you, ${name}!</p>` });
      await sendEmail({ to: process.env.RECEIVE_EMAIL, subject: "New Volunteer Application", html: `<p>Name: ${name}, Email: ${email}, City: ${city}, Message: ${message}</p>` });
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
    await saveToSheet(SPREADSHEET_IDS.streetteam, "StreetTeam", [name, email, city, message, new Date().toISOString()]);
    setImmediate(async () => {
      await sendEmail({ to: email, subject: "🎉 Street Team Application Received! 🌈", html: `<p>Thanks, ${name}!</p>` });
      await sendEmail({ to: process.env.RECEIVE_EMAIL, subject: "New Street Team Application", html: `<p>Name: ${name}, Email: ${email}, City: ${city}, Message: ${message}</p>` });
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
    const { amount } = req.body; // Amount in cents
    if (!amount || amount < 100) return res.status(400).json({ success: false, error: "Invalid donation amount (min $1)." });

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
    console.error("Stripe error:", error.message);
    res.status(500).json({ success: false, error: "Payment processing failed." });
  }
});

// ===== Campaign Creation =====
app.post("/api/campaigns", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated." });

  try {
    const form = new formidable.IncomingForm({ multiples: false });
    form.uploadDir = path.join(__dirname, "public/uploads");
    form.keepExtensions = true;

    if (!fs.existsSync(form.uploadDir)) fs.mkdirSync(form.uploadDir, { recursive: true });

    form.parse(req, async (err, fields, files) => {
      if (err) return res.status(500).json({ success: false, error: "Error parsing form." });

      const { title, description, goal, category, endDate, location } = fields;
      if (!title || !description || !goal) return res.status(400).json({ success: false, error: "Title, description, and goal are required." });

      const id = `CAMP-${Date.now()}`;
      const creatorEmail = req.session.user.email;
      const createdAt = new Date().toISOString();
      const raised = 0;

      let imageFileName = "";
      if (files.image && files.image.size > 0) {
        const ext = path.extname(files.image.originalFilename);
        imageFileName = `${id}${ext}`;
        const destPath = path.join(form.uploadDir, imageFileName);
        fs.renameSync(files.image.filepath, destPath);
      }

      const values = [id, title, description, goal, raised, creatorEmail, createdAt, category || "", endDate || "", location || "", imageFileName];
      await saveToSheet(SPREADSHEET_IDS.campaigns, "Campaigns", values);

      res.json({ success: true, id });
    });
  } catch (err) {
    console.error("Create campaign error:", err.message);
    res.status(500).json({ success: false, error: "Failed to create campaign. Please try again." });
  }
});

// ===== Start server =====
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
