-- Evidently: initial schema + multi-tenant RLS
-- Apply with an account that has CREATEROLE/superuser privileges (e.g. Supabase SQL editor).
-- The application itself connects as `app_user`, a least-privilege, non-superuser,
-- non-BYPASSRLS role -- RLS is enforced for every query the app runs.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Least-privilege application role.
-- Password is NOT set here (never commit secrets). Set it out-of-band, e.g.:
--   ALTER ROLE app_user WITH PASSWORD '<from secret manager>';
-- and put the resulting connection string in DATABASE_URL (.env, never git).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select from pg_roles where rolname = 'app_user') then
    create role app_user with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end
$$;

grant usage on schema public to app_user;

-- ---------------------------------------------------------------------------
-- Reference data (global, not tenant-scoped). Read-only for the app.
-- ---------------------------------------------------------------------------
create table controls (
  id uuid primary key default gen_random_uuid(),
  framework text not null check (framework in ('soc2', 'iso27001')),
  code text not null,
  title text not null,
  description text not null,
  category text not null,
  created_at timestamptz not null default now(),
  unique (framework, code)
);

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan_tier text not null default 'free' check (plan_tier in ('free', 'readiness_review')),
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete restrict,
  clerk_user_id text not null unique,
  email text not null,
  slack_user_id text,
  role text not null default 'member' check (role in ('admin', 'member')),
  created_at timestamptz not null default now()
);

create index users_org_id_idx on users(org_id);

-- Pending invitations, looked up by email during Clerk signup webhook
-- handling (before the new user has an org_id at all).
create table invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete restrict,
  email text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  invited_by uuid not null references users(id) on delete restrict,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, email)
);

-- ---------------------------------------------------------------------------
-- Tenant-scoped tables. Every one of these gets RLS enabled below.
-- ---------------------------------------------------------------------------
create table org_controls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete restrict,
  control_id uuid not null references controls(id) on delete restrict,
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'evidenced', 'reviewed')),
  owner_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, control_id)
);

