/**
 * The viewer's pace.
 *
 * The owner, on the Secrets short: *"there's like 7 clicks/scene changes in 7
 * seconds… are you sure it isn't too fast? Typing words fast is fine, the mouse
 * movements look ok, but then the clicks are rapid and click-to-click is too
 * rapid."* He was right to three decimal places: the take on disk runs eight
 * presses in 9.956 s of footage, median gap 1174 ms, minimum 942 ms — and the
 * reason is that `press()` was `look` → glide → click → **nothing**. There was
 * no post-press hold at all unless a beat hand-wrote one, and half of them
 * didn't. Everything here is the hold that was missing, and the arithmetic
 * around it. The pacing research note, kept outside the repo, is the whole
 * derivation with its sources; this is the table it lands on, at `--speed 1`:
 *
 * | Knob | ms | What it is |
 * |---|---|---|
 * | `look` | 500 | between looking at a control and pressing it |
 * | `settle` | 400 | after **every** press, whatever it did |
 * | `read(words)` | `clamp(900 + 200 × words, 900, 3500)` | after a press that put new words on screen |
 * | `land` | 900 + 300 | after a navigation, the second 300 being the site's own colour transition |
 * | `afterTyping` | 700 | between the last typed character and the next press |
 * | `type` | 45 / char | unchanged: the owner says typing fast reads fine |
 * | `clickHold` | 105 | mousedown → mouseup, because 0 ms reads as synthetic |
 * | `ring` | 500 | how long the overlay's click ring stays up |
 * | `read: false` | `settle` + `land` | not a knob but a switch, and the only thing a beat may declare: **a beat can switch the read off for a press whose change is a confirmation the viewer already expected — Copied.** It then holds what a Go holds — `settle`, then `land` — and no words are counted; `timeline.json` says `readRule: "off"`. `BEATS` in `demo/record.mjs` carries it; `reads()` there reads it; `confirm()` below is the hold |
 *
 * Four rules sit on top of the table, and each of them is load-bearing:
 *
 * 1. **The hold after a press is `max(settle, read)`, never the sum.** The read
 *    subsumes the settle; it does not stack on it.
 * 2. **Which words changed is measured, not declared.** The recorder snapshots
 *    `document.body.innerText` on both surfaces before the press and again
 *    after `settle`, and `newWords` counts what is in the second and not the
 *    first. A press that changed nothing holds `settle` and nothing more. The
 *    alternative — a word count written into each beat by hand — goes stale the
 *    first time the copy changes, and silently. A beat may still switch the rule
 *    **off** (`read: false`, the row above): that is a judgement about whether
 *    the viewer has anything to read, not a number that can go stale. The press
 *    then holds like a Go — `settle`, then `land` — because the owner's measure for
 *    it was the Go right before it: "it should be the same delay time as after
 *    clicking the go button". A new picture still gets its second to adjust to;
 *    it just does not get read.
 * 3. **Every hold is jittered ×0.7–1.3, seeded.** A fixed beat reads as a
 *    metronome. `seeded()` from `demo/hand.mjs` keys it on the beat's name and a
 *    counter, so the rhythm varies and two takes are still frame for frame the
 *    same — the same reason nothing in `demo/hand.mjs` calls `Math.random`.
 * 4. **`--speed` is two dials, not one** — see `pace()`.
 *
 * It is all pure, so it is unit-tested (`demo/pace.test.ts`) and there is no
 * browser anywhere in it.
 */
import { seeded } from "./hand.mjs";

/** Between looking at a control and pressing it. */
export const LOOK_MS = 500;
/**
 * After every press. Potter 1976 (*JEP:HLM* 2(5), PMID 1003124): a scene is
 * understood in ~100 ms but needs *"about 300 msec of further processing"*
 * before it survives the next picture. 400 ms is that, and it is also exactly
 * cutaway's click beat.
 */
