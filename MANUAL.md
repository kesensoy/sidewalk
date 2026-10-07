# sidewalk

An AI-authored walkthrough of a running web app, shown in a Chrome side panel
next to the live site, with the human's verdicts flowing back to the agent as
data.

Three pieces: **walkd**, a local daemon that owns a walk's two append-only
streams; **sidewalk-mcp**, a thin stdio MCP server each agent session launches to
drive it; and the **sidewalk** extension, the side panel the person actually
uses. This file is how to run it.

## 1. Install

```bash
fnm use 22
npx -y npm@11 install
npm run build
```

Install with **npm 11** (`npx -y npm@11 install`), not whatever npm ships with
your Node — that is what this tree's `package-lock.json` was written by, and it
is what every dependency change here should be run through, so the lockfile does
not churn between contributors. npm 11 holds back install scripts and says so
loudly at the end; nothing here needs them (esbuild ships its platform binary as
its own package), so the warning is noise.

`npm run build` type-checks the extension, bundles it with esbuild, and compiles
the three Node packages. It has to run before `npm test`, because `sidewalk-mcp`
imports `walkd` from `dist/`.

Then load the extension:

1. open `chrome://extensions`, turn on **Developer mode**;
2. **Load unpacked** → `packages/extension/dist`;
3. pin the toolbar icon. Clicking it opens the pane.

Nothing here ever uses Chrome's remote-debugging port 9222: leave 9222 to the person's own tools.

**On Windows** the same steps work from PowerShell or cmd with Node 22
installed (`fnm use 22` or any installer): `npx -y npm@11 install`, `npm run
build`, `npm start`, then Load unpacked. The daemon's data goes under
`%LOCALAPPDATA%\walkd\`. The e2e needs `npx playwright install chromium`
first; nothing else is platform-specific.

## 2. Run the daemon

```bash
npm start                                   # = node packages/walkd/bin/walkd.js serve
node packages/walkd/bin/walkd.js start      # the same daemon, detached; prints its pid
node packages/walkd/bin/walkd.js status     # port, pid, data dir, healthy or not
node packages/walkd/bin/walkd.js stop       # SIGTERM, and safe to run twice
```

`serve` holds the terminal; `start` hands it back. `start` spawns the same
daemon detached, waits for it to answer `/health`, prints its pid, and sends the
daemon's own output to `<data dir>/walkd.log`. `status` and `stop` find it
through the same state file either way. `sidewalk.sh/install` runs `start`, and
so does anyone who does not want a window parked on a daemon.

It binds `127.0.0.1:8760` and nothing else. A second `serve` refuses rather than
fighting for the port: it prints `walkd: already running on port 8760` and
exits 1. It says that only about its own daemon. `/health` carries the daemon's
pid and start time, the state file holds the same two, and the CLI compares
them. When something else holds the port, `serve` prints
`walkd: 127.0.0.1:8760 is already in use by another program.` and exits 1.
`stop` is idempotent: with no daemon running it says so and exits 0. It never
signals a pid the state file merely claims. It checks `/health` first, compares
the pid, and removes a stale state file instead of killing whatever inherited
that pid. When the answer on the port is not its daemon it signals nothing and
says `walkd: something else answers on 8760; not stopping it.` `status` has the
same three answers: the daemon, nothing, or something else on the port.

Data lives outside every project repo, at
`~/Library/Application Support/walkd/` (macOS), `%LOCALAPPDATA%\walkd\`
(Windows) or `$XDG_DATA_HOME/walkd/` elsewhere. The state file sits under the data
directory on macOS and Windows; elsewhere it sits under `$XDG_STATE_HOME/walkd/`,
which is the one place the two part. `--data-dir` and `--state-dir` move them, which
is what the tests do.

**The token.** walkd makes a random token the first time it starts and keeps
it. It is in `<data dir>/token` (mode 0600) and it stays there when the daemon
stops, so the next one serves the same token and the panel needs no new paste.
A restart changes nothing. `walkd token --rotate` is the one thing that
replaces it. A token file walkd cannot vouch for is replaced, with one line on
stderr saying why: not a regular file, not 0600, not this user's, or not
holding one token of the form walkd mints. Every request and both SSE streams
send the token as `Authorization: Bearer <token>`. Only `GET /health` is open;
it is how a client finds out a daemon is there at all. It says `auth: "token"`,
so a client can tell a daemon that wants one from a daemon that does not. A
missing or wrong token is a `401` that names the file.

Who gets it, and how. `sidewalk-mcp` reads the file itself. It runs on the same
machine by design, the state file names the data dir, and it reads the file on
every connect because the file is the authority. On a 401 it re-reads the file
once and tries the call again, so a rotate under a live agent session costs
that session one retry, not every tool call until the person reconnects the
MCP server. The extension cannot read files, so the person pastes the token
into the pane's gear, where it is kept in `chrome.storage.local` as
**`walkd:token`** beside the port. That is one paste, because the daemon keeps
the token. A daemon that mints one puts it on the clipboard itself, so on a
first start the paste is all that is left. `--no-copy` turns that off; the e2e and the demo recorder pass it.

```bash
node packages/walkd/bin/walkd.js token            # prints it
node packages/walkd/bin/walkd.js token --copy     # onto the clipboard (pbcopy / clip / wl-copy / xclip / xsel)
node packages/walkd/bin/walkd.js token --rotate   # a new one, written and copied; restart the daemon to serve it
```

A pane with no token, or an old one, says *walkd on 8760 needs the token* on its
connection line and offers `npx -y sidewalk-walkd token --copy` above the cards, with the
gear already open at the field. It does not climb a reconnect ladder for it:
waiting changes nothing, and saving the token in the gear reconnects at once. A
verdict clicked meanwhile is not lost. A 401 is not a refusal the queue buries,
so the verdict goes as soon as the token lands. **Save in the gear is a check**:
it stores the token, waits for what walkd says about it, and says that — *Checking…*,
then *Connected.* in green only once the daemon has let the pane in, *walkd refused
this token.* in red on a 401, or *No walkd on 8760.* when nothing is answering there.
**A daemon that restarts serves the same token**, so the pane does not ask again.
After `walkd token --rotate` it does.

`WALKD_TOKEN` pins it at both ends: the daemon serves that token instead of a
fresh one, and a client sends it instead of reading the file. That is for a
setup where the client cannot see the daemon's data dir at all — a container,
another user. Pin a value nobody can guess: walkd serves whatever the variable
says and checks nothing about it. Nothing else should set it.

What the token is, and is not. It is what stops every *other* program on this
machine from reading a walk, or a card's secret, off loopback, as long as walkd
holds the port (§5 says what happens when something else takes it first). It is
not a login, and it is not transport security. A program that can read your
user's files can read the token, and then the walk.

A fresh verdict is held back from every agent read for a **grace window**,
10 seconds by default: `--grace-ms N` changes it, `0` switches it off. That
window is the person's free Undo (§4).

The extension looks for the daemon on 8760 unless this browser has been told
otherwise: it reads `chrome.storage.local`'s **`walkd:port`** (a number) when it
starts and again whenever it changes, so a second daemon can be walked beside
the one you already have running. That is how the e2e suite gets its own daemon
on 8761 without going near yours. To point a browser at another port by hand:
`chrome://extensions` → sidewalk → *service worker* →
`chrome.storage.local.set({"walkd:port": 8761})`. Anything stored there that is
not a whole port number is ignored and 8760 is used, so a bad value can never
leave the pane with nowhere to connect.

