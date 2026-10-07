/**
 * The terminal surface's copy, which is the half of it a viewer actually reads.
 *
 * So it is held to the pack it quotes, to the line `ask.ts` produces, to the
 * terminal's width, to the beats the recorder really plays — and to the one rule
 * that matters more than any of them: the pack's demo key is not in it.
 *
 * This was `demo/record-agent.test.ts` while the terminal was a take of its own.
 * There is one recorder now, so the beat list it checks against is
 * `demo/record.mjs`'s twenty-seven. No Chrome anywhere: the recorder imports
 * Playwright dynamically, inside the take, so importing the module here costs
 * nothing, and the camera's own arithmetic is tested in `demo/record.test.ts`.
 */
import { expect, it } from "vitest";
// @ts-expect-error — the demo is plain .mjs, with no types to import.
import { ASK_TEXT, BEATS } from "./record.mjs";
// @ts-expect-error — same.
import { DEFAULT_TERMINAL, FRAME, THEME, THEMES, THEME_NAMES, frameFor, themeFor } from "./agent/theme.js";
// @ts-expect-error — same.
import { TODO, awaitingCopy, blockByName, blocksFor, fill, joinWrapped, jsonInner, jsonList, loadTranscript, placeholders, renderLines, transcriptIssues, typedText } from "./agent/transcript.mjs";
// @ts-expect-error — same.
import { loadPack } from "./run.mjs";
// The line the MCP server puts on every `ask` it hands an agent. The transcript
// quotes it, wrapped; this is the only copy of it, so the two cannot drift.
import { replyLine } from "../packages/sidewalk-mcp/src/ask.js";

const pack = await loadPack();
const transcript = await loadTranscript();
const names = BEATS.map((b: any) => b.name);

/**
 * Everything a take fills in, as it is by the end of one — the real values, in
 * the real shapes, read off a `--speed 1` take: group A's four item seqs, the
 * eleven verdict seqs of which nine ever reach an agent, the pane's own blocked
 * diagnostic, the steps the person ticked on each sequence card, and the summary
 * the launcher closes with.
 */
const VARS = {
  spinner: THEME.labels.spinner,
  walk: "demo-1",
  seqsA: "[1, 2, 3, 4]",
  passSeq: 1,
  passText: "",
  cursor1: 1,
  blockedSeq: 4,
  blockedText: jsonInner('expect[1] text meta[name=build] content: wanted "lp-24", saw "lp-23"'),
  issueSeq: 5,
  issueText: "Post an update is off, but nothing says why.",
  issueSteps: "[true, true, false]",
  tiersSeq: 6,
  tiersOption: "Lit / Bright",
  cursor2: 6,
  noteSeq: 7,
  noteText: "Newest first, and the lamps match the lines.",
  keySeq: 8,
  keySteps: "[true, true]",
  askSeq: 9,
  askText: "Is the link meant to end with a slash?",
  cursor3: 9,
  seqsReply: "[8]",
  sharePassSeq: 10,
  dismissSeq: 11,
  cursor4: 11,
  summary: "Lamppost demo: 9 verdicts.",
};

const rendered = (name: string) => renderLines(blockByName(transcript, name), VARS, THEME).map((l: any) => l.text);

/* ------------------------------------------------------- the beats it rides */

it("files every transcript block under a beat the take plays", () => {
  expect(transcriptIssues(transcript, { beats: BEATS, cols: THEME.wrap, theme: THEME, vars: VARS })).toEqual([]);
  // Seven of the twenty-seven beats print. The others are the hand's alone: the
  // agent is inside `walk_wait` for every one of them, which is the claim.
  const printing = [...new Set(transcript.blocks.map((b: any) => b.beat))];
  expect(printing).toEqual(["open", "agent-read-lamps", "agent-read", "group-b", "ask-share", "agent-read-2", "closed"]);
  for (const beat of printing) expect(names).toContain(beat);
  for (const beat of ["go-lamps", "pass-lamps", "undo-tiers", "show-shelf", "copy-key", "share"]) expect(blocksFor(transcript, beat)).toEqual([]);

  // In transcript order, which is the order the beats print them in. The agent
  // says *Four cards are up* **after** the call that put them there — a terminal
  // claiming the pane is full while the pane is still empty is the one thing in
  // this take a viewer watching both surfaces would catch.
  expect(blocksFor(transcript, "open").map((b: any) => b.name))
    .toEqual(["prompt", "walk-open", "add-group-a-call", "add-group-a-result", "prose-opened", "wait-1-call"]);
  expect(blocksFor(transcript, "ask-share").map((b: any) => b.name))
    .toEqual(["wait-3-result", "prose-answering", "add-reply-call", "add-reply-result", "wait-4-call"]);
  expect(blocksFor(transcript, "closed").map((b: any) => b.name)).toEqual(["close-call", "close-result", "prompt-idle"]);
});

