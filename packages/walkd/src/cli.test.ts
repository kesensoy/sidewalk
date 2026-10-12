import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises"; import os from "node:os"; import path from "node:path";
import nodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { DEFAULT_GRACE_MS, readState, main, serve, type Serving } from "./cli.js";
import { VERSION } from "./http.js";
import { readToken, writeToken } from "./token.js";

/** Whether a pid still answers signal 0, which is the only probe Windows has too. */
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Another program on the port the state file records: the actor of SW-1. With a
 * body it answers /health like a daemon; with none it holds the port and answers
 * nothing, which is what makes a bind fail. The port is always an ephemeral one —
 * no test may go near 8760.
 */
async function otherProgram(body?: unknown): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = nodeHttp.createServer((_req, res) => {
    if (body === undefined) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  return { port: (srv.address() as AddressInfo).port, close: () => new Promise<void>(r => srv.close(() => r())) };
}

/** Run `fn` with these environment variables set, and put the environment back. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const had = new Map(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); }
  finally { for (const [k, v] of had) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

const entry = path.join(import.meta.dirname, "..", "test", "serve-entry.ts");

/**
 * Every spawn of the real CLI below gets its own fake home.
 *
 * `walkd serve` writes native messaging manifests into the browser profiles of
 * whoever is running it, and a test run has no business editing the person's
 * Chrome. `WALKD_NATIVE_ROOT` is the one variable that moves all of it, so a
 * test that forgets it is the only way a manifest reaches a real profile.
 */
const nativeRoot = (tmp: string) => ({ WALKD_NATIVE_ROOT: path.join(tmp, "native-root") });

describe("walkd serve", () => {
  it("writes the state file, answers /health, cleans up on SIGTERM where the platform has one", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-cli-"));
    const env = { ...process.env, WALKD_DATA_DIR: path.join(tmp, "data"), WALKD_STATE_DIR: path.join(tmp, "state"), ...nativeRoot(tmp) };
    const child = spawn(process.execPath, ["--import", "tsx", entry, "serve", "--port", "0", "--no-copy"], { env, stdio: "pipe" });
    let state = null; for (let i = 0; i < 100 && !state; i++) { await new Promise(r => setTimeout(r, 50)); state = await readState(env.WALKD_STATE_DIR); }
    expect(state?.pid).toBe(child.pid);
    const h = await (await fetch(`http://127.0.0.1:${state!.port}/health`)).json();
    expect(h.ok).toBe(true);
    child.kill("SIGTERM");
    await new Promise(r => child.on("exit", r));
    // Windows has no SIGTERM to catch: kill() is TerminateProcess, so the
    // shutdown handler never runs and the state file outlives the daemon it
    // describes. Nothing the daemon can do about that from inside — it is the
    // stale file `walkd stop` health-checks and removes on its next run.
    if (process.platform === "win32") expect(await readState(env.WALKD_STATE_DIR)).not.toBeNull();
    else expect(await readState(env.WALKD_STATE_DIR)).toBeNull();
  }, 15000);

  it("does not start a server merely because argv[1] ends in cli.js", async () => {
    // sidewalk-mcp/dist/cli.js matched cli.ts's old self-run guard, so importing
    // walkd's cli.js inside the MCP process started a daemon and wrote its
    // banner to stdout — the JSON-RPC channel. Importing must do nothing.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-selfrun-"));
    const env = { ...process.env, WALKD_DATA_DIR: path.join(tmp, "data"), WALKD_STATE_DIR: path.join(tmp, "state"), WALKD_PORT: "0" };
    const target = pathToFileURL(path.join(import.meta.dirname, "cli.ts")).href;
    const child = spawn(process.execPath,
      ["--import", "tsx", "-e", `await import(${JSON.stringify(target)})`, path.join(tmp, "cli.js")],
      { env, stdio: "pipe" });
    let out = ""; child.stdout.on("data", c => { out += c; });
    const exited = Promise.race([
      new Promise<number | null>(r => child.on("exit", c => r(c))),
      new Promise<"hung">(r => setTimeout(() => r("hung"), 5000)),
    ]);
    await new Promise(r => setTimeout(r, 500));
    expect(await readState(env.WALKD_STATE_DIR)).toBeNull();
    const code = await exited;
    if (code === "hung") child.kill("SIGKILL");
    expect(code).toBe(0);
    expect(out).toBe("");
  }, 15000);

  it("WALKD_ADVERTISE_VERSION changes what /health says and nothing else", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-cli-"));
    const env = { ...process.env, WALKD_DATA_DIR: path.join(tmp, "data"), WALKD_STATE_DIR: path.join(tmp, "state"), WALKD_ADVERTISE_VERSION: "0.0.1", ...nativeRoot(tmp) };
    const child = spawn(process.execPath, ["--import", "tsx", entry, "serve", "--port", "0", "--no-copy"], { env, stdio: "pipe" });
    let out = ""; child.stdout.on("data", c => { out += c; });
    let state = null; for (let i = 0; i < 100 && !state; i++) { await new Promise(r => setTimeout(r, 50)); state = await readState(env.WALKD_STATE_DIR); }
    const h = await (await fetch(`http://127.0.0.1:${state!.port}/health`)).json();
    // The window rides along on /health beside the version — the pane draws it
    // as the drain bar — and `serve` with no --grace-ms serves the default one.
    // `auth: "token"` because `serve` always has one: a daemon this CLI started
    // never answers a caller that cannot produce its token.
    // `pid` and `startedAt` are the child's own, and the state file says the same
    // two — that is what `walkd stop` compares before it signals anything.
    // `viewers` is 0 because nothing holds the daemon's /events stream: it is
    // the count an agent is told so it can say "open the side panel".
    expect(h).toEqual({ ok: true, version: "0.0.1", graceMs: DEFAULT_GRACE_MS, auth: "token", pid: state!.pid, startedAt: state!.startedAt, viewers: 0 });
    // The banner is the daemon talking about itself, so it keeps the real
    // version: only the wire is allowed to lie, and only for the e2e.
    for (let i = 0; i < 100 && !out.includes("listening on"); i++) await new Promise(r => setTimeout(r, 50));
    expect(out).toContain(`walkd ${VERSION} listening on`);
    child.kill("SIGTERM");
    await new Promise(r => child.on("exit", r));
    await fs.rm(tmp, { recursive: true, force: true });
  }, 15000);
});

