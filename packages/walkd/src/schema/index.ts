import { z } from "zod";

export const targetSchema = z.union([
  z.object({ css: z.string().min(1) }),
  z.object({ text: z.string().min(1) }),
  z.object({ walkId: z.string().min(1) }),
]);
export type Target = z.infer<typeof targetSchema>;

export const expectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), matches: z.string().min(1) }),
  z.object({ kind: z.literal("present"), css: z.string().min(1) }),
  z.object({
    kind: z.literal("text"), css: z.string().min(1), attr: z.string().optional(),
    equals: z.string().optional(), contains: z.string().optional(),
  }),
]);
export type Expect = z.infer<typeof expectSchema>;

const itemBase = {
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  owner: z.string().min(1),
  title: z.string().min(1),
  group: z.string().optional(),
  supersedes: z.string().optional(),
};

/**
 * A value the person has to paste somewhere — a licence key, a test account's
 * password, a token. On an early walk, a question card said "the key is
 * copied to your clipboard right now" and it was not. The pane already has his
 * hand on a button, so the card carries a Copy button and he presses it,
 * instead of an agent claiming to have done something no agent can do.
 *
 * The value is held in the daemon's memory, never written to its record, never
 * handed back to an agent (store.ts), never in the pane's DOM (render.ts). The
 * card shows a fixed run of dots. What that is not is a secrets manager: the
 * daemon has a token and not a login, so what can still ask it for a value is a
 * program that can read this user's files — the token is one of them. Demo keys
 * and test accounts only.
 */
/**
 * Two ways to give a secret. `value`: the agent has it and passes it. `file`:
 * the agent must not have it (on an early walk, the agent's own permission rules
 * refused to read the operator key into its conversation, rightly), so it
 * names a file and the daemon reads the value itself out of ITS OWN
 * `secrets/` folder under the data dir. A bare filename only — no path, no
 * `..` — so the schema never accepts a path. It does not stop an agent that
 * already has a shell: that agent could read the file anyway, and the rule is
 * for an agent that is refused the value, which is refused the folder too. What
 * the name may resolve to is the daemon's half of the rule (store.ts: a regular
 * file, 64 KB, no symlink), because the schema can only see the name.
 */
export const secretSchema = z.union([
  z.object({ label: z.string().min(1).max(60), value: z.string().min(1).max(4096) }),
  z.object({ label: z.string().min(1).max(60), file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/) }),
]);
export type Secret = z.infer<typeof secretSchema>;
/** Four is the cap: a card with five things to paste is a walk, not a step. */
const secrets = z.array(secretSchema).max(4).optional();
/**
 * A secret as it sits on disk or leaves for an agent — the label and the file
 * name may survive, the value never does. `question` items take no secrets at
 * all: a decision is not a thing you paste.
 */
export type StoredSecret = { label: string; value?: string; file?: string };

export const lookInputSchema = z.object({
  ...itemBase, kind: z.literal("look"),
  // A page a browser will actually open, and nothing else. `z.url()` on its own
  // takes `javascript:`, `data:` and `chrome://` — an item whose url is a
  // script is one the pane would refuse to link and Go could not navigate to,
  // so it is refused here, where the agent gets told why.
  url: z.url({ protocol: /^https?$/ }), target: targetSchema.optional(),
  do: z.string().min(1), see: z.string().min(1), pass: z.string().min(1),
  expect: z.array(expectSchema).default([]), secrets,
});
/**
 * Only the choice is required. The owner, 2026-09-17: "we'd only utilize the
 * sections that are filled in and needed … maybe if the decision was very
 * complex and massive then that'd be a great breakdown." So the decision-sheet
 * block is a breakdown a big question earns, not a form every question fills.
 */
