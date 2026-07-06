// Sets app_user's password via the admin connection. Used in CI (and can be
// used for initial local setup) so the password never has to be hardcoded
// into a .sql migration file that might get committed.
//
// ALTER ROLE ... WITH PASSWORD '<literal>' does not support bind parameters
// (it's DDL, not a DML statement pg's extended query protocol can
// parameterize) so the value is embedded as an escaped SQL string literal.
// APP_USER_PASSWORD is expected to come from a CI-generated ephemeral value
// or a secret manager -- never a hardcoded constant in source.
import "dotenv/config";
import pg from "pg";

const adminUrl = process.env.DATABASE_ADMIN_URL;
const password = process.env.APP_USER_PASSWORD;

if (!adminUrl || !password) {
  console.error("DATABASE_ADMIN_URL and APP_USER_PASSWORD must both be set.");
  process.exit(1);
}

function escapeSqlLiteral(value) {
  return value.replace(/'/g, "''");
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  await client.query(`alter role app_user with password '${escapeSqlLiteral(password)}'`);
  console.log("app_user password set.");
} finally {
  await client.end();
}