describe("walkd serve, the secrets folder it makes", () => {
  // It holds whatever the person drops in it, so it is theirs alone: it was
  // being made `drwxr-xr-x` (secrets review). No mode on Windows.
  it.skipIf(process.platform === "win32")("is 0700", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-mode-"));
    const opts = { port: 0, dataDir: path.join(tmp, "data"), stateDir: path.join(tmp, "state") };
    const running = await serve(opts);
    try {
      expect((await fs.stat(path.join(opts.dataDir, "secrets"))).mode & 0o777).toBe(0o700);
    } finally {
      await new Promise<void>(r => running.server!.close(() => r()));
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 15000);
});

describe("walkd serve, the signal handlers it holds", () => {
  /**
   * One SIGTERM handler per live daemon, and none per dead one. `serve` is
   * called many times in this one process, and a handler left behind per call
   * reached Node's ten-listener warning — which is the process telling the truth
   * about a leak, not noise to be turned up.
   */
  it("gives them back when the server closes", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-signals-"));
    const term = process.listenerCount("SIGTERM");
    const int = process.listenerCount("SIGINT");
    const running = await serve({ port: 0, dataDir: path.join(tmp, "data"), stateDir: path.join(tmp, "state") });
    expect(process.listenerCount("SIGTERM")).toBe(term + 1);
    expect(process.listenerCount("SIGINT")).toBe(int + 1);
    await new Promise<void>(r => running.server!.close(() => r()));
    expect(process.listenerCount("SIGTERM")).toBe(term);
    expect(process.listenerCount("SIGINT")).toBe(int);
    await fs.rm(tmp, { recursive: true, force: true });
  }, 15000);
});

describe("walkd stop", () => {
  it("removes a stale state file instead of signalling a reused pid", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-stale-"));
    // pid 1 stands in for a pid the OS has handed to somebody else; port 1
    // answers nothing, which is what makes the state file stale.
    await fs.writeFile(path.join(tmp, "walkd.json"),
      JSON.stringify({ port: 1, pid: 1, dataDir: path.join(tmp, "data"), startedAt: new Date().toISOString() }));
    const killed: number[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(((p: number) => { killed.push(p); return true; }) as typeof process.kill);
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write);
    const prev = process.exitCode;
    try {
      await expect(main(["stop", "--state-dir", tmp])).resolves.toBeUndefined();
    } finally { kill.mockRestore(); write.mockRestore(); process.exitCode = prev; }
    expect(killed).toEqual([]);
    expect(out.join("")).toBe("walkd: not running (stale state file removed)\n");
    expect(await readState(tmp)).toBeNull();
  }, 15000);
});

describe("walkd serve, twice on one state dir", () => {
  it("the second refuses to bind and points at the first", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-twice-"));
    const opts = { port: 0, dataDir: path.join(tmp, "data"), stateDir: path.join(tmp, "state") };
    const prev = process.exitCode;
    const out: string[] = [];
    const first = await serve(opts);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write);
    let second;
    try { second = await serve(opts); } finally { write.mockRestore(); }
    expect(second.server).toBeNull();
    expect(second.alreadyRunning).toBe(true);
    expect(second.port).toBe(first.port);
    expect(out.join("")).toBe(`walkd: already running on port ${first.port}\n`);
    expect(process.exitCode).toBe(1);
    process.exitCode = prev;
    // The running daemon's state file is untouched.
    expect((await readState(opts.stateDir))?.port).toBe(first.port);
    await new Promise<void>(r => first.server!.close(() => r()));
  }, 15000);
});

/**
 * SW-1 and SW-4 of the 2026-10-06 audit. A loopback port is not per-uid, so
 * another OS user or a host-network container can hold 8760 and the pid a state
 * file records can be handed to anything after a reboot or a SIGKILL. Three
 * things used to go wrong on that: the bind threw an uncaught EADDRINUSE, `serve`
 * said "already running" about a stranger, and `stop` signalled whatever had
 * inherited the pid. /health now says which process it is.
 */