A port no daemon has ever answered on, in this profile, gets a different
empty state: the pane names the missing piece and offers the install command
with a Copy button. That is what a Web Store install looks like before the
MCP server is added. Once a daemon has answered on that port, the pane never
shows the note for it again — a daemon that is down mid-walk gets
*Looking for walkd on 8760* instead, which is right for a restart.

One connection carries the whole daemon. `GET /events` streams every walk's
events — `item`, `withdraw`, `close`, `delivered`, plus `open` when a walk is
opened or reopened — each frame naming its walk, and the extension holds exactly
one of them for as long as the daemon answers. That is what keeps the pane
working past six open walks: a browser gives one origin six connections, and a
client taking one stream per walk spent them all on streams and then queued its
own health checks, reads and verdict posts behind them. The per-walk
`GET /walks/:id/events` stream is unchanged and still there for other clients.
Both ping every 15 s.

You rarely start it by hand: `sidewalk-mcp` starts one if none is answering.

**When the pane and the daemon are not the same release.** Chrome updates
the extension on its own schedule; the daemon changes only when somebody
restarts it, and `sidewalk-mcp` will not replace one that is answering. So the
two drift, in either direction, and the pane says so under its header:
*This panel is X and walkd on port 8760 is Y*, with the remedy. The remedy
is both halves: stop the daemon (`npx -y sidewalk-walkd stop`, or `node
packages/walkd/bin/walkd.js stop` from a checkout) **and** reconnect the
agent's MCP server (`/mcp` in Claude Code) — the long-lived MCP process
holds the old `walkd` and would start it again. The notice is a warning,
not a gate: a stale daemon still serves everything it understands.

The daemon reads its version from its own `package.json`; `npm test` checks
that the three packages and the manifest agree, and `node scripts/version.mjs
set X.Y.Z` is the one edit a release makes. `WALKD_ADVERTISE_VERSION` makes
a daemon claim another version on `/health` — the e2e uses it to see the
notice; nothing else should.

## 3. Add it to an agent

The packages are on npm, so the one-liner is the whole install on the
agent's side, and it is what the pane's first-run note offers to copy:

    claude mcp add --scope user sidewalk -- npx -y sidewalk-mcp

`npx -y sidewalk-mcp` fetches `sidewalk-mcp` (and `sidewalk-walkd` with it),
starts a daemon on 8760 if none is answering, and serves the six
tools over stdio. Node 22 or newer. A session that was already open needs
`/mcp` reconnect to see the tools.

