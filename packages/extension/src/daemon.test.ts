import { describe, it, expect, vi, afterEach } from "vitest";
import { DaemonLink, DaemonReject, isTokenRefusal } from "./daemon.js";

const respond = (status: number, body: unknown) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

afterEach(() => vi.restoreAllMocks());

describe("DaemonLink reads", () => {
  // The launch-time e2e flake, caught by the worker console: the first refresh
  // listed walks from the default port, the port then moved, and the read for
  // one of those walks went to the new daemon, which answered 404
  // {error:"unknown walk"}. That body was stored as a view with no items, and
  // every refresh after it died dropping the poisoned view. A daemon that
  // says no is a rejection here, never a walk.
  it("read() rejects a 404 with the daemon's reason, and resolves a walk", async () => {
    respond(404, { error: "unknown walk walk-11" });
    await expect(new DaemonLink("http://127.0.0.1:1").read("walk-11")).rejects.toBeInstanceOf(DaemonReject);
    respond(200, { walk: { id: "w" }, items: [], verdicts: [], cursor: 0 });
    expect((await new DaemonLink("http://127.0.0.1:1").read("w")).items).toEqual([]);
  });
  it("read() rejects a 200 whose body is not a walk", async () => {
    respond(200, { error: "half a daemon" });
    await expect(new DaemonLink("http://127.0.0.1:1").read("w")).rejects.toThrow(/not a walk/);
  });
  it("walks() rejects a 5xx instead of handing back an error object", async () => {
    respond(503, { error: "shutting down" });
    await expect(new DaemonLink("http://127.0.0.1:1").walks()).rejects.toThrow(/503/);
  });
});

describe("DaemonLink.health", () => {
  it("carries the daemon's version, null when it does not say, and null when nothing answers", async () => {
    respond(200, { ok: true, version: "0.2.0", graceMs: 10_000 });
    expect(await new DaemonLink("http://127.0.0.1:1").health()).toEqual({ version: "0.2.0", graceMs: 10_000 });
    respond(200, { ok: true });
    expect(await new DaemonLink("http://127.0.0.1:1").health()).toEqual({ version: null, graceMs: null });
    respond(200, { ok: false });
    expect(await new DaemonLink("http://127.0.0.1:1").health()).toBeNull();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await new DaemonLink("http://127.0.0.1:1").health()).toBeNull();
  });

  // The window is what the ledge's drain bar is drawn from, so a daemon that
  // says something that is not a window has to read as "did not say" — the bar
  // is left undrawn rather than drained against a number we invented.
  it("carries the free-Undo window, and null for anything that is not one", async () => {
    const health = () => new DaemonLink("http://127.0.0.1:1").health();
    respond(200, { ok: true, version: "0.3.0", graceMs: 0 });
    expect((await health())?.graceMs).toBe(0);
    for (const graceMs of ["10000", -1, Infinity, NaN, null, undefined]) {
      respond(200, { ok: true, version: "0.3.0", graceMs });
      expect((await health())?.graceMs, `graceMs: ${String(graceMs)}`).toBeNull();
    }
  });
});

describe("DaemonLink.subscribeAll", () => {
  /** A daemon whose /events stream says exactly these frames and then ends. */
  const streamOf = (frames: string[]) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(c) {
          const enc = new TextEncoder();
          // Split across chunk boundaries: SSE frames do not arrive whole.
          const text = frames.join("");
          for (let i = 0; i < text.length; i += 7) c.enqueue(enc.encode(text.slice(i, i + 7)));
          c.close();
        },
      }), { status: 200 }));

  it("demultiplexes by walk id, unwraps open, and drops pings", async () => {
    streamOf([
      `event: ping\ndata: 1\n\n`,
      `event: item\ndata: ${JSON.stringify({ walk: "w1", data: { id: "a", seq: 1 } })}\n\n`,
      `event: close\ndata: ${JSON.stringify({ walk: "w2", data: { id: "w2", closedAt: "now" } })}\n\n`,
      `event: open\ndata: ${JSON.stringify({ walk: { id: "w3", title: "Three" } })}\n\n`,
    ]);
    const seen: unknown[] = [];
    await new DaemonLink("http://127.0.0.1:1").subscribeAll(e => seen.push(e), new AbortController().signal);
    expect(seen).toEqual([
      { event: "item", walk: "w1", data: { id: "a", seq: 1 } },
      { event: "close", walk: "w2", data: { id: "w2", closedAt: "now" } },
      { event: "open", walk: "w3", data: { id: "w3", title: "Three" } },
    ]);
  });

  it("drops a frame it cannot place rather than putting it on the wrong walk", async () => {
    streamOf([
      `event: item\ndata: ${JSON.stringify({ data: { id: "a" } })}\n\n`,          // no walk
      `event: open\ndata: ${JSON.stringify({ walk: "w1" })}\n\n`,                 // an id, not a header
      `event: nonsense\ndata: ${JSON.stringify({ walk: "w1", data: 1 })}\n\n`,
    ]);
    const seen: unknown[] = [];
    await new DaemonLink("http://127.0.0.1:1").subscribeAll(e => seen.push(e), new AbortController().signal);
    expect(seen).toEqual([]);
  });
});

