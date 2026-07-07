-- Slack handlers: /evidence-request, /evidence-link, /events, /interactions.
-- See docs/specs (gstack) for the full design; summary of what's here:
--
-- 1. lookup_org_by_slack_team_id: resolves org_id from a Slack payload's
--    team_id, before we know which org's RLS context to set -- same
--    chicken-and-egg problem lookup_user_by_clerk_id solves for Clerk.
--
-- 2. slack_link_tokens: single-use tokens for the /evidence-link flow, which
--    binds a Slack user_id to a users.id row. Deliberately NOT modeled as a
--    signed/stateless token (like src/lib/slack/state.ts's OAuth state) --
--    that idiom has no way to enforce single-use, only expiry, which isn't
--    strong enough for something that writes a persistent identity binding.
--    Consumption is an atomic conditional UPDATE (see
--    src/lib/slack/linkTokens.ts) in the same transaction as the
--    users.slack_user_id write, so a token can never be claimed twice.
--
-- 3. users_slack_user_id_unique: prevents two different users rows (in the
--    same or different orgs) from ever being linked to the same Slack
--    member id.

create or replace function lookup_org_by_slack_team_id(p_slack_team_id text)
returns table (org_id uuid)
language sql
security definer
set search_path = public
as $$
  select org_id from slack_installations where slack_team_id = p_slack_team_id;
$$;

revoke all on function lookup_org_by_slack_team_id(text) from public;
grant execute on function lookup_org_by_slack_team_id(text) to app_user;

alter table users
  add constraint users_slack_user_id_unique unique (slack_user_id);

-- Global/reference-style table (like stripe_webhook_events): no RLS, because
-- the callback that consumes a token runs before we know which org's RLS
-- context to use -- resolving org_id is exactly what consuming the token
-- gives us. The app enforces the single-use/expiry condition in the query
-- itself (see linkTokens.ts), the same way stripe_webhook_events relies on
-- INSERT ... ON CONFLICT DO NOTHING rather than RLS for its guarantee.
create table slack_link_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash bytea not null unique,
  org_id uuid not null references organizations(id) on delete restrict,
  slack_team_id text not null,
  slack_user_id text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index slack_link_tokens_org_id_idx on slack_link_tokens(org_id);

grant select, insert, update on slack_link_tokens to app_user;
