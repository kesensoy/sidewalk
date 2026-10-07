import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WalkStore, NotFound } from "./store.js";
import type { VerdictInput } from "./schema/index.js";

let dir: string; let store: WalkStore;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-")); store = new WalkStore(dir); });

const look = (id: string) => ({ id, kind: "look" as const, owner: "gate", title: id, url: "http://127.0.0.1:9340/",
  do: "d", see: "s", pass: "p", expect: [] });
const verdict = (itemId: string, nonce: string): VerdictInput => ({ itemId, kind: "pass", text: "ok", nonce,
  context: { url: "http://127.0.0.1:9340/", viewport: [800, 600], console: [], userAgent: "ua" } });

describe("WalkStore", () => {
  it("opens a walk, assigns id from title when absent, reopens by id", async () => {
    const w = await store.open({ project: "lamppost", title: "Lamppost 2.4", buildRef: "abc" });
    expect(w.id).toBe("lamppost-2-4");
    const again = await store.open({ project: "lamppost", title: "x", buildRef: "abc", id: "lamppost-2-4" });
    expect(again.openedAt).toBe(w.openedAt);
    expect((await store.list()).map(x => x.id)).toEqual(["lamppost-2-4"]);
  });

  it("keeps a brief on the header, replaces it on a reopen that brings a new one, and leaves it on a reopen that does not", async () => {
    const w = await store.open({ project: "p", title: "Briefed", buildRef: "b", brief: "Start on the portal." });
    expect(w.brief).toBe("Start on the portal.");
    expect((await store.read(w.id)).walk.brief).toBe("Start on the portal.");
    const same = await store.open({ project: "p", title: "Briefed", buildRef: "b", id: w.id });
    expect(same.brief).toBe("Start on the portal.");
    const changed = await store.open({ project: "p", title: "Briefed", buildRef: "b", id: w.id, brief: "Start on the app instead." });
    expect(changed.brief).toBe("Start on the app instead.");
    expect((await store.read(w.id)).walk.brief).toBe("Start on the app instead.");
    // Survives a reload from disk: the header is walk.json, not memory.
    const fresh = new WalkStore(dir);
    expect((await fresh.read(w.id)).walk.brief).toBe("Start on the app instead.");
  });

  it("answers two first requests that arrive together with the whole disk, not half of it", async () => {
    // On an early walk, right after a restart: the second request arriving during the
    // first scan saw walk-11 loaded and walk-12 not yet, and got a 404 for a
    // walk that was on disk the whole time.
    const a = await store.open({ project: "p", title: "walk-11", buildRef: "b" });
    const b = await store.open({ project: "p", title: "walk-12", buildRef: "b" });
    await store.addItems(b.id, [look("x")]);
    const fresh = new WalkStore(dir);
    const [ra, rb, rb2] = await Promise.all([fresh.read(a.id), fresh.read(b.id), fresh.wait(b.id, 0, 0)]);
    expect(ra.walk.id).toBe("walk-11"); expect(rb.items).toHaveLength(1); expect(rb2.cursor).toBe(0);
  });

  it("appends items with monotonic seq and persists them", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    const a = await store.addItems(w.id, [look("a"), look("b")]);
    expect(a.map(i => i.seq)).toEqual([1, 2]);
    const b = await store.addItems(w.id, [look("c")]);
    expect(b[0].seq).toBe(3);
    const fresh = new WalkStore(dir);
    expect((await fresh.read(w.id)).items.map(i => i.id)).toEqual(["a", "b", "c"]);
  });

  it("rejects a duplicate item id and an unknown walk", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a")]);
    await expect(store.addItems(w.id, [look("a")])).rejects.toThrow(/duplicate/);
    await expect(store.addItems("nope", [look("z")])).rejects.toBeInstanceOf(NotFound);
  });

  it("withdraws by appending, never rewriting", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a")]);
    const wd = await store.withdraw(w.id, "a", "not deployed");
    expect(wd.withdrawReason).toBe("not deployed");
    const lines = (await fs.readFile(path.join(dir, "p", w.id, "items.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((await store.read(w.id)).items[0].withdrawnAt).toBeTruthy();
  });

  it("stores verdicts with seq, writes the screenshot, dedupes by nonce", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a")]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
    const v1 = await store.addVerdict(w.id, { ...verdict("a", "nonce-0001"), context: { ...verdict("a", "n").context, screenshotBase64: jpeg } });
    expect(v1.seq).toBe(1);
    expect(v1.context.screenshot).toBe("shots/000001.jpg");
    expect((await fs.stat(path.join(dir, "p", w.id, "shots", "000001.jpg"))).size).toBe(4);
    const v2 = await store.addVerdict(w.id, verdict("a", "nonce-0001"));
    expect(v2.seq).toBe(1);
    expect((await store.read(w.id)).verdicts).toHaveLength(1);
    await expect(store.addVerdict(w.id, verdict("zzz", "nonce-0002"))).rejects.toThrow(/unknown item/);
  });

  it("builds a verdict with no `ask` key on it — not on an ask, not on a pass", async () => {
    // An early agent session: "The ask came back as kind: \"ask\" with
    // ask: false beside it, which reads as a contradiction." `ask` was a
    // modifier before it was a kind; the schema no longer defaults it, and
    // nothing here puts one on a verdict that arrived without one.
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a"), look("b")]);
    const asked = await store.addVerdict(w.id, { ...verdict("a", "nonce-0001"), kind: "ask", text: "which build is this?" });
    expect(asked.kind).toBe("ask");
    expect("ask" in asked).toBe(false);
    const passed = await store.addVerdict(w.id, verdict("b", "nonce-0002"));
    expect("ask" in passed).toBe(false);
    // And not on disk either, so a reload does not bring one back.
    const lines = (await fs.readFile(path.join(dir, "p", w.id, "verdicts.jsonl"), "utf8")).trim().split("\n");
    for (const line of lines) expect("ask" in JSON.parse(line)).toBe(false);
    const back = new WalkStore(dir);
    for (const v of (await back.read(w.id)).verdicts) expect("ask" in v).toBe(false);
  });

  it("keeps which steps of a sequence were ticked on the verdict", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [{ id: "s", kind: "sequence", owner: "gate", title: "s", url: "http://127.0.0.1:9340/",
      steps: [{ do: "a", see: "b" }, { do: "c", see: "d" }, { do: "e", see: "f" }], expect: [] }]);
    const v = await store.addVerdict(w.id, { ...verdict("s", "nonce-0001"), kind: "issue", text: "third never came", steps: [true, true, false] });
    expect(v.steps).toEqual([true, true, false]);
    const back = new WalkStore(dir);
    expect((await back.read(w.id)).verdicts[0].steps).toEqual([true, true, false]);
    // A look item's verdict carries no steps at all, not an empty list.
    await store.addItems(w.id, [look("a")]);
    expect("steps" in (await store.addVerdict(w.id, verdict("a", "nonce-0002")))).toBe(false);
  });

  it("tracks what an agent has been handed, hides a verdict taken back before that, and delivers an undo after it", async () => {
    // The owner, on an early walk: "until the other agent picks it up it's a free and easy
    // click to evict it from the daemon … a green undo that turns red when the
    // main agent pulls it off the queue." The daemon knows what it has handed
    // out: every agent read is a cursor call. The pane's own reads do not count.
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a"), look("b")]);
    expect((await store.read(w.id, 0, { viewer: true })).walk.delivered ?? 0).toBe(0);

    // Answer a, take it back before any agent read: both vanish from agent reads.
    await store.addVerdict(w.id, { ...verdict("a", "n1"), kind: "issue", text: "oops" });
    const u1 = await store.addVerdict(w.id, { ...verdict("a", "n2"), kind: "undo", text: "" });
    expect(u1.quiet).toBe(true); expect(u1.retracts).toBe(1);
    expect((await store.read(w.id)).verdicts).toEqual([]);
    expect((await store.wait(w.id, 0, 0)).verdicts).toEqual([]);
    // The pane still sees the whole stream, so the card reads as unanswered again.
    expect((await store.read(w.id, 0, { viewer: true })).verdicts.map(v => v.kind)).toEqual(["issue", "undo"]);

    // Answer b; an agent read hands it over and moves `delivered`.
    await store.addVerdict(w.id, { ...verdict("b", "n3"), kind: "pass", text: "" });
    const r = await store.wait(w.id, 0, 0);
    expect(r.verdicts.map(v => v.seq)).toEqual([3]);
    expect((await store.read(w.id, 0, { viewer: true })).walk.delivered).toBe(3);
    // A pane read never moves it.
    await store.addVerdict(w.id, { ...verdict("a", "n4"), kind: "pass", text: "" });
    await store.read(w.id, 0, { viewer: true });
    expect((await store.read(w.id, 0, { viewer: true })).walk.delivered).toBe(3);
    // The agent saying "I have through 4" moves it, even with nothing new.
    await store.wait(w.id, 4, 0);
    expect((await store.read(w.id, 0, { viewer: true })).walk.delivered).toBe(4);

    // Now take b back: the agent already has it, so the undo is delivered loud.
    const u2 = await store.addVerdict(w.id, { ...verdict("b", "n5"), kind: "undo", text: "" });
    expect(u2.quiet).toBeUndefined(); expect(u2.retracts).toBe(3);
    expect((await store.wait(w.id, 4, 0)).verdicts.map(v => [v.itemId, v.kind])).toEqual([["b", "undo"]]);

    // Delivered and the quiet pair survive a restart.
    const back = new WalkStore(dir);
    expect((await back.read(w.id, 0, { viewer: true })).walk.delivered).toBe(5);
    expect((await back.read(w.id)).verdicts.map(v => v.seq)).toEqual([3, 4, 5]);
  });

  it("holds a fresh verdict back from agents for the grace window, then wakes a waiter with it", async () => {
    // The owner, on an early walk: "i completed one and never saw the green undo option, did
    // the main agent just gobble it up INSTANTLY? Maybe we should do a short
    // lil cooldown like 10s before it can be pulled?" A blocking walk_wait
    // returns the instant a verdict lands, so without a window the free Undo
    // never exists. Inside the window the verdict is the pane's alone.
    const graced = new WalkStore(dir, { graceMs: 300 });
    const w = await graced.open({ project: "g", title: "t", buildRef: "b" });
    await graced.addItems(w.id, [look("a")]);
    const t0 = Date.now();
    await graced.addVerdict(w.id, verdict("a", "n1"));
    expect((await graced.wait(w.id, 0, 0)).verdicts).toEqual([]);
    expect((await graced.read(w.id)).verdicts).toEqual([]);
    expect((await graced.read(w.id, 0, { viewer: true })).verdicts).toHaveLength(1);
    expect((await graced.read(w.id, 0, { viewer: true })).walk.delivered ?? 0).toBe(0);
    // A waiter already blocked is woken when the verdict matures, not at its timeout.
    const woke = await graced.wait(w.id, 0, 5000);
    expect(woke.verdicts.map(v => v.seq)).toEqual([1]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(Date.now() - t0).toBeLessThan(2000);
    // Taken back inside the window: quiet, and the agent never sees either.
    await graced.addVerdict(w.id, { ...verdict("a", "n2"), kind: "issue", text: "x" });
    const u = await graced.addVerdict(w.id, { ...verdict("a", "n3"), kind: "undo", text: "" });
    expect(u.quiet).toBe(true);
    await new Promise(r => setTimeout(r, 350));
    expect((await graced.wait(w.id, 1, 0)).verdicts).toEqual([]);
  });

  /**
   * SW-3 of the 2026-10-06 audit. `deliver` took the caller's cursor at its word,
   * and the MCP client read with `Number.MAX_SAFE_INTEGER` whenever it needed a
   * walk's project for a screenshot path — the documented resume path. After that
   * `walk.delivered` sat above every verdict the walk would ever have, so the
   * person's next Undo inside the grace window was never quiet again, the agent
   * was handed the retracted answer and the undo together, and walk.json carried
   * the nonsense number for the rest of the walk.
   */
  it("a read from past the last verdict leaves the free Undo alone and the header honest", async () => {
    const graced = new WalkStore(dir, { graceMs: 250 });
    const w = await graced.open({ project: "q", title: "t", buildRef: "b" });
    await graced.addItems(w.id, [look("a"), look("b")]);
    // Nothing answered yet, and a read from past the end claims nothing.
    await graced.read(w.id, Number.MAX_SAFE_INTEGER);
    expect((await graced.read(w.id, 0, { viewer: true })).walk.delivered ?? 0).toBe(0);

    // One answer, matured and handed over: delivered is that seq and no more.
    await graced.addVerdict(w.id, verdict("a", "n1"));
    await new Promise(r => setTimeout(r, 300));
    expect((await graced.wait(w.id, 0, 0)).verdicts.map(v => v.seq)).toEqual([1]);
    await graced.read(w.id, Number.MAX_SAFE_INTEGER);
    expect((await graced.read(w.id, 0, { viewer: true })).walk.delivered).toBe(1);

    // The next answer, taken back inside the window: quiet, and the agent is
    // handed neither it nor the undo.
    await graced.addVerdict(w.id, { ...verdict("b", "n2"), kind: "issue", text: "oops" });
    const u = await graced.addVerdict(w.id, { ...verdict("b", "n3"), kind: "undo", text: "" });
    expect(u.quiet).toBe(true);
    expect(u.retracts).toBe(2);
    expect((await graced.wait(w.id, 1, 0)).verdicts).toEqual([]);
    await new Promise(r => setTimeout(r, 300));
    expect((await graced.wait(w.id, 1, 0)).verdicts).toEqual([]);
    // And the header still names the last seq actually handed over — the quiet
    // pair was never delivered, so it never moved.
    expect((await graced.read(w.id, 0, { viewer: true })).walk.delivered).toBe(1);
  });

  it("read(after) and wait() use the verdict cursor", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a")]);
    await store.addVerdict(w.id, verdict("a", "nonce-0001"));
    expect((await store.read(w.id, 1)).verdicts).toHaveLength(0);
    const p = store.wait(w.id, 1, 2000);
    setTimeout(() => store.addVerdict(w.id, verdict("a", "nonce-0002")), 20);
    const r = await p;
    expect(r.verdicts.map(v => v.seq)).toEqual([2]);
    expect(r.cursor).toBe(2);
    const t = await store.wait(w.id, 2, 30);
    expect(t.verdicts).toEqual([]); expect(t.closed).toBe(false);
  });

  it("close() ends waits and hides the walk from list()", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    const p = store.wait(w.id, 0, 5000);
    await store.close(w.id, "done");
    expect((await p).closed).toBe(true);
    expect(await store.list()).toEqual([]);
    await expect(store.addItems(w.id, [look("a")])).rejects.toThrow(/closed/);
  });

  it("serializes concurrent verdicts: file order, seq order and the waiter agree", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a")]);
    const big = Buffer.alloc(200 * 1024, 0x41).toString("base64");
    const waiting = store.wait(w.id, 0, 2000);
    const slow = store.addVerdict(w.id, { ...verdict("a", "nonce-0001"), context: { ...verdict("a", "x").context, screenshotBase64: big } });
    const fast = store.addVerdict(w.id, verdict("a", "nonce-0002"));
    const [v1, v2] = await Promise.all([slow, fast]);
    expect([v1.seq, v2.seq]).toEqual([1, 2]);
    const lines = (await fs.readFile(path.join(dir, "p", w.id, "verdicts.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
    expect(lines.map(l => l.seq)).toEqual([1, 2]);
    expect(lines.map(l => l.nonce)).toEqual(["nonce-0001", "nonce-0002"]);
    // The bug was a waiter waking on the fast verdict and returning cursor 2
    // with seq 1 never in any result. The invariant: the cursor never runs past
    // the last verdict handed back, so draining from it loses nothing.
    const woke = await waiting;
    expect(woke.verdicts[0].seq).toBe(1);
    expect(woke.cursor).toBe(woke.verdicts.at(-1)!.seq);
    const rest = await store.wait(w.id, woke.cursor, 0);
    expect([...woke.verdicts, ...rest.verdicts].map(v => v.seq)).toEqual([1, 2]);
  });

  it("collapses two concurrent same-nonce verdicts into one record", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a")]);
    const [x, y] = await Promise.all([store.addVerdict(w.id, verdict("a", "same")), store.addVerdict(w.id, verdict("a", "same"))]);
    expect(x.seq).toBe(y.seq);
    expect((await store.read(w.id)).verdicts).toHaveLength(1);
    expect((await fs.readFile(path.join(dir, "p", w.id, "verdicts.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("lets only one of two concurrent addItems with the same id win", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    const r = await Promise.allSettled([store.addItems(w.id, [look("dup")]), store.addItems(w.id, [look("dup")])]);
    expect(r.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter(x => x.status === "rejected")).toHaveLength(1);
    expect((await store.read(w.id)).items.map(i => i.id)).toEqual(["dup"]);
  });

  it("survives a torn last line and never truncates the walk on reopen", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a"), look("b")]);
    await store.addVerdict(w.id, verdict("a", "nonce-0001"));
    const items = path.join(dir, "p", w.id, "items.jsonl");
    const verdicts = path.join(dir, "p", w.id, "verdicts.jsonl");
    await fs.appendFile(items, '{"id":"c","kind":"loo');  // half a line, as a crash leaves it
    const sizes = [(await fs.stat(items)).size, (await fs.stat(verdicts)).size];

    const fresh = new WalkStore(dir);
    expect((await fresh.list()).map(x => x.id)).toEqual([w.id]);
    const r = await fresh.read(w.id);
    expect(r.items.map(i => i.id)).toEqual(["a", "b"]);
    expect(r.verdicts).toHaveLength(1);

    const again = await fresh.open({ project: "p", title: "t", buildRef: "b", id: w.id });
    expect(again.openedAt).toBe(w.openedAt);
    expect([(await fs.stat(items)).size, (await fs.stat(verdicts)).size]).toEqual(sizes);
  });

  it("refuses to reopen — and so to truncate — a walk dir that failed to load", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a"), look("b")]);
    const items = path.join(dir, "p", w.id, "items.jsonl");
    const text = await fs.readFile(items, "utf8");
    await fs.writeFile(items, text.replace(/^\{/, "{oops"));  // a bad line that is NOT the last
    const size = (await fs.stat(items)).size;

    const fresh = new WalkStore(dir);
    expect(await fresh.list()).toEqual([]);
    await expect(fresh.open({ project: "p", title: "t", buildRef: "b", id: w.id }))
      .rejects.toThrow(/walk dir exists but failed to load/);
    expect((await fs.stat(items)).size).toBe(size);
  });

  it("keys walks by project, so one id in two projects does not collide", async () => {
    const one = await store.open({ project: "p1", title: "t", buildRef: "b", id: "walk-11" });
    await store.addItems("walk-11", [look("a")]);
    // An id already open under another project must be refused, not silently
    // aliased onto the other project's walk.
    await expect(store.open({ project: "p2", title: "t", buildRef: "b", id: "walk-11" }))
      .rejects.toThrow("walk id walk-11 is open under project p1");
    expect((await store.list()).map(w => `${w.project}/${w.id}`)).toEqual(["p1/walk-11"]);
    await expect(fs.stat(path.join(dir, "p2", "walk-11"))).rejects.toThrow();
    expect((await store.get("walk-11")).openedAt).toBe(one.openedAt);

    // Once p1's walk is closed the id is free for another project, and both
    // dirs survive a reload side by side.
    await store.close("walk-11", "done");
    await store.open({ project: "p2", title: "t", buildRef: "b", id: "walk-11" });
    await store.addItems("walk-11", [look("b")]);
    const fresh = new WalkStore(dir);
    expect((await fresh.list()).map(w => `${w.project}/${w.id}`)).toEqual(["p2/walk-11"]);
    expect((await fresh.read("walk-11")).items.map(i => i.id)).toEqual(["b"]);
    const p1Items = (await fs.readFile(path.join(dir, "p1", "walk-11", "items.jsonl"), "utf8")).trim().split("\n");
    expect(p1Items.map(l => JSON.parse(l).id)).toEqual(["a"]);
  });

  it("takes any number of SSE listeners without a leak warning", () => {
    expect(store.getMaxListeners()).toBe(0);
    const warn: unknown[] = [];
    const onWarning = (w: unknown) => warn.push(w);
    process.on("warning", onWarning);
    for (let i = 0; i < 11; i++) store.on("item", () => {});
    process.off("warning", onWarning);
    expect(warn).toEqual([]);
  });

  it("emits events", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    const seen: string[] = [];
    store.on("item", () => seen.push("item")); store.on("verdict", () => seen.push("verdict"));
    await store.addItems(w.id, [look("a")]); await store.addVerdict(w.id, verdict("a", "nonce-0001"));
    expect(seen).toEqual(["item", "verdict"]);
  });
});

/**
 * Everything under the data dir is the person's own: the streams, every verdict
 * screenshot, and whatever they dropped in `secrets/`. These folders were made
 * with the default mode — `drwxr-xr-x` — so on a shared machine any other user
 * could read all of it (secrets review). Windows has no mode to set.
 */
describe.skipIf(process.platform === "win32")("the folders the daemon makes", () => {
  const mode = async (p: string) => (await fs.stat(p)).mode & 0o777;

  it("makes its data dir, each walk's folders and shots/ readable by nobody else", async () => {
    // Not the mkdtemp dir itself — mkdtemp is already 0700, which would prove
    // nothing. A data dir the store has to create.
    const data = path.join(dir, "nested", "walkd-data");
    const fresh = new WalkStore(data);
    await fresh.open({ project: "p", title: "t", buildRef: "b" });
    expect(await mode(data)).toBe(0o700);
    // Recursive, so the project and walk folders above shots/ are 0700 too.
    expect(await mode(path.join(data, "p"))).toBe(0o700);
    expect(await mode(path.join(data, "p", "t"))).toBe(0o700);
    expect(await mode(path.join(data, "p", "t", "shots"))).toBe(0o700);
  });
});

/**
 * On an early walk, a question card said "the key is copied to your
 * clipboard right now" and it was not. The value now rides the item to the
 * pane, where his hand is already on a button — and stops there. The daemon's
 * memory is the only place it ever lives.
 */
describe("a secret on an item", () => {
  const withSecret = (id: string) => ({ ...look(id), secrets: [{ label: "Licence key", value: "sk-test-0001" }] });
  const itemsFile = (walk: string) => path.join(dir, "p", walk, "items.jsonl");

  it("writes no value — and no labels — to items.jsonl", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [withSecret("a")]);
    const raw = await fs.readFile(itemsFile(w.id), "utf8");
    expect(raw).not.toContain("sk-test-0001");
    // The label is dropped with it: "Licence key" describes a live credential,
    // and a card rebuilt from disk with labels but no values would offer a
    // Copy button that copies nothing.
    expect(raw).not.toContain("Licence key");
    expect(JSON.parse(raw.trim())).not.toHaveProperty("secrets");
  });

  it("reads a file-backed secret from the daemon's own secrets folder, keeps it across a restart, and refuses a missing file", async () => {
    // On an early walk, the agent could not read the operator key into its own
    // conversation (its permission rules refused, rightly). So the agent names
    // a file, and the daemon reads the value itself.
    await fs.mkdir(path.join(dir, "secrets"), { recursive: true });
    await fs.writeFile(path.join(dir, "secrets", "operator-key.txt"), "op-key-4242\n");
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    const [added] = await store.addItems(w.id, [{ ...look("a"), secrets: [{ label: "Operator key", file: "operator-key.txt" }] }]);
    expect((added as any).secrets).toEqual([{ label: "Operator key", file: "operator-key.txt" }]);
    const viewer = (await store.read(w.id, 0, { viewer: true })).items[0] as any;
    expect(viewer.secrets).toEqual([{ label: "Operator key", file: "operator-key.txt", value: "op-key-4242" }]);
    // On disk: the label and the file name, never the value.
    const raw = await fs.readFile(itemsFile(w.id), "utf8");
    expect(raw).toContain("operator-key.txt"); expect(raw).not.toContain("op-key-4242");
    // After a restart the file is still there, so the value comes back.
    const back = new WalkStore(dir);
    expect(((await back.read(w.id, 0, { viewer: true })).items[0] as any).secrets[0].value).toBe("op-key-4242");
    // The file gone: the secret is dropped on load rather than offered empty.
    await fs.rm(path.join(dir, "secrets", "operator-key.txt"));
    const later = new WalkStore(dir);
    expect(((await later.read(w.id, 0, { viewer: true })).items[0] as any).secrets).toEqual([]);
    // And an add naming a file that is not there is refused, naming the folder.
    await expect(store.addItems(w.id, [{ ...look("b"), secrets: [{ label: "Other", file: "nope.txt" }] }]))
      .rejects.toThrow(/secret file not found: nope\.txt \(put it in .*secrets\)/);
  });

  /**
   * The bare-filename rule is about the name the agent writes, not about what
   * the name resolves to — so a symlink dropped in the folder pointed the daemon
   * at any file on the disk, a directory read back as "not found", and a large
   * file went whole into the heap, the item and the stream (secrets review). What is read now is a regular file of at most 64 KB.
   */
  it("reads a file secret only if it is a regular file under 64 KB, and says which rule a file broke", async () => {
    const secrets = path.join(dir, "secrets");
    await fs.mkdir(secrets, { recursive: true });
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    const add = (id: string, file: string) => store.addItems(w.id, [{ ...look(id), secrets: [{ label: "Key", file }] }]);

    // A symlink to a file the agent was never meant to reach: refused, not
    // followed. lstat rather than stat is the whole difference.
    const elsewhere = path.join(dir, "credentials");
    await fs.writeFile(elsewhere, "aws-secret-9999\n");
    await fs.symlink(elsewhere, path.join(secrets, "link.txt"));
    await expect(add("a", "link.txt")).rejects.toThrow(/secret file is not a regular file: link\.txt \(put it in .*secrets\)/);

    // A directory of that name: the old code read EISDIR and called it missing.
    await fs.mkdir(path.join(secrets, "folder.txt"));
    await expect(add("b", "folder.txt")).rejects.toThrow(/secret file is not a regular file: folder\.txt/);

    // Too big. Refused on the stat, so the bytes are never read at all.
    await fs.writeFile(path.join(secrets, "big.txt"), "x".repeat(64 * 1024 + 1));
    await expect(add("c", "big.txt")).rejects.toThrow(/secret file is over 64 KB: big\.txt/);
    // The byte under the cap is still a secret.
    await fs.writeFile(path.join(secrets, "edge.txt"), "y".repeat(64 * 1024));
    await add("d", "edge.txt");
    expect(((await store.read(w.id, 0, { viewer: true })).items.find(i => i.id === "d") as any).secrets[0].value.length).toBe(64 * 1024);

    // Nothing a refused file holds reaches the record or an agent.
    const raw = await fs.readFile(itemsFile(w.id), "utf8");
    expect(raw).not.toContain("aws-secret-9999");
    expect(JSON.stringify(await store.read(w.id))).not.toContain("aws-secret-9999");

    // On load after a restart the same rules are applied quietly, which is what
    // `lenient` has always meant: no throw, and no Copy that copies nothing.
    await store.addItems(w.id, [{ ...look("e"), secrets: [{ label: "Key", file: "edge.txt" }] }]);
    await fs.rm(path.join(secrets, "edge.txt"));
    await fs.mkdir(path.join(secrets, "edge.txt"));
    const back = new WalkStore(dir);
    expect(((await back.read(w.id, 0, { viewer: true })).items.find(i => i.id === "e") as any).secrets).toEqual([]);
  });

  /**
   * A FIFO used to block `readFile` forever inside the walk's write lock, so
   * every later add, verdict and close on that walk queued behind a read that
   * never returned. The stat refuses it before a byte is asked for, so the lock
   * is released and the walk keeps working. POSIX only — Windows has no mkfifo.
   */
  it.skipIf(process.platform === "win32")("refuses a FIFO instead of hanging the walk behind it", async () => {
    const secrets = path.join(dir, "secrets");
    await fs.mkdir(secrets, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [path.join(secrets, "pipe.txt")]);
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await expect(store.addItems(w.id, [{ ...look("a"), secrets: [{ label: "Key", file: "pipe.txt" }] }]))
      .rejects.toThrow(/secret file is not a regular file: pipe\.txt/);
    // The lock is free: the next add goes through.
    await store.addItems(w.id, [look("b")]);
    expect((await store.read(w.id)).items.map(i => i.id)).toEqual(["b"]);
  }, 10000);

  it("hands the value to the pane, and the labels alone to an agent", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [withSecret("a")]);
    const viewer = (await store.read(w.id, 0, { viewer: true })).items[0] as any;
    expect(viewer.secrets).toEqual([{ label: "Licence key", value: "sk-test-0001" }]);
    const agent = (await store.read(w.id)).items[0] as any;
    expect(agent.secrets).toEqual([{ label: "Licence key" }]);
    expect(JSON.stringify(agent)).not.toContain("sk-test-0001");
  });

  it("does not echo the value back out of walk_add_items or walk_withdraw", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    const [added] = await store.addItems(w.id, [withSecret("a")]);
    expect((added as any).secrets).toEqual([{ label: "Licence key" }]);
    const gone = await store.withdraw(w.id, "a", "wrong key");
    expect((gone as any).secrets).toEqual([{ label: "Licence key" }]);
  });

  it("puts the value on the SSE item event, which is what the pane paints from", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    const seen: any[] = [];
    store.on("item", (_walk, item) => seen.push(item));
    await store.addItems(w.id, [withSecret("a")]);
    expect(seen[0].secrets).toEqual([{ label: "Licence key", value: "sk-test-0001" }]);
  });

  it("has no secrets at all once the daemon restarts", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [withSecret("a")]);
    const fresh = new WalkStore(dir);
    const reloaded = (await fresh.read(w.id, 0, { viewer: true })).items[0] as any;
    expect(reloaded.id).toBe("a");
    expect(reloaded.secrets).toBeUndefined();
  });

  it("refuses more than four, and drops them from a question", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    const five = [1, 2, 3, 4, 5].map(n => ({ label: `k${n}`, value: `v${n}` }));
    await expect(store.addItems(w.id, [{ ...look("a"), secrets: five }])).rejects.toThrow();
    // A decision is not a thing you paste, so `question` has no `secrets` in
    // its schema and one sent anyway never reaches the item.
    const [q] = await store.addItems(w.id, [{
      id: "q", kind: "question" as const, owner: "gate", title: "q", options: ["a", "b"],
      secrets: [{ label: "k", value: "v" }],
    } as any]);
    expect(q).not.toHaveProperty("secrets");
    const raw = await fs.readFile(itemsFile(w.id), "utf8");
    expect(raw).not.toContain('"v"');
  });
});

