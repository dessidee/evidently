import { NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { verifyOAuthState } from "@/lib/slack/state";
import { encryptToken } from "@/lib/slack/tokenCrypto";
import { withOrgContext } from "@/lib/db/withOrgContext";

/**
 * Slack redirects here after the user approves the install. This request
 * comes from the user's browser (Slack does a 302 redirect), not from Slack's
 * servers directly, so we cannot trust the `code`/`state` query params on
 * their own -- verifyOAuthState checks the HMAC signature we generated in
 * /api/slack/install, which is the only thing that tells us which org this
 * install belongs to. There is deliberately no orgId query/body param here.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.json({ error: `Slack denied install: ${error}` }, { status: 400 });
  }
  if (!code || !state) {
    return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
  }

  let orgId: string;
  let userId: string;
  try {
    ({ orgId, userId } = verifyOAuthState(state));
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid OAuth state: ${(err as Error).message}` },
      { status: 400 }
    );
  }

  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.json({ error: "Slack app not configured" }, { status: 500 });
  }

  const client = new WebClient();
  const result = await client.oauth.v2.access({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  if (!result.ok || !result.access_token || !result.team?.id || !result.bot_user_id) {
    return NextResponse.json({ error: "Slack token exchange failed" }, { status: 502 });
  }

  const encrypted = encryptToken(result.access_token);
  const scopes = String(result.scope ?? "");
  const teamId = result.team.id;
  const botUserId = result.bot_user_id;

  await withOrgContext(orgId, async (dbClient) => {
    await dbClient.query(
      `insert into slack_installations
         (org_id, slack_team_id, bot_access_token_encrypted, bot_user_id, scopes, installed_by)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (slack_team_id) do update set
         bot_access_token_encrypted = excluded.bot_access_token_encrypted,
         scopes = excluded.scopes,
         installed_by = excluded.installed_by`,
      [orgId, teamId, encrypted, botUserId, scopes, userId]
    );
    await dbClient.query(
      `insert into audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
       values ($1, $2, 'slack.installed', 'slack_installation', null, $3::jsonb)`,
      [orgId, userId, JSON.stringify({ teamId, scopes })]
    );
  });

  return NextResponse.redirect(new URL("/dashboard?slack=connected", req.url));
}
