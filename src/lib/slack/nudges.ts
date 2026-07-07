import type { PoolClient } from "pg";
import type { KnownBlock } from "@slack/types";
import { pgPool } from "@/lib/db/pool";
import { withOrgContext } from "@/lib/db/withOrgContext";
import { getSlackClientForOrg } from "./client";
import { REQUEST_EVIDENCE_ACTION_ID } from "./evidenceModal";

export interface DueNudgeSchedule {
  id: string;
  orgId: string;
  orgControlId: string;
  cadence: string;
  slackChannelId: string;
}

/**
 * Resolves schedules due for their cadence across ALL orgs, via the
 * get_due_nudge_schedules() SECURITY DEFINER function -- same
 * chicken-and-egg rationale as resolveOrgIdBySlackTeam in orgLookup.ts: we
 * don't yet know which org's RLS context each row needs, that's exactly
 * what this resolves. Everything after this point (per-schedule reads and
 * writes) runs inside withOrgContext(schedule.orgId, ...).
 */
export async function fetchDueNudgeSchedules(): Promise<DueNudgeSchedule[]> {
  const { rows } = await pgPool.query<{
    id: string;
    org_id: string;
    org_control_id: string;
    cadence: string;
    slack_channel_id: string;
  }>(
    "select id, org_id, org_control_id, cadence, slack_channel_id from get_due_nudge_schedules()"
  );
  return rows.map((row) => ({
    id: row.id,
    orgId: row.org_id,
    orgControlId: row.org_control_id,
    cadence: row.cadence,
    slackChannelId: row.slack_channel_id,
  }));
}

interface ControlAndOwner {
  status: string;
  ownerSlackUserId: string | null;
}

async function getControlAndOwner(
  client: PoolClient,
  orgControlId: string
): Promise<ControlAndOwner | null> {
  const { rows } = await client.query<{ status: string; slack_user_id: string | null }>(
    `select oc.status, u.slack_user_id
       from org_controls oc
       left join users u on u.id = oc.owner_user_id
      where oc.id = $1`,
    [orgControlId]
  );
  const row = rows[0];
  return row ? { status: row.status, ownerSlackUserId: row.slack_user_id } : null;
}

/**
 * Atomically claims a schedule for sending: only the FIRST caller to
 * present a due schedule succeeds, via a conditional UPDATE ... WHERE
 * (still due) ... RETURNING -- same "claim exactly once" shape as
 * consumeLinkToken in linkTokens.ts, applied to re-checking due-ness
 * instead of consuming a token. Guards against manual invocation and
 * Vercel Cron overlapping on the same due schedule. Uses cadence_interval()
 * (0005_nudge_sender.sql) -- the SAME function get_due_nudge_schedules()
 * uses -- so the due-ness check can't drift between the two call sites.
 */
async function claimNudge(client: PoolClient, id: string): Promise<boolean> {
  const { rows } = await client.query(
    `update nudge_schedules
        set last_sent_at = now()
      where id = $1
        and (last_sent_at is null or last_sent_at + cadence_interval(cadence) <= now())
      returning id`,
    [id]
  );
  return rows.length > 0;
}

async function logNudgeAudit(
  client: PoolClient,
  orgId: string,
  action: "nudge.sent" | "nudge.skipped",
  scheduleId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await client.query(
    `insert into audit_log (org_id, actor_user_id, action, target_type, target_id, metadata)
     values ($1, null, $2, 'nudge_schedule', $3, $4::jsonb)`,
    [orgId, action, scheduleId, JSON.stringify(metadata)]
  );
}

function buildNudgeBlocks(orgControlId: string): KnownBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "Reminder: evidence is due for this control." },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Request Evidence" },
          action_id: REQUEST_EVIDENCE_ACTION_ID,
          value: orgControlId,
        },
      ],
    },
  ];
}

export interface ProcessNudgesResult {
  sent: number;
  skipped: number;
  errors: number;
}

/**
 * Processes every currently-due nudge schedule: skips (with an audit log
 * entry) controls that are already evidenced/reviewed or have no
 * Slack-linked owner, otherwise claims the schedule and sends a Slack
 * reminder with a "Request Evidence" button.
 *
 * Per-schedule failures (Slack API error, missing installation, etc.) are
 * caught and counted, never thrown -- this must never surface a 5xx for a
 * partial failure, same never-5xx-on-retry-unsafe-side-effects rationale as
 * the Slack slash command handler.
 */
export async function processDueNudges(): Promise<ProcessNudgesResult> {
  const due = await fetchDueNudgeSchedules();
  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const schedule of due) {
    try {
      const outcome = await withOrgContext(schedule.orgId, async (client) => {
        const controlAndOwner = await getControlAndOwner(client, schedule.orgControlId);
        if (!controlAndOwner) {
          // org_control was deleted since the schedule was created; nothing
          // to nudge for. Not logged -- there's no meaningful org_control
          // to attach the audit entry to.
          return "skipped" as const;
        }

        if (controlAndOwner.status === "evidenced" || controlAndOwner.status === "reviewed") {
          await logNudgeAudit(client, schedule.orgId, "nudge.skipped", schedule.id, {
            reason: "control_already_satisfied",
            orgControlId: schedule.orgControlId,
            status: controlAndOwner.status,
          });
          return "skipped" as const;
        }

        if (!controlAndOwner.ownerSlackUserId) {
          await logNudgeAudit(client, schedule.orgId, "nudge.skipped", schedule.id, {
            reason: "no_linked_owner",
            orgControlId: schedule.orgControlId,
          });
          return "skipped" as const;
        }

        const claimed = await claimNudge(client, schedule.id);
        if (!claimed) {
          // A concurrent invocation (manual + cron overlap) already claimed
          // this schedule. Not an error, not logged separately.
          return "skipped" as const;
        }

        const slack = await getSlackClientForOrg(schedule.orgId);
        await slack.chat.postMessage({
          channel: schedule.slackChannelId,
          text: "Reminder: evidence is due for this control.",
          blocks: buildNudgeBlocks(schedule.orgControlId),
        });

        await logNudgeAudit(client, schedule.orgId, "nudge.sent", schedule.id, {
          orgControlId: schedule.orgControlId,
          slackChannelId: schedule.slackChannelId,
        });
        return "sent" as const;
      });

      if (outcome === "sent") sent++;
      else skipped++;
    } catch (err) {
      errors++;
      console.error(`Nudge send failed for schedule ${schedule.id}`, err);
    }
  }

  return { sent, skipped, errors };
}
