import { randomBytes, createHash } from "crypto";
import { pgPool } from "@/lib/db/pool";

const TOKEN_TTL_INTERVAL = "10 minutes";
const TOKEN_BYTES = 32;

function hashToken(rawToken: string): Buffer {
  return createHash("sha256").update(rawToken).digest();
}

/**
 * Creates a single-use account-linking token bound to (orgId, slackTeamId,
 * slackUserId). Returns the raw token -- only its hash is ever stored, so a
 * database read alone can't be replayed to claim the link. The token is a
 * random opaque value, not a signed payload: the slack_link_tokens row
 * (existence + consumed_at + expires_at) is the sole source of authority,
 * so there's nothing extra to gain from HMAC-signing it too (contrast with
 * the stateless OAuth `state` in state.ts, which has no DB row backing it
 * and therefore *needs* a signature to prove integrity).
 */
export async function createLinkToken(input: {
  orgId: string;
  slackTeamId: string;
  slackUserId: string;
}): Promise<string> {
  const rawToken = randomBytes(TOKEN_BYTES).toString("base64url");
  await pgPool.query(
    `insert into slack_link_tokens (token_hash, org_id, slack_team_id, slack_user_id, expires_at)
     values ($1, $2, $3, $4, now() + interval '${TOKEN_TTL_INTERVAL}')`,
    [hashToken(rawToken), input.orgId, input.slackTeamId, input.slackUserId]
  );
  return rawToken;
}

export interface ConsumedLinkToken {
  orgId: string;
  slackUserId: string;
}

/**
 * Atomically claims a link token: only the FIRST caller to present a given
 * unexpired token succeeds, via a conditional UPDATE ... WHERE consumed_at
 * IS NULL ... RETURNING (same "claim exactly once" shape as the
 * stripe_webhook_events idempotency guard, applied to consumption instead
 * of first-insert). Returns null if the token is invalid, already consumed,
 * or expired -- callers must treat all three cases identically (don't leak
 * which one it was) and must NOT write to `users` unless this returns a row.
 */
export async function consumeLinkToken(rawToken: string): Promise<ConsumedLinkToken | null> {
  const { rows } = await pgPool.query<{ org_id: string; slack_user_id: string }>(
    `update slack_link_tokens
        set consumed_at = now()
      where token_hash = $1 and consumed_at is null and expires_at > now()
      returning org_id, slack_user_id`,
    [hashToken(rawToken)]
  );
  const row = rows[0];
  if (!row) return null;
  return { orgId: row.org_id, slackUserId: row.slack_user_id };
}
