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

  // Validate fields
  if (!name || !email || !reason) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // Prevent duplicate signups
  const exists = waitlist.find(item => item.email.toLowerCase() === email.toLowerCase());
  if (exists) {
    return res.status(400).json({ error: 'Email already on waitlist.' });
  }

  // Add user to waitlist
  waitlist.push({ name, email, reason, joinedAt: new Date() });

  // Prepare email
  const msg = {
    to: process.env.NOTIFY_EMAIL, // recipient of notification
    from: process.env.VERIFIED_SENDER, // must match a verified SendGrid sender
    subject: 'New Waitlist Signup',
    text: `Name: ${name}\nEmail: ${email}\nReason: ${reason}`,
    html: `<p>New waitlist signup:</p>
           <ul>
             <li><strong>Name:</strong> ${name}</li>
             <li><strong>Email:</strong> ${email}</li>
             <li><strong>Reason:</strong> ${reason}</li>
           </ul>`
  };

  try {
    await sgMail.send(msg);
    res.status(200).json({ success: true, message: 'Signup successful and email sent!' });
  } catch (error) {
    console.error('SendGrid Error:', error.response ? error.response.body : error.message);
    res.status(500).json({ success: false, message: 'Signup saved but email failed to send.' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
