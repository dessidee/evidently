import { NextResponse } from "next/server";
import { InvalidNudgeSecretError, verifyNudgeSecret } from "@/lib/slack/nudgeSecret";
import { processDueNudges } from "@/lib/slack/nudges";

/**
 * Sends Slack reminders for every currently-due nudge schedule. Triggered
 * either by Vercel Cron (see vercel.json -- Cron only issues GET requests)
 * or manually (e.g. for demos) with the same shared-secret header.
 *
 * Auth is a static shared secret, not Clerk (no signed-in user for a
 * cron/manual trigger) and not Slack request signing (the request
 * originates from us, not Slack).
 */
export async function GET(req: Request): Promise<NextResponse> {
  try {
    verifyNudgeSecret(req.headers.get("authorization"));
  } catch (err) {
    if (err instanceof InvalidNudgeSecretError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  try {
    const result = await processDueNudges();
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    // processDueNudges already catches and counts per-schedule failures --
    // reaching here means something broader failed (e.g. DB unreachable),
    // which legitimately warrants a 5xx.
    console.error("send-nudges failed", err);
    return NextResponse.json({ error: "Failed to process nudge schedules" }, { status: 500 });
  }
}
