// db.js
const mongoose = require('mongoose');

// Grab the URI from Render environment variable
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error("❌ MONGODB_URI is not set in environment variables!");
    process.exit(1);
}

mongoose.set('strictQuery', true); // optional, prevents warnings in newer versions

mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log("✅ MongoDB connected"))
.catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1); // stop server if DB fails
});

module.exports = mongoose; // export to use elsewhere in your backend