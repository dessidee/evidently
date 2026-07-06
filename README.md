# Evidently

Compliance evidence collection (Slack bot) + AI-assisted SOC 2 / ISO 27001
readiness review, for small startups preparing for their first audit.

## Stack

Next.js (App Router, TypeScript) + Postgres (Supabase-compatible, RLS) + Clerk
(auth) + Slack SDK + Stripe + Claude API.

## Security-critical design decisions

These are load-bearing for a compliance product and should not be changed
without re-reading the reasoning below.

1. **`org_id` is never trusted from the client.** Every route resolves the
   caller's org via `getAuthContext()` (`src/lib/auth/orgContext.ts`), which
   looks up `org_id`/`role` server-side from the verified Clerk session. Route
   path segments like `/api/orgs/[orgId]/...` exist for readability only --
   `requireOrgMatch` rejects requests where they don't match the session, but
   the value actually used for authorization and RLS is always the
   server-resolved `ctx.orgId`.

2. **RLS tenant isolation is safe under connection pooling.**
   `src/lib/db/withOrgContext.ts` sets `app.current_org_id` via
   `set_config(..., true)` (transaction-local, like `SET LOCAL`) inside an
   explicit `BEGIN`/`COMMIT` held on a single checked-out `PoolClient`. This
   is safe with PgBouncer/Supabase-pooler transaction-mode pooling and with
   our own small `pg.Pool`, because the setting is guaranteed to be cleared
   at the end of the transaction regardless of what the physical connection
   is reused for next. A bare `SET app.current_org_id = ...` (session-level)
   would NOT be safe here -- it would persist on the connection and could
   leak one tenant's context into the next request that reuses it.
   `tests/rls-pooling.test.ts` proves this with 40 interleaved requests for
   two different orgs through a 2-connection pool.

3. **`audit_log` is append-only** at the database grant level (`app_user` has
   `INSERT, SELECT` only -- no `UPDATE`/`DELETE` grant, and no policy for
   them either), since this is the same guarantee the product sells to
   customers.

4. **Two SQL `SECURITY DEFINER` functions** (`lookup_user_by_clerk_id`,
   `lookup_invite_by_email`) are the only places RLS is intentionally
   bypassed -- narrowly, for the one legitimate case where we must resolve a
   user's org before any tenant context exists yet (first request of a
   session, or invite acceptance during signup).

## Setup

1. `cp .env.example .env.local` and fill in values (see comments in that file
   for how to generate the Slack OAuth state secret and token encryption key).
2. Provision a Postgres instance (e.g. `supabase start` locally, or a Supabase
   project). Set `DATABASE_ADMIN_URL` to an owner/superuser connection string.
3. `npm run db:migrate` -- applies `db/migrations/0001_init.sql` (creates
   schema, RLS policies, the `app_user` role).
4. Set `app_user`'s password (not done by the migration, since secrets don't
   belong in SQL files that might get committed):
   ```sql
   ALTER ROLE app_user WITH PASSWORD '<generate one>';
   ```
   Then set `DATABASE_URL` in `.env.local` to that role's connection string.
5. `npm run db:seed` -- loads the SOC 2 Common Criteria controls catalog.
6. `npm run dev`.

## Tests

```
npm run test
```

`tests/rls-pooling.test.ts` needs a real Postgres with the schema applied;
set `TEST_ADMIN_DATABASE_URL` / `TEST_DATABASE_URL` in `.env.local` (point
these at a disposable local DB, never prod). The suite skips itself if those
aren't set.

## Status

Week 1 (this scaffold): schema + RLS, Clerk signup -> org provisioning,
Slack OAuth install flow, invite endpoint.

Not yet built: evidence upload UI/API, nudge scheduler, AI readiness review,
Stripe billing, Slack slash-command/interaction handlers (events/commands
routes are referenced in middleware as public but not yet implemented).
