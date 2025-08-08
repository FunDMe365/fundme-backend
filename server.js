const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// ✅ SIGNUP Route
app.post('/signup', (req, res) => {
  const { fullname, email, password } = req.body;

  // TODO: Save the user in your database here
  console.log(`New signup: ${fullname} (${email})`);

  // Example simple success response
  return res.status(201).json({ message: 'Signup successful' });
});

// ✅ SIGNIN Route
app.post('/signin', (req, res) => {
  const { email, password } = req.body;

  // TODO: Check user credentials in your database
  console.log(`Login attempt: ${email}`);

  // Example: Pretend credentials are always valid
  if (email && password) {
    return res.status(200).json({ message: 'Login successful' });
  } else {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
