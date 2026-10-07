import type { Item, Verdict } from "./schema/index.js";

/** An ask nobody has answered yet: the item, the ask's verdict seq, the person's words verbatim. */
export type OpenAsk = { item: string; seq: number; text: string };

/**
 * Every question still waiting on the agent, so an unanswered ask shows up on
 * every `walk_read` instead of scrolling out of the agent's sight the moment
 * one wait returns. The pane keeps an asked card visibly open until something
 * supersedes it; this is the same state, said to the agent.
 *
 * An ask is open while it is the item's latest non-blocked verdict — the same
 * rule the pane paints by, so a `pass` or a `skip` after it closes it, and so
 * does an `undo` (loud, since a quiet one never reaches an agent read at all).
 * It is also closed by a later item that names it in `supersedes`: that is the
 * reply. A superseding item that was withdrawn does not count — the agent took
 * its own answer back, and the question stands again. Nor does one that is
 * **older than the ask**: a person can ask again on a card they have already
 * been answered on (one early PIN exchange went several turns), and an answer
 * given before the second question is not an answer to it, so a newer ask
 * reopens what an older reply closed. The comparison is the reply's `addedAt`
 * against the ask's `at` — both the daemon's own `new Date().toISOString()`,
 * so the strings sort by time — and it is the same rule the pane paints the
 * waiting kerb by (`packages/extension/src/replies.ts`), which is what keeps
 * the two halves agreeing about who is waiting on whom.
 *
 * Nothing else closes one: an `info` dropped into the card's group without
 * `supersedes` is a reply the daemon cannot tell from any other note, so the
 * ask stays listed until the person answers the card. That is why the `reply`
 * line names `supersedes`.
 *
 * It lives in the daemon rather than in `sidewalk-mcp`, where it was written,
 * because the daemon is now the half that *enforces* it: `addItems` refuses a
 * `supersedes` that names anything but one of these (found on an early walk). One copy of the
 * rule, so what the store accepts and what `walk_read` lists can never be two
 * different questions. `sidewalk-mcp` re-exports it under its own name.
 *
 * Computed from a `walk_read` and nothing else. A read with `after` set sees
 * only the verdicts above that cursor, so the full picture wants `after: 0`,
 * which is the default.
 */
export function openAsks(items: Item[], verdicts: Verdict[]): OpenAsk[] {
  const latest = new Map<string, Verdict>();
  for (const v of verdicts) {
    if (v.kind === "blocked") continue;
    const seen = latest.get(v.itemId);
    if (!seen || v.seq > seen.seq) latest.set(v.itemId, v);
  }
  // The newest answer each card has been given, by the daemon's clock. In the
  // branch below `latest` is the ask itself, so this is the comparison the
  // question's own age deserves.
  const answeredAt = new Map<string, string>();
  for (const i of items) {
    if (!i.supersedes || i.withdrawnAt) continue;
    const seen = answeredAt.get(i.supersedes);
    if (seen === undefined || i.addedAt > seen) answeredAt.set(i.supersedes, i.addedAt);
  }
  const out: OpenAsk[] = [];
  for (const i of items) {
    const v = latest.get(i.id);
    if (v?.kind !== "ask") continue;
    const answered = answeredAt.get(i.id);
    if (answered === undefined || answered < v.at) out.push({ item: i.id, seq: v.seq, text: v.text });
  }
  return out;
}
