import { describe, it, expect } from "vitest";
import { DEFAULT_PORT, TOKEN_KEY, connectedKey, daemonBase, parsePort, parseToken } from "./port.js";

describe("parsePort", () => {
  it("takes a whole port number", () => {
    expect(parsePort(8761)).toBe(8761);
    expect(parsePort(1)).toBe(1);
    expect(parsePort(65535)).toBe(65535);
  });

  it("takes the same number written as a string", () => {
    // chrome.storage round-trips JSON, but a person editing it by hand — the
    // README tells them how to read this storage — types a string.
    expect(parsePort("8761")).toBe(8761);
    expect(parsePort(" 8761 ")).toBe(8761);
  });

  it("falls back to 8760 for anything that is not a port", () => {
    for (const bad of [undefined, null, "", "eight", 0, -1, 70000, 8761.5, NaN, Infinity, {}, [], true])
      expect(parsePort(bad)).toBe(DEFAULT_PORT);
  });

  it("builds the base the daemon answers on", () => {
    expect(daemonBase(8761)).toBe("http://127.0.0.1:8761");
    expect(daemonBase(DEFAULT_PORT)).toBe("http://127.0.0.1:8760");
  });

  it("names the per-port first-answer key", () => {
    expect(connectedKey(8760)).toBe("walkd:connected:8760");
    expect(connectedKey(8761)).toBe("walkd:connected:8761");
  });
});

/**
 * The token the person pastes into the gear (secrets review). The daemon
 * writes it to a file; an extension cannot read files, so this is the one thing
 * about the connection that is carried across by hand.
 */
describe("parseToken", () => {
  it("takes a token and trims what a terminal copy brings with it", () => {
    expect(parseToken("abc_123-xyz")).toBe("abc_123-xyz");
    expect(parseToken("abc\n")).toBe("abc");
    expect(parseToken("  abc  ")).toBe("abc");
  });

  it("reads anything that is not a string as no token at all", () => {
    for (const bad of [undefined, null, 0, 1, {}, [], true, NaN]) expect(parseToken(bad)).toBe("");
    expect(parseToken("   ")).toBe("");
  });

  it("is kept beside the port, and not per port", () => {
    expect(TOKEN_KEY).toBe("walkd:token");
  });
});
