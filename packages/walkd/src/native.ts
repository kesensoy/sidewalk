import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DIR_MODE } from "./store.js";
import { defaultDataDir } from "./paths.js";

/**
 * The native messaging host: how a browser panel will be able to ask walkd for
 * its own port and token instead of asking the person to paste one.
 *
 * Native messaging is the one channel out of an extension that is not loopback
 * TCP. The browser resolves a manifest from a directory only this OS user can
 * write, launches the program the manifest names, and tells that program which
 * extension is calling — so it refuses every extension but the one the manifest
 * lists. A request arriving on 127.0.0.1 can never prove that much: the daemon
 * cannot tell the panel from any other program on the machine, which is why the
 * token exists at all.
 *
 * Nothing in this release reads the host except its own tests. The panel's half
 * ships separately, through both stores, and the manifests have to be on disk
 * before any panel can ask — so every `walkd serve` writes them, best effort,
 * and says in one line what it did.
 *
 * Shape copied from KeePassXC's `NativeMessageInstaller.cpp`, which has done
 * exactly this from an unprivileged desktop app for years: one JSON file per
 * browser under the browser's own user directory, HKCU values on Windows, and a
 * rewrite on every start so a host whose program has moved heals itself.
 */

/** The host's name, as both halves spell it. Lowercase, dot-separated. */
export const HOST_NAME = "sh.sidewalk.walkd";
/** One sentence, shown by nothing today; browsers keep it for diagnostics. */
export const HOST_DESCRIPTION = "sidewalk's walk daemon. Hands the side panel the port and token of the walkd running as this user.";
/**
 * The one extension a Chromium-family browser may let through to the host. The
 * Chrome Web Store id of the sidewalk panel, with the trailing slash the
 * manifest format wants.
 *
 * If the panel is ever listed in the Microsoft Edge add-ons store as well, its
 * id belongs in this same array: Edge reads Chrome's registry key when it finds
 * no key of its own, and only the first manifest it finds is read, so an Edge
 * build whose id is missing here would be refused with no second chance.
 */
export const CHROME_ORIGINS = ["chrome-extension://fiibejlikopcaplomihaegmbanhjjmed/"];
/** Firefox names add-on ids, not origins. This is `browser_specific_settings.gecko.id`. */
export const FIREFOX_EXTENSIONS = ["sidewalk@kesensoy.github.io"];

/** The folder under the daemon's data dir that holds all of it. */
export const NATIVE_DIR = "native";
/** The copy of the host program the browser actually runs. */
export const HOST_SCRIPT = "host.js";
/**
 * `{"type":"commonjs"}`, copied beside `host.js`.
 *
 * `host.js` lands in a folder with no package above it, and Node decides a
 * `.js` file's module kind from the nearest `package.json` — which, from a data
 * directory under the person's home, could be anything at all. This one file
 * settles it, so the host is CommonJS wherever it is copied to.
 */
export const HOST_PACKAGE = "package.json";
/** The wrapper the manifest's `path` names: a shell script, or a batch file. */
export const wrapperName = (platform: NodeJS.Platform): string => (platform === "win32" ? "host.bat" : "host");
/** 0700 on the wrapper: the browser runs it as this user and nobody else needs it. */
export const WRAPPER_MODE = 0o700;

export type Family = "chromium" | "firefox";

/**
 * Where a browser looks for user-level host manifests, and the directory whose
 * existence says that browser is installed for this user.
 *
 * `vendor` is created by the browser, never by walkd: a manifest written into a
 * folder for a browser nobody has ever run would be a folder walkd invented.
 * `dir` — the `NativeMessagingHosts` leaf — is walkd's to create, because a
 * browser only makes it when something has already installed a host.
 */
export type Target = { browser: string; family: Family; vendor: string; dir: string };

