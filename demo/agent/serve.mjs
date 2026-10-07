/**
 * The agent terminal's static server.
 *
 * The same read-a-file-and-pipe-it shape as `demo/site/serve.mjs`, with one
 * extra job: `@xterm/xterm` lives in `node_modules`, and a page cannot import
 * across that boundary, so three of its files are mapped onto this origin.
 * Nothing is bundled and nothing is fetched from the network.
 *
 *   node demo/agent/serve.mjs              # 9354
 *   PORT=9355 node demo/agent/serve.mjs
 *
 * **9354**, beside Lamppost's 9353 and the recorder's walkd on 8763 — and
 * never 8760/9340 (the human's), 8761/9341/9342 (the e2e's), or 9222 (the
 * chrome-devtools MCP's).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
/** Resolved rather than spelled out, so a hoisted install still finds it. */
const xterm = path.dirname(require.resolve("@xterm/xterm/package.json"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** Clean path -> the file that answers it. The tests read it too. */
export const PAGES = { "/": "index.html" };

/** What the page imports that does not live beside it. */
export const VENDOR = {
  "/xterm.mjs": path.join(xterm, "lib", "xterm.mjs"),
  "/xterm.mjs.map": path.join(xterm, "lib", "xterm.mjs.map"),
  "/xterm.css": path.join(xterm, "css", "xterm.css"),
};

/** The version on the shelf, for `timeline.json` to record. */
export const xtermVersion = () => require("@xterm/xterm/package.json").version;

/**
 * Start the server. `port` 0 binds a free one, which is what the tests do.
 * Resolves once it is listening, with the port it actually got.
 */
export function startAgentPage(port = Number(process.env.PORT ?? 9354)) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const name = url.pathname.replace(/\/+$/, "") || "/";

    const vendor = VENDOR[name];
    const page = PAGES[name];
    const file = vendor ?? (page ? path.join(root, page) : path.join(root, path.normalize(name)));
    const inside = vendor ? file.startsWith(xterm) : file.startsWith(root);
    if (!inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { "content-type": TYPES[".html"], "cache-control": "no-store" });
      res.end("Not found");
      return;
    }
    const type = TYPES[path.extname(file)] ?? "application/octet-stream";
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
  const site = await startAgentPage();
  console.log(`agent terminal on ${site.port} (@xterm/xterm ${xtermVersion()})`);
}
