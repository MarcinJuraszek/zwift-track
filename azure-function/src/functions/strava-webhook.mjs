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

import { app } from "@azure/functions";

app.http("strava-webhook", {
  methods: ["GET", "POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    if (request.method === "GET") {
      // Strava webhook verification challenge
      const url = new URL(request.url);
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
        context.log("Strava webhook verified");
        return {
          jsonBody: { "hub.challenge": challenge },
        };
      }

      return { status: 403, body: "Verification failed" };
    }

    // POST — activity event from Strava
    const body = await request.json();
    context.log("Strava event:", JSON.stringify(body));

    // Only trigger on activity creation
    if (body.object_type !== "activity" || body.aspect_type !== "create") {
      return { jsonBody: { status: "ignored" } };
    }

    // Trigger GitHub Actions via repository_dispatch
    const owner = process.env.GITHUB_REPO_OWNER;
    const repo = process.env.GITHUB_REPO_NAME;
    const pat = process.env.GITHUB_PAT;

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
      context.log(`Triggered sync for activity ${body.object_id}`);
      return { jsonBody: { status: "dispatched" } };
    }

    const err = await res.text();
    context.error(`GitHub dispatch failed: ${res.status} ${err}`);
    return { status: 500, jsonBody: { error: "dispatch failed" } };
  },
});
