// ==================== SERVER.JS - JOYFUND BACKEND ====================

const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const Stripe = require('stripe');
const cloudinary = require('cloudinary').v2;
const nodemailer = require('nodemailer');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 5000;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());

// ==================== GOOGLE SHEETS SETUP ====================
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

async function readSheet(sheetId, range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  return res.data.values || [];
}

async function appendSheet(sheetId, range, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'RAW',
    resource: { values: [values] }
  });
}

// ==================== CLOUDINARY SETUP ====================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ==================== EMAIL SETUP (Nodemailer) ====================
const transporter = nodemailer.createTransport({
  service: 'Zoho',
  auth: {
    user: process.env.ZOHO_USER,
    pass: process.env.ZOHO_APP_PASSWORD
  }
});

function sendEmail(to, subject, text) {
  const mailOptions = {
    from: process.env.EMAIL_FROM,
    to,
    subject,
    text
  };
  return transporter.sendMail(mailOptions);
}

// ==================== AUTH MIDDLEWARE ====================
function authenticateToken(req, res, next) {
  const token = req.cookies['auth_token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  });
}

// ==================== ROUTES ====================

// ----------- Users -----------
app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body;
  const users = await readSheet(process.env.USERS_SHEET_ID, 'A:C');
  if (users.some(u => u[1].toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'User already exists' });
  }
  await appendSheet(process.env.USERS_SHEET_ID, 'A:C', [name, email, password]);
  res.json({ message: 'User created' });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const users = await readSheet(process.env.USERS_SHEET_ID, 'A:C');
  const user = users.find(u => u[1].toLowerCase() === email.toLowerCase() && u[2] === password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ email: user[1], name: user[0] }, process.env.JWT_SECRET, { expiresIn: '1d' });
  res.cookie('auth_token', token, { httpOnly: true, maxAge: 24 * 3600 * 1000 });
  res.json({ message: 'Logged in', user: { name: user[0], email: user[1] } });
});

// ----------- Campaigns -----------
app.get('/api/campaigns', async (req, res) => {
  const campaigns = await readSheet(process.env.CAMPAIGNS_SHEET_ID, 'A:Z');
  res.json(campaigns);
});

app.post('/api/campaigns', authenticateToken, async (req, res) => {
  const { title, description, goal, category, image } = req.body;
  let imageUrl = '';
  if (image) {
    const uploaded = await cloudinary.uploader.upload(image);
    imageUrl = uploaded.secure_url;
  }
  await appendSheet(process.env.CAMPAIGNS_SHEET_ID, 'A:E', [title, description, goal, category, imageUrl]);
  res.json({ message: 'Campaign created' });
});

// ----------- Donations -----------
app.post('/api/donate', async (req, res) => {
  const { campaignId, amount, donorName, donorEmail } = req.body;
  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.floor(amount * 100),
    currency: 'usd',
    receipt_email: donorEmail,
    metadata: { campaignId }
  });

  await appendSheet(process.env.DONATIONS_SHEET_ID, 'A:D', [donorName, donorEmail, campaignId, amount]);
  res.json({ clientSecret: paymentIntent.client_secret });
});

// ----------- Waitlist -----------
app.post('/api/waitlist', async (req, res) => {
  const { name, email } = req.body;
  await appendSheet(process.env.WAITLIST_SHEET_ID, 'A:B', [name, email]);
  res.json({ message: 'Added to waitlist' });
});

// ----------- Volunteers -----------
app.get('/api/volunteers', async (req, res) => {
  const volunteers = await readSheet(process.env.VOLUNTEERS_SHEET_ID, 'A:Z');
  res.json(volunteers);
});

app.post('/api/volunteers', async (req, res) => {
  const { name, role, email } = req.body;
  await appendSheet(process.env.VOLUNTEERS_SHEET_ID, 'A:C', [name, role, email]);
  res.json({ message: 'Volunteer added' });
});

// ----------- Password Reset -----------
app.post('/api/password-reset', async (req, res) => {
  const { email, newPassword } = req.body;
  const sheetId = process.env.PASSWORD_RESET_SHEET_ID;
  const users = await readSheet(process.env.USERS_SHEET_ID, 'A:C');
  const index = users.findIndex(u => u[1].toLowerCase() === email.toLowerCase());
  if (index === -1) return res.status(404).json({ error: 'User not found' });

  users[index][2] = newPassword;
  await sheets.spreadsheets.values.update({ spreadsheetId: process.env.USERS_SHEET_ID, range: 'A:C', valueInputOption: 'RAW', resource: { values: users } });
  res.json({ message: 'Password updated' });
});

// ----------- ID Verification -----------
app.post('/api/verify-id', async (req, res) => {
  const { name, email, idImage } = req.body;
  let imageUrl = '';
  if (idImage) {
    const uploaded = await cloudinary.uploader.upload(idImage);
    imageUrl = uploaded.secure_url;
  }
  await appendSheet(process.env.ID_VERIFICATIONS_SHEET, 'A:C', [name, email, imageUrl]);
  res.json({ message: 'Verification submitted' });
});

// ----------- Stripe Webhook -----------
app.post('/api/stripe-webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  // Handle event types
  res.json({ received: true });
});

// ----------- Catch All / Health Check -----------
app.get('/', (req, res) => res.send('JoyFund Backend Running'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
