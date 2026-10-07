---
name: walk-author
description: Use when writing a walkthrough for a person to walk in the sidewalk side panel (sidewalk MCP tools walk_open / walk_add_items / walk_wait / walk_read / walk_close) — how to pick item kinds, write items in plain words, wait for verdicts, and read them back.
---

# Writing a walk for the sidewalk pane

The same text ships as the sidewalk MCP server's instructions, so an agent that
connects has it already. This file is for projects that want it in their tree.
Change `packages/sidewalk-mcp/src/instructions.ts` and this file together.

## First — the four lines the loop cannot run without

Some clients cut long instructions short, so these come before everything else.

- Nothing can push to you. `walk_wait` is how you hear the person:
  `walk_wait(after: cursor, timeoutMs: 0)` whenever other work you are running
  reports back, `walk_wait(…, timeoutMs: 280000)` when nothing else is running, looping on the
  returned cursor. An empty wait is not news: call it again and say nothing.
  Never stop listening because of silence.
- An ask is answered **in the pane**: reply with a new `info` or `question`
  item with `supersedes` set to the asked item's id — that is what marks the
  ask answered. The person is reading the pane, not your chat. An answer that is only in chat
  never reaches them.
- A verdict's `text` is the person's words verbatim: quote it, never paraphrase
  or trim it.
- An `undo` verdict means unwind what you built on the answer it retracts, and
  expect a fresh one on the same item.

## The loop

`walk_open` once the build is live (one walk per build), with a **brief**:
two or three sentences the person reads first, under the walk's title — what
this build is, where to start, anything to know before the first card;
reopening with a new brief replaces it → `walk_add_items` →
`walk_wait(after: cursor, timeoutMs: 0)` whenever other work you are running
reports back, and `walk_wait(…, timeoutMs: 280000)` when nothing else is
running (loop on the returned cursor) → `walk_close` with a summary. Nothing
can push to you: `walk_wait` is how you hear the person. Append items as work
lands; do not hold the whole list back until everything is ready.

An empty `walk_wait` is not news: call it again with the same cursor and say
nothing. Never stop listening because of silence — the person walks at their
own pace, and a walk nobody is listening to is a walk whose verdicts wait for
nobody.

## Item kinds

- **sequence** — ONE page, 2–8 steps done in order, each step `do` → `see`.
  Use it whenever the person presses, then tries something, then tries
  something else on the same page: a lock that is set then tested then
  cleared, a control that is dragged then tapped then reloaded. The person
  ticks each step as it works and gives one verdict for the card; the
  verdict's `steps` tells you which were ticked, so an issue says where it
  broke. Optional `pass`: the one line that makes the whole thing a pass. Do
  not write one look card per step of one path.
- **look** — one thing to judge on one page: `url`, `do` (what they do),
  `see` (what they should see), `pass` (the one line that makes it a pass).
- **question** — a decision: `title` + 2–4 `options`, the recommended option
  first (the pane tags it). A question the person can answer in ten seconds is
  a title and its options, nothing else — that is the default. The sheet
  sections (`eli5`, `proposal`, `why`, `downsides`, `facts`, `recommendation`,
  `costIfWrong`) are for a decision that is genuinely big, and every one you
  fill needs a reason. Investigate before asking; `facts` is where that work
  goes.
- **info** — a note; the person dismisses it. Use it to say a piece of work landed, or
  to answer an ask. Not for orientation: that is the walk's brief.

## Writing items

- `url` is the exact page the item lives on, not the site root.
- `expect` preconditions (`url` regex / `present` css / `text` css +
  equals|contains) keep a not-ready page off the screen: the pane files a
  `blocked` verdict itself, naming what failed, instead of showing a broken
  item. A page that never answers files nothing. A `css` or `url` string the
  browser refuses files a `blocked` verdict carrying the browser's message, so
  a typo in one comes back to you instead of going quiet. What a `text` expect
  reports back — `seen`, and the `buildId` on every verdict — is cut off at 300
  characters.
- `target` (`{ text }` / `{ css }` / `{ walkId }`) outlines the thing to look
  at after Go.
- `group` is the feature or workstream the item belongs to; cards are grouped
  under it. The pane shows the newest group at the top, so the first group you
  add ends up at the bottom as more land — nothing you name a group changes
  that. "Read this first" goes in the walk's brief, never in a leading info
  card.
- Plain words, written for the person: what they do, what they should see,
  what makes it a pass. No finding codes, no internal names, no jargon. One
  idea per line.
- `secrets: [{label, value}]` (max 4) on a look, sequence or info item puts a
  Copy button on the card; the person copies the value themselves. Values are
  held in the daemon's memory, never written to its record, never echoed back
  in `walk_read`, and gone after a daemon restart (re-add the item).
  The daemon has a token, not a login. It hands a value only to a caller that has its token. What can still read a value is a program that can read the person's files. Demo keys and test accounts only, never a production credential. Never put a secret in do/see/pass text.
- When you must not hold the value yourself, name a file instead:
  `{label, file: "operator-key.txt"}` — a bare filename, no path. The daemon
  reads it from its own `secrets/` folder under its data dir, and reads only a
  regular file of at most 64 KB (the reason and the folder are in the error if
  it will not: tell the person what to do).
  The value does not pass through you. On a card that carries secrets the pane reports page text as its length, so a text expect's seen, buildId and the console tail come back as "(redacted, 24 chars)". On a card that carries a secret, the answer's page URL is cut to its origin and path. The screenshot is the exception: it is a picture of the site and shows whatever the site shows after the paste. Say to paste into a password field, or to turn screenshots down in the gear. A file secret survives a daemon restart.
- Reply to an `ask` with a new info or question item, `supersedes` set to the
  asked item's id: that is what marks the ask answered (`walk_read` lists the
  ones still open under `openAsks`). A `supersedes` naming anything but an item
  with an open ask is refused, and the refusal lists the walk's open asks.
  `walk_withdraw` only when an
  item was wrong, not when a page is not ready — `expect` handles that.

## Reading verdicts

- `text` is the person's words verbatim: quote it, never paraphrase or trim.
- Kinds: `pass`, `pass-note`, `issue`, `skip`, `decision` (with `option`),
  `dismiss`, `ask`, `undo` (unwind what was built on that decision; a fresh
  decision follows), `blocked` (the pane's own, not the person's words).
- `issue` verdicts carry `screenshotPath` (a file you can read), the page
  `url`, `buildId` when an expect read one, and the last 20 console
  errors/warnings.
- `screenshotError` starting `off:` means the person has screenshots turned
  down in the pane's settings, not that capture failed.
- The latest non-blocked verdict on an item is the one that counts; an `undo`
  after a `decision` means the item is unanswered again.
