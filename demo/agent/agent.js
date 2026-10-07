/**
 * The terminal on camera: a real `@xterm/xterm` emulator in a Chromium tab,
 * written to by the recorder on its own beats.
 *
 * There is **no clock in here**. Everything appears because
 * `demo/record-agent.mjs` said so, through `page.evaluate` into the handful of
 * functions on `window.agent` — which is the control channel the research's
 * §4b left open (a socket, SSE, or evaluate; evaluate is the one with no
 * connection to lose, no ack protocol to write, and a return value that *is*
 * the ack). The two things that could have had clocks of their own are
 * deliberately still:
 *
 * - **the cursor does not blink** (`cursorBlink: false`), and
 * - **the spinner does not spin**: it is one line that stands while a wait is
 *   open.
 *
 * Both for the same reason the hand never calls `Math.random` and the pace's
 * jitter is seeded — two takes of the same beats have to come out frame for
 * frame the same, or the cut has to be re-timed every time the footage is
 * re-shot. A blinking cursor or a cycling glyph would be a per-take animation
 * on this surface and nothing in the pipeline could line it up. (It is also
 * what the owner's brief asked for: the spinner line, *plain*.)
 *
 * **The renderer is xterm's DOM renderer** — the default, with no addon. The
 * recorder forces this tab to redraw every 25 ms with `Page.captureScreenshot`
 * (`keepPainting` in `demo/capture.mjs`), because a hidden tab stops
 * compositing between the recorder's actions; a forced redraw draws *the page
 * as it is*, which for the DOM renderer is a tree of spans and is exactly what
 * the screencast then gets. `@xterm/addon-webgl` would put the glyphs in a GPU
 * canvas instead, which is the one thing in that path nobody here has
 * measured — so it is not installed, and the surface is one dependency rather
 * than two. §2b of the research is the argument.
 */
import { Terminal } from "./xterm.mjs";
import { frameFor, themeFor } from "./theme.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- the page */

/**
 * The look is a query parameter and the size is the viewport.
 *
 * `--terminal-theme` arrives as `?theme=dark|light`, and `--terminal-size` as
 * the viewport the recorder set before the page was navigated — so the frame
 * **follows the flag** instead of being a constant in the theme file, and this
 * page is the only thing that knows how many cells fit in it.
 */
const THEME = themeFor(new URLSearchParams(location.search).get("theme") ?? "dark");
const FRAME = frameFor({ width: window.innerWidth, height: window.innerHeight });

const { page, crop } = FRAME;
document.documentElement.style.background = THEME.ground;
Object.assign(document.body.style, {
  background: THEME.ground,
  width: `${page.width}px`,
  height: `${page.height}px`,
});
const box = document.getElementById("box");
Object.assign(box.style, {
  left: `${crop.x}px`,
  top: `${crop.y}px`,
  width: `${crop.w}px`,
  height: `${crop.h}px`,
  padding: `${THEME.padding}px`,
  background: THEME.ground,
});

/* ------------------------------------------------------------ the terminal */

const host = document.getElementById("term");
const term = new Terminal({
  fontFamily: THEME.font.family,
  fontSize: THEME.font.size,
  lineHeight: THEME.font.lineHeight,
  cursorBlink: false,
  cursorStyle: "block",
  cursorInactiveStyle: "none",
  disableStdin: true,
  scrollback: 2000,
  // The pane is the subject; nothing here is selected on camera, but a
  // selection colour that is not set draws the browser's blue.
  theme: {
    background: THEME.ground,
    foreground: THEME.ink,
    cursor: THEME.ink,
    cursorAccent: THEME.ground,
    selectionBackground: THEME.edge,
  },
});
term.open(host);

/**
 * Size the terminal to the box, by measuring one cell rather than guessing.
 *
 * `@xterm/addon-fit` would do this; it is a second dependency for one
 * division. xterm lays `.xterm-screen` out at exactly `cols x rows` cells, so
 * opening at whatever the default is and dividing gives the cell, and one
 * `resize` then fills the box. The floor on both is so a bad measurement is a
 * small terminal and not a zero-column one.
 */
