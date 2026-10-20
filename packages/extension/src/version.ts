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

/**
 * Which half is behind, when they are not the same release.
 *
 * The direction is the whole of what a person can act on, and the pane got it
 * wrong in one of the two cases for a year: it said to stop walkd either way,
 * which is right only when walkd is the old one — a plugin update pinned a
 * newer MCP, the old daemon kept running, and the MCP reuses whatever answers.
 * When the panel is the old one the daemon has already been replaced and
 * stopping it changes nothing; the extension is what has to catch up.
 *
 * `null` for a match and for anything unreadable on either side, which is the
 * same posture `versionsDiffer` has always had: a daemon that does not say is
 * not a daemon we can accuse.
 */
export type OldHalf = "walkd" | "panel";

export function olderHalf(daemon: string | null | undefined, mine: string): OldHalf | null {
  const a = parseVersion(daemon);
  const b = parseVersion(mine);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? "walkd" : "panel";
  return null;
}

/**
 * Do they differ only in the patch number?
 *
 * Nothing in the contract has ever moved on a patch — the one difference that
 * bit locally was a minor bump (the `sequence` kind, 0.2.0) — so the notice is
 * still shown, because drift is worth knowing about, and it is said without the
 * line about not understanding each other. This is not a compatibility table
 * and must not become one: it is the difference between a warning and a worry.
 */
export function patchOnly(daemon: string | null | undefined, mine: string): boolean {
  const a = parseVersion(daemon);
  const b = parseVersion(mine);
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] !== b[2];
}
