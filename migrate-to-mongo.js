// migrate-to-mongo.js
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const { MongoClient } = require("mongodb");

// --- MongoDB connection ---
const uri = "mongodb+srv://fundasmile:fundasmile@joyfund.gvihjsw.mongodb.net/?retryWrites=true&w=majority";
const client = new MongoClient(uri);

const folder = path.join(__dirname, "sheet_exports"); // folder where CSV files are stored

// Function to convert CSV to JSON
function csvToJson(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("end", () => resolve(results))
      .on("error", reject);
  });
}

// Main migration function
async function migrate() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");

    const db = client.db("joyfund"); // replace with your DB name

    if (!fs.existsSync(folder)) {
      console.log("⚠️ No CSV folder found. Exiting.");
      return;
    }

    const files = fs.readdirSync(folder).filter(f => f.endsWith(".csv"));
    if (files.length === 0) {
      console.log("⚠️ No CSV files found. Exiting.");
      return;
    }

    for (const file of files) {
      const collectionName = file.replace(".csv", ""); // use file name as collection name
      const filePath = path.join(folder, file);

      try {
        const data = await csvToJson(filePath);

        if (data.length === 0) {
          console.log(`⚠️ ${file} is empty, skipping`);
          continue;
        }

        const collection = db.collection(collectionName);
        await collection.insertMany(data);
        console.log(`✅ ${file} migrated to collection: ${collectionName}`);
      } catch (err) {
        console.error(`❌ Error migrating ${file}:`, err);
      }
    }

    console.log("\n🎉 Migration complete!");
  } catch (err) {
    console.error("MongoDB connection error:", err);
  } finally {
    await client.close();
    console.log("🔒 Connection closed");
  }
}

// Run the migration
migrate();