`https://sidewalk.sh/install` is the same install as one line —
`curl -fsSL https://sidewalk.sh/install | sh` installs `sidewalk-walkd` and
`sidewalk-mcp` globally with npm, adds the MCP server when `claude` is on PATH,
and prints what is left. The script is `site/install`; it never uses sudo.

**Or as a Claude Code plugin.** `claude plugin marketplace add kesensoy/sidewalk`
then `claude plugin install sidewalk@sidewalk` installs the same server —
`.claude-plugin/plugin.json` runs `npx -y sidewalk-mcp@<this release>`, with the
pin held by `scripts/version.mjs` — and the walk-author skill with it, as
`/sidewalk:walk-author`. The repository is both the marketplace and the plugin.
Both of these wait on the repository being public.

From a checkout, point the agent at the built entry instead. With Claude
Code the one-liner is `claude mcp add --scope user sidewalk -- node <absolute
path to>/packages/sidewalk-mcp/bin/sidewalk-mcp.js` (on Windows the path is the
usual `C:\...\sidewalk-mcp.js`). The JSON form:

```json
{
  "mcpServers": {
    "sidewalk": {
      "command": "node",
      "args": ["/absolute/path/to/sidewalk/packages/sidewalk-mcp/bin/sidewalk-mcp.js"]
    }
  }
}
```

Six tools:

| Tool | What it does |
|---|---|
| `walk_open` | Open (or reopen) a walk. Returns `{id, …}`. Once per build, once it is live. `brief`: two or three sentences the person reads first, under the title; a reopen with a new brief replaces it. |
| `walk_add_items` | Append items. `sequence` = one page + 2–8 ordered steps of do → see; `look` = URL + do/see/pass; `question` = a title and 2–4 options, plus whichever decision-sheet sections the question earns; `info` = a note. All take `expect` preconditions, `group` and `target`. Returns `{seqs}`. |
| `walk_withdraw` | Withdraw an item. It stays in the record, struck through with the reason. |
| `walk_wait` | Block until new verdicts arrive after cursor `after`, or `timeoutMs` elapses. Returns `{verdicts, cursor, closed}`. |
| `walk_read` | The walk header, all items, and verdicts after `after` (default 0 = all), plus `openAsks`: one row — `{item, seq, text}` — per question the person has asked that nothing has answered yet. |
| `walk_close` | Close the walk with a summary. Waiters return `closed: true`; no more items or verdicts. |

`walk_wait`'s `timeoutMs` is capped at **280000** (≈4.6 min). The cap is not
taste: the `fetch` in every Node client aborts a request whose headers have not
arrived within 300 s, so a longer wait would hand the agent a transport error
instead of an empty result. To wait longer than that, **loop** — call it again
with the same cursor. `timeoutMs: 0` drains what is already there and returns
immediately, which is the call to make after every subagent notification.

## 4. A walk, start to finish

**MCP cannot push to an agent.** Nothing wakes a session because a person
clicked something. `walk_wait` is the push: a call that blocks until there is
something to read.

```jsonc
// The Lamppost demo's own walk, which `demo/walk.json` holds in full.
// 1. open
walk_open { "project": "lamppost", "title": "Lamppost 2.4", "buildRef": "lp-24",
            "brief": "Lamppost is a status page. This build adds the maintenance lock and the API key page. Start on the home page; the lamps should all be green." }
// → { "id": "lamppost-2-4", ... }

// 2. add the pack
walk_add_items { "walk": "lamppost-2-4", "items": [
  {
    "id": "lp-lamps", "kind": "look", "owner": "demo",
    "group": "home and lamps",
    "title": "The lamps are green",
    "url": "https://lamppost.example/",
    "target": { "walkId": "lamps" },
    "do":   "Look at the row of lamps.",
    "see":  "Five lamps, all green, each with its service name under it.",
    "pass": "Every lamp is green and none is missing a name.",
    "expect": [
      { "kind": "url", "matches": "^https://lamppost\\.example/?$" },
      { "kind": "text", "css": "meta[name=build]", "attr": "content", "equals": "lp-24" },
      { "kind": "present", "css": "[data-walk=lamps]" }
    ]
  },
  {
    "id": "lp-tiers", "kind": "question", "owner": "demo",
    "title": "What do we call the two paid tiers?",
    "options": ["Lit / Bright", "Pro / Team", "Basic / Plus"]
  }
]}

// 3. while the work goes on: drain after every subagent notification
walk_wait { "walk": "lamppost-2-4", "after": 12, "timeoutMs": 0 }
// only when nothing else is running, block:
walk_wait { "walk": "lamppost-2-4", "after": 12, "timeoutMs": 280000 }

// 4. close
walk_close { "walk": "lamppost-2-4", "summary": "7 items, 1 issue, 1 decision" }
```

