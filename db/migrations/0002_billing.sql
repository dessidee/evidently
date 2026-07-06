-- Evidently: Stripe billing
-- Adds subscription state to organizations and a dedup table for webhook
-- delivery. See README for the full design rationale.

alter table organizations
  add column stripe_customer_id text unique,
  add column stripe_subscription_id text unique,
  add column subscription_status text
    check (subscription_status in (
      'trialing', 'active', 'past_due', 'canceled',
      'unpaid', 'incomplete', 'incomplete_expired', 'paused'
    )),
  add column stripe_price_id text,
  add column cancel_at_period_end boolean not null default false,
  add column current_period_end timestamptz,
  -- Stripe does not guarantee webhook delivery order. We only ever apply a
  -- subscription update if its event.created is newer than the last one we
  -- applied, so a delayed/out-of-order event can't stomp newer state.
  add column stripe_last_event_at timestamptz;

create index organizations_stripe_customer_id_idx on organizations(stripe_customer_id);

-- Global/reference-level table (like `controls`): no RLS, because webhook
-- processing runs before we know which org an event belongs to -- that's
-- exactly the lookup this table's sibling logic (stripe_customer_id on
-- organizations) resolves. Keyed by Stripe's own event.id, which is unique
-- per logical event even across Stripe's at-least-once retried deliveries.
create table stripe_webhook_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);

grant select, insert on stripe_webhook_events to app_user;
