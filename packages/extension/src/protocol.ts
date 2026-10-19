import type { ConsoleEntry, Expect, Item, Target, Verdict, VerdictInput, Walk } from "sidewalk-walkd/schema";

// The daemon's address is not a constant any more: `port.ts` reads it out of
// storage, so a second daemon can be walked beside one that is already running.

// One definition of a console line: the schema the daemon validates against.
export type { ConsoleEntry };

export type PanelToSw =
  | { t: "panel:hello" }                                      // → sw replies with SwState
  | { t: "panel:go"; walk: string; itemId: string }            // navigate tab + highlight
  | { t: "panel:submit"; walk: string; verdict: VerdictDraft } // sw captures + enqueues
  | { t: "panel:seen"; walk: string; seq: number }
  | { t: "panel:token" }                                       // → sw re-reads the token and answers TokenAnswer
  /**
   * Connect was pressed. → ConnectAnswer.
   *
   * `asked` is the host's answer when the **panel** did the asking, which is
   * the ordinary case in Chrome: the browser hands the native messaging API
   * only to contexts created after the grant, so the worker that was already
   * running cannot make the call and the panel (reloaded, and therefore new)
   * can. Without it the worker asks for itself, which is the Firefox path and
   * the path of any context that has held the permission all along. Either
   * way the token reaches storage through one set of rules in the worker, and
   * the pane is told how the daemon took it.
   */
  | { t: "panel:connect"; asked?: { port: number; token: string } };

export type VerdictDraft = Omit<VerdictInput, "nonce" | "context">;

/**
 * What a Go came to, as the worker answers the pane.
 *
 * `blocked` means a `blocked` verdict was filed and the card says so itself.
 * The other two have no card to speak for them: `noAccess` is a page the check
 * could not be run on, which files nothing by design, and `badSelector` is the
 * item's own `css` or `url` string that the browser refused. Both were dropped
 * on the floor before (found in review); the pane says them in a line.
 */
export type GoResult = { ok: boolean; blocked?: boolean; noAccess?: boolean; badSelector?: string };

/**
 * What came of the token the gear last saved.
 *
 * The owner, 2026-10-06: "i had copied something else and noticed when i saved my
 * wrong token it just says saved in green like no actual connection check /
 * rejection". A Save is a check now, so the gear needs the daemon's answer and
 * not the fact that storage took the write. The worker decides the three a
 * daemon can produce; the pane adds the two that are its own — the wait, and a
 * worker that never answered. `render.ts` (`tokenSay`) has the words.
 */
export type TokenCheck = "checking" | "connected" | "refused" | "noDaemon" | "noAnswer";

/**
 * The worker's answer to `panel:token`, for the token in storage now. `port` is
 * the port it asked, carried here rather than read off the pane's last state:
 * the answer and the port it is about must be the same breath, or a Save that
 * moved the pane to another daemon names the one it left.
 */
export type TokenAnswer = { check: Extract<TokenCheck, "connected" | "refused" | "noDaemon">; port: number };

/**
 * What came of pressing Connect, as the worker saw it end.
 *
 * The permission is the pane's half — it needs the person's own click, and only
 * a page can carry one — and the ask is the worker's, so that the token is
 * stored by one code path and no other. What comes back is the **daemon's
 * verdict**, not the fact that a token reached storage: a stored token is not a
 * working one, which is the lesson the gear's Save already learned.
 *
 * - `connected`: walkd let the pane in. The connection line says so and the
 *   notice is gone, so the pane says nothing of its own.
 * - `refusedToken`: the host answered and walkd refused what it gave. This is a
 *   `walkd token --rotate` under a running daemon, and the way out is a restart,
 *   so it is the one end with a line of its own.
 * - `noHost`: nothing usable came back through the browser. One line for every
 *   reason behind it, because four of the likeliest report the same sentence.
 * - `nothingToSay`: the press changed nothing worth a line — the pane was
 *   already in on a token of its own, or nothing is answering on the port at
 *   all, and the connection line is the whole story either way.
 * - `noApi`: this worker cannot reach the host, because the browser has not
 *   given it the API. Not a failure and never a line: it is the worker telling
 *   the panel to ask for itself, from a context new enough to be allowed to.
 *
 * `reason` is `native.ts`'s own word, plus whatever the browser or the host
 * said, for the console and nowhere else.
 */
