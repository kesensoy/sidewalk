import type { Item, Verdict } from "sidewalk-walkd/schema";

/**
 * An answer to an ask, and the card it belongs on.
 *
 * The owner, 2026-10-04: "i like the new pending answer thing, but then when the
 * answer is there I think it should link to the card that asked it (instead of
 * letting a card be in between with its own dismiss) and I think the color
 * indication type stuff should stop looking like it's still pending/waiting, at
 * least in the same way, because it's still pending a person but not pending
 * the same thing anymore (claude in this case)."
 *
 * The wire has said what a reply is since 0.3.0: an item with `supersedes` set
 * to the asked item's id (`sidewalk-mcp`'s `reply` line asks for exactly that,
 * and `openAsks` closes an ask on one). What was missing was the pane's half —
 * the answer arrived as a card of its own, between the question and everything
 * else, with a Dismiss that resolved nothing. So an `info` reply is not a card
 * at all here: it is a block inside the card that asked, where the waiting line
 * was.
 *
 * A `question` reply keeps its card — it has a verdict of its own to collect —
 * and only moves, to directly under the card it answers.
 */

/** `info` is the one kind that can be an answer instead of a card: it has no verdict to collect. */
type InfoItem = Extract<Item, { kind: "info" }>;

export type Replies = {
  /**
   * Asked cards whose **latest** ask has been answered: the yellow stops here.
   * Exactly the rule `openAsks` closes an ask on — a non-withdrawn item naming
   * the card in `supersedes` that is not older than that ask — so the pane and
   * the agent never disagree about who is waiting on whom.
   */
  answered: Set<string>;
  /** The `info` replies that paint inside their asked card, in seq order. */
  blocks: Map<string, InfoItem[]>;
  /** Every item id in `blocks`, so no list, ledge or shelf paints one as a card. */
  attached: Set<string>;
  /** A `question` reply, and the asked card it sits directly under. */
  after: Map<string, string>;
};

/**
 * Which items are answers rather than cards.
 *
 * An item is a reply when it names an item of this walk in `supersedes` and has
 * not been withdrawn — the agent taking its own answer back leaves the question
 * standing, which is what `openAsks` says too. It becomes *attached* — no card
 * anywhere, no Dismiss — when the card it names was asked: the ask is the thing
 * the reply is an answer to, and a `supersedes` at a card nobody asked about is
 * an ordinary item that happens to carry the field.
 *
 * "Was asked", not "is still asking": the attachment has to outlive the
 * person's own answer, because a card they passed keeps the agent's answer in
 * its record (the Done shelf row opens out on it), and a reply that turned
 * itself back into a loose card the moment they pressed Pass would be the
 * in-between card the owner asked us to get rid of, arriving late.
 *
 * **Answering is the narrower half, and it is per ask, not per card.** A person
 * can ask again on a card they have already been answered on — one early PIN
 * exchange went several turns — and an answer given before that second question
 * cannot be an answer to it. So a reply closes an ask only if it is not older
 * than the card's latest ask: `addedAt` against that ask's `at`, both the
 * daemon's own `new Date().toISOString()` (store.ts), so the strings sort by
 * time. The old answers stay in the card as blocks, in seq order, and the new
 * question's waiting line goes under them.
 */
export function replies(items: Item[], verdicts: Verdict[]): Replies {
  // The latest ask on each item, by seq: the one anything is waiting on.
  const latestAsk = new Map<string, Verdict>();
  for (const v of verdicts) {
    if (v.kind !== "ask") continue;
    const seen = latestAsk.get(v.itemId);
    if (!seen || v.seq > seen.seq) latestAsk.set(v.itemId, v);
  }
  const byId = new Map(items.map(i => [i.id, i] as const));
  const out: Replies = { answered: new Set(), blocks: new Map(), attached: new Set(), after: new Map() };
  // Seq order, so several answers to one ask read in the order the agent sent
  // them rather than the order the walk happened to hand them over in.
  for (const r of [...items].sort((a, b) => a.seq - b.seq)) {
    if (!r.supersedes || r.withdrawnAt) continue;
    const x = byId.get(r.supersedes);
    const ask = x && latestAsk.get(x.id);
    if (!x || !ask) continue;
    if (r.addedAt >= ask.at) out.answered.add(x.id);
    if (r.kind === "info") {
      out.blocks.set(x.id, [...(out.blocks.get(x.id) ?? []), r]);
      out.attached.add(r.id);
    } else {
      out.after.set(r.id, x.id);
    }
  }
  return out;
}

/**
 * How many items a walk wants the person's eye on — the toolbar badge's number.
 *
 * An attached reply is not a card, so it is not one of these. What it changes
 * is the card it landed on, and that card is what the badge counts in its
 * place: one answer raises the badge by one whether the asked card had been
 * looked at or not, because either way there is one thing to go and look at.
 *
 * A withdrawn item wants nothing, and neither does an answer to one.
 */
export function unseenCount(view: { items: Item[]; verdicts: Verdict[]; lastSeenSeq: number }): number {
  const rep = replies(view.items, view.verdicts);
  const live = new Map(view.items.filter(i => !i.withdrawnAt).map(i => [i.id, i] as const));
  const want = new Set<string>();
  for (const i of live.values()) {
    if (i.seq <= view.lastSeenSeq) continue;
    const id = rep.attached.has(i.id) ? i.supersedes : i.id;
    if (id && live.has(id)) want.add(id);
  }
  return want.size;
}
