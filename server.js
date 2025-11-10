require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const Stripe = require('stripe');
const cors = require('cors');
const multer = require('multer');
const Mailjet = require('node-mailjet');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// ==================== MIDDLEWARE ====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'supersecret',
    resave: false,
    saveUninitialized: false,
  })
);

// ==================== MAILJET SETUP ====================
const mj = Mailjet.apiConnect(
  process.env.MJ_APIKEY_PUBLIC,
  process.env.MJ_APIKEY_PRIVATE
);

async function sendWaitlistEmail({ name, email, source, reason }) {
  try {
    const request = await mj.post('send', { version: 'v3.1' }).request({
      Messages: [
        {
          From: {
            Email: 'noreply@joyfund.net',
            Name: 'JoyFund INC.'
          },
          To: [
            { Email: 'team@joyfund.net', Name: 'JoyFund Team' }
          ],
          Subject: 'New Waitlist Signup',
          TextPart: `Name: ${name}\nEmail: ${email}\nSource: ${source}\nReason: ${reason}`,
          HTMLPart: `<h3>New Waitlist Signup</h3>
                     <p><strong>Name:</strong> ${name}</p>
                     <p><strong>Email:</strong> ${email}</p>
                     <p><strong>Source:</strong> ${source}</p>
                     <p><strong>Reason:</strong> ${reason}</p>`
        }
      ]
    });
    console.log('Waitlist email sent:', request.body);
    return true;
  } catch (err) {
    console.error('Mailjet sendWaitlistEmail error:', err);
    return false;
  }
}

// ==================== STRIPE SETUP ====================
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ==================== MULTER SETUP ====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${file.fieldname}${ext}`);
  }
});
const upload = multer({ storage });

// ==================== ROUTES ====================

// ---------- CHECK SESSION ----------
app.get('/api/check-session', (req, res) => {
  const loggedIn = !!req.session.user;
  res.json({ loggedIn, user: req.session.user || null });
});

// ---------- LOGOUT ----------
app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ success: false });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// ---------- WAITLIST ----------
app.post('/api/waitlist', async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email) return res.status(400).json({ success: false, message: 'Missing fields' });

  // Here, you can optionally save to DB or Google Sheets

  res.json({ success: true });
});

app.post('/api/send-waitlist-email', async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email) return res.status(400).json({ success: false, message: 'Missing fields' });

  const success = await sendWaitlistEmail({ name, email, source, reason });
  if (success) return res.json({ success: true });
  return res.status(500).json({ success: false, message: 'Failed to send email' });
});

// ---------- DONATIONS ----------
app.post('/api/donations', async (req, res) => {
  const { campaignId, amount } = req.body;
  if (!campaignId || !amount) return res.status(400).json({ success: false });

  // Save donation to DB if needed
  res.json({ success: true });
});

app.post('/api/create-checkout-session/:campaignId', async (req, res) => {
  const { campaignId } = req.params;
  const { amount, successUrl, cancelUrl } = req.body;
  if (!campaignId || !amount) return res.status(400).json({ error: 'Missing fields' });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `Donation - ${campaignId}` },
          unit_amount: Math.round(amount * 100)
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl
    });

    res.json({ sessionId: session.id });
  } catch (err) {
    console.error('Stripe create-checkout-session error:', err);
    res.status(500).json({ error: 'Failed to create Stripe session' });
  }
});

// ---------- STATIC FILES ----------
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
