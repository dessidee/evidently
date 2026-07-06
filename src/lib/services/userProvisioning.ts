import { pgPool } from "@/lib/db/pool";
import { withOrgContext } from "@/lib/db/withOrgContext";

/**
 * Called only from the (signature-verified) Clerk webhook, never from a
 * client request. clerkUserId/email come from Clerk's verified payload, not
 * from anything a browser sent us. org_id itself is always resolved here,
 * server-side, from either an existing invite (by email) or by minting a
 * brand-new organization -- it is never accepted as input.
 */
export async function provisionUserOnSignup(input: {
  clerkUserId: string;
  email: string;
}): Promise<{ orgId: string; userId: string; role: "admin" | "member" }> {
  const { rows: inviteRows } = await pgPool.query<{
    id: string;
    org_id: string;
    role: "admin" | "member";
  }>("select id, org_id, role from lookup_invite_by_email($1)", [input.email]);

  const invite = inviteRows[0];

  if (invite) {
    return withOrgContext(invite.org_id, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into users (org_id, clerk_user_id, email, role)
         values ($1, $2, $3, $4)
         returning id`,
        [invite.org_id, input.clerkUserId, input.email, invite.role]
      );
      await client.query("update invites set accepted_at = now() where id = $1", [
        invite.id,
      ]);
      await client.query(
        `insert into audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1, $2, 'user.invite_accepted', 'user', $2, $3::jsonb)`,
        [invite.org_id, rows[0].id, JSON.stringify({ email: input.email })]
      );
      return { orgId: invite.org_id, userId: rows[0].id, role: invite.role };
    });
  }

  // No pending invite: this signup mints a brand-new organization and the
  // signer becomes its first admin. organizations has no RLS (it's the
  // tenant root), so this insert doesn't need an org context yet.
  const { rows: orgRows } = await pgPool.query<{ id: string }>(
    "insert into organizations (name) values ($1) returning id",
    [`${input.email.split("@")[0]}'s workspace`]
  );
  const orgId = orgRows[0].id;

  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into users (org_id, clerk_user_id, email, role)
       values ($1, $2, $3, 'admin')
       returning id`,
      [orgId, input.clerkUserId, input.email]
    );
    await client.query(
      `insert into audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
       values ($1, $2, 'organization.created', 'organization', $3, '{}'::jsonb)`,
      [orgId, rows[0].id, orgId]
    );
    return { orgId, userId: rows[0].id, role: "admin" as const };
  });
}
