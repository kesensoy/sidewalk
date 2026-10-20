import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  CHROME_ORIGINS, FIREFOX_EXTENSIONS, HOST_NAME, HOST_SCRIPT, NATIVE_ROOT_ENV, NOT_OURS, batEscape,
  defaultSource, manifest, manifestName, nativeLine, nativeRoots, nativeStatus, registersBrowsers,
  regPath, registryTargets, removeNativeHost, shEscape, targets, wrapperName, wrapperPaths, wrapperText,
  writeNativeHost,
} from "./native.js";
import { defaultDataDir } from "./paths.js";

/**
 * Every test here writes under its own temp directory and nothing else. The
 * roots an un-overridden run would use are the person's real browser profiles,
 * so `WALKD_NATIVE_ROOT` (and the explicit `roots` option) is not a convenience
 * here — it is the whole reason a test suite may touch this code at all.
 */
let tmp: string;
let dataDir: string;
let stateDir: string;
const roots = () => nativeRoots({ [NATIVE_ROOT_ENV]: path.join(tmp, "home") });
/**
 * Roots with no override, for the Windows cases only.
 *
 * On win32 `targets()` is empty — a browser there reads a registry value, not a
 * folder — so this touches no file under the real home, and `reg` is stubbed in
 * every case that uses it, so it touches no real key either. It is the only way
 * to reach the registry path at all: under an overridden root that path is
 * skipped by design, which is the whole point of H1.
 */
const realRoots = () => nativeRoots({});
/**
 * What `reg.exe query <key> /ve` prints back: a blank line, the key in its long
 * form, then the value indented under it in three columns, CRLF throughout. The
 * user name has a space in it on purpose — `C:\\Users\\Ada Lovelace\\…` is the
 * case the Windows field check of 2026-10-19 was run under.
 */
const regQueryOutput = (key: string, file: string): string =>
  `\r\n${key.replace("HKCU", "HKEY_CURRENT_USER")}\r\n    (Default)    REG_SZ    C:\\Users\\Ada Lovelace\\AppData\\Local\\walkd\\native\\${file}\r\n\r\n`;

const read = async (f: string) => JSON.parse(await fs.readFile(f, "utf8"));
const exists = (f: string) => fs.stat(f).then(() => true, () => false);

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-native-"));
  dataDir = path.join(tmp, "data");
  stateDir = path.join(dataDir, "state");
  await fs.mkdir(stateDir, { recursive: true });
});
afterEach(() => fs.rm(tmp, { recursive: true, force: true }));

/** The browser directory a real browser would have made. */
const makeVendor = (v: string) => fs.mkdir(v, { recursive: true });

describe("where the manifests go", () => {
  it("is every Chromium fork's own folder, plus Mozilla's, on a Mac", () => {
    const r = nativeRoots({ [NATIVE_ROOT_ENV]: "/h" });
    const t = targets("darwin", r);
    expect(t.map(x => x.browser)).toEqual([
      "Chrome", "Chrome Beta", "Chrome Canary", "Chromium", "Brave", "Edge", "Edge Beta", "Vivaldi", "Arc", "Firefox",
    ]);
    expect(t.find(x => x.browser === "Chrome")!.dir).toBe("/h/Library/Application Support/Google/Chrome/NativeMessagingHosts");
    expect(t.find(x => x.browser === "Brave")!.dir).toBe("/h/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts");
    expect(t.find(x => x.browser === "Arc")!.dir).toBe("/h/Library/Application Support/Arc/User Data/NativeMessagingHosts");
    // Firefox's leaf is the Chromium family's with different spelling on Linux
    // and the same spelling here; its vendor folder is Mozilla's, not a browser's.
    expect(t.find(x => x.browser === "Firefox")!.dir).toBe("/h/Library/Application Support/Mozilla/NativeMessagingHosts");
    expect(t.every(x => x.dir.startsWith(x.vendor))).toBe(true);
  });

  it("is under the config directory on Linux, except Firefox, which is under the home", () => {
    const r = nativeRoots({ [NATIVE_ROOT_ENV]: "/h" });
    const t = targets("linux", r);
    expect(t.find(x => x.browser === "Chrome")!.dir).toBe("/h/.config/google-chrome/NativeMessagingHosts");
    expect(t.find(x => x.browser === "Chromium")!.dir).toBe("/h/.config/chromium/NativeMessagingHosts");
    expect(t.find(x => x.browser === "Edge")!.dir).toBe("/h/.config/microsoft-edge/NativeMessagingHosts");
    expect(t.find(x => x.browser === "Firefox")!.dir).toBe("/h/.mozilla/native-messaging-hosts");
  });

  it("has no file location on Windows: the registry points at one instead", () => {
    expect(targets("win32", nativeRoots({ [NATIVE_ROOT_ENV]: "/h" }))).toEqual([]);
    expect(registryTargets().map(r => r.key)).toEqual([
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
      `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
      `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
      `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`,
    ]);
    // HKCU, never HKLM: one needs no administrator and the other does.
    expect(registryTargets().every(r => r.key.startsWith("HKCU\\"))).toBe(true);
  });

  it("honours XDG_CONFIG_HOME, and lets the override win over it", () => {
    expect(nativeRoots({ XDG_CONFIG_HOME: "/xdg" }).config).toBe("/xdg");
    expect(nativeRoots({ XDG_CONFIG_HOME: "/xdg", [NATIVE_ROOT_ENV]: "/h" })).toEqual({ home: "/h", config: "/h/.config", overridden: true });
    // A blank variable is not a value.
    expect(nativeRoots({ [NATIVE_ROOT_ENV]: "  " }).home).toBe(os.homedir());
    expect(nativeRoots({ [NATIVE_ROOT_ENV]: "  " }).overridden).toBe(false);
  });
});

