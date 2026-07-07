import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "crypto";

/**
 * Exercises the actual nudge-sender code (processDueNudges + the route
 * handler, not reimplementations) against a real Postgres instance, same
 * convention as tests/slack-handlers.test.ts. @slack/web-api's WebClient is
 * faked for the same reason as slack-handlers.test.ts: there's no
 * local/offline equivalent of a real chat.postMessage call.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL;
const APP_URL = process.env.TEST_DATABASE_URL;
const shouldRun = Boolean(ADMIN_URL && APP_URL);

if (process.env.CI && !shouldRun) {
  throw new Error(
    "TEST_ADMIN_DATABASE_URL/TEST_DATABASE_URL must be set in CI -- refusing to silently skip the nudge sender test."
  );
}

const CRON_SECRET = "test_cron_secret_for_nudges";

interface PostMessageArgs {
  channel: string;
  blocks: { type: string; elements?: { action_id?: string; value?: string }[] }[];
}

const postMessageMock = vi.fn(async (_args: PostMessageArgs) => ({ ok: true }));

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return { chat: { postMessage: postMessageMock } };
  }),
}));

describe.runIf(shouldRun)("Scheduled nudge sender", () => {
  let adminPool: Pool;

  let orgId: string;
  let controlAId: string;
  let controlBId: string;
  let controlCId: string;

  let ownerLinkedId: string; // has slack_user_id
  let ownerUnlinkedId: string; // no slack_user_id

  let orgControlDueLinked: string; // not evidenced, linked owner -> should send
  let orgControlEvidenced: string; // already evidenced -> should skip
  let orgControlNoOwnerLink: string; // owner has no slack_user_id -> should skip

  const slackTeamId = `T_NUDGE_TEST_${randomUUID().slice(0, 6)}`;

  let GET: (typeof import("../src/app/api/cron/send-nudges/route"))["GET"];
  let processDueNudges: (typeof import("../src/lib/slack/nudges"))["processDueNudges"];

  function authedRequest(): Request {
    return new Request("http://localhost/api/cron/send-nudges", {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
  }

  beforeAll(async () => {
    process.env.CRON_SECRET = CRON_SECRET;
    process.env.SLACK_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    process.env.DATABASE_URL = APP_URL;

    ({ GET } = await import("../src/app/api/cron/send-nudges/route"));
    ({ processDueNudges } = await import("../src/lib/slack/nudges"));

    const { encryptToken } = await import("@/lib/slack/tokenCrypto");

    adminPool = new Pool({ connectionString: ADMIN_URL });

    const { rows: controlRows } = await adminPool.query("select id from controls limit 3");
    [controlAId, controlBId, controlCId] = controlRows.map((r) => r.id);

    orgId = randomUUID();
    ownerLinkedId = randomUUID();
    ownerUnlinkedId = randomUUID();

    await adminPool.query("insert into organizations (id, name) values ($1, 'Nudge Sender Test Org')", [
      orgId,
    ]);
    await adminPool.query(
      `insert into users (id, org_id, clerk_user_id, email, role, slack_user_id)
       values ($1, $2, $3, 'nudge-owner-linked@test.local', 'member', $4)`,
      [ownerLinkedId, orgId, `clerk_${ownerLinkedId}`, `U_OWNER_${randomUUID().slice(0, 6)}`]
    );
    await adminPool.query(
      `insert into users (id, org_id, clerk_user_id, email, role)
       values ($1, $2, $3, 'nudge-owner-unlinked@test.local', 'member')`,
      [ownerUnlinkedId, orgId, `clerk_${ownerUnlinkedId}`]
    );

    const { rows: ocDue } = await adminPool.query(
      `insert into org_controls (org_id, control_id, status, owner_user_id)
       values ($1, $2, 'in_progress', $3) returning id`,
      [orgId, controlAId, ownerLinkedId]
    );
    orgControlDueLinked = ocDue[0].id;

    const { rows: ocEvidenced } = await adminPool.query(
      `insert into org_controls (org_id, control_id, status, owner_user_id)
       values ($1, $2, 'evidenced', $3) returning id`,
      [orgId, controlBId, ownerLinkedId]
    );
    orgControlEvidenced = ocEvidenced[0].id;

    const { rows: ocNoOwnerLink } = await adminPool.query(
      `insert into org_controls (org_id, control_id, status, owner_user_id)
       values ($1, $2, 'in_progress', $3) returning id`,
      [orgId, controlCId, ownerUnlinkedId]
    );
    orgControlNoOwnerLink = ocNoOwnerLink[0].id;

    await adminPool.query(
      `insert into slack_installations (org_id, slack_team_id, bot_access_token_encrypted, bot_user_id, scopes, installed_by)
       values ($1, $2, $3, 'BOTUSER', 'chat:write', $4)`,
      [orgId, slackTeamId, encryptToken("xoxb-fake-nudge-test-token"), ownerLinkedId]
    );
  });

  afterAll(async () => {
    await adminPool.query("delete from audit_log where org_id = $1", [orgId]);
    await adminPool.query("delete from nudge_schedules where org_id = $1", [orgId]);
    await adminPool.query("delete from slack_installations where org_id = $1", [orgId]);
    await adminPool.query("delete from org_controls where org_id = $1", [orgId]);
    await adminPool.query("delete from users where org_id = $1", [orgId]);
    await adminPool.query("delete from organizations where id = $1", [orgId]);
    await adminPool.end();
  });

  beforeEach(() => {
    postMessageMock.mockClear();
  });

  afterEach(async () => {
    await adminPool.query("delete from nudge_schedules where org_id = $1", [orgId]);
  });

  describe("GET /api/cron/send-nudges auth", () => {
    it("401s with no Authorization header", async () => {
      const res = await GET(new Request("http://localhost/api/cron/send-nudges"));
      expect(res.status).toBe(401);
      expect(postMessageMock).not.toHaveBeenCalled();
    });

    it("401s with a wrong secret", async () => {
      const res = await GET(
        new Request("http://localhost/api/cron/send-nudges", {
          headers: { authorization: "Bearer wrong" },
        })
      );
      expect(res.status).toBe(401);
    });

    it("200s with the correct secret (no due schedules)", async () => {
      const res = await GET(authedRequest());
      expect(res.status).toBe(200);
    });
  });

  describe("processDueNudges", () => {
    it("sends a reminder for a due schedule with a not-yet-evidenced control and a linked owner", async () => {
      const { rows } = await adminPool.query(
        `insert into nudge_schedules (org_id, org_control_id, cadence, slack_channel_id)
         values ($1, $2, 'weekly', 'C_TEST_CHANNEL') returning id`,
        [orgId, orgControlDueLinked]
      );
      const scheduleId = rows[0].id;

      const result = await processDueNudges();
      expect(result.sent).toBeGreaterThanOrEqual(1);
      expect(result.errors).toBe(0);

      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C_TEST_CHANNEL",
          blocks: expect.arrayContaining([
            expect.objectContaining({
              elements: expect.arrayContaining([
                expect.objectContaining({
                  action_id: "request_evidence_button",
                  value: orgControlDueLinked,
                }),
              ]),
            }),
          ]),
        })
      );

      const { rows: scheduleRows } = await adminPool.query(
        "select last_sent_at from nudge_schedules where id = $1",
        [scheduleId]
      );
      expect(scheduleRows[0].last_sent_at).not.toBeNull();

      const { rows: auditRows } = await adminPool.query(
        "select 1 from audit_log where org_id = $1 and action = 'nudge.sent' and target_id = $2 and actor_user_id is null",
        [orgId, scheduleId]
      );
      expect(auditRows).toHaveLength(1);
    });

    it("skips (and logs) a schedule whose control is already evidenced, without touching last_sent_at", async () => {
      const { rows } = await adminPool.query(
        `insert into nudge_schedules (org_id, org_control_id, cadence, slack_channel_id)
         values ($1, $2, 'weekly', 'C_TEST_CHANNEL') returning id`,
        [orgId, orgControlEvidenced]
      );
      const scheduleId = rows[0].id;

      await processDueNudges();

      expect(postMessageMock).not.toHaveBeenCalled();

      const { rows: scheduleRows } = await adminPool.query(
        "select last_sent_at from nudge_schedules where id = $1",
        [scheduleId]
      );
      expect(scheduleRows[0].last_sent_at).toBeNull();

      const { rows: auditRows } = await adminPool.query(
        "select metadata from audit_log where org_id = $1 and action = 'nudge.skipped' and target_id = $2",
        [orgId, scheduleId]
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].metadata.reason).toBe("control_already_satisfied");
    });

    it("skips (and logs) a schedule whose owner has no linked Slack user", async () => {
      const { rows } = await adminPool.query(
        `insert into nudge_schedules (org_id, org_control_id, cadence, slack_channel_id)
         values ($1, $2, 'weekly', 'C_TEST_CHANNEL') returning id`,
        [orgId, orgControlNoOwnerLink]
      );
      const scheduleId = rows[0].id;

      await processDueNudges();

      expect(postMessageMock).not.toHaveBeenCalled();

      const { rows: auditRows } = await adminPool.query(
        "select metadata from audit_log where org_id = $1 and action = 'nudge.skipped' and target_id = $2",
        [orgId, scheduleId]
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].metadata.reason).toBe("no_linked_owner");
    });

    it("does not re-send a schedule that was just sent (not yet due again)", async () => {
      await adminPool.query(
        `insert into nudge_schedules (org_id, org_control_id, cadence, slack_channel_id)
         values ($1, $2, 'weekly', 'C_TEST_CHANNEL')`,
        [orgId, orgControlDueLinked]
      );

      const first = await processDueNudges();
      expect(first.sent).toBeGreaterThanOrEqual(1);
      postMessageMock.mockClear();

      const second = await processDueNudges();
      expect(second.sent).toBe(0);
      expect(postMessageMock).not.toHaveBeenCalled();
    });
  });
});
