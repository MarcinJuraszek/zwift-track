import { routes, worlds } from "zwift-data";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(__dirname, "../src/data/routes.json");

const worldMap = Object.fromEntries(worlds.map((w) => [w.slug, w]));

const routeData = routes.map((route) => ({
  id: route.id,
  name: route.name,
  slug: route.slug,
  world: route.world,
  worldName: worldMap[route.world]?.name ?? route.world,
  distance: route.distance,
  elevation: route.elevation,
  leadInDistance: route.leadInDistance,
  eventOnly: route.eventOnly,
  lap: route.lap,
  sports: route.sports,
  levelLocked: route.levelLocked,
  stravaSegmentUrl: route.stravaSegmentUrl ?? null,
  zwiftInsiderUrl: route.zwiftInsiderUrl ?? null,
  whatsOnZwiftUrl: route.whatsOnZwiftUrl ?? null,
}));

// Sort by world, then by name
routeData.sort((a, b) => {
  if (a.worldName !== b.worldName) return a.worldName.localeCompare(b.worldName);
  return a.name.localeCompare(b.name);
});

const worldSummary = {};
for (const route of routeData) {
  if (!worldSummary[route.worldName]) {
    worldSummary[route.worldName] = { total: 0, cycling: 0, running: 0 };
  }
  worldSummary[route.worldName].total++;
  if (route.sports.includes("cycling")) worldSummary[route.worldName].cycling++;
  if (route.sports.includes("running")) worldSummary[route.worldName].running++;
}

const output = {
  generatedAt: new Date().toISOString(),
  totalRoutes: routeData.length,
  worlds: worlds.map((w) => ({
    slug: w.slug,
    name: w.name,
    routeCount: worldSummary[w.name]?.total ?? 0,
  })),
  routes: routeData,
};

writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`✅ Synced ${routeData.length} routes across ${worlds.length} worlds → ${outputPath}`);
