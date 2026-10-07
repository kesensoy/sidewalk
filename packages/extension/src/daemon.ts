import type { Item, Verdict, VerdictInput, Walk } from "sidewalk-walkd/schema";

/**
 * One event off the daemon's `/events` stream, already demultiplexed: `walk` is
 * the walk it belongs to. `open` is a walk this worker may never have heard of
 * — its `data` is the walk header, which is what the daemon puts on the wire
 * for that one frame; the rest carry the payload the per-walk route always did.
 * Pings never get this far.
 */
export type SseEvent =
  | { event: "item"; walk: string; data: Item }
  | { event: "withdraw"; walk: string; data: Item }
  | { event: "close"; walk: string; data: Walk }
  | { event: "delivered"; walk: string; data: Walk }
  | { event: "open"; walk: string; data: Walk };

/**
 * The daemon answered, and said no. Carries the status so the queue can tell a
 * verdict this daemon will never accept (bury it, keep walking) from one it
 * would accept later (keep it queued, try again).
 */
/** How long a request that is not a stream may take before it is abandoned. */
export const REQUEST_TIMEOUT_MS = 10_000;

export class DaemonReject extends Error {
  readonly name = "DaemonReject";
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * The daemon is there and it wants its token: a 401, and nothing else.
 *
 * The one test every 401 branch in the worker makes, in one place, because the
 * rule they share is the whole point — a token refusal never starts the
 * reconnect ladder. Waiting changes nothing about a wrong token, and a ladder
 * climbing against a daemon that is answering fine would paint "looking for
 * walkd" over a pane whose remedy is a paste. Anything else — a 404, a 5xx, a
 * socket that went away — is not this, and takes the ladder as it always did.
 */
export const isTokenRefusal = (e: unknown): boolean => e instanceof DaemonReject && e.status === 401;

/** What a healthy daemon said about itself. `version` is null for a daemon
 *  too old to say (none shipped is), or one that said something odd.
 *  `graceMs` is the free-Undo window this daemon holds a fresh verdict back
 *  for, and null the same way — a pane that does not know it draws no drain
 *  bar rather than guessing at a window it cannot see. */
export type Health = { version: string | null; graceMs: number | null };

/**
 * The only thing in the extension that talks to walkd. Service workers have no
 * `EventSource`, so the SSE stream is parsed by hand off a streaming fetch.
 */
export class DaemonLink {
  /**
   * The daemon's token, kept across restarts, as the person pasted it into the
   * gear (secrets review). Empty until storage has been read, and empty
   * for a daemon old enough not to want one — nothing is sent and nothing
   * cares. `/health` never needs it, which is what lets a pane with the wrong
   * token still know the daemon is there and say what is wrong.
   */
  constructor(private base: string, private token = "") {}

  /** The daemon moved (a different port in storage). Everything sent after this
   *  goes to the new one; streams already open are the caller's to abort. */
  setBase(base: string): void {
    this.base = base;
  }

  /** The token changed in storage: a paste into the gear, or a rotation. */
  setToken(token: string): void {
    this.token = token;
  }

  /** The one header, on everything — the two streams included. */
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.token ? { ...extra, authorization: `Bearer ${this.token}` } : extra;
  }

  get href(): string {
    return this.base;
  }

