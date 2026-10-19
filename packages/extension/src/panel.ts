import type { ConnectAnswer, GoResult, SwState, SwToPanel, PanelToSw, TokenAnswer, TokenCheck, VerdictDraft } from "./protocol.js";
import { NO_ACCESS_SAID, badSelectorLine } from "./expect.js";
import { COPIED_LABEL, COPIED_NOTE, COPY_LABEL, SECRET_DOTS, TOKEN_PLACEHOLDER, TOKEN_STORED_DESC, applyChoices, drainPercent, needsText, needsTokenLine, receiptSay, renderEmpty, renderFirstRun, renderTokenHow, renderTokenNotice, renderVersionNotice, renderWalk, restoreFocus, snapshotFocus, syncVerdictButtons, tokenSay, type Choices, type Connecting } from "./render.js";
import { type Area, ASK_TIMEOUT_MS, NATIVE_PERMISSION, armConnect, askHost, canAskHere, freshRuntime, takeArmed } from "./native.js";
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
 * The daemon's token, the other way in: walkd writes it to a file and an
 * extension cannot read files (audit 2026-10-04, F1), so a person can carry it
 * across by hand. Kept beside the port in `chrome.storage.local`, where the
 * worker reads it; saving it is what makes the worker retarget and try again.
 *
 * **The field never holds the stored token.** It used to be filled once at
 * startup from storage, which put the credential in the DOM for the page's life
 * and — once Connect started storing tokens the panel had not typed — showed
 * whatever had been there at load, which for the owner was nothing. What it
 * shows now is a run of dots as its *placeholder* when the worker says one is
 * stored, so there is no value in the page to read, to leak into a screenshot,
 * or to go stale. Pasting over the dots is what replaces it.
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
 * How long the receipt stands. Two sentences is about three seconds of reading,
 * and the first thing a person does after connecting is usually close the gear
 * or press Go on a card that has just appeared — a line vanishing under a click
 * reads as the click having done it, so it goes before they get there.
 */
const RECEIPT_MS = 4000;
let receiptTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Say that walkd has let the pane in, in the place the eye already is.
 *
 * Put into a persistent element rather than a new one: `role="status"` is read
 * out when the contents of a live region change, and an element created with its
 * text in it is not reliably announced. Same reason `#said` is in the page.
 */
function sayReceipt(how: "host" | "paste") {
  const el = document.getElementById("receipt");
  if (!el) return;
  const { word, text } = receiptSay(how);
  const b = document.createElement("b");
  b.textContent = word;
  el.replaceChildren(b, document.createTextNode(` ${text}`));
  el.hidden = false;
  clearTimeout(receiptTimer);
  receiptTimer = setTimeout(hideReceipt, RECEIPT_MS);
}

/** Take it away: at four seconds, or the moment the daemon refuses the pane again. */
function hideReceipt() {
  clearTimeout(receiptTimer);
  receiptTimer = undefined;
  const el = document.getElementById("receipt");
  if (!el) return;
  el.hidden = true;
  el.replaceChildren();
}

/**
 * The third door: a token the worker fetched with nobody pressing anything.
 *
 * `sw:connected` is the worker saying it went to walkd's host by itself and the
 * daemon let the pane in on what came back (`sw.ts` `sayAdopted`). It is not an
 * answer to anything this pane asked, so there is nothing to paint — only the
 * receipt, and that waits for the paint that carries the state behind it: a
 * `paint()` reading `needsToken` calls `hideReceipt`, and would take this away
 * in the same breath as putting it up. The same ordering `paintConnect` keeps,
 * for the same reason.
 *
 * Spent on the first paint after it either way, so one adoption is one receipt:
 * a daemon that went away between the worker's refresh and this message leaves
 * nothing behind to be handed to the paste that connects later.
 */
let adopted: "host" | undefined;

/** Is the pane in, as the last state the worker sent says? */
const paneIsIn = () => state.connected && state.needsToken !== true;

