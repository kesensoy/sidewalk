import type { Expect, Verdict, VerdictInput } from "sidewalk-walkd/schema";
import { DaemonLink, DaemonReject, isTokenRefusal, type SseEvent } from "./daemon.js";
import { VerdictQueue } from "./queue.js";
import { backoffMs, inflightBy, latest } from "./once.js";
import { reconcile } from "./reconcile.js";
import { shouldFileBlocked } from "./blocked.js";
import { matchPatterns } from "./origin.js";
import { bytesToBase64 } from "./b64.js";
import { badSelectorLine, classifyExpect, describeExpect, type ExpectResult } from "./expect.js";
import { carriesSecrets, redactContext, redactSeen } from "./redact.js";
import { replayLate } from "./late.js";
import { unseenCount } from "./replies.js";
import { DEFAULT_PORT, PORT_KEY, TOKEN_KEY, connectedKey, daemonBase, parsePort, parseToken } from "./port.js";
import { UI_KEY, shotsOf } from "./settings.js";
import { type ConsoleEntry, type GoResult, type PanelToSw, type SwState, type SwToContent, type TokenAnswer, type WalkView } from "./protocol.js";

const link = new DaemonLink(daemonBase(DEFAULT_PORT));
const storage = {
  get: async (k: string) => (await chrome.storage.local.get(k))[k],
  set: (k: string, v: unknown) => chrome.storage.local.set({ [k]: v }),
};
// The port the link is pointed at. 0 until storage has been read once, which is
// why `ready` below is awaited before the first request of any kind: connecting
// to the default port and moving afterwards would talk to somebody else's
// daemon on the way past.
let currentPort = 0;
// The token the link is sending, as the person pasted it into the gear. Empty
// until storage has been read, and empty for as long as they have not pasted one
// — in which case the daemon refuses everything but /health and the pane says so.
let currentToken = "";
// Bumped whenever the daemon's address changes, so work that started against
// the old one can tell that it no longer belongs anywhere.
let generation = 0;
const ready = (async () => {
  currentPort = parsePort(await storage.get(PORT_KEY).catch(() => undefined));
  currentToken = parseToken(await storage.get(TOKEN_KEY).catch(() => undefined));
  link.setBase(daemonBase(currentPort));
  link.setToken(currentToken);
})();
// The daemon's answer carries the verdict's real seq; the copy the pane paints
// was pushed with -1 before the post, and Undo's colour is that seq against
// the walk's `delivered` mark, so the copy is brought up to date here.
const queue = new VerdictQueue(storage, (w, v) => link.postVerdict(w, v).then(res => {
  const view = views.get(w);
  const i = view?.verdicts.findIndex(x => x.nonce === v.nonce) ?? -1;
  if (view && i >= 0) { view.verdicts[i] = { ...view.verdicts[i], seq: res.seq, at: res.at, retracts: res.retracts, quiet: res.quiet }; void broadcast(); }
}));
const views = new Map<string, WalkView>();
// Walks whose copy here is current: read while the one stream below was up, and
// kept up to date by it since. A view outlives that on purpose — when the
// daemon goes away the pane keeps showing the items and says "no walk server",
// and the clicks made meanwhile are queued (spec §2.4, "a click is never lost").
// A walk falls out of this set when the stream ends, and the next refresh
// re-reads it.
const streams = new Set<string>();
// Marked before the first await in openView, so a second refresh cannot start a
// second read of the same walk while the first is still going.
const subscribing = new Set<string>();
// Frames for a walk whose first read is still in flight, kept until the read
// is in and then replayed (late.ts). Without this a card that landed in that
// window was dropped, and the pane showed a header with no cards for good.
const late = new Map<string, SseEvent[]>();
// walk id → the match patterns its content scripts are registered for.
const registered = new Map<string, string>();
let connected = false;
/**
 * The daemon answered and refused: it wants the daemon's token, kept across
 * restarts, and this pane does not have it, or has an old one (audit
 * 2026-10-04, F1). Its own state rather than a kind of disconnection, because
 * the remedy is a paste and not a wait — and because nothing about retrying changes the answer, a 401 never
 * starts the reconnect ladder.
 */
