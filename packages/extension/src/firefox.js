/**
 * The two things Firefox needs, and nothing else.
 *
 * Plain JavaScript on purpose: it is not bundled, not type-checked against
 * `@types/chrome` (whose `chrome` is not assignable), and not an entry point —
 * `build.mjs` copies it beside the bundles rather than through esbuild.
 * `scripts/firefox-manifest.mjs` puts it ahead of `sw.js` in the event page's
 * `background.scripts`; `panel.html` loads it ahead of `panel.js`, because the
 * second half below is only about the worker but the file has to be one file.
 *
 * In Chrome every line is skipped, so the Chrome zip carries about thirty dead
 * lines. That is the price of one file instead of a second patched copy of
 * `panel.html`, and it is why the Chrome build's behaviour cannot change:
 * `browser` is not defined there, and the function returns on its first line.
 *
 * **What is deliberately not here.** There is no `chrome` → `browser` shim.
 * Firefox's MV3 `chrome.*` namespace returns promises, so the worker's and the
 * pane's `await chrome.storage.local.get(…)` resolve on their own ("In
 * Manifest V3, Firefox supports promises for asynchronous events in the
 * `chrome.*` namespace" — the MV3 migration guide). An earlier draft assigned
 * `globalThis.chrome = browser`; it worked, and it was load-bearing for
 * nothing. `scripts/firefox-check.mjs` is what proves that each time.
 */
(() => {
  if (typeof browser === "undefined") return;                 // Chrome: nothing to do

  // 1. There is no `chrome.sidePanel` in Firefox.
  //
  // The worker's one call asks Chrome to open the side panel when the toolbar
  // button is pressed. Firefox has no such setting — the button below is what
  // arranges it — so the stub exists only so the `onInstalled` listener does
  // not throw on its way past.
  if (!chrome.sidePanel) chrome.sidePanel = { setPanelBehavior: async () => {} };

  // 2. The toolbar button opens the sidebar.
  //
  // The Firefox manifest keeps `action`, so the button and its unread badge
  // are the same ones Chrome has (`sidebarAction` has no badge of its own).
  // What it does not keep is Chrome's `openPanelOnActionClick`, so the press
  // has to be carried here.
  //
  // `toggle()` is the first thing in the handler and nothing is awaited before
  // it: Firefox counts this as a user action only while the handler has not
  // yet waited on a promise, and an `open()` after an `await` is refused.
  chrome.action?.onClicked.addListener(() => {
    void Promise.resolve(chrome.sidebarAction.toggle()).catch(() => {});
  });
})();
