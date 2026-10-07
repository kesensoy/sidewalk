// Renders the Kerb mark (design language v3) to the PNG sizes the manifest
// needs. 16 and 32 come from the 16-grid drawing, whose slabs sit on whole
// pixels; 48 and 128 from the 48-grid one. Run from packages/extension:
//   node icons/render.mjs
// Uses the Playwright Chromium the e2e already installs; no other dependency.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const plan = [
  { size: 16, svg: "mark-16.svg", grid: 16 },
  { size: 32, svg: "mark-16.svg", grid: 16 },
  { size: 48, svg: "mark.svg", grid: 48 },
  { size: 128, svg: "mark.svg", grid: 48 },
];

const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  for (const { size, svg, grid } of plan) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const body = readFileSync(path.join(here, svg), "utf8").replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${body}`);
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    writeFileSync(path.join(here, `icon-${size}.png`), png);
    console.log(`icon-${size}.png from ${svg} (${grid}-grid)`);
    await page.close();
  }
} finally {
  await browser.close();
}
