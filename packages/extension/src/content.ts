import { evaluateExpect, findTarget } from "./expect.js";
import type { ConsoleEntry, SwToContent } from "./protocol.js";

declare global { interface Window { __walkdConsole?: ConsoleEntry[]; __walkdListening?: true } }

/**
 * The ring the panel reads. Almost everything in it arrives from the MAIN-world
 * script (`main.ts`) over `walkd:log` events — the page's own console is not
 * visible from this isolated world, and the load-time errors that matter most
 * happen long before anything is injected on demand. The isolated wrapper below
 * is kept as well: it costs nothing and catches the case where only this script
 * made it in.
 */
if (!window.__walkdConsole) {
  const ring: ConsoleEntry[] = [];
  window.__walkdConsole = ring;
  const push = (level: "error" | "warn", text: string, at?: string) => {
    ring.push({ level, text: text.slice(0, 500), at: at ?? new Date().toISOString() });
    if (ring.length > 20) ring.shift();
  };
  document.addEventListener("walkd:log", e => {
    const d = (e as CustomEvent<Partial<ConsoleEntry> | undefined>).detail;
    if (!d || (d.level !== "error" && d.level !== "warn")) return;
    push(d.level, String(d.text ?? ""), typeof d.at === "string" ? d.at : undefined);
  });
  for (const level of ["error", "warn"] as const) {
    const orig = console[level];
    console[level] = (...a: unknown[]) => { push(level, a.map(String).join(" ")); orig.apply(console, a); };
  }
  window.addEventListener("error", e => push("error", `${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", e => push("error", `unhandled rejection: ${String(e.reason)}`));
}

// Registered at document_start AND injected on demand into tabs that predate
// the registration, so the same isolated world can run this file twice; one
// listener only, or every ask would be answered twice.
if (!window.__walkdListening) {
  window.__walkdListening = true;
  chrome.runtime.onMessage.addListener((msg: SwToContent, _s, reply) => {
    // Everything below runs on the agent's own strings: an item's `css` and its
    // `url` pattern. `querySelector` and `new RegExp` throw on a string the
    // browser will not take, and a throw out of here killed the port — which the
    // worker read as "the page never answered" and the pane then dropped on the
    // floor, so a one-character typo looked exactly like a page no script may run
    // on (found in review). Now it answers, with the browser's own words.
    try {
      return respond(msg, reply);
    } catch (e) {
      reply({ ok: false, badSelector: (e as Error)?.message ?? String(e) });
      return false;
    }
  });
}

function respond(msg: SwToContent, reply: (r: unknown) => void): boolean {
  if (msg.t === "content:expect") reply(evaluateExpect(document, location.href, msg.expect));
  if (msg.t === "content:console") reply(window.__walkdConsole ?? []);
  if (msg.t === "content:highlight") {
    const el = findTarget(document, msg.target);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      const h = el as HTMLElement;
      const prev = h.style.outline;
      const prevOffset = h.style.outlineOffset;
      h.style.outline = "3px solid #7c3aed";
      h.style.outlineOffset = "3px";
      // The outline lands at once — the press deserves a snap — then breathes:
      // out, in, out, in, out, in the kerb's rhythm (1.6 s each way, the
      // pane's own easing), and it is gone. The owner, 2026-09-22: "when the page
      // flips to one with it it's hard to notice it's trying to grab my
      // attention" — a still outline on a page you have just landed on is one
      // more rectangle; and a fade-in "is wayy too slow bc there's no snappy
      // response to the button". Reduced motion keeps the still four seconds.
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || typeof h.animate !== "function";
      const restore = () => { h.style.outline = prev; h.style.outlineOffset = prevOffset; };
      if (still) setTimeout(restore, 4000);
      else {
        const on = "rgba(124,58,237,1)", off = "rgba(124,58,237,0)";
        const a = h.animate({ outlineColor: [on, off, on, off, on, off] }, { duration: 8000, easing: "cubic-bezier(.45,0,.55,1)", fill: "forwards" });
        a.onfinish = a.oncancel = restore;
      }
    }
    reply({ found: Boolean(el) });
  }
  return false;
}
