/**
 * The launcher, driven end to end with tiny timers against a daemon and a
 * Lamppost of this test's own — both on port 0, no Chrome anywhere. What it
 * holds: the walk opens with the brief, group A lands, the history flip
 * changes what `/history` serves, group B lands on the timer, a verdict posted
 * the way the pane posts one is picked up by the agent read (so `delivered`
 * moves and the person's Undo goes red), and an `ask` is answered with an info
 * card.
 */
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WalkStore, createHttpServer } from "sidewalk-walkd";
// @ts-expect-error — the demo is plain .mjs, with no types to import.
import { startSite } from "./site/serve.mjs";
// @ts-expect-error — same.
import { findToken, main, makeDaemon, nextWalkId, verdictLine } from "./run.mjs";

let store: WalkStore;
let daemon: import("node:http").Server;
let dPort = 0;
let site: any;
let tmp = "";

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lamppost-"));
  store = new WalkStore(tmp);
  daemon = createHttpServer(store);
  await new Promise<void>(r => daemon.listen(0, "127.0.0.1", r));
  dPort = (daemon.address() as AddressInfo).port;
  site = await startSite(0);
});

afterAll(async () => {
  await site.stop();
  await new Promise<void>(r => daemon.close(() => r()));
  await fs.rm(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/**
 * Poll until `fn` returns something truthy, or give up loudly — with what the
 * launcher had printed by then, which is where the reason usually is.
 */
const printed: string[] = [];
async function until<T>(what: string, fn: () => Promise<T> | T, ms = 12_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; the launcher said:\n${printed.join("\n")}`);
    await sleep(20);
  }
}

const ids = async (walk: string) => (await store.read(walk, 0, { viewer: true })).items.map(i => i.id);
const groupOf = async (walk: string, id: string) =>
  (await store.read(walk, 0, { viewer: true })).items.find(i => i.id === id)?.group;
/** A verdict in the shape the pane sends: a nonce and the page's context. */
const post = (walk: string, body: unknown) =>
  fetch(`http://127.0.0.1:${dPort}/walks/${walk}/verdicts`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }).then(r => r.json());
const verdict = (itemId: string, kind: string, text: string, nonce: string) => ({
  itemId, kind, text, nonce,
  context: { url: `${site.url}/`, buildId: "lp-24", viewport: [1280, 800], console: [], userAgent: "vitest" },
});

it("numbers the next walk one past the highest open demo-<n>", () => {
  expect(nextWalkId([])).toBe("demo-1");
  expect(nextWalkId([{ project: "lamppost", id: "demo-2" }, { project: "lamppost", id: "demo-7" }])).toBe("demo-8");
  expect(nextWalkId([{ project: "other", id: "demo-9" }, { project: "lamppost", id: "walk-11" }])).toBe("demo-1");
});

it("prints a verdict as kind, item and the words", () => {
  expect(verdictLine({ kind: "issue", itemId: "lp-lock", text: "the banner\nstayed up" })).toBe('issue lp-lock "the banner stayed up"');
});

it("plays the whole demo: group A, the rebuild, group B, a verdict, an ask", async () => {
  const lines = printed;
  const handle = await main({
    port: dPort, site: site.port,
    afterMs: 700, readMs: 30, doneMs: 60_000,
    log: (l: string) => lines.push(l),
  });

  // 1. The walk is open, with the brief the pack carries.
  expect(handle.id).toBe("demo-1");
  const walk = await store.get(handle.id);
  expect(walk.project).toBe("lamppost");
  expect(walk.title).toBe("Lamppost 2.4");
  expect(walk.brief).toContain("Start on the home page");
  expect(lines).toContain("Walk demo-1.");

  // 2. Group A is on the pane, grouped.
  expect(await ids(handle.id)).toEqual(["lp-lamps", "lp-lock", "lp-tiers", "lp-history"]);
  expect(await groupOf(handle.id, "lp-lamps")).toBe("home and lamps");
  expect(lines).toContain("Group A on the pane.");

  // 3. History is a build behind, which is what blocks the lp-history card.
  expect(await (await fetch(`${site.url}/history`)).text()).toContain('content="lp-23"');

  // 4. The timer rebuilds it and lands group B.
  await until("group B", async () => (await ids(handle.id)).includes("lp-landed"));
  expect(await (await fetch(`${site.url}/history`)).text()).toContain('content="lp-24"');
  expect(await groupOf(handle.id, "lp-key")).toBe("settings");
  expect(lines).toContain("Group B on the pane; history rebuilt.");

  // 5. A verdict the pane's way: the agent read picks it up and `delivered`
  //    moves, which is what turns the green Undo red.
  const passed = await post(handle.id, verdict("lp-lamps", "pass", "all five green", "n-1"));
  await until("the read", () => lines.includes('pass lp-lamps "all five green"'));
  expect((await store.get(handle.id)).delivered).toBeGreaterThanOrEqual(passed.seq);

  // 6. An ask is answered with the pack's info item, id suffixed by the seq.
  //    `supersedes` is what puts it on the asked card rather than on one of
  //    its own (packages/extension/src/replies.ts).
  const asked = await post(handle.id, verdict("lp-lock", "ask", "is the banner meant to stay?", "n-2"));
  const reply = `lp-ask-${asked.seq}`;
  await until("the ask reply", async () => (await ids(handle.id)).includes(reply));
  const item: any = (await store.read(handle.id, 0, { viewer: true })).items.find(i => i.id === reply);
  expect(item.kind).toBe("info");
  expect(item.supersedes).toBe("lp-lock");
  expect(item.group).toBe("home and lamps"); // the group of the card it was asked from
  expect(item.title).toBe("Yes, the slash is on purpose");
  expect(item.body).toContain("ends with a slash");

  // 7. Stopping closes the walk and counts what it read.
  await handle.stop();
  await handle.finished;
  const closed = await store.get(handle.id);
  expect(closed.closedAt).toBeTruthy();
  expect(closed.summary).toBe("Lamppost demo: 2 verdicts.");
}, 30_000);

/**
 * `landGroupB` is how a recording hits its mark: `demo/record.mjs` pushes the
 * timer past the end of its take and lands the second group on the beat it
 * wants. Against a made-up daemon and a made-up site, so the one thing under
 * test is that the group lands once however many things ask for it.
 */
it("lands group B on demand, and only ever once", async () => {
  const added: any[] = [];
  const flips: string[] = [];
  const daemon = {
    healthy: async () => true,
    list: async () => [],
    open: async (w: any) => w,
    add: async (_id: string, items: any[]) => { added.push(...items); return { ok: true }; },
    read: async () => ({ cursor: 0, verdicts: [] }),
    close: async () => ({ ok: true }),
  };
  const siteHandle = {
    start: async () => "already",
    reset: async () => ({}),
    flipHistory: async (build: string) => { flips.push(build); },
    stop: () => {},
  };

  const handle = await main({ daemon, siteHandle, afterMs: 60_000, readMs: 60_000, doneMs: 60_000, log: () => {} });
  expect(added.map(i => i.id)).toEqual(["lp-lamps", "lp-lock", "lp-tiers", "lp-history"]);
  expect(flips).toEqual([]);

  expect(await handle.landGroupB()).toBe(true);
  expect(flips).toEqual(["lp-24"]);                       // history caught up with the build
  expect(added.map(i => i.id)).toContain("lp-landed");
  expect(added.find(i => i.id === "lp-key").group).toBe("settings");

  // The timer is still armed; whichever gets there second does nothing.
  expect(await handle.landGroupB()).toBe(false);
  expect(added.filter(i => i.id === "lp-landed")).toHaveLength(1);

  await handle.stop();
  await handle.finished;
});

/**
 * The token (secrets review). The launcher talks to a daemon it did not
 * start, so it finds the token the way `sidewalk-mcp` does — the state file
 * names the data dir, the data dir holds the file — and asks the daemon first
 * whether it wants one at all.
 */
it("sends the token on every call, and sends none to a daemon that is not asking", async () => {
  const base = `http://127.0.0.1:${dPort}`;
  // The `daemon` of this file has no token configured, and says `auth: "none"`.
  expect(await findToken({ base })).toBe("");

  const had = process.env.WALKD_TOKEN;
  process.env.WALKD_TOKEN = "from-the-environment";
  try { expect(await findToken({ base })).toBe("from-the-environment"); }
  finally { if (had === undefined) delete process.env.WALKD_TOKEN; else process.env.WALKD_TOKEN = had; }

  // One that is asking, and the header the launcher then puts on every call.
  const tokened = createHttpServer(new WalkStore(tmp), { auth: { token: "tok", file: path.join(tmp, "token") } });
  await new Promise<void>(r => tokened.listen(0, "127.0.0.1", r));
  const port = (tokened.address() as AddressInfo).port;
  try {
    const refused = makeDaemon(`http://127.0.0.1:${port}`);
    await expect(refused.list()).rejects.toThrow(/walkd 401/);
    const allowed = makeDaemon(`http://127.0.0.1:${port}`, "tok");
    expect(Array.isArray(await allowed.list())).toBe(true);
  } finally { await new Promise<void>(r => tokened.close(() => r())); }
});
