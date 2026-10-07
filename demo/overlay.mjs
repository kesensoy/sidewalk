/**
 * A pointer you can see, in the page.
 *
 * The take used to lean on Playwright's `screencast.showActions`, which draws
 * its own pointer, a click mark, a highlight box — and an action title,
 * `Mouse move`, `Click`, in the corner, with no way to turn the title off while
 * keeping the pointer. Worse, it animates **between action points on its own
 * clock**, so it did not go where `demo/hand.mjs` sends the real pointer: the owner
 * saw two pointers disagreeing with each other and neither of them easing. It
 * is gone. The cut draws the pointer from `timeline.json`'s cursor track.
 *
 * But a raw take still has to be watchable by a person deciding whether it is
 * worth cutting, so this puts a pointer **in the DOM of both surfaces**, which
 * means it is in the footage like anything else the page draws, exactly where
 * the hand is, with no second clock to disagree with.
 *
 * It is ours rather than `ghost-cursor`'s `installMouseHelper`, for a reason
 * that has nothing to do with taste: that function is written against
 * **Puppeteer** — it calls `page.evaluateOnNewDocument` and
 * `page.removeScriptToEvaluateOnNewDocument`, neither of which exists on a
 * Playwright `Page` (the Playwright spellings are `addInitScript` and
 * `removeAllInitScripts`), so it throws on contact. Its own README also says
 * *"Use for debugging only"*, and its dot is 20 px of translucent grey rather
 * than something that reads as a cursor on camera.
 *
 * Three things about it that are not decoration:
 *
 * - **`pointer-events: none`, `position: fixed`, appended last.** It cannot
 *   intercept a click, cannot move anything, and cannot change a layout. The
 *   pane's only structural CSS selectors are `.item…:last-child`, which are
 *   about list items, not about body's children.
 * - **It puts itself back.** The pane rebuilds its card list from the daemon's
 *   stream; a MutationObserver re-appends the overlay if a rerender takes it.
 * - **It can be hidden.** The beat stills are documentation, so the pointer is
 *   put away before `page.screenshot` and shown again after — the same dance
 *   `showActions` needed, for the same reason.
 *
 * One thing it does land in, and this is deliberate: the extension photographs
 * the active tab with `chrome.tabs.captureVisibleTab` when a verdict is filed,
 * and that is a real render of the site page, so the overlay is in those
 * verdict screenshots. See `demo/README.md` § The cursor — those pictures are
 * the demo launcher's own, they reach neither the footage nor the stills nor
 * the cut, a cursor in a screenshot of where the person was looking is not
 * wrong, and `--no-overlay` removes the overlay from the whole take anyway.
 */

import { RING_MS } from "./pace.mjs";

/**
 * The whole of it, as one function the page runs. No closure: this is
 * stringified and evaluated in the page, so it may not read anything from here
 * — which is why the ring's duration is an argument and not an import.
 */
const OVERLAY = (ringMs = 500) => {
  // Installed twice on purpose (see `installOverlay`), so a second run must not
  // build a second pointer — it just makes sure the one there is still in the
  // document. Two roots would be two arrows exactly on top of each other, and
  // only one of them would answer `hide()`.
  if (window.__demoCursor) { window.__demoCursor.attach(); return; }
  const root = document.createElement("div");
  root.id = "__demo-cursor";
  root.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none";
  root.innerHTML =
    '<svg width="22" height="30" viewBox="0 0 22 30" aria-hidden="true" style="position:absolute;left:0;top:0;overflow:visible;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">' +
    '<path d="M2 1.5 L2 22 L7.2 17.2 L10.7 25.8 L14.2 24.3 L10.8 16 L17.6 16 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  let x = -100, y = -100;
  const place = () => { root.style.transform = `translate(${x}px,${y}px)`; };
  place();
  addEventListener("mousemove", e => { x = e.clientX; y = e.clientY; place(); }, true);
  // A ring where the press landed, for `RING_MS`. Appended to the overlay, so
  // it travels with the pointer's own containing block and needs no
  // coordinates. It was 300 ms, which is less time than the eye needs to get
  // there — ~200 ms to program the saccade and 230-330 ms for the first
  // fixation — so the ring was routinely gone before it was looked at.
  // Playwright's own `showActions.duration` default is 500 ms; so is ours.
  addEventListener("mousedown", () => {
    const ring = document.createElement("div");
    ring.style.cssText = "position:absolute;left:-13px;top:-13px;width:26px;height:26px;border-radius:50%;border:2px solid #111;background:rgba(255,255,255,.35)";
    root.appendChild(ring);
    const done = () => ring.remove();
    // `.finished` is the one that fires on a tab that is being composited. The
    // timer is the belt: the pane is a background tab on purpose, and a tab
    // nobody is looking at does not always tick an animation to its end — a
    // ring left up for ever would be worse than one that lingers.
    if (typeof ring.animate === "function") ring.animate([{ transform: "scale(.35)", opacity: 0.95 }, { transform: "scale(1.6)", opacity: 0 }], { duration: ringMs, easing: "ease-out" }).finished.then(done, done);
    setTimeout(done, ringMs * 2);
  }, true);
  // `document` and not `document.documentElement`: an init script runs at
  // document_start, where there is no documentElement yet and `observe` throws
  // "parameter 1 is not of type 'Node'" — which took the rest of the function
  // with it, so `__demoCursor` was never set and `hide()` quietly did nothing.
  // The pointer was in every beat still of the take that caught this.
  const attach = () => { if (!root.isConnected && document.body) document.body.appendChild(root); };
  if (document.body) attach();
  else addEventListener("DOMContentLoaded", attach, { once: true });
  new MutationObserver(attach).observe(document, { childList: true, subtree: true });
  window.__demoCursor = {
    attach,
    hide: () => { root.style.display = "none"; },
    show: () => { root.style.display = ""; },
  };
};

/** Run it in the document that is open now, if there is one that will have it. */
const paint = page => page.evaluate(OVERLAY, RING_MS).catch(() => { /* about:blank, or mid-navigation */ });

/**
 * Put the overlay on a page, now and after every navigation it makes.
 *
 * `addInitScript` is the half that survives the site's six navigations.
 * `paint` is the half that covers a document that is already open — which is
 * the panel's case, because the pane is navigated to its `chrome-extension://`
 * page and nothing in Playwright's own tests says an init script reaches one.
 * Both are idempotent, so calling this again after a `goto` is free.
 */
export async function installOverlay(page) {
  await page.addInitScript(OVERLAY, RING_MS);
  await paint(page);
}

/** Make sure the document open right now has it — after a `goto`, say. */
export const repaintOverlay = paint;

/** Show or hide it on every surface at once. A page without it is no error. */
export async function setOverlay(pages, visible) {
  await Promise.all(pages.map(p => p
    .evaluate(on => { const c = window.__demoCursor; if (c) on ? c.show() : c.hide(); }, visible)
    .catch(() => { /* no overlay on this page, nothing to show or hide */ })));
}
