/**
 * The agent transcript: loaded, checked, and turned into the lines the terminal
 * prints.
 *
 * `demo/agent/transcript.json` is the copy — the person's prompt, the tool
 * calls, the results and the agent's prose, in the order they appear. This file
 * is the half that is arithmetic, so it is pure and has unit tests
 * (`demo/transcript.test.ts`) and knows nothing about a browser.
 *
 * Three rules it exists to hold:
 *
 * 1. **Every number on screen comes from the daemon.** A transcript that
 *    hard-coded `demo-1`, `"after": 5` or `lp-ask-9` would be a guess, and the
 *    research's §8 sketch proves the point: it assumed one seq counter for
 *    items and verdicts, and `packages/walkd/src/store.ts` keeps two
 *    (`itemSeq`, `verdictSeq`), so its numbers were wrong. So the transcript
 *    carries `{{placeholders}}` and the recorder fills them from
 *    `GET /walks/<id>?after=0&viewer=1` as the take plays. `fill` **throws** on
 *    a placeholder it has no value for, which is what stops a block being
 *    printed before the thing it describes has happened.
 * 2. **The look is not in here.** A line is a `tone` and its text; the glyph in
 *    front of it, its colour and its weight come from `demo/agent/theme.js`.
 *    That is what makes a second theme one file.
 * 3. **The pack's secret is never in here.** `transcriptIssues` refuses a
 *    transcript that contains the demo key, or the `secrets` argument shape
 *    that would carry it — the trap §3d of the research names. The group-B add
 *    is not printed as a tool call at all for exactly this reason.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The copy. */
export const TRANSCRIPT = path.join(HERE, "transcript.json");

export const loadTranscript = async (file = TRANSCRIPT) => JSON.parse(await fs.readFile(file, "utf8"));

/* ------------------------------------------------------------ placeholders */

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Every placeholder name in a string, in order, with duplicates kept. */
export function placeholders(text) {
  return [...String(text ?? "").matchAll(PLACEHOLDER)].map(m => m[1]);
}

/**
 * Substitute `{{name}}` from `vars`. A name with no value is an error, not an
 * empty string: a block printed before its numbers exist would put a lie on
 * screen, and the throw is what the recorder's beat order is checked by.
 */
export function fill(text, vars = {}) {
  return String(text ?? "").replace(PLACEHOLDER, (_, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(`the transcript wants {{${name}}} and nothing has set it`);
    const v = vars[name];
    if (v === undefined || v === null) throw new Error(`the transcript wants {{${name}}} and it is ${String(v)}`);
    return String(v);
  });
}

/* -------------------------------------------------------------- the blocks */

/** One block by name. */
export function blockByName(transcript, name) {
  const b = transcript.blocks.find(x => x.name === name);
  if (!b) throw new Error(`no transcript block named ${name}`);
  return b;
}

/** The blocks a beat prints, in transcript order. */
export const blocksFor = (transcript, beat) => transcript.blocks.filter(b => b.beat === beat);

/**
 * A print block as the terminal will show it: the theme's prefix for each
 * tone, then the line's own text with its placeholders filled.
 *
 * The prefix is prepended rather than written into the copy so that a theme
 * owns the furniture — `● ` and `  └ ` here, something else in a theme that has
 * permission to look like something in particular.
 */
export function renderLines(block, vars, theme) {
  if (block.kind !== "print") throw new Error(`block ${block.name} is kind ${block.kind}, not print`);
  return block.lines.map(l => {
    const prefix = theme.prefixes[l.tone];
    if (prefix === undefined) throw new Error(`block ${block.name} uses tone ${JSON.stringify(l.tone)}, which the theme has no prefix for`);
    const text = fill(l.text, vars);
    // A blank line stays blank: a prefix on nothing is a glyph with no line.
    return { tone: l.tone, text: l.tone === "blank" && text === "" ? "" : prefix + text };
  });
}

/** What a typed block types, placeholders filled. The prompt glyph is the page's. */
export function typedText(block, vars) {
  if (block.kind !== "type") throw new Error(`block ${block.name} is kind ${block.kind}, not type`);
  return fill(block.text, vars);
}

