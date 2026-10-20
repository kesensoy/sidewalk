import { test, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readToken } from "sidewalk-walkd";

const EXT = path.resolve(import.meta.dirname, "../packages/extension/dist");
const WALKD = path.resolve(import.meta.dirname, "../packages/walkd/bin/walkd.js");
// 8761, not 8760. The extension reads its daemon's port out of
// `chrome.storage.local` under `walkd:port`, which beforeAll sets before any
// panel opens — so this suite runs beside the walkd you are using rather than
// asking you to stop it. The fixture site is on 9342 for the same reason.
const PORT = 8761;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE = "http://127.0.0.1:9342";

let ctx: BrowserContext;
let daemon: ChildProcess;
let extId: string;
let dataDir: string;
/**
 * This run's daemon token (secrets review). Read after every start and
 * pushed into the pane's storage — the paste a person does in the gear, done
 * for them. Since 2026-10-06 the daemon keeps its token across a restart, so
 * the restarts below get the same string back and the push is a no-op; it stays
 * because what this suite needs is a pane holding whatever the daemon is
 * serving, and that is the line that guarantees it either way.
 */
let token = "";
const auth = () => ({ authorization: `Bearer ${token}` });

async function startDaemon(env: Record<string, string> = {}) {
  // `--grace-ms 0`: the suite reads as the agent the instant a verdict lands;
  // the real daemon serves with a 10 s window (the person's free-Undo time).
  // process.execPath, never "node": on a machine whose `node` on PATH is a
  // shim (Nodist, and nvm-for-Windows does the same), spawning the name gets
  // the shim and the daemon is its *grand*child — so kill() stopped the shim,
  // the daemon kept the port, and the two restart tests waited out their
  // timeouts. This is also what sidewalk-mcp's client.ts spawns.
  // `env` is for the one test that needs a daemon of another release:
  // WALKD_ADVERTISE_VERSION, which nothing outside this suite ever sets.
  // `--no-copy`: a daemon that mints a token puts it on the clipboard, and a
  // test run must never clobber the person's.
  // `WALKD_NATIVE_ROOT`: a daemon start also writes native messaging manifests
  // into the browser profiles under the home directory, and this suite's
  // browser is a throwaway profile Playwright made. So the manifests go under
  // this run's own data directory, where nothing reads them and the run takes
  // them away with it.
  const child = spawn(process.execPath, [WALKD, "serve", "--port", String(PORT), "--data-dir", dataDir, "--state-dir", path.join(dataDir, "state"), "--grace-ms", "0", "--no-copy"], { stdio: "inherit", env: { ...process.env, WALKD_NATIVE_ROOT: path.join(dataDir, "native-root"), ...env } });
  await waitFor("answered /health", true);
  // The token is written before the daemon listens, so it is there now. The pane
  // is told as soon as there is a browser to tell: a restart leaves it holding
  // the old daemon's token, which is exactly the needs-token state, and the
  // storage write is what retargets it.
  token = await readToken(dataDir);
  if (ctx) await (await worker()).evaluate(([p, t]) => chrome.storage.local.set({ "walkd:port": p, "walkd:token": t }), [PORT, token] as [number, string]);
  return child;
}

/** Is anything answering as a walkd on this run's port? */
async function healthy(): Promise<boolean> {
  try { return ((await (await fetch(`${BASE}/health`)).json()) as { ok?: boolean }).ok === true; } catch { return false; }
}

async function waitFor(what: string, want: boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await healthy()) === want) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`walkd on ${PORT} never ${what}`);
}

/** The extension's worker, re-read rather than held: Chrome may replace it. */
async function worker(): Promise<Worker> {
  const live = () => ctx.serviceWorkers().find(w => w.url().startsWith("chrome-extension://"));
  return live() ?? (await ctx.waitForEvent("serviceworker"));
}

test.beforeAll(async () => {
  // This suite owns 8761 for its run; it never touches 8760.
  if (await healthy()) throw new Error(`port ${PORT} busy — something is already serving ${BASE}`);

  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-e2e-"));
  daemon = await startDaemon();

  ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--remote-debugging-port=9341"],
  });
  // The Copy button on a secret writes to the clipboard and one test reads it
  // back. Granted for every origin, because the pane is a `chrome-extension://`
  // page and there is no site origin to name.
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const sw = await worker();
  extId = sw.url().split("/")[2];
  // The worker's own console, printed only when a test fails: the launch-time
  // flake (first test, header never shows) has no other witness.
  sw.on("console", m => swLog.push(`${new Date().toISOString()} [sw:${m.type()}] ${m.text()}`));

  // Point the extension at this run's daemon, before a panel is ever opened.
  await sw.evaluate(([port, tok]) => chrome.storage.local.set({ "walkd:port": port, "walkd:token": tok }), [PORT, token] as [number, string]);
  await expect
    .poll(async () => (await sw.evaluate(() => chrome.storage.local.get("walkd:port")))["walkd:port"], { timeout: 10_000 })
    .toBe(PORT);
});

test.afterAll(async () => {
  await ctx?.close();
  daemon?.kill("SIGTERM");
  // The walk's data dir is this run's alone — streams, shots and the state
  // file — and nothing reads it after the run. Leaving it behind is a temp dir
  // per e2e, forever.
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

const post = (p: string, b: unknown) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...auth() }, body: JSON.stringify(b) });
const addItems = (walk: string, items: unknown[]) => post(`/walks/${walk}/items`, { items });
// `viewer=1`: the suite reads the way the pane does, which hands nothing to an
// agent and so never moves the walk's `delivered` mark. Agent reads in a test
// go through /wait on purpose.
const read = async (walk: string) => (await (await fetch(`${BASE}/walks/${walk}?viewer=1`, { headers: auth() })).json()) as { walk: { closedAt?: string }; items: any[]; verdicts: any[] };
const agentWait = async (walk: string, after: number) => (await (await fetch(`${BASE}/walks/${walk}/wait?after=${after}&timeoutMs=0`, { headers: auth() })).json()) as { verdicts: any[]; cursor: number };
const verdicts = async (walk: string) => (await read(walk)).verdicts;
const countOf = (walk: string, kind?: string) => verdicts(walk).then(v => (kind ? v.filter(x => x.kind === kind) : v).length);

/**
 * Walks this test opened, closed again when it ends.
 *
 * Tidiness now, and it used to be more: the worker held an SSE stream per open
 * walk against the six connections Chrome gives one origin, so a suite that
 * left every walk open stopped the worker's health checks and verdict posts
 * dead behind its own streams partway through. One multiplexed stream ended
 * that — the test below opens eight walks at once on purpose. Closing is still
 * what keeps each test's pane its own rather than every earlier test's cards.
 */
const opened: string[] = [];
const swLog: string[] = [];

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) console.log(`--- service worker console (${swLog.length} lines) ---\n${swLog.join("\n")}\n---`);
  swLog.length = 0;
});

async function openWalk(walk: string) {
  const r = await post("/walks", { project: "e2e", id: walk, title: `Walk ${walk}`, buildRef: "fix-001" });
  expect(r.status, `opening ${walk}`).toBe(200);
  opened.push(walk);
}

test.afterEach(async () => {
  for (const w of opened.splice(0)) await post(`/walks/${w}/close`, { summary: "e2e" }).catch(() => {});
});

const lookItem = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: "look", owner: "e2e", title: `Look ${id}`, url: `${SITE}/other.html`,
  do: "do", see: "see", pass: "pass", ...extra,
});

/**
 * Playwright discards the worker after a failing test, which re-runs beforeAll
 * against a fresh browser and a fresh data dir — so no test may inherit the
 * previous one's walk or its tabs. Each opens its own walk, and finds the site
 * tab and the panel tab if they are already there.
 */
async function setup(walk: string): Promise<{ site: Page; panel: Page }> {
  await openWalk(walk);
  let site = ctx.pages().find(p => p.url().startsWith(SITE));
  if (!site) site = await ctx.newPage();
  // Always from a known page: the console ring a verdict carries belongs to the
  // load it was collected on, so a test must not inherit the last one's.
  await site.goto(`${SITE}/other.html`);
  let panel = ctx.pages().find(p => p.url().startsWith("chrome-extension://"));
  if (!panel) {
    panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/panel.html`);
  }
  await site.bringToFront();
  await showWalk(panel, walk);
  return { site, panel };
}

/**
 * Wait for a just-opened walk to reach the pane.
 *
 * A new walk announces itself now — the daemon puts an `open` frame on the one
 * stream and the worker refreshes on it — but a pane that was not connected
 * when that happened still learns of the walk only by asking `/walks`, which it
 * does when it says hello and every 30 s after. Saying hello is what the pane
 * itself does when it loads, so this asks the same question rather than
 * depending on which of the two got there first.
 */
async function showWalk(panel: Page, walk: string) {
  await panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
  await expect(panel.locator(`header[data-walk-id="${walk}"]`)).toHaveCount(1, { timeout: 15_000 });
}

/** The panel is a tab here, not a docked pane; a click on it must not steal the
 *  active tab from the site the worker is meant to be looking at. */
async function clickInPanel(panel: Page, site: Page, selector: string) {
  await panel.locator(selector).click();
  await site.bringToFront();
}

test("item appears via SSE, Go navigates + highlights, verdict lands with screenshot and console", async () => {
  const { site, panel } = await setup("w-look");

  await addItems("w-look", [{
    id: "rim", kind: "look", owner: "e2e", title: "Rim marks", url: `${SITE}/`,
    target: { walkId: "rim" }, do: "look", see: "marks", pass: "visible",
    expect: [{ kind: "text", css: "meta[name=build]", attr: "content", equals: "fix-001" }, { kind: "present", css: "[data-walk=rim]" }],
  }]);
  await expect(panel.locator('[data-item="rim"]')).toBeVisible({ timeout: 10_000 });

  await clickInPanel(panel, site, '[data-go="rim"]');
  // The card whose Go was pressed is the current one, until it is answered.
  await expect(panel.locator('[data-item="rim"].current')).toHaveCount(1, { timeout: 10_000 });
  await expect(panel.locator("#status .dot.on")).toHaveCount(1);
  await expect.poll(() => site.url(), { timeout: 20_000 }).toBe(`${SITE}/`);
  await expect.poll(() => site.locator("[data-walk=rim]").evaluate(el => (el as HTMLElement).style.outline), { timeout: 20_000 }).toContain("solid");

  // The console tail below only exists because main.js and content.js were in
  // place at document_start; this says so out loud rather than by implication.
  const scripts = (await (await worker()).evaluate(() => chrome.scripting.getRegisteredContentScripts())).filter((s: any) => s.id.endsWith("w-look"));
  expect(scripts.map((s: any) => s.id).sort()).toEqual(["walkd-iso-w-look", "walkd-main-w-look"]);
  // The walk's own origin, port included: a pattern that names a port matches
  // that port alone (src/origin.ts), so this registration reaches the fixture
  // site and nothing else of the person's on 127.0.0.1.
  for (const s of scripts) expect(s.matches).toEqual([`http://127.0.0.1:9342/*`]);

  await panel.locator('[data-note="rim"]').fill("seam has a hairline");
  await clickInPanel(panel, site, '[data-kind="issue"][data-for="rim"]');
  await expect.poll(() => countOf("w-look"), { timeout: 20_000 }).toBe(1);

  const v = (await verdicts("w-look"))[0];
  expect(v.text).toBe("seam has a hairline");
  expect(v.context.buildId).toBe("fix-001");
  expect(v.context.console.some((c: any) => c.text.includes("deliberate error"))).toBe(true);

  // Spec §2.4: a verdict carries the picture. `<all_urls>` is a required host
  // permission now, so captureVisibleTab answers with no grant to wait for and
  // no toolbar click to stand in for one — the picture is the contract, not one
  // of two branches.
  expect(v.context.screenshot).toBe("shots/000001.jpg");
  expect((await fs.stat(path.join(dataDir, "e2e", "w-look", "shots", "000001.jpg"))).size).toBeGreaterThan(1000);
});

test("a capture wider than the cap is downscaled and still attaches", async () => {
  // The owner's first walk-11 verdict: Retina viewport, screenshotError "Maximum
  // call stack size exceeded", screenshot null. Every earlier capture had been
  // narrower than 1568 and passed through un-re-encoded; this one is not.
  const { site, panel } = await setup("w-wide");
  await site.setViewportSize({ width: 2400, height: 900 });
  await addItems("w-wide", [lookItem("wide")]);
  await expect(panel.locator('[data-item="wide"]')).toBeVisible({ timeout: 10_000 });
  await clickInPanel(panel, site, '[data-kind="pass"][data-for="wide"]');
  await expect.poll(() => countOf("w-wide"), { timeout: 20_000 }).toBe(1);
  const v = (await verdicts("w-wide"))[0];
  expect(v.context.screenshotError).toBeUndefined();
  expect(v.context.screenshot).toBe("shots/000001.jpg");
  const jpg = await fs.readFile(path.join(dataDir, "e2e", "w-wide", "shots", "000001.jpg"));
  expect(jpg.length).toBeGreaterThan(1000);
  // JPEG SOF0/SOF2 marker carries height then width; the width must be the cap.
  let i = 2, width = 0;
  while (i < jpg.length) {
    if (jpg[i] !== 0xff) { i++; continue; }
    const m = jpg[i + 1];
    if (m === 0xc0 || m === 0xc2) { width = jpg.readUInt16BE(i + 7); break; }
    i += 2 + jpg.readUInt16BE(i + 2);
  }
  expect(width).toBe(1568);
  await site.setViewportSize({ width: 1126, height: 738 });
});