export type ConnectEnd = "connected" | "refusedToken" | "noHost" | "nothingToSay" | "noApi";
export type ConnectAnswer = { end: ConnectEnd; port: number; reason?: string };

export type SwToPanel =
  | { t: "sw:state"; state: SwState }                          // full state on hello and on change
  /**
   * Nobody pressed anything, and the pane is in.
   *
   * The hands-free door (`sw.ts` `offerToken`): the daemon said it wanted a
   * token, this profile held none, so the worker asked walkd's native messaging
   * host for it by itself and the daemon let the pane in on what came back. The
   * state broadcast only turns the connection line green — it cannot say *why*
   * the pane is suddenly in — so this says it, and the panel puts up the same
   * receipt the Connect press earns. `how` is `host` and only ever that: a
   * paste and a press each have an asker of their own to answer, and neither
   * comes this way.
   *
   * Sent once per adoption, with no panel necessarily listening: a pane that is
   * closed when it lands is a pane that will read the connection line when it
   * opens, which is the whole of the news by then.
   */
  | { t: "sw:connected"; how: "host" };

export type SwState = {
  connected: boolean;
  /**
   * The daemon answered and refused: it wants the daemon's token, kept across
   * restarts, and this pane has none, or an old one (secrets review). Its
   * own field rather than a kind of `connected: false`, because the remedy is a
   * paste into the gear and not a wait. Absent from an older worker.
   */
  needsToken?: boolean;
  /**
   * Where the daemon is, or is being looked for. The pane's connection line
   * names it, and only the worker knows which port the link is pointed at;
   * optional so a pane loaded beside an older worker still paints.
   */
  port?: number;
  /** What the daemon on `port` last said its version was; null until one has answered. */
  daemonVersion?: string | null;
  /**
   * The daemon's free-Undo window in ms, as /health last said it. Absent while
   * nothing has answered, and absent from a daemon too old to say — a pane
   * that does not know the window draws no drain bar under a ledge row rather
   * than draining against a number it made up.
   */
  graceMs?: number;
  /** A daemon on `port` has answered at least once in this profile, ever — read
   *  off storage, so a fresh install can be told apart from a daemon that is
   *  merely down. Absent from an older worker. */
  everConnected?: boolean;
  /**
   * Is a token stored for this profile at all?
   *
   * The boolean and never the value: the pane shows a run of dots when one is
   * stored, and the panel holds no copy of the token itself. It comes from the
   * worker because the worker is what the token reaches — a paste, or the host
   * handing one over — and a panel that read storage once at load would show
   * dots that had stopped being true the moment Connect worked. Absent from an
   * older worker, which reads as none.
   */
  hasToken?: boolean;
  walks: WalkView[];
  queued: number;
  /** Verdicts the daemon refused outright; they will never reach the agent. */
  dead: number;
  refused: RefusedVerdict[];
};

export type RefusedVerdict = { itemId: string; error: string };

/** `current`: the item whose Go was pressed last and is still unanswered — the card the person is on. The owner: "blue should be for what you go'd to". */
export type WalkView = {
  walk: Walk; items: Item[]; verdicts: Verdict[]; lastSeenSeq: number; current?: string;
  /**
   * Per item, the seq of the latest `blocked` verdict a later Go cleared by
   * passing its preconditions. A blocked line stays on the record (the stream
   * is append-only) but a card whose page has caught up must not keep reading
   * "Not ready here" — the Lamppost cut caught it doing exactly that.
   */
  cleared?: Record<string, number>;
};

export type SwToContent =
  | { t: "content:expect"; expect: Expect[] }                  // → { ok: boolean; failed?: Expect; seen?: string; buildId?: string }
  | { t: "content:highlight"; target: Target }                 // → { found: boolean }
  | { t: "content:console" };                                  // → ConsoleEntry[]
