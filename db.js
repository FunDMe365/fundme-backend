const Database = require('better-sqlite3');
const db = new Database('waitlist.db'); // Creates or opens this file

// Create table if not exists
db.prepare(`
  CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL,
    joinedAt TEXT NOT NULL
  )
`).run();

module.exports = db;
