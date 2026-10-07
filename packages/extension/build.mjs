import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
const watch = process.argv.includes("--watch");
// Where it lands, and whether it carries its maps. `npm run build` keeps both
// defaults — dist/, with sourcemaps, which is what Load unpacked reads and what
// the e2e drives. `scripts/package.mjs` passes both: a store build goes to its
// own folder so dist/ is never disturbed mid-session, and ships no maps,
// because a .map is the one file in dist/ that no browser needs and every
// reviewer has to be told about.
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const outdir = arg("--out") ?? "dist";
const sourcemap = !process.argv.includes("--no-sourcemap");
mkdirSync(outdir, { recursive: true });
cpSync("manifest.json", `${outdir}/manifest.json`); cpSync("src/panel.html", `${outdir}/panel.html`); cpSync("src/panel.css", `${outdir}/panel.css`);
// Not an entry point — it is plain JavaScript, it imports nothing, and in
// Chrome it returns on its first line. `panel.html` loads it and the Firefox
// manifest puts it ahead of `sw.js`; `src/firefox.js` says why.
cpSync("src/firefox.js", `${outdir}/firefox.js`);
// The pane's face travels with the extension. Atkinson Hyperlegible is OFL, so
// OFL.txt ships beside the woff2 files; nothing here is fetched at runtime,
// which is what keeps a store-clean extension loading no remote resource.
cpSync("fonts", `${outdir}/fonts`, { recursive: true });
// The Kerb mark at the four sizes the manifest names; `node icons/render.mjs`
// regenerates them from the SVGs beside them. Only the PNGs ship.
mkdirSync(`${outdir}/icons`, { recursive: true });
for (const s of [16, 32, 48, 128]) cpSync(`icons/icon-${s}.png`, `${outdir}/icons/icon-${s}.png`);
// main.ts is the MAIN-world half of the console capture; it is registered as a
// content script, so it must be its own file in dist, not part of content.js.
const opts = { entryPoints: ["src/sw.ts", "src/panel.ts", "src/content.ts", "src/main.ts"], bundle: true, format: "esm", outdir, target: "chrome120", sourcemap, logLevel: "info" };
if (watch) (await context(opts)).watch(); else await build(opts);
