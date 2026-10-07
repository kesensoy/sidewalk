import { originAndPath, redacted } from "sidewalk-walkd/schema";
import type { ConsoleEntry, VerdictInput } from "sidewalk-walkd/schema";

/**
 * What a verdict about a secret-bearing card may not carry back (audit
 * 2026-10-04, F5).
 *
 * The `file` form of a secret exists so an agent that must not hold a value
 * never sees one. The page is the hole in that: an agent writes
 * `expect: [{kind:"text", css:"#keyshown", equals:"x"}]`, the expectation fails,
 * and the `blocked` verdict's line reports what the page was showing — which is
 * what the person has just pasted. `buildId` is the same read on *every*
 * verdict, and the console tail is the same channel with less precision.
 *
 * So on an item that carries secrets, the three page-text fields leave the pane
 * as their lengths, and the url leaves it cut to its origin and path (audit
 * 2026-10-06, SW-2 — the one page-read field the first pass missed). Done here
 * rather than at the daemon because here is where they are read, and the daemon
 * checks again on the way in (store.ts) for a pane that did not.
 *
 * What is deliberately not changed: the screenshot. Whether the site is
 * photographed after the paste is the person's own setting (the gear's
 * *Issues only* / *Never*), said plainly in the copied note and in README §5 —
 * the audit's position, and it stands.
 */
export function carriesSecrets(item: unknown): boolean {
  const list = (item as { secrets?: unknown[] } | undefined)?.secrets;
  return Array.isArray(list) && list.length > 0;
}

/**
 * The page text an expectation saw, as its length. `(absent)` is the pane's own
 * word for an element that is not there, not something the page said, so it
 * survives — it is the difference between "the field is missing" and "the field
 * holds something I may not repeat".
 */
export const ABSENT = "(absent)";
export function redactSeen(seen: string | undefined): string | undefined {
  if (seen === undefined || seen === ABSENT) return seen;
  return redacted(seen.length);
}

/**
 * The verdict's context, with the two page-text fields redacted: `buildId`, and
 * every console line's text. The level and the time stay, so an agent still
 * knows the page logged two errors while the card was answered — only what they
 * said is withheld.
 *
 * And the url cut to its origin and path (found in review). It is read off
 * the live tab at verdict time, so a page that puts the pasted value in a query
 * string or a fragment was handing it back whole. Which page the verdict is about
 * is what the field is for, and that survives the cut.
 */
export function redactContext(ctx: VerdictInput["context"]): VerdictInput["context"] {
  const out: VerdictInput["context"] = {
    ...ctx,
    url: originAndPath(ctx.url),
    console: ctx.console.map((c: ConsoleEntry) => ({ ...c, text: redacted(c.text.length) })),
  };
  if (ctx.buildId !== undefined) out.buildId = redacted(ctx.buildId.length);
  return out;
}
