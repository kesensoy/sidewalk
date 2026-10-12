import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GECKO_ID, SHIM, STRICT_MIN_VERSION, patchManifest } from "./firefox-manifest.mjs";
import { CHROME_ORIGINS, FIREFOX_EXTENSIONS } from "sidewalk-walkd";

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

  it("drops Chrome's key, and keeps the optional permission both browsers ask for", () => {
    const before = chrome();
    const m = patchManifest(before);
    // The Chrome manifest carries the Web Store public key, which is what makes
    // an unpacked build report the store id — and the store id is what the
    // native messaging host lets through. Firefox has no such field: the gecko
    // id above is its identity.
    expect(before.key).toMatch(/^MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A/);
    expect(m.key).toBeUndefined();
    // `nativeMessaging` is optional in both, because a required permission
    // would disable every existing install until the person accepted it again.
    // It is never in `permissions`.
    expect(before.optional_permissions).toEqual(["nativeMessaging"]);
    expect(m.optional_permissions).toEqual(["nativeMessaging"]);
    expect(m.permissions).not.toContain("nativeMessaging");
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
    const touched = ["background", "permissions", "browser_specific_settings", "sidebar_action", "options_ui", "side_panel", "options_page", "action", "key"];
    for (const k of Object.keys({ ...before, ...after })) {
      if (touched.includes(k)) continue;
      expect([k, after[k]]).toEqual([k, before[k]]);
    }
  });
});

/**
 * The native messaging host walkd writes names exactly one extension per
 * browser family, and the browser is what enforces it: an id that does not
 * match is refused with "Access to the specified native messaging host is
 * forbidden" and no second chance. So the two halves have to agree, and this is
 * the only file that can see both.
 *
 * Both halves are live now: walkd writes the manifests naming these two ids,
 * and `src/native.ts` is the panel asking the host they point at.
 */
describe("the ids walkd writes into the native messaging manifests", () => {
  it("names this add-on's gecko id for Firefox", () => {
    expect(FIREFOX_EXTENSIONS).toEqual([GECKO_ID]);
  });

  /**
   * Chrome derives an extension's id from its public key: the SHA-256 of the
   * key's DER bytes, first 16 of them, each hex digit mapped 0→a … f→p. So the
   * `key` in the manifest and the id in `allowed_origins` are checkable against
   * each other rather than taken on trust — and if one is ever changed without
   * the other, the panel is refused by the host with "Access to the specified
   * native messaging host is forbidden" and no second chance.
   */
  it("carries the key the store id is derived from, so the host's allowlist admits an unpacked build", () => {
    const digest = createHash("sha256").update(Buffer.from(chrome().key, "base64")).digest("hex").slice(0, 32);
    const id = [...digest].map(c => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
    expect(CHROME_ORIGINS).toEqual([`chrome-extension://${id}/`]);
  });

  it("names the Chrome Web Store id this extension is listed under", () => {
    // The store id is not in the manifest — Chrome assigns it — so the README's
    // own store link is what it is checked against.
    const readme = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "README.md"), "utf8");
    expect(CHROME_ORIGINS).toHaveLength(1);
    const id = CHROME_ORIGINS[0].replace("chrome-extension://", "").replace("/", "");
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(readme).toContain(`chromewebstore.google.com/detail/sidewalk/${id}`);
    // The trailing slash is part of the format, not decoration.
    expect(CHROME_ORIGINS[0].endsWith("/")).toBe(true);
  });
});
