import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function syncFixture(t, upstream, supplemental) {
  const directory = mkdtempSync(join(tmpdir(), "zwift-track-routes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const path of ["scripts", "src/data", "node_modules/zwift-data"]) {
    mkdirSync(join(directory, path), { recursive: true });
  }
  copyFileSync(
    new URL("./sync-routes.mjs", import.meta.url),
    join(directory, "scripts/sync-routes.mjs")
  );
  writeFileSync(
    join(directory, "node_modules/zwift-data/package.json"),
    JSON.stringify({ type: "module", exports: "./index.mjs" })
  );
  writeFileSync(
    join(directory, "node_modules/zwift-data/index.mjs"),
    `export const routes = ${JSON.stringify(upstream)};
     export const worlds = [{ slug: "watopia", name: "Watopia" }];`
  );
  writeFileSync(
    join(directory, "src/data/supplemental-routes.json"),
    JSON.stringify({ routes: supplemental })
  );
  execFileSync(process.execPath, [join(directory, "scripts/sync-routes.mjs")]);
  return JSON.parse(
    readFileSync(join(directory, "src/data/routes.json"), "utf-8")
  );
}

const existingRoute = {
  id: 1,
  name: "Existing Route",
  slug: "existing-route",
  world: "watopia",
  sports: ["cycling"],
  distance: 10,
  elevation: 100,
};

test("adds supplemental cycling routes with segment IDs without changing existing routes", (t) => {
  const supplemental = JSON.parse(
    readFileSync(new URL("../src/data/supplemental-routes.json", import.meta.url), "utf-8")
  ).routes;
  const baseline = syncFixture(t, [existingRoute], []);
  const output = syncFixture(t, [existingRoute], [
    ...supplemental,
    { ...existingRoute, slug: "running-only", sports: ["running"] },
  ]);

  assert.equal(output.totalRoutes, 10);
  assert.equal(output.worlds[0].routeCount, 10);
  assert.deepEqual(
    output.routes.find((route) => route.slug === existingRoute.slug),
    baseline.routes[0]
  );
  assert.equal(new Set(output.routes.map((route) => route.slug)).size, 10);
  const pacific = output.routes.find((route) => route.slug === "pacific-pursuit");
  assert.equal(pacific.stravaSegmentId, 42422497);
  assert.equal(pacific.worldName, "Watopia");
  const california = output.routes.find((route) => route.slug === "california-dreamin");
  assert.equal(california.leadInDistance, 0);
  assert.equal(california.leadInDistanceEvent, 2.2);
});

test("uses upstream specifications when a supplemental route is published upstream", (t) => {
  const upstream = {
    ...existingRoute,
    slug: "pacific-pursuit",
    name: "Pacific Pursuit",
    distance: 53.9,
    stravaSegmentId: 42422497,
  };
  const output = syncFixture(t, [upstream], [
    { ...upstream, id: null, distance: 54, stravaSegmentId: 99 },
  ]);

  assert.equal(output.totalRoutes, 1);
  assert.equal(output.routes[0].id, upstream.id);
  assert.equal(output.routes[0].distance, upstream.distance);
  assert.equal(output.routes[0].stravaSegmentId, upstream.stravaSegmentId);
});