/**
 * One daemon owns the browser registration, because the manifests name one
 * wrapper and that wrapper names one state directory. A second daemon — an
 * experiment, a recording, a test — writes its host and registers nothing, so
 * it can never take the panel away from the daemon the person actually uses.
 */
describe("which daemon may register with the browsers", () => {
  it("is the one on this machine's own data directory", () => {
    expect(registersBrowsers(defaultDataDir(), nativeRoots({}))).toBe(true);
    expect(registersBrowsers(path.join(tmp, "somewhere-else"), nativeRoots({}))).toBe(false);
  });

  it("is any daemon at all once the root is overridden, because then the browsers are a temp directory", () => {
    expect(registersBrowsers(path.join(tmp, "somewhere-else"), roots())).toBe(true);
  });

  it("writes the host but registers nothing for a data directory that is not the default", async () => {
    const r = realRoots();
    const report = await writeNativeHost({ dataDir, stateDir, platform: "darwin", roots: r, node: "/n/node" });
    expect(report.registers).toBe(false);
    expect(report.wrote).toEqual([]);
    expect(report.registry).toEqual([]);
    expect(report.failed).toEqual([]);
    // The host and the wrapper are there either way, so --status has something
    // to say and the files cost nothing.
    expect(await exists(report.hostJs)).toBe(true);
    expect(await exists(report.wrapper)).toBe(true);
    // Every browser is accounted for, with the reason in plain words.
    expect(report.skipped.map(s => s.browser)).toEqual(targets("darwin", r).map(t => t.browser));
    expect(report.skipped.every(s => s.vendor === NOT_OURS)).toBe(true);
    expect(nativeLine(report)).toContain(NOT_OURS);
    expect(nativeLine(report).split("\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("the manifest itself", () => {
  it("allows one origin for Chromium and one add-on id for Firefox", () => {
    expect(manifest("chromium", "/w")).toEqual({
      name: HOST_NAME, description: expect.any(String), path: "/w", type: "stdio", allowed_origins: CHROME_ORIGINS,
    });
    expect(manifest("firefox", "/w")).toEqual({
      name: HOST_NAME, description: expect.any(String), path: "/w", type: "stdio", allowed_extensions: FIREFOX_EXTENSIONS,
    });
    expect(CHROME_ORIGINS).toEqual(["chrome-extension://fiibejlikopcaplomihaegmbanhjjmed/"]);
    expect(FIREFOX_EXTENSIONS).toEqual(["sidewalk@kesensoy.github.io"]);
    // Lowercase and dot-separated, which is what both halves spell.
    expect(HOST_NAME).toBe("sh.sidewalk.walkd");
  });

  it("gives the Firefox twin its own filename only where the two would collide", () => {
    expect(manifestName("chromium", "darwin")).toBe(`${HOST_NAME}.json`);
    expect(manifestName("firefox", "darwin")).toBe(`${HOST_NAME}.json`);
    // On Windows both land in the daemon's own native/ folder.
    expect(manifestName("chromium", "win32")).toBe(`${HOST_NAME}.json`);
    expect(manifestName("firefox", "win32")).toBe(`${HOST_NAME}.firefox.json`);
  });
});

describe("the wrapper the browser runs", () => {
  it("names node and the host absolutely, and quotes both", () => {
    const sh = wrapperText("darwin", "/usr/local/bin/node", "/d/native/host.js", "/d/state");
    expect(sh).toBe(`#!/bin/sh\nexec "/usr/local/bin/node" "/d/native/host.js" --state-dir "/d/state"\n`);
    const bat = wrapperText("win32", "C:\\Program Files\\node.exe", "C:\\d\\native\\host.js", "C:\\d\\state");
    expect(bat).toContain(`"C:\\Program Files\\node.exe" "C:\\d\\native\\host.js" --state-dir "C:\\d\\state"`);
    expect(bat.startsWith("@echo off")).toBe(true);
    expect(wrapperName("win32")).toBe("host.bat");
    expect(wrapperName("linux")).toBe("host");
  });

  it("reads its own two paths back, which is how --status knows the node is gone", () => {
    const sh = wrapperText("linux", "/n/bin/node", "/d/native/host.js", "/d/state");
    expect(wrapperPaths(sh)).toEqual({ node: "/n/bin/node", hostJs: "/d/native/host.js" });
    expect(wrapperPaths("nothing quoted here")).toEqual({ node: null, hostJs: null });
    // The read undoes the write's escaping, in both forms: a Windows node path
    // through the sh form (what a test on a Windows runner produces), the four
    // shell characters, and a `%` in a batch path.
    const odd = "/h/it's $HOME `x` \\ \"q\"/node";
    expect(wrapperPaths(wrapperText("darwin", odd, "/d/native/host.js", "/d/state")).node).toBe(odd);
    const win = "C:\\hostedtoolcache\\node\\22\\node.exe";
    expect(wrapperPaths(wrapperText("darwin", win, "/d/native/host.js", "/d/state")).node).toBe(win);
    const pct = "C:\\Users\\100%\\node.exe";
    expect(wrapperPaths(wrapperText("win32", pct, "C:\\d\\host.js", "C:\\d\\state")).node).toBe(pct);
  });

  /**
   * A home directory with a `$` or a space in it is ordinary and legal, and a
   * path that closed the quote would leave the browser running something else
   * entirely. Nothing here is reachable from anywhere but the person's own
   * filesystem layout — it is correctness, not a boundary.
   */
  it("escapes what a shell would still read inside the quotes", () => {
    expect(shEscape(`a"b`)).toBe(`a\\"b`);
    expect(shEscape("a$b")).toBe("a\\$b");
    expect(shEscape("a`b")).toBe("a\\`b");
    expect(shEscape("a\\b")).toBe("a\\\\b");
    expect(shEscape("/plain/path with spaces")).toBe("/plain/path with spaces");
    const sh = wrapperText("darwin", "/n/node", `/Users/a$b/d/native/host.js`, `/Users/a"b/state`);
    expect(sh).toContain(`"/Users/a\\$b/d/native/host.js"`);
    expect(sh).toContain(`"/Users/a\\"b/state"`);
  });

  it("doubles a percent sign in the batch file, which is the only thing cmd still reads", () => {
    expect(batEscape("a%b")).toBe("a%%b");
    expect(batEscape("C:\\Users\\a\\node.exe")).toBe("C:\\Users\\a\\node.exe");
    expect(wrapperText("win32", "C:\\n\\node.exe", "C:\\d%1\\host.js", "C:\\s")).toContain(`"C:\\d%%1\\host.js"`);
  });
});

describe("writing it", () => {
  it("writes one manifest per browser folder that is there, and nothing for one that is not", async () => {
    const r = roots();
    const chrome = targets("darwin", r).find(t => t.browser === "Chrome")!;
    const firefox = targets("darwin", r).find(t => t.browser === "Firefox")!;
    await makeVendor(chrome.vendor);
    await makeVendor(firefox.vendor);

    const report = await writeNativeHost({ dataDir, stateDir, platform: "darwin", roots: r, node: "/n/node" });
    expect(report.wrote.map(w => w.browser)).toEqual(["Chrome", "Firefox"]);
    expect(report.failed).toEqual([]);
    expect(report.skipped.map(s => s.browser)).toContain("Brave");

    const written = await read(path.join(chrome.dir, `${HOST_NAME}.json`));
    expect(written).toEqual({ name: HOST_NAME, description: expect.any(String), path: report.wrapper, type: "stdio", allowed_origins: CHROME_ORIGINS });
    expect((await read(path.join(firefox.dir, `${HOST_NAME}.json`))).allowed_extensions).toEqual(FIREFOX_EXTENSIONS);

    // The leaf is walkd's to create; the vendor folder never is.
    const brave = targets("darwin", r).find(t => t.browser === "Brave")!;
    expect(await exists(brave.vendor)).toBe(false);
    expect(await exists(brave.dir)).toBe(false);
  });

  it("copies the host beside the wrapper, and gives the wrapper mode 0700", async () => {
    const r = roots();
    await makeVendor(targets("darwin", r).find(t => t.browser === "Chrome")!.vendor);
    const report = await writeNativeHost({ dataDir, stateDir, platform: "darwin", roots: r, node: "/n/node" });
    expect(await exists(report.hostJs)).toBe(true);
    // The copy is self-contained: an npx cache sweep cannot take it away.
    expect(await fs.readFile(report.hostJs, "utf8")).toBe(await fs.readFile(path.join(defaultSource(), HOST_SCRIPT), "utf8"));
    // The one-line package file beside it, which is what settles the module kind
    // of a .js file in a folder with no package above it.
    expect(await read(path.join(report.dir, "package.json"))).toEqual({ type: "commonjs" });
    if (process.platform !== "win32") expect((await fs.stat(report.wrapper)).mode & 0o777).toBe(0o700);
  });

  it("is idempotent, and rewrites the wrapper so a node that moved heals itself", async () => {
    const r = roots();
    const chrome = targets("darwin", r).find(t => t.browser === "Chrome")!;
    await makeVendor(chrome.vendor);
    await writeNativeHost({ dataDir, stateDir, platform: "darwin", roots: r, node: "/old/node" });
    const second = await writeNativeHost({ dataDir, stateDir, platform: "darwin", roots: r, node: "/new/node" });
    expect(second.wrote.map(w => w.browser)).toEqual(["Chrome"]);
    expect(await fs.readFile(second.wrapper, "utf8")).toContain(`"/new/node"`);
    expect(await fs.readFile(second.wrapper, "utf8")).not.toContain("/old/node");
    // One file, not two: the second run replaced the first's manifest.
    expect(await fs.readdir(chrome.dir)).toEqual([`${HOST_NAME}.json`]);
  });

  it("records a directory it could not write to and carries on with the rest", async () => {
    const r = roots();
    const all = targets("linux", r);
    const chrome = all.find(t => t.browser === "Chrome")!;
    const firefox = all.find(t => t.browser === "Firefox")!;
    await makeVendor(chrome.vendor);
    await makeVendor(firefox.vendor);
    // A file where the leaf directory should be: mkdir fails, the next browser
    // is still written, and the start is not failed by either.
    await fs.writeFile(chrome.dir, "not a directory");
    const report = await writeNativeHost({ dataDir, stateDir, platform: "linux", roots: r, node: "/n/node" });
    expect(report.wrote.map(w => w.browser)).toEqual(["Firefox"]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].where).toContain("google-chrome");
  });

  it("writes the two JSON files into its own folder on Windows, and one HKCU value each", async () => {
    const r = realRoots();
    const calls: string[][] = [];
    const report = await writeNativeHost({
      dataDir, stateDir, platform: "win32", roots: r, node: "C:\\n\\node.exe", registers: true,
      reg: async args => { calls.push(args); return ""; },
    });
    expect(report.registry.map(w => w.browser)).toEqual(["Chrome", "Chromium", "Edge", "Firefox"]);
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c[0]).toBe("add");
      expect(c.slice(2, 6)).toEqual(["/ve", "/t", "REG_SZ", "/d"]);
      expect(c[7]).toBe("/f");
    }
    // The default value is the path of the manifest for that family.
    expect(calls[0][6]).toBe(path.join(report.dir, `${HOST_NAME}.json`));
    expect(calls[3][6]).toBe(path.join(report.dir, `${HOST_NAME}.firefox.json`));
    expect((await read(path.join(report.dir, `${HOST_NAME}.firefox.json`))).allowed_extensions).toEqual(FIREFOX_EXTENSIONS);
    expect(await exists(path.join(report.dir, "host.bat"))).toBe(true);
  });

  /**
   * A data directory under a user name with a space in it, which is where the
   * 2026-10-19 field check expected the Firefox host to break: it saw Firefox
   * launch the wrapper with no quotes around its path, where Chrome quoted it.
   * It does not break. Firefox quotes conditionally (only when the string holds
   * whitespace or a quote) and Chrome unconditionally, so a space-free path
   * looks unquoted under one and quoted under the other, and a path *with* a
   * space is quoted by both — fixed in Firefox 52, bug 1321637, and watched on a
   * real Windows PC on 2026-10-19 (Firefox 158 quoted both paths). This is the
   * test that keeps the question from being reopened, and the reason walkd
   * shortens nothing.
   */
  it("writes the Firefox manifest's path whole when the data dir has a space in it", async () => {
    const spaced = path.join(tmp, "Ada Lovelace", "data");
    const report = await writeNativeHost({
      dataDir: spaced, stateDir, platform: "win32", roots: realRoots(), registers: true,
      node: "C:\\Program Files\\nodejs\\node.exe", reg: async () => "",
    });
    const firefox = await read(path.join(report.dir, `${HOST_NAME}.firefox.json`));
    expect(firefox.path).toBe(report.wrapper);
    expect(firefox.path).toContain("Ada Lovelace");
    // The other half, one level down: the wrapper quotes every path inside
    // itself, which is where a space did bite a shipping host (bug 2009190).
    const bat = await fs.readFile(report.wrapper, "utf8");
    expect(bat).toContain(`"C:\\Program Files\\nodejs\\node.exe"`);
    expect(bat).toContain(`"${path.join(report.dir, HOST_SCRIPT)}"`);
  });

  it("keeps a reg failure to that one key", async () => {
    const report = await writeNativeHost({
      dataDir, stateDir, platform: "win32", roots: realRoots(), node: "C:\\n\\node.exe", registers: true,
      reg: async args => { if (args[1].includes("Mozilla")) throw new Error("access is denied"); return ""; },
    });
    expect(report.registry.map(w => w.browser)).toEqual(["Chrome", "Chromium", "Edge"]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].where).toContain("Mozilla");
  });

  /**
   * The one thing an overridden root cannot redirect. A registry key is the
   * person's own HKCU whatever `WALKD_NATIVE_ROOT` says, so under an override
   * the registry half is not attempted at all — which is what keeps `npm test`
   * on a Windows runner from writing four real keys pointing at a temp
   * directory the run then deletes.
   */
  it("makes no reg call at all under an overridden root, and says which keys it left alone", async () => {
    const calls: string[][] = [];
    const report = await writeNativeHost({
      dataDir, stateDir, platform: "win32", roots: roots(), node: "C:\\n\\node.exe",
      reg: async args => { calls.push(args); return ""; },
    });
    expect(calls).toEqual([]);
    expect(report.registry).toEqual([]);
    expect(report.skipped.map(s => s.browser)).toEqual(["Chrome", "Chromium", "Edge", "Firefox"]);
    for (const s of report.skipped) {
      expect(s.vendor).toContain("HKCU\\");
      expect(s.vendor).toContain(NATIVE_ROOT_ENV);
    }
    // The host itself is still written, under the temp data dir where it belongs.
    expect(await exists(report.hostJs)).toBe(true);
    expect(await exists(path.join(report.dir, "host.bat"))).toBe(true);
    // And the line a start prints names no browser, because none was registered,
    // and says which of the two reasons it was.
    const line = nativeLine(report);
    for (const b of ["Chrome", "Chromium", "Edge", "Firefox"]) expect(line).not.toContain(b);
    expect(report.heldRegistry).toBe(true);
    expect(line).toContain("nothing was registered");
    expect(line).toContain(NATIVE_ROOT_ENV);
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("the one line a start prints about it", () => {
  it("names the browsers it wrote for and where the host is", () => {
    const line = nativeLine({ dir: "/d/native", hostJs: "/d/native/host.js", wrapper: "/d/native/host", node: "/n", wrote: [{ browser: "Chrome", file: "/a" }, { browser: "Firefox", file: "/b" }], registry: [], skipped: [], failed: [], registers: true });
    expect(line).toBe("walkd: native messaging host written for Chrome, Firefox (/d/native).\n");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("says what refused it, and points at --status, without burying the good news", () => {
    const line = nativeLine({ dir: "/d/native", hostJs: "", wrapper: "", node: "", wrote: [{ browser: "Chrome", file: "/a" }], registry: [], skipped: [], failed: [{ where: "/x", why: "EACCES" }], registers: true });
    expect(line).toContain("written for Chrome");
    expect(line).toContain("1 place refused it");
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("says the host is there and nothing was registered, when no browser folder exists", () => {
    const line = nativeLine({ dir: "/d/native", hostJs: "", wrapper: "", node: "", wrote: [], registry: [], skipped: [{ browser: "Chrome", vendor: "/v" }], failed: [], registers: true });
    // The host and the wrapper were written; what is missing is a browser.
    expect(line).toContain("the native messaging host is in /d/native");
    expect(line).toContain("nothing was registered");
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("names the first failure, and the clipboard, when nothing was written at all", () => {
    const line = nativeLine({ dir: "/d/native", hostJs: "", wrapper: "", node: "", wrote: [], registry: [], skipped: [], failed: [{ where: "/d/native", why: "EROFS" }], registers: true });
    expect(line).toContain("EROFS");
    expect(line).toContain("clipboard");
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("walkd native --status", () => {
  it("says which browsers have it, and whether the node the wrapper names is still there", async () => {
    const r = roots();
    const chrome = targets("darwin", r).find(t => t.browser === "Chrome")!;
    await makeVendor(chrome.vendor);
    const realNode = process.execPath;
    await writeNativeHost({ dataDir, stateDir, platform: "darwin", roots: r, node: realNode });

    const ok = await nativeStatus({ dataDir, stateDir, platform: "darwin", roots: r });
    expect(ok.hostJs).toBe(true);
    expect(ok.node).toBe(realNode);
    expect(ok.nodeExists).toBe(true);
    expect(ok.found.map(f => f.browser)).toEqual(["Chrome"]);
    expect(ok.absent.map(a => a.browser)).toContain("Vivaldi");

    // The failure a version manager causes: the wrapper still names a node that
    // has been upgraded out from under it.
    await writeNativeHost({ dataDir, stateDir, platform: "darwin", roots: r, node: path.join(tmp, "gone", "node") });
    const stale = await nativeStatus({ dataDir, stateDir, platform: "darwin", roots: r });
    expect(stale.nodeExists).toBe(false);
  });

  it("says nothing is written when nothing is", async () => {
    const s = await nativeStatus({ dataDir, stateDir, platform: "darwin", roots: roots() });
    expect(s.hostJs).toBe(false);
    expect(s.wrapper).toBeNull();
    expect(s.found).toEqual([]);
  });

  it("reads the registry through the same seam on Windows, and names the manifest each key points at", async () => {
    const s = await nativeStatus({
      dataDir, stateDir, platform: "win32", roots: realRoots(), registers: true,
      reg: async args => {
        if (args[1].includes("Chromium")) throw new Error("not found");
        return regQueryOutput(args[1], args[1].includes("Mozilla") ? `${HOST_NAME}.firefox.json` : `${HOST_NAME}.json`);
      },
    });
    expect(s.registry.map(k => k.browser)).toEqual(["Chrome", "Chromium", "Edge", "Firefox"]);
    expect(s.registry.find(k => k.browser === "Chromium")!.state).toBe("not set");
    expect(s.registry.find(k => k.browser === "Chromium")!.path).toBeUndefined();
    const chrome = s.registry.find(k => k.browser === "Chrome")!;
    expect(chrome.state).toBe("set");
    // The path, out of the key's own value, spaces in the user name and all:
    // which manifest a browser is being sent to is the question four rows of
    // "set" could not answer.
    expect(chrome.path).toBe(`C:\\Users\\Ada Lovelace\\AppData\\Local\\walkd\\native\\${HOST_NAME}.json`);
    expect(s.registry.find(k => k.browser === "Firefox")!.path).toContain(".firefox.json");
    for (const k of s.registry) expect(k.key).toContain("HKCU\\");
  });

  it("still says set for a key whose value it cannot make sense of", async () => {
    const s = await nativeStatus({
      dataDir, stateDir, platform: "win32", roots: realRoots(), registers: true,
      // An empty default value, which is what `reg add` with no `/d` leaves.
      reg: async args => `\r\n${args[1].replace("HKCU", "HKEY_CURRENT_USER")}\r\n    (Default)    REG_SZ    \r\n\r\n`,
    });
    expect(s.registry.map(k => k.state)).toEqual(["set", "set", "set", "set"]);
    for (const k of s.registry) expect(k.path).toBeUndefined();
  });

  /**
   * The parse on its own, against the shapes a real `reg query` hands back:
   * CRLF throughout, the value indented under the key, and a value *name* that
   * is localised — a German Windows says "(Standard)" — which is why the match
   * hangs off `REG_SZ` and not off the name.
   */
  describe("regPath", () => {
    it("takes the path out of a real reg query answer, spaces and all", () => {
      expect(regPath(regQueryOutput("HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\x", `${HOST_NAME}.json`)))
        .toBe(`C:\\Users\\Ada Lovelace\\AppData\\Local\\walkd\\native\\${HOST_NAME}.json`);
    });
    it("reads a localised value name, and a run of spaces of any width", () => {
      expect(regPath("\r\nHKEY_CURRENT_USER\\Software\\Mozilla\\x\r\n (Standard) REG_SZ C:\\w\\m.json\r\n")).toBe("C:\\w\\m.json");
    });
    it("is not fooled by the other value types, or by an answer with no value in it", () => {
      expect(regPath("\r\n    (Default)    REG_EXPAND_SZ    %LOCALAPPDATA%\\walkd\\m.json\r\n")).toBeNull();
      expect(regPath("HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\x\r\n")).toBeNull();
      expect(regPath("")).toBeNull();
    });
  });

  it("does not read the registry at all under an overridden root", async () => {
    const calls: string[][] = [];
    const s = await nativeStatus({
      dataDir, stateDir, platform: "win32", roots: roots(),
      reg: async args => { calls.push(args); return ""; },
    });
    expect(calls).toEqual([]);
    expect(s.registry.map(k => k.state)).toEqual(["not read", "not read", "not read", "not read"]);
  });
});

describe("walkd native --remove", () => {
  it("takes out what it wrote, and leaves the browser's own folder standing", async () => {
    const r = roots();
    const chrome = targets("darwin", r).find(t => t.browser === "Chrome")!;
    await makeVendor(chrome.vendor);
    const report = await writeNativeHost({ dataDir, stateDir, platform: "darwin", roots: r, node: "/n/node" });
    // Something of the person's own in the folder: the folder stays.
    await fs.writeFile(path.join(report.dir, "notes.txt"), "mine");

    const gone = await removeNativeHost({ dataDir, stateDir, platform: "darwin", roots: r });
    expect(gone.failed).toEqual([]);
    expect(gone.removed).toContain(path.join(chrome.dir, `${HOST_NAME}.json`));
    expect(gone.removed).toContain(report.wrapper);
    expect(gone.removed).toContain(report.hostJs);
    expect(await exists(report.dir)).toBe(true);
    expect(await exists(path.join(report.dir, "notes.txt"))).toBe(true);
    // The browser made this, so walkd does not unmake it.
    expect(await exists(chrome.vendor)).toBe(true);
    expect(await exists(chrome.dir)).toBe(true);

    // Twice is not an error: there is simply nothing left to take out.
    expect((await removeNativeHost({ dataDir, stateDir, platform: "darwin", roots: r })).removed).toEqual([]);
  });

  it("removes its own folder when nothing of anyone else's is in it", async () => {
    const r = roots();
    await makeVendor(targets("darwin", r).find(t => t.browser === "Chrome")!.vendor);
    const report = await writeNativeHost({ dataDir, stateDir, platform: "darwin", roots: r, node: "/n/node" });
    const gone = await removeNativeHost({ dataDir, stateDir, platform: "darwin", roots: r });
    expect(gone.removed).toContain(report.dir);
    expect(await exists(report.dir)).toBe(false);
  });

  it("deletes the registry values on Windows", async () => {
    const r = realRoots();
    await writeNativeHost({ dataDir, stateDir, platform: "win32", roots: r, node: "C:\\n\\node.exe", registers: true, reg: async () => "" });
    const calls: string[][] = [];
    const gone = await removeNativeHost({ dataDir, stateDir, platform: "win32", roots: r, registers: true, reg: async args => { calls.push(args); return ""; } });
    expect(calls.map(c => c[0])).toEqual(["delete", "delete", "delete", "delete"]);
    expect(calls.every(c => c[2] === "/f")).toBe(true);
    expect(gone.removed).toContain(registryTargets()[0].key);
  });

  it("deletes no registry value under an overridden root, but still takes its own files out", async () => {
    const r = roots();
    const report = await writeNativeHost({ dataDir, stateDir, platform: "win32", roots: r, node: "C:\\n\\node.exe", reg: async () => "" });
    const calls: string[][] = [];
    const gone = await removeNativeHost({ dataDir, stateDir, platform: "win32", roots: r, reg: async args => { calls.push(args); return ""; } });
    // A run that was never allowed to write a key must not delete one either.
    expect(calls).toEqual([]);
    expect(gone.removed.some(f => f.startsWith("HKCU\\"))).toBe(false);
    // Its own files under the temp data dir are still cleaned up.
    expect(gone.removed).toContain(report.hostJs);
    expect(gone.removed).toContain(report.wrapper);
    expect(await exists(report.dir)).toBe(false);
  });
});

/**
 * The host program, driven the way a browser drives it: one framed message in,
 * one framed message out, then it exits. Nothing in this release reads it except
 * this, which is the point of testing it this hard — the panel's half arrives
 * later and will find it either working or not.
 */
describe("the host program", () => {
  const frame = (body: unknown) => {
    const json = Buffer.from(JSON.stringify(body), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(json.length, 0);
    return Buffer.concat([head, json]);
  };

  const ask = (args: string[], write: Buffer | null = frame({ t: "token" })) => new Promise<{ len: number; body: any; extra: number } | null>(resolve => {
    const child = spawn(process.execPath, [path.join(defaultSource(), HOST_SCRIPT), ...args], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", c => chunks.push(c));
    child.on("close", () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) return resolve(null);
      const len = buf.readUInt32LE(0);
      resolve({ len, body: JSON.parse(buf.subarray(4, 4 + len).toString("utf8")), extra: buf.length - 4 - len });
    });
    if (write) child.stdin.end(write); else child.stdin.end();
  });

  const writeState = async (port: number) => {
    await fs.writeFile(path.join(stateDir, "walkd.json"), JSON.stringify({ port, pid: 1, dataDir, startedAt: new Date().toISOString() }));
  };

  it("answers the port and the token in one frame, and nothing after it", async () => {
    await writeState(8765);
    await fs.writeFile(path.join(dataDir, "token"), "a-token-with-a-trailing-newline\n");
    const r = await ask(["--state-dir", stateDir]);
    expect(r!.body).toEqual({ ok: true, port: 8765, token: "a-token-with-a-trailing-newline" });
    // The length in the header is the length of the body, and there is one body.
    expect(r!.len).toBe(Buffer.byteLength(JSON.stringify(r!.body)));
    expect(r!.extra).toBe(0);
  }, 15000);

  it("finds the data dir from the state file, so it is told only where the state is", async () => {
    // The state dir is not the data dir's child here, which is the Linux shape.
    const elsewhere = path.join(tmp, "state-elsewhere");
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.writeFile(path.join(elsewhere, "walkd.json"), JSON.stringify({ port: 8766, pid: 1, dataDir, startedAt: "x" }));
    await fs.writeFile(path.join(dataDir, "token"), "the-token\n");
    expect((await ask(["--state-dir", elsewhere]))!.body).toEqual({ ok: true, port: 8766, token: "the-token" });
  }, 15000);

  it("says why rather than how when there is nothing to answer with", async () => {
    expect((await ask([]))!.body.ok).toBe(false);
    expect((await ask(["--state-dir", path.join(tmp, "nope")]))!.body).toEqual({ ok: false, reason: "no walkd is running" });
    await writeState(8767);
    expect((await ask(["--state-dir", stateDir]))!.body.reason).toContain("token could not be read");
    // A state file with no port in it is not a daemon to connect to.
    await fs.writeFile(path.join(stateDir, "walkd.json"), JSON.stringify({ pid: 1, dataDir }));
    await fs.writeFile(path.join(dataDir, "token"), "the-token\n");
    expect((await ask(["--state-dir", stateDir]))!.body.reason).toContain("incomplete");
    // And one with no data directory is not guessed at from the state
    // directory's own path: on Linux the two are siblings, not parent and
    // child, so a guess would be wrong exactly where it mattered.
    await fs.writeFile(path.join(stateDir, "walkd.json"), JSON.stringify({ port: 8770, pid: 1 }));
    expect((await ask(["--state-dir", stateDir]))!.body).toEqual({ ok: false, reason: "walkd's state file names no data directory" });
    // Unless it is told one.
    expect((await ask(["--state-dir", stateDir, "--data-dir", dataDir]))!.body).toEqual({ ok: true, port: 8770, token: "the-token" });
  }, 25000);

  it("answers a frame that arrives in pieces, and refuses one that claims to be huge", async () => {
    await writeState(8768);
    await fs.writeFile(path.join(dataDir, "token"), "the-token\n");
    const split = await new Promise<any>(resolve => {
      const child = spawn(process.execPath, [path.join(defaultSource(), HOST_SCRIPT), "--state-dir", stateDir], { stdio: ["pipe", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", c => chunks.push(c));
      child.on("close", () => { const b = Buffer.concat(chunks); resolve(JSON.parse(b.subarray(4).toString("utf8"))); });
      const f = frame({ t: "token" });
      child.stdin.write(f.subarray(0, 2));
      setTimeout(() => child.stdin.write(f.subarray(2, 5)), 20);
      setTimeout(() => child.stdin.end(f.subarray(5)), 40);
    });
    expect(split).toEqual({ ok: true, port: 8768, token: "the-token" });

    const huge = Buffer.alloc(4);
    huge.writeUInt32LE(8 * 1024 * 1024, 0);
    expect((await ask(["--state-dir", stateDir], huge))!.body).toEqual({ ok: false, reason: "message too large" });
  }, 20000);

  it("exits without a word when the browser closes the pipe saying nothing", async () => {
    await writeState(8769);
    await fs.writeFile(path.join(dataDir, "token"), "the-token\n");
    expect(await ask(["--state-dir", stateDir], null)).toBeNull();
  }, 15000);
});

/**
 * The stop op: the panel's *Restart walkd* button, from the host's side.
 *
 * The twin is `stop` in `cli.ts`, mirrored there and here because this host
 * imports `node:fs` and nothing else — so what the two share is behaviour, and
 * this is what pins it. The daemon in these cases is a stand-in rather than a
 * real `walkd serve`: a child that sits there until it is signalled, and an
 * HTTP server answering /health about it. That is exactly the surface the stop
 * op reads, and it lets every refusal be built on purpose — a port somebody
 * else holds, a pid that is not the one answering — which a real daemon will
 * not do for a test.
 */
describe("the host program's stop op", () => {
  const frame = (body: unknown) => {
    const json = Buffer.from(JSON.stringify(body), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(json.length, 0);
    return Buffer.concat([head, json]);
  };

  const ask = (body: unknown) => new Promise<Record<string, unknown> | null>(resolve => {
    const child = spawn(process.execPath, [path.join(defaultSource(), HOST_SCRIPT), "--state-dir", stateDir], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", c => chunks.push(c));
    child.on("close", () => {
      const buf = Buffer.concat(chunks);
      resolve(buf.length < 4 ? null : JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString("utf8")));
    });
    child.stdin.end(frame(body));
  });

  /** A process to be stopped, and the /health that vouches for it. Both torn down after. */
  const standIns: (() => Promise<void>)[] = [];
  async function standIn(health: (pid: number) => unknown) {
    // A child that does nothing but stay alive, so a signal is the only thing
    // that ends it and its exit is the proof the host sent one.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const gone = new Promise<string>(r => child.once("exit", (_c, sig) => r(String(sig))));
    const body = JSON.stringify(health(child.pid!));
    const server = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    standIns.push(async () => { child.kill("SIGKILL"); await new Promise<void>(r => server.close(() => r())); });
    return { child, port, gone, alive: () => child.exitCode === null && child.signalCode === null };
  }
  afterEach(async () => { for (const stop of standIns.splice(0)) await stop(); });

  const writeState = (s: Record<string, unknown>) =>
    fs.writeFile(path.join(stateDir, "walkd.json"), JSON.stringify({ dataDir, ...s }));

  it("signals the daemon the state file names, and says it stopped it", async () => {
    const startedAt = new Date().toISOString();
    const d = await standIn(pid => ({ ok: true, version: "1.2.0", pid, startedAt }));
    await writeState({ port: d.port, pid: d.child.pid, startedAt });
    expect(await ask({ t: "stop", port: d.port })).toEqual({ ok: true, stopped: true });
    expect(await d.gone).toBe("SIGTERM");
  }, 20000);

  /**
   * One host serves the whole machine and answers about whichever walkd owns the
   * registration, so a pane pointed somewhere else must not be able to stop this
   * one. The token op has the same guard in the panel (`askHost` drops an answer
   * about another port); on a stop there is nothing left to drop afterwards, so
   * the refusal has to be the host's.
   */
  it("refuses a stop that names another port than the one it is registered for", async () => {
    const startedAt = new Date().toISOString();
    const d = await standIn(pid => ({ ok: true, version: "1.2.0", pid, startedAt }));
    await writeState({ port: d.port, pid: d.child.pid, startedAt });
    expect(await ask({ t: "stop", port: d.port + 1 })).toEqual({ ok: false, reason: `this host is registered for walkd on ${d.port}` });
    expect(await ask({ t: "stop" })).toEqual({ ok: false, reason: "a stop has to name the port it means" });
    expect(d.alive()).toBe(true);
  }, 20000);

  /** The twin's reason for existing: a pid that was reused, or a port another program holds. */
  it("refuses to signal a pid when what answers on the port is not that daemon", async () => {
    const d = await standIn(() => ({ ok: true, version: "1.2.0", pid: 999_999, startedAt: "someone else's" }));
    await writeState({ port: d.port, pid: d.child.pid, startedAt: new Date().toISOString() });
    expect(await ask({ t: "stop", port: d.port })).toEqual({ ok: false, reason: `something else answers on ${d.port}` });
    expect(d.alive()).toBe(true);
  }, 20000);

  /**
   * Nothing answers: the daemon the file names is already gone, which is what
   * was asked for — so `ok`, and the stale file goes the way the twin takes it.
   * Port 9 is discard; nothing listens there.
   */
  it("takes the stale state file away when nothing healthy answers, and calls that stopped", async () => {
    await writeState({ port: 9, pid: 999_999, startedAt: "x" });
    expect(await ask({ t: "stop", port: 9 })).toEqual({ ok: true, stopped: true });
    await expect(fs.readFile(path.join(stateDir, "walkd.json"))).rejects.toThrow();
  }, 20000);

  it("says why rather than how when there is no state file or it is incomplete", async () => {
    expect(await ask({ t: "stop", port: 8760 })).toEqual({ ok: false, reason: "no walkd is running" });
    await writeState({ pid: 1 });
    expect(await ask({ t: "stop", port: 8760 })).toEqual({ ok: false, reason: "walkd's state file is incomplete" });
  }, 20000);

  /**
   * The compatibility case, both ways round.
   *
   * Forwards: this host answers an op it does not know with one word, rather
   * than handing out the token the way every host up to 1.1.1 did for any
   * message at all. Backwards: `stopped: true` is what a panel looks for,
   * because a 1.1.1 host answers a stop request with `{ok: true, port, token}`
   * and the panel has to be able to tell a daemon that went away from a host
   * that never understood the question.
   */
  it("answers an op it does not know with unknownOp, and never the token", async () => {
    await writeState({ port: 8765, pid: 1, startedAt: "x" });
    await fs.writeFile(path.join(dataDir, "token"), "the-token\n");
    for (const body of [{ t: "restart" }, { t: "" }, {}, "stop", 7, null]) {
      expect(await ask(body), `op ${JSON.stringify(body)}`).toEqual({ ok: false, reason: "unknownOp" });
    }
    // And the op it does know is untouched by all of that.
    expect(await ask({ t: "token" })).toEqual({ ok: true, port: 8765, token: "the-token" });
  }, 30000);
});
