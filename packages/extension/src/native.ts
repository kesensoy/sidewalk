import { parseToken } from "./port.js";

/**
 * Asking walkd for its own token through the browser, instead of asking the
 * person to paste it.
 *
 * walkd keeps its token in a file (`MANUAL.md` §2) and an extension cannot read
 * files, so until now the person carried it across themselves. Native messaging
 * is the one channel out of an extension that is not loopback TCP: the browser
 * resolves a manifest from a directory only this OS user can write, launches the
 * program that manifest names, and tells that program which extension is
 * calling — so it refuses every extension but the one the manifest lists. A
 * request arriving on 127.0.0.1 can never prove that much, which is why the
 * token exists at all.
 *
 * The daemon's half shipped first: every `walkd serve` writes the host, the
 * wrapper and one manifest per browser installed for this user. This is the
 * other half. One message out, one answer back, and the answer is only taken
 * when it is about the daemon this pane is pointed at.
 *
 * Everything here is measured, on this machine, 2026-10-12 (the verification
 * report behind this release):
 *
 * - `chrome.runtime.sendNativeMessage` **does not exist** until the permission
 *   is held — it is not a function that throws, it is `undefined`. So the one
 *   test before the call is a feature detection, never a try/catch.
 * - The browser re-reads the manifest on **every** call. Nothing has to be
 *   restarted after walkd writes one; a pane that failed a minute ago succeeds
 *   the moment the file is there.
 * - Four different mistakes — no manifest, a `path` that does not exist, a
 *   relative `path`, a host name nobody registered — all report the same
 *   sentence. Nothing here can tell them apart, and the panel says the same
 *   line for all of them rather than guessing.
 */

/** The host's name, as walkd spells it in every manifest it writes. */
export const HOST_NAME = "sh.sidewalk.walkd";
/** The one message the host understands. It reads nothing else off the frame. */
export const ASK = { t: "token" } as const;
/**
 * The permission the host is behind, asked for only when the person presses
 * Connect.
 *
 * Optional, not required: Chrome disables an extension whose update adds a
 * warning permission until the person accepts it, which would take the pane
 * away from everybody who already has it. The cost is one press per profile,
 * and the paste is still there for a browser that cannot do it at all.
 */
export const NATIVE_PERMISSION = "nativeMessaging";

/**
 * How long the host has to answer.
 *
 * It is a program that reads two small files and exits, so this is not a
 * budget — it is the bound on a pane that would otherwise sit on "Asking
 * walkd…" for as long as it is open, if a wrapper ever hung instead of
 * failing.
 */
export const ASK_TIMEOUT_MS = 5_000;

/**
 * Why no token came back.
 *
 * The browser's own refusals all end in the same sentence on the pane — the
 * token is pasted instead — and the console is where the word itself goes. The
 * last three are not the browser's at all: they are `adopt` (below) dropping an
 * answer the pane cannot use, and `refusedToken` is the one of those the person
 * is told about, because the way out of it is a walkd restart.
 */
export type AskReason =
  | "noApi"        // the permission is not held: there is no function to call
  | "noHost"       // no manifest, or one naming a program that is not there
  | "forbidden"    // a manifest that does not list this extension
  | "hostExited"   // the wrapper ran and died — a node that moved, most likely
  | "timeout"      // it never answered
  | "hostRefused"  // it answered, and said why it had nothing to give
  | "wrongPort"    // it answered about another daemon than the one we are on
  // The three below are `adopt`'s, not the browser's: a good answer that is
  // still the wrong one to store.
  | "refusedToken" // what it gave is the token this daemon is already refusing
  | "superseded"   // the pane is in with a token of its own now
  | "unknown";     // an answer, or an error, in a shape nothing here knows

export type Asked = { ok: true; port: number; token: string } | { ok: false; reason: AskReason; said?: string };

