/**
 * Two pictures of the real pane, for the design record.
 *
 * Not a test — a one-shot that stands the product up the way the e2e does (its
 * own walkd on 8761, its own fixture site on 9342, Chromium's remote debugging
 * on 9341; never 8760, 9340 or 9222) and opens a walk carrying one of every
 * card kind: the look card whose Go was pressed last, a sequence two steps in,
 * a fresh question, a blocked card, two answered cards the agent has not read,
 * three on the shelf with one confirm open, and a withdrawn item. It shoots the
 * panel at 360 wide in light and in dark, into packages/extension/store/shots/
 * — `store/` is gitignored, the way every other build output here is.
 *
 *   node e2e/shots.mjs
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readToken } from "sidewalk-walkd";

const HERE = import.meta.dirname;
const EXT = path.resolve(HERE, "../packages/extension/dist");
const WALKD = path.resolve(HERE, "../packages/walkd/bin/walkd.js");
const OUT = path.resolve(HERE, "../packages/extension/store/shots");
const PORT = 8761, BASE = `http://127.0.0.1:${PORT}`, SITE = "http://127.0.0.1:9342";
const WALK = "kerb-v3";

// This daemon's token, read once it has answered: it refuses every route but
// /health without it (secrets review).
let token = "";
const auth = () => (token ? { authorization: `Bearer ${token}` } : {});
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...auth() }, body: JSON.stringify(b) });
const items = async list => {
  const r = await post(`/walks/${WALK}/items`, { items: list });
  if (r.status !== 200) throw new Error(`items refused (${r.status}): ${await r.text()}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const healthy = async () => { try { return (await (await fetch(`${BASE}/health`)).json()).ok === true; } catch { return false; } };

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-shots-"));
if (await healthy()) throw new Error(`port ${PORT} busy`);
const site = spawn("node", [path.resolve(HERE, "../fixtures/site/serve.mjs")], { env: { ...process.env, PORT: "9342" }, stdio: "inherit" });
const daemon = spawn("node", [WALKD, "serve", "--port", String(PORT), "--data-dir", dataDir, "--state-dir", path.join(dataDir, "state"), "--grace-ms", "0"], { stdio: "inherit" });
for (let i = 0; i < 200 && !(await healthy()); i++) await sleep(100);
token = await readToken(dataDir);

const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--remote-debugging-port=9341"],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const extId = sw.url().split("/")[2];
  await sw.evaluate(([p, tok]) => chrome.storage.local.set({ "walkd:port": p, "walkd:token": tok }), [PORT, token]);

  await post("/walks", { project: "lamppost", id: WALK, title: "Lamppost 2.4", buildRef: "lp-24" });
  const g = "home and lamps";
  const look = (id, title, extra = {}) => ({ id, kind: "look", owner: "demo", group: g, title, url: `${SITE}/`, do: "Look at the row of lamps.", see: "Five lamps, all green, each with its service name under it.", pass: "Every lamp is green and none is missing a name.", ...extra });
  await items([
    // The three that will be read by the agent, so they land on the shelf.
    look("fav", "Last week's incidents"),
    look("pop", "The status link"),
    { id: "tiers-done", kind: "question", owner: "demo", group: g, title: "What do we call the two paid tiers?", options: ["Lit / Bright", "Pro / Team", "Basic / Plus"] },
    // The two the agent has not read: still theirs, green Undo.
    look("chips", "The lamp names wrap at 320"),
    { id: "keep", kind: "question", owner: "demo", group: g, title: "One tap on a lamp", options: ["Keep it", "Open the card"] },
    // The live ones.
    look("rim", "The lamps are green", { url: `${SITE}/` }),
    { id: "king", kind: "sequence", owner: "demo", group: g, title: "The maintenance lock: set it, test it, clear it", url: `${SITE}/other.html`,
      steps: [{ do: "Open the dashboard.", see: "The lock is off and the lamps are green." }, { do: "Turn Maintenance on.", see: "The lamps go amber and a banner says the page is under maintenance." }, { do: "Press Post an update.", see: "Nothing happens: the button is off while the lock is on." }, { do: "Turn Maintenance off.", see: "The lamps go green and the banner goes." }],
      pass: "The lock holds while it is on and lets go when it is off." },
    { id: "tiers", kind: "question", owner: "demo", group: g, title: "What do we call the two paid tiers?", options: ["Lit / Bright", "Pro / Team", "Basic / Plus"], proposal: "What the two paid tiers are called on the pricing page." },
    look("operator", "The dashboard in the dark look", { url: `${SITE}/other.html`, expect: [{ kind: "text", css: "meta[name=build]", attr: "content", equals: "lp-24" }] }),
    look("wd", "A lamp with no service name"),
  ]);

  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(`${SITE}/`);
  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 360, height: 900 });
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  await panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
  await panel.locator(`header[data-walk-id="${WALK}"]`).waitFor({ timeout: 15_000 });
  await panel.locator('[data-item="wd"]').waitFor({ timeout: 15_000 });
  console.log("Atkinson Hyperlegible loaded:", await panel.evaluate(() => document.fonts.check('700 16px "Atkinson Hyperlegible"')));
  // The site is the tab the worker photographs with each verdict; the panel is
  // clicked from behind it, the way a docked side panel is used.
  await page.bringToFront();
  const press = async sel => { await panel.locator(sel).click(); await page.bringToFront(); };

  // Three answers, then an agent read: those three drop to the shelf.
  await panel.locator('[data-note="pop"]').fill("the link came back without its trailing slash the second time");
  await press('[data-kind="pass"][data-for="fav"]');
  await press('[data-kind="issue"][data-for="pop"]');
  await press('[data-item="tiers-done"] input[value="Lit / Bright"]');
  await press('[data-item="tiers-done"] button[data-kind="decision"]');
  await sleep(1500);
  await fetch(`${BASE}/walks/${WALK}/wait?after=0&timeoutMs=0`, { headers: auth() });

  // Two more the agent has not been handed: green Undo, still in the group.
  await panel.locator('[data-note="chips"]').fill("two rows, nothing clipped");
  await press('[data-kind="pass"][data-for="chips"]');
  await press('[data-item="keep"] input[value="Keep it"]');
  await press('[data-item="keep"] button[data-kind="decision"]');

  await post(`/walks/${WALK}/items/wd/withdraw`, { reason: "the lane was reverted" });
  // Go on a card whose expectation fails paints it orange; Go on the one we are
  // actually on paints it blue, and it is the last Go, so it is the current one.
  await press('[data-go="operator"]');
  await sleep(2500);
  await press('[data-go="rim"]');
  await press('[data-step="0"][data-for="king"]');
  await press('[data-step="1"][data-for="king"]');
  await sleep(1500);
  // One shelf line with its confirm open, the way the design page shows it.
  await press('button[data-undo="pop"]');
  await sleep(500);

  await fs.mkdir(OUT, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    await panel.emulateMedia({ colorScheme: scheme });
    await sleep(400);
    await panel.screenshot({ path: path.join(OUT, `2026-09-18-pane-${scheme}.png`), fullPage: true });
    console.log("wrote", path.join(OUT, `2026-09-18-pane-${scheme}.png`));
  }
} finally {
  await ctx.close();
  daemon.kill("SIGTERM");
  site.kill("SIGTERM");
  await fs.rm(dataDir, { recursive: true, force: true });
}
