/**
 * The camera.
 *
 * `demo/record.mjs` plays the person's part; this file films it. It is its own
 * module because the arithmetic — which frame fills which 1/60 s slot, whether
 * a surface moved at all, whether a cursor track makes sense — is pure, and
 * pure things get unit tests (`demo/record.test.ts`).
 *
 * Why not `recordVideo`: Playwright's own recorder is hard-wired to 25 fps and
 * VP8 at 1 Mbit/s on libvpx's fastest, worst setting, it sizes video per
 * *context* rather than per page, and it starts before the viewport is settled.
 * The capture research note, kept outside the repo, has the line numbers.
 * `page.screencast.start({ onFrame })` hands us the same JPEGs Playwright's own
 * recorder gets, each with the wall-clock moment the compositor swapped it, and
 * we mux them ourselves at a constant 60 fps.
 *
 * Three things the probe (`demo/probe-capture.mjs`) measured that shape this:
 *
 * 1. **A visible tab is captured at its browser window's content area**, not at
 *    its emulated viewport — so the window has to be made to fit, which is what
 *    `fitWindow` does. A **hidden** tab has no window widget and is captured at
 *    its emulated viewport, which is why the pane has always been the right
 *    size and the site has not.
 * 2. The screencast is **CSS pixels only**: `deviceScaleFactor: 2` raises
 *    `devicePixelRatio` and changes nothing about the JPEG. The viewport is the
 *    only lever on resolution.
 * 3. Chromium emits a frame when the page repaints and nothing when it is idle,
 *    and it re-sends a frame it has already sent often enough to be worth
 *    de-duplicating — about 40% of a take's frames are byte-identical to the
 *    one before.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_STEP_PX } from "./hand.mjs";

/** The take's frame rate. Constant, and the cut's `fps` too. */
export const FPS = 60;

/**
 * The floor the health check holds a surface to.
 *
 * A frozen surface does not fail — it produces a full-length *frozen video*,
 * because the muxer holds the last frame into every empty slot. That is the
 * one failure this pipeline cannot see on its own, so it is counted instead:
 * a take of any length with fewer than this many distinct frames on any
 * surface did not film anything moving.
 *
 * **It is tuned to the two surfaces a hand moves**, which count thousands. The
 * terminal changes only when a block prints and counted **64 of 7949** on the
 * take this was last checked against — honest footage of a surface that is
 * mostly still, not a dropped capture, and it has to pass. That leaves this
 * number too slack to mean anything there, so the terminal is held to a count
 * instead: see `floors` on `health` below. What a floor is for either way is a
 * surface that stopped compositing altogether, which produces single figures.
 */
export const DISTINCT_FLOOR = 30;

/* --------------------------------------------------------------- the maths */

/**
 * Which frame is on screen in each 1/60 s slot.
 *
 * `times` are the wall-clock moments frames arrived, in order. The slot a frame
 * belongs to is `round((t - t0) * fps / 1000)`; a slot with no frame of its own
 * holds the last one, which is what makes an idle page a still rather than a
 * gap; and slots before the first frame hold the first frame, so a slow first
 * paint does not shift everything after it.
 *
 * Returns one index into `times` per slot — the whole film, as a playlist.
 */
export function placeFrames(times, { fps = FPS, t0 = times[0], until = times.at(-1) } = {}) {
  if (!times.length) return [];
  const slot = t => Math.max(0, Math.round(((t - t0) * fps) / 1000));
  const total = Math.max(1, slot(until) + 1);
  const out = new Array(total);
  let shown = 0, next = 0;
  for (let i = 0; i < total; i++) {
    // Several frames can land in one slot; the last of them is what was on
    // screen when the slot ended, so it is the one that gets drawn.
    while (next < times.length && slot(times[next]) <= i) shown = next++;
    out[i] = shown;
  }
  return out;
}

/**
 * Did every surface actually move? `counts` is `{ <surface>: { distinct } }`.
 *
 * `floors` **replaces** the general floor for a surface the recorder knows
 * something exact about, and the terminal is the one that needs it.
 * `DISTINCT_FLOOR` is a guess tuned to the two surfaces a hand moves; the
 * terminal changes only when a block prints, and the recorder knows how many
 * blocks it printed — a take that filmed all of them cannot have produced
 * fewer distinct frames than that. A count is a better floor than a guess in
 * both directions: it is tighter than 30 when the transcript is short, so a
 * lost block is caught rather than hidden under the general floor, and it
 * keeps up with the transcript instead of going stale. It still catches the
 * failure the whole check exists for, because a surface that stopped
 * compositing produces one distinct frame, not one short of its count.
 */
