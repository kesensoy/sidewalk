import { describe, it, expect } from "vitest";
import { DEFAULT_SCALE, DEFAULT_SHOTS, SCALES, SHOTS, applyScale, nextScale, shotsOf } from "./settings.js";

describe("text size", () => {
  // The owner, first hands-on use: "font size too small. maybe settings top right
  // and text +- as first setting?"
  it("starts at 100 and steps through the ladder", () => {
    expect(DEFAULT_SCALE).toBe(100);
    expect(SCALES).toEqual([80, 90, 100, 110, 125, 150]);
    expect(nextScale(100, 1)).toBe(110);
    expect(nextScale(110, 1)).toBe(125);
    expect(nextScale(100, -1)).toBe(90);
    expect(nextScale(90, -1)).toBe(80);
  });

  it("stops at both ends rather than wrapping", () => {
    expect(nextScale(150, 1)).toBe(150);
    expect(nextScale(80, -1)).toBe(80);
  });

  it("is reversible", () => {
    for (const s of SCALES.slice(1, -1)) {
      expect(nextScale(nextScale(s, 1), -1)).toBe(s);
      expect(nextScale(nextScale(s, -1), 1)).toBe(s);
    }
  });

  it("steps off the nearest rung when storage hands back something odd", () => {
    // A hand-edited preference, or a ladder that changed under a saved value.
    expect(nextScale(103, 1)).toBe(110);
    expect(nextScale(103, -1)).toBe(90);
    expect(nextScale(1000, -1)).toBe(125);
    expect(nextScale(0, 1)).toBe(90);
  });

  it("lands on the root as a multiplier, not as a font size", () => {
    applyScale(document, 125);
    expect(document.documentElement.style.getPropertyValue("--scale")).toBe("1.25");
    applyScale(document, 80);
    expect(document.documentElement.style.getPropertyValue("--scale")).toBe("0.8");
  });
});

// The owner: "should we make post-answer screenshots a disable-able option in
// settings? … or maybe a 3rd option of 'on issues only'."
describe("the screenshot setting", () => {
  it("offers three, and takes every verdict as the default", () => {
    expect(SHOTS).toEqual(["always", "issues", "never"]);
    expect(DEFAULT_SHOTS).toBe("always");
    for (const s of SHOTS) expect(shotsOf({ scale: 100, shots: s })).toBe(s);
  });

  it("reads a preference saved before it existed as every verdict", () => {
    // The pane has had `walkd:ui` since the text size shipped; those objects
    // have a scale and nothing else, and silently not taking a picture is the
    // one thing this setting must never do by accident.
    expect(shotsOf({ scale: 125 })).toBe("always");
    expect(shotsOf(undefined)).toBe("always");
    expect(shotsOf({})).toBe("always");
  });

  it("reads anything else as every verdict too", () => {
    for (const odd of [{ shots: "off" }, { shots: "" }, { shots: 3 }, { shots: null }, "issues", 7, null]) {
      expect(shotsOf(odd)).toBe("always");
    }
  });
});