Verdicts come back with the human's words verbatim, the console tail inline, and
the screenshot as a **file path** for the agent to read (`screenshotPath`). What
the extension sends over the wire is base64 JPEG inside the verdict JSON, capped
at 8 MB per body — the spec's §2.2 originally said multipart; this is the
amendment, and it is one code path with no multipart parser.

### What the person sees, and when

The walk's brief, when the agent wrote one, sits under the title and never
moves; groups of cards below it are newest first.

- While the pane is **open** it holds a port to the service worker and pings it
  every 20 s, which keeps the worker awake; new items land over SSE in about as
  long as the network takes.
- While the pane is **closed** the worker is allowed to sleep. It is woken by a
  30 s alarm, so a new item can take **up to 30 seconds** to raise the toolbar
  badge. That is the worst case worth knowing when you add an item and then
  message the person about it.

The pane's look is the **Kerb** design language, settled on 2026-09-18 over
three rounds with the owner. The things worth knowing as an agent:

- The top line reads *Connected to walkd on 8760* with a green dot that
  breathes, or *Looking for walkd on 8760* with a grey one, then the queued
  and refused counts. The typeface is Atkinson Hyperlegible, bundled.
- Every card has a **kerb**, a 4 px edge on its left, and the kerb is the
  card's state: blue and breathing on the **current** card (the one whose Go
  was pressed last; there is no order to a walk, so nothing is current until
  a Go), yellow and breathing on a card waiting on an answer from the agent,
  orange on a blocked card, green / red / grey / ink on an answered
  card the agent has not read yet, nothing on a fresh one.
- An answered card is **one line**: the verdict, the title, then the person's
  words in muted (on a decision the option leads), with Undo at the right end.
  It leaves the list at once for the **ledge** (§"Answering an item").
- Once the agent has read a verdict, its card drops into the **Done** shelf
  at the bottom of the walk, a gutter mark in place of the word: tick, cross,
  chevron, dot, dash, or a struck dash for a withdrawn item. What the person
  can still act on stays above, so the next item is near the top. A shelf row
  opens out on hover or focus to show its full title and the words it was
  answered with.
- With nothing to walk the pane says so: *Nothing to see here yet. When an
  agent opens a walk, it shows up on its own.*, and a walk with nothing left
  reads *Nothing left on this walk. Anything new lands here on its own.*

### Answering an item

A `look` card carries its page as a link on its top row, with **Go** beside
it — the link opens the page in a new tab without spending Go, which
navigates the tab being walked, runs the item's preconditions and outlines
the target — then do/see/pass, a note box, and five buttons: **Pass**,
**Pass + note**, **Issue**, **Skip**, **Ask**. A `sequence` card has the same
top row, then its steps, each with a tick the person presses as it works, an
optional pass line, and the same note box and buttons once; its verdict
carries which steps were ticked. A `question` card carries its sections, its
options, a note box, then **Submit** and **Ask**. A button that would mean
nothing without words is dead until there are words: Issue, Pass + note, Ask,
and Submit under *Other*.

A `blocked` card keeps its orange kerb and shows the diagnostic in one line a
person can read at a glance — *expect[2] text meta[name=build] content: wanted
"fac3493f", saw "fix-001"* — and that is also the text the agent receives.

**Ask** (verdict kind `ask`) is a question back to the agent; the note box is
the question and it is required. It does not close the card — it reads *Asked.
Waiting for the agent.* above the buttons, and the person can still answer the
item while the agent is thinking. While that line is up the card's kerb is
yellow and breathing on the current card's rhythm, with a dot of the same yellow
at the head of the line, and it goes when the line goes — when the agent's answer
lands, on the person's next answer to the card, or when the agent withdraws the
item — a blocked card's orange still outranking it. Reply with a new `info` or
`question` item with `supersedes` set to the asked item's id; that is what marks
the ask answered.

**The answer lands on the card that asked.** An `info` reply is not a card of its
own anywhere — not in its group, not on the ledge, not on the Done shelf, and
with no Dismiss to press. It is a block inside the asked card, in the place of
the waiting line: the reply's title in the card's bold, its body under it, and
several answers to one ask as several blocks in the order they were sent. The
waiting ends there. The yellow kerb and its dot go, the card's kerb returns to
whatever it would otherwise be — blue and breathing if it is the current card,
nothing if it is not, orange if a Go stopped there — and what the block carries
instead is a thin rule in the ink colour, with nothing moving, because *answered,
your move* should not read like *waiting* or like *fresh*. The card's own buttons
and note box are untouched: answering the card is still what resolves it, and the
answer stays with the verdict on the Done shelf row, which opens out on it like
every other word of the record. A `question` reply keeps its card — it has a
verdict of its own to collect — and sits directly under the card it answers.
Withdrawing a reply puts the question back: the kerb is yellow again and
`openAsks` lists the ask again. So does **asking again on the same card**: an
answer that landed before the new question is not an answer to it, so the yellow
comes back under the answers already on the card, and the agent is shown the ask
on its next read. Both halves compare the reply's `addedAt` with the ask's `at`
— the daemon stamps both — so the pane and the agent always agree about who is
waiting on whom.

