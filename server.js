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

// Setup nodemailer transporter
const transporter = nodemailer.createTransport({
  service: 'gmail', // or use another provider if needed
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
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

    // Send email notification
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_RECEIVER, // your email address
      subject: 'New FunDMe Waitlist Entry',
      text: `
        New person joined the waitlist!

        Name: ${name}
        Email: ${email}
        Reason: ${reason || 'Not provided'}
        Date: ${entry.date}
      `,
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