/**
 * The browser's own words, as one of the reasons above.
 *
 * Substrings rather than whole sentences, because the two browsers do not say
 * the same words. On Firefox a host that is not on disk and a host whose
 * manifest does not list this add-on both throw `No such native application
 * sh.sidewalk.walkd` — "forbidden" has no separate wording there, so it
 * collapses into `noHost`. It costs nothing: the pane says one line for every
 * reason here, and only the console sees which. Anything unrecognised is
 * `unknown`, which the person is shown exactly as the known ones are.
 */
export function reasonOf(said: string | undefined): AskReason {
  const s = (said ?? "").toLowerCase();
  if (!s) return "unknown";
  if (s.includes("forbidden")) return "forbidden";                                  // Chromium: "Access to the specified native messaging host is forbidden."
  if (s.includes("not found") || s.includes("no such native")) return "noHost";      // Chromium: "Specified native messaging host not found."
  if (s.includes("exited") || s.includes("failed to start")) return "hostExited";    // Chromium: "Native host has exited."
  return "unknown";
}

/** Whatever the browser threw, as a sentence, off the runtime that threw it. */
function said(e: unknown, runtime: { lastError?: { message?: string } }): string | undefined {
  const m = (e as { message?: unknown } | null)?.message;
  if (typeof m === "string" && m) return m;
  // The callback form's channel for the same text. Read as a fallback because
  // the promise form is what is called below, and a browser that rejects with
  // something that is not an Error still sets this. Off the same object the call
  // was made on: a frame's runtime has its own `lastError`, and the parent's
  // would be about something else entirely.
  const last = runtime.lastError?.message;
  return typeof last === "string" && last ? last : undefined;
}

/** Is the optional permission held? False, never a throw, when it cannot be asked. */
export async function hasNativePermission(): Promise<boolean> {
  try {
    return (await chrome.permissions.contains({ permissions: [NATIVE_PERMISSION] })) === true;
  } catch {
    // A browser with no `chrome.permissions` at all is a browser that cannot do
    // this; the pane's own answer is the paste either way.
    return false;
  }
}

/**
 * Ask the host for the token of the daemon on `port`.
 *
 * `port` is not decoration and it is not a hint: the answer is **dropped**
 * unless it is about that exact daemon. One host serves the whole machine and
 * it answers about whichever walkd owns the registration — which on this
 * machine is the one on 8760 — so an e2e pane on 8761 or a Firefox check on
 * 8764 asking this question must never adopt a token minted for somebody
 * else's daemon. It would be sent to a daemon that never issued it, refused,
 * and the person would be told to paste a token the pane had already quietly
 * replaced.
 *
 * `runtime` is which `chrome.runtime` to ask through, and it is this context's
 * own unless a caller hands over another: a panel older than the permission
 * grant has no method on its own and borrows one from a frame it makes
 * (`freshRuntime`). Everything else about the call is the same.
 */
export async function askHost(port: number, timeoutMs = ASK_TIMEOUT_MS, runtime: typeof chrome.runtime = chrome.runtime): Promise<Asked> {
  // Not `try { runtime.sendNativeMessage(...) } catch`: without the permission
  // the function is not there at all (measured), so the absence is the
  // question, and asking it costs nothing.
  const send = (runtime as { sendNativeMessage?: (host: string, message: unknown) => Promise<unknown> }).sendNativeMessage;
  if (typeof send !== "function") return { ok: false, reason: "noApi" };

  let timer: ReturnType<typeof setTimeout> | undefined;
  type Settled = { reply: unknown } | { failed: unknown } | { late: true };
  const settled = await Promise.race<Settled>([
    (async () => {
      try { return { reply: await send.call(runtime, HOST_NAME, ASK) }; }
      catch (e) { return { failed: e }; }
    })(),
    new Promise<Settled>(r => { timer = setTimeout(() => r({ late: true }), timeoutMs); }),
  ]);
  clearTimeout(timer);

  if ("late" in settled) return { ok: false, reason: "timeout" };
  if ("failed" in settled) {
    const words = said(settled.failed, runtime);
    return { ok: false, reason: reasonOf(words), said: words };
  }
  const r = settled.reply as { ok?: unknown; port?: unknown; token?: unknown; reason?: unknown } | null | undefined;
  if (!r || typeof r !== "object") return { ok: false, reason: "unknown" };
  // The host says why it has nothing — no walkd running, a state file it could
  // not read — in its own words. They go to the console; the pane's line about
  // all of this is one line.
  if (r.ok !== true) return { ok: false, reason: "hostRefused", said: typeof r.reason === "string" ? r.reason : undefined };
  const token = parseToken(r.token);
  if (!token || !Number.isInteger(r.port)) return { ok: false, reason: "unknown" };
  const answered = r.port as number;
  if (answered !== port) return { ok: false, reason: "wrongPort", said: `the host answered about walkd on ${answered}` };
  return { ok: true, port: answered, token };
}

