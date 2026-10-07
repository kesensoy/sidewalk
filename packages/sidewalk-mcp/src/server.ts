import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { itemInputSchema, walkInputSchema } from "sidewalk-walkd/schema";
import type { DaemonClient } from "./client.js";
import { INSTRUCTIONS } from "./instructions.js";
import { openAsks, withReply } from "./ask.js";

/** What the MCP handshake tells a client this server is, kept the package's
 *  own so it cannot drift from the number npm shows. From dist/server.js and
 *  from src/server.ts alike, ../package.json is this package's. */
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
const err = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: (e as Error).message }] });
const run = async (fn: () => Promise<unknown>) => { try { return ok(await fn()); } catch (e) { return err(e); } };

export function buildServer(client: DaemonClient): McpServer {
  const s = new McpServer({ name: "sidewalk", version: VERSION }, { instructions: INSTRUCTIONS });
  s.registerTool("walk_open", {
    description: "Open (or reopen) a walk. Returns {id,...}. Call once per build, once it is live. brief: two or three sentences the person reads first, under the title — what this build is, where to start, what to know before the first card; reopening with a new brief replaces it.",
    inputSchema: walkInputSchema.shape,
  }, (a) => run(() => client.open(a)));
  s.registerTool("walk_add_items", {
    description: "Append items to a walk. sequence = ONE page + 2–8 ordered steps of do→see (the person ticks steps, one verdict for the card; use this for press-then-try-then-try-again paths, never one look per step); look = URL + do/see/pass; question = title + 2–4 options, recommended first, sheet sections only for a big decision; info = note. All take expect preconditions, group, target. Returns {seqs}. Read the server instructions for how to write a good walk.",
    inputSchema: { walk: z.string(), items: z.array(itemInputSchema).min(1) },
  }, (a) => run(async () => ({ seqs: (await client.addItems(a.walk, a.items)).map(i => i.seq) })));
  s.registerTool("walk_withdraw", {
    description: "Withdraw an item (it stays in the record, struck through with the reason).",
    inputSchema: { walk: z.string(), itemId: z.string(), reason: z.string() },
  }, (a) => run(() => client.withdraw(a.walk, a.itemId, a.reason)));
  s.registerTool("walk_wait", {
    description: "Block until new verdicts arrive after cursor `after`, or timeoutMs elapses (0 = drain now, max 280000 (≈4.6 min); loop for longer). Returns {verdicts, cursor, closed}. Screenshots are file paths. An `ask` verdict carries a `reply` line: do what it says.",
    inputSchema: { walk: z.string(), after: z.number().int().min(0), timeoutMs: z.number().int().min(0).max(280000) },
  }, (a) => run(async () => {
    const r = await client.wait(a.walk, a.after, a.timeoutMs);
    if (r.verdicts.length === 0) return r;
    const project = await client.projectOf(a.walk);
    return { ...r, verdicts: r.verdicts.map(v => withReply({ ...v, screenshotPath: client.shotPath({ project, id: a.walk }, v) })) };
  }));
  s.registerTool("walk_read", {
    description: "Read the walk header, all items, and verdicts after `after` (default 0 = all). Also returns openAsks: every question the person asked that nothing has answered yet.",
    inputSchema: { walk: z.string(), after: z.number().int().min(0).optional() },
  }, (a) => run(async () => { const r = await client.read(a.walk, a.after ?? 0);
    return { ...r, verdicts: r.verdicts.map(v => withReply({ ...v, screenshotPath: client.shotPath(r.walk, v) })), openAsks: openAsks(r.items, r.verdicts) }; }));
  s.registerTool("walk_close", {
    description: "Close the walk with a summary. Waiters return closed:true; no more items or verdicts.",
    inputSchema: { walk: z.string(), summary: z.string() },
  }, (a) => run(() => client.close(a.walk, a.summary)));
  return s;
}
