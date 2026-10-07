import type { GoResult, SwState, PanelToSw, TokenAnswer, TokenCheck, VerdictDraft } from "./protocol.js";
import { NO_ACCESS_SAID, badSelectorLine } from "./expect.js";
import { COPIED_LABEL, COPIED_NOTE, COPY_LABEL, applyChoices, drainPercent, needsText, needsTokenLine, renderEmpty, renderFirstRun, renderTokenNotice, renderVersionNotice, renderWalk, restoreFocus, snapshotFocus, syncVerdictButtons, tokenSay, type Choices } from "./render.js";
import { versionsDiffer } from "./version.js";
import { setMarkup } from "./markup.js";
import { DEFAULT_SCALE, DEFAULT_SHOTS, SCALES, UI_KEY, applyScale, nextScale, shotsOf, type Shots, type Ui } from "./settings.js";
import { DEFAULT_PORT, TOKEN_KEY, parseToken } from "./port.js";

const send = <T>(m: PanelToSw): Promise<T> => chrome.runtime.sendMessage(m);
const drafts = new Map<string, string>();
// What the human has picked but not yet submitted. A repaint rebuilds the DOM,
// so these outlive it and are put back on the fresh cards.
const choices: Choices = { options: new Map() };
// A sequence's ticked steps, by item id, until its verdict goes. Same reason
// as `choices`: a repaint must not un-tick a step mid-path.
const ticks = new Map<string, boolean[]>();
// Items whose Undo has been pressed once and is waiting for the second press.
// Panel-local: an unconfirmed Undo is not a fact the walk should carry.
const confirming = new Set<string>();
// The long-held warning carries an elapsed time; while a confirm is open the
// pane repaints once a minute so that number does not go stale.
setInterval(() => { if (confirming.size) paint(); }, 60_000);
let state: SwState = { connected: false, walks: [], queued: 0, dead: 0, refused: [] };

// The service worker sleeps after ~30 s idle, which would stall the SSE stream
// under an open pane. A port with a ping on it keeps the worker up for exactly
// as long as the pane is on screen.
const PING_MS = 20_000;
let port: chrome.runtime.Port | null = null;
function connect() {
  try {
    port = chrome.runtime.connect({ name: "walkd-panel" });
    port.onDisconnect.addListener(() => { port = null; });
  } catch {
    port = null;
  }
}
connect();
setInterval(() => {
  if (!port) connect();
  try { port?.postMessage({ t: "panel:ping" }); } catch { port = null; }
}, PING_MS);

// The owner, first hands-on use: "font size too small." The pane's own size is a
// per-viewer preference, not a property of the walk, so it lives in this
// browser's storage and never goes near the daemon.
let scale = DEFAULT_SCALE;
// The owner: "should we make post-answer screenshots a disable-able option in
// settings? … or maybe a 3rd option of 'on issues only'." Read by the worker
// at submit time, so a change lands on the next verdict without a reload.
let shots: Shots = DEFAULT_SHOTS;
const SHOT_BUTTONS: [id: string, value: Shots][] = [["shots-always", "always"], ["shots-issues", "issues"], ["shots-never", "never"]];

function paintScale() {
  applyScale(document, scale);
  document.getElementById("scale")!.textContent = `${scale}%`;
}

function paintShots() {
  for (const [id, value] of SHOT_BUTTONS) document.getElementById(id)?.classList.toggle("on", shots === value);
}

/** Both preferences go in one object, so saving either does not forget the other. */
function saveUi() {
  // Not being able to remember it is not a reason to refuse to do it.
  try { void chrome.storage.local.set({ [UI_KEY]: { scale, shots } satisfies Ui }).catch(() => {}); } catch { /* the setting still changed for this session */ }
}

function stepScale(dir: 1 | -1) {
  scale = nextScale(scale, dir);
  paintScale();
  saveUi();
}

function setShots(next: Shots) {
  shots = next;
  paintShots();
  saveUi();
}

/**
 * The daemon's token, the one connection setting the person has to carry across
 * by hand: walkd writes it to a file and an extension cannot read files (audit
 * 2026-10-04, F1). Kept beside the port in `chrome.storage.local`, where the
 * worker reads it; saving it is what makes the worker retarget and try again.
 *
 * The field shows what is stored, as dots — it is a credential on screen, and a
 * person who cannot see whether anything is in there would paste twice.
 */
