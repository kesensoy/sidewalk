#!/usr/bin/env node
/**
 * The Lamppost demo launcher.
 *
 * It plays the agent so the demo needs no Claude session: it opens a walk on
 * the running daemon, puts the first group of cards on the pane, rebuilds the
 * history page and adds the second group a while later, and reads verdicts on
 * a rhythm — which is what turns the person's green Undo red on camera.
 *
 *   node demo/run.mjs [--port 8760] [--site 9350] [--after 30] [--read 20] [--manual] [--token T]
 *
 *   --port    the walkd the extension is pointed at
 *   --token   that daemon's token; read from its own data dir when not given
 *   --site    the port Lamppost runs on
 *   --after   seconds until history is rebuilt and group B lands
 *   --read    seconds between agent reads
 *   --manual  read only when Enter is pressed
 *
 * It talks plain HTTP to the daemon (packages/walkd/src/http.ts is the route
 * list) and never through MCP: a demo that needed an agent session would not
 * be repeatable.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultStateDir, readState, readToken, tokenFromEnv } from "sidewalk-walkd";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK = path.join(HERE, "walk.json");
const SERVE = path.join(HERE, "site", "serve.mjs");
const PROJECT = "lamppost";

const sleep = ms => new Promise(r => setTimeout(r, ms));

export const loadPack = async (file = PACK) => JSON.parse(await fs.readFile(file, "utf8"));

/**
 * The token the daemon on `--port` made when it started (secrets review).
 *
 * It is in a file in that daemon's data dir, and its state file is where that
 * dir is named — the same pairing `sidewalk-mcp` does, for the same reason: this
 * is a program on the same machine. `WALKD_TOKEN`, and `token` from the
 * recorder (which spawns its own daemon and knows its data dir outright), are
 * the ways in when there is no state file to read.
 */
export async function findToken({ token, stateDir, base } = {}) {
  if (token) return token;
  const fromEnv = tokenFromEnv();
  if (fromEnv) return fromEnv;
  // A daemon that is not asking for one — an embedded server with no token
  // configured, or one too old to have the idea — says so on /health, and that
  // is cheaper and more honest than guessing from a file that is not there.
  if (base && !(await wantsToken(base))) return "";
  const state = await readState(stateDir ?? defaultStateDir());
  if (!state) throw new Error("no walkd state file: start the daemon (npm start) or set WALKD_TOKEN");
  return readToken(state.dataDir);
}

/** Does the daemon on `base` want a token? Unreachable counts as yes. */
async function wantsToken(base) {
  try { return (await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) })).json()).auth === "token"; }
  catch { return true; }
}

/** The daemon, as four calls and a health check. */
export function makeDaemon(base, token = "") {
  // Every call has a deadline: a fetch that never answers would otherwise
  // leave a read in flight forever, and the guard below it would then skip
  // every later tick in silence.
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`walkd ${res.status}: ${data.error ?? "error"}`);
    return data;
  };
  return {
    base,
    async healthy() { try { return (await (await fetch(`${base}/health`)).json()).ok === true; } catch { return false; } },
    list: () => call("GET", "/walks"),
    open: walk => call("POST", "/walks", walk),
    add: (id, items) => call("POST", `/walks/${id}/items`, { items }),
    /**
     * The read an agent makes: no `?viewer=1`, so the daemon moves `delivered`
     * and every verdict it hands over stops being quietly undoable.
     */
    read: (id, after) => call("GET", `/walks/${id}?after=${after}`),
    close: (id, summary) => call("POST", `/walks/${id}/close`, { summary }),
  };
}

