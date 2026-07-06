import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Lazy singleton, same pattern as src/lib/db/pool.ts and src/lib/stripe/client.ts
// -- initialized on first actual use, not at module-import time, so merely
// importing this module (e.g. transitively, in a test that mocks
// evidenceStorage.ts entirely) doesn't require SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
// to be set.
declare global {
  var __evidentlySupabaseClient: SupabaseClient | undefined;
}

function createSupabaseClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set");
  }
  // The service-role key bypasses Storage access policies entirely and must
  // never be sent to the browser. This client is only ever used server-side
  // to mint short-lived signed URLs -- the actual file bytes never pass
  // through our server (see src/lib/storage/evidenceStorage.ts).
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

function getSupabaseClient(): SupabaseClient {
  if (!globalThis.__evidentlySupabaseClient) {
    globalThis.__evidentlySupabaseClient = createSupabaseClient();
  }
  return globalThis.__evidentlySupabaseClient;
}

export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getSupabaseClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
