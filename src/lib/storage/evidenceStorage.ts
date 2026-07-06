import { supabase } from "./client";

const BUCKET = process.env.SUPABASE_EVIDENCE_BUCKET ?? "evidence";

export interface SignedUploadUrl {
  path: string;
  signedUrl: string;
  token: string;
}

/**
 * Mints a signed upload URL for a brand-new object at `path`. The browser
 * uploads the file bytes directly to `signedUrl` (or via the Supabase JS
 * client's `uploadToSignedUrl` helper using `token`) -- file bytes never
 * pass through our Next.js server, avoiding request body size limits and
 * timeouts on serverless routes.
 *
 * This function (and createSignedDownloadUrl below) is the one external
 * boundary that tests/evidence-upload.test.ts replaces with a deterministic
 * fake via vi.mock -- unlike Stripe's webhook signature, there is no local/
 * offline equivalent of a real Supabase Storage signed-URL call. Everything
 * else in that test (Postgres, RLS, the actual route handlers) is real.
 */
export async function createSignedUploadUrl(path: string): Promise<SignedUploadUrl> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) {
    throw new Error(`Failed to create signed upload URL: ${error.message}`);
  }
  return { path: data.path, signedUrl: data.signedUrl, token: data.token };
}

/**
 * Mints a short-lived signed download URL for an existing object. Always
 * generated fresh on demand (see GET /evidence/[evidenceId]/download-url) --
 * never stored in the DB or returned inline from the evidence list endpoint,
 * so a cached/logged list response can't leak a working download link.
 */
export async function createSignedDownloadUrl(
  path: string,
  expiresInSeconds: number
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) {
    throw new Error(`Failed to create signed download URL: ${error.message}`);
  }
  return data.signedUrl;
}
