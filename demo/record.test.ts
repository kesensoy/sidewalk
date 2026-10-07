/**
 * The recorder's pieces that can be wrong without a camera: the pack retargeted
 * onto the recording's own Lamppost, the beat list the timeline is written from,
 * the camera's arithmetic and the hand's path. No Chrome anywhere — the script
 * imports Playwright dynamically, inside the take, so importing the module here
 * costs nothing. The pace is its own module now, and `demo/pace.test.ts` is its
 * own test.
 */
import { expect, it } from "vitest";
// @ts-expect-error — the demo is plain .mjs, with no types to import.
import { BEATS, DEFAULT_OUT, SCHEMES, parseArgs, parseSize, reads, retarget, outFor } from "./record.mjs";
// @ts-expect-error — same. The terminal's default geometry, which is the cut's.
import { DEFAULT_TERMINAL } from "./agent/theme.js";
// @ts-expect-error — same.
import { loadPack } from "./run.mjs";
// @ts-expect-error — same. The camera's arithmetic, which needs no camera.
import { DISTINCT_FLOOR, PULSE_MS, cursorIssues, frameAt, health, keepPainting, placeFrames } from "./capture.mjs";
// @ts-expect-error — same. The hand's maths, which needs no mouse.
import { MAX_STEP_PX, SAMPLE_MS, aim, aimWidth, fittsMs, handPath, seeded } from "./hand.mjs";

const pack = await loadPack();

it("retargets every url and every url expectation, and nothing else", async () => {
  const moved = retarget(pack, 9353);
  // The whole pack, as text, differs from the original in exactly the port —
  // which is the tightest way to say "and nothing else": a title, a step, a
  // secret or the ask reply that changed would show up here.
  expect(JSON.stringify(moved)).toBe(JSON.stringify(pack).split("9350").join("9353"));

  const items = moved.groups.flatMap((g: any) => g.items);
  const urls = items.map((i: any) => i.url).filter(Boolean);
  expect(urls.length).toBeGreaterThan(0);
  for (const u of urls) expect(u).toContain("127.0.0.1:9353");
  for (const u of urls) expect(u).not.toContain("9350");

  // The escaped-dot spelling inside a regex is rewritten too, and the regex
  // still does its job against the page the card will be opened on.
  const lamps = items.find((i: any) => i.id === "lp-lamps");
  const url = lamps.expect.find((e: any) => e.kind === "url");
  expect(url.matches).toBe("^http://127\\.0\\.0\\.1:9353/?$");
  expect(new RegExp(url.matches).test("http://127.0.0.1:9353/")).toBe(true);
  expect(new RegExp(url.matches).test("http://127.0.0.1:9350/")).toBe(false);

  // An expectation that is not about the url is carried through untouched.
  const build = lamps.expect.find((e: any) => e.kind === "text");
  expect(build).toEqual({ kind: "text", css: "meta[name=build]", attr: "content", equals: "lp-24" });
});

it("leaves the pack it was given alone", async () => {
  const before = JSON.stringify(pack);
  retarget(pack, 9353);
  expect(JSON.stringify(pack)).toBe(before);
});

it("has one event per beat of the take, and no name twice", () => {
  // 27: the ask's answer stopped being a card of its own, so there is no reply
  // to dismiss and no beat for dismissing one. `ask-share` is followed straight
  // by `share`, whose Pass on the card that asked is what resolves the ask.
  expect(BEATS).toHaveLength(27);
  const names = BEATS.map((b: any) => b.name);
  expect(new Set(names).size).toBe(names.length);
  // The four the cut needs by name; `group-a` is emitted inside the first beat.
  for (const n of ["group-b", "agent-read", "closed"]) expect(names).toContain(n);
  expect(names[0]).toBe("open");
  expect(names.at(-1)).toBe("closed");
  // Every beat carries the line the cut captions from.
  for (const b of BEATS as any[]) expect(b.note.length).toBeGreaterThan(10);

  // The free Undo, the one left to go red, and the shelf it lands on are one
  // unbroken run of beats, so the cut plays the whole story without dissolving
  // to a pane with no context in it. The owner on the take before this one: *"it
  // does something, then fades to something else with 0 context, then fades back
  // to the next step"*; and on this one: *"maybe you hit pass on two, then undo
  // one in the green, letting the second fade to red, then scroll if needed."*
  expect(names.slice(names.indexOf("pass-lamps"), names.indexOf("pass-lamps") + 5))
    .toEqual(["pass-lamps", "decide-tiers-early", "undo-tiers", "agent-read-lamps", "show-shelf"]);
  // And the later read is still there, for the lock's issue and the decision —
  // which `undo-tiers` handed back answerable, so it is answered again first.
  expect(names.indexOf("agent-read")).toBeGreaterThan(names.indexOf("decide-tiers"));
  expect(names.indexOf("decide-tiers")).toBeGreaterThan(names.indexOf("show-shelf"));
  // The ask and the press that resolves it are next to each other, with nothing
  // in between — there is no card in between any more either.
  expect(names.slice(names.indexOf("ask-share"), names.indexOf("ask-share") + 2)).toEqual(["ask-share", "share"]);
});

