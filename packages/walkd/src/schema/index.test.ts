import { describe, it, expect } from "vitest";
import { itemInputSchema, redactSaw, redacted, verdictInputSchema, walkInputSchema, toJsonSchema } from "./index.js";

const look = {
  id: "w1-1", kind: "look", owner: "gate", title: "Rim marks",
  url: "http://127.0.0.1:9340/", target: { css: "[data-walk=rim]" },
  do: "Watch two bubbles merge.", see: "Arcs on the rim.", pass: "Arcs visible; no gap.",
  expect: [{ kind: "url", matches: "^http://127\\.0\\.0\\.1:9340/?$" }],
};

describe("items", () => {
  it("takes a secret as a value or as a bare filename, and refuses a path", () => {
    // The file form exists because an agent may not be allowed to hold the
    // value; a bare name keeps it from pointing a card at any file on disk.
    const withS = (s: unknown) => itemInputSchema.safeParse({ ...look, secrets: [s] }).success;
    expect(withS({ label: "Operator key", value: "op-4242" })).toBe(true);
    expect(withS({ label: "Operator key", file: "operator-key.txt" })).toBe(true);
    for (const file of ["../id_rsa", "/etc/passwd", "a/b", ".hidden", "C:\\x", ""]) expect(withS({ label: "k", file })).toBe(false);
    expect(withS({ label: "k" })).toBe(false);
    expect(itemInputSchema.safeParse({ ...look, secrets: Array(5).fill({ label: "k", value: "v" }) }).success).toBe(false);
  });
  it("accepts a full look item", () => {
    expect(itemInputSchema.parse(look).kind).toBe("look");
  });
  it("takes only a page a browser will open as a look item's url", () => {
    // An item's author is an agent. `z.url()` alone accepts `javascript:`,
    // `data:` and `chrome://` — none of which the pane can link and Go cannot
    // navigate to — so they are refused here, with a reason the agent reads.
    expect(itemInputSchema.safeParse({ ...look, url: "https://app.example.com/" }).success).toBe(true);
    for (const url of ["javascript:alert(1)", "data:text/html,<b>x", "chrome://settings", "file:///tmp/x", "not a url"])
      expect(itemInputSchema.safeParse({ ...look, url }).success).toBe(false);
  });
  it("rejects a look item without a pass line", () => {
    const { pass, ...noPass } = look;
    expect(itemInputSchema.safeParse(noPass).success).toBe(false);
  });
  it("rejects a question with empty facts or one option", () => {
    const q = { id: "q1", kind: "question", owner: "gate", title: "Tier names",
      eli5: "x", proposal: "y", why: "z", downsides: ["d"], facts: "", recommendation: "r",
      options: ["Solo / Team"], costIfWrong: "c" };
    expect(itemInputSchema.safeParse(q).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...q, facts: "settled", options: ["a", "b"] }).success).toBe(true);
  });
  it("accepts a question that is only a title and its options", () => {
    // Most decisions are not a full decision sheet. Only the breakdown a big
    // one deserves is optional; the choice itself never is.
    const bare = { id: "q2", kind: "question", owner: "gate", title: "Keep it?", options: ["Keep it", "Change it"] };
    expect(itemInputSchema.safeParse(bare).success).toBe(true);
    const { options, ...noOptions } = bare;
    expect(itemInputSchema.safeParse(noOptions).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...bare, options: ["only one"] }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...bare, options: ["a", "b", "c", "d", "e"] }).success).toBe(false);
    const { title, ...noTitle } = bare;
    expect(itemInputSchema.safeParse(noTitle).success).toBe(false);
  });
  it("takes any subset of the decision-sheet sections", () => {
    const q = { id: "q3", kind: "question", owner: "gate", title: "Tier names", options: ["a", "b"] };
    for (const section of [{ eli5: "e" }, { proposal: "p" }, { why: "w" }, { downsides: ["d"] }, { facts: "f" }, { recommendation: "r" }, { costIfWrong: "c" }]) {
      expect(itemInputSchema.safeParse({ ...q, ...section }).success).toBe(true);
    }
  });
  it("accepts a sequence: one page, two to eight do→see steps, an optional pass line", () => {
    // The owner, 2026-09-17, on four look cards for one path: "press go does it
    // work? Try this now what does it do? Try this now..." One card, the steps
    // in order, one note box and one set of buttons for the whole thing.
    const seq = { id: "s1", kind: "sequence", owner: "gate", title: "The hour lock", url: "https://demo.app.example.com/",
      steps: [{ do: "Press Go.", see: "You land on the demo, booked for 60 minutes." }, { do: "Open a second favourite.", see: "Booked line, no switch." }],
      expect: [{ kind: "url", matches: "^https://app\\.example\\.com/demo" }] };
    const parsed = itemInputSchema.parse(seq);
    expect(parsed.kind).toBe("sequence");
    expect(itemInputSchema.safeParse({ ...seq, pass: "The lock held and your approval beat it." }).success).toBe(true);
    expect(itemInputSchema.safeParse({ ...seq, steps: seq.steps.slice(0, 1) }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...seq, steps: Array(9).fill(seq.steps[0]) }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...seq, steps: [{ do: "x", see: "" }, seq.steps[1]] }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...seq, url: "javascript:alert(1)" }).success).toBe(false);
    const { expect: _e, ...noExpect } = seq;
    expect(itemInputSchema.parse(noExpect)).toMatchObject({ expect: [] });
  });
  it("constrains an item id to what is safe in a URL path segment", () => {
    // Ids ride in /walks/:id/items/:itemId/withdraw, so a slash would split the
    // route; "w11-07" and "F141.b" are the shapes the walks actually use.
    expect(itemInputSchema.safeParse({ ...look, id: "w11/07" }).success).toBe(false);
    expect(itemInputSchema.safeParse({ ...look, id: "w11-07" }).success).toBe(true);
    expect(itemInputSchema.safeParse({ ...look, id: "F141.b" }).success).toBe(true);
  });

  it("accepts an info item with only title and body", () => {
    expect(itemInputSchema.safeParse({ id: "i1", kind: "info", owner: "gate", title: "t", body: "b" }).success).toBe(true);
  });
});