test("the gear's text size steps, sticks across a reload, and steps back", async () => {
  const { site, panel } = await setup("w-settings");
  const scale = () => panel.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--scale").trim());

  await expect(panel.locator("#prefs")).toBeHidden();
  await clickInPanel(panel, site, "#settings");
  await expect(panel.locator("#prefs")).toBeVisible();
  expect(await scale()).toBe("1");

  await clickInPanel(panel, site, "#scale-up");
  await clickInPanel(panel, site, "#scale-up");
  await expect.poll(scale).toBe("1.25");
  await expect(panel.locator("#scale")).toHaveText("125%");

  // Per viewer, in chrome.storage.local — so it survives the page, not just the
  // paint. A reload is the only honest way to ask that.
  await panel.reload();
  await expect.poll(scale, { timeout: 15_000 }).toBe("1.25");
  await expect(panel.locator("#scale")).toHaveText("125%");

  // And the rung is on before anybody sees the pane at all. The stored scale is
  // an async read, so a pane that painted first resized a frame later — every
  // line of it, on every open. A page of its own with a recorder installed
  // before anything on it runs, because the one moment this is about is over
  // for the pane above: the body is hidden while the document is still booting,
  // and the frame it is shown on is already at 125 %.
  const probe = await ctx.newPage();
  await probe.addInitScript(() => {
    type Frame = { at: string; vis: string; scale: string; booting: boolean };
    const w = window as unknown as { __boot: Frame[] };
    w.__boot = [];
    const note = (at: string) => w.__boot.push({
      at,
      vis: document.body ? getComputedStyle(document.body).visibility : "no body",
      scale: getComputedStyle(document.documentElement).getPropertyValue("--scale").trim(),
      booting: document.documentElement.classList.contains("booting"),
    });
    // From `DOMContentLoaded`, not from here: this runs before the document has
    // a root element to watch, and the pane is still booting at that point —
    // the rung comes out of storage, which is a round trip away.
    document.addEventListener("DOMContentLoaded", () => {
      note("parsed");
      const root = document.documentElement;
      const shown = () => { if (!root.classList.contains("booting")) note("shown"); };
      new MutationObserver(shown).observe(root, { attributes: true, attributeFilter: ["class"] });
      shown();
    });
  });
  await probe.goto(`chrome-extension://${extId}/panel.html`);
  const boot = () => probe.evaluate(() => (window as unknown as { __boot: { at: string; vis: string; scale: string; booting: boolean }[] }).__boot);
  await expect.poll(async () => (await boot()).map(f => f.at), { timeout: 15_000 }).toEqual(["parsed", "shown"]);
  const frames = await boot();
  expect(frames[0].vis, "the pane is not drawn while it is still booting").toBe("hidden");
  expect(frames[0].booting).toBe(true);
  expect(frames[1].vis, "shown, and only once").toBe("visible");
  expect(frames[1].booting).toBe(false);
  expect(frames[1].scale, "the first paint anybody sees is at their own rung").toBe("1.25");
  console.log(`scale proof: the pane was ${frames[0].vis} while booting and ${frames[1].vis} at --scale ${frames[1].scale}, so nothing resized under the eye`);
  await probe.close();
  await site.bringToFront();

  await clickInPanel(panel, site, "#settings");
  await clickInPanel(panel, site, "#scale-down");
  await clickInPanel(panel, site, "#scale-down");
  await expect.poll(scale).toBe("1");
  await expect(panel.locator("#scale")).toHaveText("100%");
  await clickInPanel(panel, site, "#settings");
  await expect(panel.locator("#prefs")).toBeHidden();
});

/** The gear is a toggle, and the pane outlives a test — so ask, do not assume. */
async function openPrefs(panel: Page, site: Page) {
  if (await panel.locator("#prefs").isHidden()) await clickInPanel(panel, site, "#settings");
  await expect(panel.locator("#prefs")).toBeVisible();
}

test("a secret is dots and a Copy button: the value is nowhere in the pane, nowhere on disk, and on the clipboard once pressed", async () => {
  const { site, panel } = await setup("w-secret");
  const KEY = "sk-test-e2e-000000001";
  await addItems("w-secret", [lookItem("key", { secrets: [{ label: "Licence key", value: KEY }] })]);
  const card = panel.locator('[data-item="key"]');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.locator(".secret .name")).toHaveText("Licence key");
  await expect(card.locator(".secret .dots")).toHaveText("••••••••••••");

  // The whole point: the card says a value exists and never shows it, so a
  // picture of the pane never holds it. (The next verdict's screenshot is of
  // the site, and shows whatever the site shows after the paste — which is what
  // the line under the row now says.)
  expect(await panel.content()).not.toContain(KEY);
  // And the daemon kept it in memory only.
  expect(await fs.readFile(path.join(dataDir, "e2e", "w-secret", "items.jsonl"), "utf8")).not.toContain(KEY);

  const copy = card.locator('[data-copy="key"][data-secret="0"]');
  await panel.bringToFront();
  await copy.click();
  await expect(copy).toHaveText("Copied", { timeout: 2_000 });
  await expect(card.locator(".copied-note")).toHaveText(
    "On your clipboard — every app here can read it. If you paste it where it shows in plain text, the next verdict's screenshot will show it too.");
  expect(await panel.evaluate(() => navigator.clipboard.readText())).toBe(KEY);
  // Two seconds later it is a button again, and the line stays.
  await expect(copy).toHaveText("Copy", { timeout: 6_000 });
  await expect(card.locator(".copied-note")).toHaveCount(1);
  await site.bringToFront();
});

test("Issues only skips the capture on a Pass and says so, and still photographs an Issue", async () => {
  const { site, panel } = await setup("w-shots");
  await addItems("w-shots", [lookItem("p1"), lookItem("i1")]);
  await expect(panel.locator('[data-item="i1"]')).toBeVisible({ timeout: 10_000 });
  try {
    await openPrefs(panel, site);
    await clickInPanel(panel, site, "#shots-issues");
    await expect(panel.locator("#shots-issues")).toHaveClass(/\bon\b/);
    await expect(panel.locator("#shots-always")).not.toHaveClass(/\bon\b/);

    // A Pass is not an issue, so there is no picture — and the verdict says
    // which of the two reasons that is.
    await clickInPanel(panel, site, '[data-kind="pass"][data-for="p1"]');
    await expect.poll(() => countOf("w-shots"), { timeout: 20_000 }).toBe(1);
    const pass = (await verdicts("w-shots"))[0];
    expect(pass.context.screenshot).toBe(null);
    expect(pass.context.screenshotError).toBe("off: screenshots set to issues only");
    // The rest of the context is still collected: only the picture is off.
    expect(pass.context.url).toBe(`${SITE}/other.html`);

    await panel.locator('[data-note="i1"]').fill("the seam is open");
    await clickInPanel(panel, site, '[data-kind="issue"][data-for="i1"]');
    await expect.poll(() => countOf("w-shots"), { timeout: 20_000 }).toBe(2);
    const issue = (await verdicts("w-shots"))[1];
    expect(issue.context.screenshotError).toBeUndefined();
    expect(issue.context.screenshot).toBe("shots/000002.jpg");
    expect((await fs.stat(path.join(dataDir, "e2e", "w-shots", "shots", "000002.jpg"))).size).toBeGreaterThan(1000);

    await openPrefs(panel, site);
    await clickInPanel(panel, site, "#shots-always");
    await expect(panel.locator("#shots-always")).toHaveClass(/\bon\b/);
  } finally {
    // The pane and its storage outlive this test: a failure above must not
    // leave every later test walking with its screenshots turned down.
    await (await worker()).evaluate(() => chrome.storage.local.set({ "walkd:ui": { scale: 100, shots: "always" } }));
  }
});

test("a question that is only a title and options renders no sheet, and Submit waits for an answer", async () => {
  const { site, panel } = await setup("w-slim");
  await addItems("w-slim", [{
    id: "q-slim", kind: "question", owner: "e2e", title: "Keep the 30 second worst case?",
    options: ["Keep it", "Add a notification"],
  }]);
  const card = panel.locator('[data-item="q-slim"]');
  await expect(card).toBeVisible({ timeout: 10_000 });

  // No section was filled, so there is no sheet to render — not a card of blank
  // labels.
  await expect(card.locator("dl")).toHaveCount(0);
  await expect(card.locator(".options label").first()).toContainText("Keep it");
  await expect(card.locator(".options label").first().locator(".tag")).toHaveText("Recommended");
  await expect(card.locator(".options label").nth(1).locator(".tag")).toHaveCount(0);

  const submit = card.locator('button[data-kind="decision"]');
  await expect(submit).toBeDisabled();
  await clickInPanel(panel, site, '[data-item="q-slim"] input[value="Keep it"]');
  await expect(submit).toBeEnabled();

  // Other is not an answer until they have written what it is.
  await clickInPanel(panel, site, '[data-item="q-slim"] input[value="__other"]');
  await expect(submit).toBeDisabled();
  await panel.locator('[data-note="q-slim"]').fill("neither; cap it at ten");
  await expect(submit).toBeEnabled();
});

test("a decision collapses to one line; Keep files nothing and Undo hands the card back", async () => {
  const { site, panel } = await setup("w-undo");
  await addItems("w-undo", [{
    id: "q-undo", kind: "question", owner: "e2e", title: "Tier names", options: ["Solo / Team", "Pro / Team"],
  }]);
  const card = panel.locator('[data-item="q-undo"]');
  await expect(card).toBeVisible({ timeout: 10_000 });

  await clickInPanel(panel, site, '[data-item="q-undo"] input[value="Solo / Team"]');
  await clickInPanel(panel, site, '[data-item="q-undo"] button[data-kind="decision"]');
  await expect.poll(() => countOf("w-undo"), { timeout: 20_000 }).toBe(1);
  // Design v3: on a decision the option leads and the title trails, because at
  // 360 px the title would push the option — the whole answer — off the line.
  await expect(card.locator(".verdict")).toHaveText(/^Decided\s+Solo \/ Team\s+Tier names$/);

  // Unread by any agent, the Undo is the free one. An agent read makes it the
  // loud one, and that is the path under test here.
  await expect(card.locator('button.free[data-undo-now="q-undo"]')).toBeVisible();
  expect((await agentWait("w-undo", 0)).verdicts.map(v => v.seq)).toEqual([1]);
  // Undo is destructive outside the pane, so it asks inside the card first.
  await expect(card.locator('button.danger[data-undo="q-undo"]')).toBeVisible({ timeout: 10_000 });
  await clickInPanel(panel, site, '[data-item="q-undo"] button[data-undo="q-undo"]');
  await expect(card.locator(".confirm")).toBeVisible();
  await expect(card.locator("button[data-undo-confirm]")).toHaveText("Undo");
  await expect(card.locator("button[data-undo-cancel]")).toHaveText("Keep");

  // Keep: still decided, and nothing new in the record. That nothing was filed
  // is held shut by the count below being 2 rather than 3.
  await clickInPanel(panel, site, '[data-item="q-undo"] button[data-undo-cancel="q-undo"]');
  await expect(card.locator(".confirm")).toHaveCount(0);
  // The agent has read it, so the card is on the Done shelf: the verdict word
  // has become the mark in the gutter, and the line is option then title.
  await expect(card.locator(".verdict")).toHaveText(/^Solo \/ Team\s+Tier names$/);
  await expect(card.locator(".mark.mark-decision")).toHaveCount(1);
  expect(await countOf("w-undo")).toBe(1);

  await clickInPanel(panel, site, '[data-item="q-undo"] button[data-undo="q-undo"]');
  await clickInPanel(panel, site, '[data-item="q-undo"] button[data-undo-confirm="q-undo"]');
  await expect.poll(() => countOf("w-undo"), { timeout: 20_000 }).toBe(2);
  const undone = (await verdicts("w-undo"))[1];
  expect(undone.kind).toBe("undo");
  expect(undone.option).toBe("Solo / Team");

  // The card comes back answerable with the answer being taken back still
  // picked: they are correcting it, not starting from nothing.
  await expect(card.locator('button[data-kind="decision"]')).toBeEnabled();
  await expect(card.locator('input[value="Solo / Team"]')).toBeChecked();
  await expect(card.locator(".verdict")).toHaveCount(0);
});

test("Ask needs words, files them verbatim, and leaves the card answerable", async () => {
  const { site, panel } = await setup("w-ask");
  await addItems("w-ask", [lookItem("look-ask")]);
  const card = panel.locator('[data-item="look-ask"]');
  await expect(card).toBeVisible({ timeout: 10_000 });

  const ask = card.locator('button[data-kind="ask"]');
  await expect(ask).toBeDisabled();
  await panel.locator('[data-note="look-ask"]').fill("which build is this against?");
  await expect(ask).toBeEnabled();

  await clickInPanel(panel, site, '[data-item="look-ask"] button[data-kind="ask"]');
  await expect.poll(() => countOf("w-ask"), { timeout: 20_000 }).toBe(1);
  const v = (await verdicts("w-ask"))[0];
  expect(v.kind).toBe("ask");
  expect(v.text).toBe("which build is this against?");

  // An asked card is not an answered one: the line sits above the buttons, and
  // the buttons still work, so nobody is locked out waiting on the agent.
  await expect(card.locator(".asked")).toHaveText("Asked. Waiting for the agent.");
  await expect(card.locator(".asked + .verdicts")).toHaveCount(1);
  await expect(card.locator('button[data-kind="pass"]')).toBeEnabled();
  await expect(card.locator("button[data-go]")).toBeEnabled();
  // The question has been sent, so the box is empty and the buttons that need
  // words say so — the box and the pane's memory of it cannot disagree, or
  // Issue reads as alive over a draft that is already gone.
  await expect(panel.locator('[data-note="look-ask"]')).toHaveValue("");
  await expect(ask).toBeDisabled();
  await expect(card.locator('button[data-kind="issue"]')).toBeDisabled();
});

test("a card waiting on the agent says so at its kerb and at its line, both breathing", async () => {
  // The owner, 2026-10-04: "when you hit ask and it says 'Asked. Waiting for the
  // agent.' can we do like a pulsing yellow thing or put a left-pane color
  // thing or SOMETHING to indicate it's waiting? in addition to that text of
  // course." Both, in the Kerb's own vocabulary: the 4 px edge goes yellow and
  // breathes on the current card's rhythm, and the line grows the header's dot.
  const { site, panel } = await setup("w-waiting");
  await addItems("w-waiting", [lookItem("look-wait")]);
  const card = panel.locator('[data-item="look-wait"]');
  await expect(card).toBeVisible({ timeout: 10_000 });

  await panel.locator('[data-note="look-wait"]').fill("is this against the kerb build?");
  await clickInPanel(panel, site, '[data-item="look-wait"] button[data-kind="ask"]');
  await expect.poll(() => countOf("w-waiting"), { timeout: 20_000 }).toBe(1);

  await expect(card).toHaveClass(/\bwaiting\b/, { timeout: 10_000 });
  // The words are untouched, and the dot adds none of its own.
  await expect(card.locator(".asked")).toHaveText("Asked. Waiting for the agent.");
  await expect(card.locator(".asked .dot.waiting")).toHaveCount(1);

  // The kerb is painted the waiting colour and breathing it, whichever theme
  // Chrome is in: `--kerb-breath` is the colour the one kerb animation runs on.
  const edge = await card.evaluate(el => {
    const s = getComputedStyle(el);
    const dot = getComputedStyle(el.querySelector(".asked .dot")!);
    return {
      anim: s.animationName, width: s.borderLeftWidth,
      breath: s.getPropertyValue("--kerb-breath").trim(),
      waiting: getComputedStyle(document.documentElement).getPropertyValue("--waiting").trim(),
      dotAnim: dot.animationName, dotColour: dot.backgroundColor,
    };
  });
  expect(edge.anim).toBe("kerb");
  expect(edge.width).toBe("4px");
  expect(edge.breath).toBe(edge.waiting);
  // The dot breathes the header's own breath, in the same yellow.
  expect(edge.dotAnim).toBe("breathe");
  expect(edge.dotColour).not.toBe("rgba(0, 0, 0, 0)");
});