it("opens a wait before every result and closes the loop on walk_close", () => {
  // Four waits, each called before the beat that films its return: a result
  // printed with no call above it would be a return from nothing.
  const order = transcript.blocks.map((b: any) => b.name);
  for (const n of [1, 2, 3, 4]) {
    expect(order).toContain(`wait-${n}-call`);
    expect(order).toContain(`wait-${n}-result`);
    expect(order.indexOf(`wait-${n}-call`), `wait-${n}`).toBeLessThan(order.indexOf(`wait-${n}-result`));
  }
  // Each call takes the cursor the result before it returned, so the agent's
  // own cursor is the only thing that walks the loop forward.
  const after = (name: string) => rendered(name).find((l: string) => l.includes('"after"'));
  expect(after("wait-1-call")).toContain('"after": 0');
  expect(after("wait-2-call")).toContain(`"after": ${VARS.cursor1}`);
  expect(after("wait-3-call")).toContain(`"after": ${VARS.cursor2}`);
  expect(after("wait-4-call")).toContain(`"after": ${VARS.cursor3}`);
  // `walk_wait`'s own maximum, which the server's schema caps at 280000.
  for (const n of [1, 2, 3, 4]) expect(after(`wait-${n}-call`)).toContain('"timeoutMs": 280000');
  // And the close is last, with the summary the launcher really files.
  expect(order.at(-3)).toBe("close-call");
  expect(rendered("close-call")).toContain(`  { "walk": "demo-1", "summary": "Lamppost demo: 9 verdicts." }`);
  expect(rendered("close-result")).toEqual(['  → { "id": "demo-1", "closedAt": "…", "summary": "Lamppost demo: 9 verdicts." }']);
});

/* ------------------------------------------------------- the secret trap */

it("has no secret in it, and no argument shape that would carry one", () => {
  const secret = (pack.groups[1].items.find((i: any) => i.id === "lp-key").secrets[0] as any).value;
  expect(secret).toMatch(/^lp_live_/);
  const all = JSON.stringify(transcript);
  expect(all).not.toContain(secret);
  expect(all).not.toContain("lp_live");
  // Not even the key the value would arrive under: a faithful `walk_add_items`
  // for group B would put it on screen, which is why group B's add is one prose
  // line instead of a tool call (the research's §3d trap).
  expect(all).not.toContain('"secrets"');
  expect(blocksFor(transcript, "group-b").map((b: any) => b.name)).toEqual(["prose-group-b", "wait-3-call"]);
  expect(rendered("prose-group-b")).toEqual(["", "Group B is up: the key, the status link, a note."]);

  // And the check that would catch it being put back.
  const planted = { blocks: [{ name: "x", beat: "open", kind: "print", lines: [{ tone: "arg", text: '"secrets": [{"label": "Demo API key", "value": "lp_live_0"}]' }] }] };
  const bad = transcriptIssues(planted, { beats: BEATS, theme: THEME });
  expect(bad).toContain("block x carries the pack's demo API key");
  expect(bad).toContain("block x carries a `secrets` argument, which is how a key reaches the screen");
});

it("keeps any copy still waiting on review marked, and the marker off the screen", () => {
  // Prose an implementer writes carries `TODO-COPY` on the **block**, so it can
  // be found in one grep and replaced; it is never a word in a line, because a
  // line is filmed. Nothing is waiting now: every prose line is settled.
  expect(TODO).toBe("TODO-COPY");
  expect(awaitingCopy(transcript)).toEqual([]);
  for (const name of awaitingCopy(transcript)) {
    for (const line of rendered(name)) expect(line).not.toContain(TODO);
    // And it is prose, not a tool call: nothing with a number in it is waiting
    // on anybody's words.
    for (const l of blockByName(transcript, name).lines) expect(["blank", "prose"]).toContain(l.tone);
  }
  // A marker that reached a line would be caught, and so would a misspelt one.
  const planted = { blocks: [{ name: "x", beat: "open", kind: "print", todo: "TODO", lines: [{ tone: "prose", text: "TODO-COPY something" }] }] };
  const bad = transcriptIssues(planted, { beats: BEATS, theme: THEME });
  expect(bad).toContain("block x carries a TODO-COPY marker in the copy itself, where it would be filmed");
  expect(bad).toContain('block x carries todo "TODO", which is not TODO-COPY');
});