let needsToken = false;
let daemonVersion: string | null = null;
// The free-Undo window this daemon holds a fresh verdict back for. Null until
// a daemon has said, and for one too old to say; the pane draws no drain bar
// on a ledge row without it.
let daemonGraceMs: number | null = null;
let reconnecting = false;
// Ports this worker has already written a first-answer mark for, so a
// 30-second poll does not write storage every time it succeeds.
const connectedPorts = new Set<number>();

/** The first time a daemon on this port answers, say so in storage — once. */
async function noteConnected(port: number) {
  if (connectedPorts.has(port)) return;
  connectedPorts.add(port);
  await storage.set(connectedKey(port), new Date().toISOString()).catch(() => {});
}

/**
 * The one stream to the daemon, or null when there is none.
 *
 * It used to be one per open walk, and Chrome gives one origin six connections:
 * past six open walks the worker's own streams were all six, so every health
 * check, read and verdict post queued behind them until it timed out and the
 * pane stalled. `/events` carries every walk on this one connection instead, so
 * the count does not grow with the walks. It is open whenever the daemon is
 * answering, not only while a walk is — an `open` frame on it is how a walk
 * that has just been opened reaches the pane without waiting out the 30 s alarm.
 */
let stream: AbortController | null = null;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

chrome.runtime.onInstalled.addListener(() => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }));
chrome.alarms?.create?.("walkd:poll", { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener(a => { if (a.name === "walkd:poll") void refresh(); });

// The panel holds a port open and pings it while it is on screen; that keeps
// this worker alive. Nothing is ever sent over the port.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "walkd-panel") return;
  port.onMessage.addListener(() => {});
});

/**
 * The daemon moved. Every view on screen belongs to the daemon we were talking
 * to, not the one we are about to talk to, so they all go; the refresh that
 * follows builds the pane again out of what the new one says is open.
 */
async function retarget() {
  await ready;
  const port = parsePort(await storage.get(PORT_KEY).catch(() => undefined));
  const token = parseToken(await storage.get(TOKEN_KEY).catch(() => undefined));
  if (port === currentPort && token === currentToken) return;
  // A new token for the same daemon is not a new daemon: the views on screen
  // are still its walks, so they stay and the refresh below brings them up to
  // date. This is the path a paste into the gear takes, and the one a daemon
  // that restarted with a fresh token takes once the person pastes the new one.
  const moved = port !== currentPort;
  currentPort = port;
  currentToken = token;
  link.setToken(token);
  needsToken = false;                                     // what this answers is worth a fresh try
  if (!moved) {
    abortStream();                                        // the old stream carries the old token
    await refresh();
    return;
  }
  generation++;
  link.setBase(daemonBase(port));
  // The stream belongs to the daemon we are leaving; the refresh below opens a
  // new one against the new base.
  abortStream();
  for (const id of [...views.keys()]) await forgetView(id);
  connected = false;
  daemonVersion = null;                                   // the new daemon has not said yet
  daemonGraceMs = null;                                   // nor what its free-Undo window is
  await refresh();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (PORT_KEY in changes || TOKEN_KEY in changes)) void retarget();
});

/**
 * What the daemon on this port makes of the token the gear has just stored.
 *
 * The owner, 2026-10-06: "i had copied something else and noticed when i saved my
 * wrong token it just says saved in green like no actual connection check /
 * rejection". The pane cannot know — only this worker talks to the daemon — so
 * the gear asks, and waits for this.
 *
 * Nothing new happens here. The storage write the pane made has already set
 * `retarget` going; this takes the same path, and the second of the two reads
 * finds nothing to move and returns. What this adds is an answer addressed to
 * the asker: `latest` guarantees the refresh awaited below *started* after the
 * ask, so what it found is about the token in storage now and never the one from
 * before the paste. The three it can answer are the three the pane's connection
 * line already distinguishes — in, refused, or nothing there.
 */
async function checkToken(): Promise<TokenAnswer> {
  await retarget();
  await refresh();
  return { check: connected ? "connected" : needsToken ? "refused" : "noDaemon", port: currentPort || DEFAULT_PORT };
}

// `latest`, not `inflight`: the pane says hello the moment it opens and then
// waits on the answer, so it must not be handed a refresh that started before
// it asked — the walk opened in between would be missing until the next alarm.
const refresh = latest(refreshNow);