test("an unmet expectation files a blocked verdict instead of showing a broken item", async () => {
  const { site, panel } = await setup("w-stale");
  await addItems("w-stale", [lookItem("stale", {
    title: "Needs new build",
    expect: [{ kind: "text", css: "meta[name=build]", attr: "content", equals: "fix-999" }],
  })]);
  await expect(panel.locator('[data-item="stale"]')).toBeVisible({ timeout: 10_000 });

  await clickInPanel(panel, site, '[data-go="stale"]');
  await expect.poll(() => countOf("w-stale", "blocked"), { timeout: 30_000 }).toBe(1);
  await expect(panel.locator('[data-item="stale"]')).toHaveClass(/blocked/, { timeout: 10_000 });
});

test("a Go whose preconditions now pass clears the card's blocked state, and the record keeps the line", async () => {
  // The Lamppost cut caught it: history was rebuilt, Go outlined the list, and
  // the card still read "Not ready here" with the old diagnostic under it.
  const { site, panel } = await setup("w-unblock");
  await addItems("w-unblock", [lookItem("late", {
    title: "Ready on the next build",
    expect: [{ kind: "text", css: "meta[name=build]", attr: "content", equals: "fix-777" }],
  })]);
  const card = panel.locator('[data-item="late"]');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await clickInPanel(panel, site, '[data-go="late"]');
  await expect.poll(() => countOf("w-unblock", "blocked"), { timeout: 30_000 }).toBe(1);
  await expect(card).toHaveClass(/blocked/, { timeout: 10_000 });
  // The build catches up. The fixture's tag is edited in place; a real site
  // would have been redeployed.
  await site.evaluate(() => document.querySelector("meta[name=build]")!.setAttribute("content", "fix-777"));
  await clickInPanel(panel, site, '[data-go="late"]');
  await expect(card).not.toHaveClass(/blocked/, { timeout: 10_000 });
  await expect(card.locator(".diag")).toHaveCount(0);
  expect(await countOf("w-unblock", "blocked")).toBe(1);
  // And if it falls back again, that is news: the same diagnostic files once more.
  await site.evaluate(() => document.querySelector("meta[name=build]")!.setAttribute("content", "fix-001"));
  await clickInPanel(panel, site, '[data-go="late"]');
  await expect.poll(() => countOf("w-unblock", "blocked"), { timeout: 30_000 }).toBe(2);
  await expect(card).toHaveClass(/blocked/, { timeout: 10_000 });
});

test("three presses of Go on an item that is not ready file one blocked, and Issue files the person's words", async () => {
  const { site, panel } = await setup("w-dedupe");
  await addItems("w-dedupe", [lookItem("unsat", {
    title: "Still not ready",
    expect: [{ kind: "present", css: "#nothing-here" }],
  })]);
  const card = panel.locator('[data-item="unsat"]');
  await expect(card).toBeVisible({ timeout: 10_000 });

  // Driven through the panel's own message rather than the button, because the
  // assertion is about presses that overlap: sendMessage resolves when the
  // worker has finished that Go, so "all three are done" needs no sleep.
  const go = () => panel.evaluate(([w, i]) => chrome.runtime.sendMessage({ t: "panel:go", walk: w, itemId: i }), ["w-dedupe", "unsat"]);
  await Promise.all([go(), go(), go()]);
  expect(await countOf("w-dedupe", "blocked")).toBe(1);

  // And a press that starts after the first one finished: the same diagnostic
  // against the same item is not news either.
  await clickInPanel(panel, site, '[data-go="unsat"]');
  await go();
  expect(await countOf("w-dedupe", "blocked")).toBe(1);

  await expect(card).toHaveClass(/blocked/);
  await expect(card.locator(".diag code")).toHaveText('expect[1] present #nothing-here: wanted "present", saw "(absent)"');

  // The diagnostic is the pane's; the note box is theirs. An Issue carries what
  // they typed and nothing the machine wrote.
  await panel.locator('[data-note="unsat"]').fill("the anchor never renders on this page");
  await clickInPanel(panel, site, '[data-item="unsat"] button[data-kind="issue"]');
  await expect.poll(() => countOf("w-dedupe", "issue"), { timeout: 20_000 }).toBe(1);
  const issue = (await verdicts("w-dedupe")).find(v => v.kind === "issue");
  expect(issue.text).toBe("the anchor never renders on this page");
  expect(issue.text).not.toContain("expect[");
});

test("a selector the browser refuses is filed as blocked and said in the pane", async () => {
  // Found in review: `querySelector` threw out of the content script's
  // listener, the worker read the dead port as "the page never answered", and
  // the panel discarded that reply — so the agent's own typo was indistinguish-
  // able from a page no script may run on, and nobody was told at all.
  const { site, panel } = await setup("w-badsel");
  await addItems("w-badsel", [lookItem("typo", {
    title: "Written with a typo",
    expect: [{ kind: "present", css: "div >" }],
  })]);
  const card = panel.locator('[data-item="typo"]');
  await expect(card).toBeVisible({ timeout: 10_000 });

  await clickInPanel(panel, site, '[data-go="typo"]');
  await expect.poll(() => countOf("w-badsel", "blocked"), { timeout: 30_000 }).toBe(1);
  const line = (await verdicts("w-badsel")).find(v => v.kind === "blocked").text as string;
  // The sentence the person reads, then the browser's own words after it.
  expect(line.startsWith("This card's selector is not valid. ")).toBe(true);
  expect(line).toContain("div >");
  await expect(card).toHaveClass(/blocked/, { timeout: 10_000 });
  await expect(panel.locator("#said")).toHaveText(/^This card's selector is not valid\. /, { timeout: 10_000 });
});

test("a sequence is one card: ticks survive a repaint, ride the verdict, and the verdict line says how far it got", async () => {
  const { site, panel } = await setup("w-seq");
  await addItems("w-seq", [{
    id: "lock", kind: "sequence", owner: "e2e", title: "The lock", url: `${SITE}/other.html`,
    steps: [{ do: "Press Go.", see: "The other page." }, { do: "Read the heading.", see: "It is there." }, { do: "Blink.", see: "Nothing changes." }],
    pass: "All three.",
  }]);
  const card = panel.locator('[data-item="lock"]');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card.locator("li.step")).toHaveCount(3);
  await expect(card.locator("dt")).toHaveCount(0);
  await expect(card.locator("button[data-go]")).toHaveCount(1);
  await expect(card.locator("textarea[data-note]")).toHaveCount(1);
  await expect(card.locator(".pass")).toHaveText("All three.");

  await panel.locator('[data-step="0"][data-for="lock"]').check();
  await panel.locator('[data-step="1"][data-for="lock"]').check();
  // A new item repaints every card; the ticks must come back on the fresh DOM.
  await addItems("w-seq", [{ id: "note", kind: "info", owner: "e2e", title: "Landed", body: "A lane landed." }]);
  await expect(panel.locator('[data-item="note"]')).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator('[data-step="0"][data-for="lock"]')).toBeChecked();
  await expect(panel.locator('[data-step="1"][data-for="lock"]')).toBeChecked();
  await expect(panel.locator('[data-step="2"][data-for="lock"]')).not.toBeChecked();

  await panel.locator('[data-note="lock"]').fill("third never came");
  await clickInPanel(panel, site, '[data-kind="issue"][data-for="lock"]');
  await expect.poll(() => countOf("w-seq"), { timeout: 20_000 }).toBe(1);
  const v = (await verdicts("w-seq"))[0];
  expect(v.text).toBe("third never came");
  expect(v.steps).toEqual([true, true, false]);
  await expect(card.locator(".far")).toHaveText("2 of 3 steps");
});

test("Undo is free until an agent reads the verdict, the agent never sees what was taken back before that, and it turns red after", async () => {
  // The owner, on an early walk: "until the other agent picks it up it's a free and easy
  // click to evict it from the daemon … a green undo that turns red when the
  // main agent pulls it off the queue."
  const { site, panel } = await setup("w-takeback");
  await addItems("w-takeback", [lookItem("tb")]);
  const card = panel.locator('[data-item="tb"]');
  await expect(card).toBeVisible({ timeout: 10_000 });

  await panel.locator('[data-note="tb"]').fill("wrong button");
  await clickInPanel(panel, site, '[data-kind="issue"][data-for="tb"]');
  await expect.poll(() => countOf("w-takeback"), { timeout: 20_000 }).toBe(1);
  // Free: one click, no confirm, and the words come back into the note box.
  await expect(card.locator('button.free[data-undo-now="tb"]')).toBeVisible();
  await clickInPanel(panel, site, 'button[data-undo-now="tb"]');
  await expect.poll(() => countOf("w-takeback"), { timeout: 20_000 }).toBe(2);
  await expect(card.locator('[data-note="tb"]')).toHaveValue("wrong button");
  // The agent is handed neither the answer nor its retraction.
  expect((await agentWait("w-takeback", 0)).verdicts).toEqual([]);

  // Answer again; the agent reads it; Undo turns red and asks first.
  await clickInPanel(panel, site, '[data-kind="pass"][data-for="tb"]');
  await expect.poll(() => countOf("w-takeback"), { timeout: 20_000 }).toBe(3);
  await expect(card.locator('button.free[data-undo-now="tb"]')).toBeVisible();
  expect((await agentWait("w-takeback", 0)).verdicts.map(v => v.seq)).toEqual([3]);
  await expect(card.locator('button.danger[data-undo="tb"]')).toBeVisible({ timeout: 10_000 });
  // Read by the agent: the card has dropped into the Done shelf.
  await expect(panel.locator('section.shelf [data-item="tb"]')).toHaveCount(1);
  await clickInPanel(panel, site, 'button[data-undo="tb"]');
  await clickInPanel(panel, site, 'button[data-undo-confirm="tb"]');
  await expect.poll(() => countOf("w-takeback"), { timeout: 20_000 }).toBe(4);
  expect((await agentWait("w-takeback", 3)).verdicts.map(v => [v.kind, v.retracts])).toEqual([["undo", 3]]);
});

test("a card answered mid-list moves to the ledge, the pane does not move, and the agent's read shelves it", async () => {
  // The owner, 2026-09-23, on the Lamppost demo: "the way the thing scrolled me
  // away from where I was was… surprising", and "there maybe needs to be an
  // intermediary step, where while the undo is still green … collapse and pin
  // and stick to the screen for a bit".
  //
  // The suite's daemon serves with --grace-ms 0, so the window is not what
  // holds the row on the ledge — an agent read is what takes it off, and
  // nothing here reads as the agent until the last two lines. (`countOf` and
  // the rest read with ?viewer=1, which hands nothing to an agent.)
  const { site, panel } = await setup("w-ledge");
  await panel.setViewportSize({ width: 360, height: 600 });
  await addItems("w-ledge", Array.from({ length: 10 }, (_, n) => lookItem(`l${n}`, { title: `Card ${n}` })));
  // A card in the middle, with cards above and below it: the one whose leaving
  // used to take the pane with it.
  const mid = panel.locator('[data-item="l5"]');
  await expect(panel.locator('[data-item="l9"]')).toBeVisible({ timeout: 10_000 });
  await mid.scrollIntoViewIfNeeded();
  const before = await panel.evaluate(() => document.scrollingElement!.scrollTop);
  await panel.locator('[data-note="l5"]').fill("a long answer");
  await clickInPanel(panel, site, '[data-kind="pass-note"][data-for="l5"]');
  await expect.poll(() => countOf("w-ledge"), { timeout: 20_000 }).toBe(1);
  // One row on the ledge, the green Undo on it, and the card out of its group.
  // Scoped to this walk: the pane carries every earlier test's walk too, and a
  // closed walk keeps its cards, so `section.ledge` alone is not this one's.
  const ledge = panel.locator('section.ledge[data-walk-id="w-ledge"]');
  const row = ledge.locator('[data-item="l5"]');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.locator('button.free[data-undo-now="l5"]')).toBeVisible();
  await expect(row.locator(".verdict")).toContainText("a long answer");
  await expect(panel.locator('section.group [data-item="l5"]')).toHaveCount(0);
  // And the person is still standing where they were.
  const after = await panel.evaluate(() => document.scrollingElement!.scrollTop);
  expect(Math.abs(after - before), `scrollTop moved from ${before} to ${after}`).toBeLessThan(8);
  // Now the agent reads it: off the ledge, onto the Done shelf, loud Undo.
  expect((await agentWait("w-ledge", 0)).verdicts.map(v => v.seq)).toEqual([1]);
  await expect(panel.locator('section.shelf [data-item="l5"]')).toHaveCount(1, { timeout: 10_000 });
  await expect(ledge).toHaveCount(0);
  await expect(panel.locator('button.danger[data-undo="l5"]')).toBeVisible();
});

test("Undo on a ledge row hands the card straight back, and the ledge goes with it", async () => {
  const { site, panel } = await setup("w-ledge-undo");
  await addItems("w-ledge-undo", [lookItem("lu")]);
  await expect(panel.locator('[data-item="lu"]')).toBeVisible({ timeout: 10_000 });
  await panel.locator('[data-note="lu"]').fill("wrong button");
  await clickInPanel(panel, site, '[data-kind="issue"][data-for="lu"]');
  await expect.poll(() => countOf("w-ledge-undo"), { timeout: 20_000 }).toBe(1);
  // Scoped to this walk: the pane still carries every earlier test's walk.
  const ledge = panel.locator('section.ledge[data-walk-id="w-ledge-undo"]');
  await expect(ledge.locator('[data-item="lu"]')).toBeVisible({ timeout: 10_000 });
  // One press, no confirm: the free Undo is free from the ledge too.
  await clickInPanel(panel, site, 'section.ledge[data-walk-id="w-ledge-undo"] button[data-undo-now="lu"]');
  await expect.poll(() => countOf("w-ledge-undo"), { timeout: 20_000 }).toBe(2);
  // Back in its group, answerable, with their words back in the box — and with
  // nothing left on it the ledge is not in the DOM at all.
  await expect(panel.locator('section.group [data-item="lu"]')).toHaveCount(1, { timeout: 10_000 });
  await expect(panel.locator('[data-note="lu"]')).toHaveValue("wrong button");
  await expect(ledge).toHaveCount(0);
  // The agent is handed neither the answer nor its retraction.
  expect((await agentWait("w-ledge-undo", 0)).verdicts).toEqual([]);
});

