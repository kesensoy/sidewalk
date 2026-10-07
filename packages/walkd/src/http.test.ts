import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises"; import { readFileSync } from "node:fs"; import os from "node:os"; import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WalkStore } from "./store.js";
import { createHttpServer, clampWait, MAX_WAIT_MS, VERSION } from "./http.js";

let base: string; let port = 0; let server: ReturnType<typeof createHttpServer>;
beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-http-"));
  server = createHttpServer(new WalkStore(dir));
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
afterEach(() => new Promise<void>(r => server.close(() => r())));

const post = (p: string, body: unknown) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * A request with the headers a browser would send, which `fetch` will not let
 * a test set: `Host` is forbidden to it outright, and `Origin` it overwrites.
 * Resolves on the response head, so an SSE route that was allowed answers here
 * too instead of hanging on a stream that never ends.
 */
function raw(p: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}, onPort = port): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: onPort, path: p, method: opts.method ?? "GET", headers: opts.headers ?? {} }, res => {
      let got = ""; res.setEncoding("utf8");
      res.on("data", c => { got += c; if (got.includes("\n\n")) { resolve({ status: res.statusCode!, body: got }); req.destroy(); } });
      res.on("end", () => resolve({ status: res.statusCode!, body: got }));
      res.on("error", () => {});
    });
    req.on("error", e => { if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e); });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
const look = (id: string) => ({ id, kind: "look", owner: "gate", title: id, url: "http://127.0.0.1:9340/", do: "d", see: "s", pass: "p", expect: [] });
const verdict = (itemId: string, nonce: string) => ({ itemId, kind: "pass", text: "ok", nonce,
  context: { url: "http://127.0.0.1:9340/", viewport: [800, 600], console: [], userAgent: "ua" } });

/** An SSE response read one `event: … / data: …` frame at a time, in order. */
function reader(res: Response) {
  const r = res.body!.getReader();
  const dec = new TextDecoder();
  const queue: { event: string; data: any }[] = [];
  let buf = "";
  const next = async (): Promise<{ event: string; data: any }> => {
    while (!queue.length) {
      const { value, done } = await r.read();
      if (done) throw new Error("stream ended");
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (event && data) queue.push({ event, data: JSON.parse(data) });
      }
    }
    return queue.shift()!;
  };
  return {
    next,
    /** The next `n` frames, pings dropped — a heartbeat is not an event. */
    async take(n: number) {
      const out: { event: string; data: any }[] = [];
      while (out.length < n) { const f = await next(); if (f.event !== "ping") out.push(f); }
      return out;
    },
    cancel: () => r.cancel(),
  };
}