describe("walkd and another program on the port", () => {
  it("serve says the port is taken rather than throwing EADDRINUSE", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-inuse-"));
    const other = await otherProgram();
    const errs: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { errs.push(String(s)); return true; }) as typeof process.stderr.write);
    const prev = process.exitCode;
    let out: Serving;
    try { out = await serve({ port: other.port, dataDir: path.join(tmp, "data"), stateDir: path.join(tmp, "state") }); }
    finally { write.mockRestore(); }
    expect(out.server).toBeNull();
    expect(out.alreadyRunning).toBe(false);
    expect(errs.join("")).toBe(`walkd: 127.0.0.1:${other.port} is already in use by another program.\n`);
    expect(process.exitCode).toBe(1);
    process.exitCode = prev;
    // Nothing is claimed that is not held: no state file names a daemon that
    // never bound.
    expect(await readState(path.join(tmp, "state"))).toBeNull();
    await other.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }, 15000);

  it("serve does not call a stranger on the recorded port 'already running'", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-stranger-"));
    const other = await otherProgram({ ok: true });
    await fs.mkdir(path.join(tmp, "state"), { recursive: true });
    await fs.writeFile(path.join(tmp, "state", "walkd.json"),
      JSON.stringify({ port: other.port, pid: 1, dataDir: path.join(tmp, "data"), startedAt: new Date().toISOString() }));
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write);
    let serving: Serving;
    try { serving = await serve({ port: 0, dataDir: path.join(tmp, "data"), stateDir: path.join(tmp, "state") }); }
    finally { write.mockRestore(); }
    expect(serving.alreadyRunning).toBe(false);
    expect(serving.server).not.toBeNull();
    expect(out.join("")).not.toContain("already running");
    // The daemon that did start is the one the state file now names.
    expect((await readState(path.join(tmp, "state")))?.pid).toBe(process.pid);
    await new Promise<void>(r => serving.server!.close(() => r()));
    await other.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }, 15000);

  it("stop refuses to signal when the answer on that port is not the daemon the state file names", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-notours-"));
    // Answers like a walkd, down to the version, but it is another process.
    const other = await otherProgram({ ok: true, version: VERSION, pid: process.pid + 100000, startedAt: new Date().toISOString() });
    await fs.writeFile(path.join(tmp, "walkd.json"),
      JSON.stringify({ port: other.port, pid: 1, dataDir: path.join(tmp, "data"), startedAt: new Date().toISOString() }));
    const killed: number[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(((p: number) => { killed.push(p); return true; }) as typeof process.kill);
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write);
    const prev = process.exitCode;
    try { await main(["stop", "--state-dir", tmp]); }
    finally { kill.mockRestore(); write.mockRestore(); }
    expect(killed).toEqual([]);
    expect(out.join("")).toBe(`walkd: something else answers on ${other.port}; not stopping it.\n`);
    expect(process.exitCode).toBe(1);
    process.exitCode = prev;
    // The state file stays: it is the only record of the daemon that is gone.
    expect(await readState(tmp)).not.toBeNull();
    await other.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }, 15000);

  it("status names the stranger instead of calling the port healthy", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-status-"));
    const other = await otherProgram({ ok: true, version: VERSION, pid: process.pid + 100000, startedAt: new Date().toISOString() });
    await fs.writeFile(path.join(tmp, "walkd.json"),
      JSON.stringify({ port: other.port, pid: 1, dataDir: path.join(tmp, "data"), startedAt: new Date().toISOString() }));
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write);
    const prev = process.exitCode;
    try { await main(["status", "--state-dir", tmp]); } finally { write.mockRestore(); }
    expect(out.join("")).toContain("SOMETHING ELSE ON THIS PORT");
    expect(out.join("")).not.toContain("healthy");
    expect(process.exitCode).toBe(1);
    process.exitCode = prev;
    await other.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }, 15000);

  it("/health says which process it is, and the state file says the same", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-identity-"));
    const serving = await serve({ port: 0, dataDir: path.join(tmp, "data"), stateDir: path.join(tmp, "state") });
    const h = await (await fetch(`http://127.0.0.1:${serving.port}/health`)).json();
    const s = await readState(path.join(tmp, "state"));
    expect(h.pid).toBe(process.pid);
    expect(h.pid).toBe(s?.pid);
    expect(h.startedAt).toBe(s?.startedAt);
    await new Promise<void>(r => serving.server!.close(() => r()));
    await fs.rm(tmp, { recursive: true, force: true });
  }, 15000);
});

/**
 * The token (secrets review): what stops every other program on the
 * machine from reading a walk, or a card's secret, off loopback. Kept across
 * restarts since 2026-10-06, so the person's one paste into the pane's gear
 * survives one.
 */
