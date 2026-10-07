import { describe, it, expect } from "vitest";
import { inflight, inflightBy, backoffMs, latest } from "./once.js";

const defer = <T>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

describe("inflight", () => {
  it("runs once while pending and hands both callers the same promise", async () => {
    const d = defer<number>(); let calls = 0;
    const run = inflight(() => { calls++; return d.promise; });
    const a = run(); const b = run();
    expect(calls).toBe(1); expect(a).toBe(b);
    d.resolve(7);
    expect(await a).toBe(7); expect(await b).toBe(7);
  });
  it("runs again once the previous call has settled", async () => {
    let calls = 0;
    const run = inflight(async () => { calls++; });
    await run(); await run();
    expect(calls).toBe(2);
  });
  it("clears on rejection, so a failed run does not wedge the next one", async () => {
    let calls = 0;
    const run = inflight(async () => { calls++; if (calls === 1) throw new Error("down"); });
    await expect(run()).rejects.toThrow("down");
    await run();
    expect(calls).toBe(2);
  });
});

describe("latest", () => {
  it("never answers a caller with a run that started before it asked", async () => {
    // The pane says hello and waits on the answer. A walk opened between the
    // start of a refresh and that hello has to be in what comes back, or it is
    // missing from the pane until the next alarm, half a minute later.
    const d = [defer<number>(), defer<number>()];
    let calls = 0;
    const run = latest(() => d[calls++].promise);
    const first = run();
    const asked = run();
    expect(calls).toBe(1);                        // waits rather than running two at once
    d[0].resolve(1);
    expect(await first).toBe(1);
    expect(calls).toBe(2);                        // and then runs again, for the later caller
    d[1].resolve(2);
    expect(await asked).toBe(2);
  });

  it("gives everyone who asked during one run the same next run", async () => {
    const d = [defer<number>(), defer<number>()];
    let calls = 0;
    const run = latest(() => d[calls++].promise);
    const first = run();
    const b = run();
    const c = run();
    expect(b).toBe(c);
    d[0].resolve(1); d[1].resolve(2);
    expect(await first).toBe(1);
    expect(await b).toBe(2);
    expect(await c).toBe(2);
    expect(calls).toBe(2);
  });

  it("runs the waiting call even when the one before it failed", async () => {
    let calls = 0;
    const run = latest(async () => { calls++; if (calls === 1) throw new Error("down"); return calls; });
    const first = run();
    const after = run();
    await expect(first).rejects.toThrow("down");
    expect(await after).toBe(2);
  });

  it("starts fresh once everything has settled", async () => {
    let calls = 0;
    const run = latest(async () => ++calls);
    expect(await run()).toBe(1);
    expect(await run()).toBe(2);
  });
});

describe("inflightBy", () => {
  it("collapses calls for the same key and lets other keys run", async () => {
    const d = { a: defer<void>(), b: defer<void>() };
    const calls: string[] = [];
    const run = inflightBy((k: "a" | "b") => { calls.push(k); return d[k].promise; });
    const first = run("a"); const again = run("a"); const other = run("b");
    expect(calls).toEqual(["a", "b"]);
    expect(first).toBe(again);
    d.a.resolve(); d.b.resolve();
    await Promise.all([first, again, other]);
  });
  it("runs a key again once its previous call has settled", async () => {
    const calls: string[] = [];
    const run = inflightBy(async (k: string) => { calls.push(k); });
    await run("a"); await run("a"); await run("b");
    expect(calls).toEqual(["a", "a", "b"]);
  });
});

describe("backoffMs", () => {
  it("waits 1s, then 2s, then 5s for every attempt after", () => {
    expect([0, 1, 2, 3, 9].map(backoffMs)).toEqual([1000, 2000, 5000, 5000, 5000]);
  });
});
