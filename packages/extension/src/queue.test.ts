import { describe, it, expect } from "vitest";
import { VerdictQueue, pickTerminal } from "./queue.js";
import { DaemonReject } from "./daemon.js";

const mem = () => { const m: Record<string, unknown> = {}; return { get: async (k: string) => m[k], set: async (k: string, v: unknown) => { m[k] = v; }, m }; };
const draft = (n: string) => ({ itemId: "a", kind: "pass" as const, text: "ok", nonce: n,
  context: { url: "u", viewport: [1, 1] as [number, number], console: [], userAgent: "ua" } });

describe("VerdictQueue", () => {
  it("persists, flushes in order, keeps failures queued", async () => {
    const st = mem(); const sent: string[] = []; let fail = true;
    const q = new VerdictQueue(st, async (_w, v) => { if (fail) throw new Error("down"); sent.push(v.nonce); });
    await q.enqueue("w", draft("n1")); await q.enqueue("w", draft("n2"));
    await q.flush();
    expect(sent).toEqual([]); expect(await q.size()).toBe(2);
    expect((st.m["walkd:queue"] as any[]).length).toBe(2);
    fail = false; await q.flush();
    expect(sent).toEqual(["n1", "n2"]); expect(await q.size()).toBe(0);
  });
  it("a fresh queue over the same storage resumes the backlog", async () => {
    const st = mem(); const q1 = new VerdictQueue(st, async () => { throw new Error("down"); });
    await q1.enqueue("w", draft("n1"));
    const sent: string[] = []; const q2 = new VerdictQueue(st, async (_w, v) => { sent.push(v.nonce); });
    await q2.flush(); expect(sent).toEqual(["n1"]);
  });

  it("a rejection the daemon will never accept buries the entry and the rest still sends", async () => {
    const st = mem(); const sent: string[] = [];
    const q = new VerdictQueue(st, async (_w, v) => {
      if (v.nonce === "n1") throw new DaemonReject(400, "walkd 400: bad verdict");
      sent.push(v.nonce);
    });
    await q.enqueue("w", draft("n1")); await q.enqueue("w", draft("n2"));
    await q.flush();
    expect(sent).toEqual(["n2"]);
    expect(await q.size()).toBe(0);
    const dead = await q.dead();
    expect(dead.map(d => d.verdict.itemId)).toEqual(["a"]);
    expect(dead[0].error).toContain("400");
    expect(dead[0].walk).toBe("w");
  });

  it("buries the item and the kind, and not the screenshot", async () => {
    // `walkd:dead` keeps its last fifty entries indefinitely, so a context on
    // one is a picture of the walked site — a value the person had just pasted
    // included — parked in the Chrome profile for good, for a verdict that never
    // landed. Audit 2026-10-04, F4.
    const st = mem();
    const q = new VerdictQueue(st, async () => { throw new DaemonReject(400, "walkd 400: bad verdict"); });
    await q.enqueue("w", { ...draft("n1"), context: { ...draft("n1").context, screenshotBase64: "/9j/SECRETPIXELS", console: ["Key saved: sk-test-0001"] } });
    await q.flush();
    const dead = await q.dead();
    expect(dead).toEqual([{ walk: "w", verdict: { itemId: "a", kind: "pass" }, error: "walkd 400: bad verdict", at: expect.any(String) }]);
    expect(JSON.stringify(st.m["walkd:dead"])).not.toContain("SECRETPIXELS");
    expect(JSON.stringify(st.m["walkd:dead"])).not.toContain("sk-test-0001");
    // And the queue it came off is empty, so the screenshot is gone from there
    // too — it only ever sat in `walkd:queue` while the daemon was down.
    expect(st.m["walkd:queue"]).toEqual([]);
  });

  it("a network error still blocks the entry behind it", async () => {
    const st = mem(); const sent: string[] = [];
    const q = new VerdictQueue(st, async (_w, v) => {
      if (v.nonce === "n1") throw new TypeError("Failed to fetch");
      sent.push(v.nonce);
    });
    await q.enqueue("w", draft("n1")); await q.enqueue("w", draft("n2"));
    await q.flush();
    expect(sent).toEqual([]); expect(await q.size()).toBe(2); expect(await q.dead()).toEqual([]);
  });

  it("a 5xx or a 429 is retried, not buried", async () => {
    const st = mem(); const sent: string[] = []; let down = true;
    const q = new VerdictQueue(st, async (_w, v) => {
      if (down) throw new DaemonReject(503, "walkd 503");
      sent.push(v.nonce);
    });
    await q.enqueue("w", draft("n1"));
    await q.flush();
    expect(await q.size()).toBe(1); expect(await q.dead()).toEqual([]);
    down = false; await q.flush(); expect(sent).toEqual(["n1"]);
  });

  it("forgets an item's dead letters once it has been answered again", async () => {
    // The pane tells the human a refused verdict needs answering again; when
    // they do, the notice has to go, or the card asks forever.
    const st = mem(); const q = new VerdictQueue(st, async () => { throw new DaemonReject(400, "walkd 400"); });
    await q.enqueue("w", { ...draft("n1"), itemId: "a" });
    await q.enqueue("w", { ...draft("n2"), itemId: "b" });
    await q.flush();
    expect((await q.dead()).map(d => d.verdict.itemId)).toEqual(["a", "b"]);
    await q.clearDead("a");
    expect((await q.dead()).map(d => d.verdict.itemId)).toEqual(["b"]);
    await q.clearDead("nobody");
    expect((await q.dead()).length).toBe(1);
  });

  it("enriches a queued entry in place by nonce, and ignores one already sent", async () => {
    const st = mem(); const sent: any[] = [];
    const q = new VerdictQueue(st, async (_w, v) => { sent.push(v); });
    await q.enqueue("w", draft("n1"));
    expect(await q.patch("n1", { ...draft("n1").context, buildId: "fac3493f" })).toBe(true);
    await q.flush();
    expect(sent[0].context.buildId).toBe("fac3493f");
    expect(await q.patch("n1", draft("n1").context)).toBe(false);
  });
});

describe("pickTerminal", () => {
  it("buries only what re-sending cannot fix", () => {
    expect([400, 404, 413].map(pickTerminal)).toEqual([true, true, true]);
    expect([401, 408, 429, 500, 503].map(pickTerminal)).toEqual([false, false, false, false, false]);
  });
});
