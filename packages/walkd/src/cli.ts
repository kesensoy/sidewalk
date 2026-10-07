#!/usr/bin/env node
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { DIR_MODE, WalkStore } from "./store.js";
import { createHttpServer, VERSION } from "./http.js";
import { defaultDataDir, defaultStateDir } from "./paths.js";
import { ensureToken, inspectToken, newToken, readToken, TOKEN_ENV, tokenFromEnv, tokenPath, writeToken } from "./token.js";
import { copyToClipboard, type ClipboardCommand } from "./clipboard.js";
import { spawn } from "node:child_process";

export type State = { port: number; pid: number; dataDir: string; startedAt: string };
const stateFile = (dir: string) => path.join(dir, "walkd.json");

export async function readState(stateDir = defaultStateDir()): Promise<State | null> {
  try { return JSON.parse(await fs.readFile(stateFile(stateDir), "utf8")); } catch { return null; }
}

/** What /health says about the process answering it. `pid` and `startedAt` are
 *  absent on a daemon older than this CLI, which is why `sameDaemon` treats a
 *  missing pid as "nothing to compare" rather than as a mismatch. */
export type Health = { ok: boolean; version?: string; graceMs?: number; auth?: string; pid?: number; startedAt?: string };

/** The /health answer on this port, or null if nothing healthy answers. The only
 *  honest liveness test: a pid can have been reused, a state file can outlive the
 *  process. It returns the body rather than a boolean because "something answers"
 *  is not "our daemon answers" — see `sameDaemon`. */
export async function isHealthy(port: number): Promise<Health | null> {
  try { const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json(); return h?.ok === true ? h as Health : null; } catch { return null; }
}

/**
 * Is the daemon answering on that port the one this state file names?
 *
 * A loopback port is not per-uid, so another program — another OS user, a
 * host-network container — can hold the port this state file records; and after a
 * reboot or a SIGKILL the recorded pid can belong to anything. Before this
 * comparison existed, `stop` signalled whatever now held the pid and `serve` said
 * "already running" about a stranger (found in review).
 *
 * A daemon that names no pid is one older than this CLI, and an upgrade must not
 * strand the daemon already running, so it is taken at the state file's word the
 * way every release before this one did. It still has to look like a walkd:
 * /health has carried `version` since the first release, and a program that
 * answers `ok` and nothing else is not one.
 */
export function sameDaemon(h: Health | null, s: State): boolean {
  if (!h) return false;
  if (h.pid === undefined) return typeof h.version === "string";
  return h.pid === s.pid && (h.startedAt === undefined || h.startedAt === s.startedAt);
}

export type Serving = { port: number; server: http.Server | null; alreadyRunning: boolean };

/** How long a fresh verdict stays the pane's alone before an agent can be handed it. */
export const DEFAULT_GRACE_MS = 10_000;

/**
 * The one line a person reads about the token when a daemon starts, and it
 * depends entirely on what just happened to it: a token that was minted goes on
 * the clipboard, because the next thing they do with it is paste it into the
 * pane's gear; a token that was kept is said to be unchanged, so they know not
 * to. The token itself is never in this line — it goes wherever the daemon's
 * output goes, which may be a log file somebody else can read.
 *
 * `copied` is the clipboard command that took it, `null` when none did, and
 * `copyOff` is `--no-copy` (the e2e, the demo recorder, CI: a test run must
 * never clobber the person's clipboard).
 */
export type TokenNews = { file: string; kept: boolean; pinned: boolean; copied: string | null; copyOff: boolean };

