import { describe, it, expect } from "vitest";
import { replies, unseenCount } from "./replies.js";
import type { Item, Verdict } from "sidewalk-walkd/schema";

const look = (id: string, seq: number): Item => ({ id, seq, kind: "look", owner: "g", title: `T${id}`, url: "http://x/", do: "do", see: "see", pass: "pass", expect: [], addedAt: "" });
const info = (id: string, seq: number, over: Partial<Item> = {}): Item =>
  ({ id, seq, kind: "info", owner: "g", title: `T${id}`, body: "b", addedAt: "", ...over }) as Item;
const question = (id: string, seq: number, over: Partial<Item> = {}): Item =>
  ({ id, seq, kind: "question", owner: "g", title: `T${id}`, options: ["A", "B"], addedAt: "", ...over }) as Item;
const v = (itemId: string, kind: Verdict["kind"], seq: number): Verdict =>
  ({ itemId, kind, text: "t", nonce: "n", seq, at: "", context: { url: "", viewport: [1, 1], console: [], userAgent: "", screenshot: null } }) as unknown as Verdict;

describe("which items are answers rather than cards", () => {
  it("attaches an info reply to the card that was asked about", () => {
    const r = replies([look("a", 1), info("r", 2, { supersedes: "a" })], [v("a", "ask", 1)]);
    expect(r.answered.has("a")).toBe(true);
    expect(r.attached.has("r")).toBe(true);
    expect(r.blocks.get("a")?.map(i => i.id)).toEqual(["r"]);
    expect(r.after.size).toBe(0);
  });

  it("keeps the attachment after the person has answered the card", () => {
    // The shelf row is the record and carries the answer it was given under, so
    // a Pass must not turn the reply back into a loose card — which would be the
    // in-between card arriving late.
    const items = [look("a", 1), info("r", 2, { supersedes: "a" })];
    const r = replies(items, [v("a", "ask", 1), v("a", "pass", 3)]);
    expect(r.attached.has("r")).toBe(true);
    expect(r.blocks.get("a")?.length).toBe(1);
  });

  it("orders several answers to one ask by seq, whatever order they come in", () => {
    const r = replies([look("a", 1), info("r2", 3, { supersedes: "a" }), info("r1", 2, { supersedes: "a" })], [v("a", "ask", 1)]);
    expect(r.blocks.get("a")?.map(i => i.id)).toEqual(["r1", "r2"]);
  });

  it("gives a question reply its own card, under the one it answers", () => {
    const r = replies([look("a", 1), question("r", 2, { supersedes: "a" })], [v("a", "ask", 1)]);
    expect(r.answered.has("a")).toBe(true);
    expect(r.attached.size).toBe(0);
    expect(r.after.get("r")).toBe("a");
  });

  it("counts a withdrawn reply as no reply at all — the question stands", () => {
    const r = replies([look("a", 1), info("r", 2, { supersedes: "a", withdrawnAt: "x", withdrawReason: "wrong" })], [v("a", "ask", 1)]);
    expect(r.answered.size).toBe(0);
    expect(r.attached.size).toBe(0);
    expect(r.blocks.size).toBe(0);
  });

  it("leaves an item that supersedes a card nobody asked about ordinary", () => {
    const r = replies([look("a", 1), info("r", 2, { supersedes: "a" })], []);
    // `answered` is per ask, not per card: with no ask on this card there is
    // nothing for the item to have answered.
    expect(r.answered.size).toBe(0);
    expect(r.attached.size).toBe(0);
    expect(r.blocks.size).toBe(0);
    expect(r.after.size).toBe(0);
  });

  it("waits again on a second ask, and stops when an answer newer than it lands", () => {
    // One early PIN exchange went several turns: the person asks, is answered,
    // and asks again on the same card. An answer given before that second
    // question is not an answer to it — the stamps are what say so, both the
    // daemon's own toISOString().
    const t = (s: number) => `2026-10-04T00:0${s}:00.000Z`;
    const ask1 = { ...v("a", "ask", 1), at: t(1) };
    const first = info("r1", 2, { supersedes: "a", addedAt: t(2) });
    const ask2 = { ...v("a", "ask", 3), at: t(3) };
    const second = info("r2", 4, { supersedes: "a", addedAt: t(4) });

    expect(replies([look("a", 1), first], [ask1]).answered.has("a")).toBe(true);
    // Asked again: the old answer is too old to have answered it.
    const open = replies([look("a", 1), first], [ask1, ask2]);
    expect(open.answered.size).toBe(0);
    // …and it is still in the card's record, which is where the conversation is.
    expect(open.blocks.get("a")?.map(i => i.id)).toEqual(["r1"]);
    // Answered again: both answers on the card, and nothing waiting.
    const closed = replies([look("a", 1), first, second], [ask1, ask2]);
    expect(closed.answered.has("a")).toBe(true);
    expect(closed.blocks.get("a")?.map(i => i.id)).toEqual(["r1", "r2"]);
  });

  it("ignores a supersedes that names nothing on this walk", () => {
    const r = replies([info("r", 1, { supersedes: "gone" })], [v("gone", "ask", 1)]);
    expect(r.attached.size).toBe(0);
    expect(r.blocks.size).toBe(0);
    expect(r.after.size).toBe(0);
  });
});

describe("the badge counts cards, and an answer is not one", () => {
  // The reply is not a card, so what it raises the badge for is the card it
  // landed on: one answer, one thing to go and look at.
  it("counts the asked card in the reply's place", () => {
    const items = [look("a", 1), info("r", 2, { supersedes: "a" })];
    const verdicts = [v("a", "ask", 1)];
    expect(unseenCount({ items, verdicts, lastSeenSeq: 1 })).toBe(1);
    // The asked card was unseen too: still one, because it is still one card.
    expect(unseenCount({ items, verdicts, lastSeenSeq: 0 })).toBe(1);
    // Both seen: nothing to raise.
    expect(unseenCount({ items, verdicts, lastSeenSeq: 2 })).toBe(0);
  });

  it("counts an ordinary item once, and never a withdrawn one", () => {
    expect(unseenCount({ items: [look("a", 1), look("b", 2)], verdicts: [], lastSeenSeq: 0 })).toBe(2);
    expect(unseenCount({ items: [look("a", 1), { ...look("b", 2), withdrawnAt: "x" }], verdicts: [], lastSeenSeq: 0 })).toBe(1);
  });

  it("wants nothing for an answer to a card that has been withdrawn", () => {
    const items = [{ ...look("a", 1), withdrawnAt: "x" }, info("r", 2, { supersedes: "a" })];
    expect(unseenCount({ items, verdicts: [v("a", "ask", 1)], lastSeenSeq: 0 })).toBe(0);
  });
});
