import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs/promises"; import os from "node:os"; import path from "node:path";
import { WalkStore, createHttpServer, tokenPath, writeToken } from "sidewalk-walkd";
import type { AddressInfo } from "node:net";
import { DaemonClient } from "./client.js";

let server: ReturnType<typeof createHttpServer>; let client: DaemonClient; let dataDir: string; let base: string;
beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sidewalk-mcp-"));
  server = createHttpServer(new WalkStore(dataDir));
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = new DaemonClient(base, dataDir);
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

describe("DaemonClient", () => {
  it("round-trips a walk", async () => {
    const w = await client.open({ project: "p", title: "Walk 11", buildRef: "b" });
    const items = await client.addItems(w.id, [{ id: "a", kind: "look", owner: "gate", title: "a", url: "http://127.0.0.1:9340/", do: "d", see: "s", pass: "p", expect: [] }]);
    expect(items[0].seq).toBe(1);
    const r = await client.read(w.id);
    expect(r.items).toHaveLength(1);
    const wt = await client.wait(w.id, 0, 10);
    expect(wt.verdicts).toEqual([]);
    await client.withdraw(w.id, "a", "gone");
    const closed = await client.close(w.id, "done");
    expect(closed.closedAt).toBeTruthy();
  });
  it("surfaces daemon errors as thrown Errors with the message", async () => {
    await expect(client.read("nope")).rejects.toThrow(/not found/);
  });
  it("connect() fails clearly when there is no daemon and autoStart is off", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-nostate-"));
    await expect(DaemonClient.connect({ stateDir: empty, autoStart: false })).rejects.toThrow(/walkd is not running/);
  });

  /**
   * The daemon this process starts is started behind the person's back, with its
   * output thrown away, so it must not take their clipboard: a token it minted
   * would land there with no line anywhere saying so. `--no-copy` is not
   * optional on this path. The stub stands in for the daemon and writes the
   * state file an actual one would, pointing at the server this suite is already
   * running.
   */
  it("connect() starts a daemon with --no-copy, so nothing takes the clipboard unasked", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-autostart-"));
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-autostart-data-"));
    await writeToken(data, "a-token-the-stub-daemon-serves");
    const port = (server.address() as AddressInfo).port;
    const calls: { args: readonly string[]; detached?: boolean; stdio?: unknown }[] = [];
    const fake = ((_exe: string, args: readonly string[], o: { detached?: boolean; stdio?: unknown }) => {
      calls.push({ args, ...o });
      void fs.writeFile(path.join(stateDir, "walkd.json"),
        JSON.stringify({ port, pid: process.pid, dataDir: data, startedAt: new Date().toISOString() }));
      return { unref() {} };
    }) as unknown as typeof import("node:child_process").spawn;

    const started = await DaemonClient.connect({ stateDir, spawn: fake });
    expect(started).toBeInstanceOf(DaemonClient);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([expect.stringContaining("walkd.js"), "serve", "--state-dir", stateDir, "--no-copy"]);
    // And it is still the detached, output-thrown-away child it always was —
    // which is the whole reason the clipboard write would have been silent.
    expect(calls[0].detached).toBe(true);
    expect(calls[0].stdio).toBe("ignore");
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(data, { recursive: true, force: true });
  });
});

describe("DaemonClient item ids", () => {
  it("withdraws an id whose characters need encoding in a path segment", async () => {
    const w = await client.open({ project: "p", title: "Encoded", buildRef: "b", id: "encoded" });
    await client.addItems(w.id, [{ id: "lane:site-141.b", kind: "look", owner: "gate", title: "a",
      url: "http://127.0.0.1:9340/", do: "d", see: "s", pass: "p", expect: [] }]);
    const wd = await client.withdraw(w.id, "lane:site-141.b", "gone");
    expect(wd.withdrawReason).toBe("gone");
  });
});