The agent is told that on the verdict itself: every `ask` it is handed carries a
`reply` line naming the item and saying to answer in the pane, not in its own
chat, and `walk_read` lists every ask nothing has answered yet under `openAsks`
— so one that scrolled past in a `walk_wait` is still in front of the agent on
its next read.

There is no "ask the agent" tickbox any more. It was a modifier on four
verdicts that said nothing the note box did not; `ask` on a verdict stays in the
schema, optional, so an older verdict still parses — but nothing sets it and
nothing writes one, because `kind: "ask"` with `ask: false` beside it reads as a
contradiction.

Every answered card collapses to one line — the option for a question, the
verdict's name, the title and the person's words for the rest — with an
**Undo** at its right end, in one of two colours. The owner, on an early walk: "until the other
agent picks it up it's a free and easy click to evict it from the daemon … a
green undo that turns red when the main agent pulls it off the queue."

On Submit that line leaves the list for the **ledge**, a strip pinned to the
bottom of the pane that holds every answer the agent has not been handed yet,
newest on top, three rows before it scrolls inside itself; under each row a
2 px bar drains over the grace window below. Nothing scrolls: the card is gone
from its group, so the next one slides up into its place and the person is left
where they were standing. When the agent's read lands the row leaves the ledge
for the Done shelf, and its Undo turns red.

- **Green** while no agent has been handed the verdict. One click, no
  confirm. The daemon marks the verdict and the `undo` that retracts it
  `quiet`, and **no agent read ever returns either** — `walk_wait` and
  `walk_read` skip both, as if the answer was never filed. The stream on disk
  keeps both; the pane's own reads see both, which is how the card knows it
  is answerable again.
- **Red** once an agent has it. Undo asks inside the card first and then files
  a loud `undo` verdict, with `retracts` naming the seq it takes back. If the
  agent has held the answer for ten minutes or more, a second line under the
  question says how long — *Are you really sure? Automated work built on this
  answer across the last 42 min may be destroyed.* — and the buttons stay the
  same two.
  **Treat it as an instruction to unwind whatever you built on that answer**,
  and expect a fresh answer on the same item.

Either way the card comes back answerable with the person's words back in the
note box, the undone option still picked, and a sequence's ticks where they
were.

The green one needs time to exist: an agent blocked in `walk_wait` would
otherwise be handed a verdict the instant it landed. So the daemon holds a
fresh verdict back from every agent read for a **grace window** — 10 seconds
by default, `walkd serve --grace-ms N` to change it, 0 to switch it off —
during which it is the pane's alone; a blocked `walk_wait` wakes the moment
it matures. The e2e serves with 0. The cursor an agent gets back never runs
past a verdict still inside the window. `GET /health` carries the window as
`graceMs`, which is what the pane draws the ledge's drain bar from — a daemon
too old to say leaves the rows there with no bar under them. The daemon knows which colour to show because every agent read is a
cursor call: `delivered` on the walk header is the highest seq an agent has
been handed (by `walk_wait` or `walk_read`, never by the pane), and it moves
on the pane over SSE the moment an agent reads. In `walk_read`, an `undo`
after an answer means the item is unanswered again — the latest non-blocked
verdict on an item is the one that counts.

The pane's own text size is under the gear at the top right: **Text size**, with
`−` and `+` around the current percentage (80 to 150, default 100). Every size
in the pane is a multiple of one base, so the gear scales the whole pane. It
is per viewer, kept in `chrome.storage.local` under `walkd:ui`, and never
reaches the daemon. The pane follows Chrome's light or dark theme; there is
no toggle of its own.

Under it is **Screenshots**, with three: **Every verdict** (the default),
**Issues only**, and **Never**. The owner: "should we make post-answer screenshots
a disable-able option in settings? … or maybe a 3rd option of 'on issues
only'." The worker reads the setting when the person files a verdict, so a
change lands on the next one without a reload, and it is kept beside the text
size in `walkd:ui` — per viewer, never at the daemon. Turned down, the verdict
still carries its url, its console tail and its build id; what it carries
instead of a picture is a `screenshotError` of exactly `off: screenshots set
to never` or `off: screenshots set to issues only`, so the agent reads why
there is none rather than guessing that capture failed. An agent can tell the
two apart by the leading `off:`. The pane's own `blocked` verdicts are not
answers and are not governed by this: they always carry their picture.

### Verdicts the agent will never receive

A verdict is written to the extension's storage before it is sent, so a click is
never lost to a daemon that is down: the queue replays in click order when it
comes back, and the pane's header shows `· N queued` meanwhile.

The exception is a verdict the daemon **refuses outright** — a 400, 404 or 413.
Replaying it would never succeed and keeping it would jam every later verdict
behind it, so it is moved to `walkd:dead` in `chrome.storage.local` (last 50).

