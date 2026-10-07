import type { Item, Verdict } from "sidewalk-walkd/schema";
import type { TokenCheck, WalkView } from "./protocol.js";
import { replies, type Replies } from "./replies.js";

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/**
 * What a verdict is called on screen. The raw kinds are for the agent.
 *
 * Design language v3, §"An answered card is one line": the word on the line is
 * the word the button had, so Pass reads Pass and Skip reads Skipped — and
 * "Pass, with a note" collapses to Pass, because the note *is* the trailing
 * words. The long label stays here because it is still the kind's name.
 */
const VERDICT_LABEL: Record<Verdict["kind"], string> = {
  pass: "Pass",
  "pass-note": "Pass, with a note",
  issue: "Issue",
  skip: "Skipped",
  decision: "Decided",
  dismiss: "Dismissed",
  blocked: "Not ready here",
  ask: "Asked",
  undo: "Undo",
};

/** The word that leads an answered line. `pass-note` is a Pass with words after it. */
const lineLabel = (k: Verdict["kind"]): string => VERDICT_LABEL[k === "pass-note" ? "pass" : k];

/**
 * The kerb, and the gutter mark, by verdict — one vocabulary on both sides of
 * the shelf: green passed, red an issue, ink decided, grey passed over.
 */
const MARK_KIND: Partial<Record<Verdict["kind"], string>> = {
  pass: "pass", "pass-note": "pass", issue: "issue", skip: "skip", decision: "decision", dismiss: "dismiss",
};

/**
 * The Done shelf's gutter marks, drawn at 18 px on a 2.4 px stroke so they hold
 * at the 80 percent text size. `currentColor`, so the stylesheet paints each
 * one the colour its kerb had while the card was live.
 */
