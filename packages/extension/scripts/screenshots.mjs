#!/usr/bin/env node
/**
 * The listing's pictures: five store screenshots, a dark one, and the two
 * promo tiles. Nothing here is drawn by hand.
 *
 *   npm run build && npm run screenshots
 *   node packages/extension/scripts/screenshots.mjs
 *
 * Into `packages/extension/store/` (gitignored), at the sizes the Chrome Web
 * Store takes and Firefox accepts anything of:
 *
 *   01-go.png … 05-ask.png      1280×800   the five cards the README's clips show
 *   06-dark.png                 1280×800   the same pane on wet asphalt
 *   tile-small.png               440×280   the small promo tile (CWS requires one)
 *   tile-marquee.png            1400×560   the marquee (optional)
 *
 * Each frame is the real product: Lamppost (`demo/site`) on the left at 880,
 * the real pane loaded from `dist` on the right at 400, composed to exactly
 * 1280 — so every pixel is 1:1 and nothing is scaled or retouched. The pane is
 * driven through its own buttons, the way `e2e/shots.mjs` drives it, and the
 * agent's half is plain HTTP to walkd, the way `demo/run.mjs` does it.
 *
 * The tiles are the mark (`icons/mark.svg`) and one line, set in the pane's
 * own Atkinson Hyperlegible on the pane's own ground — the colours are read
 * out of `src/panel.css` at run time rather than copied here, so a palette
 * change moves them.
 *
 * Ports: walkd 8766, Lamppost 9346, Chromium's remote debugging 9347. Not
 * 8760/9340 (the human's), 8761/9342/9341 (the e2e's), 8763/9353/9343 (the
 * recorder's), 8764/8765/9344 (`firefox-check.mjs`), and never 9222.
 *
 * The daemon it starts is its own, in a fresh data dir, and it wants its token
 * on every request: the token is read out of that data dir once the daemon has
 * answered, sent on each post, and written into the extension's storage beside
 * the port, or the pane paints the token notice instead of cards.
 */
import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { loadPack } from "../../../demo/run.mjs";
import { ASK_TEXT, retarget } from "../../../demo/record.mjs";
import { readToken } from "sidewalk-walkd";

const HERE = import.meta.dirname;
const EXT = path.resolve(HERE, "..");
const ROOT = path.resolve(EXT, "../..");
const DIST = path.join(EXT, "dist");
const OUT = path.join(EXT, "store");
const WALKD = path.join(ROOT, "packages", "walkd", "bin", "walkd.js");

const PORT = 8766, SITE_PORT = 9346, DEBUG_PORT = 9347;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const WALK = "lamppost";
/** 880 + 400 = 1280, so the composition is 1:1 and nothing is ever resampled. */
const SITE_W = 880, PANE_W = 400, H = 800;

const sleep = ms => new Promise(r => setTimeout(r, ms));
// The daemon this script starts refuses every route but /health without its
// token (secrets review), and it writes that token into the data dir below
// — so it is read once the daemon has answered and sent on everything after
// that, the way e2e/shots.mjs does it. Without this the two POSTs are 401 and
// the run dies before the browser launches (found in review).
// Named for the daemon, because a `token` reader of CSS variables lives
// further down this file and the two must not collide.
let walkdToken = "";
const auth = () => (walkdToken ? { authorization: `Bearer ${walkdToken}` } : {});
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...auth() }, body: JSON.stringify(b) });
const healthy = async () => { try { return (await (await fetch(`${BASE}/health`)).json()).ok === true; } catch { return false; } };
const free = port => new Promise(res => {
  const s = net.createServer().once("error", () => res(false)).once("listening", () => s.close(() => res(true))).listen(port, "127.0.0.1");
});

for (const [p, who] of [[PORT, "walkd"], [SITE_PORT, "Lamppost"], [DEBUG_PORT, "Chromium's remote debugging"]]) {
  if (!(await free(p))) throw new Error(`port ${p} (${who}) is busy — this script would be talking to somebody else's`);
}

