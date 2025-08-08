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

app.listen(PORT, () => console.log(`Server running on backend`));


