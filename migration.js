require("dotenv").config();
const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = "joyfund";

async function migrateUsers() {
    const client = new MongoClient(MONGO_URI);
    try {
        await client.connect();
        const db = client.db(DB_NAME);

        const sourceCollection = db.collection("ID_Verifications");
        const targetCollection = db.collection("Users");

        const users = await sourceCollection.find({}).toArray();
        console.log(`Found ${users.length} users in ID_Verifications`);

        for (const user of users) {
            // Check if user already exists in Users collection
            const exists = await targetCollection.findOne({ email: user.email.toLowerCase() });
            if (exists) {
                console.log(`Skipping ${user.email} - already exists`);
                continue;
            }

            if (!user.password) {
                console.warn(`Skipping ${user.email} - no password field`);
                continue;
            }

            await targetCollection.insertOne({
                name: user.name,
                email: user.email.toLowerCase(),
                password: user.password, // hashed password
                joinDate: user.joinDate || user.createdAt || new Date()
            });

            console.log(`Migrated ${user.email}`);
        }

        console.log("Migration complete!");
    } catch (err) {
        console.error("Migration error:", err);
    } finally {
        await client.close();
    }
}

migrateUsers();