it("reads its flags", () => {
  expect(parseArgs([])).toEqual({});
  expect(parseArgs(["--out", "demo/out/check", "--speed", "2"])).toEqual({ out: "demo/out/check", speed: 2 });
  expect(parseArgs(["--keep-frames"])).toEqual({ keepFrames: true });
  // The in-page pointer is on unless it is turned off, which is what a take for
  // the cut does — the cut draws its own and two pointers disagree.
  expect(parseArgs(["--no-overlay"])).toEqual({ overlay: false });
  expect(parseArgs(["--out", "x", "--no-overlay", "--speed", "2"])).toEqual({ out: "x", overlay: false, speed: 2 });
  expect(() => parseArgs(["--fast"])).toThrow(/unknown flag/);
  expect(() => parseArgs(["--overlay"])).toThrow(/unknown flag/);

  // The scheme is `prefers-color-scheme`, emulated on the pane and on Lamppost,
  // and absent is light. Anything else is a typo, not a third scheme.
  expect(SCHEMES).toEqual(["light", "dark"]);
  expect(parseArgs(["--scheme", "dark"])).toEqual({ scheme: "dark" });
  expect(parseArgs(["--scheme", "light"])).toEqual({ scheme: "light" });
  expect(() => parseArgs(["--scheme", "sepia"])).toThrow(/--scheme is light or dark/);

  // The terminal's look is its own flag, because it stays dark in both schemes.
  expect(parseArgs(["--terminal-theme", "light"])).toEqual({ terminalTheme: "light" });
  expect(() => parseArgs(["--terminal-theme", "amber"])).toThrow(/--terminal-theme is dark or light/);

  // And its filmed viewport is a parameter, so nothing in the pipeline depends
  // on the number: the cut decides it and the page sizes its grid to it.
  expect(parseArgs(["--terminal-size", "1212x440"])).toEqual({ terminalSize: { width: 1212, height: 440 } });
  expect(parseArgs(["--terminal-size", "1440x900"])).toEqual({ terminalSize: { width: 1440, height: 900 } });
  expect(() => parseArgs(["--terminal-size", "1212"])).toThrow(/wants WxH/);
  expect(() => parseArgs(["--terminal-size", "1212x400x2"])).toThrow(/wants WxH/);
  // yuv420p will not take an odd side, and the muxer's own check comes too late
  // to be worth finding out at the end of a take.
  expect(() => parseSize("1213x440")).toThrow(/even both ways/);
  expect(() => parseSize("1212x441")).toThrow(/even both ways/);
  expect(() => parseSize("200x100")).toThrow(/too small/);
});

it("films the terminal at the size the cut draws 1:1, by default", () => {
  // The owner, 2026-10-05: "Film the terminal at 1212×440 … the cut draws it 1:1,
  // so no resampling." Both sides even, for the muxer.
  expect(DEFAULT_TERMINAL).toEqual({ width: 1212, height: 440 });
  expect(DEFAULT_TERMINAL.width % 2).toBe(0);
  expect(DEFAULT_TERMINAL.height % 2).toBe(0);
});

it("gives each scheme one fixed out folder, overwritten by the next take", () => {
  expect(DEFAULT_OUT).toBe("demo/out/lamppost");
  expect(outFor("light")).toBe("demo/out/lamppost");
  expect(outFor("dark")).toBe("demo/out/lamppost-dark");
  expect(outFor()).toBe("demo/out/lamppost");
});

