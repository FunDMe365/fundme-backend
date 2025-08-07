const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: 'https://fundasmile.net',
  methods: ['GET', 'POST'],
}));

app.use(bodyParser.json());

// ✅ Clean and validate email env
const EMAIL_USER = process.env.EMAIL_USER?.trim();
const EMAIL_PASS = process.env.EMAIL_PASS?.trim();

if (!EMAIL_USER || !EMAIL_PASS) {
  console.error('❌ Missing EMAIL_USER or EMAIL_PASS in .env file');
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

app.post('/api/waitlist', (req, res) => {
  console.log('➡ Received waitlist POST:', req.body);

  const { name, email, reason } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  const entry = {
    name,
    email,
    reason: reason || '',
    date: new Date().toISOString(),
  };

  try {
    const data = fs.existsSync('waitlist.json') ? fs.readFileSync('waitlist.json', 'utf8') : '[]';
    const list = JSON.parse(data);
    list.push(entry);
    fs.writeFileSync('waitlist.json', JSON.stringify(list, null, 2));
    console.log('✨ New entry saved:', entry);

    // ✅ Send email notification
    const mailOptions = {
      from: `"FunDMe Waitlist" <${EMAIL_USER}>`,
      to: EMAIL_USER,
      subject: 'New Waitlist Submission',
      text: `Name: ${name}\nEmail: ${email}\nReason: ${reason || 'N/A'}\nDate: ${entry.date}`,
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error('❌ Email send error:', error);
      } else {
        console.log('📬 Email sent:', info.response);
      }
    });

    return res.status(200).json({ message: 'Waitlist entry saved!' });
  } catch (err) {
    console.error('❌ Error saving entry:', err);
    return res.status(500).json({ error: 'Server error saving entry.' });
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
