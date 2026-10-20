import { VERSION, defaultDataDir, writeNativeHost, type NativeReport } from "sidewalk-walkd";

/**
 * Bringing walkd's native messaging host up to this release without touching
 * the daemon that is running.
 *
 * The case, and it is the common one: somebody updates the plugin, so the MCP
 * on disk is current — and the daemon from last week is still answering, which
 * means this process reuses it rather than starting the version it ships. The
 * pane then says walkd is the older half and offers *Restart walkd*, which asks
 * walkd's native messaging **host** to stop it. But the host on disk is the one
 * that old daemon wrote, and a host older than 1.2.0 has no stop op at all: it
 * answers the token to any message, the pane cannot take that for a stop, and
 * the person is sent to a terminal for the one press that was meant to spare
 * them one.
 *
 * The host is not the daemon, though. It is two small files in the data
 * directory, rewritten from scratch at every `walkd serve`, and the version
 * that matters is the version of the code that writes them — which here is this
 * process's own `sidewalk-walkd` dependency. So an MCP that meets an older
 * daemon refreshes the host and leaves the daemon alone. Nothing about the
 * running daemon changes; the manifests are rewritten with identical contents,
 * and `host.js` and the wrapper become this release's.
 *
 * **Only on the default data directory**, which is the same rule the daemon
 * itself follows for the same reason: the manifests name one wrapper and that
 * wrapper names one state directory, so a `--data-dir /tmp/somewhere` daemon
 * owns no registration and must not be able to repoint the browsers. An
 * experiment, a recording and the e2e all run on their own data dirs.
 */

/** Is `theirs` an earlier release than `mine`? False unless both are read, which is the warning's own posture. */
export function older(theirs: unknown, mine: string): boolean {
  const parse = (v: unknown): [number, number, number] | null => {
    if (typeof v !== "string") return null;
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(theirs);
  const b = parse(mine);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/**
 * Is the host on disk one this process should replace?
 *
 * The daemon's version is what says so: a daemon older than this
 * `sidewalk-walkd` wrote a host older than it too, because the two are written
 * together at every start. A daemon the same age or newer wrote a host that is
 * the same or better, and this process has nothing to add.
 */
export function hostNeedsRefresh(daemonVersion: unknown, dataDir: string, mine = VERSION, theDefault = defaultDataDir()): boolean {
  return dataDir === theDefault && older(daemonVersion, mine);
}

/** Once per process: a second connect in one session has nothing left to write. */
let done = false;

/** For the tests, which run several connects in one process. */
export function resetHostRefresh(): void { done = false; }

export type RefreshOptions = {
  daemonVersion: unknown;
  dataDir: string;
  stateDir: string;
  /** The writer. walkd's own unless a test hands over another; nothing in the product does. */
  write?: (o: { dataDir: string; stateDir: string }) => Promise<NativeReport>;
  mine?: string;
  theDefault?: string;
  warn?: (line: string) => void;
};

/**
 * Refresh the host if it is worth refreshing, and never let that cost the
 * connection.
 *
 * Best effort throughout, the way the daemon's own call is: the agent is
 * waiting on a tool, the pane still has *Do it by hand instead* under the
 * button, and a host that could not be written is not a reason to fail a
 * session. Every failure is one line on stderr — the MCP's log, never its
 * protocol — and `WALKD_NATIVE_ROOT` is honoured because `writeNativeHost`
 * reads it for itself.
 */
export async function refreshHostIfStale(o: RefreshOptions): Promise<boolean> {
  if (done) return false;
  if (!hostNeedsRefresh(o.daemonVersion, o.dataDir, o.mine, o.theDefault)) return false;
  done = true;
  const warn = o.warn ?? ((line: string) => process.stderr.write(line));
  try {
    const report = await (o.write ?? writeNativeHost)({ dataDir: o.dataDir, stateDir: o.stateDir });
    if (report.failed.length) warn(`sidewalk: walkd's native messaging host could not be brought up to date (${report.failed[0].why}). The panel's Restart walkd button will ask you to stop walkd yourself.\n`);
    return true;
  } catch (e) {
    warn(`sidewalk: walkd's native messaging host could not be brought up to date (${(e as Error)?.message ?? String(e)}). The panel's Restart walkd button will ask you to stop walkd yourself.\n`);
    return true;
  }
}
