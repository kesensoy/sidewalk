import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_COMMAND, NOTHING_LEFT, NOTHING_OPEN, SECRET_DOTS, STOP_COMMAND, TOKEN_COMMAND, WALK_CLOSED, applyChoices, groupItems, itemState, needsText, needsTokenLine, questionSections, renderEmpty, renderFirstRun, renderTokenNotice, renderVersionNotice, renderWalk, restoreFocus, snapshotFocus, syncVerdictButtons, tokenSay } from "./render.js";
import type { Item, Verdict } from "sidewalk-walkd/schema";

const look = (id: string, seq: number, group?: string): Item => ({ id, seq, group, kind: "look", owner: "g", title: `T${id}`, url: "http://x/", do: "do", see: "see", pass: "pass", expect: [], addedAt: "2026-09-16T00:00:00Z" });
const v = (itemId: string, kind: Verdict["kind"], seq: number): Verdict => ({ itemId, kind, text: "t", nonce: "n", seq, at: "", context: { url: "", viewport: [1, 1], console: [], userAgent: "", screenshot: null } });

describe("render helpers", () => {
  it("groups newest group first, seq order inside", () => {
    const g = groupItems([look("a", 1, "pack"), look("b", 2, "lane:x"), look("c", 3, "pack")]);
    expect(g.map(([k]) => k)).toEqual(["lane:x", "pack"]);
    expect(g[1][1].map(i => i.id)).toEqual(["a", "c"]);
  });
  it("derives item state from verdicts", () => {
    const a = look("a", 1);
    expect(itemState(a, [])).toBe("new");
    expect(itemState(a, [v("a", "blocked", 1)])).toBe("blocked");
    expect(itemState(a, [v("a", "blocked", 1), v("a", "pass", 2)])).toBe("answered");
    // A Go that passed after the blocked line clears it; a newer blocked line re-blocks.
    expect(itemState(a, [v("a", "blocked", 1)], false, 1)).toBe("new");
    expect(itemState(a, [v("a", "blocked", 1), v("a", "blocked", 2)], false, 1)).toBe("blocked");
    expect(itemState({ ...a, withdrawnAt: "x" }, [])).toBe("withdrawn");
    expect(itemState(a, [v("a", "pass", 1)], true)).toBe("refused");
    expect(itemState({ ...a, withdrawnAt: "x" }, [], true)).toBe("withdrawn");
  });
  it("renders do/see/pass, the Go button, and escapes html", () => {
    const html = renderWalk({ walk: { id: "w", project: "p", title: "Walk <11>", buildRef: "b", openedAt: "" }, items: [look("a", 1)], verdicts: [], lastSeenSeq: 0 }, { drafts: new Map() });
    expect(html).toContain("Walk &lt;11&gt;"); expect(html).toContain('data-go="a"'); expect(html).toContain(">pass<");
    expect(html).toContain('data-kind="pass"'); expect(html).toContain('data-kind="ask"');
  });
  it("paints the walk's brief under its header, escaped, and nothing when there is none", () => {
    const walk = { id: "w", project: "p", title: "Walk", buildRef: "b", openedAt: "" };
    const none = renderWalk({ walk, items: [], verdicts: [], lastSeenSeq: 0 }, { drafts: new Map() });
    expect(none).not.toContain('class="brief"');
    const some = renderWalk({ walk: { ...walk, brief: "Start on the portal. <b>Do not</b> log out." }, items: [], verdicts: [], lastSeenSeq: 0 }, { drafts: new Map() });
    expect(some).toContain('<p class="brief">Start on the portal. &lt;b&gt;Do not&lt;/b&gt; log out.</p>');
    expect(some.indexOf('class="meta"')).toBeLessThan(some.indexOf('class="brief"'));
  });
  it("puts Go on the link row above do/see/pass, once, and keeps it when there is no link", () => {
    // The owner, 2026-09-17: "if the link is at the top of the card maybe the Go
    // button should be near the top too/instead?" Instead: get there, then read
    // what to do, then judge. One Go, and it does not depend on the link.
    const state = { walk: { id: "w", project: "p", title: "W", buildRef: "b", openedAt: "" }, verdicts: [], lastSeenSeq: 0 };
    const html = renderWalk({ ...state, items: [look("a", 1)] }, { drafts: new Map() });
    expect(html.indexOf('data-go="a"')).toBeLessThan(html.indexOf("<dl>"));
    expect(html.match(/data-go="a"/g)).toHaveLength(1);
    expect(html).toMatch(/<p class="url"><a [^>]*>http:\/\/x\/<\/a><button data-go="a">Go<\/button><\/p>/);
    const noLink = renderWalk({ ...state, items: [{ ...look("a", 1), url: "javascript:alert(1)" }] }, { drafts: new Map() });
    expect(noLink).not.toContain("<a ");
    expect(noLink).toContain('<p class="url"><button data-go="a">Go</button></p>');
  });
  it("renders a sequence as one card: link row, numbered do→see steps with ticks, one note, one set of buttons", () => {
    const seq: Item = { id: "s", seq: 1, kind: "sequence", owner: "g", title: "Lock", url: "http://x/", addedAt: "",
      steps: [{ do: "Press Go.", see: "Booked for an hour." }, { do: "Open another.", see: "Booked line." }, { do: "Request one.", see: "Booked line, no ping." }],
      pass: "The lock held.", expect: [] };
    const state = { walk: { id: "w", project: "p", title: "W", buildRef: "b", openedAt: "" }, verdicts: [], lastSeenSeq: 0, items: [seq] };
    const html = renderWalk(state, { drafts: new Map(), ticks: new Map([["s", [true, false, false]]]) });
    expect(html.match(/data-go="s"/g)).toHaveLength(1);
    expect(html).not.toContain("<dt>do</dt>");
    expect(html.match(/<li class="step">/g)).toHaveLength(3);
    expect(html).toMatch(/<input type="checkbox" data-step="0" data-for="s" checked>/);
    expect(html).toMatch(/<input type="checkbox" data-step="1" data-for="s">/);
    expect(html).toContain("Press Go.");
    expect(html).toContain("Booked for an hour.");
    expect(html).toContain("The lock held.");
    expect(html.match(/<textarea data-note="s"/g)).toHaveLength(1);
    for (const k of ["pass", "pass-note", "issue", "skip", "ask"]) expect(html.match(new RegExp(`data-kind="${k}" data-for="s"`, "g"))).toHaveLength(1);
    // Answered: the verdict line says how far the steps got.
    const done = renderWalk({ ...state, verdicts: [{ ...v("s", "issue", 1), text: "third never came", steps: [true, true, false] }] }, { drafts: new Map() });
    expect(done).toContain("third never came");
    expect(done).toContain("2 of 3 steps");
  });
  it("puts Undo on every answered card: green while the agent has not read it, red with a confirm once it has", () => {
    const a = look("a", 1);
    const base = { walk: { id: "w", project: "p", title: "W", buildRef: "b", openedAt: "", delivered: 1 }, items: [a], lastSeenSeq: 0 };
    // seq 2 > delivered 1: the agent has not been handed it yet.
    const green = renderWalk({ ...base, verdicts: [v("a", "issue", 2)] }, { drafts: new Map() });
    expect(green).toMatch(/<button class="free" data-undo-now="a">Undo<\/button>/);
    expect(green).not.toContain('data-undo="a"');
    // seq 1 ≤ delivered 1: the agent has it; this is the loud one.
    const red = renderWalk({ ...base, verdicts: [v("a", "issue", 1)] }, { drafts: new Map() });
    expect(red).toMatch(/<button class="danger" data-undo="a">Undo<\/button>/);
    const confirming = renderWalk({ ...base, verdicts: [v("a", "issue", 1)] }, { drafts: new Map(), confirming: new Set(["a"]) });
    expect(confirming).toContain('data-undo-confirm="a"');
    // A verdict the daemon has not acknowledged yet (seq -1) is free too.
    const local = renderWalk({ ...base, verdicts: [v("a", "pass", -1)] }, { drafts: new Map() });
    expect(local).toContain('data-undo-now="a"');
    // No delivered on the header at all (older daemon): treat as unread.
    const old = renderWalk({ ...base, walk: { ...base.walk, delivered: undefined }, verdicts: [v("a", "pass", 1)] }, { drafts: new Map() });
    expect(old).toContain('data-undo-now="a"');
  });
  it("drops a card into the Done shelf once the agent has read its verdict, and holds it on the ledge before", () => {
    const items = [look("a", 1, "site"), look("b", 2, "site"), { ...look("c", 3, "site"), withdrawnAt: "x", withdrawReason: "moved" }];
    const walk = { id: "w", project: "p", title: "W", buildRef: "b", openedAt: "", delivered: 1 };
    // a answered at seq 1 (read), b answered at seq 2 (not yet read), c withdrawn.
    const html = renderWalk({ walk, items, verdicts: [v("a", "pass", 1), v("b", "issue", 2)], lastSeenSeq: 0 }, { drafts: new Map() });
    const shelf = html.slice(html.indexOf('class="group shelf"'), html.indexOf('class="ledge"'));
    // The heading carries the count at the right of its own line (design v3).
    expect(shelf).toContain(`<h2>Done<span class="count">2</span></h2>`);
    expect(shelf).toContain('data-item="a"');
    expect(shelf).toContain('data-item="c"');
    expect(shelf).not.toContain('data-item="b"');
    // b is on the ledge with the free Undo and out of its group; a's red Undo
    // is on the shelf.
    const site = html.slice(html.indexOf("<h2>site</h2>"), html.indexOf('class="group shelf"'));
    expect(site).not.toContain('data-item="b"');
    expect(site).not.toContain('data-item="a"');
    const ledge = html.slice(html.indexOf('class="ledge"'));
    expect(ledge).toContain('data-item="b"');
    expect(ledge).toContain('data-undo-now="b"');
    expect(shelf).toContain('data-undo="a"');
    // Nothing done: no shelf at all.
    expect(renderWalk({ walk, items: [look("a", 1)], verdicts: [], lastSeenSeq: 0 }, { drafts: new Map() })).not.toContain("shelf");
  });
  it("puts an answered card the agent has not read on the ledge, newest on top, and keeps the ledge out of the DOM when nothing is green", () => {
    // The owner, 2026-09-23: "while the undo is still green … collapse and pin and
    // stick to the screen for a bit". The green ones are the ledge's; the read
    // ones are the shelf's; nothing green, no ledge.
    const walk = { id: "w", project: "p", title: "W", buildRef: "b", openedAt: "", delivered: 0 };
    const items = ["a", "b", "c", "d", "e"].map((id, n) => look(id, n + 1, "site"));
    // Four green rows: past the three the ledge shows at once, which is a
    // height in the stylesheet and not a cap on what is rendered.
    const view = { walk, items, verdicts: [v("a", "pass", 1), v("b", "issue", 2), v("c", "skip", 3), v("d", "decision", 4)], lastSeenSeq: 5 };
    const html = renderWalk(view, { drafts: new Map() });
    const ledge = html.slice(html.indexOf('<section class="ledge"'));
    // All four, as the list's own one-line answered rendering: the word, the
    // title, the green Undo — and the fifth card still in its group.
    expect(ledge.match(/class="item answered v-\w+ on-ledge"/g)).toHaveLength(4);
    expect(ledge).toContain('<p class="verdict"><b>Issue</b> Tb <span class="w">t</span></p>');
    expect(ledge.match(/data-undo-now="[a-d]"/g)).toHaveLength(4);
    expect(ledge).not.toContain('data-item="e"');
    expect(html.slice(0, html.indexOf('<section class="ledge"'))).toContain('data-item="e"');
    // Newest on top, and the ledge is the last thing in the walk.
    expect([...ledge.matchAll(/data-item="(\w)"/g)].map(m => m[1])).toEqual(["d", "c", "b", "a"]);
    expect(html.indexOf('<section class="ledge"')).toBeGreaterThan(html.indexOf('class="group"'));
    expect(html.trimEnd().endsWith("</section>")).toBe(true);
    // A verdict the daemon has not acknowledged (seq -1) is the newest there is.
    const local = renderWalk({ ...view, verdicts: [...view.verdicts, v("e", "pass", -1)] }, { drafts: new Map() });
    const order = local.slice(local.indexOf('<section class="ledge"'));
    expect([...order.matchAll(/data-item="(\w)"/g)].map(m => m[1])).toEqual(["e", "d", "c", "b", "a"]);
    // Read by the agent: off the ledge, onto the shelf, red Undo and all.
    const read = renderWalk({ ...view, walk: { ...walk, delivered: 4 } }, { drafts: new Map() });
    expect(read).not.toContain('class="ledge"');
    expect(read).not.toContain("data-undo-now");
    const shelf = read.slice(read.indexOf('class="group shelf"'));
    for (const id of ["a", "b", "c", "d"]) expect(shelf).toContain(`data-item="${id}"`);
    // Nothing green at all: no ledge in the DOM.
    expect(renderWalk({ walk, items, verdicts: [], lastSeenSeq: 4 }, { drafts: new Map() })).not.toContain("ledge");
  });
  it("draws the drain bar from the verdict's at against the daemon's window, and no bar without one", () => {
    const walk = { id: "w", project: "p", title: "W", buildRef: "b", openedAt: "", delivered: 0 };
    const at = "2026-09-23T03:00:00.000Z";
    const bar = (opts: { now?: number; graceMs?: number }) => {
      const html = renderWalk({ walk, items: [look("a", 1)], verdicts: [{ ...v("a", "pass", 1), at }], lastSeenSeq: 1 }, { drafts: new Map(), ...opts });
      return /<div class="drain" data-drain="[^"]*" style="width:([\d.]+)%"><\/div>/.exec(html)?.[1] ?? null;
    };
    const t = (ms: number) => Date.parse(at) + ms;
    expect(bar({ now: t(0), graceMs: 10_000 })).toBe("100");
    expect(bar({ now: t(2_500), graceMs: 10_000 })).toBe("75");
    expect(bar({ now: t(9_900), graceMs: 10_000 })).toBe("1");
    // It stops at empty and stays there: the row leaves on the read, not on a
    // timer, so a matured window is an empty bar and a card still to take back.
    expect(bar({ now: t(60_000), graceMs: 10_000 })).toBe("0");
    // A clock that is behind the daemon's cannot overfill it.
    expect(bar({ now: t(-5_000), graceMs: 10_000 })).toBe("100");
    // No window said (an older daemon), and a window switched off: no bar. The
    // row is still there, and still free to take back.
    for (const graceMs of [undefined, 0]) {
      expect(bar({ now: t(0), graceMs })).toBeNull();
      const html = renderWalk({ walk, items: [look("a", 1)], verdicts: [{ ...v("a", "pass", 1), at }], lastSeenSeq: 1 }, { drafts: new Map(), now: t(0), graceMs });
      expect(html).toContain('class="ledge"');
      expect(html).toContain('data-undo-now="a"');
      expect(html).not.toContain("drain");
    }
    // A verdict with no readable timestamp has nothing to drain from.
    const noAt = renderWalk({ walk, items: [look("a", 1)], verdicts: [v("a", "pass", 1)], lastSeenSeq: 1 }, { drafts: new Map(), graceMs: 10_000 });
    expect(noAt).toContain('class="ledge"');
    expect(noAt).not.toContain("drain");
    // The bar is the row's last child, under the line and its Undo.
    const row = renderWalk({ walk, items: [look("a", 1)], verdicts: [{ ...v("a", "pass", 1), at }], lastSeenSeq: 1 }, { drafts: new Map(), now: t(0), graceMs: 10_000 });
    expect(row).toMatch(/data-undo-now="a">Undo<\/button><\/div><div class="drain"[^>]*><\/div><\/article>/);
  });
  it("adds a second warning with the elapsed time when a long-held answer is being undone", () => {
    const a = look("a", 1);
    const walk = { id: "w", project: "p", title: "W", buildRef: "b", openedAt: "", delivered: 1 };
    const at = "2026-09-18T03:00:00.000Z";
    const html = (minutesLater: number) => renderWalk(
      { walk, items: [a], verdicts: [{ ...v("a", "pass", 1), at }], lastSeenSeq: 0 },
      { drafts: new Map(), confirming: new Set(["a"]), now: Date.parse(at) + minutesLater * 60_000 });
    expect(html(2)).not.toContain("Are you really sure?");
    expect(html(2)).toContain("Undo this answer?");
    expect(html(42)).toContain("Are you really sure? Automated work built on this answer across the last 42 min may be destroyed.");
    expect(html(42).match(/data-undo-confirm="a"/g)).toHaveLength(1);
    expect(html(42)).toContain('data-undo-cancel="a"');
    expect(html(3 * 60 + 5)).toContain("across the last 3 h 5 min");
    expect(html(26 * 60)).toContain("across the last 1 d 2 h");
    // The free Undo never warns: nothing was built on it yet.
    const free = renderWalk({ walk: { ...walk, delivered: 0 }, items: [a], verdicts: [{ ...v("a", "pass", 1), at }], lastSeenSeq: 0 },
      { drafts: new Map(), confirming: new Set(["a"]), now: Date.parse(at) + 60 * 60_000 });
    expect(free).not.toContain("Are you really sure?");
  });
  it("says so when there is nothing to walk: no walk open, nothing left, or the walk is closed", () => {
    expect(renderEmpty()).toBe(`<p class="nothing">${NOTHING_OPEN}</p>`);
    const walk = { id: "w", project: "p", title: "W", buildRef: "b", openedAt: "", delivered: 1 };
    const a = look("a", 1);
    const allDone = renderWalk({ walk, items: [a], verdicts: [v("a", "pass", 1)], lastSeenSeq: 0 }, { drafts: new Map() });
    expect(allDone).toContain(`<p class="empty">${NOTHING_LEFT}</p>`);
    expect(allDone.indexOf('class="empty"')).toBeLessThan(allDone.indexOf('class="group shelf"'));
    const closed = renderWalk({ walk: { ...walk, closedAt: "x" }, items: [a], verdicts: [v("a", "pass", 1)], lastSeenSeq: 0 }, { drafts: new Map() });
    expect(closed).toContain(WALK_CLOSED);
    expect(closed).not.toContain(NOTHING_LEFT);
    const live = renderWalk({ walk, items: [a, look("b", 2)], verdicts: [v("a", "pass", 1)], lastSeenSeq: 0 }, { drafts: new Map() });
    expect(live).not.toContain('class="empty"');
    // A walk with no items at all is empty too, not blank.
    expect(renderWalk({ walk, items: [], verdicts: [], lastSeenSeq: 0 }, { drafts: new Map() })).toContain(NOTHING_LEFT);
  });
  it("marks the card whose Go was pressed last as current, until it is answered", () => {
    const walk = { id: "w", project: "p", title: "W", buildRef: "b", openedAt: "" };
    const items = [look("a", 1), look("b", 2)];
    const on = renderWalk({ walk, items, verdicts: [], lastSeenSeq: 0, current: "b" }, { drafts: new Map() });
    expect(on).toMatch(/<article class="item new[^"]*current" data-item="b"/);
    expect(on).not.toMatch(/<article class="item[^"]*current" data-item="a"/);
    // Answered: no longer current even if the worker's mark lingers.
    const answered = renderWalk({ walk, items, verdicts: [v("b", "pass", 1)], lastSeenSeq: 0, current: "b" }, { drafts: new Map() });
    expect(answered).not.toContain("current");
    // Blocked keeps it: the person is still on that card.
    const blocked = renderWalk({ walk, items, verdicts: [v("b", "blocked", 1)], lastSeenSeq: 0, current: "b" }, { drafts: new Map() });
    expect(blocked).toMatch(/<article class="item blocked[^"]*current" data-item="b"/);
    // No Go yet: nothing is current.
    expect(renderWalk({ walk, items, verdicts: [], lastSeenSeq: 0 }, { drafts: new Map() })).not.toContain("current");
  });
  it("stamps the walk id on its header and on every group", () => {
    // Two walks paint into one list, so which walk a card belongs to has to be
    // readable off the DOM, not inferred from whichever header sits above it.
    const html = renderWalk({ walk: { id: "walk-b", project: "p", title: "t", buildRef: "b", openedAt: "" }, items: [look("a", 1, "lane:x")], verdicts: [], lastSeenSeq: 0 }, { drafts: new Map() });
    expect(html).toContain('<header data-walk-id="walk-b">');
    expect(html).toContain('<section class="group" data-walk-id="walk-b">');
  });
  it("renders a question with options and Other, and an info card with Dismiss", () => {
    const q: Item = { id: "q", seq: 1, kind: "question", owner: "g", title: "Tier", eli5: "e", proposal: "p", why: "w", downsides: ["d1"], facts: "f", recommendation: "r", options: ["A", "B"], costIfWrong: "c", addedAt: "" };
    const i: Item = { id: "i", seq: 2, kind: "info", owner: "g", title: "Closed", body: "b", addedAt: "" };
    const html = renderWalk({ walk: { id: "w", project: "p", title: "t", buildRef: "b", openedAt: "" }, items: [q, i], verdicts: [], lastSeenSeq: 0 }, { drafts: new Map() });
    expect(html).toContain('value="A"'); expect(html).toContain('value="__other"'); expect(html).toContain("Dismiss");
  });
  it("names a verdict in words, never by its raw kind", () => {
    const a = look("a", 1);
    const html = renderWalk({ walk: { id: "w", project: "p", title: "t", buildRef: "b", openedAt: "" }, items: [a], verdicts: [v("a", "pass-note", 1)], lastSeenSeq: 1 }, { drafts: new Map() });
    // Design v3: on the line "Pass, with a note" collapses to Pass, because the
    // note is the trailing words and that is what "with a note" meant.
    expect(html).toContain("<b>Pass</b>");
    expect(html).not.toContain("Pass, with a note");
    expect(html).not.toContain("pass-note");
  });
  it("heads a blocked card in words and keeps the diagnostic in a code line", () => {
    const a = look("a", 1);
    const diag = 'expect failed: {"kind":"url"}; seen: http://x/';
    const html = renderWalk({ walk: { id: "w", project: "p", title: "t", buildRef: "b", openedAt: "" }, items: [a], verdicts: [{ ...v("a", "blocked", 1), text: diag }], lastSeenSeq: 1 }, { drafts: new Map() });
    expect(html).toContain("Not ready here");
    expect(html).toContain("<code>expect failed: {&quot;kind&quot;:&quot;url&quot;}; seen: http://x/</code>");
  });
});

