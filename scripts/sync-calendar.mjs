// Scrapes the Zwift Insider world calendar using Playwright.
// Extracts current and next month schedules, outputs world-calendar.json.
//
// Usage: node scripts/sync-calendar.mjs

import { chromium } from "playwright";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(__dirname, "..", "src", "data", "world-calendar.json");

// Map display names to world slugs used in routes.json
const WORLD_SLUG_MAP = {
  "watopia": "watopia",
  "new york": "new-york",
  "makuri islands": "makuri-islands",
  "london": "london",
  "france": "france",
  "scotland": "scotland",
  "richmond": "richmond",
  "yorkshire": "yorkshire",
  "innsbruck": "innsbruck",
  "paris": "paris",
  "crit city": "crit-city",
  "bologna": "bologna",
};

function parseWorldName(text) {
  const slug = WORLD_SLUG_MAP[text.toLowerCase().trim()];
  if (!slug) console.warn(`  ⚠ Unknown world: "${text}"`);
  return slug;
}

async function scrapeMonth(page) {
  // Get the month/year header
  const monthHeader = await page.locator("table td").nth(2).textContent();
  const [monthName, year] = monthHeader.trim().split(" ");
  const monthDate = new Date(`${monthName} 1, ${year}`);
  const monthNum = String(monthDate.getMonth() + 1).padStart(2, "0");
  const yearNum = monthDate.getFullYear();

  console.log(`Scraping ${monthName} ${yearNum}...`);

  // Get all calendar day cells (skip header rows)
  const allCells = await page.locator("table").first().locator("td").allTextContents();

  const schedule = {};
  for (const cell of allCells) {
    // Day cells start with a number, followed by world names
    const match = cell.match(/^(\d{1,2})(.+)/s);
    if (!match) continue;

    const day = parseInt(match[1], 10);
    if (day < 1 || day > 31) continue;

    const worldText = match[2];
    // World names appear doubled (visible text + link text run together).
    // Split on newlines, trim, filter empties, then deduplicate.
    const worldNames = worldText
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // Each world name appears as "LondonLondon" — split doubled names
    const cleaned = worldNames.flatMap((name) => {
      // Try to split doubled names: find a point where first half === second half
      for (let i = 1; i <= name.length / 2; i++) {
        const first = name.substring(0, i);
        const rest = name.substring(i);
        if (first === rest) return [first];
      }
      return [name];
    });

    const unique = [...new Set(cleaned)];
    const slugs = unique.map(parseWorldName).filter(Boolean);

    if (slugs.length > 0) {
      const dateKey = `${yearNum}-${monthNum}-${String(day).padStart(2, "0")}`;
      schedule[dateKey] = slugs;
    }
  }

  return schedule;
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto("https://zwiftinsider.com/schedule/", {
    waitUntil: "networkidle",
  });

  // Scrape current month
  const currentSchedule = await scrapeMonth(page);

  // Navigate to next month
  await page.locator("table td a").filter({ hasText: ">" }).click();
  await page.waitForTimeout(1000);

  // Scrape next month
  const nextSchedule = await scrapeMonth(page);

  await browser.close();

  const schedule = { ...currentSchedule, ...nextSchedule };
  const sortedSchedule = Object.fromEntries(
    Object.entries(schedule).sort(([a], [b]) => a.localeCompare(b))
  );

  const output = {
    note: "Auto-generated from Zwift Insider. Watopia is always available and not listed.",
    lastUpdated: new Date().toISOString().split("T")[0],
    schedule: sortedSchedule,
  };

  writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n✅ Wrote ${Object.keys(sortedSchedule).length} days to ${OUTPUT}`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