/**
 * The two roots every path below hangs off.
 *
 * `WALKD_NATIVE_ROOT` replaces the home directory, which is the whole of how
 * the tests stay out of the real browser folders: every test points it at a
 * temp dir, and the only run that writes into a real profile is a `walkd serve`
 * with the variable unset. It also overrides `XDG_CONFIG_HOME`, so a test
 * cannot be dragged out of its own root by the environment it inherited.
 *
 * `overridden` says the variable was set, and it is load-bearing rather than
 * informational: Windows has no file location to redirect — a browser there
 * reads a registry value — so the only way an overridden root can keep a test
 * out of the person's own machine is for the registry half to be skipped
 * outright. Every `reg` call is behind it.
 */
export type Roots = { home: string; config: string; overridden: boolean };
export const NATIVE_ROOT_ENV = "WALKD_NATIVE_ROOT";

export function nativeRoots(env: NodeJS.ProcessEnv = process.env): Roots {
  const override = env[NATIVE_ROOT_ENV]?.trim();
  // An overridden root is a test's, and the layouts it asks for are POSIX ones,
  // so its config dir is joined the POSIX way even on a Windows runner.
  if (override) return { home: override, config: path.posix.join(override, ".config"), overridden: true };
  const home = os.homedir();
  return { home, config: env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), overridden: false };
}

/**
 * May this daemon register itself with the person's browsers?
 *
 * Only one daemon on a machine can own that registration — the manifests name
 * one wrapper, and the wrapper names one state directory — so it belongs to the
 * daemon on the machine's own data directory. A daemon somebody started on
 * `--data-dir /tmp/something` is a second daemon, an experiment or a recording,
 * and repointing the person's real browsers at it would take the panel away
 * from the daemon they actually use.
 *
 * An overridden root says yes regardless, because then "the person's browsers"
 * are a temp directory: that is the e2e, and release 2's throwaway profile.
 */
export function registersBrowsers(dataDir: string, roots: Roots): boolean {
  return roots.overridden || path.resolve(dataDir) === path.resolve(defaultDataDir());
}

/**
 * Every user-level manifest directory walkd knows about, for this platform.
 *
 * Each row is a directory name, not code: a Chromium fork is a folder, so Brave,
 * Vivaldi and Arc cost one line each and no branch. Windows has no file
 * location at all — the manifest can sit anywhere and a registry value points
 * at it — so it answers with nothing and `registryTargets` carries that half.
 */
export function targets(platform: NodeJS.Platform, roots: Roots): Target[] {
  // A macOS or Linux layout is a POSIX path wherever it is computed: a test on
  // Windows asking for the Mac table must not get backslashes in it.
  const join = path.posix.join;
  const row = (browser: string, family: Family, vendor: string, leaf = "NativeMessagingHosts"): Target =>
    ({ browser, family, vendor, dir: join(vendor, leaf) });
  if (platform === "darwin") {
    const support = (...p: string[]) => join(roots.home, "Library", "Application Support", ...p);
    return [
      row("Chrome", "chromium", support("Google", "Chrome")),
      row("Chrome Beta", "chromium", support("Google", "Chrome Beta")),
      row("Chrome Canary", "chromium", support("Google", "Chrome Canary")),
      row("Chromium", "chromium", support("Chromium")),
      row("Brave", "chromium", support("BraveSoftware", "Brave-Browser")),
      row("Edge", "chromium", support("Microsoft Edge")),
      row("Edge Beta", "chromium", support("Microsoft Edge Beta")),
      row("Vivaldi", "chromium", support("Vivaldi")),
      row("Arc", "chromium", support("Arc", "User Data")),
      row("Firefox", "firefox", support("Mozilla")),
    ];
  }
  if (platform === "win32") return [];
  return [
    row("Chrome", "chromium", join(roots.config, "google-chrome")),
    row("Chrome Beta", "chromium", join(roots.config, "google-chrome-beta")),
    row("Chromium", "chromium", join(roots.config, "chromium")),
    row("Brave", "chromium", join(roots.config, "BraveSoftware", "Brave-Browser")),
    row("Edge", "chromium", join(roots.config, "microsoft-edge")),
    row("Vivaldi", "chromium", join(roots.config, "vivaldi")),
    // Firefox is the one that is not under the config directory, and the one
    // whose leaf is lowercase and hyphenated.
    row("Firefox", "firefox", join(roots.home, ".mozilla"), "native-messaging-hosts"),
  ];
}