describe("a verdict the daemon refused", () => {
  const walk = { id: "w", project: "p", title: "t", buildRef: "b", openedAt: "" };
  it("says so on the card and gives the buttons back", () => {
    const a = look("a", 1);
    const html = renderWalk({ walk, items: [a], verdicts: [v("a", "issue", 1)], lastSeenSeq: 1 }, { drafts: new Map(), refused: new Set(["a"]) });
    expect(html).toContain("Refused by the walk server. Answer this one again.");
    expect(html).toContain('data-kind="issue"');
    expect(html).toContain('data-go="a"');
    expect(html).toContain("item refused");
    expect(html).not.toContain('class="verdict"');
  });
  it("does the same for an info card, which keeps its Dismiss", () => {
    const i: Item = { id: "i", seq: 1, kind: "info", owner: "g", title: "Closed", body: "b", addedAt: "" };
    const html = renderWalk({ walk, items: [i], verdicts: [v("i", "dismiss", 1)], lastSeenSeq: 1 }, { drafts: new Map(), refused: new Set(["i"]) });
    expect(html).toContain("Refused by the walk server. Answer this one again.");
    expect(html).toContain("Dismiss");
  });
  it("leaves the other items answered", () => {
    const [a, b] = [look("a", 1), look("b", 2)];
    const html = renderWalk({ walk, items: [a, b], verdicts: [v("a", "pass", 1), v("b", "pass", 2)], lastSeenSeq: 2 }, { drafts: new Map(), refused: new Set(["a"]) });
    expect(html).toContain("item refused");
    expect(html).toContain("item answered");
    expect((html.match(/Refused by the walk server/g) ?? []).length).toBe(1);
  });
});