async function refreshNow() {
  await ready;
  // Which daemon this refresh is about. A refresh that was in flight when the
  // port moved is carrying the old daemon's list of open walks, and reconcile
  // would read that list as "every walk the new daemon just gave us is gone"
  // and drop them all — leaving an empty pane until the next alarm.
  const gen = generation;
  // The token this refresh is using. A 401 is only news while it is still the
  // one we hold: a paste into the gear lands mid-refresh often enough (it is
  // what the person does the moment the pane asks), and the old token's refusal
  // must not paint "needs the token" over the new one's refresh.
  const tok = currentToken;
  const h = await link.health();
  if (gen !== generation) return;
  const ok = h !== null;
  connected = ok;
  // A refresh that gets this far is about to find out whether the token is
  // right; the last answer is not evidence about this one.
  needsToken = false;
  if (h) { daemonVersion = h.version; daemonGraceMs = h.graceMs; await noteConnected(currentPort); }
  if (ok) {
    // Before the reads below, not after: the stream is what keeps every view
    // this refresh builds up to date, and a walk opened between the read and
    // the subscribe would otherwise be missed until the next alarm.
    ensureStream(gen);
    try {
      const walks = await link.walks();
      if (gen !== generation) return;
      console.debug(`walkd: refresh port=${currentPort} gen=${gen} stream=${stream ? "up" : "down"} open=[${walks.map(w => w.id).join(",")}] views=[${[...views.keys()].join(",")}] current=[${[...streams, ...subscribing].join(",")}]`);
      await reconcile(
        // `open` carries this refresh's generation: the list it opens from came
        // from this daemon, and a port move between listing and opening must
        // not read one daemon's walk out of another.
        { flush: () => queue.flush(), drop: dropView, unregister: unregisterScripts, open: id => openView(id, gen) },
        walks.map(w => w.id),
        { views: [...views.keys()], registered: [...registered.keys()], streaming: [...streams, ...subscribing] },
      );
    } catch (e) {
      // A daemon that refused the token is not a daemon that went away: it is
      // right there and it wants something the person has to paste. Saying it
      // needs the token, and leaving the ladder alone, is the whole difference —
      // a retry cannot change the answer, and the next paste into the gear
      // retargets at once.
      if (isTokenRefusal(e)) {
        console.warn("walkd: refused — the daemon wants its token", e);
        if (tok === currentToken) { needsToken = true; connected = false; }
      } else {
        // The daemon went away between the health check and the read; the pane
        // says so and the reconnect ladder takes it from here.
        console.warn("walkd: refresh failed", e);
        connected = false;
        void reconnect();
      }
    }
  }
  await broadcast();
}

/**
 * Read one walk onto the pane and register its content scripts. Nothing here
 * opens a connection that stays open: the one stream (`ensureStream`) is
 * already carrying this walk's events, and everything after this read arrives
 * on it.
 *
 * `gen` is the generation of the refresh that listed this walk. The e2e's
 * launch flake (2026-09-17, caught by the worker console): the first refresh
 * listed walks from the default port, the port moved, and the open for one of
 * those walks captured the *new* generation here — so it passed the check
 * below while its read went to the new daemon, which had never heard of the
 * walk. The 404 body became a view with no items, and every refresh after it
 * died dropping that view before it could open the walk that was real.
 */
