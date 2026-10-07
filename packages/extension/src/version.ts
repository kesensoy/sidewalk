/**
 * Whether this pane and the daemon it is talking to are the same release.
 *
 * Chrome updates the extension on its own schedule; the daemon changes only
 * when someone restarts it, and sidewalk-mcp will not replace one that is
 * answering — so the two drift apart in either direction, and a pane that
 * cannot draw an item kind the daemon has, or a daemon that refuses one the
 * pane sends, would otherwise fail in silence. Any difference counts: the
 * one time this bit locally was a minor bump (the `sequence` kind, 0.2.0).
 *
 * An unknown on either side is not a disagreement: a daemon that does not
 * say is not a daemon we can accuse, and the notice is a warning, not a gate.
 */
export function parseVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionsDiffer(daemon: string | null | undefined, mine: string): boolean {
  const a = parseVersion(daemon);
  const b = parseVersion(mine);
  if (!a || !b) return false;
  return a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2];
}