/* --------------------------------------------------- the loader's filling */

it("fills a placeholder from the take and refuses one nothing has set", () => {
  expect(fill("{{walk}} and {{cursor1}}", VARS)).toBe("demo-1 and 1");
  expect(fill("nothing here", VARS)).toBe("nothing here");
  expect(placeholders('{ "walk": "{{walk}}", "after": {{cursor2}} }')).toEqual(["walk", "cursor2"]);
  // The rule the beat order rests on: a block cannot print ahead of the fact it
  // describes, because its number does not exist yet.
  expect(() => fill("{{seqsReply}}", {})).toThrow(/wants \{\{seqsReply\}\}/);
  expect(() => fill("{{askSeq}}", { askSeq: undefined })).toThrow(/wants \{\{askSeq\}\}/);
  // Zero is a number a daemon really returns, and it is not "nothing set".
  expect(fill("{{cursor1}}", { cursor1: 0 })).toBe("0");

  // Every block the `open` beat prints is renderable from the three things known
  // when it starts, and the later ones are not.
  const early = { spinner: VARS.spinner, walk: VARS.walk, seqsA: VARS.seqsA };
  for (const b of blocksFor(transcript, "open"))
    expect(() => (b.kind === "type" ? typedText(b, early) : renderLines(b, early, THEME))).not.toThrow();
  expect(() => renderLines(blockByName(transcript, "wait-1-result"), early, THEME)).toThrow(/passSeq/);
  expect(() => renderLines(blockByName(transcript, "close-call"), early, THEME)).toThrow(/summary/);

  // A JSON array is spelled the way the transcript's own `seqs` lines spell one.
  expect(jsonList([1, 2, 3, 4])).toBe("[1, 2, 3, 4]");
  expect(jsonList([true, true, false])).toBe("[true, true, false]");
  expect(jsonList([])).toBe("[]");
  expect(jsonList(undefined)).toBe("[]");
  // And a string goes inside a double-quoted JSON value as the daemon gave it.
  expect(jsonInner('saw "lp-23"')).toBe('saw \\"lp-23\\"');
  expect(jsonInner("")).toBe("");
});

it("puts the theme's furniture in front of the copy, not the copy's own", () => {
  // The glyphs are the theme's, which is what makes a second theme one file:
  // nothing in transcript.json carries a bullet, a branch or a prompt.
  for (const b of transcript.blocks)
    for (const l of b.lines ?? []) expect(l.text).not.toMatch(/[●↳❯✶⏺⎿]/);
  expect(rendered("add-reply-result")).toEqual(['  → { "seqs": [8] }']);
  expect(rendered("prose-answering")).toEqual(["", "You asked about the slash. Answering on the card."]);
  // A blank line is blank, not a prefix with nothing after it.
  expect(rendered("prose-opened")[0]).toBe("");
  // Every tone a line uses has a prefix and a colour **both** themes really have.
  for (const b of transcript.blocks)
    for (const l of b.lines ?? [])
      for (const name of THEME_NAMES) {
        const theme = themeFor(name);
        expect(theme.prefixes[l.tone], `${name}/${l.tone}`).toBeTypeOf("string");
        expect(theme[theme.tones[l.tone].colour], `${name}/${l.tone}`).toMatch(/^#[0-9a-f]{6}$/);
      }
  // The spinner's words are the theme's too — furniture, not copy — and the
  // waits are the open lines, which is what makes a result land where the
  // spinner was rather than under it.
  expect(rendered("wait-1-call").at(-1)).toBe(`✶ ${THEME.labels.spinner}`);
  for (const n of [1, 2, 3, 4]) expect(blockByName(transcript, `wait-${n}-call`).open, `wait-${n}`).toBe(true);
  expect(blockByName(transcript, "prompt-idle").open).toBe(true);
});

/* ------------------------------------------------------ what it quotes */

it("quotes the walk pack's own header, wrapped and not changed", () => {
  const lines = rendered("walk-open");
  expect(lines[1]).toBe("● walk_open");
  const args = lines.slice(2, -1).join(" ");
  for (const [key] of Object.entries(pack.walk)) expect(args).toContain(`"${key}":`);
  expect(args).toContain('"project": "lamppost"');
  expect(args).toContain('"title": "Lamppost 2.4"');
  expect(args).toContain('"buildRef": "lp-24"');
  // The brief is wrapped over three lines for the terminal's width; put back
  // together it is the pack's own sentence, to the character.
  const brief = joinWrapped(lines.slice(3, 6)).replace(/^"brief": "/, "").replace(/" }$/, "");
  expect(brief).toBe(pack.walk.brief);
  expect(lines.at(-1)).toBe('  → { "id": "demo-1" }');
});

