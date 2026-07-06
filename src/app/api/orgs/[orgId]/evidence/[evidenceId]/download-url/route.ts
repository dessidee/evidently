import { NextResponse } from "next/server";
import {
  ForbiddenError,
  UnauthorizedError,
  getAuthContext,
  requireOrgMatch,
} from "@/lib/auth/orgContext";
import { withOrgContext } from "@/lib/db/withOrgContext";
import { createSignedDownloadUrl } from "@/lib/storage/evidenceStorage";

const DOWNLOAD_URL_TTL_SECONDS = 60;

/**
 * Mints a short-lived signed download URL on demand. Never returned inline
 * from the evidence list endpoint (GET .../evidence) -- see that route's
 * comment for why.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string; evidenceId: string }> }
) {
  try {
    const { orgId: pathOrgId, evidenceId } = await params;
    const ctx = await getAuthContext();
    requireOrgMatch(ctx, pathOrgId);

    const storagePath = await withOrgContext(ctx.orgId, async (client) => {
      // RLS scopes this to the current org, so evidence belonging to another
      // org (or a soft-deleted row) simply returns no rows -- fail closed.
      const { rows } = await client.query<{ storage_path: string | null }>(
        `select storage_path from evidence
         where id = $1 and deleted_at is null`,
        [evidenceId]
      );
      return rows[0]?.storage_path ?? null;
    });

    if (!storagePath) {
      return NextResponse.json({ error: "Evidence not found or has no file" }, { status: 404 });
    }

    const downloadUrl = await createSignedDownloadUrl(storagePath, DOWNLOAD_URL_TTL_SECONDS);
    return NextResponse.json({ downloadUrl, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS });
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