describe("walkd serve, the token it writes", () => {
  const tmpdir = () => fs.mkdtemp(path.join(os.tmpdir(), "walkd-token-"));
  const started = async (tmp: string, env: Record<string, string> = { WALKD_TOKEN: "" }) => {
    const opts = { port: 0, dataDir: path.join(tmp, "data"), stateDir: path.join(tmp, "state") };
    const out: string[] = []; const err: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write);
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { err.push(String(s)); return true; }) as typeof process.stderr.write);
    let running;
    try { running = await withEnv(env, () => serve(opts)); } finally { write.mockRestore(); warn.mockRestore(); }
    return { running, opts, out: out.join(""), err: err.join("") };
  };
  const stop = (running: Serving) => new Promise<void>(r => running.server!.close(() => r()));

  it("writes one 0600 file in the data dir", async () => {
    const tmp = await tmpdir();
    const first = await started(tmp);
    const file = path.join(first.opts.dataDir, "token");
    const one = (await fs.readFile(file, "utf8")).trim();
    try {
      expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/);           // 32 bytes, base64url
      expect(await readToken(first.opts.dataDir)).toBe(one);
      // The path is said out loud on startup; the token never is.
      expect(first.out).toContain(file);
      expect(first.out).not.toContain(one);
      // A first run replaces nothing, so it says nothing on stderr.
      expect(first.err).toBe("");
      if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    } finally { await stop(first.running); await fs.rm(tmp, { recursive: true, force: true }); }
  }, 20000);

  it("serves the same token to the next boot on that data dir, and leaves the file behind on SIGTERM", async () => {
    // The whole of what persistence is for: the person pastes once into the
    // gear and a restart does not ask again. `serve`'s own shutdown handler is
    // what used to remove the file, so the second `serve` here is the test —
    // it finds a file the first one wrote and did not take with it.
    const tmp = await tmpdir();
    const first = await started(tmp);
    const file = path.join(first.opts.dataDir, "token");
    const one = (await fs.readFile(file, "utf8")).trim();
    await stop(first.running);
    await fs.rm(path.join(first.opts.stateDir, "walkd.json"), { force: true });

    const second = await started(tmp);
    try {
      expect((await fs.readFile(file, "utf8")).trim()).toBe(one);
      expect(second.err).toBe("");
      // And the daemon is serving that one, not merely leaving it on disk.
      const base = `http://127.0.0.1:${second.running.port}`;
      expect((await fetch(`${base}/walks`, { headers: { authorization: `Bearer ${one}` } })).status).toBe(200);
    } finally { await stop(second.running); await fs.rm(tmp, { recursive: true, force: true }); }
  }, 20000);

  it("replaces a file it cannot vouch for, and says so on stderr in one line", async () => {
    const tmp = await tmpdir();
    const first = await started(tmp);
    const file = path.join(first.opts.dataDir, "token");
    const one = (await fs.readFile(file, "utf8")).trim();
    await stop(first.running);
    await fs.rm(path.join(first.opts.stateDir, "walkd.json"), { force: true });

    // Not a token this daemon ever minted: a truncated write, an editor, a
    // WALKD_TOKEN an earlier boot pinned into the file. Not served again.
    await fs.writeFile(file, "not-a-token\n", { mode: 0o600 });
    const second = await started(tmp);
    const two = (await fs.readFile(file, "utf8")).trim();
    try {
      expect(two).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(two).not.toBe(one);
      expect(second.err.split("\n").filter(Boolean)).toHaveLength(1);
      expect(second.err).toContain("not the form walkd mints");
      expect(second.err).toContain(file);
      expect(second.err).not.toContain(two);
    } finally { await stop(second.running); await fs.rm(path.join(second.opts.stateDir, "walkd.json"), { force: true }); }

    // A mode anyone else can read is the other half: a 0644 file left by an
    // older walkd is replaced rather than trusted (secrets review).
    if (process.platform !== "win32") {
      await fs.chmod(file, 0o644);
      const third = await started(tmp);
      try {
        expect((await fs.readFile(file, "utf8")).trim()).not.toBe(two);
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
        expect(third.err.split("\n").filter(Boolean)).toHaveLength(1);
        expect(third.err).toContain("mode 0644, not 0600");
      } finally { await stop(third.running); }
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }, 30000);

  /**
   * The clipboard half of install day: the one gesture left is the paste, and
   * putting the token where a paste comes from is the half a program can do. A
   * token that was kept is not copied — the pane already has it, and taking the
   * person's clipboard for nothing is rude. `copier` is injected so no test ever
   * writes to the real clipboard, and `armer` so none of them spawns the
   * detached child that would clear it 90 seconds later.
   */
  it("puts a token it minted on the clipboard, says so, and says when it clears", async () => {
    const tmp = await tmpdir();
    const copies: string[] = [];
    const armed: string[] = [];
    const copier = async (t: string) => { copies.push(t); return { cmd: "pbcopy", args: [] }; };
    const armer = (t: string) => { armed.push(t); return { afterMs: 90_000 }; };
    const opts = { port: 0, dataDir: path.join(tmp, "data"), stateDir: path.join(tmp, "state"), copy: true, copier, armer };
    const say = () => { const out: string[] = []; const w = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write); return { out, done: () => { w.mockRestore(); return out.join(""); } }; };

    const first = say();
    const one = await withEnv({ WALKD_TOKEN: "" }, () => serve(opts));
    const firstOut = first.done();
    const token = await readToken(opts.dataDir);
    expect(copies).toEqual([token]);
    expect(firstOut).toContain("a new token is on your clipboard (pbcopy)");
    expect(firstOut).toContain("open the panel's gear");
    // A person told a credential is on their clipboard is owed the other half of
    // the sentence: how long it stays there, and that it will not touch what
    // they copy next.
    expect(armed).toEqual([token]);
    expect(firstOut).toContain("clipboard clears itself in 90 seconds");
    expect(firstOut).toContain("leaves alone anything you copy before then");
    // Said, never shown: this line goes wherever the daemon's output goes.
    expect(firstOut).not.toContain(token);
    await stop(one);
    await fs.rm(path.join(opts.stateDir, "walkd.json"), { force: true });

    const second = say();
    const two = await withEnv({ WALKD_TOKEN: "" }, () => serve(opts));
    const secondOut = second.done();
    expect(copies).toEqual([token]);                       // not copied a second time
    expect(secondOut).toContain("the token is unchanged");
    expect(secondOut).toContain("the panel needs no new paste");
    await stop(two);
    await fs.rm(tmp, { recursive: true, force: true });
  }, 20000);

  it("does not touch the clipboard unless it is asked to", async () => {
    // What --no-copy buys the e2e, the demo recorder and CI: a run that cannot
    // clobber the person's clipboard. `copy` defaults to off for every embedder.
    const tmp = await tmpdir();
    const running = await started(tmp);
    try {
      expect(running.out).toContain("a new token is in");
      expect(running.out).toContain("Run \"walkd token --copy\"");
    } finally { await stop(running.running); await fs.rm(tmp, { recursive: true, force: true }); }
  }, 20000);

  it("requires it on a read and serves the read that carries it; /health stays open", async () => {
    const tmp = await tmpdir();
    const { running, opts } = await started(tmp);
    const base = `http://127.0.0.1:${running.port}`;
    try {
      const token = await readToken(opts.dataDir);
      expect((await (await fetch(`${base}/health`)).json()).auth).toBe("token");
      expect((await fetch(`${base}/walks`)).status).toBe(401);
      const refused = await (await fetch(`${base}/walks`)).json();
      expect(refused.error).toContain(path.join(opts.dataDir, "token"));
      expect((await fetch(`${base}/walks`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    } finally {
      await new Promise<void>(r => running.server!.close(() => r()));
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 20000);

  it("serves WALKD_TOKEN when the environment pins one, so a client that cannot read the file still works", async () => {
    const tmp = await tmpdir();
    const { running, opts } = await started(tmp, { WALKD_TOKEN: "pinned-by-the-environment" });
    try {
      expect(await readToken(opts.dataDir)).toBe("pinned-by-the-environment");
      const base = `http://127.0.0.1:${running.port}`;
      expect((await fetch(`${base}/walks`, { headers: { authorization: "Bearer pinned-by-the-environment" } })).status).toBe(200);
    } finally {
      await new Promise<void>(r => running.server!.close(() => r()));
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 20000);
});

describe("walkd token", () => {
  const run = async (argv: string[], env: Record<string, string> = { WALKD_TOKEN: "" }) => {
    const out: string[] = []; const err: string[] = [];
    const w = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write);
    const e = vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { err.push(String(s)); return true; }) as typeof process.stderr.write);
    const code = process.exitCode;
    try { await withEnv(env, () => main(argv)); } finally { w.mockRestore(); e.mockRestore(); }
    const exit = process.exitCode; process.exitCode = code;
    return { out: out.join(""), err: err.join(""), exit };
  };

  it("prints the token of the daemon the state file names", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-tokencmd-"));
    const dataDir = path.join(tmp, "data");
    await writeToken(dataDir, "the-one-in-the-file");
    await fs.mkdir(path.join(tmp, "state"), { recursive: true });
    await fs.writeFile(path.join(tmp, "state", "walkd.json"),
      JSON.stringify({ port: 1, pid: 1, dataDir, startedAt: new Date().toISOString() }));
    expect((await run(["token", "--state-dir", path.join(tmp, "state")])).out).toBe("the-one-in-the-file\n");
    // --data-dir reads another daemon's instead.
    const other = path.join(tmp, "other");
    await writeToken(other, "another-daemons-token");
    expect((await run(["token", "--data-dir", other])).out).toBe("another-daemons-token\n");
    // WALKD_TOKEN is what the daemon would be serving, so it is what is printed.
    expect((await run(["token", "--data-dir", other], { WALKD_TOKEN: "pinned" })).out).toBe("pinned\n");
    await fs.rm(tmp, { recursive: true, force: true });
  }, 15000);

  /**
   * `--rotate` is the way a new token is asked for, now that a restart is not
   * one. It writes the file and says what it did; the daemon already running
   * holds its token in memory and keeps serving it, so the line says restart.
   */
  it("--rotate writes a new token, prints it, and says a running daemon keeps the old one", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-rotate-"));
    const dataDir = path.join(tmp, "data");
    await writeToken(dataDir, "the-one-in-the-file");
    const file = path.join(dataDir, "token");

    // --no-copy throughout: a rotate copies by default, and a test must not
    // write to the machine's clipboard.
    const r = await run(["token", "--rotate", "--no-copy", "--data-dir", dataDir]);
    const now = (await fs.readFile(file, "utf8")).trim();
    expect(r.exit).toBeUndefined();
    expect(now).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(now).not.toBe("the-one-in-the-file");
    // The new token is printed, the way `walkd token` prints one, under a line
    // naming the file and what a running daemon is still serving.
    expect(r.out).toContain(`a new token is in ${file}`);
    expect(r.out).toContain("until you restart it");
    expect(r.out.endsWith(`${now}\n`)).toBe(true);
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    // Twice in a row is two different tokens, and `walkd token` then agrees
    // with the file.
    const again = await run(["token", "--rotate", "--no-copy", "--data-dir", dataDir]);
    const later = (await fs.readFile(file, "utf8")).trim();
    expect(later).not.toBe(now);
    expect(again.out.endsWith(`${later}\n`)).toBe(true);
    expect((await run(["token", "--data-dir", dataDir])).out).toBe(`${later}\n`);
    await fs.rm(tmp, { recursive: true, force: true });
  }, 15000);

  it("--rotate refuses while WALKD_TOKEN pins the token, and leaves the file alone", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-rotate-pin-"));
    const dataDir = path.join(tmp, "data");
    await writeToken(dataDir, "the-one-in-the-file");
    const r = await run(["token", "--rotate", "--no-copy", "--data-dir", dataDir], { WALKD_TOKEN: "pinned" });
    expect(r.exit).toBe(2);
    expect(r.out).toBe("");
    expect(r.err).toContain("WALKD_TOKEN pins the token");
    expect((await fs.readFile(path.join(dataDir, "token"), "utf8")).trim()).toBe("the-one-in-the-file");
    await fs.rm(tmp, { recursive: true, force: true });
  }, 15000);

  it("exits 1 naming the file when there is none to read", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-notoken-"));
    const r = await run(["token", "--data-dir", path.join(tmp, "data"), "--state-dir", path.join(tmp, "state")], { WALKD_TOKEN: "" });
    expect(r.exit).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain(path.join(tmp, "data", "token"));
    await fs.rm(tmp, { recursive: true, force: true });
  }, 15000);
});

