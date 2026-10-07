import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A static site with the two things a walk item leans on: a build id in a meta
// tag for `expect`, a [data-walk] target to highlight, and a console.error at
// load so the console tail has something honest to carry.
const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 9340);

http
  .createServer((req, res) => {
    const name = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const f = path.join(root, name === "/" ? "index.html" : path.normalize(name));
    if (!f.startsWith(root) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    fs.createReadStream(f).pipe(res);
  })
  .listen(port, "127.0.0.1", () => console.log(`fixture on ${port}`));
