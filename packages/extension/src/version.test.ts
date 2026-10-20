import { describe, it, expect } from "vitest";
import { olderHalf, parseVersion, patchOnly } from "./version.js";

describe("versions", () => {
  it("parses X.Y.Z and nothing else", () => {
    expect(parseVersion("0.3.0")).toEqual([0, 3, 0]);
    expect(parseVersion("10.2.33")).toEqual([10, 2, 33]);
    expect(parseVersion("0.3")).toBeNull();
    expect(parseVersion("v0.3.0")).toBeNull();
    expect(parseVersion("0.3.0-beta")).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(3)).toBeNull();
  });
  /**
   * The direction, because the remedy is the opposite thing in the two cases:
   * a walkd that is behind is stopped and the agent's MCP starts a current one;
   * a panel that is behind is updated, and stopping the daemon would do nothing
   * at all.
   */
  it("names which half is behind, at every position, and nothing over an unknown", () => {
    expect(olderHalf("0.2.0", "0.3.0")).toBe("walkd");
    expect(olderHalf("0.4.0", "0.3.0")).toBe("panel");
    expect(olderHalf("1.0.0", "0.9.9")).toBe("panel");     // major outranks the rest
    expect(olderHalf("0.9.9", "1.0.0")).toBe("walkd");
    expect(olderHalf("1.1.1", "1.1.2")).toBe("walkd");     // a patch apart, and still a direction
    expect(olderHalf("1.1.2", "1.1.1")).toBe("panel");
    // Numbers, not strings: 10 is after 9.
    expect(olderHalf("1.10.0", "1.9.0")).toBe("panel");
    expect(olderHalf("0.3.0", "0.3.0")).toBeNull();
    expect(olderHalf(null, "0.3.0")).toBeNull();
    expect(olderHalf(undefined, "0.3.0")).toBeNull();
    expect(olderHalf("garbage", "0.3.0")).toBeNull();
    expect(olderHalf("0.3.0", "garbage")).toBeNull();
  });

  /** A patch apart is still said, and said without the line about not understanding each other. */
  it("knows a patch-only difference from every other kind", () => {
    expect(patchOnly("1.1.1", "1.1.2")).toBe(true);
    expect(patchOnly("1.1.2", "1.1.1")).toBe(true);
    expect(patchOnly("1.1.1", "1.2.1")).toBe(false);
    expect(patchOnly("1.1.1", "2.1.1")).toBe(false);
    expect(patchOnly("1.1.1", "1.1.1")).toBe(false);       // not a difference at all
    expect(patchOnly(null, "1.1.1")).toBe(false);
  });
});
