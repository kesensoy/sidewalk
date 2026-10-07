import { describe, expect, it } from "vitest";
import type { Item, Verdict } from "sidewalk-walkd/schema";
import type { WalkView } from "./protocol.js";
import { renderEmpty, renderFirstRun, renderTokenNotice, renderVersionNotice, renderWalk } from "./render.js";
import { scrub, setMarkup } from "./markup.js";

const at = "2026-10-05T00:00:00.000Z";
const look = (id: string, seq: number, extra: Partial<Item> = {}): Item =>
  ({ id, seq, kind: "look", owner: "t", title: `Look ${id} <b>`, url: "http://127.0.0.1:9342/other.html", do: "do", see: "see", pass: "pass", expect: [], addedAt: at, ...extra } as Item);
const verdict = (itemId: string, kind: Verdict["kind"], seq: number, extra: Partial<Verdict> = {}): Verdict =>
  ({ itemId, kind, text: `words "for" ${itemId}`, nonce: "n", seq, at, context: { url: "", viewport: [1, 1], console: [], userAgent: "", screenshot: null }, ...extra } as Verdict);

/**
 * One walk with every shape the pane draws: a current card, a waiting one, a
 * blocked one, a refused one, a question with its sheet, a sequence with
 * ticks, an info card with a secret, a withdrawn card, a replied ask, a ledge
 * row with its drain bar, and a shelf with a confirming Undo on it.
 */
const view: WalkView = {
  walk: { id: "w", project: "p", title: "Walk <11>", buildRef: "fix-001", openedAt: at, brief: "Read & this first", delivered: 3 } as WalkView["walk"],
  current: "cur",
  cleared: { cleared: 1 },
  lastSeenSeq: 4,
  items: [
    look("cur", 1),
    look("asked", 2),
    look("stopped", 3),
    look("refused", 4),
    look("cleared", 5),
    { id: "q", seq: 6, kind: "question", owner: "t", title: "Tier names?", options: ["Solo / Team", "Pro / Team"], eli5: "simple", why: ["one", "two"], addedAt: at } as Item,
    { id: "seq", seq: 7, kind: "sequence", owner: "t", title: "The lock", url: "http://127.0.0.1:9342/", steps: [{ do: "Press", see: "It" }, { do: "Read", see: "That" }], pass: "Both.", addedAt: at } as Item,
    { id: "info", seq: 8, kind: "info", owner: "t", title: "A key", body: "Use it", secrets: [{ label: "Licence key" }], addedAt: at } as Item,
    look("gone", 9, { withdrawnAt: at, withdrawReason: "not needed" } as Partial<Item>),
    look("ledge", 10),
    look("shelf", 11),
    look("replied", 12),
    { id: "reply", seq: 13, kind: "info", owner: "t", title: "Yes", body: "On purpose", supersedes: "replied", addedAt: at } as Item,
  ],
  verdicts: [
    verdict("asked", "ask", 1),
    verdict("stopped", "blocked", 2, { text: 'expect[0] present #x: wanted "present", saw "(absent)"' }),
    verdict("refused", "pass", 3),
    verdict("cleared", "blocked", 1),
    verdict("shelf", "issue", 3),
    verdict("ledge", "pass-note", 5),
    verdict("replied", "ask", 4, { at: "2026-10-04T00:00:00.000Z" }),
  ],
};

const opts = {
  drafts: new Map([["cur", "mid 'sentence' <"]]),
  refused: new Set(["refused"]),
  confirming: new Set(["shelf"]),
  ticks: new Map([["seq", [true, false]]]),
  now: Date.parse(at) + 4000,
  graceMs: 10_000,
};

const walkHtml = renderWalk(view, opts);

/** What an `innerHTML` assignment builds from the same string, for comparison only. */
function viaInnerHtml(html: string): HTMLElement {
  const el = document.createElement("main");
  el.innerHTML = html;
  return el;
}

function viaMarkup(html: string): HTMLElement {
  const el = document.createElement("main");
  setMarkup(el, html);
  return el;
}