export function tokenLine(n: TokenNews): string {
  if (n.pinned) return `walkd: the token is the one ${TOKEN_ENV} pins. It is written to ${n.file} so "walkd token" agrees. Nothing was put on your clipboard.\n`;
  if (n.kept) return `walkd: the token is unchanged, in ${n.file}, so the panel needs no new paste. "walkd token --copy" puts it on your clipboard again. "walkd token --rotate" replaces it.\n`;
  if (n.copied) return `walkd: a new token is on your clipboard (${n.copied}). Now open the panel's gear, paste it, Save. It is kept in ${n.file}, and the next restart serves the same one.\n`;
  if (n.copyOff) return `walkd: a new token is in ${n.file}, and the next restart serves the same one. Run "walkd token --copy" and paste it into the panel's gear.\n`;
  return `walkd: a new token is in ${n.file}. This machine has no clipboard command (pbcopy, clip, wl-copy, xclip, xsel). Run "walkd token" to print it, then paste it into the panel's gear.\n`;
}

/**
 * `opts.copy` is the clipboard: on for `walkd serve` and `walkd start`, off for
 * every embedder and every test, which is why it is off by default here and
 * turned on by the CLI. `opts.copier` is the seam the tests use instead of
 * writing to the machine's real clipboard.
 */
export async function serve(opts: { port: number; dataDir: string; stateDir: string; graceMs?: number; copy?: boolean; copier?: (text: string) => Promise<ClipboardCommand | null> }): Promise<Serving> {
  const running = await readState(opts.stateDir);
  // "Already running" is about *our* daemon, not about whatever holds the port:
  // the answer has to name the pid this state file names (found in review).
  // Anything else falls through to the bind, which is where the truth is.
  if (running && sameDaemon(await isHealthy(running.port), running)) {
    process.stdout.write(`walkd: already running on port ${running.port}\n`);
    process.exitCode = 1;
    return { port: running.port, server: null, alreadyRunning: true };
  }
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const store = new WalkStore(opts.dataDir, { graceMs });
  // The token, before the server exists: there is no window in which this
  // daemon answers without one. Kept from the last boot when the file is still
  // one this daemon can vouch for, so the person's paste into the gear outlives
  // a restart; minted and written when it is not. WALKD_TOKEN pins it instead,
  // for a client that cannot see this data dir at all.
  const pinned = tokenFromEnv();
  const kept = await ensureToken(opts.dataDir, pinned);
  const { token, file: tokenFile } = kept;
  // WALKD_ADVERTISE_VERSION is for the e2e only: a daemon that says it is
  // another version, so the pane's mismatch notice can be seen end to end.
  // The line printed below, and everything else, keeps the real one.
  // `graceMs` goes on /health beside the version: the pane draws that window as
  // the drain bar under a ledge row. The version is the e2e's to fake; the
  // window never is — it is the one the store above was built with.
  // One timestamp, written to the state file and served on /health, so a client
  // holding the file can recognise this daemon rather than guess at it.
  const startedAt = new Date().toISOString();
  const server = createHttpServer(store, { version: process.env.WALKD_ADVERTISE_VERSION ?? VERSION, graceMs, auth: { token, file: tokenFile }, startedAt });
  // The bind can fail, and the one failure that is not a bug is a port held by
  // something that is not a walkd: another OS user's daemon, a container, an
  // unrelated program. That used to come out as an uncaught EADDRINUSE stack
  // trace (found in review); it is one line now, and the port is the whole of it.
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => reject(e);
      server.once("error", onError);
      server.listen(opts.port, "127.0.0.1", () => { server.off("error", onError); resolve(); });
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    process.stderr.write(`walkd: 127.0.0.1:${opts.port} is already in use by another program.\n`);
    process.exitCode = 1;
    return { port: opts.port, server: null, alreadyRunning: false };
  }
  const port = (server.address() as AddressInfo).port;
  await fs.mkdir(opts.stateDir, { recursive: true });
  const state: State = { port, pid: process.pid, dataDir: opts.dataDir, startedAt };
  await fs.writeFile(stateFile(opts.stateDir), JSON.stringify(state, null, 2));
  // The folder file-backed secrets are read from: made here so the person can
  // see where to drop a file before any card ever names one. 0700 — it holds
  // whatever they drop in it, and nobody else on the machine needs to read it.
  await fs.mkdir(store.secretsDir, { recursive: true, mode: DIR_MODE });
  process.stdout.write(`walkd ${VERSION} listening on http://127.0.0.1:${port} (data ${opts.dataDir}, secrets ${store.secretsDir}, grace ${graceMs} ms)\n`);
  // A token nobody can select out of a terminal is a token typed by hand, so a
  // token this daemon just minted goes on the clipboard here — the one gesture
  // left on install day is the paste, and this is the half of it a program can
  // do. A token that was kept is not copied: the pane already has it, and
  // taking the person's clipboard for nothing is rude.
  const fresh = !kept.reused && pinned === undefined;
  const copied = fresh && opts.copy === true ? await (opts.copier ?? copyToClipboard)(token) : null;
  process.stdout.write(tokenLine({ file: tokenFile, kept: kept.reused, pinned: pinned !== undefined, copied: copied?.cmd ?? null, copyOff: opts.copy !== true }));
  // A token file that could not be used is replaced, and that is said out loud
  // on stderr: the paste the person made has just stopped working, and the
  // reason is the only thing they can act on. One line, naming both.
  if (kept.replaced) process.stderr.write(`walkd: made a new token. The old file could not be used (${kept.replaced}): ${tokenFile}. Run "walkd token --copy" and paste it into the panel's gear again.\n`);
  // Only the state file goes: the token stays, so the next daemon on this data
  // dir serves the one already pasted into the pane's gear. Nothing else can
  // read it — 0600 in a 0700 dir — and `walkd token --rotate` is how a new one
  // is asked for.
  const shutdown = async () => { stopWatchingSignals(); await fs.rm(stateFile(opts.stateDir), { force: true }); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
  // A daemon that is no longer serving has no business holding a signal
  // handler: `serve` is called more than once per process by the tests and by an
  // embedder, and a handler per call is a leak the process warns about at ten.
  // Both ways out drop them — the signal path, and a `server.close()` by
  // anything else.
  function stopWatchingSignals() { process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown); }
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
  server.once("close", stopWatchingSignals);
  return { port, server, alreadyRunning: false };
}

