import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { itemInputSchema, originAndPath, redactSaw, redacted, verdictInputSchema, walkInputSchema } from "./schema/index.js";
import type { Item, ItemInput, StoredSecret, Verdict, VerdictInput, Walk, WalkInput } from "./schema/index.js";
import { openAsks } from "./asks.js";

export class NotFound extends Error {}

/** An item seen through its secrets, whatever kind it is. A `question` never has any. */
type MaybeSecret = Item & { secrets?: StoredSecret[] };

/**
 * The copy that goes in `items.jsonl`: no `secrets` key at all, not even the
 * labels. Two reasons it is the whole key and not only the value. A label is
 * itself a description of a live credential ("prod admin password"), and a
 * card rebuilt from disk with labels but no values would show Copy buttons
 * that put nothing on the clipboard — the exact lie this feature exists to
 * stop. Dropped whole, the item simply has no secrets after a restart, and the
 * agent's instructions say to add it again.
 */
function forDisk(item: Item): Item {
  const { secrets, ...rest } = item as MaybeSecret;
  if (secrets === undefined) return item;
  // A file-backed secret keeps its label and file name on disk: the value is
  // re-read from the daemon's own secrets folder on load, so it survives a
  // restart without ever being written into the record.
  const kept = secrets.filter(s => s.file !== undefined).map(s => ({ label: s.label, file: s.file }));
  return (kept.length ? { ...rest, secrets: kept } : rest) as Item;
}

/**
 * The copy an agent is handed: the labels (and file names), never the values.
 * The agent wrote the values, so echoing them back through a tool result buys
 * nothing and puts a live credential into a transcript, a log and a context
 * window. The labels stay because their presence is the signal — an item
 * written with secrets that comes back with none is a daemon that has
 * restarted since.
 */
export function withoutSecretValues(item: Item): Item {
  const i = item as MaybeSecret;
  if (!i.secrets?.length) return item;
  return { ...i, secrets: i.secrets.map(s => (s.file !== undefined ? { label: s.label, file: s.file } : { label: s.label })) } as Item;
}

/**
 * A verdict on an item that carries secrets, with the page's own words taken out
 * of it (secrets review): a `blocked` line's `saw "…"` clause, `buildId`,
 * and every console line's text — each as its length — and the page url cut to
 * its origin and path (found in review), since a page can put what was
 * pasted into a query string or a fragment.
 *
 * The pane does this first, where the fields are read; this is the same rule
 * applied again on the way in, for a client that did not — an extension of an
 * older release, or anything else posting a verdict. `verdicts.jsonl` is
 * forever, so this is the last place the page's words can go unwritten. It is
 * idempotent: a verdict that arrives already redacted is stored as it came.
 *
 * Not the screenshot: whether the site is photographed after a paste is the
 * person's own setting, not the daemon's to decide (the audit's position).
 */
export function redactForSecrets<T extends VerdictInput>(v: T, on: Item): T {
  if (!(on as MaybeSecret).secrets?.length) return v;
  const ctx = v.context;
  return {
    ...v,
    ...(v.kind === "blocked" && v.text ? { text: redactSaw(v.text) } : {}),
    context: {
      ...ctx,
      url: originAndPath(ctx.url),
      ...(ctx.buildId === undefined ? {} : { buildId: redactedOnce(ctx.buildId) }),
      console: ctx.console.map(c => ({ ...c, text: redactedOnce(c.text) })),
    },
  };
}

/** `(redacted, N chars)` unless it already says exactly that. */
const redactedOnce = (s: string): string => (/^\(redacted, \d+ chars\)$/.test(s) ? s : redacted(s.length));

type WalkState = {
  walk: Walk; dir: string;
  items: Map<string, Item>; itemSeq: number;
  verdicts: Verdict[]; verdictSeq: number; nonces: Map<string, Verdict>;
  /** Seqs no agent read ever returns: a verdict taken back before it was handed out, and the undo that took it back. */
  hidden: Set<number>;
  waiters: Set<() => void>;
  lock: Promise<unknown>;
};