test("a Done shelf row opens out on hover and on focus, and the red Undo does not move under the hand", async () => {
  // The owner, 2026-10-04: "when hovering over a line on the done ledge do you think
  // we can expand on hover to at least show the full untruncated title? If i'm
  // considering a red undo for example, I'll need to get some details on what it
  // was exactly."
  const TITLE = "The operator key box takes a key, keeps it, and the station reads it back after a restart";
  const WORDS = "the box took it but the station still read the old one until I restarted the box by hand, twice";
  const { site, panel } = await setup("w-shelf-open");
  // The real pane's width, so the one-line form has something to clip.
  await panel.setViewportSize({ width: 360, height: 700 });
  await addItems("w-shelf-open", [lookItem("so", { title: TITLE })]);
  await expect(panel.locator('[data-item="so"]')).toBeVisible({ timeout: 10_000 });
  await panel.locator('[data-note="so"]').fill(WORDS);
  await clickInPanel(panel, site, '[data-kind="pass-note"][data-for="so"]');
  await expect.poll(() => countOf("w-shelf-open"), { timeout: 20_000 }).toBe(1);
  // The agent reads it, so the row is on the shelf with the loud red Undo.
  expect((await agentWait("w-shelf-open", 0)).verdicts.map(v => v.seq)).toEqual([1]);
  const row = panel.locator('section.shelf[data-walk-id="w-shelf-open"] [data-item="so"]');
  await expect(row).toHaveCount(1, { timeout: 10_000 });
  await expect(row.locator("button.danger[data-undo]")).toBeVisible();
  await panel.bringToFront();
  await row.scrollIntoViewIfNeeded();

  /** The row, in the numbers that matter: is the line clipped, and where is the Undo. */
  const shape = () => row.evaluate(el => {
    const v = el.querySelector(".verdict") as HTMLElement;
    const r = el.getBoundingClientRect();
    const b = (el.querySelector(".undo button") as HTMLElement).getBoundingClientRect();
    const w = (el.querySelector(".verdict .w") as HTMLElement).getBoundingClientRect();
    return {
      rowTop: Math.round(r.top), rowHeight: Math.round(r.height),
      whiteSpace: getComputedStyle(v).whiteSpace,
      clipped: v.scrollWidth > v.clientWidth,
      // The Undo, as an offset inside the row: what the hand is reaching for.
      undo: [Math.round(b.top - r.top), Math.round(b.left - r.left), Math.round(b.width), Math.round(b.height)],
      // Are the person's words on screen, or off the end of the line?
      wordsInside: Math.round(w.right) <= Math.round(v.getBoundingClientRect().right),
      // The pane itself must not move either: scrolled to its end, which is
      // where the shelf is, scroll anchoring used to answer the row's growth by
      // scrolling down by exactly as much and taking the row up with it.
      scrollTop: Math.round(document.scrollingElement!.scrollTop),
    };
  });

  const shut = await shape();
  expect(shut.whiteSpace).toBe("nowrap");
  expect(shut.clipped).toBe(true);
  expect(shut.wordsInside).toBe(false);

  // Two points: where a hand enters the row, and the red Undo it is reaching
  // for. Driven with the mouse rather than `hover()`, which scrolls the pane to
  // satisfy its own actionability check and would move the row it is measuring.
  const at = await row.evaluate(el => {
    const v = (el.querySelector(".verdict") as HTMLElement).getBoundingClientRect();
    const b = (el.querySelector(".undo button") as HTMLElement).getBoundingClientRect();
    return { enter: [Math.round(v.left + 4), Math.round(v.top + v.height / 2)], undo: [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)] };
  });

  // Hover: the line wraps, the whole title and every word they wrote are on
  // screen, and the row grew downward — its top, and the Undo inside it, did
  // not move, so a hand on its way to the red Undo still lands on it.
  await panel.mouse.move(at.enter[0], at.enter[1]);
  const open = await shape();
  expect(open.whiteSpace).toBe("normal");
  expect(open.clipped).toBe(false);
  expect(open.wordsInside).toBe(true);
  expect(open.rowHeight).toBeGreaterThan(shut.rowHeight);
  expect(open.rowTop).toBe(shut.rowTop);
  expect(open.scrollTop).toBe(shut.scrollTop);
  expect(open.undo).toEqual(shut.undo);
  await expect(row.locator(".verdict")).toContainText(TITLE);
  await expect(row.locator(".verdict")).toContainText(WORDS);
  // And the press the hand was on its way to is still under the same point.
  expect(await panel.evaluate(([x, y]) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest("button")?.dataset.undo ?? null, at.undo)).toBe("so");

  // Pointer away: shut again, exactly as it was.
  await panel.mouse.move(2, 2);
  expect(await shape()).toEqual(shut);

  // And keyboard: focus inside the row opens it too, so tabbing to the red Undo
  // shows what it is about to take back.
  await row.locator("button.danger[data-undo]").focus();
  const focused = await shape();
  expect(focused.whiteSpace).toBe("normal");
  expect(focused.clipped).toBe(false);
  expect(focused.undo).toEqual(shut.undo);
});

test("a look card links its page, and a url that is not a page is refused by the daemon", async () => {
  const { panel } = await setup("w-link");
  await addItems("w-link", [lookItem("linked", { title: "Linked page" })]);
  const link = panel.locator('[data-item="linked"] .url a');
  await expect(link).toHaveAttribute("href", `${SITE}/other.html`, { timeout: 10_000 });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveText(`${SITE}/other.html`);

  const refused = await addItems("w-link", [lookItem("js", { url: "javascript:alert(1)" })]);
  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain("url");
  await expect(panel.locator('[data-item="js"]')).toHaveCount(0);
});

test("a withdrawn item is struck through with its reason and has nothing to click", async () => {
  const { panel } = await setup("w-withdraw");
  await addItems("w-withdraw", [lookItem("wd1", { title: "Rolled back" })]);
  await expect(panel.locator('[data-item="wd1"]')).toBeVisible({ timeout: 10_000 });

  const r = await post("/walks/w-withdraw/items/wd1/withdraw", { reason: "the lane was reverted" });
  expect(r.status).toBe(200);
  await expect(panel.locator('[data-item="wd1"]')).toHaveClass(/withdrawn/, { timeout: 10_000 });
  await expect(panel.locator('[data-item="wd1"] .strike')).toHaveText("the lane was reverted");
  await expect(panel.locator('[data-item="wd1"] button')).toHaveCount(0);
});

test("info items raise the toolbar badge while the pane is not being looked at, and clear when it is", async () => {
  const { site, panel } = await setup("w-badge");
  const badge = async () => (await worker()).evaluate(() => chrome.action.getBadgeText({}));
  // Headless Chrome reports every tab as visible and never fires
  // `visibilitychange`, so bringToFront cannot stand for "they looked at the
  // pane". The event is dispatched instead; everything it sets off — the
  // panel's listener, markSeen, the `panel:seen` message, the badge the worker
  // recomputes — is the product's own.
  const looked = () => panel.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await looked();
  await expect.poll(badge, { timeout: 20_000 }).toBe("");

  await addItems("w-badge", [
    { id: "n1", kind: "info", owner: "e2e", title: "Lane merged", body: "site-rim-marks is on main" },
    { id: "n2", kind: "info", owner: "e2e", title: "Box redeployed", body: "the demo box carries it now" },
  ]);
  await expect(panel.locator('[data-item="n2"]')).toBeVisible({ timeout: 10_000 });
  await expect.poll(badge, { timeout: 20_000 }).toBe("2");

  await looked();
  await expect.poll(badge, { timeout: 20_000 }).toBe("");
  await site.bringToFront();
});

test("two walks are open at once, each under its own header, and a verdict lands in the right one", async () => {
  const { site, panel } = await setup("w-two-a");
  await openWalk("w-two-b");
  await showWalk(panel, "w-two-b");

  await addItems("w-two-a", [lookItem("ta1", { group: "lane:a", title: "A's item" })]);
  await addItems("w-two-b", [lookItem("tb1", { group: "lane:b", title: "B's item" })]);

  for (const [walk, item, group] of [["w-two-a", "ta1", "lane:a"], ["w-two-b", "tb1", "lane:b"]]) {
    await expect(panel.locator(`header[data-walk-id="${walk}"]`)).toHaveCount(1, { timeout: 15_000 });
    const g = panel.locator(`section.group[data-walk-id="${walk}"]`).filter({ has: panel.locator(`[data-item="${item}"]`) });
    await expect(g).toHaveCount(1);
    await expect(g.locator("h2")).toHaveText(group);
  }

  await clickInPanel(panel, site, 'section.group[data-walk-id="w-two-b"] [data-item="tb1"] button[data-kind="pass"]');
  await expect.poll(() => countOf("w-two-b"), { timeout: 20_000 }).toBe(1);
  expect((await verdicts("w-two-b"))[0].itemId).toBe("tb1");
  expect(await countOf("w-two-a")).toBe(0);
});

test("eight walks at once — past Chrome's six connections — and the pane keeps up", async () => {
  // The defect this holds shut: the worker used to hold one SSE stream per open
  // walk, and Chrome gives one origin six connections. At the seventh walk the
  // worker's own streams were the six, so the read for that walk — and every
  // health check and verdict post behind it — queued until it timed out, and
  // the pane stalled with the last walks never on screen. One multiplexed
  // stream spends one connection however many walks are open.
  const { site, panel } = await setup("w-mux-1");
  for (let i = 2; i <= 8; i++) await openWalk(`w-mux-${i}`);
  await showWalk(panel, "w-mux-8");

  await addItems("w-mux-8", [lookItem("m8", { title: "Eighth walk" })]);
  await addItems("w-mux-1", [lookItem("m1", { title: "First walk" })]);
  await expect(panel.locator('[data-item="m8"]')).toBeVisible({ timeout: 10_000 });
  await expect(panel.locator('[data-item="m1"]')).toBeVisible({ timeout: 10_000 });

  // A verdict is a short POST: it must not be stuck behind the stream either.
  await clickInPanel(panel, site, 'section.group[data-walk-id="w-mux-8"] [data-item="m8"] button[data-kind="pass"]');
  await expect.poll(() => countOf("w-mux-8"), { timeout: 10_000 }).toBe(1);
  expect((await verdicts("w-mux-8"))[0].itemId).toBe("m8");
  await expect(panel.locator("#status .dot.on")).toHaveCount(1);
});

test("a verdict carries the page's console: the load-time error, a later warning, newest last, last 20", async () => {
  const { site, panel } = await setup("w-console");
  await addItems("w-console", [
    { ...lookItem("c1", { title: "Home" }), url: `${SITE}/` },
    { ...lookItem("c2", { title: "Home again" }), url: `${SITE}/` },
  ]);
  await expect(panel.locator('[data-item="c2"]')).toBeVisible({ timeout: 10_000 });

  // Go loads the page with both halves of the capture already registered, which
  // is the only way a console line written during the load is caught at all.
  await clickInPanel(panel, site, '[data-go="c1"]');
  await expect.poll(() => site.url(), { timeout: 20_000 }).toBe(`${SITE}/`);
  await site.evaluate(() => console.warn("a warning written long after load"));

  await clickInPanel(panel, site, '[data-item="c1"] button[data-kind="pass"]');
  await expect.poll(() => countOf("w-console"), { timeout: 20_000 }).toBe(1);
  const tail = (await verdicts("w-console"))[0].context.console as { text: string }[];
  const err = tail.findIndex(c => c.text.includes("deliberate error"));
  const warn = tail.findIndex(c => c.text.includes("a warning written long after load"));
  expect(err, "the load-time error").toBeGreaterThanOrEqual(0);
  expect(warn, "the later warning, after it").toBeGreaterThan(err);
  expect(tail.length).toBeLessThanOrEqual(20);

  // The ring is the last 20 lines, not the first 20 — the cap the schema holds
  // the daemon to as well.
  await site.evaluate(() => { for (let i = 0; i < 25; i++) console.warn(`flood ${i}`); });
  await clickInPanel(panel, site, '[data-item="c2"] button[data-kind="pass"]');
  await expect.poll(() => countOf("w-console"), { timeout: 20_000 }).toBe(2);
  const tail2 = (await verdicts("w-console"))[1].context.console as { text: string }[];
  expect(tail2.length).toBe(20);
  expect(tail2[19].text).toContain("flood 24");
  expect(tail2.some(c => c.text.includes("deliberate error"))).toBe(false);
});

test("verdicts queue while the daemon is down and replay when it returns", async () => {
  const { site, panel } = await setup("w-queue");
  await addItems("w-queue", [{ id: "q", kind: "info", owner: "e2e", title: "Closed while away", body: "b" }]);
  await expect(panel.locator('[data-item="q"]')).toBeVisible({ timeout: 10_000 });

  daemon.kill("SIGTERM");
  await waitFor("stopped answering /health", false);

  await clickInPanel(panel, site, '[data-kind="dismiss"][data-for="q"]');
  // No daemon: the line is looking for it, with the queued count after (v3).
  await expect(panel.locator("#status")).toContainText("queued", { timeout: 10_000 });
  await expect(panel.locator("#status")).toContainText(`Looking for walkd on ${PORT}`);

  daemon = await startDaemon();
  await expect
    .poll(async () => {
      try { return (await verdicts("w-queue")).some(v => v.itemId === "q"); } catch { return false; }
    }, { timeout: 45_000 })
    .toBe(true);

  // The daemon having the verdict is not the same as the human seeing it land:
  // the reconnect re-reads the walk and rebuilds every card, so a replay that
  // happened after that read would repaint the card he just answered as new.
  await expect(panel.locator('[data-item="q"]')).toHaveClass(/answered/, { timeout: 30_000 });
});

test("an item added after the daemon is restarted still reaches the pane", async () => {
  const { panel } = await setup("w-restart");
  await addItems("w-restart", [lookItem("rs-a", { title: "Before the restart" })]);
  await expect(panel.locator('[data-item="rs-a"]')).toBeVisible({ timeout: 10_000 });

  daemon.kill("SIGTERM");
  await waitFor("stopped answering /health", false);
  daemon = await startDaemon();

  expect((await addItems("w-restart", [lookItem("rs-b", { title: "After the restart" })])).status).toBe(200);
  // The reconnect ladder tops out at 5 s between tries; 15 s is that with room.
  await expect(panel.locator('[data-item="rs-b"]')).toBeVisible({ timeout: 15_000 });
  // The connection line names the daemon and its port in both states (v3).
  await expect(panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 15_000 });
});

test("a verdict the daemon refuses is counted, and its card asks for the answer again", async () => {
  const { site, panel } = await setup("w-refuse");
  await addItems("w-refuse", [lookItem("r1", { title: "Answered too late" })]);
  await expect(panel.locator('[data-item="r1"]')).toBeVisible({ timeout: 10_000 });

  // The agent closes the walk while the pane is open and the person is mid-item.
  expect((await post("/walks/w-refuse/close", { summary: "done" })).status).toBe(200);
  await expect.poll(() => read("w-refuse").then(r => Boolean(r.walk.closedAt)), { timeout: 10_000 }).toBe(true);

  await clickInPanel(panel, site, '[data-item="r1"] button[data-kind="pass"]');
  await expect(panel.locator("#status")).toContainText("1 refused", { timeout: 20_000 });
  await expect(panel.locator('[data-item="r1"] .refused')).toHaveText("Refused by the walk server. Answer this one again.");
  expect(await countOf("w-refuse")).toBe(0);

  // The dead letter is this test's; it would otherwise sit in the header's
  // count for whatever runs next.
  await (await worker()).evaluate(() => chrome.storage.local.set({ "walkd:dead": [] }));
});

