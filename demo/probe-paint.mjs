#!/usr/bin/env node
/**
 * A ONE-OFF, like `demo/probe-capture.mjs`. Not part of the take, not a test.
 *
 * `probe-capture.mjs` measured the hidden pane at 62 fps and 941 distinct
 * frames over 20 s and the recorder has said ever since that the pane "is not
 * throttled either". **That measurement was taken while the hand was moving.**
 * Its `activity()` glides, clicks and types for the whole window it measures,
 * so it never measured the thing the take spends most of its length doing:
 * waiting. This one takes the poke away.
 *
 *   node demo/probe-paint.mjs [--secs 10] [--only none,shot100] [--list]
 *
 * Per mechanism it stands the pane up exactly as the recorder does — the
 * window fitted, the site tab visible and filming, the pane a hidden tab and
 * filming — and runs three phases:
 *
 *   A. `secs` seconds of a DOM change every 500 ms with **nothing sent to the
 *      pane's own CDP session**: the change goes through the service worker,
 *      by `chrome.runtime.sendMessage`, which is the route the product uses,
 *      and the pane stamps the moment it applied it. Reported: frames, distinct
 *      frames, and the lag from each change to the first frame carrying an
 *      image nobody had seen before.
 *   B. three seconds of nothing at all. Frames here are frames the compositor
 *      produced unprompted; `distinct` here is whether the pane's own CSS
 *      animations — the breathing kerb — reach the footage.
 *   C. the realest change there is: the launcher lands group B, four cards
 *      arrive through the daemon and the service worker, and nothing at all is
 *      sent to the pane. This is the shape of every change the take's footage
 *      used to miss.
 *
 * **What it is honest about: the pane in isolation does not reproduce the
 * defect.** Every mechanism, `none` included, gets each change into a frame in
 * under 50 ms here, while the same change in a whole take was 3.5 s late. So
 * this probe is good for what a mechanism *costs* and for what phase B says
 * about animations — and the harness that actually found and settled the
 * defect is a real take shot `--keep-frames`, whose `frames/stamps.json` has
 * every frame's swap and arrival moment, against the `landed` stamps the beats
 * write into `timeline.json`. The capture research note, kept outside the
 * repo, has both sets of numbers.
 *
 * The trap this fell into first, worth not falling into again: driving the DOM
 * change with `panel.evaluate` measures nothing. That is `Runtime.callFunctionOn`
 * on the pane's own session, and sending anything to a page's session is itself
 * enough to get a frame out of it.
 *
 * Each mechanism gets a fresh browser context and a walk of its own, because
 * most of them cannot be taken off a page once they are on it and group B can
 * only land once. walkd and Lamppost are shared.
 *
 * Ports are the recorder's: walkd 8763, Lamppost 9353, CDP 9343.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PULSE_MS, fitWindow } from "./capture.mjs";
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
const PANE = { width: 400, height: 900 };
const SCREEN = { width: 1440, height: 900 };
/** Where the probe parks the pane's pointer, and where a nudge re-sends it. */
const PARK = { x: 24, y: PANE.height - 24 };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (xs, q) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] : 0);

/* --------------------------------------------------------------- the meter */

/** One surface's capture, every frame stamped on arrival and hashed. */
async function meter(page, size) {
  const seen = [];                       // { at, t, bytes, hash }
  const hashes = new Set();
  await page.screencast.start({
    size,
    quality: 100,
    onFrame: ({ data, timestamp }) => {
      const hash = crypto.createHash("md5").update(data).digest("hex");
      hashes.add(hash);
      seen.push({ at: Date.now(), t: timestamp, bytes: data.length, hash });
    },
  });
  return { seen, hashes, stop: async () => { await page.screencast.stop().catch(() => {}); } };
}

/* ---------------------------------------------------------- the mechanisms */

/**
 * Each one is `{ why, setup(ctx, page) -> stop() }`. `setup` runs **before**
 * the camera, the way the recorder would do it at setup; a mechanism that
 * needs a pump returns the function that stops it.
 *
 * `page.mouse.move` is Playwright's wrapper over `Input.dispatchMouseEvent`,
 * which is what the hand sends: the nudge is the same event the hand already
 * sends, at the coordinates the pointer is already on.
 */
