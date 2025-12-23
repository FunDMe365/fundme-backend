// merge_waitlist.js
require("dotenv").config();
const { MongoClient } = require("mongodb");
const crypto = require("crypto");

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || "joyfund";
const CANONICAL = "waitlist"; // <- the ONE collection to keep

function makeKey(doc) {
  // create a stable dedupe key from common fields
  const raw = [
    (doc.email || doc.Email || "").toString().trim().toLowerCase(),
    (doc.name || doc.Name || "").toString().trim().toLowerCase(),
    (doc.reason || doc.Reason || "").toString().trim().toLowerCase(),
    doc.createdAt ? new Date(doc.createdAt).toISOString() : "",
    doc.CreatedAt ? new Date(doc.CreatedAt).toISOString() : ""
  ].join("|");

  return crypto.createHash("sha1").update(raw).digest("hex");
}

(async () => {
  if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI in .env");
    process.exit(1);
  }

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  const collections = await db.listCollections().toArray();
  const waitlistLike = collections
    .map(c => c.name)
    .filter(name => name.toLowerCase().includes("waitlist"));

  console.log("🔎 Found waitlist-like collections:", waitlistLike);

  if (!waitlistLike.length) {
    console.log("Nothing to merge. Exiting.");
    await client.close();
    return;
  }

  // Ensure canonical exists
  const canonicalCol = db.collection(CANONICAL);

  // Add a unique index for dedupe keys (safe: only affects canonical)
  await canonicalCol.createIndex({ _dedupeKey: 1 }, { unique: true });

  let totalInserted = 0;

  for (const colName of waitlistLike) {
    const col = db.collection(colName);

    // Skip canonical if it already exists in the list
    if (colName === CANONICAL) continue;

    const docs = await col.find({}).toArray();
    if (!docs.length) {
      console.log(`ℹ️ ${colName}: 0 docs`);
      continue;
    }

    const ops = docs.map(d => {
      const normalized = {
        name: d.name ?? d.Name ?? null,
        email: (d.email ?? d.Email ?? null)?.toString().trim().toLowerCase() ?? null,
        reason: d.reason ?? d.Reason ?? null,
        createdAt: d.createdAt ?? d.CreatedAt ?? new Date()
      };

      const key = makeKey(normalized);

      return {
        updateOne: {
          filter: { _dedupeKey: key },
          update: { $setOnInsert: { ...normalized, _dedupeKey: key, _sourceCollection: colName } },
          upsert: true
        }
      };
    });

    const result = await canonicalCol.bulkWrite(ops, { ordered: false });
    totalInserted += (result.upsertedCount || 0);

    console.log(`✅ Merged from ${colName}: upserted ${result.upsertedCount || 0} (from ${docs.length} docs)`);
  }

  // Report canonical count
  const finalCount = await canonicalCol.countDocuments({});
  console.log("🎉 Done. Total newly inserted into canonical:", totalInserted);
  console.log("📌 Canonical collection:", CANONICAL, "count:", finalCount);

  await client.close();
})().catch(err => {
  console.error("❌ Merge failed:", err);
  process.exit(1);
});
