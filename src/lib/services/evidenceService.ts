import { withOrgContext } from "@/lib/db/withOrgContext";
import { createSignedUploadUrl } from "@/lib/storage/evidenceStorage";

export interface CreateEvidenceInput {
  orgId: string;
  userId: string;
  orgControlId: string;
  type: "file" | "screenshot" | "link" | "text_note";
  description?: string;
  periodStart?: string;
  periodEnd?: string;
  fileName?: string;
  externalUrl?: string;
  submittedVia: "web" | "slack";
}

export type CreateEvidenceResult =
  | { notFound: true }
  | {
      notFound: false;
      evidenceId: string;
      upload: { uploadUrl: string; token: string } | null;
    };

function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * Creates an evidence row (optionally minting a signed Storage upload URL
 * for file/screenshot types) and writes the audit_log entry. Extracted out
 * of the HTTP route (src/app/api/orgs/[orgId]/evidence/route.ts) so it can
 * also be called in-process from the Slack view_submission handler --
 * mirrors the userProvisioning.ts precedent (a plain callable service, no
 * getAuthContext() inside, caller resolves orgId/userId first) used by the
 * Clerk webhook, rather than the Slack handler making an HTTP call back to
 * this same Next.js server.
 */
export async function createEvidence(
  input: CreateEvidenceInput
): Promise<CreateEvidenceResult> {
  const {
    orgId,
    userId,
    orgControlId,
    type,
    description,
    periodStart,
    periodEnd,
    fileName,
    externalUrl,
    submittedVia,
  } = input;

  return withOrgContext(orgId, async (client) => {
    // org_controls has RLS, so with app.current_org_id set to orgId this
    // SELECT only finds the row if it actually belongs to this org -- unlike
    // the evidence.org_control_id foreign key constraint alone, which runs
    // as the table owner and would NOT reject a reference to another org's
    // org_controls row. This check is what actually enforces the tenant
    // boundary here.
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
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        orgId,
        orgControlId,
        userId,
        type,
        description ?? null,
        periodStart ?? null,
        periodEnd ?? null,
        externalUrl ?? null,
        submittedVia,
      ]
    );
    const evidenceId: string = rows[0].id;

    let upload: { uploadUrl: string; token: string } | null = null;
    if (type === "file" || type === "screenshot") {
      const objectKey = `${orgId}/${orgControlId}/${evidenceId}-${sanitizeFileName(fileName!)}`;
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
      [orgId, userId, evidenceId, JSON.stringify({ type, orgControlId, submittedVia })]
    );

    return { notFound: false as const, evidenceId, upload };
  });
}