What the person sees: the header counts them, `· N refused` after the
connection line, and the card comes back to life — where its verdict line would
be it reads *Refused by the walk server. Answer this one again.*, and its
buttons and note box are there to do it with. Answering it clears both the
line and the count. What the agent sees: nothing at
all. That verdict never arrives, and the item still reads as unanswered in
`walk_read` until the person answers it again — so an item they remember
answering that has no verdict was refused, not forgotten. The daemon's reason
for each one is in the extension's service worker console
(`chrome://extensions` → sidewalk → *service worker* →
`chrome.storage.local.get("walkd:dead")`). Re-ask the item rather than guessing
what they said.

## 5. Item rules

Every agent that connects gets these rules as the server's **instructions**
(the MCP initialize handshake carries them; Claude Code shows them as server
instructions), so nothing has to be installed for an agent to write a good
walk. The same text is `skills/walk-author/SKILL.md` for projects that want it
in their tree; `packages/sidewalk-mcp/src/instructions.ts` is the source.

- `sequence` is **one page and several things to do on it in order**: `url`,
  2–8 `steps` of `do` → `see`, an optional `pass` line for the whole card.
  The owner, 2026-09-17, on four look cards for one path: "press go does it work?
  Try this now what does it do? Try this now.... it makes it way less mentally
  taxing in that path, without losing any quality bc you can still write in
  the field and hit the buttons for the grouping." The card has one link row
  with Go, the steps with a tick each, one note box and the same five buttons
  as a look. The verdict carries `steps`, one flag per step in order, so an
  Issue with two of four ticked says where it broke; the answered card reads
  *2 of 4 steps* after the words. Write a sequence for a lock that is set then
  tested then cleared, or a control that is dragged then tapped then reloaded;
  write a look for one thing on one page.
- `look` needs `url`, `do`, `see`, `pass`. `expect` is optional but is what
  keeps an item off the screen until it is actually ready.
- `question` needs a `title` and 2–4 `options`, and nothing else. The first
  option is the recommended one and the pane tags it *Recommended*.
- The decision-sheet block — `eli5`, `proposal`, `why`, `downsides`, `facts`,
  `recommendation`, `costIfWrong` — is **all optional**, and the pane renders
  only the sections that are there, in that order. One section on its own is
  the card's body and gets no label. The owner, 2026-09-17: "we'd only utilize the
  sections that are filled in and needed … we don't want to fatigue the user
  without gains/wins/decisions … maybe if the decision was very complex and
  massive then that'd be a great breakdown." So fill the sheet for a decision
  that is genuinely big, and ask a small question small. The
  investigate-before-asking rule has not moved: it is a rule about the work,
  and `facts` is where that work goes when there was any worth reporting.
- `info` needs only `title` and `body`, and takes a single Dismiss — unless it
  answers an ask, when it is a block on that card and takes no verdict at all
  (§"Answering an item").
