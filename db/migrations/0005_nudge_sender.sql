-- Scheduled nudge sender: reads nudge_schedules that are due for their
-- cadence, skips org_controls already evidenced/reviewed, and posts a Slack
-- reminder (with a "Request Evidence" button) to the schedule's channel.
-- See docs/specs (gstack) for the full design; summary of what's here:
--
-- 1. cadence_interval: single source of truth for the cadence -> interval
--    mapping (weekly/biweekly/monthly). Used by BOTH get_due_nudge_schedules
--    below (to compute which schedules are due) and the claim UPDATE in
--    src/lib/slack/nudges.ts (to re-check due-ness atomically at send time).
--    Extracted so this mapping can't drift between the two call sites, same
--    reasoning as the evidenceService extraction.
--
-- 2. get_due_nudge_schedules: resolves due schedules across all orgs before
--    we know which org's RLS context to set -- same chicken-and-egg problem
--    lookup_user_by_clerk_id and lookup_org_by_slack_team_id solve. The
--    actual send loop then runs each schedule's claim + read + write inside
--    withOrgContext(schedule.org_id, ...).
--
-- No new grants or RLS policy needed on nudge_schedules itself: RLS is
-- already enabled+forced from 0001_init.sql, and app_user already has
-- select/insert/update/delete on it.

create or replace function cadence_interval(cadence text)
returns interval
language sql
immutable
as $$
  select case cadence
    when 'weekly' then interval '7 days'
    when 'biweekly' then interval '14 days'
    when 'monthly' then interval '1 month'
  end;
$$;

create or replace function get_due_nudge_schedules()
returns table (
  id uuid,
  org_id uuid,
  org_control_id uuid,
  cadence text,
  slack_channel_id text,
  last_sent_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select ns.id, ns.org_id, ns.org_control_id, ns.cadence, ns.slack_channel_id, ns.last_sent_at
  from nudge_schedules ns
  where ns.last_sent_at is null
     or ns.last_sent_at + cadence_interval(ns.cadence) <= now();
$$;

revoke all on function get_due_nudge_schedules() from public;
grant execute on function get_due_nudge_schedules() to app_user;