  /**
   * The short requests answer or they give up.
   *
   * The pane awaits a reply from the worker, and the worker awaits these, so a
   * request that never settles is a pane that never paints again with nothing
   * on screen to say why. That used to happen for real: Chrome allows one
   * origin six connections, and the worker held one stream per open walk, so
   * past the sixth walk every short request waited behind them. The worker
   * holds one stream now (`subscribeAll`) and the timeout stays as the floor
   * under a daemon that accepts a connection and then says nothing.
   */
  private short(path: string): Promise<Response> {
    return fetch(this.base + path, { headers: this.headers(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  /** The daemon, if one is answering. The version rides along so the pane can
   *  say when it and the daemon are not the same release, and the grace window
   *  so it can draw how long a green Undo has left. */
  async health(): Promise<Health | null> {
    try {
      const h = (await (await this.short("/health")).json()) as { ok?: boolean; version?: unknown; graceMs?: unknown };
      if (h.ok !== true) return null;
      // A window has to be a finite, non-negative number of milliseconds to be
      // drawable; anything else is a daemon we do not understand on this point.
      const grace = typeof h.graceMs === "number" && Number.isFinite(h.graceMs) && h.graceMs >= 0 ? h.graceMs : null;
      return { version: typeof h.version === "string" ? h.version : null, graceMs: grace };
    } catch {
      return null;
    }
  }

  /**
   * A daemon that answered and said no is a rejection, never data. The e2e's
   * launch flake was a 404 body (`{error:"unknown walk"}`) from a daemon the
   * worker had just moved to, stored as a walk with no items; nothing after it
   * could drop that view, so nothing after it could open a real one.
   */
  private async okJson<T>(path: string): Promise<T> {
    const r = await this.short(path);
    if (r.status >= 400 && r.status < 500) throw new DaemonReject(r.status, `walkd ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
    if (!r.ok) throw new Error(`walkd ${r.status}`);
    return r.json() as Promise<T>;
  }

  async walks(): Promise<Walk[]> {
    const w = await this.okJson<unknown>("/walks");
    if (!Array.isArray(w)) throw new Error("walkd: /walks is not a list");
    return w as Walk[];
  }

  async read(id: string): Promise<{ walk: Walk; items: Item[]; verdicts: Verdict[]; cursor: number }> {
    // `viewer=1`: this read paints a pane; it hands nothing to an agent, so it
    // must not move the walk's `delivered` mark.
    const r = await this.okJson<{ walk?: Walk; items?: Item[]; verdicts?: Verdict[]; cursor?: number }>(`/walks/${id}?viewer=1`);
    if (!r.walk || !Array.isArray(r.items) || !Array.isArray(r.verdicts)) throw new Error(`walkd: /walks/${id} is not a walk`);
    return r as { walk: Walk; items: Item[]; verdicts: Verdict[]; cursor: number };
  }

  async postVerdict(id: string, v: VerdictInput): Promise<Verdict> {
    const r = await fetch(`${this.base}/walks/${id}/verdicts`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(v),
    });
    if (r.status >= 400 && r.status < 500) {
      throw new DaemonReject(r.status, `walkd ${r.status}: ${(await r.text().catch(() => "")).slice(0, 300)}`);
    }
    if (!r.ok) throw new Error(`walkd ${r.status}`);
    return r.json() as Promise<Verdict>;
  }

  /**
   * The one stream. `/events` carries every walk this daemon has, so the worker
   * spends one of Chrome's six connections however many walks are open — the
   * whole point of the route. Resolves when the daemon ends the stream, rejects
   * when it breaks or `signal` aborts it; either way the caller decides whether
   * that was on purpose.
   *
   * The frames are unwrapped here, so nothing above this has to know that the
   * wire says `{walk, data}` — or that `open` is the one frame that does not.
   */
  subscribeAll(onEvent: (e: SseEvent) => void, signal: AbortSignal): Promise<void> {
    return (async () => {
      const res = await fetch(`${this.base}/events`, { headers: this.headers(), signal });
      // A daemon that answered and said no is a rejection with its status, the
      // way a read's is: the worker tells a 401 (the token is wrong or the
      // daemon has restarted with a new one) from a daemon that went away, and
      // a 401 must not start the reconnect ladder — nothing about retrying
      // changes the answer.
      if (res.status >= 400 && res.status < 500) throw new DaemonReject(res.status, `walkd ${res.status} on /events: ${(await res.text().catch(() => "")).slice(0, 300)}`);
      if (!res.ok) throw new Error(`walkd ${res.status} on /events`);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /^event: (.+)$/m.exec(chunk)?.[1];
          const raw = /^data: (.+)$/m.exec(chunk)?.[1];
          if (!ev || !raw || ev === "ping") continue;            // a heartbeat is not an event
          const e = demux(ev, JSON.parse(raw));
          if (e) onEvent(e);
        }
      }
    })();
  }
}

/**
 * A frame off `/events` as the worker wants it, or null if it is not one we
 * act on. A walk id that is not a string, or an `open` with no walk header, is
 * a daemon we do not understand — dropping the frame beats poisoning a view.
 */
function demux(event: string, payload: any): SseEvent | null {
  if (event === "open") {
    const walk = payload?.walk as Walk | undefined;
    return typeof walk?.id === "string" ? { event: "open", walk: walk.id, data: walk } : null;
  }
  if (event !== "item" && event !== "withdraw" && event !== "close" && event !== "delivered") return null;
  const walk = payload?.walk;
  if (typeof walk !== "string" || payload?.data === undefined) return null;
  return { event, walk, data: payload.data } as SseEvent;
}
