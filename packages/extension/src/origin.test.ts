import { describe, it, expect } from "vitest";
import { matchPatterns, patternOf } from "./origin.js";

describe("patternOf", () => {
  /**
   * Measured on Chromium 151, 2026-10-12: a port in a `matches` pattern is
   * honoured exactly — the 9401 script ran on 9401 and not on 9402 — so the
   * port is kept rather than dropped. A walk of an app on one port no longer
   * registers its content scripts for every other port on that host.
   */
  it("keeps the port, because a pattern with one matches that port alone", () => {
    expect(patternOf("http://127.0.0.1:9340/other.html?x=1")).toBe("http://127.0.0.1:9340/*");
    expect(patternOf("http://localhost:3000/")).toBe("http://localhost:3000/*");
    expect(patternOf("https://app.example.com:8443/x")).toBe("https://app.example.com:8443/*");
  });

  /**
   * A URL on its scheme's default port has no port of its own — `new
   * URL("https://x/").port` is the empty string — and a pattern with no port
   * matches every port, which for 443 is every page that scheme serves there.
   */
  it("writes no port when the URL names none", () => {
    expect(patternOf("https://app.example.com/")).toBe("https://app.example.com/*");
    expect(patternOf("http://app.example.com/a/b")).toBe("http://app.example.com/*");
    expect(patternOf("https://app.example.com:443/")).toBe("https://app.example.com/*");
    expect(patternOf("http://app.example.com:80/")).toBe("http://app.example.com/*");
  });

  /**
   * The one shape Chrome refuses is a scheme wildcard beside a port —
   * `*://127.0.0.1:9401/*` is rejected with "Invalid port." — so the scheme is
   * always written out. It always was here; this is what holds it that way.
   */
  it("always names the scheme", () => {
    for (const url of ["http://127.0.0.1:9340/", "https://app.example.com/"]) {
      expect(patternOf(url)).toMatch(/^https?:\/\//);
      expect(patternOf(url)).not.toContain("*://");
    }
  });

  it("has no pattern for anything that is not http(s)", () => {
    expect(patternOf("chrome://extensions")).toBeNull();
    expect(patternOf("file:///tmp/x.html")).toBeNull();
    expect(patternOf("not a url")).toBeNull();
  });
});

describe("matchPatterns", () => {
  it("dedupes the origins a walk points at and sorts them", () => {
    expect(matchPatterns([
      "https://app.example.com/",
      "https://app.example.com/demo",
      "http://127.0.0.1:9340/other.html",
      "http://127.0.0.1:9340/",
    ])).toEqual(["http://127.0.0.1:9340/*", "https://app.example.com/*"]);
  });

  /**
   * Two ports on one host are two origins, and `127.0.0.1` and `localhost` are
   * two hosts to the matcher (measured: a `127.0.0.1:9401` pattern does not
   * fire on `localhost:9401`, or the other way about). Nothing here infers one
   * from the other — a walk gets the origins it named.
   */
  it("keeps two ports on one host apart, and the two loopback names apart", () => {
    expect(matchPatterns(["http://127.0.0.1:9342/a", "http://127.0.0.1:9402/b"]))
      .toEqual(["http://127.0.0.1:9342/*", "http://127.0.0.1:9402/*"]);
    expect(matchPatterns(["http://127.0.0.1:9342/a", "http://localhost:9342/a"]))
      .toEqual(["http://127.0.0.1:9342/*", "http://localhost:9342/*"]);
  });

  it("leaves out a url no content script could ever run on", () => {
    expect(matchPatterns(["chrome://extensions", "https://app.example.com/"])).toEqual(["https://app.example.com/*"]);
    expect(matchPatterns([])).toEqual([]);
  });
});
