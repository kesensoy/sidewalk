/**
 * The pane's own markup, from a string to live nodes.
 *
 * `render.ts` builds every card as an HTML string with each interpolation
 * through `esc`; that escape is what keeps an agent's words from becoming
 * markup, and nothing here replaces it. What this adds is the step between
 * the string and the page: the string is parsed in a detached document, where
 * nothing in it can run or load, the tree is checked, and only then are the
 * nodes adopted into the pane. A string assigned straight to `innerHTML` has
 * no such step — which is what addons-linter's `UNSAFE_VAR_ASSIGNMENT` warns
 * about, and why the pane does not do it.
 *
 * The check is the floor `Element.setHTML()` keeps under any configuration
 * (MDN, read 2026-10-05): the elements that run or embed code — script,
 * frame, iframe, embed, object, use — and every event-handler attribute. One
 * thing more: a URL attribute whose scheme is not http or https. The one link
 * the pane draws (`pageLink`) already refuses those; this holds the same rule
 * at the edge, where a future card type would meet it too. `setHTML` itself
 * is Chrome 146 and Firefox 148 with no Safari, against a pane that runs on
 * Chrome 120 and Firefox 140, so the check is written out rather than called.
 *
 * Nothing in render.ts emits any of that, so on the pane's markup `scrub` is
 * a no-op, and `markup.test.ts` holds that what lands in the pane is
 * node-for-node what an innerHTML assignment would have built — same tree,
 * same attributes, same text. Focus, the ledge, and the breathing kerbs are
 * all read off that tree, so none of them can tell the difference.
 */

/** What `setHTML` removes whatever it is told; the pane never draws any of them. */
const DROP = new Set(["script", "frame", "iframe", "embed", "object", "use"]);
/** Attributes a browser reads as a URL to fetch or follow. */
const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "poster"]);
/**
 * An absolute http or https URL and nothing else — not relative, not
 * `javascript:`, and not `java\tscript:`, which a browser would strip to the
 * same thing. The pane's one link is absolute, so the narrow rule costs it
 * nothing.
 */
const SAFE_URL = /^\s*https?:/i;

/** Take out of `root` anything that could run, load, or point somewhere that runs. */
export function scrub(root: ParentNode): void {
  // Static list, so removing an element does not move the iteration. A removed
  // element's descendants are still in the list and are scrubbed detached,
  // which is harmless.
  for (const el of [...root.querySelectorAll("*")]) {
    if (DROP.has(el.localName)) { el.remove(); continue; }
    for (const { name, value } of [...el.attributes]) {
      const n = name.toLowerCase();
      if (n.startsWith("on") || (URL_ATTRS.has(n) && !SAFE_URL.test(value))) el.removeAttribute(name);
    }
  }
}

/**
 * Replace `el`'s children with `html`, parsed apart from the page and checked
 * before any of it is live. An empty string empties `el`.
 */
export function setMarkup(el: Element, html: string): void {
  const doc = new DOMParser().parseFromString(html, "text/html");
  scrub(doc.body);
  // Nodes from another document are adopted on insertion.
  el.replaceChildren(...doc.body.childNodes);
}
