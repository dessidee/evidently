import { Pool } from "pg";

// Single pooled connection to Postgres, used only by withOrgContext() below.
// Never query this pool directly for tenant-scoped tables -- that would skip
// RLS context and either see nothing (fail closed) or, if misused across
// requests, risk leaking context. Direct pool access is fine only for
// queries against non-tenant reference data (e.g. `controls`).
declare global {
  var __evidentlyPgPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Pool({
    connectionString,
    // Keep the pool small and predictable; this is exactly the scenario we
    // need withOrgContext's transaction discipline to be correct under --
    // connections WILL be reused across different tenants' requests.
    max: 10,
  });
}

function getPool(): Pool {
  if (!globalThis.__evidentlyPgPool) {
    globalThis.__evidentlyPgPool = createPool();
  }
  return globalThis.__evidentlyPgPool;
}

// Lazily initialized on first actual use (not at module-import time), so
// merely importing this module -- e.g. transitively, in a test that never
// touches the DB -- doesn't require DATABASE_URL to be set.
export const pgPool: Pool = new Proxy({} as Pool, {
  get(_target, prop) {
    const pool = getPool();
    const value = Reflect.get(pool, prop, pool);
    return typeof value === "function" ? value.bind(pool) : value;
  },
});
