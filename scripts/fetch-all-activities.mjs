// Fetch activities from Strava and save raw data locally.
// Supports incremental updates — only fetches activities newer than the cache.
// Run: node scripts/fetch-all-activities.mjs
// Run with --full to re-fetch everything from scratch.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
const outputPath = resolve(__dirname, "../src/data/raw-activities.json");

function loadEnv() {
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf-8").split("\n");
    const env = {};
    for (const line of lines) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) env[match[1].trim()] = match[2].trim();
    }
    return env;
  }
  // Fall back to process.env (for CI)
  return { ...process.env };
}

function saveEnv(env) {
  // Only write .env.local when running locally
  if (!existsSync(envPath) && !process.env.CI) return;
  if (process.env.CI) return;
  const content = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
  writeFileSync(envPath, content);
}

async function getAccessToken(env) {
  const expiresAt = parseInt(env.STRAVA_TOKEN_EXPIRES_AT || "0");
  const now = Math.floor(Date.now() / 1000);

  if (expiresAt > now + 60) {
    return env.STRAVA_ACCESS_TOKEN;
  }

  console.log("🔄 Refreshing Strava access token...");
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      refresh_token: env.STRAVA_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Token refresh failed: ${data.message || JSON.stringify(data)}`);
  }
  console.log(`✅ Token refreshed (scope: ${data.scope || "unknown"})`);

  env.STRAVA_ACCESS_TOKEN = data.access_token;
  env.STRAVA_REFRESH_TOKEN = data.refresh_token;
  env.STRAVA_TOKEN_EXPIRES_AT = String(data.expires_at);
  saveEnv(env);

  // In CI, write the new refresh token so the workflow can update the secret
  if (process.env.CI) {
    const tokenPath = resolve(__dirname, "../.strava-refresh-token");
    writeFileSync(tokenPath, data.refresh_token);
  }

  return data.access_token;
}

async function fetchActivitiesAfter(accessToken, afterEpoch) {
  const activities = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = new URL("https://www.strava.com/api/v3/athlete/activities");
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    if (afterEpoch) {
      url.searchParams.set("after", String(afterEpoch));
    }

    let res;
    let retries = 3;
    while (retries > 0) {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.ok) break;

      retries--;
      if (retries > 0 && res.status >= 500) {
        console.log(`   ⚠️  Server error ${res.status} on page ${page}, retrying in 5s... (${retries} left)`);
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        const body = await res.text();
        throw new Error(`Strava API error ${res.status}: ${body}`);
      }
    }

    const rateLimit = res.headers.get("x-ratelimit-limit");
    const rateUsage = res.headers.get("x-ratelimit-usage");

    const batch = await res.json();
    if (batch.length === 0) break;

    activities.push(...batch);
    console.log(`   Page ${page}: ${batch.length} activities (total: ${activities.length}) [rate: ${rateUsage}/${rateLimit}]`);

    if (batch.length < perPage) break;
    page++;
  }

  return activities;
}

async function main() {
  const fullRefresh = process.argv.includes("--full");
  const env = loadEnv();
  const accessToken = await getAccessToken(env);

  // Load existing cache
  let existingVirtualRides = [];
  let existingIds = new Set();
  if (!fullRefresh && existsSync(outputPath)) {
    const existing = JSON.parse(readFileSync(outputPath, "utf-8"));
    existingVirtualRides = existing.virtualRides || [];
    existingIds = new Set(existingVirtualRides.map((a) => a.id));

    // Find the most recent activity timestamp
    const latestDate = existingVirtualRides.reduce((max, a) => {
      const d = new Date(a.start_date).getTime();
      return d > max ? d : max;
    }, 0);
    // Use the most recent activity from ALL cached data (not just virtual rides)
    // to determine the "after" cutoff. We use the fetchedAt as a simpler proxy.
    const afterEpoch = Math.floor(latestDate / 1000);
    const afterDate = new Date(afterEpoch * 1000).toLocaleDateString();

    console.log(`📂 Existing cache: ${existingVirtualRides.length} virtual rides`);
    console.log(`🔍 Fetching activities after ${afterDate}...`);

    const newActivities = await fetchActivitiesAfter(accessToken, afterEpoch);
    const newVirtualRides = newActivities.filter(
      (a) =>
        (a.type === "VirtualRide" || a.sport_type === "VirtualRide") &&
        !existingIds.has(a.id)
    );

    if (newVirtualRides.length === 0) {
      console.log(`\n✅ Already up to date — no new virtual rides found.`);
      console.log(`   Virtual rides: ${existingVirtualRides.length}`);
      return;
    }

    console.log(`   New activities: ${newActivities.length} total, ${newVirtualRides.length} virtual rides`);
    existingVirtualRides.push(...newVirtualRides);
    // Sort by date descending
    existingVirtualRides.sort(
      (a, b) => new Date(b.start_date).getTime() - new Date(a.start_date).getTime()
    );
  } else {
    if (fullRefresh) {
      console.log("🔄 Full refresh requested — fetching all activities...");
    } else {
      console.log("🔍 No cache found — fetching all activities...");
    }

    const allActivities = await fetchActivitiesAfter(accessToken, null);
    existingVirtualRides = allActivities.filter(
      (a) => a.type === "VirtualRide" || a.sport_type === "VirtualRide"
    );
  }

  const output = {
    fetchedAt: new Date().toISOString(),
    totalActivities: existingVirtualRides.length,
    virtualRideCount: existingVirtualRides.length,
    virtualRides: existingVirtualRides,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`\n✅ Done!`);
  console.log(`   Virtual rides: ${existingVirtualRides.length}`);
  console.log(`   Saved to: ${outputPath}`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
