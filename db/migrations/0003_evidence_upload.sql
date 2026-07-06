-- Evidence upload API: tracks how evidence was submitted (web upload form vs
-- the Slack bot), and adds a dedicated column for link-type evidence instead
-- of overloading `description` with two different meanings (a human note vs
-- the actual link target).

alter table evidence
  add column submitted_via text not null default 'web' check (submitted_via in ('web', 'slack')),
  add column external_url text;

-- external_url is required for (and only meaningful for) type='link'. Every
-- other evidence type must leave it null. Enforced at the DB level rather
-- than trusted to the app layer alone.
alter table evidence
  add constraint evidence_external_url_requires_link_type
    check ((type = 'link') = (external_url is not null));
