// Sync Zwift rides from Strava and match to known routes.
// Fetches VirtualRide activities from the last 2 weeks.
// Run: node scripts/sync-activities.mjs

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
const routesPath = resolve(__dirname, "../src/data/routes.json");
const outputPath = resolve(__dirname, "../src/data/completed-routes.json");

// --- Env helpers ---

function loadEnv() {
  if (!existsSync(envPath)) return {};
  const lines = readFileSync(envPath, "utf-8").split("\n");
  const env = {};
  for (const line of lines) {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) env[match[1].trim()] = match[2].trim();
  }
  return env;
}

function saveEnv(env) {
  const content = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
  writeFileSync(envPath, content);
}

// --- Token management ---

async function getAccessToken(env) {
  const expiresAt = parseInt(env.STRAVA_TOKEN_EXPIRES_AT || "0");
  const now = Math.floor(Date.now() / 1000);

  // Token still valid (with 60s buffer)
  if (expiresAt > now + 60) {
    return env.STRAVA_ACCESS_TOKEN;
  }

  // Refresh the token
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

  env.STRAVA_ACCESS_TOKEN = data.access_token;
  env.STRAVA_REFRESH_TOKEN = data.refresh_token;
  env.STRAVA_TOKEN_EXPIRES_AT = String(data.expires_at);
  saveEnv(env);
  console.log("✅ Token refreshed");

  return data.access_token;
}

// --- Strava API ---

async function fetchActivities(accessToken, afterEpoch) {
  const activities = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = new URL("https://www.strava.com/api/v3/athlete/activities");
    url.searchParams.set("after", String(afterEpoch));
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Strava API error ${res.status}: ${body}`);
    }

    const batch = await res.json();
    if (batch.length === 0) break;

    activities.push(...batch);
    console.log(`   Fetched page ${page} (${batch.length} activities)`);

    if (batch.length < perPage) break;
    page++;
  }

  return activities;
}

// --- Route matching ---

function normalizeRouteName(name) {
  return name
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRouteIndex(routes) {
  const byName = new Map();
  for (const route of routes) {
    byName.set(normalizeRouteName(route.name), route);
  }
  return { byName };
}

function matchActivityToRoute(activity, routeIndex) {
  const { name } = activity;
  if (!name) return null;

  // Zwift activities are titled "World - Route Name" or sometimes just the route name
  const parts = name.split(" - ");
  const candidateNames = [];

  if (parts.length >= 2) {
    // "Watopia - Tempus Fugit" → try "Tempus Fugit"
    candidateNames.push(parts.slice(1).join(" - "));
  }
  // Also try the full name in case someone named it exactly
  candidateNames.push(name);

  for (const candidate of candidateNames) {
    const normalized = normalizeRouteName(candidate);
    const route = routeIndex.byName.get(normalized);
    if (route) return route;
  }

  return null;
}

// --- Main ---

async function main() {
  const env = loadEnv();

  if (!env.STRAVA_REFRESH_TOKEN) {
    console.error("❌ No Strava tokens found. Run the auth script first:");
    console.error("   node scripts/strava-auth.mjs");
    process.exit(1);
  }

  // Load route data
  if (!existsSync(routesPath)) {
    console.error("❌ No routes.json found. Run the route sync first:");
    console.error("   node scripts/sync-routes.mjs");
    process.exit(1);
  }

  const routeData = JSON.parse(readFileSync(routesPath, "utf-8"));
  const routeIndex = buildRouteIndex(routeData.routes);
  console.log(`📋 Loaded ${routeData.routes.length} known routes`);

  // Get access token (refreshes if needed)
  const accessToken = await getAccessToken(env);

  // Fetch activities from the last 2 weeks
  const twoWeeksAgo = Math.floor(Date.now() / 1000) - 14 * 24 * 60 * 60;
  console.log(`\n🔍 Fetching activities since ${new Date(twoWeeksAgo * 1000).toLocaleDateString()}...`);
  const allActivities = await fetchActivities(accessToken, twoWeeksAgo);
  console.log(`   Total activities: ${allActivities.length}`);

  // Filter to virtual rides only
  const virtualRides = allActivities.filter(
    (a) => a.type === "VirtualRide" || a.sport_type === "VirtualRide"
  );
  console.log(`   Virtual rides: ${virtualRides.length}`);

  // Load existing completed routes (for merging)
  let existing = { completedRoutes: [], unmatchedActivities: [] };
  if (existsSync(outputPath)) {
    existing = JSON.parse(readFileSync(outputPath, "utf-8"));
  }

  // Build a set of already-tracked activity IDs
  const trackedIds = new Set(existing.completedRoutes.map((r) => r.activityId));

  // Match rides to routes
  let newMatches = 0;
  let newUnmatched = 0;

  for (const activity of virtualRides) {
    if (trackedIds.has(activity.id)) continue;

    const route = matchActivityToRoute(activity, routeIndex);

    if (route) {
      existing.completedRoutes.push({
        routeSlug: route.slug,
        routeName: route.name,
        worldName: route.worldName,
        activityId: activity.id,
        activityName: activity.name,
        date: activity.start_date_local,
        distance: Math.round(activity.distance) / 1000, // meters → km
        movingTime: activity.moving_time,
        elapsedTime: activity.elapsed_time,
        elevationGain: activity.total_elevation_gain,
        averageWatts: activity.average_watts || null,
        stravaUrl: `https://www.strava.com/activities/${activity.id}`,
      });
      newMatches++;
    } else {
      existing.unmatchedActivities.push({
        activityId: activity.id,
        activityName: activity.name,
        date: activity.start_date_local,
        distance: Math.round(activity.distance) / 1000,
      });
      newUnmatched++;
    }
  }

  // Sort completed routes by date (newest first)
  existing.completedRoutes.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  // Deduplicate completed routes by routeSlug (keep earliest completion)
  const seenSlugs = new Set();
  const uniqueCompletions = [];
  // Sort oldest first for dedup, then re-sort
  const byDateAsc = [...existing.completedRoutes].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
  for (const entry of byDateAsc) {
    if (!seenSlugs.has(entry.routeSlug)) {
      seenSlugs.add(entry.routeSlug);
      uniqueCompletions.push(entry);
    }
  }
  uniqueCompletions.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  const output = {
    syncedAt: new Date().toISOString(),
    totalCompleted: uniqueCompletions.length,
    totalRoutes: routeData.routes.length,
    completedRoutes: uniqueCompletions,
    unmatchedActivities: existing.unmatchedActivities,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`\n✅ Sync complete!`);
  console.log(`   New matches: ${newMatches}`);
  console.log(`   Unmatched: ${newUnmatched}`);
  console.log(`   Total unique routes completed: ${uniqueCompletions.length}/${routeData.routes.length}`);
  console.log(`   → ${outputPath}`);

  if (newUnmatched > 0) {
    console.log(`\n⚠️  Unmatched activities (could not identify route):`);
    for (const u of existing.unmatchedActivities.slice(-newUnmatched)) {
      console.log(`   - "${u.activityName}" (${u.distance.toFixed(1)} km, ${u.date})`);
    }
  }
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
