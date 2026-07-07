import { NextResponse } from "next/server";
import { InvalidSlackSignatureError, verifySlackSignature } from "@/lib/slack/verifyRequest";

/**
 * Minimal Events API endpoint. The only thing this MVP needs it for is the
 * one-time url_verification handshake required to save this URL as the
 * Events API "Request URL" in the Slack app config -- no event
 * subscriptions are actually consumed yet (sending nudges is out of scope
 * for this iteration; see spec). Any other event type is acknowledged and
 * ignored.
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

  const body = JSON.parse(rawBody) as { type?: string; challenge?: string };

  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  return new NextResponse(null, { status: 200 });
}