it("names group A's four cards with the pack's own ids, kinds and titles", () => {
  const lines = rendered("add-group-a-call");
  expect(lines[1]).toBe("● walk_add_items");
  const items = pack.groups[0].items;
  expect(items).toHaveLength(4);
  for (const i of items) {
    const line = lines.find((l: string) => l.includes(`"id": "${i.id}"`));
    expect(line, i.id).toBeTruthy();
    expect(line).toContain(`"kind": "${i.kind}"`);
    expect(line).toContain(`"title": "${i.title}"`);
    // The rest is elided, which is what keeps four items to four lines.
    expect(line).toContain("…");
  }
  expect(rendered("add-group-a-result")).toEqual(['  → { "seqs": [1, 2, 3, 4] }']);
});

it("carries each verdict the daemon hands over, in its own shape", () => {
  // One verdict in the first return. The tiers decision and the undo that took
  // it back are a quiet pair the daemon hides from every agent read, which is
  // why the cursor after this is 1 and not 3.
  const first = rendered("wait-1-result").join("\n");
  expect(first).toContain('"kind": "pass"');
  expect(first).toContain('"itemId": "lp-lamps"');
  expect(first).toContain(`"cursor": ${VARS.cursor1}`);

  // Three in the second, in seq order: the pane's own `blocked`, carried as the
  // daemon returns it (`describeExpect` in packages/extension/src/expect.ts);
  // the lock's issue with the steps the person ticked; the tiers decision with
  // the option they picked and no text of its own.
  const second = rendered("wait-2-result").join("\n");
  expect(second).toContain('"kind": "blocked"');
  expect(second).toContain('expect[1] text meta[name=build] content: wanted \\"lp-24\\", saw \\"lp-23\\"');
  expect(second).toContain('"kind": "issue"');
  expect(second).toContain('"steps": [true, true, false]');
  expect(second).toContain('"text": "Post an update is off, but nothing says why."');
  expect(second).toContain('"kind": "decision"');
  expect(second).toContain('"option": "Lit / Bright"');
  expect(second).toContain(`"cursor": ${VARS.cursor2}`);
  // In the order the daemon hands them over, which is seq order.
  const order = ["blocked", "issue", "decision"].map(k => second.indexOf(`"kind": "${k}"`));
  expect(order).toEqual([...order].sort((a, b) => a - b));

  // Two in the last, and the walk is still open when the wait returns them —
  // the close is a call of its own, a beat later.
  const last = rendered("wait-4-result").join("\n");
  expect(last).toContain('"itemId": "lp-share"');
  expect(last).toContain('"kind": "dismiss"');
  expect(last).toContain('"itemId": "lp-landed"');
  expect(last).toContain('"closed": false');
});

it("quotes the ask's reply line exactly as the MCP server produces it", () => {
  const lines = rendered("wait-3-result");
  // The history note and the key's pass come back in the same return as the ask:
  // they matured in their own beats and the wait returns everything it holds.
  const all = lines.join("\n");
  expect(all).toContain('"kind": "pass-note"');
  expect(all).toContain('"text": "Newest first, and the lamps match the lines."');
  expect(all).toContain('"steps": [true, true]');
  // The ask verdict's own fields, as `walk_wait` returns them.
  expect(all).toContain('"kind": "ask"');
  expect(all).toContain('"itemId": "lp-share"');
  expect(all).toContain(`"text": "${ASK_TEXT}"`);
  expect(ASK_TEXT).toBe("Is the link meant to end with a slash?");
  // Three wrapped lines, which join back to `replyLine("lp-share")` to the
  // character. If `ask.ts` changes its wording this fails, which is the point.
  const at = lines.findIndex((l: string) => l.includes('"reply"'));
  const reply = joinWrapped(lines.slice(at, at + 3)).replace(/^"reply": "/, "").replace(/"$/, "");
  expect(reply).toBe(replyLine("lp-share"));
  expect(lines.at(-1)).toContain('"closed": false');
});