describe("a verdict mid-append", () => {
  it("is never skipped by an agent read or wait that lands during the file write", async () => {
    // The demo launcher's test failed once in six runs with a read that saw
    // nothing and a cursor that had moved past the verdict; a stress loop of
    // reads during posts skipped every one. The seq was taken before the
    // append and the counter had already moved, so a read's empty answer
    // carried a cursor one past the verdict still being written.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-midappend-"));
    const store = new WalkStore(dir);
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a")]);
    const ctx = { url: "http://x/", viewport: [1, 1] as [number, number], console: [], userAgent: "t" };
    const appending = store.addVerdict(w.id, { itemId: "a", kind: "pass", text: "", nonce: "n1", context: ctx });
    // Both land while addVerdict is inside its fs.appendFile.
    const [r, wt] = await Promise.all([store.read(w.id, 0), store.wait(w.id, 0, 0)]);
    expect(r.verdicts).toEqual([]); expect(r.cursor).toBe(0);
    expect(wt.verdicts).toEqual([]); expect(wt.cursor).toBe(0);
    const v = await appending;
    expect(v.seq).toBe(1);
    const again = await store.read(w.id, r.cursor);
    expect(again.verdicts.map(x => x.seq)).toEqual([1]);
    expect(again.cursor).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

/**
 * F5 of the 2026-10-04 audit, at the daemon. An agent refused a value can ask
 * for it back through the page: a `text` expect that fails reports what it saw,
 * `buildId` is that same read on every verdict, and the console tail is the same
 * channel with less precision. The pane redacts all three on a card that carries
 * secrets; this is the daemon doing it again for a client that did not, because
 * `verdicts.jsonl` is forever.
 */
describe("a verdict on an item that carries secrets", () => {
  const KEY = "lp_live_4f9c2a7e1d0b8c6e";
  const withSecret = (id: string) => ({ ...look(id), secrets: [{ label: "Licence key", value: KEY }] });
  /** What an un-redacting pane would send: the key in all three fields. */
  const leaky = (itemId: string, nonce: string): VerdictInput => ({
    itemId, kind: "blocked", nonce,
    text: `expect[1] text #shown: wanted "saved", saw "${KEY}"`,
    context: { url: "http://127.0.0.1:9340/", viewport: [800, 600], userAgent: "ua",
      buildId: KEY, console: [{ level: "warn", text: `key accepted: ${KEY}`, at: "2026-10-04T00:00:00.000Z" }] },
  });

  it("redacts what the page was showing — the saw clause, buildId and the console tail — and never writes it down", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [withSecret("a")]);
    const v = await store.addVerdict(w.id, leaky("a", "n-1"));
    expect(v.text).toBe('expect[1] text #shown: wanted "saved", saw "(redacted, 24 chars)"');
    expect(v.context.buildId).toBe("(redacted, 24 chars)");
    expect(v.context.console[0]).toEqual({ level: "warn", text: "(redacted, 38 chars)", at: "2026-10-04T00:00:00.000Z" });
    // What the agent is handed, and what is on disk forever.
    expect(JSON.stringify(await store.read(w.id))).not.toContain(KEY);
    expect(await fs.readFile(path.join(dir, "p", w.id, "verdicts.jsonl"), "utf8")).not.toContain(KEY);
    // The agent's own expectation survives: it still knows what failed and how
    // long what the page showed was.
    expect(v.text).toContain('wanted "saved"');
  });

  it("leaves a verdict the pane already redacted exactly as it came, and says nothing about the length of the marker", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [withSecret("a")]);
    const already = 'expect[1] text #shown: wanted "saved", saw "(redacted, 24 chars)"';
    const v = await store.addVerdict(w.id, { ...leaky("a", "n-2"), text: already, context: { ...leaky("a", "n-2").context, buildId: "(redacted, 24 chars)", console: [] } });
    expect(v.text).toBe(already);
    expect(v.context.buildId).toBe("(redacted, 24 chars)");
  });

  it("leaves a verdict on an item with no secrets alone", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a")]);
    const v = await store.addVerdict(w.id, leaky("a", "n-3"));
    expect(v.text).toContain(KEY);
    expect(v.context.buildId).toBe(KEY);
    expect(v.context.console[0].text).toContain(KEY);
  });

  /**
   * SW-2 of the 2026-10-06 audit: the url was the one page-read field F5 missed.
   * The pane reads it off the live tab at verdict time, so a page that puts the
   * pasted value in a query string or a fragment was writing it to
   * verdicts.jsonl, which is forever.
   */
  it("cuts the url to its origin and path, and leaves one with nothing to cut as it was", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [withSecret("a")]);
    const base = leaky("a", "n-5");
    const v = await store.addVerdict(w.id, { ...base, context: { ...base.context, url: `http://127.0.0.1:9340/activate?key=${KEY}` } });
    expect(v.context.url).toBe("http://127.0.0.1:9340/activate");
    expect(await fs.readFile(path.join(dir, "p", w.id, "verdicts.jsonl"), "utf8")).not.toContain(KEY);
    const plain = await store.addVerdict(w.id, { ...base, nonce: "n-6", context: { ...base.context, url: "http://127.0.0.1:9340/activate" } });
    expect(plain.context.url).toBe("http://127.0.0.1:9340/activate");
  });

  it("leaves the url on an item with no secrets alone: that is where the agent is told to look", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a")]);
    const base = leaky("a", "n-7");
    const v = await store.addVerdict(w.id, { ...base, context: { ...base.context, url: "http://127.0.0.1:9340/activate?step=2#done" } });
    expect(v.context.url).toBe("http://127.0.0.1:9340/activate?step=2#done");
  });

  it("leaves the screenshot alone: whether the site is photographed is the person's setting", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [withSecret("a")]);
    const v = await store.addVerdict(w.id, { ...leaky("a", "n-4"), context: { ...leaky("a", "n-4").context, screenshotBase64: Buffer.from("not a jpeg").toString("base64") } });
    expect(v.context.screenshot).toBe("shots/000001.jpg");
  });
});

