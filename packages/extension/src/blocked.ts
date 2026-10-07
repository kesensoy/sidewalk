import type { Item, Verdict } from "sidewalk-walkd/schema";

/**
 * Whether pressing Go on an item the page cannot satisfy is worth another
 * `blocked` verdict.
 *
 * The owner's first walk answered this: seqs 4, 5 and 6 were three byte-identical
 * `blocked` verdicts, one per press, because `go()` filed one every time. The
 * stream is append-only and the agent reads it as a record of what happened —
 * three of them say "it broke three times", when what happened is one broken
 * item pressed three times. The same diagnostic against the same item is not
 * news; a different one (the build moved, a later expectation is the one
 * failing now) is, so it still goes.
 */
export function shouldFileBlocked(item: Pick<Item, "id">, verdicts: Verdict[], text: string, clearedSeq = 0): boolean {
  // A diagnostic filed before a Go that passed is history, not a duplicate: the
  // page caught up and fell back again, and that is news.
  return !verdicts.some(v => v.itemId === item.id && v.kind === "blocked" && v.text === text && v.seq > clearedSeq);
}