/**
 * `walkd start` — `serve` with the terminal handed back, which is what
 * `sidewalk.sh/install` runs. The daemon is a real detached child here: the
 * point of the command is that it outlives the process that started it, and
 * nothing but spawning one proves that.
 */
describe("walkd start", () => {
  const started = (tmp: string, args: string[] = []) => new Promise<{ out: string; err: string; code: number | null }>(resolve => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, "start", "--port", "0", "--no-copy",
      "--data-dir", path.join(tmp, "data"), "--state-dir", path.join(tmp, "state"), ...args],
      { stdio: "pipe", env: { ...process.env, WALKD_TOKEN: "", ...nativeRoot(tmp) } });
    let out = ""; let err = "";
    child.stdout.on("data", c => { out += c; }); child.stderr.on("data", c => { err += c; });
    child.on("exit", code => resolve({ out, err, code }));
  });

  it("leaves a daemon running after it exits, prints its pid, and status and stop find it", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-start-"));
    const stateDir = path.join(tmp, "state");
    const first = await started(tmp);
    expect(first.code).toBe(0);
    const s = await readState(stateDir);
    expect(s).not.toBeNull();
    // The pid in the line is the daemon's, not this command's — the whole point.
    expect(first.out).toContain(`pid ${s!.pid}`);
    expect(first.out).toContain("running in the background");
    expect(first.out).toContain(path.join(tmp, "data", "walkd.log"));
    expect((await (await fetch(`http://127.0.0.1:${s!.port}/health`)).json()).ok).toBe(true);
    // The detached daemon's own output went to the log, not to this terminal.
    expect(await fs.readFile(path.join(tmp, "data", "walkd.log"), "utf8")).toContain("listening on");
    expect(first.out).not.toContain("listening on");

    // A second start is refused by the daemon already answering, and says so.
    const second = await started(tmp);
    expect(second.code).toBe(1);
    expect(second.out).toContain(`already running on port ${s!.port}`);

    // `status` reports the detached daemon, and `stop` stops it.
    const out: string[] = [];
    const w = vi.spyOn(process.stdout, "write").mockImplementation(((x: string) => { out.push(String(x)); return true; }) as typeof process.stdout.write);
    const prev = process.exitCode;
    try { await main(["status", "--state-dir", stateDir]); } finally { w.mockRestore(); process.exitCode = prev; }
    expect(out.join("")).toContain(`walkd pid ${s!.pid} port ${s!.port}`);
    expect(out.join("")).toContain("healthy");

    process.kill(s!.pid, "SIGTERM");
    for (let i = 0; i < 100 && await readState(stateDir); i++) await new Promise(r => setTimeout(r, 50));
    if (process.platform === "win32") {
      // No signal handler runs on Windows, so the daemon left its state file
      // behind; `stop` finds nothing answering on the port and removes the
      // stale file instead of signalling, as its own test says.
      for (let i = 0; i < 100 && isAlive(s!.pid); i++) await new Promise(r => setTimeout(r, 50));
      const w2 = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
      try { await main(["stop", "--state-dir", stateDir]); } finally { w2.mockRestore(); process.exitCode = prev; }
    }
    expect(await readState(stateDir)).toBeNull();
    await fs.rm(tmp, { recursive: true, force: true });
  }, 30000);

  it("hands the next start the same token, and says the panel needs no new paste", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-start-token-"));
    const stateDir = path.join(tmp, "state");
    const first = await started(tmp);
    const token = await readToken(path.join(tmp, "data"));
    expect(first.out).toContain("a new token is in");
    expect(first.out).not.toContain(token);
    const s = await readState(stateDir);
    process.kill(s!.pid, "SIGTERM");
    for (let i = 0; i < 100 && await readState(stateDir); i++) await new Promise(r => setTimeout(r, 50));

    const second = await started(tmp);
    expect(second.code).toBe(0);
    expect(await readToken(path.join(tmp, "data"))).toBe(token);
    expect(second.out).toContain("the token is unchanged");
    const back = await readState(stateDir);
    process.kill(back!.pid, "SIGTERM");
    for (let i = 0; i < 100 && await readState(stateDir); i++) await new Promise(r => setTimeout(r, 50));
    await fs.rm(tmp, { recursive: true, force: true });
  }, 30000);
});