export function health(counts, floor = DISTINCT_FLOOR, floors = {}) {
  const floorFor = name => floors[name] ?? floor;
  const frozen = Object.entries(counts)
    .filter(([name, c]) => (c?.distinct ?? 0) < floorFor(name))
    .map(([name, c]) => `${name} produced ${c?.distinct ?? 0} distinct frames against a floor of ${floorFor(name)}`);
  return { ok: frozen.length === 0, floor, ...(Object.keys(floors).length ? { floors } : {}), frozen };
}

/**
 * The surfaces a pointer can be on. Not the terminal: nothing hovers a
 * terminal, and the take's claim is that the person's hand is in the pane and
 * the agent's is nowhere — so a cursor event on it would be a pointer the take
 * never moved there.
 */
const SURFACES = new Set(["site", "pane"]);
const KINDS = new Set(["move", "down", "up"]);

/**
 * What is wrong with a cursor track, as a list of sentences. Empty is good.
 *
 * Two rules matter to the cut, and both are about the same thing — a pointer
 * that is somewhere it never travelled to. A `down` with no `move` before it on
 * the same surface is a press the pointer teleported onto; and now that the
 * track is the whole **path** rather than its endpoints (`demo/hand.mjs`), two
 * consecutive `move`s on one surface more than `MAX_STEP_PX` apart are a
 * teleport in the middle of a move. The one it catches in practice is a glide
 * that started from the wrong place — a surface whose resting position the
 * recorder lost track of.
 */
export function cursorIssues(track) {
  const bad = [];
  const num = v => typeof v === "number" && Number.isFinite(v);
  let last = -Infinity;
  const seen = new Map();                        // surface -> last kind
  const was = new Map();                         // surface -> last move's point
  track.forEach((e, i) => {
    const at = `cursor[${i}]`;
    if (!num(e?.t)) bad.push(`${at} has no numeric t`);
    else if (e.t < last) bad.push(`${at} goes backwards in time (${e.t} after ${last})`);
    else last = e.t;
    if (!SURFACES.has(e?.surface)) bad.push(`${at} is on surface ${JSON.stringify(e?.surface)}, not site or pane`);
    if (!KINDS.has(e?.kind)) bad.push(`${at} is kind ${JSON.stringify(e?.kind)}, not move, down or up`);
    if (!num(e?.x) || !num(e?.y)) bad.push(`${at} has no numeric x,y`);
    const before = seen.get(e?.surface);
    if (e?.kind === "down" && before !== "move" && before !== "up") bad.push(`${at} is a down on ${e.surface} with no move before it`);
    if (e?.kind === "up" && before !== "down") bad.push(`${at} is an up on ${e.surface} with no down before it`);
    if (e?.kind === "move" && num(e?.x) && num(e?.y) && SURFACES.has(e?.surface)) {
      const from = was.get(e.surface);
      // The first move on a surface has nothing to be far from: the pointer's
      // resting position before the track began is not in the track.
      if (from) {
        const jump = Math.hypot(e.x - from.x, e.y - from.y);
        if (jump > MAX_STEP_PX) bad.push(`${at} jumps ${Math.round(jump)} px on ${e.surface} since the move before it, more than ${MAX_STEP_PX}`);
      }
      was.set(e.surface, { x: e.x, y: e.y });
    }
    if (SURFACES.has(e?.surface) && KINDS.has(e?.kind)) seen.set(e.surface, e.kind);
  });
  return bad;
}

/** The frame a moment falls on, for a surface that started at `t0`. */
export const frameAt = (t, t0, fps = FPS) => Math.max(0, Math.round(((t - t0) * fps) / 1000));

/* -------------------------------------------------------------- the window */

/**
 * Make the browser window's content area exactly `size`, for a **visible** tab.
 *
 * `page.setViewportSize` moves the window with `Browser.setWindowBounds` to the
 * viewport plus Playwright's idea of the window insets, which is zero on this
 * build — so the content area comes out 87 px short, and a second page's
 * `setViewportSize` moves the shared window somewhere else again and the first
 * page's call does not move it back (`_updateViewport` early-returns when the
 * metrics are unchanged). Rather than hard-code 87, the inset is measured: film
 * one frame, see how big it came out, correct, and film one more to check.
 *
 * Throws rather than carrying on, because a wrong window is complaint 2.
 */
export async function fitWindow(ctx, page, size) {
  const cdp = await ctx.newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  const measure = async () => {
    const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });
    const got = await oneFrame(page, size);
    return { bounds, got };
  };
  let { bounds, got } = await measure();
  const inset = { width: bounds.width - got.width, height: bounds.height - got.height };
  if (inset.width || inset.height) {
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width: size.width + inset.width, height: size.height + inset.height } });
    ({ bounds, got } = await measure());
  }
  await cdp.detach().catch(() => {});
  if (got.width !== size.width || got.height !== size.height)
    throw new Error(`the window will not give ${size.width}x${size.height}: it is ${bounds.width}x${bounds.height} and films ${got.width}x${got.height}`);
  return { bounds, inset };
}

