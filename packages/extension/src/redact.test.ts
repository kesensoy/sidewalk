import { describe, it, expect } from "vitest";
import { ABSENT, carriesSecrets, redactContext, redactSeen } from "./redact.js";
import { describeExpect } from "./expect.js";
import type { VerdictInput } from "sidewalk-walkd/schema";

const KEY = "lp_live_4f9c2a7e1d0b8c6e";                 // 24 characters
const ctx = (over: Partial<VerdictInput["context"]> = {}): VerdictInput["context"] => ({
  url: "http://127.0.0.1:9342/settings", viewport: [1280, 800], userAgent: "ua", console: [], ...over,
});

/**
 * F5 of the 2026-10-04 audit, in the pane. The `file` form of a secret exists so
 * an agent that must not hold a value never sees one; the page is the hole in
 * that, and these are the three fields it leaks through.
 */
describe("redaction on a card that carries a secret", () => {
  it("knows which cards it applies to", () => {
    expect(carriesSecrets({ secrets: [{ label: "Licence key", value: KEY }] })).toBe(true);
    expect(carriesSecrets({ secrets: [] })).toBe(false);
    expect(carriesSecrets({})).toBe(false);
    expect(carriesSecrets(undefined)).toBe(false);
  });

  it("reports what a failed expectation saw as its length, so the blocked line says how and not what", () => {
    const all = [{ kind: "text" as const, css: "#shown", equals: "saved" }];
    const line = describeExpect(all[0], all, redactSeen(KEY));
    expect(line).toBe('expect[1] text #shown: wanted "saved", saw "(redacted, 24 chars)"');
    expect(line).not.toContain(KEY);
  });

  it("keeps the pane's own words: an element that is not there is not something the page said", () => {
    expect(redactSeen(ABSENT)).toBe(ABSENT);
    expect(redactSeen(undefined)).toBeUndefined();
    expect(redactSeen("")).toBe("(redacted, 0 chars)");
  });

  it("redacts buildId and every console line's text, and keeps the level and the time", () => {
    const out = redactContext(ctx({
      buildId: KEY,
      console: [
        { level: "warn", text: `key accepted: ${KEY}`, at: "2026-10-04T00:00:00.000Z" },
        { level: "error", text: "boom", at: "2026-10-04T00:00:01.000Z" },
      ],
    }));
    expect(out.buildId).toBe("(redacted, 24 chars)");
    expect(out.console).toEqual([
      { level: "warn", text: "(redacted, 38 chars)", at: "2026-10-04T00:00:00.000Z" },
      { level: "error", text: "(redacted, 4 chars)", at: "2026-10-04T00:00:01.000Z" },
    ]);
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("leaves a context with nothing to redact as it was, buildId absent and all", () => {
    const bare = ctx();
    expect(redactContext(bare)).toEqual(bare);
    expect(redactContext(bare)).not.toHaveProperty("buildId");
  });

  it("does not touch the screenshot: that is the person's own setting", () => {
    const out = redactContext(ctx({ screenshotBase64: "aaaa", screenshotError: "off: screenshots set to never" }));
    expect(out.screenshotBase64).toBe("aaaa");
    expect(out.screenshotError).toBe("off: screenshots set to never");
  });

  /**
   * SW-2 of the 2026-10-06 audit: the url is read off the live tab at verdict
   * time, so a page that puts the pasted value in a query string or a fragment
   * was handing it back whole, into verdicts.jsonl and to the agent. Which page
   * the verdict is about is what the field is for, and that survives the cut.
   */
  it("cuts the url to its origin and path, so a key the page put in a query string does not ride along", () => {
    const out = redactContext(ctx({ url: `http://127.0.0.1:9342/settings?key=${KEY}#token=${KEY}` }));
    expect(out.url).toBe("http://127.0.0.1:9342/settings");
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("leaves a url with nothing to cut exactly as it was, and cuts a string it cannot parse all the same", () => {
    expect(redactContext(ctx()).url).toBe("http://127.0.0.1:9342/settings");
    expect(redactContext(ctx({ url: "" })).url).toBe("");
    expect(redactContext(ctx({ url: `about:blank?k=${KEY}` })).url).toBe("about:blank");
  });
});