it("lets a beat say its press is not worth a read, and reads for it by default", () => {
  // The flag as the recorder reads it: absent is on, `false` is the only thing
  // that turns it off, and nothing else — not 0, not a string — is the switch.
  expect(reads({ name: "pass-lamps" })).toBe(true);
  expect(reads({ name: "copy-key", read: false })).toBe(false);
  expect(reads({ name: "x", read: true })).toBe(true);

  // Exactly one beat carries it: the Copy button, whose Copied note is a
  // confirmation of a press the viewer just made. Every other entry leaves the
  // flag off and gets the read rule.
  const off = (BEATS as any[]).filter((b: any) => !reads(b)).map((b: any) => b.name);
  expect(off).toEqual(["copy-key"]);
  for (const b of BEATS as any[]) if (b.name !== "copy-key") expect(b.read).toBeUndefined();
});

/* ------------------------------------------------- the camera's arithmetic */

it("fills every 1/60 s slot, holding the last frame through a gap", () => {
  // Nothing in, nothing out.
  expect(placeFrames([])).toEqual([]);
  // One frame is one slot.
  expect(placeFrames([0])).toEqual([0]);
  // A frame a slot: 1000/60 is 16.67 ms.
  expect(placeFrames([0, 16.7, 33.3, 50])).toEqual([0, 1, 2, 3]);
  // Half a second of nothing: the last frame is held through all thirty slots
  // rather than leaving a gap, which is what makes an idle page a still.
  const held = placeFrames([0, 500]);
  expect(held).toHaveLength(31);
  expect(held.slice(0, 30)).toEqual(Array(30).fill(0));
  expect(held[30]).toBe(1);
  // Several frames inside one slot: the last of them is what was on screen
  // when the slot ended, so it is the one that gets drawn.
  expect(placeFrames([0, 5, 9, 16.7])).toEqual([1, 3]);
  // A slow first paint does not shift the take: the slots before the first
  // frame are back-filled from it rather than dropped.
  const late = placeFrames([100, 200], { t0: 0 });
  expect(late).toHaveLength(13);
  expect(late.slice(0, 12)).toEqual(Array(12).fill(0));
  expect(late[12]).toBe(1);
  // And the tail is held out to `until`, so both surfaces can end together.
  expect(placeFrames([0], { until: 100 })).toEqual(Array(7).fill(0));
  // A different rate is the same arithmetic.
  expect(placeFrames([0, 100], { fps: 10 })).toEqual([0, 1]);
  expect(placeFrames([0, 100, 350], { fps: 10 })).toEqual([0, 1, 1, 1, 2]);
});

it("puts a moment on the frame it belongs to", () => {
  expect(frameAt(0, 0)).toBe(0);
  expect(frameAt(1000, 0)).toBe(60);
  expect(frameAt(1000, 500)).toBe(30);
  // A beat before this surface's first frame is frame 0, never a negative one.
  expect(frameAt(100, 500)).toBe(0);
});

it("calls a take bad when any surface stopped moving", () => {
  const live = { site: { distinct: 2103 }, pane: { distinct: 486 } };
  expect(health(live)).toEqual({ ok: true, floor: DISTINCT_FLOOR, frozen: [] });

  // Three surfaces now, and the terminal is honestly the quietest of them: it
  // changes only when a block prints. A real take measured 64 distinct frames
  // of 7949 on it, which has to pass — the general floor is for a surface that
  // stopped compositing, which produces single figures, not for one that is
  // still between actions.
  const trio = { site: { distinct: 2536 }, pane: { distinct: 8581 }, terminal: { distinct: 64 } };
  expect(health(trio)).toEqual({ ok: true, floor: DISTINCT_FLOOR, frozen: [] });
  expect(health({ ...trio, terminal: { distinct: 31 } }).ok).toBe(true);
  expect(health({ ...trio, terminal: { distinct: 3 } }).frozen).toEqual(["terminal produced 3 distinct frames against a floor of 30"]);

  // The failure this exists for: the muxer holds the last frame into every
  // empty slot, so a frozen pane is a full-length frozen video, not an error.
  const frozen = health({ site: { distinct: 2103 }, pane: { distinct: 3 } });
  expect(frozen.ok).toBe(false);
  expect(frozen.frozen).toEqual(["pane produced 3 distinct frames against a floor of 30"]);

  // Both can be bad, the floor can be moved, and a surface that reported
  // nothing at all is as bad as one that reported three.
  expect(health({ site: { distinct: 1 }, pane: { distinct: 2 } }).frozen).toHaveLength(2);
  expect(health({ site: { distinct: 40 } }, 50).ok).toBe(false);
  expect(health({ site: {} }).frozen).toEqual(["site produced 0 distinct frames against a floor of 30"]);
  expect(DISTINCT_FLOOR).toBe(30);
});

