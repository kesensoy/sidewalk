/**
 * What the pane remembers about how it looks, per viewer. Kept small on
 * purpose: one rung ladder for text size, stepped by the two buttons under
 * the header's gear, persisted in `chrome.storage.local` under `walkd:ui`.
 *
 * The rungs are a ladder rather than a free number so the two buttons always
 * land somewhere legible, and so a saved value can never be a size nobody can
 * read their way out of.
 */
export const SCALES = [80, 90, 100, 110, 125, 150] as const;
export const DEFAULT_SCALE = 100;
export const UI_KEY = "walkd:ui";

/**
 * How much of a walk gets photographed. The owner: "should we make post-answer
 * screenshots a disable-able option in settings? … or maybe a 3rd option of
 * 'on issues only'." Every verdict is the default and stays it — the picture
 * is most of what makes an issue readable to an agent — but the person walking
 * is the one whose screen it is.
 *
 * The worker reads this at submit time, so turning it down takes effect on the
 * next verdict with no reload. `blocked` is the pane's own verdict about a
 * page that is not ready, not an answer, and is not governed by this.
 */
export const SHOTS = ["always", "issues", "never"] as const;
export type Shots = (typeof SHOTS)[number];
export const DEFAULT_SHOTS: Shots = "always";

export type Ui = { scale: number; shots: Shots };

/**
 * What a stored `walkd:ui` says about screenshots. A preference saved before
 * this setting existed has no `shots` at all, and a hand-edited one can say
 * anything; both read as the default rather than as "off", because silently
 * not taking a picture is the failure this setting exists to explain.
 */
export function shotsOf(saved: unknown): Shots {
  const s = (saved as Partial<Ui> | undefined)?.shots;
  return (SHOTS as readonly string[]).includes(s as string) ? (s as Shots) : DEFAULT_SHOTS;
}

/** One rung up (`1`) or down (`-1`), stopping at the ends. */
export function nextScale(current: number, dir: 1 | -1): number {
  const rungs: readonly number[] = SCALES;
  const i = rungs.indexOf(current);
  if (i < 0) {
    // A value that is not a rung — hand-edited, or saved by a build whose
    // ladder was different. Step off the nearest one instead of refusing.
    const near = rungs.reduce((a, b) => (Math.abs(b - current) < Math.abs(a - current) ? b : a));
    return nextScale(near, dir);
  }
  return rungs[Math.min(rungs.length - 1, Math.max(0, i + dir))];
}

/**
 * The scale is a multiplier on `:root`, not a font size: the stylesheet sizes
 * everything in `em` off one `calc()` on the body, so one variable moves the
 * whole pane and nothing has to be re-rendered.
 */
export function applyScale(doc: Document, scale: number): void {
  doc.documentElement.style.setProperty("--scale", String(scale / 100));
}
