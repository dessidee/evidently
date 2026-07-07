// Shared Block Kit modal builder + view_submission parser, used by BOTH the
// /evidence-request slash command and the block_actions (nudge button)
// handler, so there is exactly one place that defines the modal's shape --
// see spec acceptance criteria ("single modal-building code path").
//
// MVP scope trim (flagged explicitly, not silently): only 'link' and
// 'text_note' evidence types are submittable from Slack. 'file'/'screenshot'
// require the browser signed-upload-URL flow (createSignedUploadUrl), which
// has no equivalent inside a Slack modal; that remains web-only for now.
// periodStart/periodEnd are also omitted from the modal for simplicity --
// still supported by evidenceService/the web API, just not set on
// Slack-submitted evidence in this iteration.

import type { KnownBlock, ModalView } from "@slack/types";

export const EVIDENCE_MODAL_CALLBACK_ID = "evidence_submit_modal";

// action_id of the nudge message's button (block_actions handler). Owned
// here, alongside the callback_id above, since both are part of the same
// "single modal-building code path" this module exists to centralize --
// whatever posts the nudge message (out of scope for this iteration; see
// spec) must use this exact action_id for the button to be recognized.
export const REQUEST_EVIDENCE_ACTION_ID = "request_evidence_button";

export interface EvidenceModalOption {
  label: string;
  value: string;
}

export function buildEvidenceModalView(input: {
  orgControlId?: string;
  orgControlOptions?: EvidenceModalOption[];
}): ModalView {
  const blocks: KnownBlock[] = [];

  if (input.orgControlId) {
    // Pre-selected (came from a nudge button click) -- not editable, just
    // shown for context. No extra DB round-trip to resolve the control's
    // display name for this iteration.
    blocks.push({
      type: "section",
      block_id: "org_control_context",
      text: { type: "mrkdwn", text: "Submitting evidence for the requested control." },
    });
  } else {
    blocks.push({
      type: "input",
      block_id: "org_control_block",
      label: { type: "plain_text", text: "Control" },
      element: {
        type: "static_select",
        action_id: "org_control_select",
        options: (input.orgControlOptions ?? []).map((o) => ({
          text: { type: "plain_text", text: o.label },
          value: o.value,
        })),
      },
    });
  }

  blocks.push(
    {
      type: "input",
      block_id: "type_block",
      label: { type: "plain_text", text: "Evidence type" },
      element: {
        type: "static_select",
        action_id: "type_select",
        options: [
          { text: { type: "plain_text", text: "Link" }, value: "link" },
          { text: { type: "plain_text", text: "Text note" }, value: "text_note" },
        ],
      },
    },
    {
      type: "input",
      block_id: "description_block",
      optional: true,
      label: { type: "plain_text", text: "Description" },
      element: { type: "plain_text_input", action_id: "description_input", multiline: true },
    },
    {
      type: "input",
      block_id: "external_url_block",
      optional: true,
      label: { type: "plain_text", text: "Link URL (required for type Link)" },
      element: { type: "plain_text_input", action_id: "external_url_input" },
    }
  );

  return {
    type: "modal" as const,
    callback_id: EVIDENCE_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({ orgControlId: input.orgControlId ?? null }),
    title: { type: "plain_text" as const, text: "Submit evidence" },
    submit: { type: "plain_text" as const, text: "Submit" },
    close: { type: "plain_text" as const, text: "Cancel" },
    blocks,
  };
}

export interface ViewStateValue {
  selected_option?: { value: string } | null;
  value?: string | null;
}

// Exported so callers (e.g. the interactions route) that receive a raw
// view_submission payload can type their `view` field with this exact shape
// instead of redeclaring an incompatible one.
export interface SlackViewSubmissionView {
  private_metadata?: string;
  state: { values: Record<string, Record<string, ViewStateValue>> };
}

export interface ParsedEvidenceSubmission {
  orgControlId: string;
  type: "link" | "text_note";
  description?: string;
  externalUrl?: string;
}

export type ParseEvidenceSubmissionResult =
  | { ok: true; data: ParsedEvidenceSubmission }
  | { ok: false; errors: Record<string, string> };

export function parseEvidenceSubmission(
  view: SlackViewSubmissionView
): ParseEvidenceSubmissionResult {
  const metadata: { orgControlId?: string | null } = view.private_metadata
    ? JSON.parse(view.private_metadata)
    : {};
  const values = view.state.values;

  const orgControlId =
    metadata.orgControlId ?? values.org_control_block?.org_control_select?.selected_option?.value;
  const type = values.type_block?.type_select?.selected_option?.value as
    | "link"
    | "text_note"
    | undefined;
  const description = values.description_block?.description_input?.value ?? undefined;
  const externalUrl = values.external_url_block?.external_url_input?.value ?? undefined;

  const errors: Record<string, string> = {};
  if (!orgControlId) errors.org_control_block = "Select a control";
  if (!type) errors.type_block = "Select an evidence type";
  if (type === "link" && !externalUrl) {
    errors.external_url_block = "A link URL is required for type Link";
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: { orgControlId: orgControlId as string, type: type!, description, externalUrl },
  };
}