const MARK_PATH: Record<string, string> = {
  pass: '<path d="M3 9.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  issue: '<path d="M4 4l10 10M14 4L4 14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  skip: '<path d="M6 4l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  decision: '<circle cx="9" cy="9" r="4.5" fill="currentColor"/>',
  dismiss: '<path d="M4 9h10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  withdrawn: '<path d="M4 9h10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M5 13.5l8-9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};
/** The mark is the only thing on a shelf line that says which verdict it was, so it is named. */
const WITHDRAWN_LABEL = "Withdrawn";
function gutterMark(kind: string, label: string): string {
  return `<span class="mark mark-${kind}"><svg viewBox="0 0 18 18" role="img" aria-label="${esc(label)}">${MARK_PATH[kind] ?? ""}</svg></span>`;
}

/**
 * The trailing half of an answered line, in muted: what a sequence got through
 * first (that number is the finding), then the person's own words. It is the
 * half that is allowed to run off the end of the line — it is already in the
 * record, and it comes back into the note box on Undo.
 */
function trail(parts: string[]): string {
  const kept = parts.filter(Boolean);
  return kept.length ? ` <span class="w">${kept.join(", ")}</span>` : "";
}

/**
 * Groups in creation order, newest group first — a group's position is fixed
 * by the seq of its first item, so appending to an old group does not shuffle
 * the list under the human's cursor. Items inside a group stay in seq order.
 */
export function groupItems(items: Item[]): [string, Item[]][] {
  const m = new Map<string, Item[]>();
  for (const i of [...items].sort((a, b) => a.seq - b.seq)) { const k = i.group ?? ""; if (!m.has(k)) m.set(k, []); m.get(k)!.push(i); }
  return [...m.entries()].sort((a, b) => Math.min(...b[1].map(i => i.seq)) - Math.min(...a[1].map(i => i.seq)));
}

/**
 * A `question` the agent replied with keeps its own card — it has a verdict of
 * its own to collect — but it sits directly under the card it answers rather
 * than at the end of whatever group it was added to, so the answer and the
 * question are never separated by a card that has nothing to do with either.
 *
 * It moves between groups if it has to: `supersedes` is the link, the group is
 * only where the agent filed it. A group left with nothing in it goes with its
 * last card, and a reply whose card is not in the list — answered, on the shelf —
 * stays exactly where it was.
 */
export function placeReplies(groups: [string, Item[]][], after: Map<string, string>): [string, Item[]][] {
  if (!after.size) return groups;
  const here = new Set(groups.flatMap(([, items]) => items.map(i => i.id)));
  const under = new Map<string, Item[]>();
  for (const [, items] of groups) {
    for (const i of items) {
      const target = after.get(i.id);
      if (target && here.has(target)) under.set(target, [...(under.get(target) ?? []), i]);
    }
  }
  if (!under.size) return groups;
  for (const list of under.values()) list.sort((a, b) => a.seq - b.seq);
  const moved = new Set([...under.values()].flat().map(i => i.id));
  // A card and everything that answers it, depth first — a reply can be asked
  // about and answered in turn, and a chain that was only one level deep would
  // leave the second answer filtered out of the list and painted nowhere. The
  // `seen` set is for a `supersedes` that points back up its own chain: the
  // schema cannot refuse one, and a pane that hung on it would be worse.
  const expand = (i: Item, seen = new Set<string>()): Item[] => {
    if (seen.has(i.id)) return [];
    seen.add(i.id);
    return [i, ...(under.get(i.id) ?? []).flatMap(c => expand(c, seen))];
  };
  return groups
    .map(([g, items]): [string, Item[]] => [g, items.filter(i => !moved.has(i.id)).flatMap(i => expand(i))])
    .filter(([, items]) => items.length);
}

/**
 * The radio the pane calls *Other* travels as `__other`, so the agent can tell
 * "they picked Other and wrote it out" from "no option at all" — and so Undo
 * can hand the card back with Other still picked. It is a token for the wire;
 * it is not a word to show a person, which is what `Decided: __other` did.
 */
export const OTHER = "__other";
export const optionLabel = (o?: string): string => (o === OTHER ? "Other" : o ?? "");

export type ItemState = "new" | "answered" | "blocked" | "withdrawn" | "refused";

/**
 * `refused` is not derived from the streams: the daemon never took that verdict,
 * so nothing in the walk records it. It comes from the extension's own dead
 * letters, and it outranks the optimistic verdict the pane pushed when the
 * human clicked — otherwise the card sits there reading as answered forever.
 */
export function itemState(item: Item, verdicts: Verdict[], refused = false, clearedSeq = 0): ItemState {
  if (item.withdrawnAt) return "withdrawn";
  if (refused) return "refused";
  const mine = verdicts.filter(v => v.itemId === item.id);
  // The latest non-blocked verdict decides. `ask` and `undo` are both answers
  // that put the card back in front of the human rather than closing it.
  const last = [...mine].reverse().find(v => v.kind !== "blocked");
  if (last) return last.kind === "ask" || last.kind === "undo" ? "new" : "answered";
  // Blocked only while the newest blocked line is newer than the last Go that
  // passed: the record keeps the line, the card does not keep the kerb.
  if (mine.length) return mine[mine.length - 1].seq > clearedSeq ? "blocked" : "new";
  return "new";
}

export type RenderOpts = {
  drafts: Map<string, string>;
  refused?: Set<string>;
  confirming?: Set<string>;
  ticks?: Map<string, boolean[]>;
  /** "now" for elapsed-time lines and the ledge's drain bars; tests pin it. */
  now?: number;
  /**
   * The daemon's free-Undo window, off /health. Undefined is not zero: it is a
   * daemon that did not say, and a ledge row then gets no drain bar at all.
   */
  graceMs?: number;
};

type QuestionItem = Extract<Item, { kind: "question" }>;
export type Section = { label: string; html: string };

/**
 * The decision-sheet block, in the order the 2026-09-14 sheet used it — but
 * only the rows the agent actually filled. The owner, 2026-09-17: "we don't want to
 * fatigue the user without gains/wins/decisions". An unfilled row is not a
 * blank to render, it is a row that was never worth his time.
 */
const SECTIONS: [keyof QuestionItem, string][] = [
  ["eli5", "eli5"], ["proposal", "proposal"], ["why", "why"], ["downsides", "downsides"],
  ["facts", "facts"], ["recommendation", "recommendation"], ["costIfWrong", "cost if wrong"],
];

export function questionSections(i: QuestionItem): Section[] {
  const out: Section[] = [];
  for (const [key, label] of SECTIONS) {
    const v = i[key];
    if (Array.isArray(v)) { if (v.length) out.push({ label, html: v.map(esc).join("<br>") }); continue; }
    if (typeof v === "string" && v) out.push({ label, html: esc(v) });
  }
  return out;
}

/** One section is the card's body and needs no name; two or more get their labels back. */
function questionBody(i: QuestionItem): string {
  const s = questionSections(i);
  if (!s.length) return "";
  if (s.length === 1) return `<p class="body">${s[0].html}</p>`;
  return `<dl>${s.map(x => `<dt>${x.label}</dt><dd>${x.html}</dd>`).join("")}</dl>`;
}

const NOTE_PLACEHOLDER = "Your words, if you have any";
const REFUSED_LINE = `<p class="refused">Refused by the walk server. Answer this one again.</p>`;
const ASKED_LINE = "Asked. Waiting for the agent.";
/**
 * The breathing dot at the head of the asked line — the header's own dot class,
 * in the waiting yellow. The owner, 2026-10-04: "when you hit ask and it says
 * 'Asked. Waiting for the agent.' can we do like a pulsing yellow thing or put
 * a left-pane color thing or SOMETHING to indicate it's waiting? in addition to
 * that text of course." Both: this, and the kerb (see `waiting` below).
 *
 * Decorative, so it is hidden from the reading order: the line beside it
 * already says what it means, and the dot adds no words.
 */
const WAITING_DOT = `<span class="dot waiting" aria-hidden="true"></span>`;
/**
 * The agent's answer, on the card that asked for it — where the waiting line
 * was. The owner, 2026-10-04: "when the answer is there I think it should link to
 * the card that asked it (instead of letting a card be in between with its own
 * dismiss)". So there is no card in between and nothing to dismiss: the answer
 * is the reply's own title and body, in the card, and the card's own buttons
 * are still what resolves it.
 *
 * Not one new word. Several answers to one ask are several blocks, in seq order
 * (`replies.ts`). A secret the agent put on the reply keeps its row and its Copy
 * button: the value is reachable from nowhere else, and the row's only words are
 * the label the agent wrote.
 */
function replyBlocks(list: Extract<Item, { kind: "info" }>[]): string {
  return list.map(r =>
    `<div class="reply"><h4>${esc(r.title)}</h4><p class="body">${esc(r.body)}</p>${secretRows(r)}</div>`).join("");
}
const UNDO_LINE = "Undo this answer? The agent already has it and will be told to unwind; work built on it may change.";

/**
 * Undoing is destructive in the world outside the pane — the agent unwinds
 * whatever it built on the answer — so it asks first. It asks in the card:
 * `window.confirm` steals the whole window and reads as a browser error, and
 * the side panel is meant to sit beside the site without interrupting it.
 */
/**
 * The item's page, as a link. The owner: "you probably could have linked me the
 * fixture site instead of just saying it was on the port." Go navigates the tab
 * he is walking; this is for the times he just wants to look, in his own tab,
 * without spending the card's Go on it.
 *
 * Only a scheme a browser will actually open: the item's author is an agent,
 * and `href` is the one place in this pane where escaping is not enough.
 */
function pageLink(url: string): string {
  let ok = false;
  try { ok = ["http:", "https:"].includes(new URL(url).protocol); } catch { ok = false; }
  if (!ok) return "";
  return `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(url)}</a>`;
}
/**
 * The link and Go share the card's top row. The owner, 2026-09-17: "if the link is
 * at the top of the card maybe the Go button should be near the top too /
 * instead?" Instead. Go is the first press on every card, so the card reads
 * get there → what to do → judge it. Go is there even when the url earned no
 * link, because a card with nowhere to press is a card that cannot be walked.
 */
function goRow(i: { id: string; url: string }): string {
  return `<p class="url">${pageLink(i.url)}<button data-go="${esc(i.id)}">Go</button></p>`;
}

/**
 * A secret's row: what it is, a run of dots, and a button that puts the value
 * on the clipboard. On an early walk, a question card said "the key is
 * copied to your clipboard right now" and it was not — an agent cannot reach
 * the clipboard, and the pane already has his hand on a button.
 *
 * The value is not here, and must never be: not as text, not in a title, not
 * in a data attribute. It reaches the clipboard from the worker's copy of the
 * walk (panel.ts), so nothing on screen and nothing in a screenshot of the
 * pane has ever seen it. The dots are a fixed length for the same reason — the
 * length of a key is a fact about the key.
 */
export const SECRET_DOTS = "••••••••••••";
export const COPY_LABEL = "Copy";
export const COPIED_LABEL = "Copied";
/**
 * Said once the value is actually on the clipboard, because from there it is
 * the person's to spend — and from there every app on the machine can read it,
 * which the line now says out loud (secrets review).
 */
export const COPIED_NOTE = "On your clipboard — every app here can read it. If you paste it where it shows in plain text, the next verdict's screenshot will show it too.";

function secretRows(i: Item): string {
  const list = (i as { secrets?: { label: string }[] }).secrets;
  if (!list?.length) return "";
  const rows = list.map((s, n) =>
    `<div class="secret"><span class="name">${esc(s.label)}</span><span class="dots" aria-hidden="true">${SECRET_DOTS}</span>` +
    `<button data-copy="${esc(i.id)}" data-secret="${n}" aria-label="${esc(`${COPY_LABEL} ${s.label}`)}">${COPY_LABEL}</button></div>`).join("");
  return `<div class="secrets">${rows}</div>`;
}

/**
 * What a person sees when no daemon has ever answered on this port.
 *
 * A store install is the extension alone; the daemon arrives with the agent's
 * MCP server. Until then the pane would say "Looking for walkd" forever with
 * nothing to say what is missing. This is for a port that has never answered
 * (the worker keeps that per port in storage); a daemon that is down mid-walk
 * keeps the "Looking for" line, which is right for a restart.
 *
 * The command is in the DOM on purpose, unlike a secret's value: it is public
 * and it is the whole point of the note. `data-copy-text` puts it on the
 * clipboard with the same Copy button a secret has.
 */
export const INSTALL_COMMAND = "claude mcp add --scope user sidewalk -- npx -y sidewalk-mcp";
export const FIRST_RUN_TITLE = "One more piece to install";
export const firstRunBody = (port: number) =>
  `This panel listens for walkd, a small local program your agent starts. Nothing has answered on port ${port} yet. Add it to Claude Code with this command, then ask the agent to open a walk:`;
export const FIRST_RUN_FOOT = "Any other agent that can run an MCP server works the same way with npx -y sidewalk-mcp. Needs Node 22 or newer. walkd makes a token the first time it starts and keeps it. Run walkd token --copy, then paste it into this panel's gear once. Without it the daemon will not let the panel in.";

function commandRow(command: string, label: string): string {
  return `<div class="command"><code>${esc(command)}</code><button data-copy-text="${esc(command)}" aria-label="${esc(label)}">${COPY_LABEL}</button></div>`;
}

export function renderFirstRun(port: number): string {
  return `<section class="note first-run"><h2>${esc(FIRST_RUN_TITLE)}</h2><p>${esc(firstRunBody(port))}</p>` +
    commandRow(INSTALL_COMMAND, `${COPY_LABEL} the install command`) +
    `<p class="foot">${esc(FIRST_RUN_FOOT)}</p></section>`;
}

/**
 * The pane and the daemon are not the same release (`version.ts` says when).
 * A warning, never a gate: a stale daemon still serves everything it does
 * understand, and refusing would strand a person mid-walk. The remedy is
 * both halves — the MCP process holds the old walkd and would start it again.
 */
export const STOP_COMMAND = "npx -y sidewalk-walkd stop";
export const versionNotice = (mine: string, theirs: string, port: number) =>
  `This panel is ${mine} and walkd on port ${port} is ${theirs}. They may not understand each other. To match them, stop walkd, then reconnect the agent's MCP server (/mcp in Claude Code); its next call starts a current one.`;

export function renderVersionNotice(mine: string, theirs: string, port: number): string {
  return `<section class="note version"><p>${esc(versionNotice(mine, theirs, port))}</p>` +
    commandRow(STOP_COMMAND, `${COPY_LABEL} the stop command`) + `</section>`;
}

/**
 * The daemon is right there and it refused us: it wants its token, and an
 * extension cannot read the file it keeps it in (secrets review). So the
 * one thing to say is where to get it and where to put it — the command, with a
 * Copy button, and the gear that takes what it prints.
 *
 * It takes the notice slot the version warning uses, above the cards, because
 * nothing on the pane works until this is done.
 */
export const TOKEN_COMMAND = "npx -y sidewalk-walkd token --copy";
export const tokenNotice = (port: number) =>
  `walkd on port ${port} will not let this panel in without its token. It keeps the same one across restarts, so this is asked once. Run this, then paste it into the gear above:`;
export const NEEDS_TOKEN_STATUS = "needs the token";
export const needsTokenLine = (port: number) => `walkd on ${port} ${NEEDS_TOKEN_STATUS}`;

export function renderTokenNotice(port: number): string {
  return `<section class="note token"><p>${esc(tokenNotice(port))}</p>` +
    commandRow(TOKEN_COMMAND, `${COPY_LABEL} the token command`) + `</section>`;
}

/**
 * What the gear says about the token that was just saved, and in which colour.
 *
 * The owner, 2026-10-06: "i had copied something else and noticed when i saved my
 * wrong token it just says saved in green like no actual connection check /
 * rejection". Save is a check: the pane stores the token, waits for the worker's
 * answer for that port with that token, and this is that answer and only that.
 * Green is the one state where the daemon has let the pane in; a refusal is the
 * pane's issue red, and the two "nothing to ask" ends are muted, because neither
 * is a verdict on what was pasted.
 */
export const TOKEN_CHECKING = "Checking…";
export const TOKEN_CONNECTED = "Connected.";
export const TOKEN_REFUSED = "walkd refused this token.";
export const noWalkdLine = (port: number) => `No walkd on ${port}.`;
export const noAnswerLine = (port: number) => `No answer from walkd on ${port}.`;

export function tokenSay(check: TokenCheck, port: number): { text: string; cls: "" | "pass" | "issue" } {
  switch (check) {
    case "checking": return { text: TOKEN_CHECKING, cls: "" };
    case "connected": return { text: TOKEN_CONNECTED, cls: "pass" };
    case "refused": return { text: TOKEN_REFUSED, cls: "issue" };
    case "noDaemon": return { text: noWalkdLine(port), cls: "" };
    case "noAnswer": return { text: noAnswerLine(port), cls: "" };
  }
}

/**
 * Which Undo a verdict gets. The owner, on an early walk: "until the other agent picks it
 * up it's a free and easy click to evict it from the daemon … a green undo
 * that turns red when the main agent pulls it off the queue." The daemon's
 * `delivered` mark is the highest seq an agent has been handed: above it
 * (or not yet acknowledged, seq -1, or a daemon too old to say) the verdict is
 * still only the pane's, and taking it back costs nothing.
 */
export function undoIsFree(v: { seq: number }, walk: { delivered?: number }): boolean {
  return v.seq < 1 || walk.delivered === undefined || v.seq > walk.delivered;
}

/**
 * The owner, on an early walk: "if it's been more than like 10min or some longer amount of
 * time, can you keep the buttons the same but update with one more text
 * warning". An answer the agent has held for a while has had lanes built on
 * it; the second line says how long, so the person sees what the undo
 * reaches back across before they press.
 */
export const LONG_HELD_MS = 10 * 60 * 1000;
export function formatElapsed(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}
const LONG_HELD_LINE = (elapsed: string) => `Are you really sure? Automated work built on this answer across the last ${elapsed} may be destroyed.`;

function undoBlock(id: string, confirming: boolean, free = false, at?: string, now = Date.now()): string {
  const e = esc(id);
  if (free) return `<div class="undo"><button class="free" data-undo-now="${e}">Undo</button></div>`;
  if (!confirming) return `<div class="undo"><button class="danger" data-undo="${e}">Undo</button></div>`;
  const age = at ? now - Date.parse(at) : 0;
  const held = Number.isFinite(age) && age >= LONG_HELD_MS ? `<p class="confirm held">${LONG_HELD_LINE(formatElapsed(age))}</p>` : "";
  return `<p class="confirm">${UNDO_LINE}</p>${held}<div class="undo"><button class="danger" data-undo-confirm="${e}">Undo</button><button data-undo-cancel="${e}">Keep</button></div>`;
}

/**
 * Two walks can be open at once and the pane paints them one after another into
 * the same list, so `data-walk-id` on the header and on every group is what
 * says which walk a card belongs to. It is a hook, not a style: nothing in the
 * stylesheet reads it.
 */
/** The person's latest answer on an item: the newest verdict that is not the pane's own `blocked`. */
function lastAnswer(i: Item, verdicts: Verdict[]): Verdict | undefined {
  return [...verdicts].reverse().find(v => v.itemId === i.id && v.kind !== "blocked");
}

/**
 * Done: answered, and the agent has been handed the answer (the red-Undo
 * state), or withdrawn. The owner, on an early walk: "once it's read off the daemon or
 * whatever then it drops down to the bottom in the 'completed' shelf? having
 * to scroll all the way down to my next walk item feels wrong." A card the
 * agent has not read yet stays where it was, green Undo and all.
 */
export function isDone(i: Item, view: WalkView, refused: Set<string> | undefined): boolean {
  const st = itemState(i, view.verdicts, refused?.has(i.id) ?? false, view.cleared?.[i.id] ?? 0);
  if (st === "withdrawn") return true;
  if (st !== "answered") return false;
  const last = lastAnswer(i, view.verdicts);
  return !!last && !undoIsFree(last, view.walk);
}

/**
 * The ledge: answered, and the agent has not been handed the answer yet — the
 * green-Undo state, and the exact complement of `isDone` over answered cards.
 *
 * The owner, 2026-09-23, on the Lamppost demo: "the way the thing scrolled me away
 * from where I was was… surprising", and then "there maybe needs to be an
 * intermediary step, where while the undo is still green like during that
 * cooldown period, where it'd maybe either collapse to one row for a bit, or
 * collapse and pin and stick to the screen for a bit". So it does both: the
 * card leaves the list the moment it is answered — the next card slides up into
 * its place, and nothing under the person's cursor moves — and its one line
 * pins to the bottom of the pane with the free Undo on it until the read lands.
 *
 * `blocked`, `ask` and `undo` never reach here: `itemState` calls the first
 * `blocked` and the other two `new`, because all three are cards the person can
 * still act on.
 */
export function isOnLedge(i: Item, view: WalkView, refused: Set<string> | undefined): boolean {
  if (itemState(i, view.verdicts, refused?.has(i.id) ?? false, view.cleared?.[i.id] ?? 0) !== "answered") return false;
  const last = lastAnswer(i, view.verdicts);
  return !!last && undoIsFree(last, view.walk);
}

/**
 * How much of the drain bar is left, as a percentage, or null for no bar at
 * all: a daemon that did not say what its window is (`graceMs` undefined), a
 * daemon serving with the window switched off (0, as the e2e does), or a
 * verdict with no readable timestamp.
 *
 * Linear, and it stops at empty. An empty bar is not a card leaving — the row
 * leaves when the agent's read lands, which can be a while after the window
 * matures if no agent is reading, and a row that vanished on a timer would be
 * a free Undo the person watched expire when it had not.
 */
export function drainPercent(at: string | undefined, now: number, graceMs: number | undefined): number | null {
  if (graceMs === undefined || !Number.isFinite(graceMs) || graceMs <= 0) return null;
  const started = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(started)) return null;
  const left = (graceMs - (now - started)) / graceMs;
  return Math.round(Math.min(1, Math.max(0, left)) * 1000) / 10;
}