const freshState = (walk: Walk, dir: string): WalkState => ({
  walk, dir, items: new Map(), itemSeq: 0, verdicts: [], verdictSeq: 0,
  nonces: new Map(), hidden: new Set(), waiters: new Set(), lock: Promise.resolve(),
});

// Every writer runs alone. Without this a verdict's seq was handed out before
// its screenshot was written, so a small verdict could overtake a big one into
// verdicts.jsonl and wake a waiter on a cursor past a record it had not seen;
// the same window let two same-nonce replays both pass dedupe.
function withLock<T>(st: WalkState, fn: () => Promise<T>): Promise<T> {
  const result = st.lock.then(fn, fn);
  st.lock = result.then(() => {}, () => {});
  return result;
}

/**
 * The most a file-backed secret may be. A credential is tens of bytes and the
 * schema caps a `value` at 4096 characters; 64 KB is room for any key, any
 * certificate and any pasted-in block, and far short of a file worth streaming
 * into every pane on the machine.
 */
const MAX_SECRET_BYTES = 64 * 1024;

/**
 * Every folder this daemon makes is the person's own. They were created with
 * the default mode, which on this machine is `drwxr-xr-x`: on a shared box any
 * other user could read `items.jsonl`, every verdict screenshot, and anything
 * dropped in `secrets/` (secrets review). Ignored on Windows, where
 * `mode` is not a thing; a folder that already exists is left as it is.
 */
export const DIR_MODE = 0o700;