async function openView(id: string, gen = generation) {
  if (streams.has(id) || subscribing.has(id)) return;
  if (gen !== generation) return;                                    // listed by a daemon we have left
  const tok = currentToken;                                          // a 401 is news only while this is still ours
  subscribing.add(id);
  late.set(id, []);
  let r;
  try {
    r = await link.read(id);
  } catch (e) {
    subscribing.delete(id);
    late.delete(id);
    // A daemon that answered and said no (a walk it does not have) is not a
    // daemon that went away; only silence starts the reconnect ladder.
    if (e instanceof DaemonReject) {
      // Except a 401, which is about this pane and not about this walk: the
      // token moved under us mid-refresh. The line has to change, so broadcast.
      if (isTokenRefusal(e) && tok === currentToken) { needsToken = true; connected = false; void broadcast(); }
      return;
    }
    connected = false;
    void reconnect();
    return;
  }
  const lastSeenSeq = views.get(id)?.lastSeenSeq ?? ((await storage.get(`walkd:seen:${id}`)) as number) ?? 0;
  if (gen !== generation) { subscribing.delete(id); late.delete(id); return; }       // the daemon moved under us
  const view: WalkView = { walk: r.walk, items: r.items, verdicts: r.verdicts, lastSeenSeq, current: views.get(id)?.current, cleared: views.get(id)?.cleared };
  // What the stream said about this walk while the read was out, on top of
  // what the read brought back; only the part the read did not already have.
  const replayed = replayLate(view, late.get(id) ?? []);
  late.delete(id);
  views.set(id, view);
  streams.add(id);
  subscribing.delete(id);
  if (replayed.closed) { streams.delete(id); void unregisterScripts(id); }
  await syncScripts(id);
  void broadcast();
}

/** Open the one stream if there is not one already. Cheap to call on every refresh. */
function ensureStream(gen: number) {
  if (stream || gen !== generation) return;
  const ac = new AbortController();
  stream = ac;
  link.subscribeAll(e => onStreamEvent(e, gen), ac.signal).then(() => endStream(ac), e => endStream(ac, e));
  // Nothing read while there was no stream is current: a walk read in the gap
  // between the old stream breaking and this one's fetch going out would keep
  // whatever it missed in between. The reads in the refresh that called this
  // one happen after the fetch above, so they are covered.
  streams.clear();
}

/**
 * One frame off the one stream, put on the walk it names.
 *
 * A frame for a walk with no view is not a mistake: `open` is exactly that, and
 * it is how a walk that was opened while the pane was up reaches the pane at
 * once rather than on the next alarm. It goes through `refresh` so a new walk
 * takes the same path as one found by polling — queue flushed first, views that
 * went away dropped, generation checked — instead of a second way in.
 */
function onStreamEvent(e: SseEvent, gen: number) {
  if (gen !== generation) return;                                    // a daemon we have left
  // A walk whose first read is out: keep the frame for `openView` to replay
  // once the read is in, so nothing that landed meanwhile is lost.
  const held = late.get(e.walk);
  if (held && subscribing.has(e.walk)) { held.push(e); return; }
  // `streams`, not `views`: a closed walk leaves `streams` (just below) but
  // stays on screen, so holding a view is not proof this frame is about the
  // walk that view holds — the same id opened again under another project would
  // paint the fresh header onto the closed walk's items and the "this walk is
  // closed" line would vanish. `streams` is `openView`'s own early-return
  // condition, so the header is taken off the frame for exactly the walks a
  // refresh would decline to re-read, and every other `open` goes through
  // `refresh` as it always did.
  if (e.event === "open" && !streams.has(e.walk)) { void refresh(); return; }
  const v = views.get(e.walk);
  if (!v) return;                                                    // not a walk on this pane
  if (e.event === "item") { v.items.push(e.data); void syncScripts(e.walk); }
  if (e.event === "withdraw") { const i = v.items.findIndex(x => x.id === e.data.id); if (i >= 0) v.items[i] = e.data; }
  if (e.event === "close") { v.walk = e.data; streams.delete(e.walk); void unregisterScripts(e.walk); }
  if (e.event === "delivered") v.walk = e.data;                      // an agent read: Undo turns from free to loud
  // A reopen of a walk this worker is streaming: the header came again because
  // it changed — a reopen with a new brief replaces the old one. `refresh`
  // re-reads nothing that is already streaming (`openView` returns early), so
  // the frame itself is the only thing that repaints this one.
  if (e.event === "open") v.walk = e.data;
  void broadcast();
}

/** Stop the one stream on purpose. Its fetch rejects; nothing is wrong. */
function abortStream() {
  const ac = stream;
  if (!ac) return;
  stream = null;
  streams.clear();
  ac.abort();
}

/**
 * The stream ended or broke. Every view stays on screen — the human is mid-walk
 * and their clicks queue — but none of them is current any more, so they all
 * fall out of `streams` and the next successful refresh re-reads them and
 * subscribes again.
 */
