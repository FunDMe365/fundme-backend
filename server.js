// ==================== SERVER.JS - JOYFUND BACKEND (FIXED) ====================

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const { google } = require("googleapis");
const Stripe = require("stripe");
const cors = require("cors");
const mailjetLib = require("node-mailjet");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 5000;

// -------------------- REQUIRED ENV VARIABLES --------------------
const requiredEnvs = [
  "JWT_SECRET",
  "SESSION_SECRET",
  "STRIPE_SECRET_KEY",
  "FRONTEND_URL"
];
for (const envVar of requiredEnvs) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// -------------------- CORS --------------------
const allowedOrigins = [
  "https://fundasmile.net",
  "https://www.fundasmile.net",
  "https://fundme-backend.onrender.com",
  "http://localhost:5000",
  "http://127.0.0.1:5000"
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("CORS not allowed"));
  },
  credentials: true
}));

// -------------------- BODY PARSING --------------------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

// -------------------- SESSION --------------------
app.set('trust proxy', 1);

app.use(session({
  name: 'sessionId',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 24
  }
}));

// -------------------- STATIC FILES --------------------
app.use(express.static(path.join(__dirname, "public")));

// -------------------- STRIPE --------------------
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// -------------------- MAILJET --------------------
let mailjetClient = null;
if (process.env.MAILJET_API_KEY && process.env.MAILJET_API_SECRET) {
  mailjetClient = mailjetLib.apiConnect(process.env.MAILJET_API_KEY, process.env.MAILJET_API_SECRET);
}

async function sendMailjetEmail(subject, htmlContent, toEmail) {
  if (!mailjetClient) return;
  try {
    await mailjetClient.post("send", { 'version': 'v3.1' }).request({
      Messages: [{
        From: { Email: process.env.MAILJET_SENDER_EMAIL, Name: "JoyFund INC" },
        To: [{ Email: toEmail || process.env.NOTIFY_EMAIL }],
        Subject: subject,
        HTMLPart: htmlContent
      }]
    });
  } catch (err) {
    console.error("Mailjet error:", err);
  }
}

// -------------------- GOOGLE SHEETS --------------------
// Note: using CommonJS require at top. Removed stray `import` to avoid runtime errors.

let sheets;

function safeJSONParse(input) {
  try {
    return JSON.parse(input);
  } catch (e) {
    console.error("❌ Failed to parse GOOGLE_CREDENTIALS_JSON:", e.message);
    return null;
  }
}

// Initialize sheets
try {
  const creds = safeJSONParse(process.env.GOOGLE_CREDENTIALS_JSON);
  if (creds) {
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    sheets = google.sheets({ version: "v4", auth });
    console.log("✅ Google Sheets initialized successfully.");
  } else {
    console.log("❌ No valid GOOGLE_CREDENTIALS_JSON loaded.");
  }
} catch (err) {
  console.error("❌ Google Sheets init failed:", err.message);
}

// Utility: convert 0-based column index → A1 string (0 -> A, 25 -> Z, 26 -> AA)
function colToA1(n) {
  let s = "";
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

// Read values from sheet (returns raw rows, including header row if present)
async function getSheetValues(spreadsheetId, range) {
  if (!sheets) return [];
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range
  });
  return res.data.values || [];
}

// Append rows
async function appendSheetValues(spreadsheetId, range, values) {
  if (!sheets) throw new Error("Sheets not initialized");

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "USER_ENTERED",
    resource: { values }
  });
}