const tokenField = () => document.getElementById("token") as HTMLInputElement | null;

/**
 * How long the gear waits for the worker's answer before it says there was none.
 *
 * The worker's own floor is the 10 s it gives a daemon that accepts a connection
 * and then says nothing (`daemon.ts`), so this is not "the daemon is down" — a
 * port with nothing on it is refused at once and says so. It is the bound on a
 * line that would otherwise read `Checking…` for as long as the pane is open.
 */
const TOKEN_CHECK_MS = 5000;
/** The Save that owns the line. A second one takes it; the first one's answer is dropped. */
let checking = 0;
/** What that line last said, so `dropStaleTokenSay` can tell when it has stopped being true. */
let lastSaid: TokenCheck | null = null;

/** The gear's line: one of the five, in its own colour. */
function sayToken(check: TokenCheck, port = state.port ?? DEFAULT_PORT) {
  lastSaid = check;
  const said = document.getElementById("token-said");
  if (!said) return;
  const { text, cls } = tokenSay(check, port);
  said.textContent = text;
  said.className = cls;
  said.hidden = false;
}

/**
 * Take the line away once the pane has outgrown it.
 *
 * A green `Connected.` left standing over a pane that has since been refused —
 * one `walkd token --rotate` is enough — is the same lie as the "Saved" this
 * change went out to end, and the gear opens itself on a refusal, so it would be
 * read. A line is dropped only when the state contradicts it; a refusal stands
 * for as long as the daemon is still refusing.
 */
function dropStaleTokenSay() {
  if (lastSaid === null || lastSaid === "checking") return;
  if (lastSaid === "connected" ? state.connected : !state.connected) return;
  lastSaid = null;
  const said = document.getElementById("token-said");
  if (!said) return;
  said.hidden = true;
  said.textContent = "";
  said.className = "";
}

/**
 * What came of the last Go, when no card can say it.
 *
 * A page the check could not be run on files no verdict — silence is not a
 * failed expectation — and a selector the browser refuses used to look exactly
 * like it. Both now come back from the worker, and this is the one line that
 * reports them (found in review). `null` takes the line away, which is
 * what the next press does before it asks.
 */
function sayGo(r: GoResult | null) {
  const said = document.getElementById("said");
  if (!said) return;
  const text = r?.noAccess ? NO_ACCESS_SAID : r?.badSelector ? badSelectorLine(r.badSelector) : "";
  said.textContent = text;
  said.hidden = !text;
}

/**
 * Save the token, and say what the daemon made of it.
 *
 * The owner, 2026-10-06: "i had copied something else and noticed when i saved my
 * wrong token it just says saved in green like no actual connection check /
 * rejection". Writing a credential to storage is not evidence that it is the
 * right one, and green said it was. So the store stands — the worker reads
 * storage and retargets on the change, which is still what makes the connection
 * happen — and the gear waits for the worker's answer about that port with that
 * token before it says anything in green.
 *
 * An empty Save does nothing: there is no token to check, and the status line
 * already says the daemon wants one.
 */
async function saveToken() {
  const field = tokenField();
  if (!field) return;
  const token = parseToken(field.value);
  field.value = token;
  if (!token) return;
  const mine = ++checking;
  const button = document.getElementById("token-save") as HTMLButtonElement | null;
  if (button) button.disabled = true;
  sayToken("checking");
  // Not being able to remember it is not a reason to refuse to do it: the
  // worker reads storage, so a refused write is a token that does not land —
  // and the check below is what says so, in the daemon's own words.
  try { await chrome.storage.local.set({ [TOKEN_KEY]: token }); } catch { /* the answer below is still the daemon's */ }
  const answer = await askAboutToken();
  if (mine !== checking) return;                       // a later Save owns the line now
  if (button) button.disabled = false;
  sayToken(answer.check, answer.port);
  // A refused token is a paste that has to happen again, so the field is where
  // the hand already is, with the wrong one selected for the next paste to replace.
  if (answer.check === "refused") { field.focus(); field.select(); }
}

/**
 * The worker's answer for the token now in storage, bounded.
 *
 * The pane decides nothing about the token itself — it cannot: only the worker
 * talks to the daemon. A worker that does not answer inside the window is not a
 * refusal and must not be painted as one.
 */
