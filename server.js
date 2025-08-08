// server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();
const sgMail = require('@sendgrid/mail');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Temporary in-memory waitlist
const waitlist = [];

// Get current waitlist count
app.get('/api/waitlist/live', (req, res) => {
  res.json({ count: waitlist.length });
});

// Add to waitlist + send email notification
app.post('/api/waitlist', async (req, res) => {
  const { name, email, reason } = req.body;

  // Pretend check credentials
  if (email && password) {
    req.session.user = { email };
    return res.status(200).json({ message: 'Login successful' });
  } else {

    return res.status(401).j


// ✅ SIGNIN (pretend login)
app.post('/signin', (req, res) => {
  const { email, password } = req.body;
  console.log(`Login attempt: ${email}`);

  // Pretend check credentials
  if (email && password) {
    req.session.user = { email };
    return res.status(200).json({ message: 'Login successful' });
  } else {

    return res.status(401).json({ message: 'Invalid credentials' });
  }
});

// ✅ Protected Dashboard API
app.get('/dashboard-data', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ message: 'Not logged in' });
  }
  // Send back the fullname for display
  res.json({ fullname: req.session.user.fullname || req.session.user.email });
});


// ✅ Logout
app.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logged out' });
});

app.post('/api/waitlist', async (req, res) => {
  const { name, email, reason } = req.body;

  if (!name || !email || !reason) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // Check if email is already on the waitlist
  const exists = waitlist.find(item => item.email.toLowerCase() === email.toLowerCase());
  if (exists) {
    return res.status(400).json({ error: 'Email already on waitlist.' });
  }

  // Prepare email message
  const msg = {
    to: process.env.NOTIFY_EMAIL,
    from: process.env.VERIFIED_SENDER,
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
    // Send email first
    await sgMail.send(msg);

    // If email sent successfully, add to waitlist
    waitlist.push({ name, email, reason, joinedAt: new Date() });

    res.status(200).json({ success: true, message: 'Signup successful and email sent!' });
  } catch (error) {
    console.error('SendGrid Error:', error.response ? error.response.body : error.message);
    res.status(500).json({ success: false, message: 'Signup failed: could not send email.' });
  }
});


// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