it("holds the terminal to the blocks it printed, not to a guess", () => {
  // The quiet surface's floor is a count the recorder has: a take that filmed
  // every block cannot have produced fewer distinct frames than it printed
  // blocks. It moves with the transcript, where a number here would go stale.
  const counts = { site: { distinct: 2536 }, pane: { distinct: 8581 }, terminal: { distinct: 64 } };
  expect(health(counts, undefined, { terminal: 23 })).toEqual({ ok: true, floor: DISTINCT_FLOOR, floors: { terminal: 23 }, frozen: [] });
  // Twenty-two of twenty-three blocks in the footage is a take that lost one.
  const lost = health({ ...counts, terminal: { distinct: 22 } }, undefined, { terminal: 23 });
  expect(lost.ok).toBe(false);
  expect(lost.frozen).toEqual(["terminal produced 22 distinct frames against a floor of 23"]);
  // It replaces the general floor rather than raising it, which is the point:
  // 30 is a guess tuned to the two surfaces a hand moves, and under it a
  // terminal that lost a block of a short transcript would pass unnoticed.
  expect(health({ terminal: { distinct: 20 } }, undefined, { terminal: 21 }).ok).toBe(false);
  expect(health({ terminal: { distinct: 20 } }, undefined, { terminal: 4 }).ok).toBe(true);
  // And a surface with no floor of its own still gets the general one.
  expect(health({ site: { distinct: 29 }, terminal: { distinct: 99 } }, undefined, { terminal: 99 }).frozen)
    .toEqual(["site produced 29 distinct frames against a floor of 30"]);
});

it("holds the cursor track to a shape the cut can draw", () => {
  const good = [
    { t: 10, surface: "pane", x: 190, y: 240, kind: "move" },
    { t: 20, surface: "pane", x: 190, y: 240, kind: "down" },
    { t: 30, surface: "pane", x: 190, y: 240, kind: "up" },
    { t: 40, surface: "site", x: 600, y: 400, kind: "move" },
    { t: 50, surface: "site", x: 600, y: 400, kind: "down" },
    { t: 60, surface: "site", x: 600, y: 400, kind: "up" },
    // A second press where the pointer already is: an up is a fine place to
    // press from, because the pointer did not move in between.
    { t: 70, surface: "site", x: 600, y: 400, kind: "down" },
  ];
  expect(cursorIssues(good)).toEqual([]);
  expect(cursorIssues([])).toEqual([]);

  // The rule the whole track exists for: a press the pointer never travelled
  // to is a pointer that teleports onto a button.
  expect(cursorIssues([{ t: 0, surface: "pane", x: 1, y: 1, kind: "down" }]))
    .toEqual(["cursor[0] is a down on pane with no move before it"]);

  // The move has to be on the *same* surface: a hand on the site does not put
  // the pane's pointer anywhere.
  const crossed = cursorIssues([
    { t: 0, surface: "site", x: 1, y: 1, kind: "move" },
    { t: 1, surface: "pane", x: 2, y: 2, kind: "down" },
  ]);
  expect(crossed).toEqual(["cursor[1] is a down on pane with no move before it"]);

  // A release with nothing to release.
  expect(cursorIssues([
    { t: 0, surface: "site", x: 1, y: 1, kind: "move" },
    { t: 1, surface: "site", x: 1, y: 1, kind: "up" },
  ])).toEqual(["cursor[1] is an up on site with no down before it"]);

  // And the field-by-field shape, because a cut that reads a broken track
  // draws a pointer in the wrong place rather than failing.
  const junk = cursorIssues([
    { t: "soon", surface: "pane", x: 1, y: 1, kind: "move" },
    { t: 5, surface: "panel", x: 1, y: 1, kind: "move" },
    { t: 6, surface: "pane", x: 1, y: 1, kind: "wiggle" },
    { t: 7, surface: "pane", x: null, y: 1, kind: "move" },
    { t: 2, surface: "pane", x: 1, y: 1, kind: "move" },
  ]);
  expect(junk).toContain("cursor[0] has no numeric t");
  expect(junk).toContain('cursor[1] is on surface "panel", not site or pane');
  expect(junk).toContain('cursor[2] is kind "wiggle", not move, down or up');
  expect(junk).toContain("cursor[3] has no numeric x,y");
  expect(junk).toContain("cursor[4] goes backwards in time (2 after 7)");
});

