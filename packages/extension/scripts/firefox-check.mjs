#!/usr/bin/env node
/**
 * Stand the Firefox build up in a real Firefox and watch it work.
 *
 *   npm run package                                  # the build this loads
 *   npm run firefox-check
 *   node packages/extension/scripts/firefox-check.mjs [--hold] [--out <dir>]
 *
 * There is no Playwright for stock Firefox — its Firefox is a patched build —
 * and `web-ext run` gives no handle to drive the page with. So the proof is
 * taken from the only two places that can see the add-on from outside: the
 * daemon it talks to, and the screen.
 *
 * It starts a walkd of its own on 8765 behind a **witness** on 8764 that
 * records every request's method, path, `Origin` and `User-Agent` and passes
 * it through unchanged. The fixture site is on 9344. Nothing here goes near
 * 8760 or 9340 (the human's), 8761/9342/9341 (the e2e's) or 8763/9353/9343
 * (the recorder's).
 *
 * What each half proves, and nothing more:
 *
 * - **The witness log.** A `GET /health`, a `GET /walks` and a long `GET
 *   /events` with a Firefox `User-Agent` prove the event page ran: Firefox has
 *   no service worker here, so `background.scripts` is being executed, and the
 *   shim did not throw on its way past. It also proves walkd's own guards
 *   (`refuse()` in `http.ts`) let a Firefox pane through — the `Origin` test
 *   there takes `moz-extension://` as well as `chrome-extension://`.
 * - **The screenshot.** Cards drawn in the sidebar prove the parts no request
 *   can: `panel.js` awaited `chrome.runtime.sendMessage` and got a state back
 *   (Firefox's own `chrome` namespace answers that with `undefined`, so an
 *   unshimmed pane paints nothing at all), and the worker got through
 *   `chrome.action.setBadgeText`, which the Firefox manifest has no `action`
 *   for and which the shim sends to the sidebar's tooltip instead.
 *
 * Two things it changes about the build it loads, both because a throwaway
 * Firefox profile cannot be told anything — the pane reads both out of
 * `chrome.storage.local`, and nothing outside the browser can write there.
 *
 * 1. The default port, rewritten from 8760 to 8764 in `sw.js` and `panel.js`.
 *    That is a string swap, counted and printed, and the run fails if it did not
 *    land exactly twice.
 * 2. The token. The daemon is started with `WALKD_TOKEN` pinned to the value
 *    below, and a seam is appended to each of those two bundles that writes it
 *    into `chrome.storage.local` — a statement after the bundle, not a swap
 *    inside it, because there is no token literal in there to swap. The worker
 *    either reads it at startup or hears it on `chrome.storage.onChanged` and
 *    retargets; both paths end with the pane let in. Without it the sidebar is
 *    refused, nothing is read, and the two asserts this script exists for both
 *    fail (found in review).
 *
 * Every other byte is the zip's.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
const EXT = path.resolve(HERE, "..");
const ROOT = path.resolve(EXT, "../..");
const BUILD = path.join(EXT, "store", "build", "firefox");
const WALKD = path.join(ROOT, "packages", "walkd", "bin", "walkd.js");
const FIXTURE = path.join(ROOT, "fixtures", "site", "serve.mjs");
const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";

const WITNESS = 8764, DAEMON = 8765, SITE = 9344;
const BASE = `http://127.0.0.1:${DAEMON}`;
/**
 * The token this check's daemon serves, pinned with `WALKD_TOKEN` so the script
 * knows it without reading a file and can put it in the throwaway profile. It is
 * a test value, published here on purpose: the daemon it unlocks is this run's
 * own, on 8765, and lives for about a minute.
 */
const TOKEN = "firefox-check-token-not-a-real-one-0123456789";
const hold = process.argv.includes("--hold");
const outArg = process.argv.indexOf("--out");
const OUT = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(os.tmpdir(), "sidewalk-firefox-check");

const sleep = ms => new Promise(r => setTimeout(r, ms));
const free = port => new Promise(res => {
  const s = net.createServer().once("error", () => res(false)).once("listening", () => s.close(() => res(true))).listen(port, "127.0.0.1");
});

for (const [port, who] of [[WITNESS, "the witness"], [DAEMON, "this check's walkd"], [SITE, "the fixture site"]]) {
  if (!(await free(port))) throw new Error(`port ${port} (${who}) is busy — stop whatever holds it, or this check would talk to it`);
}

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });

