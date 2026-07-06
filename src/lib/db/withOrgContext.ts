import type { Pool, PoolClient } from "pg";
import { pgPool } from "./pool";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error("withOrgContext: orgId is not a valid UUID");
  }
}

/**
 * Runs `fn` inside a Postgres transaction with `app.current_org_id` set for
 * that transaction only. Every RLS policy in the schema keys off this value
 * via current_setting('app.current_org_id', true) -- see db/migrations.
 *
 * Why this is safe under connection pooling (PgBouncer / Supabase pooler in
 * transaction mode, and our own app-level pg.Pool):
 *
 * - We check out a single PoolClient and hold it for the entire
 *   BEGIN..COMMIT/ROLLBACK block. No other request can interleave queries on
 *   this same physical connection while we hold it.
 * - We use `set_config('app.current_org_id', $1, true)` -- the third
 *   argument `true` makes it transaction-local, i.e. equivalent to
 *   `SET LOCAL`. This is guaranteed by Postgres to be discarded at COMMIT or
 *   ROLLBACK, regardless of what happens to the underlying connection
 *   afterwards.
 * - We NEVER use a bare `SET app.current_org_id = ...` (session-level) --
 *   that would persist on the physical connection and could leak to
 *   whichever tenant's request the pool hands that connection to next.
 * - `set_config` is a normal function call that accepts a bound parameter,
 *   so orgId is never string-interpolated into SQL (no injection surface),
 *   unlike `SET LOCAL app.current_org_id = '${orgId}'` which would require
 *   manual escaping.
 * - orgId must always come from server-side session resolution (see
 *   src/lib/auth/orgContext.ts), never from a client-supplied body/query
 *   param, so this function is the single place tenant isolation is
 *   enforced at the data layer.
 *
 * See tests/rls-pooling.test.ts for an automated test that hammers a small
 * pool with interleaved calls for two different orgs and asserts no
 * cross-tenant leakage.
 */
export async function withOrgContext<T>(
  orgId: string,
  fn: (client: PoolClient) => Promise<T>,
  pool: Pool = pgPool
): Promise<T> {
  assertValidUuid(orgId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Connection may already be broken; pool will discard it on release.
    });
    throw err;
  } finally {
    client.release();
  }
}
