import { describe, it, expect } from "vitest";
import { matchPatterns, patternOf } from "./origin.js";

describe("patternOf", () => {
  it("drops the port, because Chrome match patterns have none", () => {
    expect(patternOf("http://127.0.0.1:9340/other.html?x=1")).toBe("http://127.0.0.1/*");
    expect(patternOf("https://app.example.com/")).toBe("https://app.example.com/*");
  });
  it("has no pattern for anything that is not http(s)", () => {
    expect(patternOf("chrome://extensions")).toBeNull();
    expect(patternOf("file:///tmp/x.html")).toBeNull();
    expect(patternOf("not a url")).toBeNull();
  });
});

describe("matchPatterns", () => {
  it("dedupes the hosts a walk points at and sorts them", () => {
    expect(matchPatterns([
      "https://app.example.com/",
      "https://app.example.com/demo",
      "http://127.0.0.1:9340/other.html",
    ])).toEqual(["http://127.0.0.1/*", "https://app.example.com/*"]);
  });
  it("leaves out a url no content script could ever run on", () => {
    expect(matchPatterns(["chrome://extensions", "https://app.example.com/"])).toEqual(["https://app.example.com/*"]);
    expect(matchPatterns([])).toEqual([]);
  });
});
