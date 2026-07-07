import { pgPool } from "@/lib/db/pool";
import { withOrgContext } from "@/lib/db/withOrgContext";

/**
 * Resolves org_id from a Slack payload's team_id, via the
 * lookup_org_by_slack_team_id SECURITY DEFINER function -- same
 * chicken-and-egg rationale as lookup_user_by_clerk_id in orgContext.ts:
 * we don't yet know which org's RLS context to set, that's exactly what
 * this resolves. slack_installations is RLS-protected and tenant-scoped,
 * so a plain query here (without org context) would always return zero
 * rows.
 */
export async function resolveOrgIdBySlackTeam(slackTeamId: string): Promise<string | null> {
  const { rows } = await pgPool.query<{ org_id: string }>(
    "select org_id from lookup_org_by_slack_team_id($1)",
    [slackTeamId]
  );
  return rows[0]?.org_id ?? null;
}

export interface LinkedSlackUser {
  userId: string;
  role: "admin" | "member";
}

/**
 * Once org_id is known (via resolveOrgIdBySlackTeam above), this is a normal
 * RLS-scoped lookup for the users row linked to a given Slack member id via
 * the /evidence-link flow. Returns null if that Slack user hasn't linked an
 * account in this org yet.
 */
export async function resolveLinkedSlackUser(
  orgId: string,
  slackUserId: string
): Promise<LinkedSlackUser | null> {
  const rows = await withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ id: string; role: "admin" | "member" }>(
      "select id, role from users where slack_user_id = $1",
      [slackUserId]
    );
    return rows;
  });
  const row = rows[0];
  return row ? { userId: row.id, role: row.role } : null;
}
