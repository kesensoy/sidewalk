/**
 * The agent terminal's look — every colour, every glyph, every prefix, every
 * label, in one file.
 *
 * **Why it is one file.** The owner, on the mock-session clip: *"a generic agent
 * terminal now, the look in one theme file"* — so that if permission to depict
 * a particular agent's interface ever arrives, the clip is re-themed rather
 * than re-shot. The argument: Anthropic's Consumer Terms §12 grant nobody the
 * use of their name, logos or trademarks "in connection with products or
 * services other than the Services", there is no public brand page to cite,
 * and imitating an interface is the part that carries the risk. So **the
 * default theme names nobody**:
 * there is no product name, no wordmark, no version-and-model header, and the
 * glyphs are plain ones rather than the commonly-seen forms the research could
 * not verify (§2d: neither U+23FA nor U+23BF appears in the installed binary,
 * and no public doc publishes them).
 *
 * **Two themes, and the take picks one.** `--terminal-theme dark|light`, dark
 * by default — including in the light take, because a terminal is a dark
 * surface and the pane beside it is the subject. Only the seven colours and
 * the name differ between them; every glyph, prefix, label, measurement and
 * the `chrome` slot are shared, which is what keeps "the look is one file"
 * true with two of them in it.
 *
 * What a third theme would change: `name`, the seven colours, `font`,
 * `glyphs`, `prefixes`, `labels`, and `chrome` — and nothing else in the repo.
 * What it must **not** change is the frame, which is the camera's, not taste's.
 *
 * Verified glyphs only. `❯` and the `✽`/`✦`/`✶` spinner set are present in the
 * installed binary and so are safe as a generic terminal's furniture; `●`
 * (U+25CF) and `↳` (U+21B3) are our own plain choices for the tool bullet and
 * the result branch, picked over the commonly-seen `⏺`/`⎿` precisely because
 * those two are the unverified ones.
 */

/**
 * The size the recorder films the terminal at, unless `--terminal-size` says
 * otherwise. The cut draws this surface **1:1** — no resampling — so the number
 * is the cut's, and the only thing in here that follows from it is the cell
 * grid the page measures for itself.
 *
 * 1212x440 is the owner's, 2026-10-05: *"Film the terminal at 1212×440 (about 118
 * columns × 20 rows at 17 px / 22 px lines); the cut draws it 1:1, so no
 * resampling."* Both halves are even, which `yuv420p` needs.
 */
export const DEFAULT_TERMINAL = { width: 1212, height: 440 };

/**
 * The camera's rectangle, which is not part of the look.
 *
 * It used to be a constant — a 1440x900 page with the terminal laid out inside
 * the `{x: 144, y: 0, w: 1152, h: 720}` slice the cut's `SITE_REGION` cropped
 * out of Lamppost — because the terminal was filmed **in the site slot** of its
 * own take. It is a surface of its own now (`terminal.mp4`, beside `site.mp4`
 * and `pane.mp4`), filmed at exactly `--terminal-size`, so the page *is* the
 * crop: `crop` covers the whole page and is kept only so a cut that reads it
 * still reads something true.
 *
 * A theme may not set either. The page derives them from the viewport the
 * recorder gave it, so the only place the number lives is the flag.
 */
export const frameFor = (size = DEFAULT_TERMINAL) => ({
  page: { width: size.width, height: size.height },
  crop: { x: 0, y: 0, w: size.width, h: size.height },
});

/** The default frame, for anything that wants one without a flag in hand. */
export const FRAME = frameFor();

/**
 * Everything both themes share: the measurements, the furniture, the labels.
 * A colour name here is a key into the theme, which is why `tones` names them
 * rather than carrying hexes of its own.
 */
