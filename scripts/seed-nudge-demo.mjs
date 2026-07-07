// Demo-only helper: creates ONE nudge_schedules row for an existing org, so
// /api/cron/send-nudges has something to pick up during a demo.
//
// Deliberately NOT part of `npm run db:seed` / db/seed/*.sql: that path is
// strictly global reference data (the controls catalog) loaded with no
// assumption that any organization exists yet. nudge_schedules rows need a
// real org_id + org_control_id, which only exist once someone has actually
// signed up (userProvisioning.ts) and has org_controls instantiated -- there
// is no demo-org seeding path in this codebase, so this script looks up an
// existing org/control at runtime instead of hardcoding UUIDs.
//
// CRUD/UI for managing nudge_schedules is out of scope for this iteration
// (see the nudge-sender issue) -- this script is the only way to create one
// until that lands.
//
// Usage: node scripts/seed-nudge-demo.mjs <slack_channel_id> [cadence]
import "dotenv/config";
import pg from "pg";

const [, , slackChannelId, cadenceArg] = process.argv;
const cadence = cadenceArg ?? "weekly";

if (!slackChannelId) {
  console.error("Usage: node scripts/seed-nudge-demo.mjs <slack_channel_id> [cadence]");
  console.error("  cadence: weekly | biweekly | monthly (default: weekly)");
  process.exit(1);
}
if (!["weekly", "biweekly", "monthly"].includes(cadence)) {
  console.error(`Invalid cadence "${cadence}" -- must be weekly, biweekly, or monthly.`);
  process.exit(1);
}

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  console.error("DATABASE_ADMIN_URL is not set (see .env.example).");
  process.exit(1);
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  // Prefer an org that already has a Slack installation (nudge sending
  // needs a working bot token), and a control that isn't already
  // evidenced/reviewed (so the demo has something visible to do).
  const { rows } = await client.query(
    `select oc.id as org_control_id, oc.org_id
       from org_controls oc
       join slack_installations si on si.org_id = oc.org_id
      where oc.status not in ('evidenced', 'reviewed')
      order by oc.created_at asc
      limit 1`
  );

  const target = rows[0];
  if (!target) {
    console.error(
      "No eligible org_control found (needs an org with a Slack installation and a " +
        "not-yet-evidenced control). Connect Slack and create/import at least one " +
        "control for a demo org first."
    );
    process.exit(1);
  }

  const { rows: existing } = await client.query(
    `select id from nudge_schedules where org_control_id = $1`,
    [target.org_control_id]
  );
  if (existing[0]) {
    console.log(`nudge_schedules row already exists (${existing[0].id}) for this control -- skipping.`);
    process.exit(0);
  }

  const { rows: inserted } = await client.query(
    `insert into nudge_schedules (org_id, org_control_id, cadence, slack_channel_id)
     values ($1, $2, $3, $4)
     returning id`,
    [target.org_id, target.org_control_id, cadence, slackChannelId]
  );
  console.log(`Created nudge_schedules row ${inserted[0].id} (cadence: ${cadence}).`);
} finally {
  await client.end();
}
