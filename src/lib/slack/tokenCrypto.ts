import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// AES-256-GCM. Key comes from env (never hardcoded, never in git) as a
// base64-encoded 32-byte value, e.g. generated with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
function getKey(): Buffer {
  const b64 = process.env.SLACK_TOKEN_ENCRYPTION_KEY;
  if (!b64) throw new Error("SLACK_TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error("SLACK_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

/** Encrypts a Slack bot token for storage in slack_installations.bot_access_token_encrypted. */
export function encryptToken(plaintext: string): Buffer {
  const key = getKey();
  const iv = randomBytes(12); // GCM standard nonce size
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Layout: iv (12) | authTag (16) | ciphertext
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptToken(stored: Buffer): string {
  const key = getKey();
  const iv = stored.subarray(0, 12);
  const authTag = stored.subarray(12, 28);
  const ciphertext = stored.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