describe("setMarkup on the pane's own markup", () => {
  it("builds the same tree an innerHTML assignment would, on a walk with every card shape", () => {
    // The fixture really does reach every branch: each shape leaves a mark.
    for (const sel of [".item.current", ".item.waiting .asked .dot.waiting", ".item.blocked .diag code", ".refused", ".options .tag", "li.step input:checked", ".secret .dots", ".mark.mark-withdrawn", "section.ledge .drain[data-drain]", "section.shelf .confirm", ".reply h4", "p.brief"]) {
      expect(viaMarkup(walkHtml).querySelector(sel), sel).not.toBeNull();
    }
    const a = viaInnerHtml(walkHtml);
    const b = viaMarkup(walkHtml);
    expect(b.innerHTML).toBe(a.innerHTML);
    expect(b.isEqualNode(a)).toBe(true);
    expect(b.childNodes.length).toBe(a.childNodes.length);
  });

  it("is the same on every notice and both empties", () => {
    for (const html of [renderEmpty(), renderFirstRun(8760), renderTokenNotice(8760), renderVersionNotice("0.3.0", "0.2.0", 8760)]) {
      expect(viaMarkup(html).innerHTML).toBe(viaInnerHtml(html).innerHTML);
    }
  });

  it("keeps what the pane reads: data attributes, the drain bar's style, an http link, aria, the svg mark", () => {
    const el = viaMarkup(walkHtml);
    expect(el.querySelector('[data-note="cur"]')).not.toBeNull();
    expect((el.querySelector("textarea[data-note='cur']") as HTMLTextAreaElement).value).toBe("mid 'sentence' <");
    expect(el.querySelector("section.ledge .drain")?.getAttribute("style")).toMatch(/^width:\d/);
    expect(el.querySelector("p.url a")?.getAttribute("href")).toBe("http://127.0.0.1:9342/other.html");
    expect(el.querySelector("button[data-copy-text]")).toBeNull();      // only the notices carry one
    expect(el.querySelector(".mark-withdrawn svg")?.getAttribute("aria-label")).toBe("Withdrawn");
    expect(el.querySelector(".mark-withdrawn svg")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(el.querySelector("h3")?.textContent).toBe("Look cur <b>");
  });

  it("replaces what was there, and an empty string clears it", () => {
    const el = document.createElement("div");
    setMarkup(el, "<p>one</p>");
    setMarkup(el, "<p>two</p><p>three</p>");
    expect(el.children.length).toBe(2);
    setMarkup(el, "");
    expect(el.childNodes.length).toBe(0);
  });

  it("adopts the nodes into the pane's document", () => {
    const el = viaMarkup("<p>x</p>");
    expect(el.firstElementChild?.ownerDocument).toBe(document);
  });
});

describe("scrub", () => {
  const scrubbed = (html: string) => { const el = document.createElement("div"); setMarkup(el, html); return el.innerHTML; };

  it("drops the elements setHTML always drops", () => {
    const out = scrubbed('<p>a</p><script>1</script><iframe></iframe><object data="x"></object><embed src="x"><frame></frame><svg><use href="#u"></use><path d="M0 0"></path></svg>');
    expect(out).toContain("<p>a</p>");
    expect(out).toContain('<path d="M0 0"></path>');
    for (const tag of ["script", "iframe", "object", "embed", "frame", "use"]) expect(out).not.toContain(`<${tag}`);
  });

  it("drops every event-handler attribute, whatever its case", () => {
    const out = scrubbed('<img src="https://x/a.png" onerror="1" ONLOAD="2"><div onclick="3" class="k">t</div>');
    expect(out).not.toMatch(/on\w+=/i);
    expect(out).toContain('class="k"');
    expect(out).toContain('src="https://x/a.png"');
  });

  it("drops a URL attribute that is not absolute http or https, and keeps one that is", () => {
    const out = scrubbed('<a href="javascript:1">j</a><a href="java\tscript:1">t</a><a href=" HTTPS://ok/">s</a><a href="/relative">r</a><form action="data:x"></form>');
    expect(out).not.toContain("javascript");
    expect(out).not.toContain("script:1");
    expect(out).toContain('href=" HTTPS://ok/"');
    expect(out).not.toContain("/relative");
    expect(out).not.toContain("data:x");
  });

  it("is a no-op on the pane's markup", () => {
    const el = document.createElement("main");
    el.innerHTML = walkHtml;
    const before = el.innerHTML;
    scrub(el);
    expect(el.innerHTML).toBe(before);
  });
});