describe("state that must survive a repaint", () => {
  it("re-applies the chosen option", () => {
    document.body.innerHTML = `<input type="radio" name="opt-q1" value="A"><input type="radio" name="opt-q1" value="B">`;
    applyChoices(document, { options: new Map([["q1", "B"]]) });
    const [a, b] = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect([a.checked, b.checked]).toEqual([false, true]);
  });
  it("puts the cursor back in the note it was in", () => {
    document.body.innerHTML = `<textarea data-note="a">hello</textarea><textarea data-note="b"></textarea>`;
    const ta = document.querySelector<HTMLTextAreaElement>('[data-note="a"]')!;
    ta.focus(); ta.setSelectionRange(2, 4);
    const snap = snapshotFocus(document);
    document.body.innerHTML = `<textarea data-note="a">hello</textarea><textarea data-note="b"></textarea>`;
    restoreFocus(document, snap);
    const next = document.querySelector<HTMLTextAreaElement>('[data-note="a"]')!;
    expect(document.activeElement).toBe(next);
    expect([next.selectionStart, next.selectionEnd]).toEqual([2, 4]);
  });
  it("snapshots nothing when the focus was not in a note", () => {
    document.body.innerHTML = `<button>Go</button>`;
    expect(snapshotFocus(document)).toBeNull();
    expect(() => restoreFocus(document, null)).not.toThrow();
  });
});

describe("a question carries only the sections it has", () => {
  const walk = { id: "w", project: "p", title: "t", buildRef: "b", openedAt: "" };
  const bare = (extra: Partial<Item> = {}): Item => ({ id: "q", seq: 1, kind: "question", owner: "g", title: "Keep the 30 second worst case?", options: ["Keep it", "Add a notification"], addedAt: "", ...extra } as Item);
  const html = (i: Item) => renderWalk({ walk, items: [i], verdicts: [], lastSeenSeq: 0 }, { drafts: new Map() });

  it("lists the present sections in the sheet's order, and no others", () => {
    expect(questionSections(bare({ why: "w", eli5: "e", costIfWrong: "c" } as Partial<Item>)).map(s => s.label)).toEqual(["eli5", "why", "cost if wrong"]);
    expect(questionSections(bare())).toEqual([]);
  });

  it("renders no dl at all for a title and its options", () => {
    const out = html(bare());
    expect(out).not.toContain("<dl>");
    expect(out).toContain("Keep the 30 second worst case?");
    expect(out).toContain('value="Keep it"');
  });

  it("drops the label when one section is the whole body", () => {
    const out = html(bare({ proposal: "Leave it. A shorter alarm costs battery." } as Partial<Item>));
    expect(out).not.toContain("<dl>");
    expect(out).not.toContain("<dt>proposal</dt>");
    expect(out).toContain("Leave it. A shorter alarm costs battery.");
  });

  it("labels them once there are two", () => {
    const out = html(bare({ proposal: "Leave it.", facts: "Chrome caps alarms at 30 s." } as Partial<Item>));
    expect(out).toContain("<dl>");
    expect(out).toContain("<dt>proposal</dt>");
    expect(out).toContain("<dt>facts</dt>");
    expect(out).not.toContain("<dt>why</dt>");
  });

  it("tags the first option as the recommended one, and only the first", () => {
    const out = html(bare());
    expect(out).toContain("Recommended");
    expect((out.match(/Recommended/g) ?? []).length).toBe(1);
    expect(out.indexOf("Recommended")).toBeGreaterThan(out.indexOf('value="Keep it"'));
    expect(out.indexOf("Recommended")).toBeLessThan(out.indexOf('value="Add a notification"'));
  });

  it("keeps an empty downsides list out of the card", () => {
    expect(questionSections(bare({ downsides: [] } as Partial<Item>))).toEqual([]);
    expect(questionSections(bare({ downsides: ["one"] } as Partial<Item>)).map(s => s.label)).toEqual(["downsides"]);
  });
});

