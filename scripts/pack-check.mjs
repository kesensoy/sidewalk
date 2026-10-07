#!/usr/bin/env node
/**
 * The pre-publish gate: what `npm publish` would actually send for the two
 * published packages. Run it before every publish (`npm run pack:check`), and
 * read it as a checklist of what a fresh `npm i` on another machine needs.
 *
 * Two packs per package, because they prove different things:
 *   1. `npm pack --dry-run --json` — the file list. A missing `dist/`, README
 *      or LICENSE, or a bin that lost its executable bit, fails here.
 *   2. a real `npm pack` into a temp dir, then `package/package.json` out of
 *      the tarball — the manifest as the registry would receive it. This is
 *      the only place a `workspace:` / `file:` / `link:` dependency left in
 *      the tree is caught for certain: those resolve inside a checkout and
 *      nowhere else, so a package carrying one installs on this machine and
 *      breaks on every other.
 *
 * The tarballs go to a temp dir outside the repo and are deleted; nothing is
 * published and nothing is left behind. `scripts/version.mjs check` runs first
 * (the root `pack:check` script chains it) so a drifted internal pin fails
 * before any of this.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

/** The two packages npm publishes, in publish order, with what each one owes. */
const PUBLISHED = [
  { dir: "packages/walkd", name: "sidewalk-walkd", bin: "bin/walkd.js", files: ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts", "dist/schema/index.js", "dist/schema/index.d.ts", "bin/walkd.js"] },
  { dir: "packages/sidewalk-mcp", name: "sidewalk-mcp", bin: "bin/sidewalk-mcp.js", files: ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts", "bin/sidewalk-mcp.js"] },
];
/** Everything else in the workspace must say so. */
const NOT_PUBLISHED = ["packages/extension"];
/** Ranges that resolve in a checkout and nowhere else. */
const LOCAL_PROTOCOLS = ["workspace:", "file:", "link:", "portal:"];
const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

const problems = [];
const say = s => console.log(s);
const fail = s => problems.push(s);

const npm = (args, cwd) => execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const readJson = f => JSON.parse(fs.readFileSync(f, "utf8"));

/** `npm pack --dry-run --json` is an array of one report. */
function packReport(args, cwd) {
  const out = npm(["pack", "--json", ...args], cwd);
  const start = out.indexOf("[");
  return JSON.parse(start > 0 ? out.slice(start) : out)[0];
}

function checkDeps(where, pkg, ownVersion) {
  for (const field of DEP_FIELDS) {
    for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
      const local = LOCAL_PROTOCOLS.find(p => String(range).startsWith(p));
      if (local) fail(`${where}: ${field}.${dep} is "${range}" — ${local} resolves in a checkout only`);
      // The two internal packages move as one number, so a pin that drifted
      // would publish a package asking the registry for a version that is not
      // there yet. version.mjs owns the number; this is the publish-side net.
      if (dep === "sidewalk-walkd" && range !== ownVersion) {
        fail(`${where}: ${field}.${dep} is "${range}", not this package's own ${ownVersion}`);
      }
    }
  }
}

const rootVersion = readJson(path.join(root, "packages/walkd/package.json")).version;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sidewalk-pack-"));

try {
  for (const { dir, name, bin, files } of PUBLISHED) {
    const cwd = path.join(root, dir);
    const pkg = readJson(path.join(cwd, "package.json"));

    if (pkg.name !== name) fail(`${dir}: name is "${pkg.name}", expected "${name}"`);
    if (pkg.private) fail(`${dir}: private: true would refuse to publish`);
    if (pkg.version !== rootVersion) fail(`${dir}: version ${pkg.version} is not ${rootVersion}`);
    for (const key of ["description", "license", "files", "engines", "publishConfig", "repository", "homepage"]) {
      if (pkg[key] === undefined) fail(`${dir}: no ${key}`);
    }
    if (!pkg.engines?.node) fail(`${dir}: no engines.node`);
    if (!pkg.scripts?.prepublishOnly) fail(`${dir}: no prepublishOnly, so a stale dist could ship`);
    if (bin && !Object.values(pkg.bin ?? {}).includes(bin)) fail(`${dir}: bin does not point at ${bin}`);

    // 1. the file list, without writing anything
    const dry = packReport(["--dry-run"], cwd);
    const packed = new Map(dry.files.map(f => [f.path, f]));
    for (const want of files) if (!packed.has(want)) fail(`${name}: ${want} is not in the tarball`);
    if (bin) {
      const entry = packed.get(bin);
      if (entry && !(entry.mode & 0o111)) fail(`${name}: ${bin} is not executable (mode ${entry.mode.toString(8)})`);
      const first = fs.readFileSync(path.join(cwd, bin), "utf8").split("\n")[0];
      if (first !== "#!/usr/bin/env node") fail(`${name}: ${bin} does not start with #!/usr/bin/env node`);
    }
    for (const f of dry.files) if (f.path.endsWith(".test.js") || f.path.endsWith(".test.d.ts")) fail(`${name}: ${f.path} is a test file`);

    // 2. the manifest as the registry would get it
    const real = packReport([`--pack-destination=${tmp}`], cwd);
    const tgz = path.join(tmp, real.filename);
    const manifest = JSON.parse(execFileSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8" }));
    checkDeps(`${name} (packed)`, manifest, manifest.version);
    checkDeps(`${dir}`, pkg, pkg.version);

    say(`${name}@${manifest.version}  ${dry.entryCount} files, ${real.filename}`);
    for (const field of DEP_FIELDS) {
      const deps = manifest[field];
      if (deps) say(`  ${field}: ${Object.entries(deps).map(([d, r]) => `${d}@${r}`).join(", ")}`);
    }
  }

  for (const dir of NOT_PUBLISHED) {
    const pkg = readJson(path.join(root, dir, "package.json"));
    if (!pkg.private) fail(`${dir}: not private, so a workspace-wide publish would send it`);
    else say(`${pkg.name}  private, not published`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (problems.length) {
  console.error(`\npack:check failed, ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`\npack:check passed: two packages at ${rootVersion}, nothing local left in a dependency`);
