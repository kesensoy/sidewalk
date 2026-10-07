import { describe, it, expect } from "vitest";
import type { Item, Verdict } from "sidewalk-walkd/schema";
import { openAsks, replyLine, withReply } from "./ask.js";

const look = (id: string, seq: number, extra: Partial<Item> = {}): Item =>
  ({ id, kind: "look", owner: "gate", title: id, url: "http://127.0.0.1:9340/", do: "d", see: "s", pass: "p",
    expect: [], seq, addedAt: "2026-10-04T00:00:00.000Z", ...extra } as Item);
const info = (id: string, seq: number, extra: Partial<Item> = {}): Item =>
  ({ id, kind: "info", owner: "gate", title: id, body: "b", seq, addedAt: "2026-10-04T00:00:00.000Z", ...extra } as Item);
const v = (itemId: string, kind: Verdict["kind"], seq: number, text = ""): Verdict =>
  ({ itemId, kind, text, nonce: `n${seq}`, seq, at: "2026-10-04T00:00:00.000Z",
    context: { url: "http://127.0.0.1:9340/", viewport: [800, 600], console: [], userAgent: "ua", screenshot: null } });

describe("the reply line on an ask", () => {
  it("tells the agent to answer in the pane, naming the item", () => {
    expect(replyLine("w13-q1")).toBe(
      "Answer in the pane: add an info or question item on this walk, in the same group as w13-q1, with supersedes set to w13-q1. That is what marks the ask answered. The person is reading the pane, not your chat.");
  });
  it("goes on an ask verdict and on nothing else", () => {
    const asked = withReply(v("a", "ask", 1, "which build is this?"));
    expect(asked.reply).toBe(replyLine("a"));
    expect("reply" in withReply(v("a", "pass", 2))).toBe(false);
    expect("reply" in withReply(v("a", "issue", 3, "hairline"))).toBe(false);
  });
  it("leaves the verdict otherwise as the daemon filed it", () => {
    const filed = v("a", "ask", 1, "which build is this?");
    const { reply, ...rest } = withReply(filed) as Verdict & { reply: string };
    expect(rest).toEqual(filed);
  });
});

describe("openAsks", () => {
  it("lists an unanswered ask with its seq and the person's words verbatim", () => {
    const asks = openAsks([look("a", 1), look("b", 2)], [v("b", "pass", 1), v("a", "ask", 2, "  which build is this?\t")]);
    expect(asks).toEqual([{ item: "a", seq: 2, text: "  which build is this?\t" }]);
  });

  it("is empty when nobody has asked anything", () => {
    expect(openAsks([look("a", 1)], [v("a", "pass", 1)])).toEqual([]);
    expect(openAsks([], [])).toEqual([]);
  });

  it("drops an ask once a later item supersedes it", () => {
    const items = [look("a", 1), info("a-answer", 2, { supersedes: "a" })];
    expect(openAsks(items, [v("a", "ask", 1, "which build?")])).toEqual([]);
    // A superseding item the agent took back is no answer: the question stands.
    const withdrawn = [look("a", 1), info("a-answer", 2, { supersedes: "a", withdrawnAt: "2026-10-04T00:01:00.000Z", withdrawReason: "wrong answer" })];
    expect(openAsks(withdrawn, [v("a", "ask", 1, "which build?")])).toHaveLength(1);
  });

  it("lists a second ask on a card an older reply already answered", () => {
    // One early PIN exchange went several turns: the person asks, the agent
    // answers, the person asks again on the same card. The first answer is
    // older than the second question, so it cannot be an answer to it — and the
    // pane paints its waiting kerb by the same comparison
    // (`packages/extension/src/replies.ts`), so the two halves agree.
    const t = (s: number) => `2026-10-04T00:0${s}:00.000Z`;
    const items = [look("a", 1), info("a-answer", 2, { addedAt: t(2), supersedes: "a" })];
    const ask1 = { ...v("a", "ask", 1, "which build?"), at: t(1) };
    const ask2 = { ...v("a", "ask", 3, "and which port?"), at: t(3) };
    expect(openAsks(items, [ask1])).toEqual([]);
    expect(openAsks(items, [ask1, ask2])).toEqual([{ item: "a", seq: 3, text: "and which port?" }]);
    // Answered again, after the second question: closed again.
    const answered = [...items, info("a-answer-2", 4, { addedAt: t(4), supersedes: "a" })];
    expect(openAsks(answered, [ask1, ask2])).toEqual([]);
  });

  it("drops an ask the person answered themselves on the card", () => {
    expect(openAsks([look("a", 1)], [v("a", "ask", 1, "which build?"), v("a", "pass", 2)])).toEqual([]);
    // The other way round still counts: a pass, then a question about it.
    expect(openAsks([look("a", 1)], [v("a", "pass", 1), v("a", "ask", 2, "but which build?")])).toHaveLength(1);
  });

  it("drops an ask that was undone", () => {
    const undone = [v("a", "ask", 1, "which build?"), { ...v("a", "undo", 2), retracts: 1 }];
    expect(openAsks([look("a", 1)], undone)).toEqual([]);
    // A quiet undo never reaches an agent read at all, so there is no ask to list.
    expect(openAsks([look("a", 1)], [])).toEqual([]);
  });

  it("ignores a blocked line filed over the top of an ask", () => {
    // `blocked` is the pane's own note about a page that is not ready, not an
    // answer — the same rule the pane paints the card's state by.
    const asks = openAsks([look("a", 1)], [v("a", "ask", 1, "which build?"), v("a", "blocked", 2, "expect[0] url: wanted …")]);
    expect(asks).toEqual([{ item: "a", seq: 1, text: "which build?" }]);
  });

  it("lists several in item order", () => {
    const items = [look("a", 1), look("b", 2), look("c", 3)];
    const asks = openAsks(items, [v("c", "ask", 1, "third"), v("a", "ask", 2, "first")]);
    expect(asks.map(x => x.item)).toEqual(["a", "c"]);
  });
});
