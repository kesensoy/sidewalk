import { describe, it, expect } from "vitest";
import { replayLate } from "./late.js";
import type { WalkView } from "./protocol.js";
import type { Item, Walk } from "sidewalk-walkd/schema";

const walk = (over: Partial<Walk> = {}): Walk => ({ id: "w", project: "p", title: "t", buildRef: "b", openedAt: "2026-09-23T00:00:00Z", ...over });
const info = (id: string, seq: number, over: Partial<Item> = {}): Item =>
  ({ id, seq, kind: "info", owner: "o", title: id, body: "b", addedAt: "2026-09-23T00:00:00Z", ...over }) as Item;
const view = (items: Item[], w = walk()): WalkView => ({ walk: w, items, verdicts: [], lastSeenSeq: 0 });

describe("replayLate — frames that arrived while the first read was in flight", () => {
  it("appends an item the read did not carry, and nothing it did", () => {
    // The recorder's case: group A landed while the worker was reading, the
    // read came back with two of four, the other two arrived as frames.
    const v = view([info("a", 1), info("b", 2)]);
    const r = replayLate(v, [
      { event: "item", walk: "w", data: info("b", 2) },   // the read already had it
      { event: "item", walk: "w", data: info("c", 3) },
      { event: "item", walk: "w", data: info("d", 4) },
    ]);
    expect(v.items.map(i => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(r).toEqual({ items: true, closed: false });
  });

  it("applies a withdraw once", () => {
    const v = view([info("a", 1)]);
    const gone = info("a", 1, { withdrawn: { reason: "wrong page", at: "2026-09-23T00:01:00Z" } } as Partial<Item>);
    expect(replayLate(v, [{ event: "withdraw", walk: "w", data: gone }]).items).toBe(true);
    expect((v.items[0] as { withdrawn?: unknown }).withdrawn).toBeTruthy();
    // Again, for an item the read already saw withdrawn: no change reported.
    expect(replayLate(v, [{ event: "withdraw", walk: "w", data: gone }]).items).toBe(false);
  });

  it("never rolls delivered or closedAt backwards, and takes a newer header", () => {
    const v = view([], walk({ delivered: 5 }));
    replayLate(v, [{ event: "delivered", walk: "w", data: walk({ delivered: 3 }) }]);
    expect(v.walk.delivered).toBe(5);
    replayLate(v, [{ event: "delivered", walk: "w", data: walk({ delivered: 7 }) }]);
    expect(v.walk.delivered).toBe(7);
    const r = replayLate(v, [{ event: "close", walk: "w", data: walk({ delivered: 7, closedAt: "2026-09-23T00:02:00Z", summary: "done" }) }]);
    expect(r.closed).toBe(true);
    expect(v.walk.closedAt).toBeTruthy();
    // An open frame from before the close carries no closedAt: ignored.
    replayLate(v, [{ event: "open", walk: "w", data: walk({ delivered: 7 }) }]);
    expect(v.walk.closedAt).toBeTruthy();
  });

  it("reports nothing for no frames", () => {
    const v = view([info("a", 1)]);
    expect(replayLate(v, [])).toEqual({ items: false, closed: false });
    expect(v.items).toHaveLength(1);
  });
});
