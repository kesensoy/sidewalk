#!/usr/bin/env node
"use strict";
/**
 * walkd's native messaging host.
 *
 * The browser launches this, writes one message to its stdin and reads one from
 * its stdout; then it exits. It never holds the daemon's lifetime — walkd is
 * the long-lived process, and this is the shim that tells a panel where that
 * walkd is and what token it wants.
 *
 * The framing is the native messaging framing: a 4-byte little-endian length,
 * then that many bytes of JSON. The incoming message is not read for content —
 * the browser is what decides which extension may reach this at all, through
 * `allowed_origins` / `allowed_extensions` in the manifest, and this answers
 * whoever got through.
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

function reply() {
  const stateDir = arg("--state-dir");
  if (!stateDir) return answer({ ok: false, reason: "this host was installed without --state-dir" });
  let state;
  try { state = JSON.parse(fs.readFileSync(stateDir + "/walkd.json", "utf8")); }
  catch { return answer({ ok: false, reason: "no walkd is running" }); }
  // walkd writes its data directory into the state file, so the token is found
  // without this host knowing a thing about where either one lives.
  const dataDir = arg("--data-dir") || state.dataDir || stateDir.replace(/[\\/][^\\/]+[\\/]*$/, "");
  let token;
  try { token = fs.readFileSync(dataDir + "/token", "utf8").trim(); }
  catch { return answer({ ok: false, reason: "walkd's token could not be read" }); }
  if (!Number.isInteger(state.port) || !token) return answer({ ok: false, reason: "walkd's state file is incomplete" });
  answer({ ok: true, port: state.port, token: token });
}

let buf = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  buf = Buffer.concat([buf, chunk]);
  if (buf.length < 4) return;
  const len = buf.readUInt32LE(0);
  if (len > 1024 * 1024) return answer({ ok: false, reason: "message too large" });
  if (buf.length < 4 + len) return;
  process.stdin.pause();
  reply();
});
// A browser that opened the pipe and said nothing, and a browser that closed
// it: neither is a reason to sit here holding a process open.
process.stdin.on("end", () => process.exit(0));
setTimeout(() => process.exit(0), 10000);