it("calls a jump between two moves on one surface a teleport", () => {
  // The track is the whole path now, so a gap between consecutive samples is a
  // pointer that was never in between. 200 px is the line.
  const hop = (dx: number) => cursorIssues([
    { t: 0, surface: "site", x: 100, y: 100, kind: "move" },
    { t: 16, surface: "site", x: 100 + dx, y: 100, kind: "move" },
  ]);
  expect(hop(199)).toEqual([]);
  expect(hop(200)).toEqual([]);
  expect(hop(201)).toEqual([`cursor[1] jumps 201 px on site since the move before it, more than ${MAX_STEP_PX}`]);
  // Diagonally too: 300,400,500 is the triangle that catches a rule written
  // against x or y alone.
  expect(cursorIssues([
    { t: 0, surface: "pane", x: 0, y: 0, kind: "move" },
    { t: 16, surface: "pane", x: 300, y: 400, kind: "move" },
  ])).toEqual([`cursor[1] jumps 500 px on pane since the move before it, more than ${MAX_STEP_PX}`]);

  // The two surfaces are measured apart: the pane's pointer does not move
  // because the hand went somewhere on the site, and an excursion and back is
  // not a jump as long as the glide resumed where it stopped.
  expect(cursorIssues([
    { t: 0, surface: "pane", x: 350, y: 250, kind: "move" },
    { t: 10, surface: "site", x: 20, y: 870, kind: "move" },
    { t: 20, surface: "site", x: 120, y: 800, kind: "move" },
    { t: 30, surface: "pane", x: 352, y: 254, kind: "move" },
  ])).toEqual([]);

  // The first move on a surface has nothing to be far from — where the pointer
  // rested before the track began is not in the track.
  expect(cursorIssues([{ t: 0, surface: "site", x: 1400, y: 880, kind: "move" }])).toEqual([]);

  // A press and a release do not count as travel, so a move after them is
  // measured from the last *move*.
  expect(cursorIssues([
    { t: 0, surface: "site", x: 100, y: 100, kind: "move" },
    { t: 10, surface: "site", x: 100, y: 100, kind: "down" },
    { t: 20, surface: "site", x: 100, y: 100, kind: "up" },
    { t: 30, surface: "site", x: 600, y: 100, kind: "move" },
  ])).toEqual([`cursor[3] jumps 500 px on site since the move before it, more than ${MAX_STEP_PX}`]);
});

/* ------------------------------------------------------------ the hand */