// 8762: a port this suite never serves on, so it is a port no daemon has ever
// answered on in this profile — which is what a store install looks like.
const NEVER_PORT = 8762;

test("a port no daemon has ever answered on gets the install note, with the command on the clipboard once Copy is pressed", async () => {
  const { panel } = await setup("w-first");
  const sw = await worker();
  await sw.evaluate(port => chrome.storage.local.set({ "walkd:port": port }), NEVER_PORT);
  await expect(panel.locator(".note.first-run")).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator(".note.first-run code")).toHaveText("claude mcp add --scope user sidewalk -- npx -y sidewalk-mcp");
  // The connection line is unchanged: it is still looking, and that is still true.
  await expect(panel.locator("#status")).toContainText(`Looking for walkd on ${NEVER_PORT}`);
  await panel.locator(".note.first-run button[data-copy-text]").click();
  await expect(panel.locator(".note.first-run button[data-copy-text]")).toHaveText("Copied");
  expect(await panel.evaluate(() => navigator.clipboard.readText())).toBe("claude mcp add --scope user sidewalk -- npx -y sidewalk-mcp");

  // Back on a port that has answered: the note goes, the walk comes back.
  await sw.evaluate(port => chrome.storage.local.set({ "walkd:port": port }), PORT);
  await expect(panel.locator(".note.first-run")).toHaveCount(0, { timeout: 15_000 });
  await expect(panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 15_000 });
  await expect(panel.locator('header[data-walk-id="w-first"]')).toHaveCount(1, { timeout: 15_000 });
});

/**
 * The token (secrets review). The daemon makes one every boot and refuses
 * every route but /health without it, so these two cover the whole visible half:
 * what a caller without it gets, and what the person does about it.
 */
test("a request without the token is refused, and the pane says the daemon needs it", async () => {
  const { panel } = await setup("w-token");
  await addItems("w-token", [lookItem("tk-a", { title: "Behind the token" })]);
  await expect(panel.locator('[data-item="tk-a"]')).toBeVisible({ timeout: 10_000 });

  // The daemon first: the pane's own read, with no header on it.
  const bare = await fetch(`${BASE}/walks/w-token?viewer=1`);
  expect(bare.status).toBe(401);
  const refused = (await bare.json()) as { error: string };
  expect(refused.error).toContain(path.join(dataDir, "token"));
  // Nothing of the walk comes back with the refusal.
  expect(JSON.stringify(refused)).not.toContain("tk-a");
  // /health stays open, which is what lets the pane know it is there at all.
  expect((await (await fetch(`${BASE}/health`)).json()).auth).toBe("token");

  // Now the pane, holding a token that is not this daemon's. The gear starts
  // closed on purpose: what is being shown here is that a refusal no longer
  // opens it, and an earlier test may have left it open.
  const sw = await worker();
  await closeGear(panel);
  await sw.evaluate(() => chrome.storage.local.set({ "walkd:token": "not-this-daemons-token" }));
  await expect(panel.locator("#status")).toContainText(`walkd on ${PORT} needs the token`, { timeout: 15_000 });
  // One slab: the sentence, Connect, and the way to the other door. No command
  // in it — that lives in the gear, next to the field it feeds.
  await expect(panel.locator(".note.token")).toContainText(`walkd on port ${PORT} is running and has not let this panel in yet.`);
  await expect(panel.locator(".note.token code")).toHaveCount(0);
  // And the gear does not open itself on a refusal any more: Connect is the
  // first door, and pre-opening the second one left it standing open.
  await expect(panel.locator("#prefs #token")).toBeHidden();

  // The link is what opens it, and it goes to the field it named, with the
  // command one line above.
  await panel.locator(".note.token button[data-paste]").click();
  await expect(panel.locator("#prefs #token")).toBeVisible();
  await expect(panel.locator("#prefs #token")).toBeFocused();
  await expect(panel.locator("#prefs #token-how code")).toHaveText("npx -y sidewalk-walkd token --copy");
  // A token *is* stored here — the wrong one — so the field shows dots and holds
  // no value. Stored-ness is what the mask is about, not whether walkd took it,
  // and the hidden line beside it says a paste replaces what is there.
  await expect(panel.locator("#prefs #token")).toHaveAttribute("placeholder", "••••••••••••");
  await expect(panel.locator("#prefs #token")).toHaveValue("");
  await expect(panel.locator("#prefs #token")).toHaveAttribute("data-stored", "1");
  await expect(panel.locator("#prefs #token")).toHaveAttribute("aria-describedby", "token-stored");
  await expect(panel.locator("#token-stored")).toHaveText("A token is stored. Pasting a new one replaces it.");

  // Put it back, the way a paste would, and the pane comes back.
  await sw.evaluate(t => chrome.storage.local.set({ "walkd:token": t }), token);
  await expect(panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 15_000 });
  await expect(panel.locator(".note.token")).toHaveCount(0);
  // The gear was opened by the link above and the panel page outlives this
  // test, so leave it as it was found: closed.
  await panel.locator("#settings").click();
  await expect(panel.locator("#prefs #token")).toBeHidden();
});

/**
 * F5 of the audit, end to end. An agent that is refused a value can ask the page
 * for it back: a `text` expect that fails files a `blocked` verdict saying what
 * it *saw*, `buildId` is that same read on every verdict, and the console tail is
 * the same channel. On a card carrying a secret the pane sends their lengths.
 */
test("a card with a secret files what the page showed as a length, not as the words", async () => {
  const { site, panel } = await setup("w-redact");
  await addItems("w-redact", [lookItem("rd-a", {
    title: "Paste the licence key",
    // The home page, so Go navigates there from the page `setup` left open and
    // the console scripts are in place for its load — the tail is one of the
    // three fields this is about.
    url: `${SITE}/`,
    secrets: [{ label: "Licence key", value: "lp_live_4f9c2a7e1d0b8c6e" }],
    // The build meta there says "fix-001" (7 characters); the expect wants
    // something else, so the pane files `blocked` with what it saw.
    expect: [{ kind: "text", css: "meta[name=build]", attr: "content", equals: "not-this-build" }],
  })]);
  await expect(panel.locator('[data-item="rd-a"]')).toBeVisible({ timeout: 10_000 });

  await clickInPanel(panel, site, '[data-go="rd-a"]');
  await expect.poll(() => countOf("w-redact", "blocked"), { timeout: 20_000 }).toBe(1);
  const v = (await verdicts("w-redact"))[0];
  // What the agent wrote survives; what the page was showing does not.
  expect(v.text).toContain('wanted "not-this-build"');
  expect(v.text).toContain("(redacted, 7 chars)");
  expect(v.text).not.toContain("fix-001");
  // The picture is untouched: that is the person's own setting, not this rule's.
  expect(v.context.screenshot).toMatch(/^shots\/\d{6}\.jpg$/);

  // `buildId` and the console tail ride every verdict, a pass included — so the
  // card that passes is where those two are read.
  await addItems("w-redact", [lookItem("rd-c", {
    title: "The key was accepted", url: `${SITE}/`,
    secrets: [{ label: "Licence key", value: "lp_live_4f9c2a7e1d0b8c6e" }],
    expect: [{ kind: "text", css: "meta[name=build]", attr: "content", contains: "fix" }],
  })]);
  await expect(panel.locator('[data-item="rd-c"]')).toBeVisible({ timeout: 10_000 });
  await clickInPanel(panel, site, '[data-go="rd-c"]');
  await clickInPanel(panel, site, '[data-kind="pass"][data-for="rd-c"]');
  await expect.poll(() => countOf("w-redact", "pass"), { timeout: 20_000 }).toBe(1);
  const p = (await verdicts("w-redact")).find((x: any) => x.kind === "pass");
  expect(p.context.buildId).toBe("(redacted, 7 chars)");
  // The console tail keeps its levels and times, and none of its words.
  expect(p.context.console.length).toBeGreaterThan(0);
  for (const line of p.context.console as { level: string; text: string }[]) {
    expect(["error", "warn"]).toContain(line.level);
    expect(line.text).toMatch(/^\(redacted, \d+ chars\)$/);
  }
  expect(JSON.stringify(p.context)).not.toContain("deliberate error");

  // And a card with no secret on the same page still says what it saw.
  await addItems("w-redact", [lookItem("rd-b", { title: "No secret here", url: `${SITE}/`, expect: [{ kind: "text", css: "meta[name=build]", attr: "content", equals: "not-this-build" }] })]);
  await expect(panel.locator('[data-item="rd-b"]')).toBeVisible({ timeout: 10_000 });
  await clickInPanel(panel, site, '[data-go="rd-b"]');
  await expect.poll(() => countOf("w-redact", "blocked"), { timeout: 20_000 }).toBe(2);
  expect((await verdicts("w-redact")).find((x: any) => x.itemId === "rd-b").text).toContain('saw "fix-001"');
});

test("pasting the token into the gear is what lets the pane in", async () => {
  const sw = await worker();
  // A pane with no token at all: where a fresh install stands before the person
  // has run `walkd token`.
  await sw.evaluate(() => chrome.storage.local.set({ "walkd:token": "" }));
  await openWalk("w-paste");
  await addItems("w-paste", [lookItem("ps-a", { title: "Only after the paste" })]);

  let panel = ctx.pages().find(p => p.url().startsWith("chrome-extension://"));
  if (!panel) { panel = await ctx.newPage(); await panel.goto(`chrome-extension://${extId}/panel.html`); }
  // At the pane's real width, because the field and its Save share one row. Put
  // back at the end: the panel page outlives this test.
  const was = panel.viewportSize();
  await panel.setViewportSize({ width: 360, height: 900 });
  await panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
  await expect(panel.locator("#status")).toContainText(`walkd on ${PORT} needs the token`, { timeout: 15_000 });
  await expect(panel.locator('header[data-walk-id="w-paste"]')).toHaveCount(0);

  // The way in is the notice's own link, which is the route a person takes: the
  // gear does not open itself on a refusal, and this is what opens it and puts
  // the cursor where the paste goes. With nothing stored, the field says so.
  await expect(panel.locator("#prefs #token")).toBeHidden();
  await panel.locator(".note.token button[data-paste]").click();
  await expect(panel.locator("#prefs #token")).toBeFocused();
  await expect(panel.locator("#prefs #token")).toHaveAttribute("placeholder", "paste it here");
  await expect(panel.locator("#prefs #token")).not.toHaveAttribute("data-stored", "1");
  await expect(panel.locator("#prefs #token-how code")).toHaveText("npx -y sidewalk-walkd token --copy");

  // The paste itself, into the gear, with the trailing newline a terminal copy
  // brings along; Save is the button beside the field.
  await panel.locator("#prefs #token").fill(`${token}\n`);
  // Nothing on that row is pushed off the pane by a 43-character token.
  for (const sel of ["#prefs #token", "#token-save"]) {
    const box = await panel.locator(sel).boundingBox();
    expect(box!.x, sel).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, sel).toBeLessThanOrEqual(360);
  }
  await panel.locator("#token-save").click();
  // The gear's line is what the daemon said about this token, not the fact that
  // storage took the write: green only once it has let the pane in.
  await expect(panel.locator("#token-said")).toHaveText("Connected.", { timeout: 15_000 });
  await expect(panel.locator("#token-said")).toHaveClass("pass");
  // The paste door's receipt, in the same box as the host door's, saying which
  // door it was. The gear's own line stays — that one is about this paste.
  await expect(panel.locator("#receipt")).toHaveText("Connected. walkd accepted the token you pasted. Your walks open here from now on.");
  await expect(panel.locator("#receipt b")).toHaveText("Connected.");
  await expect(panel.locator("#receipt")).toBeHidden({ timeout: 6_000 });
  console.log(`receipt proof: the paste door said "Connected. walkd accepted the token you pasted. Your walks open here from now on." and took it away by itself`);
  // The token has done its job and leaves the page: dots in the placeholder,
  // nothing in the value, and the gear's command row gone with the notice —
  // nobody needs to be told how to get a token once walkd has let them in.
  await expect(panel.locator("#prefs #token")).toHaveValue("");
  await expect(panel.locator("#prefs #token")).toHaveAttribute("placeholder", "••••••••••••");
  await expect(panel.locator("#prefs #token")).toHaveAttribute("data-stored", "1");
  await expect(panel.locator("#prefs #token-how")).toBeHidden();
  console.log(`field proof: after the paste the field holds no value and shows ${"••••••••••••"}, and the gear's command row is gone`);

  await expect(panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 15_000 });
  await expect(panel.locator('header[data-walk-id="w-paste"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(panel.locator('[data-item="ps-a"]')).toBeVisible({ timeout: 15_000 });
  // What was stored is the token without the newline — which is what makes it work.
  expect((await sw.evaluate(() => chrome.storage.local.get("walkd:token")))["walkd:token"]).toBe(token);
  if (was) await panel.setViewportSize(was);
});

/** The gear, open, however the test before this one left it. */
async function openGear(panel: Page) {
  if (!(await panel.locator("#prefs").isVisible())) await panel.locator("#settings").click();
  await expect(panel.locator("#prefs #token")).toBeVisible();
}

/** The gear, closed, the same way: the panel page outlives every test here. */
async function closeGear(panel: Page) {
  if (await panel.locator("#prefs").isVisible()) await panel.locator("#settings").click();
  await expect(panel.locator("#prefs #token")).toBeHidden();
}

/**
 * The owner, 2026-10-06: "i had copied something else and noticed when i saved my
 * wrong token it just says saved in green like no actual connection check /
 * rejection". So Save is a check: the pane stores the token, waits for the
 * worker's answer about this port with this token, and says that.
 */
test("a Save is a check: a wrong token is refused out loud and the pane stays out, the right one lets it in", async () => {
  const sw = await worker();
  // Where a fresh install stands, and where the wrong paste lands: no token yet.
  await sw.evaluate(() => chrome.storage.local.set({ "walkd:token": "" }));
  await openWalk("w-check");
  await addItems("w-check", [lookItem("ck-a", { title: "Only after the check" })]);

  let panel = ctx.pages().find(p => p.url().startsWith("chrome-extension://"));
  if (!panel) { panel = await ctx.newPage(); await panel.goto(`chrome-extension://${extId}/panel.html`); }
  await panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
  await expect(panel.locator("#status")).toContainText(`walkd on ${PORT} needs the token`, { timeout: 15_000 });
  await openGear(panel);

  // The other thing on the clipboard, saved.
  await panel.locator("#prefs #token").fill("not-this-daemons-token");
  await panel.locator("#token-save").click();
  await expect(panel.locator("#token-said")).toHaveText("walkd refused this token.", { timeout: 15_000 });
  await expect(panel.locator("#token-said")).toHaveClass("issue");
  // Still out: the line says what the daemon wants and the walk is not on the pane.
  await expect(panel.locator("#status")).toContainText(`walkd on ${PORT} needs the token`);
  await expect(panel.locator('header[data-walk-id="w-check"]')).toHaveCount(0);
  // Save is a button again, and the field has the hand and the wrong token in it,
  // so the next paste replaces it.
  await expect(panel.locator("#token-save")).toBeEnabled();
  await expect(panel.locator("#prefs #token")).toBeFocused();

  // The right one, over the top of it.
  await panel.locator("#prefs #token").fill(token);
  await panel.locator("#token-save").click();
  await expect(panel.locator("#token-said")).toHaveText("Connected.", { timeout: 15_000 });
  await expect(panel.locator("#token-said")).toHaveClass("pass");
  // The one that worked leaves the page too, the same way.
  await expect(panel.locator("#prefs #token")).toHaveValue("");
  await expect(panel.locator("#prefs #token")).toHaveAttribute("placeholder", "••••••••••••");
  await expect(panel.locator("#prefs #token")).toHaveAttribute("data-stored", "1");
  await expect(panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 15_000 });
  await expect(panel.locator('[data-item="ck-a"]')).toBeVisible({ timeout: 15_000 });
});