const MECHANISMS = {
  none: { why: "the recorder as it stands — a hidden tab, nothing applied" },

  lifecycle: {
    why: "Page.setWebLifecycleState({state:'active'}) once at setup",
    async setup(ctx, page) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Page.setWebLifecycleState", { state: "active" });
      return async () => { await cdp.detach().catch(() => {}); };
    },
  },

  focus: {
    why: "Emulation.setFocusEmulationEnabled({enabled:true}) once at setup",
    async setup(ctx, page) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      return async () => { await cdp.detach().catch(() => {}); };
    },
  },

  idle: {
    why: "Emulation.setIdleOverride({isUserActive:true, isScreenUnlocked:true})",
    async setup(ctx, page) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Emulation.setIdleOverride", { isUserActive: true, isScreenUnlocked: true });
      return async () => { await cdp.detach().catch(() => {}); };
    },
  },

  both: {
    why: "setWebLifecycleState('active') and setFocusEmulationEnabled together",
    async setup(ctx, page) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Page.setWebLifecycleState", { state: "active" });
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      return async () => { await cdp.detach().catch(() => {}); };
    },
  },

  raf: {
    why: "an invisible requestAnimationFrame-driven element in the page",
    async setup(_ctx, page) {
      await page.evaluate(() => {
        const el = document.createElement("div");
        el.id = "__probe_raf";
        el.style.cssText = "position:fixed;left:-4px;top:-4px;width:1px;height:1px;opacity:0.01;pointer-events:none";
        document.documentElement.appendChild(el);
        let n = 0;
        const tick = () => { el.style.transform = `translateX(${(n++ % 2) * 0.5}px)`; window.__probeRafN = n; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      return async () => {};
    },
  },

  nudge250: { why: "a no-op Input.dispatchMouseEvent at the parked point, every 250 ms", pump: 250, kind: "mouse" },
  nudge60: { why: "the same, every 60 ms", pump: 60, kind: "mouse" },
  nudge16: { why: "the same, every 16 ms — one a frame", pump: 16, kind: "mouse" },

  shot100: { why: "page.screenshot() every 100 ms (heavy; the cost is the point)", pump: 100, kind: "shot" },
  cdpshot100: { why: "CDP Page.captureScreenshot every 100 ms", pump: 100, kind: "cdpshot" },
  // What the recorder ships: `keepPainting`, at its own period.
  pulse: { why: "the recorder's own pulse — CDP Page.captureScreenshot every 25 ms, discarded", pump: PULSE_MS, kind: "cdpshot" },
  // The one-pixel version, which is tempting and must not be used: Chromium
  // emulates device metrics around a clipped capture, and at this rate that
  // makes the page un-clickable. Here to keep the cost comparison honest.
  clipped: { why: "the same, clipped to one pixel — DO NOT SHIP, it makes the page un-clickable", pump: PULSE_MS, kind: "clipshot" },

  popup: { why: "the pane in its own unfocused popup window rather than a hidden tab", popup: true },

  // Every beat ends with `hideCursor()` and a `page.screenshot()` of each
  // surface, and Playwright's screenshotter registers a screencast client of
  // its own. These two ask whether that is what stops the stream.
  preshot: { why: "nothing applied, but a page.screenshot() of each surface first — as every beat ends", preShot: true },
  preshotlife: {
    why: "a screenshot of each surface first, then setWebLifecycleState('active')",
    preShot: true,
    async setup(ctx, page) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Page.setWebLifecycleState", { state: "active" });
      return async () => { await cdp.detach().catch(() => {}); };
    },
  },
};

/** Start a mechanism's pump, if it has one. Returns its stop. */
async function startPump(mech, ctx, page) {
  if (!mech.pump) return async () => {};
  let stopped = false;
  let cdp = null;
  if (mech.kind === "cdpshot" || mech.kind === "clipshot") cdp = await ctx.newCDPSession(page);
  const once = async () => {
    if (mech.kind === "mouse") await page.mouse.move(PARK.x, PARK.y);
    else if (mech.kind === "shot") await page.screenshot({ type: "jpeg", quality: 20 });
    else if (mech.kind === "cdpshot") await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 0, optimizeForSpeed: true });
    else if (mech.kind === "clipshot") await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 0, optimizeForSpeed: true, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
  };
  let beats = 0, spent = 0;
  const loop = (async () => {
    const started = Date.now();
    for (let i = 1; !stopped; i++) {
      const wait = started + i * mech.pump - Date.now();
      if (wait > 0) await sleep(wait);
      if (stopped) break;
      const began = Date.now();
      await once().catch(() => {});
      spent += Date.now() - began;
      beats++;
    }
  })();
  return async () => { stopped = true; await loop; return { beats, msEach: beats ? +(spent / beats).toFixed(2) : 0 }; };
}

