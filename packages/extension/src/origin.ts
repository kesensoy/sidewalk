/**
 * The match patterns a walk's `look` items need, worked out from their URLs.
 *
 * `<all_urls>` is a required host permission, so there is nothing to ask for
 * and nothing to check: the only question left is what patterns to register
 * the content scripts against, which is a walk's own origins and nothing else.
 *
 * Origins, not hosts, since this release. Everything below was measured on
 * Chromium 151 on 2026-10-12, with `chrome.scripting.registerContentScripts`
 * driven from a real service worker:
 *
 * - **A port in a pattern is honoured exactly.** `http://127.0.0.1:9401/*`
 *   registers and fires on 9401 and on nothing else; a page on 9402 gets no
 *   script. The eTLD rule an earlier note repeated — that patterns cannot
 *   carry ports — is not what this browser does.
 * - **A scheme wildcard and a port cannot be combined.** `*://host:port/*` is
 *   refused outright: *"has invalid value for matches[0]: Invalid port."* So
 *   the scheme is always written out, which it is here anyway.
 * - **`127.0.0.1` and `localhost` are different hosts to the matcher**, in both
 *   directions. A walk is registered for the origin it actually names and
 *   nothing is inferred from one loopback name to the other.
 * - **`:*` is not worth writing.** It is accepted and then silently normalised
 *   to a pattern with no port at all, which already means every port.
 * - **`host_permissions` gate injection, not registration.** A pattern outside
 *   them registers cleanly and then injects nothing, with no error anywhere.
 *   `<all_urls>` covers every pattern this can produce, which is what keeps
 *   that silent failure out of reach.
 *
 * Why it matters that the port is kept: a walk of an app on one port used to
 * register its console capture for every port on that host, so a different app
 * of the person's on 127.0.0.1 — anything at all, in any tab they opened while
 * the walk was open — got two content scripts it had nothing to do with.
 */

/**
 * The pattern for one URL: its scheme, its host, its port if the URL names one,
 * and `/*`. A URL on a scheme's default port has no port of its own to keep —
 * `new URL("https://x/").port` is empty — and a pattern without one matches
 * every port, which for 443 is the same set of pages that scheme can serve.
 */
export function patternOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}/*`;
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