/**
 * On an early walk, through the MCP. Two things a refused add owes the agent that sent
 * it: a reply has to name an ask, and a refusal has to cost nothing.
 */
describe("a reply names an open ask", () => {
  const look = (id: string) => ({ id, kind: "look" as const, owner: "gate", title: id, url: "http://127.0.0.1:9340/",
    do: "d", see: "s", pass: "p", expect: [] });
  const info = (id: string, supersedes: string) => ({ id, kind: "info" as const, owner: "gate", title: id, body: "b", supersedes });
  const ask = (itemId: string, nonce: string, text: string): VerdictInput => ({ itemId, kind: "ask", text, nonce,
    context: { url: "http://127.0.0.1:9340/", viewport: [800, 600] as [number, number], console: [], userAgent: "ua" } });

  it("takes a reply to an ask the person is waiting on", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("q")]);
    await store.addVerdict(w.id, ask("q", "n-1", "is this the operator key?"));
    // Two answers in one add is a card of two blocks, not a refusal: the open
    // asks are read once, for the whole add.
    const replies = await store.addItems(w.id, [info("q-answer", "q"), info("q-answer-2", "q")]);
    expect(replies.map(i => i.seq)).toEqual([2, 3]);
    expect((await store.read(w.id)).items.map(i => i.id)).toEqual(["q", "q-answer", "q-answer-2"]);
  });

  it("refuses a supersedes naming an id this walk does not have", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("q")]);
    await store.addVerdict(w.id, ask("q", "n-1", "which build?"));
    await expect(store.addItems(w.id, [info("w14-a1", "w14-q1")])).rejects.toThrow(
      "w14-a1: supersedes w14-q1 is not an item of this walk. supersedes answers an open ask and nothing else, so nothing was added. Open asks: q.");
    expect((await store.read(w.id)).items.map(i => i.id)).toEqual(["q"]);
  });

  it("refuses a supersedes naming a withdrawn item, and leaves it out of the list", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("q"), look("r")]);
    await store.addVerdict(w.id, ask("q", "n-1", "which build?"));
    await store.addVerdict(w.id, ask("r", "n-2", "and which port?"));
    await store.withdraw(w.id, "q", "asked on the wrong card");
    await expect(store.addItems(w.id, [info("q-answer", "q")])).rejects.toThrow(
      "q-answer: supersedes q is withdrawn. supersedes answers an open ask and nothing else, so nothing was added. Open asks: r.");
  });

  it("refuses a supersedes naming an item nobody has asked about", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a")]);
    await expect(store.addItems(w.id, [info("a-answer", "a")])).rejects.toThrow(
      "a-answer: supersedes a has no open ask. supersedes answers an open ask and nothing else, so nothing was added. This walk has no open asks.");
    // The person's own verdict on the card closes the ask too.
    await store.addVerdict(w.id, ask("a", "n-1", "which build?"));
    await store.addVerdict(w.id, { ...verdict("a", "n-2"), text: "never mind, found it" });
    await expect(store.addItems(w.id, [info("a-answer", "a")])).rejects.toThrow(/has no open ask.*This walk has no open asks\./);
  });

  it("refuses a second reply to an ask an earlier reply already answered", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("q")]);
    await store.addVerdict(w.id, ask("q", "n-1", "which build?"));
    await store.addItems(w.id, [info("q-answer", "q")]);
    await expect(store.addItems(w.id, [info("q-answer-late", "q")])).rejects.toThrow(
      "q-answer-late: supersedes q has no open ask. supersedes answers an open ask and nothing else, so nothing was added. This walk has no open asks.");
    // The person asking again reopens it, and the next reply goes through.
    // The comparison is `addedAt` against the ask's `at`, both ISO strings off
    // the same clock, so the second question has to land in a later millisecond
    // than the first answer for this to be a second question at all.
    await new Promise(r => setTimeout(r, 2));
    await store.addVerdict(w.id, ask("q", "n-2", "and which port?"));
    expect((await store.addItems(w.id, [info("q-answer-2", "q")]))[0].seq).toBe(3);
  });

  it("refuses the whole add when one item of it names nothing open", async () => {
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("q")]);
    await store.addVerdict(w.id, ask("q", "n-1", "which build?"));
    await expect(store.addItems(w.id, [look("fine"), info("q-answer", "q"), info("stray", "nope")])).rejects.toThrow(/supersedes nope is not an item/);
    expect((await store.read(w.id)).items.map(i => i.id)).toEqual(["q"]);
    expect((await store.addItems(w.id, [look("fine")]))[0].seq).toBe(2);
  });
});

