#!/usr/bin/env node
"use strict";
/**
 * walkd's native messaging host.
 *
 * The browser launches this, writes one message to its stdin and reads one from
 * its stdout; then it exits. It never holds the daemon's lifetime — walkd is
 * the long-lived process, and this is the shim that tells a panel where that
 * walkd is and what token it wants, and — since 1.2.0 — stops it when the panel
 * asks.
 *
 * The framing is the native messaging framing: a 4-byte little-endian length,
 * then that many bytes of JSON. The browser is what decides which extension may
 * reach this at all, through `allowed_origins` / `allowed_extensions` in the
 * manifest, and this answers whoever got through.
 *
 * Two ops, read off the frame's `t`. Until 1.2.0 the frame was not read for
 * content at all and every message got the token, which is why the stop answer
 * carries `stopped: true`: a panel talking to an older host than itself gets
 * `{ok: true, port, token}` back from a stop request, and the marker is how it
 * tells that apart from a daemon that actually went away. An op this host does
 * not know is `unknownOp` and nothing else happens.
 *
 * `node:fs` and nothing else, and no imports from the package it was copied out
 * of, so it keeps working after an npx cache is swept. Paths are joined with a
 * forward slash, which Node accepts on Windows too.
 */
const fs = require("node:fs");

const arg = name => { const i = process.argv.indexOf(name); return i > 1 ? process.argv[i + 1] : undefined; };

function answer(body) {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([head, json]), () => process.exit(0));
}

/** The state file this host was installed to read, parsed, or a reason it was not. */
function readState() {
  const stateDir = arg("--state-dir");
  if (!stateDir) return { why: "this host was installed without --state-dir" };
  try { return { stateDir, state: JSON.parse(fs.readFileSync(stateDir + "/walkd.json", "utf8")) }; }
  catch { return { why: "no walkd is running" }; }
}

function tokenReply() {
  const read = readState();
  if (read.why) return answer({ ok: false, reason: read.why });
  const state = read.state;
  // walkd writes its data directory into the state file, so the token is found
  // without this host knowing a thing about where either one lives. There is no
  // guess at it from the state directory's own path: on Linux the two are
  // siblings, not parent and child, so a guess would be wrong exactly where it
  // mattered.
  const dataDir = arg("--data-dir") || state.dataDir;
  if (!dataDir) return answer({ ok: false, reason: "walkd's state file names no data directory" });
  let token;
  try { token = fs.readFileSync(dataDir + "/token", "utf8").trim(); }
  catch { return answer({ ok: false, reason: "walkd's token could not be read" }); }
  if (!Number.isInteger(state.port) || !token) return answer({ ok: false, reason: "walkd's state file is incomplete" });
  answer({ ok: true, port: state.port, token: token });
}

/**
 * Is the daemon answering on that port the one this state file names?
 *
 * The twin of `sameDaemon` in `packages/walkd/src/cli.ts`, mirrored rather than
 * imported: this file takes `node:fs` and nothing else, so that a swept npx
 * cache cannot leave the browser running a host whose imports are gone. Change
 * one and change the other. The reasoning is written out where the twin lives;
 * the short of it is that a loopback port is not per-uid and a recorded pid can
 * have been reused, so the state file's word is never enough on its own.
 */
function sameDaemon(h, s) {
  if (!h) return false;
  if (h.pid === undefined) return typeof h.version === "string";
  return h.pid === s.pid && (h.startedAt === undefined || h.startedAt === s.startedAt);
}

/** How long /health has to answer. Shorter than the twin's unbounded fetch, because a browser is waiting. */
const HEALTH_TIMEOUT_MS = 2000;

/**
 * Stop the daemon this host was installed for.
 *
 * The twin of `stop` in `packages/walkd/src/cli.ts`, and the same four steps in
 * the same order: the state file, /health, `sameDaemon`, SIGTERM — then, on
 * Windows alone, the state file, because a "SIGTERM" there is TerminateProcess
 * and the daemon's own shutdown never runs to remove it.
 *
 * One thing the CLI has no need of: the port the panel means is on the frame and
 * has to match. One host serves the whole machine and it answers about whichever
 * walkd owns the registration, so without this a pane pointed at 8761 could
 * press its button and stop the daemon on 8760 — the `askHost` port guard in the
 * panel's `native.ts` exists for the same reason on the token op.
 */
async function stopReply(msg) {
  const read = readState();
  if (read.why) return answer({ ok: false, reason: read.why });
  const state = read.state;
  if (!Number.isInteger(state.port) || !Number.isInteger(state.pid)) return answer({ ok: false, reason: "walkd's state file is incomplete" });
  if (!Number.isInteger(msg.port)) return answer({ ok: false, reason: "a stop has to name the port it means" });
  if (msg.port !== state.port) return answer({ ok: false, reason: "this host is registered for walkd on " + state.port });

  let health = null;
  try {
    const res = await fetch("http://127.0.0.1:" + state.port + "/health", { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const h = await res.json();
    if (h && h.ok === true) health = h;
  } catch { health = null; }
  // Nothing healthy answers: the daemon this file names is already gone, which
  // is what was asked for. The file goes with it — the twin removes it here too,
  // and leaving it would have `walkd status` reporting a daemon that is NOT
  // ANSWERING until the next stop or start.
  if (!health) {
    try { fs.rmSync(read.stateDir + "/walkd.json", { force: true }); } catch { /* the daemon is gone either way */ }
    return answer({ ok: true, stopped: true });
  }
  // Something answers, but not the daemon this file names — another OS user's
  // walkd, a container, an unrelated program. Signalling the recorded pid here
  // would kill whatever had inherited it, so this stops and says what it found.
  // The state file stays: it is the only evidence left.
  if (!sameDaemon(health, state)) return answer({ ok: false, reason: "something else answers on " + state.port });
  try { process.kill(state.pid, "SIGTERM"); }
  catch (e) { return answer({ ok: false, reason: "pid " + state.pid + " could not be signalled (" + e.message + ")" }); }
  if (process.platform === "win32") { try { fs.rmSync(read.stateDir + "/walkd.json", { force: true }); } catch { /* the next start clears it */ } }
  answer({ ok: true, stopped: true });
}

function reply(bytes) {
  let msg;
  try { msg = JSON.parse(bytes.toString("utf8")); } catch { msg = null; }
  const t = msg && typeof msg === "object" ? msg.t : undefined;
  if (t === "token") return tokenReply();
  if (t === "stop") return void stopReply(msg);
  answer({ ok: false, reason: "unknownOp" });
}

// A browser that opened the pipe and said nothing, and a browser that closed
// it: neither is a reason to sit here holding a process open. Dropped the moment
// a message has been taken, because the stop op waits on /health and a pipe
// closed under it must not end the process before the daemon is signalled.
const bye = () => process.exit(0);
process.stdin.on("end", bye);

/** Nothing more will be read: one message in, one answer out. */
function done() {
  process.stdin.pause();
  process.stdin.off("end", bye);
}

let buf = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  buf = Buffer.concat([buf, chunk]);
  if (buf.length < 4) return;
  const len = buf.readUInt32LE(0);
  // Closed before either answer, so no further chunk can arrive and run this
  // handler a second time while the first answer is still being written.
  if (len > 1024 * 1024) { done(); return answer({ ok: false, reason: "message too large" }); }
  if (buf.length < 4 + len) return;
  done();
  reply(buf.subarray(4, 4 + len));
});
setTimeout(() => process.exit(0), 10000);
