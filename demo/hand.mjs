/**
 * The hand.
 *
 * The owner, on the take before this one: *"the mouse movements do not really look
 * smooth or human like"*. They were not: `page.mouse.move(x, y, { steps: 20 })`
 * is a **straight line at a constant speed**, fired as fast as CDP will carry
 * it, from one target's centre to the next target's centre. Three things are
 * wrong with that at once — the line, the constant speed, and the centre.
 *
 * This module fixes all three, and it is pure, so it has unit tests and no
 * browser:
 *
 * 1. **The line.** The geometry comes from `ghost-cursor`'s `path()` — a cubic
 *    Bézier through two anchors offset perpendicular to the line of travel,
 *    which is what the anti-bot people worked out a human arm does. We use the
 *    library for the curve and nothing else (see `withSeed` below for the one
 *    thing we have to do to it, and `demo/README.md` § The cursor for why the
 *    Playwright wrapper is not the dependency).
 * 2. **The speed.** The move's duration is Fitts's law — it grows with the
 *    distance and shrinks with the size of the thing being hit — and the
 *    position along the path is eased, so the pointer accelerates away, coasts,
 *    and decelerates in. Then it overshoots a few pixels and flicks back, which
 *    is the other half of what a real hand does on a long throw.
 * 3. **The centre.** Nobody hits the middle of a button twice. Every target
 *    gets a small offset from its centre, fixed for that target for all time
 *    because it is derived from a **seeded hash of the target's id** — never
 *    `Math.random()`, because two takes of the same beat have to come out the
 *    same frame for frame or the cut has to be re-timed every time the footage
 *    is re-shot.
 *
 * The path is handed back **sampled at the take's own 60 Hz**, each sample with
 * its own millisecond offset, which is both what the recorder feeds
 * `page.mouse.move` and what goes into `timeline.json`'s cursor track. So the
 * track is the path, not its endpoints, and the cut can draw the pointer
 * through the same curve the page actually saw.
 */
import { path as ghostPath } from "ghost-cursor";

/** The take's frame interval. One sample a frame is all the cut can draw. */
export const SAMPLE_MS = 1000 / 60;

/**
 * The furthest two consecutive samples on one surface may be apart, in CSS
 * pixels. `cursorIssues` in `demo/capture.mjs` holds the track to it: a jump
 * bigger than this is a pointer that teleports, which is the thing the whole
 * track exists to prevent. The path generator keeps to it by refusing to make
 * a move shorter than the distance can be crossed in.
 */
export const MAX_STEP_PX = 200;

/** How much of `MAX_STEP_PX` a sample is allowed to use. Headroom is cheap. */
const STEP_BUDGET = 0.6;

/** Fitts's law, in milliseconds: `a + b · log2(distance / width + 1)`. */
const FITTS_A = 120;
const FITTS_B = 110;

/**
 * How far off the straight line the arc is allowed to bow, as a share of the
 * distance, and in pixels whatever happens.
 *
 * This is `spreadOverride`, and it has to be passed: left to itself
 * `ghost-cursor` uses `clamp(distance, 2, 200)`, and the anchor is thrown a
 * random fraction of *all* of that off to one side — so a 400 px move can bow
 * 200 px. On the 400 px-wide pane that puts the pointer off the surface
 * altogether, and on the site it reads as a cartoon. A hand bows a few percent.
 */
const SPREAD_FRAC = 0.12;
const SPREAD_PX = [6, 60];
/**
 * How far off the straight line the arc has to bow before we accept it.
 *
 * `ghost-cursor` throws its anchors a **random fraction** of the spread it is
 * given, so an unlucky seed draws very nearly a straight line — which is the
 * one thing this module exists to stop. The curve is measured and the spread
 * widened until it bows at least this much. See `bowed`.
 */
const MIN_BOW_FRAC = 0.025;
const MIN_BOW_PX = 4;
/** How much the spread may be widened looking for a bow, and in how many tries. */
const WIDEN = [1, 2, 3.5];

/** Below this much travel a hand does not overshoot — it just arrives. */
const OVERSHOOT_MIN_PX = 160;
/** How far past the target a long throw goes, before the correcting flick. */
const OVERSHOOT_PX = [5, 16];
/** The share of the move the main arc gets; the flick back gets the rest. */
const ARC_SHARE = 0.78;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/* ------------------------------------------------------------ seeded chance */

/** FNV-1a over the key's code units. Same key, same number, every run. */
const hash32 = key => {
  let h = 0x811c9dc5;
  const s = String(key);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
};

/**
 * A `Math.random`-shaped function that is the same sequence for the same key.
 * mulberry32, which is four lines and passes gjrand — plenty for deciding how
 * far off a button's centre to land.
 */