describe("Ask is a button, not a tickbox", () => {
  // The owner: "What is your intent behind the tickbox for ask the agent?
  // considering we have issue, pass with note, and skip, all with the text
  // field there." It was a modifier on four verdicts; it is a fifth verdict.
  const walk = { id: "w", project: "p", title: "t", buildRef: "b", openedAt: "" };
  const askV = (itemId: string, seq: number, text: string): Verdict => ({ ...v(itemId, "ask", seq), text });

  it("puts Ask beside Skip on a look card and drops the tickbox", () => {
    const out = renderWalk({ walk, items: [look("a", 1)], verdicts: [], lastSeenSeq: 0 }, { drafts: new Map() });
    expect(out).toContain('data-kind="ask"');
    expect(out).not.toContain("data-ask=");
    expect(out).not.toContain("Ask the agent");
    expect(out.indexOf('data-kind="ask"')).toBeGreaterThan(out.indexOf('data-kind="skip"'));
  });

  it("puts Ask beside Submit on a question card", () => {
    const q: Item = { id: "q", seq: 1, kind: "question", owner: "g", title: "Tier", options: ["A", "B"], addedAt: "" } as Item;
    const out = renderWalk({ walk, items: [q], verdicts: [], lastSeenSeq: 0 }, { drafts: new Map() });
    expect(out).toContain('data-kind="ask"');
    expect(out.indexOf('data-kind="ask"')).toBeGreaterThan(out.indexOf('data-kind="decision"'));
  });

  it("says the question is with the agent, and leaves the card answerable", () => {
    const a = look("a", 1);
    const out = renderWalk({ walk, items: [a], verdicts: [askV("a", 1, "which build is this?")], lastSeenSeq: 1 }, { drafts: new Map() });
    expect(out).toContain("Asked. Waiting for the agent.");
    expect(out).toContain('data-kind="pass"');
    expect(out).toContain('data-go="a"');
    expect(out).not.toContain('class="verdict"');
  });

  it("leaves an item that was asked about in its answerable state", () => {
    const a = look("a", 1);
    expect(itemState(a, [askV("a", 1, "q")])).toBe("new");
    expect(itemState(a, [askV("a", 1, "q"), v("a", "pass", 2)])).toBe("answered");
    expect(itemState(a, [v("a", "pass", 1), askV("a", 2, "q")])).toBe("new");
  });
});

describe("waiting on the agent: the kerb says it too", () => {
  // The owner, 2026-10-04: "when you hit ask and it says 'Asked. Waiting for the
  // agent.' can we do like a pulsing yellow thing or put a left-pane color
  // thing or SOMETHING to indicate it's waiting? in addition to that text of
  // course." The line is untouched; the kerb goes yellow and breathes, and the
  // line grows the header's dot in the same yellow.
  const walk = { id: "w", project: "p", title: "t", buildRef: "b", openedAt: "" };
  const askV = (itemId: string, seq: number): Verdict => ({ ...v(itemId, "ask", seq), text: "which build?" });
  const blockedV = (itemId: string, seq: number): Verdict => ({ ...v(itemId, "blocked", seq), text: "expect failed" });
  const render = (verdicts: Verdict[], item: Item = look("a", 1), current?: string) =>
    renderWalk({ walk, items: [item], verdicts, lastSeenSeq: 9, current }, { drafts: new Map() });
  /** The card's own class list, so the dot's `waiting` can never stand in for the kerb's. */
  const noWaitingKerb = /class="item(?![^"]*waiting)/;

  it("paints the waiting kerb and the breathing dot while the ask is open", () => {
    const out = render([askV("a", 1)]);
    expect(out).toContain('class="item new waiting"');
    expect(out).toContain(`<p class="asked"><span class="dot waiting" aria-hidden="true"></span>Asked. Waiting for the agent.</p>`);
  });

  it("hands the kerb to the verdict once the person answers it", () => {
    // The line's own lifetime, unchanged: the next answer on the card ends it.
    const out = render([askV("a", 1), v("a", "pass", 2)]);
    expect(out).toContain("v-pass");
    expect(out).toMatch(noWaitingKerb);
    expect(out).not.toContain("waiting");
    expect(out).not.toContain("Asked. Waiting for the agent.");
  });

  it("is outranked by blocked, which keeps the line and the dot", () => {
    // Both are true at once — the question is with the agent and the page is
    // not ready — so the words say both and only the 4 px of edge chooses.
    const out = render([askV("a", 1), blockedV("a", 2)]);
    expect(out).toContain('class="item new blocked"');
    expect(out).toMatch(noWaitingKerb);
    expect(out).toContain("Not ready here");
    expect(out).toContain('<span class="dot waiting" aria-hidden="true"></span>Asked. Waiting for the agent.');
  });

  it("outranks current on the same card, and keeps it: an asked card stays where you are", () => {
    const out = render([askV("a", 1)], look("a", 1), "a");
    expect(out).toContain('class="item new waiting current"');
  });

  it("goes with the line when the agent withdraws the item", () => {
    // One of the three things that end the line, with the person's own answer
    // and the agent's reply (below). Reading the ask is not one of them.
    const out = render([askV("a", 1)], { ...look("a", 1), withdrawnAt: "x", withdrawReason: "moot now" });
    expect(out).toMatch(noWaitingKerb);
    expect(out).not.toContain("waiting");
    expect(out).not.toContain("Asked. Waiting for the agent.");
  });

  it("does not wait on a walk server that refused the ask", () => {
    const out = renderWalk({ walk, items: [look("a", 1)], verdicts: [askV("a", 1)], lastSeenSeq: 9 }, { drafts: new Map(), refused: new Set(["a"]) });
    expect(out).toContain('class="item refused"');
    expect(out).toMatch(noWaitingKerb);
  });

  it("is painted after current and before blocked, which is where the precedence lives", () => {
    // The renderer puts `waiting` and `current` on the same card and lets the
    // stylesheet choose; source order is that choice, so it is pinned here.
    // Spelled out rather than `new URL("./panel.css", import.meta.url)`: vite
    // rewrites that pattern into an asset URL, which `readFileSync` cannot open.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "panel.css"), "utf8");
    expect(css.indexOf(".item.current{")).toBeLessThan(css.indexOf(".item.waiting{"));
    expect(css.indexOf(".item.waiting{")).toBeLessThan(css.indexOf(".item.blocked{"));
    // One rhythm for both kerbs, one for both dots, and all of it off when asked.
    expect(css).toContain("--kerb-breath:var(--waiting)");
    expect(css).toMatch(/\.item\.waiting\{[^}]*animation:kerb 3\.2s cubic-bezier\(\.45,0,\.55,1\) infinite alternate\}/);
    expect(css).toMatch(/\.dot\.waiting\{[^}]*animation:breathe 2\.4s cubic-bezier\(\.45,0,\.55,1\) infinite alternate\}/);
    expect(css).toContain("@media (prefers-reduced-motion: reduce){.dot.on,.dot.waiting,.item.current,.item.waiting{animation:none}}");
  });
});