describe("http face", () => {
  it("health, open, list, add items, read", async () => {
    expect((await (await fetch(base + "/health")).json()).ok).toBe(true);
    const w = await (await post("/walks", { project: "p", title: "Walk 11", buildRef: "b" })).json();
    expect(w.id).toBe("walk-11");
    expect((await (await fetch(base + "/walks")).json()).map((x: any) => x.id)).toEqual(["walk-11"]);
    const items = await (await post("/walks/walk-11/items", { items: [look("a")] })).json();
    expect(items[0].seq).toBe(1);
    const r = await (await fetch(base + "/walks/walk-11")).json();
    expect(r.items).toHaveLength(1); expect(r.cursor).toBe(0);
  });

  it("answers 404 when a pane subscribes to a walk it does not have, and stays up", async () => {
    // This one took the daemon down: `sse` looks the walk up first, that
    // rejection went past the request handler's try as an unhandled rejection,
    // and Node killed the process. A pane pointed at a second daemon asks for
    // the first one's walk on its next reconnect, so it is not a rare path.
    const res = await fetch(base + "/walks/nope/events");
    expect(res.status).toBe(404);
    await res.body?.cancel();
    expect((await (await fetch(base + "/health")).json()).ok).toBe(true);
  });

  it("404 on unknown walk, 400 on a bad item", async () => {
    expect((await fetch(base + "/walks/nope")).status).toBe(404);
    await post("/walks", { project: "p", title: "t", buildRef: "b" });
    const res = await post("/walks/t/items", { items: [{ id: "x", kind: "look", owner: "g", title: "t" }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/url|do|see|pass/);
  });

  it("400s a supersedes that names no open ask, and the body says which asks are open", async () => {
    // On an early walk: an `info` superseding a withdrawn question nobody had asked
    // landed without a word, so the agent could believe it had answered an ask.
    await post("/walks", { project: "p", title: "t", buildRef: "b" });
    await post("/walks/t/items", { items: [look("q"), look("r")] });
    const none = await post("/walks/t/items", { items: [{ id: "a1", kind: "info", owner: "g", title: "answer", body: "b", supersedes: "q" }] });
    expect(none.status).toBe(400);
    expect((await none.json()).error).toBe("a1: supersedes q has no open ask. supersedes answers an open ask and nothing else, so nothing was added. This walk has no open asks.");
    await post("/walks/t/verdicts", { ...verdict("q", "nonce-ask-1"), kind: "ask", text: "which build?" });
    await post("/walks/t/verdicts", { ...verdict("r", "nonce-ask-2"), kind: "ask", text: "and which port?" });
    const wrong = await post("/walks/t/items", { items: [{ id: "a2", kind: "info", owner: "g", title: "answer", body: "b", supersedes: "w14-q1" }] });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe("a2: supersedes w14-q1 is not an item of this walk. supersedes answers an open ask and nothing else, so nothing was added. Open asks: q, r.");
    // Nothing of either refused add is on the walk, and the next seq is 3.
    const read = await (await fetch(base + "/walks/t")).json();
    expect(read.items.map((i: { id: string; seq: number }) => [i.id, i.seq])).toEqual([["q", 1], ["r", 2]]);
    const good = await post("/walks/t/items", { items: [{ id: "a3", kind: "info", owner: "g", title: "answer", body: "b", supersedes: "q" }] });
    expect(good.status).toBe(200);
    expect((await good.json())[0].seq).toBe(3);
  });

  it("posts a verdict and wait() returns it", async () => {
    await post("/walks", { project: "p", title: "t", buildRef: "b" });
    await post("/walks/t/items", { items: [look("a")] });
    const waiting = fetch(base + "/walks/t/wait?after=0&timeoutMs=3000");
    await new Promise(r => setTimeout(r, 20));
    const v = await (await post("/walks/t/verdicts", verdict("a", "nonce-0001"))).json();
    expect(v.seq).toBe(1);
    const got = await (await waiting).json();
    expect(got.verdicts[0].nonce).toBe("nonce-0001"); expect(got.cursor).toBe(1);
  });

  it("streams items over SSE", async () => {
    await post("/walks", { project: "p", title: "t", buildRef: "b" });
    const res = await fetch(base + "/walks/t/events");
    const reader = res.body!.getReader(); const dec = new TextDecoder();
    await post("/walks/t/items", { items: [look("a")] });
    let buf = "";
    while (!buf.includes("event: item")) buf += dec.decode((await reader.read()).value);
    expect(buf).toContain('"id":"a"');
    await post("/walks/t/items/a/withdraw", { reason: "gone" });
    while (!buf.includes("event: withdraw")) buf += dec.decode((await reader.read()).value);
    await post("/walks/t/close", { summary: "done" });
    while (!buf.includes("event: close")) buf += dec.decode((await reader.read()).value);
    reader.cancel();
  });

  it("multiplexes every walk onto one /events stream, each frame naming its walk", async () => {
    // One connection for the whole daemon. A browser gives one origin six, so
    // a client that opened one stream per walk stalled its own health checks
    // and posts behind them past the sixth walk.
    await post("/walks", { project: "p", id: "one", title: "One", buildRef: "b" });
    await post("/walks", { project: "p", id: "two", title: "Two", buildRef: "b" });
    const frames = reader(await fetch(base + "/events"));
    // The stream says hello with a ping straight away (and every 15 s after).
    expect(await frames.next()).toEqual({ event: "ping", data: expect.any(Number) });

    await post("/walks/one/items", { items: [look("i1")] });
    await post("/walks/two/items", { items: [look("i2")] });
    await post("/walks/one/items/i1/withdraw", { reason: "gone" });
    await post("/walks/two/close", { summary: "done" });
    // Opened after the subscription: the client hears about it without asking.
    await post("/walks", { project: "p", id: "three", title: "Three", buildRef: "b" });

    expect(await frames.take(5)).toEqual([
      { event: "item", data: { walk: "one", data: expect.objectContaining({ id: "i1", seq: 1 }) } },
      { event: "item", data: { walk: "two", data: expect.objectContaining({ id: "i2", seq: 1 }) } },
      { event: "withdraw", data: { walk: "one", data: expect.objectContaining({ id: "i1", withdrawReason: "gone" }) } },
      { event: "close", data: { walk: "two", data: expect.objectContaining({ id: "two", summary: "done" }) } },
      { event: "open", data: { walk: expect.objectContaining({ id: "three", title: "Three" }) } },
    ]);
    await frames.cancel();
  });

  it("the per-walk stream is unchanged by the multiplexed one: its frames carry the payload alone", async () => {
    await post("/walks", { project: "p", id: "solo", title: "Solo", buildRef: "b" });
    const frames = reader(await fetch(base + "/walks/solo/events"));
    expect((await frames.next()).event).toBe("ping");
    await post("/walks/solo/items", { items: [look("s1")] });
    // No `walk` wrapper, and no `open` frame for a walk opened meanwhile.
    await post("/walks", { project: "p", id: "other", title: "Other", buildRef: "b" });
    await post("/walks/solo/items", { items: [look("s2")] });
    expect(await frames.take(2)).toEqual([
      { event: "item", data: expect.objectContaining({ id: "s1" }) },
      { event: "item", data: expect.objectContaining({ id: "s2" }) },
    ]);
    await frames.cancel();
  });

  it("400s on a non-integer after, on both the read and the wait route", async () => {
    await post("/walks", { project: "p", title: "t", buildRef: "b" });
    for (const p of ["/walks/t?after=abc", "/walks/t/wait?after=abc&timeoutMs=0"]) {
      const res = await fetch(base + p);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "after must be a non-negative integer" });
    }
    for (const bad of ["-1", "1.5", "Infinity"]) {
      expect((await fetch(`${base}/walks/t?after=${bad}`)).status).toBe(400);
    }
    expect((await fetch(`${base}/walks/t?after=0`)).status).toBe(200);
    expect((await fetch(`${base}/walks/t?after=${Number.MAX_SAFE_INTEGER}`)).status).toBe(200);
  });

  it("clamps a wait under undici's 300 s headersTimeout, not to ten minutes", () => {
    expect(MAX_WAIT_MS).toBe(280000);
    expect(clampWait("600000")).toBe(280000);
    expect(clampWait("280001")).toBe(280000);
    expect(clampWait("1000")).toBe(1000);
    expect(clampWait(null)).toBe(0);
  });

  it("rejects bodies over 8 MB with 413", async () => {
    await post("/walks", { project: "p", title: "t", buildRef: "b" });
    const res = await fetch(base + "/walks/t/verdicts", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(8 * 1024 * 1024 + 1) });
    expect(res.status).toBe(413);
  });

  // `?viewer=1` is the pane, which needs the value to put it on the clipboard;
  // every other read is an agent's, and the agent already knows the value.
  it("serves a secret's value to the pane and on the stream, its label alone to an agent", async () => {
    await post("/walks", { project: "p", title: "t", buildRef: "b" });
    const stream = reader(await fetch(base + "/walks/t/events"));
    await post("/walks/t/items", { items: [{ ...look("a"), secrets: [{ label: "Licence key", value: "sk-test-0001" }] }] });

    const [frame] = await stream.take(1);
    expect(frame.event).toBe("item");
    expect(frame.data.secrets).toEqual([{ label: "Licence key", value: "sk-test-0001" }]);

    const viewer = await (await fetch(base + "/walks/t?viewer=1")).json();
    expect(viewer.items[0].secrets).toEqual([{ label: "Licence key", value: "sk-test-0001" }]);

    const agent = await (await fetch(base + "/walks/t")).json();
    expect(agent.items[0].secrets).toEqual([{ label: "Licence key" }]);
    expect(JSON.stringify(agent)).not.toContain("sk-test-0001");
    await stream.cancel();
  });
});