export function seeded(key) {
  let a = hash32(key) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `ghost-cursor`'s `path()` calls `Math.random()` four times — twice to place
 * each Bézier anchor along the line and twice to throw it off to one side — and
 * there is no seed option. So the global is swapped for the run of the call.
 *
 * That is safe, and only because of one fact: `path()` is **synchronous** —
 * `bezierCurve` then `getLUT` then a `map`, no awaits anywhere — so on one
 * thread nothing else can observe the swap. It is restored in a `finally`.
 */
function withSeed(rng, fn) {
  const real = Math.random;
  Math.random = rng;
  try { return fn(); } finally { Math.random = real; }
}

/** How far the furthest point of a polyline is off the line from `a` to `b`. */
function bow(a, b, points) {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  let most = 0;
  for (const p of points) most = Math.max(most, Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len);
  return most;
}

/**
 * An arc from `a` to `b` that actually arcs.
 *
 * The spread is widened and the curve re-drawn until it bows at least `least`
 * px off the straight line, or the tries run out, and the bowiest of them wins.
 * `r` is the seeded generator, which advances with each try — so this is still
 * the same arc on every run of the same take, however many tries it took.
 */
function bowed(r, a, b, spread, least) {
  let best = null;
  for (const widen of WIDEN) {
    const points = withSeed(r, () => ghostPath(a, b, { spreadOverride: spread * widen }));
    const off = bow(a, b, points);
    if (!best || off > best.off) best = { points, off };
    if (off >= least) break;
  }
  return best.points;
}

/* ------------------------------------------------------------- where to aim */

/**
 * Where on a target to land: its centre, plus a small offset that is this
 * target's own, for ever.
 *
 * `key` is what makes it repeatable — pass the thing that names the target
 * (the card's item id, the selector that found it), never a counter and never
 * the clock. Returns the point both in the surface's own CSS pixels (`x`, `y`,
 * what the pointer is moved to and what the track records) and relative to the
 * box's top-left (`rel`, which is what Playwright's `position` option wants, so
 * the press lands exactly where the hand landed instead of snapping back to the
 * centre the way a bare `locator.click()` does).
 */
export function aim(box, key, { maxPx = 14, frac = 0.5 } = {}) {
  const r = seeded(`aim:${key}`);
  const off = (extent, u) => clamp((u * 2 - 1) * frac * (extent / 2), -maxPx, maxPx);
  const inside = (v, extent) => clamp(Math.round(v), 1, Math.max(1, Math.round(extent) - 1));
  const rel = {
    x: inside(box.width / 2 + off(box.width, r()), box.width),
    y: inside(box.height / 2 + off(box.height, r()), box.height),
  };
  return { rel, x: Math.round(box.x + rel.x), y: Math.round(box.y + rel.y) };
}

/** The width Fitts's law should use for a box: the dimension that is hardest. */
export const aimWidth = box => clamp(Math.min(box.width, box.height), 8, 160);

/** How long a hand takes to cross `distance` px onto a target `width` px wide. */
export const fittsMs = (distance, width) =>
  FITTS_A + FITTS_B * Math.log2(distance / clamp(width, 8, 400) + 1);

/* ------------------------------------------------------------------ easings */

/** Smootherstep: in and out, and with no kink in the acceleration either. */
const smoother = u => u * u * u * (u * (u * 6 - 15) + 10);
/** Its steepest slope, for working out how fast a sample can be moving. */
const SMOOTHER_PEAK = 1.9;
/** The correcting flick: all of its speed at the start, settling in. */
const outCubic = u => 1 - (1 - u) ** 3;
const OUT_CUBIC_PEAK = 3;

/* -------------------------------------------------------------- the polyline */

/** Cumulative arc length along a list of points, and the total. */
function arc(points) {
  const at = [0];
  for (let i = 1; i < points.length; i++) at.push(at[i - 1] + dist(points[i - 1], points[i]));
  return { at, total: at.at(-1) };
}

/** The point `s` pixels along a polyline, straight-line between samples. */
function along(points, at, s) {
  if (s <= 0) return points[0];
  const total = at.at(-1);
  if (s >= total) return points.at(-1);
  let hi = 1;
  while (hi < at.length - 1 && at[hi] < s) hi++;
  const lo = hi - 1, span = at[hi] - at[lo];
  const u = span > 0 ? (s - at[lo]) / span : 0;
  return { x: points[lo].x + (points[hi].x - points[lo].x) * u, y: points[lo].y + (points[hi].y - points[lo].y) * u };
}

/* --------------------------------------------------------------- the path */

/**
 * One move, as the samples the pointer passes through.
 *
 * `from` and `to` are the surface's own CSS pixels; `key` names the target and
 * is the whole of the randomness; `speed` is `--speed`, so a rehearsal's hand
 * is quick like every other pause; `width` is the target's size, which is what
 * makes Fitts's law Fitts's law rather than a constant.
 *
 * Returns `{ ms, points }`, `points` being `{ t, x, y }` at whole pixels and
 * whole milliseconds, `t` from 0, the first point exactly `from` and the last
 * exactly `to`. Consecutive points are never more than `MAX_STEP_PX` apart:
 * the duration has a floor derived from the arc length for exactly that
 * reason, so a `--speed 8` rehearsal cannot make the pointer teleport.
 *
 * `bounds` is the surface's size, and the arc is kept inside it — a bow that
 * leaves the viewport is a pointer that vanishes mid-move on camera.
 */
export function handPath({ from, to, key, speed = 1, width = 24, bounds = null }) {
  const start = { x: Math.round(from.x), y: Math.round(from.y) };
  const end = { x: Math.round(to.x), y: Math.round(to.y) };
  const travel = dist(start, end);
  // Already there. One sample, no time: the recorder marks it and moves on.
  if (travel < 1) return { ms: 0, points: [{ t: 0, x: end.x, y: end.y }] };

  const r = seeded(`path:${key}`);
  const spread = clamp(travel * SPREAD_FRAC, SPREAD_PX[0], SPREAD_PX[1]);
  const least = Math.max(MIN_BOW_PX, travel * MIN_BOW_FRAC);
  const segs = [];
  if (travel >= OVERSHOOT_MIN_PX) {
    // Past the target by a few pixels, a little off the line of travel, then
    // back. The flick is a near-straight Bézier, so its spread is small and it
    // is not held to a bow.
    const mag = OVERSHOOT_PX[0] + r() * (OVERSHOOT_PX[1] - OVERSHOOT_PX[0]);
    const ang = Math.atan2(end.y - start.y, end.x - start.x) + (r() * 2 - 1) * 0.5;
    const over = { x: Math.max(0, end.x + Math.cos(ang) * mag), y: Math.max(0, end.y + Math.sin(ang) * mag) };
    segs.push({ points: bowed(r, start, over, spread, least), ease: smoother, peak: SMOOTHER_PEAK, share: ARC_SHARE });
    segs.push({ points: withSeed(r, () => ghostPath(over, end, { spreadOverride: 6 })), ease: outCubic, peak: OUT_CUBIC_PEAK, share: 1 - ARC_SHARE });
  } else {
    segs.push({ points: bowed(r, start, end, spread, least), ease: smoother, peak: SMOOTHER_PEAK, share: 1 });
  }
  // The library clamps to positive and ends on the point it was given, but it
  // is the last word on nothing: both ends are pinned here so a caller can
  // trust that the track starts where the pointer was and ends where it clicks.
  const fit = p => (bounds
    ? { x: clamp(p.x, 0, bounds.width - 1), y: clamp(p.y, 0, bounds.height - 1) }
    : { x: Math.max(0, p.x), y: Math.max(0, p.y) });
  for (const s of segs) s.points = s.points.map(fit);
  segs[0].points[0] = start;
  segs.at(-1).points[segs.at(-1).points.length - 1] = end;
  for (const s of segs) Object.assign(s, arc(s.points));

  // Fitts's law for the feel, then a floor for the rule: a sample may not be
  // more than `STEP_BUDGET` of `MAX_STEP_PX` from the one before, and a
  // segment's fastest sample moves `peak × (length / duration)` per frame.
  let ms = fittsMs(travel, width) / (Number(speed) > 0 ? Number(speed) : 1);
  for (const s of segs) ms = Math.max(ms, (s.total * s.peak * SAMPLE_MS) / (MAX_STEP_PX * STEP_BUDGET) / s.share);
  ms = Math.max(ms, SAMPLE_MS);

  const points = [];
  let t0 = 0;
  for (const s of segs) {
    const span = ms * s.share;
    const steps = Math.max(1, Math.round(span / SAMPLE_MS));
    for (let k = 0; k <= steps; k++) {
      // The first sample of a later segment is the last of the one before it.
      if (k === 0 && points.length) continue;
      const p = along(s.points, s.at, s.ease(k / steps) * s.total);
      const q = { t: Math.round(t0 + span * (k / steps)), x: Math.round(p.x), y: Math.round(p.y) };
      // A sample that is the pixel the pointer is already on is a CDP round
      // trip and a track row for nothing; the last one is kept regardless, so
      // the move always ends on the point it was aimed at.
      const last = points.at(-1);
      if (last && last.x === q.x && last.y === q.y) continue;
      points.push(q);
    }
    t0 += span;
  }
  const last = points.at(-1);
  if (!last || last.x !== end.x || last.y !== end.y) points.push({ t: Math.round(ms), x: end.x, y: end.y });
  else last.t = Math.round(ms);
  return { ms: Math.round(ms), points };
}