- `secrets` — up to four `{label, value}` on a `look`, `sequence` or `info`
  item (never a `question`: a decision is not a thing you paste) — puts a row
  on the card with the label, a run of dots and a **Copy** button, and the
  person copies it themselves. On an early walk, a question card said "the
  key is copied to your clipboard right now" and it was not — no agent can
  reach a clipboard, and the pane already has his hand on a button. Once
  pressed the button reads *Copied* for two seconds and a line appears under
  the row: *On your clipboard — every app here can read it. If you paste it
  where it shows in plain text, the next verdict's screenshot will show it
  too.* Nothing clears the clipboard afterwards; emptying it means reading it
  first, which is a permission the extension does not ask for. Every app on
  this machine can read the clipboard, Universal Clipboard carries it to your
  other Apple devices, and a clipboard manager keeps it. Copy something else
  when you are done.

  **The daemon has a token, not a login.** A value is held in walkd's memory
  and never written to its record. walkd hands it out on `127.0.0.1:8760` only
  to a caller that presents the token it made when it started (§2): the pane,
  once the token has been pasted into the gear, and the agent's MCP server,
  which reads it from walkd's own data dir. That stops every other program on
  the machine, as long as walkd holds the port. It does not stop a program that
  can read your user's files, because the token is one of those files. It does
  not stop another user on the machine who binds 8760 before walkd does. The
  token proves the pane to the daemon, not the daemon to the pane, so the pane
  would hand it to whatever is listening there. walkd refuses to start beside a
  taken port and says so, and `walkd status` says when the answer on the port
  is not its daemon.

  Put demo keys, test accounts and tokens you are willing to rotate on a card.
  Do not put a production credential on one. `items.jsonl` gets the item
  with the whole `secrets` key dropped — not even the labels, because a label
  describes a live credential and a card rebuilt from disk with labels and no
  values would offer a button that copies nothing. `walk_read` and
  `walk_add_items` hand an agent the labels alone, since the agent wrote the
  values and echoing them back only puts a credential in a transcript. The
  value is never in the pane's DOM either — not as text, not in an attribute —
  so a picture of the pane never holds it. The next verdict's screenshot
  is of the **site**, and shows whatever the site shows after the paste;
  it is kept in `shots/` for good and handed to the agent. Paste into a
  password field, or turn screenshots to *Issues only* first. **After a daemon
  restart a `value` secret is gone**; add the item again if the person still
  needs it.

  What else the daemon checks, before it even looks at the token: the request is
  addressed to its own loopback port (so a page whose DNS has been flipped to
  127.0.0.1 cannot read a value, token or no token), it carries no web page's
  `Origin`, and a POST carries `application/json` — which a form and a `no-cors`
  fetch cannot send, so a page cannot put a card on the pane or file a verdict
  either.

  **A card with a secret does not report back what the page shows.** A `text`
  expect that fails says what it *saw*. `buildId` is that same reading of the
  page, on every verdict, a pass included. Either one is cut to 300
  characters (`TEXT_CAP` in `expect.ts`) on every card, secret or not, so an
  expect cannot carry a page's whole text back. The console tail is the same channel
  with less precision. So on an item that carries `secrets` all three come back
  as `(redacted, 24 chars)`. The length is a fact about the page, not about the
  value, and it keeps a `blocked` line readable: *wanted "fix-001", saw
  "(redacted, 24 chars)"*. The pane redacts before it posts, and the daemon
  does it again on the way in, because `verdicts.jsonl` is forever. On a card
  that carries a secret, the answer's page URL is cut to its origin and path.
  A page can put what was pasted into a query string or a fragment, and that
  record would be forever too. The
  screenshot is the exception, on purpose: it is a picture of the **site**, and
  whether one is taken is the person's own setting in the gear.

  **When the agent must not have the value at all**, it names a file instead:
  `{label, file: "operator-key.txt"}`. The daemon reads the value itself from
  its own folder, `<data dir>/secrets/` (`~/Library/Application Support/walkd/
  secrets/` on macOS, `%LOCALAPPDATA%\walkd\secrets\` on Windows), which
  `walkd serve` creates and prints. A bare filename only — no path, no `..` —
  so the schema never accepts a path. It does not stop an agent that already
  has a shell — that agent could read the file anyway; the rule is for an agent
  that is refused the value, and that agent is refused the folder too. What the
  daemon will read from that folder is a regular file of at most 64 KB: a
  symlink is refused rather than followed, and so are a directory and a pipe.
  The person drops the file there; the value goes file → daemon → clipboard and
  never enters a conversation. An add that names a file the daemon will not
  read is refused with the reason and the folder in the message, so the agent
  can tell the person what to do. These survive a restart (the file is still
  there); a file removed later drops its secret from the card rather than
  offering a Copy that copies nothing.

  The folder is `0700`, like the data dir and every walk's folder under it —
  no other user on the machine reads it, the streams, or the screenshots.

  **For the store listing**, the three sentences of
  this that belong in it: *"walkd answers only a caller that has the token it
  made when it started. That is a token, not a login: a program that can read
  your files can read the token, and then a walk or a value a card carries.
  Use it with demo keys and test accounts, not production credentials."*
- `expect` runs against the live page before the item is shown. A failure files
  a `blocked` verdict naming which expectation failed and what was seen. The
  person is never shown a broken item; the agent is told exactly why.
- A `css` selector or `url` pattern the browser refuses files a `blocked`
  verdict too, carrying the browser's own message, and the pane says one line
  about it. A typo in a selector used to be silent and indistinguishable from a
  page no script may run on.
- `blocked` verdicts are the pane's, not the human's. Do not quote one as if it
  were something they said. Pressing Go again on an item that is still not
  ready re-shows the card without filing a second identical `blocked`; a
  diagnostic that **changed** is news and still arrives.
- A Go against a page that never answers at all — the tab was closed, the load
  never finished, a surface no content script may run on — files **nothing**.
  Silence is not a failed expectation, and an item nobody reached must not read
  as a build that is not ready. The pane says one line about that press, so the
  person is not left wondering what happened.

### Host access

The extension asks for `<all_urls>` outright, so Chrome shows its access
warning **once, when you load the extension**, and nothing is ever asked
during a walk.

Two things a walk needs come out of that. `main.js` and `content.js` register
at `document_start` for the hosts the walk's items point at (hosts, not
origins: a Chrome match pattern carries no port), which is the
only way to catch a console error that happens while the page is loading —
`main.js` runs in the page's own world, where the page's `console` actually
lives, and forwards each line to the isolated content script that holds the
ring the verdict carries. And `tabs.captureVisibleTab` answers, so every
verdict carries its picture. Chrome hands that call only to an extension
holding the literal `<all_urls>` host permission or `activeTab` for that tab —
a per-site grant does not qualify (measured, not assumed), and `activeTab` is
lost the moment a Go navigates across origins. That is why there is no
per-site flow: it bought the console lines and never the screenshot.

Capture can still be refused on a page Chrome protects (a `chrome://` tab, the
Web Store). The verdict is recorded anyway, with `screenshot: null` and
`screenshotError` carrying Chrome's reason — the click is never lost over a
missing picture.

