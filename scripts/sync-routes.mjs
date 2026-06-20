import { routes, worlds } from "zwift-data";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(__dirname, "../src/data/routes.json");

const worldMap = Object.fromEntries(worlds.map((w) => [w.slug, w]));

// Manual display name overrides (slug → display name)
const nameOverrides = {
  "figure-8": "Figure 8",
  "figure-8-reverse": "Figure 8 Reverse",
  "flat-route": "Flat Route",
  "mountain-route": "Mountain Route",
};

// Routes missing from zwift-data npm package (added to Zwift after last package update)
const extraRoutes = [
  {
    id: 2521625692,
    name: "Yumezi Grit",
    slug: "yumezi-grit",
    world: "makuri-islands",
    eventOnly: false,
    distance: 7.486,
    elevation: 83,
    leadInDistance: 0.01,
    leadInElevation: 0,
    levelLocked: false,
    lap: true,
    sports: ["cycling"],
    experience: 150,
    stravaSegmentId: null,
    stravaSegmentUrl: null,
    zwiftInsiderUrl: "https://zwiftinsider.com/route/yumezi-grit",
  },
];

// Only include routes that support cycling
const allRoutes = [
  ...routes.filter((route) => route.sports.includes("cycling")),
  ...extraRoutes,
];

const routeData = allRoutes
  .map((route) => {
    const worldName = worldMap[route.world]?.name ?? route.world;
    return {
      id: route.id,
      name: nameOverrides[route.slug] ?? route.name,
      slug: route.slug,
      world: route.world,
      worldName,
      distance: route.distance,
      elevation: route.elevation,
      gradient: route.distance > 0 ? Math.round((route.elevation / (route.distance * 1000)) * 1000) / 10 : 0,
      experience: route.experience ?? 0,
      leadInDistance: route.leadInDistance,
      leadInElevation: route.leadInElevation ?? 0,
      eventOnly: route.eventOnly,
      lap: route.lap,
      levelLocked: route.levelLocked,
      stravaSegmentId: route.stravaSegmentId ?? null,
      stravaSegmentUrl: route.stravaSegmentUrl ?? null,
      zwiftInsiderUrl: route.zwiftInsiderUrl ?? null,
    };
  });

// Sort by world, then by name
routeData.sort((a, b) => {
  if (a.worldName !== b.worldName) return a.worldName.localeCompare(b.worldName);
  return a.name.localeCompare(b.name);
});

const worldSummary = {};
for (const route of routeData) {
  if (!worldSummary[route.worldName]) {
    worldSummary[route.worldName] = { total: 0 };
  }
  worldSummary[route.worldName].total++;
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