create table evidence (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete restrict,
  org_control_id uuid not null references org_controls(id) on delete restrict,
  uploaded_by uuid not null references users(id) on delete restrict,
  type text not null check (type in ('file', 'screenshot', 'link', 'text_note')),
  storage_path text,
  description text,
  period_start date,
  period_end date,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create index evidence_org_control_idx on evidence(org_control_id);
create index evidence_org_id_idx on evidence(org_id);

create table slack_installations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete restrict,
  slack_team_id text not null unique,
  bot_access_token_encrypted bytea not null,
  bot_user_id text not null,
  scopes text not null,
  installed_by uuid not null references users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table nudge_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete restrict,
  org_control_id uuid not null references org_controls(id) on delete restrict,
  cadence text not null check (cadence in ('weekly', 'biweekly', 'monthly')),
  slack_channel_id text not null,
  last_sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table readiness_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete restrict,
  framework text not null check (framework in ('soc2', 'iso27001')),
  requested_by uuid not null references users(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table readiness_review_findings (
  id uuid primary key default gen_random_uuid(),
  -- org_id is denormalized from readiness_reviews so RLS policies below don't
  -- need a join/subquery on every row check.
  org_id uuid not null references organizations(id) on delete restrict,
  review_id uuid not null references readiness_reviews(id) on delete cascade,
  control_id uuid not null references controls(id) on delete restrict,
  gap_description text not null,
  severity text not null check (severity in ('none', 'minor', 'major', 'critical')),
  recommendation text,
  created_at timestamptz not null default now()
);

create index findings_review_id_idx on readiness_review_findings(review_id);

-- Append-only audit trail. This is the same guarantee the product sells to
-- customers, so it must hold for Evidently's own data too.
create table audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete restrict,
  actor_user_id uuid references users(id) on delete set null, -- null = system/bot action
  action text not null,
  target_type text not null,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);

create index audit_log_org_id_idx on audit_log(org_id);
create index audit_log_created_at_idx on audit_log(created_at);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Every tenant-scoped query must run inside a transaction that has first
-- called: select set_config('app.current_org_id', $1, true)  -- true = local
-- to the transaction. See src/lib/db/withOrgContext.ts. `current_setting(...,
-- true)` returns NULL if unset, so with no context set, every policy below
-- evaluates to false and zero rows are visible/writable (fail closed).
-- ---------------------------------------------------------------------------

alter table users enable row level security;
alter table invites enable row level security;
alter table org_controls enable row level security;
alter table evidence enable row level security;
alter table slack_installations enable row level security;
alter table nudge_schedules enable row level security;
alter table readiness_reviews enable row level security;
alter table readiness_review_findings enable row level security;
alter table audit_log enable row level security;

alter table users force row level security;
alter table invites force row level security;
alter table org_controls force row level security;
alter table evidence force row level security;
alter table slack_installations force row level security;
alter table nudge_schedules force row level security;
alter table readiness_reviews force row level security;
alter table readiness_review_findings force row level security;
alter table audit_log force row level security;

create policy tenant_isolation on users
  using (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

create policy tenant_isolation on invites
  using (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

create policy tenant_isolation on org_controls
  using (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

create policy tenant_isolation on evidence
  using (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

create policy tenant_isolation on slack_installations
  using (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

create policy tenant_isolation on nudge_schedules
  using (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

create policy tenant_isolation on readiness_reviews
  using (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

create policy tenant_isolation on readiness_review_findings
  using (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- audit_log: readable within tenant context, but INSERT-only at the grant
-- level (see below) -- no UPDATE/DELETE policy exists at all, so even a role
-- with a bug that tries to update/delete is blocked twice over.
create policy tenant_isolation_select on audit_log
  for select
  using (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

create policy tenant_isolation_insert on audit_log
  for insert
  with check (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Grants for app_user: least privilege, and defense-in-depth on audit_log.
-- ---------------------------------------------------------------------------
grant select on controls to app_user;

grant select, insert, update on organizations to app_user;
grant select, insert, update on users to app_user;
grant select, insert, update on invites to app_user;
grant select, insert, update on org_controls to app_user;
grant select, insert, update on evidence to app_user; -- delete is soft (deleted_at), never hard-deleted by the app
grant select, insert on slack_installations to app_user; -- tokens are rotated via insert+delete by an admin service path only
grant select, insert, update, delete on nudge_schedules to app_user;
grant select, insert, update on readiness_reviews to app_user;
grant select, insert on readiness_review_findings to app_user;

-- audit_log: INSERT + SELECT only. No UPDATE, no DELETE, ever, for the app role.
grant select, insert on audit_log to app_user;

-- ---------------------------------------------------------------------------
-- Narrow SECURITY DEFINER lookup used ONLY to resolve org_id/role from a
-- clerk_user_id before any app.current_org_id is known (chicken-and-egg:
-- RLS on `users` requires org context, but we don't have it yet on the very
-- first query of a request). Executes with the privileges of whichever role
-- applies this migration (must NOT be app_user), so it bypasses RLS -- but
-- only for this single, parameterized, single-row-shape lookup. It is not a
-- general escape hatch: app_user has no other way to read across tenants.
-- ---------------------------------------------------------------------------
create or replace function lookup_user_by_clerk_id(p_clerk_user_id text)
returns table (org_id uuid, id uuid, role text)
language sql
security definer
set search_path = public
as $$
  select org_id, id, role from users where clerk_user_id = p_clerk_user_id;
$$;

revoke all on function lookup_user_by_clerk_id(text) from public;
grant execute on function lookup_user_by_clerk_id(text) to app_user;

-- Same rationale as above: look up a pending invite by email before the
-- invitee has an org_id/users row of their own. Only returns unaccepted
-- invites, and only the columns needed to attach the new user to the
-- right org with the right role.
create or replace function lookup_invite_by_email(p_email text)
returns table (id uuid, org_id uuid, role text)
language sql
security definer
set search_path = public
as $$
  select id, org_id, role
  from invites
  where email = p_email and accepted_at is null
  order by created_at desc
  limit 1;
$$;

revoke all on function lookup_invite_by_email(text) from public;
grant execute on function lookup_invite_by_email(text) to app_user;