describe("walkd --version and a flag it does not know", () => {
  const run = async (argv: string[]) => {
    const out: string[] = []; const err: string[] = [];
    const w = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write);
    const e = vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { err.push(String(s)); return true; }) as typeof process.stderr.write);
    const code = process.exitCode;
    try { await main(argv); } finally { w.mockRestore(); e.mockRestore(); }
    const exit = process.exitCode; process.exitCode = code;
    return { out: out.join(""), err: err.join(""), exit };
  };

  it("prints the package version and nothing else, for --version and -v", async () => {
    for (const argv of [["--version"], ["-v"]]) {
      const r = await run(argv);
      expect(r.out).toBe(`${VERSION}\n`);
      expect(r.err).toBe("");
      expect(r.exit).not.toBe(2);
    }
  });

  it("prints the usage on stdout for --help", async () => {
    const r = await run(["--help"]);
    expect(r.out).toMatch(/^usage: walkd \[serve\|start\|status\|stop\|token\|native\|clipboard-clear\]/);
    expect(r.out).toContain("--version");
    expect(r.exit).not.toBe(2);
  });

  it("answers an unknown flag with one walkd line and the usage, exit 2, not a stack trace", async () => {
    const r = await run(["--bogus"]);
    expect(r.err).toMatch(/^walkd: Unknown option '--bogus'\nusage: walkd /);
    expect(r.err).not.toContain("parse_args");
    expect(r.err).not.toContain("    at ");
    expect(r.exit).toBe(2);
  });
});

