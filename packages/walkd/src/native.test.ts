import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CHROME_ORIGINS, FIREFOX_EXTENSIONS, HOST_NAME, HOST_SCRIPT, NATIVE_ROOT_ENV, defaultSource,
  manifest, manifestName, nativeLine, nativeRoots, nativeStatus, registryTargets, removeNativeHost,
  targets, wrapperName, wrapperPaths, wrapperText, writeNativeHost,
} from "./native.js";

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
    expect(nativeRoots({ XDG_CONFIG_HOME: "/xdg", [NATIVE_ROOT_ENV]: "/h" })).toEqual({ home: "/h", config: path.join("/h", ".config") });
    // A blank variable is not a value.
    expect(nativeRoots({ [NATIVE_ROOT_ENV]: "  " }).home).toBe(os.homedir());
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
    const r = roots();
    const calls: string[][] = [];
    const report = await writeNativeHost({
      dataDir, stateDir, platform: "win32", roots: r, node: "C:\\n\\node.exe",
      reg: async args => { calls.push(args); },
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

  it("keeps a reg failure to that one key", async () => {
    const report = await writeNativeHost({
      dataDir, stateDir, platform: "win32", roots: roots(), node: "C:\\n\\node.exe",
      reg: async args => { if (args[1].includes("Mozilla")) throw new Error("access is denied"); },
    });
    expect(report.registry.map(w => w.browser)).toEqual(["Chrome", "Chromium", "Edge"]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].where).toContain("Mozilla");
  });
});

describe("the one line a start prints about it", () => {
  it("names the browsers it wrote for and where the host is", () => {
    const line = nativeLine({ dir: "/d/native", hostJs: "/d/native/host.js", wrapper: "/d/native/host", node: "/n", wrote: [{ browser: "Chrome", file: "/a" }, { browser: "Firefox", file: "/b" }], registry: [], skipped: [], failed: [] });
    expect(line).toBe("walkd: native messaging host written for Chrome, Firefox (/d/native).\n");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("says what refused it, and points at --status, without burying the good news", () => {
    const line = nativeLine({ dir: "/d/native", hostJs: "", wrapper: "", node: "", wrote: [{ browser: "Chrome", file: "/a" }], registry: [], skipped: [], failed: [{ where: "/x", why: "EACCES" }] });
    expect(line).toContain("written for Chrome");
    expect(line).toContain("1 place refused it");
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("says the host is there and nothing was registered, when no browser folder exists", () => {
    const line = nativeLine({ dir: "/d/native", hostJs: "", wrapper: "", node: "", wrote: [], registry: [], skipped: [{ browser: "Chrome", vendor: "/v" }], failed: [] });
    // The host and the wrapper were written; what is missing is a browser.
    expect(line).toContain("the native messaging host is in /d/native");
    expect(line).toContain("nothing was registered");
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("names the first failure, and the clipboard, when nothing was written at all", () => {
    const line = nativeLine({ dir: "/d/native", hostJs: "", wrapper: "", node: "", wrote: [], registry: [], skipped: [], failed: [{ where: "/d/native", why: "EROFS" }] });
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

  it("reads the registry through the same seam on Windows", async () => {
    const s = await nativeStatus({
      dataDir, stateDir, platform: "win32", roots: roots(),
      reg: async args => { if (args[1].includes("Chromium")) throw new Error("not found"); },
    });
    expect(s.registry.map(k => k.browser)).toEqual(["Chrome", "Chromium", "Edge", "Firefox"]);
    expect(s.registry.find(k => k.browser === "Chromium")!.value).toBeNull();
    expect(s.registry.find(k => k.browser === "Chrome")!.value).toContain(`${HOST_NAME}.json`);
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
    const r = roots();
    await writeNativeHost({ dataDir, stateDir, platform: "win32", roots: r, node: "C:\\n\\node.exe", reg: async () => {} });
    const calls: string[][] = [];
    const gone = await removeNativeHost({ dataDir, stateDir, platform: "win32", roots: r, reg: async args => { calls.push(args); } });
    expect(calls.map(c => c[0])).toEqual(["delete", "delete", "delete", "delete"]);
    expect(calls.every(c => c[2] === "/f")).toBe(true);
    expect(gone.removed).toContain(registryTargets()[0].key);
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
  }, 20000);

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
