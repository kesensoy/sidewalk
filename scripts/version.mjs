#!/usr/bin/env node
// One version number, five files: the three package.json versions (and the
// internal pins between them), the extension's manifest, and the Claude Code
// plugin manifest — whose MCP entry pins the published package as
// `sidewalk-mcp@X.Y.Z`, so a plugin install can never ask the registry for a
// version this release did not ship. Exact, never a range: npx reuses any
// cached version that satisfies a range without asking the registry, so a
// caret would not carry patches either. The daemon and the MCP server read
// theirs from package.json at runtime, so this is every place the number is
// spelled.
// `check` is run by `npm test`; `set` is the release edit. Neither touches the
// lockfile — run `npx -y npm@11 install --package-lock-only` after `set`.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const PACKAGES = ["packages/walkd", "packages/sidewalk-mcp", "packages/extension"];
const INTERNAL = ["sidewalk-walkd", "sidewalk-mcp"];
const MANIFEST = "packages/extension/manifest.json";
const PLUGIN = ".claude-plugin/plugin.json";
/** The published package the plugin's MCP entry runs, pinned in its args. */
const PLUGIN_PIN = /("sidewalk-mcp@)([^"]+)(")/;
const SEMVER = /^\d+\.\d+\.\d+$/;

const readText = f => fs.readFileSync(path.join(root, f), "utf8");
const readJson = f => JSON.parse(readText(f));

/** Every spelling of the version, as [where, value]. */
function spellings() {
  const out = [];
  for (const p of PACKAGES) {
    const pkg = readJson(`${p}/package.json`);
    out.push([`${p}/package.json version`, pkg.version]);
    for (const name of INTERNAL) if (pkg.dependencies?.[name]) out.push([`${p}/package.json dependencies.${name}`, pkg.dependencies[name]]);
  }
  out.push([`${MANIFEST} version`, readJson(MANIFEST).version]);
  out.push([`${PLUGIN} version`, readJson(PLUGIN).version]);
  // A pin the regex cannot find is reported as missing rather than skipped, so
  // deleting the pin fails the check instead of passing it.
  out.push([`${PLUGIN} mcpServers.sidewalk args sidewalk-mcp@`, readText(PLUGIN).match(PLUGIN_PIN)?.[2] ?? "(no sidewalk-mcp@ pin)"]);
  return out;
}

function check() {
  const all = spellings();
  const distinct = [...new Set(all.map(([, v]) => v))];
  if (distinct.length === 1) { console.log(`version ${distinct[0]} in ${all.length} places`); return 0; }
  console.error("version: the files disagree");
  for (const [where, v] of all) console.error(`  ${v}\t${where}`);
  return 1;
}

/** Rewrite in place with a regex, so each file keeps its own formatting. */
function set(next) {
  if (!SEMVER.test(next)) { console.error(`version: ${next} is not X.Y.Z`); return 2; }
  for (const p of PACKAGES) {
    const f = path.join(root, p, "package.json");
    let s = fs.readFileSync(f, "utf8");
    s = s.replace(/("version":\s*")[^"]+(")/, `$1${next}$2`);
    // Inside the dependencies object only. A package's own name is spelled
    // elsewhere too — `"bin": { "walkd": "bin/walkd.js" }` comes first in the
    // file — and a bare replace would turn the CLI's path into a version.
    s = s.replace(/("dependencies"\s*:\s*\{)([^}]*)(\})/, (_all, head, deps, tail) => {
      for (const name of INTERNAL) deps = deps.replace(new RegExp(`("${name}":\\s*")[^"]+(")`), `$1${next}$2`);
      return head + deps + tail;
    });
    fs.writeFileSync(f, s);
  }
  const m = path.join(root, MANIFEST);
  fs.writeFileSync(m, fs.readFileSync(m, "utf8").replace(/("version":\s*")[^"]+(")/, `$1${next}$2`));
  const g = path.join(root, PLUGIN);
  fs.writeFileSync(g, fs.readFileSync(g, "utf8")
    .replace(/("version":\s*")[^"]+(")/, `$1${next}$2`)
    .replace(PLUGIN_PIN, `$1${next}$3`));
  console.log(`version ${next}; now: npx -y npm@11 install --package-lock-only`);
  return check();
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "check") process.exit(check());
else if (cmd === "set" && arg) process.exit(set(arg));
else { console.error("usage: node scripts/version.mjs check | set X.Y.Z"); process.exit(2); }
