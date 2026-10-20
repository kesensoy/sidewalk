import { afterEach, describe, expect, it, vi } from "vitest";
import { ASK, ASK_PAGE, ASK_TIMEOUT_MS, CONNECT_FLAG, CONNECT_FLAG_MS, HOST_NAME, NATIVE_PERMISSION, STALE_WORKER, adopt, armConnect, armedFlag, askHost, askStop, canAskHere, hasNativePermission, reasonOf, takeArmed, type Area, type Asked } from "./native.js";

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

  /**
   * The panel that drew the Connect button is older than the grant and has no
   * method of its own, so it borrows one from a hidden frame (`freshRuntime`)
   * and hands it here. The call and every rule about the answer are the same;
   * only the object the method hangs off changes — and `lastError` is read off
   * that same object, because the parent's is about something else entirely.
   */
  it("asks through whatever runtime it is handed, and reads that one's lastError", async () => {
    // This context has no method at all: the real field shape.
    stub({ api: false });
    const calls: { host: string; message: unknown }[] = [];
    const frame = {
      sendNativeMessage: (host: string, message: unknown) => { calls.push({ host, message }); return Promise.resolve({ ok: true, port: 8761, token: "through-the-frame" }); },
    } as unknown as typeof chrome.runtime;
    expect(await askHost(8761)).toEqual({ ok: false, reason: "noApi" });
    expect(await askHost(8761, ASK_TIMEOUT_MS, frame)).toEqual({ ok: true, port: 8761, token: "through-the-frame" });
    expect(calls).toEqual([{ host: HOST_NAME, message: ASK }]);

    const failing = {
      sendNativeMessage: () => Promise.reject("not an Error at all"),
      lastError: { message: "Specified native messaging host not found." },
    } as unknown as typeof chrome.runtime;
    expect(await askHost(8761, ASK_TIMEOUT_MS, failing)).toEqual({ ok: false, reason: "noHost", said: "Specified native messaging host not found." });
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
 * The *Restart walkd* press, from the panel's side. The host's own half — the
 * four steps it takes and the refusals it makes — is pinned in walkd's
 * `native.test.ts`, by running the program.
 */
describe("askStop", () => {
  it("names the port it means, and takes the host's word that the daemon went away", async () => {
    const calls = stub({ reply: { ok: true, stopped: true } });
    expect(await askStop(8761)).toEqual({ ok: true });
    expect(calls).toEqual([{ host: HOST_NAME, message: { t: "stop", port: 8761 } }]);
  });

  /**
   * The compatibility trap, and the reason the answer carries a marker at all.
   *
   * Every host up to 1.1.1 read nothing off the frame and answered the token to
   * any message it was sent, so a stop request against one comes back
   * `{ok: true, port, token}`. Taking `ok` as the answer would have the pane
   * saying a daemon went away that is still running — and the person waiting
   * for a pane that never changes. This is the end that puts the by-hand words
   * on screen instead.
   */
  it("refuses a 1.1.1 host's token answer rather than calling it a stop", async () => {
    stub({ reply: { ok: true, port: 8761, token: "the-token-it-always-answers-with" } });
    const r = await askStop(8761);
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "unknown" });
    expect((r as { said?: string }).said).toContain("older than this panel");
  });

  it("carries the host's own reason when it answers that it will not", async () => {
    for (const reason of ["unknownOp", "something else answers on 8761", "this host is registered for walkd on 8760"]) {
      stub({ reply: { ok: false, reason } });
      expect(await askStop(8761)).toEqual({ ok: false, reason: "hostRefused", said: reason });
    }
  });

  it("is the same feature detection, and the same bound on a host that never answers", async () => {
    stub({ api: false });
    expect(await askStop(8761)).toEqual({ ok: false, reason: "noApi" });

    vi.useFakeTimers();
    stub({ hang: true });
    const asked = askStop(8761, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await asked).toEqual({ ok: false, reason: "timeout" });
  });

  it("reads the browser's own refusals the way the token ask does", async () => {
    stub({ fail: new Error("Specified native messaging host not found.") });
    expect(await askStop(8761)).toEqual({ ok: false, reason: "noHost", said: "Specified native messaging host not found." });
    for (const reply of [undefined, null, "a string", { stopped: true }]) {
      stub({ reply });
      expect((await askStop(8761)).ok, JSON.stringify(reply ?? null)).toBe(false);
    }
  });

  /** The frame path, for the same reason Connect has one: this page may hold the permission and have no method. */
  it("asks through whatever runtime it is handed", async () => {
    stub({ api: false });
    const calls: { host: string; message: unknown }[] = [];
    const frame = {
      sendNativeMessage: (host: string, message: unknown) => { calls.push({ host, message }); return Promise.resolve({ ok: true, stopped: true }); },
    } as unknown as typeof chrome.runtime;
    expect(await askStop(8761, ASK_TIMEOUT_MS, frame)).toEqual({ ok: true });
    expect(calls).toEqual([{ host: HOST_NAME, message: { t: "stop", port: 8761 } }]);
  });
});

