#!/usr/bin/env node
/**
 * A ONE-OFF. Not part of the take, not run by anything, not a test.
 *
 * The capture research note, kept outside the repo, asks five questions that
 * cannot be answered by reading Playwright's source, and two of them decide
 * the shape of the recorder. This script answers them against the recorder's own setup —
 * a persistent context with the unpacked extension, the site tab visible, the
 * panel page open on a real walk — and prints numbers.
 *
 *   node demo/probe-capture.mjs [--secs 20] [--take demo/out/take-1]
 *
 * It answers:
 *
 *   1. frames/second received from `page.screencast.start` on each surface,
 *      and the count of *distinct* frames (a pane count near 1 means the
 *      hidden tab is frozen and today's pane.webm is less real than it looks);
 *   2. whether `showActions({ cursor: 'pointer' })` and `addInitScript` take
 *      effect on a `chrome-extension://…/panel.html` page (UNCONFIRMED by any
 *      Playwright test — its own only cover `http://`);
 *   3. whether `deviceScaleFactor: 2` changes the JPEG's real pixel size, or
 *      whether the screencast is CSS pixels only;
 *   4. the same two counts with the pane in its own `chrome.windows.create({
 *      type: 'popup', focused: false })` window instead of a background tab,
 *      while the site's window stays active;
 *   5. the first-frame size and the grey pad column of an existing
 *      `recordVideo` take (complaint 2, on the record rather than in a
 *      reasoning chain).
 *
 * Ports are the recorder's: walkd 8763, Lamppost 9353, CDP 9343.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPack, main } from "./run.mjs";
import { retarget } from "./record.mjs";
import { startSite } from "./site/serve.mjs";
import { readToken } from "sidewalk-walkd";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const EXT = path.join(ROOT, "packages", "extension", "dist");
const WALKD = path.join(ROOT, "packages", "walkd", "bin", "walkd.js");

const PORT = 8763;
const SITE_PORT = 9353;
const DEBUG_PORT = 9343;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const PANE = { width: 380, height: 800 };
const SCREEN = { width: 1280, height: 800 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------- the meter */

/** One surface's capture, counting frames and hashing every one of them. */
async function meter(page, label, size) {
  const seen = [];          // { t, ms, bytes, w, h, hash }
  const hashes = new Set();
  const started = Date.now();
  await page.screencast.start({
    size,
    quality: 100,
    onFrame: ({ data, timestamp, viewportWidth, viewportHeight }) => {
      const hash = crypto.createHash("md5").update(data).digest("hex");
      hashes.add(hash);
      seen.push({ t: timestamp, ms: Date.now() - started, bytes: data.length, w: viewportWidth, h: viewportHeight, jpeg: jpegSize(data) });
    },
  });
  return {
    label, seen, hashes, started,
    stop: async () => { await page.screencast.stop().catch(e => console.log(`  ${label}: stop threw ${e.message}`)); },
  };
}

/** A JPEG's real pixel size, read off its SOF marker — no library. */
function jpegSize(buf) {
  for (let i = 2; i + 9 < buf.length; ) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
      return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function report(m, secs) {
  const n = m.seen.length;
  const span = n > 1 ? (m.seen.at(-1).ms - m.seen[0].ms) / 1000 : secs;
  const gaps = m.seen.slice(1).map((f, i) => f.ms - m.seen[i].ms).sort((a, b) => a - b);
  const pct = q => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))] : 0);
  const sizes = new Set(m.seen.map(f => `${f.w}x${f.h}`));
  const jpegs = new Set(m.seen.map(f => (f.jpeg ? `${f.jpeg.w}x${f.jpeg.h}` : "?")));
  const bytes = m.seen.reduce((s, f) => s + f.bytes, 0);
  console.log(
    `  ${m.label.padEnd(12)} ${String(n).padStart(5)} frames over ${span.toFixed(1)}s = ${(n / Math.max(span, 0.001)).toFixed(1)} fps  ` +
    `distinct ${String(m.hashes.size).padStart(5)}  gaps ms p50 ${pct(0.5)} p90 ${pct(0.9)} max ${gaps.at(-1) ?? 0}  ` +
    `viewport ${[...sizes].join(",")}  jpeg ${[...jpegs].join(",")}  ${(bytes / 1e6).toFixed(1)} MB  ` +
    `ts first ${m.seen[0]?.t} last ${m.seen.at(-1)?.t}`,
  );
  // When each surface size was seen: a size that only appears at the start is a
  // settling race; one that comes back is a navigation re-registering the
  // screencast, and needs a guard rather than a later start.
  for (const key of sizes) {
    const f = m.seen.filter(x => `${x.w}x${x.h}` === key);
    console.log(`    ${key}: ${f.length} frames, ${f[0].ms}..${f.at(-1).ms} ms`);
  }
  return { frames: n, fps: n / Math.max(span, 0.001), distinct: m.hashes.size };
}

