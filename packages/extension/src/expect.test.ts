import { describe, it, expect } from "vitest";
import { TEXT_CAP, classifyExpect, describeExpect, evaluateExpect, findTarget } from "./expect.js";

describe("describeExpect", () => {
  // Design language v3 fidelity review: the diagnostic is read at a glance on
  // the orange card, so it is a sentence, not the expectation's JSON.
  const all = [
    { kind: "url" as const, matches: "^https://app\\.example\\.com/demo" },
    { kind: "text" as const, css: "meta[name=build]", attr: "content", equals: "fac3493f" },
    { kind: "present" as const, css: "[data-walk=rim]" },
    { kind: "text" as const, css: "h1", contains: "Walk" },
  ];
  it("names the index, the kind, the selector, what was wanted and what was seen", () => {
    expect(describeExpect(all[1], all, "fix-001")).toBe('expect[2] text meta[name=build] content: wanted "fac3493f", saw "fix-001"');
    expect(describeExpect(all[0], all, "https://app.example.com/")).toBe('expect[1] url: wanted "^https://app\\.example\\.com/demo", saw "https://app.example.com/"');
    expect(describeExpect(all[2], all, "(absent)")).toBe('expect[3] present [data-walk=rim]: wanted "present", saw "(absent)"');
    expect(describeExpect(all[3], all, "Nothing")).toBe('expect[4] text h1: wanted "contains Walk", saw "Nothing"');
  });
  it("still reads when the failed expectation is not in the list, or nothing was seen", () => {
    expect(describeExpect({ kind: "url", matches: "^x" }, [], undefined)).toBe('expect[1] url: wanted "^x", saw ""');
  });
});

const doc = (html: string) => { document.body.innerHTML = html; return document; };
const href = "http://127.0.0.1:9340/";

describe("evaluateExpect", () => {
  it("passes when url, present and text all hold, and reports buildId", () => {
    const d = doc(`<meta name="build" content="abc123"><div data-walk="rim">x</div>`);
    d.head.innerHTML = `<meta name="build" content="abc123">`;
    const r = evaluateExpect(d, href, [
      { kind: "url", matches: "^http://127\\.0\\.0\\.1:9340/?$" },
      { kind: "present", css: "[data-walk=rim]" },
      { kind: "text", css: "meta[name=build]", attr: "content", equals: "abc123" },
    ]);
    expect(r).toEqual({ ok: true, buildId: "abc123" });
  });
  it("fails on the first unmet expectation with what was seen", () => {
    const d = doc(`<div data-walk="rim">x</div>`); d.head.innerHTML = `<meta name="build" content="old">`;
    const r = evaluateExpect(d, href, [{ kind: "text", css: "meta[name=build]", attr: "content", equals: "new" }]);
    expect(r.ok).toBe(false); expect(r.seen).toBe("old"); expect(r.failed).toMatchObject({ kind: "text" });
    expect(evaluateExpect(d, href, [{ kind: "present", css: "#nope" }]).seen).toBe("(absent)");
    expect(evaluateExpect(d, "http://other/", [{ kind: "url", matches: "^http://127" }]).seen).toBe("http://other/");
  });
  it("text.contains matches element text", () => {
    const d = doc(`<h1>Walk ready fac349</h1>`);
    expect(evaluateExpect(d, href, [{ kind: "text", css: "h1", contains: "fac349" }]).ok).toBe(true);
  });

  // Found in review: `{kind:"text", css:"body"}` came back as 3070
  // characters of the page on a pass, which PRIVACY.md said did not happen.
  it("reports at most TEXT_CAP characters of the page, on a pass and on a failure", () => {
    const long = "x".repeat(TEXT_CAP + 500);
    const d = doc(`<p id="long">${long}</p>`);
    const pass = evaluateExpect(d, href, [{ kind: "text", css: "#long", contains: "x" }]);
    expect(pass.ok).toBe(true);
    expect(pass.buildId).toBe("x".repeat(TEXT_CAP));
    const failed = evaluateExpect(d, href, [{ kind: "text", css: "#long", equals: "something else" }]);
    expect(failed.ok).toBe(false);
    expect(failed.seen).toBe("x".repeat(TEXT_CAP));
  });

  it("compares against the whole text, not the first TEXT_CAP characters", () => {
    const d = doc(`<p id="long">${"a".repeat(TEXT_CAP)}b</p>`);
    expect(evaluateExpect(d, href, [{ kind: "text", css: "#long", equals: "a".repeat(TEXT_CAP) }]).ok).toBe(false);
    expect(evaluateExpect(d, href, [{ kind: "text", css: "#long", contains: "b" }]).ok).toBe(true);
  });

  // Found in review: the agent's own string, which `new RegExp` and
  // `querySelector` can both refuse. The content script catches it and answers
  // `badSelector`, which is the only reason this throw is allowed to stand.
  // (happy-dom takes `button:contains("Save")`, the usual jQuery typo, where
  // Chrome refuses it — so the selector here is one both engines refuse.)
  it("throws on a url pattern or a selector the browser will not take", () => {
    const d = doc(`<p>x</p>`);
    expect(() => evaluateExpect(d, href, [{ kind: "url", matches: "(" }])).toThrow();
    expect(() => evaluateExpect(d, href, [{ kind: "present", css: "div >" }])).toThrow();
  });
});

describe("findTarget", () => {
  it("resolves css, walkId and text targets", () => {
    const d = doc(`<p data-walk="a">alpha</p><p>bravo charlie</p>`);
    expect(findTarget(d, { css: "[data-walk=a]" })?.textContent).toBe("alpha");
    expect(findTarget(d, { walkId: "a" })?.textContent).toBe("alpha");
    expect(findTarget(d, { text: "charlie" })?.textContent).toBe("bravo charlie");
    expect(findTarget(d, { text: "zulu" })).toBeNull();
  });
});

describe("classifyExpect", () => {
  it("passes an expectation that held", () => {
    expect(classifyExpect({ ok: true })).toBe("ok");
    expect(classifyExpect({ ok: true, buildId: "fix-001" })).toBe("ok");
  });
  it("blocks when the page answered and an expectation did not hold", () => {
    expect(classifyExpect({ ok: false, failed: { kind: "present", css: "#x" }, seen: "(absent)" })).toBe("blocked");
  });
  it("files nothing when the page never answered at all", () => {
    // Not the same as a failed expectation: nothing was looked at, so a
    // `blocked` verdict here would tell the agent the build was wrong.
    expect(classifyExpect({ ok: false, noAnswer: true, seen: "(no answer from the page: …)" })).toBe("noAnswer");
  });
});