/* ------------------------------------------------- the build, port-rewritten */
const ext = path.join(OUT, "extension");
await fs.cp(BUILD, ext, { recursive: true });
let rewrites = 0;
// The seam: one statement after the bundle, so the profile starts with the
// token the daemon was pinned to. It is appended rather than prepended because
// esbuild's own `"use strict"` has to stay the first thing in the file, and
// because by the time it runs the worker's `chrome.storage.onChanged` listener
// is registered — so a late write retargets the link rather than being missed.
const seam = token => `\n// firefox-check.mjs: the token this run's daemon was started with.\ntry { chrome.storage.local.set({ "walkd:token": ${JSON.stringify(token)} }); } catch (e) { console.error("firefox-check seam:", e); }\n`;
for (const f of ["sw.js", "panel.js"]) {
  const p = path.join(ext, f);
  const before = await fs.readFile(p, "utf8");
  // The witness, not the daemon: the point of rewriting the port at all is to
  // put something in the path that can see what Firefox sends.
  const after = before.replaceAll("8760", String(WITNESS));
  rewrites += before.split("8760").length - 1;
  await fs.writeFile(p, after + seam(TOKEN));
}
// One in each bundle: `DEFAULT_PORT`, inlined by esbuild. More than that and
// the number means something else somewhere, and this check is editing it.
if (rewrites !== 2) throw new Error(`expected 8760 twice in the bundles, found ${rewrites} — look before trusting this run`);
console.log(`build: ${path.relative(ROOT, BUILD)} copied to ${ext}, default port 8760 → ${WITNESS} (${rewrites} places), token seam in sw.js and panel.js`);

/* ------------------------------------------------------------- the processes */
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-ff-"));
const kids = [];
const spawnKid = (cmd, args, env) => { const c = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } }); kids.push(c); return c; };
spawnKid("node", [FIXTURE], { PORT: String(SITE) });
spawnKid("node", [WALKD, "serve", "--port", String(DAEMON), "--data-dir", dataDir, "--state-dir", path.join(dataDir, "state")], { WALKD_TOKEN: TOKEN });

