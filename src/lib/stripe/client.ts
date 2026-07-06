import Stripe from "stripe";

// Lazily initialized on first actual use, same rationale as src/lib/db/pool.ts:
// merely importing this module shouldn't require STRIPE_SECRET_KEY to be set
// (e.g. in tests that never touch Stripe).
declare global {
  var __evidentlyStripeClient: Stripe | undefined;
}

function createClient(): Stripe {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  return new Stripe(apiKey);
}

function getClient(): Stripe {
  if (!globalThis.__evidentlyStripeClient) {
    globalThis.__evidentlyStripeClient = createClient();
  }
  return globalThis.__evidentlyStripeClient;
}

export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
