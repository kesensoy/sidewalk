#!/usr/bin/env node
/**
 * The raw footage the marketing cut is made from.
 *
 * Phase 2 of the Lamppost demo: this script stands the whole product up —
 * its own daemon, its own Lamppost, its own agent terminal, Chromium with the
 * unpacked extension — and then plays the person's part, once, at a human
 * pace, deterministically. It leaves **three** videos, one still of each
 * surface at every beat, and a timeline the Remotion cut (phase 3, outside
 * this repo) cuts and captions from.
 *
 *   node demo/record.mjs [--speed 1] [--scheme light|dark] [--no-overlay]
 *                        [--terminal-size 1212x440] [--terminal-theme dark|light]
 *                        [--out demo/out/<name>] [--keep-frames]
 *
 *   --speed           a rehearsal: the hand divides by it and the holds by its
 *                     square root. 1 is the real pace, and the only speed that
 *                     is footage
 *   --scheme          `light` (default) or `dark`: `prefers-color-scheme` as
 *                     emulated on the pane and on Lamppost. The terminal's own
 *                     look is `--terminal-theme`, not this
 *   --terminal-size   the terminal's filmed viewport, `WxH`. 1212x440 by
 *                     default, which is what the cut draws 1:1
 *   --terminal-theme  `dark` (default, in both schemes) or `light`
 *   --keep-frames     leave the JPEGs the videos were muxed from on disk, with
 *                     `frames/stamps.json`: when each one was swapped by the
 *                     compositor and when it reached this process
 *   --no-overlay      film without the in-page pointer, for the cut to draw its own
 *   --out             a folder to compare against, instead of the scheme's own
 *
 * Ports are its own: walkd on 8763, Lamppost on 9353, the agent terminal page
 * on 9354, Chromium's remote debugging on 9343 — never 8760/9340 (the
 * human's), never 8761/9342/9341 (the e2e's), never 9222 (the chrome-devtools
 * MCP's).
 *
 * What it leaves in the take's folder (`demo/out/lamppost`, or
 * `demo/out/lamppost-dark`; emptied first, so the next take overwrites it):
 *
 *   site.mp4       the Lamppost tab, 1440x900, H.264 at a constant 60 fps
 *   pane.mp4       the side panel page, 400x900, the same
 *   terminal.mp4   the agent session, `--terminal-size`, the same
 *   timeline.json  the take's index: every beat, the frame it falls on in
 *                  each video, and the cursor track the cut draws the
 *                  pointer from. `demo/README.md` § The take has the schema.
 *   shots/         three stills a beat, `<nn>-<name>-pane.png`, `-site.png`
 *                  and `-terminal.png`, taken at the end of the beat so they
 *                  show what it produced
 *
 * `t` is milliseconds from the first frame of whichever video started first,
 * and it is the moment a beat *starts* — the beat runs until the next event.
 * Four events are not beats: `site-video-start`, `pane-video-start` and
 * `terminal-video-start` say when each video's first frame landed (one of the
 * three is always 0), and `group-a` marks the moment the first four cards
 * reach the pane.
 *
 * Six things are worth knowing before reading the beats:
 *
 * 1. **The pane is a background tab, on purpose, and it is made to redraw.**
 *    The extension's Go and its screenshot both work on
 *    `chrome.tabs.query({active: true})`, so the site has to be the active tab
 *    the whole way through — and a background tab stops producing frames
 *    between the recorder's actions, so a card that changed while the hand was
 *    still was simply not in the footage. (take-11: the blocked diagnostic in
 *    the DOM at 25.6 s, in the film at 36.05 s, in one jump, on the frame the
 *    beat's own screenshot forced.) `keepPainting` in `demo/capture.mjs` forces
 *    a redraw every 25 ms for the whole take, which is the only thing that
 *    moved the number — not focus emulation, which Playwright already does, and
 *    not a no-op mouse move. §9 of the research note has the four measurements.
 * 2. **A visible tab is filmed at its browser window's content area**, not at
 *    its emulated viewport, so the window has to be made to fit the site
 *    exactly — `fitWindow` in `demo/capture.mjs`. `page.setViewportSize` is
 *    the call that moves the window (`Browser.setWindowBounds`), *not*
 *    `bringToFront`, which is one `Page.bringToFront` and nothing else; and
 *    the site's own `setViewportSize` cannot undo what the pane's did,
 *    because Playwright early-returns when the metrics are unchanged. Left
 *    alone, the site films at 500x713 inside a grey 1280x800 field, for the
 *    whole take. A **hidden** tab has no window widget and is filmed at its
 *    emulated viewport, which is why the pane never had this problem.
 * 3. **Nothing is filmed until both surfaces are settled and the pane is on
 *    the walk.** The camera starts after the window is fitted, the pane has
 *    group A on it and the site has painted — so there is no half-sized,
 *    half-painted opening second to cut around.
 * 4. **The hand is a hand, and the whole of its path is logged.** The owner, on the
 *    take before this one: *"the mouse movements do not really look smooth or
 *    human like"*. `demo/hand.mjs` replaced the straight line at a constant
 *    speed with a Bézier arc on Fitts's-law timing, eased, overshooting and
 *    settling, aimed a little off each target's centre — and every sample of
 *    it, at the take's own 60 Hz, goes into `timeline.json`'s cursor track in
 *    that surface's CSS pixels, so the cut draws the pointer through the same
 *    curve the page saw. Playwright's `showActions` is gone with it: it drew a
 *    second pointer on its own clock, which disagreed with the real one, and
 *    its `Mouse move` / `Click` title could not be turned off. What makes a raw
 *    take watchable now is `demo/overlay.mjs`, a pointer in the page's own DOM
 *    — `--no-overlay` to film clean footage for the cut.
 * 5. **The pace is the viewer's, and what the viewer has to read is measured.**
 *    The owner, on the Secrets short: *"the clicks are rapid and click-to-click is
 *    too rapid"*. Every press now holds for `settle` and, if it changed words
 *    on screen, for `read` — and *which* words changed is counted off
 *    `innerText` on both surfaces before and after the press, not declared by
 *    the beat. The one thing a beat may declare is `read: false`, that its
 *    press is a confirmation the viewer already expected and is not worth a
 *    read at all. `demo/pace.mjs` is the table, the sources and the arithmetic;
 *    the beats below keep only the holds no rule covers, and say which.
 * 6. **The terminal is the third surface, on the same clock as the other two.**
 *    `demo/agent/` is a real `@xterm/xterm` emulator in a second hidden tab,
 *    written to by this recorder on its own beats, so the agent's side of the
 *    MCP link is filmed beside the pane and Lamppost rather than in a take of
 *    its own. The owner, 2026-10-05: *"I think you could probably incorporate the
 *    terminal in with the site and regular side-walk"* — before this there
 *    were two takes with two clocks, and a cut could only dissolve between
 *    them. Everything printed on it is the daemon's: the walk id, the seqs,
 *    the cursor each wait is called with, the person's own words, the option
 *    they picked, the steps they ticked, and the summary the launcher closes
 *    with. `demo/agent/transcript.json` is the copy and its `{{placeholders}}`
 *    are filled as the take plays; `fill` throws on one nothing has set, which
 *    is what stops a block printing ahead of the fact it describes. The
 *    group-B add is **not** printed as a tool call: its arguments carry the
 *    pack's demo key (the research's §3d trap), so one prose line stands in
 *    its place and a unit test refuses a transcript that carries either the
 *    key or a `secrets` argument.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAgentPage, xtermVersion } from "./agent/serve.mjs";
import { DEFAULT_TERMINAL, THEME_NAMES, themeFor } from "./agent/theme.js";
import { blockByName, jsonInner, jsonList, loadTranscript, renderLines, typedText } from "./agent/transcript.mjs";
import { FPS, cursorIssues, encode, fitWindow, frameAt, health, keepPainting, startCapture } from "./capture.mjs";
import { aim, aimWidth, handPath } from "./hand.mjs";
import { installOverlay, repaintOverlay, setOverlay } from "./overlay.mjs";
import { freshWords, pace, paceSummary } from "./pace.mjs";
import { loadPack, main } from "./run.mjs";
import { startSite } from "./site/serve.mjs";
import { readToken } from "sidewalk-walkd";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const EXT = path.join(ROOT, "packages", "extension", "dist");
const WALKD = path.join(ROOT, "packages", "walkd", "bin", "walkd.js");

const PORT = 8763;
const SITE_PORT = 9353;
const AGENT_PORT = 9354;
const DEBUG_PORT = 9343;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
/**
 * How long the daemon holds a fresh verdict before any agent may be handed it.
 *
 * It is the recorder's own `--grace-ms`, and the read beats need the number as
 * well as the flag: a `walk_wait` returns when a verdict **matures**, so a beat
 * that wants one return carrying three verdicts waits until all three are past
 * this and then reads once. Ten seconds is the daemon's own default and what
 * the green Undo's drain bar is drawn from.
 */
const GRACE_MS = 10_000;
/**
 * The side panel, a little wider and taller than the 380x800 a docked pane
 * gets. There is no 2x master to be had — the screencast is CSS pixels and
 * `deviceScaleFactor: 2` changes nothing about the JPEG, measured — so the
 * viewport is the only lever on how many pixels a 1080p cut has to work with.
 */
const PANE = { width: 400, height: 900 };
/** The tab being walked, for the same reason. Both sizes are even: yuv420p. */
const SCREEN = { width: 1440, height: 900 };
/**
 * The window Chromium opens with. It is fitted to `SCREEN` before the camera
 * rolls — the launch size only has to be big enough that the fit is a shrink.
 */
const WINDOW = "--window-size=1600,1200";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ pack */

/**
 * The walk pack, pointed at this recording's Lamppost.
 *
 * `demo/walk.json` says 9350 in every `url` and inside the escaped regex of
 * every `url` expectation. Both spellings of the host appear — `127.0.0.1` in
 * a url, `127\.0\.0\.1` in a regex — so one pattern covers them, and nothing
 * but the port that follows the loopback host is touched.
 */
const LOOPBACK_9350 = /(127(?:\\\.|\.)0(?:\\\.|\.)0(?:\\\.|\.)1):9350\b/g;

