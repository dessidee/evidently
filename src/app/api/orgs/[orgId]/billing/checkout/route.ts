import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe/client";
import {
  ForbiddenError,
  UnauthorizedError,
  getAuthContext,
  requireAdmin,
  requireOrgMatch,
} from "@/lib/auth/orgContext";
import { pgPool } from "@/lib/db/pool";

/**
 * Creates a Stripe Checkout session for the caller's org to subscribe to the
 * paid 'readiness_review' tier. org_id is never accepted from the client --
 * it's the server-resolved ctx.orgId, passed to Stripe via
 * client_reference_id/metadata so the webhook can attribute the resulting
 * subscription to the right org without trusting anything client-supplied.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const { orgId: pathOrgId } = await params;
    const ctx = await getAuthContext();
    requireOrgMatch(ctx, pathOrgId);
    requireAdmin(ctx);

    const priceId = process.env.STRIPE_READINESS_REVIEW_PRICE_ID;
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (!priceId || !appUrl) {
      console.error("STRIPE_READINESS_REVIEW_PRICE_ID or NEXT_PUBLIC_APP_URL is not set");
      return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
    }

    const { rows } = await pgPool.query<{ stripe_customer_id: string | null }>(
      "select stripe_customer_id from organizations where id = $1",
      [ctx.orgId]
    );
    const existingCustomerId = rows[0]?.stripe_customer_id ?? undefined;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: existingCustomerId,
      client_reference_id: ctx.orgId,
      metadata: { org_id: ctx.orgId },
      subscription_data: { metadata: { org_id: ctx.orgId } },
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/dashboard?billing=success`,
      cancel_url: `${appUrl}/dashboard?billing=cancelled`,
    });

    return NextResponse.json({ checkoutUrl: session.url });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    console.error(err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