/**
 * The bar itself: 2 px of pass green under the row, full at the verdict's `at`
 * and empty a grace window later. `data-drain` carries that timestamp so the
 * pane can redraw the width on a tick without rebuilding the card — a repaint
 * four times a second under someone's hand is how you lose a half-typed note.
 */
function drainBar(v: Verdict, opts: RenderOpts): string {
  const pct = drainPercent(v.at, opts.now ?? Date.now(), opts.graceMs);
  if (pct === null) return "";
  return `<div class="drain" data-drain="${esc(v.at)}" style="width:${pct}%"></div>`;
}

/** Where a card is being painted. The three are exclusive, and the renderer
 *  decides: the list is what is left to walk, the ledge is what was just
 *  answered, the shelf is the record. */
export type Place = "list" | "ledge" | "shelf";

/**
 * The owner, on an early walk: "if there's nothing on the walk can you vertically centered
 * just put a lil text there saying like nothing to see here style text".
 * Two empties: no walk open at all (the whole pane), and a walk with nothing
 * left to act on (a line above its Done shelf).
 */
export const NOTHING_OPEN = "Nothing to see here yet. When an agent opens a walk, it shows up on its own.";
export const NOTHING_LEFT = "Nothing left on this walk. Anything new lands here on its own.";
export const WALK_CLOSED = "This walk is closed.";
export function renderEmpty(): string {
  return `<p class="nothing">${NOTHING_OPEN}</p>`;
}