test("a Save with nothing answering on the port says so in no colour at all, and a green line does not outlive its connection", async () => {
  const { panel } = await setup("w-noport");
  const sw = await worker();
  await openGear(panel);
  // Green first, on this run's daemon: that is the line that must not be left
  // standing once the pane is no longer in.
  await panel.locator("#prefs #token").fill(token);
  await panel.locator("#token-save").click();
  await expect(panel.locator("#token-said")).toHaveText("Connected.", { timeout: 15_000 });

  // 8762 again: nothing this suite runs ever serves on it.
  await sw.evaluate(port => chrome.storage.local.set({ "walkd:port": port }), NEVER_PORT);
  await expect(panel.locator("#status")).toContainText(`Looking for walkd on ${NEVER_PORT}`, { timeout: 15_000 });
  await expect(panel.locator("#token-said")).toBeHidden();

  // And a Save against that port has nothing to ask, which it must not dress up
  // as a verdict on the token. The token goes in again first: the one that
  // worked above left the field the moment walkd accepted it, and a Save on an
  // untouched field is a no-op by design.
  await expect(panel.locator("#prefs #token")).toHaveValue("");
  await panel.locator("#prefs #token").fill(token);
  await panel.locator("#token-save").click();
  await expect(panel.locator("#token-said")).toHaveText(`No walkd on ${NEVER_PORT}.`, { timeout: 15_000 });
  await expect(panel.locator("#token-said")).toHaveClass("");

  // Back on this run's daemon, for whatever runs next.
  await sw.evaluate(port => chrome.storage.local.set({ "walkd:port": port }), PORT);
  await expect(panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 15_000 });
});

/** This run's daemon, put back claiming whatever release a test needs it to. */
async function daemonClaiming(version?: string) {
  daemon.kill("SIGTERM");
  await waitFor("stopped answering /health", false);
  daemon = await startDaemon(version ? { WALKD_ADVERTISE_VERSION: version } : {});
}

test("a daemon older than the pane says so, offers Restart walkd, and hides the command behind a link", async () => {
  const { panel } = await setup("w-version");
  await expect(panel.locator(".note.version")).toHaveCount(0);

  await daemonClaiming("0.1.0");

  const mine = await panel.evaluate(() => chrome.runtime.getManifest().version);
  // The reconnect ladder tops out at 5 s between tries; 15 s is that with room.
  await expect(panel.locator(".note.version")).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator(".note.version")).toContainText(`walkd on port ${PORT} is 0.1.0 and this panel is ${mine}. walkd is the older half. They may not understand each other.`);
  await expect(panel.locator(".note.version button[data-restart]")).toHaveText("Restart walkd");
  await expect(panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`);

  // Nothing to run and nothing to copy until it is asked for: the owner's own
  // shape for this slab — the command hidden behind a text, the button the auto path.
  await expect(panel.locator(".note.version code")).toHaveCount(0);
  await panel.locator(".note.version button[data-by-hand]").click();
  await expect(panel.locator(".note.version")).toContainText("Stop walkd, then reconnect the agent's MCP server (/mcp in Claude Code); its next call starts a current one.");
  // Two commands, in order: the stop, and then the one for the loop a stop
  // cannot leave — an old plugin pins the old walkd, and the MCP starts it again.
  await expect(panel.locator(".note.version")).toContainText("If it comes back as the old one, update the plugin.");
  await expect(panel.locator(".note.version code")).toHaveText(["npx -y sidewalk-walkd stop", "claude plugin update sidewalk@sidewalk"]);
  await expect(panel.locator(".note.version button[data-by-hand]")).toHaveCount(0);
  // And the button is still there: the link is the other way, not a replacement.
  await expect(panel.locator(".note.version button[data-restart]")).toBeVisible();

  await daemonClaiming();
  // After the kill the pane is disconnected and the notice goes with it, so wait for the match: a gap must not pass for one.
  await expect(panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 15_000 });
  await expect(panel.locator(".note.version")).toHaveCount(0, { timeout: 15_000 });
});

/**
 * The other direction, which the notice got wrong until now: the daemon was
 * replaced and the store copy of the extension has not caught up, so stopping
 * walkd changes nothing and the panel is what has to be updated.
 *
 * `requestUpdateCheck` is stubbed, and so is `reload`. It has to be: an unpacked
 * build has no store listing to check against, and a real `reload` would take
 * the test's own pane away mid-assertion. What is proved here is the panel's
 * side of it — which answer leads to which words, and that `update_available`
 * is what restarts the extension.
 */
test("a pane older than the daemon is named as the older half, and its button asks Chrome for an update", async () => {
  const { panel } = await setup("w-version-panel");
  const mine = await panel.evaluate(() => chrome.runtime.getManifest().version);

  await daemonClaiming("99.0.0");
  await expect(panel.locator(".note.version")).toBeVisible({ timeout: 15_000 });
  await expect(panel.locator(".note.version")).toContainText(`This panel is ${mine} and walkd on port ${PORT} is 99.0.0. The panel is the older half. They may not understand each other.`);
  await expect(panel.locator(".note.version button[data-update]")).toHaveText("Update the panel");
  await expect(panel.locator(".note.version button[data-restart]")).toHaveCount(0);
  // The stop command is not the remedy here and is nowhere on the slab, behind
  // the link or in front of it.
  await expect(panel.locator(".note.version")).not.toContainText("sidewalk-walkd stop");

  // Nothing newer in the store yet: one line, and the by-hand way stays.
  await panel.evaluate(() => {
    Object.defineProperty(chrome.runtime, "requestUpdateCheck", { value: async () => ({ status: "no_update" }), configurable: true });
    Object.defineProperty(chrome.runtime, "reload", { value: () => { (globalThis as { reloaded?: boolean }).reloaded = true; }, configurable: true });
  });
  await panel.locator(".note.version button[data-update]").click();
  await expect(panel.locator(".note.version .said")).toHaveText("No newer panel in the store yet.");
  await expect(panel.locator(".note.version .said")).toHaveClass(/issue/);
  expect(await panel.evaluate(() => (globalThis as { reloaded?: boolean }).reloaded === true)).toBe(false);
  await expect(panel.locator(".note.version button[data-by-hand]")).toBeVisible();

  // Chrome is rate-limiting the check: also one line, also not a dead end.
  await panel.evaluate(() => Object.defineProperty(chrome.runtime, "requestUpdateCheck", { value: async () => ({ status: "throttled" }), configurable: true }));
  await panel.locator(".note.version button[data-update]").click();
  await expect(panel.locator(".note.version .said")).toHaveText("Chrome checked too recently. Try again in a few minutes.");

  // The by-hand way, asked for: the page in Chrome's own chrome, which nothing
  // in an extension can open for somebody.
  await panel.locator(".note.version button[data-by-hand]").click();
  await expect(panel.locator(".note.version")).toContainText("Open chrome://extensions and press Update.");
  await expect(panel.locator(".note.version code")).toHaveCount(0);

  // And the answer that means the new build is downloaded and waiting: the
  // extension restarts, which is the only thing that puts it on.
  await panel.evaluate(() => Object.defineProperty(chrome.runtime, "requestUpdateCheck", { value: async () => ({ status: "update_available", version: "99.0.0" }), configurable: true }));
  await panel.locator(".note.version button[data-update]").click();
  await expect.poll(() => panel.evaluate(() => (globalThis as { reloaded?: boolean }).reloaded === true), { timeout: 10_000 }).toBe(true);

  await daemonClaiming();
  await expect(panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 15_000 });
  await expect(panel.locator(".note.version")).toHaveCount(0, { timeout: 15_000 });
});

test("a walk's brief sits under its header, and a reopen with a new brief replaces it in place", async () => {
  const r = await post("/walks", { project: "e2e", id: "w-brief", title: "Walk w-brief", buildRef: "fix-001", brief: "Start on the portal. Do not log out." });
  expect(r.status).toBe(200);
  opened.push("w-brief");
  const { panel } = await setup("w-brief");   // setup's own open is a reopen with no brief: the brief must survive it
  await expect(panel.locator('header[data-walk-id="w-brief"] .brief')).toHaveText("Start on the portal. Do not log out.");
  expect((await post("/walks", { project: "e2e", id: "w-brief", title: "Walk w-brief", buildRef: "fix-001", brief: "Start on the app instead." })).status).toBe(200);
  await expect(panel.locator('header[data-walk-id="w-brief"] .brief')).toHaveText("Start on the app instead.", { timeout: 15_000 });
});

/**
 * A walk's content scripts are registered for the origin its items name — the
 * port included, since a pattern that carries one matches that port alone
 * (`src/origin.ts` has the readings). What that is worth is here: a second page
 * of the person's own, on another loopback port, in a tab opened while the walk
 * is open. Before this it got both of the walk's content scripts.
 *
 * The neighbour is on 9402, which is nobody's: this suite owns 8761/9342/9341
 * and everything else it needs is 9400 or above.
 */
test("a walk registers for the port it named, and a page on another loopback port gets nothing", async () => {
  const NEIGHBOUR = 9402;
  const neighbour = http.createServer((_req, res) => {
    // `connection: close`, and `closeAllConnections` below: a browser holds a
    // keep-alive socket open, and `server.close()` waits for every connection
    // it has rather than ending them — which is a test that sits there for a
    // minute and a half after it has proved its point. (`firefox-check.mjs`
    // learned the same thing about its witness.)
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
    res.end("<!doctype html><title>neighbour</title><p>not part of any walk</p>");
  });
  await new Promise<void>((resolve, reject) => neighbour.once("error", reject).listen(NEIGHBOUR, "127.0.0.1", resolve));
  try {
    const { site } = await setup("w-origin");
    await addItems("w-origin", [lookItem("og-a", { title: "On the fixture site" })]);
    const sw = await worker();

    // The pattern itself, read back out of the browser: one origin, with the
    // port on it.
    await expect
      .poll(async () => (await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts())).flatMap(s => s.matches ?? []), { timeout: 15_000 })
      .toEqual([`http://127.0.0.1:9342/*`, `http://127.0.0.1:9342/*`]);

    /** Does a content script answer on the page this tab is on? */
    const answers = async (url: string) => {
      await site.goto(url);
      return await (await worker()).evaluate(async u => {
        const t = (await chrome.tabs.query({})).find(x => x.url?.startsWith(u));
        if (!t?.id) return "no tab";
        // A content script answers this; a page with none throws "Receiving end
        // does not exist". Nothing is injected on demand here — that happens
        // under a Go, and this test presses nothing.
        try { return Array.isArray(await chrome.tabs.sendMessage(t.id, { t: "content:console" })); } catch { return false; }
      }, url);
    };

    // The control first: the method can see a content script when there is one.
    expect(await answers(`${SITE}/other.html`), "the walk's own page").toBe(true);
    expect(await answers(`http://127.0.0.1:${NEIGHBOUR}/`), "another port on the same host").toBe(false);
    console.log(`origin proof: registered for http://127.0.0.1:9342/* only; a page on 127.0.0.1:${NEIGHBOUR} got no content script`);

    // Leave the tab where every other test expects to find it.
    await site.goto(`${SITE}/other.html`);
  } finally {
    neighbour.closeAllConnections();
    await new Promise<void>(resolve => neighbour.close(() => resolve()));
  }
});

/* ------------------------------------------------------- the hands-free token
 *
 * The panel asking walkd for its own token, through the browser, with nothing
 * pasted. Two tests, each with a browser of its own, because what is being
 * tested is a profile that has never been given anything: the suite's shared
 * context has had a token pushed into its storage since `beforeAll`.
 *
 * Three things make this runnable at all, and each of them was measured on this
 * machine on 2026-10-12 rather than taken from documentation:
 *
 * 1. **The permission has to be required in the test build.** Chrome draws a
 *    native Views bubble for `permissions.request({nativeMessaging})` that no
 *    automation can answer — not Playwright, not CDP, not `chrome://extensions`,
 *    and the preferences file's MAC rejects a hand-edited grant. So the build
 *    these two tests load is a copy of `dist` whose manifest moves
 *    `nativeMessaging` into `permissions`. The shipped `dist` keeps
 *    `optional_permissions`, and nothing in the build scripts knows about this:
 *    the patch is made here, into a temp directory, so it cannot leak into a
 *    store zip.
 * 2. **A Chromium launched with `--user-data-dir` reads host manifests from
 *    `<user-data-dir>/NativeMessagingHosts`, beside `Default/` and not inside
 *    it** — so the real folders under `$HOME` are invisible to it, which is
 *    exactly why the suite can prove this without going near the person's own
 *    browser. The file is the one walkd's own writer produced, copied in.
 * 3. **The lookup happens on every call**, so the manifest can be written
 *    before or after the browser starts and nothing has to be restarted.
 *
 * The copy also rewrites the default port, 8760 → 8761, the way
 * `firefox-check.mjs` does: a fresh profile has nothing in storage, so without
 * that the pane would look for the daemon the person is actually using.
 */

/**
 * A walkd command, run to the end, with its stdout handed back. Stderr goes
 * straight through, so walkd's own lines show up in the suite's output the way
 * the daemon's do.
 */