const SHARED = {
  /**
   * 17 px. The owner's range for this surface was 16–17 and the cut draws the
   * surface 1:1, so 17 px on the page is 17 px in the frame. The research
   * wanted 19; the pane is the subject and the terminal is context, so it sits
   * under the pane rather than over it.
   *
   * `lineHeight` is xterm's multiple of the font size, not CSS: 1.2 is loose
   * enough that a wrapped JSON line does not read as one block of noise.
   */
  font: {
    family: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    size: 17,
    lineHeight: 1.2,
  },
  /**
   * The ring of ground around the glyphs, so none of them sits on the cut's
   * edge. It was 28 inside a 720 px-tall crop; at 440 px tall that ring costs
   * a row and a half of a twenty-row terminal, so it is 16 — still more than a
   * cell's width on every side, and the measured grid is in `timeline.json`
   * either way.
   */
  padding: 16,
  /**
   * The width the transcript's JSON is wrapped to, which is **not** the
   * terminal's width.
   *
   * At 1212x440 the terminal measures around 114 columns, and the page writes
   * what it really measured into `timeline.json`. The copy wraps to 100 so
   * that a theme with a slightly wider cell — or a font that falls back
   * somewhere else, or a `--terminal-size` a little narrower than the default
   * — still does not soft-wrap a JSON value at an arbitrary place in the
   * middle of it, which is the one formatting accident nobody would notice
   * until they watched the footage. A unit test holds every rendered line to
   * this.
   */
  wrap: 100,

  /**
   * The furniture. `prompt` is the person's line, `tool` the call, `result` its
   * return, `resultCont` the alignment under a result that wrapped, `spinner`
   * the line that stands while a wait is open.
   */
  prefixes: {
    prompt: "❯ ",
    tool: "● ",
    arg: "",
    result: "  → ",
    resultCont: "    ",
    prose: "",
    spinner: "✶ ",
    blank: "",
  },
  /** tone -> what it is drawn in. `bold` is the only weight a terminal has. */
  tones: {
    prompt: { colour: "ink", bold: false },
    tool: { colour: "accent", bold: true },
    arg: { colour: "muted", bold: false },
    result: { colour: "muted", bold: false },
    resultCont: { colour: "muted", bold: false },
    prose: { colour: "ink", bold: false },
    spinner: { colour: "waiting", bold: false },
    blank: { colour: "ink", bold: false },
  },
  /**
   * The only words the theme owns. Everything else a viewer reads is in
   * `demo/agent/transcript.json`, which is the copy.
   */
  labels: { spinner: "waiting for the person…" },
  /**
   * Where a themed header would go — the line a real session draws above its
   * prompt with a version, a model and a working directory. The default theme
   * draws none: a version and a model name are a claim about somebody's
   * product, and this surface does not make one. A second theme sets it to an
   * array of `{ tone, text }` lines and the page prints them before the prompt.
   */
  chrome: null,
};

/**
 * The two palettes, and nothing invented in either.
 *
 * **Dark** is the Kerb palette's dark half, which is where a terminal lives:
 * the page and ink pair is `demo/site/styles.css`'s dark mode (`--page` /
 * `--ink`), the muted and accent are its `--muted` / `--accent`, and the green
 * and yellow are `packages/extension/src/panel.css`'s dark `--pass` and
 * `--waiting`. **Light** is the same seven slots read off the light half of
 * exactly those two files. Nothing here is a tint of anything else.
 */
export const THEMES = {
  dark: {
    ...SHARED,
    /** For `timeline.json`, so a take says which look it was shot in. */
    name: "plain agent terminal",
    ground: "#1e1f1c",
    ink: "#e4e3de",
    muted: "#9b9a92",
    edge: "#6b6a64",
    accent: "#8aa9f2",
    pass: "#4fc97c",
    waiting: "#ffd633",
  },
  light: {
    ...SHARED,
    name: "plain agent terminal, light",
    ground: "#f4f3ef",
    ink: "#1e1f1c",
    muted: "#6b6a64",
    edge: "#9d9e97",
    accent: "#1f4fbf",
    pass: "#17784a",
    waiting: "#d4a600",
  },
};

/** The names `--terminal-theme` takes. */
export const THEME_NAMES = Object.keys(THEMES);

/** One theme by name. Anything but a name it has is an error, not a fallback. */
export function themeFor(name = "dark") {
  const t = THEMES[name];
  if (!t) throw new Error(`no terminal theme ${JSON.stringify(name)} — it is one of ${THEME_NAMES.join(", ")}`);
  return t;
}

/** The default: a terminal is dark, in the light take as much as in the dark one. */
export const THEME = THEMES.dark;

/** The tone names a transcript line may carry. */
export const TONES = Object.keys(SHARED.tones);