await fs.mkdir(OUT, { recursive: true });
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-shots-"));
const kids = [];
const kid = (cmd, args, env) => { const c = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } }); kids.push(c); return c; };
kid("node", [path.join(ROOT, "demo", "site", "serve.mjs")], { PORT: String(SITE_PORT) });
// `--grace-ms 20000`: the Undo frame wants two green Undos with their drain
// bars still visibly draining, and the default ten seconds runs out while the
// hand is still on the next card. `--no-copy` keeps the token this fresh data
// dir mints off the clipboard of whoever is taking the pictures.
kid("node", [WALKD, "serve", "--port", String(PORT), "--data-dir", dataDir, "--state-dir", path.join(dataDir, "state"), "--grace-ms", "20000", "--no-copy"]);
for (let i = 0; i < 200 && !(await healthy()); i++) await sleep(100);
if (!(await healthy())) throw new Error(`no walkd on ${PORT}`);
walkdToken = await readToken(dataDir);

/* ------------------------------------------------------------------ the walk */
const pack = retarget(await loadPack(), SITE_PORT);
await post("/walks", { ...pack.walk, id: WALK });
const group = async g => {
  const r = await post(`/walks/${WALK}/items`, { items: g.items.map(i => ({ ...i, group: g.name })) });
  if (r.status !== 200) throw new Error(`items refused (${r.status}): ${await r.text()}`);
};
await group(pack.groups[0]);
await group(pack.groups[1]);

