import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK, ASK_TIMEOUT_MS, HOST_NAME, NATIVE_PERMISSION, askHost, hasNativePermission, reasonOf } from "./native.js";

/**
 * The host is a program the browser launches, so there is nothing of it to run
 * here. What a test can hold is the half this file is: the feature detection,
 * the port guard, and the three sentences a browser says when it will not make
 * the call.
 *
 * Every string below was read off a real browser on 2026-10-12 (the
 * verification report behind this release), not written from documentation.
 */

/** A `chrome` with only what these functions touch. */
function stub({ permission = true, api = true, reply = undefined as unknown, fail = undefined as unknown, hang = false, contains = undefined as unknown } = {}) {
  const calls: { host: string; message: unknown }[] = [];
  const runtime: Record<string, unknown> = { lastError: undefined };
  if (api) {
    runtime.sendNativeMessage = (host: string, message: unknown) => {
      calls.push({ host, message });
      if (hang) return new Promise(() => {});
      if (fail !== undefined) return Promise.reject(fail);
      return Promise.resolve(reply);
    };
  }
  (globalThis as { chrome?: unknown }).chrome = {
    runtime,
    permissions: {
      contains: async (p: { permissions: string[] }) => {
        if (typeof contains === "function") return (contains as (p: unknown) => unknown)(p);
        return p.permissions.every(x => x === NATIVE_PERMISSION) && permission;
      },
    },
  };
  return calls;
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe("hasNativePermission", () => {
  it("asks for the one permission, and takes no for an answer", async () => {
    stub({ permission: true });
    expect(await hasNativePermission()).toBe(true);
    stub({ permission: false });
    expect(await hasNativePermission()).toBe(false);
  });

  it("is false, not a throw, in a browser that cannot answer", async () => {
    stub({ contains: () => { throw new Error("no permissions API here"); } });
    expect(await hasNativePermission()).toBe(false);
    // And with no `chrome.permissions` at all.
    (globalThis as { chrome?: unknown }).chrome = { runtime: {} };
    expect(await hasNativePermission()).toBe(false);
  });
});

describe("askHost", () => {
  it("sends one frame to walkd's host and takes the token it answers with", async () => {
    const calls = stub({ reply: { ok: true, port: 8761, token: "  a-token\n" } });
    expect(await askHost(8761)).toEqual({ ok: true, port: 8761, token: "a-token" });
    expect(calls).toEqual([{ host: HOST_NAME, message: ASK }]);
    expect(HOST_NAME).toBe("sh.sidewalk.walkd");
  });

  /**
   * The guard this whole function is written around. One host serves the
   * machine and answers about whichever daemon owns the registration, so a pane
   * on another port must never adopt that token: it would be sent to a daemon
   * that never issued it, refused, and the person told to paste a token the
   * pane had already replaced behind their back.
   */
  it("drops an answer about another daemon than the one this pane is on", async () => {
    stub({ reply: { ok: true, port: 8760, token: "the-other-daemons-token" } });
    const r = await askHost(8761);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "wrongPort" });
    expect((r as { said?: string }).said).toContain("8760");
  });

  it("is a feature detection, because the function does not exist until the permission is held", async () => {
    stub({ api: false });
    expect(await askHost(8761)).toEqual({ ok: false, reason: "noApi" });
  });

  it("carries the host's own reason when it answers that it has nothing", async () => {
    stub({ reply: { ok: false, reason: "no walkd is running" } });
    expect(await askHost(8761)).toEqual({ ok: false, reason: "hostRefused", said: "no walkd is running" });
  });

  it("refuses an answer in a shape it does not know", async () => {
    for (const reply of [undefined, null, "a string", { ok: true, port: 8761 }, { ok: true, port: 8761, token: "   " }, { ok: true, port: "8761", token: "t" }]) {
      stub({ reply });
      expect((await askHost(8761)).ok, JSON.stringify(reply ?? null)).toBe(false);
    }
  });

  it("gives up rather than leaving the pane asking for as long as it is open", async () => {
    vi.useFakeTimers();
    stub({ hang: true });
    const asked = askHost(8761, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await asked).toEqual({ ok: false, reason: "timeout" });
    expect(ASK_TIMEOUT_MS).toBe(5_000);
  });

  it("reads the browser's refusal off the rejection, and off lastError when there is nothing else", async () => {
    stub({ fail: new Error("Specified native messaging host not found.") });
    expect(await askHost(8761)).toEqual({ ok: false, reason: "noHost", said: "Specified native messaging host not found." });

    stub({ fail: "not an Error at all" });
    (globalThis as { chrome: { runtime: { lastError?: unknown } } }).chrome.runtime.lastError = { message: "Native host has exited." };
    expect(await askHost(8761)).toEqual({ ok: false, reason: "hostExited", said: "Native host has exited." });
  });
});

/**
 * The three Chromium 151 sentences, verbatim, and Firefox's own words for two
 * of the same failures. Four causes collapse into the first string — no
 * manifest, a `path` that is not there, a relative `path`, a name nobody
 * registered — so nothing can tell them apart, and the pane says one line for
 * every reason here.
 */
describe("reasonOf", () => {
  it("knows the sentences a browser says", () => {
    expect(reasonOf("Specified native messaging host not found.")).toBe("noHost");
    expect(reasonOf("Access to the specified native messaging host is forbidden.")).toBe("forbidden");
    expect(reasonOf("Native host has exited.")).toBe("hostExited");
    // Firefox words the same two failures differently.
    expect(reasonOf("No such native application sh.sidewalk.walkd")).toBe("noHost");
    expect(reasonOf("An unexpected error occurred")).toBe("unknown");
    expect(reasonOf(undefined)).toBe("unknown");
  });
});