export function renderWalk(view: WalkView, opts: RenderOpts): string {
  const w = esc(view.walk.id);
  // The brief is the agent's words, under the title, and it never moves:
  // groups below it are newest first, so it is the one place "read this
  // first" can live.
  const brief = view.walk.brief ? `<p class="brief">${esc(view.walk.brief)}</p>` : "";
  const head = `<header data-walk-id="${w}"><h1>${esc(view.walk.title)}</h1><div class="meta"><code>${esc(view.walk.buildRef)}</code></div>${brief}</header>`;
  // An `info` answer to an ask is not an item on the pane at all: it paints
  // inside the card that asked (`replies.ts`), so it is out of all three places
  // below — out of its group, off the ledge, off the shelf — and out of the
  // count that decides whether this walk has anything left on it.
  const rep = replies(view.items, view.verdicts);
  const cards = view.items.filter(i => !rep.attached.has(i.id));
  // Three places, and every item is in exactly one: the list is what is left to
  // walk, the ledge is what was answered and not yet read, the shelf is the
  // record. A card answered mid-list leaves the list at once, so the card under
  // it slides up into its place and the pane does not have to chase it.
  const onLedge = cards.filter(i => isOnLedge(i, view, opts.refused));
  const ledgeSet = new Set(onLedge.map(i => i.id));
  const active = cards.filter(i => !isDone(i, view, opts.refused) && !ledgeSet.has(i.id));
  // The shelf keeps the order things were finished in, oldest first.
  const done = cards.filter(i => isDone(i, view, opts.refused))
    .sort((a, b) => (lastAnswer(a, view.verdicts)?.seq ?? a.seq) - (lastAnswer(b, view.verdicts)?.seq ?? b.seq));
  const groups = placeReplies(groupItems(active), rep.after).map(([g, items]) => `<section class="group" data-walk-id="${w}"><h2>${esc(g || "walk")}</h2>${items.map(i => renderItem(i, view, opts, "list", rep)).join("")}</section>`).join("");
  // The shelf's heading carries the count at the right of its own line; the
  // rule above it is the edge where the slabs stop and the record begins.
  const shelf = done.length ? `<section class="group shelf" data-walk-id="${w}"><h2>Done<span class="count">${done.length}</span></h2>${done.map(i => renderItem(i, view, opts, "shelf", rep)).join("")}</section>` : "";
  const empty = active.length ? "" : `<p class="empty">${view.walk.closedAt ? WALK_CLOSED : NOTHING_LEFT}</p>`;
  // Newest on top — the row you just made is the one your eye is looking for.
  // A verdict the daemon has not acknowledged yet has no seq (-1) and is the
  // newest thing there is, so it sorts above every numbered one.
  const order = (i: Item) => { const s = lastAnswer(i, view.verdicts)?.seq ?? i.seq; return s < 1 ? Infinity : s; };
  // Last in the pane, and sticky to its bottom: the ledge is the one thing that
  // does not move when the list under it does. No heading and no words of its
  // own — the rows are the whole content.
  const ledge = onLedge.length
    ? `<section class="ledge" data-walk-id="${w}">${[...onLedge].sort((a, b) => order(b) - order(a)).map(i => renderItem(i, view, opts, "ledge", rep)).join("")}</section>`
    : "";
  return head + groups + empty + shelf + ledge;
}