/* -------------------------------------------------------------- the two pages */
const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium", headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, `--remote-debugging-port=${DEBUG_PORT}`],
});
const shots = [];
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const extId = sw.url().split("/")[2];
  // The port and the token together: the pane paints the token notice instead of
  // cards without the second one, and these frames are the store's.
  await sw.evaluate(([p, tok]) => chrome.storage.local.set({ "walkd:port": p, "walkd:token": tok }), [PORT, walkdToken]);

  const site = ctx.pages()[0] ?? (await ctx.newPage());
  await site.setViewportSize({ width: SITE_W, height: H });
  await site.goto(`${SITE}/`);
  const pane = await ctx.newPage();
  await pane.setViewportSize({ width: PANE_W, height: H });
  await pane.goto(`chrome-extension://${extId}/panel.html`);
  await pane.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
  await pane.locator(`header[data-walk-id="${WALK}"]`).waitFor({ timeout: 15_000 });
  await pane.locator('[data-item="lp-share"]').waitFor({ timeout: 15_000 });
  if (!(await pane.evaluate(() => document.fonts.check('700 16px "Atkinson Hyperlegible"')))) throw new Error("the pane's own face did not load — the frames would be set in something else");

  // Go navigates the *active* tab (`chrome.tabs.query({active:true})` in
  // `sw.ts`), and in a real browser that is the page, because the pane is a
  // panel and not a tab at all. Here it is a tab like any other, so the site
  // is kept in front of it — before the first press, and again after anything
  // that opens a page of its own. Without this, Go takes the pane's own tab to
  // Lamppost and every frame after it is of the site, twice.
  await site.bringToFront();
  const press = async sel => { await pane.locator(sel).click(); await site.bringToFront(); };
  const scheme = async s => { for (const p of [site, pane]) await p.emulateMedia({ colorScheme: s }); await sleep(300); };

  /**
   * Put the card this frame is about at the top of the pane.
   *
   * The pane deliberately does not scroll on its own (the owner, 2026-09-23: being
   * scrolled away from where you were is "surprising"), so after a few answers
   * the card a frame is named for has drifted up out of the 800 px a store
   * screenshot gets. The ledge is pinned to the bottom and stays in every
   * frame whatever this does.
   */
  const focus = async sel => { await pane.locator(sel).evaluate(el => el.scrollIntoView({ block: "start", behavior: "instant" })); await sleep(400); };
  const top = async () => { await pane.evaluate(() => window.scrollTo(0, 0)); await sleep(400); };
  const bottom = async () => { await pane.evaluate(() => window.scrollTo(0, document.body.scrollHeight)); await sleep(400); };

  /**
   * One frame: the site and the pane side by side, at their own sizes, through
   * a third page that does nothing but hold the two PNGs next to each other.
   * No library, no resampling — the compositor is the same Chromium.
   */
  const frame = async (name) => {
    const [a, b] = [await site.screenshot(), await pane.screenshot()];
    const png = u8 => `data:image/png;base64,${u8.toString("base64")}`;
    const canvas = await ctx.newPage();
    await canvas.setViewportSize({ width: SITE_W + PANE_W, height: H });
    await canvas.setContent(`<!doctype html><style>
      html,body{margin:0;background:#000;display:flex}
      img{display:block;height:${H}px}
      /* The seam Chrome itself paints between a page and its side panel. */
      .pane{box-shadow:-1px 0 0 rgba(0,0,0,.18)}
    </style><img src="${png(a)}" width="${SITE_W}"><img class="pane" src="${png(b)}" width="${PANE_W}">`);
    const file = path.join(OUT, `${name}.png`);
    await canvas.screenshot({ path: file, clip: { x: 0, y: 0, width: SITE_W + PANE_W, height: H } });
    await canvas.close();
    await site.bringToFront();                         // see `press` above
    shots.push(file);
    console.log(`  ${name}.png`);
  };

  console.log("frames:");

  // 1. Go — the press that opens the page and points at the thing to check.
  await press('[data-go="lp-lamps"]');
  await sleep(2500);                                   // the outline lands, then breathes
  // Groups render newest-first (`groupItems`), so the card Go was just pressed
  // on is not the one at the top of the pane; put it there.
  await focus('[data-item="lp-lamps"]');
  await frame("01-go");

  // 2. A sequence — two of three steps ticked, the lock half-walked.
  await press('[data-go="lp-lock"]');
  await sleep(2000);
  await press('[data-step="0"][data-for="lp-lock"]');
  await press('[data-step="1"][data-for="lp-lock"]');
  await sleep(600);
  await focus('[data-item="lp-lock"]');
  await frame("02-sequence");

  // 3. Undo — two answers on the ledge, both still free to take back, both
  //    draining. The agent has read neither, which is what keeps them green.
  await pane.locator('[data-note="lp-lamps"]').fill("all five green, names under each");
  await press('[data-kind="pass"][data-for="lp-lamps"]');
  // The pack's own first option, which the pane tags *Recommended*; reading it
  // off the pack rather than naming it here keeps this frame correct when
  // the copy reviewer next changes the demo's words.
  await press(`[data-item="lp-tiers"] input[value="${pack.groups[0].items.find(i => i.id === "lp-tiers").options[0]}"]`);
  await press('[data-item="lp-tiers"] button[data-kind="decision"]');
  await pane.locator('[data-note="lp-history"]').fill("six, newest first");
  await press('[data-kind="pass"][data-for="lp-history"]');
  await sleep(1200);
  // Three rows is as tall as the ledge is allowed to get, and the bottom of
  // the list is where it is least crowded by cards that are not the subject.
  await bottom();
  await frame("03-undo");

  // 4. Secrets — the row of dots and its Copy button, on the settings page the
  //    key is pasted into. The value never reaches the DOM; the dots are all
  //    there has ever been to photograph.
  await press('[data-go="lp-key"]');
  await sleep(2500);
  await focus('[data-item="lp-key"]');
  await frame("04-secrets");

  // 5. Ask — a question of the person's, answered by the agent on the card it
  //    was asked from. The reply is an `info` item carrying `supersedes`,
  //    which is exactly what `demo/run.mjs` sends when it plays the agent.
  await press('[data-go="lp-share"]');
  await sleep(1500);
  await pane.locator('[data-note="lp-share"]').fill(ASK_TEXT);
  await press('[data-kind="ask"][data-for="lp-share"]');
  await sleep(1500);
  const asked = (await (await fetch(`${BASE}/walks/${WALK}?viewer=1`, { headers: auth() })).json()).verdicts.find(v => v.kind === "ask" && v.itemId === "lp-share");
  if (!asked) throw new Error("the ask never reached the daemon, so there is nothing for the agent to answer");
  await post(`/walks/${WALK}/items`, { items: [{ ...pack.ask, id: `lp-ask-${asked.seq}`, group: pack.groups[1].name, supersedes: "lp-share" }] });
  await sleep(2000);
  await focus('[data-item="lp-share"]');
  await frame("05-ask");

  // 6. The same pane, dark. The owner's clips ship a dark set; the listing gets one.
  await scheme("dark");
  await top();
  await frame("06-dark");
  await scheme("light");

  /* ----------------------------------------------------------------- the tiles */
  //
  // The mark, the name and the one line, on the pane's ground. The palette is
  // read out of panel.css rather than written here twice, and the face is the
  // same woff2 the extension ships, inlined so the page fetches nothing.
  const css = await fs.readFile(path.join(EXT, "src", "panel.css"), "utf8");
  const token = n => (new RegExp(`--${n}:(#[0-9a-f]{3,8})`, "i").exec(css) ?? [])[1] ?? "#000";
  const mark = await fs.readFile(path.join(EXT, "icons", "mark.svg"), "utf8");
  const face = async (f, w) => `@font-face{font-family:"Atkinson Hyperlegible";font-weight:${w};src:url(data:font/woff2;base64,${(await fs.readFile(path.join(EXT, "fonts", f))).toString("base64")}) format("woff2")}`;
  const fonts = (await Promise.all([face("atkinson-400-latin.woff2", 400), face("atkinson-700-latin.woff2", 700)])).join("");
  // The tiles carry the manifest's own description and nothing else. The name
  // under the mark is the product's, lowercase, as everywhere else.
  const LINE = JSON.parse(await fs.readFile(path.join(EXT, "manifest.json"), "utf8")).description;

  const tile = async (name, w, h, markPx, line) => {
    const page = await ctx.newPage();
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<!doctype html><style>${fonts}
      html,body{margin:0}
      body{width:${w}px;height:${h}px;background:${token("ground")};color:${token("ink")};
        font-family:"Atkinson Hyperlegible",system-ui,sans-serif;
        display:flex;flex-direction:column;justify-content:center;gap:${Math.round(h * 0.055)}px;
        padding:0 ${Math.round(w * 0.085)}px;box-sizing:border-box}
      .brand{display:flex;align-items:center;gap:${Math.round(markPx * 0.3)}px}
      .brand svg{width:${markPx}px;height:${markPx}px;display:block}
      .name{font-weight:700;font-size:${Math.round(markPx * 0.72)}px;letter-spacing:-0.01em;line-height:1}
      p{margin:0;font-size:${line}px;line-height:1.25;letter-spacing:-0.012em;max-width:22ch;text-wrap:balance}
    </style><div class="brand">${mark}<span class="name">sidewalk</span></div><p>${LINE}</p>`);
    await page.evaluate(() => document.fonts.ready);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: w, height: h } });
    await page.close();
    shots.push(file);
    console.log(`  ${name}.png`);
  };
  console.log("tiles:");
  await tile("tile-small", 440, 280, 38, 25);
  await tile("tile-marquee", 1400, 560, 96, 62);
} finally {
  await ctx.close();
  for (const c of kids) c.kill("SIGTERM");
  await sleep(300);
  await fs.rm(dataDir, { recursive: true, force: true });
}

/* ------------------------------------------------------------- the alpha strip
 *
 * The Chrome Web Store takes JPEG or 24-bit PNG and refuses a PNG with an
 * alpha channel; Playwright has no way to emit one without. Both reference
 * repos hit this and both answer it the same way — re-encode through `sips`,
 * which is macOS's and is built in. On anything else the frames are still
 * correct, and the note below says what to do before uploading.
 */
let stripped = 0;
for (const f of shots) {
  try { execFileSync("sips", ["-s", "format", "png", f, "--out", f], { stdio: "ignore" }); stripped++; }
  catch { /* reported once, below */ }
}
console.log(`\n${shots.length} files in ${path.relative(ROOT, OUT)}`);
if (stripped !== shots.length) {
  console.warn(`\nalpha: sips re-encoded ${stripped}/${shots.length}. The Chrome Web Store refuses a 32-bit RGBA PNG;`);
  console.warn(`on a machine without sips, run them through any encoder that writes 24-bit PNG before uploading.`);
}