const inner = { w: crop.w - 2 * THEME.padding, h: crop.h - 2 * THEME.padding };
function fit() {
  const screen = host.querySelector(".xterm-screen");
  const r = screen.getBoundingClientRect();
  const cell = { w: r.width / term.cols, h: r.height / term.rows };
  const cols = Math.max(40, Math.floor(inner.w / cell.w));
  const rows = Math.max(10, Math.floor(inner.h / cell.h));
  term.resize(cols, rows);
  return { cols, rows, cell, px: { w: cols * cell.w, h: rows * cell.h } };
}
const size = fit();

/* ------------------------------------------------------------------ colour */

const rgb = hex => {
  const n = Number.parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
/** The escape that sets a tone: reset, then weight, then a truecolor fg. */
function sgr(tone) {
  const t = THEME.tones[tone] ?? THEME.tones.prose;
  const [r, g, b] = rgb(THEME[t.colour] ?? THEME.ink);
  return `[0m${t.bold ? "[1m" : ""}[38;2;${r};${g};${b}m`;
}

const write = data => new Promise(r => term.write(data, r));

/* ------------------------------------------------------------- the channel */

/**
 * Whether the last thing written left a line unterminated.
 *
 * The spinner and the resting prompt are both *open* lines: the cursor sits on
 * them, and the next thing printed erases the line and takes its place — which
 * is what makes the wait's result appear *where the spinner was*, the way a
 * real wait returning does, rather than under it.
 */
let open = false;
/** How many blocks have been printed, which is the recorder's ack. */
let printed = 0;

async function print(lines, opts = {}) {
  let data = open ? "\r[2K" : "";
  open = false;
  lines.forEach((l, i) => {
    const last = i === lines.length - 1;
    data += sgr(l.tone) + l.text + "[0m";
    if (!(last && opts.open)) data += "\r\n";
  });
  if (opts.open) open = true;
  await write(data);
  printed++;
  return printed;
}

/**
 * The person typing, a character at a time at the pace rule's own 45 ms.
 *
 * Played against **absolute deadlines** inside the page, for the same reason
 * the hand plays its samples that way: nothing waits on a round trip, so the
 * string takes the time it is supposed to take whatever the recorder's CDP
 * latency is doing. The prompt glyph goes down first if nothing has put one
 * there.
 */
async function type(text, msPerChar) {
  let data = open ? "" : sgr("prompt") + THEME.prefixes.prompt;
  if (data) await write(data);
  open = true;
  const started = performance.now();
  for (let i = 0; i < text.length; i++) {
    const wait = started + (i + 1) * msPerChar - performance.now();
    if (wait > 0) await sleep(wait);
    await write(text[i]);
  }
  await write("[0m\r\n");
  open = false;
  printed++;
  return printed;
}

/**
 * What a viewer can read on this surface, in reading order.
 *
 * The visible viewport only, like the pane's `innerText`: a row that has
 * scrolled off is not something the viewer is being asked to read, and the
 * recorder's read holds are measured off this exactly the way the pane's are
 * (`freshWords` in `demo/pace.mjs`).
 */
function text() {
  const buf = term.buffer.active;
  const out = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    out.push(line ? line.translateToString(true) : "");
  }
  return out.join("\n");
}

/** A themed header, if a theme has one. The default theme has none. */
if (Array.isArray(THEME.chrome) && THEME.chrome.length) await print(THEME.chrome);
// The resting prompt, so the take's first frame is a terminal waiting for a
// person rather than an empty rectangle.
await write(sgr("prompt") + THEME.prefixes.prompt);
open = true;

window.agent = {
  ready: true,
  theme: THEME.name,
  /** What the recorder asked for, measured back: `timeline.terminal.viewport`. */
  viewport: { width: page.width, height: page.height },
  size,
  /** True if any glyph is being drawn into a canvas rather than the DOM. */
  canvas: Boolean(host.querySelector("canvas:not(.xterm-cursor-layer)")),
  print,
  type,
  text,
  get printed() { return printed; },
};