describe("verdicts", () => {
  it("requires nonce and a known kind", () => {
    const v = { itemId: "w1-1", kind: "issue", text: "seam has a hairline", nonce: "abc",
      context: { url: "http://127.0.0.1:9340/", viewport: [1512, 982], console: [], userAgent: "ua" } };
    expect(verdictInputSchema.safeParse(v).success).toBe(true);
    expect(verdictInputSchema.safeParse({ ...v, kind: "meh" }).success).toBe(false);
    const { nonce, ...noNonce } = v;
    expect(verdictInputSchema.safeParse(noNonce).success).toBe(false);
  });
  it("knows undo and ask", () => {
    const v = { itemId: "w1-1", text: "", nonce: "abc",
      context: { url: "http://127.0.0.1:9340/", viewport: [1512, 982], console: [], userAgent: "ua" } };
    expect(verdictInputSchema.safeParse({ ...v, kind: "undo", option: "Keep it" }).success).toBe(true);
    expect(verdictInputSchema.safeParse({ ...v, kind: "ask", text: "which build is this?" }).success).toBe(true);
  });
  it("leaves `ask` absent on the wire rather than defaulting it to false", () => {
    // It used to default to false, which put `ask: false` beside `kind: "ask"`
    // on every asked card the agent read. It still parses when something sends
    // one, so a pre-0.1.1 verdict is accepted; nothing invents one.
    const v = { itemId: "w1-1", kind: "pass", text: "", nonce: "abc",
      context: { url: "http://127.0.0.1:9340/", viewport: [1512, 982], console: [], userAgent: "ua" } };
    const parsed = verdictInputSchema.parse(v);
    expect("ask" in parsed).toBe(false);
    expect(verdictInputSchema.parse({ ...v, ask: true }).ask).toBe(true);
  });
});

describe("walks + json schema", () => {
  it("accepts a walk input", () => {
    expect(walkInputSchema.parse({ project: "lamppost", title: "Lamppost 2.4", buildRef: "lp-24" }).project).toBe("lamppost");
  });
  it("takes an optional brief, and refuses an empty or oversized one", () => {
    const base = { project: "p", title: "t", buildRef: "b" };
    expect(walkInputSchema.parse(base).brief).toBeUndefined();
    expect(walkInputSchema.parse({ ...base, brief: "Read this first." }).brief).toBe("Read this first.");
    expect(walkInputSchema.safeParse({ ...base, brief: "" }).success).toBe(false);
    expect(walkInputSchema.safeParse({ ...base, brief: "x".repeat(1001) }).success).toBe(false);
  });
  it("exports JSON Schema with the three item kinds", () => {
    const js = toJsonSchema();
    expect(JSON.stringify(js.item)).toContain('"look"');
    expect(JSON.stringify(js.item)).toContain('"question"');
    expect(JSON.stringify(js.item)).toContain('"info"');
  });
});

/**
 * The one wording both halves use for page text a secret-bearing card's verdict
 * may not carry back (secrets review).
 */
describe("redaction", () => {
  it("says the length and nothing else", () => {
    expect(redacted(0)).toBe("(redacted, 0 chars)");
    expect(redacted(24)).toBe("(redacted, 24 chars)");
  });

  it("redacts the saw clause of a blocked line and keeps what the agent itself wrote", () => {
    expect(redactSaw('expect[1] text #shown: wanted "saved", saw "lp_live_4f9c2a7e1d0b8c6e"'))
      .toBe('expect[1] text #shown: wanted "saved", saw "(redacted, 24 chars)"');
    // A value with quotes and newlines in it is still one clause: the regex is
    // anchored at the end of the line, so it takes everything the page showed.
    expect(redactSaw('expect[1] text #x: wanted "a", saw "he said "hi"\nthen left"'))
      .toBe('expect[1] text #x: wanted "a", saw "(redacted, 22 chars)"');
  });

  it("is idempotent, so the daemon's second pass never reports the marker's own length", () => {
    const once = redactSaw('expect[1] text #shown: wanted "saved", saw "lp_live_4f9c2a7e1d0b8c6e"');
    expect(redactSaw(once)).toBe(once);
  });

  it("leaves a line with no saw clause alone", () => {
    expect(redactSaw("the page never answered")).toBe("the page never answered");
    expect(redactSaw('expect[1] url: wanted "/x", saw "/y" and then something')).toBe('expect[1] url: wanted "/x", saw "/y" and then something');
  });
});