describe("DaemonClient project cache", () => {
  it("learns a walk's project from open/read and re-reads at most once", async () => {
    const w = await client.open({ project: "p", title: "Cached", buildRef: "b", id: "cached" });
    const spy = vi.spyOn(client as any, "call");
    expect(await client.projectOf(w.id)).toBe("p");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    const fresh = new DaemonClient(base, dataDir);
    const spy2 = vi.spyOn(fresh as any, "call");
    expect(await fresh.projectOf(w.id)).toBe("p");
    expect(spy2).toHaveBeenCalledTimes(1);
    expect(await fresh.projectOf(w.id)).toBe("p");
    expect(spy2).toHaveBeenCalledTimes(1);
    spy2.mockRestore();
  });

  /**
   * SW-3 of the 2026-10-06 audit: the fallback read above used to ask from
   * `Number.MAX_SAFE_INTEGER`, and the daemon took that cursor as "the agent holds
   * everything up to here". A resumed session hit it on its first `walk_wait`, and
   * the person's free Undo was gone for the rest of the walk. The wait names the
   * project now, so there is nothing left to read.
   */
  it("learns a walk's project from a wait, so a resumed session never reads the walk for it", async () => {
    const w = await client.open({ project: "p", title: "Resumed", buildRef: "b", id: "resumed" });
    const fresh = new DaemonClient(base, dataDir);
    await fresh.wait(w.id, 0, 0);
    const spy = vi.spyOn(fresh as any, "call");
    expect(await fresh.projectOf(w.id)).toBe("p");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("hands its caller the shape it always had: the project is kept, not passed on", async () => {
    const w = await client.open({ project: "p", title: "Shape", buildRef: "b", id: "shape" });
    expect(Object.keys(await client.wait(w.id, 0, 0)).sort()).toEqual(["closed", "cursor", "verdicts"]);
  });
});

/**
 * The token (secrets review). The daemon makes one the first time it starts
 * and keeps it across restarts, in its own data dir; this process is on the same
 * machine by design, so reading that file is how it is paired — and `WALKD_TOKEN`
 * is the way out for a setup where it cannot see the folder.
 */
describe("DaemonClient and the daemon's token", () => {
  const TOKEN = "a-tokens-32-bytes-stood-in-for";
  let tserver: ReturnType<typeof createHttpServer>; let tbase: string; let tdata: string;
  beforeAll(async () => {
    tdata = await fs.mkdtemp(path.join(os.tmpdir(), "sidewalk-mcp-token-"));
    tserver = createHttpServer(new WalkStore(tdata), { auth: { token: TOKEN, file: tokenPath(tdata) } });
    await new Promise<void>(r => tserver.listen(0, "127.0.0.1", r));
    tbase = `http://127.0.0.1:${(tserver.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>(r => tserver.close(() => r())));

  it("sends it on every call, and is refused without it", async () => {
    const withToken = new DaemonClient(tbase, tdata, TOKEN);
    const w = await withToken.open({ project: "p", title: "Tokened", buildRef: "b", id: "tokened" });
    expect(w.id).toBe("tokened");
    await withToken.addItems("tokened", [{ id: "a", kind: "info", owner: "gate", title: "a", body: "b" }]);
    expect((await withToken.read("tokened")).items).toHaveLength(1);

    const without = new DaemonClient(tbase, tdata);
    await expect(without.read("tokened")).rejects.toThrow(/walkd 401/);
    // The refusal names the file the person has to look in.
    await expect(without.read("tokened")).rejects.toThrow(tokenPath(tdata));
    await expect(new DaemonClient(tbase, tdata, "wrong").read("tokened")).rejects.toThrow(/walkd 401/);
  });

  it("connect() reads it out of the data dir the state file names", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-state-"));
    await fs.writeFile(path.join(stateDir, "walkd.json"), JSON.stringify({
      port: Number(new URL(tbase).port), pid: process.pid, dataDir: tdata, startedAt: new Date().toISOString() }));
    await writeToken(tdata, TOKEN);
    const client = await DaemonClient.connect({ stateDir, autoStart: false });
    await client.open({ project: "p", title: "From the file", buildRef: "b", id: "from-the-file" });
    expect((await client.read("from-the-file")).walk.id).toBe("from-the-file");

    // No file: the error says where it looked. A client that connected without
    // one would 401 on its first tool call with nothing to act on.
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-empty-data-"));
    await fs.writeFile(path.join(stateDir, "walkd.json"), JSON.stringify({
      port: Number(new URL(tbase).port), pid: process.pid, dataDir: empty, startedAt: new Date().toISOString() }));
    await expect(DaemonClient.connect({ stateDir, autoStart: false })).rejects.toThrow(tokenPath(empty));
  });

  it("WALKD_TOKEN overrides the file, for a daemon whose data dir this process cannot see", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-state-"));
    const unreadable = path.join(stateDir, "not-a-dir");
    await fs.writeFile(path.join(stateDir, "walkd.json"), JSON.stringify({
      port: Number(new URL(tbase).port), pid: process.pid, dataDir: unreadable, startedAt: new Date().toISOString() }));
    const had = process.env.WALKD_TOKEN;
    process.env.WALKD_TOKEN = TOKEN;
    try {
      const client = await DaemonClient.connect({ stateDir, autoStart: false });
      await client.open({ project: "p", title: "From the env", buildRef: "b", id: "from-the-env" });
      expect((await client.read("from-the-env")).walk.id).toBe("from-the-env");
    } finally { if (had === undefined) delete process.env.WALKD_TOKEN; else process.env.WALKD_TOKEN = had; }
  });
});

/**
 * The MCP process outlives daemons on purpose — it is the thing that starts
 * them — so a daemon serving a token this process does not have must cost it a
 * retry and not its walk. A restart alone no longer changes the token; a
 * `walkd token --rotate`, and a token file walkd replaced, still do.
 */
describe("DaemonClient when the token changes under it", () => {
  it("re-reads the token file once on a 401 and carries on", async () => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-rotate-"));
    // The daemon the client meets first, and the token it was given at connect.
    const first = createHttpServer(new WalkStore(data), { auth: { token: "first-boot", file: tokenPath(data) } });
    await new Promise<void>(r => first.listen(0, "127.0.0.1", r));
    const port = (first.address() as AddressInfo).port;
    const client = new DaemonClient(`http://127.0.0.1:${port}`, data, "first-boot");
    await client.open({ project: "p", title: "Before", buildRef: "b", id: "before" });
    await new Promise<void>(r => first.close(() => r()));

    // The same port, a daemon with a new token, and the new token on disk.
    const second = createHttpServer(new WalkStore(data), { auth: { token: "second-boot", file: tokenPath(data) } });
    await new Promise<void>(r => second.listen(port, "127.0.0.1", r));
    await writeToken(data, "second-boot");
    try {
      // No reconnect, no new client: the next call simply works.
      expect((await client.read("before")).walk.id).toBe("before");
    } finally { await new Promise<void>(r => second.close(() => r())); }
  });

  it("gives up with the daemon's own 401 when the file says nothing new", async () => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-rotate-"));
    const server = createHttpServer(new WalkStore(data), { auth: { token: "the-real-one", file: tokenPath(data) } });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    await writeToken(data, "stale");
    try {
      await expect(new DaemonClient(`http://127.0.0.1:${port}`, data, "stale").read("nope")).rejects.toThrow(/walkd 401/);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });
});
