import { NextResponse } from "next/server";
import { ForbiddenError, UnauthorizedError, getAuthContext, requireAdmin } from "@/lib/auth/orgContext";
import { createOAuthState } from "@/lib/slack/state";

// Minimal scopes: post nudges/reminders and respond to the slash command.
// Deliberately not requesting channels:read, users:read, or anything else
// not needed for the v1 nudge bot.
const SLACK_SCOPES = ["chat:write", "commands"].join(",");

export async function GET() {
  try {
    const ctx = await getAuthContext();
    requireAdmin(ctx); // only an org admin can connect Slack

    const clientId = process.env.SLACK_CLIENT_ID;
    const redirectUri = process.env.SLACK_OAUTH_REDIRECT_URI;
    if (!clientId || !redirectUri) {
      return NextResponse.json({ error: "Slack app not configured" }, { status: 500 });
    }

    const state = createOAuthState(ctx.orgId, ctx.userId);

    const authorizeUrl = new URL("https://slack.com/oauth/v2/authorize");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("scope", SLACK_SCOPES);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", state);

    return NextResponse.redirect(authorizeUrl.toString());
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    console.error(err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
