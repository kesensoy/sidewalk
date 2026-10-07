import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GECKO_ID, SHIM, STRICT_MIN_VERSION, patchManifest } from "./firefox-manifest.mjs";

/**
 * The real manifest, not a fixture: every assertion below is about what
 * actually ships, and a fixture would go stale the first time a permission
 * moved. Each case names the `web-ext lint` finding it is standing in for, so
 * a change that reintroduces one fails here before it reaches a zip.
 */
const chrome = () => JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "manifest.json"), "utf8"));

describe("patchManifest", () => {
  it("leaves the Chrome manifest alone", () => {
    const before = chrome();
    patchManifest(before);
    expect(before).toEqual(chrome());
  });

  it("answers ADDON_ID_REQUIRED and MISSING_DATA_COLLECTION_PERMISSIONS", () => {
    const { gecko } = patchManifest(chrome()).browser_specific_settings;
    expect(gecko.id).toBe(GECKO_ID);
    expect(gecko.strict_min_version).toBe(STRICT_MIN_VERSION);
    expect(gecko.data_collection_permissions).toEqual({ required: ["none"] });
  });

  it("answers BACKGROUND_SERVICE_WORKER_NOFALLBACK with the shim ahead of the worker", () => {
    const { background } = patchManifest(chrome());
    expect(background.scripts).toEqual([SHIM, "sw.js"]);
    // Firefox ignores it and the validator says so; and the shim has to run
    // first or `sw.js` awaits a callback namespace.
    expect(background.service_worker).toBeUndefined();
    expect(background.type).toBeUndefined();
  });

  it("answers MANIFEST_PERMISSIONS by dropping sidePanel, and keeps the rest", () => {
    const m = patchManifest(chrome());
    expect(m.permissions).not.toContain("sidePanel");
    for (const p of ["tabs", "activeTab", "scripting", "storage", "alarms"]) expect(m.permissions).toContain(p);
    // The secrets row's Copy button. Chrome takes the user gesture; Firefox
    // wants it named.
    expect(m.permissions).toContain("clipboardWrite");
    // `<all_urls>` is the one the listing has to justify, in both stores. It
    // is not something a Firefox patch may quietly narrow.
    expect(m.host_permissions).toEqual(["<all_urls>"]);
  });

  it("moves the pane from a side panel to a sidebar, and the options page with it", () => {
    const m = patchManifest(chrome());
    expect(m.side_panel).toBeUndefined();
    expect(m.sidebar_action.default_panel).toBe("panel.html");
    expect(m.options_page).toBeUndefined();
    expect(m.options_ui).toEqual({ page: "panel.html", open_in_tab: true });
    // `action` survives: it carries the unread badge, which `sidebarAction`
    // has no equivalent for, and Firefox adds no second toolbar button for a
    // sidebar. `src/firefox.js` §2 is what makes pressing it open the pane.
    expect(m.action).toEqual(chrome().action);
  });

  it("changes nothing else", () => {
    const before = chrome();
    const after = patchManifest(before);
    const touched = ["background", "permissions", "browser_specific_settings", "sidebar_action", "options_ui", "side_panel", "options_page", "action"];
    for (const k of Object.keys({ ...before, ...after })) {
      if (touched.includes(k)) continue;
      expect([k, after[k]]).toEqual([k, before[k]]);
    }
  });
});
