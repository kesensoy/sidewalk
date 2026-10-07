import { describe, it, expect } from "vitest";
import { shouldFileBlocked } from "./blocked.js";
import type { Verdict } from "sidewalk-walkd/schema";

const diag = 'expect failed: {"kind":"text","css":"meta[name=build]","attr":"content","equals":"fix-999"}; seen: fix-002';
const item = { id: "stale" };
const v = (itemId: string, kind: Verdict["kind"], text: string, seq: number): Verdict =>
  ({ itemId, kind, text, nonce: `n${seq}`, seq, at: "", context: { url: "", viewport: [1, 1], console: [], userAgent: "", screenshot: null } });

describe("a blocked item pressed again", () => {
  // The owner's first walk filed seqs 4, 5 and 6 as three identical `blocked`
  // verdicts, because Go files one every time and nothing looked first.
  it("files the first one", () => {
    expect(shouldFileBlocked(item, [], diag)).toBe(true);
  });

  it("does not file the same diagnostic twice", () => {
    expect(shouldFileBlocked(item, [v("stale", "blocked", diag, 4)], diag)).toBe(false);
    expect(shouldFileBlocked(item, [v("stale", "blocked", diag, 4), v("stale", "blocked", diag, 5)], diag)).toBe(false);
  });

  it("files it when what failed changed", () => {
    // The build moved, or a later expectation is the one failing now: that is
    // news, and the agent needs it.
    expect(shouldFileBlocked(item, [v("stale", "blocked", diag, 4)], diag.replace("fix-002", "fix-003"))).toBe(true);
  });

  it("files the same diagnostic again once a Go has passed in between", () => {
    // The page caught up, then fell back: that is news, not a duplicate.
    expect(shouldFileBlocked(item, [v("stale", "blocked", diag, 4)], diag, 4)).toBe(true);
    expect(shouldFileBlocked(item, [v("stale", "blocked", diag, 4), v("stale", "blocked", diag, 6)], diag, 4)).toBe(false);
  });

  it("is per item", () => {
    expect(shouldFileBlocked(item, [v("other", "blocked", diag, 4)], diag)).toBe(true);
  });

  it("is not satisfied by some other kind of verdict", () => {
    expect(shouldFileBlocked(item, [v("stale", "issue", diag, 7)], diag)).toBe(true);
  });
});
