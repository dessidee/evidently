import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe/client";
import { pgPool } from "@/lib/db/pool";
import { withOrgContext } from "@/lib/db/withOrgContext";

const SUBSCRIPTION_ACTIVE_STATUSES = new Set(["trialing", "active"]);

function planTierForStatus(status: string): "free" | "readiness_review" {
  return SUBSCRIPTION_ACTIVE_STATUSES.has(status) ? "readiness_review" : "free";
}

/**
 * Resolves which org an event belongs to. Prefers stripe_customer_id (already
 * attached to the org by a prior checkout.session.completed), falling back to
 * the org_id we stamped into subscription/session metadata at checkout-
 * creation time, in case the customer link hasn't been persisted yet (e.g.
 * customer.subscription.updated arriving before checkout.session.completed --
 * Stripe does not guarantee ordering across event types either).
 */
async function resolveOrgId(customerId: string, metadataOrgId?: string | null) {
  const { rows } = await pgPool.query<{ id: string }>(
    "select id from organizations where stripe_customer_id = $1",
    [customerId]
  );
  return rows[0]?.id ?? metadataOrgId ?? null;
}

async function applySubscriptionState(
  subscription: Stripe.Subscription,
  eventCreatedAt: Date,
  customerId: string
) {
  const orgId = await resolveOrgId(customerId, subscription.metadata?.org_id);
  if (!orgId) {
    console.error(
      `Stripe webhook: could not resolve org_id for customer ${customerId} / subscription ${subscription.id}`
    );
    return;
  }

  const item = subscription.items.data[0];
  const status = subscription.status;
  const planTier = planTierForStatus(status);

  await withOrgContext(orgId, async (client) => {
    // The `stripe_last_event_at` guard makes this update a no-op if we've
    // already applied a newer event for this org -- protects against
    // out-of-order webhook delivery overwriting fresher state with stale
    // state. organizations has no RLS (tenant root), so this update and the
    // audit_log insert below just share the transaction/org-context for
    // convenience, not for RLS reasons on the organizations row itself.
    const { rows } = await client.query<{ plan_tier: string }>(
      `update organizations
       set stripe_customer_id = $1,
           stripe_subscription_id = $2,
           subscription_status = $3,
           stripe_price_id = $4,
           cancel_at_period_end = $5,
           current_period_end = $6,
           plan_tier = $7,
           stripe_last_event_at = $8
       where id = $9
         and (stripe_last_event_at is null or stripe_last_event_at < $8)
       returning plan_tier`,
      [
        customerId,
        subscription.id,
        status,
        item?.price.id ?? null,
        subscription.cancel_at_period_end,
        item ? new Date(item.current_period_end * 1000) : null,
        planTier,
        eventCreatedAt,
        orgId,
      ]
    );

    if (rows.length === 0) {
      // Either a stale/out-of-order event, or the row didn't exist -- no
      // state changed, nothing to audit.
      return;
    }

    await client.query(
      `insert into audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
       values ($1, null, 'billing.subscription_synced', 'organization', $1, $2::jsonb)`,
      [orgId, JSON.stringify({ status, planTier, subscriptionId: subscription.id })]
    );
  });
}

async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
  const orgId = session.client_reference_id ?? session.metadata?.org_id;
  const customerId =
    typeof session.customer === "string" ? session.customer : session.customer?.id;

  if (!orgId || !customerId) {
    console.error(
      `Stripe webhook: checkout.session.completed missing org_id or customer (session ${session.id})`
    );
    return;
  }

  // Only attaches the customer id here; subscription status/plan_tier is set
  // by the customer.subscription.updated event that Stripe sends alongside
  // this one, which carries the authoritative status/price -- avoids two
  // code paths computing plan_tier from potentially inconsistent shapes.
  await withOrgContext(orgId, async (client) => {
    await client.query(
      `update organizations set stripe_customer_id = $1 where id = $2 and stripe_customer_id is null`,
      [customerId, orgId]
    );
    await client.query(
      `insert into audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
       values ($1, null, 'billing.checkout_completed', 'organization', $1, $2::jsonb)`,
      [orgId, JSON.stringify({ sessionId: session.id, customerId })]
    );
  });
}

export async function POST(req: Request) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not set");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  // Signature verification happens first, over the raw body, before any
  // JSON parsing or business logic runs.
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid signature: ${(err as Error).message}` },
      { status: 400 }
    );
  }

  // Idempotency: Stripe delivers at-least-once and retries on non-2xx or
  // timeout. event.id is unique per logical event, so a first-write-wins
  // insert here makes redelivery a no-op rather than reprocessing.
  const { rowCount } = await pgPool.query(
    `insert into stripe_webhook_events (id, type) values ($1, $2) on conflict (id) do nothing`,
    [event.id, event.type]
  );
  if (rowCount === 0) {
    return NextResponse.json({ received: true, deduped: true });
  }

  const eventCreatedAt = new Date(event.created * 1000);

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(event.data.object);
        break;
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer.id;
        await applySubscriptionState(subscription, eventCreatedAt, customerId);
        break;
      }
      default:
        // Acknowledged but ignored -- we only act on the events above.
        break;
    }
  } catch (err) {
    console.error(`Stripe webhook: failed to process event ${event.id} (${event.type})`, err);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
