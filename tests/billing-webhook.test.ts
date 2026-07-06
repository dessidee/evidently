import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "crypto";

/**
 * Exercises the actual Stripe webhook route handler (not a reimplementation
 * of its logic) against a real Postgres instance, proving:
 *  - an invalid signature is rejected before any DB write happens
 *  - redelivery of the same event.id is a no-op (idempotency)
 *  - an older event (by event.created) can never overwrite state applied by
 *    a newer one, even if delivered later (Stripe does not guarantee order)
 *  - downgrading/canceling only changes plan_tier -- evidence, org_controls,
 *    and past readiness_reviews rows are never deleted or hidden
 *
 * Same env var / CI-guard convention as tests/rls-pooling.test.ts.
 */
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL;
const APP_URL = process.env.TEST_DATABASE_URL;
const shouldRun = Boolean(ADMIN_URL && APP_URL);

if (process.env.CI && !shouldRun) {
  throw new Error(
    "TEST_ADMIN_DATABASE_URL/TEST_DATABASE_URL must be set in CI -- refusing to silently skip the billing webhook test."
  );
}

const STRIPE_WEBHOOK_SECRET = "whsec_test_secret_for_billing_webhook_test";

describe.runIf(shouldRun)("Stripe billing webhook", () => {
  let adminPool: Pool;
  let orgId: string;
  let userId: string;
  let controlId: string;
  let customerId: string;
  let stripe: typeof import("stripe").default.prototype;
  let POST: (typeof import("../src/app/api/billing/webhook/route"))["POST"];

  beforeAll(async () => {
    // Must be set before the route module's lazy pgPool/stripe client are
    // first touched (both are lazy Proxies, so this is safe even though the
    // import below is a static top-level import).
    process.env.DATABASE_URL = APP_URL;
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy_key_for_webhook_signature_only";
    process.env.STRIPE_WEBHOOK_SECRET = STRIPE_WEBHOOK_SECRET;

    ({ stripe } = await import("@/lib/stripe/client"));
    ({ POST } = await import("../src/app/api/billing/webhook/route"));

    adminPool = new Pool({ connectionString: ADMIN_URL });

    const { rows: controlRows } = await adminPool.query("select id from controls limit 1");
    controlId = controlRows[0].id;

    orgId = randomUUID();
    userId = randomUUID();
    customerId = `cus_test_${randomUUID().slice(0, 8)}`;

    await adminPool.query("insert into organizations (id, name) values ($1, 'Billing Test Org')", [
      orgId,
    ]);
    await adminPool.query(
      `insert into users (id, org_id, clerk_user_id, email, role)
       values ($1, $2, $3, 'billing@test.local', 'admin')`,
      [userId, orgId, `clerk_${userId}`]
    );
  });

  afterAll(async () => {
    await adminPool.query("delete from readiness_reviews where org_id = $1", [orgId]);
    await adminPool.query("delete from evidence where org_id = $1", [orgId]);
    await adminPool.query("delete from org_controls where org_id = $1", [orgId]);
    await adminPool.query("delete from audit_log where org_id = $1", [orgId]);
    await adminPool.query("delete from users where org_id = $1", [orgId]);
    await adminPool.query("delete from organizations where id = $1", [orgId]);
    await adminPool.query(
      "delete from stripe_webhook_events where id like 'evt_test_%'"
    );
    await adminPool.end();
  });

  function signedRequest(body: unknown): Request {
    const payload = JSON.stringify(body);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: STRIPE_WEBHOOK_SECRET,
    });
    return new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": signature },
      body: payload,
    });
  }

  it("rejects an invalid signature before writing anything to the database", async () => {
    const eventId = `evt_test_bad_sig_${randomUUID().slice(0, 8)}`;
    const payload = JSON.stringify({
      id: eventId,
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "cs_test_x", client_reference_id: orgId, customer: customerId } },
    });

    const req = new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=deadbeef" }, // wrong secret/signature entirely
      body: payload,
    });

    const res = await POST(req);
    expect(res.status).toBe(400);

    const { rows } = await adminPool.query(
      "select 1 from stripe_webhook_events where id = $1",
      [eventId]
    );
    expect(rows).toHaveLength(0);

    const { rows: orgRows } = await adminPool.query(
      "select stripe_customer_id from organizations where id = $1",
      [orgId]
    );
    expect(orgRows[0].stripe_customer_id).toBeNull();
  });

  it("processes checkout.session.completed exactly once, even when Stripe redelivers the same event", async () => {
    const eventId = `evt_test_checkout_${randomUUID().slice(0, 8)}`;
    const body = {
      id: eventId,
      type: "checkout.session.completed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "cs_test_123",
          client_reference_id: orgId,
          customer: customerId,
          metadata: {},
        },
      },
    };

    const res1 = await POST(signedRequest(body));
    expect(res1.status).toBe(200);
    expect(await res1.json()).toMatchObject({ received: true });

    // Exact redelivery: same event.id, same signature.
    const res2 = await POST(signedRequest(body));
    expect(res2.status).toBe(200);
    expect(await res2.json()).toMatchObject({ received: true, deduped: true });

    const { rows: orgRows } = await adminPool.query(
      "select stripe_customer_id from organizations where id = $1",
      [orgId]
    );
    expect(orgRows[0].stripe_customer_id).toBe(customerId);

    const { rows: auditRows } = await adminPool.query(
      "select count(*)::int as count from audit_log where org_id = $1 and action = 'billing.checkout_completed'",
      [orgId]
    );
    expect(auditRows[0].count).toBe(1);
  });

  it("applies a newer subscription.updated event, and an out-of-order older event cannot overwrite it", async () => {
    const now = Math.floor(Date.now() / 1000);
    const subscriptionId = `sub_test_${randomUUID().slice(0, 8)}`;

    const newerEvent = {
      id: `evt_test_newer_${randomUUID().slice(0, 8)}`,
      type: "customer.subscription.updated",
      created: now, // newer
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status: "active",
          cancel_at_period_end: false,
          metadata: {},
          items: {
            data: [{ price: { id: "price_test_readiness" }, current_period_end: now + 30 * 86400 }],
          },
        },
      },
    };

    const res1 = await POST(signedRequest(newerEvent));
    expect(res1.status).toBe(200);

    const { rows: afterNewer } = await adminPool.query(
      "select plan_tier, subscription_status from organizations where id = $1",
      [orgId]
    );
    expect(afterNewer[0]).toMatchObject({
      plan_tier: "readiness_review",
      subscription_status: "active",
    });

    // A DIFFERENT event (distinct event.id, so it passes the idempotency
    // check), but with an OLDER `created` timestamp -- simulates Stripe
    // redelivering/delaying an earlier event out of order.
    const olderEvent = {
      id: `evt_test_older_${randomUUID().slice(0, 8)}`,
      type: "customer.subscription.updated",
      created: now - 3600, // an hour earlier than newerEvent
      data: {
        object: {
          id: subscriptionId,
          customer: customerId,
          status: "past_due",
          cancel_at_period_end: false,
          metadata: {},
          items: {
            data: [{ price: { id: "price_test_readiness" }, current_period_end: now + 30 * 86400 }],
          },
        },
      },
    };

    const res2 = await POST(signedRequest(olderEvent));
    expect(res2.status).toBe(200);

    const { rows: afterOlder } = await adminPool.query(
      "select plan_tier, subscription_status from organizations where id = $1",
      [orgId]
    );
    // Unchanged -- the stale event must not have been applied.
    expect(afterOlder[0]).toMatchObject({
      plan_tier: "readiness_review",
      subscription_status: "active",
    });
  });

  it("cancellation downgrades plan_tier to free, but never deletes or hides evidence/controls/past reviews", async () => {
    // Simulate data the org accumulated while on the paid plan.
    const { rows: ocRows } = await adminPool.query(
      "insert into org_controls (org_id, control_id) values ($1, $2) returning id",
      [orgId, controlId]
    );
    await adminPool.query(
      `insert into evidence (org_id, org_control_id, uploaded_by, type, description)
       values ($1, $2, $3, 'text_note', 'accumulated-evidence-should-survive-downgrade')`,
      [orgId, ocRows[0].id, userId]
    );
    await adminPool.query(
      `insert into readiness_reviews (org_id, framework, requested_by, status)
       values ($1, 'soc2', $2, 'completed')`,
      [orgId, userId]
    );

    const now = Math.floor(Date.now() / 1000);
    const cancelEvent = {
      id: `evt_test_deleted_${randomUUID().slice(0, 8)}`,
      type: "customer.subscription.deleted",
      created: now + 7200, // clearly the newest event of the test
      data: {
        object: {
          id: `sub_test_${randomUUID().slice(0, 8)}`,
          customer: customerId,
          status: "canceled",
          cancel_at_period_end: false,
          metadata: {},
          items: { data: [{ price: { id: "price_test_readiness" }, current_period_end: now }] },
        },
      },
    };

    const res = await POST(signedRequest(cancelEvent));
    expect(res.status).toBe(200);

    const { rows: orgRows } = await adminPool.query(
      "select plan_tier, subscription_status from organizations where id = $1",
      [orgId]
    );
    expect(orgRows[0]).toMatchObject({ plan_tier: "free", subscription_status: "canceled" });

    // Data accumulated pre-downgrade must still be fully present and
    // readable -- downgrade gates future actions, not past data.
    const { rows: evidenceRows } = await adminPool.query(
      "select description from evidence where org_id = $1",
      [orgId]
    );
    expect(evidenceRows.map((r) => r.description)).toContain(
      "accumulated-evidence-should-survive-downgrade"
    );

    const { rows: reviewRows } = await adminPool.query(
      "select status from readiness_reviews where org_id = $1",
      [orgId]
    );
    expect(reviewRows.map((r) => r.status)).toContain("completed");

    const { rows: controlRows } = await adminPool.query(
      "select id from org_controls where org_id = $1",
      [orgId]
    );
    expect(controlRows).toHaveLength(1);
  });

  it("requirePlan rejects a free-tier org and allows a readiness_review-tier org", async () => {
    const { requirePlan, PlanRequiredError } = await import("@/lib/auth/orgContext");
    const ctx = { orgId, userId, role: "admin" as const };

    // From the previous test, orgId is currently back on 'free'.
    await expect(requirePlan(ctx, "readiness_review")).rejects.toBeInstanceOf(PlanRequiredError);

    await adminPool.query("update organizations set plan_tier = 'readiness_review' where id = $1", [
      orgId,
    ]);
    await expect(requirePlan(ctx, "readiness_review")).resolves.toBeUndefined();
  });
});
