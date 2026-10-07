#!/usr/bin/env node
/**
 * Build the two store artifacts, and the source zip AMO asks for.
 *
 *   npm run package                 # from the repo root
 *   node packages/extension/scripts/package.mjs [--no-source] [--no-lint]
 *
 * Writes into `packages/extension/store/`, which is gitignored — a zip is a
 * build output and the tree already holds everything it was built from:
 *
 *   sidewalk-chrome-<version>.zip   the Chrome Web Store upload
 *   sidewalk-firefox-<version>.zip  the AMO upload
 *   sidewalk-source-<version>.zip   the source AMO's reviewer reads beside it
 *   build/chrome, build/firefox     the unpacked trees the zips were made of,
 *                                   left behind so `web-ext run` and
 *                                   about:debugging have something to load
 *
 * `.mjs`, not `.sh`: `MANUAL.md` §1 says this tree builds on Windows, and
 * a bash packager would be the one step that did not. The reference packagers
 * it is modelled on are two earlier add-ons' (the three-zip shape, the staging
 * tree, `git ls-files | zip -@` for the source, `web-ext build` as the zipper,
 * the manifest patched for Firefox only).
 *
 * Two things it does that neither of those does, both because they cost
 * nothing here: it reads the version through `scripts/version.mjs`, so a tree
 * whose five version spellings disagree cannot be packaged at all; and it runs
 * `web-ext lint` over the Firefox build and refuses on an error.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { patchManifest } from "./firefox-manifest.mjs";

const HERE = import.meta.dirname;
const EXT = path.resolve(HERE, "..");
const ROOT = path.resolve(EXT, "../..");
const STORE = path.join(EXT, "store");
const BUILD = path.join(STORE, "build");
const noSource = process.argv.includes("--no-source");
const noLint = process.argv.includes("--no-lint");

const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
const node = (file, args, cwd) => run(process.execPath, [file, ...args], cwd);
/** node_modules/.bin is not on PATH unless npm put it there; resolve it ourselves. */
const webExt = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "web-ext.cmd" : "web-ext");

/**
 * The one version, from the one place that knows it.
 *
 * `version.mjs check` exits non-zero when the five spellings disagree, which
 * is the whole point of asking it rather than reading the manifest: a zip
 * built from a tree mid-bump would carry a manifest version that nothing else
 * in the release agrees with, and the store keeps it for good.
 */
function version() {
  const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "version.mjs"), "check"], { cwd: ROOT, encoding: "utf8" });
  const m = /^version (\d+\.\d+\.\d+) in \d+ places/m.exec(out);
  if (!m) throw new Error(`version.mjs check said something unexpected: ${out.trim()}`);
  return m[1];
}

/** `web-ext build`, which is a cross-platform zip that happens to know manifests. */
function zip(sourceDir, filename) {
  run(webExt, ["build", "-s", sourceDir, "-a", STORE, "--overwrite-dest", "--filename", filename, "--no-config-discovery"]);
}

const v = version();
rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });

// ---------------------------------------------------------------- chrome
//
// Its own esbuild run rather than a copy of `dist`: `dist` is whatever the
// last `npm run build` or `--watch` left there, with sourcemaps beside every
// bundle. A store build is made fresh, into its own folder, with no maps —
// nothing in the zip should be a file no browser reads.
const chrome = path.join(BUILD, "chrome");
node(path.join(EXT, "build.mjs"), ["--out", chrome, "--no-sourcemap"], EXT);
zip(chrome, `sidewalk-chrome-${v}.zip`);

// --------------------------------------------------------------- firefox
//
// The same bytes, one patched manifest. Copying the finished Chrome build
// rather than building twice is what makes "Chrome's build must not change"
// checkable: if the two trees differ anywhere but manifest.json, something
// here did it on purpose.
const firefox = path.join(BUILD, "firefox");
cpSync(chrome, firefox, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(chrome, "manifest.json"), "utf8"));
writeFileSync(path.join(firefox, "manifest.json"), JSON.stringify(patchManifest(manifest), null, 2) + "\n");

if (!noLint) {
  // Errors only. The warnings that survive are known and listed in the store
  // listing, kept outside the repo; a new one is worth a person's eye but is
  // not a reason to refuse to build a zip.
  const out = execFileSync(webExt, ["lint", "-s", firefox, "--no-config-discovery", "-o", "json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const report = JSON.parse(out);
  for (const w of report.warnings) console.log(`web-ext lint warning: ${w.code} ${w.file ?? ""}${w.line ? `:${w.line}` : ""}`);
  if (report.errors.length) {
    for (const e of report.errors) console.error(`web-ext lint ERROR: ${e.code} — ${e.message}`);
    throw new Error(`web-ext lint: ${report.errors.length} error(s) in the Firefox build`);
  }
  console.log(`web-ext lint: 0 errors, ${report.warnings.length} warnings`);
}
zip(firefox, `sidewalk-firefox-${v}.zip`);

// ---------------------------------------------------------------- source
//
// AMO asks for source whenever the uploaded files are not the files that were
// written — esbuild bundles four entry points into four files, so they are
// not. `git ls-files` is the list, which keeps every gitignored thing
// (node_modules, dist, the takes under demo/out, this store folder) out of it
// without a strip list to maintain. `-FS` so a file deleted since the last
// release cannot survive in the archive: `zip -@` alone only ever adds.
if (!noSource) {
  const out = path.join(STORE, `sidewalk-source-${v}.zip`);
  rmSync(out, { force: true });
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  execFileSync("zip", ["-q", "-FS", "-@", out], { cwd: ROOT, input: tracked });
}

const kb = f => `${(statSync(path.join(STORE, f)).size / 1024).toFixed(0)} KB`;
console.log(`\npackaged ${v}:`);
for (const f of readdirSync(STORE).filter(f => f.endsWith(".zip")).sort()) console.log(`  ${f.padEnd(34)} ${kb(f)}`);
console.log(`\nunpacked, for web-ext run and about:debugging:\n  ${path.relative(ROOT, chrome)}\n  ${path.relative(ROOT, firefox)}`);