/** Every request the add-on makes, in order. */
const seen = [];
const witness = http.createServer((req, res) => {
  seen.push({ at: Date.now(), method: req.method, url: req.url, origin: req.headers.origin ?? null, ua: req.headers["user-agent"] ?? null });
  // `Host` is rewritten to the daemon's own address and nothing else is:
  // walkd's first guard (`refuse()` in `packages/walkd/src/http.ts`) refuses a
  // Host that is not its own socket, which is the DNS-rebinding door. A proxy
  // that forwarded the witness's port would be refused 403 on every call —
  // which is how this check found its own bug.
  const up = http.request({ host: "127.0.0.1", port: DAEMON, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${DAEMON}` } }, r => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
});
witness.listen(WITNESS, "127.0.0.1");

const healthy = async () => { try { return (await (await fetch(`${BASE}/health`)).json()).ok === true; } catch { return false; } };
for (let i = 0; i < 200 && !(await healthy()); i++) await sleep(100);
if (!(await healthy())) throw new Error(`no walkd on ${DAEMON}`);

/* ------------------------------------------------------------------ the walk */
// The daemon refuses every route but /health without its token, and this one was
// pinned to TOKEN above (found in review).
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(b) });
const WALK = "firefox-check";
await post("/walks", { project: "sidewalk", id: WALK, title: "sidewalk in Firefox", buildRef: "ff-check", brief: "Three cards, so the pane has something to draw. Nothing here is a real walk." });
const r = await post(`/walks/${WALK}/items`, {
  items: [
    { id: "ff-look", kind: "look", owner: "check", group: "firefox", title: "The sidebar drew this card", url: `http://127.0.0.1:${SITE}/`, do: "Read this card.", see: "A title, a link row with Go, and five buttons.", pass: "The card is here and the kerb is painted." },
    { id: "ff-secret", kind: "look", owner: "check", group: "firefox", title: "A secrets row, with its Copy button", url: `http://127.0.0.1:${SITE}/`, do: "Press Copy.", see: "The button says Copied and a line appears under the row.", pass: "The clipboard took it.", secrets: [{ label: "Demo API key", value: "ff-check-not-a-real-key" }] },
    { id: "ff-question", kind: "question", owner: "check", group: "firefox", title: "Does the pane look right in Firefox?", options: ["Yes", "No"] },
  ],
});
if (r.status !== 200) throw new Error(`items refused (${r.status}): ${await r.text()}`);
console.log(`walk: ${WALK}, three cards, on the witness at 127.0.0.1:${WITNESS}`);

/* ---------------------------------------------------------------- the browser */
const webExt = path.join(ROOT, "node_modules", ".bin", "web-ext");
spawnKid(webExt, ["run", "--source-dir", ext, "--firefox", FIREFOX, "--no-reload", "--no-config-discovery",
  "--start-url", `http://127.0.0.1:${SITE}/`, "--profile-create-if-missing", "--keep-profile-changes",
  "--firefox-profile", path.join(OUT, "profile")]);

console.log("firefox: starting; the sidebar opens with the add-on (sidebar_action, open_at_install)");

const shoot = name => {
  const p = path.join(OUT, `${name}.png`);
  try { execFileSync("screencapture", ["-x", "-o", p]); console.log(`screen: ${p}`); return p; }
  catch (e) { console.warn(`screen: screencapture refused (${e.message}); the witness log still stands`); return null; }
};

await sleep(18_000);
const shot = shoot("firefox-sidebar");

/* ------------------------------------------------------- does the stream hold?
 *
 * A Firefox event page is not a service worker: MDN says it "unloads after a
 * few seconds of inactivity" and that message ports cannot stop it — which
 * would end the one SSE stream the worker holds, and with it every card that
 * lands after the pane was opened. What is documented to keep it loaded is an
 * open visible view, and the sidebar is one.
 *
 * So: wait out a window several times longer than "a few seconds", then put a
 * card on the walk through the daemon and give it a moment. If the event page
 * had gone, the card cannot arrive — nothing polls for 30 s — and the second
 * screenshot shows three cards. If the stream held, it shows four.
 */
await sleep(25_000);
const late = await post(`/walks/${WALK}/items`, {
  items: [{ id: "ff-late", kind: "info", owner: "check", group: "firefox", title: "This card landed 43 seconds in", body: "It arrived on the stream the worker opened at the start. If you can read it, the event page did not idle out behind the open sidebar." }],
});
if (late.status !== 200) throw new Error(`late item refused (${late.status}): ${await late.text()}`);
await sleep(6_000);
const shotLate = shoot("firefox-sidebar-late");

const ua = seen.find(s => s.ua)?.ua ?? null;
const got = p => seen.filter(s => s.url?.startsWith(p));
const report = {
  requests: seen.length,
  userAgent: ua,
  firefox: /Firefox\/\d/.test(ua ?? ""),
  health: got("/health").length,
  walks: got("/walks").filter(s => s.url === "/walks").length,
  read: got(`/walks/${WALK}?`).length + got(`/walks/${WALK}/`).length,
  events: got("/events").length,
  origins: [...new Set(seen.map(s => s.origin).filter(Boolean))],
};
await fs.writeFile(path.join(OUT, "witness.json"), JSON.stringify({ report, seen }, null, 2));
console.log("\nwitness:", JSON.stringify(report, null, 2));

const fail = [];
if (!report.firefox) fail.push("no Firefox User-Agent reached the daemon — the event page never ran");
if (!report.health) fail.push("no GET /health");
if (!report.events) fail.push("no GET /events — the pane's one stream never opened");
if (!report.read) fail.push(`no read of /walks/${WALK} — the worker saw no walk to put on the pane`);

// One stream, opened once and never re-opened: a worker that had been unloaded
// and woken would have had to open another, and the count would climb.
if (report.events > 1) fail.push(`the stream was opened ${report.events} times — the event page is being unloaded under the open sidebar`);

if (hold) { console.log("\n--hold: Firefox is still up. Ctrl-C when you are done looking."); await new Promise(() => {}); }

for (const c of kids) c.kill("SIGTERM");
witness.close();
// The sidebar's SSE stream is still an open socket on the witness, and `close()`
// only stops it accepting new ones — so without this the script sits there after
// printing its verdict, with nothing left to do. Nobody saw it before: the run
// threw at the first POST (EXT-3) and never reached this line.
witness.closeAllConnections();
await sleep(500);
await fs.rm(dataDir, { recursive: true, force: true });

if (fail.length) { for (const f of fail) console.error(`FAIL: ${f}`); process.exit(1); }
console.log("\nOK — the Firefox event page connected, read the walk and held the stream open.");
console.log(`Look at ${shot} for the half no request can prove: the cards in the sidebar.`);
// Firefox is somebody else's process now (web-ext's child, and `web-ext run`
// does not always take it down with it), so say so and go rather than wait for
// an event loop that may never empty.
process.exit(0);
