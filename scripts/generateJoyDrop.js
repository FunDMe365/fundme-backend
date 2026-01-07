// scripts/generateJoyDrop.js
require("dotenv").config();
const { Pool } = require("pg");

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();

if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL. Set it in Render env vars.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildJoyDrop() {
  const titles = [
    "A tiny reset for today 💙",
    "You made it to this moment",
    "A gentle 60-second JoyDrop",
    "Small joy counts",
    "One breath, one step"
  ];

  const openers = [
    "If today feels heavy, you don’t have to fix everything at once.",
    "This is your reminder: you’re allowed to pause.",
    "You’re not behind — you’re human.",
    "Even a small win is still a win.",
    "You’ve carried a lot. Let’s lighten it by 1%."
  ];

  const middles = [
    "Put one hand on your chest and take one slow breath in, then out.",
    "Unclench your jaw. Drop your shoulders. Let your exhale be longer than your inhale.",
    "Look around and name 3 things you can see. 2 things you can hear. 1 thing you can feel.",
    "Text someone you trust one sentence: “Thinking of you today.”",
    "Do the smallest helpful thing for Future You (fill your water, clear one spot, or set one reminder)."
  ];

  const closers = [
    "That’s it. That counts.",
    "No pressure. Just presence.",
    "You can come back to this anytime.",
    "Proud of you for taking a moment.",
    "Tiny steps still move you forward."
  ];

  const microActions = [
    "Drink a glass of water.",
    "Step outside for 60 seconds.",
    "Send one kind text.",
    "Write one sentence: “Right now, I need ___.”",
    "Put your phone down for 2 minutes and breathe."
  ];

  const title = pick(titles);
  const body = `${pick(openers)}\n\n${pick(middles)}\n\n${pick(closers)}`;
  const micro_action = pick(microActions);

  return { title, body, micro_action };
}

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS joydrops (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      micro_action TEXT DEFAULT ''
    );
  `);
}

async function run() {
  await ensureTable();

  const { title, body, micro_action } = buildJoyDrop();

  await pool.query(
    `INSERT INTO joydrops (title, body, micro_action) VALUES ($1, $2, $3)`,
    [title, body, micro_action]
  );

  console.log("✅ JoyDrop generated and saved:", title);
  await pool.end();
}

run().catch(async (err) => {
  console.error("❌ JoyDrop generator failed:", err);
  try { await pool.end(); } catch {}
  process.exit(1);
});