// findRowAndUpdateOrAppend:
// - rangeCols expects sheetName!A:Z (start and end columns OK), e.g. "Campaigns!A:I"
// - matchColIndex is 0-based index relative to the returned row array
async function findRowAndUpdateOrAppend(
  spreadsheetId,
  rangeCols,
  matchColIndex,
  matchValue,
  updatedValues
) {

  if (!sheets) throw new Error("Sheets not initialized");

  const rows = await getSheetValues(spreadsheetId, rangeCols);

  // If no rows at all, just append header-less values
  if (!rows || rows.length === 0) {
    await appendSheetValues(spreadsheetId, rangeCols, [updatedValues]);
    return { action: "appended", row: 1 };
  }

  // attempt to skip header row when searching by data
  const dataRows = rows.length > 1 ? rows.slice(1) : [];

  const rowIndex = dataRows.findIndex(r =>
    (r[matchColIndex] || "").toString().trim().toLowerCase() ===
    (matchValue || "").toString().trim().toLowerCase()
  );

  // Row not found → append
  if (rowIndex === -1) {
    await appendSheetValues(spreadsheetId, rangeCols, [updatedValues]);
    return { action: "appended", row: rows.length + 1 };
  }

  // Update existing row
  // parse rangeCols sheet and start column correctly
  const [sheetName, rangePart] = rangeCols.split("!");
  // rangePart may be like "A:I" or "A:E" or "A2:Z"
  const startColLetter = (rangePart.split(":")[0] || "").replace(/[^A-Z]/gi, "").toUpperCase();
  if (!startColLetter) throw new Error("Invalid rangeCols start column");

  // convert column letter to 0-based index
  const startColIndex = startColLetter.split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 65 + 1), 0) - 1;

  const endColLetter = colToA1(startColIndex + updatedValues.length - 1);

  // +2: one for header skip and one because sheet rows are 1-indexed
  const updateRowNumber = rowIndex + 2;

  const updateRange = `${sheetName}!${startColLetter}${updateRowNumber}:${endColLetter}${updateRowNumber}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: updateRange,
    valueInputOption: "USER_ENTERED",
    resource: { values: [updatedValues] }
  });

  return { action: "updated", row: updateRowNumber };
}

// -------------------- MULTER --------------------
const storage = multer.memoryStorage();
const upload = multer({ storage });

// -------------------- SHEET RANGE CONSTANTS (match your tabs) --------------------
const VERIFICATIONS_RANGE = "ID_Verifications!A:E";
const CAMPAIGNS_RANGE = "Campaigns!A:I";
const DONATIONS_RANGE = "Donations!A:I";
const USERS_RANGE = "Users!A:E"; // adjust if your users tab name differs

// -------------------- USERS / SIGN-IN --------------------
async function getUsers() {
  if (!process.env.USERS_SHEET_ID) return [];
  return getSheetValues(process.env.USERS_SHEET_ID, USERS_RANGE);
}

async function getUserFromDB(email) {
  const users = await getUsers();
  if (!users || users.length <= 1) return null;
  const dataRows = users.slice(1);
  const row = dataRows.find(u => (u[2] || "").toLowerCase() === (email || "").toLowerCase());
  if (!row) return null;
  return {
    joinDate: row[0],
    name: row[1],
    email: row[2],
    passwordHash: row[3]
  };
}

async function checkPassword(inputPassword, storedHash) {
  if (!inputPassword || !storedHash) return false;
  return await bcrypt.compare(inputPassword.trim(), storedHash.trim());
}

// -------------------- SIGN-IN --------------------
app.post("/api/signin", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = await getUserFromDB(email);

    if (!user || !(await checkPassword(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const sessionToken = jwt.sign(
      { email: user.email, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.cookie("session", sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    req.session.user = { email: user.email, name: user.name };

    return res.json({
      ok: true,
      loggedIn: true,
      name: user.name,
      email: user.email,
    });

  } catch (error) {
    console.error("Signin error:", error);
    return res.status(500).json({ error: "Server error" });
  }
});

// -------------------- CHECK-AUTH --------------------
app.get("/api/check-session", (req, res) => {
  try {
    const token = req.cookies?.session;
    if (!token) return res.json({ loggedIn: false });

    const user = jwt.verify(token, process.env.JWT_SECRET);

    return res.json({
      loggedIn: true,
      email: user.email,
      name: user.name
    });

  } catch (err) {
    return res.json({ loggedIn: false });
  }
});

// -------------------- LOGOUT --------------------
app.post("/api/logout", (req, res) => {
  try {
    // Clear the JWT cookie
    res.clearCookie("session", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      path: "/"
    });

    // Clear the express-session cookie
    res.clearCookie("sessionId", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      path: "/"
    });

    // Destroy express session
    if (req.session) {
      req.session.destroy(err => {
        if (err) {
          console.error("Session destroy error:", err);
          return res.status(500).json({ success: false, message: "Logout failed" });
        }
        return res.json({ success: true, message: "Logged out successfully" });
      });
    } else {
      // No session? Just return success
      return res.json({ success: true, message: "Logged out successfully" });
    }
  } catch (err) {
    console.error("Logout error:", err);
    return res.status(500).json({ success: false, message: "Server error during logout" });
  }
});

// -------------------- CAMPAIGNS --------------------
app.post("/api/create-campaign", upload.single("image"), async (req, res) => {
  try {
    const user = req.session?.user;
    if (!user) return res.status(401).json({ success: false, message: "Sign in required" });

    const { title, goal, description, category } = req.body;
    if (!title || !goal || !description || !category)
      return res.status(400).json({ success: false, message: "Missing required fields" });

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    const campaignId = Date.now().toString();
    let imageUrl = "https://placehold.co/400x200?text=No+Image";

    if (req.file) {
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder: "joyfund/campaigns" }, (err, result) => {
          if (err) reject(err); else resolve(result);
        });
        stream.end(req.file.buffer);
      });
      imageUrl = uploadResult.secure_url;
    }

    const createdAt = new Date().toISOString();
    const status = "Pending";
    const newCampaignRow = [campaignId, title, user.email.toLowerCase(), goal, description, category, status, createdAt, imageUrl];

    // append to the Campaigns sheet (explicit sheet range)
    await appendSheetValues(spreadsheetId, CAMPAIGNS_RANGE, [newCampaignRow]);

    await sendMailjetEmail("New Campaign Submitted", `<p>${user.name} (${user.email}) submitted a campaign titled "${title}"</p>`);

    res.json({ success: true, message: "Campaign submitted", campaignId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to create campaign" });
  }
});

// -------------------- GET MY CAMPAIGNS --------------------
app.get("/api/my-campaigns", async (req, res) => {
  try {
    const user = req.session?.user;
    if (!user) return res.status(401).json({ success: false, message: "Not logged in" });

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    const rows = await getSheetValues(spreadsheetId, CAMPAIGNS_RANGE);

    const dataRows = rows.length > 1 ? rows.slice(1) : [];

    const myCampaigns = dataRows
      .filter(r => (r[2] || "").toLowerCase() === user.email.toLowerCase())
      .map(r => ({
        campaignId: r[0],
        title: r[1],
        creator: r[2],
        goal: r[3],
        description: r[4],
        category: r[5],
        status: r[6],
        createdAt: r[7],
        imageUrl: r[8] || "https://placehold.co/400x200?text=No+Image"
      }));

    res.json({ success: true, campaigns: myCampaigns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch campaigns" });
  }
});

// -------------------- PUBLIC CAMPAIGNS --------------------
app.get("/api/public-campaigns", async (req, res) => {
  try {
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    const rows = await getSheetValues(spreadsheetId, CAMPAIGNS_RANGE);

    const dataRows = rows.length > 1 ? rows.slice(1) : [];

    const activeCampaigns = dataRows
      .filter(r => {
        const status = (r[6] || "").toString().trim().toLowerCase();
        return ["approved", "active"].includes(status);
      })
      .map(r => ({
        campaignId: r[0],
        title: r[1],
        creator: r[2],
        goal: r[3],
        description: r[4],
        category: r[5],
        status: r[6],
        createdAt: r[7],
        imageUrl: r[8] || "https://placehold.co/400x200?text=No+Image"
      }));

    res.json({ success: true, campaigns: activeCampaigns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to fetch campaigns" });
  }
});

// -------------------- SEARCH CAMPAIGNS --------------------
app.get("/api/search-campaigns", async (req, res) => {
  try {
    const { category, amount } = req.query;
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });

    const spreadsheetId = process.env.CAMPAIGNS_SHEET_ID;
    const rows = await getSheetValues(spreadsheetId, CAMPAIGNS_RANGE);

    const dataRows = rows.length > 1 ? rows.slice(1) : [];

    let allCampaigns = dataRows.map(r => ({
      campaignId: r[0],
      title: r[1],
      creator: r[2],
      goal: parseFloat(r[3]) || 0,
      description: r[4],
      category: r[5],
      status: r[6],
      createdAt: r[7],
      imageUrl: r[8] || "https://placehold.co/400x200?text=No+Image"
    }));

    let filteredCampaigns = allCampaigns.filter(c => {
      const s = (c.status || "").toString().trim().toLowerCase();
      return ['approved', 'active'].includes(s);
    });

    if (category && category !== 'all') filteredCampaigns = filteredCampaigns.filter(c => c.category === category);
    if (amount) filteredCampaigns = filteredCampaigns.filter(c => c.goal <= parseFloat(amount));

    res.json({ success: true, campaigns: filteredCampaigns });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to search campaigns" });
  }
});

// -------------------- STRIPE CHECKOUT --------------------
app.post("/api/create-checkout-session/:campaignId", async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { amount, successUrl, cancelUrl } = req.body;
    if (!amount || !successUrl || !cancelUrl) return res.status(400).json({ error: "Missing required fields" });

    const amountCents = Math.round(amount * 100);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: `JoyFund Donation - ${campaignId}` },
          unit_amount: amountCents,
        },
        quantity: 1
      }],
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// -------------------- WAITLIST / VOLUNTEERS / STREET TEAM --------------------
app.post("/api/waitlist", async (req, res) => {
  try {
    const { name, email, reason } = req.body;
    if (!name || !email) return res.status(400).json({ success: false, message: "Missing name or email" });
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });

    const spreadsheetId = process.env.WAITLIST_SHEET_ID;
    const timestamp = new Date().toLocaleString();
    await appendSheetValues(spreadsheetId, "Waitlist!A:D", [[timestamp, name, email.toLowerCase(), reason || ""]]);

    await sendMailjetEmail("New Waitlist Submission", `<p>${name} (${email}) joined the waitlist at ${timestamp}. Reason: ${reason || "N/A"}</p>`);

    res.json({ success: true, message: "Waitlist submission successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to submit waitlist" });
  }
});

app.post("/api/volunteer", async (req, res) => {
  try {
    const { name, email, role, availability } = req.body;
    if (!name || !email || !role) return res.status(400).json({ success: false, message: "Missing required fields" });
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });

    const spreadsheetId = process.env.VOLUNTEERS_SHEET_ID;
    const timestamp = new Date().toLocaleDateString();
    await appendSheetValues(spreadsheetId, "Volunteers!A:E", [[timestamp, name, email.toLowerCase(), role, availability || ""]]);

    await sendMailjetEmail("New Volunteer Submission", `<p>${name} (${email}) signed up as a volunteer for ${role} at ${timestamp}. Availability: ${availability || "N/A"}</p>`);

    res.json({ success: true, message: "Volunteer submission successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to submit volunteer" });
  }
});

app.post("/api/street-team", async (req, res) => {
  try {
    const { name, email, city, hoursAvailable } = req.body;
    if (!name || !email || !city) return res.status(400).json({ success: false, message: "Missing required fields" });
    if (!sheets) return res.status(500).json({ success: false, message: "Sheets not initialized" });

    const spreadsheetId = process.env.STREET_TEAM_SHEET_ID;
    const timestamp = new Date().toLocaleString();
    await appendSheetValues(spreadsheetId, "StreetTeam!A:E", [[timestamp, name, email.toLowerCase(), city, hoursAvailable || ""]]);

    await sendMailjetEmail("New Street Team Submission", `<p>${name} (${email}) signed up for the street team in ${city} at ${timestamp}. Hours: ${hoursAvailable || "N/A"}</p>`);

    res.json({ success: true, message: "Street team submission successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to submit street team" });
  }
});

// -------------------- ID VERIFICATION --------------------
app.post("/api/verify-id", upload.single("idImage"), async (req, res) => {
  try {
    const user = req.session?.user;
    if (!user) return res.status(401).json({ success: false, message: "Sign in required" });
    if (!req.file) return res.status(400).json({ success: false, message: "No ID uploaded" });

    let imageUrl = "";
    if (req.file) {
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder: "joyfund/ids" }, (err, result) => {
          if (err) reject(err); else resolve(result);
        });
        stream.end(req.file.buffer);
      });
      imageUrl = uploadResult.secure_url;
    }

    const spreadsheetId = process.env.ID_VERIFICATION_SHEET_ID;
    const timestamp = new Date().toLocaleString();

    // append to ID_Verifications sheet with correct columns (A:E). We append: TimeStamp, Email, Name, Status, ID Photo URL
    await appendSheetValues(spreadsheetId, VERIFICATIONS_RANGE, [[timestamp, user.email.toLowerCase(), user.name || "", "Pending", imageUrl]]);

    await sendMailjetEmail("New ID Submission", `<p>${user.name} (${user.email}) submitted an ID at ${timestamp}. <a href="${imageUrl}">View ID</a></p>`);

    res.json({ success: true, message: "ID uploaded successfully", imageUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to upload ID" });
  }
});

// -------------------- PASSWORD RESET --------------------
app.post("/api/reset-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email required" });

    const user = await getUserFromDB(email);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = await bcrypt.hash(resetToken, 10);

    const spreadsheetId = process.env.USERS_SHEET_ID;
    // Using USERS_RANGE; update or append adds token as a 5th column
    await findRowAndUpdateOrAppend(spreadsheetId, USERS_RANGE, 2, email, [user.joinDate, user.name, user.email, user.passwordHash, hashedToken]);

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;

    await sendMailjetEmail("Password Reset", `<p>Hello ${user.name},</p><p>Click here to reset your password: <a href="${resetUrl}">${resetUrl}</a></p>`);

    res.json({ success: true, message: "Password reset email sent" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to send password reset email" });
  }
});

// -------------------- START SERVER --------------------
app.listen(PORT, () => {
  console.log(`JoyFund Backend running on port ${PORT}`);
});