/** A Windows registry value that points a browser at a manifest file. */
export type RegTarget = { browser: string; family: Family; key: string };

/**
 * HKCU only — no admin, and every product that ships this writes nothing else.
 * A key for a browser nobody has installed is inert, so all four are written
 * rather than guessed at. Edge is given its own key even though it would fall
 * back to Chrome's: the fallback reads only the first manifest it finds, and
 * naming Edge directly is what keeps that from mattering.
 */
export function registryTargets(): RegTarget[] {
  const k = (vendor: string) => `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${HOST_NAME}`;
  return [
    { browser: "Chrome", family: "chromium", key: k("Google\\Chrome") },
    { browser: "Chromium", family: "chromium", key: k("Chromium") },
    { browser: "Edge", family: "chromium", key: k("Microsoft\\Edge") },
    { browser: "Firefox", family: "firefox", key: k("Mozilla") },
  ];
}

/**
 * The manifest file's name. On macOS and Linux the two families land in
 * different directories, so both are `sh.sidewalk.walkd.json`; on Windows both
 * sit in the daemon's own `native/` folder, where they would be one file, so
 * the Firefox one says so in its name. The `name` *inside* the file is
 * `sh.sidewalk.walkd` in every case — that is what a browser matches on.
 */
export const manifestName = (family: Family, platform: NodeJS.Platform): string =>
  family === "firefox" && platform === "win32" ? `${HOST_NAME}.firefox.json` : `${HOST_NAME}.json`;

/**
 * The manifest, as the two browser families spell the same thing: Chromium
 * allows origins, Firefox allows add-on ids. `path` is the wrapper, absolute,
 * which is what both require on macOS and Linux.
 */
export function manifest(family: Family, wrapper: string): Record<string, unknown> {
  const base = { name: HOST_NAME, description: HOST_DESCRIPTION, path: wrapper, type: "stdio" };
  return family === "firefox"
    ? { ...base, allowed_extensions: FIREFOX_EXTENSIONS }
    : { ...base, allowed_origins: CHROME_ORIGINS };
}

/**
 * The wrapper the browser executes.
 *
 * It exists because a browser launched from the Dock or the Start menu carries
 * none of a terminal's PATH: no fnm, no nvm, no Homebrew. So the node that is
 * running this daemon is written in absolutely, and the host script beside it
 * likewise. Both are quoted, because a home directory with a space in it is
 * ordinary on every platform here.
 *
 * It is rewritten at every start, so a node that moved — an upgrade, a version
 * manager switching — is corrected by the next daemon rather than leaving a
 * host the browser cannot launch.
 */
export function wrapperText(platform: NodeJS.Platform, node: string, hostJs: string, stateDir: string): string {
  if (platform === "win32") {
    const b = (s: string) => batEscape(s);
    return `@echo off\r\n"${b(node)}" "${b(hostJs)}" --state-dir "${b(stateDir)}"\r\n`;
  }
  const q = (s: string) => shEscape(s);
  return `#!/bin/sh\nexec "${q(node)}" "${q(hostJs)}" --state-dir "${q(stateDir)}"\n`;
}

/**
 * The four characters a shell still reads inside double quotes. A home directory
 * with a `$` in it is unusual and entirely legal, and a path that closed the
 * quote would leave the browser running something else.
 */
