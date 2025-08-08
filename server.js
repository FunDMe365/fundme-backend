const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from your frontend domain with credentials (for session/cookies if needed)
app.use(cors({
  origin: 'https://fundasmile.net', // Make sure this matches your frontend URL exactly
  credentials: true,
}));

app.use(bodyParser.json());

// Session setup - adjust secure flag for production
app.use(session({
  secret: process.env.SESSION_SECRET || 'super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // true in production (HTTPS), false in dev
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24, // 1 day
  },
}));

// --- USER AUTH ROUTES (signup/signin) ---

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ message: 'Not logged in' });
  }
  next();
}

app.post('/signup', (req, res) => {
  const { fullname, email, password } = req.body;
  console.log(`New signup: ${fullname} (${email})`);

  // TODO: Add actual user creation & password hashing

  req.session.user = { fullname, email };
  res.status(201).json({ message: 'Signup successful' });
});

app.post('/signin', (req, res) => {
  const { email, password } = req.body;
  console.log(`Login attempt: ${email}`);

  // TODO: Add actual credential verification

  if (email && password) {
    req.session.user = { email };
    res.status(200).json({ message: 'Login successful' });
  } else {
    res.status(401).json({ message: 'Invalid credentials' });
  }
});

app.get('/dashboard-data', requireAuth, (req, res) => {
  res.json({ fullname: req.session.user.fullname || req.session.user.email });
});

app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ message: 'Logout failed' });
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out' });
  });
});

// --- WAITLIST ROUTES ---

const waitlist = [];

// Get current waitlist count
app.get('/api/waitlist/live', (req, res) => {
  res.json({ count: waitlist.length });
});

// Add a new person to the waitlist
app.post('/api/waitlist', (req, res) => {
  const { name, email, reason } = req.body;

  if (!name || !email || !reason) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // Check if email is already on the waitlist (case-insensitive)
  const exists = waitlist.find(item => item.email.toLowerCase() === email.toLowerCase());
  if (exists) {
    return res.status(400).json({ error: 'Email already on waitlist.' });
  }

  waitlist.push({ name, email, reason, joinedAt: new Date() });
  res.json({ message: 'Successfully joined the waitlist!' });
});

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
