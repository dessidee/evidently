import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isPublicRoute } from "../src/middleware";

/**
 * Pure unit test for src/middleware.ts's isPublicRoute matcher -- no
 * database, no Clerk keys, no running server needed, always runs.
 *
 * This directly regression-tests the bug class that let
 * /api/cron/send-nudges reach production unauthenticatable: a
 * self-verifying route (checks its own signature/secret instead of a Clerk
 * session) accidentally left out of this list, so clerkMiddleware's
 * auth.protect() would run and block it before its own handler-level
 * verification ever executes.
 *
 * Scope note: this proves the route *matcher* config is correct (every
 * self-verifying route is listed, and unrelated routes are not). It does
 * NOT exercise the actual enforcement wiring in the exported default
 * clerkMiddleware(...) callback (i.e. that auth.protect() is truly skipped
 * for matched routes end-to-end through real Next.js middleware) -- that
 * would require a real `next start` + HTTP integration test, which this
 * project has no infrastructure for yet (see PR description).
 */
describe("isPublicRoute", () => {
  const publicPaths = [
    "/sign-in",
    "/sign-up",
    "/api/webhooks/clerk",
    "/api/billing/webhook",
    "/api/slack/events",
    "/api/slack/commands",
    "/api/slack/interactions",
    "/api/slack/oauth/callback",
    "/api/cron/send-nudges",
  ];

  it.each(publicPaths)("matches %s as public", (path) => {
    const req = new NextRequest(new URL(path, "http://localhost"));
    expect(isPublicRoute(req)).toBe(true);
  });

  const protectedPaths = [
    "/dashboard",
    "/api/orgs/some-org-id/evidence",
    "/api/slack/install",
    "/api/slack/link",
    "/api/billing/checkout",
  ];

  it.each(protectedPaths)("does not match %s as public", (path) => {
    const req = new NextRequest(new URL(path, "http://localhost"));
    expect(isPublicRoute(req)).toBe(false);
  });
});