/** stdout and stderr caught, the exit code put back, the way the suites above do it. */
const captured = async (argv: string[], env: Record<string, string> = {}) => {
  const out: string[] = []; const err: string[] = [];
  const w = vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { err.push(String(s)); return true; }) as typeof process.stderr.write);
  const code = process.exitCode;
  try { await withEnv(env, () => main(argv)); } finally { w.mockRestore(); e.mockRestore(); }
  const exit = process.exitCode; process.exitCode = code;
  return { out: out.join(""), err: err.join(""), exit };
};

/**
 * The native messaging host, through the CLI.
 *
 * `WALKD_NATIVE_ROOT` on every run: without it these would write into the
 * browser profiles of whoever is running the suite, which is the one thing this
 * code must never do from a test.
 */
describe("walkd serve and the native messaging host", () => {
  /** The folder a real Chrome would have made, inside the fake home. */
  const chromeVendor = (home: string) => process.platform === "linux"
    ? path.join(home, ".config", "google-chrome")
    : path.join(home, "Library", "Application Support", "Google", "Chrome");

  it("writes it at a start, says so in one line on stderr, and never fails the start for it", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-native-cli-"));
    const home = path.join(tmp, "home");
    const opts = { port: 0, dataDir: path.join(tmp, "data"), stateDir: path.join(tmp, "state"), nativeHost: true, nativeRoot: home };
    // Windows writes no file under the home at all — the registry is its half,
    // and `reg` writes into the person's own HKCU, so that path is covered
    // against a stubbed `reg` in native.test.ts and not from here.
    if (process.platform !== "win32") await fs.mkdir(chromeVendor(home), { recursive: true });
    const err: string[] = [];
    const e = vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { err.push(String(s)); return true; }) as typeof process.stderr.write);
    const w = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    let running;
    try { running = await withEnv({ WALKD_TOKEN: "" }, () => serve(opts)); } finally { e.mockRestore(); w.mockRestore(); }
    try {
      const lines = err.join("").split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("native messaging host");
      expect(lines[0]).toContain(path.join(opts.dataDir, "native"));
      if (process.platform === "win32") {
        // A browser on Windows reads a registry value, which an overridden root
        // cannot redirect — so under one the registry half is skipped outright
        // and the line names no browser at all. That is what keeps `npm test`
        // on a Windows runner out of the person's own HKCU.
        for (const b of ["Chrome", "Chromium", "Edge", "Firefox"]) expect(lines[0]).not.toContain(b);
        expect(lines[0]).toContain("nothing was registered");
      }
      if (process.platform !== "win32") {
        expect(lines[0]).toContain("Chrome");
        const file = path.join(chromeVendor(home), "NativeMessagingHosts", "sh.sidewalk.walkd.json");
        const written = JSON.parse(await fs.readFile(file, "utf8"));
        expect(written.name).toBe("sh.sidewalk.walkd");
        // The wrapper the manifest points at is there, and it names this node
        // and this daemon's state directory.
        const wrapper = await fs.readFile(written.path, "utf8");
        expect(wrapper).toContain(process.execPath);
        expect(wrapper).toContain(opts.stateDir);
      }
      // Whatever happened to the manifests, the daemon is serving.
      expect((await (await fetch(`http://127.0.0.1:${running.port}/health`)).json()).ok).toBe(true);
    } finally {
      await new Promise<void>(r => running!.server!.close(() => r()));
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 20000);

  it("writes nothing when nobody asked, which is what every embedder and every test gets", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-native-off-"));
    const opts = { port: 0, dataDir: path.join(tmp, "data"), stateDir: path.join(tmp, "state") };
    const w = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    let running;
    try { running = await withEnv({ WALKD_TOKEN: "" }, () => serve(opts)); } finally { w.mockRestore(); }
    try {
      expect(await fs.stat(path.join(opts.dataDir, "native")).then(() => true, () => false)).toBe(false);
    } finally {
      await new Promise<void>(r => running!.server!.close(() => r()));
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 20000);

  it("walkd native writes it, --status reads it back, --remove takes it out", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-native-cmd-"));
    const home = path.join(tmp, "home");
    const dataDir = path.join(tmp, "data");
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(stateDir, { recursive: true });
    const env = { WALKD_NATIVE_ROOT: home, WALKD_TOKEN: "" };
    if (process.platform === "win32") return;            // see the note above
    await fs.mkdir(chromeVendor(home), { recursive: true });

    const wrote = await captured(["native", "--data-dir", dataDir, "--state-dir", stateDir], env);
    expect(wrote.out).toContain("written for Chrome");
    expect(wrote.exit).toBeUndefined();

    const status = await captured(["native", "--status", "--data-dir", dataDir, "--state-dir", stateDir], env);
    expect(status.out).toContain("the host program is there");
    expect(status.out).toContain(process.execPath);
    expect(status.out).toContain("which is there");
    expect(status.out).toContain("Chrome: ");
    expect(status.out).toContain("nothing written (no ");

    const gone = await captured(["native", "--remove", "--data-dir", dataDir, "--state-dir", stateDir], env);
    expect(gone.out).toContain("removed the native messaging host");
    expect(gone.out).toContain("sh.sidewalk.walkd.json");
    const again = await captured(["native", "--remove", "--data-dir", dataDir, "--state-dir", stateDir], env);
    expect(again.out).toContain("there was no native messaging host to remove");
    await fs.rm(tmp, { recursive: true, force: true });
  }, 20000);

  /**
   * One daemon owns the registration, so `walkd native` writes it for the
   * machine's own data directory and says so rather than repointing the person's
   * browsers at a second one. Looking and cleaning up are different: `--status`
   * and `--remove` take any data directory.
   */
  it("walkd native refuses a --data-dir that is not this machine's own, and says why", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-native-other-"));
    const dataDir = path.join(tmp, "data");
    // WALKD_NATIVE_ROOT blanked, because an overridden root is exactly the case
    // this guard steps aside for — and this is the only test that turns the net
    // off. It is safe because the guard writes nothing at all: no manifest, no
    // folder, nothing that could reach a real browser.
    const r = await captured(["native", "--data-dir", dataDir, "--state-dir", path.join(tmp, "state")], { WALKD_TOKEN: "", WALKD_NATIVE_ROOT: "" });
    expect(r.out).toContain("nothing was written");
    expect(r.out).toContain(dataDir);
    expect(r.out).toContain("Leave --data-dir off");
    expect(r.exit).toBeUndefined();
    // It wrote nothing at all, not even its own folder.
    expect(await fs.stat(path.join(dataDir, "native")).then(() => true, () => false)).toBe(false);
    await fs.rm(tmp, { recursive: true, force: true });
  }, 20000);

  it("walkd native --status says what is missing when nothing has been written", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-native-empty-"));
    const r = await captured(["native", "--status", "--data-dir", path.join(tmp, "data"), "--state-dir", path.join(tmp, "state")],
      { WALKD_NATIVE_ROOT: path.join(tmp, "home"), WALKD_TOKEN: "" });
    expect(r.out).toContain("the host program is MISSING");
    expect(r.out).toContain("no wrapper has been written yet");
    await fs.rm(tmp, { recursive: true, force: true });
  }, 20000);
});

