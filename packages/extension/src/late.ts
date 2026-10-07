import type { WalkView } from "./protocol.js";
import type { SseEvent } from "./daemon.js";

/**
 * Frames that arrived for a walk while the worker's first read of it was in
 * flight, applied once the read is in.
 *
 * `openView` reads a walk, then awaits storage, then stores the view; a stream
 * frame in that window found no view and was dropped, and nothing re-read
 * afterwards because the walk was streaming by then. The Lamppost recorder hit
 * it live (2026-09-23): a header with no cards, for good. So the worker keeps
 * those frames aside and replays them here — only what the read did not
 * already carry, because the read may have been answered after the frame
 * went out: an item the read has is not pushed twice, a withdraw is applied
 * once, and a header frame never rolls `delivered` or `closedAt` backwards.
 *
 * Returns what changed, so the caller can register scripts for new items and
 * drop the stream for a close.
 */
export function replayLate(v: WalkView, frames: SseEvent[]): { items: boolean; closed: boolean } {
  let items = false;
  let closed = false;
  for (const e of frames) {
    if (e.event === "item") {
      const maxSeq = v.items.reduce((m, i) => Math.max(m, i.seq), 0);
      if (e.data.seq > maxSeq && !v.items.some(i => i.id === e.data.id)) { v.items.push(e.data); items = true; }
      continue;
    }
    if (e.event === "withdraw") {
      const i = v.items.findIndex(x => x.id === e.data.id);
      if (i >= 0 && !(v.items[i] as { withdrawn?: unknown }).withdrawn) { v.items[i] = e.data; items = true; }
      continue;
    }
    // close, delivered, open: each carries the header. An older one is one the
    // read already saw past.
    const cur = v.walk;
    const next = e.data;
    if ((next.delivered ?? 0) < (cur.delivered ?? 0)) continue;
    if (cur.closedAt && !next.closedAt) continue;
    v.walk = next;
    if (e.event === "close") closed = true;
  }
  return { items, closed };
}
