import type { VerdictInput } from "sidewalk-walkd/schema";
import { DaemonReject } from "./daemon.js";

type Entry = { walk: string; verdict: VerdictInput };
/**
 * A dead letter is not the verdict, only enough of it to put the card back in
 * front of the person: which item, what they answered it with, why the daemon
 * refused it and when. The verdict's `context` is deliberately not here. It
 * carries the base64 of a screenshot of the walked site, and `walkd:dead` keeps
 * its last fifty entries indefinitely — so a value the person had just pasted
 * sat in the Chrome profile for good, for a verdict that never even landed
 * (secrets review). Nothing reads the context off a dead letter: nothing
 * replays one.
 */
export type DeadEntry = { walk: string; verdict: Pick<VerdictInput, "itemId" | "kind">; error: string; at: string };
type Storage = { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> };

const KEY = "walkd:queue";
const DEAD_KEY = "walkd:dead";

/**
 * Statuses a replay can never turn into a success: a malformed verdict, a walk
 * that is gone, a body over the daemon's cap. Everything else — a network
 * drop, a 5xx, a rate limit — is worth trying again, so it holds the queue.
 */
export function pickTerminal(status: number): boolean {
  return status === 400 || status === 404 || status === 413;
}

/**
 * A verdict submit is never lost: it is written to storage first, then sent.
 * A failed send stays at the head of the queue, so replays keep the order the
 * human clicked in. `flush` serialises on a promise chain so two callers never
 * drain the same entry twice. A permanent rejection is moved to `walkd:dead`
 * rather than parked at the head, where it would jam every later verdict.
 */
export class VerdictQueue {
  private chain: Promise<void> = Promise.resolve();

  constructor(private storage: Storage, private send: (walk: string, v: VerdictInput) => Promise<void>) {}

  private async load(): Promise<Entry[]> {
    return ((await this.storage.get(KEY)) as Entry[] | undefined) ?? [];
  }

  async enqueue(walk: string, verdict: VerdictInput) {
    const q = await this.load();
    q.push({ walk, verdict });
    await this.storage.set(KEY, q);
  }

  async size() {
    return (await this.load()).length;
  }

  /** Verdicts the daemon refused outright, kept so the agent can be told. */
  async dead(): Promise<DeadEntry[]> {
    return ((await this.storage.get(DEAD_KEY)) as DeadEntry[] | undefined) ?? [];
  }

  /**
   * Replaces the context of a still-queued verdict (the screenshot, the console
   * tail, the build id arriving after the click was recorded). Runs on the same
   * chain as `flush`, so it never races a send. False means it already went.
   */
  patch(nonce: string, context: VerdictInput["context"]): Promise<boolean> {
    const done = this.chain.then(async () => {
      const q = await this.load();
      const i = q.findIndex(e => e.verdict.nonce === nonce);
      if (i < 0) return false;
      q[i] = { ...q[i], verdict: { ...q[i].verdict, context } };
      await this.storage.set(KEY, q);
      return true;
    });
    this.chain = done.then(() => {}, () => {});
    return done;
  }

  flush(): Promise<void> {
    this.chain = this.chain.then(async () => {
      let q = await this.load();
      while (q.length) {
        try {
          await this.send(q[0].walk, q[0].verdict);
        } catch (e) {
          if (!(e instanceof DaemonReject && pickTerminal(e.status))) break;
          await this.bury(q[0], e.message);
        }
        q = q.slice(1);
        await this.storage.set(KEY, q);
      }
    });
    return this.chain;
  }

  /**
   * Drop an item's dead letters. The pane shows a refused verdict as a card to
   * answer again; the moment the human does, the refusal is spent — leaving it
   * would keep asking them for an answer they have already given twice.
   */
  clearDead(itemId: string): Promise<void> {
    const done = this.chain.then(async () => {
      const dead = await this.dead();
      const left = dead.filter(d => d.verdict.itemId !== itemId);
      if (left.length !== dead.length) await this.storage.set(DEAD_KEY, left);
    });
    this.chain = done.then(() => {}, () => {});
    return done;
  }

  private async bury(entry: Entry, error: string) {
    const dead = await this.dead();
    // Built field by field, not spread: a dead letter outlives the walk it came
    // from, so what goes in it is a decision and not whatever a verdict happens
    // to carry. The screenshot above all.
    const { itemId, kind } = entry.verdict;
    dead.push({ walk: entry.walk, verdict: { itemId, kind }, error, at: new Date().toISOString() });
    await this.storage.set(DEAD_KEY, dead.slice(-50));
  }
}