/** What the pane holds at the moment an answer comes back. */
export type PaneNow = { port: number; token: string; needsToken: boolean };

/**
 * May this answer be stored? Three ways a good answer is still the wrong one.
 *
 * The ask is not instant — a host is a process the browser launches — so the
 * pane can have moved on by the time it answers, and the worker is the only
 * half that knows what it holds now. Kept here, apart from the worker, because
 * each of the three is a case that cost somebody a bad afternoon rather than a
 * rule anybody would guess:
 *
 * 1. **The pane moved to another daemon while the host was answering.** The
 *    token is kept under one key for the whole profile (`port.ts` says why), so
 *    storing it would hand the new daemon the old one's token.
 * 2. **A paste won the race.** Somebody put a working token in the gear while
 *    the host was being asked; overwriting it would take a connected pane out
 *    again. Only while the daemon is not refusing what they pasted — if it is,
 *    the host's answer is exactly what is wanted.
 * 3. **The host's token is the one the daemon is already refusing.** This is
 *    `walkd token --rotate` under a running daemon: the daemon keeps serving
 *    the token it has in memory and the host reads the new one off disk, so the
 *    host hands over a token that daemon will never accept. Storing it again is
 *    not merely useless — Chromium writes no `onChanged` for a value that has
 *    not changed, so nothing would retarget, nothing would settle, and the next
 *    refusal would ask the host all over again. Ending the episode here is what
 *    makes it stop, and the pane says so: restart walkd and press Connect.
 */
export function adopt(answer: Asked, now: PaneNow): Asked {
  if (!answer.ok) return answer;
  if (answer.port !== now.port) return { ok: false, reason: "wrongPort", said: "the pane moved to another port while the host was answering" };
  if (now.token && now.token !== answer.token && !now.needsToken) return { ok: false, reason: "superseded", said: "the pane is in with a token of its own" };
  if (now.token === answer.token) return { ok: false, reason: "refusedToken", said: "the host's token is the one already refused" };
  return answer;
}

/**
 * Can the context this is running in reach the host at all?
 *
 * Measured in the owner's own Chrome on 2026-10-18, after a real grant on the
 * real store build: `chrome.permissions.contains` says true in every context,
 * while `chrome.runtime.sendNativeMessage` is **still undefined** in the service
 * worker and in the panel page that drew the button. A side panel closed and
 * opened again had the function and reached the host on its first call. So
 * Chrome hands the new API only to contexts created after the grant, and no
 * delay fixes a context that already exists.
 *
 * That is why holding the permission is not the question a press can act on.
 * The question is this one, asked per context: the panel asks it of itself and
 * reloads when the answer is no, and the worker answers it for its own context
 * so a press is never left waiting on a worker the browser has not caught up
 * with. (Firefox was measured the other way on the same day: a page that was
 * already open had the function the moment the doorhanger was accepted, so it
 * takes the direct path and never reloads.)
 */
export const canAskHere = (): boolean =>
  typeof (chrome.runtime as { sendNativeMessage?: unknown }).sendNativeMessage === "function";

/** The page the frame below loads: empty, scriptless, and not reachable by anything else. */
export const ASK_PAGE = "ask.html";

