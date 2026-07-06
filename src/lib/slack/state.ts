import { createHmac, timingSafeEqual } from "crypto";

const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface StatePayload {
  orgId: string;
  userId: string;
  iat: number;
}

function getSecret(): string {
  const secret = process.env.SLACK_OAUTH_STATE_SECRET;
  if (!secret) throw new Error("SLACK_OAUTH_STATE_SECRET is not set");
  return secret;
}

function sign(data: string): string {
  return createHmac("sha256", getSecret()).update(data).digest("base64url");
}

/**
 * Signed, expiring state token for the Slack OAuth flow. orgId/userId are
 * baked into the signed payload server-side (from the authenticated
 * session that started the install), so the callback -- which Slack calls
 * later, out of band -- can recover *which* org this install belongs to
 * without trusting anything in the callback's own query string.
 */
export function createOAuthState(orgId: string, userId: string): string {
  const payload: StatePayload = { orgId, userId, iat: Date.now() };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(data);
  return `${data}.${signature}`;
}

export function verifyOAuthState(state: string): StatePayload {
  const [data, signature] = state.split(".");
  if (!data || !signature) {
    throw new Error("Malformed state");
  }

  const expectedSignature = sign(data);
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (
    sigBuf.length !== expectedBuf.length ||
    !timingSafeEqual(sigBuf, expectedBuf)
  ) {
    throw new Error("Invalid state signature");
  }

  const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as StatePayload;
  if (Date.now() - payload.iat > STATE_TTL_MS) {
    throw new Error("State expired");
  }
  return payload;
}
