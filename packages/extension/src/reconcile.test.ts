import { describe, it, expect } from "vitest";
import { reconcile } from "./reconcile.js";

function recorder() {
  const calls: string[] = [];
  const ops = {
    flush: async () => { calls.push("flush"); },
    drop: async (id: string) => { calls.push(`drop:${id}`); },
    unregister: async (id: string) => { calls.push(`unregister:${id}`); },
    open: async (id: string) => { calls.push(`open:${id}`); },
  };
  return { calls, ops };
}

describe("reconcile", () => {
  it("replays the queue BEFORE any view is rebuilt", async () => {
    // H2: a verdict replayed after the read is not in the daemon's list yet, so
    // the rebuilt view paints the item the human just answered as unanswered.
    const { calls, ops } = recorder();
    await reconcile(ops, ["w1"], { views: ["w1"], registered: ["w1"], streaming: [] });
    expect(calls).toEqual(["flush", "open:w1"]);
    expect(calls.indexOf("flush")).toBeLessThan(calls.indexOf("open:w1"));
  });

  it("drops the views and registrations of walks the daemon no longer lists", async () => {
    const { calls, ops } = recorder();
    await reconcile(ops, ["w1"], { views: ["w1", "gone"], registered: ["gone", "stale"], streaming: ["w1"] });
    // A dropped walk is unregistered by `drop` as well; the call here is the
    // second one, and unregistering twice is a no-op.
    expect(calls).toEqual(["flush", "drop:gone", "unregister:gone", "unregister:stale"]);
  });

  it("leaves a walk that is already streaming or mid-subscribe alone", async () => {
    const { calls, ops } = recorder();
    await reconcile(ops, ["w1", "w2"], { views: ["w1", "w2"], registered: [], streaming: ["w1", "w2"] });
    expect(calls).toEqual(["flush"]);
  });

  it("opens every walk that has no stream, in the daemon's order", async () => {
    const { calls, ops } = recorder();
    await reconcile(ops, ["w1", "w2", "w3"], { views: [], registered: [], streaming: ["w2"] });
    expect(calls).toEqual(["flush", "open:w1", "open:w3"]);
  });
});
