# sidewalk — working notes for Claude

Start with `MANUAL.md` — it is the operator manual and is kept current.

## Where things are

| Topic | Read |
|---|---|
| Install, run the daemon, the MCP entry, a walk start to finish | `MANUAL.md` |
| What shipped when | `CHANGELOG.md` |
| The item / verdict / walk contract (zod, source of truth; JSON Schema via `toJsonSchema()`) | `packages/walkd/src/schema/index.ts`, published as `sidewalk-walkd/schema` |
| Daemon: streams on disk, HTTP+SSE, CLI | `packages/walkd/src/{store,http,cli}.ts` |
| Agent face: the six MCP tools | `packages/sidewalk-mcp/src/server.ts` |
| Extension: worker / content / page-world / panel | `packages/extension/src/{sw,content,main,panel}.ts` |
| The marketing demo: Lamppost, a walk of every feature, and the launcher that plays the agent | `demo/README.md` |
| The Claude Code plugin and the marketplace that lists it | `.claude-plugin/` |
| The one-page site and `sidewalk.sh/install` | `site/README.md` |

## What this is

An agent writes a walkthrough of a running web app; the person walks it in a
Chrome side panel next to the live site; verdicts go back to the agent as data.
Two append-only streams per walk (items agent→human, verdicts human→agent),
owned by one local daemon. Agent-agnostic on purpose: anything that speaks MCP
or can POST JSON runs a walk. First customer: the release walks of the first
product that used it.

## Conventions that bite

- **Install with npm 11** (`npx -y npm@11 install`). The npm bundled with Node
  22 crashes on this tree. Every dependency change goes through npm 11 so the
  lockfile does not churn.
- **Build before test.** `sidewalk-mcp` imports `walkd` from `dist/`; the
  extension build type-checks first. `npm run build && npm test`.
- **Ports**: daemon 8760, fixture site 9340 — those two are the human's, and
  nothing automated may take them. The e2e runs its own walkd on 8761 and its
  own fixture site on 9342, pointing the extension at the first through
  `chrome.storage.local`'s `walkd:port`; Playwright debugging is 9341.
  **Never 9222** — leave 9222 to the person's own tools.
  Unit tests bind port 0.
- **Streams are append-only.** Nothing in `items.jsonl` / `verdicts.jsonl` is
  ever rewritten; state is derived. A torn last line is skipped, never a reason
  to truncate. All store mutations run under the per-walk lock.
- **Verdict text is the person's words, verbatim.** No trimming beyond a
  trailing newline, no autocorrect in the pane, no paraphrase in the agent.
- **The daemon writes nothing into any project repo.** Data lives under
  `~/Library/Application Support/walkd/`; the agent's skill decides what a
  ledger gets.
- **Permissions posture**: least-needy where it costs nothing. Today
  `host_permissions: ["<all_urls>"]` is required — it is what makes screenshots
  always attach and Go never dead-end, and the store listing carries the
  justification. Any change to
  the manifest's permissions is a store-listing change: say so in the commit.
- **Stores are the plan.** Keep `manifest.json`
  store-clean: a real description, no debug permissions, `<all_urls>` with a
  one-paragraph justification ready for review. The Firefox port is
  `sidebar_action` plus the SSE client; do not let Chrome-only APIs creep into
  `panel.ts` / `render.ts` without a note.
- **One version number.** The daemon and the MCP server read theirs from
  their own `package.json`; `npm test` fails if the three packages, their
  internal pins, the extension's manifest and the plugin manifest's
  `sidewalk-mcp@X.Y.Z` pin disagree — five files, eight places. A release is
  `node scripts/version.mjs set X.Y.Z`, then
  `npx -y npm@11 install --package-lock-only`. Publish order is
  `sidewalk-walkd` → `sidewalk-mcp`, and it is the owner's call.
  `npm run pack:check` is what to run before asking him: it packs the two and
  fails on a missing file or a dependency that only resolves in a checkout.
- **Pushing, publishing to npm, and uploading to any store are the owner's
  explicit call, every time.** Local commits are fine at any point.

## How to check your work

```bash
npm run build && npm test          # 34 files, 470 unit tests
npm run e2e                        # 35 Playwright tests, unpacked extension vs fixtures/site
npm run pack:check                 # before a publish: the two packages as npm would send them
node packages/walkd/bin/walkd.js status
```

`npm run e2e` starts its own walkd on 8761 and its own fixture site on 9342, so
**leave the daemon you are using alone** — it is not in the suite's way and the
suite is not in its. It refuses to start only if something already answers on
8761. What the thirty-five tests cover is listed in `MANUAL.md` §7.

## Process

Review diffs, not reports.