const key = (project: string, id: string) => `${project}/${id}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "walk";
const now = () => new Date().toISOString();

export class WalkStore extends EventEmitter {
  private walks = new Map<string, WalkState>();
  private loaded = false;
  // One listener per SSE client per event: the default cap of 10 warns at the
  // 11th pane. There is no leak to catch here, so lift the cap entirely.
  /**
   * `graceMs`: how long a fresh verdict stays the pane's alone before any
   * agent read can have it — the person's window for the free Undo. The
   * library default is 0 (tests, embedders); the CLI serves with 10 s.
   *
   * Readable from outside because the pane draws that window as the drain bar
   * under a ledge row and /health is where it reads it — so the number on the
   * wire is the window this store enforces, never a second copy of it.
   */
  readonly graceMs: number;
  constructor(private dataDir: string, opts: { graceMs?: number } = {}) {
    super(); this.setMaxListeners(0);
    this.graceMs = Math.max(0, opts.graceMs ?? 0);
  }

  /** Where file-backed secrets are read from: the daemon's own folder, and nowhere else. */
  get secretsDir(): string { return path.join(this.dataDir, "secrets"); }

  /**
   * Fill in the values of an item's file-backed secrets from `secrets/`. On
   * add, a file this daemon will not read is an error the agent gets back — it
   * says why and where the file goes. On load after a restart it is not: the
   * secret is simply dropped, so the card never offers a Copy that copies
   * nothing.
   *
   * What it will read is a regular file of at most 64 KB, and the stat is an
   * `lstat` so a symlink is refused rather than followed. Three things that
   * bought (secrets review): a symlink dropped in the folder pointed the
   * daemon at any file on the disk — `~/.aws/credentials` — and the bare
   * filename rule did not stop it, because the rule is about the name the agent
   * writes and not about what the name resolves to. A FIFO blocked `readFile`
   * forever *inside the walk's lock*, so every later add, verdict and close on
   * that walk hung behind it. And nothing capped the size: the whole file went
   * into the heap, into the item and onto the stream.
   */
  private async resolveSecrets<T extends ItemInput | Item>(item: T, lenient: boolean): Promise<T> {
    const list = (item as MaybeSecret).secrets;
    if (!list?.some(s => s.file !== undefined)) return item;
    const out: StoredSecret[] = [];
    for (const s of list) {
      if (s.file === undefined) { out.push(s); continue; }
      const file = path.join(this.secretsDir, s.file);
      // One shape of message whatever the reason, so the agent always learns
      // the same two things: which name it named, and the folder it lives in.
      const refuse = (why: string) => { if (!lenient) throw new Error(`secret file ${why}: ${s.file} (put it in ${this.secretsDir})`); };
      let stat;
      try { stat = await fs.lstat(file); } catch { refuse("not found"); continue; }
      if (!stat.isFile()) { refuse("is not a regular file"); continue; }
      if (stat.size > MAX_SECRET_BYTES) { refuse(`is over ${MAX_SECRET_BYTES / 1024} KB`); continue; }
      try { out.push({ label: s.label, file: s.file, value: (await fs.readFile(file, "utf8")).replace(/\r?\n$/, "") }); }
      catch { refuse("could not be read"); continue; }
    }
    return { ...item, secrets: out } as T;
  }

  /** A verdict old enough for an agent to be handed. */
  private matured(v: Verdict, now = Date.now()): boolean {
    return this.graceMs === 0 || now - Date.parse(v.at) >= this.graceMs;
  }

  /**
   * One scan of the data dir, shared by every caller. On an early walk, right after a
   * restart: the first request started the scan and a second request, arriving
   * while it was still running, saw `loaded` already true and a map with
   * walk-11 in it and walk-12 not yet — and answered 404 for a walk that was
   * on disk the whole time. Everyone now awaits the same promise.
   */
  private loading: Promise<void> | null = null;
  private loadAll(): Promise<void> {
    this.loading ??= (async () => {
      await fs.mkdir(this.dataDir, { recursive: true, mode: DIR_MODE });
      for (const project of await fs.readdir(this.dataDir)) {
        const pdir = path.join(this.dataDir, project);
        if (!(await fs.stat(pdir)).isDirectory() || project === "state" || project === "secrets") continue;
        for (const id of await fs.readdir(pdir)) {
          const dir = path.join(pdir, id);
          try { await this.loadWalk(dir); } catch { /* not a walk dir */ }
        }
      }
      this.loaded = true;
    })();
    return this.loading;
  }

  private async loadWalk(dir: string) {
    const walk = JSON.parse(await fs.readFile(path.join(dir, "walk.json"), "utf8")) as Walk;
    const st = freshState(walk, dir);
    for (const rec of await readRecords(path.join(dir, "items.jsonl")) as any[]) {
      if (rec.op === "withdraw") { const it = st.items.get(rec.id); if (it) { it.withdrawnAt = rec.at; it.withdrawReason = rec.reason; } }
      else { st.items.set(rec.id, await this.resolveSecrets(rec as Item, true)); st.itemSeq = Math.max(st.itemSeq, rec.seq); }
    }
    for (const v of await readRecords(path.join(dir, "verdicts.jsonl")) as Verdict[]) {
      st.verdicts.push(v); st.nonces.set(v.nonce, v); st.verdictSeq = Math.max(st.verdictSeq, v.seq);
      if (v.quiet && v.retracts !== undefined) { st.hidden.add(v.retracts); st.hidden.add(v.seq); }
    }
    this.walks.set(key(walk.project, walk.id), st);
  }

  // Callers (HTTP, MCP) address a walk by id alone, which open() keeps globally
  // unique among OPEN walks; a closed walk's id may be reused by another
  // project, so an open walk always wins the lookup.
  private find(walkId: string): WalkState | undefined {
    let closed: WalkState | undefined;
    for (const st of this.walks.values()) {
      if (st.walk.id !== walkId) continue;
      if (!st.walk.closedAt) return st;
      closed ??= st;
    }
    return closed;
  }

  private async state(walkId: string): Promise<WalkState> {
    await this.loadAll();
    const st = this.find(walkId);
    if (!st) throw new NotFound(`walk ${walkId} not found`);
    return st;
  }
  private assertOpen(st: WalkState) { if (st.walk.closedAt) throw new Error(`walk ${st.walk.id} is closed`); }

  async open(input: WalkInput): Promise<Walk> {
    const inp = walkInputSchema.parse(input);
    await this.loadAll();
    const id = inp.id ?? slug(inp.title);
    const existing = this.walks.get(key(inp.project, id));
    // A reopen announces itself too: a pane that missed the first `open` — it
    // was pointed elsewhere, or its stream was down — gets another chance
    // without waiting out the 30 s alarm.
    if (existing && !existing.walk.closedAt) {
      // A reopen that brings a different brief replaces it: the header is
      // walk.json, rewritten under the walk's lock the way `delivered` and
      // `closedAt` are, and the `open` frame below is what makes the pane
      // re-read it. A reopen with no brief leaves the one on the header alone.
      if (inp.brief !== undefined && inp.brief !== existing.walk.brief) {
        await withLock(existing, async () => {
          existing.walk.brief = inp.brief;
          await fs.writeFile(path.join(existing.dir, "walk.json"), JSON.stringify(existing.walk, null, 2));
        });
      }
      this.emit("open", id, existing.walk);
      return existing.walk;
    }
    const elsewhere = this.find(id);
    if (elsewhere && !elsewhere.walk.closedAt && elsewhere.walk.project !== inp.project)
      throw new Error(`walk id ${id} is open under project ${elsewhere.walk.project}`);
    if (existing) throw new Error(`walk ${id} is closed; pick a new id`);
    const dir = path.join(this.dataDir, inp.project, id);
    // The walk is not loaded. If its dir is nonetheless on disk, loading it
    // failed — creating it again here would blow away the streams it holds.
    if (await exists(path.join(dir, "walk.json"))) throw new Error(`walk dir exists but failed to load: ${dir}`);
    // Recursive, so the project and walk folders above it are made 0700 too.
    await fs.mkdir(path.join(dir, "shots"), { recursive: true, mode: DIR_MODE });
    const walk: Walk = { id, project: inp.project, title: inp.title, buildRef: inp.buildRef, openedAt: now(), ...(inp.brief !== undefined ? { brief: inp.brief } : {}) };
    await fs.writeFile(path.join(dir, "walk.json"), JSON.stringify(walk, null, 2));
    await fs.writeFile(path.join(dir, "items.jsonl"), "");
    await fs.writeFile(path.join(dir, "verdicts.jsonl"), "");
    this.walks.set(key(inp.project, id), freshState(walk, dir));
    // The one event that is not about a walk somebody is already watching: a
    // client on `/events` learns a new walk exists the moment it does, instead
    // of on its next poll of `/walks`.
    this.emit("open", id, walk);
    return walk;
  }

  async list(): Promise<Walk[]> { await this.loadAll(); return [...this.walks.values()].filter(s => !s.walk.closedAt).map(s => s.walk); }
  async get(walkId: string): Promise<Walk> { return (await this.state(walkId)).walk; }

  /**
   * A reply names an ask, or it is not a reply.
   *
   * On an early walk, through the MCP: an `info` carrying `supersedes: "w14-q1"` — a
   * question that had been withdrawn before anybody asked it — was accepted
   * without a word, so the orchestrator that sent it could believe it had
   * answered an ask that was never open. `supersedes` has one meaning on the
   * wire (`sidewalk-mcp`'s `reply` line asks for exactly this, `openAsks`
   * closes an ask on it, and the pane paints the answer inside the asked card),
   * and nothing in the tree uses it for anything else — so a `supersedes` that
   * names anything but an open ask is a mistake, and this is where it is said.
   *
   * The three refusals are the three ways it can be wrong: an id this walk does
   * not have, an item the agent withdrew, and an item nobody is asking about —
   * never asked, already answered by the person, or already answered by an
   * earlier reply of the agent's own. The message carries the walk's open asks
   * because they are the only ids that would have been accepted, and an agent
   * that got one wrong needs the list, not the rule.
   *
   * Computed once for the whole add, so two items of one add may both answer
   * the same ask — several `info` blocks on one card is what the pane draws
   * (`packages/extension/src/replies.ts`).
   */
  private assertReplies(st: WalkState, parsed: ItemInput[]) {
    const replying = parsed.filter(p => p.supersedes !== undefined);
    if (!replying.length) return;
    // Withdrawn asks are left out of the list: `openAsks` still reports an ask
    // on a card the agent later withdrew (the person did ask it), but a reply
    // to one is refused below, and a message must not name an id that would be.
    const open = openAsks([...st.items.values()], st.verdicts).filter(a => !st.items.get(a.item)?.withdrawnAt);
    const names = open.length ? `Open asks: ${open.map(a => a.item).join(", ")}.` : "This walk has no open asks.";
    const ids = new Set(open.map(a => a.item));
    for (const p of replying) {
      const sup = p.supersedes!;
      const target = st.items.get(sup);
      const why = !target ? "is not an item of this walk"
        : target.withdrawnAt ? "is withdrawn"
        : !ids.has(sup) ? "has no open ask"
        : null;
      if (why) throw new Error(`${p.id}: supersedes ${sup} ${why}. supersedes answers an open ask and nothing else, so nothing was added. ${names}`);
    }
  }

  async addItems(walkId: string, inputs: ItemInput[]): Promise<Item[]> {
    const st = await this.state(walkId);
    return withLock(st, async () => {
      this.assertOpen(st);
      const parsed = inputs.map(i => itemInputSchema.parse(i));
      const seen = new Set<string>();
      for (const p of parsed) {
        if (st.items.has(p.id) || seen.has(p.id)) throw new Error(`duplicate item id ${p.id}`);
        seen.add(p.id);
      }
      this.assertReplies(st, parsed);
      // Everything the agent sent is checked before anything is spent: the
      // schema, the ids and the replies above, and the file-backed secrets
      // here, which is the one check that has to touch the disk. On an early walk: an
      // add naming a secrets file that was not there came back as a clean 400,
      // but its first item had already taken a seq, so the walk's items ran 1–7
      // and then 9 and a refusal had cost a number that nothing would ever use.
      // A refused add now leaves the walk exactly as it was.
      const resolved: ItemInput[] = [];
      for (const p of parsed) resolved.push(await this.resolveSecrets(p, false));
      // Nothing below this line may throw on what the agent sent.
      const out: Item[] = [];
      for (const r of resolved) {
        const item = { ...r, seq: ++st.itemSeq, addedAt: now() } as Item;
        // The values go no further than this process's heap: the stream gets
        // the item without them, the map keeps the one with them, and the
        // `item` event carries that one because the pane is the whole point.
        await fs.appendFile(path.join(st.dir, "items.jsonl"), JSON.stringify(forDisk(item)) + "\n");
        st.items.set(item.id, item); out.push(withoutSecretValues(item)); this.emit("item", walkId, item);
      }
      return out;
    });
  }

  async withdraw(walkId: string, itemId: string, reason: string): Promise<Item> {
    const st = await this.state(walkId);
    return withLock(st, async () => {
      this.assertOpen(st);
      const it = st.items.get(itemId); if (!it) throw new NotFound(`item ${itemId} not found`);
      const at = now();
      await fs.appendFile(path.join(st.dir, "items.jsonl"), JSON.stringify({ op: "withdraw", id: itemId, reason, at }) + "\n");
      it.withdrawnAt = at; it.withdrawReason = reason; this.emit("withdraw", walkId, it);
      // The pane's SSE frame above keeps the values (it is still the same card
      // on screen); the answer to the agent that asked does not.
      return withoutSecretValues(it);
    });
  }

  async addVerdict(walkId: string, input: VerdictInput): Promise<Verdict> {
    const st = await this.state(walkId);
    return withLock(st, async () => {
      this.assertOpen(st);
      const parsed = verdictInputSchema.parse(input);
      const dup = st.nonces.get(parsed.nonce); if (dup) return dup;
      const on = st.items.get(parsed.itemId);
      if (!on) throw new Error(`unknown item ${parsed.itemId}`);
      // The daemon's half of the redaction (secrets review). The pane redacts the page
      // text a secret-bearing card's verdict would carry back — what a failed
      // expectation saw, `buildId`, the console tail — and this is the same rule
      // applied again on the way in, for a client that did not: an extension of
      // an older release, or anything else that posts a verdict.
      // `verdicts.jsonl` is forever, so this is the last place it can be not
      // written down.
      const v = redactForSecrets(parsed, on);
      // The number is taken now but the counter moves only once the verdict
      // is in the list, below: a read that lands during the file append
      // computes its cursor from the counter, and a counter that ran ahead of
      // the list handed that read a cursor past a verdict it never saw — the
      // launcher's test caught it once in six runs; a stress loop, every time.
      // Under the walk's lock no other append can take the same number.
      const seq = st.verdictSeq + 1;
      let screenshot: string | null = null;
      const { screenshotBase64, ...ctx } = v.context;
      if (screenshotBase64) {
        screenshot = `shots/${String(seq).padStart(6, "0")}.jpg`;
        await fs.writeFile(path.join(st.dir, screenshot), Buffer.from(screenshotBase64, "base64"));
      }
      // `ask` only if a client actually sent one. It is a verdict *kind* now,
      // and an `ask` verdict carrying `ask: false` beside it reads as a
      // contradiction to the agent on the other end (the agent session, walk
      // 13, said so). The field is kept for whatever still sends it; nothing
      // puts one on a verdict that arrived without it.
      const verdict: Verdict = { itemId: v.itemId, kind: v.kind, text: v.text, option: v.option, ...(v.ask === undefined ? {} : { ask: v.ask }), ...(v.steps ? { steps: v.steps } : {}), nonce: v.nonce, seq, at: now(), context: { ...ctx, screenshot } };
      if (v.kind === "undo") {
        // What is being taken back: the person's latest answer on the item. If
        // no agent has been handed it yet, both records go quiet — the agent
        // never sees a verdict that was withdrawn before it looked.
        const target = [...st.verdicts].reverse().find(x => x.itemId === v.itemId && x.kind !== "blocked" && x.kind !== "undo" && !st.hidden.has(x.seq));
        if (target) {
          verdict.retracts = target.seq;
          if (target.seq > (st.walk.delivered ?? 0)) { verdict.quiet = true; st.hidden.add(target.seq); st.hidden.add(seq); }
        }
      }
      await fs.appendFile(path.join(st.dir, "verdicts.jsonl"), JSON.stringify(verdict) + "\n");
      st.verdicts.push(verdict); st.verdictSeq = seq; st.nonces.set(v.nonce, verdict);
      for (const w of st.waiters) w();
      this.emit("verdict", walkId, verdict);
      return verdict;
    });
  }

  /**
   * A read is an agent's unless it says `viewer` — the pane reads to paint,
   * and painting hands nothing to anyone. An agent's read returns no hidden
   * seq and moves `delivered` to cover everything it now holds: what it was
   * just given, and everything at or below the cursor it asked from.
   */
  async read(walkId: string, after = 0, opts: { viewer?: boolean } = {}) {
    const st = await this.state(walkId);
    const items = [...st.items.values()].sort((a, b) => a.seq - b.seq);
    // The pane gets the values — it is the hand on the Copy button. Everything
    // below this line is an agent read, and gets the labels only.
    if (opts.viewer) return { walk: st.walk, items, verdicts: st.verdicts.filter(v => v.seq > after), cursor: st.verdictSeq };
    // Only what has matured past the grace window, and only up to the first
    // verdict that has not: a cursor must never skip over a verdict that is
    // still to come, so the handed list stops at the first young one.
    const verdicts = this.handable(st, after);
    const cursor = verdicts.length ? verdicts[verdicts.length - 1].seq : Math.min(st.verdictSeq, this.firstYoungBefore(st, after));
    await this.deliver(walkId, st, after, verdicts);
    return { walk: st.walk, items: items.map(withoutSecretValues), verdicts, cursor };
  }

  /** Verdicts an agent may be handed now: after the cursor, not hidden, matured, and stopping at the first one still inside the window. */
  private handable(st: WalkState, after: number, now = Date.now()): Verdict[] {
    const out: Verdict[] = [];
    for (const v of st.verdicts) {
      if (v.seq <= after) continue;
      if (!this.matured(v, now)) break;
      if (!st.hidden.has(v.seq)) out.push(v);
    }
    return out;
  }
  /** The seq just before the first verdict after `after` that is still inside the window, or the latest seq if none is. */
  private firstYoungBefore(st: WalkState, after: number, now = Date.now()): number {
    const young = st.verdicts.find(v => v.seq > after && !this.matured(v, now));
    return young ? young.seq - 1 : st.verdictSeq;
  }
  /** ms until the first young verdict after `after` matures; Infinity if none is young. */
  private untilMature(st: WalkState, after: number, now = Date.now()): number {
    const young = st.verdicts.find(v => v.seq > after && !this.matured(v, now));
    return young ? Math.max(1, this.graceMs - (now - Date.parse(young.at))) : Infinity;
  }

  async wait(walkId: string, after: number, timeoutMs: number) {
    const st = await this.state(walkId);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    // Woken by a new verdict or by the window closing on one already here;
    // either way the loop re-checks, because a wake inside the window is not
    // yet an answer. timeoutMs 0 drains what has matured and returns.
    while (this.handable(st, after).length === 0 && !st.walk.closedAt) {
      const now = Date.now();
      const left = deadline - now;
      if (left <= 0) break;
      const ms = Math.min(left, this.untilMature(st, after, now));
      await new Promise<void>(resolve => {
        const done = () => { st.waiters.delete(done); clearTimeout(t); resolve(); };
        const t = setTimeout(done, ms);
        st.waiters.add(done);
      });
    }
    // The list and the cursor are one snapshot: `deliver` waits for the walk
    // lock, and a verdict landing meanwhile must not push the cursor past the
    // last one in this answer (the invariant the concurrency test holds).
    const verdicts = this.handable(st, after);
    const cursor = verdicts.length ? verdicts[verdicts.length - 1].seq : Math.min(st.verdictSeq, this.firstYoungBefore(st, after));
    const closed = Boolean(st.walk.closedAt);
    await this.deliver(walkId, st, after, verdicts);
    // `project` rides along because a verdict's screenshot path is
    // `<data dir>/<project>/<walk>/…` and the MCP server needs it to hand the
    // agent a file path. Without it a client that had never opened or read this
    // walk — every resumed session — read the whole walk header just to learn one
    // string, and read it from past the end (found in review). A walk's
    // project never changes, so one field here replaces that read for good.
    return { verdicts, cursor, closed, project: st.walk.project };
  }

  private async deliver(walkId: string, st: WalkState, after: number, handed: Verdict[]) {
    // Clamped to the walk's own last seq (found in review). `after` is the
    // caller's cursor and a caller may ask from past the end — a client that read
    // with Number.MAX_SAFE_INTEGER did exactly that — and an unclamped
    // `delivered` then sat above every verdict the walk will ever have, so no
    // undo inside the grace window was ever quiet again and walk.json carried a
    // nonsense number for the rest of the walk. The cursor handed back to the
    // agent is clamped one line up in `wait` and `read`; this is the same bound.
    const upTo = Math.min(st.verdictSeq, Math.max(after, handed.length ? handed[handed.length - 1].seq : 0));
    if (upTo <= (st.walk.delivered ?? 0)) return;
    await withLock(st, async () => {
      if (upTo <= (st.walk.delivered ?? 0)) return;
      st.walk.delivered = upTo;
      await fs.writeFile(path.join(st.dir, "walk.json"), JSON.stringify(st.walk, null, 2));
      this.emit("delivered", walkId, st.walk);
    });
  }

  async close(walkId: string, summary: string): Promise<Walk> {
    const st = await this.state(walkId);
    return withLock(st, async () => {
      this.assertOpen(st);
      st.walk = { ...st.walk, closedAt: now(), summary };
      await fs.writeFile(path.join(st.dir, "walk.json"), JSON.stringify(st.walk, null, 2));
      for (const w of st.waiters) w();
      this.emit("close", walkId, st.walk);
      return st.walk;
    });
  }
}

// A crash mid-append leaves half a line at the end of a .jsonl. That last line
// is the only one we are allowed to drop: everything before it was written
// whole, so an unparseable line anywhere else means real damage and must not be
// swallowed into a silently shorter walk.
async function readRecords(file: string): Promise<unknown[]> {
  let text: string;
  try { text = await fs.readFile(file, "utf8"); } catch { return []; }
  const lines = text.split("\n").filter(l => l.length > 0);
  const out: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    try { out.push(JSON.parse(lines[i])); }
    catch (e) {
      if (i === lines.length - 1) { console.warn(`walkd: ${file}: skipping torn last line (${(e as Error).message})`); continue; }
      throw new Error(`${file}: line ${i + 1} is not JSON: ${(e as Error).message}`);
    }
  }
  return out;
}

async function exists(file: string): Promise<boolean> {
  try { await fs.stat(file); return true; } catch { return false; }
}
