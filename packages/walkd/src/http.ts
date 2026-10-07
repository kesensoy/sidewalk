import http from "node:http";
import { createRequire } from "node:module";
import { ZodError } from "zod";
import { NotFound, type WalkStore } from "./store.js";
import { presented, sameToken } from "./token.js";

/**
 * The daemon's version is its package's, read once, so a release is one edit
 * (`node scripts/version.mjs set X.Y.Z`) and the number on /health can never
 * drift from the one npm shows. From dist/http.js and from src/http.ts alike,
 * ../package.json is this package's.
 */
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;
const MAX_BODY = 8 * 1024 * 1024;
// undici (the fetch in every Node client, including sidewalk-mcp) aborts a request
// whose headers have not arrived in 300 s. A wait must finish inside that or the
// caller sees a transport error instead of an empty result.
export const MAX_WAIT_MS = 280_000;

export function parseAfter(raw: string | null): number {
  const n = Number(raw ?? 0);
  if (!Number.isInteger(n) || n < 0) throw new Error("after must be a non-negative integer");
  return n;
}
export function clampWait(raw: string | null): number {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_WAIT_MS) : 0;
}

/**
 * The three things a daemon with no login can still check, and what each one
 * closes. Null means the request may proceed.
 *
 * `Host` — the URL in the handler is parsed against a fixed base, so the header
 * itself was never read, and that is exactly what makes DNS rebinding work: a
 * page served from `attacker.example:8760` whose name then resolves to
 * 127.0.0.1 is same-origin with this daemon in the browser's eyes, and its
 * fetches arrive carrying `Host: attacker.example:8760`. Only this daemon's own
 * loopback address is accepted. The port comes off the socket rather than a
 * closure because a server can be created long before it is told where to
 * listen — every test in this package does exactly that.
 *
 * `Origin` — `chrome-extension://…` on the pane's posts, and absent both on a
 * client that is not a browser (Node's fetch, curl, the MCP client) and on the
 * pane's own GETs, because a browser sends no Origin on a plain GET. Measured
 * over a whole e2e run: 28 posts carrying the extension's origin, 402 requests
 * carrying none. So an Origin that is present and is not an extension's is a
 * web page, and a web page has no business in a walk; the reads are the Host
 * rule's to guard, not this one's.
 *
 * `Content-Type` on a POST — a cross-origin `fetch` in `no-cors` mode and a
 * `<form enctype="text/plain">` are the two ways a page can post to loopback
 * without being asked anything, and neither can set `application/json`.
 * Requiring it is what stops a page forging an item onto somebody's pane, or
 * filing a verdict their agent then builds on.
 */
