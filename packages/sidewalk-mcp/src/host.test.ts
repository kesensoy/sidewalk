import { describe, it, expect, beforeEach } from "vitest";
import { VERSION, type NativeReport } from "sidewalk-walkd";
import { hostNeedsRefresh, older, refreshHostIfStale, resetHostRefresh } from "./host.js";

/**
 * The MCP bringing walkd's native messaging host up to its own release.
 *
 * The loop this closes: somebody updates the plugin, the daemon from last week
 * is still answering, this process reuses it — and the host on disk is the one
 * that daemon wrote, which has no stop op. So the pane's *Restart walkd* button
 * would be a press at a host that cannot do it. The host is two files and the
 * version that matters is the version of the code that writes them, which is
 * this process's.
 */
const report = (failed: NativeReport["failed"] = []): NativeReport =>
  ({ dir: "/d/native", hostJs: "/d/native/host.js", wrapper: "/d/native/host", node: "/n", wrote: [], registry: [], skipped: [], failed, registers: true });

const DEFAULT = "/home/someone/Library/Application Support/walkd";

beforeEach(resetHostRefresh);

describe("older", () => {
  it("reads X.Y.Z at every position, and nothing it cannot parse", () => {
    expect(older("1.1.1", "1.2.0")).toBe(true);
    expect(older("0.9.9", "1.0.0")).toBe(true);
    expect(older("1.1.1", "1.1.2")).toBe(true);
    expect(older("1.9.0", "1.10.0")).toBe(true);     // numbers, not strings
    expect(older("1.2.0", "1.2.0")).toBe(false);
    expect(older("1.3.0", "1.2.0")).toBe(false);     // newer than us is not ours to fix
    expect(older("1.10.0", "1.9.0")).toBe(false);
    for (const v of [undefined, null, 3, "", "v1.1.1", "1.1", "1.1.1-beta"]) {
      expect(older(v, "1.2.0"), String(v)).toBe(false);
    }
  });
});

describe("hostNeedsRefresh", () => {
  /**
   * The default data directory and no other, which is the rule the daemon
   * itself follows: the manifests name one wrapper and that wrapper names one
   * state directory, so a daemon on its own data dir owns no registration and
   * must not be able to repoint anybody's browsers. The e2e, a recording and
   * every experiment run on their own.
   */
  it("is an older daemon on the default data dir, and nothing else", () => {
    expect(hostNeedsRefresh("1.1.1", DEFAULT, "1.2.0", DEFAULT)).toBe(true);
    expect(hostNeedsRefresh("1.2.0", DEFAULT, "1.2.0", DEFAULT)).toBe(false);
    expect(hostNeedsRefresh("1.3.0", DEFAULT, "1.2.0", DEFAULT)).toBe(false);
    expect(hostNeedsRefresh(undefined, DEFAULT, "1.2.0", DEFAULT)).toBe(false);
    expect(hostNeedsRefresh("1.1.1", "/tmp/an-experiment", "1.2.0", DEFAULT)).toBe(false);
  });

  it("reads this process's own sidewalk-walkd as the version to be", () => {
    // The dependency's own number, not a string written out here: the whole
    // point is that the host and this process come out of the same release.
    expect(hostNeedsRefresh(VERSION, DEFAULT, undefined, DEFAULT)).toBe(false);
    expect(hostNeedsRefresh("0.0.1", DEFAULT, undefined, DEFAULT)).toBe(true);
  });
});

describe("refreshHostIfStale", () => {
  it("writes the host for an older daemon, with that daemon's own directories", async () => {
    const calls: { dataDir: string; stateDir: string }[] = [];
    const wrote = await refreshHostIfStale({
      daemonVersion: "1.1.1", dataDir: DEFAULT, stateDir: "/s", mine: "1.2.0", theDefault: DEFAULT,
      write: async o => { calls.push(o); return report(); },
    });
    expect(wrote).toBe(true);
    expect(calls).toEqual([{ dataDir: DEFAULT, stateDir: "/s" }]);
  });

  it("does nothing for a daemon that is not older, or one on its own data dir", async () => {
    const calls: unknown[] = [];
    const write = async (o: { dataDir: string; stateDir: string }) => { calls.push(o); return report(); };
    expect(await refreshHostIfStale({ daemonVersion: "1.2.0", dataDir: DEFAULT, stateDir: "/s", mine: "1.2.0", theDefault: DEFAULT, write })).toBe(false);
    expect(await refreshHostIfStale({ daemonVersion: "1.1.1", dataDir: "/tmp/x", stateDir: "/s", mine: "1.2.0", theDefault: DEFAULT, write })).toBe(false);
    expect(calls).toEqual([]);
  });

  /** One host, one process: a second connect in the same session has nothing left to write. */
  it("writes once per process", async () => {
    const calls: unknown[] = [];
    const o = { daemonVersion: "1.1.1", dataDir: DEFAULT, stateDir: "/s", mine: "1.2.0", theDefault: DEFAULT, write: async (x: { dataDir: string; stateDir: string }) => { calls.push(x); return report(); } };
    expect(await refreshHostIfStale(o)).toBe(true);
    expect(await refreshHostIfStale(o)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  /**
   * A host that could not be written is not a reason to fail a session: the
   * agent is waiting on a tool call, and the pane still has *Do it by hand
   * instead* under the button. One line on stderr — the MCP's log, never its
   * protocol — and never a throw.
   */
  it("says so in one line and never throws, whichever way it fails", async () => {
    for (const write of [
      async () => { throw new Error("EACCES, permission denied"); },
      async () => report([{ where: "/d/native", why: "EROFS, read-only file system" }]),
    ]) {
      resetHostRefresh();
      const said: string[] = [];
      await expect(refreshHostIfStale({
        daemonVersion: "1.1.1", dataDir: DEFAULT, stateDir: "/s", mine: "1.2.0", theDefault: DEFAULT,
        write: write as never, warn: l => said.push(l),
      })).resolves.toBe(true);
      expect(said).toHaveLength(1);
      expect(said[0]).toContain("native messaging host could not be brought up to date");
      expect(said[0].endsWith("\n")).toBe(true);
      expect(said[0].split("\n").filter(Boolean)).toHaveLength(1);
    }
  });
});