function renderItem(i: Item, view: WalkView, opts: RenderOpts, place: Place = "list", rep: Replies = replies(view.items, view.verdicts)) {
  const st = itemState(i, view.verdicts, opts.refused?.has(i.id) ?? false, view.cleared?.[i.id] ?? 0);
  const isNew = i.seq > view.lastSeenSeq;
  const mine = view.verdicts.filter(v => v.itemId === i.id);
  // Two different "last" verdicts, because they answer two different questions.
  // `last` is the person's latest answer and owns the card's verdict line — a
  // `blocked` the pane filed afterwards must never be read out as their words.
  // `newest` is whatever happened most recently and owns the diagnostic line.
  const last = [...mine].reverse().find(v => v.kind !== "blocked");
  const newest = mine[mine.length - 1];
  /**
   * Go stopped here: the pane's own `blocked` line is the newest thing on the
   * card, and no later Go has cleared it. It is a kerb state as well as a line.
   *
   * It has to be read off the verdicts rather than off `itemState`, because an
   * `ask` before the blocked line makes the state `new` — the card is
   * answerable, which is right — and the orange edge would then be lost on
   * exactly the card that needs it most: the one whose Go just failed. The
   * design language has said since v3 that orange outranks blue on the same
   * card, and it outranks the waiting yellow for the same reason.
   *
   * An answered or withdrawn card is over: the line is never drawn there (both
   * return early below), so neither is its kerb — a green Pass does not turn
   * orange because a stale Go failed behind it.
   */
  const stopped = !!newest && newest.kind === "blocked" && newest.seq > (view.cleared?.[i.id] ?? 0)
    && st !== "answered" && st !== "withdrawn";
  // The refused line takes the place of the verdict line, and the card falls
  // through to its answerable form below: same buttons, same note box.
  // Current = the card whose Go was pressed last, while it can still be
  // answered. The owner: "blue should be for what you go'd to".
  const current = view.current === i.id && (st === "new" || st === "blocked" || st === "refused");
  /**
   * Waiting: the person's question is with the agent and the agent has not come
   * back. It is the same condition as the asked line below — one state, said
   * twice, at the line and at the kerb — so it begins when the ask verdict is
   * filed and ends when it ends: when the agent's answer lands (`replied`), on
   * the person's next answer to the card (any verdict that is not the pane's own
   * `blocked`), or when the agent withdraws the item. Reading the ask does not
   * end it; neither does an item that was replied with and then withdrawn,
   * because the agent took its own answer back and the question stands again.
   *
   * The owner, 2026-10-04, on the answer landing: "I think the color indication type
   * stuff should stop looking like it's still pending/waiting, at least in the
   * same way, because it's still pending a person but not pending the same thing
   * anymore (claude in this case)." So the yellow goes the moment the reply
   * does: the kerb falls back to whatever it would otherwise be — blue and
   * breathing if this is the current card, nothing if it is not, orange if a Go
   * stopped here — and what says "answered, your move" is the reply block's own
   * 2 px of ink, which does not move (see `replyBlocks`, and `.reply` in
   * panel.css). Three states, three ways of reading: fresh has no edge, waiting
   * breathes yellow, answered-and-yours is a still ink rule inside the card.
   *
   * Precedence among kerb states: blocked (orange) outranks waiting, waiting
   * (yellow) outranks current (blue) on the same card, and an answered card is
   * never waiting. `st === "new"` covers two of those — `itemState` calls an
   * asked card `new` and an answered one `answered` — and it also keeps the
   * kerb off a `refused` card, whose ask the walk server never took, so there
   * is nobody to wait for. `!stopped` is the first: a card that is both asked
   * and stopped keeps the asked *line* (both things are true at once, and the
   * words say both), but the 4 px of edge has to choose, and it says orange.
   * Yellow over blue is left to the stylesheet's source order, which puts
   * `.item.waiting` after `.item.current` and before `.item.blocked`.
   */
  const askedNow = last?.kind === "ask";
  const replied = rep.answered.has(i.id);
  const waiting = askedNow && !replied && st === "new" && !stopped;
  // The kerb reads off these classes: the state, and on an answered card the
  // verdict's own kind. `unseen` stays as a hook and paints nothing — v3 drops
  // the purple edge, because arriving is not a state.
  const kind = st === "answered" && last ? ` v-${MARK_KIND[last.kind] ?? "pass"}` : "";
  const onShelf = place === "shelf";
  // The agent's answers to this card, in seq order. They stand where the waiting
  // line stood while the card is answerable, and on the shelf they are part of
  // the record the row opens out to show — a verdict and the answer it was given
  // under are one thing to read back, which is the whole point of the shelf.
  const answers = replyBlocks(rep.blocks.get(i.id) ?? []);
  const cls = `item ${st}${isNew ? " unseen" : ""}${kind}${waiting ? " waiting" : ""}${stopped && st !== "blocked" ? " blocked" : ""}${current ? " current" : ""}${onShelf ? " done" : ""}${place === "ledge" ? " on-ledge" : ""}`;
  const openTag = `<article class="${cls}" data-item="${esc(i.id)}">`;
  const open = `${openTag}<h3>${esc(i.title)}</h3>${st === "refused" ? REFUSED_LINE : ""}`;
  // A withdrawn card is over: a struck title, the agent's reason in muted, and
  // a struck dash in the gutter. Nothing to press.
  if (st === "withdrawn") return `${openTag}${gutterMark("withdrawn", WITHDRAWN_LABEL)}<p class="verdict"><s>${esc(i.title)}</s> <span class="strike">${esc(i.withdrawReason ?? "")}</span></p></article>`;
  if (st === "answered" && last) {
    // One line, in a fixed order: the verdict, the card's title, then the
    // person's words in muted. A decision is the exception — the option leads
    // and the title trails, because at 360 px the title would push the option
    // off the line and the option is the whole answer. On the shelf the word is
    // dropped for the gutter mark, which says the same thing in the same colour.
    // A sequence's verdict says how far the steps got, so "Issue" on a four-step
    // card reads as where it broke without the words having to say so.
    const far = last.steps ? `<span class="far">${last.steps.filter(Boolean).length} of ${last.steps.length} steps</span>` : "";
    const decided = last.kind === "decision";
    const lead = decided ? esc(optionLabel(last.option)) : esc(i.title);
    const rest = trail(decided ? [esc(i.title), far, esc(last.text)] : [far, esc(last.text)]);
    const word = onShelf ? "" : `<b>${esc(lineLabel(last.kind))}</b> `;
    const mark = onShelf ? gutterMark(MARK_KIND[last.kind] ?? "pass", lineLabel(last.kind)) : "";
    // On the ledge the line is the list's line exactly — same word, same order,
    // same green Undo — with the window it has left drawn under it.
    const drain = place === "ledge" ? drainBar(last, opts) : "";
    // The shelf row carries the answer it was given under; the ledge row does
    // not. A ledge row is the list's one line and three of them is the whole
    // strip — a receipt, not the record — and the row leaves for the shelf a
    // grace window later, where the answer opens out with everything else.
    const record = onShelf ? answers : "";
    return `${openTag}${mark}<p class="verdict">${word}${lead}${rest}</p>${undoBlock(i.id, opts.confirming?.has(i.id) ?? false, undoIsFree(last, view.walk), last.at, opts.now)}${record}${drain}</article>`;
  }
  // The note box says what it is for; v3's pane mock has the words in the well.
  const note = `<textarea data-note="${esc(i.id)}" spellcheck="false" autocomplete="off" placeholder="${NOTE_PLACEHOLDER}">${esc(opts.drafts.get(i.id) ?? "")}</textarea>`;
  // An asked card is not an answered one: the line goes above the buttons and
  // the buttons stay, so the human is never locked out waiting on the agent.
  // The dot leads it, breathing in the same yellow the kerb is.
  //
  // When the answer lands it takes that slot: the words that said "waiting" are
  // replaced by the words that were waited for, in the same place, on the same
  // card, above the same buttons — answering the card is still what resolves it.
  // A `question` reply has no block to put here (it is a card of its own, right
  // under this one), so the slot is simply empty: the line and its dot go either
  // way, because nothing is pending the agent any more.
  //
  // Both at once when the person asks again on a card that has already been
  // answered — one early PIN exchange went several turns. The answers so far are
  // the card's record and stay where they are; the new question's line goes
  // under them, which is the order the conversation happened in.
  const asked = answers + (askedNow && !replied ? `<p class="asked">${WAITING_DOT}${ASKED_LINE}</p>` : "");
  // Every card's presses sit in one row at its foot, so the slab has one shape.
  if (i.kind === "info") return `${open}<p class="body">${esc(i.body)}</p>${secretRows(i)}<div class="verdicts"><button data-kind="dismiss" data-for="${esc(i.id)}">Dismiss</button></div></article>`;
  if (i.kind === "question") {
    // The agent puts the recommended option first (design §1.1); the tag says so
    // out loud, so the order is not a convention only the agent knows about.
    // An undone decision hands the card back with the answer that was undone
    // still picked: the human is correcting it, not starting from nothing.
    const picked = last?.kind === "undo" ? last.option : undefined;
    const opts_ = i.options.map((o, n) => `<label><input type="radio" name="opt-${esc(i.id)}" value="${esc(o)}"${o === picked ? " checked" : ""}> ${esc(o)}${n === 0 ? ` <span class="tag">Recommended</span>` : ""}</label>`).join("") + `<label><input type="radio" name="opt-${esc(i.id)}" value="${OTHER}"> Other</label>`;
    return `${open}${questionBody(i)}<div class="options">${opts_}</div>${note}${asked}<div class="verdicts"><button data-kind="decision" data-for="${esc(i.id)}">Submit</button><button data-kind="ask" data-for="${esc(i.id)}">Ask</button></div></article>`;
  }
  // The heading is for the human; the diagnostic under it stays exactly as the
  // pane filed it, because that string is what the agent (and the owner) read.
  const blocked = stopped ? `<p class="blocked">${esc(VERDICT_LABEL.blocked)}</p><p class="diag"><code>${esc(newest!.text)}</code></p>` : "";
  const buttons = `<div class="verdicts"><button data-kind="pass" data-for="${esc(i.id)}">Pass</button><button data-kind="pass-note" data-for="${esc(i.id)}">Pass + note</button><button data-kind="issue" data-for="${esc(i.id)}">Issue</button><button data-kind="skip" data-for="${esc(i.id)}">Skip</button><button data-kind="ask" data-for="${esc(i.id)}">Ask</button></div>`;
  if (i.kind === "sequence") {
    // One card for a path: the steps in order, a tick each as it works, then
    // the same note box and buttons a look card has, once. The ticks live in
    // the panel's map like a draft does, so a repaint mid-path keeps them.
    // An undone sequence comes back with its ticks where they were, like an
    // undone decision comes back with its option picked.
    const ticks = opts.ticks?.get(i.id) ?? (last?.kind === "undo" ? last.steps ?? [] : []);
    const steps = i.steps.map((s, n) => `<li class="step"><label><input type="checkbox" data-step="${n}" data-for="${esc(i.id)}"${ticks[n] ? " checked" : ""}> <span class="do">${esc(s.do)}</span> <span class="see">${esc(s.see)}</span></label></li>`).join("");
    const pass = i.pass ? `<p class="pass">${esc(i.pass)}</p>` : "";
    return `${open}${goRow(i)}<ol class="steps">${steps}</ol>${pass}${secretRows(i)}${blocked}${note}${asked}${buttons}</article>`;
  }
  return `${open}${goRow(i)}<dl><dt>do</dt><dd>${esc(i.do)}</dd><dt>see</dt><dd>${esc(i.see)}</dd><dt>pass</dt><dd>${esc(i.pass)}</dd></dl>${secretRows(i)}${blocked}${note}${asked}${buttons}</article>`;
}