export const questionInputSchema = z.object({
  ...itemBase, kind: z.literal("question"),
  eli5: z.string().min(1).optional(), proposal: z.string().min(1).optional(), why: z.string().min(1).optional(),
  downsides: z.array(z.string()).max(4).optional(), facts: z.string().min(1).optional(),
  recommendation: z.string().min(1).optional(), options: z.array(z.string().min(1)).min(2).max(4),
  costIfWrong: z.string().min(1).optional(),
});
export const infoInputSchema = z.object({ ...itemBase, kind: z.literal("info"), body: z.string().min(1), secrets });
/**
 * One page, several things to do on it in order. The owner, 2026-09-17, looking at
 * four look cards for one path: "press go does it work? Try this now what does
 * it do? Try this now.... it makes it way less mentally taxing in that path,
 * without losing any quality bc you can still write in the field and hit the
 * buttons for the grouping." One card: the steps, a tick per step as it works,
 * one note box, one verdict — which carries the ticks, so an Issue says where
 * it broke without the person typing "step 3".
 */
export const stepSchema = z.object({ do: z.string().min(1), see: z.string().min(1) });
export type Step = z.infer<typeof stepSchema>;
export const sequenceInputSchema = z.object({
  ...itemBase, kind: z.literal("sequence"),
  url: z.url({ protocol: /^https?$/ }), target: targetSchema.optional(),
  steps: z.array(stepSchema).min(2).max(8),
  pass: z.string().min(1).optional(),
  expect: z.array(expectSchema).default([]), secrets,
});

export const itemInputSchema = z.discriminatedUnion("kind", [lookInputSchema, sequenceInputSchema, questionInputSchema, infoInputSchema]);
export type ItemInput = z.infer<typeof itemInputSchema>;

const itemStamp = z.object({
  seq: z.number().int().positive(), addedAt: z.string(),
  withdrawnAt: z.string().optional(), withdrawReason: z.string().optional(),
});
export type Item = ItemInput & z.infer<typeof itemStamp>;

export const verdictKinds = ["pass", "pass-note", "issue", "skip", "decision", "dismiss", "blocked", "undo", "ask"] as const;
export const consoleEntrySchema = z.object({ level: z.enum(["error", "warn"]), text: z.string(), at: z.string() });
export type ConsoleEntry = z.infer<typeof consoleEntrySchema>;
export const verdictContextSchema = z.object({
  url: z.string(), buildId: z.string().optional(),
  viewport: z.tuple([z.number(), z.number()]),
  console: z.array(consoleEntrySchema).max(20), userAgent: z.string(),
  screenshotBase64: z.string().optional(), screenshotError: z.string().optional(),
});
export const verdictInputSchema = z.object({
  itemId: z.string().min(1), kind: z.enum(verdictKinds), text: z.string(),
  // The pane's Ask checkbox is gone — `ask` is now a verdict kind. The field
  // stays so a verdict written before 0.1.1 still parses; nothing sets it, and
  // it no longer defaults to `false`: an early agent session was
  // handed `kind: "ask"` with `ask: false` beside it and read the pair as a
  // contradiction. A verdict that carries no `ask` key says nothing to argue
  // with.
  option: z.string().optional(), ask: z.boolean().optional(), nonce: z.string().min(1),
  // A sequence's verdict: which steps the person ticked, in step order. Absent
  // on every other kind of item.
  steps: z.array(z.boolean()).max(8).optional(),
  context: verdictContextSchema,
});
/** What a client sends. `ask` is optional, and stays absent when it is absent. */
export type VerdictInput = z.input<typeof verdictInputSchema>;
type VerdictParsed = z.infer<typeof verdictInputSchema>;
export type Verdict = Omit<VerdictParsed, "nonce" | "context"> & {
  seq: number; at: string; nonce: string;
  /** On an `undo`: the seq of the verdict it takes back. */
  retracts?: number;
  /**
   * On an `undo`: the verdict it takes back had not been handed to any agent
   * yet, so the daemon hides both from agent reads — taken back before anyone
   * saw it, as if never filed. The pane's own reads still see both.
   */
  quiet?: boolean;
  context: Omit<z.infer<typeof verdictContextSchema>, "screenshotBase64"> & { screenshot: string | null };
};

