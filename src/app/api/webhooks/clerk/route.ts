import { headers } from "next/headers";
import { Webhook } from "svix";
import { NextResponse } from "next/server";
import { provisionUserOnSignup } from "@/lib/services/userProvisioning";

// Minimal shape of the Clerk `user.created` event we rely on. We deliberately
// don't type the full Clerk payload to avoid silently trusting fields we
// don't use.
interface ClerkUserCreatedEvent {
  type: string;
  data: {
    id: string;
    email_addresses: { id: string; email_address: string }[];
    primary_email_address_id: string;
  };
}

export async function POST(req: Request) {
  const signingSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!signingSecret) {
    console.error("CLERK_WEBHOOK_SIGNING_SECRET is not set");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  const headerList = await headers();
  const svixId = headerList.get("svix-id");
  const svixTimestamp = headerList.get("svix-timestamp");
  const svixSignature = headerList.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "Missing svix headers" }, { status: 400 });
  }

  const body = await req.text();
  const wh = new Webhook(signingSecret);

  let event: ClerkUserCreatedEvent;
  try {
    event = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkUserCreatedEvent;
  } catch {
    // Signature invalid: this request did not actually come from Clerk.
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type !== "user.created") {
    // We only act on user.created; other event types are acknowledged but ignored.
    return NextResponse.json({ ok: true });
  }

  const primaryEmail = event.data.email_addresses.find(
    (e) => e.id === event.data.primary_email_address_id
  )?.email_address;

  if (!primaryEmail) {
    return NextResponse.json({ error: "No primary email on event" }, { status: 400 });
  }

  await provisionUserOnSignup({ clerkUserId: event.data.id, email: primaryEmail });

  return NextResponse.json({ ok: true });
}
