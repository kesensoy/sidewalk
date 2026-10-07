/**
 * The Chrome manifest, as Firefox needs it.
 *
 * A patch at package time rather than a second manifest in the tree, which is
 * how two earlier add-ons' packagers both do it: one source of
 * truth, and the Chrome artifact never carries a key Chrome would complain
 * about. This file is a pure function so the shape can be pinned by a test
 * (`firefox-manifest.test.ts`) instead of by reading a zip.
 *
 * Every change below answers something `web-ext lint` says about the Chrome
 * manifest. Run it (`npm run package` does) and the list should be empty of
 * manifest findings; if Mozilla adds one, it belongs here with its code in the
 * comment, the way these are.
 */

/**
 * The add-on's identity on AMO. `ADDON_ID_REQUIRED`: Mozilla needs an id for
 * every MV3 submission, it is permanent once a version is published under it,
 * and the first upload claims it.
 *
 * The email shape is the one the owner's earlier add-ons use,
 * `<name>@kesensoy.github.io`, so this is `sidewalk@kesensoy.github.io`:
 * same owner, same pattern, and a GUID
 * would say nothing a person could read. It is not an address anyone sends
 * mail to; AMO only requires the form.
 */
export const GECKO_ID = "sidewalk@kesensoy.github.io";

/**
 * The oldest Firefox this build is claimed to run on.
 *
 * The pane's own floor is 128: `scripting.registerContentScripts` takes
 * `world: "MAIN"` from there, and the MAIN-world half of the console capture
 * (`main.js`) is registered that way for every walk. Below it the registration
 * is refused, the worker logs it and carries on, and the person gets a walk
 * with no load-time console lines.
 *
 * The number is 140 because of the key above it. `web-ext lint` on 128 says
 * `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION`: *"strict_min_version requires
 * Firefox 128, which was released before version 140 introduced support for
 * browser_specific_settings.gecko.data_collection_permissions"* — and that key
 * is required of every new AMO submission. Declaring 128 would promise the
 * add-on to browsers that cannot read its own data disclosure. 140 is an ESR,
 * so the floor is still a long-lived one.
 *
 * One warning survives this and is expected: Firefox for Android wants 142 for
 * the same key. sidewalk is a desktop side panel — Android has no sidebar —
 * and the AMO listing is submitted for desktop only, so the floor is not
 * raised to 142 to quiet a platform the add-on does not claim.
 */
export const STRICT_MIN_VERSION = "140.0";

/** The file `src/firefox.js` is published as, ahead of `sw.js`. */
export const SHIM = "firefox.js";

/**
 * Firefox's copy of the manifest. Takes the parsed Chrome manifest, returns a
 * new object; the input is not touched.
 */
export function patchManifest(chrome) {
  const m = structuredClone(chrome);

  // `ADDON_ID_REQUIRED`, and `MISSING_DATA_COLLECTION_PERMISSIONS`.
  //
  // `required: ["none"]` is the honest answer and not a convenience: Mozilla's
  // categories are about data that reaches the developer, and nothing sidewalk
  // handles leaves the machine. The screenshots and the console tails go to a
  // daemon on 127.0.0.1 that the person is running themselves; there is no
  // server of ours for them to reach. If that ever stops being true this key
  // is the first thing that has to change.
  m.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: STRICT_MIN_VERSION,
      data_collection_permissions: { required: ["none"] },
    },
  };

  // `BACKGROUND_SERVICE_WORKER_NOFALLBACK`. Firefox runs the background as an
  // event page, and AMO's validator refuses a manifest that offers it no
  // `scripts` to run. The shim goes first because it is what points `chrome`
  // at the promise namespace `sw.js` awaits on every line.
  //
  // `service_worker` is dropped rather than left beside `scripts`: Firefox
  // ignores it and the validator says so out loud, and an earlier add-on removed
  // it for exactly that warning. `type: "module"` goes with it — esbuild's
  // bundles have no import or export left in them (checked: `grep` finds none
  // in `dist/*.js`), so they load as classic scripts, and a classic background
  // is the shape Firefox has supported longest.
  m.background = { scripts: [SHIM, "sw.js"] };

  // `MANIFEST_PERMISSIONS: Invalid permissions "sidePanel"`. There is no such
  // permission in Firefox; the sidebar needs none.
  m.permissions = m.permissions.filter(p => p !== "sidePanel");

  // The pane itself. Chrome's `side_panel.default_path` and Firefox's
  // `sidebar_action.default_panel` name the same `panel.html`.
  //
  // `action` stays. Firefox does not put a second toolbar button there for a
  // sidebar — the sidebar is reached from Firefox's own sidebar launcher — so
  // keeping it costs nothing and keeps the unread badge, which `sidebarAction`
  // has no equivalent for. `src/firefox.js` §2 is what makes pressing it open
  // the pane, since Firefox has no `openPanelOnActionClick`.
  //
  // `open_at_install` is left at its default of true: a sidebar nobody can
  // find is the first thing a new person hits, and Firefox opening it once on
  // install is the documented answer to that.
  delete m.side_panel;
  m.sidebar_action = {
    default_panel: "panel.html",
    default_title: m.name,
    default_icon: m.icons,
  };

  // Firefox's key is `options_ui`. `open_in_tab` because the pane is a tall
  // narrow column and about:addons' options frame is neither.
  delete m.options_page;
  m.options_ui = { page: "panel.html", open_in_tab: true };

  // `navigator.clipboard.writeText` is what the secrets row's Copy button
  // calls. Chrome allows it from a user gesture in an extension page; Firefox
  // wants the permission named. It is one of the permissions Firefox installs
  // without a prompt, so it costs the person nothing and buys the button.
  if (!m.permissions.includes("clipboardWrite")) m.permissions.push("clipboardWrite");

  return m;
}