export function retarget(pack, port) {
  const swap = s => s.replace(LOOPBACK_9350, (_, host) => `${host}:${port}`);
  const item = i => {
    const out = { ...i };
    if (typeof out.url === "string") out.url = swap(out.url);
    if (Array.isArray(out.expect)) {
      out.expect = out.expect.map(e => (e.kind === "url" && typeof e.matches === "string" ? { ...e, matches: swap(e.matches) } : { ...e }));
    }
    return out;
  };
  return {
    ...pack,
    groups: pack.groups.map(g => ({ ...g, items: g.items.map(item) })),
  };
}

/* ------------------------------------------------------------------ beats */

/**
 * The take, in order. The runner asserts each beat against this list as it
 * plays, so a beat that is renamed or reordered in one place and not the other
 * fails loudly instead of quietly writing a timeline nobody can cut from.
 *
 * `read: false` on a beat is the one option an entry carries, and `reads()`
 * below is what reads it: the beat's presses hold what a Go holds — `settle`,
 * then `land` — with no word count and no `read`. It is for a press whose
 * change is a confirmation the viewer already expected — Copy saying Copied.
 * Absent is on.
 */
export const BEATS = [
  { name: "open", item: null, note: "The person's one line, and the agent acting on it: the walk opens, group A's four cards land on the pane as walk_add_items returns, and the agent goes into walk_wait." },
  { name: "go-lamps", item: "lp-lamps", note: "Go on the lamps card: the tab lands on the home page and the row of lamps takes the outline." },
  { name: "pass-lamps", item: "lp-lamps", note: "Pass on the lamps card. The Undo at its right end is green: no agent has been handed it." },
  { name: "decide-tiers-early", item: "lp-tiers", note: "The tiers question, decided: the recommended option, submitted. Two answers on the ledge now, both green." },
  { name: "undo-tiers", item: "lp-tiers", note: "The green Undo on the decision, pressed. The question is back, answerable, the option still picked." },
  { name: "agent-read-lamps", item: "lp-lamps", note: "The agent reads. The lamps row's drain bar is the grace window emptying; when it is gone the row leaves the ledge for the Done shelf and its Undo is red." },
  { name: "show-shelf", item: "lp-lamps", note: "The Done shelf, scrolled into view: the lamps card is there with a red Undo. Undoing now asks first." },
  { name: "go-history-blocked", item: "lp-history", note: "Go on the incidents card. The history page is still a build behind, so the pane files blocked and paints the kerb instead of showing a card that cannot pass." },
  { name: "go-lock", item: "lp-lock", note: "Go on the maintenance lock: the dashboard." },
  { name: "lock-step-1", item: "lp-lock", note: "Maintenance on — the lamps go amber behind the banner — and step one is ticked." },
  { name: "lock-step-2", item: "lp-lock", note: "Post an update, pressed while the lock is on: nothing happens, because the button is off. Step two ticked." },
  { name: "issue-lock", item: "lp-lock", note: "An issue in the person's own words, filed against the lock card." },
  { name: "decide-tiers", item: "lp-tiers", note: "A ten-second decision: the recommended option, submitted." },
  { name: "agent-read", item: null, note: "The agent reads. Every answer it is handed stops being freely undoable: the Undo goes red and the card drops to the Done shelf." },
  { name: "group-b", item: "lp-landed", note: "Cards arriving mid-walk: group B lands above group A, and the history page is rebuilt with it." },
  { name: "go-history", item: "lp-history", note: "Go on the incidents card again. It opens this time, and the list takes the outline." },
  { name: "pass-note-history", item: "lp-history", note: "A pass with a note." },
  { name: "go-key", item: "lp-key", note: "Go on the API key card: the settings page." },
  // `read: false`: the Copied note is the button telling the viewer the press
  // they just made worked. Nobody reads a receipt, so this press holds what a
  // Go holds — `settle`, then `land` — and never a read on the note's words.
  { name: "copy-key", item: "lp-key", read: false, note: "The card's own Copy button puts the secret on the clipboard. The pane never shows it: the row is dots." },
  { name: "paste-key", item: "lp-key", note: "Pasted into the field — the person's hand, because no agent has a clipboard." },
  { name: "verify-key", item: "lp-key", note: "Verify says the key was accepted; both steps ticked, and the card passed." },
  { name: "go-share", item: "lp-share", note: "Go on the status link card: back to the dashboard." },
  { name: "ask-share", item: "lp-share", note: "Ask, answered by the agent on the card it was asked from, in the place of the waiting line. The card was answerable the whole time, and answering it is what resolves it." },
  { name: "share", item: "lp-share", note: "Copy status link on the site reads Copied, and the card is passed." },
  { name: "dismiss-landed", item: "lp-landed", note: "The info card, dismissed." },
  { name: "agent-read-2", item: null, note: "The agent reads again: every card is on the Done shelf and the walk has nothing left on it." },
  { name: "closed", item: null, note: "The agent closes the walk. The pane says so." },
];

/**
 * Whether this beat's presses hold for the words they put on screen.
 *
 * `read: false` is a beat saying its press is not worth a read: the change it
 * makes is a confirmation the viewer already expected, so counting its words
 * and holding for them buys nothing and costs the take a few seconds. The owner, on
 * the Copy button in the Secrets short: *"the time after clicking copy on the
 * secret is still a lot, it should be the same delay time as after clicking the
 * go button right before it."*
 *
 * It is a flag and not a word count because the point is to switch the rule
 * **off**, not to argue with its arithmetic: anything written in numbers goes
 * stale with the copy, which is the whole reason the count is measured. Absent
 * is on, so a new beat gets the rule without having to ask for it. What the
 * press holds instead is `pace.confirm()`: `settle`, then `land`, the same two
 * a Go sleeps — his measure for it was the Go right before it.
 */
export const reads = beat => beat?.read !== false;

/**
 * The person's question, typed into the pane and quoted on the terminal.
 *
 * The one thing the research said would read as fake if it slipped: the two
 * surfaces have to agree to the character, because the transcript quotes what
 * the hand typed. So it is one constant, the recorder types it, and the beat
 * refuses the take if the verdict the daemon hands back says anything else.
 */
export const ASK_TEXT = "Is the link meant to end with a slash?";

/* ------------------------------------------------------------------- args */

/** The two schemes `--scheme` takes: what `prefers-color-scheme` is emulated as. */
export const SCHEMES = ["light", "dark"];

/** `WxH`, both even — `yuv420p` will not take an odd one. */
export function parseSize(s) {
  const m = /^(\d+)x(\d+)$/.exec(String(s ?? ""));
  if (!m) throw new Error(`--terminal-size wants WxH, not ${JSON.stringify(s)}`);
  const size = { width: Number(m[1]), height: Number(m[2]) };
  if (size.width % 2 || size.height % 2) throw new Error(`--terminal-size has to be even both ways for yuv420p, not ${size.width}x${size.height}`);
  if (size.width < 320 || size.height < 120) throw new Error(`--terminal-size ${size.width}x${size.height} is too small for a terminal`);
  return size;
}

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--speed") opts.speed = Number(argv[++i]);
    else if (a === "--keep-frames") opts.keepFrames = true;
    else if (a === "--no-overlay") opts.overlay = false;
    else if (a === "--scheme") {
      const v = argv[++i];
      if (!SCHEMES.includes(v)) throw new Error(`--scheme is ${SCHEMES.join(" or ")}, not ${JSON.stringify(v)}`);
      opts.scheme = v;
    } else if (a === "--terminal-size") opts.terminalSize = parseSize(argv[++i]);
    else if (a === "--terminal-theme") {
      const v = argv[++i];
      if (!THEME_NAMES.includes(v)) throw new Error(`--terminal-theme is ${THEME_NAMES.join(" or ")}, not ${JSON.stringify(v)}`);
      opts.terminalTheme = v;
    } else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

/**
 * Where a take lives: one fixed folder per scheme, and the next take of that
 * scheme overwrites it.
 *
 * The owner, 2026-10-05: "we only really care about the absolute latest unless I'm
 * trying to compare in which case they can have unique names". So `--out` names
 * a folder only while two takes are being compared, and that copy goes when the
 * comparison is done. The folder is emptied before the take starts, so nothing
 * of an older take (a still, a frame) can survive into this one.
 */
export const outFor = (scheme = "light") => path.join("demo", "out", scheme === "dark" ? "lamppost-dark" : "lamppost");

/** The light take's folder, which is the one the cut reads unless it says otherwise. */
export const DEFAULT_OUT = outFor("light");

/* -------------------------------------------------------------- the take */

const healthy = async () => {
  try { return (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()).ok === true; }
  catch { return false; }
};

