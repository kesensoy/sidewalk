export type ReconcileOps = {
  /** Replay the offline verdict queue into the daemon. */
  flush(): Promise<void>;
  /** The walk is gone from the daemon: forget its view. */
  drop(id: string): Promise<void>;
  /** The walk is gone: take its content scripts back out. */
  unregister(id: string): Promise<void>;
  /** Read the walk onto the pane and register its content scripts. The events
   *  that follow arrive on the worker's one stream, not on a stream of its own. */
  open(id: string): Promise<void>;
};

export type Known = {
  views: Iterable<string>;
  registered: Iterable<string>;
  /** Walks whose copy the worker holds current — read while its one stream was
   *  up, or being read right now. Not a connection count: there is one stream
   *  for the whole daemon, and a walk falls out of this when it ends. */
  streaming: Iterable<string>;
};

/**
 * One pass over what the daemon says is open, against what this worker holds.
 *
 * The flush comes first, and that ordering is the whole point of the function
 * having a name: `open` re-reads the walk and replaces the view with what the
 * daemon has at that moment. A verdict replayed after the read is not in that
 * answer, so the card the human had just answered while the daemon was down
 * repaints as unanswered, and their click looks lost even though it landed.
 */
export async function reconcile(ops: ReconcileOps, live: string[], known: Known): Promise<void> {
  await ops.flush();
  const open = new Set(live);
  for (const id of known.views) if (!open.has(id)) await ops.drop(id);
  for (const id of known.registered) if (!open.has(id)) await ops.unregister(id);
  const streaming = new Set(known.streaming);
  for (const id of live) if (!streaming.has(id)) await ops.open(id);
}