function sayAdopted() {
  const how = adopted;
  adopted = undefined;
  if (how && paneIsIn()) sayReceipt(how);
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
  // The same receipt as the host door, because it is the same event: walkd has
  // let the pane in. The gear's own line stays too — that one is the verdict on
  // this paste, and it is what the person was waiting on.
  if (answer.check === "connected") {
    // The token has done its job and leaves the page: the field goes back to
    // dots, which is the broadcast's answer a moment later anyway, and nothing
    // of the credential is left in the DOM to be read or photographed.
    field.value = "";
    field.placeholder = SECRET_DOTS;
    field.dataset.stored = "1";
    field.setAttribute("aria-describedby", "token-stored");
    sayReceipt("paste");
  }
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
 * Open the gear, and put the cursor in the token field when that is what was
 * asked for.
 *
 * The gear does not open itself on a refusal any more. Connect is the first door
 * now, and pre-opening the second one left it standing open over the receipt
 * when the press worked. It opens on *Paste the token instead*, which is
 * somebody asking for the field, and after a press that did not work, which is
 * the pane offering the form rather than making them find it. A press that is
 * still going, or one that worked, leaves it exactly as they had it.
 */
function openGear(focusField: boolean) {
  document.getElementById("prefs")!.hidden = false;
  if (!focusField) return;
  const field = tokenField();
  field?.focus();
}

/**
 * What the Connect button is in the middle of, or what came of the last press.
 *
 * Panel-local, like the drafts and the ticks, and for the same reason: the
 * notice is rebuilt from scratch on every repaint, and a broadcast lands every
 * time the worker refreshes. Without this the line a press put up would vanish
 * under the next one.
 */
let connecting: Connecting | undefined;

/**
 * Where the press's one piece of state lives across the reload below:
 * `storage.session` where there is one, so it cannot outlive the browser, and
 * `storage.local` otherwise. The flag carries its own age either way.
 */
function flagArea(): Area {
  const area = (chrome.storage as { session?: chrome.storage.StorageArea }).session ?? chrome.storage.local;
  return { get: k => area.get(k), set: items => area.set(items), remove: k => area.remove(k) };
}

/**
 * Connect, pressed.
 *
 * The permission request is made by the caller, synchronously inside the click
 * handler, and its promise is handed here: both browsers refuse
 * `permissions.request` outside a user action, and Firefox says so in as many
 * words. Everything after it is ordinary async work.
 *
 * Then the awkward fact, measured in the owner's own Chrome on 2026-10-18 on
 * the real store build: the browser gives the new API only to contexts created
 * **after** the grant. `permissions.contains` says true everywhere, and
 * `sendNativeMessage` is still undefined in the worker and in this very page —
 * the one that drew the button — while a side panel closed and opened again has
 * it and reaches the host first time. No delay fixes a context that already
 * exists.
 *
 * So this page makes a context of its own: a hidden frame on an empty page of
 * ours, whose `chrome.runtime` is built from the permissions as they are now,
 * and which this page may call through because the two are same-origin
 * (`native.ts` `freshRuntime`). Nothing is drawn and nothing on the pane moves —
 * no reload, so the drafts, the ticks, the scroll, the gear and the text size
 * all stay where they were. Firefox hands the API to the page that is already
 * open, so it never comes this way at all.
 *
 * Only if that frame comes back without the method is the pane reloaded, which
 * is the honest finish on a browser that behaves differently from the one
 * measured: a note of what the press was about, and the load that follows picks
 * it up.
 */
async function pressConnect(asking: Promise<boolean>) {
  connecting = "asking";
  paint();
  let granted = false;
  try { granted = (await asking) === true; } catch { granted = false; }
  if (!granted) { connecting = "refused"; paint(); offerTheForm(); return; }
  const port = state.port ?? DEFAULT_PORT;
  if (canAskHere()) { paintConnect(await connectThrough(port)); return; }
  const fresh = await freshRuntime(document).catch(() => null);
  if (fresh) {
    // Which half asked is the first thing the field console should say.
    console.warn("sidewalk: this panel is older than the grant; asked walkd's host through a fresh frame");
    // The frame stays until the answer or the timeout: one removed mid-call
    // leaves this await hanging for good (measured).
    try { paintConnect(await connectThrough(port, fresh.runtime)); }
    finally { fresh.drop(); }
    return;
  }
  // Not being able to remember it is not a reason to refuse to reload: the
  // worst a lost flag costs is one more press, on a page that can then ask.
  await armConnect(flagArea(), port).catch(() => {});
  location.reload();
}

/**
 * The worker first, this page second.
 *
 * The worker is where a token is stored, so it is asked first and it is the
 * half that talks to walkd about it. What it cannot always do is reach the host:
 * in Chrome a worker that was running when the permission was granted never
 * gets the API, and it says `noApi` instead of pretending the host is missing.
 * Then the ask happens here instead, through `runtime` — this page's own when it
 * has the method, and a hidden frame's when it does not — and what the host
 * gives goes back to the worker to store by its own rules.
 *
 * The worker is still asked first on the frame path, and that is not waste: a
 * profile whose worker has restarted since the grant has the method there, and
 * then none of the rest of this runs.
 */
async function connectThrough(port: number, runtime = chrome.runtime): Promise<ConnectAnswer | undefined> {
  const first = await send<ConnectAnswer | undefined>({ t: "panel:connect" }).catch(() => undefined);
  if (first && first.end !== "noApi") return first;
  if (first?.reason) console.warn(`sidewalk: the worker cannot reach walkd's host (${first.reason})`);
  const r = await askHost(port, ASK_TIMEOUT_MS, runtime);
  if (!r.ok) {
    console.warn(`sidewalk: this panel could not reach walkd's host either (${r.reason}${r.said ? `: ${r.said}` : ""})`);
    return { end: "noHost", port, reason: r.reason };
  }
  return send<ConnectAnswer | undefined>({ t: "panel:connect", asked: { port: r.port, token: r.token } }).catch(() => undefined);
}

/**
 * The two ends that leave the person a form to fill: open it for them.
 *
 * Called once per press — from the refusal above and from `paintConnect` below,
 * which is every other end — and never from `paint()`, because a repaint must
 * not fight somebody who has closed the gear again. The focus stays on Connect,
 * which may still be the thing that works: a manifest that lands a moment
 * later, or a browser they want to try once more. The `stale` end does not open
 * it, because a paste of the token walkd is already refusing is no way out.
 */
function offerTheForm() {
  if (connecting === "refused" || connecting === "failed") openGear(false);
}

/** The one line a press earns, and the word behind it for whoever is looking. */
function paintConnect(answer: ConnectAnswer | undefined) {
  // The reason never reaches the pane: four of the likeliest mistakes report
  // the same sentence to the browser, so there is one line per end and the word
  // behind it goes to the console.
  if (answer?.reason) console.warn(`sidewalk: Connect ended in ${answer.end} (${answer.reason})`);
  if (!answer) console.warn("sidewalk: the worker did not answer the Connect press");
  // `connected` and `nothingToSay` leave the connection line to speak for
  // itself — in the first it has just turned green, and in the second nothing
  // the press did is worth a line. A worker that never answered is the same
  // dead end as a host that did not.
  connecting = !answer ? "failed" : answer.end === "refusedToken" ? "stale" : answer.end === "noHost" ? "failed" : undefined;
  paint();
  offerTheForm();
  // After the paint, not before it: `connected` here is the daemon's own verdict
  // (`sw.ts` `verdict`), and the state this pane is painting from may not have
  // caught up with it yet — a paint that still reads `needsToken` would take the
  // receipt away in the same breath as putting it up.
  if (answer?.end === "connected") sayReceipt("host");
}

/**
 * The second half of a press that needed a reload to get the API.
 *
 * Read once and cleared, and only acted on while it is fresh, so a flag left by
 * a press that never finished cannot make a panel opened tomorrow ask the host
 * out of nowhere.
 */
(async () => {
  const armed = await takeArmed(flagArea()).catch(() => null);
  if (!armed) return;
  connecting = "asking";
  paint();
  paintConnect(await connectThrough(armed.port));
})();


/**
 * The gear's first row while walkd is refusing: the command that prints a token,
 * with its Copy button, directly above the field it feeds. Built once — it never
 * changes — and shown or hidden by `paint()` from the one state that governs it.
 */
setMarkup(document.getElementById("token-how")!, renderTokenHow());
(() => {
  const el = document.getElementById("token-stored");
  if (el) el.textContent = TOKEN_STORED_DESC;
})();

/**
 * The field, as the worker says the token stands: a run of dots for one that is
 * stored and `paste it here` for none, in the placeholder either way, so the
 * page holds no credential. `aria-describedby` points at a hidden sentence
 * rather than at twelve bullets, which is what a screen reader can use.
 */
function paintTokenField() {
  const field = tokenField();
  if (!field) return;
  const stored = state.hasToken === true;
  field.placeholder = stored ? SECRET_DOTS : TOKEN_PLACEHOLDER;
  if (stored) {
    field.dataset.stored = "1";
    field.setAttribute("aria-describedby", "token-stored");
  } else {
    delete field.dataset.stored;
    field.removeAttribute("aria-describedby");
  }
}

function paint() {
  const focus = snapshotFocus(document);
  dropStaleTokenSay();
  // The command belongs with the field, and only while there is a reason for it:
  // once walkd has let the pane in, nobody needs to be told how to get a token.
  document.getElementById("token-how")!.hidden = !state.needsToken;
  paintTokenField();
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
  // The notice is gone the moment the daemon lets the pane in, and so is
  // whatever the Connect button was saying: a press that worked has the
  // connection line to speak for it, and a press that did not has nothing left
  // to be about.
  //
  // Strictly `=== false`, which is the worker having said so. The pane paints
  // once before any worker has answered — `needsToken` absent — and that paint
  // must not take the line off a press this panel is in the middle of, which is
  // exactly where a reloaded panel starts.
  if (state.needsToken === false) connecting = undefined;
  // A receipt standing over a pane the daemon has gone back to refusing — one
  // `walkd token --rotate` is enough — is the same lie as the "Saved" the gear's
  // check went out to end.
  if (state.needsToken) hideReceipt();
  // The token notice outranks the version one: until the daemon lets the pane
  // in, nothing it might say about versions can be acted on.
  setMarkup(document.getElementById("notice")!, state.needsToken
    ? renderTokenNotice(port, connecting)
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

chrome.runtime.onMessage.addListener((m: SwToPanel) => {
  if (m.t === "sw:state") { state = m.state; paint(); sayAdopted(); return; }
  // The hands-free door. The broadcast that carries the connected state is
  // usually here first — the worker sends it before this — and then the paint it
  // caused is already the one the receipt was waiting for; when it is the other
  // way round, the next paint picks it up.
  if (m.t === "sw:connected") { adopted = m.how; if (paneIsIn()) sayAdopted(); }
});

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
  // First in the handler, and nothing is awaited before it: a permission
  // request outside a user action is refused, and one after an `await` has
  // already left the gesture behind. (The same rule as `firefox.js` §2, which
  // has the sidebar open for exactly this reason.)
  if (b.dataset.connect !== undefined) {
    let asking: Promise<boolean>;
    // A browser with no `chrome.permissions`, or one that refuses the name
    // outright, answers here and not from inside the promise.
    try { asking = Promise.resolve(chrome.permissions.request({ permissions: [NATIVE_PERMISSION] })).then(g => g === true); }
    catch (err) { console.warn("sidewalk: this browser would not be asked for the permission", err); asking = Promise.resolve(false); }
    void pressConnect(asking);
    return;
  }
  // *Paste the token instead*: the other door, and the only thing on the pane
  // that asks for the field by name — so it opens the gear and goes there.
  if (b.dataset.paste !== undefined) { openGear(true); return; }
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
    sayAdopted();                                  // an adoption that landed while this was in flight
    markSeen();                                    // the pane only loads because the human opened it
  })
  .catch(() => {});
