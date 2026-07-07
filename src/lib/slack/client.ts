import { WebClient } from "@slack/web-api";
import { withOrgContext } from "@/lib/db/withOrgContext";
import { decryptToken } from "./tokenCrypto";

/**
 * Builds a Slack WebClient authenticated as the org's installed bot, for
 * calling views.open / chat.postMessage etc. Decrypts the token on demand
 * (never cached in plaintext) using the same AES-256-GCM helper the OAuth
 * callback uses to encrypt it at rest.
 */
export async function getSlackClientForOrg(orgId: string): Promise<WebClient> {
  const token = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ bot_access_token_encrypted: Buffer }>(
      `select bot_access_token_encrypted from slack_installations
       where org_id = $1
       order by created_at desc
       limit 1`,
      [orgId]
    );
    if (!rows[0]) {
      throw new Error(`No Slack installation found for org ${orgId}`);
    }
    return decryptToken(rows[0].bot_access_token_encrypted);
  });
  return new WebClient(token);
}
