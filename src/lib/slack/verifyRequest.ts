import { createHmac, timingSafeEqual } from "crypto";

// Slack recommends rejecting requests whose timestamp is more than 5
// minutes old, as replay protection -- same rationale (and same window) as
// the OAuth state TTL in state.ts.
const MAX_REQUEST_AGE_SECONDS = 5 * 60;

export class InvalidSlackSignatureError extends Error {}

function getSigningSecret(): string {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) throw new Error("SLACK_SIGNING_SECRET is not set");
  return secret;
}

/**
 * Verifies a Slack request's signature per Slack's documented v0 HMAC-SHA256
 * scheme: HMAC(signing_secret, "v0:{timestamp}:{rawBody}") compared against
 * the X-Slack-Signature header, using a timing-safe comparison (same
 * primitive already used for the OAuth state signature in state.ts).
 *
 * Must be called with the RAW (unparsed) body -- Slack signs the exact bytes
 * it sent, and this must run BEFORE any JSON/form parsing or business logic,
 * mirroring the Stripe webhook's verify-then-parse discipline
 * (src/app/api/billing/webhook/route.ts).
 */
export function verifySlackSignature(params: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
}): void {
  const { rawBody, timestamp, signature } = params;
  if (!timestamp || !signature) {
    throw new InvalidSlackSignatureError("Missing Slack signature headers");
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw new InvalidSlackSignatureError("Malformed X-Slack-Request-Timestamp header");
  }
  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (ageSeconds > MAX_REQUEST_AGE_SECONDS) {
    throw new InvalidSlackSignatureError("Request timestamp too old (possible replay)");
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", getSigningSecret()).update(base).digest("hex")}`;

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new InvalidSlackSignatureError("Invalid Slack signature");
  }
}