it("gives the same target the same off-centre landing spot for ever", () => {
  const box = { x: 100, y: 200, width: 120, height: 28 };
  const a = aim(box, '[data-go="lp-lamps"]');
  expect(aim(box, '[data-go="lp-lamps"]')).toEqual(a);
  // Off the centre (60, 14), but only slightly, and inside the box.
  expect(a.rel).not.toEqual({ x: 60, y: 14 });
  expect(Math.abs(a.rel.x - 60)).toBeLessThanOrEqual(14);
  expect(Math.abs(a.rel.y - 14)).toBeLessThanOrEqual(14);
  expect(a).toEqual({ rel: a.rel, x: 100 + a.rel.x, y: 200 + a.rel.y });
  // A different target lands somewhere else.
  expect(aim(box, '[data-go="lp-lock"]').rel).not.toEqual(a.rel);
  // A 14 px checkbox is still hit: the offset is a share of the box, and the
  // result is always at least a pixel inside it.
  for (const key of ["a", "b", "c", "d", "e"]) {
    const tiny = aim({ x: 0, y: 0, width: 14, height: 14 }, key);
    expect(tiny.rel.x).toBeGreaterThanOrEqual(1);
    expect(tiny.rel.x).toBeLessThanOrEqual(13);
    expect(tiny.rel.y).toBeGreaterThanOrEqual(1);
    expect(tiny.rel.y).toBeLessThanOrEqual(13);
  }
  // Nothing leans on `Math.random`: the same seed is the same stream, and a
  // different seed is a different one.
  const r = seeded("lp-lamps"), s = seeded("lp-lamps");
  expect([r(), r(), r()]).toEqual([s(), s(), s()]);
  expect(seeded("lp-lock")()).not.toBe(seeded("lp-lamps")());
});

it("takes longer to reach a further, smaller target — Fitts's law", () => {
  expect(fittsMs(400, 40)).toBeGreaterThan(fittsMs(100, 40));
  expect(fittsMs(400, 200)).toBeLessThan(fittsMs(400, 20));
  // A target under 8 px or over 400 is not a harder or easier target still.
  expect(fittsMs(400, 2)).toBe(fittsMs(400, 8));
  expect(fittsMs(400, 4000)).toBe(fittsMs(400, 400));
  expect(aimWidth({ x: 0, y: 0, width: 300, height: 28 })).toBe(28);
  expect(aimWidth({ x: 0, y: 0, width: 2, height: 2 })).toBe(8);
  expect(aimWidth({ x: 0, y: 0, width: 900, height: 700 })).toBe(160);
});

it("draws a path that starts where the hand was, ends where it presses, and never teleports", () => {
  const cases = [
    { from: { x: 24, y: 876 }, to: { x: 350, y: 253 }, key: "pane-pass", bounds: { width: 400, height: 900 } },
    { from: { x: 350, y: 253 }, to: { x: 356, y: 258 }, key: "pane-nudge", bounds: { width: 400, height: 900 } },
    { from: { x: 20, y: 880 }, to: { x: 1400, y: 40 }, key: "site-far", bounds: { width: 1440, height: 900 } },
    // The one the floor exists for: a rehearsal fast enough that Fitts's law
    // alone would put 300 px between two samples.
    { from: { x: 20, y: 880 }, to: { x: 1400, y: 40 }, key: "site-far", speed: 8, bounds: { width: 1440, height: 900 } },
  ];
  for (const c of cases) {
    const { ms, points } = handPath(c);
    const what = `${c.key}@${c.speed ?? 1}`;
    expect(points.length, what).toBeGreaterThan(2);
    // The ends are exact: the track picks up where the pointer was and the
    // press happens where the last sample left it.
    expect(points[0], what).toEqual({ t: 0, x: c.from.x, y: c.from.y });
    expect(points.at(-1), what).toEqual({ t: ms, x: c.to.x, y: c.to.y });
    for (let i = 1; i < points.length; i++) {
      // Time only goes forwards, and no sample is outside the move.
      expect(points[i].t, `${what}[${i}] t`).toBeGreaterThan(points[i - 1].t);
      expect(points[i].t, `${what}[${i}] t`).toBeLessThanOrEqual(ms);
      // The rule `cursorIssues` holds the track to.
      const step = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      expect(step, `${what}[${i}] step`).toBeLessThanOrEqual(MAX_STEP_PX);
      // Nothing leaves the surface: a pointer that bows out of frame mid-move
      // looks like a bug in the footage.
      expect(points[i].x, `${what}[${i}] x`).toBeGreaterThanOrEqual(0);
      expect(points[i].y, `${what}[${i}] y`).toBeGreaterThanOrEqual(0);
      expect(points[i].x, `${what}[${i}] x`).toBeLessThan(c.bounds.width);
      expect(points[i].y, `${what}[${i}] y`).toBeLessThan(c.bounds.height);
    }
    // One sample a frame, give or take the ones dropped for being the pixel the
    // pointer was already on.
    expect(points.length, what).toBeLessThanOrEqual(Math.round(ms / SAMPLE_MS) + 4);
  }
});