export type Choices = { options: Map<string, string> };
export type FocusSnapshot = { note: string; start: number; end: number } | null;

/**
 * Which verdicts are nothing without words in the note box. An Issue with no
 * words is not a finding, a Pass + note is a Pass, an Ask is not a question,
 * and Other is not an answer.
 */
export function needsText(kind: Verdict["kind"], option?: string): boolean {
  return kind === "pass-note" || kind === "issue" || kind === "ask" || (kind === "decision" && option === OTHER);
}

/**
 * The second half of the seq-7 defect in the owner's first walk: Issue on an empty
 * note box did nothing at all, silently, and the only text on the card was the
 * machine diagnostic — so that is what ended up in the box and in the record.
 * A button that cannot do anything yet says so by being dead, and there is
 * nothing to hunt for to make it work.
 */
export function syncVerdictButtons(root: ParentNode, drafts: Map<string, string>, c: Choices): void {
  for (const b of root.querySelectorAll<HTMLButtonElement>("button[data-kind][data-for]")) {
    const id = b.dataset.for!;
    const kind = b.dataset.kind as Verdict["kind"];
    const option = c.options.get(id);
    b.disabled = (kind === "decision" && !option) || (needsText(kind, option) && !(drafts.get(id) ?? "").trim());
  }
}

/**
 * A repaint rebuilds every card, which would silently un-pick a radio while the
 * human is mid-answer. The panel keeps the pick in a map and puts it back on
 * the fresh DOM; an item the map says nothing about is left as rendered.
 */
export function applyChoices(root: ParentNode, c: Choices): void {
  for (const el of root.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
    if (!el.name.startsWith("opt-")) continue;
    const chosen = c.options.get(el.name.slice(4));
    if (chosen !== undefined) el.checked = chosen === el.value;
  }
}

/** Where the cursor was, so a repaint mid-sentence does not throw it out. */
export function snapshotFocus(doc: Document): FocusSnapshot {
  const el = doc.activeElement as HTMLTextAreaElement | null;
  if (!el || !el.dataset?.note) return null;
  return { note: el.dataset.note, start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
}

export function restoreFocus(doc: Document, snap: FocusSnapshot): void {
  if (!snap) return;
  const el = [...doc.querySelectorAll<HTMLTextAreaElement>("textarea[data-note]")].find(t => t.dataset.note === snap.note);
  if (!el) return;
  el.focus();
  try { el.setSelectionRange(snap.start, snap.end); } catch { /* a detached or read-only field */ }
}
