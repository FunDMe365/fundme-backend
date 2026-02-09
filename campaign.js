const mongoose = require("./db"); // your existing connection

const campaignSchema = new mongoose.Schema({
  title: { type: String, required: true },           // campaign title
  goalAmount: { type: Number, required: true },      // funding goal
  currentAmount: { type: Number, default: 0 },       // donations received
  creatorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // who created it
  idVerified: { type: Boolean, default: false },     // has ID been verified?
  createdAt: { type: Date, default: Date.now }       // optional, track creation date
});

const Campaign = mongoose.model("Campaign", campaignSchema);

module.exports = Campaign;