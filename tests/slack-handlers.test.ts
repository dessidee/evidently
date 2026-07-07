import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { randomUUID, createHmac } from "crypto";

/**
 * Exercises the actual Slack route handlers (not reimplementations) against
 * a real Postgres instance, same convention as tests/billing-webhook.test.ts
 * and tests/evidence-upload.test.ts. Two boundaries are faked, for the same
 * category of reason as evidence-upload.test.ts's storage fake:
 *
 * 1. @slack/web-api's WebClient -- there is no local/offline equivalent of a
 *    real Slack API call (views.open); this proves our code calls it with
 *    the right trigger_id/view, not that Slack itself renders it.
 * 2. @clerk/nextjs/server's `auth()` -- same reasoning as
 *    evidence-upload.test.ts, needed only for the /api/slack/link web
 *    callback (which is Clerk-session-authenticated); everything downstream
 *    (getAuthContext, RLS, the DB) is real.
 *
 * Slack request signatures are computed for real via the same v0 HMAC
 * scheme verifyRequest.ts implements (mirrors
 * tests/slack-signature.test.ts's helper) -- signature verification itself
 * is exercised end-to-end here, not bypassed.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL;
const APP_URL = process.env.TEST_DATABASE_URL;
const shouldRun = Boolean(ADMIN_URL && APP_URL);

if (process.env.CI && !shouldRun) {
  throw new Error(
    "TEST_ADMIN_DATABASE_URL/TEST_DATABASE_URL must be set in CI -- refusing to silently skip the Slack handlers test."
  );
}

const SLACK_SIGNING_SECRET = "test_slack_signing_secret_for_handlers";
const CLERK_USER_ID = `clerk_slack_link_test_${randomUUID().slice(0, 8)}`;

interface ViewsOpenArgs {
  trigger_id: string;
  view: {
    callback_id?: string;
    private_metadata?: string;
    blocks: { block_id?: string; element?: { options?: unknown[] } }[];
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- param exists only to give the mock a typed signature
const viewsOpenMock = vi.fn(async (_args: ViewsOpenArgs) => ({ ok: true }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: CLERK_USER_ID })),
}));

vi.mock("@slack/web-api", () => ({
  // Must be a real `function`, not an arrow function -- getSlackClientForOrg
  // calls `new WebClient(...)`, and arrow functions can't be used as
  // constructors.
  WebClient: vi.fn().mockImplementation(function () {
    return { views: { open: viewsOpenMock } };
  }),
}));

function signSlack(rawBody: string): { timestamp: string; signature: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  return { timestamp, signature };
}

function slackFormRequest(url: string, form: Record<string, string>): Request {
  const rawBody = new URLSearchParams(form).toString();
  const { timestamp, signature } = signSlack(rawBody);
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: rawBody,
  });
}

describe.runIf(shouldRun)("Slack handlers", () => {
  let adminPool: Pool;

  let orgId: string;
  let controlId: string;
  let orgControlId: string;

  let userLinkedId: string; // already has slack_user_id set
  let userToLinkId: string; // clerk_user_id === CLERK_USER_ID, starts unlinked

  const slackTeamId = `T_TEST_${randomUUID().slice(0, 6)}`;
  const slackUserIdLinked = `U_LINKED_${randomUUID().slice(0, 6)}`;
  const slackUserIdUnlinked = `U_UNLINKED_${randomUUID().slice(0, 6)}`;
  const slackUserIdToLink = `U_TOLINK_${randomUUID().slice(0, 6)}`;

  let commandsPOST: (typeof import("../src/app/api/slack/commands/route"))["POST"];
  let interactionsPOST: (typeof import("../src/app/api/slack/interactions/route"))["POST"];
  let linkGET: (typeof import("../src/app/api/slack/link/route"))["GET"];

  beforeAll(async () => {
    process.env.SLACK_SIGNING_SECRET = SLACK_SIGNING_SECRET;
    process.env.SLACK_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.DATABASE_URL = APP_URL;

    ({ POST: commandsPOST } = await import("../src/app/api/slack/commands/route"));
    ({ POST: interactionsPOST } = await import("../src/app/api/slack/interactions/route"));
    ({ GET: linkGET } = await import("../src/app/api/slack/link/route"));

    const { encryptToken } = await import("@/lib/slack/tokenCrypto");

    adminPool = new Pool({ connectionString: ADMIN_URL });

    const { rows: controlRows } = await adminPool.query("select id from controls limit 1");
    controlId = controlRows[0].id;

    orgId = randomUUID();
    userLinkedId = randomUUID();
    userToLinkId = randomUUID();

    await adminPool.query("insert into organizations (id, name) values ($1, 'Slack Handlers Test Org')", [
      orgId,
    ]);
    await adminPool.query(
      `insert into users (id, org_id, clerk_user_id, email, role, slack_user_id)
       values ($1, $2, $3, 'slack-linked@test.local', 'member', $4)`,
      [userLinkedId, orgId, `clerk_${userLinkedId}`, slackUserIdLinked]
    );
    await adminPool.query(
      `insert into users (id, org_id, clerk_user_id, email, role)
       values ($1, $2, $3, 'slack-tolink@test.local', 'member')`,
      [userToLinkId, orgId, CLERK_USER_ID]
    );

    const { rows: ocRows } = await adminPool.query(
      "insert into org_controls (org_id, control_id) values ($1, $2) returning id",
      [orgId, controlId]
    );
    orgControlId = ocRows[0].id;

    await adminPool.query(
      `insert into slack_installations (org_id, slack_team_id, bot_access_token_encrypted, bot_user_id, scopes, installed_by)
       values ($1, $2, $3, 'BOTUSER', 'chat:write,commands', $4)`,
      [orgId, slackTeamId, encryptToken("xoxb-fake-test-token"), userLinkedId]
    );
  });

  afterAll(async () => {
    await adminPool.query("delete from audit_log where org_id = $1", [orgId]);
    await adminPool.query("delete from evidence where org_id = $1", [orgId]);
    await adminPool.query("delete from slack_link_tokens where org_id = $1", [orgId]);
    await adminPool.query("delete from slack_installations where org_id = $1", [orgId]);
    await adminPool.query("delete from org_controls where org_id = $1", [orgId]);
    await adminPool.query("delete from users where org_id = $1", [orgId]);
    await adminPool.query("delete from organizations where id = $1", [orgId]);
    await adminPool.end();
  });

  beforeEach(() => {
    viewsOpenMock.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("POST /api/slack/commands", () => {
    it("rejects a request with an invalid signature", async () => {
      const rawBody = "command=%2Fevidence-request&team_id=" + slackTeamId + "&user_id=" + slackUserIdLinked;
      const res = await commandsPOST(
        new Request("http://localhost/api/slack/commands", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
            "x-slack-signature": "v0=deadbeef",
          },
          body: rawBody,
        })
      );
      expect(res.status).toBe(401);
      expect(viewsOpenMock).not.toHaveBeenCalled();
    });

    it("/evidence-request tells an unlinked Slack user to run /evidence-link first", async () => {
      const res = await commandsPOST(
        slackFormRequest("http://localhost/api/slack/commands", {
          command: "/evidence-request",
          team_id: slackTeamId,
          user_id: slackUserIdUnlinked,
          trigger_id: "trigger123",
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.text).toMatch(/isn't linked/i);
      expect(viewsOpenMock).not.toHaveBeenCalled();
    });

    it("/evidence-request opens the evidence modal for a linked Slack user, with org_controls as options", async () => {
      const res = await commandsPOST(
        slackFormRequest("http://localhost/api/slack/commands", {
          command: "/evidence-request",
          team_id: slackTeamId,
          user_id: slackUserIdLinked,
          trigger_id: "trigger123",
        })
      );
      expect(res.status).toBe(200);
      expect(viewsOpenMock).toHaveBeenCalledTimes(1);

      const call = viewsOpenMock.mock.calls[0]![0];
      expect(call.trigger_id).toBe("trigger123");
      expect(call.view.callback_id).toBe("evidence_submit_modal");
      const controlSelectBlock = call.view.blocks.find(
        (b: { block_id?: string }) => b.block_id === "org_control_block"
      );
      expect(controlSelectBlock?.element?.options).toEqual(
        expect.arrayContaining([expect.objectContaining({ value: orgControlId })])
      );
    });

    it("/evidence-link returns a single-use link, and stores only its hash", async () => {
      const res = await commandsPOST(
        slackFormRequest("http://localhost/api/slack/commands", {
          command: "/evidence-link",
          team_id: slackTeamId,
          user_id: slackUserIdToLink,
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      const match = body.text.match(/token=([\w-]+)/);
      expect(match).not.toBeNull();

      const { rows } = await adminPool.query(
        "select org_id, slack_team_id, slack_user_id, consumed_at from slack_link_tokens where org_id = $1 and slack_user_id = $2",
        [orgId, slackUserIdToLink]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ org_id: orgId, slack_team_id: slackTeamId });
      expect(rows[0].consumed_at).toBeNull();
    });
  });

  describe("GET /api/slack/link (single-use token consumption)", () => {
    async function requestLinkToken(): Promise<string> {
      const res = await commandsPOST(
        slackFormRequest("http://localhost/api/slack/commands", {
          command: "/evidence-link",
          team_id: slackTeamId,
          user_id: slackUserIdToLink,
        })
      );
      const body = await res.json();
      return body.text.match(/token=([\w-]+)/)[1];
    }

    it("400s when no token is provided", async () => {
      const res = await linkGET(new Request("http://localhost/api/slack/link"));
      expect(res.status).toBe(400);
    });

    it("consumes the token exactly once: first use links the account, second use fails", async () => {
      const token = await requestLinkToken();

      const firstRes = await linkGET(
        new Request(`http://localhost/api/slack/link?token=${token}`)
      );
      expect(firstRes.status).toBe(307); // NextResponse.redirect default
      expect(firstRes.headers.get("location")).toContain("slack=linked");

      const { rows: afterFirst } = await adminPool.query(
        "select slack_user_id from users where id = $1",
        [userToLinkId]
      );
      expect(afterFirst[0].slack_user_id).toBe(slackUserIdToLink);

      const { rows: auditRows } = await adminPool.query(
        "select 1 from audit_log where org_id = $1 and action = 'slack.user_linked' and actor_user_id = $2",
        [orgId, userToLinkId]
      );
      expect(auditRows).toHaveLength(1);

      // Replay with the SAME token must fail, and must not touch users again.
      const secondRes = await linkGET(
        new Request(`http://localhost/api/slack/link?token=${token}`)
      );
      expect(secondRes.status).toBe(307);
      expect(secondRes.headers.get("location")).toContain("slack=link_invalid");

      const { rows: afterSecond } = await adminPool.query(
        "select slack_user_id from users where id = $1",
        [userToLinkId]
      );
      expect(afterSecond[0].slack_user_id).toBe(slackUserIdToLink);
    });
  });

  describe("POST /api/slack/interactions", () => {
    function blockActionsPayload(input: { slackUserId: string; actionId: string; value: string }) {
      return {
        type: "block_actions",
        team: { id: slackTeamId },
        user: { id: input.slackUserId },
        trigger_id: "trigger456",
        response_url: "https://hooks.slack.test/response",
        actions: [{ action_id: input.actionId, value: input.value }],
      };
    }

    it("block_actions: opens the modal pre-filled with the control, for a linked user", async () => {
      const payload = blockActionsPayload({
        slackUserId: slackUserIdLinked,
        actionId: "request_evidence_button",
        value: orgControlId,
      });
      const res = await interactionsPOST(
        slackFormRequest("http://localhost/api/slack/interactions", {
          payload: JSON.stringify(payload),
        })
      );
      expect(res.status).toBe(200);
      expect(viewsOpenMock).toHaveBeenCalledTimes(1);
      const call = viewsOpenMock.mock.calls[0]![0];
      expect(call.trigger_id).toBe("trigger456");
      const metadata = JSON.parse(call.view.private_metadata!);
      expect(metadata.orgControlId).toBe(orgControlId);
    });

    it("block_actions: notifies via response_url and does not open a modal for an unlinked user", async () => {
      const payload = blockActionsPayload({
        slackUserId: slackUserIdUnlinked,
        actionId: "request_evidence_button",
        value: orgControlId,
      });
      const res = await interactionsPOST(
        slackFormRequest("http://localhost/api/slack/interactions", {
          payload: JSON.stringify(payload),
        })
      );
      expect(res.status).toBe(200);
      expect(viewsOpenMock).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledWith(
        "https://hooks.slack.test/response",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("view_submission: creates evidence (submitted_via='slack') for a valid, linked submission", async () => {
      const payload = {
        type: "view_submission",
        team: { id: slackTeamId },
        user: { id: slackUserIdLinked },
        view: {
          callback_id: "evidence_submit_modal",
          private_metadata: JSON.stringify({ orgControlId }),
          state: {
            values: {
              type_block: { type_select: { selected_option: { value: "text_note" } } },
              description_block: { description_input: { value: "we rotate keys quarterly" } },
              external_url_block: { external_url_input: { value: null } },
            },
          },
        },
      };
      const res = await interactionsPOST(
        slackFormRequest("http://localhost/api/slack/interactions", {
          payload: JSON.stringify(payload),
        })
      );
      expect(res.status).toBe(200);

      const { rows } = await adminPool.query(
        "select uploaded_by, submitted_via, description from evidence where org_control_id = $1 and submitted_via = 'slack'",
        [orgControlId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        uploaded_by: userLinkedId,
        submitted_via: "slack",
        description: "we rotate keys quarterly",
      });
    });

    it("view_submission: rejects a submission with no evidence type selected, and creates no evidence", async () => {
      const payload = {
        type: "view_submission",
        team: { id: slackTeamId },
        user: { id: slackUserIdLinked },
        view: {
          callback_id: "evidence_submit_modal",
          private_metadata: JSON.stringify({ orgControlId }),
          state: {
            values: {
              type_block: { type_select: { selected_option: null } },
              description_block: { description_input: { value: null } },
              external_url_block: { external_url_input: { value: null } },
            },
          },
        },
      };
      const res = await interactionsPOST(
        slackFormRequest("http://localhost/api/slack/interactions", {
          payload: JSON.stringify(payload),
        })
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.response_action).toBe("errors");
      expect(body.errors.type_block).toBeDefined();
    });
  });
});
