import { NextResponse } from "next/server";
import { InvalidSlackSignatureError, verifySlackSignature } from "@/lib/slack/verifyRequest";
import { resolveLinkedSlackUser, resolveOrgIdBySlackTeam } from "@/lib/slack/orgLookup";
import { getSlackClientForOrg } from "@/lib/slack/client";
import { createLinkToken } from "@/lib/slack/linkTokens";
import { buildEvidenceModalView, type EvidenceModalOption } from "@/lib/slack/evidenceModal";
import { withOrgContext } from "@/lib/db/withOrgContext";

// Slack's static_select element hard-caps at 100 options.
const MAX_SELECT_OPTIONS = 100;

function ephemeral(text: string): NextResponse {
  return NextResponse.json({ response_type: "ephemeral", text });
}

async function listOrgControlOptions(orgId: string): Promise<EvidenceModalOption[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ id: string; code: string; title: string }>(
      `select oc.id, c.code, c.title
         from org_controls oc
         join controls c on c.id = oc.control_id
        where oc.org_id = $1
        order by c.code asc
        limit $2`,
      [orgId, MAX_SELECT_OPTIONS]
    );
    return rows.map((row) => ({ label: `${row.code} - ${row.title}`, value: row.id }));
  });
}

async function handleEvidenceRequest(input: {
  orgId: string;
  slackUserId: string;
  triggerId: string | null;
}): Promise<NextResponse> {
  const { orgId, slackUserId, triggerId } = input;
  if (!triggerId) {
    return ephemeral("Missing trigger_id -- please retry the command.");
  }

  const linkedUser = await resolveLinkedSlackUser(orgId, slackUserId);
  if (!linkedUser) {
    return ephemeral(
      "Your Slack account isn't linked to an Evidently user yet. Run /evidence-link first."
    );
  }

  const orgControlOptions = await listOrgControlOptions(orgId);
  const client = await getSlackClientForOrg(orgId);
  await client.views.open({
    trigger_id: triggerId,
    view: buildEvidenceModalView({ orgControlOptions }),
  });

  return new NextResponse(null, { status: 200 });
}

async function handleEvidenceLink(input: {
  orgId: string;
  teamId: string;
  slackUserId: string;
}): Promise<NextResponse> {
  const { orgId, teamId, slackUserId } = input;
  const token = await createLinkToken({ orgId, slackTeamId: teamId, slackUserId });

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const linkUrl = new URL("/api/slack/link", baseUrl);
  linkUrl.searchParams.set("token", token);

  return ephemeral(
    `Click this link to connect your Slack account to Evidently (expires in 10 minutes, ` +
      `single use): ${linkUrl.toString()}`
  );
}

/**
 * Handles Slack slash commands (application/x-www-form-urlencoded). Both
 * /evidence-request and /evidence-link are routed through this single
 * endpoint (one Slack "Slash Command" request URL is configured to point
 * here; `command` in the body selects the behavior), consistent with the
 * spec's MVP scope.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const rawBody = await req.text();
  try {
    verifySlackSignature({
      rawBody,
      timestamp: req.headers.get("x-slack-request-timestamp"),
      signature: req.headers.get("x-slack-signature"),
    });
  } catch (err) {
    if (err instanceof InvalidSlackSignatureError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const params = new URLSearchParams(rawBody);
  const command = params.get("command");
  const teamId = params.get("team_id");
  const slackUserId = params.get("user_id");
  const triggerId = params.get("trigger_id");

  if (!command || !teamId || !slackUserId) {
    return NextResponse.json({ error: "Malformed slash command payload" }, { status: 400 });
  }

  const orgId = await resolveOrgIdBySlackTeam(teamId);
  if (!orgId) {
    return ephemeral("This Slack workspace isn't connected to an Evidently organization.");
  }

  try {
    switch (command) {
      case "/evidence-request":
        return await handleEvidenceRequest({ orgId, slackUserId, triggerId });
      case "/evidence-link":
        return await handleEvidenceLink({ orgId, teamId, slackUserId });
      default:
        return ephemeral(`Unrecognized command: ${command}`);
    }
  } catch (err) {
    // Slack requires an ack within 3s regardless of outcome; a 5xx here
    // would just cause Slack to retry (re-triggering side effects like
    // views.open/token creation), so failures are surfaced to the user as
    // an ephemeral message instead, and logged server-side for follow-up.
    console.error(`Slack command handler failed for ${command}`, err);
    return ephemeral("Something went wrong handling that command. Please try again.");
  }
}