describe("the agent's answer lands on the card that asked", () => {
  // The owner, 2026-10-04: "i like the new pending answer thing, but then when the
  // answer is there I think it should link to the card that asked it (instead of
  // letting a card be in between with its own dismiss) and I think the color
  // indication type stuff should stop looking like it's still pending/waiting, at
  // least in the same way, because it's still pending a person but not pending
  // the same thing anymore (claude in this case)."
  const walk = { id: "w", project: "p", title: "t", buildRef: "b", openedAt: "" };
  const askV = (id: string, seq: number): Verdict => ({ ...v(id, "ask", seq), text: "is the link meant to end with a slash?" });
  const reply = (over: Partial<Item> = {}): Item =>
    ({ id: "r", seq: 2, kind: "info", owner: "g", title: "Yes, the slash is on purpose", body: "It matches the address bar.", supersedes: "a", addedAt: "", ...over }) as Item;
  const render = (items: Item[], verdicts: Verdict[], current?: string) =>
    renderWalk({ walk, items, verdicts, lastSeenSeq: 9, current }, { drafts: new Map() });
  const BLOCK = '<div class="reply"><h4>Yes, the slash is on purpose</h4><p class="body">It matches the address bar.</p></div>';

  it("stops waiting the moment the answer lands, and keeps the card answerable", () => {
    const before = render([look("a", 1)], [askV("a", 1)]);
    expect(before).toContain('class="item new waiting"');
    expect(before).toContain("Asked. Waiting for the agent.");

    const after = render([look("a", 1), reply()], [askV("a", 1)]);
    // Still pending a person — the card's own buttons and note box are what
    // resolves it — but no longer pending the agent, so the yellow and its dot go.
    expect(after).toContain('class="item new"');
    expect(after).not.toContain("waiting");
    expect(after).not.toContain("Asked. Waiting for the agent.");
    expect(after).toContain('data-kind="pass" data-for="a"');
    expect(after).toContain('data-note="a"');
  });

  it("paints it in the card, in the waiting line's place, and as a card nowhere", () => {
    const out = render([look("a", 1), reply()], [askV("a", 1)]);
    expect(out).toContain(BLOCK);
    // No card between the question and everything else, and no Dismiss — that
    // press was the one that resolved nothing.
    expect(out).not.toContain('data-item="r"');
    expect(out).not.toContain('data-for="r"');
    expect(out).not.toContain("Dismiss");
    // The asked line's slot: after the note box, above the buttons.
    expect(out.indexOf('class="reply"')).toBeGreaterThan(out.indexOf('data-note="a"'));
    expect(out.indexOf('class="reply"')).toBeLessThan(out.indexOf('data-kind="pass"'));
  });

  it("shows several answers to one ask in seq order, each its own block", () => {
    const out = render([look("a", 1), reply({ id: "r2", seq: 3, title: "And one more thing" }), reply({ id: "r1", seq: 2, title: "First" })], [askV("a", 1)]);
    expect(out.indexOf("First")).toBeLessThan(out.indexOf("And one more thing"));
    expect((out.match(/class="reply"/g) ?? []).length).toBe(2);
  });

  it("hands the kerb back to what the card would otherwise be", () => {
    // Blue and breathing if this is the card whose Go was pressed last…
    expect(render([look("a", 1), reply()], [askV("a", 1)], "a")).toContain('class="item new current"');
    // …orange if a Go stopped here, which outranks everything and always did.
    const stopped = render([look("a", 1), reply()], [askV("a", 1), { ...v("a", "blocked", 3), text: "expect[0] url" }]);
    expect(stopped).toContain('class="item new blocked"');
    expect(stopped).toContain("Not ready here");
    expect(stopped).toContain(BLOCK);
  });

  it("keeps the answer on the record once the person has answered the card", () => {
    const out = renderWalk({ walk: { ...walk, delivered: 3 }, items: [look("a", 1), reply()], verdicts: [askV("a", 1), v("a", "pass", 3)], lastSeenSeq: 9 }, { drafts: new Map() });
    expect(out).toContain('class="item answered v-pass done"');
    // On the shelf row, which opens out under the pointer — the verdict and the
    // answer it was given under are one thing to read back before a red Undo.
    expect(out).toContain("<h4>Yes, the slash is on purpose</h4>");
    expect(out).toContain("It matches the address bar.");
    expect(out).not.toContain('data-item="r"');
    expect(out).not.toContain("Dismiss");
    // And the walk is over: an answer is not an item the person owes anything on.
    expect(out).toContain(NOTHING_LEFT);
  });

  it("waits again when the person asks a second time, under the answers so far", () => {
    // One early PIN exchange went several turns. An answer that landed before
    // the second question cannot be an answer to it, so the yellow comes back —
    // and the first answer stays in the card, with the new question under it,
    // which is the order the conversation happened in.
    const t = (s: number) => `2026-10-04T00:0${s}:00.000Z`;
    const ask1 = { ...askV("a", 1), at: t(1) };
    const ask2 = { ...askV("a", 3), at: t(3), text: "and the port?" };
    const first = reply({ addedAt: t(2) });
    const again = render([look("a", 1), first], [ask1, ask2]);
    expect(again).toContain('class="item new waiting"');
    expect(again).toContain(BLOCK);
    expect(again).toContain("Asked. Waiting for the agent.");
    expect(again.indexOf("Asked. Waiting for the agent.")).toBeGreaterThan(again.indexOf('class="reply"'));

    // A second answer, after the second question: nothing waiting, both blocks.
    const second = reply({ id: "r2", seq: 4, title: "Port 9350", body: "The demo site's own.", addedAt: t(4) });
    const closed = render([look("a", 1), first, second], [ask1, ask2]);
    expect(closed).not.toContain("waiting");
    expect(closed).not.toContain("Asked. Waiting for the agent.");
    expect(closed.indexOf("Yes, the slash is on purpose")).toBeLessThan(closed.indexOf("Port 9350"));
  });

  it("still waits after an answer, a pass, an undo and a fresh ask", () => {
    // The card comes back answerable on the undo and the person asks something
    // new on it; the old answer is not an answer to the new question.
    const t = (s: number) => `2026-10-04T00:0${s}:00.000Z`;
    const items = [look("a", 1), reply({ addedAt: t(2) })];
    const verdicts = [
      { ...askV("a", 1), at: t(1) }, { ...v("a", "pass", 3), at: t(3) },
      { ...v("a", "undo", 4), at: t(4) }, { ...askV("a", 5), at: t(5), text: "what about the port?" },
    ];
    const out = render(items, verdicts);
    expect(out).toContain('class="item new waiting"');
    expect(out).toContain("Asked. Waiting for the agent.");
    expect(out).toContain(BLOCK);
  });

  it("waits again when the agent withdraws its answer", () => {
    // `openAsks` says the same thing on the agent's side (ask.test.ts): the
    // answer was taken back, so the question stands. The withdrawn item keeps
    // the struck row every withdrawn item gets — that is why the card is yellow
    // again, and the record should say who took what back.
    const out = render([look("a", 1), reply({ withdrawnAt: "2026-10-04T00:01:00Z", withdrawReason: "wrong answer" })], [askV("a", 1)]);
    expect(out).toContain('class="item new waiting"');
    expect(out).toContain("Asked. Waiting for the agent.");
    expect(out).not.toContain('class="reply"');
    expect(out).toContain("<s>Yes, the slash is on purpose</s>");
  });

  it("leaves an info item that supersedes a card nobody asked about as an ordinary card", () => {
    const out = render([look("a", 1), reply()], []);
    expect(out).toContain('data-item="r"');
    expect(out).toContain("Dismiss");
    expect(out).not.toContain('class="reply"');
  });

  it("keeps a question reply as its own card, directly under the one it answers", () => {
    const q = { id: "r", seq: 3, kind: "question", owner: "g", title: "Which one should it be?", options: ["With", "Without"], supersedes: "a", group: "lane:later", addedAt: "" } as unknown as Item;
    const out = render([look("a", 1, "pack"), look("b", 2, "pack"), q], [askV("a", 1)]);
    // A question has a verdict of its own to collect, so it cannot be a block in
    // somebody else's card — but it moves out of the group it was filed in to sit
    // under the question it answers.
    expect(out.indexOf('data-item="r"')).toBeGreaterThan(out.indexOf('data-item="a"'));
    expect(out.indexOf('data-item="r"')).toBeLessThan(out.indexOf('data-item="b"'));
    expect(out).not.toContain("lane:later");
    // The waiting ends all the same: nothing is pending the agent any more.
    expect(out).not.toContain("waiting");
    expect(out).not.toContain("Asked. Waiting for the agent.");
  });

  it("keeps a chain of question replies in order, and loses none of it", () => {
    // A question reply can be asked about in turn. Every card in the chain is
    // still on the pane, in the order it answers.
    const q = (id: string, seq: number, supersedes: string) =>
      ({ id, seq, kind: "question", owner: "g", title: `Q${id}`, options: ["A", "B"], supersedes, group: "pack", addedAt: "" }) as unknown as Item;
    const out = render([look("a", 1, "pack"), q("r1", 2, "a"), q("r2", 3, "r1"), look("b", 4, "pack")], [v("a", "ask", 1), v("r1", "ask", 2)]);
    const order = ["a", "r1", "r2", "b"].map(id => out.indexOf(`data-item="${id}"`));
    expect(order.every(n => n >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it("keeps a secret the agent put on its answer reachable", () => {
    const out = render([look("a", 1), reply({ secrets: [{ label: "Status link", value: "s3cret" }] } as Partial<Item>)], [askV("a", 1)]);
    expect(out).toContain('data-copy="r"');
    expect(out).toContain(SECRET_DOTS);
    expect(out).not.toContain("s3cret");
  });

  it("says answered-and-yours in a still ink rule, and keeps it off the shelf line", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "panel.css"), "utf8");
    expect(css).toMatch(/\.reply\{[^}]*border-left:2px solid var\(--ink\)/);
    // No third rhythm. The pane's two are the dot's breath and the kerb's.
    expect(css).not.toMatch(/\.reply\{[^}]*animation/);
    expect(css).toContain(".item.done .reply{display:none}");
    expect(css).toContain(".item.done:hover .reply,.item.done:focus-within .reply{display:grid;grid-column:2/-1}");
  });
});

describe("a decision collapses to a line, and can be taken back", () => {
  // `delivered: 1`: the agent has been handed the decision, so the Undo here
  // is the loud, confirmed one. The free one is covered under "puts Undo on
  // every answered card".
  const walk = { id: "w", project: "p", title: "t", buildRef: "b", openedAt: "", delivered: 1 };
  const q: Item = { id: "q", seq: 1, kind: "question", owner: "g", title: "Keep the 30 second worst case?", options: ["Keep it", "Add a notification"], addedAt: "" } as Item;
  const decided = (text = ""): Verdict => ({ ...v("q", "decision", 1), text, option: "Keep it" });
  const html = (verdicts: Verdict[], confirming?: Set<string>) =>
    renderWalk({ walk, items: [q], verdicts, lastSeenSeq: 1 }, { drafts: new Map(), confirming });

  it("is one line naming the option, with the person's words after it", () => {
    const out = html([decided()]);
    // Design v3: a decision is the one exception to verdict-title-words — the
    // option leads and the title trails, because at 360 px the title would push
    // the option, which is the whole answer, off the line. This one has been
    // read by the agent, so it is on the shelf: the gutter mark stands in for
    // the word, in the same ink the kerb had.
    expect(out).toContain(`<p class="verdict">Keep it <span class="w">Keep the 30 second worst case?</span></p>`);
    expect(out).toContain(`class="mark mark-decision"`);
    expect(out).not.toContain("<dl>");
    expect(out).not.toContain('data-kind="decision"');
    expect(html([decided("the badge is a courtesy")])).toContain("the badge is a courtesy");
    // Still the person's (the agent has not been handed it): the word leads.
    const unread = renderWalk({ walk: { ...walk, delivered: 0 }, items: [q], verdicts: [decided()], lastSeenSeq: 1 }, { drafts: new Map() });
    expect(unread).toContain(`<b>Decided</b> Keep it <span class="w">Keep the 30 second worst case?</span>`);
  });

  it("carries an Undo button beside it", () => {
    const out = html([decided()]);
    expect(out).toContain('data-undo="q"');
    expect(out).toContain(">Undo<");
    expect(out).not.toContain("data-undo-confirm");
  });

  it("asks in the card, not in a browser dialog, before it files anything", () => {
    const out = html([decided()], new Set(["q"]));
    expect(out).toContain("Undo this answer? The agent already has it and will be told to unwind; work built on it may change.");
    expect(out).toContain('data-undo-confirm="q"');
    expect(out).toContain('data-undo-cancel="q"');
    expect(out).toContain(">Keep<");
  });

  it("puts the card back, with the previous choice picked", () => {
    const undone: Verdict = { ...v("q", "undo", 2), text: "", option: "Keep it" };
    expect(itemState(q, [decided(), undone])).toBe("new");
    const out = html([decided(), undone]);
    expect(out).toContain('data-kind="decision"');
    expect(out).toContain('value="Keep it" checked');
    expect(out).not.toContain('value="Add a notification" checked');
    expect(out).not.toContain('class="verdict"');
  });

  it("says Other on the line, never the token the wire uses", () => {
    // `__other` is how the agent is told they picked Other rather than one of
    // its options; on the card it read `Decided: __other`, which is a machine
    // word in front of the person — the thing 0.1.1 went out to stop.
    const out = html([{ ...v("q", "decision", 1), text: "neither, cap it at ten", option: "__other" }]);
    expect(out).toContain(`<p class="verdict">Other <span class="w">`);
    expect(out).not.toContain("__other");
    expect(out).toContain("neither, cap it at ten");
  });

  it("offers the same confirmed Undo on an answered look once the agent has read it", () => {
    const a = look("a", 1);
    const out = renderWalk({ walk, items: [a], verdicts: [v("a", "pass", 1)], lastSeenSeq: 1 }, { drafts: new Map() });
    expect(out).toContain('data-undo="a"');
    expect(out).not.toContain("data-undo-now");
  });
});

describe("the note box is the person's, and nothing else's", () => {
  // Seq 7 of the owner's first walk is an `issue` whose text is the machine
  // diagnostic from the `blocked` verdicts above it, word for word. The note
  // box must never carry anything a verdict put there.
  const walk = { id: "w", project: "p", title: "t", buildRef: "b", openedAt: "" };
  const diag = 'expect failed: {"kind":"text","css":"meta[name=build]","attr":"content","equals":"fix-999"}; seen: fix-002';

  it("leaves a blocked card's textarea empty, diagnostic and all", () => {
    const a = look("stale", 1);
    document.body.innerHTML = renderWalk({ walk, items: [a], verdicts: [{ ...v("stale", "blocked", 1), text: diag }], lastSeenSeq: 1 }, { drafts: new Map() });
    const ta = document.querySelector<HTMLTextAreaElement>('textarea[data-note="stale"]')!;
    expect(ta.value).toBe("");
    expect(document.querySelector(".diag code")!.textContent).toBe(diag);
  });

  it("leaves it empty after any verdict that hands the card back", () => {
    const a = look("a", 1);
    for (const kind of ["blocked", "ask"] as const) {
      document.body.innerHTML = renderWalk({ walk, items: [a], verdicts: [{ ...v("a", kind, 1), text: "words from a verdict" }], lastSeenSeq: 1 }, { drafts: new Map() });
      expect(document.querySelector<HTMLTextAreaElement>("textarea[data-note]")!.value).toBe("");
    }
  });

  it("carries the human's own draft back, and only that", () => {
    const a = look("a", 1);
    document.body.innerHTML = renderWalk({ walk, items: [a], verdicts: [], lastSeenSeq: 1 }, { drafts: new Map([["a", "mid-sentence"]]) });
    expect(document.querySelector<HTMLTextAreaElement>("textarea[data-note]")!.value).toBe("mid-sentence");
  });
});

describe("a verdict button that needs words says so by being dead", () => {
  // The other half of seq 7: clicking Issue with an empty box did nothing at
  // all, silently. The only text on the card was the diagnostic.
  const walk = { id: "w", project: "p", title: "t", buildRef: "b", openedAt: "" };
  const q: Item = { id: "q", seq: 2, kind: "question", owner: "g", title: "Tier", options: ["A", "B"], addedAt: "" } as Item;

  it("knows which kinds are nothing without a note", () => {
    expect(needsText("pass-note")).toBe(true);
    expect(needsText("issue")).toBe(true);
    expect(needsText("ask")).toBe(true);
    expect(needsText("decision", "__other")).toBe(true);
    expect(needsText("decision", "A")).toBe(false);
    expect(needsText("pass")).toBe(false);
    expect(needsText("skip")).toBe(false);
    expect(needsText("dismiss")).toBe(false);
  });

  const paint = (drafts: Map<string, string>, options: Map<string, string>) => {
    document.body.innerHTML = renderWalk({ walk, items: [look("a", 1), q], verdicts: [], lastSeenSeq: 2 }, { drafts });
    syncVerdictButtons(document, drafts, { options });
    return (kind: string, id: string) => document.querySelector<HTMLButtonElement>(`button[data-kind="${kind}"][data-for="${id}"]`)!.disabled;
  };

  it("kills Issue, Pass + note and Ask until there are words", () => {
    let dead = paint(new Map(), new Map());
    expect([dead("issue", "a"), dead("pass-note", "a"), dead("ask", "a")]).toEqual([true, true, true]);
    expect([dead("pass", "a"), dead("skip", "a")]).toEqual([false, false]);
    dead = paint(new Map([["a", "the seam has a hairline"]]), new Map());
    expect([dead("issue", "a"), dead("pass-note", "a"), dead("ask", "a")]).toEqual([false, false, false]);
  });

  it("counts whitespace as no words", () => {
    const dead = paint(new Map([["a", "  \n "]]), new Map());
    expect(dead("issue", "a")).toBe(true);
  });

  it("kills Submit until an option is picked, and again if Other has no words", () => {
    expect(paint(new Map(), new Map())("decision", "q")).toBe(true);
    expect(paint(new Map(), new Map([["q", "A"]]))("decision", "q")).toBe(false);
    expect(paint(new Map(), new Map([["q", "__other"]]))("decision", "q")).toBe(true);
    expect(paint(new Map([["q", "a third way"]]), new Map([["q", "__other"]]))("decision", "q")).toBe(false);
  });
});

describe("a look card links the page it is about", () => {
  // The owner: "you probably could have linked me the fixture site instead of just
  // saying it was on the port."
  const walk = { id: "w", project: "p", title: "t", buildRef: "b", openedAt: "" };
  const html = (url: string) => renderWalk({ walk, items: [{ ...look("a", 1), url }], verdicts: [], lastSeenSeq: 0 }, { drafts: new Map() });

  it("is a real link, opening away from the pane", () => {
    const out = html("http://127.0.0.1:9340/other.html");
    expect(out).toContain('<a href="http://127.0.0.1:9340/other.html" target="_blank" rel="noreferrer">http://127.0.0.1:9340/other.html</a>');
  });

  it("sits under the title, above do/see/pass", () => {
    const out = html("http://x/");
    expect(out.indexOf("<a href=")).toBeGreaterThan(out.indexOf("</h3>"));
    expect(out.indexOf("<a href=")).toBeLessThan(out.indexOf("<dl>"));
  });

  it("is still there on a blocked card — that is the card that needs it", () => {
    const out = renderWalk({ walk, items: [look("a", 1)], verdicts: [v("a", "blocked", 1)], lastSeenSeq: 1 }, { drafts: new Map() });
    expect(out).toContain("<a href=");
  });

  it("only links a page a browser will open", () => {
    expect(html("javascript:alert(1)")).not.toContain("<a href=");
    expect(html("https://app.example.com/")).toContain("<a href=");
  });
});

describe("an item the pane blocked after it was already answered to", () => {
  const walk = { id: "w", project: "p", title: "t", buildRef: "b", openedAt: "" };
  const diag = "expect failed: {}; seen: fix-002";
  const blocked = (itemId: string, seq: number): Verdict => ({ ...v(itemId, "blocked", seq), text: diag });

  it("keeps the asked line and shows why Go stopped", () => {
    // Ask, then press Go: the answer is still pending with the agent AND the
    // page is not ready. Both are true, so the card says both.
    const a = look("a", 1);
    const out = renderWalk({ walk, items: [a], verdicts: [{ ...v("a", "ask", 1), text: "which build?" }, blocked("a", 2)], lastSeenSeq: 2 }, { drafts: new Map() });
    expect(out).toContain("Asked. Waiting for the agent.");
    expect(out).toContain("Not ready here");
    expect(out).toContain(diag);
  });

  it("keeps an undone decision's option picked", () => {
    const q: Item = { id: "q", seq: 1, kind: "question", owner: "g", title: "Tier", options: ["A", "B"], addedAt: "" } as Item;
    const out = renderWalk({ walk, items: [q], verdicts: [{ ...v("q", "decision", 1), option: "B" }, { ...v("q", "undo", 2), option: "B" }, blocked("q", 3)], lastSeenSeq: 3 }, { drafts: new Map() });
    expect(out).toContain('value="B" checked');
  });

  it("never reads a machine diagnostic out as the person's verdict", () => {
    const a = look("a", 1);
    const out = renderWalk({ walk, items: [a], verdicts: [{ ...v("a", "pass", 1), text: "" }, blocked("a", 2)], lastSeenSeq: 2 }, { drafts: new Map() });
    expect(out).toContain('class="verdict"');
    expect(out).toContain("<b>Pass</b>");
    expect(out).not.toContain(diag);
  });
});

describe("the Kerb rules: one line, one kerb, one mark", () => {
  // The Kerb v3 design language — the line reads verdict,
  // title, then the person's words in muted; the kerb is a class on the card;
  // and at the shelf the word becomes a mark in the gutter, the colour the
  // kerb had.
  const walk = { id: "w", project: "p", title: "t", buildRef: "b", openedAt: "", delivered: 0 };
  const line = (kind: Verdict["kind"], extra: Partial<Verdict> = {}) =>
    renderWalk({ walk, items: [look("a", 1)], verdicts: [{ ...v("a", kind, 1), text: "", ...extra }], lastSeenSeq: 1 }, { drafts: new Map() });

  it("reads verdict, then title, then the words — and the words are the muted half", () => {
    const out = line("issue", { text: "froze on the second try" });
    expect(out).toContain(`<p class="verdict"><b>Issue</b> Ta <span class="w">froze on the second try</span></p>`);
    // No words: the line is the verdict and the title, nothing trailing.
    expect(line("pass")).toContain(`<p class="verdict"><b>Pass</b> Ta</p>`);
    // The card sheds everything else the moment a verdict is filed.
    expect(out).not.toContain("<textarea");
    expect(out).not.toContain("data-go=");
    expect(out).not.toContain("<h3>");
  });

  it("puts how far a sequence got first in the trail, ahead of the words", () => {
    const out = line("issue", { text: "the crown stayed put", steps: [true, true, true, false] });
    expect(out).toContain(`<span class="w"><span class="far">3 of 4 steps</span>, the crown stayed put</span>`);
  });

  it("names the verdict's kind on the card, which is what paints the kerb", () => {
    // `line` answers a card the agent has not read, so the card is a ledge row
    // — where the kerb is the answered card's, in the verdict's colour.
    for (const [kind, cls] of [["pass", "v-pass"], ["pass-note", "v-pass"], ["issue", "v-issue"], ["skip", "v-skip"], ["dismiss", "v-dismiss"]] as const) {
      expect(line(kind, { text: "words" })).toContain(`class="item answered ${cls} on-ledge"`);
    }
  });

  it("stamps the verdict in the gutter once the card is on the shelf, and drops the word", () => {
    const read = { ...walk, delivered: 1 };
    const shelved = (kind: Verdict["kind"]) =>
      renderWalk({ walk: read, items: [look("a", 1)], verdicts: [{ ...v("a", kind, 1), text: "" }], lastSeenSeq: 1 }, { drafts: new Map() });
    expect(shelved("pass")).toContain(`<span class="mark mark-pass"><svg viewBox="0 0 18 18" role="img" aria-label="Pass">`);
    expect(shelved("issue")).toContain(`class="mark mark-issue"`);
    expect(shelved("skip")).toContain(`class="mark mark-skip"`);
    expect(shelved("dismiss")).toContain(`class="mark mark-dismiss"`);
    // The gutter carries it now, so the bold word is gone — and the loud Undo
    // is the only thing left to press.
    expect(shelved("pass")).toContain(`<p class="verdict">Ta</p>`);
    expect(shelved("pass")).not.toContain("<b>");
    expect(shelved("pass")).toContain('data-undo="a"');
  });

  /**
   * The owner, 2026-10-04: "when hovering over a line on the done ledge do you think
   * we can expand on hover to at least show the full untruncated title? If i'm
   * considering a red undo for example, I'll need to get some details on what it
   * was exactly."
   *
   * The answer is that there was nothing to add: the whole answered line is
   * already in the DOM on a shelf row and the one line is a CSS clip. So these
   * two pin the halves that make the open-out work — the renderer putting every
   * word there untruncated, and the stylesheet being the only thing cutting it.
   */
  it("carries the whole line on a shelf row: the full title, how far it got, and every word they wrote", () => {
    const read = { ...walk, delivered: 1 };
    const long = { ...look("a", 1), kind: "sequence", title: "The operator key box takes a key, keeps it, and the station reads it back after a restart", steps: [{ do: "d", see: "s" }, { do: "d", see: "s" }, { do: "d", see: "s" }] } as Item;
    const words = "the box took it but the station still read the old one until I restarted the box by hand, twice";
    const out = renderWalk({ walk: read, items: [long], verdicts: [{ ...v("a", "issue", 1), text: words, steps: [true, true, false] }], lastSeenSeq: 1 }, { drafts: new Map() });
    const row = out.slice(out.indexOf('class="group shelf"'));
    // Nothing is shortened, nothing is elided, and nothing is moved into an
    // attribute: a native tooltip is slow and is not how this pane says things.
    expect(row).toContain("The operator key box takes a key, keeps it, and the station reads it back after a restart");
    expect(row).toContain(words);
    expect(row).toContain(`<span class="far">2 of 3 steps</span>`);
    expect(row).not.toContain("…");
    expect(row).not.toContain("title=");
    // The kind is the gutter mark and the loud Undo is beside it, both as before.
    expect(row).toContain(`class="mark mark-issue"`);
    expect(row).toContain('data-undo="a"');
  });

  it("opens a shelf row out on hover and on focus within it, downward, with the Undo where it was", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "panel.css"), "utf8");
    // The clip is the stylesheet's, on the one-line form every answered row has.
    expect(css).toContain(".verdict{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis");
    // Hover and focus-within both, so tabbing to the red Undo opens the same row
    // a pointer would, and the words wrap rather than run off the end.
    expect(css).toContain(".item.done:hover,.item.done:focus-within{align-items:start}");
    expect(css).toContain(".item.done:hover .verdict,.item.done:focus-within .verdict{white-space:normal;overflow-wrap:anywhere}");
    // The gutter mark sits in a cell one Undo tall and centres inside that, so
    // taking the row off centre as it grows leaves the mark where it was.
    expect(css).toContain(".item.done:hover .mark,.item.done:focus-within .mark{height:var(--undo-row);display:grid;place-content:center}");
    expect(css).toContain("--undo-row:calc(var(--t-label) * 1.2 + 8px)");
    // And the pane's scroller does not anchor: with the pane at its end, which is
    // where the shelf is, anchoring answered the row's growth by scrolling down
    // by exactly as much and took the row — and its red Undo — up with it.
    expect(css).toContain("html{background:var(--ground);overflow-anchor:none}");
    // One source for that height: the ledge's row is the same Undo plus padding.
    expect(css).toContain("--ledge-row:calc(var(--undo-row) + 14px + 1px)");
    // No transition and so nothing to turn off: the pane's reduced-motion rule
    // still names the two animations it always had, and no third one.
    expect(css).toContain("@media (prefers-reduced-motion: reduce){.dot.on,.dot.waiting,.item.current,.item.waiting{animation:none}}");
    expect(css).not.toMatch(/\.item\.done[^{]*\{[^}]*transition/);
  });

  it("strikes a withdrawn title, keeps the reason muted beside it, and has nothing to press", () => {
    const wd = { ...look("a", 1), withdrawnAt: "x", withdrawReason: "the lane was reverted" };
    const out = renderWalk({ walk, items: [wd], verdicts: [], lastSeenSeq: 1 }, { drafts: new Map() });
    expect(out).toContain(`class="mark mark-withdrawn"`);
    expect(out).toContain(`<p class="verdict"><s>Ta</s> <span class="strike">the lane was reverted</span></p>`);
    expect(out).not.toContain("<button");
  });
});

