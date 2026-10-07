import { describe, it, expect } from "vitest";
import { parseVersion, versionsDiffer } from "./version.js";

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
  it("differs in either direction, and never over an unknown", () => {
    expect(versionsDiffer("0.2.0", "0.3.0")).toBe(true);   // daemon older
    expect(versionsDiffer("0.4.0", "0.3.0")).toBe(true);   // pane older
    expect(versionsDiffer("0.3.1", "0.3.0")).toBe(true);   // a patch apart still differs
    expect(versionsDiffer("0.3.0", "0.3.0")).toBe(false);
    expect(versionsDiffer(null, "0.3.0")).toBe(false);
    expect(versionsDiffer(undefined, "0.3.0")).toBe(false);
    expect(versionsDiffer("garbage", "0.3.0")).toBe(false);
  });
});
