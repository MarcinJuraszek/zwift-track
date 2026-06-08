// Sync Zwift rides from Strava and match to known routes.
// Uses Strava segment matching as source of truth, with manual overrides
// for routes that can't be detected by segments. Name mismatches are
// surfaced as warnings for manual review.
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
const manualCompletionsPath = resolve(
  __dirname,
  "../src/data/manual-completions.json"
);
const outputPath = resolve(__dirname, "../src/data/completed-routes.json");

// --- Env helpers ---

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
  if (!existsSync(envPath) && !process.env.CI) return;
  if (process.env.CI) return;
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

  // In CI, write the new refresh token so the workflow can update the secret
  if (process.env.CI) {
    const tokenPath = resolve(__dirname, "../.strava-refresh-token");
    writeFileSync(tokenPath, data.refresh_token);
  }

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

  // Fetch detailed activity data for all rides (segment-based matching)
  console.log(`\n🔍 Segment-based matching for all ${virtualRides.length} activities...`);
  const detailedCache = loadDetailedCache();
  let apiCalls = 0;

  // Get access token if we need to fetch any uncached activities
  const uncachedCount = virtualRides.filter(
    (a) => !detailedCache[String(a.id)]
  ).length;
  let accessToken = null;
  if (uncachedCount > 0) {
    console.log(`   ${uncachedCount} activities need fetching from API`);
    if (!env.STRAVA_REFRESH_TOKEN) {
      console.log(
        `   ⚠️  No Strava tokens — using only cached detailed data`
      );
    } else {
      accessToken = await getAccessToken(env);
    }
  } else {
    console.log(`   All activities cached — no API calls needed`);
  }

  const completions = [];
  const unmatchedList = [];
  const reviewItems = []; // Name says one thing, segments say another

  for (const activity of virtualRides) {
    const cacheKey = String(activity.id);

    // Fetch detailed activity if not cached
    if (!detailedCache[cacheKey]) {
      if (!accessToken) {
        unmatchedList.push(activity);
        continue;
      }

      try {
        const detailed = await fetchDetailedActivity(
          activity.id,
          accessToken
        );
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

        if (apiCalls % 10 === 0) {
          console.log(`   (${apiCalls} API calls so far, pausing 2s...)`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (err) {
        console.log(
          `   ⚠️  Failed to fetch ${activity.id}: ${err.message}`
        );
        unmatchedList.push(activity);
        continue;
      }
    }

    // Match by segments (source of truth)
    const segRoutes = matchActivityBySegments(
      detailedCache[cacheKey],
      routeIndex
    );
    const segSlugs = new Set(segRoutes.map((r) => r.slug));

    for (const route of segRoutes) {
      addCompletion(completions, route, activity, "segment");
    }

    // Check name-based matching — flag mismatches for review
    const nameRoutes = matchActivityToRouteByName(activity, routeIndex);
    if (nameRoutes) {
      for (const route of nameRoutes) {
        if (!segSlugs.has(route.slug)) {
          reviewItems.push({
            activityId: activity.id,
            activityName: activity.name,
            date: activity.start_date_local,
            stravaUrl: `https://www.strava.com/activities/${activity.id}`,
            nameMatchedRoute: route.name,
            nameMatchedSlug: route.slug,
            nameMatchedWorld: route.worldName,
            segmentMatchedRoutes: segRoutes.map((r) => r.name),
          });
        }
      }
    }

    if (segSlugs.size === 0 && !nameRoutes) {
      unmatchedList.push(activity);
    }
  }

  // Save detailed activity cache
  saveDetailedCache(detailedCache);
  if (apiCalls > 0) {
    console.log(`   API calls made: ${apiCalls} (cached for future runs)`);
  }

  console.log(
    `   Segment matches: ${completions.length} route completions`
  );
  console.log(`   Unmatched: ${unmatchedList.length} activities`);

  // Load manual overrides
  let manualOverrides = { completions: [], exclusions: [] };
  if (existsSync(manualCompletionsPath)) {
    manualOverrides = JSON.parse(
      readFileSync(manualCompletionsPath, "utf-8")
    );
    if (!manualOverrides.exclusions) manualOverrides.exclusions = [];
  }

  // Apply exclusions — remove segment matches the user says are wrong
  // Exclusions match on { activityId, routeSlug } or just { routeSlug } (blanket)
  const exclusionSet = new Set(
    manualOverrides.exclusions.map((e) =>
      e.activityId ? `${e.activityId}:${e.routeSlug}` : `*:${e.routeSlug}`
    )
  );
  const beforeExclusions = completions.length;
  const filtered = completions.filter((c) => {
    const specificKey = `${c.activityId}:${c.routeSlug}`;
    const blanketKey = `*:${c.routeSlug}`;
    return !exclusionSet.has(specificKey) && !exclusionSet.has(blanketKey);
  });
  const excluded = beforeExclusions - filtered.length;
  if (excluded > 0) {
    console.log(`   Exclusions applied: ${excluded} completions removed`);
  }
  completions.length = 0;
  completions.push(...filtered);

  // Add manual completions
  const segMatchedSlugs = new Set(completions.map((c) => c.routeSlug));
  let manualAdded = 0;
  for (const manual of manualOverrides.completions) {
    const route = routeData.routes.find((r) => r.slug === manual.routeSlug);
    if (!route) {
      console.log(
        `   ⚠️  Manual completion references unknown route: ${manual.routeSlug}`
      );
      continue;
    }
    if (segMatchedSlugs.has(manual.routeSlug)) continue; // already found by segments

    completions.push({
      routeSlug: route.slug,
      routeName: route.name,
      worldName: route.worldName,
      activityId: null,
      activityName: manual.note || "Manual override",
      date: manual.date,
      distance: null,
      movingTime: null,
      elapsedTime: null,
      elevationGain: null,
      averageWatts: null,
      stravaUrl: manual.stravaUrl || null,
      matchMethod: "manual",
    });
    manualAdded++;
  }
  if (manualAdded > 0) {
    console.log(`   Manual completions: ${manualAdded} routes added`);
  }

  const unmatchedActivities = unmatchedList.map((a) => ({
    activityId: a.id,
    activityName: a.name,
    date: a.start_date_local,
    distance: Math.round(a.distance) / 1000,
  }));

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

  // Surface name/segment mismatches for manual review
  // Filter out items already in manual completions or exclusions
  const manualSlugs = new Set(
    manualOverrides.completions.map((c) => c.routeSlug)
  );
  const pendingReview = reviewItems.filter(
    (r) =>
      !manualSlugs.has(r.nameMatchedSlug) &&
      !exclusionSet.has(`${r.activityId}:${r.nameMatchedSlug}`) &&
      !exclusionSet.has(`*:${r.nameMatchedSlug}`)
  );

  if (pendingReview.length > 0) {
    console.log(
      `\n🔎 Review needed (${pendingReview.length}): activity title suggests a route not confirmed by segments.`
    );
    console.log(
      `   Check in Zwift and add to manual-completions.json if confirmed:`
    );
    for (const r of pendingReview) {
      console.log(`\n   "${r.activityName}"`);
      console.log(`     Title says: ${r.nameMatchedRoute} (${r.nameMatchedWorld})`);
      console.log(
        `     Segments found: ${r.segmentMatchedRoutes.length > 0 ? r.segmentMatchedRoutes.join(", ") : "none"}`
      );
      console.log(`     ${r.stravaUrl}`);
      console.log(
        `     → To confirm:  add to "completions" with slug "${r.nameMatchedSlug}"`
      );
      console.log(
        `     → To dismiss:  add to "exclusions" with activityId ${r.activityId} and slug "${r.nameMatchedSlug}"`
      );
    }
  }

  if (unmatchedActivities.length > 0) {
    console.log(
      `\n⚠️  Unmatched activities (${unmatchedActivities.length}):`
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
