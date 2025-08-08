// server.js
const db = require('./db'); // Import SQLite database instance
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
require('dotenv').config();
const sgMail = require('@sendgrid/mail');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }, // true if using HTTPS in prod
app.use(cors());
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'super-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }, // Set to true if using HTTPS in production
}));

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Temporary in-memory waitlist
const waitlist = [];

// Get current waitlist count
app.get('/api/waitlist/live', (req, res) => {
  const countRow = db.prepare('SELECT COUNT(*) AS count FROM waitlist').get();
  res.json({ count: countRow.count });
});

// Add to waitlist + send email notification
app.post('/api/waitlist', async (req, res) => {
  const { name, email, reason } = req.body;

  if (!name || !email || !reason) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // Check if email already exists in the database
  const exists = db.prepare('SELECT 1 FROM waitlist WHERE LOWER(email) = LOWER(?)').get(email);
  // Check if email is already on the waitlist
  const exists = waitlist.find(item => item.email.toLowerCase() === email.toLowerCase());
  if (exists) {
    return res.status(400).json({ error: 'Email already on waitlist.' });
  }

  // Prepare email notification
  const msg = {
    to: process.env.NOTIFY_EMAIL,
    from: process.env.VERIFIED_SENDER,

  // Prepare email message
  const msg = {
    to: process.env.NOTIFY_EMAIL,
    from: process.env.VERIFIED_SENDER, // Must be a verified sender in SendGrid
    subject: 'New Waitlist Signup',
    text: `New waitlist signup:\n\nName: ${name}\nEmail: ${email}\nReason: ${reason}`,
    html: `<p>New waitlist signup:</p>
           <ul>
             <li><strong>Name:</strong> ${name}</li>
             <li><strong>Email:</strong> ${email}</li>
             <li><strong>Reason:</strong> ${reason}</li>
           </ul>`,
  };

  try {
    await sgMail.send(msg);

    // Save to database after successful email
    db.prepare('INSERT INTO waitlist (name, email, reason, joinedAt) VALUES (?, ?, ?, ?)').run(
      name,
      email,
      reason,
      new Date().toISOString()
    );

    waitlist.push({ name, email, reason, joinedAt: new Date() });
    res.status(200).json({ success: true, message: 'Signup successful and email sent!' });
  } catch (error) {
    console.error('SendGrid Error:', error.response ? error.response.body : error.message);
    res.status(500).json({ success: false, message: 'Signup failed: could not send email.' });
  }
});


// Pretend signin (just for example)
app.post('/signin', (req, res) => {
  const { email, password } = req.body;
  console.log(`Login attempt: ${email}`);

  if (email && password) {
    req.session.user = { email };
    return res.status(200).json({ message: 'Login successful' });
  } else {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
});

// Protected dashboard route
app.get('/dashboard-data', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ message: 'Not logged in' });
  }
  res.json({ fullname: req.session.user.fullname || req.session.user.email });
});

// Logout route
app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
