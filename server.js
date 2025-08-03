const express = require('express');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

    
    app.post('/api/waitlist', async (req, res) => {
  const { name, email, reason } = req.body;

  if (!name || !email || !reason) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,     // your Gmail (same as verification email)
      pass: process.env.GMAIL_PASS      // your App Password
    }
  });

  const mailOptions = {
    from: process.env.GMAIL_USER,
    to: process.env.GMAIL_USER, // Send to yourself
    subject: 'New Campaign Waitlist Signup',
    text: `Name: ${name}\nEmail: ${email}\nReason: ${reason}`
  };

  try {
    await transporter.sendMail(mailOptions);
    res.json({ success: true, message: 'Waitlist request received.' });
  } catch (error) {
    console.error('Waitlist email error:', error);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});
    const fs = require('fs'); // Only add this ONCE at the top if it's not already there

app.post('/join-waitlist', (req, res) => {
  const { name, email, idea } = req.body;
  const entry = { name, email, idea, date: new Date().toISOString() };

  fs.appendFile('waitlist.json', JSON.stringify(entry) + ',\n', (err) => {
    if (err) {
      console.error('Error saving waitlist entry:', err);
      return res.status(500).send('Failed to save');
    }
    res.send('Success');
  });
});

app.post('/send-verification', async (req, res) => {
  const { email } = req.body;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'verify.fundasmile365@gmail.com',
      pass: 'opmxqmfxbxlryayb' // Not your normal password!
    }
  });

  const mailOptions = {
    from: 'FunDMe <YOUR_EMAIL@gmail.com>',
    to: email,
    subject: 'Please verify your email address',
    text: `Hi there, please verify your email by clicking the link below:\n\nhttp://localhost:5500/verify-email.html`
  };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).send({ message: 'Verification email sent!' });
  } catch (err) {
    res.status(500).send({ message: 'Failed to send email', error: err });
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