function endStream(ac: AbortController, e?: unknown) {
  if (stream !== ac) return;                                         // already replaced or aborted
  stream = null;
  streams.clear();
  // We ended it: a daemon we walked away from is not a daemon that went away.
  // Saying so would flash "no walk server" across a pane whose daemon is right
  // there, and start a reconnect ladder against nothing.
  if (ac.signal.aborted) { void broadcast(); return; }
  connected = false;
  // The daemon refused the token: the ladder cannot help, and the pane has to
  // say what it wants instead of looking for a daemon that is answering.
  if (isTokenRefusal(e)) { needsToken = true; void broadcast(); return; }
  void broadcast();
  void reconnect();
}

/**
 * The walk is gone from `/walks`, which lists open walks only — so "gone"
 * covers two different things, and they do not deserve the same treatment.
 *
 * A walk we watched close is one the human may be in the middle of. Erasing
 * its cards the instant the agent closes it takes the note they were typing
 * with it, and hides the refusal their next click earns: a verdict on a closed
 * walk is exactly the 400 that `walkd:dead` and the card's "Answer this one
 * again" line exist for (README §4), and neither can be seen on a card that is
 * no longer on screen. So a closed walk stays, answerable, until this worker
 * goes away — which it does as soon as the pane is closed.
 *
 * A walk that vanished for any other reason is forgotten.
 */
async function dropView(id: string) {
  if (views.get(id)?.walk?.closedAt) {
    streams.delete(id);
    subscribing.delete(id);
    await unregisterScripts(id);
    return;
  }
  await forgetView(id);
}

/** Take a walk off the pane outright: the daemon that owned it is not ours. */
async function forgetView(id: string) {
  views.delete(id);
  streams.delete(id);
  subscribing.delete(id);
  await unregisterScripts(id);
}

async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  try {
    for (let attempt = 0; ; attempt++) {
      await sleep(backoffMs(attempt));
      if (await link.health()) { await refresh(); return; }
      connected = false;
      await broadcast();
    }
  } finally {
    reconnecting = false;
  }
}

/**
 * The page's console lives in the page's own world, and a load-time error is
 * over before anything can be injected on demand — so both halves of the
 * capture are registered at document_start for as long as the walk is open,
 * scoped to the hosts its look items point at and nothing else (hosts, not
 * origins: a match pattern carries no port — `origin.ts`).
 */
function walkPatterns(v: WalkView): string[] {
  return matchPatterns(v.items.flatMap(i => (i.kind === "look" || i.kind === "sequence" ? [i.url] : [])));
}

async function syncScriptsFor(id: string) {
  const v = views.get(id);
  if (!v) return;
  const matches = walkPatterns(v);
  if (!matches.length) return;                        // no look items yet: nothing to scope to
  const key = matches.join(" ");
  if (registered.get(id) === key) return;             // same patterns: the registration stands
  await unregisterScripts(id);
  try {
    await chrome.scripting.registerContentScripts([
      { id: `walkd-main-${id}`, matches, js: ["main.js"], world: "MAIN", runAt: "document_start", allFrames: false, persistAcrossSessions: false },
      { id: `walkd-iso-${id}`, matches, js: ["content.js"], runAt: "document_start", allFrames: false, persistAcrossSessions: false },
    ]);
    registered.set(id, key);
  } catch (e) {
    // Without a registration the on-demand injection in ask() still answers
    // expect/highlight/console for the tab in front of the human — only the
    // load-time lines, which happen before any injection, are lost.
    console.warn("walkd: content script registration refused", matches, e);
  }
}

// Registration is unregister-then-register, so two syncs for one walk can race
// each other into a walk with no scripts at all. One at a time, per walk.
const syncScripts = inflightBy(syncScriptsFor);

async function unregisterScripts(id: string) {
  registered.delete(id);
  const ids = [`walkd-main-${id}`, `walkd-iso-${id}`];
  try {
    const have = new Set((await chrome.scripting.getRegisteredContentScripts()).map(s => s.id));
    const drop = ids.filter(i => have.has(i));
    if (drop.length) await chrome.scripting.unregisterContentScripts({ ids: drop });
  } catch (e) {
    console.warn("walkd: content script unregister failed", e);
  }
}

