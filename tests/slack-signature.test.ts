import { beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "crypto";

/**
 * Pure unit test for src/lib/slack/verifyRequest.ts -- no database needed,
 * always runs. Mirrors Slack's own documented v0 signing scheme directly
 * (there's no offline test-signature helper shipped by @slack/web-api, the
 * way Stripe ships `generateTestHeaderString`), so this test computes a
 * valid signature itself and also asserts forged/stale/missing cases are
 * rejected.
 */
const SIGNING_SECRET = "test_slack_signing_secret";

function sign(timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

describe("verifySlackSignature", () => {
  let verifySlackSignature: typeof import("../src/lib/slack/verifyRequest")["verifySlackSignature"];
  let InvalidSlackSignatureError: typeof import("../src/lib/slack/verifyRequest")["InvalidSlackSignatureError"];

  beforeAll(async () => {
    process.env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    ({ verifySlackSignature, InvalidSlackSignatureError } = await import(
      "../src/lib/slack/verifyRequest"
    ));
  });

  it("accepts a correctly signed, fresh request", () => {
    const rawBody = "command=%2Fevidence-request&team_id=T123";
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(() =>
      verifySlackSignature({ rawBody, timestamp, signature: sign(timestamp, rawBody) })
    ).not.toThrow();
  });

  it("rejects a forged signature", () => {
    const rawBody = "command=%2Fevidence-request&team_id=T123";
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(() =>
      verifySlackSignature({ rawBody, timestamp, signature: "v0=deadbeef" })
    ).toThrow(InvalidSlackSignatureError);
  });

  it("rejects a signature computed over a different body (tamper detection)", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(timestamp, "command=%2Fevidence-request&team_id=T123");
    expect(() =>
      verifySlackSignature({
        rawBody: "command=%2Fevidence-request&team_id=T999",
        timestamp,
        signature,
      })
    ).toThrow(InvalidSlackSignatureError);
  });

  it("rejects a stale timestamp (replay protection), even with a valid signature for it", () => {
    const rawBody = "command=%2Fevidence-request&team_id=T123";
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 10 * 60); // 10 min old
    expect(() =>
      verifySlackSignature({
        rawBody,
        timestamp: staleTimestamp,
        signature: sign(staleTimestamp, rawBody),
      })
    ).toThrow(InvalidSlackSignatureError);
  });

  it("rejects missing headers", () => {
    expect(() =>
      verifySlackSignature({ rawBody: "x=1", timestamp: null, signature: null })
    ).toThrow(InvalidSlackSignatureError);
  });
});