/**
 * The token on the wire (secrets review). Every request carries it, the
 * streams included; nothing is sent when there is none, so a daemon too old to
 * want one is unaffected; and a 401 is a rejection with its status, which is
 * what lets the worker tell "wants its token" from "went away".
 */
describe("DaemonLink and the daemon's token", () => {
  /** What the last request carried in `Authorization`, if anything. */
  const sent = () => {
    const calls = vi.mocked(globalThis.fetch).mock.calls as unknown as [string, RequestInit][];
    return (calls[calls.length - 1][1]?.headers as Record<string, string> | undefined)?.authorization;
  };

  it("sends it on health, a read and a post, and sends nothing when there is none", async () => {
    respond(200, { ok: true, version: "0.3.0", graceMs: 0 });
    await new DaemonLink("http://127.0.0.1:1", "tok-1").health();
    expect(sent()).toBe("Bearer tok-1");

    respond(200, { walk: { id: "w" }, items: [], verdicts: [], cursor: 0 });
    await new DaemonLink("http://127.0.0.1:1", "tok-1").read("w");
    expect(sent()).toBe("Bearer tok-1");

    respond(200, { seq: 1, at: "now" });
    await new DaemonLink("http://127.0.0.1:1", "tok-1").postVerdict("w", { itemId: "a", kind: "pass", text: "", nonce: "n", context: { url: "", viewport: [0, 0], console: [], userAgent: "" } } as never);
    expect(sent()).toBe("Bearer tok-1");

    respond(200, { ok: true });
    await new DaemonLink("http://127.0.0.1:1").health();
    expect(sent()).toBeUndefined();
  });

  it("setToken is what a paste into the gear changes", async () => {
    respond(200, { ok: true });
    const link = new DaemonLink("http://127.0.0.1:1", "old");
    link.setToken("new");
    await link.health();
    expect(sent()).toBe("Bearer new");
  });

  it("rejects a 401 on the stream as a DaemonReject, so a retry ladder is never started for it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "walkd needs its token" }), { status: 401 }));
    const fail = new DaemonLink("http://127.0.0.1:1").subscribeAll(() => {}, new AbortController().signal);
    await expect(fail).rejects.toBeInstanceOf(DaemonReject);
    await expect(fail).rejects.toThrow(/401/);
    // And on a read, which is where a refreshing worker meets it first.
    await expect(new DaemonLink("http://127.0.0.1:1").walks()).rejects.toBeInstanceOf(DaemonReject);
  });

  /**
   * The rule the worker's three 401 branches share, in the one place they all
   * ask: a wrong token is never a reason to climb the reconnect ladder. The
   * daemon is answering; what it wants is a paste, and a retry cannot produce
   * one. Everything else the worker meets still takes the ladder.
   */
  it("a 401 is a token refusal and nothing else is", async () => {
    respond(401, { error: "walkd needs its token" });
    await expect(new DaemonLink("http://127.0.0.1:1").walks()).rejects.toSatisfy(isTokenRefusal);
    for (const status of [400, 403, 404, 409]) {
      respond(status, { error: "no" });
      await expect(new DaemonLink("http://127.0.0.1:1").walks()).rejects.not.toSatisfy(isTokenRefusal);
    }
    // A daemon that went away is a plain Error, so the ladder is its answer.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(new DaemonLink("http://127.0.0.1:1").walks()).rejects.not.toSatisfy(isTokenRefusal);
    expect(isTokenRefusal(undefined)).toBe(false);
  });
});
