import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Routes that verify their own signature/secret instead of a Clerk session
// (server-to-server webhooks, Slack's own signing, the Slack OAuth redirect
// target which arrives from Slack's servers, not a signed-in browser).
const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks/clerk",
  "/api/billing/webhook",
  "/api/slack/events",
  "/api/slack/commands",
  "/api/slack/interactions",
  "/api/slack/oauth/callback",
]);

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
