// Sync Zwift rides from Strava and match to known routes.
// Uses name parsing first, then falls back to Strava segment matching.
// Caches detailed activity data locally to avoid repeated API calls.
// Run: node scripts/sync-activities.mjs

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
const routesPath = resolve(__dirname, "../src/data/routes.json");
const rawActivitiesPath = resolve(__dirname, "../src/data/raw-activities.json");
const detailedActivitiesPath = resolve(
  __dirname,
  "../src/data/detailed-activities.json"
);
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
  const worldNames = new Set();
  const byStravaSegmentId = new Map();
  for (const route of routes) {
    byName.set(normalizeRouteName(route.name), route);
    worldNames.add(route.worldName.toLowerCase());
    if (route.stravaSegmentId) {
      byStravaSegmentId.set(route.stravaSegmentId, route);
    }
  }
  return { byName, worldNames, byStravaSegmentId, routes };
}

function matchActivityToRouteByName(activity, routeIndex) {
  const { name } = activity;
  if (!name) return null;

  const candidateNames = [];

  // Strip common prefixes
  let stripped = name;
  stripped = stripped.replace(/^\d+x\s+/i, "");
  if (stripped.startsWith("Zwift - ")) {
    stripped = stripped.slice("Zwift - ".length);
  }

  // Handle "Pacer Group Ride: Route in World with PacerName"
  const pacerMatch = stripped.match(/^Pacer Group Ride:\s+(.+?)\s+in\s+.+?\s+with\s+\w+$/i);
  if (pacerMatch) {
    candidateNames.push(pacerMatch[1]);
  }

  // Handle "Group Ride: ... on Route in World"
  const groupOnMatch = stripped.match(/on\s+(.+?)\s+in\s+[\w\s]+$/i);
  if (groupOnMatch) {
    candidateNames.push(groupOnMatch[1]);
  }

  // Handle "Route in KnownWorld" — only strip if suffix is a known world name
  for (const world of routeIndex.worldNames) {
    const suffix = ` in ${world}`;
    if (stripped.toLowerCase().endsWith(suffix)) {
      const routePart = stripped.slice(0, -suffix.length);
      candidateNames.push(routePart);
      // Some routes are named "World Route" (e.g. "London Classique")
      const worldCapitalized = stripped.slice(stripped.length - suffix.length + 4);
      candidateNames.push(`${worldCapitalized} ${routePart}`);
      break;
    }
  }

  // Handle "World - Route" format
  const dashParts = stripped.split(" - ");
  if (dashParts.length >= 2) {
    candidateNames.push(dashParts.slice(1).join(" - "));
  }

  // Try the stripped name as-is
  candidateNames.push(stripped);

  // Try the full original name
  candidateNames.push(name);

  for (const candidate of candidateNames) {
    const normalized = normalizeRouteName(candidate);
    const route = routeIndex.byName.get(normalized);
    if (route) return [route];
  }

  return null;
}

// Match using Strava segment efforts from detailed activity data.
// Returns an array of matched routes (may be multiple per activity).
function matchActivityBySegments(detailedActivity, routeIndex) {
  const segmentEfforts = detailedActivity.segment_efforts || [];
  if (segmentEfforts.length === 0) return [];

  const matched = [];
  const seenSlugs = new Set();
  for (const effort of segmentEfforts) {
    const segId = effort.segment?.id;
    if (!segId) continue;
    const route = routeIndex.byStravaSegmentId.get(segId);
    if (route && !seenSlugs.has(route.slug)) {
      seenSlugs.add(route.slug);
      matched.push(route);
    }
  }

  return matched;
}

// --- Detailed activity cache ---

function loadDetailedCache() {
  if (existsSync(detailedActivitiesPath)) {
    return JSON.parse(readFileSync(detailedActivitiesPath, "utf-8"));
  }
  return {};
}

function saveDetailedCache(cache) {
  writeFileSync(detailedActivitiesPath, JSON.stringify(cache, null, 2));
}

async function fetchDetailedActivity(activityId, accessToken) {
  const res = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Strava API error ${res.status} for activity ${activityId}: ${body}`
    );
  }

  return await res.json();
}

// --- Main ---

function addCompletion(completions, route, activity, matchMethod) {
  completions.push({
    routeSlug: route.slug,
    routeName: route.name,
    worldName: route.worldName,
    activityId: activity.id,
    activityName: activity.name,
    date: activity.start_date_local,
    distance: Math.round(activity.distance) / 1000,
    movingTime: activity.moving_time,
    elapsedTime: activity.elapsed_time,
    elevationGain: activity.total_elevation_gain,
    averageWatts: activity.average_watts || null,
    stravaUrl: `https://www.strava.com/activities/${activity.id}`,
    matchMethod,
  });
}