export function refuse(req: http.IncomingMessage): { status: number; error: string } | null {
  const port = req.socket.localPort;
  const host = (req.headers.host ?? "").toLowerCase();
  if (port === undefined || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host))
    return { status: 403, error: "host must be this daemon's own loopback address" };
  const origin = req.headers.origin;
  if (origin !== undefined && !/^(chrome|moz)-extension:\/\//i.test(origin))
    return { status: 403, error: "origin not allowed" };
  if ((req.method ?? "GET").toUpperCase() === "POST") {
    const type = (req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    if (type !== "application/json") return { status: 415, error: "content-type must be application/json" };
  }
  return null;
}

/**
 * What the daemon asks of a caller now that it has something to ask: its
 * token, in the one header, on everything but `GET /health`.
 *
 * `/health` stays open because it is how every client — the pane, the MCP
 * client, `walkd status`, the e2e — finds out whether anything is there at
 * all, and it says nothing about any walk. It does say `auth`, so a client can
 * tell a daemon that wants a token from one too old to have one.
 *
 * Null means the request may proceed. The message names the file, because the
 * file is the only thing the person can act on.
 */
export type Auth = { token: string; file: string };

export function unauthorized(req: http.IncomingMessage, auth: Auth | undefined): { status: number; error: string } | null {
  if (!auth) return null;
  if (sameToken(presented(req.headers.authorization), auth.token)) return null;
  return { status: 401, error: `walkd needs its token: send "Authorization: Bearer <token>". The token is in ${auth.file}; "walkd token" prints it, and the panel takes it in its gear.` };
}

/**
 * `opts.version` is what /health advertises. The e2e starts a daemon that
 * claims another version to prove the pane notices; nothing else sets it.
 *
 * `opts.auth` is the daemon's token and the file it was written to. With it,
 * every route but `GET /health` wants that token; without it the daemon
 * answers anybody who clears `refuse` — which is what the tests and an
 * embedder that has its own front door get, the same way the bind is theirs
 * to choose (`createHttpServer` never listens). `walkd serve` always has one.
 *
 * `opts.graceMs` is the other half of /health: the free-Undo window, which the
 * pane draws as the drain bar under a ledge row. It defaults to the window the
 * store is actually enforcing, so the two cannot drift; the CLI passes it the
 * way it passes the version, from the one number it built the store with.
 *
 * `opts.startedAt` is the identity half of /health, with the pid beside it. A
 * loopback port is not per-uid and a recorded pid can be handed to something
 * else after a reboot or a SIGKILL, so "something answers on 8760" was never the
 * same question as "the daemon the state file names answers on 8760". These two
 * fields are what lets the CLI ask the second one before it signals a pid or
 * refuses to start (found in review). The CLI passes the
 * timestamp it writes into the state file, so the two are the same string.
 */
export function createHttpServer(store: WalkStore, opts: { version?: string; graceMs?: number; auth?: Auth; startedAt?: string } = {}): http.Server {
  const version = opts.version ?? VERSION;
  const graceMs = opts.graceMs ?? store.graceMs;
  const auth = opts.auth;
  const startedAt = opts.startedAt ?? new Date().toISOString();
  return http.createServer(async (req, res) => {
    try {
      // Before the route, and before the body: every route, the two streams
      // included, answers only a client that cleared `refuse`.
      const no = refuse(req);
      if (no) return json(res, no.status, { error: no.error });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean);
      const m = req.method ?? "GET";
      // `pid` and `startedAt` say which process this is, so a client holding a
      // state file can tell this daemon from whatever else may hold the port.
      if (m === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, version, graceMs, auth: auth ? "token" : "none", pid: process.pid, startedAt });
      // After /health and before the route: a caller with no token learns
      // nothing a stranger should not know, not even which walks exist or
      // whether a path is one of this daemon's.
      const no401 = unauthorized(req, auth);
      if (no401) return json(res, no401.status, { error: no401.error });
      // Every walk's events on one connection. A browser gives one origin six
      // connections, so a client taking one stream per walk spends them all on
      // streams past the sixth walk and its own health checks, reads and posts
      // queue behind them. Nothing here is per walk, so nothing 404s.
      if (m === "GET" && url.pathname === "/events") return await sse(req, res, store);
      if (parts[0] !== "walks") return json(res, 404, { error: "not found" });
      if (parts.length === 1) {
        if (m === "GET") return json(res, 200, await store.list());
        if (m === "POST") return json(res, 200, await store.open(await body(req)));
      }
      const id = parts[1];
      // `?viewer=1` is the pane painting, which hands nothing to an agent.
      if (parts.length === 2 && m === "GET") return json(res, 200, await store.read(id, parseAfter(url.searchParams.get("after")), { viewer: url.searchParams.get("viewer") === "1" }));
      // Awaited, not just returned: `sse` looks the walk up first, and an
      // unknown id threw past this try into an unhandled rejection that took
      // the whole daemon down with it. A pane asking for a walk this daemon
      // does not have is an ordinary 404 — it happens the moment a pane is
      // pointed at a different daemon, or a walk's data is removed under it.
      if (parts[2] === "events" && m === "GET") return await sse(req, res, store, id);
      if (parts[2] === "wait" && m === "GET") {
        const after = parseAfter(url.searchParams.get("after"));
        return json(res, 200, await store.wait(id, after, clampWait(url.searchParams.get("timeoutMs"))));
      }
      if (parts[2] === "items" && parts.length === 3 && m === "POST") return json(res, 200, await store.addItems(id, (await body(req)).items));
      // The itemId is percent-encoded by the client (a ":" in an id would
      // otherwise arrive as %3A and match nothing).
      if (parts[2] === "items" && parts[4] === "withdraw" && m === "POST") return json(res, 200, await store.withdraw(id, decodeURIComponent(parts[3]), (await body(req)).reason ?? ""));
      if (parts[2] === "verdicts" && m === "POST") return json(res, 200, await store.addVerdict(id, await body(req)));
      if (parts[2] === "close" && m === "POST") return json(res, 200, await store.close(id, (await body(req)).summary ?? ""));
      return json(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof NotFound) return json(res, 404, { error: e.message });
      if (e instanceof TooLarge) return json(res, 413, { error: "body over 8 MB" });
      if (e instanceof ZodError) return json(res, 400, { error: e.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
      return json(res, 400, { error: (e as Error).message });
    }
  });
}

class TooLarge extends Error {}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function body(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0; let over = false;
    // Over the cap we stop buffering but keep draining: destroying the socket
    // here would kill the 413 response before the client could read it.
    req.on("data", c => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) { over = true; chunks.length = 0; reject(new TooLarge()); req.resume(); }
      else chunks.push(c);
    });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

/**
 * One SSE stream. With a `walkId` it is that walk's own (`/walks/:id/events`)
 * and each frame's `data` is the payload itself, as it always was. Without one
 * it is the multiplexed stream (`/events`): every walk rides it, so each frame
 * has to say which walk it is about, and `data` is `{walk, data}`. The
 * multiplexed stream also carries `open` — a walk this client has never heard
 * of — which is the whole reason it does not need a walk id to subscribe.
 */
async function sse(req: http.IncomingMessage, res: http.ServerResponse, store: WalkStore, walkId?: string) {
  if (walkId !== undefined) await store.get(walkId);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const on = (ev: string) => walkId === undefined
    ? (walk: string, data: unknown) => send(ev, { walk, data })
    : (id: string, payload: unknown) => { if (id === walkId) send(ev, payload); };
  const hs: Record<string, (id: string, payload: any) => void> = { item: on("item"), withdraw: on("withdraw"), close: on("close"), delivered: on("delivered") };
  // The walk header itself, not a payload about a walk the client already
  // holds — so it is the one frame whose shape is `{walk: <Walk>}`.
  if (walkId === undefined) hs.open = (_id: string, walk: unknown) => send("open", { walk });
  for (const [ev, h] of Object.entries(hs)) store.on(ev, h);
  const ping = setInterval(() => send("ping", Date.now()), 15000);
  send("ping", Date.now());
  req.on("close", () => { clearInterval(ping); for (const [ev, h] of Object.entries(hs)) store.off(ev, h); });
}