/** One screencast frame, and how big it really came out. */
async function oneFrame(page, size) {
  let settle;
  const first = new Promise(r => { settle = r; });
  await page.screencast.start({ size, quality: 30, onFrame: ({ viewportWidth, viewportHeight }) => settle({ width: viewportWidth, height: viewportHeight }) });
  // A page that is not repainting never sends one; a mouse move always makes it.
  const nudge = setInterval(() => { page.mouse.move(1, 1).catch(() => {}); }, 100);
  try {
    return await Promise.race([first, new Promise((_, no) => setTimeout(() => no(new Error("no screencast frame in 10 s — is the surface compositing?")), 10_000))]);
  } finally {
    clearInterval(nudge);
    await page.screencast.stop().catch(() => {});
  }
}

/* --------------------------------------------------------------- the pulse */

/**
 * How often the pane is asked to redraw. 25 ms is a frame and a half at 60.
 *
 * It is the whole of the latency the mechanism adds: a change that lands just
 * after one beat is in the footage on the next, so the worst case is `PULSE_MS`
 * plus the round trip, and the measured worst over a take is under 40 ms.
 */
export const PULSE_MS = 25;

/**
 * Keep a surface painting into the screencast while nothing is touching it.
 *
 * **The defect this exists for.** The pane is a background tab, because the
 * extension's Go and its screenshot both work on
 * `chrome.tabs.query({active: true})`. Between the recorder's own actions —
 * the four to eight seconds a beat spends waiting for something that arrives
 * on the daemon's or the agent's clock — Chromium produces no compositor
 * frames for it at all, so the change is in the DOM and not in the footage.
 * Measured on take-11: the blocked diagnostic was in the pane at 25.6 s and
 * the next frame the compositor produced was 3.6 s later. Not a late delivery
 * — every frame of that take reached this process 3 ms after it was swapped —
 * but 3.6 s in which nothing was produced, and then the footage jumped, on the
 * frame the beat's own `page.screenshot()` forced, 45 ms before the next beat.
 * `demo/probe-capture.mjs` missed it for three takes because its `activity()`
 * moved the hand for the whole 20 s it measured: it measured a pane somebody
 * was poking.
 *
 * **What it is not.** It is not the hidden tab's *visibility*. Playwright
 * sends `Emulation.setFocusEmulationEnabled` at page init, which takes a
 * `WebContents` capturer count, and the pane's `document.visibilityState` is
 * `"visible"` for the whole take — the thing the research note feared. Sending
 * it again from a session of our own changed nothing: measured, the worst
 * change-to-frame lag stayed at 3564 ms. Neither did a no-op
 * `Input.dispatchMouseEvent` to the point the pointer was already on, every
 * 25 ms for a whole take: 3563 ms. What the pane is short of is not visibility
 * and not input but a **redraw**, and `Page.captureScreenshot` is the only
 * thing CDP exposes that forces one (`blink_widget_->ForceRedraw()`), which is
 * exactly why a `page.screenshot()` shows what the footage does not.
 *
 * So the recorder takes one, on a timer, for the whole take, and throws it
 * away. At the worst quality the encoder takes, because none of the bytes are
 * wanted — only the redraw. Nothing is drawn, no DOM event is dispatched, the
 * pointer does not move, and nothing reaches the cursor track: `mark()` is
 * called from `glide` and `hand`, and this is neither.
 *
 * **It may not be clipped**, however tempting a one-pixel screenshot is:
 * Chromium implements `clip` by emulating device metrics around the capture
 * and putting them back, and doing that forty times a second makes the page
 * un-clickable — Playwright's own actionability check starts reporting
 * `<html> intercepts pointer events` and a beat times out. Measured, once.
 *
 * **One thing it cannot do**: a forced redraw draws the page as it is, it does
 * not advance an animation's clock. The pane's breathing kerb stays still
 * while the hand does — 180 byte-identical frames over three seconds of
 * take-12 — and no mechanism measured changes that. The kerb's *colour*
 * changing is a DOM change and is in the footage to the frame.
 *
 * `busy()` is the one courtesy it owes: the beat's own stills go through
 * Playwright's screenshotter, which overrides the page's background colour
 * around the capture, and a forced redraw landing inside that is a frame of
 * the wrong colour. The beats hold it off for the two shots they take.
 *
 * The capture research note, kept outside the repo, has the measurements and
 * what else was tried.
 */
