import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { readState, readToken, tokenFromEnv, defaultStateDir, defaultDataDir } from "sidewalk-walkd";
import type { Item, ItemInput, Verdict, Walk, WalkInput } from "sidewalk-walkd/schema";

export class DaemonClient {
  /** walk id -> project. A walk's project never changes, and shotPath is the
   *  only thing that needs it, so walk_wait no longer re-reads the whole walk
   *  on every wait just to learn it. */
  private projects = new Map<string, string>();
  /**
   * The daemon's token, kept across restarts (secrets review). Read off the
   * file in the daemon's own data dir on connect, never held anywhere else, and
   * sent on every call. Undefined is for a daemon that wants none — the embedded
   * servers the unit tests build.
   */
  constructor(private baseUrl: string, private dataDir: string = defaultDataDir(), private token?: string) {}

  /**
   * `opts.spawn` is the seam the test uses instead of starting a real daemon;
   * nothing in the product passes it.
   */
  static async connect(opts: { stateDir?: string; autoStart?: boolean; spawn?: typeof spawn } = {}): Promise<DaemonClient> {
    const stateDir = opts.stateDir ?? defaultStateDir();
    const healthy = async () => { const s = await readState(stateDir); if (!s) return null;
      try { const h = await (await fetch(`http://127.0.0.1:${s.port}/health`)).json(); return h.ok ? s : null; } catch { return null; } };
    let s = await healthy();
    if (!s && opts.autoStart !== false) {
      const bin = path.join(path.dirname(createRequire(import.meta.url).resolve("sidewalk-walkd/package.json")), "bin", "walkd.js");
      // `--no-copy`, always: this daemon is started behind the person's back,
      // with `stdio: "ignore"`, so a token it mints must not take their
      // clipboard when nothing anywhere could say that it did. The pane's own
      // needs-token notice offers `npx -y sidewalk-walkd token --copy`, which reaches the
      // same clipboard with the person asking for it.
      const child = (opts.spawn ?? spawn)(process.execPath, [bin, "serve", "--state-dir", stateDir, "--no-copy"], { detached: true, stdio: "ignore" });
      child.unref();
      for (let i = 0; i < 50 && !s; i++) { await new Promise(r => setTimeout(r, 100)); s = await healthy(); }
    }
    if (!s) throw new Error("walkd is not running and could not be started (run `walkd serve`)");
    // The token, from the daemon's own data dir — the state file is where that
    // dir is named, and this process is on the same machine by design. It is
    // read on every connect, never cached between runs: the daemon keeps its
    // token across restarts, but `walkd token --rotate` replaces it, and a
    // daemon on another data dir has another. WALKD_TOKEN wins for a setup where this process
    // cannot see that folder at all; `readToken` throws with the path, which is
    // the only thing the person can act on, and a client with no token would
    // 401 on its first tool call with no explanation.
    const token = tokenFromEnv() ?? await readToken(s.dataDir);
    return new DaemonClient(`http://127.0.0.1:${s.port}`, s.dataDir, token);
  }

  private async call<T>(method: "GET" | "POST", p: string, body?: unknown): Promise<T> {
    let res = await this.send(method, p, body);
    // A 401 after a connect that worked is a daemon serving a token this
    // process does not have — a rotate, or a token file it could not vouch for
    // and replaced — and the file in its data dir has it. This process
    // outlives daemons on purpose — it is the thing that starts them — so it
    // re-reads the file once and tries again, rather than handing the agent a
    // dead tool for the rest of the session. A token pinned by WALKD_TOKEN is
    // not re-read: the environment is the authority there, and a 401 against it
    // is a real disagreement the person has to see.
    if (res.status === 401 && tokenFromEnv() === undefined) {
      const fresh = await readToken(this.dataDir).catch(() => undefined);
      if (fresh !== undefined && fresh !== this.token) {
        this.token = fresh;
        res = await this.send(method, p, body);
      }
    }
    const data = await res.json();
    if (!res.ok) throw new Error(`walkd ${res.status}: ${data.error ?? "error"}`);
    return data as T;
  }

  private send(method: "GET" | "POST", p: string, body?: unknown): Promise<Response> {
    return fetch(this.baseUrl + p, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  async open(input: WalkInput) { const w = await this.call<Walk>("POST", "/walks", input); this.projects.set(w.id, w.project); return w; }
  addItems(walk: string, items: ItemInput[]) { return this.call<Item[]>("POST", `/walks/${walk}/items`, { items }); }
  withdraw(walk: string, itemId: string, reason: string) { return this.call<Item>("POST", `/walks/${walk}/items/${encodeURIComponent(itemId)}/withdraw`, { reason }); }
  async wait(walk: string, after: number, timeoutMs: number) {
    // The wait names the walk's project, so `projectOf` below has it without
    // reading the walk (found in review). It is kept here rather than
    // passed on: the caller's shape does not change, and a daemon older than this
    // client sends no such field, which leaves the fallback read to do the work.
    const { project, ...r } = await this.call<{ verdicts: Verdict[]; cursor: number; closed: boolean; project?: string }>("GET", `/walks/${walk}/wait?after=${after}&timeoutMs=${timeoutMs}`);
    if (typeof project === "string") this.projects.set(walk, project);
    return r;
  }
  async read(walk: string, after = 0) {
    const r = await this.call<{ walk: Walk; items: Item[]; verdicts: Verdict[]; cursor: number }>("GET", `/walks/${walk}?after=${after}`);
    this.projects.set(r.walk.id, r.walk.project);
    return r;
  }
  close(walk: string, summary: string) { return this.call<Walk>("POST", `/walks/${walk}/close`, { summary }); }
  /**
   * The walk's project, for the screenshot path. Cached from `open`, from `read`,
   * and now from every `wait`, which is the path a resumed session takes.
   *
   * The fallback is an ordinary read from the start of the walk. It used to read
   * from `Number.MAX_SAFE_INTEGER` — a cursor past the end, meant to ask for no
   * verdicts — and the daemon took that cursor as "the agent holds everything up
   * to here", which killed the person's free Undo for the rest of the walk (audit
   * 2026-10-06, SW-3). The daemon clamps that now; this does not ask for it.
   */
  async projectOf(walk: string): Promise<string> {
    const cached = this.projects.get(walk);
    if (cached) return cached;
    return (await this.read(walk)).walk.project;
  }
  shotPath(walk: { project: string; id: string }, v: Verdict): string | null { return v.context.screenshot ? path.join(this.dataDir, walk.project, walk.id, v.context.screenshot) : null; }
}
