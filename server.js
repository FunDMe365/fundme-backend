const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: 'https://fundasmile.net', // your frontend domain
  credentials: true
}));
app.use(bodyParser.json());

app.use(session({
  secret: 'super-secret-key', // change this to something long/random
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // secure: true if using HTTPS only
}));

 HEAD
// ✅ SIGNUP (pretend create account)
app.post('/signup', (req, res) => {
  const { fullname, email, password } = req.body;
  console.log(`New signup: ${fullname} (${email})`);
  
  // Store user session
  req.session.user = { fullname, email };
  
  return res.status(201).json({ message: 'Signup successful' });
});

// ✅ SIGNIN (pretend login)
app.post('/signin', (req, res) => {
  const { email, password } = req.body;
  console.log(`Login attempt: ${email}`);

  // Pretend check credentials
  if (email && password) {
    req.session.user = { email };
    return res.status(200).json({ message: 'Login successful' });
  } else {
    return res.status(401).j

// === Live waitlist count from Google Sheets ===
// === Live waitlist count from local file ===
app.get('/api/waitlist/live', (req, res) => {
  fs.readFile('waitlist.json', 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading waitlist.json:', err);
      return res.status(500).json({ error: 'Failed to fetch waitlist count.' });
    }

    try {
      const waitlist = JSON.parse(data);
      const count = Array.isArray(waitlist) ? waitlist.length : 0;
      res.json({ count });
    } catch (parseError) {
      console.error('Error parsing waitlist.json:', parseError);
      res.status(500).json({ error: 'Failed to parse waitlist.' });
    }
  });
});


// === ...rest of your routes like /api/waitlist, /send-verification, etc ===

// === Start server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
