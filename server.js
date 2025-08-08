const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const session = require('express-session');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS - allow your frontend domain and credentials for cookies
app.use(cors({
  origin: 'https://fundasmile.net', // replace with your actual frontend URL
  credentials: true
}));

app.use(bodyParser.json());

// Session setup - adjust secure for your environment
app.use(session({
  secret: process.env.SESSION_SECRET || 'super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production', // true in prod (https), false in dev
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 // 1 day session
  }
}));

// Middleware to check if user is logged in
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ message: 'Not logged in' });
  }
  next();
}

// Signup route - pretend create user & start session
app.post('/signup', (req, res) => {
  const { fullname, email, password } = req.body;
  console.log(`New signup: ${fullname} (${email})`);

  // TODO: Add real user creation & password hashing here

  // Save user info in session
  req.session.user = { fullname, email };
  res.status(201).json({ message: 'Signup successful' });
});

// Signin route - pretend login & start session
app.post('/signin', (req, res) => {
  const { email, password } = req.body;
  console.log(`Login attempt: ${email}`);

  // TODO: Add real credential validation here

  if (email && password) {
    req.session.user = { email };
    res.status(200).json({ message: 'Login successful' });
  } else {
    res.status(401).json({ message: 'Invalid credentials' });
  }
});

// Protected dashboard data route
app.get('/dashboard-data', requireAuth, (req, res) => {
  res.json({ fullname: req.session.user.fullname || req.session.user.email });
});

// Logout route
app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ message: 'Logout failed' });
    res.clearCookie('connect.sid'); // clear session cookie on client
    res.json({ message: 'Logged out' });
  });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

