const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
const nodemailer = require('nodemailer');  // <-- Added here
require('dotenv').config();

require('dotenv').config();

console.log('SMTP_HOST:', process.env.SMTP_HOST);
console.log('SMTP_PORT:', process.env.SMTP_PORT);
console.log('SMTP_SECURE:', process.env.SMTP_SECURE);
console.log('SMTP_USER:', process.env.SMTP_USER);


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

// Create Nodemailer transporter (update with your SMTP info in .env)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true', // convert string to boolean
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Get current waitlist count
app.get('/api/waitlist/live', (req, res) => {
  res.json({ count: waitlist.length });
});

// Add a new person to the waitlist
app.post('/api/waitlist', async (req, res) => {
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

  // Send notification email to your admin/support email
  try {
    await transporter.sendMail({
      from: `"FunDMe Waitlist" <${process.env.SMTP_USER}>`, // sender address
      to: process.env.NOTIFY_EMAIL, // your notification email address
      subject: "New Waitlist Signup",
      text: `New waitlist signup:\n\nName: ${name}\nEmail: ${email}\nReason: ${reason}`,
      html: `<p>New waitlist signup:</p>
             <ul>
               <li><strong>Name:</strong> ${name}</li>
               <li><strong>Email:</strong> ${email}</li>
               <li><strong>Reason:</strong> ${reason}</li>
             </ul>`
    });
  } catch (error) {
    console.error('Error sending notification email:', error);
    // You can decide if you want to fail the request or still succeed:
    // return res.status(500).json({ error: 'Failed to send notification email.' });
    // Here, we let it succeed but log the error
  }

res.json({ message: 'Successfully joined the waitlist!' });
});


// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