/* ------------------------------------------------------- scripted activity */

/** A glide, as the recorder will do it: steps:20 is 20 real mousemove events. */
async function glide(page, locator) {
  const b = await locator.boundingBox().catch(() => null);
  if (!b) return null;
  const x = Math.round(b.x + b.width / 2), y = Math.round(b.y + b.height / 2);
  await page.mouse.move(x, y, { steps: 20 });
  return { x, y };
}

/**
 * ~`secs` of the kind of thing the take does: the pane hovered and clicked, the
 * site navigated and toggled. Both surfaces at once, so the measurement is of
 * the real contention and not of one surface alone.
 */
async function activity(siteTab, panel, secs) {
  const end = Date.now() + secs * 1000;
  const paneTargets = ['[data-go="lp-lamps"]', '[data-kind="pass"][data-for="lp-lamps"]', '[data-note="lp-lock"]', '[data-go="lp-lock"]'];
  let i = 0;
  while (Date.now() < end) {
    const sel = paneTargets[i % paneTargets.length];
    await glide(panel, panel.locator(sel).first());
    await sleep(250);
    if (i % 4 === 2) {
      await panel.locator('[data-note="lp-lock"]').first().click({ timeout: 5000 }).catch(() => {});
      await panel.keyboard.type("probe ", { delay: 45 });
    }
    await glide(siteTab, siteTab.locator("body"));
    await siteTab.mouse.move(300 + ((i * 97) % 600), 200 + ((i * 53) % 400), { steps: 20 });
    if (i % 3 === 1) {
      await siteTab.goto(`${SITE}/${["", "dashboard", "history", "settings"][i % 4]}`).catch(() => {});
    }
    if (i % 6 === 4) await siteTab.locator(".switch").first().click({ timeout: 3000 }).catch(() => {});
    i++;
  }
}

/* ------------------------------------------------- the current take's frame 0 */

const run = (cmd, args) =>
  new Promise(resolve => {
    const ch = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = [];
    ch.stdout.on("data", c => out.push(c));
    ch.stderr.on("data", c => err.push(c));
    ch.on("error", () => resolve({ code: -1, out: Buffer.alloc(0), err: "spawn failed" }));
    ch.on("exit", code => resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err).toString() }));
  });

/**
 * Frame 0 of an existing `recordVideo` file: its size, and how many uniform
 * grey columns sit at its right-hand edge. ffmpeg's `pad=…:gray` writes
 * #808080, so a run of 0x80 columns is the complaint-2 artefact, measured.
 */
async function frameZero(file) {
  const probe = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate,codec_name,duration", "-of", "default=nw=1", file]);
  if (probe.code !== 0) return console.log(`  ${file}: ffprobe said ${probe.err.trim() || probe.code}`);
  const meta = Object.fromEntries(probe.out.toString().trim().split("\n").map(l => l.split("=")));
  const w = Number(meta.width), h = Number(meta.height);
  const raw = await run("ffmpeg", ["-v", "error", "-i", file, "-vframes", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  if (raw.code !== 0 || raw.out.length < w * h * 3) return console.log(`  ${file}: ffmpeg gave ${raw.out.length} bytes, wanted ${w * h * 3}`);
  const grey = x => {
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * 3;
      const [r, g, b] = [raw.out[o], raw.out[o + 1], raw.out[o + 2]];
      if (Math.abs(r - 0x80) > 6 || Math.abs(g - 0x80) > 6 || Math.abs(b - 0x80) > 6) return false;
    }
    return true;
  };
  let cols = 0;
  while (cols < w && grey(w - 1 - cols)) cols++;
  let rows = 0;
  const greyRow = y => {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      if (Math.abs(raw.out[o] - 0x80) > 6 || Math.abs(raw.out[o + 1] - 0x80) > 6 || Math.abs(raw.out[o + 2] - 0x80) > 6) return false;
    }
    return true;
  };
  while (rows < h && greyRow(h - 1 - rows)) rows++;
  console.log(`  ${path.basename(file)}: ${w}x${h} ${meta.codec_name} ${meta.r_frame_rate} fps ${meta.duration}s — frame 0 has ${cols} grey columns at the right and ${rows} grey rows at the bottom`);
}

