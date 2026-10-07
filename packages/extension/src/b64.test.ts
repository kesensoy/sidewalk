import { describe, it, expect } from "vitest";
import { bytesToBase64 } from "./b64.js";

describe("bytesToBase64", () => {
  it("matches Node's encoder on small, odd-length and empty inputs", () => {
    for (const n of [0, 1, 2, 3, 100, 0x7fff, 0x8000, 0x8001]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });
  it("encodes a screenshot-sized buffer without blowing the stack", () => {
    // 1.5 MB: bigger than any JPEG the worker sends (the body cap is 8 MB, but
    // a 1568-wide JPEG at 0.8 is a few hundred KB). The old spread-into-one-call
    // encoder threw RangeError here.
    const bytes = new Uint8Array(1_500_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131) & 0xff;
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
