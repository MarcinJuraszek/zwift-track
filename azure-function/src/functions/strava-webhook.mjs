// Strava webhook → GitHub Actions relay
//
// GET  /api/strava-webhook — Strava verification challenge (one-time setup)
// POST /api/strava-webhook — Activity event → triggers repository_dispatch
//
// Required app settings:
//   STRAVA_WEBHOOK_VERIFY_TOKEN — any random string you choose (shared with Strava)
//   GITHUB_PAT                  — GitHub fine-grained PAT with "contents" write access
//   GITHUB_REPO_OWNER           — "MarcinJuraszek"
//   GITHUB_REPO_NAME            — "zwift-track"
//   STRAVA_SUBSCRIPTION_ID      — webhook subscription ID (e.g. "352581")
//   STRAVA_OWNER_ID             — your Strava athlete ID (e.g. "29432659")

import { app } from "@azure/functions";

app.http("strava-webhook", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    context.log(`${request.method} /api/strava-webhook from ${request.headers.get("x-forwarded-for") || "unknown"}`);

    if (request.method === "GET") {
      // Strava webhook verification challenge
      const url = new URL(request.url);
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
        context.log("✅ Strava webhook verification succeeded");
        return {
          jsonBody: { "hub.challenge": challenge },
        };
      }

      context.warn(`⚠️ Verification failed — mode=${mode}, token match=${token === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN}`);
      return { status: 403, body: "Verification failed" };
    }

    // POST — activity event from Strava
    const body = await request.json();
    context.log(`📥 Strava event: object_type=${body.object_type}, aspect_type=${body.aspect_type}, object_id=${body.object_id}, owner_id=${body.owner_id}, subscription_id=${body.subscription_id}`);

    // Validate the request is from our Strava subscription
    const expectedSubId = process.env.STRAVA_SUBSCRIPTION_ID;
    const expectedOwnerId = process.env.STRAVA_OWNER_ID;

    if (expectedSubId && String(body.subscription_id) !== expectedSubId) {
      context.warn(`🚫 Rejected: subscription_id ${body.subscription_id} doesn't match expected ${expectedSubId}`);
      return { status: 403, jsonBody: { error: "invalid subscription" } };
    }

    if (expectedOwnerId && String(body.owner_id) !== expectedOwnerId) {
      context.warn(`🚫 Rejected: owner_id ${body.owner_id} doesn't match expected ${expectedOwnerId}`);
      return { status: 403, jsonBody: { error: "invalid owner" } };
    }

    // Only trigger on activity creation
    if (body.object_type !== "activity" || body.aspect_type !== "create") {
      context.log(`⏭️ Ignoring event (not activity create)`);
      return { jsonBody: { status: "ignored" } };
    }

    // Trigger GitHub Actions via repository_dispatch
    const owner = process.env.GITHUB_REPO_OWNER;
    const repo = process.env.GITHUB_REPO_NAME;
    const pat = process.env.GITHUB_PAT;

    if (!pat) {
      context.error("❌ GITHUB_PAT not configured");
      return { status: 500, jsonBody: { error: "GITHUB_PAT not set" } };
    }

    context.log(`🚀 Dispatching to ${owner}/${repo} for activity ${body.object_id}...`);
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${pat}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          event_type: "strava-activity",
          client_payload: {
            activity_id: body.object_id,
          },
        }),
      }
    );

    if (res.ok || res.status === 204) {
      context.log(`✅ Dispatched sync for activity ${body.object_id} (HTTP ${res.status})`);
      return { jsonBody: { status: "dispatched" } };
    }

    const err = await res.text();
    context.error(`❌ GitHub dispatch failed: HTTP ${res.status} — ${err}`);
    return { status: 500, jsonBody: { error: "dispatch failed" } };
  },
});
