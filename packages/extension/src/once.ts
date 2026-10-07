/**
 * Collapses concurrent calls into one run. The service worker starts a refresh
 * at module load and the panel asks for one the moment it opens; without this
 * both get past `views.has(id)` before either sets it and the extension
 * subscribes to the same walk twice.
 */
export function inflight<T>(fn: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | null = null;
  return () => {
    if (current) return current;
    const run = (async () => fn())();
    current = run;
    run.then(
      () => { if (current === run) current = null; },
      () => { if (current === run) current = null; },
    );
    return run;
  };
}

/**
 * Collapses concurrent calls too, but never answers a caller with work that
 * started before it asked.
 *
 * "Refresh" means *make this current now*. Handing a pane that has only just
 * opened the answer to a question asked a moment before it opened is how a
 * walk that was created in between goes missing until the next alarm, half a
 * minute later. A call that arrives while a run is going waits for it and then
 * gets one more; everything that asked during that run shares the one after it.
 */
export function latest<T>(fn: () => Promise<T>): () => Promise<T> {
  let running: Promise<unknown> | null = null;
  let queued: Promise<T> | null = null;
  const start = (): Promise<T> => {
    const run = (async () => fn())();
    running = run;
    const done = () => { if (running === run) running = null; };
    run.then(done, done);
    return run;
  };
  return () => {
    if (!running) return start();
    if (queued) return queued;
    const after = running;
    const run = (async () => {
      // The run before ours failing is not our answer; ours still has to happen.
      try { await after; } catch { /* its failure is its caller's */ }
      queued = null;
      return start();
    })();
    queued = run;
    return run;
  };
}

/**
 * One `inflight` per key. Two walks may sync their content scripts at the same
 * time — they register different patterns — but a walk must never sync twice at
 * once: registration is unregister-then-register, and an overlap can leave the
 * walk with no scripts at all, or with a stale pair it thinks is current.
 *
 * The same shape answers the other per-thing race in the worker: two presses of
 * Go on one item are one press, while Go on a different item is not held up.
 * Callers that want an answer get the one run's answer, not `undefined`.
 */
export function inflightBy<K, T>(fn: (key: K) => Promise<T>): (key: K) => Promise<T> {
  const runs = new Map<K, () => Promise<T>>();
  return key => {
    let run = runs.get(key);
    if (!run) { run = inflight(() => fn(key)); runs.set(key, run); }
    return run();
  };
}

/** Reconnect waits: 1 s, 2 s, then 5 s for as long as the daemon stays down. */
export function backoffMs(attempt: number): number {
  const ladder = [1000, 2000, 5000];
  return ladder[Math.min(Math.max(attempt, 0), ladder.length - 1)];
}
