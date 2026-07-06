import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "crypto";
import { withOrgContext } from "@/lib/db/withOrgContext";

/**
 * Proves that tenant isolation holds even when the app-level connection
 * pool is small and connections are aggressively reused across different
 * orgs' requests -- the exact scenario where a bug (e.g. session-level SET
 * instead of transaction-local set_config) would leak one tenant's context
 * into another tenant's query.
 *
 * Requires a real Postgres with the schema from db/migrations applied and
 * an app_user role configured, e.g. a local Supabase/postgres instance:
 *
 *   TEST_ADMIN_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
 *   TEST_DATABASE_URL=postgres://app_user:<pw>@localhost:5432/postgres \
 *   npm run test
 *
 * Skips (rather than fails) locally if those env vars aren't set, since a
 * dev machine may not have a database provisioned. In CI (process.env.CI is
 * set by GitHub Actions), a missing DB config is treated as a hard failure
 * instead -- this test exists specifically to catch regressions, so it must
 * never be able to silently go green by skipping itself.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL;
const APP_URL = process.env.TEST_DATABASE_URL;
const shouldRun = Boolean(ADMIN_URL && APP_URL);

if (process.env.CI && !shouldRun) {
  throw new Error(
    "TEST_ADMIN_DATABASE_URL/TEST_DATABASE_URL must be set in CI -- refusing to silently skip the RLS isolation test."
  );
}

describe.runIf(shouldRun)("RLS isolation under connection pooling", () => {
  let adminPool: Pool;
  // Deliberately tiny pool so concurrent requests for different orgs are
  // forced to reuse the same physical connections.
  let smallAppPool: Pool;

  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;
  let controlId: string;

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: ADMIN_URL });
    smallAppPool = new Pool({ connectionString: APP_URL, max: 2 });

    const { rows: controlRows } = await adminPool.query(
      "select id from controls limit 1"
    );
    controlId = controlRows[0].id;

    orgA = randomUUID();
    orgB = randomUUID();
    userA = randomUUID();
    userB = randomUUID();

    await adminPool.query(
      "insert into organizations (id, name) values ($1, 'Org A Test'), ($2, 'Org B Test')",
      [orgA, orgB]
    );
    await adminPool.query(
      `insert into users (id, org_id, clerk_user_id, email, role)
       values ($1, $2, $3, 'a@test.local', 'admin'), ($4, $5, $6, 'b@test.local', 'admin')`,
      [userA, orgA, `clerk_${userA}`, userB, orgB, `clerk_${userB}`]
    );

    const { rows: ocA } = await adminPool.query(
      "insert into org_controls (org_id, control_id) values ($1, $2) returning id",
      [orgA, controlId]
    );
    const { rows: ocB } = await adminPool.query(
      "insert into org_controls (org_id, control_id) values ($1, $2) returning id",
      [orgB, controlId]
    );

    await adminPool.query(
      `insert into evidence (org_id, org_control_id, uploaded_by, type, description)
       values ($1, $2, $3, 'text_note', 'SECRET-A')`,
      [orgA, ocA[0].id, userA]
    );
    await adminPool.query(
      `insert into evidence (org_id, org_control_id, uploaded_by, type, description)
       values ($1, $2, $3, 'text_note', 'SECRET-B')`,
      [orgB, ocB[0].id, userB]
    );
  });

  afterAll(async () => {
    await adminPool.query("delete from evidence where org_id in ($1, $2)", [orgA, orgB]);
    await adminPool.query("delete from org_controls where org_id in ($1, $2)", [orgA, orgB]);
    await adminPool.query("delete from users where org_id in ($1, $2)", [orgA, orgB]);
    await adminPool.query("delete from organizations where id in ($1, $2)", [orgA, orgB]);
    await adminPool.end();
    await smallAppPool.end();
  });

  it("never leaks org B's evidence into an org A query, or vice versa, under heavy connection reuse", async () => {
    const readEvidenceDescriptions = (orgId: string) =>
      withOrgContext(
        orgId,
        async (client) => {
          const { rows } = await client.query("select description from evidence");
          return rows.map((r) => r.description as string);
        },
        smallAppPool
      );

    // Fire 40 interleaved reads (alternating org A / org B) through a pool
    // of only 2 connections -- guarantees connection reuse across tenants.
    const calls: Promise<{ orgId: string; rows: string[] }>[] = [];
    for (let i = 0; i < 40; i++) {
      const orgId = i % 2 === 0 ? orgA : orgB;
      calls.push(readEvidenceDescriptions(orgId).then((rows) => ({ orgId, rows })));
    }

    const results = await Promise.all(calls);

    for (const { orgId, rows } of results) {
      if (orgId === orgA) {
        expect(rows).toEqual(["SECRET-A"]);
      } else {
        expect(rows).toEqual(["SECRET-B"]);
      }
    }
  });

  it("returns zero rows when no org context is set at all (fail closed)", async () => {
    const client = await smallAppPool.connect();
    try {
      const { rows } = await client.query("select description from evidence");
      expect(rows).toEqual([]);
    } finally {
      client.release();
    }
  });
});