it("quotes the pack's ask reply, and supersedes the card it answers", () => {
  const lines = rendered("add-reply-call");
  expect(lines[1]).toBe("● walk_add_items");
  const args = lines.slice(2).join("\n");
  // `lp-ask-<the ask verdict's seq>` is what `demo/run.mjs` really names it.
  expect(args).toContain('"id": "lp-ask-9"');
  expect(args).toContain('"kind": "info"');
  expect(args).toContain('"supersedes": "lp-share"');
  expect(args).toContain(`"title": "${pack.ask.title}"`);
  const body = joinWrapped(lines.slice(5, 7)).replace(/^"body": "/, "").replace(/" \} \] \}$/, "");
  expect(body).toBe(pack.ask.body);
});

it("types the person's one line and nothing else", () => {
  const prompt = blockByName(transcript, "prompt");
  expect(prompt.kind).toBe("type");
  expect(typedText(prompt, VARS)).toBe("Open a walk on the Lamppost build and add the first cards.");
  expect(transcript.blocks.filter((b: any) => b.kind === "type")).toHaveLength(1);
});

/* --------------------------------------------------------- the geometry */

it("wraps inside the terminal, whatever size the camera films it at", () => {
  for (const name of THEME_NAMES) {
    const theme = themeFor(name);
    for (const b of transcript.blocks) {
      if (b.kind !== "print") continue;
      for (const l of renderLines(b, VARS, theme))
        expect([...l.text].length, `${name}/${b.name}: ${l.text}`).toBeLessThanOrEqual(theme.wrap);
    }
  }
  // The frame follows the flag now: the page is whatever `--terminal-size` says
  // and the crop is the whole of it, because the cut draws this surface 1:1.
  expect(frameFor({ width: 1212, height: 440 })).toEqual({ page: { width: 1212, height: 440 }, crop: { x: 0, y: 0, w: 1212, h: 440 } });
  expect(frameFor({ width: 900, height: 320 }).crop).toEqual({ x: 0, y: 0, w: 900, h: 320 });
  expect(FRAME).toEqual(frameFor(DEFAULT_TERMINAL));
  // 16–17 px, the owner's range, and the padding keeps every glyph off the edge —
  // but not so much of it that a 440 px frame loses a row to the ring.
  for (const name of THEME_NAMES) {
    const theme = themeFor(name);
    expect(theme.font.size).toBeGreaterThanOrEqual(16);
    expect(theme.font.size).toBeLessThanOrEqual(17);
    expect(theme.padding).toBeGreaterThan(0);
    expect(theme.padding * 2).toBeLessThan(DEFAULT_TERMINAL.height / 4);
  }
});

it("has two themes that differ in nothing but their colours and their name", () => {
  expect(THEME_NAMES).toEqual(["dark", "light"]);
  expect(THEME).toBe(THEMES.dark);
  expect(() => themeFor("amber")).toThrow(/no terminal theme/);
  const COLOURS = ["ground", "ink", "muted", "edge", "accent", "pass", "waiting"];
  for (const name of THEME_NAMES) for (const c of COLOURS) expect(THEMES[name][c], `${name}.${c}`).toMatch(/^#[0-9a-f]{6}$/);
  // Every colour really is different between them — a theme that shared one
  // would be a light terminal with a dark surprise in it.
  for (const c of COLOURS) expect(THEMES.dark[c], c).not.toBe(THEMES.light[c]);
  // And nothing else is: the furniture, the measurements and the slot a themed
  // header would go in are shared, which is what keeps the look one file.
  const shared = (t: any) => JSON.stringify({ font: t.font, padding: t.padding, wrap: t.wrap, prefixes: t.prefixes, tones: t.tones, labels: t.labels, chrome: t.chrome });
  expect(shared(THEMES.light)).toBe(shared(THEMES.dark));
});

it("names nobody in either theme", () => {
  // The whole of §2e in one assertion: the look is generic until somebody has
  // asked, and a themed header is a slot rather than a line.
  const look = JSON.stringify({ THEMES, FRAME, DEFAULT_TERMINAL }) + JSON.stringify(transcript);
  for (const word of ["Claude", "Anthropic", "claude", "anthropic"]) expect(look).not.toContain(word);
  for (const name of THEME_NAMES) expect(themeFor(name).chrome).toBeNull();
  expect(THEMES.dark.name).toBe("plain agent terminal");
  expect(THEMES.light.name).toBe("plain agent terminal, light");
});
