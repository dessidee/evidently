import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Routes that verify their own signature/secret instead of a Clerk session
// (server-to-server webhooks, Slack's own signing, the Slack OAuth redirect
// target which arrives from Slack's servers, not a signed-in browser, and the
// cron-triggered nudge sender which verifies CRON_SECRET itself -- see
// nudgeSecret.ts. There is never a Clerk session for these callers, so
// auth.protect() must not run for them; leaving one out of this list means
// Clerk blocks it before its own handler-level verification ever runs.
export const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks/clerk",
  "/api/billing/webhook",
  "/api/slack/events",
  "/api/slack/commands",
  "/api/slack/interactions",
  "/api/slack/oauth/callback",
  "/api/cron/send-nudges",
]);

// TODO: tests/middleware-public-routes.test.ts only unit-tests isPublicRoute
// itself (that every self-verifying route is listed, and unrelated routes
// aren't) -- it does not exercise this conditional end-to-end through real
// Next.js middleware. Catching a regression in this wiring (e.g. the
// condition below getting inverted or dropped) would need a `next start` +
// HTTP integration test; no such harness exists in this project yet.
export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|.*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico)).*)",
    "/(api|trpc)(.*)",
  ],
};
