const express = require('express');
const router = express.Router();
const { sendVerificationEmail } = require('../controllers/emailController');

router.post('/verify-email', sendVerificationEmail);

module.exports = router;