function askAboutToken(): Promise<TokenAnswer | { check: "noAnswer"; port: number }> {
  const port = state.port ?? DEFAULT_PORT;
  const none = { check: "noAnswer" as const, port };
  return Promise.race([
    send<TokenAnswer | undefined>({ t: "panel:token" }).then(a => a?.check ? a : none, () => none),
    new Promise<typeof none>(r => setTimeout(() => r(none), TOKEN_CHECK_MS)),
  ]);
}

(async () => {
  try {
    const stored = parseToken((await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY]);
    const field = tokenField();
    if (field) field.value = stored;
  } catch { /* storage refused: the field starts empty and a paste still works */ }
})();

(async () => {
  try {
    const saved = (await chrome.storage.local.get(UI_KEY))[UI_KEY] as Partial<Ui> | undefined;
    // Only a rung: a stored value off the ladder could paint a pane nobody can
    // read, and the way back would be buttons they cannot see.
    if ((SCALES as readonly number[]).includes(saved?.scale as number)) scale = saved!.scale!;
    shots = shotsOf(saved);
  } catch { /* storage refused: the default is readable */ }
  paintScale();
  paintShots();
})();

/**
 * The ledge's drain bars, redrawn on a tick rather than by a repaint.
 *
 * Nothing else on the pane moves between paints, and a repaint four times a
 * second under someone's hand is how a half-typed note or a selection is lost.
 * So the width is the only thing touched here: each bar carries its verdict's
 * `at` in `data-drain`, and the rest is that and the daemon's window.
 *
 * The pane no longer scrolls anywhere on submit. The owner, 2026-09-23, on the
 * Lamppost demo: "the way the thing scrolled me away from where I was was…
 * surprising". The answered card leaves the list for the ledge, so the card
 * under it slides up into its place and the person stays where they were.
 */
const DRAIN_TICK_MS = 250;
function tickDrains() {
  const bars = document.querySelectorAll<HTMLElement>(".ledge .drain[data-drain]");
  if (!bars.length) return;
  const now = Date.now();
  for (const b of bars) {
    const pct = drainPercent(b.dataset.drain, now, state.graceMs);
    if (pct !== null) b.style.width = `${pct}%`;
  }
}
setInterval(tickDrains, DRAIN_TICK_MS);

/**
 * The gear opens itself the first time a daemon refuses the token, because the
 * field the notice points at is inside it. Once per pane: a person who closes it
 * again has closed it, and a repaint must not fight them.
 */
let openedForToken = false;

function paint() {
  const focus = snapshotFocus(document);
  dropStaleTokenSay();
  if (state.needsToken && !openedForToken) { openedForToken = true; document.getElementById("prefs")!.hidden = false; }
  const refused = new Set((state.refused ?? []).map(r => r.itemId));
  const status = document.getElementById("status")!;
  // Design language v3, §Motion: the line says which daemon, and on which port,
  // in both states; the queued and refused counts follow either one.
  const port = state.port ?? DEFAULT_PORT;
  const counts = `${state.queued ? `, ${state.queued} queued` : ""}${state.dead ? `, ${state.dead} refused` : ""}`;
  // Three states now, not two: connected, looking, and answering-but-refusing.
  // The third is a daemon that is right there and wants its token, which is a
  // different thing to tell somebody than "nothing is answering".
  const where = state.needsToken ? needsTokenLine(port) : `${state.connected ? "Connected to walkd on" : "Looking for walkd on"} ${port}`;
  status.textContent = `${where}${counts}`;
  // A breathing green dot while there is a walk server; grey and still without.
  const dot = document.createElement("span");
  dot.className = `dot${state.connected ? " on" : ""}`;
  status.prepend(dot);
  // Which empty. A port no daemon has ever answered on gets the install note;
  // everything else — including a daemon that is down right now — keeps the
  // plain one. Strictly `=== false`: an older worker does not send the field.
  const empty = !state.connected && state.everConnected === false ? renderFirstRun(port) : renderEmpty();
  // `now` and `graceMs` are the ledge's: how much of the free-Undo window each
  // green row has left. Without a `graceMs` — a daemon too old to say — the
  // rows are still there and still free to take back; only the bar is not.
  // Parsed apart from the page and checked before it is live (`markup.ts`),
  // never assigned to innerHTML as a string.
  setMarkup(document.getElementById("walks")!,
    state.walks.map(w => renderWalk(w, { drafts, refused, confirming, ticks, now: Date.now(), graceMs: state.graceMs })).join("") || empty);
  // The pane's own version is the manifest's. chrome.runtime.getManifest is
  // WebExtension-standard (Firefox has it), not Chrome-only.
  const mine = chrome.runtime.getManifest().version;
  // The token notice outranks the version one: until the daemon lets the pane
  // in, nothing it might say about versions can be acted on.
  setMarkup(document.getElementById("notice")!, state.needsToken
    ? renderTokenNotice(port)
    : state.connected && versionsDiffer(state.daemonVersion, mine) ? renderVersionNotice(mine, state.daemonVersion!, port) : "");
  applyChoices(document, choices);
  syncVerdictButtons(document, drafts, choices);
  restoreFocus(document, focus);
}

