import { auth } from "@clerk/nextjs/server";
import { pgPool } from "@/lib/db/pool";

export class UnauthorizedError extends Error {}
export class ForbiddenError extends Error {}

export interface AuthContext {
  orgId: string;
  userId: string;
  role: "admin" | "member";
}

/**
 * Resolves the caller's org_id and role SERVER-SIDE from the authenticated
 * Clerk session only. The client never supplies org_id for authorization
 * purposes -- even though routes are shaped like /api/orgs/[orgId]/..., that
 * path segment is NEVER trusted as the tenant boundary. It is only used (by
 * requireOrgMatch below) to catch the case where a signed-in user's URL
 * doesn't match their actual org, in which case we reject rather than
 * silently substitute the "real" one.
 *
 * This query runs against the reference `users` table via the raw pool
 * (not withOrgContext) because at this point we don't yet know the caller's
 * org_id -- that's exactly what we're looking up. `users` RLS still applies,
 * but with no app.current_org_id set the policy fails closed (0 rows)
 * *unless* we bypass it here specifically for this one lookup keyed by the
 * globally-unique, server-verified clerk_user_id. We do this with a
 * SECURITY DEFINER function so app_user never needs a broader grant.
 */
export async function getAuthContext(): Promise<AuthContext> {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) {
    throw new UnauthorizedError("Not signed in");
  }

  const { rows } = await pgPool.query<{
    org_id: string;
    id: string;
    role: "admin" | "member";
  }>("select org_id, id, role from lookup_user_by_clerk_id($1)", [clerkUserId]);

  const row = rows[0];
  if (!row) {
    throw new UnauthorizedError("No Evidently account for this session");
  }

  return { orgId: row.org_id, userId: row.id, role: row.role };
}

/**
 * Call this in any route that has an [orgId] path segment. Confirms the
 * server-resolved org (from the session) matches the URL for a sane error
 * message, but authorization and RLS context always use ctx.orgId, never
 * the raw path param.
 */
export function requireOrgMatch(ctx: AuthContext, pathOrgId: string): void {
  if (ctx.orgId !== pathOrgId) {
    throw new ForbiddenError("Path org does not match authenticated session");
  }
}

export function requireAdmin(ctx: AuthContext): void {
  if (ctx.role !== "admin") {
    throw new ForbiddenError("Admin role required");
  }
}
