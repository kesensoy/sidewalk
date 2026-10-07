/**
 * What an agent is told to do with a question the person asked back.
 *
 * An early agent session answered one in its own chat, where the
 * person never saw it — and nothing in the verdict had told it otherwise. So
 * the instruction rides the verdict itself, on every `ask` the agent is handed:
 * one line it cannot miss, naming the item so the reply lands in the same group
 * as the card the question came off.
 *
 * It is not stored. The daemon's record stays as the person filed it; this is
 * the MCP server dressing a read for the agent, the same place `screenshotPath`
 * is added.
 *
 * `openAsks` — which asks are still waiting — moved to the daemon (`walkd`'s
 * `asks.ts`) when `walk_add_items` began refusing a `supersedes` that names
 * anything but an open ask (found on an early walk). The store and this listing have to answer
 * the same question, so there is one copy of the rule and this is a re-export
 * of it.
 */
export { openAsks, type OpenAsk } from "sidewalk-walkd";

export const replyLine = (itemId: string) =>
  `Answer in the pane: add an info or question item on this walk, in the same group as ${itemId}, with supersedes set to ${itemId}. That is what marks the ask answered. The person is reading the pane, not your chat.`;

/** The `reply` line on an `ask`, and nothing added to any other kind. */
export function withReply<V extends { kind: string; itemId: string }>(v: V): V & { reply?: string } {
  return v.kind === "ask" ? { ...v, reply: replyLine(v.itemId) } : v;
}