it("curves, and eases in and out", () => {
  const from = { x: 0, y: 0 }, to = { x: 600, y: 0 };
  const { points, ms } = handPath({ from, to, key: "curve" });
  // A straight line at a constant speed is what the owner was looking at. Neither
  // is true here: the path leaves the line between its endpoints…
  expect(Math.max(...points.map((p: { y: number }) => Math.abs(p.y)))).toBeGreaterThan(4);
  // …and the middle third of the move covers more ground than the first.
  const spanOf = (lo: number, hi: number) => {
    const inside = points.filter((p: { t: number }) => p.t >= ms * lo && p.t <= ms * hi);
    return Math.abs(inside.at(-1).x - inside[0].x);
  };
  expect(spanOf(0.4, 0.6)).toBeGreaterThan(spanOf(0, 0.2) * 1.5);
  expect(spanOf(0.4, 0.6)).toBeGreaterThan(spanOf(0.8, 1) * 1.5);
  // And it goes past the target before settling back onto it, which is the
  // other half of what a hand does on a long throw.
  expect(Math.max(...points.map((p: { x: number }) => p.x))).toBeGreaterThan(to.x);

  // A short move is just a move: no overshoot to correct on a 40 px hop.
  const near = handPath({ from: { x: 100, y: 100 }, to: { x: 140, y: 100 }, key: "hop" });
  expect(Math.max(...near.points.map((p: { x: number }) => p.x))).toBe(140);

  // Twice the speed is at most the same duration and usually half of it, and
  // the geometry does not change with it.
  const slow = handPath({ from, to, key: "curve" });
  const fast = handPath({ from, to, key: "curve", speed: 2 });
  expect(fast.ms).toBeLessThan(slow.ms);
  // Already there is no move at all.
  expect(handPath({ from: to, to, key: "curve" })).toEqual({ ms: 0, points: [{ t: 0, x: 600, y: 0 }] });
});

it("shoots the same take twice the same way", () => {
  const once = handPath({ from: { x: 11, y: 22 }, to: { x: 333, y: 444 }, key: '[data-undo-now="lp-lamps"]' });
  const twice = handPath({ from: { x: 11, y: 22 }, to: { x: 333, y: 444 }, key: '[data-undo-now="lp-lamps"]' });
  expect(twice).toEqual(once);
  // A different target is a different arc, so the take is not one shape reused.
  const other = handPath({ from: { x: 11, y: 22 }, to: { x: 333, y: 444 }, key: '[data-undo-now="lp-lock"]' });
  expect(other.points).not.toEqual(once.points);
});

it("the pane's pulse beats on its own, stays out of the way, and reports what it cost", async () => {
  // A fake CDP session: the pulse only ever sends one command, and the only
  // thing it does with the answer is throw it away.
  const sent: string[] = [];
  let refuse = false;
  const cdp = {
    send: async (method: string) => {
      sent.push(method);
      if (refuse) throw new Error("the page has gone away");
      return { data: "" };
    },
  };
  let busy = false;
  const pulse = keepPainting({}, { cdp, everyMs: 5, busy: () => busy });
  await new Promise(r => setTimeout(r, 60));
  const beating = sent.length;
  expect(beating).toBeGreaterThan(3);
  expect(sent.every(m => m === "Page.captureScreenshot")).toBe(true);

  // While a beat is taking its stills, the pulse sends nothing at all.
  busy = true;
  await new Promise(r => setTimeout(r, 60));
  expect(sent.length).toBe(beating);

  // And a page that has gone away is counted, not thrown.
  busy = false;
  refuse = true;
  await new Promise(r => setTimeout(r, 40));
  const out = await pulse.stop();
  expect(out.everyMs).toBe(5);
  expect(out.beats).toBe(beating);
  expect(out.failed).toBeGreaterThan(0);
  // And it stays stopped.
  const after = sent.length;
  await new Promise(r => setTimeout(r, 30));
  expect(sent.length).toBe(after);
});

it("the pulse's default period is a frame and a half, so the lag it adds is under two", () => {
  expect(PULSE_MS).toBeLessThanOrEqual(Math.round(1000 / 60) * 2);
  expect(PULSE_MS).toBeGreaterThan(0);
});
