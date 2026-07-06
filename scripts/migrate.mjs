// Applies db/migrations/*.sql in order, using an admin/owner connection
// (DATABASE_ADMIN_URL) -- never the least-privilege app_user connection
// (DATABASE_URL), since these scripts create roles, RLS policies, and grants
// that app_user must not be able to alter.
import "dotenv/config";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "db", "migrations");

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  console.error("DATABASE_ADMIN_URL is not set (see .env.example).");
  process.exit(1);
}

const client = new pg.Client({ connectionString: adminUrl });

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

await client.connect();
try {
  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    console.log(`Applying ${file}...`);
    await client.query(sql);
  }
  console.log("Migrations applied.");
} finally {
  await client.end();
}