describe("a refused add costs nothing", () => {
  const look = (id: string) => ({ id, kind: "look" as const, owner: "gate", title: id, url: "http://127.0.0.1:9340/",
    do: "d", see: "s", pass: "p", expect: [] });

  it("spends no seq and writes no line when a file-backed secret is not there", async () => {
    // On an early walk: the add was refused with a clean message naming the folder, but
    // the first item of it had already taken its number, so the walk's items
    // ran 1–7 and then 9.
    const w = await store.open({ project: "p", title: "t", buildRef: "b" });
    await store.addItems(w.id, [look("a"), look("b")]);
    await expect(store.addItems(w.id, [look("c"), { ...look("d"), secrets: [{ label: "Key", file: "does-not-exist.txt" }] }]))
      .rejects.toThrow(/secret file not found: does-not-exist\.txt/);
    const after = await store.addItems(w.id, [look("e")]);
    expect(after[0].seq).toBe(3);
    expect((await store.read(w.id)).items.map(i => [i.id, i.seq])).toEqual([["a", 1], ["b", 2], ["e", 3]]);
    const lines = (await fs.readFile(path.join(dir, "p", w.id, "items.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    // And a restart reads the same three: the refusal left nothing on disk.
    expect((await new WalkStore(dir).read(w.id)).items.map(i => i.seq)).toEqual([1, 2, 3]);
  });
});