/* ------------------------------------------------------- deviceScaleFactor */

/** Does `deviceScaleFactor: 2` give a 2x JPEG, or is the screencast CSS-only? */
async function probeScale(chromium) {
  for (const dsf of [1, 2]) {
    const ctx = await chromium.launchPersistentContext("", { channel: "chromium", headless: true, viewport: SCREEN, deviceScaleFactor: dsf });
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.setViewportSize(SCREEN);
      await page.goto(`${SITE}/dashboard`);
      const m = await meter(page, `dsf=${dsf}`, SCREEN);
      for (let i = 0; i < 8; i++) { await page.mouse.move(100 + i * 60, 300, { steps: 10 }); await sleep(150); }
      await m.stop();
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      console.log(`  deviceScaleFactor ${dsf}: devicePixelRatio ${dpr}, jpeg ${[...new Set(m.seen.map(f => (f.jpeg ? `${f.jpeg.w}x${f.jpeg.h}` : "?")))].join(",")}, onFrame viewport ${[...new Set(m.seen.map(f => `${f.w}x${f.h}`))].join(",")}`);
    } finally { await ctx.close(); }
  }
}

/* ------------------------------------------------------------------- probe */

const healthy = async () => {
  try { return (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()).ok === true; }
  catch { return false; }
};