/**
 * A JSON array as the transcript spells one: `[1, 2, 3, 4]`, `[true, true,
 * false]`. `JSON.stringify` writes it without the spaces, and the transcript's
 * own `seqs` lines have them, so this is the one place the spelling lives.
 */
export const jsonList = values => `[${(values ?? []).map(v => JSON.stringify(v)).join(", ")}]`;

/** A string as it goes inside a JSON double-quoted value on screen. */
export const jsonInner = s => JSON.stringify(String(s ?? "")).slice(1, -1);

/**
 * Wrapped-over-several-lines text, put back together.
 *
 * A long JSON string value is wrapped for the terminal's width with a hanging
 * indent — the one thing the brief lets this transcript do to a value's shape.
 * The tests use this to prove the wrap is only a wrap: the lines joined back up
 * have to equal the walk pack's own words, and the `reply` line has to equal
 * what `ask.ts` produces, to the character.
 */
export const joinWrapped = texts => texts.map(t => String(t).trim()).join(" ");

/* ------------------------------------------------------------- the checks */

/** The demo key and the argument shape that would carry one onto the screen. */
const FORBIDDEN = [
  { what: "the pack's demo API key", re: /lp_live[_a-z0-9]*/i },
  { what: "a `secrets` argument, which is how a key reaches the screen", re: /"secrets"/ },
  // The marker is a note to the owner on the block, not a word on the terminal.
  { what: "a TODO-COPY marker in the copy itself, where it would be filmed", re: /TODO-COPY/ },
];

/** The marker a block carries while its prose is still waiting on the owner's words. */
export const TODO = "TODO-COPY";
/** Every block whose copy is still the implementer's, in transcript order. */
export const awaitingCopy = transcript => (transcript.blocks ?? []).filter(b => b.todo === TODO).map(b => b.name);

/**
 * What is wrong with a transcript, as a list of sentences. Empty is good.
 *
 * `beats` is the recorder's own beat list, so a block filed under a beat that
 * is not played — or a beat with nothing to print that was supposed to have
 * something — is caught without a camera. `cols` is the terminal's width: a
 * line wider than that soft-wraps at an arbitrary place in the middle of a
 * JSON value, which is the one formatting accident nobody would notice until
 * they watched the footage.
 */
export function transcriptIssues(transcript, { beats = [], cols = Infinity, theme, vars = {} } = {}) {
  const bad = [];
  const names = new Set();
  const beatNames = new Set(beats.map(b => (typeof b === "string" ? b : b.name)));
  for (const b of transcript.blocks ?? []) {
    const at = `block ${b.name ?? "(unnamed)"}`;
    if (!b.name) bad.push("a block has no name");
    else if (names.has(b.name)) bad.push(`${at} is named twice`);
    else names.add(b.name);
    if (!beatNames.has(b.beat)) bad.push(`${at} is filed under beat ${JSON.stringify(b.beat)}, which the take does not play`);
    if (b.kind !== "print" && b.kind !== "type") bad.push(`${at} is kind ${JSON.stringify(b.kind)}, not print or type`);
    if (b.todo !== undefined && b.todo !== TODO) bad.push(`${at} carries todo ${JSON.stringify(b.todo)}, which is not ${TODO}`);
    const texts = b.kind === "type" ? [b.text] : (b.lines ?? []).map(l => l.text);
    if (b.kind === "print" && !(b.lines ?? []).length) bad.push(`${at} prints nothing`);
    for (const l of b.lines ?? []) {
      if (theme && theme.prefixes[l.tone] === undefined) bad.push(`${at} uses tone ${JSON.stringify(l.tone)}, which the theme has no prefix for`);
    }
    for (const t of texts) {
      for (const f of FORBIDDEN) if (f.re.test(String(t))) bad.push(`${at} carries ${f.what}`);
    }
    if (theme && b.kind === "print") {
      let rendered;
      try { rendered = renderLines(b, vars, theme); } catch (e) { bad.push(`${at} will not render: ${e.message}`); }
      for (const l of rendered ?? []) {
        if ([...l.text].length > cols) bad.push(`${at} has a ${[...l.text].length}-column line, wider than the terminal's ${cols}`);
      }
    }
  }
  return bad;
}
