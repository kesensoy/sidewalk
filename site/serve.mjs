/**
 * sidewalk.sh, served from this folder the way Cloudflare would serve it.
 *
 * The same read-a-file-and-pipe-it shape as `demo/site/serve.mjs`, plus the two
 * things the deployed site relies on: `_redirects` and `_headers`. Cloudflare
 * reads both for a Worker's static assets; this server reads the same files, so
 * `/clips/go.gif` goes to the bucket here too and `/install` arrives as
 * text/plain, and the page is looked at with the links and the types it will
 * ship with.
 *
 *   node site/serve.mjs              # 9360
 *   PORT=9361 node site/serve.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** `_redirects`, one rule a line: `source destination [code]`, `*` at the end of a source. */
export function readRedirects(file = path.join(root, "_redirects")) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n")
    .map(l => l.trim()).filter(l => l && !l.startsWith("#"))
    .map(l => l.split(/\s+/))
    .filter(p => p.length >= 2)
    .map(([source, destination, code]) => ({ source, destination, code: Number(code ?? 302) }));
}

/**
 * `_headers`, a path on its own line and its headers indented under it:
 *
 *   /install
 *     content-type: text/plain; charset=utf-8
 */
export function readHeaders(file = path.join(root, "_headers")) {
  if (!fs.existsSync(file)) return [];
  const rules = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) { rules.push({ source: line.trim(), headers: {} }); continue; }
    const at = line.indexOf(":");
    if (at < 0 || !rules.length) continue;
    rules.at(-1).headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return rules;
}

/** The headers for `pathname` under `rules`, later rules winning. */
export function headersFor(pathname, rules) {
  const out = {};
  for (const r of rules) {
    const matches = r.source.endsWith("/*")
      ? pathname.startsWith(r.source.slice(0, -1))
      : r.source === pathname;
    if (matches) Object.assign(out, r.headers);
  }
  return out;
}

/** The destination for `pathname` under `rules`, or null. */
export function redirectFor(pathname, rules) {
  for (const r of rules) {
    if (r.source.endsWith("/*")) {
      const prefix = r.source.slice(0, -1);
      if (pathname.startsWith(prefix)) {
        return { to: r.destination.replace(":splat", pathname.slice(prefix.length)), code: r.code };
      }
    } else if (r.source === pathname) {
      return { to: r.destination, code: r.code };
    }
  }
  return null;
}

export function startSite(port = Number(process.env.PORT ?? 9360)) {
  const rules = readRedirects();
  const headerRules = readHeaders();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const name = url.pathname.replace(/\/+$/, "") || "/";

    const hop = redirectFor(name, rules);
    if (hop) {
      res.writeHead(hop.code, { location: hop.to, "cache-control": "no-store" });
      res.end();
      return;
    }

    let file = name === "/" ? path.join(root, "index.html") : path.join(root, path.normalize(name));
    // Cloudflare's `html_handling` default serves `privacy.html` at `/privacy`,
    // which is the URL both store listings give and the footer links. This
    // server answers the same way, so the link can be followed here too.
    if (!path.extname(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
    const hidden = path.basename(file).startsWith("_") || path.basename(file) === "serve.mjs";
    if (!file.startsWith(root) || hidden || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "content-type": TYPES[".html"], "cache-control": "no-store" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
      ...headersFor(name, headerRules),
    });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise(resolve => {
    server.listen(port, "127.0.0.1", () => {
      const bound = server.address().port;
      resolve({ server, port: bound, url: `http://127.0.0.1:${bound}`, stop: () => new Promise(r => server.close(() => r())) });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const site = await startSite();
  console.log(`sidewalk.sh on ${site.port}`);
}
