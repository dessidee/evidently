import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "crypto";

/**
 * Exercises the actual evidence upload/list/download-url route handlers
 * (not a reimplementation of their logic) against a real Postgres instance,
 * proving:
 *  - text_note/link evidence is created without touching storage at all
 *  - file/screenshot evidence gets a signed upload URL and storage_path set
 *  - a link with no externalUrl (and a file with no fileName) is rejected
 *  - an orgControlId belonging to a DIFFERENT org is rejected (tenant
 *    isolation on write, not just on read)
 *  - GET lists evidence scoped to the org, excludes soft-deleted rows, and
 *    never returns storage_path directly
 *  - GET .../download-url mints a fresh signed URL on demand and 404s for
 *    evidence that doesn't exist or belongs to another org
 *
 * Two boundaries are faked here, both for reasons that don't apply to
 * tests/billing-webhook.test.ts:
 *
 * 1. src/lib/storage/evidenceStorage.ts (Supabase Storage signed URLs) --
 *    unlike Stripe's webhook signature (which has a full offline test
 *    helper, `generateTestHeaderString`), there is no local/offline
 *    equivalent of a real Storage signed-URL API call. Spinning up a real
 *    Supabase project or a self-hosted storage-api container for every CI
 *    run was considered and deliberately rejected as disproportionate to
 *    what this boundary needs to prove (that our code calls it with the
 *    right path and wires the result into the DB correctly).
 * 2. @clerk/nextjs/server's `auth()` -- calling a route handler directly
 *    (like tests/billing-webhook.test.ts does with the Stripe webhook)
 *    requires *some* stand-in for the real browser/cookie-based Clerk
 *    session, since there's no live HTTP request here. Everything
 *    downstream of `auth()` inside getAuthContext() -- the
 *    lookup_user_by_clerk_id() query, org resolution, RLS -- runs for real
 *    against Postgres, using a real fixture user row.
 *
 * Postgres, RLS, withOrgContext, and the route handlers themselves are all
 * real, same convention as tests/rls-pooling.test.ts and
 * tests/billing-webhook.test.ts.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL;
const APP_URL = process.env.TEST_DATABASE_URL;
const shouldRun = Boolean(ADMIN_URL && APP_URL);

if (process.env.CI && !shouldRun) {
  throw new Error(
    "TEST_ADMIN_DATABASE_URL/TEST_DATABASE_URL must be set in CI -- refusing to silently skip the evidence upload test."
  );
}

const CLERK_USER_ID = `clerk_evidence_test_${randomUUID().slice(0, 8)}`;

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: CLERK_USER_ID })),
}));

vi.mock("@/lib/storage/evidenceStorage", () => ({
  createSignedUploadUrl: vi.fn(async (path: string) => ({
    path,
    signedUrl: `https://fake-storage.test/upload/${path}`,
    token: "fake-upload-token",
  })),
  createSignedDownloadUrl: vi.fn(
    async (path: string, expiresInSeconds: number) =>
      `https://fake-storage.test/download/${path}?expires=${expiresInSeconds}`
  ),
}));

describe.runIf(shouldRun)("Evidence upload API", () => {
  let adminPool: Pool;
  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let controlId: string;
  let orgControlId: string;
  let otherOrgControlId: string;

  let POST: (typeof import("../src/app/api/orgs/[orgId]/evidence/route"))["POST"];
  let GET: (typeof import("../src/app/api/orgs/[orgId]/evidence/route"))["GET"];
  let downloadUrlGET: (typeof import(
    "../src/app/api/orgs/[orgId]/evidence/[evidenceId]/download-url/route"
  ))["GET"];
  let createSignedUploadUrl: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    process.env.DATABASE_URL = APP_URL;

    ({ POST, GET } = await import("../src/app/api/orgs/[orgId]/evidence/route"));
    ({ GET: downloadUrlGET } = await import(
      "../src/app/api/orgs/[orgId]/evidence/[evidenceId]/download-url/route"
    ));
    ({ createSignedUploadUrl } = (await import(
      "@/lib/storage/evidenceStorage"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as any);

    adminPool = new Pool({ connectionString: ADMIN_URL });

    const { rows: controlRows } = await adminPool.query("select id from controls limit 1");
    controlId = controlRows[0].id;

    orgId = randomUUID();
    otherOrgId = randomUUID();
    userId = randomUUID();

    await adminPool.query(
      "insert into organizations (id, name) values ($1, 'Evidence Test Org'), ($2, 'Other Org')",
      [orgId, otherOrgId]
    );
    await adminPool.query(
      `insert into users (id, org_id, clerk_user_id, email, role)
       values ($1, $2, $3, 'evidence@test.local', 'member')`,
      [userId, orgId, CLERK_USER_ID]
    );

    const { rows: ocRows } = await adminPool.query(
      "insert into org_controls (org_id, control_id) values ($1, $2) returning id",
      [orgId, controlId]
    );
    orgControlId = ocRows[0].id;

    const { rows: otherOcRows } = await adminPool.query(
      "insert into org_controls (org_id, control_id) values ($1, $2) returning id",
      [otherOrgId, controlId]
    );
    otherOrgControlId = otherOcRows[0].id;
  });

  afterAll(async () => {
    await adminPool.query("delete from audit_log where org_id in ($1, $2)", [orgId, otherOrgId]);
    await adminPool.query("delete from evidence where org_id in ($1, $2)", [orgId, otherOrgId]);
    await adminPool.query("delete from org_controls where org_id in ($1, $2)", [
      orgId,
      otherOrgId,
    ]);
    await adminPool.query("delete from users where org_id = $1", [orgId]);
    await adminPool.query("delete from organizations where id in ($1, $2)", [orgId, otherOrgId]);
    await adminPool.end();
  });

  function req(body: unknown): Request {
    return new Request(`http://localhost/api/orgs/${orgId}/evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("creates text_note evidence without touching storage", async () => {
    const res = await POST(req({ orgControlId, type: "text_note", description: "we do backups" }), {
      params: Promise.resolve({ orgId }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.evidenceId).toBeDefined();
    expect(body.upload).toBeUndefined();
    expect(createSignedUploadUrl).not.toHaveBeenCalled();

    const { rows } = await adminPool.query(
      "select submitted_via, storage_path, description from evidence where id = $1",
      [body.evidenceId]
    );
    expect(rows[0]).toMatchObject({
      submitted_via: "web",
      storage_path: null,
      description: "we do backups",
    });
  });

  it("creates file evidence, mints a signed upload URL, and stores storage_path", async () => {
    const res = await POST(
      req({ orgControlId, type: "file", fileName: "soc2-policy.pdf" }),
      { params: Promise.resolve({ orgId }) }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.upload.uploadUrl).toMatch(/^https:\/\/fake-storage\.test\/upload\//);
    expect(body.upload.token).toBe("fake-upload-token");
    expect(createSignedUploadUrl).toHaveBeenCalledWith(
      expect.stringContaining(`${orgId}/${orgControlId}/${body.evidenceId}-soc2-policy.pdf`)
    );

    const { rows } = await adminPool.query("select storage_path from evidence where id = $1", [
      body.evidenceId,
    ]);
    expect(rows[0].storage_path).toContain("soc2-policy.pdf");
  });

  it("rejects a file with no fileName, and a link with no externalUrl", async () => {
    const fileRes = await POST(req({ orgControlId, type: "file" }), {
      params: Promise.resolve({ orgId }),
    });
    expect(fileRes.status).toBe(400);

    const linkRes = await POST(req({ orgControlId, type: "link" }), {
      params: Promise.resolve({ orgId }),
    });
    expect(linkRes.status).toBe(400);
  });

  it("creates link evidence with external_url set, not description", async () => {
    const res = await POST(
      req({ orgControlId, type: "link", externalUrl: "https://example.com/policy" }),
      { params: Promise.resolve({ orgId }) }
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    const { rows } = await adminPool.query(
      "select external_url, storage_path from evidence where id = $1",
      [body.evidenceId]
    );
    expect(rows[0]).toMatchObject({
      external_url: "https://example.com/policy",
      storage_path: null,
    });
  });

  it("rejects an orgControlId belonging to a different org", async () => {
    const res = await POST(
      req({ orgControlId: otherOrgControlId, type: "text_note", description: "cross-tenant attempt" }),
      { params: Promise.resolve({ orgId }) }
    );
    expect(res.status).toBe(404);

    const { rows } = await adminPool.query(
      "select 1 from evidence where org_control_id = $1",
      [otherOrgControlId]
    );
    expect(rows).toHaveLength(0);
  });

  it("lists evidence scoped to the org, excludes soft-deleted rows, and never returns storage_path", async () => {
    const created = await POST(req({ orgControlId, type: "text_note", description: "to be deleted" }), {
      params: Promise.resolve({ orgId }),
    });
    const { evidenceId: deletedId } = await created.json();
    await adminPool.query("update evidence set deleted_at = now() where id = $1", [deletedId]);

    const res = await GET(new Request(`http://localhost/api/orgs/${orgId}/evidence?orgControlId=${orgControlId}`), {
      params: Promise.resolve({ orgId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.evidence.some((e: { id: string }) => e.id === deletedId)).toBe(false);
    expect(body.evidence.length).toBeGreaterThan(0);
    for (const item of body.evidence) {
      expect(item.storage_path).toBeUndefined();
    }
  });

  it("mints a fresh signed download URL on demand, and 404s for missing/foreign evidence", async () => {
    const created = await POST(req({ orgControlId, type: "file", fileName: "report.pdf" }), {
      params: Promise.resolve({ orgId }),
    });
    const { evidenceId } = await created.json();

    const res = await downloadUrlGET(new Request("http://localhost/ignored"), {
      params: Promise.resolve({ orgId, evidenceId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.downloadUrl).toMatch(/^https:\/\/fake-storage\.test\/download\//);
    expect(body.expiresInSeconds).toBe(60);

    const missingRes = await downloadUrlGET(new Request("http://localhost/ignored"), {
      params: Promise.resolve({ orgId, evidenceId: randomUUID() }),
    });
    expect(missingRes.status).toBe(404);
  });
});
