const mongoose = require('mongoose');

const waitlistSchema = new mongoose.Schema({
  name: String,
  email: { type: String, required: true },
  joinedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Waitlist', waitlistSchema);
