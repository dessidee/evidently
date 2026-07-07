import { NextResponse } from "next/server";
import { InvalidSlackSignatureError, verifySlackSignature } from "@/lib/slack/verifyRequest";
import { resolveLinkedSlackUser, resolveOrgIdBySlackTeam } from "@/lib/slack/orgLookup";
import { getSlackClientForOrg } from "@/lib/slack/client";
import {
  EVIDENCE_MODAL_CALLBACK_ID,
  REQUEST_EVIDENCE_ACTION_ID,
  buildEvidenceModalView,
  parseEvidenceSubmission,
  type SlackViewSubmissionView,
} from "@/lib/slack/evidenceModal";
import { createEvidence } from "@/lib/services/evidenceService";

// Generic, non-field-specific errors surfaced during view_submission always
// target this block_id. It's guaranteed to exist as an *input* block in
// both modal variants (control pre-filled or not) -- Slack rejects a
// response_action "errors" payload referencing a block_id that isn't a
// live input block in the view currently open, so this can't reuse
// org_control_block/org_control_context (which only exists in one variant
// each; see evidenceModal.ts).
const GENERIC_ERROR_BLOCK_ID = "type_block";

interface SlackBlockActionsPayload {
  type: "block_actions";
  team?: { id?: string };
  user?: { id?: string };
  trigger_id?: string;
  response_url?: string;
  actions?: { action_id?: string; value?: string }[];
}

interface SlackViewSubmissionPayload {
  type: "view_submission";
  team?: { id?: string };
  user?: { id?: string };
  view: SlackViewSubmissionView & { callback_id?: string };
}

type SlackInteractionPayload =
  | SlackBlockActionsPayload
  | SlackViewSubmissionPayload
  | { type: string };

async function postToResponseUrl(responseUrl: string, text: string): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
  });
}

async function handleBlockActions(payload: SlackBlockActionsPayload): Promise<NextResponse> {
  const teamId = payload.team?.id;
  const slackUserId = payload.user?.id;
  const triggerId = payload.trigger_id;
  const responseUrl = payload.response_url;
  const action = payload.actions?.[0];

  if (
    !teamId ||
    !slackUserId ||
    !triggerId ||
    !action ||
    action.action_id !== REQUEST_EVIDENCE_ACTION_ID
  ) {
    // Not a button this handler recognizes -- ack quietly rather than error,
    // since Slack may add other interactive components in the future.
    return new NextResponse(null, { status: 200 });
  }

  const orgId = await resolveOrgIdBySlackTeam(teamId);
  if (!orgId) {
    if (responseUrl) {
      await postToResponseUrl(
        responseUrl,
        "This Slack workspace isn't connected to an Evidently organization."
      );
    }
    return new NextResponse(null, { status: 200 });
  }

  const linkedUser = await resolveLinkedSlackUser(orgId, slackUserId);
  if (!linkedUser) {
    if (responseUrl) {
      await postToResponseUrl(
        responseUrl,
        "Your Slack account isn't linked to an Evidently user yet. Run /evidence-link first."
      );
    }
    return new NextResponse(null, { status: 200 });
  }

  // The nudge button's value carries the org_control_id it was rendered
  // for (out of scope here: whatever posts that button -- see spec).
  const orgControlId = action.value;

  try {
    const client = await getSlackClientForOrg(orgId);
    await client.views.open({
      trigger_id: triggerId,
      view: buildEvidenceModalView({ orgControlId }),
    });
  } catch (err) {
    console.error("Failed to open evidence modal from block_actions", err);
    if (responseUrl) {
      await postToResponseUrl(responseUrl, "Something went wrong opening the form -- please try again.");
    }
  }

  return new NextResponse(null, { status: 200 });
}

async function handleViewSubmission(payload: SlackViewSubmissionPayload): Promise<NextResponse> {
  const view = payload.view;
  if (view?.callback_id !== EVIDENCE_MODAL_CALLBACK_ID) {
    return new NextResponse(null, { status: 200 });
  }

  const parsed = parseEvidenceSubmission(view);
  if (!parsed.ok) {
    return NextResponse.json({ response_action: "errors", errors: parsed.errors });
  }

  const teamId = payload.team?.id;
  const slackUserId = payload.user?.id;

  const orgId = teamId ? await resolveOrgIdBySlackTeam(teamId) : null;
  if (!orgId) {
    return NextResponse.json({
      response_action: "errors",
      errors: {
        [GENERIC_ERROR_BLOCK_ID]:
          "This Slack workspace isn't connected to an Evidently organization.",
      },
    });
  }

  const linkedUser = slackUserId ? await resolveLinkedSlackUser(orgId, slackUserId) : null;
  if (!linkedUser) {
    return NextResponse.json({
      response_action: "errors",
      errors: {
        [GENERIC_ERROR_BLOCK_ID]: "Your Slack account isn't linked. Run /evidence-link first.",
      },
    });
  }

  const result = await createEvidence({
    orgId,
    userId: linkedUser.userId,
    orgControlId: parsed.data.orgControlId,
    type: parsed.data.type,
    description: parsed.data.description,
    externalUrl: parsed.data.externalUrl,
    submittedVia: "slack",
  });

  if (result.notFound) {
    return NextResponse.json({
      response_action: "errors",
      errors: { [GENERIC_ERROR_BLOCK_ID]: "Control not found." },
    });
  }

  return new NextResponse(null, { status: 200 });
}

/**
 * Handles Slack's block_actions (nudge button click -> open modal) and
 * view_submission (modal submit -> create evidence) interaction types. Both
 * arrive as a single application/x-www-form-urlencoded `payload` field
 * containing a JSON string, per Slack's Interactivity API.
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
  const rawPayload = params.get("payload");
  if (!rawPayload) {
    return NextResponse.json({ error: "Missing payload" }, { status: 400 });
  }

  const payload = JSON.parse(rawPayload) as SlackInteractionPayload;

  try {
    switch (payload.type) {
      case "block_actions":
        return await handleBlockActions(payload as SlackBlockActionsPayload);
      case "view_submission":
        return await handleViewSubmission(payload as SlackViewSubmissionPayload);
      default:
        return new NextResponse(null, { status: 200 });
    }
  } catch (err) {
    console.error(`Slack interaction handler failed for type ${payload.type}`, err);
    // For view_submission specifically, a 5xx/malformed body makes Slack
    // show a generic "something went wrong" and leaves the modal open with
    // the user's input intact, which is an acceptable fallback here.
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
