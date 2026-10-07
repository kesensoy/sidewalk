# sidewalk.sh

The one-page site. Static: `index.html`, `site.css`, `site.js` (the strip
that shows one clip at a time, and the Copy button; without it the five
clips stack), the mark, `stills/` (frame 0 of the hero clip, light and dark,
painted under the gif while it loads), the Atkinson Hyperlegible files the
extension already ships (OFL, `fonts/OFL.txt`). No build step, no analytics,
no cookies, nothing fetched from a third party.

## The clips

The gifs are not in this repo. The page asks for `/clips/<name>.gif` and
`/clips/dark/<name>.gif`, and **`_redirects`** holds the one line that sends
those to the `sidewalk-assets` bucket. Cloudflare reads that file for a
Worker's static assets; `serve.mjs` reads the same file, so the page is looked
at locally with the links it ships with. The bucket answers at
`assets.sidewalk.sh`, and that hostname is written in the one line of
`_redirects` and nowhere else.

## The install script

`install` is what `curl -fsSL https://sidewalk.sh/install | sh` runs: POSIX
`sh`, `set -eu`, no sudo, nothing different on a second run. It checks for Node
22 and npm, installs `sidewalk-walkd` and `sidewalk-mcp` globally, adds the MCP server
when `claude` is on PATH, and prints the two things left for the person. The
name has no extension so the one-liner reads well, which means nothing can
infer its type: **`_headers`** holds the one rule that serves `/install` as
`text/plain; charset=utf-8`, so a browser shows the script instead of
downloading it. Cloudflare reads `_headers` for a Worker's static assets the
way it reads `_redirects`, and `serve.mjs` reads both, so the local view
answers with the same types. Every sentence the script prints was settled in
review; `install.test.ts` runs the script under `sh -n` and under a PATH of
stub `node` / `npm` / `claude`, one run per branch, and fails if a review
marker ever comes back.

## Look at it

```bash
node site/serve.mjs          # http://127.0.0.1:9360
PORT=9361 node site/serve.mjs
curl -i http://127.0.0.1:9360/install     # text/plain, the script itself
```

## Deploy

As a Worker with static assets and no Worker code. `wrangler.jsonc` beside
this file names the Worker `sidewalk-site` and uploads this folder as is,
minus `.assetsignore`'s list. No secrets, no bindings.

```bash
cd site
npx wrangler login              # once, on this machine
npx wrangler deploy             # uploads the folder; prints the workers.dev URL
```

Pointing `sidewalk.sh` at it is a zone change (a custom domain on the Worker,
or a route): `routes[].custom_domain` in `wrangler.jsonc` does this on deploy.
It is also deployable as a Pages project with the same folder and no build
command; `_redirects` means the same thing there.

Nothing here deploys itself. A deploy is the owner's word, every time.
