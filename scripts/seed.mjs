// Loads db/seed/*.sql (reference data like the SOC 2 controls catalog)
// using the admin connection, since app_user only has SELECT on `controls`.
import "dotenv/config";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedDir = path.join(__dirname, "..", "db", "seed");

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  console.error("DATABASE_ADMIN_URL is not set (see .env.example).");
  process.exit(1);
}

const client = new pg.Client({ connectionString: adminUrl });

const files = readdirSync(seedDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

await client.connect();
try {
  for (const file of files) {
    const sql = readFileSync(path.join(seedDir, file), "utf8");
    console.log(`Seeding ${file}...`);
    await client.query(sql);
  }
  console.log("Seed complete.");
} finally {
  await client.end();
}