/**
 * The three Chromium 151 sentences, verbatim, and Firefox's own wording. Four
 * causes collapse into the first string — no manifest, a `path` that is not
 * there, a relative `path`, a name nobody registered — so nothing can tell them
 * apart, and the pane says one line for every reason here.
 */
describe("reasonOf", () => {
  it("knows the sentences a browser says", () => {
    expect(reasonOf("Specified native messaging host not found.")).toBe("noHost");
    expect(reasonOf("Access to the specified native messaging host is forbidden.")).toBe("forbidden");
    expect(reasonOf("Native host has exited.")).toBe("hostExited");
    // Firefox has no separate wording for a host that will not take this
    // add-on: a host that is not on disk and a host whose manifest does not
    // list it both say this, so `forbidden` collapses into `noHost` there.
    expect(reasonOf("No such native application sh.sidewalk.walkd")).toBe("noHost");
    expect(reasonOf("An unexpected error occurred")).toBe("unknown");
    expect(reasonOf(undefined)).toBe("unknown");
  });
});

/**
 * The host is a process the browser launches, so an answer arrives after a
 * gap — and the pane can have moved in it. These are the three ways a good
 * answer is still the wrong one to store, each of them a case the pane got
 * wrong before review caught it.
 */
describe("adopt", () => {
  const good: Asked = { ok: true, port: 8761, token: "the-hosts-token" };
  const now = (over: Partial<{ port: number; token: string; needsToken: boolean }> = {}) =>
    ({ port: 8761, token: "", needsToken: false, ...over });

  it("takes an answer about the daemon the pane is on", () => {
    expect(adopt(good, now())).toBe(good);
    // A pane being refused is the case this whole path exists for.
    expect(adopt(good, now({ token: "the-old-one", needsToken: true }))).toBe(good);
  });

  it("hands a failure straight back", () => {
    const failed: Asked = { ok: false, reason: "noHost" };
    expect(adopt(failed, now())).toBe(failed);
  });

  it("drops an answer for a daemon the pane has left while the host was answering", () => {
    const r = adopt(good, now({ port: 8765 }));
    expect(r).toEqual({ ok: false, reason: "wrongPort", said: "the pane moved to another port while the host was answering" });
  });

  it("never overwrites a token that is working: a paste can win the race", () => {
    const r = adopt(good, now({ token: "pasted-and-accepted" }));
    expect(r).toEqual({ ok: false, reason: "superseded", said: "the pane is in with a token of its own" });
    // Unless the daemon is refusing what they pasted, in which case the host's
    // answer is the whole point.
    expect(adopt(good, now({ token: "pasted-and-refused", needsToken: true }))).toBe(good);
  });

  /**
   * `walkd token --rotate` under a running daemon: the daemon keeps serving the
   * token in its memory and the host reads the new one off disk, so the host
   * hands over a token that daemon will never accept. Storing it a second time
   * writes an unchanged value, Chromium reports no `onChanged` for that,
   * nothing retargets — and the next refusal asks the host again. This is what
   * ends that.
   */
  it("ends the episode when the host's token is the one already refused", () => {
    const r = adopt(good, now({ token: good.token, needsToken: true }));
    expect(r).toEqual({ ok: false, reason: "refusedToken", said: "the host's token is the one already refused" });
  });
});