function state(): SwState {
  const walks = [...views.values()];
  // A closed walk keeps its cards (see dropView) but can never want attention:
  // nothing more is coming, so it must not raise the badge.
  // `unseenCount` is cards, not items: an answer to an ask is not a card of its
  // own (replies.ts), so what it raises the badge for is the card it landed on.
  const unseen = walks.filter(v => !v.walk.closedAt).reduce((n, v) => n + unseenCount(v), 0);
  chrome.action.setBadgeText({ text: unseen ? String(unseen) : "" });
  // The pane's connection line names the port it is connected to, or looking
  // for; the worker is the only half that knows which one that is.
  // `graceMs` only when a daemon has said one: the pane treats "absent" as
  // "draw no drain bar", which is the right answer for a daemon too old to say.
  return { connected, needsToken, port: currentPort || DEFAULT_PORT, daemonVersion, graceMs: daemonGraceMs ?? undefined, walks, queued: 0, dead: 0, refused: [] };
}

/**
 * The cards and the badge, plus what the queue knows — which lives in storage,
 * so it cannot be read on the synchronous path. A buried verdict never reaches
 * the agent, so the pane has to say so; `refused` is what puts the card back in
 * front of the human.
 */
async function fullState(): Promise<SwState> {
  const s = state();
  const dead = await queue.dead();
  s.queued = await queue.size();
  s.dead = dead.length;
  s.refused = dead.map(d => ({ itemId: d.verdict.itemId, error: d.error }));
  const port = s.port ?? DEFAULT_PORT;
  s.everConnected = connectedPorts.has(port) || Boolean(await storage.get(connectedKey(port)).catch(() => undefined));
  return s;
}

async function broadcast() {
  chrome.runtime.sendMessage({ t: "sw:state", state: await fullState() }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg: PanelToSw, _sender, reply) => {
  (async () => {
    try {
      if (msg.t === "panel:hello") { await refresh(); reply(await fullState()); return; }
      if (msg.t === "panel:seen") {
        const v = views.get(msg.walk);
        if (v) { v.lastSeenSeq = Math.max(v.lastSeenSeq, msg.seq); await storage.set(`walkd:seen:${msg.walk}`, v.lastSeenSeq); }
        await broadcast();
        reply(true);
        return;
      }
      if (msg.t === "panel:token") { reply(await checkToken()); return; }
      if (msg.t === "panel:go") { reply(await goOnce(goKey(msg.walk, msg.itemId))); return; }
      if (msg.t === "panel:submit") { reply(await submit(msg.walk, msg.verdict)); return; }
      reply({ ok: false, error: `unknown message: ${String((msg as { t?: unknown }).t)}` });
    } catch (e) {
      // A panel waiting on a reply that never comes is a pane that looks hung.
      reply({ ok: false, error: (e as Error)?.message ?? String(e) });
    }
  })();
  return true;
});

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t;
}

async function ask<T>(tabId: number, m: SwToContent): Promise<T> {
  try {
    return await chrome.tabs.sendMessage(tabId, m);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tabId, m);
  }
}

const LOAD_TIMEOUT_MS = 15_000;
const EXPECT_POLL_MS = 250;
const EXPECT_WINDOW_MS = 3_000;

