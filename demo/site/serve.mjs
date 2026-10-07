/**
 * Lamppost's static server.
 *
 * Grown from `fixtures/site/serve.mjs`: the same read-a-file-and-pipe-it
 * shape, plus the content types a real-looking site needs, clean page paths,
 * and one piece of state — the build id `/history` is serving. Every other
 * page carries `lp-24` in its own HTML; `/history` starts a build behind, at
 * `lp-23`, so a walk item's `expect` blocks the card until the launcher
 * rebuilds it. That is the demo's "this card is not ready yet" moment, and it
 * is a variable rather than a file edit so the demo can reset itself.
 *
 *   node demo/site/serve.mjs              # 9350
 *   PORT=9351 node demo/site/serve.mjs
 *
 *   GET  /__demo/history-build            -> {"build":"lp-23"}
 *   POST /__demo/history-build {"build":"lp-24"}
 *   POST /__demo/reset                    -> back to lp-23
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/** The build every page but `/history` is born with. */
export const BUILD = "lp-24";
/** The build `/history` starts on, and the one `POST /__demo/reset` restores. */
export const FIRST_HISTORY_BUILD = "lp-23";
const PLACEHOLDER = "__HISTORY_BUILD__";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Clean path -> the file that answers it. The pack's tests read it too. */
export const PAGES = {
  "/": "index.html",
  "/dashboard": "dashboard.html",
  "/history": "history.html",
  "/settings": "settings.html",
};

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

/**
 * Start the site. `port` 0 binds a free one, which is what the tests do.
 * Resolves once it is listening, with the port it actually got.
 */
export function startSite(port = Number(process.env.PORT ?? 9350)) {
  let historyBuild = FIRST_HISTORY_BUILD;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const name = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    const json = (status, data) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    };

    if (name === "/__demo/history-build") {
      if (method === "GET") return json(200, { build: historyBuild });
      if (method === "POST") {
        let want;
        try { want = (await body(req)).build; } catch { return json(400, { error: "body is not JSON" }); }
        if (typeof want !== "string" || !want) return json(400, { error: "build must be a non-empty string" });
        historyBuild = want;
        return json(200, { build: historyBuild });
      }
    }
    if (name === "/__demo/reset" && method === "POST") {
      historyBuild = FIRST_HISTORY_BUILD;
      return json(200, { build: historyBuild });
    }

    const page = PAGES[name] ?? (name.endsWith(".html") ? path.basename(name) : null);
    const file = page ? path.join(root, page) : path.join(root, path.normalize(name));
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "content-type": TYPES[".html"], "cache-control": "no-store" });
      res.end("Not found");
      return;
    }

    const type = TYPES[path.extname(file)] ?? "application/octet-stream";
    // The history page is the only one rewritten on the way out: its build id
    // is this server's variable, not a string in the file.
    if (path.basename(file) === "history.html") {
      const html = (await fsp.readFile(file, "utf8")).replaceAll(PLACEHOLDER, historyBuild);
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(html);
      return;
    }
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
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
  console.log(`lamppost on ${site.port}`);
}
