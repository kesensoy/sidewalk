/**
 * The pace maths: the table's numbers, the clamps, how `--speed` scales each
 * category, the seeded jitter, and the word count the `read` hold is derived
 * from. All pure — no camera, no browser, no clock.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — the demo is plain .mjs, with no types to import.
import {
  AFTER_TYPING_MS, CLICK_HOLD_MS, HOLD_FLOOR_MS, JITTER, LAND_COLOUR_MS, LAND_MS, LAND_TOTAL_MS,
  LOOK_MS, READ_MAX_MS, RING_MS, SETTLE_MS, TYPE_MS, freshWords, jitter, newWords, pace, paceSummary, readMs,
} from "./pace.mjs";

it("is the research's table at --speed 1", () => {
  const p = pace(1);
  expect([p.look, p.settle, p.land, p.colour, p.afterTyping, p.type, p.clickHold, p.ring])
    .toEqual([500, 400, 900, 300, 700, 45, 105, 500]);
  // The 1200 ms a navigation really costs, in one place rather than a bare
  // `sleep(300)` next to the constant.
  expect(p.land + p.colour).toBe(LAND_TOTAL_MS);
  expect(LAND_TOTAL_MS).toBe(LAND_MS + LAND_COLOUR_MS);
  expect([LOOK_MS, SETTLE_MS, AFTER_TYPING_MS, TYPE_MS, CLICK_HOLD_MS, RING_MS, HOLD_FLOOR_MS])
    .toEqual([500, 400, 700, 45, 105, 500, 300]);
  // And the numbers a take ran on, for the cut to read out of `timeline.json`.
  const s = paceSummary(p);
  expect(s.read).toEqual({ base: 900, perWord: 200, min: 900, max: 3500 });
  expect([s.speed, s.landTotal, s.floor]).toEqual([1, 1200, 300]);
  expect(s.jitter).toEqual([0.7, 1.3]);
});

it("reads for 0.9 s plus 0.2 s a word, clamped at both ends", () => {
  // The rows of §4.1, against our own copy: "Key accepted." is 2 words, "The
  // maintenance lock" 3, the median string 4.
  expect([0, 2, 3, 4, 6, 11, 13].map(readMs)).toEqual([900, 1300, 1500, 1700, 2100, 3100, 3500]);
  // The walk brief is 27 words and needs 9 s by the formula: the cap is what it
  // gets, and §4.4 says the brief is a copy problem, not a hold problem.
  expect(readMs(27)).toBe(READ_MAX_MS);
  expect(readMs(27)).toBe(3500);
  expect(readMs(1000)).toBe(3500);
  // Nonsense is the floor, never NaN.
  expect([readMs(-3), readMs(Number.NaN), readMs(undefined)]).toEqual([900, 900, 900]);
});

it("holds max(settle, read) after a press, never the sum", () => {
  const p = pace(1);
  // A press that changed nothing on screen holds the settle and nothing more.
  const nothing = p.press(0, "lock-step-2/0");
  expect(nothing.read).toBe(0);
  expect(nothing.ms).toBe(nothing.settle);
  expect(nothing.newWords).toBe(0);
  // A press that changed words holds the read — which already contains the
  // settle, so the two are not added.
  const read = p.press(4, "verify-key/3");
  expect(read.read).toBeGreaterThan(read.settle);
  expect(read.ms).toBe(read.read);
  expect(read.ms).toBeLessThan(read.settle + read.read);
  // Asked twice with the same key, the settle is the same both times — which is
  // what lets the recorder sleep the settle first and the remainder after it has
  // counted the words.
  expect(p.press(11, "verify-key/3").settle).toBe(read.settle);
  // More words is a longer hold, and the cap holds.
  expect(p.press(11, "k").ms).toBeGreaterThan(p.press(4, "k").ms);
  expect(p.press(27, "k").ms).toBe(p.press(100, "k").ms);
});

it("holds a read-off press like a Go: settle, then land, and no read", () => {
  const p = pace(1);
  const c = p.confirm("copy-key/0");
  // No words are counted and nothing is read.
  expect(c.read).toBe(0);
  expect(c.newWords).toBe(0);
  // The settle is the one press() gives for the same key, so the recorder can
  // sleep it first and the landing after.
  expect(c.settle).toBe(p.press(0, "copy-key/0").settle);
  // The landing is the Go's own, nudged: inside 0.7–1.3 of 900.
  expect(c.land).toBeGreaterThanOrEqual(630);
  expect(c.land).toBeLessThanOrEqual(1170);
  // And summed, the way a Go sums them — not max'd like a read.
  expect(c.ms).toBe(c.settle + c.land);
  // Seeded: the same key is the same hold every run.
  expect(p.confirm("copy-key/0")).toEqual(c);
  // At speed the holds divide by root speed, like every other dwell.
  expect(pace(4).confirm("copy-key/0").ms).toBeLessThan(c.ms);
});

it("counts the words that are new, and only those", () => {
  // Words added: three of them, wherever they landed.
  expect(newWords("The maintenance lock", "The maintenance lock is on now")).toBe(3);
  expect(newWords("", "Key accepted.")).toBe(2);
  // Words that only went away cost nothing: there is nothing new to read.
  expect(newWords("Pass Issue Ask Dismiss", "Pass Dismiss")).toBe(0);
  expect(newWords("Key accepted.", "")).toBe(0);
  // Reordered is not new either — a card moving to the Done shelf, a row the
  // ledge pins to the bottom. This is the reason the count is measured off the
  // page rather than written into the beat by hand.
  expect(newWords("one two three", "three two one")).toBe(0);
  // A multiset, not a set: a second copy of a word is a word that appeared.
  expect(newWords("Pass", "Pass Pass")).toBe(1);
  expect(newWords("Pass Pass", "Pass")).toBe(0);
  // Whitespace is the only separator: punctuation rides along with its word,
  // and a newline, a tab or a run of spaces is one break.
  expect(newWords("a\nb\tc   d", "a b c d")).toBe(0);
  expect(newWords("accepted", "accepted.")).toBe(1);
  // Nothing in, nothing out.
  expect([newWords("", ""), newWords(undefined, undefined), newWords(null, "  \n ")]).toEqual([0, 0, 0]);
});

it("jitters every hold inside 0.7–1.3, the same way every run", () => {
  const [lo, hi] = JITTER;
  expect([lo, hi]).toEqual([0.7, 1.3]);
  const keys = ["open", "go-lamps", "undo-lamps", "verify-key", "share", "closed"];
  for (const k of keys) {
    for (let n = 0; n < 6; n++) {
      const j = jitter(k, n);
      expect(j, `${k}#${n}`).toBeGreaterThanOrEqual(lo);
      expect(j, `${k}#${n}`).toBeLessThan(hi);
    }
  }
  // Deterministic: the same beat and counter is the same nudge for ever, which
  // is what keeps two takes frame for frame the same.
  expect(jitter("go-key", 2)).toBe(jitter("go-key", 2));
  expect(jitter("go-key", 0)).toBe(jitter("go-key"));
  // And not a metronome: the two holds of one beat, and the same hold of two
  // beats, are different numbers.
  expect(jitter("go-key", 0)).not.toBe(jitter("go-key", 1));
  expect(jitter("go-key", 0)).not.toBe(jitter("copy-key", 0));
  // It is really in the holds: the same press with two keys is two lengths.
  const p = pace(1);
  expect(p.press(4, "a/0").ms).not.toBe(p.press(4, "b/0").ms);
  // A spread worth having, over the keys a take actually uses.
  const all = keys.flatMap(k => [0, 1, 2].map(n => jitter(k, n)));
  expect(Math.max(...all) - Math.min(...all)).toBeGreaterThan(0.3);
  // No key, no nudge — the bare figure, for a caller that wants the table.
  expect(p.vary(400, undefined)).toBe(400);
  expect(p.vary(0, "open", 0)).toBe(0);
});

it("divides the hand by --speed and the holds by its square root", () => {
  // The hand: travel and typing, as it always has been.
  expect(pace(2).type).toBe(23);
  expect(pace(4).type).toBe(11);
  // The viewer: ÷ √speed, because a rehearsal's reading time cannot be halved
  // the way its hand can.
  expect(pace(4).land).toBe(450);
  expect(pace(2).land).toBe(636);
  expect(pace(2).look).toBe(354);
  expect(pace(2).afterTyping).toBe(495);
  expect(pace(4).read(4)).toBe(850);
  expect(pace(9).land).toBe(300);
  // The floor, which is what stops a fast rehearsal from being a slideshow of
  // changes nobody can see: 400 ÷ 2 is 200, and a hold is never under 300.
  expect(pace(4).settle).toBe(HOLD_FLOOR_MS);
  expect(pace(16).look).toBe(HOLD_FLOOR_MS);
  expect(pace(100).read(2)).toBe(HOLD_FLOOR_MS);
  expect(pace(100).read(13)).toBe(350);
  // Jitter cannot take a hold under the floor either.
  for (const k of ["open", "go-lamps", "closed"]) expect(pace(1).press(0, k).settle).toBeGreaterThanOrEqual(HOLD_FLOOR_MS);
  // The product's own colour transition is not the person's hand, so no speed
  // flag touches it.
  expect([pace(1).colour, pace(4).colour, pace(100).colour]).toEqual([300, 300, 300]);
  // And neither is the button hold: it is the press itself, and 105 ms costs a
  // rehearsal nothing.
  expect([pace(1).clickHold, pace(8).clickHold]).toEqual([105, 105]);
  // A missing, zero or nonsense speed is the real pace, never a divide by zero.
  expect([pace().look, pace(0).look, pace(Number.NaN).look, pace(-2).look]).toEqual([500, 500, 500, 500]);
  expect(paceSummary(pace(4)).speed).toBe(4);
});

describe("freshWords — only what has never been on this surface", () => {
  it("counts a word once for the take, however many presses show it again", () => {
    const bag = new Map();
    expect(freshWords(bag, "Pass Issue Skip Ask")).toBe(4);
    expect(freshWords(bag, "Pass Issue Skip Ask")).toBe(0);           // the same controls, again
    expect(freshWords(bag, "Pass Issue Skip Ask Not ready here")).toBe(3);
    expect(freshWords(bag, "Not ready here")).toBe(0);
  });
  it("counts extra copies, and never counts a word that went away", () => {
    const bag = new Map();
    expect(freshWords(bag, "Undo")).toBe(1);
    expect(freshWords(bag, "Undo Undo")).toBe(1);
    expect(freshWords(bag, "")).toBe(0);
    expect(freshWords(bag, "Undo Undo")).toBe(0);
  });
});

describe("the read cap holds after the jitter", () => {
  it("never lets a capped read past the cap", () => {
    const p = pace(1);
    for (let n = 0; n < 40; n++) expect(p.press(27, `beat-${n}`).read).toBeLessThanOrEqual(3500);
  });
});