/** "Seen" means the human looked at the pane, not that the pane redrew itself. */
function markSeen() {
  for (const w of state.walks) {
    const max = Math.max(0, ...w.items.map(i => i.seq));
    if (max > w.lastSeenSeq) void send({ t: "panel:seen", walk: w.walk.id, seq: max });
  }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") markSeen(); });
window.addEventListener("focus", markSeen);

chrome.runtime.onMessage.addListener(m => { if (m.t === "sw:state") { state = m.state; paint(); } });

document.addEventListener("input", e => {
  const t = e.target as HTMLTextAreaElement;
  if (!t.dataset.note) return;
  drafts.set(t.dataset.note, t.value);
  syncVerdictButtons(document, drafts, choices);
});

// Enter or a blur in the token field is a save, so the person never has to find
// the button; the button is there for the ones who look for one.
document.addEventListener("keydown", e => {
  if ((e as KeyboardEvent).key === "Enter" && (e.target as HTMLElement)?.id === "token") { e.preventDefault(); void saveToken(); }
});

document.addEventListener("change", e => {
  const t = e.target as HTMLInputElement;
  if (t.id === "token") { void saveToken(); return; }
  if (t.type === "radio" && t.name.startsWith("opt-")) choices.options.set(t.name.slice(4), t.value);
  if (t.type === "checkbox" && t.dataset.step !== undefined && t.dataset.for) {
    const arr = ticks.get(t.dataset.for) ?? [];
    arr[Number(t.dataset.step)] = t.checked;
    ticks.set(t.dataset.for, arr);
  }
  syncVerdictButtons(document, drafts, choices);
});

/** How long the button says Copied before it goes back to being a button. */
const COPIED_MS = 2000;

/**
 * Put a secret on the clipboard, and say so.
 *
 * The value is read out of the worker's copy of the walk — which came off the
 * daemon's stream and lives only in memory — never out of the DOM, which has
 * only the label and a run of dots. Nothing is auto-cleared afterwards:
 * emptying the clipboard means reading it first, which costs the
 * `clipboardRead` permission and a store-listing change for a guess about
 * whether the person is done pasting. The line under the row says what they
 * are now holding instead.
 */
async function copySecret(b: HTMLButtonElement) {
  const id = b.dataset.copy!;
  const n = Number(b.dataset.secret);
  const item = state.walks.flatMap(w => w.items).find(i => i.id === id) as { secrets?: { value?: string }[] } | undefined;
  const value = item?.secrets?.[n]?.value;
  // A daemon that restarted has the labels off disk and no values: the button
  // is there but there is nothing behind it, and a "Copied" that copied
  // nothing is the thing this feature exists to stop.
  if (value === undefined) return;
  if (!(await putOnClipboard(b, value))) return;
  const row = b.closest(".secret");
  if (row && !row.querySelector(".copied-note")) {
    const note = document.createElement("p");
    note.className = "copied-note";
    note.textContent = COPIED_NOTE;
    row.append(note);
  }
}

/** Write `value`, and let the button say so for a moment. False if the clipboard refused. */
async function putOnClipboard(b: HTMLButtonElement, value: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(value); } catch { return false; }
  b.textContent = COPIED_LABEL;
  setTimeout(() => { if (b.isConnected) b.textContent = COPY_LABEL; }, COPIED_MS);
  return true;
}