/**
 * On an early walk, a question card said "the key is copied to your
 * clipboard right now" and it was not. The card shows that a value exists and
 * gives him the button; the value itself never enters the DOM, so nothing on
 * screen — and nothing in the screenshot the next verdict carries — has it.
 */
describe("a secret is a button, never a value on screen", () => {
  const walk = { id: "w", project: "p", title: "W", buildRef: "b", openedAt: "" };
  const KEY = "sk-test-secret-0001";
  const secret = [{ label: "Licence key", value: KEY }];
  const paint = (items: Item[]) => renderWalk({ walk, items, verdicts: [], lastSeenSeq: 1 }, { drafts: new Map() });

  it("renders the label, a fixed run of dots, and a Copy button on a look card", () => {
    const html = paint([{ ...look("a", 1), secrets: secret } as Item]);
    expect(html).toContain('<span class="name">Licence key</span>');
    expect(html).toContain(`<span class="dots" aria-hidden="true">${SECRET_DOTS}</span>`);
    expect(SECRET_DOTS).toHaveLength(12);
    expect(html).toContain('<button data-copy="a" data-secret="0" aria-label="Copy Licence key">Copy</button>');
    // Under do/see/pass, above the note box: what to paste comes after what to do.
    expect(html.indexOf("<dl>")).toBeLessThan(html.indexOf('class="secrets"'));
    expect(html.indexOf('class="secrets"')).toBeLessThan(html.indexOf("<textarea"));
  });

  it("never puts the value in the html — not as text, not in an attribute", () => {
    const html = paint([{ ...look("a", 1), secrets: secret } as Item]);
    expect(html).not.toContain(KEY);
    // The dots say a value exists, never how long it is.
    expect(html).not.toContain(String(KEY.length));
  });

  it("gives a row to each of up to four, numbered for the panel to read back", () => {
    const four = [1, 2, 3, 4].map(n => ({ label: `Key ${n}`, value: `v${n}` }));
    const html = paint([{ ...look("a", 1), secrets: four } as Item]);
    expect(html.match(/<div class="secret">/g)).toHaveLength(4);
    for (let n = 0; n < 4; n++) expect(html).toContain(`data-copy="a" data-secret="${n}"`);
    for (const s of four) expect(html).not.toContain(s.value);
  });

  it("escapes a label like anything else an agent wrote", () => {
    const html = paint([{ ...look("a", 1), secrets: [{ label: "<b>key</b>", value: KEY }] } as Item]);
    expect(html).toContain("&lt;b&gt;key&lt;/b&gt;");
  });

  it("carries them on info and sequence cards, and on a card with none renders no row", () => {
    const info: Item = { id: "i", seq: 1, kind: "info", owner: "g", title: "Ti", body: "body", addedAt: "", secrets: secret };
    expect(paint([info])).toContain('<button data-copy="i" data-secret="0" aria-label="Copy Licence key">Copy</button>');
    const seq: Item = { id: "s", seq: 1, kind: "sequence", owner: "g", title: "Ts", url: "http://x/", addedAt: "",
      steps: [{ do: "d1", see: "s1" }, { do: "d2", see: "s2" }], expect: [], secrets: secret };
    const html = paint([seq]);
    expect(html).toContain('<button data-copy="s" data-secret="0" aria-label="Copy Licence key">Copy</button>');
    // After the steps, before the note box.
    expect(html.indexOf("</ol>")).toBeLessThan(html.indexOf('class="secrets"'));
    expect(paint([look("a", 1)])).not.toContain("data-copy");
  });

  it("has no row at all once the daemon has restarted and the values are gone", () => {
    // The daemon drops the whole `secrets` key on the way to disk, so a card
    // rebuilt from it never offers a button with nothing behind it.
    expect(paint([look("a", 1)])).not.toContain('class="secrets"');
  });
});

