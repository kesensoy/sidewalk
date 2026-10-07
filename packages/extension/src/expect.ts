import type { Expect, Target } from "sidewalk-walkd/schema";
import { ABSENT } from "./redact.js";

export type ExpectResult = {
  ok: boolean; failed?: Expect; seen?: string; buildId?: string; noAnswer?: boolean;
  /**
   * The browser refused the item's own `css` selector or `url` pattern — the
   * agent wrote something `querySelector` or `RegExp` will not take. Its own
   * field, not a kind of `noAnswer`: a page nobody could reach files nothing,
   * while a selector nobody can parse is the agent's mistake and has to be said
   * out loud (found in review).
   */
  badSelector?: string;
};

/**
 * The most of a page's own words a `text` expect may carry back.
 *
 * `seen` and `buildId` are read off the live page, and `buildId` rides every
 * verdict of that card, a pass included — so without a bound the answer carries
 * however much text the element happened to hold (a 3070-character read of
 * `body` containing the page's email address, in the audit's own repro). 300
 * characters is longer than any build stamp, release tag or heading an expect is
 * written against, and short enough that PRIVACY.md can say what leaves the
 * page (found in review).
 */
export const TEXT_CAP = 300;
const capped = (s: string): string => (s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) : s);

/**
 * The compiled form of an item's `url` pattern, made once per pattern.
 *
 * `evaluateExpect` runs on every poll of a Go — about twelve times across the
 * three-second window — and the pattern is the agent's string, not the
 * person's. One compile per distinct pattern, and an unparseable one throws
 * here, where the content script's own catch turns it into `badSelector`.
 */
const compiled = new Map<string, RegExp>();
function urlPattern(matches: string): RegExp {
  const known = compiled.get(matches);
  if (known) return known;
  const rx = new RegExp(matches);
  compiled.set(matches, rx);
  return rx;
}

/**
 * What a Go should do with an expect result. A page that never answered is not
 * a page whose preconditions failed: the tab could not be reached at all — it
 * never loaded, or it is a page no content script may run on — and a `blocked`
 * verdict there would tell the agent the build was wrong when nothing was ever
 * looked at. So that case files nothing.
 */
export function classifyExpect(r: ExpectResult): "ok" | "blocked" | "noAnswer" {
  if (r.ok) return "ok";
  return r.noAnswer ? "noAnswer" : "blocked";
}

/**
 * The line a `blocked` verdict carries, for people first and agents second.
 * Design language v3 (the fidelity review): the raw JSON the worker used to
 * file wrapped mid-token in the diagnostic well and could not be read at a
 * glance, which was the whole point of the orange card the owner liked. So:
 * `expect[2] text meta[name=build] content: wanted "fac3493f", saw "fix-001"`.
 * The index is 1-based and counts the item's own `expect` list.
 */
export function describeExpect(failed: Expect, all: Expect[], seen: string | undefined): string {
  const n = Math.max(1, all.indexOf(failed) + 1);
  const where = failed.kind === "url" ? "url" : `${failed.kind} ${failed.css}${failed.kind === "text" && failed.attr ? ` ${failed.attr}` : ""}`;
  const wanted = failed.kind === "url" ? failed.matches : failed.kind === "present" ? "present" : failed.equals ?? (failed.contains !== undefined ? `contains ${failed.contains}` : "any text");
  return `expect[${n}] ${where}: wanted "${wanted}", saw "${seen ?? ""}"`;
}

/**
 * The two lines the pane says about a Go that got no usable answer.
 *
 * `NO_ACCESS_SAID` is the silent case the worker already had and nobody was
 * told about: the tab was closed, the load never finished, or it is a surface no
 * content script may run on. Nothing is filed for it — silence is not a failed
 * expectation — so the pane is the only place it can be said.
 *
 * `BAD_SELECTOR_SAID` is the agent's typo: `querySelector` or `RegExp` refused
 * the item's own string. The browser's message follows it, and the same pair is
 * filed as a `blocked` line, because the agent that wrote the selector is the
 * one who can fix it (found in review).
 */
export const NO_ACCESS_SAID = "The check could not run on this page.";
export const BAD_SELECTOR_SAID = "This card's selector is not valid.";
export const badSelectorLine = (message: string): string => `${BAD_SELECTOR_SAID} ${message}`;

// happy-dom (and older engines) may not ship CSS.escape; walk ids are plain
// slugs, so passing them through unescaped is the honest fallback.
const cssEscape = (s: string): string => (globalThis.CSS?.escape ?? ((x: string) => x))(s);

/**
 * Checks an item's preconditions against the live page. Stops at the first
 * unmet one and reports what was actually seen, so a `blocked` verdict tells
 * the agent exactly why the human was never shown the item.
 */
export function evaluateExpect(doc: Document, href: string, expect: Expect[]): ExpectResult {
  let buildId: string | undefined;
  for (const e of expect) {
    if (e.kind === "url") {
      if (!urlPattern(e.matches).test(href)) return { ok: false, failed: e, seen: href };
      continue;
    }
    const el = doc.querySelector(e.css);
    // ABSENT is the pane's own word for a missing element, not something the
    // page said — which is why redacting a secret-bearing card's `seen` leaves
    // it alone (redact.ts).
    if (!el) return { ok: false, failed: e, seen: ABSENT };
    if (e.kind === "text") {
      const val = (e.attr ? el.getAttribute(e.attr) : el.textContent) ?? "";
      // The comparison is against everything the element holds; only what is
      // reported back is cut to TEXT_CAP. A page that satisfies the expect in
      // its first 300 characters and breaks it in the 400th still fails.
      if (e.equals !== undefined && val.trim() !== e.equals) return { ok: false, failed: e, seen: capped(val.trim()) };
      if (e.contains !== undefined && !val.includes(e.contains)) return { ok: false, failed: e, seen: capped(val.trim()) };
      if (buildId === undefined) buildId = capped(val.trim());
    }
  }
  return buildId === undefined ? { ok: true } : { ok: true, buildId };
}

export function findTarget(doc: Document, t: Target): Element | null {
  if ("css" in t) return doc.querySelector(t.css);
  if ("walkId" in t) return doc.querySelector(`[data-walk="${cssEscape(t.walkId)}"]`);
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  let best: Element | null = null;
  for (let n = walker.nextNode() as Element | null; n; n = walker.nextNode() as Element | null) {
    if (n.children.length === 0 && (n.textContent ?? "").includes(t.text)) { best = n; break; }
  }
  return best;
}