export const SETTLE_MS = 400;
/**
 * The constant in `read`. Rensink, O'Regan & Clark 1997's blanks-removed
 * control condition — **0.9 s** to notice *and identify* an unmasked change —
 * meeting ITC 1999 §1.9's *"at least one second to allow the reader time to
 * adjust to the new picture"* from the other direction.
 */
export const READ_BASE_MS = 900;
/**
 * The per-word term. The BBC's own subtitle figure, *"0.33 to 0.375 second per
 * word"*, pulled down to the slowest rate Ofcom still calls comfortable
 * (200 wpm = 300 ms/word) and left above Netflix's adult 20 cps (266 ms on our
 * 4.14-letter words), because our text competes with a moving pointer and
 * cannot be paused or re-read.
 */
export const READ_PER_WORD_MS = 200;
/** The clamp on `read`: never less than the constant, never past a re-read. */
export const READ_MIN_MS = 900;
/**
 * Karamitroglou's 6 s re-read threshold and Netflix's 7 s maximum are both
 * above this, and only the 27-word walk brief ever reaches it — which §4.4 of
 * the research says is a copy problem, not a hold problem.
 */
export const READ_MAX_MS = 3500;
/** After a page lands, before the next thing is touched. */
export const LAND_MS = 900;
/**
 * The site's own colour transition, which is the product's animation and not
 * the person's hand — so no `--speed` touches it. It used to be a bare
 * `sleep(300)` next to `land`; the 1200 ms a navigation really costs is
 * `LAND_MS + LAND_COLOUR_MS`, and this is the one place it is written down.
 */
export const LAND_COLOUR_MS = 300;
/** What a navigation costs the take, all in. */
export const LAND_TOTAL_MS = LAND_MS + LAND_COLOUR_MS;
/**
 * Between the last typed character and the next press. Netflix's subtitle
 * out-time — *"at least half a second past the end of the event"* — rounded up
 * past Potter's 400 ms. The string appeared a character at a time under the
 * viewer's eye, so it takes no per-word `read`.
 */
export const AFTER_TYPING_MS = 700;
/** Per character typed. */
export const TYPE_MS = 45;
/**
 * mousedown → mouseup. Playwright's `click({ delay })` defaults to **0**, so
 * every press in the take on disk is an instantaneous down-up; cutaway's note
 * is blunt — *"people hold a mouse button for ~100–120 ms; automation's instant
 * release reads as synthetic"*. Not divided by `--speed`: it is the press
 * itself, not a pause a rehearsal is trying to skip, and 105 ms costs a
 * rehearsal nothing.
 */
export const CLICK_HOLD_MS = 105;
/**
 * How long `demo/overlay.mjs` leaves the ring where a press landed. Playwright's
 * own `showActions.duration` default is 500 ms, Cap's ripple 600 ms. At the
 * 300 ms it used to be, the ring is routinely gone before the eye arrives:
 * ~200 ms to program the saccade and 230–330 ms for the first fixation.
 */
export const RING_MS = 500;
/** No hold is ever shorter than this, however fast the rehearsal. */
export const HOLD_FLOOR_MS = 300;
/** How far a hold may wander from its number, so the beat is not a metronome. */
export const JITTER = [0.7, 1.3];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** Visible text, as words. Whitespace is the only separator that matters here. */
const tokens = s => String(s ?? "").split(/\s+/).filter(Boolean);

/* ------------------------------------------------------- what changed */

/**
 * How many words are in `after` that were not in `before` — a multiset
 * difference over whitespace-split tokens.
 *
 * A multiset and not a set, so a card that gains a second "Pass" counts one new
 * word; and a difference in one direction only, so text that *went away* costs
 * nothing (the viewer has nothing new to read) and text that was merely
 * reordered — a card moving to the Done shelf, the ledge pinning a row — counts
 * zero, which is the whole reason this is measured rather than declared.
 */
