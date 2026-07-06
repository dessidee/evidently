import { NextResponse } from "next/server";
import { z } from "zod";
import {
  ForbiddenError,
  PlanRequiredError,
  UnauthorizedError,
  getAuthContext,
  requireAdmin,
  requireOrgMatch,
  requirePlan,
} from "@/lib/auth/orgContext";
import { withOrgContext } from "@/lib/db/withOrgContext";

const bodySchema = z.object({
  framework: z.enum(["soc2", "iso27001"]),
});

/**
 * Creating a new readiness review is the ONLY thing gated by plan_tier.
 * Everything else -- evidence, org_controls progress, past reviews/findings,
 * the Slack bot itself -- stays fully readable regardless of plan_tier, by
 * deliberate product decision: a downgrade/cancellation never hides or
 * deletes data the org already accumulated, it only blocks starting a new
 * paid AI review run.
 *
 * The actual review generation (AI analysis) is not implemented yet -- this
 * just creates the 'pending' row a future worker will pick up.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const { orgId: pathOrgId } = await params;
    const ctx = await getAuthContext();
    requireOrgMatch(ctx, pathOrgId);
    requireAdmin(ctx);
    await requirePlan(ctx, "readiness_review");

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { framework } = parsed.data;

    const review = await withOrgContext(ctx.orgId, async (client) => {
      const { rows } = await client.query(
        `insert into readiness_reviews (org_id, framework, requested_by)
         values ($1, $2, $3)
         returning id`,
        [ctx.orgId, framework, ctx.userId]
      );
      await client.query(
        `insert into audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1, $2, 'readiness_review.requested', 'readiness_review', $3, $4::jsonb)`,
        [ctx.orgId, ctx.userId, rows[0].id, JSON.stringify({ framework })]
      );
      return rows[0];
    });

    return NextResponse.json({ reviewId: review.id }, { status: 201 });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof PlanRequiredError) {
      return NextResponse.json({ error: err.message }, { status: 402 });
    }
    console.error(err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
