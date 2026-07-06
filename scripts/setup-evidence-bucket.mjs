// Creates (or updates) the private Supabase Storage bucket evidence files
// are uploaded to, with the size/MIME limits agreed for the product.
//
// Run manually against a real Supabase project -- this is NOT part of CI.
// CI never talks to a real Storage backend; tests/evidence-upload.test.ts
// injects a fake storage client instead (see that file's top-of-file
// comment for why that boundary, specifically, can't reasonably be
// exercised for real in every test run).
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_EVIDENCE_BUCKET ?? "evidence";

if (!url || !serviceRoleKey) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.");
  process.exit(1);
}

const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];
const FILE_SIZE_LIMIT_BYTES = 25 * 1024 * 1024; // 25MB

const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

const { data: existing } = await supabase.storage.getBucket(bucket);

const bucketOptions = {
  public: false,
  fileSizeLimit: FILE_SIZE_LIMIT_BYTES,
  allowedMimeTypes: ALLOWED_MIME_TYPES,
};

if (existing) {
  const { error } = await supabase.storage.updateBucket(bucket, bucketOptions);
  if (error) {
    console.error(`Failed to update bucket '${bucket}':`, error.message);
    process.exit(1);
  }
  console.log(`Updated bucket '${bucket}' (private, 25MB limit, restricted MIME types).`);
} else {
  const { error } = await supabase.storage.createBucket(bucket, bucketOptions);
  if (error) {
    console.error(`Failed to create bucket '${bucket}':`, error.message);
    process.exit(1);
  }
  console.log(`Created bucket '${bucket}' (private, 25MB limit, restricted MIME types).`);
}
