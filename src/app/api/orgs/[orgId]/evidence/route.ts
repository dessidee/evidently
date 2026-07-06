import { NextResponse } from "next/server";
import { z } from "zod";
import {
  ForbiddenError,
  UnauthorizedError,
  getAuthContext,
  requireOrgMatch,
} from "@/lib/auth/orgContext";
import { withOrgContext } from "@/lib/db/withOrgContext";
import { createSignedUploadUrl } from "@/lib/storage/evidenceStorage";

const bodySchema = z
  .object({
    orgControlId: z.string().uuid(),
    type: z.enum(["file", "screenshot", "link", "text_note"]),
    description: z.string().max(2000).optional(),
    periodStart: z.string().date().optional(),
    periodEnd: z.string().date().optional(),
    fileName: z.string().min(1).max(255).optional(),
    externalUrl: z.string().url().optional(),
  })
  .superRefine((body, ctx) => {
    if ((body.type === "file" || body.type === "screenshot") && !body.fileName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fileName is required for type 'file' or 'screenshot'",
        path: ["fileName"],
      });
    }
    if (body.type === "link" && !body.externalUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "externalUrl is required for type 'link'",
        path: ["externalUrl"],
      });
    }
    if (body.type !== "link" && body.externalUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "externalUrl is only allowed for type 'link'",
        path: ["externalUrl"],
      });
    }
  });

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

const listQuerySchema = z.object({
  orgControlId: z.string().uuid().optional(),
});

/**
 * Evidence upload is intentionally NOT admin-gated (contrast with
 * invite/route.ts and readiness-reviews/route.ts, which both call
 * requireAdmin). Any org member can submit evidence -- the core product
 * workflow is the Slack bot nudging individual contributors, not just
 * admins, to attach evidence to a control. Gating this on admin would break
 * that workflow entirely.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const { orgId: pathOrgId } = await params;
    const ctx = await getAuthContext();
    requireOrgMatch(ctx, pathOrgId);

    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { orgControlId, type, description, periodStart, periodEnd, fileName, externalUrl } =
      parsed.data;

    const result = await withOrgContext(ctx.orgId, async (client) => {
      // org_controls has RLS, so with app.current_org_id set to ctx.orgId
      // this SELECT only finds the row if it actually belongs to this org --
      // unlike the evidence.org_control_id foreign key constraint alone,
      // which runs as the table owner and would NOT reject a reference to
      // another org's org_controls row. This check is what actually enforces
      // the tenant boundary here.
      const { rows: ocRows } = await client.query(
        "select 1 from org_controls where id = $1",
        [orgControlId]
      );
      if (ocRows.length === 0) {
        return { notFound: true as const };
      }

      const { rows } = await client.query(
        `insert into evidence
           (org_id, org_control_id, uploaded_by, type, description, period_start, period_end,
            external_url, submitted_via)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'web')
         returning id`,
        [
          ctx.orgId,
          orgControlId,
          ctx.userId,
          type,
          description ?? null,
          periodStart ?? null,
          periodEnd ?? null,
          externalUrl ?? null,
        ]
      );
      const evidenceId: string = rows[0].id;

      let upload: { uploadUrl: string; token: string } | null = null;
      if (type === "file" || type === "screenshot") {
        const objectKey = `${ctx.orgId}/${orgControlId}/${evidenceId}-${sanitizeFileName(fileName!)}`;
        const signed = await createSignedUploadUrl(objectKey);
        await client.query("update evidence set storage_path = $1 where id = $2", [
          signed.path,
          evidenceId,
        ]);
        upload = { uploadUrl: signed.signedUrl, token: signed.token };
      }

      await client.query(
        `insert into audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1, $2, 'evidence.created', 'evidence', $3, $4::jsonb)`,
        [ctx.orgId, ctx.userId, evidenceId, JSON.stringify({ type, orgControlId })]
      );

      return { notFound: false as const, evidenceId, upload };
    });

    if (result.notFound) {
      return NextResponse.json({ error: "orgControlId not found" }, { status: 404 });
    }

    return NextResponse.json(
      { evidenceId: result.evidenceId, ...(result.upload ? { upload: result.upload } : {}) },
      { status: 201 }
    );
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

/**
 * Lists evidence for the org (optionally filtered by orgControlId). Does not
 * return storage_path -- signed download URLs are minted on demand via
 * GET .../evidence/[evidenceId]/download-url instead, so a cached/logged
 * list response can never contain a working file link.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const { orgId: pathOrgId } = await params;
    const ctx = await getAuthContext();
    requireOrgMatch(ctx, pathOrgId);

    const url = new URL(req.url);
    const parsed = listQuerySchema.safeParse({
      orgControlId: url.searchParams.get("orgControlId") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { orgControlId } = parsed.data;

    const evidence = await withOrgContext(ctx.orgId, async (client) => {
      const { rows } = orgControlId
        ? await client.query(
            `select id, org_control_id, uploaded_by, type, description, period_start,
                    period_end, external_url, submitted_via, created_at
             from evidence
             where org_control_id = $1 and deleted_at is null
             order by created_at desc`,
            [orgControlId]
          )
        : await client.query(
            `select id, org_control_id, uploaded_by, type, description, period_start,
                    period_end, external_url, submitted_via, created_at
             from evidence
             where deleted_at is null
             order by created_at desc`
          );
      return rows;
    });

    return NextResponse.json({ evidence });
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