function run(bin: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env } });
    let out = "";
    child.stdout?.on("data", d => { out += String(d); });
    child.once("error", reject);
    child.once("exit", code => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(bin)} ${args.join(" ")} exited ${code}`))));
  });
}

/**
 * A copy of `dist` these tests can load: nativeMessaging required, 8761 by
 * default, and — when a test asks for it — a worker that cannot reach the host.
 *
 * `blindWorker` is the field case of 2026-10-18 made testable. In the owner's
 * Chrome, a grant gives the new API only to contexts created after it, so the
 * service worker that was already running holds the permission and has no
 * `sendNativeMessage` at all. A seam appended to `sw.js` takes the function away
 * in exactly that shape, which is the only way to stand the press up against a
 * stale worker without a real grant to be stale about.
 *
 * `blindPanel` does the same to `panel.js`, and the two together are the field
 * shape exactly: the permission held, and no method in either of the contexts a
 * press runs in. That is the only way to make the panel take its frame path,
 * since the one thing no automation can do is grant the permission for real.
 */
async function nativeBuild(dir: string, { blindWorker = false, blindPanel = false } = {}) {
  await fs.cp(EXT, dir, { recursive: true });
  // The maps are the only files in dist no browser reads, and the rewrite below
  // would leave them describing something else.
  for (const f of await fs.readdir(dir)) if (f.endsWith(".map")) await fs.rm(path.join(dir, f));

  const file = path.join(dir, "manifest.json");
  const m = JSON.parse(await fs.readFile(file, "utf8")) as { permissions: string[]; optional_permissions?: string[]; key?: string };
  expect(m.optional_permissions, "the shipped manifest keeps it optional").toEqual(["nativeMessaging"]);
  // The `key` travels with the copy: it is what makes this build report the
  // store id, and the store id is the only origin the host's manifest admits.
  expect(m.key, "the store key, or the host refuses this build").toBeTruthy();
  m.permissions = [...m.permissions, "nativeMessaging"];
  delete m.optional_permissions;
  await fs.writeFile(file, `${JSON.stringify(m, null, 2)}\n`);

  let found = 0;
  for (const f of ["sw.js", "panel.js"]) {
    const p = path.join(dir, f);
    const before = await fs.readFile(p, "utf8");
    found += before.split("8760").length - 1;
    await fs.writeFile(p, before.replaceAll("8760", String(PORT)));
  }
  // One in each bundle: `DEFAULT_PORT`, inlined by esbuild. Any other count and
  // the number means something else somewhere, and this is editing it.
  expect(found, "8760 in the two bundles").toBe(2);

  // Appended, not prepended: esbuild's own "use strict" has to stay the first
  // thing in the file. `configurable: true` because the API object is the
  // browser's, and a plain `delete` is not promised to work on it. The frame
  // `panel.js` makes gets its own `chrome.runtime`, which this does not touch —
  // which is the whole point of the frame.
  const blind = (who: string) => `
// e2e: this context as Chrome leaves one that existed before the permission was
// granted — the permission held, and no function to call.
try { Object.defineProperty(chrome.runtime, "sendNativeMessage", { value: undefined, configurable: true }); } catch (e) { console.error("e2e blind-${who} seam:", e); }
`;
  for (const [on, who] of [[blindWorker, "sw"], [blindPanel, "panel"]] as const) {
    if (!on) continue;
    const f = path.join(dir, `${who}.js`);
    await fs.writeFile(f, `${await fs.readFile(f, "utf8")}${blind(who)}`);
  }
}

/**
 * The Chrome host manifest walkd's own writer produces, put where a Chromium on
 * a throwaway profile will find it. Returns what was written, so a test can say
 * which daemon it points at.
 */
async function hostManifestInto(udd: string) {
  const nativeRoot = path.join(dataDir, "native-root-e2e");
  // walkd writes a manifest only where the browser's own folder already exists
  // — it never invents a browser — so this run's root gets a Chrome folder in
  // both unix layouts. Only the one this platform uses is ever read.
  for (const vendor of [["Library", "Application Support", "Google", "Chrome"], [".config", "google-chrome"]]) {
    await fs.mkdir(path.join(nativeRoot, ...vendor), { recursive: true });
  }
  // `walkd native` is the same writer a `walkd serve` runs, so the file copied
  // below is the file a person's own browser would be given, down to the
  // wrapper path and the state directory it names.
  await run(WALKD, ["native", "--data-dir", dataDir, "--state-dir", path.join(dataDir, "state")], { WALKD_NATIVE_ROOT: nativeRoot });

  const entries = await fs.readdir(nativeRoot, { recursive: true, withFileTypes: true });
  const hit = entries.find(e => e.isFile() && e.name === "sh.sidewalk.walkd.json");
  expect(hit, `no host manifest under ${nativeRoot}`).toBeTruthy();
  const from = path.join(hit!.parentPath, hit!.name);
  const manifest = JSON.parse(await fs.readFile(from, "utf8")) as { name: string; path: string; allowed_origins: string[] };
  // Beside `Default/`, not inside it: measured, and the one that works.
  const into = path.join(udd, "NativeMessagingHosts");
  await fs.mkdir(into, { recursive: true });
  await fs.copyFile(from, path.join(into, path.basename(from)));
  return manifest;
}

/** A browser of its own, on a profile with nothing in it. */
async function freshPane(withHost: boolean, opts: { blindWorker?: boolean; blindPanel?: boolean } = {}) {
  const udd = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-e2e-profile-"));
  const build = await fs.mkdtemp(path.join(os.tmpdir(), "walkd-e2e-build-"));
  await nativeBuild(build, opts);
  const manifest = withHost ? await hostManifestInto(udd) : null;
  const fresh = await chromium.launchPersistentContext(udd, {
    channel: "chromium",
    headless: true,
    // No remote debugging port: 9341 belongs to the context beforeAll made.
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
  });
  const log: string[] = [];
  const sw = fresh.serviceWorkers().find(w => w.url().startsWith("chrome-extension://")) ?? (await fresh.waitForEvent("serviceworker"));
  sw.on("console", msg => log.push(`[sw:${msg.type()}] ${msg.text()}`));
  const id = sw.url().split("/")[2];
  const panel = await fresh.newPage();
  // Before the first load, and kept across the reload a press can cause: the
  // panel's own console is the only witness to which half asked the host.
  const panelLog: string[] = [];
  panel.on("console", msg => panelLog.push(`[panel:${msg.type()}] ${msg.text()}`));
  await panel.goto(`chrome-extension://${id}/panel.html`);
  const close = async () => {
    await fresh.close();
    await fs.rm(udd, { recursive: true, force: true });
    await fs.rm(build, { recursive: true, force: true });
  };
  return { fresh, sw, id, panel, log, panelLog, manifest, udd, close };
}

test("a fresh profile with no token asks walkd's host for it, is let in with nothing pasted, and says so in the receipt", async () => {
  const pane = await freshPane(true);
  try {
    // The key in the manifest is what makes an unpacked build report the store
    // id, and the store id is the one origin the host's manifest admits.
    expect(pane.id).toBe("fiibejlikopcaplomihaegmbanhjjmed");
    expect(pane.manifest!.allowed_origins).toEqual([`chrome-extension://${pane.id}/`]);
    expect(pane.manifest!.name).toBe("sh.sidewalk.walkd");
    console.log(`hands-free proof: extension id ${pane.id}, host ${pane.manifest!.name} -> ${pane.manifest!.path}`);

    // Nothing was pasted and nothing was pushed into storage: this profile has
    // never been told anything at all.
    expect((await pane.sw.evaluate(() => chrome.storage.local.get(["walkd:token", "walkd:port"]))) as Record<string, unknown>).toEqual({});

    await pane.panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
    await expect(pane.panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 20_000 });
    // No notice, and the gear never opened itself for a token.
    await expect(pane.panel.locator(".note.token")).toHaveCount(0);

    const stored = (await pane.sw.evaluate(() => chrome.storage.local.get("walkd:token")))["walkd:token"];
    expect(stored).toBe(token);
    expect(String(stored).length).toBeGreaterThan(20);
    // The worker's own account of it.
    expect(pane.log.join("\n")).toContain(`the native messaging host handed over the token for ${PORT}`);
    console.log(`hands-free proof: panel connected to walkd on ${PORT} with no paste; the stored token is the daemon's (${String(stored).length} characters, ${String(stored) === token ? "identical" : "DIFFERENT"})`);

    // The receipt for this door, which needs a pane open at the moment the
    // token lands — above there was none: the worker adopts within a moment of
    // the browser starting, long before Playwright has a page on the panel, and
    // a message with nothing listening is dropped on the floor by design.
    //
    // Taking the token back out of storage is the honest way back to the state
    // the worker asks the host from, and it walks the whole ladder: the daemon
    // still answers, so `wantsToken` with no token asks again — spent, this
    // episode — and the read that follows is refused, which after an adoption
    // is worth exactly one more ask (`sw.ts` `refreshNow`). That ask is the
    // hands-free door a second time, with the pane watching.
    await pane.sw.evaluate(() => chrome.storage.local.remove("walkd:token"));
    await expect(pane.panel.locator("#receipt")).toHaveText("Connected. walkd handed over its token. Your walks open here from now on.", { timeout: 20_000 });
    await expect(pane.panel.locator("#receipt b")).toHaveText("Connected.");
    await expect(pane.panel.locator("#receipt")).toBeVisible();
    // The same green word as the gear's Save line, over a pane that is in.
    await expect(pane.panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`);
    // And it takes itself away, like every other notice on this pane.
    await expect(pane.panel.locator("#receipt")).toBeHidden({ timeout: 6_000 });
    expect(await pane.panel.evaluate(() => document.getElementById("receipt")!.textContent)).toBe("");
    console.log(`receipt proof: the hands-free door said "Connected. walkd handed over its token. Your walks open here from now on." with nothing pressed, and took it away by itself`);
  } finally {
    await pane.close();
  }
});

/**
 * The same profile with no host on disk, and then the Connect button pressed
 * twice — once with nothing there to answer, and once after the manifest lands.
 *
 * Pressing it is testable here for one reason: in this build the permission is
 * required, and `permissions.request` on a permission already held returns
 * `granted: true` at once with no bubble drawn (measured). So the click path is
 * exercised in full — the request inside the handler, the message to the
 * worker, the ask, and the line the pane says about how it went — and only the
 * drawing of Chrome's bubble is left out, which is the one part no automation
 * can reach.
 *
 * Writing the manifest between the two presses is the per-call lookup, used as
 * a feature: nothing is restarted, and the second press finds a host the first
 * one could not.
 */
test("with no host on disk the pane says so, and Connect says what came of it — then the manifest lands and it connects", async () => {
  const pane = await freshPane(false);
  try {
    await pane.panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
    await expect(pane.panel.locator("#status")).toContainText(`walkd on ${PORT} needs the token`, { timeout: 20_000 });
    await expect(pane.panel.locator(".note.token")).toBeVisible();
    await expect(pane.panel.locator(".note.token")).toContainText(`walkd on port ${PORT} is running and has not let this panel in yet.`);
    await expect(pane.panel.locator(".note.token button[data-connect]")).toHaveText("Connect");
    await expect(pane.panel.locator(".note.token button[data-paste]")).toHaveText("Paste the token instead");
    // The command is not in the notice, and the gear is not open: Connect is the
    // first door, and nothing has been pressed yet.
    await expect(pane.panel.locator(".note.token code")).toHaveCount(0);
    await expect(pane.panel.locator("#prefs #token")).toBeHidden();
    // The worker did ask, and the browser's answer was the one four different
    // manifest mistakes all produce.
    expect(pane.log.join("\n")).toContain("no token through the browser (noHost");
    expect((await pane.sw.evaluate(() => chrome.storage.local.get("walkd:token")))["walkd:token"]).toBeUndefined();
    console.log(`hands-free proof: with no manifest the pane says "walkd on ${PORT} needs the token", offers Connect and the way to the gear, and holds no command of its own`);

    // Pressed with nothing to answer: one line, and the form offered rather than
    // left to be found — the gear opens itself with the command above the field.
    await pane.panel.locator(".note.token button[data-connect]").click();
    await expect(pane.panel.locator(".note.token .said")).toHaveText("walkd did not answer through the browser.", { timeout: 15_000 });
    await expect(pane.panel.locator("#prefs #token")).toBeVisible();
    await expect(pane.panel.locator("#prefs #token-how code")).toHaveText("npx -y sidewalk-walkd token --copy");
    // Nothing is stored in this profile, so the field says what it wants.
    await expect(pane.panel.locator("#prefs #token")).toHaveAttribute("placeholder", "paste it here");
    // Connect stays: the manifest may land a moment later, and it does below.
    await expect(pane.panel.locator(".note.token button[data-connect]")).toBeEnabled();
    await expect(pane.panel.locator("#status")).toContainText(`walkd on ${PORT} needs the token`);
    console.log(`hands-free proof: Connect pressed with no host — "walkd did not answer through the browser." and the gear opened itself at the field`);

    // The manifest lands now, with the browser already running and nothing
    // restarted, because the lookup happens on every call.
    const manifest = await hostManifestInto(pane.udd);
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${pane.id}/`]);
    await pane.panel.locator(".note.token button[data-connect]").click();
    await expect(pane.panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 20_000 });
    await expect(pane.panel.locator(".note.token")).toHaveCount(0);
    expect((await pane.sw.evaluate(() => chrome.storage.local.get("walkd:token")))["walkd:token"]).toBe(token);
    // The notice's place answers in the notice's own box: one green word and one
    // sentence, for four seconds and then gone.
    await expect(pane.panel.locator("#receipt")).toBeVisible();
    await expect(pane.panel.locator("#receipt")).toHaveText("Connected. walkd handed over its token. Your walks open here from now on.");
    await expect(pane.panel.locator("#receipt b")).toHaveText("Connected.");
    await expect(pane.panel.locator("#receipt")).toBeHidden({ timeout: 6_000 });
    // The gear is still open — the failed press opened it and nothing closes it
    // behind the person — and the field now shows that a token is stored, with
    // the command gone because nobody needs it any more.
    await expect(pane.panel.locator("#prefs #token")).toHaveValue("");
    await expect(pane.panel.locator("#prefs #token")).toHaveAttribute("placeholder", "••••••••••••");
    await expect(pane.panel.locator("#prefs #token")).toHaveAttribute("data-stored", "1");
    await expect(pane.panel.locator("#prefs #token-how")).toBeHidden();
    console.log(`hands-free proof: Connect pressed again with the manifest in the profile — connected to walkd on ${PORT}, token identical, nothing restarted`);
    console.log(`receipt proof: the host door said "Connected. walkd handed over its token. Your walks open here from now on." and took it away by itself`);
  } finally {
    await pane.close();
  }
});

/**
 * The one way the two halves can disagree, and the loop it used to cause.
 *
 * `walkd token --rotate` under a running daemon writes a new token to the file
 * and leaves the daemon serving the one in its memory — it says so when it runs.
 * The host reads the file. So the host hands the pane a token that daemon will
 * never accept, and before review found it the pane stored that token, took the
 * 401 as a fresh episode, asked again, and stored the same value — which
 * Chromium reports no `onChanged` for, so nothing retargeted and nothing
 * settled. One host process per thirty-second alarm, and a Connect press that
 * said nothing at all.
 *
 * Two asks are the floor here and the test holds them to it: one to find out
 * what the host has, one to find out that it is the same thing again. After
 * that the episode is over, and two forced refreshes add none.
 */