/**
 * The field case this whole second path exists for, measured in the owner's own
 * Chrome on 2026-10-18: after a real grant on the real store build,
 * `permissions.contains` is true in every context while
 * `chrome.runtime.sendNativeMessage` is still undefined in the service worker
 * and in the panel page that drew the button. A side panel closed and opened
 * again had it. So holding the permission is not the question — this is, asked
 * per context.
 */
describe("canAskHere", () => {
  it("is about this context and not about the permission", () => {
    stub({ permission: true, api: false });
    expect(canAskHere()).toBe(false);
    stub({ permission: false, api: true });
    expect(canAskHere()).toBe(true);
  });

  it("frames a page of ours that build.mjs copies", () => {
    // `build.mjs` copies it beside `panel.html`; a rename here without one there
    // is a frame that loads nothing and a press that falls back to a reload.
    expect(ASK_PAGE).toBe("ask.html");
  });

  it("names what a stale worker should say out loud", () => {
    // "no API" and "no host" are otherwise the same word to whoever is reading
    // the console, and they want opposite things of them.
    expect(STALE_WORKER).toContain("after the worker restarts");
  });
});

/** A `chrome.storage` area as a plain object, with its calls counted. */
function area(seed: Record<string, unknown> = {}) {
  const held: Record<string, unknown> = { ...seed };
  const calls: string[] = [];
  const a: Area = {
    get: async k => { calls.push(`get ${k}`); return k in held ? { [k]: held[k] } : {}; },
    set: async items => { calls.push(`set ${Object.keys(items).join(",")}`); Object.assign(held, items); },
    remove: async k => { calls.push(`remove ${k}`); delete held[k]; },
  };
  return { a, held, calls };
}

describe("the flag a press leaves behind when the panel has to reload", () => {
  it("carries the port it was about and the time it was made", async () => {
    const { a, held } = area();
    await armConnect(a, 8761, 1000);
    expect(held[CONNECT_FLAG]).toEqual({ port: 8761, at: 1000 });
    expect(CONNECT_FLAG).toBe("walkd:connect-after-reload");
  });

  it("is read once and cleared, whether or not it was any use", async () => {
    const { a, held, calls } = area({ [CONNECT_FLAG]: { port: 8761, at: 1000 } });
    expect(await takeArmed(a, 1500)).toEqual({ port: 8761, at: 1000 });
    expect(held[CONNECT_FLAG]).toBeUndefined();
    expect(calls).toEqual([`get ${CONNECT_FLAG}`, `remove ${CONNECT_FLAG}`]);
    // A second load has nothing to act on, and nothing to clear.
    const again = area();
    expect(await takeArmed(again.a, 1500)).toBeNull();
    expect(again.calls).toEqual([`get ${CONNECT_FLAG}`]);
  });

  it("will not make a panel opened tomorrow ask the host out of nowhere", async () => {
    const stale = area({ [CONNECT_FLAG]: { port: 8761, at: 1000 } });
    expect(await takeArmed(stale.a, 1000 + CONNECT_FLAG_MS + 1)).toBeNull();
    // Cleared all the same: a flag nobody can use is not a flag to keep.
    expect(stale.held[CONNECT_FLAG]).toBeUndefined();
    expect(CONNECT_FLAG_MS).toBe(10_000);
  });

  it("takes nothing it cannot read", () => {
    for (const raw of [undefined, null, 1, "x", {}, { port: 8761 }, { at: 1000 }, { port: "8761", at: 1000 }, { port: 8761, at: 1.5 }]) {
      expect(armedFlag(raw, 1500), JSON.stringify(raw ?? null)).toBeNull();
    }
    // A clock that moved backwards under a stored flag is not ours to act on.
    expect(armedFlag({ port: 8761, at: 50_000 }, 1500)).toBeNull();
    expect(armedFlag({ port: 8761, at: 1500 }, 1500)).toEqual({ port: 8761, at: 1500 });
  });

  it("is never a throw, whatever storage does", async () => {
    const broken: Area = { get: async () => { throw new Error("no storage"); }, set: async () => {}, remove: async () => {} };
    expect(await takeArmed(broken, 1500)).toBeNull();
  });
});
