/**
 * Where the daemon is listening.
 *
 * 8760 unless this browser has been told otherwise: the worker reads
 * `walkd:port` out of `chrome.storage.local` at startup and again whenever it
 * changes. That exists so a second daemon can be walked next to the one you
 * already have running — the e2e starts its own on 8761 rather than asking you
 * to stop yours — and it is the only thing in the extension that decides the
 * daemon's address.
 */
export const DEFAULT_PORT = 8760;
export const PORT_KEY = "walkd:port";

/**
 * A stored port, or the default. Anything that is not a whole port number —
 * absent, a string that is not a number, 0, 70000, a float — is not a port, and
 * a pane that refused to connect over a bad storage value would be a pane with
 * no way back. So the default is the answer to every bad value, not an error.
 */
export function parsePort(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_PORT;
  return n;
}

export const daemonBase = (port: number): string => `http://127.0.0.1:${port}`;

/**
 * Where the worker writes down that a daemon on this port has answered, once
 * ever, in this profile. The pane's first-run note is for a port that never
 * has; a daemon that is down right now on a port that once answered gets the
 * "Looking for walkd" line instead. Per port, so pointing the browser at a
 * port nobody has ever served on is a first run for that port.
 */
export const connectedKey = (port: number): string => `walkd:connected:${port}`;

/**
 * The daemon's token, kept across restarts, pasted in by hand (audit
 * 2026-10-04, F1).
 *
 * The daemon writes it to a file in its data dir and an extension cannot read
 * files, so this is the one thing about the connection the person carries across
 * themselves: the pane's gear takes it, it is kept beside the port in
 * `chrome.storage.local`, and the worker sends it on every request. A restart
 * changes nothing, so the paste is asked for once; `walkd token --rotate` is the
 * only thing that makes the stored one stale.
 *
 * Not per port, unlike the first-answer mark: one profile talks to one daemon at
 * a time, and a token remembered per port would be a stale token the moment that
 * daemon's token was rotated.
 */
export const TOKEN_KEY = "walkd:token";

/**
 * A stored token, or the empty string for none. Trimmed, because a token copied
 * out of a terminal brings a newline with it, and a token with a newline is a
 * token refused for a reason nobody can see. Anything that is not a string is
 * nothing — the way a bad port is the default: the pane says it needs the token
 * and the gear is right there.
 */
export function parseToken(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}