/**
 * What stands in for page text on a verdict about an item that carries secrets
 * (secrets review).
 *
 * The thing F5 is about: an agent refused a value can ask for it back through
 * the page. `expect: [{kind:"text", css:"#keyshown", equals:"x"}]` fails, and
 * the `blocked` verdict's line says what was *seen* — the page's rendering of
 * what the person just pasted. `buildId` is that same read on every verdict,
 * pass included, and the console tail is the same channel with less precision.
 *
 * The length survives, because the length of what a page is showing is a fact
 * about the page and not the value: "wanted fac3493f, saw 24 chars" still tells
 * an agent that its expectation failed and roughly how. The pane and the daemon
 * share this one function so they cannot say it two different ways.
 */
export const redacted = (n: number): string => `(redacted, ${n} chars)`;
const IS_REDACTED = /^\(redacted, \d+ chars\)$/;

/**
 * The `saw "…"` clause of a `blocked` verdict's line, redacted — the daemon's
 * backstop for a pane that did not redact it (an older extension, or anything
 * else posting verdicts). Idempotent: a clause the pane already redacted is left
 * exactly as it is, because redacting it twice would report the length of the
 * marker, and that would be a lie about the page.
 */
export function redactSaw(line: string): string {
  return line.replace(/(, saw ")(.*)(")$/s, (whole, head: string, seen: string, tail: string) =>
    (IS_REDACTED.test(seen) ? whole : `${head}${redacted(seen.length)}${tail}`));
}

/**
 * A verdict's page url with the query string and the fragment taken off — the
 * last page-read field a verdict about a secret-bearing card still carried
 * whole (found in review). A value the person pastes that the page then
 * puts in `?key=…` or `#token=…` was landing in verdicts.jsonl, which is
 * forever, and in the agent's hands.
 *
 * What is left is the origin and the path: enough to say which page the verdict
 * is about, which is the whole reason the field is there. Userinfo
 * (`https://user:pass@host/`) goes with it.
 *
 * The pane and the daemon share this one function so they cannot disagree about
 * where the cut is, and it is idempotent: a url already cut has nothing left to
 * cut. A string that is not a url it can parse — the empty string a verdict with
 * no tab carries, a `chrome://` page, an opaque scheme — keeps whatever stands
 * before the first `?` or `#`, because the cut matters more than the shape.
 */
export function originAndPath(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.origin !== "null") return u.origin + u.pathname;
  } catch { /* not a url this runtime can parse: fall through to the plain cut */ }
  return raw.split(/[?#]/, 1)[0];
}

export const walkInputSchema = z.object({
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), title: z.string().min(1),
  buildRef: z.string().min(1), id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  /**
   * Two or three sentences the person reads first, under the walk's title:
   * what this build is, where to start, anything to know before the first
   * card. It never moves — the pane orders groups newest first, so a
   * "read this first" info card sinks as lanes land (the owner, 2026-09-20,
   * watching one do exactly that). Reopening with a new brief replaces it.
   */
  brief: z.string().min(1).max(1000).optional(),
});
export type WalkInput = z.infer<typeof walkInputSchema>;
export type Walk = {
  id: string; project: string; title: string; buildRef: string; brief?: string; openedAt: string; closedAt?: string; summary?: string;
  /**
   * The highest verdict seq an agent has been handed (by walk_wait / walk_read,
   * never by the pane's own reads). A verdict above it can be taken back
   * quietly; one at or below it is in the agent's hands, and taking it back
   * tells the agent to unwind.
   */
  delivered?: number;
};

export function toJsonSchema() {
  return {
    item: z.toJSONSchema(itemInputSchema),
    verdict: z.toJSONSchema(verdictInputSchema),
    walk: z.toJSONSchema(walkInputSchema),
  };
}