## 6. Where things are

```
~/Library/Application Support/walkd/
  token              the daemon's token, 0600, kept across restarts (§2)
  walkd.log          what a daemon started by `walkd start` printed
  secrets/           file-backed secret values, 0700 — the person puts them here
  state/walkd.json   port, pid, data dir, started-at (macOS and Windows only)
  <project>/<walk-id>/
    walk.json        the header
    items.jsonl      agent → human, append-only
    verdicts.jsonl   human → agent, append-only
    shots/NNNNNN.jpg one per verdict that carried a picture
```

On Linux the state file is not under the data directory: it is `$XDG_STATE_HOME/walkd/walkd.json`, or `~/.local/state/walkd/walkd.json` when that variable is unset.

Nothing is ever rewritten in either stream; a withdrawal is an appended record,
and state is derived. The daemon writes nothing into any project repo: the
agent's own notes get its decision, and the pictures stay here with the walk.

## 7. Testing

```bash
npm run build     # required first: sidewalk-mcp imports walkd from dist
npm test          # unit + integration (vitest)
npx playwright install chromium   # once
npm run e2e       # the extension, loaded unpacked, against fixtures/site
npm run pack:check # before a publish: what npm would send for the two packages
```

`npm test` first checks that the version is one number across the packages, the
extension's manifest and the plugin manifest's pin (`scripts/version.mjs`).

`npm run pack:check` is the pre-publish gate: it packs `sidewalk-walkd` and
`sidewalk-mcp` — `--dry-run` for the file list, then a real tarball
into a temp dir so the manifest can be read back out of it — and fails on a
missing `dist/`, README or LICENSE, a bin that lost its executable bit or its
shebang, a package off the one version, or any `workspace:` / `file:` / `link:`
range left in a dependency, which would resolve in this checkout and nowhere
else.

**You do not have to stop your daemon to run the e2e.** It starts its own walkd
on **8761** with a temp data dir, serves the fixture site on **9342**, and
points the extension at that daemon through `walkd:port` (§2) before it opens a
panel. Nothing in the suite binds 8760 or 9340, and Chrome's remote debugging is
9341 — never 9222, which belongs to the chrome-devtools MCP. It refuses to start
if something is already answering on 8761.

Thirty-five tests, one Chromium with the extension loaded unpacked, one walk per
test: an item arriving over SSE and Go navigating and highlighting; the verdict
that carries its screenshot, build id and console tail; a capture wider than the
cap; the gear's text size across a reload; a secret's value absent from the
pane and from `items.jsonl` and on the clipboard once Copy is pressed;
*Issues only* skipping the capture on a Pass, naming itself in
`screenshotError`, and still photographing an Issue; a question that is only a
title and options; Submit waiting for an answer and for the words under *Other*; the
decided line, Keep, and Undo handing the card back with the option still picked;
Ask, and the waiting kerb and dot it lights; an unmet expectation; three presses of Go filing one `blocked` and Issue
filing the person's words; a sequence card; the free Undo turning loud when an
agent reads the verdict; a card answered mid-list moving to the ledge with the
scroller left where it was, and the agent's read shelving it; Undo on a ledge
row handing the card back; a Done shelf row opening out on hover and on focus
with the red Undo on it not moving; the page link and a `javascript:` url the
daemon refuses; a withdrawn item; the toolbar badge; two walks at once; **eight walks
at once**, past the six connections a browser gives one origin, with cards from
the first and the eighth on screen and a verdict landing from the eighth; the
console ring, newest last, last 20; verdicts queueing while the daemon is down;
an item added after it restarts; and a refused verdict counted in the header
with its card asking to be answered again; the install note on a port that has
never answered, with the command on the clipboard once Copy is pressed; and a
daemon that claims another release named in the pane with the remedy, gone once
a matching one is back; and a walk's brief under its header, surviving a reopen
that carries none and replaced in place by one that carries a new one.

Each test closes the walk it opened. That is tidiness now rather than a
requirement: the worker holds one multiplexed stream however many walks are
open, so a suite that left them all open would no longer stall behind its own
connections — it would just carry every earlier test's cards into the next.

## 8. The mark

The Kerb logo — three slabs and a blue kerb on a dark tile, drawn in
one-point perspective with the near slab and the kerb running off the bottom
edge, so the tile is the sidewalk you are standing on — is the extension's
icon. (The 16-grid drawing keeps the flat bars; perspective has no pixels to
spend there.) It is "Cropped", the owner's pick on 2026-09-21 after four rounds. `packages/extension/icons/mark.svg` and `mark-16.svg` are
the sources, `node icons/render.mjs` (from `packages/extension`) renders the
16 / 32 / 48 / 128 PNGs the manifest names, and `wordmark.svg` is the mark
with the word, for listings and docs.

## 9. Not yet

Out of scope: an AI inside the extension; annotation or drawing on the page; Safari; iOS and OBS surfaces; a hosted or shared daemon; video capture.