export function keepPainting(page, { cdp, busy = () => false, everyMs = PULSE_MS } = {}) {
  let stopped = false, beats = 0, failed = 0, spent = 0;
  const loop = (async () => {
    const started = Date.now();
    for (let i = 1; !stopped; i++) {
      // Absolute deadlines, so a slow round trip costs the next beat nothing.
      const wait = started + i * everyMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      if (stopped || busy()) continue;
      const began = Date.now();
      try {
        await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 0, optimizeForSpeed: true });
        beats++;
        spent += Date.now() - began;
      } catch {
        // A page that has gone away is not worth failing a take over: the
        // camera stops before the browser does, and this stops before that.
        failed++;
      }
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await loop;
      return { beats, failed, everyMs, msPerBeat: beats ? +(spent / beats).toFixed(2) : 0 };
    },
  };
}

/* ------------------------------------------------------------- the capture */

/**
 * Film one surface into `dir`, one JPEG a repaint.
 *
 * Frames that come back the wrong size are dropped rather than muxed: the one
 * thing that can silently ruin a take is a surface that is not the size it was
 * asked for, and `cutaway` makes the same check for the same reason.
 *
 * Byte-identical consecutive frames are not written twice — about 40% of a
 * take's frames repeat — so the slot list can point two slots at one file.
 */
export async function startCapture(page, { dir, size, fps = FPS }) {
  await fs.mkdir(dir, { recursive: true });
  const frames = [];                     // { t, at, file }
  const hashes = new Set();
  let n = 0, odd = 0, lastHash = null, lastFile = null;
  // The first frame's wall clock is what everything else in the take is
  // measured from, and waiting for it is also the earliest a surface can prove
  // it is alive — a pane that never sends one is a take not worth playing.
  let settle;
  const first = new Promise(r => { settle = r; });
  await page.screencast.start({
    size,
    quality: 100,
    onFrame: async ({ data, timestamp, viewportWidth, viewportHeight }) => {
      if (viewportWidth !== size.width || viewportHeight !== size.height) { odd++; return; }
      const hash = crypto.createHash("md5").update(data).digest("hex");
      hashes.add(hash);
      if (hash === lastHash) { frames.push({ t: timestamp, at: Date.now(), file: lastFile }); return; }
      const file = path.join(dir, `${String(n++).padStart(6, "0")}.jpg`);
      await fs.writeFile(file, data);
      lastHash = hash; lastFile = file;
      frames.push({ t: timestamp, at: Date.now(), file });
      settle(timestamp);
    },
  });
  return {
    page, dir, size, fps, frames, first,
    get distinct() { return hashes.size; },
    get odd() { return odd; },
    stop: async () => { await page.screencast.stop(); },
  };
}

/**
 * Mux a surface's frames into a constant-rate 60 fps H.264 mp4.
 *
 * `-f image2pipe -framerate 60` *is* constant rate — one image in is one frame
 * out — so the slot list is the whole timing model and there is no `-fps_mode`
 * or concat-demuxer footgun. CRF 16 on flat UI is visually transparent;
 * Playwright's own recorder caps the same footage at 1 Mbit/s.
 */
export async function encode(cap, out, { log = () => {} } = {}) {
  const { size, fps, frames } = cap;
  if (!frames.length) throw new Error(`nothing to encode for ${out}`);
  if (size.width % 2 || size.height % 2) throw new Error(`yuv420p needs an even size, not ${size.width}x${size.height}`);
  const slots = placeFrames(frames.map(f => f.t), { fps });
  const ff = spawn("ffmpeg", [
    "-v", "error", "-y",
    "-f", "image2pipe", "-framerate", String(fps), "-i", "pipe:0",
    "-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p",
    "-g", String(fps), "-movflags", "+faststart", "-an", out,
  ], { stdio: ["pipe", "ignore", "inherit"] });
  const done = new Promise((ok, no) => {
    ff.on("error", e => no(new Error(`ffmpeg would not start: ${e.message}`)));
    ff.on("exit", c => (c === 0 ? ok() : no(new Error(`ffmpeg exited ${c} writing ${out}`))));
  });
  let cachedFile = null, cached = null;
  try {
    for (const i of slots) {
      const { file } = frames[i];
      if (file !== cachedFile) { cached = await fs.readFile(file); cachedFile = file; }
      if (!ff.stdin.write(cached)) await new Promise(r => ff.stdin.once("drain", r));
    }
    ff.stdin.end();
  } catch (e) {
    ff.kill("SIGKILL");
    throw e;
  }
  await done;
  log(`${path.basename(out)}: ${slots.length} frames at ${fps} fps = ${(slots.length / fps).toFixed(1)}s, ${size.width}x${size.height}, ${cap.distinct} distinct of ${frames.length} received${cap.odd ? `, ${cap.odd} dropped for being the wrong size` : ""}.`);
  return { file: out, frames: slots.length, fps, seconds: slots.length / fps, size: [size.width, size.height], received: frames.length, distinct: cap.distinct, odd: cap.odd };
}