test("a token the host hands over that walkd refuses is said once, and not asked for again", async () => {
  // `--no-copy`: a rotate copies by default, and the person's clipboard is
  // never a test's to take.
  // Two lines on stdout: what it did, then the token itself.
  const said = await run(WALKD, ["token", "--rotate", "--no-copy", "--data-dir", dataDir, "--state-dir", path.join(dataDir, "state")]);
  const rotated = said.trim().split("\n").pop()!.trim();
  expect(rotated, "the token, not walkd's own line").toMatch(/^[A-Za-z0-9_-]{20,}$/);
  expect(rotated, "a new token in the file").not.toBe(token);
  const pane = await freshPane(true);
  /** How many times the host has been asked, off the worker's own console. */
  const asks = () => pane.log.filter(l => l.includes("handed over the token") || l.includes("no token through the browser")).length;
  try {
    // The daemon is still serving the token it booted with, so what the host
    // gives is refused.
    await pane.panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
    await expect(pane.panel.locator("#status")).toContainText(`walkd on ${PORT} needs the token`, { timeout: 20_000 });
    await expect.poll(asks, { timeout: 15_000 }).toBe(2);
    expect(pane.log.join("\n")).toContain("no token through the browser (refusedToken: the host's token is the one already refused)");
    // What the pane stored is the file's token, which is the one being refused —
    // so the state is real and not a pane that quietly kept the old one.
    expect((await pane.sw.evaluate(() => chrome.storage.local.get("walkd:token")))["walkd:token"]).toBe(rotated);

    // Two more refreshes, each of which earns its own 401: no further asks.
    for (let i = 0; i < 2; i++) await pane.panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
    await expect(pane.panel.locator("#status")).toContainText(`walkd on ${PORT} needs the token`);
    expect(asks(), "the episode is over").toBe(2);
    console.log(`rotate proof: the host was asked twice and no more; the pane holds the rotated token and walkd refuses it`);

    // The press says what is wrong, and does not tell them to paste a token that
    // is already the one being refused.
    await pane.panel.locator(".note.token button[data-connect]").click();
    await expect(pane.panel.locator(".note.token .said")).toHaveText("walkd refused the token the host handed over. Restart walkd, then press Connect again.", { timeout: 15_000 });
    expect(asks(), "the press is one ask of its own").toBe(3);
    // No way to the gear offered, and the gear not opened: a paste of the token
    // walkd is already refusing is no way out, and the line says what is.
    await expect(pane.panel.locator(".note.token button[data-paste]")).toHaveCount(0);
    await expect(pane.panel.locator("#prefs")).toBeHidden();
    // And no receipt, at any point: a pane walkd is refusing has nothing to
    // show a receipt for, which is the lie the gear's own check went out to end.
    await expect(pane.panel.locator("#receipt")).toBeHidden();
    expect(await pane.panel.evaluate(() => document.getElementById("receipt")!.textContent)).toBe("");
    console.log(`rotate proof: Connect says "walkd refused the token the host handed over. Restart walkd, then press Connect again." and no receipt was shown`);
  } finally {
    await pane.close();
    // Hand the daemon's own token back to the file, so nothing after this test
    // inherits a data dir whose file and daemon disagree.
    await fs.writeFile(path.join(dataDir, "token"), `${token}\n`);
  }
});

/* --------------------------------------------- the press, from two contexts
 *
 * Measured in the owner's own Chrome on 2026-10-18, on the shipped build with a
 * real grant: `permissions.contains` is true in every context afterwards, and
 * `chrome.runtime.sendNativeMessage` is **still undefined** in the service
 * worker and in the panel page that drew the button. A side panel closed and
 * opened again had the function and reached the host first time. So the browser
 * gives the new API only to contexts created after the grant, and a press has to
 * survive the two it starts in being stale.
 *
 * Neither of the two tests below can grant anything — no automation can press
 * Chrome's bubble — so the permission is required in their build and the
 * staleness is put in by hand, with a seam that takes `sendNativeMessage` away
 * from the worker and leaves the permission held. That is the field shape
 * exactly, and it is the half a real grant cannot be automated into.
 */

test("a worker the browser has not given the API to: the press still connects, through the panel", async () => {
  const pane = await freshPane(true, { blindWorker: true });
  try {
    // The automatic ask cannot work for the same reason the first press could
    // not, so the pane is where the field report found it.
    await pane.panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
    await expect(pane.panel.locator("#status")).toContainText(`walkd on ${PORT} needs the token`, { timeout: 20_000 });
    expect(pane.log.join("\n")).toContain(`no token through the browser (noApi: the browser has not given this worker the API yet`);

    await pane.panel.locator(".note.token button[data-connect]").click();
    await expect(pane.panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 20_000 });
    await expect(pane.panel.locator(".note.token")).toHaveCount(0);
    expect((await pane.sw.evaluate(() => chrome.storage.local.get("walkd:token")))["walkd:token"]).toBe(token);
    // The panel said out loud that it was the half that could ask.
    expect(pane.panelLog.join("\n")).toContain("the worker cannot reach walkd's host (noApi");
    console.log(`two-context proof: a worker with the permission and no API said noApi; the panel asked the host and the pane is connected to walkd on ${PORT}`);
  } finally {
    await pane.close();
  }
});

test("a press that needed a reload finishes itself on the load that follows", async () => {
  const pane = await freshPane(true, { blindWorker: true });
  try {
    await pane.panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
    await expect(pane.panel.locator("#status")).toContainText(`walkd on ${PORT} needs the token`, { timeout: 20_000 });

    // What the press leaves behind when this page cannot ask: one flag, and a
    // reload. Written here rather than by a click, because the branch that
    // writes it is taken only when the page has no API — and a page that has
    // none cannot be made by any automation, only by a real grant.
    await pane.panel.evaluate(([key, port]) => chrome.storage.session.set({ [key as string]: { port, at: Date.now() } }), ["walkd:connect-after-reload", PORT] as [string, number]);
    await pane.panel.reload();

    // Nothing is pressed from here on: the load reads the flag and finishes.
    await expect(pane.panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 20_000 });
    expect((await pane.sw.evaluate(() => chrome.storage.local.get("walkd:token")))["walkd:token"]).toBe(token);
    // And the flag is gone, so the next load does not ask the host again.
    expect(await pane.panel.evaluate(key => chrome.storage.session.get(key as string), "walkd:connect-after-reload")).toEqual({});
    console.log(`two-context proof: a panel that reloaded with the flag set finished the press by itself and connected to walkd on ${PORT}`);
  } finally {
    await pane.close();
  }
});

/**
 * The field shape exactly: the permission held, and no method in either context
 * a press runs in. What the panel does then is make one — a hidden frame on an
 * empty page of ours, whose `chrome.runtime` is built from the permissions as
 * they are now — and ask through that.
 *
 * Measured on Chromium 151 before this was written: a same-extension frame
 * created after a grant has the method, the old parent may call it through
 * `contentWindow`, a scriptless page is enough, and a frame removed mid-call
 * leaves the caller's promise hanging for good. What this test holds is the
 * behaviour the person sees: the pane connects and **nothing on it moves**.
 */
test("a panel older than the grant asks through a hidden frame, with no reload and nothing left behind", async () => {
  const pane = await freshPane(true, { blindWorker: true, blindPanel: true });
  try {
    await pane.panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
    await expect(pane.panel.locator("#status")).toContainText(`walkd on ${PORT} needs the token`, { timeout: 20_000 });
    // Neither half can reach the host on its own.
    expect(await pane.panel.evaluate(() => typeof chrome.runtime.sendNativeMessage)).toBe("undefined");
    expect(await pane.sw.evaluate(() => typeof chrome.runtime.sendNativeMessage)).toBe("undefined");

    // From here on, any navigation of the panel's own frame is the reload this
    // change exists to avoid.
    const navigations: string[] = [];
    pane.panel.on("framenavigated", f => { if (f === pane.panel.mainFrame()) navigations.push(f.url()); });

    await pane.panel.locator(".note.token button[data-connect]").click();
    await expect(pane.panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 20_000 });
    await expect(pane.panel.locator(".note.token")).toHaveCount(0);
    expect((await pane.sw.evaluate(() => chrome.storage.local.get("walkd:token")))["walkd:token"]).toBe(token);
    expect(navigations, "the pane did not reload").toEqual([]);
    expect(pane.panelLog.join("\n")).toContain("this panel is older than the grant; asked walkd's host through a fresh frame");
    // The frame is taken away once the answer is in, and only then.
    expect(await pane.panel.evaluate(() => document.querySelectorAll("iframe").length)).toBe(0);
    // Nothing was left in the flag either: this press never needed the reload.
    expect(await pane.panel.evaluate(key => chrome.storage.session.get(key as string), "walkd:connect-after-reload")).toEqual({});
    console.log(`frame proof: a panel and a worker with no method connected to walkd on ${PORT} through a hidden frame — no navigation, no iframe left, no flag`);
  } finally {
    await pane.close();
  }
});

/* ------------------------------------------------- Restart walkd, for real
 *
 * The version notice's button, pressed against a daemon that really is the
 * older half, through a real host on disk. These two need the same browser of
 * their own the hands-free tests do, and for the same reason: the permission has
 * to be required in the build, because the bubble is the one thing no automation
 * can answer.
 *
 * The state file is where `walkd stop` and the host agree: the daemon removes it
 * on its way out, so its absence is the proof the signal arrived and was acted
 * on rather than merely sent.
 */
const stateFile = () => path.join(dataDir, "state", "walkd.json");
/** The host the wrapper in this run's manifest launches. */
const hostFile = () => path.join(dataDir, "native", "host.js");

test("Restart walkd stops the older daemon through the host, and the pane falls to its no-daemon words", async () => {
  await daemonClaiming("0.1.0");
  const pane = await freshPane(true);
  try {
    // Connected with nothing pasted, the way a fresh profile is.
    await pane.panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
    await expect(pane.panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 20_000 });
    const mine = await pane.panel.evaluate(() => chrome.runtime.getManifest().version);
    await expect(pane.panel.locator(".note.version")).toContainText(`walkd on port ${PORT} is 0.1.0 and this panel is ${mine}. walkd is the older half.`, { timeout: 20_000 });
    await expect(pane.panel.locator(".note.version button[data-restart]")).toHaveText("Restart walkd");
    expect(JSON.parse(await fs.readFile(stateFile(), "utf8")).port).toBe(PORT);

    await pane.panel.locator(".note.version button[data-restart]").click();
    // The daemon is gone, and it removed its own state file on the way — which
    // is what `walkd stop` leaves behind too.
    await waitFor("stopped answering /health", false);
    await expect.poll(() => fs.access(stateFile()).then(() => "there", () => "gone"), { timeout: 15_000 }).toBe("gone");
    // And the pane says the one thing that is true now. Nothing about the press
    // is left on screen: there is no notice left to say it in.
    await expect(pane.panel.locator("#status")).toContainText(`Looking for walkd on ${PORT}`, { timeout: 20_000 });
    await expect(pane.panel.locator(".note.version")).toHaveCount(0);
    await expect(pane.panel.locator(".note.token")).toHaveCount(0);
    console.log(`restart proof: Restart walkd stopped the 0.1.0 daemon on ${PORT} through the host — state file gone, pane back to "Looking for walkd on ${PORT}"`);
  } finally {
    await pane.close();
    await daemonClaiming();
  }
});

/**
 * The compatibility end, and the one this feature could have hung on.
 *
 * Every host up to 1.1.1 read nothing off the frame: it answered the port and
 * the token to any message at all. So a 1.2.0 panel pressing Restart walkd at
 * one of those gets a perfectly good token answer back, and `ok: true` would
 * have the pane saying a daemon went away that is still serving. The host on
 * disk below is that host — a faithful stand-in for 1.1.1's one reply, written
 * here rather than fetched from git so a shallow clone can still run it — and
 * what the press has to end in is the by-hand words, inside the ask timeout.
 *
 * The MCP brings the host up to its own release when it meets an older daemon
 * (`sidewalk-mcp/src/host.ts`), so in the field this is now the narrow case: a
 * daemon on a data directory of its own, or a host that could not be written.
 * It is still the end that must not hang, which is why it is held here.
 */
test("a host older than the panel ends a Restart press in the by-hand words, not in a hang", async () => {
  await daemonClaiming("0.1.0");
  const pane = await freshPane(true);
  const real = await fs.readFile(hostFile());
  try {
    // 1.1.1's host, in the words it would use: read the state file this host was
    // installed for, read that daemon's token, and answer with both — whatever
    // was asked.
    await fs.writeFile(hostFile(), `"use strict";
const fs = require("node:fs");
const arg = n => { const i = process.argv.indexOf(n); return i > 1 ? process.argv[i + 1] : undefined; };
let buf = Buffer.alloc(0);
process.stdin.on("data", c => {
  buf = Buffer.concat([buf, c]);
  if (buf.length < 4) return;
  if (buf.length < 4 + buf.readUInt32LE(0)) return;
  process.stdin.pause();
  const state = JSON.parse(fs.readFileSync(arg("--state-dir") + "/walkd.json", "utf8"));
  const token = fs.readFileSync(state.dataDir + "/token", "utf8").trim();
  const json = Buffer.from(JSON.stringify({ ok: true, port: state.port, token }), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([head, json]), () => process.exit(0));
});
setTimeout(() => process.exit(0), 10000);
`);

    // That host is good enough for the token op, which is what 1.1.1 was: the
    // pane connects hands-free on it, exactly as it does on a current one.
    await pane.panel.evaluate(() => chrome.runtime.sendMessage({ t: "panel:hello" }));
    await expect(pane.panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`, { timeout: 20_000 });
    await expect(pane.panel.locator(".note.version button[data-restart]")).toBeVisible({ timeout: 20_000 });

    await pane.panel.locator(".note.version button[data-restart]").click();
    // One line, and the way that does work on screen without being asked for:
    // this is the end where the person has to do it themselves.
    await expect(pane.panel.locator(".note.version .said")).toHaveText("walkd did not stop.", { timeout: 15_000 });
    await expect(pane.panel.locator(".note.version .said")).toHaveClass(/issue/);
    await expect(pane.panel.locator(".note.version")).toContainText("Stop walkd, then reconnect the agent's MCP server (/mcp in Claude Code); its next call starts a current one.");
    await expect(pane.panel.locator(".note.version code")).toHaveText(["npx -y sidewalk-walkd stop", "claude plugin update sidewalk@sidewalk"]);
    await expect(pane.panel.locator(".note.version button[data-by-hand]")).toHaveCount(0);
    expect(pane.panelLog.join("\n")).toContain("older than this panel");
    // Nothing was stopped, which is the whole point: the daemon is still there.
    expect(await healthy()).toBe(true);
    await expect(pane.panel.locator("#status")).toContainText(`Connected to walkd on ${PORT}`);
    console.log(`restart proof: a 1.1.1 host answered a stop with its token, and the pane said "walkd did not stop." with the by-hand way under it — no hang`);
  } finally {
    await fs.writeFile(hostFile(), real);
    await pane.close();
    await daemonClaiming();
  }
});