// walkd has no login, so these three headers are everything it can check. The
// Host rule is what a rebinding page fails; the Origin and Content-Type rules
// are what an ordinary web page fails, and a forged verdict is the thing they
// really stop.
describe("the three headers a daemon with no login can check", () => {
  it("refuses a request whose Host is not this daemon's own loopback address", async () => {
    const rebind = await raw("/health", { headers: { host: "attacker.example:8760" } });
    expect(rebind.status).toBe(403);
    expect(JSON.parse(rebind.body).error).toContain("loopback");
    // The right name on the wrong port is still somebody else's daemon.
    expect((await raw("/health", { headers: { host: `127.0.0.1:${port + 1}` } })).status).toBe(403);
    // A bare name carries no port, so it is not this daemon's address either.
    expect((await raw("/health", { headers: { host: "localhost" } })).status).toBe(403);
  });

  it("accepts the three spellings of this port on loopback", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
      expect((await raw("/health", { headers: { host } })).status).toBe(200);
  });

  it("refuses a POST that is not application/json, which is the one a page can send", async () => {
    const open = JSON.stringify({ project: "p", title: "t", buildRef: "b" });
    for (const headers of [{ "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }, {}]) {
      const res = await raw("/walks", { method: "POST", headers: { host: `127.0.0.1:${port}`, ...headers }, body: open });
      expect(res.status).toBe(415);
    }
    // A charset is part of the type a browser or a library may send.
    expect((await raw("/walks", { method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json; charset=utf-8" }, body: open })).status).toBe(200);
  });

  it("accepts a JSON POST with no Origin and one from an extension, and refuses a page's", async () => {
    // No Origin at all: every Node client there is, the MCP client included.
    expect((await post("/walks", { project: "p", title: "t", buildRef: "b" })).status).toBe(200);
    const items = (n: string) => JSON.stringify({ items: [look(n)] });
    for (const origin of ["chrome-extension://abcdefghijklmnopabcdefghijklmnop", "moz-extension://1234-5678"]) {
      const res = await raw("/walks/t/items", { method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", origin }, body: items(origin.slice(0, 3)) });
      expect(res.status).toBe(200);
    }
    for (const origin of ["https://evil.example", "http://127.0.0.1:9340", "null"]) {
      const res = await raw("/walks/t/items", { method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", origin }, body: items("x") });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error).toBe("origin not allowed");
    }
  });

  it("holds on both SSE routes, which are where a value would be read", async () => {
    await post("/walks", { project: "p", title: "t", buildRef: "b" });
    for (const p of ["/events", "/walks/t/events"]) {
      expect((await raw(p, { headers: { host: "attacker.example:8760" } })).status).toBe(403);
      expect((await raw(p, { headers: { host: `127.0.0.1:${port}`, origin: "https://evil.example" } })).status).toBe(403);
      const allowed = await raw(p, { headers: { host: `127.0.0.1:${port}`, origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" } });
      expect(allowed.status).toBe(200);
      expect(allowed.body).toContain("event: ping");
    }
    // And the pane's own read of a value obeys it too.
    expect((await raw("/walks/t?viewer=1", { headers: { host: "attacker.example:8760" } })).status).toBe(403);
  });
});

/**
 * The token: the one thing that tells this daemon's own clients from every
 * other program on the machine (secrets review). The server the rest of
 * this file uses has none — an embedder's choice, and `walkd serve` always
 * passes one — so this block serves its own.
 */
describe("the daemon's token, kept across restarts", () => {
  const TOKEN = "T-O-K-E-N_8Tq3xhO2aVcl";
  const FILE = "/tmp/walkd-test/token";
  let tserver: ReturnType<typeof createHttpServer>; let tbase: string; let tport = 0;
  const withToken = (p: string, init: RequestInit = {}) =>
    fetch(tbase + p, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${TOKEN}` } });
  const tpost = (p: string, body: unknown) =>
    withToken(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-token-"));
    tserver = createHttpServer(new WalkStore(dir), { auth: { token: TOKEN, file: FILE } });
    await new Promise<void>(r => tserver.listen(0, "127.0.0.1", r));
    tport = (tserver.address() as AddressInfo).port;
    tbase = `http://127.0.0.1:${tport}`;
  });
  afterEach(() => new Promise<void>(r => tserver.close(() => r())));

  it("leaves /health open, and says there that it wants one", async () => {
    const h = await (await fetch(tbase + "/health")).json();
    // `pid` and `startedAt` are the identity half, checked in cli.test.ts against
    // the state file; here only that they are there and are this process's.
    expect(h).toEqual({ ok: true, version: VERSION, graceMs: 0, auth: "token", pid: process.pid, startedAt: expect.any(String) });
    // The daemon the rest of this file uses has no token, and says so on the
    // same field — which is how a client tells the two apart.
    expect((await (await fetch(base + "/health")).json()).auth).toBe("none");
  });

  it("401s every other route without it, and names the file in the message", async () => {
    expect((await tpost("/walks", { project: "p", id: "t", title: "t", buildRef: "b" })).status).toBe(200);
    for (const p of ["/walks", "/walks/t", "/walks/t?viewer=1", "/walks/t/wait?after=0&timeoutMs=0", "/events", "/walks/t/events", "/nope"]) {
      const res = await fetch(tbase + p);
      expect(res.status, p).toBe(401);
      const { error } = await res.json();
      expect(error).toContain(FILE);
      expect(error).toContain("Bearer");
    }
    const open = await fetch(tbase + "/walks", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(open.status).toBe(401);
  });

  it("401s a wrong token, one of another length, and a header that is not a Bearer", async () => {
    for (const authorization of [`Bearer ${TOKEN}x`, "Bearer wrong", `Basic ${TOKEN}`, "Bearer", "Bearer ", TOKEN, ""]) {
      const res = await fetch(tbase + "/walks", { headers: { authorization } });
      expect(res.status, authorization || "(empty)").toBe(401);
    }
    // The spelling of the scheme is not the person's problem.
    expect((await fetch(tbase + "/walks", { headers: { authorization: `bearer ${TOKEN}` } })).status).toBe(200);
  });

  it("serves every route with it, the pane's read of a value and both streams included", async () => {
    expect((await tpost("/walks", { project: "p", id: "t", title: "t", buildRef: "b" })).status).toBe(200);
    expect((await tpost("/walks/t/items", { items: [{ ...look("a"), secrets: [{ label: "Licence key", value: "sk-test-0001" }] }] })).status).toBe(200);
    const viewer = await (await withToken("/walks/t?viewer=1")).json();
    expect(viewer.items[0].secrets).toEqual([{ label: "Licence key", value: "sk-test-0001" }]);
    expect((await withToken("/walks")).status).toBe(200);
    expect((await withToken("/walks/t/wait?after=0&timeoutMs=0")).status).toBe(200);
    for (const p of ["/events", "/walks/t/events"]) {
      const res = await withToken(p);
      expect(res.status, p).toBe(200);
      await res.body?.cancel();
    }
  });

  it("is checked after the three header guards, so a rebinding page with the token is still refused", async () => {
    const res = await raw("/walks", { headers: { host: "attacker.example:8760", authorization: `Bearer ${TOKEN}` } }, tport);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toContain("loopback");
  });
});

// The number on /health is the package's own, never a literal in the source,
// and `version` on the wire is the only thing an advertised version changes.
describe("health version", () => {
  const pkgVersion = () => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

  it("/health carries the package's own version", async () => {
    const h = await (await fetch(base + "/health")).json();
    expect(h.version).toBe(pkgVersion());
    expect(VERSION).toBe(pkgVersion());
  });

  it("an advertised version overrides it on the wire only", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-http-"));
    const s = createHttpServer(new WalkStore(dir, { graceMs: 0 }), { version: "9.9.9" });
    await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as AddressInfo).port;
    expect((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).version).toBe("9.9.9");
    expect(VERSION).not.toBe("9.9.9");
    s.close();
  });
});

// The free-Undo window, on /health because the pane draws it: a ledge row's
// drain bar is this number, and a pane that cannot read it draws no bar.
describe("health graceMs", () => {
  it("/health carries the window the store is enforcing", async () => {
    // The `base` server of this file's beforeEach: a store built with no
    // window at all, which is the library default.
    expect((await (await fetch(base + "/health")).json()).graceMs).toBe(0);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-http-"));
    const s = createHttpServer(new WalkStore(dir, { graceMs: 10_000 }));
    await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as AddressInfo).port;
    expect((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).graceMs).toBe(10_000);
    s.close();
  });

  it("an explicit opts.graceMs is what goes on the wire", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-http-"));
    const s = createHttpServer(new WalkStore(dir, { graceMs: 10_000 }), { graceMs: 250 });
    await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as AddressInfo).port;
    expect((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).graceMs).toBe(250);
    s.close();
  });
});