/** Poll until `fn` is truthy, or say what was being waited for. */
async function until(what, fn, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function record(opts = {}) {
  const p = pace(opts.speed ?? 1);
  /** The in-page pointer. On by default; `--no-overlay` films clean footage. */
  const overlay = opts.overlay !== false;
  /** What `prefers-color-scheme` is emulated as, on the pane and on Lamppost. */
  const scheme = opts.scheme ?? "light";
  /**
   * The terminal's own look, which the scheme does **not** decide. The owner,
   * 2026-10-05: *"I lean to keeping the terminal dark in both schemes"* — so
   * this is its own flag and it defaults to dark whatever `--scheme` says.
   */
  const terminalTheme = opts.terminalTheme ?? "dark";
  const theme = themeFor(terminalTheme);
  /** The terminal's filmed viewport. The cut draws it 1:1, so this is the cut's. */
  const TERM = opts.terminalSize ?? DEFAULT_TERMINAL;
  const out = path.resolve(opts.out ?? outFor(scheme));
  const shotsDir = path.join(out, "shots");
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(shotsDir, { recursive: true });
  const log = (...a) => console.log(...a);
  const transcript = await loadTranscript();

  // --- the daemon, with the real grace window so the green Undo is real.
  // `--no-copy`: it mints a token in a fresh data dir and would otherwise put it
  // on the clipboard, which a recording must not take from whoever is recording.
  if (await healthy()) throw new Error(`port ${PORT} busy — something is already serving walkd there`);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-record-"));
  const daemon = spawn(process.execPath, [WALKD, "serve", "--port", String(PORT), "--data-dir", dataDir, "--state-dir", path.join(dataDir, "state"), "--grace-ms", String(GRACE_MS), "--no-copy"], { stdio: "inherit" });
  await until(`walkd on ${PORT}`, healthy);
  // This daemon's own token, out of the data dir it was told to use: it refuses
  // every route but /health without it, and the launcher, the pane and the
  // viewer reads below all go through it (secrets review).
  const token = await readToken(dataDir);
  log(`walkd on ${PORT}, data in ${dataDir}.`);

  // --- Lamppost, ours, so the launcher finds it already up and never spawns one.
  const site = await startSite(SITE_PORT);
  log(`Lamppost on ${site.port}.`);
  // --- and the agent terminal, the third surface.
  const agentPage = await startAgentPage(AGENT_PORT);
  log(`agent terminal on ${agentPage.port}, @xterm/xterm ${xtermVersion()}, theme "${theme.name}", filmed at ${TERM.width}x${TERM.height}.`);

  const { chromium } = await import("@playwright/test");
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    // `prefers-color-scheme`, for the whole context. The pane follows Chrome's
    // theme and has no toggle of its own (`panel.css`); Lamppost honours it too
    // unless its own System/Light/Dark setting has been pressed, and nothing
    // presses it in this take. The terminal page does not read it at all — its
    // colours come from `--terminal-theme` — so a dark take with a dark
    // terminal and a light take with a dark terminal are both one flag apart.
    colorScheme: scheme,
    viewport: SCREEN,
    // The Copy button writes to the clipboard from the pane and the site reads
    // it back at the paste beat — both halves have to be granted.
    permissions: ["clipboard-read", "clipboard-write"],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--remote-debugging-port=${DEBUG_PORT}`, WINDOW],
  });

  let handle = null;
  // `overlay` is in the file because the cut has to know: a take filmed with
  // the in-page pointer already has one, and drawing a second one from the
  // track over the top of it is the two-pointers complaint all over again.
  // `pace` is the numbers this take actually ran on, so a cut that finds a beat
  // long can read why out of the file instead of re-deriving it.
  const timeline = { startedAt: null, fps: FPS, overlay, scheme, pace: paceSummary(p), surfaces: {}, events: [], cursor: [] };
  let t0 = 0;
  let nextBeat = 0;
  let caps = null;
  let pulses = {};

  try {
    const siteTab = ctx.pages()[0] ?? (await ctx.newPage());
    const panel = await ctx.newPage();
    const termTab = await ctx.newPage();
    // The terminal's and the pane's viewports first, the site's last: all three
    // calls move the one browser window they share, and `fitWindow` then has
    // the final word on it for the site's sake. The other two are hidden tabs,
    // which are filmed at their emulated viewport and so owe the window
    // nothing.
    await termTab.setViewportSize(TERM);
    await panel.setViewportSize(PANE);
    await siteTab.setViewportSize(SCREEN);
    // Before either page has navigated, so the init script is in place for the
    // site's six navigations and for the pane's one. Not on the terminal:
    // nothing hovers a terminal, and the take's claim is that the person's hand
    // is in the pane and the agent's is nowhere.
    if (overlay) for (const pg of [siteTab, panel]) await installOverlay(pg);
    // And the scheme again, per page, because the context option is a default a
    // page can be created before: `emulateMedia` is `Emulation.setEmulatedMedia`
    // on that page's own session and is idempotent.
    for (const pg of [siteTab, panel]) await pg.emulateMedia({ colorScheme: scheme });

    // `t0` comes off a frame's wall clock, which has sub-millisecond precision;
    // nothing downstream wants the fraction, and a 60 fps slot is 16 ms wide.
    const since = () => Math.round(Date.now() - t0);
    const at = (name, item, note) => { const ev = { t: since(), name, item: item ?? null, note }; timeline.events.push(ev); return ev; };
    /**
     * When a change the beat waited for was actually in the DOM.
     *
     * The three beats that wait for something nobody pressed — the blocked
     * diagnostic, the lamps row leaving the ledge, the agent's answer —
     * are the ones whose footage has to be checked, and checking it needs the
     * instant to check against. `until`'s resolve is that instant: the poll
     * that returned true is the first poll at which the pane had it.
     */
    let landing = null;
    const landed = what => { if (landing) (landing.landed ??= []).push({ what, t: since() }); };

    /** The worker is re-read rather than held: Chrome may replace it. */
    const worker = async () => ctx.serviceWorkers().find(w => w.url().startsWith("chrome-extension://")) ?? (await ctx.waitForEvent("serviceworker"));
    const sw = await worker();
    const extId = sw.url().split("/")[2];

    await siteTab.goto(`${SITE}/`);

    // The site is the tab the extension navigates and photographs, so it is the
    // active one from here to the end. Set through the extension's own tabs
    // API, never `bringToFront` — the pane would stop being the background tab
    // its Go and its screenshot depend on. (`bringToFront` does not resize
    // anything; `setViewportSize` is the call that moves the window.)
    const siteTabId = await sw.evaluate(async base => {
      const tabs = await chrome.tabs.query({});
      return tabs.find(t => t.url && t.url.startsWith(base))?.id;
    }, SITE);
    if (siteTabId === undefined) throw new Error("the site tab is not one the extension can see");
    const focusSite = async () => { await (await worker()).evaluate(id => chrome.tabs.update(id, { active: true }), siteTabId); };
    await focusSite();

    // The window last: the pane's `setViewportSize` moved it to fit a 400 px
    // page and the site's own call cannot move it back, so it is set here by
    // hand and checked. Left wrong, the site films at the window's content
    // area and the whole take comes out small in a grey field.
    const fitted = await fitWindow(ctx, siteTab, SCREEN);
    log(`window ${fitted.bounds.width}x${fitted.bounds.height} — ${SCREEN.width}x${SCREEN.height} of page plus ${fitted.inset.width}x${fitted.inset.height} of browser.`);

    // --- the terminal, up and resting at its prompt before anything is filmed.
    // The theme travels in the query string and the size is the viewport, so
    // `FRAME` in `demo/agent/theme.js` follows `--terminal-size` instead of
    // being a constant the page and the camera have to agree about by hand.
    await termTab.goto(`http://127.0.0.1:${agentPage.port}/?theme=${terminalTheme}`);
    await termTab.waitForFunction(() => window.agent?.ready === true, null, { timeout: 30_000 });
    const termSize = await termTab.evaluate(() => ({ ...window.agent.size, canvas: window.agent.canvas, viewport: window.agent.viewport }));
    if (termSize.viewport.width !== TERM.width || termSize.viewport.height !== TERM.height)
      throw new Error(`the terminal page is ${termSize.viewport.width}x${termSize.viewport.height}, not the ${TERM.width}x${TERM.height} it was asked for`);
    log(`terminal ${termSize.cols}x${termSize.rows} cells at ${theme.font.size} px (${termSize.canvas ? "canvas" : "DOM"} renderer), wrap ${theme.wrap}.`);
    await focusSite();

    // --- the launcher, playing the agent. Its own timers are pushed past the
    // end of the take: this script lands group B and reads on the beat.
    const pack = retarget(await loadPack(), SITE_PORT);
    // Group A is handed to the launcher **empty** and added by hand at the beat
    // the terminal prints `walk_add_items`, so the pane fills *because of the
    // call* rather than before the camera rolled. With the terminal in the take
    // there is no other honest order: a terminal printing an add whose cards
    // have been on the pane since frame 0 is the one thing a viewer watching
    // both surfaces would catch. (It is safe to land them after the pane is on
    // the walk, which the agent take proved: the worker's first read has
    // finished and its view is stored by the time the header is drawn, so a
    // later item arrives as a stream frame for a walk it knows about.)
    const groupA = { ...pack.groups[0] };
    const groupAItems = groupA.items.map(i => ({ ...i, group: groupA.name }));
    handle = await main({
      port: PORT, site: SITE_PORT, token,
      pack: { ...pack, groups: [{ ...groupA, items: [] }, pack.groups[1]] },
      manual: true,
      afterMs: 10 * 60 * 1000,
      doneMs: 10 * 60 * 1000,
      log: l => log(`  launcher: ${l}`),
    });

    /** A read that hands nothing to any agent — the pane's own kind. */
    const peek = async () => {
      const res = await fetch(`http://127.0.0.1:${PORT}/walks/${handle.id}?after=0&viewer=1`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`walkd ${res.status} reading ${handle.id}`);
      return res.json();
    };

    // Only now is the extension pointed at this recording's daemon, and only
    // then is the pane opened on it. Until this line the worker has no reason
    // to talk to anything, and nothing has been filmed — the pane is still
    // about:blank.
    // The port and this daemon's token together: the pane cannot read the file
    // the token is in, so the recorder does the paste the person would.
    await (await worker()).evaluate(([port, tok]) => chrome.storage.local.set({ "walkd:port": port, "walkd:token": tok }), [PORT, token]);
    await panel.goto(`chrome-extension://${extId}/panel.html`);
    // Again for the pane, because nothing in Playwright's own tests says an
    // init script reaches a `chrome-extension://` document; this is the half
    // that is certain, and it is idempotent.
    if (overlay) await repaintOverlay(panel);
    await panel.emulateMedia({ colorScheme: scheme });
    await focusSite();

    const pane = sel => panel.locator(sel);

    /* ------------------------------------------------- roll the camera */

    // Nothing above this line is filmed. The pane is asked for the walk and the
    // header is waited for *first*, so the camera's first frame is a pane on an
    // open walk with its brief on it and nothing else — which is exactly what
    // the agent is about to fill, in the `open` beat, as the terminal prints the
    // call that fills it. Not about:blank, and not a site tab still being
    // resized.
    await panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
    await pane(`header[data-walk-id="${handle.id}"]`).waitFor({ timeout: 30_000 });
    await focusSite();
    await siteTab.waitForLoadState("networkidle").catch(() => {});

    // What the scheme actually did, measured rather than assumed: a take shot in
    // the wrong one is a whole take wasted, and the two grounds are a hex apart.
    const grounds = {
      site: await siteTab.evaluate(() => getComputedStyle(document.body).backgroundColor),
      pane: await panel.evaluate(() => getComputedStyle(document.body).backgroundColor),
      dark: await panel.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches),
    };
    if (grounds.dark !== (scheme === "dark")) throw new Error(`--scheme ${scheme} but the pane reports prefers-color-scheme: dark = ${grounds.dark}`);
    log(`scheme ${scheme}: site ground ${grounds.site}, pane ground ${grounds.pane}, terminal ${theme.ground} (${terminalTheme}).`);

    /**
     * Where the pointer is on each surface, in that surface's CSS pixels.
     *
     * Every glide starts from here and ends by writing here, which is what makes
     * the track continuous: an excursion to the other surface does not move this
     * one's pointer, so the next glide on it picks up exactly where it stopped.
     * They are parked bottom-left and told so **before the camera rolls** — the
     * real pointer has been at 1,1 on the site since `fitWindow` nudged it to
     * get a frame out, and has never moved at all on the pane, and a first glide
     * that disagreed with either would be a jump in the first frames of the take.
     */
    const pointer = { site: { x: 24, y: SCREEN.height - 24 }, pane: { x: 24, y: PANE.height - 24 } };
    const BOUNDS = { site: SCREEN, pane: PANE };
    await siteTab.mouse.move(pointer.site.x, pointer.site.y);
    await panel.mouse.move(pointer.pane.x, pointer.pane.y);

    /** True while a beat is taking its stills, which the pulses stay out of. */
    let shooting = 0;
    /** Each filmed surface's page and the size it is filmed at, in one place. */
    const SURFACE = { site: { page: siteTab, size: SCREEN }, pane: { page: panel, size: PANE }, terminal: { page: termTab, size: TERM } };
    const NAMES = Object.keys(SURFACE);

    const frames = path.join(out, "frames");
    caps = Object.fromEntries(await Promise.all(NAMES.map(async k =>
      [k, await startCapture(SURFACE[k].page, { dir: path.join(frames, k), size: SURFACE[k].size })])));

    /**
     * The pulses: one per **hidden** surface, for the whole take.
     *
     * The site is the active tab and redraws when it changes; the pane and the
     * terminal are background tabs — the extension's Go and its verdict
     * screenshot both work on `chrome.tabs.query({active: true})`, so Lamppost
     * has to stay active — and a background tab stops redrawing between the
     * recorder's own actions. A card that changed while the hand was still was
     * not in the footage until the next beat moved it, and a terminal only ever
     * changes between actions, so without a pulse it would not send a **first**
     * frame at all and the take would die on the twenty-second timeout below
     * rather than on anything real. `demo/capture.mjs` has the measurement,
     * what else was tried, and why this is what is left.
     *
     * Both start **before** the first frame is waited for, which is why they are
     * here and not where the pane's single pulse used to be.
     */
    pulses = Object.fromEntries(await Promise.all(["pane", "terminal"].map(async k =>
      [k, keepPainting(SURFACE[k].page, { cdp: await ctx.newCDPSession(SURFACE[k].page), busy: () => shooting > 0 })])));

    // A surface that never sends a first frame is a surface that is not
    // compositing, and there is no point playing the whole take to it.
    const firsts = Object.fromEntries(await Promise.all(NAMES.map(async k => {
      const t = await Promise.race([caps[k].first, sleep(20_000).then(() => null)]);
      if (t === null) throw new Error(`the ${k} surface sent no frame in 20 s — it is not compositing`);
      return [k, t];
    })));
    t0 = Math.min(...NAMES.map(k => firsts[k]));
    timeline.startedAt = new Date(t0).toISOString();
    const SURFACE_NOTE = {
      site: `The Lamppost tab, ${SCREEN.width}x${SCREEN.height}.`,
      pane: `The side panel page, ${PANE.width}x${PANE.height}.`,
      terminal: `The agent session, ${TERM.width}x${TERM.height}, drawn 1:1.`,
    };
    for (const k of NAMES)
      timeline.events.push({ t: Math.round(firsts[k] - t0), name: `${k}-video-start`, item: null, note: `${k}.mp4's first frame. ${SURFACE_NOTE[k]}` });

    // The pointer a person watching the raw take follows: real DOM on both
    // surfaces, so it is in the footage where the hand actually is, with no
    // second clock of its own. `demo/overlay.mjs` says why `showActions` is not
    // here any more.
    const surfaces = [siteTab, panel];
    const hideCursor = () => setOverlay(surfaces, false);
    const showCursor = () => setOverlay(surfaces, true);

    /* ---------------------------------------------------------- the hand */

    /**
     * Every sample of every move, and every press and release, in the surface's
     * own CSS pixels. The cut draws the pointer from this: it is sharp at any
     * zoom, it does not blink out between actions, and it is the same data on
     * both surfaces whatever the browser did at capture time.
     */
    const mark = (surface, x, y, kind) => { timeline.cursor.push({ t: since(), surface, x, y, kind }); };
    /**
     * Move a hand to a target: a Bézier arc on Fitts's-law timing, eased,
     * overshooting and settling, landing a little off the target's centre.
     * `demo/hand.mjs` is the whole of the maths and the whole of the why.
     *
     * `key` is what makes the take repeatable: it seeds this target's offset and
     * its arc, so the same beat is shot the same way every time. It defaults to
     * the locator's own text, which names the item — `locator('[data-go=
     * "lp-lamps"]')` — and is stable across runs in a way a counter is not.
     *
     * Each sample is a real `mousemove`, so hover states happen and the pane
     * repaints — which is what keeps frames coming out of it during the stretch
     * of a beat when nothing else on it is changing. The samples are played
     * against absolute deadlines rather than sleeps between them: a slow CDP
     * round trip then costs the move nothing, instead of stretching it.
     */
    const glide = async (surface, page, locator, key = String(locator)) => {
      await locator.scrollIntoViewIfNeeded({ timeout: 20_000 });
      const b = await locator.boundingBox();
      if (!b) throw new Error(`${surface}: nothing to glide to for ${locator}`);
      const target = aim(b, key);
      const { points } = handPath({ from: pointer[surface], to: target, key, speed: p.speed, width: aimWidth(b), bounds: BOUNDS[surface] });
      const started = Date.now();
      for (const s of points) {
        const wait = started + s.t - Date.now();
        if (wait > 0) await sleep(wait);
        mark(surface, s.x, s.y, "move");
        await page.mouse.move(s.x, s.y);
      }
      pointer[surface] = { x: target.x, y: target.y };
      return target;
    };
    /**
     * Glide, then press — `act` is `click` or `check`.
     *
     * `position` is the point the hand landed on, relative to the box, so
     * Playwright presses **there** rather than snapping back to the centre the
     * way a bare `locator.click()` does — which would undo the off-centre aim
     * in one frame. Everything else about `click` is unchanged, actionability
     * checks included, which is what `tap`'s `force` still gets past.
     *
     * **The button is held down for `clickHold`.** Playwright's `delay` defaults
     * to 0, so every press in the take before this one was an instantaneous
     * down-up, which is one of the things that reads as synthetic about a
     * recorded click — a person holds a mouse button for 100–120 ms.
     * `locator.check()` takes no `delay`, so a tick is pressed by hand instead:
     * `mouse.down`, the hold, `mouse.up`, where the glide has already left the
     * real pointer. Then the state `check` exists to assert is waited for,
     * which is also what covers the pane rebuilding the card around the box.
     */
    const hand = async (surface, page, locator, act = "click", o = {}) => {
      const { x, y, rel } = await glide(surface, page, locator);
      // The track carries a press only when one happens: a tick on a box that
      // is already checked (the tiers option after `undo-tiers` handed it back
      // picked) glides there and presses nothing, so it marks nothing — a cut
      // drawing a ring from every `down` would otherwise ring a radio nobody
      // clicked.
      if (act === "check") {
        if (!(await locator.isChecked())) {
          mark(surface, x, y, "down");
          await page.mouse.down();
          await sleep(p.clickHold);
          await page.mouse.up();
          mark(surface, x, y, "up");
          await until(`${locator} to be checked`, () => locator.isChecked().catch(() => false), 20_000);
        }
      } else {
        mark(surface, x, y, "down");
        await locator[act]({ timeout: 20_000, position: rel, delay: p.clickHold, ...o });
        mark(surface, x, y, "up");
      }
    };

    /* --------------------------------------------------------- the holds */

    /**
     * What the viewer is given after each action. `demo/pace.mjs` is the table,
     * its sources and the arithmetic; this is the half that needs a browser.
     *
     * Every hold is keyed on the beat it falls in and which hold of that beat it
     * is, so each one is nudged off its number — a fixed beat reads as a
     * metronome — while the take still comes out the same length every run.
     * `holding` totals what a beat spent on press holds and the beat writes it
     * into `timeline.json`.
     *
     * Three kinds of hold exist in the beats below, and only the first is in
     * here: the rules' own (`settle`, `read`, `afterTyping`, `land`), the
     * product's (an animation, the daemon's grace window, a change that arrives
     * on the agent's clock), and the take's two ends. A beat that writes a
     * `hold(…)` by hand says which of the last two it is.
     */
    let beatKey = "pre-roll";
    let holdNo = 0;
    /** `reads(spec)` for the beat being played: false switches the read off. */
    let beatReads = true;
    let holding = { settle: 0, read: 0, newWords: 0, ms: 0 };
    /** This beat's next hold, as a jitter key: `undo-lamps/2`. */
    const k = () => `${beatKey}/${holdNo++}`;
    /** A hold no rule covers, written into a beat. Jittered like any other. */
    const hold = ms => sleep(p.vary(p.hold(ms), k()));

    /**
     * The words a viewer can see, per surface.
     *
     * `innerText` and not `textContent`: it is what was laid out and is visible,
     * so a card the pane has not drawn does not count, and the string is in
     * reading order. A page mid-navigation has no body to ask — that is an empty
     * string, not a failed take.
     *
     * The terminal is asked for its own **visible buffer** instead
     * (`window.agent.text()`, the viewport rows in reading order), which is what
     * `innerText` is for the pane: a row that has scrolled off is not something
     * the viewer is being asked to read. It is **not** in the default list: a
     * press in the pane never changes the terminal, and counting its whole
     * buffer against the first press of the take would put several seconds of
     * read on a beat that earned none. Only `say()` counts it, right after a
     * block prints.
     */
    const visible = async (which = ["site", "pane"]) => {
      const seen = {};
      for (const s of which) {
        if (s === "terminal") seen[s] = await termTab.evaluate(() => window.agent.text()).catch(() => "");
        else seen[s] = await SURFACE[s].page.evaluate(() => document.body.innerText).catch(() => "");
      }
      return seen;
    };

    /**
     * The hold after a press: `settle`, then the words that press turned out to
     * change, then the rest of `read` if there is any — `max(settle, read)`,
     * never the sum.
     *
     * **The count is measured, not declared.** A word count written into each
     * beat by hand goes stale the first time the copy changes, and silently.
     * Measuring it `settle` after the press is also what keeps the rule honest
     * about asynchrony: a change that has not arrived by then is not something
     * the viewer is being asked to read yet, and the beat holds for it on its
     * own if it is worth holding for.
     *
     * **A beat may say its press is not worth a read** — `read: false` in
     * `BEATS`, and `beatReads` is it. Then nothing is counted, no second
     * snapshot is taken, and the press holds `pace.confirm()`: `settle`, then
     * `land`, the hold a Go gets. The beat's `hold` carries `readRule: "off"`
     * and the `land` it slept, so the cut can see where the time went rather
     * than wondering what went wrong with the count.
     */
    // Everything the viewer has been shown on each surface so far (pace.mjs,
    // `freshWords`): a press is held for the words it put on screen for the
    // first time, not for a control set the viewer read minutes ago.
    const shown = { site: new Map(), pane: new Map(), terminal: new Map() };
    const afterPress = async before => {
      const key = k();
      const { settle } = p.press(0, key);
      // What was on screen before the press has been seen, whether or not a
      // hold was ever written for it.
      for (const s of Object.keys(before)) freshWords(shown[s], before[s]);
      await sleep(settle);
      let h;
      if (beatReads) {
        const after = await visible(Object.keys(before));
        const words = Object.keys(before).reduce((n, s) => n + freshWords(shown[s], after[s]), 0);
        h = p.press(words, key);
        if (h.ms > h.settle) await sleep(h.ms - h.settle);
      } else {
        // The read is off: no second snapshot, no count. The press holds the
        // landing a Go holds after its settle, and that is all.
        h = p.confirm(key);
        await sleep(h.land);
      }
      holding = {
        ...holding,
        settle: holding.settle + h.settle,
        read: holding.read + h.read,
        newWords: holding.newWords + h.newWords,
        ms: holding.ms + h.ms,
        ...(h.land ? { land: (holding.land ?? 0) + h.land } : {}),
      };
    };

    /**
     * A read hold for words that arrived without a press: the agent's reply
     * card, the pane's own blocked diagnostic. The press rule cannot see them —
     * its snapshot is taken `settle` after the press, and these land seconds
     * later on the daemon's or the agent's clock — so a beat waits for them,
     * then counts what is new on the surface and holds the read the rule would
     * give a press that had put them there. It goes into the beat's `hold`
     * like a press's would, so the cut can see why the beat took as long as
     * it did.
     */
    const readArrived = async (surface = "pane") => {
      const after = await visible([surface]);
      const r = p.press(freshWords(shown[surface], after[surface]), k());
      holding = { ...holding, settle: holding.settle + r.settle, read: holding.read + r.read, newWords: holding.newWords + r.newWords, ms: holding.ms + r.ms };
      await sleep(r.ms);
    };

    /**
     * A press in the pane, with the pause of someone who looked first and the
     * hold of someone reading what it did. `watch` narrows which surfaces the
     * words are counted on; both, unless a caller knows better.
     */
    const press = async (sel, o = {}) => {
      await sleep(p.vary(p.look, k()));
      const before = await visible(o.watch);
      await hand("pane", panel, pane(sel));
      await focusSite();
      await afterPress(before);
    };
    /** A tick in the pane: the same pauses, a checkbox rather than a button. */
    const tick = async sel => {
      await sleep(p.vary(p.look, k()));
      const before = await visible();
      await hand("pane", panel, pane(sel), "check");
      await focusSite();
      await afterPress(before);
    };
    /** A press on the site itself. `force` is for the button that is off. */
    const tap = async (sel, o = {}) => {
      await sleep(p.vary(p.look, k()));
      const before = await visible();
      await hand("site", siteTab, siteTab.locator(sel), "click", o);
      await afterPress(before);
    };
    /**
     * Typed, not filled: the camera is watching the note box.
     *
     * No `read` afterwards — the string appeared a character at a time under the
     * viewer's eye, so there is nothing new to take in. What it gets is
     * `afterTyping`, the beat between the last character and the next press.
     */
    const typeInto = async (sel, text) => {
      await sleep(p.vary(p.look, k()));
      await hand("pane", panel, pane(sel));
      await panel.keyboard.type(text, { delay: p.type });
      await focusSite();
      await sleep(p.vary(p.afterTyping, k()));
    };
    /**
     * Go, the page it lands on, and that page's own hold.
     *
     * The press is counted on the **pane** only. The site is about to be a
     * different page, and counting a whole new page's words would put five
     * seconds of `read` on top of the hold a new picture already has — which is
     * `land`: 900 ms plus the 300 ms the lamps take to finish changing colour,
     * and the 300 is the product's animation, so no `--speed` touches it. 1200
     * ms, with ITC's one second for a viewer to adjust to a new picture inside
     * it.
     */
    const go = async (id, url) => {
      await press(`[data-go="${id}"]`, { watch: ["pane"] });
      if (url) await siteTab.waitForURL(url, { timeout: 30_000 });
      await sleep(p.colour);
      await sleep(p.vary(p.land, k()));
    };

    /* ------------------------------------------------- the pane's scroller */

    /**
     * The pane is one document and its body is the scroller: the Done shelf is
     * the last section in it and `.ledge` is sticky to its bottom. Nothing in
     * `panel.ts` ever scrolls it — the owner, 2026-09-23: *"the way the thing
     * scrolled me away from where I was was… surprising"* — so every scroll in
     * the take is the person's hand on the wheel and the camera's to watch.
     */
    const scrollState = () => panel.evaluate(() => {
      const sc = document.scrollingElement;
      return { y: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight) };
    });
    /** Where something is in the pane's frame, and whether it is all of it in. */
    const inFrame = sel => panel.evaluate(s => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const h = document.scrollingElement.clientHeight;
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), frame: h, inside: r.top >= 0 && r.bottom <= h };
    }, sel);
    /**
     * Scroll the pane to `y` the way a person does: the wheel, in a dozen
     * notches eased over `ms`, so the footage shows the pane moving.
     *
     * The alternative is the one thing the camera must not see. `glide` opens
     * with `locator.scrollIntoViewIfNeeded`, which is an **instant jump** — so a
     * press on a control that is off screen teleports the pane in a single frame.
     * Every scroll here is filmed, and the beat that scrolls puts the pane back
     * where the next press needs it before it ends.
     *
     * Chromium animates a wheel scroll, so the scroller is still moving when the
     * last notch is sent: it is waited out and whatever the animation left on
     * the table is taken up in one more notch. Nothing is written to the cursor
     * track — the wheel does not move the pointer, and `move`, `down` and `up`
     * are the only kinds the track may carry.
     */
    const wheelTo = async (y, ms = 520, steps = 14) => {
      const before = await scrollState();
      const target = Math.max(0, Math.min(before.max, Math.round(y)));
      const total = target - before.y;
      if (!total) return before.y;
      /** Smoothstep: the wheel accelerates away and eases in, as a hand does. */
      const ease = u => u * u * (3 - 2 * u);
      const started = Date.now();
      let sent = 0;
      for (let i = 1; i <= steps; i++) {
        const wait = started + Math.round((ms * i) / steps) - Date.now();
        if (wait > 0) await sleep(wait);
        const want = Math.round(total * ease(i / steps));
        const dy = want - sent;
        sent = want;
        if (dy) await panel.mouse.wheel(0, dy);
      }
      let last = -1;
      await until("the pane's scroll to settle", async () => { const { y: now } = await scrollState(); const still = now === last; last = now; return still; }, 10_000);
      const after = await scrollState();
      if (after.y !== target) {
        await panel.mouse.wheel(0, target - after.y);
        await sleep(150);
      }
      return (await scrollState()).y;
    };

    /* ------------------------------------------------------ the terminal */

    /**
     * What the agent has learned so far, as the transcript's placeholders.
     *
     * `spinner` is the theme's, so the waiting line is furniture a second theme
     * owns rather than copy. Everything else is filled from the daemon at the
     * moment it becomes true — and `fill` throws on one that is not set yet, so
     * a block cannot be printed ahead of the fact it describes.
     */
    const vars = { spinner: theme.labels.spinner };

    /**
     * How many things the terminal has been told to draw.
     *
     * It is the surface's own health floor: a take that filmed every block
     * cannot have produced fewer distinct frames than it printed blocks, and
     * that is a count the transcript keeps up to date by itself where a number
     * written here would go stale the first time a block was added.
     */
    let printed = 0;
    /** Print one transcript block, and hold for what it put on screen. */
    const say = async name => {
      const block = blockByName(transcript, name);
      const lines = renderLines(block, vars, theme);
      await termTab.evaluate(([ls, open]) => window.agent.print(ls, { open }), [lines, Boolean(block.open)]);
      printed++;
      landed(`the terminal's ${name}`);
      await readArrived("terminal");
    };
    /** The person's line, typed at the pace rule's 45 ms a character. */
    const typePrompt = async name => {
      await sleep(p.vary(p.look, k()));
      const text = typedText(blockByName(transcript, name), vars);
      await termTab.evaluate(([t, ms]) => window.agent.type(t, ms), [text, p.type]);
      printed++;
      await sleep(p.vary(p.afterTyping, k()));
    };

    /**
     * What an agent read would be handed right now, as the daemon decides it.
     *
     * `packages/walkd/src/store.ts`'s own rule, over a **viewer** read so that
     * asking does not hand anything over: after the cursor, not hidden (a
     * quietly-undone verdict and the verdict it took back are invisible to every
     * agent read), matured past the grace window, and **stopping at the first
     * one that has not matured** — a cursor may never skip a verdict still to
     * come.
     *
     * The read beats use it to wait until a whole group of verdicts has matured
     * before reading once, so the terminal prints one `walk_wait` result
     * carrying all of them — which is also what the pane shows, every one of
     * those cards leaving the ledge together on the one read.
     */
    const handable = async after => {
      const seen = await peek();
      const hidden = new Set();
      for (const v of seen.verdicts) if (v.quiet && v.retracts !== undefined) { hidden.add(v.retracts); hidden.add(v.seq); }
      const out = [];
      for (const v of seen.verdicts) {
        if (v.seq <= after) continue;
        if (Date.now() - Date.parse(v.at) < GRACE_MS) break;
        if (!hidden.has(v.seq)) out.push(v);
      }
      return out;
    };

    /** `<kind> <itemId>`, and with the seq when the read has to match to the number. */
    const shapeOf = v => `${v.kind} ${v.itemId}`;
    const stampOf = v => `${v.seq} ${v.kind} ${v.itemId}`;

    /**
     * The verdicts the next agent read will be handed: waited for, and checked
     * against the ones the beat is filming.
     *
     * The terminal prints a `walk_wait` result **before** the read that hands it
     * over, because that is the order on camera: the agent's return and the
     * pane's row leaving the ledge are the same event, and a terminal that
     * printed the add of a reply already on the pane would be reading the take
     * backwards. So the numbers come from the daemon's own rule over the
     * daemon's own data (`handable`), the beat prints them, and `handOver` below
     * refuses the take if the read then handed over anything else.
     *
     * `want` is `<kind> <itemId>` per verdict, in seq order.
     */
    const nextHanded = async (what, want) => {
      await until(`${what} to mature past the ${GRACE_MS / 1000} s grace window`, async () => (await handable(handle.cursor)).length >= want.length, 120_000);
      const ready = await handable(handle.cursor);
      if (ready.map(shapeOf).join(", ") !== want.join(", "))
        throw new Error(`the daemon is about to hand over [${ready.map(shapeOf).join(", ")}] for ${what} and the transcript films [${want.join(", ")}]`);
      return ready;
    };
    /** The read itself, and the check that it handed over exactly what was filmed. */
    const handOver = async filmed => {
      const from = handle.handed.length;
      await handle.read();
      const got = handle.handed.slice(from);
      if (got.map(stampOf).join(", ") !== filmed.map(stampOf).join(", "))
        throw new Error(`the read handed over [${got.map(stampOf).join(", ")}] and the terminal had already printed [${filmed.map(stampOf).join(", ")}]`);
      if (handle.cursor !== filmed.at(-1).seq)
        throw new Error(`the agent's cursor is ${handle.cursor} and the terminal printed ${filmed.at(-1).seq}`);
    };

    const count = async sel => pane(sel).count();
    /** The inline outline the content script paints on a Go target. */
    const outlined = walkId => siteTab.locator(`[data-walk=${walkId}]`).evaluate(el => el.style.outline).then(o => String(o).includes("solid")).catch(() => false);
    /** The card is answered and the answer is still the person's alone. */
    const green = id => count(`[data-undo-now="${id}"]`).then(n => n > 0);
    /** The card is answered and the agent has it: red Undo, or on the shelf. */
    const handedOver = id => Promise.all([count(`[data-undo="${id}"]`), count(`section.shelf [data-item="${id}"]`)]).then(([a, b]) => a + b > 0);
    const onShelf = id => count(`section.shelf [data-item="${id}"]`).then(n => n > 0);

    /**
     * One beat: its event, the work, then a still of each surface. The stills
     * are taken at the end, so they show what the beat produced — and with the
     * in-page pointer put away first, because the stills are documentation.
     */
    const beat = async (name, work) => {
      const spec = BEATS[nextBeat];
      if (!spec || spec.name !== name) throw new Error(`beat ${nextBeat} is ${spec?.name ?? "past the end"}, not ${name}`);
      nextBeat++;
      beatKey = name;
      holdNo = 0;
      beatReads = reads(spec);
      holding = { settle: 0, read: 0, newWords: 0, ms: 0, ...(beatReads ? {} : { readRule: "off" }) };
      const ev = at(spec.name, spec.item, spec.note);
      landing = ev;
      try { await work(); } finally { landing = null; }
      // What the rules gave the viewer in this beat, so the cut can see why it
      // took as long as it did: `settle` and `read` totalled over its presses,
      // the words they changed, and `ms` the hold actually slept — which is
      // `max(settle, read)` a press, not their sum. A beat that switched the
      // read off says so here too: `readRule: "off"`, with `read` and
      // `newWords` at zero because nothing was counted, and `land` for the
      // landing its press held instead.
      ev.hold = { ...holding };
      const nn = String(nextBeat).padStart(2, "0");
      await hideCursor();
      // Playwright's screenshotter overrides the page's background colour
      // around the capture, so the pulses stay out of all three.
      shooting++;
      try {
        for (const s of NAMES) await SURFACE[s].page.screenshot({ path: path.join(shotsDir, `${nn}-${name}-${s}.png`) });
      } finally { shooting--; }
      await showCursor();
      log(`beat ${nn} ${name} at ${since()} ms`);
    };

    /* --------------------------------------------------------- the beats */

    await beat("open", async () => {
      await panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
      await pane(`header[data-walk-id="${handle.id}"]`).waitFor({ timeout: 30_000 });
      // The person's one line, and then the agent acting on it. The walk is
      // already open on the daemon — the launcher opened it so the pane could be
      // put on it before the camera rolled — so `walk_open`'s id is the real
      // one, and the add below is the call that really fills the pane.
      vars.walk = handle.id;
      await typePrompt("prompt");
      await say("walk-open");
      await say("add-group-a-call");
      const added = await handle.daemon.add(handle.id, groupAItems);
      vars.seqsA = jsonList(added.map(i => i.seq));
      await until("group A's four cards", async () => (await Promise.all(groupAItems.map(i => count(`[data-item="${i.id}"]`)))).every(n => n > 0));
      landed("group A on the pane");
      at("group-a", null, "Group A: four cards, one of every shape the pane can draw except the info card.");
      await say("add-group-a-result");
      // The agent's line about the cards comes **after** the call that put them
      // there, never before it: on camera the terminal and the pane are read
      // together, and a terminal that says four cards are up while the pane is
      // still empty is the one thing in this take a viewer would catch.
      await say("prose-opened");
      // The pane's four cards arrived on the agent's clock, with no press near
      // them, so they get the read a press that had put them there would get.
      await readArrived("pane");
      await say("wait-1-call");
      // The take's first picture, and a hold no rule can produce: nothing has
      // been pressed yet. §4.4 of the research note says the 27-word brief
      // cannot be read inside a short however long this is — that is the copy's
      // problem and the cut's, not this hold's.
      await hold(1500);
    });

    await beat("go-lamps", async () => {
      await go("lp-lamps", `${SITE}/`);
      await until("the outline on the lamps", () => outlined("lamps"));
      // Kept: the outline breathing on the row of lamps is the product's own
      // animation, and it is the first thing the take asks anyone to look at.
      await hold(2500);
    });

    await beat("pass-lamps", async () => {
      await press('[data-kind="pass"][data-for="lp-lamps"]');
      await until("the green Undo on lp-lamps", () => green("lp-lamps"));
    });

    await beat("decide-tiers-early", async () => {
      // The second answer, so the Undo story has something to compare against.
      // The owner: *"maybe you hit pass on two, then undo one in the green, letting
      // the second fade to red, then scroll if needed or whatever or not, then
      // conclude as you did"*. Both rows drain side by side on the ledge; one is
      // taken back while it is still green, and the other is left to be read.
      //
      // The question is answered again later, in `decide-tiers`, because the
      // undo below hands the card back answerable with this option still picked
      // — which is the half of the free Undo a red one cannot show.
      await tick('[data-item="lp-tiers"] input[value="Lit / Bright"]');
      await press('[data-item="lp-tiers"] button[data-kind="decision"]');
      await until("the answered row on lp-tiers", () => green("lp-tiers"));
      // The caption says two rows, both green, so the take counts them.
      await until("two green rows on the ledge", async () => (await count("section.ledge .item.on-ledge")) === 2 && (await green("lp-lamps")) && (await green("lp-tiers")));
    });

    await beat("undo-tiers", async () => {
      // Two holds gone from here when this was `undo-lamps`: the 2 s before the
      // press that gave the viewer time to notice the green Undo — which the
      // answer that produced it now holds for itself — and the 1 s after it,
      // which is `settle` and `read`'s job and measured rather than guessed.
      await press('[data-undo-now="lp-tiers"]');
      await until("lp-tiers answerable again", async () => (await count('[data-item="lp-tiers"] button[data-kind="decision"]')) > 0);
      // The caption says the option is still picked, so the take checks it: an
      // undone decision hands the card back with the answer that was undone
      // still chosen, because the person is correcting it, not starting over.
      await until("the undone option still picked", () => pane('[data-item="lp-tiers"] input[value="Lit / Bright"]').isChecked().catch(() => false));
      // And the lamps row is left alone on the ledge, still draining.
      await until("the lamps row alone on the ledge", async () => (await count("section.ledge .item.on-ledge")) === 1 && (await green("lp-lamps")));
    });

    await beat("agent-read-lamps", async () => {
      // The read that ends the Undo story, here rather than thirty seconds
      // later. The owner, on the hero cut made from the take before this one:
      // *"'undo is free until an agent reads it' it does something, then fades
      // to something else with 0 context, then fades back to the next step…
      // it doesn't make sense to me and is maybe a mistake?"* — because the free
      // Undo was at 7 s and the read that turns it red was at 43 s, so the cut
      // had to dissolve to a pane nothing else in the story had been on.
      //
      // The daemon holds a fresh verdict for its grace window, so the lamps row
      // drains on the ledge from the Pass that filed it until this read lands,
      // with no press anywhere in this beat. That is the product, and it is a
      // wait a cut can trim honestly: there is nothing to cut around, only time
      // to compress.
      // One read, and the terminal prints exactly what it returns. The pass is
      // the only thing in it: the tiers decision and the undo that took it back
      // are a quiet pair, and the daemon hides both from every agent read, which
      // is why the agent's cursor after this is 1 and not 3.
      const filmed = await nextHanded("the pass on the lamps card", ["pass lp-lamps"]);
      const [pass] = filmed;
      vars.passSeq = pass.seq;
      vars.passText = jsonInner(pass.text);
      vars.cursor1 = pass.seq;
      await say("wait-1-result");
      await handOver(filmed);
      await until("the lamps card handed over", () => handedOver("lp-lamps"), 45_000);
      landed("the lamps row off the ledge, its Undo red");
      await say("prose-lamps");
      await say("wait-2-call");
      // Kept, as in `agent-read` below: the Undo going red and the card dropping
      // to the Done shelf happen on the agent's clock, with no press near them,
      // so there is nothing for `read` to measure.
      await hold(2000);
    });

    await beat("show-shelf", async () => {
      // Where the red Undo actually is. At 400x900 the Done shelf sits under
      // three cards of group A — one of them the tiers question, back to full
      // height from the undo above — so the beat before this one ends with the
      // row dropping to a shelf the camera cannot see. The owner: *"then scroll if
      // needed or whatever or not"*. Whether it is needed is measured, not
      // assumed, and the scroll is filmed as a scroll (`wheelTo`), never the
      // instant jump `scrollIntoViewIfNeeded` would make of it.
      const shelfRow = 'section.shelf [data-item="lp-lamps"]';
      const redUndo = 'section.shelf [data-undo="lp-lamps"]';
      const where = await inFrame(shelfRow);
      if (!where) throw new Error("the lamps card is not on the Done shelf");
      // Where the pane has to be back at before the beat ends: the next beat
      // presses Go on the incidents card and the card then grows its blocked
      // diagnostic, so the WHOLE card has to be in frame — its top near the top
      // of the pane — not merely its Go button. (`glide` would jump the pane in
      // one frame if the button were off screen; and the take-9 cut found that
      // a button-only target left the card cut off after its first line, the
      // orange kerb a sliver at the bottom edge and the diagnostic below the
      // fold for the whole of `go-history-blocked`.)
      const home = await panel.evaluate(sel => {
        const el = document.querySelector(sel);
        const sc = document.scrollingElement;
        const top = el.getBoundingClientRect().top + sc.scrollTop;
        return Math.max(0, Math.round(top - 16));
      }, '[data-item="lp-history"]');
      if (where.inside) {
        log(`  the Done shelf is already in frame — the lamps row is at ${where.top}–${where.bottom} of ${where.frame}, so nothing is scrolled.`);
      } else {
        await sleep(p.vary(p.look, k()));
        const landed = await wheelTo(Number.MAX_SAFE_INTEGER);
        await until("the lamps row on the Done shelf in frame", async () => (await inFrame(shelfRow))?.inside === true, 10_000);
        log(`  the Done shelf was at ${where.top}–${where.bottom} of ${where.frame}: scrolled to ${landed}.`);
      }
      log(`  red Undo in frame: ${JSON.stringify(await inFrame(redUndo))}`);
      // Kept, the product's: the row left the ledge and its Undo went red on the
      // agent's clock in the beat before this one, with no press anywhere near
      // them — the same hold `agent-read` keeps, for the same reason.
      await hold(2000);
      if (!where.inside) {
        const back = await wheelTo(home);
        await until("Go on the incidents card in frame", async () => (await inFrame('[data-go="lp-history"]'))?.inside === true, 10_000);
        log(`  scrolled back to ${back}, where the next press needs the pane.`);
      }
    });

    await beat("go-history-blocked", async () => {
      await press('[data-go="lp-history"]');
      await until("lp-history blocked", async () => (await count('[data-item="lp-history"].blocked')) > 0, 45_000);
      landed("the orange kerb and the blocked diagnostic");
      // The kerb and its 28-word diagnostic land after the pane's expect
      // retry, seconds after the press's own snapshot — which counted the
      // history page's words on the site and nothing on the pane. So hold the
      // read for it once it is here.
      //
      // The take-10 and take-11 cuts measured the diagnostic appearing 30-45 ms
      // before the *next beat*, hours of hold later, which read as the beat
      // being mistimed and was not: the line had been in the DOM the whole time
      // and the pane had stopped painting. That is `keepPainting`, and this is
      // the beat that found it.
      await readArrived();
      // Kept: the product's — the line arrived on the daemon's clock.
      await hold(2000);
    });

    await beat("go-lock", async () => { await go("lp-lock", `${SITE}/dashboard`); });

    await beat("lock-step-1", async () => {
      // The 400 ms between the switch and the tick is `settle` now, and the
      // lamps going amber behind the banner is what `read` is measured on.
      await tap(".switch");
      await tick('[data-step="0"][data-for="lp-lock"]');
    });

    await beat("lock-step-2", async () => {
      // Off while the lock is on: the press is real and nothing happens, which
      // is the step. `force` only gets past Playwright's own enabled check.
      await tap("#post", { force: true });
      // And here the rule earns its keep the other way round: the press changes
      // nothing on screen, so it holds `settle` and nothing more.
      await tick('[data-step="1"][data-for="lp-lock"]');
    });

    await beat("issue-lock", async () => {
      // Issue is dead until there are words in the box — that is the pane's
      // rule, so the words go in first and Issue is the press that files them.
      await typeInto('[data-note="lp-lock"]', "Post an update is off, but nothing says why.");
      await press('[data-kind="issue"][data-for="lp-lock"]');
      await until("the answered row on lp-lock", () => green("lp-lock"));
    });

    await beat("decide-tiers", async () => {
      // The card has been here before: `decide-tiers-early` answered it and
      // `undo-tiers` took that back, so the option is **already picked** when
      // this beat arrives. `hand(…, "check")` glides to it and presses nothing
      // when the box is already checked, so what this tick costs the take is the
      // look and the travel, and Submit is the press that files the answer.
      await tick('[data-item="lp-tiers"] input[value="Lit / Bright"]');
      await press('[data-item="lp-tiers"] button[data-kind="decision"]');
      await until("the answered row on lp-tiers", () => green("lp-tiers"));
    });

    await beat("agent-read", async () => {
      // The lamps card was handed over in `agent-read-lamps`; what this read
      // is for is the lock's issue and the tiers decision, both still inside
      // the daemon's grace when it starts. Waiting on the lamps card here would
      // return after one read with nothing handed over, and the two would go
      // over thirty seconds later inside `ask-share`, with no beat on them.
      // Three verdicts in one return, in seq order: the pane's own `blocked` on
      // the incidents card, the lock's issue with the steps the person ticked,
      // and the tiers decision with the option they picked. One read, so all
      // three leave the ledge together on the pane — which is what a single
      // `walk_wait` returning them is, and the only reason the beat waits for
      // the youngest of them to mature before reading at all.
      const filmed = await nextHanded(
        "the blocked card, the lock's issue and the tiers decision",
        ["blocked lp-history", "issue lp-lock", "decision lp-tiers"],
      );
      const [blocked, issue, decision] = filmed;
      vars.blockedSeq = blocked.seq;
      vars.blockedText = jsonInner(blocked.text);
      vars.issueSeq = issue.seq;
      vars.issueText = jsonInner(issue.text);
      vars.issueSteps = jsonList(issue.steps);
      vars.tiersSeq = decision.seq;
      vars.tiersOption = jsonInner(decision.option);
      vars.cursor2 = decision.seq;
      await say("wait-2-result");
      await handOver(filmed);
      await until("the lock and the decision handed to the agent", async () => (await handedOver("lp-lock")) && (await handedOver("lp-tiers")), 45_000);
      landed("the lock and the decision handed over");
      await say("prose-read");
      // Kept: the Undo going red and the card dropping to the Done shelf happen
      // on the agent's clock, after the daemon's 10 s grace window, with no
      // press anywhere near them — so there is nothing for `read` to measure.
      await hold(2000);
    });

    await beat("group-b", async () => {
      // One prose line where a tool call would be. The add's arguments carry the
      // pack's demo key, and the research's §3d trap is putting it on screen; the
      // key is still copied by the person's own hand in the pane, which is the
      // better story anyway.
      await say("prose-group-b");
      await handle.landGroupB();
      await until("lp-landed on the pane", async () => (await count('[data-item="lp-landed"]')) > 0);
      landed("group B on the pane");
      await say("wait-3-call");
      // Kept: group B lands because the launcher landed it, not because anything
      // was pressed.
      await hold(1500);
    });

    await beat("go-history", async () => {
      await go("lp-history", `${SITE}/history`);
      await until("the outline on the incident list", () => outlined("incidents"));
      // Kept, as on the lamps: the outline is the product's animation.
      await hold(1500);
    });

    await beat("pass-note-history", async () => {
      await typeInto('[data-note="lp-history"]', "Newest first, and the lamps match the lines.");
      await press('[data-kind="pass-note"][data-for="lp-history"]');
      await until("the answered row on lp-history", () => green("lp-history"));
    });

    await beat("go-key", async () => { await go("lp-key", `${SITE}/settings`); });

    await beat("copy-key", async () => {
      // This beat carries `read: false`, so the press holds what a Go holds —
      // `settle`, then `land` — and never a read: the Copied note is the button
      // confirming a press the viewer just made, and the full read on its 21
      // words is what the owner was watching when he said the wait after Copy
      // should be the wait after the Go right before it.
      //
      // The label says Copied for two seconds (`COPIED_MS`) and then goes back
      // to being a button. The watch still starts **before** the press rather
      // than after it: it is the only way that cannot miss the label whatever
      // the hold after the press turns out to be.
      const copied = until("the Copy button to read Copied", async () => (await pane('[data-copy="lp-key"]').textContent()) === "Copied");
      await press('[data-copy="lp-key"]');
      await copied;
    });

    await beat("paste-key", async () => {
      await tap("#key");
      // What lands is what the card copied, read back off the clipboard.
      const key = await siteTab.evaluate(() => navigator.clipboard.readText());
      await siteTab.keyboard.insertText(key);
      // The key appearing in the field is a string the viewer watched arrive, so
      // it takes `afterTyping` and not a per-word `read` — the same rule the note
      // box gets, because it is the same event.
      await sleep(p.vary(p.afterTyping, k()));
    });

    await beat("verify-key", async () => {
      await tap("#verify");
      await until("Key accepted.", async () => (await siteTab.locator("#keyresult").textContent())?.trim() === "Key accepted.");
      await tick('[data-step="0"][data-for="lp-key"]');
      await tick('[data-step="1"][data-for="lp-key"]');
      await press('[data-kind="pass"][data-for="lp-key"]');
      await until("the answered row on lp-key", () => green("lp-key"));
    });

    await beat("go-share", async () => { await go("lp-share", `${SITE}/dashboard`); });

    await beat("ask-share", async () => {
      await typeInto('[data-note="lp-share"]', ASK_TEXT);
      await press('[data-kind="ask"][data-for="lp-share"]');
      // Three verdicts in this return as well: the history note and the key's
      // pass have been matured since their own beats, and the ask is the one the
      // wait was actually blocked on. Printing them is printing what the wait
      // returns, not only the part the beat is about.
      const filmed = await nextHanded(
        "the history note, the key's pass and the ask",
        ["pass-note lp-history", "pass lp-key", "ask lp-share"],
      );
      const [note, key, ask] = filmed;
      // The one thing that would read as fake: the terminal quoting words the
      // pane does not have. Refuse the take rather than film the mismatch.
      if (ask.text !== ASK_TEXT) throw new Error(`the pane filed ${JSON.stringify(ask.text)} and the transcript quotes ${JSON.stringify(ASK_TEXT)}`);
      vars.noteSeq = note.seq;
      vars.noteText = jsonInner(note.text);
      vars.keySeq = key.seq;
      vars.keySteps = jsonList(key.steps);
      vars.askSeq = ask.seq;
      vars.askText = jsonInner(ask.text);
      vars.cursor3 = ask.seq;
      await say("wait-3-result");
      await say("prose-answering");
      // The call can print now — its arguments are the ask's seq and the card it
      // supersedes, both known — and it prints *before* the read that really
      // adds the reply, because the launcher answers an ask inside the read that
      // hands it over. The result below waits for the reply to exist.
      await say("add-reply-call");
      await handOver(filmed);
      // The answer lands inside the card that asked, where the waiting line was
      // (render.ts, `replyBlocks`) — there is no card of its own to wait for any
      // more, and nothing to dismiss.
      await until("the agent's answer on the card", async () => (await count('[data-item="lp-share"] .reply')) > 0, 45_000);
      landed("the agent's answer on the card");
      const after = await peek();
      const reply = after.items.find(i => i.id === `lp-ask-${ask.seq}`);
      if (!reply) throw new Error(`lp-ask-${ask.seq} is on the share card and not in the daemon`);
      vars.seqsReply = jsonList([reply.seq]);
      await say("add-reply-result");
      await say("wait-4-call");
      // The reply arrives on the agent's clock: the take-7 to take-9 cuts gave
      // the 25-word reply 3.3 s where the reading rate wants more.
      await readArrived();
      // Kept: the product's — the answer landed on the agent's clock.
      await hold(2000);
    });

    await beat("share", async () => {
      // Copied for two seconds here too, and caught the same way.
      const copied = until("Copy status link to read Copied", async () => (await siteTab.locator("#share").textContent()) === "Copied");
      await tap("#share");
      await copied;
      await press('[data-kind="pass"][data-for="lp-share"]');
      await until("the answered row on lp-share", () => green("lp-share"));
    });

    await beat("dismiss-landed", async () => {
      await press('[data-kind="dismiss"][data-for="lp-landed"]');
      await until("lp-landed answered", async () => (await green("lp-landed")) || (await handedOver("lp-landed")));
    });

    // Every card of the walk. The agent's answer is not one of them: it is a
    // block on lp-share's row, which the row carries onto the shelf with it.
    const everything = ["lp-lamps", "lp-lock", "lp-tiers", "lp-history", "lp-key", "lp-share", "lp-landed"];
    await beat("agent-read-2", async () => {
      // The last two: the pass on the share card, which is what resolved the
      // ask, and the info card's dismiss. Nothing is outstanding after them,
      // which is what the launcher closes the walk on.
      const filmed = await nextHanded(
        "the share card's pass and the info card's dismiss",
        ["pass lp-share", "dismiss lp-landed"],
      );
      vars.sharePassSeq = filmed[0].seq;
      vars.dismissSeq = filmed[1].seq;
      vars.cursor4 = filmed.at(-1).seq;
      await say("wait-4-result");
      await handOver(filmed);
      await until("every card on the Done shelf", async () => (await Promise.all(everything.map(onShelf))).every(Boolean), 90_000);
      landed("every card on the Done shelf");
      await say("prose-done");
      // Kept, as `agent-read`: the shelf fills on the agent's clock.
      await hold(2000);
    });

    await beat("closed", async () => {
      // The close prints where it happens, not a beat early: `walk_close` takes
      // the summary, and the summary is the launcher's own — `Lamppost demo: <n>
      // verdicts.`, counted from the verdicts it was really handed — so it is
      // read back off the daemon rather than written here.
      await handle.stop();
      await handle.finished;
      const closed = await peek();
      if (!closed.walk.closedAt) throw new Error(`${handle.id} is still open after the launcher closed it`);
      vars.summary = jsonInner(closed.walk.summary);
      landed("the walk closed on the daemon");
      await say("close-call");
      await say("close-result");
      await until("the pane's closed line", async () => (await pane("p.empty").count()) > 0 && /closed/i.test((await pane("p.empty").textContent()) ?? ""), 45_000);
      // The terminal's last picture is a prompt with nothing on it: the session
      // is idle and listening, and no words are invented to say so.
      await say("prompt-idle");
      // Kept: the take's last picture. The camera stops after this beat, so this
      // is the out-point the cut gets to work with.
      await hold(2000);
    });

    if (nextBeat !== BEATS.length) throw new Error(`played ${nextBeat} beats of ${BEATS.length}`);

    // The camera stops before the browser does, so the last beat's hold is in
    // the file and nothing is filmed of the tear-down. The pulses stop first:
    // there is nothing left to wake either hidden surface for.
    const pulsed = Object.fromEntries(await Promise.all(Object.entries(pulses).map(async ([k, pu]) => [k, await pu.stop()])));
    pulses = {};
    await Promise.all(NAMES.map(k => caps[k].stop()));
    // `pulse` stays the pane's, which is the one every earlier take's file
    // carries and the one a cut reads; the terminal's is beside it under its own
    // name rather than folded into it.
    timeline.pulse = pulsed.pane;
    timeline.pulseTerminal = pulsed.terminal;
    for (const [k, s] of Object.entries(pulsed))
      log(`${k} pulse: ${s.beats} forced redraws every ${s.everyMs} ms, ${s.msPerBeat} ms each${s.failed ? `, ${s.failed} failed` : ""}.`);
    await ctx.close();

    for (const name of NAMES) {
      timeline.surfaces[name] = {
        ...(await encode(caps[name], path.join(out, `${name}.mp4`), { log })),
        file: `${name}.mp4`,
        t0: Math.round(firsts[name] - t0),
      };
    }
    /**
     * The terminal, as the cut needs to know it: which look it was shot in, the
     * emulator and renderer behind it, the grid the page measured for itself,
     * and the viewport the flag asked for — which the cut draws 1:1, so `crop`
     * is the whole surface and is here only so a cut that reads it reads
     * something true.
     */
    timeline.terminal = {
      theme: theme.name,
      scheme: terminalTheme,
      xterm: xtermVersion(),
      renderer: termSize.canvas ? "canvas" : "dom",
      cols: termSize.cols,
      rows: termSize.rows,
      font: { ...theme.font },
      wrap: theme.wrap,
      viewport: { ...TERM },
      crop: { x: 0, y: 0, w: TERM.width, h: TERM.height },
      /** Blocks printed, which is also this surface's own health floor. */
      printed,
    };
    // Every beat's frame number on each surface, so the cut says
    // `<Sequence from={ev.frame.site}>` and never reasons about milliseconds or
    // about two files that did not start at the same instant.
    for (const ev of timeline.events)
      ev.frame = Object.fromEntries(Object.entries(timeline.surfaces).map(([k, s]) => [k, frameAt(ev.t, s.t0)]));

    const bad = cursorIssues(timeline.cursor);
    if (bad.length) throw new Error(`the cursor track does not hold together:\n  ${bad.join("\n  ")}`);
    timeline.health = health(timeline.surfaces, undefined, { terminal: printed });

    // With the JPEGs kept, their stamps are kept too: when the compositor
    // swapped each frame (`t`, what the muxer places it by) and when it reached
    // this process (`at`). A beat's `landed` moment against these two is how a
    // question like "did the diagnostic reach the footage" is answered without
    // re-deriving anything from the video.
    if (opts.keepFrames)
      await fs.writeFile(path.join(out, "frames", "stamps.json"), `${JSON.stringify({ t0, ...Object.fromEntries(NAMES.map(k => [k, caps[k].frames])) })}\n`);
    else await fs.rm(path.join(out, "frames"), { recursive: true, force: true });
    log(`\nTake in ${out}: ${NAMES.map(k => `${k}.mp4`).join(", ")}, timeline.json, ${timeline.cursor.length} cursor events, ${BEATS.length * NAMES.length} stills, scheme ${scheme}, terminal ${terminalTheme} at ${TERM.width}x${TERM.height}, pointer ${overlay ? "in the footage" : "for the cut to draw"}.`);
    return { out, timeline };
  } finally {
    // The timeline is written whatever happened: a take that fell over at beat
    // 19 is still worth looking at, and the events say where it got to.
    if (timeline.startedAt) await fs.writeFile(path.join(out, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`).catch(() => {});
    for (const pu of Object.values(pulses)) { try { await pu.stop(); } catch { /* already stopped */ } }
    try { await handle?.stop(); } catch { /* already closed */ }
    await ctx.close().catch(() => {});
    await agentPage.stop();
    await site.stop();
    daemon.kill("SIGTERM");
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { timeline } = await record(parseArgs(process.argv.slice(2)));
  // A surface that stopped moving does not fail on its own: the muxer holds the
  // last frame into every empty slot, so a frozen pane is a full-length frozen
  // video rather than an error. It is counted instead, and the count is the
  // last word on whether the take is worth cutting.
  const { ok, frozen, floor } = timeline.health;
  for (const [name, s] of Object.entries(timeline.surfaces))
    console.log(`${name}: ${s.distinct} distinct frames of ${s.received} received, ${s.frames} written at ${s.fps} fps.`);
  if (!ok) {
    console.error(`\nThis take is not good: ${frozen.join("; ")}, and the floor is ${floor}.`);
    process.exit(1);
  }
  // The terminal changes only when a block prints, so it is honestly the
  // quietest of the three — a few hundred distinct frames against the pane's
  // few thousand. The floor is set low enough for that on purpose: what it is
  // there to catch is a surface that stopped compositing, which produces
  // single figures, not one that is simply still between actions.
  console.log(`All three surfaces moved: the floor is ${floor} distinct frames and none is near it.`);
  process.exit(0);
}

export { record };