async function until(what, fn, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function probe(opts) {
  const secs = opts.secs ?? 20;
  console.log(`\n=== 5. the current take's frame 0 (complaint 2)`);
  for (const f of ["site.webm", "pane.webm"]) {
    const p = path.resolve(ROOT, opts.take ?? "demo/out/take-1", f);
    if (await fs.stat(p).then(() => true, () => false)) await frameZero(p);
    else console.log(`  ${p} is not there — skipped`);
  }
  if (opts.frame0) return;

  if (await healthy()) throw new Error(`port ${PORT} busy`);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-probe-"));
  const daemon = spawn(process.execPath, [WALKD, "serve", "--port", String(PORT), "--data-dir", dataDir, "--state-dir", path.join(dataDir, "state"), "--grace-ms", "10000"], { stdio: "ignore" });
  await until(`walkd on ${PORT}`, healthy);
  // This daemon's token: it refuses every route but /health without it, and the
  // launcher and the pane below both have to carry it (secrets review).
  const token = await readToken(dataDir);
  const site = await startSite(SITE_PORT);
  const { chromium } = await import("@playwright/test");
  const scaleAfter = async () => {
    const site2 = await startSite(SITE_PORT);
    console.log(`\n=== 3. deviceScaleFactor`);
    try { await probeScale(chromium); } finally { await site2.stop(); }
  };

  let handle = null;
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    colorScheme: "light",
    viewport: SCREEN,
    permissions: ["clipboard-read", "clipboard-write"],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--remote-debugging-port=${DEBUG_PORT}`, "--window-size=1600,1200"],
  });

  try {
    const worker = async () => ctx.serviceWorkers().find(w => w.url().startsWith("chrome-extension://")) ?? (await ctx.waitForEvent("serviceworker"));
    const sw = await worker();
    const extId = sw.url().split("/")[2];
    const siteTab = ctx.pages()[0] ?? (await ctx.newPage());
    await siteTab.setViewportSize(SCREEN);
    await siteTab.goto(`${SITE}/`);
    const siteTabId = await sw.evaluate(async base => (await chrome.tabs.query({})).find(t => t.url?.startsWith(base))?.id, SITE);
    const focusSite = async () => { await (await worker()).evaluate(id => chrome.tabs.update(id, { active: true }), siteTabId); };

    handle = await main({ port: PORT, site: SITE_PORT, token, pack: retarget(await loadPack(), SITE_PORT), manual: true, afterMs: 10 * 60e3, doneMs: 10 * 60e3, log: () => {} });
    await (await worker()).evaluate(([port, tok]) => chrome.storage.local.set({ "walkd:port": port, "walkd:token": tok }), [PORT, token]);

    /* --- 2a. addInitScript on a chrome-extension:// page, registered before the goto. */
    const panel = await ctx.newPage();
    let initOk = "not reached";
    try {
      await panel.addInitScript(() => { window.__probeInit = "yes"; });
      initOk = "registered";
    } catch (e) { initOk = `addInitScript threw: ${e.message}`; }
    // `window.outerWidth` in headless mirrors the emulated viewport, so the
    // only honest witness of the real browser window is CDP's own
    // Browser.getWindowBounds — which is what Browser.setWindowBounds moved.
    const cdp = await ctx.newCDPSession(siteTab);
    const bounds = async () => {
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });
      return { windowId, bounds };
    };
    const metrics = async (page, when) => {
      const m = await page.evaluate(() => ({ outer: [outerWidth, outerHeight], inner: [innerWidth, innerHeight], dpr: devicePixelRatio })).catch(() => null);
      const b = await bounds().catch(e => ({ bounds: e.message }));
      console.log(`  ${when}: page outer ${m?.outer?.join("x")} inner ${m?.inner?.join("x")} dpr ${m?.dpr} — window ${JSON.stringify(b.bounds)}`);
    };
    console.log(`\n=== 0. what setViewportSize does to the window (research §2.3)`);
    await metrics(siteTab, "site tab, after its own setViewportSize(1280x800)");
    await panel.setViewportSize(PANE);
    await metrics(siteTab, "site tab, after panel.setViewportSize(380x800)");
    await siteTab.setViewportSize(SCREEN);
    await metrics(siteTab, "site tab, after setViewportSize(1280x800) again");
    if (opts.fixwindow) {
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      const [w, h] = opts.fixwindow.split(",").map(Number);
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: w, height: h } });
      await metrics(siteTab, `site tab, after Browser.setWindowBounds(${w}x${h})`);
    }
    if (opts.bump) {
      // The early return in `_updateViewport` only fires when the metrics are
      // unchanged, so one round trip through a different size makes the site's
      // own viewport the last word on the shared window.
      await siteTab.setViewportSize({ width: SCREEN.width - 1, height: SCREEN.height });
      await siteTab.setViewportSize(SCREEN);
      await metrics(siteTab, "site tab, after a 1279 bump and back to 1280x800");
    }
    await panel.goto(`chrome-extension://${extId}/panel.html`);
    await focusSite();
    if (initOk === "registered") initOk = String(await panel.evaluate(() => window.__probeInit ?? "absent").catch(e => `evaluate threw: ${e.message}`));

    await panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
    await panel.locator(`header[data-walk-id="${handle.id}"]`).waitFor({ timeout: 30_000 });
    await until("group A on the pane", async () => (await panel.locator('[data-item="lp-lamps"]').count()) > 0);
    await focusSite();

    /* --- 1 + 2b. both surfaces, pane as a hidden background tab. */
    console.log(`\n=== 1. ${secs}s of activity, pane as a hidden background tab`);
    const sm = await meter(siteTab, "site(tab)", SCREEN);
    const pm = await meter(panel, "pane(tab)", PANE);
    const actions = {};
    for (const [label, page, o] of [["site", siteTab, { cursor: "pointer", duration: 1500, position: "bottom-right", fontSize: 18 }], ["pane", panel, { cursor: "pointer", duration: 1500, position: "bottom", fontSize: 14 }]]) {
      try { await page.screencast.showActions(o); actions[label] = "ok"; }
      catch (e) { actions[label] = `threw: ${e.message}`; }
    }
    await activity(siteTab, panel, secs);
    await sm.stop(); await pm.stop();
    const tab = { site: report(sm, secs), pane: report(pm, secs) };

    /* --- 2. did showActions actually draw anything on the extension page? */
    console.log(`\n=== 2. showActions / addInitScript on chrome-extension://…/panel.html`);
    console.log(`  showActions(site tab) ${actions.site}`);
    console.log(`  showActions(panel page) ${actions.pane}`);
    console.log(`  addInitScript(panel page) → window.__probeInit is ${initOk}`);
    // The drawing is an <x-pw-glass> in the utility world with a *closed* shadow
    // root, so the page's own world cannot see inside it — but the host element
    // is appended to document.documentElement, which the page's world can count.
    for (const [label, page] of [["site tab", siteTab], ["panel page", panel]]) {
      const glass = await page.evaluate(() => {
        const names = [...document.documentElement.children].map(e => e.tagName.toLowerCase());
        return { pw: names.filter(n => n.startsWith("x-pw")), all: names.length };
      }).catch(e => ({ pw: [`evaluate threw: ${e.message}`], all: 0 }));
      console.log(`  ${label}: documentElement children ${glass.all}, playwright glass elements ${JSON.stringify(glass.pw)}`);
    }
    // And a still of each, so the cursor can be looked at rather than inferred.
    const shots = path.resolve(ROOT, "demo/out/probe");
    await fs.mkdir(shots, { recursive: true });
    await glide(panel, panel.locator('[data-kind="pass"][data-for="lp-lamps"]').first());
    await panel.screenshot({ path: path.join(shots, "pane-after-move.png") });
    await glide(siteTab, siteTab.locator("body"));
    await siteTab.mouse.move(640, 400, { steps: 20 });
    await siteTab.screenshot({ path: path.join(shots, "site-after-move.png") });
    console.log(`  stills in ${shots}`);

    /* --- 4. the pane in its own popup window, site's window still active. */
    console.log(`\n=== 4. ${secs}s of activity, pane in its own popup window`);
    await panel.close();
    await (await worker()).evaluate(url => chrome.windows.create({ url, type: "popup", width: 380, height: 800, focused: false }), `chrome-extension://${extId}/panel.html`);
    await until("the popup pane page", async () => ctx.pages().some(p => p.url().includes("/panel.html")), 20_000);
    const pop = ctx.pages().find(p => p.url().includes("/panel.html"));
    await pop.setViewportSize(PANE);
    await focusSite();
    await pop.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
    await pop.locator(`header[data-walk-id="${handle.id}"]`).waitFor({ timeout: 30_000 });
    await focusSite();
    const sm2 = await meter(siteTab, "site(win)", SCREEN);
    const pm2 = await meter(pop, "pane(popup)", PANE);
    await pop.screencast.showActions({ cursor: "pointer", duration: 1500 }).catch(e => console.log(`  popup showActions threw ${e.message}`));
    await activity(siteTab, pop, secs);
    await sm2.stop(); await pm2.stop();
    const win = { site: report(sm2, secs), pane: report(pm2, secs) };
    await pop.screenshot({ path: path.join(shots, "pane-popup.png") }).catch(() => {});
    console.log(`  popup page viewportSize ${JSON.stringify(pop.viewportSize())}`);

    console.log(`\n=== verdict`);
    console.log(`  pane as a hidden tab:    ${tab.pane.fps.toFixed(1)} fps, ${tab.pane.distinct} distinct of ${tab.pane.frames}`);
    console.log(`  pane in its own popup:   ${win.pane.fps.toFixed(1)} fps, ${win.pane.distinct} distinct of ${win.pane.frames}`);
    console.log(`  site beside each:        ${tab.site.fps.toFixed(1)} fps / ${win.site.fps.toFixed(1)} fps`);
  } finally {
    try { await handle?.stop(); } catch { /* already */ }
    await ctx.close().catch(() => {});
    await site.stop();
    daemon.kill("SIGTERM");
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  /* --- 3. deviceScaleFactor, in its own context with no extension. */
  await scaleAfter();
}

const opts = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--secs") opts.secs = Number(process.argv[++i]);
  else if (process.argv[i] === "--take") opts.take = process.argv[++i];
  else if (process.argv[i] === "--frame0") opts.frame0 = true;
  else if (process.argv[i] === "--fixwindow") opts.fixwindow = process.argv[++i];
  else if (process.argv[i] === "--bump") opts.bump = true;
  else throw new Error(`unknown flag ${process.argv[i]}`);
}
await probe(opts);
process.exit(0);