export const shEscape = (s: string): string => s.replace(/(["$`\\])/g, "\\$1");

/**
 * `%` is what `cmd` still reads inside a quoted argument in a batch file, and
 * `%%` is how a batch file writes a literal one. A double quote cannot appear in
 * a Windows path at all, so there is nothing else to do here.
 */
export const batEscape = (s: string): string => s.replace(/%/g, "%%");

export type Wrote = { browser: string; file: string };
/**
 * A browser that was not registered with, and the plain reason: the folder that
 * was not there, the registry key that was left alone, or the sentence saying
 * this daemon does not own the registration at all.
 */
export type Skipped = { browser: string; vendor: string };
export type Failure = { where: string; why: string };
export type NativeReport = {
  dir: string;
  hostJs: string;
  wrapper: string;
  node: string;
  wrote: Wrote[];
  registry: Wrote[];
  skipped: Skipped[];
  failed: Failure[];
  /** False when this daemon does not own the browser registration — see `registersBrowsers`. */
  registers: boolean;
  /**
   * True when the Windows registry half was left alone because the root is
   * overridden. It is the one place an override cannot redirect anything, so it
   * is the one place the honest line is "nothing was touched" rather than
   * "nothing was there".
   */
  heldRegistry?: boolean;
};

/**
 * `reg add` / `reg delete` / `reg query`, the way the clipboard goes through
 * `clip`. It resolves with the command's stdout, which only `reg query` has
 * anything to say in: `add` and `delete` are asked to succeed, not to answer.
 */
export type Reg = (args: string[]) => Promise<string>;

// `timeout`: a `reg` that hangs would hang a `walkd serve` start, and this runs
// four times. The failure is recorded like any other and the start carries on.
// stdout is decoded as UTF-8 like any other child's, which is right for the
// ASCII paths this reads back and may mangle a non-ASCII one — a mangled path
// is still a path on the status row, and nothing acts on it.
const runReg: Reg = args => new Promise((resolve, reject) => {
  execFile("reg", args, { windowsHide: true, timeout: 5000 }, (e, stdout) => (e ? reject(e) : resolve(stdout)));
});

export type NativeOptions = {
  dataDir: string;
  stateDir: string;
  platform?: NodeJS.Platform;
  roots?: Roots;
  /** The node the wrapper names. The running one, unless a test says otherwise. */
  node?: string;
  /** Where the shipped `host.js` is read from. */
  source?: string;
  reg?: Reg;
  /**
   * Overrides `registersBrowsers`. The seam the Windows tests need: the registry
   * half is unreachable under an overridden root by design, so the only way to
   * exercise it is to say so here and hand `reg` a stub. Nothing in the product
   * passes it.
   */
  registers?: boolean;
};

/**
 * The shipped host, beside this package's `src/` and `dist/` alike: both are
 * one level under the package root, so `../native` is the same folder from
 * either. `fileURLToPath`, not the URL's own pathname, because on Windows that
 * pathname begins with a slash before the drive letter.
 */
export const defaultSource = (): string => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", NATIVE_DIR);

const why = (e: unknown) => (e as Error).message ?? String(e);

/**
 * Write the host, the wrapper and every manifest this machine has a browser
 * for. Idempotent and best effort: each piece is tried, each failure is
 * recorded, and nothing here can fail a `walkd serve` — a daemon that serves
 * walks is worth more than a manifest, and the clipboard and the gear are still
 * there when this does not work.
 */
export async function writeNativeHost(opts: NativeOptions): Promise<NativeReport> {
  const platform = opts.platform ?? process.platform;
  const roots = opts.roots ?? nativeRoots();
  const node = opts.node ?? process.execPath;
  const source = opts.source ?? defaultSource();
  const dir = path.join(opts.dataDir, NATIVE_DIR);
  const hostJs = path.join(dir, HOST_SCRIPT);
  const wrapper = path.join(dir, wrapperName(platform));
  const registers = opts.registers ?? registersBrowsers(opts.dataDir, roots);
  const report: NativeReport = { dir, hostJs, wrapper, node, wrote: [], registry: [], skipped: [], failed: [], registers };

  try {
    await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
    // Copied rather than run in place: an npx cache can be swept between one
    // session and the next, and a host the browser cannot find is a host the
    // panel reports as missing.
    for (const f of [HOST_SCRIPT, HOST_PACKAGE]) await fs.copyFile(path.join(source, f), path.join(dir, f));
    await fs.writeFile(wrapper, wrapperText(platform, node, hostJs, opts.stateDir), { mode: WRAPPER_MODE });
    // writeFile honours `mode` only when it creates the file, so a wrapper that
    // already existed keeps whatever mode it had until this says otherwise.
    if (platform !== "win32") await fs.chmod(wrapper, WRAPPER_MODE);
  } catch (e) {
    report.failed.push({ where: dir, why: why(e) });
    return report;
  }

  // The host and the wrapper are written for every daemon, because `--status`
  // should have something to say and the files cost nothing. The registration is
  // what one daemon owns, and a daemon that does not own it stops here.
  if (!registers) {
    for (const t of [...targets(platform, roots), ...(platform === "win32" ? registryTargets().map(r => ({ browser: r.browser, vendor: r.key })) : [])])
      report.skipped.push({ browser: t.browser, vendor: NOT_OURS });
    return report;
  }

  for (const t of targets(platform, roots)) {
    try {
      // The browser's own directory is the test for "this browser exists here".
      // walkd never creates it: that would be walkd inventing a browser.
      await fs.stat(t.vendor);
    } catch { report.skipped.push({ browser: t.browser, vendor: t.vendor }); continue; }
    const file = path.join(t.dir, manifestName(t.family, platform));
    try {
      await fs.mkdir(t.dir, { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(manifest(t.family, wrapper), null, 2)}\n`);
      report.wrote.push({ browser: t.browser, file });
    } catch (e) { report.failed.push({ where: file, why: why(e) }); }
  }

  if (platform === "win32") {
    // The one place an overridden root cannot redirect anything. A registry key
    // is the person's own HKCU whatever `WALKD_NATIVE_ROOT` says, so under an
    // override the registry half is not attempted at all — which is what keeps
    // `npm test` on a Windows runner from writing four real keys that point at
    // a temp directory the run then deletes.
    if (roots.overridden) {
      for (const t of registryTargets()) report.skipped.push({ browser: t.browser, vendor: `${t.key} (${NATIVE_ROOT_ENV} is set)` });
      report.heldRegistry = true;
      return report;
    }
    const reg = opts.reg ?? runReg;
    for (const t of registryTargets()) {
      const file = path.join(dir, manifestName(t.family, platform));
      try {
        await fs.writeFile(file, `${JSON.stringify(manifest(t.family, wrapper), null, 2)}\n`);
        await reg(["add", t.key, "/ve", "/t", "REG_SZ", "/d", file, "/f"]);
        report.registry.push({ browser: t.browser, file });
      } catch (e) { report.failed.push({ where: t.key, why: why(e) }); }
    }
  }
  return report;
}

/** Why nothing was registered, when the reason is which daemon this is. */
export const NOT_OURS = "another data directory owns the browser registration";

/**
 * The one line `walkd serve` prints about all of it — one on success, one when
 * there was nothing to write or nothing worked. A daemon start is not the place
 * for a report, and the person can ask for one: `walkd native --status`.
 */
export function nativeLine(r: NativeReport): string {
  const names = [...r.wrote, ...r.registry].map(w => w.browser);
  if (names.length === 0) {
    const first = r.failed[0];
    if (first) return `walkd: the native messaging host could not be written (${first.where}: ${first.why}). The panel still takes its token from your clipboard, in the gear.\n`;
    // Not a failure: this daemon is on its own data directory, and repointing
    // the person's browsers at it would take the panel away from the daemon
    // they actually use.
    if (!r.registers) return `walkd: the native messaging host is in ${r.dir}, and no browser was registered with it: ${NOT_OURS}.\n`;
    // Windows under an overridden root: the keys were not read and not written,
    // which is a different sentence from "there was nothing there".
    if (r.heldRegistry) return `walkd: the native messaging host is in ${r.dir}, and nothing was registered: ${NATIVE_ROOT_ENV} is set, and a registry key is not something it can redirect.\n`;
    // The host and its wrapper are written either way; what is missing is a
    // browser to register them with, and saying "none was written" about the
    // whole thing would be wrong.
    return `walkd: the native messaging host is in ${r.dir}; no browser folder on this machine to register it with, so nothing was registered.\n`;
  }
  const trouble = r.failed.length ? ` ${r.failed.length} place${r.failed.length === 1 ? "" : "s"} refused it; "walkd native --status" says which.` : "";
  return `walkd: native messaging host written for ${names.join(", ")} (${r.dir}).${trouble}\n`;
}

export type NativeStatus = {
  dir: string;
  wrapper: string | null;
  node: string | null;
  nodeExists: boolean;
  hostJs: boolean;
  found: Wrote[];
  absent: Skipped[];
  /**
   * Whether the key is there, and what it points at.
   *
   * A key that is set is only half an answer: four keys that all say "set"
   * still leave the one question a person has — which manifest is this browser
   * actually being sent to — to a `reg query` typed by hand (the Windows field
   * check of 2026-10-19 had to). So `reg query /ve`'s own stdout is read back
   * and the value lands in `path`. It is optional because a key can hold
   * something this cannot make sense of, and "set" with nothing after it is a
   * truer row than a guess. "not read" is the overridden-root case, where the
   * registry is deliberately left alone.
   */
  registry: { browser: string; key: string; state: "set" | "not set" | "not read"; path?: string }[];
};

/**
 * The manifest path out of a `reg query <key> /ve`.
 *
 * `reg` answers with the key on one line and the value on the next, as three
 * columns run together with spaces — `    (Default)    REG_SZ    C:\…\sh.sidewalk.walkd.json` —
 * in CRLF lines. The value's *name* is localised ("(Standard)" on a German
 * Windows), so the match hangs off `REG_SZ`, and the data runs to the end of
 * the line, which is what lets a path with spaces in it through whole.
 *
 * Null for anything that is not that, the empty default value included: a row
 * that says "set" and names nothing is right, and one that invents a path is
 * not.
 */
export function regPath(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /\sREG_SZ\s+(\S.*?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** The absolute paths a wrapper names, read back out of the file it is. */
export function wrapperPaths(text: string): { node: string | null; hostJs: string | null } {
  // The inverse of `wrapperText`: a batch file doubled its `%`, a sh wrapper
  // backslashed the four characters a shell reads inside quotes, and a quoted
  // string in the sh form may hold an escaped quote.
  const bat = text.startsWith("@echo off");
  const quoted = bat
    ? (text.match(/"([^"]*)"/g)?.map(s => s.slice(1, -1).replace(/%%/g, "%")) ?? [])
    : (text.match(/"((?:\\.|[^"\\])*)"/g)?.map(s => s.slice(1, -1).replace(/\\(["$`\\])/g, "$1")) ?? []);
  return { node: quoted[0] ?? null, hostJs: quoted[1] ?? null };
}

/**
 * What is on disk, for `walkd native --status`. The one question it is really
 * for: does the node the wrapper names still exist? A version manager that
 * upgraded Node leaves a wrapper pointing at a directory that is gone, and the
 * browser's only word for that is "failed to start native messaging host".
 */
export async function nativeStatus(opts: NativeOptions): Promise<NativeStatus> {
  const platform = opts.platform ?? process.platform;
  const roots = opts.roots ?? nativeRoots();
  const dir = path.join(opts.dataDir, NATIVE_DIR);
  const wrapperFile = path.join(dir, wrapperName(platform));
  const out: NativeStatus = { dir, wrapper: null, node: null, nodeExists: false, hostJs: false, found: [], absent: [], registry: [] };
  out.hostJs = await fs.stat(path.join(dir, HOST_SCRIPT)).then(() => true, () => false);
  const text = await fs.readFile(wrapperFile, "utf8").catch(() => null);
  if (text !== null) {
    out.wrapper = wrapperFile;
    out.node = wrapperPaths(text).node;
    out.nodeExists = out.node !== null && await fs.stat(out.node).then(() => true, () => false);
  }
  for (const t of targets(platform, roots)) {
    const file = path.join(t.dir, manifestName(t.family, platform));
    if (await fs.stat(file).then(() => true, () => false)) out.found.push({ browser: t.browser, file });
    else out.absent.push({ browser: t.browser, vendor: t.vendor });
  }
  if (platform === "win32") {
    // Under an overridden root the registry is not ours to read either: a run
    // that must not write HKCU has no business reporting on it.
    if (roots.overridden && opts.registers !== true) {
      for (const t of registryTargets()) out.registry.push({ browser: t.browser, key: t.key, state: "not read" });
      return out;
    }
    const reg = opts.reg ?? runReg;
    for (const t of registryTargets()) {
      // `reg query` through the same seam: a key that is not there throws, which
      // is the answer rather than an error. A key that is there answers with the
      // value too, and that is the manifest path the row goes on to name.
      const answer = await reg(["query", t.key, "/ve"]).then(s => s, () => null);
      if (answer === null) { out.registry.push({ browser: t.browser, key: t.key, state: "not set" }); continue; }
      const file = regPath(answer);
      out.registry.push({ browser: t.browser, key: t.key, state: "set", ...(file === null ? {} : { path: file }) });
    }
  }
  return out;
}

export type NativeRemoved = { removed: string[]; failed: Failure[] };

/**
 * Take out everything `writeNativeHost` put in, and nothing else: the manifest
 * at its own name in each directory, the wrapper, the host and its one-line
 * package file, the registry values, and the `native/` folder when it is empty.
 * A directory the browser made is left alone, empty or not.
 */
export async function removeNativeHost(opts: NativeOptions): Promise<NativeRemoved> {
  const platform = opts.platform ?? process.platform;
  const roots = opts.roots ?? nativeRoots();
  const dir = path.join(opts.dataDir, NATIVE_DIR);
  const out: NativeRemoved = { removed: [], failed: [] };
  const drop = async (file: string) => {
    try {
      if (!await fs.stat(file).then(() => true, () => false)) return;
      await fs.rm(file, { force: true });
      out.removed.push(file);
    } catch (e) { out.failed.push({ where: file, why: why(e) }); }
  };
  for (const t of targets(platform, roots)) await drop(path.join(t.dir, manifestName(t.family, platform)));
  if (platform === "win32") {
    // The JSON files are under this data directory, so they go either way. The
    // registry keys are the person's own HKCU whatever the root says, so under
    // an overridden root they are left exactly as they are — a run that was
    // never allowed to write them must not delete them either.
    for (const t of registryTargets()) await drop(path.join(dir, manifestName(t.family, platform)));
    if (!roots.overridden || opts.registers === true) {
      const reg = opts.reg ?? runReg;
      for (const t of registryTargets()) {
        try { await reg(["delete", t.key, "/f"]); out.removed.push(t.key); }
        catch { /* a key that was never there is nothing to report */ }
      }
    }
  }
  for (const f of [wrapperName(platform), HOST_SCRIPT, HOST_PACKAGE]) await drop(path.join(dir, f));
  // Only when it is empty: a person may have put something of their own there.
  await fs.rmdir(dir).then(() => out.removed.push(dir), () => {});
  return out;
}
