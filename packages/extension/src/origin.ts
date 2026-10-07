/**
 * The match patterns a walk's `look` items need, worked out from their URLs.
 *
 * `<all_urls>` is a required host permission, so there is nothing to ask for
 * and nothing to check: the only question left is what patterns to register
 * the content scripts against, which is a walk's own hosts and nothing else.
 * Hosts, not origins: a pattern carries no port (see `patternOf`), so a walk
 * pointed at one port on a host registers for every port on it.
 */

/**
 * Chrome match patterns carry no port — `http://127.0.0.1/*` is every port on
 * that host — so the port is dropped here rather than handed to Chrome, which
 * would refuse the pattern outright.
 */
export function patternOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/** The de-duplicated, sorted patterns for a set of item URLs. */
export function matchPatterns(urls: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    const p = patternOf(u);
    if (p) out.add(p);
  }
  return [...out].sort();
}
