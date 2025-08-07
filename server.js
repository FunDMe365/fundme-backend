const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Enable CORS to allow your frontend (Netlify domain)
app.use(cors({
  origin: 'https://fundasmile.netlify.app',
  methods: ['GET', 'POST'],
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Your GET for live count (keep unchanged)
app.get('/api/waitlist/live', (req, res) => {
  // existing logic...
});

// 2. POST route with logging
app.post('/api/waitlist', (req, res) => {
  console.log('➡ Received waitlist POST:', req.body); // <-- Logs incoming submission

  const { name, email, reason } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  const entry = { name, email, reason: reason || '', date: new Date().toISOString() };
  try {
    const data = fs.existsSync('waitlist.json') ? fs.readFileSync('waitlist.json', 'utf8') : '[]';
    const list = JSON.parse(data);
    list.push(entry);
    fs.writeFileSync('waitlist.json', JSON.stringify(list, null, 2));
    console.log('✨ New entry saved:', entry);
    return res.status(200).json({ message: 'Waitlist entry saved!' });
  } catch (err) {
    console.error('❌ Error saving entry:', err);
    return res.status(500).json({ error: 'Server error saving entry.' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// === Start Server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
