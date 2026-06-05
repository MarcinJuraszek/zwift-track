// Fetch ALL activities from Strava and save raw data locally.
// This avoids repeated API calls while we iterate on matching logic.
// Run: node scripts/fetch-all-activities.mjs

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");
const outputPath = resolve(__dirname, "../src/data/raw-activities.json");

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

  env.STRAVA_ACCESS_TOKEN = data.access_token;
  env.STRAVA_REFRESH_TOKEN = data.refresh_token;
  env.STRAVA_TOKEN_EXPIRES_AT = String(data.expires_at);
  saveEnv(env);
  return data.access_token;
}

async function main() {
  const env = loadEnv();
  const accessToken = await getAccessToken(env);

  const allActivities = [];
  let page = 1;
  const perPage = 100;

  console.log("🔍 Fetching all activities from Strava...");

  while (true) {
    const url = new URL("https://www.strava.com/api/v3/athlete/activities");
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));

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

    // Log rate limit headers
    const rateLimit = res.headers.get("x-ratelimit-limit");
    const rateUsage = res.headers.get("x-ratelimit-usage");
    
    const batch = await res.json();
    if (batch.length === 0) break;

    allActivities.push(...batch);
    console.log(`   Page ${page}: ${batch.length} activities (total: ${allActivities.length}) [rate: ${rateUsage}/${rateLimit}]`);

    if (batch.length < perPage) break;
    page++;
  }

  // Separate virtual rides from everything else
  const virtualRides = allActivities.filter(
    (a) => a.type === "VirtualRide" || a.sport_type === "VirtualRide"
  );

  const output = {
    fetchedAt: new Date().toISOString(),
    totalActivities: allActivities.length,
    virtualRideCount: virtualRides.length,
    virtualRides,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`\n✅ Done!`);
  console.log(`   Total activities: ${allActivities.length}`);
  console.log(`   Virtual rides: ${virtualRides.length}`);
  console.log(`   Saved to: ${outputPath}`);
  console.log(`   API pages used: ${page}`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