/** Resolves on load complete, on the tab being closed, or after 15 s — first wins. */
function waitForLoad(tabId: number): Promise<void> {
  return new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => { if (id === tabId && info.status === "complete") finish(); };
    const onRemoved = (id: number) => { if (id === tabId) finish(); };
    const timer = setTimeout(finish, LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

/** An app that paints after load would file a false `blocked`; give it 3 s. */
async function pollExpect(tabId: number, expect: Expect[]): Promise<ExpectResult> {
  const deadline = Date.now() + EXPECT_WINDOW_MS;
  for (;;) {
    let last: ExpectResult;
    try {
      last = await ask<ExpectResult>(tabId, { t: "content:expect", expect });
    } catch (e) {
      last = { ok: false, noAnswer: true, seen: `(no answer from the page: ${(e as Error)?.message ?? String(e)})` };
    }
    // A selector the browser refuses is not going to start parsing: no poll, and
    // no twelve more injections of content.js while nothing can change.
    if (last.ok || last.badSelector || Date.now() >= deadline) return last;
    await sleep(EXPECT_POLL_MS);
  }
}

const goKey = (walk: string, itemId: string) => `${walk} ${itemId}`;

/**
 * Presses of Go that overlap are one press.
 *
 * `go()` reads the item's verdicts to decide whether this `blocked` is news
 * (blocked.ts), and it can spend three seconds waiting for the page to satisfy
 * the item before it gets there. Three impatient presses all read that list
 * before any of them had written to it, and all three filed — which is exactly
 * the three identical `blocked` verdicts in the owner's first walk that the dedupe
 * was meant to end. A press that arrives while the same item is still being
 * checked now joins that check instead of starting a second one.
 */
const goOnce = inflightBy((key: string) => {
  const cut = key.indexOf(" ");
  return go(key.slice(0, cut), key.slice(cut + 1));
});

async function go(walk: string, itemId: string): Promise<GoResult> {
  const item = views.get(walk)?.items.find(i => i.id === itemId);
  const tab = await activeTab();
  if (!item || (item.kind !== "look" && item.kind !== "sequence") || !tab?.id) return { ok: false };
  // The card the person is on is the one they last pressed Go on — there is
  // no inherent order to a walk, which is why every card has its own Go.
  const view = views.get(walk);
  if (view && view.current !== itemId) { view.current = itemId; void broadcast(); }
  // Picking the registration up here means the page about to be loaded gets
  // both scripts at document_start, which is the only moment a load-time error
  // can be caught.
  await syncScripts(walk);
  const tabId = tab.id;
  if (tab.url !== item.url) {
    await chrome.tabs.update(tabId, { url: item.url });
    await waitForLoad(tabId);
  }
  const ex = await pollExpect(tabId, item.expect);
  // A page that never answered is a page nobody looked at — the tab is gone,
  // the load never finished, or it is a surface no content script may run on.
  // Filing `blocked` there would put a false "not ready" against the build.
  if (classifyExpect(ex) === "noAnswer") return { ok: false, noAccess: true };
  // A `css` or `url` string the browser will not take is the agent's own typo,
  // and it reaches the record the way a failed expectation does: a `blocked`
  // line, deduped like any other, carrying the browser's message. Before this it
  // was indistinguishable from a page nobody could reach (found in review).
  if (ex.badSelector) {
    const text = badSelectorLine(ex.badSelector);
    if (shouldFileBlocked(item, view?.verdicts ?? [], text, view?.cleared?.[itemId] ?? 0)) await submit(walk, { itemId, kind: "blocked", text });
    else await broadcast();
    return { ok: false, badSelector: ex.badSelector };
  }
  if (!ex.ok) {
    // On a card that carries a secret, what the page was showing leaves as its
    // length: the whole point of a `file` secret is that the agent never holds
    // the value, and a `blocked` line saying `saw "lp_live_…"` hands it over
    // (secrets review).
    const text = describeExpect(ex.failed!, item.expect, carriesSecrets(item) ? redactSeen(ex.seen) : ex.seen);
    // Pressing Go again on an item that is still not ready re-shows the card;
    // it does not add another identical line to the record.
    if (shouldFileBlocked(item, view?.verdicts ?? [], text, view?.cleared?.[itemId] ?? 0)) await submit(walk, { itemId, kind: "blocked", text });
    else await broadcast();
    return { ok: false, blocked: true };
  }
  // The page caught up: every blocked line filed so far is history now, and
  // the card stops reading "Not ready here". The record keeps the lines.
  const lastBlocked = (view?.verdicts ?? []).reduce((m, x) => (x.itemId === itemId && x.kind === "blocked" ? Math.max(m, x.seq) : m), 0);
  if (view && lastBlocked > (view.cleared?.[itemId] ?? 0)) { (view.cleared ??= {})[itemId] = lastBlocked; void broadcast(); }
  if (item.target) await ask(tabId, { t: "content:highlight", target: item.target });
  return { ok: true };
}

/**
 * The click is on disk before anything that can fail is attempted; the
 * screenshot, console tail and build id are then folded into the entry where it
 * already sits. A capture that throws costs the picture, never the verdict.
 */
async function submit(walk: string, draft: Omit<VerdictInput, "nonce" | "context">) {
  const tab = await activeTab();
  const item = views.get(walk)?.items.find(i => i.id === draft.itemId);
  const nonce = crypto.randomUUID();
  const context: VerdictInput["context"] = {
    url: tab?.url ?? "",
    viewport: [tab?.width ?? 0, tab?.height ?? 0],
    console: [],
    userAgent: navigator.userAgent,
  };
  // Answering an item clears whatever the daemon refused for it before: the
  // card stops asking, and the header's count comes down with it.
  await queue.clearDead(draft.itemId);
  await queue.enqueue(walk, { ...draft, nonce, context });
  // The in-memory copy the panel paints never carries the JPEG.
  const view = views.get(walk);
  view?.verdicts.push({ ...draft, nonce, seq: -1, at: new Date().toISOString(), context: { ...context, screenshot: null } } as unknown as Verdict);
  // Answered (or taken back), the card is no longer the one they are on; an
  // Ask leaves them on it.
  if (view && view.current === draft.itemId && draft.kind !== "ask") view.current = undefined;
  await broadcast();
  try {
    await queue.patch(nonce, await enrich(context, tab, item, draft.kind));
  } catch (e) {
    console.warn("walkd: verdict context enrichment failed", e);
  }
  await queue.flush();
  await broadcast();
  return { ok: true };
}

/**
 * Why there is no picture, when the reason is the person's own setting rather
 * than a capture that failed. It leads with `off:` so an agent reading a
 * verdict can tell the two apart without matching on Chrome's wording.
 */
const SHOTS_OFF: Record<"never" | "issues", string> = {
  never: "off: screenshots set to never",
  issues: "off: screenshots set to issues only",
};

/**
 * The person's screenshot setting, read at submit time so a change in the gear
 * lands on the next verdict with no reload. `blocked` is the pane's own
 * verdict about a page that is not ready — not an answer, and the picture is
 * most of what makes it diagnosable — so it is never turned down.
 */
async function shotsOff(kind: VerdictInput["kind"]): Promise<string | null> {
  if (kind === "blocked") return null;
  const shots = shotsOf(await storage.get(UI_KEY).catch(() => undefined));
  if (shots === "never") return SHOTS_OFF.never;
  if (shots === "issues" && kind !== "issue") return SHOTS_OFF.issues;
  return null;
}

async function enrich(base: VerdictInput["context"], tab: chrome.tabs.Tab | undefined, item: WalkView["items"][number] | undefined, kind: VerdictInput["kind"]) {
  const ctx: VerdictInput["context"] = { ...base };
  const off = await shotsOff(kind);
  // Only the picture is turned down: the console tail and the build id below
  // cost the person nothing and are what is left to read the verdict by.
  if (off) {
    ctx.screenshotError = off;
  } else {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT, { format: "jpeg", quality: 80 });
      ctx.screenshotBase64 = await downscale(dataUrl, 1568);
    } catch (e) {
      ctx.screenshotError = (e as Error)?.message ?? String(e);
    }
  }
  if (tab?.id && (item?.kind === "look" || item?.kind === "sequence")) {
    try { ctx.console = await ask<ConsoleEntry[]>(tab.id, { t: "content:console" }); } catch { /* no content script, no tail */ }
    try { ctx.buildId = (await ask<ExpectResult>(tab.id, { t: "content:expect", expect: item.expect.filter(e => e.kind === "text") })).buildId; } catch { /* likewise */ }
  }
  // A card carrying a secret reports the page's text as lengths: `buildId` is a
  // `text` expect's reading of the page on *every* verdict, pass included, and
  // the console tail is the same thing with less precision (audit F5). The
  // picture is not touched — that is the person's own setting, said plainly on
  // the card and in README §5.
  return carriesSecrets(item) ? redactContext(ctx) : ctx;
}

async function downscale(dataUrl: string, maxW: number): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  if (bmp.width <= maxW) return dataUrl.split(",")[1];
  const c = new OffscreenCanvas(maxW, Math.round(bmp.height * maxW / bmp.width));
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  const out = await c.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return bytesToBase64(new Uint8Array(await out.arrayBuffer()));
}

void refresh();
