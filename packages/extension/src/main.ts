import type { ConsoleEntry } from "./protocol.js";

/**
 * MAIN world, document_start. The page's own `console` lives here, not in the
 * isolated world, so this is the only place a load-time error can be seen at
 * all. It keeps nothing: every line is forwarded to the isolated content
 * script as a `walkd:log` DOM event, which owns the ring the panel reads.
 */
declare global { interface Window { __walkdMain?: true } }

if (!window.__walkdMain) {
  window.__walkdMain = true;
  const emit = (level: ConsoleEntry["level"], text: string) => {
    try {
      const detail: ConsoleEntry = { level, text: text.slice(0, 500), at: new Date().toISOString() };
      document.dispatchEvent(new CustomEvent("walkd:log", { detail }));
    } catch {
      // A page that has replaced CustomEvent or document must not break because
      // of us; the walk goes on without that line.
    }
  };
  for (const level of ["error", "warn"] as const) {
    const orig = console[level];
    console[level] = (...a: unknown[]) => {
      emit(level, a.map(x => { try { return String(x); } catch { return "[unprintable]"; } }).join(" "));
      orig.apply(console, a);
    };
  }
  window.addEventListener("error", e => emit("error", `${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", e => emit("error", `unhandled rejection: ${String(e.reason)}`));
}