describe("first run and version notice", () => {
  it("the first-run note names the port, carries the install command once as text and once on the Copy button", () => {
    const html = renderFirstRun(8760);
    expect(html).toContain('class="note first-run"');
    expect(html).toContain("Nothing has answered on port 8760 yet");
    expect(html).toContain(`<code>${INSTALL_COMMAND}</code>`);
    expect(html).toContain(`data-copy-text="${INSTALL_COMMAND}"`);
    expect(html).toContain('aria-label="Copy the install command"');
    expect(html).toContain(">Copy<");
    expect(INSTALL_COMMAND).toBe("claude mcp add --scope user sidewalk -- npx -y sidewalk-mcp");
  });
  it("the version notice names both versions and the port, and offers the stop command", () => {
    const html = renderVersionNotice("0.3.0", "0.2.0", 8760);
    expect(html).toContain('class="note version"');
    expect(html).toContain("This panel is 0.3.0 and walkd on port 8760 is 0.2.0.");
    expect(html).toContain("reconnect the agent");
    expect(html).toContain(`<code>${STOP_COMMAND}</code>`);
    expect(html).toContain(`data-copy-text="${STOP_COMMAND}"`);
    expect(html).toContain('aria-label="Copy the stop command"');
    expect(STOP_COMMAND).toBe("npx -y sidewalk-walkd stop");
  });
  it("escapes a version string that is not ours", () => {
    expect(renderVersionNotice("0.3.0", "<b>x</b>", 8760)).not.toContain("<b>");
  });

  // The daemon keeps its token in a file an extension cannot read, so this
  // notice says where to get it, and the first-run note says it exists at all
  // (secrets review).
  it("the needs-token notice names the port and offers the command that prints it", () => {
    const html = renderTokenNotice(8761);
    expect(html).toContain('class="note token"');
    expect(html).toContain("walkd on port 8761 will not let this panel in without its token");
    expect(html).toContain("paste it into the gear");
    expect(html).toContain(`<code>${TOKEN_COMMAND}</code>`);
    expect(html).toContain(`data-copy-text="${TOKEN_COMMAND}"`);
    expect(html).toContain('aria-label="Copy the token command"');
    expect(TOKEN_COMMAND).toBe("npx -y sidewalk-walkd token --copy");
    // The notice holds no token, only the way to get one.
    expect(html).not.toMatch(/Bearer/);
  });

  it("the connection line for a daemon that is answering and refusing says what it wants", () => {
    expect(needsTokenLine(8760)).toBe("walkd on 8760 needs the token");
  });

  it("the first-run note says a token exists, because nothing works until it is pasted", () => {
    expect(renderFirstRun(8760)).toContain("walkd token");
  });

  // The owner, 2026-10-06: "i had copied something else and noticed when i saved my
  // wrong token it just says saved in green like no actual connection check /
  // rejection". The gear's line after a Save is the daemon's answer, and green
  // belongs to exactly one of the five.
  it("the gear's line after a Save says what came of the token, and only green is in", () => {
    expect(tokenSay("checking", 8761)).toEqual({ text: "Checking…", cls: "" });
    expect(tokenSay("connected", 8761)).toEqual({ text: "Connected.", cls: "pass" });
    expect(tokenSay("refused", 8761)).toEqual({ text: "walkd refused this token.", cls: "issue" });
    expect(tokenSay("noDaemon", 8761)).toEqual({ text: "No walkd on 8761.", cls: "" });
    expect(tokenSay("noAnswer", 8761)).toEqual({ text: "No answer from walkd on 8761.", cls: "" });
    // The port is the one that was asked, not a constant.
    expect(tokenSay("noDaemon", 8760).text).toBe("No walkd on 8760.");
    // Nothing here is the old unconditional "Saved" — that word was the defect.
    for (const c of ["checking", "connected", "refused", "noDaemon", "noAnswer"] as const) {
      expect(tokenSay(c, 8761).text).not.toMatch(/Saved/);
      // Green is the pass colour and nothing else wears it.
      if (c !== "connected") expect(tokenSay(c, 8761).cls).not.toBe("pass");
    }
  });
});