const OPTIONS = {
  port: { type: "string" }, "data-dir": { type: "string" }, "state-dir": { type: "string" }, "grace-ms": { type: "string" },
  copy: { type: "boolean" }, rotate: { type: "boolean" }, "no-copy": { type: "boolean" },
  version: { type: "boolean", short: "v" }, help: { type: "boolean", short: "h" },
} as const;

const USAGE = "usage: walkd [serve|start|status|stop|token] [--port N] [--data-dir D] [--state-dir S] [--grace-ms N] [--copy] [--no-copy] [--rotate] [--version]\n";

export async function main(argv = process.argv.slice(2)) {
  let parsed: ReturnType<typeof parseArgs<{ args: string[]; allowPositionals: true; options: typeof OPTIONS }>>;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (e) {
    // An unknown flag used to surface as Node's own stack trace. One line
    // naming the flag, then the usage, is what a person at a terminal needs.
    process.stderr.write(`walkd: ${(e as Error).message.split(".")[0]}\n${USAGE}`); process.exitCode = 2; return;
  }
  const { positionals, values } = parsed;
  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (values.help) { process.stdout.write(USAGE); return; }
  const cmd = positionals[0] ?? "serve";
  const stateDir = values["state-dir"] ?? defaultStateDir();
  const copyOff = values["no-copy"] === true;
  if (cmd === "serve") {
    const grace = values["grace-ms"] === undefined ? DEFAULT_GRACE_MS : Number(values["grace-ms"]);
    if (!Number.isInteger(grace) || grace < 0) { process.stderr.write("walkd: --grace-ms must be a non-negative integer\n"); process.exitCode = 2; return; }
    return serve({ port: Number(values.port ?? process.env.WALKD_PORT ?? 8760), dataDir: values["data-dir"] ?? defaultDataDir(), stateDir, graceMs: grace, copy: !copyOff });
  }
  /**
   * `start` is `serve` with the terminal handed back: what `sidewalk.sh/install`
   * runs, and what a person who does not want a window parked on a daemon runs.
   * It spawns this same entry's `serve` detached — the state file `status` and
   * `stop` already read is the whole of the bookkeeping — waits for it to answer
   * /health, and prints the pid.
   *
   * The child's own output goes to `<data dir>/walkd.log`, because a daemon
   * nobody can see is a daemon nobody can diagnose. The token line is printed
   * here instead, by the half the person is looking at, which is why the child
   * is told `--no-copy`: one clipboard write, one line about it, in this
   * process.
   */
  if (cmd === "start") {
    const dataDir = values["data-dir"] ?? defaultDataDir();
    const s = await readState(stateDir);
    // Same rule as `serve`: the daemon on that port has to be the one this state
    // file names before `start` calls it "already running" (found in review).
    if (s && sameDaemon(await isHealthy(s.port), s)) { process.stdout.write(`walkd: already running on port ${s.port} (pid ${s.pid}). "walkd token --copy" puts its token on your clipboard.\n`); process.exitCode = 1; return; }
    const entry = process.argv[1];
    if (!entry) { process.stderr.write("walkd: start cannot find its own entry script; run \"walkd serve\" instead\n"); process.exitCode = 2; return; }
    // What the token file holds now decides what the child will do with it, so
    // it is read before the child exists: a file this daemon can vouch for is
    // one the child reuses, and anything else is one it replaces.
    const before = await inspectToken(dataDir);
    const args = ["serve", "--data-dir", dataDir, "--state-dir", stateDir, "--no-copy"];
    if (values.port !== undefined) args.push("--port", values.port);
    if (values["grace-ms"] !== undefined) args.push("--grace-ms", values["grace-ms"]);
    await fs.mkdir(dataDir, { recursive: true, mode: DIR_MODE });
    const logPath = path.join(dataDir, "walkd.log");
    const log = await fs.open(logPath, "a", 0o600);
    // process.execArgv so a parent started with --import tsx (the tests) hands
    // the child the same loader; detached + unref so this process can exit and
    // leave it running.
    const child = spawn(process.execPath, [...process.execArgv, entry, ...args], { detached: true, stdio: ["ignore", log.fd, log.fd] });
    child.unref();
    let live: State | null = null;
    for (let i = 0; i < 100 && !live; i++) {
      await new Promise(r => setTimeout(r, 100));
      const st = await readState(stateDir);
      if (st && st.pid === child.pid && sameDaemon(await isHealthy(st.port), st)) live = st;
    }
    await log.close();
    if (!live) { process.stderr.write(`walkd: started a daemon (pid ${child.pid}) but nothing answered /health. Its output is in ${logPath}.\n`); process.exitCode = 1; return; }
    process.stdout.write(`walkd ${VERSION} is running in the background on http://127.0.0.1:${live.port}, pid ${live.pid}. "walkd status" checks it and "walkd stop" stops it. Its output goes to ${logPath}.\n`);
    const token = await readToken(dataDir).catch(() => null);
    if (token !== null) {
      const pin = tokenFromEnv();
      const fresh = pin === undefined && !(before.ok && before.token === token);
      const copied = fresh && !copyOff ? await copyToClipboard(token) : null;
      process.stdout.write(tokenLine({ file: tokenPath(dataDir), kept: !fresh && pin === undefined, pinned: pin !== undefined, copied: copied?.cmd ?? null, copyOff }));
    }
    return;
  }
  if (cmd === "status") {
    const s = await readState(stateDir); if (!s) { process.stdout.write("walkd: not running (no state file)\n"); process.exitCode = 1; return; }
    // Three answers, not two: ours, nothing, or a stranger holding the port. The
    // middle word used to be "healthy" for all three (found in review).
    const h = await isHealthy(s.port);
    const ours = sameDaemon(h, s);
    const word = ours ? "healthy" : h ? "SOMETHING ELSE ON THIS PORT" : "NOT ANSWERING";
    process.stdout.write(`walkd pid ${s.pid} port ${s.port} data ${s.dataDir} since ${s.startedAt} — ${word}\n`);
    if (!ours) process.exitCode = 1; return;
  }
  /**
   * The token, for the person. The pane cannot read a file and the extension is
   * not allowed to, so this is how the one paste into the gear happens — once,
   * now that the token outlives a restart.
   *
   * The running daemon's own data dir wins, because that is the daemon the
   * panel is talking to — `--data-dir` is for reading another one's, and the
   * default is the answer when nothing is running.
   *
   * `--rotate` is the whole of "make me a new one": it mints, writes the file,
   * puts it on the clipboard (a new token is a token to paste, so `--rotate`
   * copies unless told `--no-copy`) and says what it did. It does not reach into
   * a running daemon — that daemon holds its token in memory and keeps serving
   * it, so the honest line to print is "restart it". A daemon that re-read the
   * file on a 401 would be the alternative, and it buys a minute of ambiguity
   * (which token is live right now?) and a timer to pay for a restart the MCP
   * server does by itself on its next call.
   */
  if (cmd === "token") {
    const dataDir = values["data-dir"] ?? (await readState(stateDir))?.dataDir ?? defaultDataDir();
    const fromEnv = tokenFromEnv();
    let token: string;
    if (values.rotate) {
      // Nothing to rotate when the environment pins the token: the file is not
      // what the daemon would serve, so writing a new one into it would only
      // break `walkd token` for the next person to run it.
      if (fromEnv) { process.stderr.write(`walkd: ${TOKEN_ENV} pins the token, so there is nothing to rotate. Unset it and start walkd again first.\n`); process.exitCode = 2; return; }
      token = newToken();
      const file = await writeToken(dataDir, token);
      process.stdout.write(`walkd: a new token is in ${file}. A daemon already running keeps serving the old one until you restart it: "walkd stop", and your agent starts the next one.\n`);
    }
    else if (fromEnv) token = fromEnv;
    else {
      try { token = await readToken(dataDir); }
      catch (e) { process.stderr.write(`walkd: ${(e as Error).message}\n`); process.exitCode = 1; return; }
    }
    // A rotate copies by default — the person asked for a new token, and the
    // only reason to want one is to paste it — where a plain `token` prints
    // unless asked. `--no-copy` turns both off, for a script and for CI.
    const wantsClipboard = !copyOff && (values.copy === true || values.rotate === true);
    if (!wantsClipboard) { process.stdout.write(`${token}\n`); return; }
    const copied = await copyToClipboard(token);
    if (copied) process.stdout.write(`walkd: token copied to the clipboard (${copied.cmd}). Paste it into the panel's gear.\n`);
    else process.stdout.write(`${token}\nwalkd: no clipboard command on this machine (pbcopy, clip, wl-copy, xclip, xsel). The token is printed above.\n`);
    return;
  }
  if (cmd === "stop") {
    const s = await readState(stateDir);
    if (!s) { process.stdout.write("walkd: not running (no state file)\n"); return; }
    // Never signal on the state file's word alone: the daemon may be long gone
    // and the OS may have handed its pid to something else.
    const h = await isHealthy(s.port);
    if (!h) {
      await fs.rm(stateFile(stateDir), { force: true });
      process.stdout.write("walkd: not running (stale state file removed)\n");
      return;
    }
    // Something answers, but not the daemon this file names — another user's
    // walkd, a container, an unrelated program. Signalling the recorded pid here
    // killed whatever had inherited it (found in review), so this stops instead and
    // says what it found. The state file stays: it is the only evidence left.
    if (!sameDaemon(h, s)) {
      process.stdout.write(`walkd: something else answers on ${s.port}; not stopping it.\n`);
      process.exitCode = 1;
      return;
    }
    try { process.kill(s.pid, "SIGTERM"); }
    catch (e) { process.stdout.write(`walkd: pid ${s.pid} could not be signalled (${(e as Error).message})\n`); }
    return;
  }
  process.stderr.write(USAGE); process.exitCode = 2;
}
