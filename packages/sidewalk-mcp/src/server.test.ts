import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises"; import os from "node:os"; import path from "node:path";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { WalkStore, createHttpServer } from "sidewalk-walkd";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DaemonClient } from "./client.js";
import { buildServer } from "./server.js";

let server: ReturnType<typeof createHttpServer>; let mcp: Client; let store: WalkStore;
beforeAll(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sidewalk-mcp-srv-"));
  store = new WalkStore(dir); server = createHttpServer(store);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const client = new DaemonClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(client).connect(a);
  mcp = new Client({ name: "test", version: "0" }); await mcp.connect(b);
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const text = (r: any) => JSON.parse(r.content[0].text);

describe("sidewalk-mcp tools", () => {
  it("lists the six tools", async () => {
    const names = (await mcp.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual(["walk_add_items", "walk_close", "walk_open", "walk_read", "walk_wait", "walk_withdraw"]);
  });
  it("hands every client the authoring guide as server instructions", async () => {
    // The owner, 2026-09-17: "agents using the MCP also get some info or a skill
    // or something to kind of gain this understanding of how to create a good
    // walk naturally right?" The guide rides the initialize handshake, so an
    // agent that connects has it before its first walk_open.
    const guide = mcp.getInstructions() ?? "";
    for (const word of ["sequence", "look", "question", "info", "expect", "walk_wait", "verbatim"]) expect(guide).toContain(word);
    const add = (await mcp.listTools()).tools.find(t => t.name === "walk_add_items")!;
    expect(add.description).toContain("sequence");
  });
  it("advertises the package's own version in the handshake", () => {
    // The pane tells a person when the daemon is another release; the agent's
    // side can only do the same if the initialize handshake carries the real
    // number rather than one typed in by hand.
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(mcp.getServerVersion()?.version).toBe(pkg.version);
  });
  it("introduces itself as sidewalk", () => {
    // The name the handshake carries is the name an agent sees its tools
    // under (mcp__sidewalk__walk_*), and the one the pane's install line
    // adds. walkd is the daemon; this is the entry a person adds.
    expect(mcp.getServerVersion()?.name).toBe("sidewalk");
  });
  it("runs a walk end to end", async () => {
    const w = text(await mcp.callTool({ name: "walk_open", arguments: { project: "p", title: "Walk 11", buildRef: "b" } }));
    expect(w.id).toBe("walk-11");
    const added = text(await mcp.callTool({ name: "walk_add_items", arguments: { walk: "walk-11", items: [
      { id: "a", kind: "look", owner: "gate", title: "a", url: "http://127.0.0.1:9340/", do: "d", see: "s", pass: "p", expect: [] } ] } }));
    expect(added.seqs).toEqual([1]);
    await store.addVerdict("walk-11", { itemId: "a", kind: "issue", text: "hairline", nonce: "nonce-0001",
      context: { url: "http://127.0.0.1:9340/", viewport: [1, 1], console: [], userAgent: "ua" } });
    const waited = text(await mcp.callTool({ name: "walk_wait", arguments: { walk: "walk-11", after: 0, timeoutMs: 0 } }));
    expect(waited.verdicts[0].text).toBe("hairline"); expect(waited.cursor).toBe(1);
    const read = text(await mcp.callTool({ name: "walk_read", arguments: { walk: "walk-11" } }));
    expect(read.items).toHaveLength(1);
    const wd = text(await mcp.callTool({ name: "walk_withdraw", arguments: { walk: "walk-11", itemId: "a", reason: "r" } }));
    expect(wd.withdrawReason).toBe("r");
    const closed = text(await mcp.callTool({ name: "walk_close", arguments: { walk: "walk-11", summary: "s" } }));
    expect(closed.closedAt).toBeTruthy();
  });
  it("returns isError with the daemon message on a bad call", async () => {
    const r: any = await mcp.callTool({ name: "walk_read", arguments: { walk: "nope" } });
    expect(r.isError).toBe(true); expect(r.content[0].text).toMatch(/not found/);
  });
});

/**
 * Is anybody watching? The agent cannot see the panel, and nothing can push to
 * it, so a walk written for nobody looks exactly like a walk written for
 * somebody until a verdict arrives — or does not. `viewers` is the one fact that
 * tells the two apart: open `/events` streams, which only a panel holds.
 */
describe("the viewer count the agent is told", () => {
  const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const open = async (id: string) => text(await mcp.callTool({ name: "walk_open", arguments: { project: "viewers", title: "Viewers", buildRef: "b", id } }));

  it("rides on walk_open, and is 0 when nothing is watching", async () => {
    const w = await open("viewers-none");
    expect(w.viewers).toBe(0);
    // `started` is absent rather than false: this client never spawned a daemon.
    expect(w.started).toBeUndefined();
  });

  it("counts a panel that is holding the stream, and stops counting it when it goes", async () => {
    const stream = await fetch(`${base()}/events`);
    try {
      let w = await open("viewers-one");
      for (let i = 0; i < 100 && w.viewers === 0; i++) { await new Promise(r => setTimeout(r, 10)); w = await open("viewers-one"); }
      expect(w.viewers).toBe(1);
    } finally { await stream.body?.cancel(); }
    let w = await open("viewers-one");
    for (let i = 0; i < 100 && w.viewers !== 0; i++) { await new Promise(r => setTimeout(r, 10)); w = await open("viewers-one"); }
    expect(w.viewers).toBe(0);
  });

  it("rides on an empty walk_wait, which is the call that might mean nobody is there", async () => {
    await open("viewers-wait");
    const empty = text(await mcp.callTool({ name: "walk_wait", arguments: { walk: "viewers-wait", after: 0, timeoutMs: 0 } }));
    expect(empty.verdicts).toEqual([]);
    expect(empty.viewers).toBe(0);
  });

  it("stays off a wait that carries verdicts: a person has already answered", async () => {
    await open("viewers-answered");
    await store.addItems("viewers-answered", [{ id: "a", kind: "info", owner: "gate", title: "a", body: "b" }]);
    await store.addVerdict("viewers-answered", { itemId: "a", kind: "dismiss", text: "", nonce: "nonce-0002",
      context: { url: "http://127.0.0.1:9340/", viewport: [1, 1], console: [], userAgent: "ua" } });
    const answered = text(await mcp.callTool({ name: "walk_wait", arguments: { walk: "viewers-answered", after: 0, timeoutMs: 0 } }));
    expect(answered.verdicts).toHaveLength(1);
    expect(answered.viewers).toBeUndefined();
  });

  it("says in the instructions what an agent is to do about a 0, and never asks for the token", () => {
    const guide = mcp.getInstructions() ?? "";
    expect(guide).toContain("viewers is how many panels hold walkd's stream");
    expect(guide).toContain("tell the person to open the sidewalk side panel");
    expect(guide).toContain("npx -y sidewalk-walkd token --copy");
    expect(guide).toContain("Never ask for the token and never print one");
  });
});

describe("walk_wait bounds", () => {
  it("refuses a timeout past undici's headersTimeout", async () => {
    const tools = (await mcp.listTools()).tools;
    const wait = tools.find(t => t.name === "walk_wait")!;
    expect((wait.inputSchema as any).properties.timeoutMs.maximum).toBe(280000);
    expect(wait.description).toContain("280000");
    const r: any = await mcp.callTool({ name: "walk_wait", arguments: { walk: "walk-11", after: 0, timeoutMs: 280001 } })
      .catch((e: unknown) => ({ isError: true, thrown: String(e) }));
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toMatch(/280000/);
  });
});

describe("walk_wait screenshot paths", () => {
  it("resolves a shot path from the cached project, not a re-read", async () => {
    const w = text(await mcp.callTool({ name: "walk_open", arguments: { project: "shots-proj", title: "Shots", buildRef: "b", id: "shots" } }));
    await mcp.callTool({ name: "walk_add_items", arguments: { walk: "shots", items: [
      { id: "a", kind: "look", owner: "gate", title: "a", url: "http://127.0.0.1:9340/", do: "d", see: "s", pass: "p", expect: [] } ] } });
    await store.addVerdict("shots", { itemId: "a", kind: "pass", text: "ok", nonce: "n-shot",
      context: { url: "http://127.0.0.1:9340/", viewport: [1, 1], console: [], userAgent: "ua",
        screenshotBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") } });
    const r = text(await mcp.callTool({ name: "walk_wait", arguments: { walk: "shots", after: 0, timeoutMs: 0 } }));
    // shotPath joins with the platform separator, so the tail is built the same
    // way rather than spelled with POSIX slashes: on Windows this is `\`.
    const sep = path.sep === "\\" ? "\\\\" : "/";
    expect(r.verdicts[0].screenshotPath).toMatch(new RegExp(`${sep}shots-proj${sep}shots${sep}shots${sep}000001\\.jpg$`));
    expect((await fs.stat(r.verdicts[0].screenshotPath)).size).toBe(4);
    expect(w.project).toBe("shots-proj");
  });
});

describe("an ask, as the agent receives it", () => {
  // An early agent session answered the person's question in its own chat, and
  // the person never saw it. Nothing in the verdict had said where the answer
  // belonged, and `walk_read` gave it no way to notice the ask again later.
  const ctx = { url: "http://127.0.0.1:9340/", viewport: [1, 1] as [number, number], console: [], userAgent: "ua" };
  const look = (id: string) => ({ id, kind: "look" as const, owner: "gate", title: id, url: "http://127.0.0.1:9340/", do: "d", see: "s", pass: "p", expect: [] });

  it("carries a reply line on the ask and on nothing else", async () => {
    await mcp.callTool({ name: "walk_open", arguments: { project: "asks-proj", title: "Asks", buildRef: "b", id: "asks" } });
    await mcp.callTool({ name: "walk_add_items", arguments: { walk: "asks", items: [look("a"), look("b")] } });
    await store.addVerdict("asks", { itemId: "a", kind: "ask", text: "which build is this?", nonce: "n-ask-1", context: ctx });
    await store.addVerdict("asks", { itemId: "b", kind: "pass", text: "ok", nonce: "n-ask-2", context: ctx });
    const waited = text(await mcp.callTool({ name: "walk_wait", arguments: { walk: "asks", after: 0, timeoutMs: 0 } }));
    expect(waited.verdicts[0].reply).toBe("Answer in the pane: add an info or question item on this walk, in the same group as a, with supersedes set to a. That is what marks the ask answered. The person is reading the pane, not your chat. Reply only when you have the answer; if the ask can be read two ways, make it a question whose options are the readings.");
    expect("reply" in waited.verdicts[1]).toBe(false);
    const read = text(await mcp.callTool({ name: "walk_read", arguments: { walk: "asks" } }));
    expect(read.verdicts[0].reply).toContain("Answer in the pane");
    expect("reply" in read.verdicts[1]).toBe(false);
    // And no `ask: false` beside `kind: "ask"` anywhere on the way out.
    for (const v of read.verdicts) expect("ask" in v).toBe(false);
  });

  it("stays on walk_read's openAsks until an item supersedes it", async () => {
    await mcp.callTool({ name: "walk_open", arguments: { project: "asks-proj", title: "Open asks", buildRef: "b", id: "open-asks" } });
    await mcp.callTool({ name: "walk_add_items", arguments: { walk: "open-asks", items: [look("q"), look("other")] } });
    expect(text(await mcp.callTool({ name: "walk_read", arguments: { walk: "open-asks" } })).openAsks).toEqual([]);
    await store.addVerdict("open-asks", { itemId: "other", kind: "pass", text: "ok", nonce: "n-oa-1", context: ctx });
    await store.addVerdict("open-asks", { itemId: "q", kind: "ask", text: "is this the operator key or the licence key?", nonce: "n-oa-2", context: ctx });
    expect(text(await mcp.callTool({ name: "walk_read", arguments: { walk: "open-asks" } })).openAsks)
      .toEqual([{ item: "q", seq: 2, text: "is this the operator key or the licence key?" }]);
    await mcp.callTool({ name: "walk_add_items", arguments: { walk: "open-asks", items: [
      { id: "q-answer", kind: "info", owner: "gate", title: "The operator key", body: "The operator key. The licence key is the other one.", supersedes: "q" } ] } });
    expect(text(await mcp.callTool({ name: "walk_read", arguments: { walk: "open-asks" } })).openAsks).toEqual([]);
  });
});
