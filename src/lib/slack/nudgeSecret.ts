import { timingSafeEqual } from "crypto";

// Auth for the nudge-sender endpoint: a single static shared secret, not
// Clerk (no signed-in user -- this is a machine/manual trigger) and not
// Slack request signing (the request originates from us, not Slack). Same
// timing-safe-comparison discipline as verifySlackSignature, simplified to a
// flat secret since there's no per-request signing scheme to replicate.
//
// Env var MUST be named CRON_SECRET, not something else: Vercel Cron
// auto-attaches `Authorization: Bearer <value>` using the env var literally
// named CRON_SECRET when it triggers a cron job -- vercel.json cron entries
// have no way to configure a custom header. A differently-named secret
// would leave Vercel's own cron-triggered requests unauthenticated (no
// header at all), so this name is load-bearing, not cosmetic.
export class InvalidNudgeSecretError extends Error {}

function getNudgeSecret(): string {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET is not set");
  return secret;
}

/**
 * Verifies the `Authorization: Bearer <secret>` header against
 * CRON_SECRET using a timing-safe comparison. Throws
 * InvalidNudgeSecretError on any mismatch (missing header, wrong scheme,
 * wrong value) -- callers should treat all of these identically and return
 * 401 without distinguishing the reason.
 */
export function verifyNudgeSecret(authorizationHeader: string | null): void {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new InvalidNudgeSecretError("Missing or malformed Authorization header");
  }
  const provided = authorizationHeader.slice("Bearer ".length);

  const expectedBuf = Buffer.from(getNudgeSecret());
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    throw new InvalidNudgeSecretError("Invalid nudge sender secret");
  }
}