export function newWords(before, after) {
  const bag = new Map();
  for (const w of tokens(before)) bag.set(w, (bag.get(w) ?? 0) + 1);
  let fresh = 0;
  for (const w of tokens(after)) {
    const have = bag.get(w) ?? 0;
    if (have > 0) bag.set(w, have - 1);
    else fresh++;
  }
  return fresh;
}

/**
 * How many words in `after` have never been on this surface before, and
 * remember them.
 *
 * `newWords` above measures a press against the screen just before it; this
 * measures against everything the viewer has been shown since the take began.
 * The first check take said why that matters: pressing the green Undo brought
 * a whole card's controls back and counted 38 "new" words — Pass, Issue, Skip,
 * the note box's placeholder — every one of which the viewer had already read
 * on that card minutes earlier. Nobody re-reads a control set. What is new is
 * what has never been on screen: a diagnostic, an agent's answer, a Copied note.
 *
 * `bag` is the surface's memory, word → the most copies of it ever visible at
 * once; it is updated in place. A multiset, for the same reason as above.
 */
export function freshWords(bag, after) {
  const now = new Map();
  for (const w of tokens(after)) now.set(w, (now.get(w) ?? 0) + 1);
  let fresh = 0;
  for (const [w, n] of now) {
    const had = bag.get(w) ?? 0;
    if (n > had) { fresh += n - had; bag.set(w, n); }
  }
  return fresh;
}

/**
 * `clamp(900 + 200 × words, 900, 3500)`, in milliseconds. The research's
 * table said 300 and 5000 and called both derived, not viewer-tested; the owner
 * watching the paced Secrets short (2026-10-04): "after clicking on the copy
 * button it waits too long" — the 21-word Copied note held the full 5 s. The
 * research's own §4.2 compromise (0.9 + 0.20 × words) and a cap under the
 * 4 s a 1080p lower third gets are the first real data point applied.
 */
export function readMs(words) {
  const w = Number.isFinite(words) && words > 0 ? words : 0;
  return clamp(READ_BASE_MS + READ_PER_WORD_MS * w, READ_MIN_MS, READ_MAX_MS);
}

/* ------------------------------------------------------- seeded jitter */

/**
 * A multiplier in `JITTER`, the same one every time for the same beat and
 * counter. `n` is which hold of the beat this is, so two holds in one beat do
 * not get the same nudge.
 */
export function jitter(key, n = 0) {
  const [lo, hi] = JITTER;
  return lo + (hi - lo) * seeded(`${key}#${n}`)();
}

/* ------------------------------------------------------------- the dials */

/**
 * The person's pace, in milliseconds, at this `--speed`.
 *
 * **`--speed` is two dials.** The hand — travel and typing — divides by
 * `speed`, as it always has. The holds — `settle`, `read`, `land`,
 * `afterTyping`, `look` — divide by **√speed**, with a 300 ms floor. A
 * rehearsal's hand can be made twice as quick without lying about the take,
 * because the hand is the performer; its reading time cannot, because that
 * belongs to the viewer, and a rehearsal still has to be legible enough to
 * confirm a state change landed. So `--speed 4` is a 4× hand and 2× holds,
 * about 3× overall. playwright-recast re-times a trace by category for the same
 * reason — `duringUserAction` 1.0, `duringNavigation` 2.0, `duringIdle` 4.0 —
 * rather than with one global multiplier.
 *
 * `look` is filed with the holds rather than with the hand: it is the viewer's
 * beat before a press as much as the hand's, and it is the one thing in the
 * table that was already at the consensus value.
 *
 * **A take that will be cut is shot at `--speed 1`.** `--speed` is a rehearsal
 * flag; nothing above 1 is footage.
 */
