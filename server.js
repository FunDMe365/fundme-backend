const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
require('dotenv').config();

const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

// CORS, bodyParser, session setup here (same as before)...

// --- WAITLIST ROUTES ---
const waitlist = [];

app.get('/api/waitlist/live', (req, res) => {
  res.json({ count: waitlist.length });
});

app.post('/api/waitlist', async (req, res) => {
  const { name, email, reason } = req.body;

  if (!name || !email || !reason) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const exists = waitlist.find(item => item.email.toLowerCase() === email.toLowerCase());
  if (exists) {
    return res.status(400).json({ error: 'Email already on waitlist.' });
  }

  waitlist.push({ name, email, reason, joinedAt: new Date() });

  try {
    const msg = {
      to: process.env.NOTIFY_EMAIL,
      from: process.env.NOTIFY_EMAIL, // must be verified in SendGrid
      subject: 'New Waitlist Signup',
      text: `New waitlist signup:\n\nName: ${name}\nEmail: ${email}\nReason: ${reason}`,
      html: `<p>New waitlist signup:</p>
             <ul>
               <li><strong>Name:</strong> ${name}</li>
               <li><strong>Email:</strong> ${email}</li>
               <li><strong>Reason:</strong> ${reason}</li>
             </ul>`
    };

    await sgMail.send(msg);
  } catch (error) {
    console.error('Error sending notification email:', error);
    return res.status(500).json({ error: 'Failed to send notification email.' });
  }

  res.json({ message: 'Successfully joined the waitlist!' });
});

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