/** Lamppost: start it if it is not up, rebuild its history page, put it back. */
export function makeSite(port) {
  const base = `http://127.0.0.1:${port}`;
  let child = null;
  const post = async (p, body) => {
    const res = await fetch(base + p, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`lamppost ${res.status} on ${p}`);
    return res.json();
  };
  const answers = async () => { try { return (await fetch(`${base}/__demo/history-build`)).ok; } catch { return false; } };
  return {
    base,
    /** "already" if something was serving there, "started" if we spawned one. */
    async start() {
      if (await answers()) return "already";
      child = spawn(process.execPath, [SERVE], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
      for (let i = 0; i < 100; i++) {
        if (await answers()) return "started";
        await sleep(100);
      }
      child.kill("SIGTERM");
      child = null;
      throw new Error(`lamppost did not answer on ${port}`);
    },
    flipHistory: build => post("/__demo/history-build", { build }),
    reset: () => post("/__demo/reset"),
    /** Only ever stops a site this process started. */
    stop() { if (child) { child.kill("SIGTERM"); child = null; } },
    get ours() { return child !== null; },
  };
}

/** `demo-<n>`, one past the highest open one. A closed id can never be reused. */
export function nextWalkId(walks, project = PROJECT) {
  let max = 0;
  for (const w of walks) {
    if (w.project !== project) continue;
    const m = /^demo-(\d+)$/.exec(w.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `demo-${max + 1}`;
}

/**
 * Open the walk. `GET /walks` lists only the open ones, so the id after the
 * highest of those may still be a closed walk's — the daemon says so, and the
 * answer is simply the next number up.
 */
export async function openWalk(daemon, walk, id) {
  let n = Number(/^demo-(\d+)$/.exec(id)[1]);
  for (let i = 0; i < 100; i++, n++) {
    try { return await daemon.open({ ...walk, id: `demo-${n}` }); }
    catch (e) { if (!/closed/.test(e.message)) throw e; }
  }
  throw new Error("no free demo walk id under 100 tries");
}

/** One verdict, one line: kind, item, the person's words in quotes. */
export function verdictLine(v) {
  // The record keeps the words as they were typed; only this terminal line
  // folds a newline into a space, so one verdict stays one line.
  return `${v.kind} ${v.itemId} "${v.text.replace(/\s+/g, " ").trim()}"`;
}

/**
 * Open the walk, land the groups, read on a rhythm. Resolves as soon as the
 * walk is open and group A is on the pane, with a handle: `read()` is one
 * agent read, `landGroupB()` lands the second group now rather than on the
 * timer, `finished` settles when the walk is closed, and `stop()` closes it.
 * `cursor` and `handed` are what the agent has actually been given, for a
 * recorder that films the agent's side of the link.
 */
export async function main(opts = {}) {
  const {
    port = 8760,
    site: sitePort = 9350,
    afterMs = 30_000,
    readMs = 20_000,
    doneMs = 10_000,
    manual = false,
    log = console.log,
  } = opts;
  const pack = opts.pack ?? (await loadPack());
  // The daemon wants its token on everything but /health, so the launcher finds
  // it before the first call rather than discovering a 401 halfway in.
  const base = `http://127.0.0.1:${port}`;
  const daemon = opts.daemon ?? makeDaemon(base, await findToken({ token: opts.token, base }));
  const site = opts.siteHandle ?? makeSite(sitePort);

  const how = await site.start();
  await site.reset();
  log(how === "already" ? `Lamppost was already on ${sitePort}.` : `Lamppost on ${sitePort}.`);

  if (!(await daemon.healthy())) throw new Error(`no walkd on ${port} (start it with: npm start)`);
  const walk = await openWalk(daemon, pack.walk, nextWalkId(await daemon.list()));
  log(`Walk ${walk.id}.`);

  /** item id -> the group it landed in, so an Ask's answer is filed in the asked card's group. */
  const added = new Map();
  const answered = new Set();
  let cursor = 0;
  let verdicts = 0;
  let closed = false;
  /**
   * Every verdict the agent has been handed, in the order the daemon handed
   * them over.
   *
   * The recorder's terminal surface prints `walk_wait`'s results, and the only
   * honest source for what one returned is what the read really got: the seqs,
   * the kinds, the person's own words, the option they picked, the steps they
   * ticked. `cursor` is exposed beside it for the same reason — the `after` the
   * next wait is called with is the agent's cursor, which is not the pane's
   * (a quietly-undone verdict never reaches an agent read, so the two differ).
   */
  const handed = [];

  const addGroup = async g => {
    const items = g.items.map(i => ({ ...i, group: g.name }));
    await daemon.add(walk.id, items);
    for (const i of items) added.set(i.id, i.group);
  };

  await addGroup(pack.groups[0]);
  log("Group A on the pane.");

  let resolveFinished;
  const finished = new Promise(r => { resolveFinished = r; });
  const timers = [];
  const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
  let doneTimer = null;
  let reads = null;

  const close = async () => {
    if (closed) return;
    closed = true;
    for (const t of timers) clearTimeout(t);
    if (reads) clearInterval(reads);
    if (doneTimer) clearTimeout(doneTimer);
    try { await daemon.close(walk.id, `Lamppost demo: ${verdicts} verdicts.`); } catch { /* already closed */ }
    log(`Closed ${walk.id}: ${verdicts} verdicts.`);
    site.stop();
    resolveFinished();
  };

  // Group B, and the history page catching up with the rest of the build.
  //
  // On the handle as well as on the timer, because a recording has to hit a
  // mark: `demo/record.mjs` sets `afterMs` past the end of its take and calls
  // this at the beat it wants. Whichever gets there first, group B lands once.
  let landedB = false;
  const landGroupB = async () => {
    if (landedB) return false;
    landedB = true;
    try {
      await site.flipHistory("lp-24");
      await addGroup(pack.groups[1]);
      log("Group B on the pane; history rebuilt.");
      return true;
    } catch (e) { landedB = false; throw e; }
  };
  later(async () => {
    try { await landGroupB(); } catch (e) { log(`Group B failed: ${e.message}`); }
  }, afterMs);

  // One read at a time. The interval does not wait for the previous read, so
  // a slow daemon would let two leave with the same cursor and the same
  // verdict would be counted, printed and answered twice.
  let reading = false;
  const read = async () => {
    if (closed || reading) return;
    reading = true;
    // Anything that escapes readOnce is said out loud: the interval that calls
    // this drops a rejection on the floor, and a read that died after moving
    // the cursor would otherwise look like a read that saw nothing.
    try { await readOnce(); }
    catch (e) { log(`Read failed: ${e?.stack ?? e}`); }
    finally { reading = false; }
  };
  const readOnce = async () => {
    let r;
    try { r = await daemon.read(walk.id, cursor); }
    catch (e) { log(`Read failed: ${e.message}`); return; }
    cursor = r.cursor;
    for (const v of r.verdicts) {
      verdicts++;
      handed.push(v);
      log(verdictLine(v));
      if (v.kind === "blocked") continue;
      // An `ask` is a question back, not an answer: the card stays open, so
      // the walk is not finished on the strength of one.
      if (v.kind === "ask") {
        // `supersedes` names the asked card: it is what marks the ask answered
        // (walk_read lists the ones still open under openAsks), and it is what
        // puts the answer on that card instead of on a card of its own. The
        // group is still the asked card's, which is what the reply line asks
        // for and where a `question` reply would sit.
        //
        // Not into `added`: an attached answer never gets a verdict, so a walk
        // that counted it as outstanding would never finish.
        const reply = { ...pack.ask, id: `lp-ask-${v.seq}`, group: added.get(v.itemId), supersedes: v.itemId };
        try { await daemon.add(walk.id, [reply]); log(`Answered the ask with ${reply.id}.`); }
        catch (e) { log(`Ask reply failed: ${e.message}`); }
        continue;
      }
      if (v.kind === "undo") answered.delete(v.itemId);
      else answered.add(v.itemId);
    }
    const outstanding = [...added.keys()].filter(id => !answered.has(id));
    if (outstanding.length === 0) doneTimer ??= setTimeout(close, doneMs);
    else if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
  };

  if (manual) {
    log("Manual: press Enter to read.");
    process.stdin.resume();
    process.stdin.on("data", () => { void read(); });
  } else {
    reads = setInterval(() => { void read(); }, readMs);
  }

  return {
    id: walk.id, walk, site, daemon, read, landGroupB, finished, stop: close,
    /** The agent's own cursor: what the next `walk_wait` would be called with. */
    get cursor() { return cursor; },
    /** Every verdict the agent has been handed, oldest first. */
    handed,
  };
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--manual") opts.manual = true;
    else if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--token") opts.token = argv[++i];
    else if (a === "--site") opts.site = Number(argv[++i]);
    else if (a === "--after") opts.afterMs = Number(argv[++i]) * 1000;
    else if (a === "--read") opts.readMs = Number(argv[++i]) * 1000;
    else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const handle = await main(parseArgs(process.argv.slice(2)));
  process.on("SIGINT", () => { void handle.stop(); });
  await handle.finished;
  process.exit(0);
}