export function pace(speed = 1) {
  const s = Number(speed) > 0 ? Number(speed) : 1;
  const root = Math.sqrt(s);
  /** The hand: ÷ speed. */
  const hand = ms => Math.round(ms / s);
  /** The viewer: ÷ √speed, and never under the floor. */
  const dwell = ms => (ms > 0 ? Math.max(HOLD_FLOOR_MS, Math.round(ms / root)) : 0);
  /**
   * An already-scaled hold, nudged off its number. No key, no nudge — which is
   * what a caller that wants the bare figure passes.
   */
  const vary = (ms, key, n = 0) => {
    if (!(ms > 0)) return 0;
    if (key === undefined || key === null) return ms;
    return Math.max(HOLD_FLOOR_MS, Math.round(ms * jitter(key, n)));
  };
  return {
    speed: s,
    look: dwell(LOOK_MS),
    settle: dwell(SETTLE_MS),
    afterTyping: dwell(AFTER_TYPING_MS),
    land: dwell(LAND_MS),
    /** The product's own animation. Never scaled, never jittered. */
    colour: LAND_COLOUR_MS,
    type: hand(TYPE_MS),
    clickHold: CLICK_HOLD_MS,
    ring: RING_MS,
    /** The read hold for a press that changed `words` words; 0 if it changed none. */
    read: words => (words > 0 ? dwell(readMs(words)) : 0),
    /**
     * The whole hold a press earns, and the rule that decides it: `settle`
     * always, `read` when words changed, and **`max` of the two rather than
     * their sum** — the read subsumes the settle instead of stacking on it.
     *
     * `key` is the beat and which press of it this is, so the two halves get
     * different nudges (counter 0 and 1) and the same press asked twice — once
     * for the settle to sleep now, once with the words it turned out to change —
     * gets the same settle both times.
     */
    press: (words, key) => {
      const settle = vary(dwell(SETTLE_MS), key, 0);
      // The cap is applied after the nudge: a read at the cap must stay inside
      // the 6 s re-read threshold the cap was chosen for, jitter or no jitter.
      const read = Math.min(dwell(READ_MAX_MS), vary(words > 0 ? dwell(readMs(words)) : 0, key, 1));
      return { settle, read, newWords: words > 0 ? words : 0, ms: Math.max(settle, read) };
    },
    /**
     * The hold for a press whose beat switched the read off (`read: false`):
     * `settle`, then `land`, summed the way a Go sums them, and never a read.
     * `key` is the same beat-and-press key `press` takes, and the settle is
     * the one `press(0, key)` gives, so the recorder can sleep the settle
     * first and the landing after. `land` is carried separately in the result
     * so the timeline can say where the time went.
     */
    confirm: key => {
      const settle = vary(dwell(SETTLE_MS), key, 0);
      const land = vary(dwell(LAND_MS), key, 1);
      return { settle, read: 0, newWords: 0, land, ms: settle + land };
    },
    /** A hold written into a beat for something the rules do not cover. */
    hold: ms => dwell(ms),
    vary,
    /** The read row at this speed, for `timeline.json`. */
    readTable: {
      base: Math.round(READ_BASE_MS / root),
      perWord: Math.round(READ_PER_WORD_MS / root),
      min: dwell(READ_MIN_MS),
      max: dwell(READ_MAX_MS),
    },
  };
}

/**
 * The numbers a take actually ran on, for `timeline.json` — so a cut that finds
 * a beat long can see which rule made it long, without re-deriving anything.
 */
export function paceSummary(p) {
  return {
    speed: p.speed,
    look: p.look,
    settle: p.settle,
    read: { ...p.readTable },
    land: p.land,
    colour: p.colour,
    landTotal: p.land + p.colour,
    afterTyping: p.afterTyping,
    type: p.type,
    clickHold: p.clickHold,
    ring: p.ring,
    jitter: [...JITTER],
    floor: HOLD_FLOOR_MS,
    rule: "a press holds max(settle, read(words never shown on that surface before)); every hold is jittered 0.7-1.3 seeded on the beat, the read capped after the nudge; the hand divides by speed, the holds by its square root, floored",
  };
}