document.addEventListener("click", async e => {
  const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (!b) return;
  if (b.id === "settings") { const p = document.getElementById("prefs")!; p.hidden = !p.hidden; return; }
  if (b.id === "token-save") { await saveToken(); return; }
  if (b.id === "scale-down") { stepScale(-1); return; }
  if (b.id === "scale-up") { stepScale(1); return; }
  const shot = SHOT_BUTTONS.find(([id]) => id === b.id);
  if (shot) { setShots(shot[1]); return; }
  // A command in a note: public text, copied from the attribute it is in.
  if (b.dataset.copyText !== undefined) { await putOnClipboard(b, b.dataset.copyText); return; }
  if (b.dataset.copy !== undefined) { await copySecret(b); return; }
  const undoId = b.dataset.undo ?? b.dataset.undoConfirm ?? b.dataset.undoCancel ?? b.dataset.undoNow;
  const view = state.walks.find(w => w.items.some(i => i.id === (b.dataset.go ?? b.dataset.for ?? undoId)));
  const walk = view?.walk.id;
  if (!walk || !view) return;
  if (b.dataset.undo) { confirming.add(b.dataset.undo); paint(); return; }
  if (b.dataset.undoCancel) { confirming.delete(b.dataset.undoCancel); paint(); return; }
  // Two ways in, one verdict out: the free Undo (the agent has not read the
  // answer; one click) and the confirmed one (it has; the agent is told to
  // unwind). Which one a card shows is the renderer's call, from `delivered`.
  const taking = b.dataset.undoConfirm ?? b.dataset.undoNow;
  if (taking) {
    const id = taking;
    const taken = [...view.verdicts].reverse().find(v => v.itemId === id && v.kind !== "blocked" && v.kind !== "undo");
    confirming.delete(id);
    // Everything this pane remembers is settled before the worker is told,
    // because telling it paints: `submit` broadcasts while this await is still
    // running, and the repaint reads these maps. Their words, their option and
    // their ticks come back onto the card: a take-back is a correction, not a
    // restart.
    if (taken?.text) drafts.set(id, taken.text); else drafts.delete(id);
    if (taken?.option) choices.options.set(id, taken.option);
    if (taken?.steps) ticks.set(id, [...taken.steps]);
    await send({ t: "panel:submit", walk, verdict: { itemId: id, kind: "undo", text: "", option: taken?.option, steps: taken?.steps } });
    return;
  }
  if (b.dataset.go) {
    sayGo(null);                                         // the last press's line is not this press's
    sayGo(await send<GoResult>({ t: "panel:go", walk, itemId: b.dataset.go }));
    return;
  }
  const id = b.dataset.for!;
  const kind = b.dataset.kind as VerdictDraft["kind"];
  const option = choices.options.get(id);
  if (kind === "decision" && !option) return;
  // Verbatim but for the trailing newline (the repo's rule); the emptiness test
  // ignores whitespace, so a box of spaces does not pass for a finding.
  const text = (drafts.get(id) ?? "").replace(/\n$/, "");
  if (needsText(kind, option) && !text.trim()) return;
  // Cleared before the worker is told, for the same reason as the undo above:
  // the repaint the submit sets off happens during this await. An `ask` leaves
  // the card answerable, so clearing after it left their question sitting in a
  // note box the pane had already forgotten — and Issue looking alive over an
  // empty draft, which is the dead button 0.1.1 went out to end.
  // A sequence's verdict carries one flag per step, in step order, whatever
  // was ticked — a sparse map entry becomes a full list here.
  const item = view.items.find(i => i.id === id);
  const steps = item?.kind === "sequence" ? item.steps.map((_, n) => Boolean(ticks.get(id)?.[n])) : undefined;
  drafts.delete(id);
  choices.options.delete(id);
  ticks.delete(id);
  // Nothing scrolls. An Ask leaves the card open where it is; every other
  // verdict takes it out of the list and onto the ledge, so what was under it
  // slides up into its place and the person is left where they were standing.
  await send({ t: "panel:submit", walk, verdict: { itemId: id, kind, text, option, steps } });
});

send<SwState>({ t: "panel:hello" })
  .then(s => {
    if (!s || !Array.isArray(s.walks)) return;    // the worker answered with an error
    state = s;
    paint();
    markSeen();                                    // the pane only loads because the human opened it
  })
  .catch(() => {});