/* ------------------------------------------------------------- the harness */

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

/**
 * One mechanism, in its own browser context, set up the way the recorder sets
 * up: the window fitted, the site tab visible and filming, the pane a hidden
 * tab and filming.
 *
 * **The DOM change may not be driven by a CDP call to the pane.** That is the
 * trap the first version of this probe fell into: `panel.evaluate` is
 * `Runtime.callFunctionOn` on the pane's own session, and sending *anything* to
 * a hidden page's session wakes its compositor — so the measurement came back
 * perfect and meant nothing. The change is driven from the **service worker**
 * instead, which is a different CDP target, by exactly the route the product
 * uses: `chrome.runtime.sendMessage` to the panel page. The panel stamps
 * `Date.now()` itself when it applies the change, and the stamps are read back
 * after the phase, so nothing reaches the pane's session while it is measured.
 */
async function trial(name, chromium, handle, secs, token = "") {
  const mech = MECHANISMS[name];
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    colorScheme: "light",
    viewport: SCREEN,
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
    await (await worker()).evaluate(([port, tok]) => chrome.storage.local.set({ "walkd:port": port, "walkd:token": tok }), [PORT, token]);

    let panel;
    if (mech.popup) {
      await (await worker()).evaluate(url => chrome.windows.create({ url, type: "popup", width: 400, height: 900, focused: false }), `chrome-extension://${extId}/panel.html`);
      await until("the popup pane page", async () => ctx.pages().some(p => p.url().includes("/panel.html")), 20_000);
      panel = ctx.pages().find(p => p.url().includes("/panel.html"));
    } else {
      panel = await ctx.newPage();
      await panel.goto(`chrome-extension://${extId}/panel.html`);
    }
    await panel.setViewportSize(PANE);
    await focusSite();

    await panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
    await panel.locator(`header[data-walk-id="${handle.id}"]`).waitFor({ timeout: 30_000 });
    await until("group A on the pane", async () => (await panel.locator('[data-item="lp-lamps"]').count()) > 0);
    await focusSite();

    // The window, as the recorder fits it: the pane's `setViewportSize` moved
    // it to fit a 400 px page and the site's own call cannot move it back.
    await fitWindow(ctx, siteTab, SCREEN);
    await focusSite();

    // A target that is unmistakably visible, so a frame either has the change
    // in it or does not — and a listener that applies the change and stamps
    // the moment it did, so nothing has to be sent to this page to drive it.
    await panel.evaluate(() => {
      const el = document.createElement("div");
      el.id = "__probe";
      el.style.cssText = "position:fixed;left:0;top:0;width:360px;height:120px;z-index:2147483647;font:48px/120px monospace;text-align:center";
      document.documentElement.appendChild(el);
      window.__probeLog = [];
      chrome.runtime.onMessage.addListener(m => {
        if (m?.t !== "__probe") return;
        el.textContent = String(m.n);
        el.style.background = m.n % 2 ? "#111" : "#eee";
        el.style.color = m.n % 2 ? "#eee" : "#111";
        window.__probeLog.push({ n: m.n, at: Date.now() });
      });
    });

    // The pointer is parked once, before the camera, and never moved again
    // except by a mechanism that moves it on purpose.
    await panel.mouse.move(PARK.x, PARK.y);
    await siteTab.mouse.move(24, SCREEN.height - 24);
    const stopMech = mech.setup ? await mech.setup(ctx, panel) : async () => {};

    // Both surfaces film, because the recorder films both and two screencasts
    // on one browser is the real contention.
    const sm = await meter(siteTab, SCREEN);
    const m = await meter(panel, PANE);
    const stopPump = await startPump(mech, ctx, panel);
    // Let the first frame land, so "nothing arrived" is about the phase and
    // not about the screencast still starting up.
    await until("a first frame", async () => m.seen.length > 0, 20_000).catch(() => {});
    if (mech.preShot) {
      await panel.screenshot({ path: path.join(os.tmpdir(), "probe-pane.png") });
      await siteTab.screenshot({ path: path.join(os.tmpdir(), "probe-site.png") });
      await sleep(300);
    }
    const phaseA = { started: Date.now(), mark: m.seen.length, sent: [] };

    for (let i = 0; i * 500 < secs * 1000; i++) {
      const target = phaseA.started + i * 500;
      const wait = target - Date.now();
      if (wait > 0) await sleep(wait);
      // Sent to the **service worker's** target, never the pane's.
      await sw.evaluate(n => chrome.runtime.sendMessage({ t: "__probe", n }).catch(() => {}), i);
      phaseA.sent.push(i);
    }
    await sleep(500);
    phaseA.end = Date.now();
    phaseA.until = m.seen.length;

    // Phase B: nothing at all. Only the pane's own CSS animations can move.
    const phaseB = { started: Date.now(), mark: m.seen.length };
    await sleep(3000);
    phaseB.end = Date.now();
    phaseB.until = m.seen.length;

    // Phase C: the realest change there is — the launcher lands group B, four
    // new cards arrive on the pane through the daemon and the service worker,
    // and nothing at all is sent to the pane's own session. This is the shape
    // of every change the take's footage misses: it arrives on somebody else's
    // clock while the hand is still.
    const phaseC = { mark: m.seen.length };
    await handle.landGroupB();
    phaseC.at = Date.now();
    await sleep(4000);
    phaseC.until = m.seen.length;

    const beats = await stopPump();
    await m.stop(); await sm.stop();
    await stopMech();
    // Only now, with the camera off, is anything asked of the pane again.
    const changes = await panel.evaluate(() => window.__probeLog ?? []);

    // What each change cost: the first frame carrying an image nobody has seen
    // before. A frame that is byte-identical to one already sent is a re-send,
    // not a paint, and showing the change is the whole question.
    const seenHash = new Set();
    const firstNewAfter = at => {
      for (const s of m.seen) {
        if (s.at >= at && !seenHash.has(s.hash)) return s;
      }
      return null;
    };
    const lags = [];
    let missed = 0;
    for (const c of changes) {
      // Everything up to the change is old news.
      for (const s of m.seen) { if (s.at < c.at) seenHash.add(s.hash); }
      const f = firstNewAfter(c.at);
      if (!f) { missed++; continue; }
      lags.push(f.at - c.at);
      seenHash.add(f.hash);
    }
    const aFrames = phaseA.until - phaseA.mark;
    const aSecs = (phaseA.end - phaseA.started) / 1000;
    const bFrames = phaseB.until - phaseB.mark;
    const slice = m.seen.slice(phaseA.mark, phaseA.until);
    const distinctA = new Set(slice.map(s => s.hash)).size;
    const distinctB = new Set(m.seen.slice(phaseB.mark, phaseB.until).map(s => s.hash)).size;
    // Group B: the first frame after it landed that nobody had seen before.
    const beforeC = new Set(m.seen.slice(0, phaseC.mark).map(s => s.hash));
    const cNew = m.seen.slice(phaseC.mark, phaseC.until).find(s => s.at >= phaseC.at && !beforeC.has(s.hash));
    const distinctC = new Set(m.seen.slice(phaseC.mark, phaseC.until).map(s => s.hash)).size;
    return {
      name, why: mech.why, beats,
      a: { frames: aFrames, fps: aFrames / aSecs, distinct: distinctA, changes: changes.length, sent: phaseA.sent.length, missed, p50: pct(lags, 0.5), p90: pct(lags, 0.9), max: lags.length ? Math.max(...lags) : 0 },
      b: { frames: bFrames, fps: bFrames / 3, distinct: distinctB },
      c: { lag: cNew ? cNew.at - phaseC.at : null, frames: phaseC.until - phaseC.mark, distinct: distinctC },
      site: { frames: sm.seen.length, distinct: sm.hashes.size },
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------- main */

async function probe(opts) {
  const names = opts.only ?? Object.keys(MECHANISMS);
  for (const n of names) if (!MECHANISMS[n]) throw new Error(`no mechanism called ${n} — try ${Object.keys(MECHANISMS).join(", ")}`);

  if (await healthy()) throw new Error(`port ${PORT} busy`);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-paint-"));
  const daemon = spawn(process.execPath, [WALKD, "serve", "--port", String(PORT), "--data-dir", dataDir, "--state-dir", path.join(dataDir, "state"), "--grace-ms", "10000"], { stdio: "ignore" });
  await until(`walkd on ${PORT}`, healthy);
  // This daemon's token: it refuses every route but /health without it, and the
  // launcher and the pane below both have to carry it (secrets review).
  const token = await readToken(dataDir);
  const site = await startSite(SITE_PORT);
  const { chromium } = await import("@playwright/test");
  const pack = retarget(await loadPack(), SITE_PORT);

  const rows = [];
  let handle = null;
  try {
    for (const n of names) {
      process.stdout.write(`\n--- ${n}: ${MECHANISMS[n].why}\n`);
      // A walk of its own per mechanism: group B can only land once.
      handle = await main({ port: PORT, site: SITE_PORT, token, pack, manual: true, afterMs: 60 * 60e3, doneMs: 60 * 60e3, log: () => {} });
      try {
        const r = await trial(n, chromium, handle, opts.secs ?? 10, token);
        rows.push(r);
        console.log(
          `  A (${r.a.changes} of ${r.a.sent} DOM changes applied, no input to the pane): ${r.a.frames} frames ${r.a.fps.toFixed(1)} fps, ${r.a.distinct} distinct, ` +
          `${r.a.missed} changes never reached a new frame, lag ms p50 ${r.a.p50} p90 ${r.a.p90} max ${r.a.max}` +
          (r.beats?.beats ? `  [${r.beats.beats} pump beats, ${r.beats.msEach} ms each]` : ""),
        );
        console.log(`  B (3 s of nothing at all): ${r.b.frames} frames ${r.b.fps.toFixed(1)} fps, ${r.b.distinct} distinct`);
        console.log(`  C (group B lands, 4 s, no input): ${r.c.frames} frames, ${r.c.distinct} distinct, first new frame ${r.c.lag === null ? "NEVER" : `${r.c.lag} ms`} after it landed`);
      } catch (e) {
        console.log(`  FAILED: ${e.message}`);
        rows.push({ name: n, why: MECHANISMS[n].why, failed: e.message });
      } finally {
        try { await handle.stop(); } catch { /* already */ }
        handle = null;
      }
    }
  } finally {
    try { await handle?.stop(); } catch { /* already */ }
    await site.stop();
    daemon.kill("SIGTERM");
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  console.log(`\n=== verdict — lag is DOM change to the next frame; "missed" never reached one\n`);
  console.log(`  ${"mechanism".padEnd(12)} ${"A fps".padStart(7)} ${"A dist".padStart(7)} ${"missed".padStart(7)} ${"p50".padStart(6)} ${"p90".padStart(6)} ${"max".padStart(6)}  ${"B fps".padStart(6)} ${"B dist".padStart(7)} ${"C lag".padStart(7)}`);
  for (const r of rows) {
    if (r.failed) { console.log(`  ${r.name.padEnd(12)} FAILED: ${r.failed}`); continue; }
    console.log(
      `  ${r.name.padEnd(12)} ${r.a.fps.toFixed(1).padStart(7)} ${String(r.a.distinct).padStart(7)} ${String(r.a.missed).padStart(7)} ` +
      `${String(r.a.p50).padStart(6)} ${String(r.a.p90).padStart(6)} ${String(r.a.max).padStart(6)}  ${r.b.fps.toFixed(1).padStart(6)} ${String(r.b.distinct).padStart(7)} ${String(r.c.lag === null ? "NEVER" : r.c.lag).padStart(7)}`,
    );
  }
}

const opts = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--secs") opts.secs = Number(process.argv[++i]);
  else if (process.argv[i] === "--only") opts.only = process.argv[++i].split(",");
  else if (process.argv[i] === "--list") { console.log(Object.entries(MECHANISMS).map(([k, v]) => `  ${k.padEnd(12)} ${v.why}`).join("\n")); process.exit(0); }
  else throw new Error(`unknown flag ${process.argv[i]}`);
}
await probe(opts);
process.exit(0);