/**
 * `walkd clipboard-clear` — the detached child a copy starts. What is checked
 * here is the argument handling and the compare, never a real clipboard write:
 * the machine running this has a person's own clipboard on it.
 */
describe("walkd clipboard-clear", () => {
  it("refuses to run without the fingerprint of the value it may clear", async () => {
    const r = await captured(["clipboard-clear", "--after", "0"]);
    expect(r.err).toContain("needs --expect");
    expect(r.exit).toBe(2);
    expect(r.out).toBe("");
  });

  it("refuses a wait that is not a count of milliseconds", async () => {
    // `--after=-1` rather than `--after -1`: a bare `-1` reads as a flag, which
    // parseArgs refuses one step earlier, with its own line and the same exit 2.
    for (const bad of ["--after=-1", "--after=soon", "--after=1.5"]) {
      const r = await captured(["clipboard-clear", bad, "--expect", "a".repeat(64)]);
      expect(r.err).toContain("--after must be a non-negative integer");
      expect(r.exit).toBe(2);
    }
    const ambiguous = await captured(["clipboard-clear", "--after", "-1", "--expect", "a".repeat(64)]);
    expect(ambiguous.exit).toBe(2);
    expect(ambiguous.err).toContain("usage: walkd ");
  });

  it("clears nothing when the clipboard does not hold what it was told to look for", async () => {
    // The fingerprint of a value nothing has ever copied, so the compare fails
    // and the person's own clipboard stays theirs. This is the only test that
    // reads the real clipboard, and it never writes one.
    const r = await captured(["clipboard-clear", "--after", "0", "--expect", "0".repeat(64)]);
    expect(r.exit).toBeUndefined();
    expect(r.err).toBe("");
    expect(r.out).toBe("");
  }, 20000);
});
