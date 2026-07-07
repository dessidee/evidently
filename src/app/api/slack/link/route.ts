import { NextResponse } from "next/server";
import { UnauthorizedError, getAuthContext } from "@/lib/auth/orgContext";
import { consumeLinkToken } from "@/lib/slack/linkTokens";
import { withOrgContext } from "@/lib/db/withOrgContext";

/**
 * The /evidence-link self-service flow's web half: the signed-in user
 * clicks the ephemeral link Slack showed them (from /evidence-link),
 * landing here. Not listed in middleware.ts's public-route matcher, so
 * clerkMiddleware's auth.protect() already guarantees a signed-in session
 * before this handler runs -- getAuthContext() below resolves which
 * Evidently org/user that session maps to.
 *
 * consumeLinkToken enforces single-use atomically (see linkTokens.ts); this
 * handler must not write users.slack_user_id unless it returns a row.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }

  let ctx: Awaited<ReturnType<typeof getAuthContext>>;
  try {
    ctx = await getAuthContext();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const consumed = await consumeLinkToken(token);
  if (!consumed) {
    return NextResponse.redirect(new URL("/dashboard?slack=link_invalid", req.url));
  }

  // Belt-and-suspenders: the token was minted for a specific org, and
  // consumeLinkToken already scoped its lookup to that token's own row, but
  // this makes the cross-org invariant explicit here too -- never let a
  // token minted for org A link a Slack user id under org B's session.
  if (consumed.orgId !== ctx.orgId) {
    return NextResponse.redirect(new URL("/dashboard?slack=link_org_mismatch", req.url));
  }

  try {
    await withOrgContext(ctx.orgId, async (client) => {
      await client.query("update users set slack_user_id = $1 where id = $2", [
        consumed.slackUserId,
        ctx.userId,
      ]);
      await client.query(
        `insert into audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1, $2, 'slack.user_linked', 'user', $2, $3::jsonb)`,
        [ctx.orgId, ctx.userId, JSON.stringify({ slackUserId: consumed.slackUserId })]
      );
    });
  } catch (err) {
    // users_slack_user_id_unique (0004_slack_handlers.sql): this Slack
    // member id is already linked to a different users row.
    if ((err as { code?: string }).code === "23505") {
      return NextResponse.redirect(new URL("/dashboard?slack=link_already_used", req.url));
    }
    throw err;
  }

  return NextResponse.redirect(new URL("/dashboard?slack=linked", req.url));
}