/**
 * A context the browser has caught up with, made inside this page.
 *
 * Chrome hands a newly granted permission's API only to contexts created after
 * the grant, and this page is older than it (measured 2026-10-18). A frame on
 * one of our own pages is a new context (measured 2026-10-18, Chromium 151): it
 * builds its own `chrome.runtime`, with the method, and this page may call it
 * through `contentWindow` because the frame is same-origin. Hidden, so nothing
 * is drawn; kept until the answer is in, because a frame removed mid-call
 * leaves the caller's promise hanging forever (measured).
 *
 * Why the method and not the whole permission: Chromium does push a permission
 * update into contexts that already exist — a top-level API like `chrome.idle`
 * appears in the running worker and the open page — but it does not add a method
 * back onto an API object that has already been instantiated. Every context here
 * touches `chrome.runtime` in its first tick, so its `runtime` is built without
 * `sendNativeMessage` and stays that way. A new frame builds a new one.
 */
export async function freshRuntime(doc: Document): Promise<{ runtime: typeof chrome.runtime; drop: () => void } | null> {
  const f = doc.createElement("iframe");
  f.hidden = true;
  f.setAttribute("aria-hidden", "true");
  f.tabIndex = -1;
  f.src = chrome.runtime.getURL(ASK_PAGE);
  const loaded = new Promise<void>(r => { f.onload = () => r(); f.onerror = () => r(); });
  doc.body.append(f);
  await loaded;
  const runtime = (f.contentWindow as (Window & { chrome?: { runtime?: typeof chrome.runtime } }) | null)?.chrome?.runtime;
  const drop = () => f.remove();
  if (!runtime || typeof (runtime as { sendNativeMessage?: unknown }).sendNativeMessage !== "function") { drop(); return null; }
  return { runtime, drop };
}

/** What the worker says about itself when the permission is held and the API is not there yet. */
export const STALE_WORKER = "the browser has not given this worker the API yet; it arrives after the worker restarts";

/**
 * The one thing a press leaves behind when the panel has to reload to finish it.
 *
 * `{port, at}` and nothing else: the port the press was about, so a reload that
 * lands after the person has pointed the pane somewhere else does not ask about
 * the wrong daemon, and the time, so a flag left by a press that never finished
 * cannot make a panel opened tomorrow ask the host out of nowhere. It is read
 * once and cleared whether or not it is used.
 */
export const CONNECT_FLAG = "walkd:connect-after-reload";
/** How long a press stays worth finishing. A reload is a second or two; this is room. */
export const CONNECT_FLAG_MS = 10_000;
export type Armed = { port: number; at: number };

/** The smallest piece of `chrome.storage` this needs, so a test can hand it a plain object. */
export type Area = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

/** A stored flag, if it is one and it is still fresh. */
export function armedFlag(raw: unknown, now: number): Armed | null {
  const f = raw as Partial<Armed> | undefined;
  if (!f || typeof f !== "object") return null;
  if (!Number.isInteger(f.port) || !Number.isInteger(f.at)) return null;
  if (f.at! > now + CONNECT_FLAG_MS) return null;                  // a clock that moved: not ours to act on
  if (now - f.at! > CONNECT_FLAG_MS) return null;
  return { port: f.port!, at: f.at! };
}

/** Say that the reload about to happen is the second half of a press. */
export async function armConnect(area: Area, port: number, now = Date.now()): Promise<void> {
  await area.set({ [CONNECT_FLAG]: { port, at: now } satisfies Armed });
}

/**
 * Was this panel load the second half of a press? Reads and clears in one go,
 * so a flag can never be acted on twice — and clears it even when it is too old
 * to use.
 */
export async function takeArmed(area: Area, now = Date.now()): Promise<Armed | null> {
  let raw: unknown;
  try { raw = (await area.get(CONNECT_FLAG))[CONNECT_FLAG]; } catch { return null; }
  if (raw === undefined) return null;
  await area.remove(CONNECT_FLAG).catch(() => {});
  return armedFlag(raw, now);
}