async function main() {
  const env = loadEnv();

  // Load route data
  if (!existsSync(routesPath)) {
    console.error("❌ No routes.json found. Run the route sync first:");
    console.error("   node scripts/sync-routes.mjs");
    process.exit(1);
  }

  const routeData = JSON.parse(readFileSync(routesPath, "utf-8"));
  const routeIndex = buildRouteIndex(routeData.routes);
  console.log(`📋 Loaded ${routeData.routes.length} known routes`);
  console.log(
    `   ${routeIndex.byStravaSegmentId.size} routes have Strava segment IDs`
  );

  // Load virtual rides — prefer cached raw data, fall back to API
  let virtualRides;

  if (existsSync(rawActivitiesPath)) {
    console.log(`\n📂 Using cached activities from ${rawActivitiesPath}`);
    const raw = JSON.parse(readFileSync(rawActivitiesPath, "utf-8"));
    virtualRides = raw.virtualRides;
    console.log(
      `   Virtual rides: ${virtualRides.length} (fetched ${raw.fetchedAt})`
    );
  } else {
    if (!env.STRAVA_REFRESH_TOKEN) {
      console.error("❌ No cached data and no Strava tokens. Run one of:");
      console.error(
        "   node scripts/fetch-all-activities.mjs  (preferred)"
      );
      console.error(
        "   node scripts/strava-auth.mjs           (then re-run)"
      );
      process.exit(1);
    }

    const accessToken = await getAccessToken(env);
    const twoWeeksAgo = Math.floor(Date.now() / 1000) - 14 * 24 * 60 * 60;
    console.log(
      `\n🔍 Fetching activities since ${new Date(twoWeeksAgo * 1000).toLocaleDateString()}...`
    );
    const allActivities = await fetchActivities(accessToken, twoWeeksAgo);
    console.log(`   Total activities: ${allActivities.length}`);

    virtualRides = allActivities.filter(
      (a) => a.type === "VirtualRide" || a.sport_type === "VirtualRide"
    );
    console.log(`   Virtual rides: ${virtualRides.length}`);
  }

  // Phase 1: Name-based matching
  console.log(`\n🔤 Phase 1: Name-based matching...`);
  const completions = [];
  const unmatchedByName = [];
  let nameMatches = 0;

  for (const activity of virtualRides) {
    const routes = matchActivityToRouteByName(activity, routeIndex);

    if (routes) {
      for (const route of routes) {
        addCompletion(completions, route, activity, "name");
      }
      nameMatches++;
    } else {
      unmatchedByName.push(activity);
    }
  }
  console.log(
    `   Matched: ${nameMatches} activities → ${completions.length} route completions`
  );
  console.log(`   Unmatched: ${unmatchedByName.length} activities`);

  // Phase 2: Segment-based matching for unmatched activities
  if (unmatchedByName.length > 0) {
    console.log(`\n🔍 Phase 2: Segment-based matching...`);

    // Load or initialize detailed activity cache
    const detailedCache = loadDetailedCache();
    let apiCalls = 0;
    let segmentMatches = 0;
    let segmentRouteCount = 0;
    const stillUnmatched = [];

    // Get access token only if we need to make API calls
    const needsApi = unmatchedByName.some(
      (a) => !detailedCache[String(a.id)]
    );
    let accessToken = null;
    if (needsApi) {
      if (!env.STRAVA_REFRESH_TOKEN) {
        console.log(
          `   ⚠️  No Strava tokens — can only use cached detailed data`
        );
      } else {
        accessToken = await getAccessToken(env);
      }
    }

    for (const activity of unmatchedByName) {
      const cacheKey = String(activity.id);

      // Fetch detailed activity if not cached
      if (!detailedCache[cacheKey]) {
        if (!accessToken) {
          stillUnmatched.push(activity);
          continue;
        }

        console.log(
          `   Fetching details for "${activity.name}" (${activity.id})...`
        );
        try {
          const detailed = await fetchDetailedActivity(
            activity.id,
            accessToken
          );
          // Cache only what we need: segment efforts
          detailedCache[cacheKey] = {
            id: detailed.id,
            name: detailed.name,
            segment_efforts: (detailed.segment_efforts || []).map((se) => ({
              name: se.name,
              segment: { id: se.segment?.id, name: se.segment?.name },
            })),
            fetchedAt: new Date().toISOString(),
          };
          apiCalls++;

          // Brief delay to be kind to rate limits
          if (apiCalls % 10 === 0) {
            console.log(`   (${apiCalls} API calls so far, pausing 2s...)`);
            await new Promise((r) => setTimeout(r, 2000));
          }
        } catch (err) {
          console.log(
            `   ⚠️  Failed to fetch ${activity.id}: ${err.message}`
          );
          stillUnmatched.push(activity);
          continue;
        }
      }

      // Match by segments
      const routes = matchActivityBySegments(
        detailedCache[cacheKey],
        routeIndex
      );

      if (routes.length > 0) {
        for (const route of routes) {
          addCompletion(completions, route, activity, "segment");
        }
        segmentMatches++;
        segmentRouteCount += routes.length;
        console.log(
          `   ✅ "${activity.name}" → ${routes.map((r) => r.name).join(", ")}`
        );
      } else {
        stillUnmatched.push(activity);
      }
    }

    // Save detailed activity cache
    saveDetailedCache(detailedCache);
    console.log(
      `   Segment matches: ${segmentMatches} activities → ${segmentRouteCount} route completions`
    );
    if (apiCalls > 0) {
      console.log(`   API calls made: ${apiCalls} (cached for future runs)`);
    }

    // Record still-unmatched
    if (stillUnmatched.length > 0) {
      console.log(`   Still unmatched: ${stillUnmatched.length} activities`);
    }

    var unmatchedActivities = stillUnmatched.map((a) => ({
      activityId: a.id,
      activityName: a.name,
      date: a.start_date_local,
      distance: Math.round(a.distance) / 1000,
    }));
  } else {
    var unmatchedActivities = [];
  }

  // Sort completed routes by date (newest first)
  completions.sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  // Deduplicate completed routes by routeSlug (keep earliest completion)
  const seenSlugs = new Set();
  const uniqueCompletions = [];
  const byDateAsc = [...completions].sort(
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
    unmatchedActivities,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`\n✅ Sync complete!`);
  console.log(
    `   Total unique routes completed: ${uniqueCompletions.length}/${routeData.routes.length}`
  );
  console.log(`   → ${outputPath}`);

  if (unmatchedActivities.length > 0) {
    console.log(
      `\n⚠️  Still unmatched activities (${unmatchedActivities.length}):`
    );
    for (const u of unmatchedActivities) {
      console.log(
        `   - "${u.activityName}" (${u.distance.toFixed(1)} km, ${u.date})`
      );
    }
  }
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
