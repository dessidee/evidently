import { NextResponse } from "next/server";
import { z } from "zod";
import {
  ForbiddenError,
  UnauthorizedError,
  getAuthContext,
  requireAdmin,
  requireOrgMatch,
} from "@/lib/auth/orgContext";
import { withOrgContext } from "@/lib/db/withOrgContext";

const bodySchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"]).default("member"),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const { orgId: pathOrgId } = await params;

    // ctx.orgId is resolved server-side from the Clerk session (see
    // getAuthContext). pathOrgId is only used to sanity-check the URL
    // against that session -- it is never itself the authorization source
    // or what gets passed into withOrgContext below.
    const ctx = await getAuthContext();
    requireOrgMatch(ctx, pathOrgId);
    requireAdmin(ctx);

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { email, role } = parsed.data;

    const invite = await withOrgContext(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `insert into invites (org_id, email, role, invited_by)
         values ($1, $2, $3, $4)
         on conflict (org_id, email) do update set role = excluded.role
         returning id`,
        [ctx.orgId, email, role, ctx.userId]
      );
      await client.query(
        `insert into audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1, $2, 'user.invited', 'invite', $3, $4::jsonb)`,
        [ctx.orgId, ctx.userId, rows[0].id, JSON.stringify({ email, role })]
      );
      return rows[0];
    });

    return NextResponse.json({ inviteId: invite.id }, { status: 201 });
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
