import { beforeAll, describe, expect, it } from "vitest";

/**
 * Pure unit test for src/lib/slack/nudgeSecret.ts -- no database needed,
 * always runs. Mirrors tests/slack-signature.test.ts's structure.
 */
const SECRET = "test_cron_secret_value";

describe("verifyNudgeSecret", () => {
  let verifyNudgeSecret: typeof import("../src/lib/slack/nudgeSecret")["verifyNudgeSecret"];
  let InvalidNudgeSecretError: typeof import("../src/lib/slack/nudgeSecret")["InvalidNudgeSecretError"];

  beforeAll(async () => {
    process.env.CRON_SECRET = SECRET;
    ({ verifyNudgeSecret, InvalidNudgeSecretError } = await import("../src/lib/slack/nudgeSecret"));
  });

  it("accepts a correct Bearer token", () => {
    expect(() => verifyNudgeSecret(`Bearer ${SECRET}`)).not.toThrow();
  });

  it("rejects a wrong secret", () => {
    expect(() => verifyNudgeSecret("Bearer wrong_value")).toThrow(InvalidNudgeSecretError);
  });

  it("rejects a missing header", () => {
    expect(() => verifyNudgeSecret(null)).toThrow(InvalidNudgeSecretError);
  });

  it("rejects a header with the wrong scheme", () => {
    expect(() => verifyNudgeSecret(`Basic ${SECRET}`)).toThrow(InvalidNudgeSecretError);
  });

  it("rejects a value that is a prefix/suffix of the real secret", () => {
    expect(() => verifyNudgeSecret(`Bearer ${SECRET}extra`)).toThrow(InvalidNudgeSecretError);
    expect(() => verifyNudgeSecret(`Bearer ${SECRET.slice(0, -1)}`)).toThrow(InvalidNudgeSecretError);
  });
});
