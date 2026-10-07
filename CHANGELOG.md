# Changelog

## 1.0.2 — 2026-10-07 — two packages

- **The schema package is folded into `sidewalk-walkd`.** The contract it held
  is now a subpath of the daemon's package, `sidewalk-walkd/schema`, with the
  same exports.
- **`sidewalk-schema` is unpublished.** Two packages are published from here:
  `sidewalk-walkd` and `sidewalk-mcp`.
- **Nothing a user types changes.** The install line, the MCP entry, the
  `walkd` commands and the extension are what they were.

## 1.0.1 — 2026-10-07 — the version flag

- **`walkd --version` and `sidewalk-mcp --version`.** Both print the package
  version and exit. Before this, walkd answered an unknown flag with Node's own
  stack trace; now it is one line naming the flag, then the usage, exit 2.
  `--help` prints the usage on stdout. The MCP's flag answers before it looks
  for a daemon, so asking for the version never starts one.

## 1.0.0 — 2026-10-06 — the launch build

The first build published to the registry, on 2026-10-07: `sidewalk-schema`,
`sidewalk-walkd` and `sidewalk-mcp`. Not yet in either store.

- **The daemon's package is `sidewalk-walkd`.** The registry refused `walkd`
  as too close to `walk` and `walker`, a rule it applies only at publish. The
  program, its binary, its data folders and its log are still `walkd`; the
  install line and the `npx -y sidewalk-walkd …` commands are what changed.
- **A reply has to answer an open ask, and a refused add costs nothing.** A
  `supersedes` that names an id the walk does not have, a withdrawn item, or an
  item with no open ask is refused, with the walk's open asks in the message.
  Every check, file-backed secrets included, now runs before a seq is spent, so
  a refused add leaves the walk exactly as it was. Both found on the first real
  walk through the 1.0.0 MCP.
- **The connection line is a band.** The owner: "the 'Connected to walkd on 8760'
  line should be tastefully distinguished from the walks like the ledge below
  is". The line and the gear sit on a strip one step off the ground (darker on
  concrete, lighter on asphalt), under the ledge's hairline, sticky to the top
  the way the ledge is to the bottom; the gear's settings open inside it. Same
  words, same size, same dot; the walk's title stays on the ground below.
- **Save checks the token.** The owner, pasting the wrong thing: "it just says saved
  in green like no actual connection check/rejection". The gear still stores the
  token, then waits for the worker's answer for that port with that token —
  `Checking…` while it asks, `Connected.` in green only once walkd has let the
  pane in, `walkd refused this token.` in red on a 401 with the field still
  focused for the next paste, `No walkd on <port>.` when nothing is answering.
- **One paste, not one per restart.** walkd mints its token the first time it
  starts and keeps it: `serve` reuses `<data>/token` when it is a regular 0600
  file this user owns holding a token of the form walkd mints, replaces it with
  one line on stderr when it is not, and `stop` no longer removes it. A minted
  token goes onto the clipboard (`--no-copy` opts out), `walkd token --rotate`
  replaces it and says a running daemon keeps the old one until it restarts, and
  `walkd start` is `serve` detached — the pid printed, the daemon's output in
  `<data>/walkd.log` — which is what `sidewalk.sh/install` now runs, so the one
  gesture left on install day is the paste.
- **The pane no longer assigns HTML strings.** `render.ts` still builds a
  card as an escaped string; `markup.ts` parses it in a detached document,
  drops scripts, frames, event-handler attributes and non-http(s) URLs, and
  swaps the nodes in. The two AMO linter warnings on `innerHTML` are gone;
  the pane's animations, caret and scroll position are unchanged, measured.
- **A Firefox build, from the same tree.** `npm run package` writes
  `sidewalk-chrome-<v>.zip`, `sidewalk-firefox-<v>.zip` and the source zip AMO
  requires, into a gitignored `packages/extension/store/`. The Firefox half is
  a manifest patch at package time (`scripts/firefox-manifest.mjs`, a pure
  function with a test) plus thirty lines in `src/firefox.js`: a `sidePanel`
  stub and an `action.onClicked` that opens the sidebar. No `chrome` ->
  `browser` shim — Firefox's MV3 `chrome.*` returns promises. Verified on
  Firefox 152: the event page connected over plain loopback HTTP, read a walk,
  held one stream open across two alarm ticks, and the sidebar drew the cards.
  `web-ext lint` is clean of errors. Nothing is uploaded to either store.
- **The listing is written down.** A listing kept outside the repo holds
  every field both stores ask for, the permission justifications, the data-use
  answers, the AMO source-code submission, the reviewer notes and the upload
  runbook — plus the four things that have to be true first. `PRIVACY.md` and
  `site/privacy.html` are the policy both listings link to.
- **Store pictures by script.** `npm run screenshots` drives the real pane
  beside the real demo site and writes five 1280x800 frames, a dark one and
  the two promo tiles.
## 0.3.0 — 2026-09-20 — the store shape

Never published; 1.0.0 went out first.

- **Three ways in, all of them without a file path.** `npm run pack:check`
  packs `@sidewalk/schema`, `walkd` and `sidewalk-mcp` the way npm would and
  fails on a missing file, a bin that lost its executable bit, or a dependency
  that resolves only in a checkout; each package carries its own README with the
  secrets posture verbatim. `.claude-plugin/` makes the repository its own
  marketplace listing one plugin, `sidewalk`, which adds the MCP server
  (`npx -y sidewalk-mcp@0.3.0`, pinned by `scripts/version.mjs`) and the
  walk-author skill as `/sidewalk:walk-author`. `site/install` is
  `curl -fsSL https://sidewalk.sh/install | sh`: Node and npm checked, the two
  packages installed globally, the MCP server added when `claude` is on PATH,
  and the two things left printed — no sudo, and the same on a second run.
  Nothing is published, pushed or deployed by any of it.
- **The agent's answer lands on the card that asked, and the waiting stops.**
  The owner, 2026-10-04, on the waiting kerb a day old: "i like the new pending
  answer thing, but then when the answer is there I think it should link to the
  card that asked it (instead of letting a card be in between with its own
  dismiss) and I think the color indication type stuff should stop looking like
  it's still pending/waiting, at least in the same way, because it's still
  pending a person but not pending the same thing anymore (claude in this case)."
  Both halves. **An `info` reply is no longer a card anywhere** — not in its
  group, not on the ledge, not on the Done shelf, no Dismiss. It is a block
  inside the asked card, standing in the place of *Asked. Waiting for the
  agent.*: the reply's own title in the card's bold, its body under it, and
  several answers to one ask as several blocks in the order they were sent. Not
  one new word — the answer is the words the agent wrote. The asked card's
  buttons and note box never moved, because answering the card is what resolves
  it, and the answer rides along with the verdict onto the Done shelf, where the
  row already opens out under the pointer to show the whole record. **And the
  waiting ends where it is no longer true:** the yellow kerb and its dot go the
  moment the reply lands, the kerb falls back to what it would otherwise be —
  blue and breathing on the current card, nothing on a card that is not, orange
  still outranking everything — and the block carries a thin rule in the ink a
  decision's kerb is painted, with no animation at all. Three states, three ways
  of reading: fresh has no edge, waiting breathes yellow, answered-and-yours is
  a still ink rule inside the card. A `question` reply keeps its own card, since
  it has a verdict to collect, and moves to sit directly under the card it
  answers. Withdrawing a reply puts the question back, kerb and `openAsks`
  together — the pane and the agent close an ask on exactly the same rule — and
  so does **asking again**: a person can ask a second time on a card they have
  already been answered on (one early PIN exchange went several turns), and an
  answer that landed before the new question is not an answer to it. Both halves
  compare the reply's `addedAt` with the ask's `at`, both stamped by the daemon,
  so a newer ask reopens what an older reply closed — in the pane the answers
  already given stay in the card and the new question's waiting line goes under
  them, and in `walk_read` the ask is listed again. The Lamppost demo lost a
  beat to this: the recorder used to press Dismiss on the reply card, and there
  is nothing there to press any more.
- **walkd has a token now, and a card with a secret stops reporting what the
  page shows.** The last two items of the audit, the ones the owner agreed to before
  the repo goes public (F1 and F5).
  **The token (F1).** walkd makes 32 random bytes the first time it starts,
  keeps them in memory, and writes them to `<data dir>/token` at mode 0600.
  The next boot reads that file back, and `stop` leaves it where it is.
  Every request and both SSE streams send them back as `Authorization: Bearer
  <token>`; a missing or wrong one is a 401 that names the file. `GET /health` stays open, because it is how
  every client finds out a daemon is there at all, and it now says
  `auth: "token"` so a client can tell a daemon that wants one from a daemon
  that does not. The three header guards still run first, so a rebinding page
  holding the token is refused on its `Host` anyway. What this stops is every
  *other* program on the machine reading a walk, or a card's value, off
  loopback. What it is not is a login, or transport security: a program that
  can read your user's files can read the token. That is the sentence the docs
  now use. `sidewalk-mcp` pairs itself: the state file names the data dir, the
  data dir holds the token, and the client reads it on every connect and once
  more after a 401, since `walkd token --rotate` can replace it.
  The extension cannot read files, so the pane's gear takes it
  (`walkd:token` in `chrome.storage.local`, beside the port); `walkd token`
  prints it and `walkd token --copy` puts it on the clipboard. A pane without
  it says *walkd on 8760 needs the token*, offers the command above the cards,
  and opens the gear at the field. It never climbs a reconnect ladder for a
  401, because waiting changes nothing and saving the token reconnects at
  once. A verdict clicked meanwhile is not lost; a 401 is not a refusal the
  queue buries. `WALKD_TOKEN` pins the token at both ends, for a client that
  cannot see the daemon's data dir at all.
  **Redaction (F5).** The `file` form of a secret exists so an agent that must
  not hold a value never sees one, and the page was the hole in it. A `text`
  expect that failed filed a `blocked` line saying what it *saw*, which was the
  page's rendering of what had just been pasted. `buildId` was that same read
  on every verdict, pass included, and the console tail was the same channel
  with less precision. On an item carrying `secrets` all three now come back as
  `(redacted, 24 chars)`. The length stays because the length of what a page
  is showing is a fact about the page and not about the value, and it keeps a
  blocked line readable: *wanted "fix-001", saw "(redacted, 24 chars)"*.
  `(absent)` survives; that is the pane's own word for a missing element, not
  something the page said. The pane redacts before it posts and the daemon
  does it again on the way in, because `verdicts.jsonl` is forever. The
  screenshot is unchanged on purpose: it is a picture of the site, and whether
  one is taken is the person's own setting in the gear.
- **Secrets, said plainly:** walkd's token is what stops another program on the
  machine reading a card's value; the pane's dots keep it off the pane and
  nowhere else. Demo and test credentials only. Five guards landed with it. walkd
  refuses a request whose `Host` is not its own loopback port, so a page whose
  DNS has been flipped to 127.0.0.1 can no longer read a value (F2); it refuses
  a request carrying a web page's `Origin`, and a POST that is not
  `application/json` — which is exactly what a `no-cors` fetch and an HTML form
  cannot send, so a page can no longer put a card on somebody's pane or file a
  verdict their agent then builds on (F3); a file-backed secret is read only if
  it is a regular file of at most 64 KB, so a symlink is refused rather than
  followed and a pipe no longer hangs the walk inside its own lock (F7); the
  data dir, every walk's folder and `secrets/` are made `0700` (F8); and a
  verdict the daemon refuses keeps the item and the kind in `walkd:dead` and not
  the screenshot, which used to sit in the Chrome profile for good (F4). The
  words in §5 of the README, in the server instructions and in the walk-author
  skill now say those limits instead of implying there are none.
- **An ask now tells the agent where the answer goes, and stays in front of it
  until something answers.** On a real walk, 2026-10-04, after the agent answered the person's question in its own chat, where they never saw it:
  "The verdict itself could say it. The ask came back as `kind: "ask"` with
  `ask: false` beside it, which reads as a contradiction. A verdict could carry
  one line the agent cannot miss, something like `reply: "answer in the pane
  with an info item that supersedes w13-q1"`, and the flag could be renamed to
  what it means or dropped." And: "If an asked card stayed visibly open until an
  item superseded it … the agent would see an unanswered ask on every
  `walk_read`." Three things, in that order. **The flag is dropped** — the
  schema no longer defaults `ask` to `false` and the daemon no longer writes one
  onto a verdict that arrived without it, so `kind: "ask"` is the only thing
  said about an ask (the field stays in the schema, optional, so a pre-0.1.1
  verdict still parses). **Every `ask` the agent is handed carries a `reply`
  line** — *Answer in the pane: add an info or question item on this walk, in
  the same group as `<item>`, with supersedes set to `<item>`. That is what marks
  the ask answered. The person is reading the pane, not your chat.* — added by the MCP
  server as it formats `walk_wait` and `walk_read`, beside `screenshotPath`,
  never stored: the record stays as the person filed it. **And `walk_read`
  carries `openAsks`**, one `{item, seq, text}` row per question whose latest
  non-blocked verdict is still the ask and which no item on the walk supersedes,
  the person's words verbatim — so an ask that scrolled past in one wait is in
  front of the agent on every read after it, which is what the pane has been
  doing at the card's kerb all along. Computed from the read the server already
  has; nothing in the daemon changed.
- **A Done shelf row opens out under the pointer.** The owner, 2026-10-04: "when
  hovering over a line on the done ledge do you think we can expand on hover to
  at least show the full untruncated title? If i'm considering a red undo for
  example, I'll need to get some details on what it was exactly." It turned out
  there was nothing to add and nothing to say: a shelf row already carries its
  whole answered line — the title, how far a sequence got, every word the person
  wrote — and the one line it reads as is a clip the stylesheet puts there. So
  hover, or focus landing anywhere inside the row, lifts the clip: the line wraps
  and the record reads in full where it already stands, no tooltip, no second
  copy of anything, not one new word. `:focus-within` as well as `:hover`, so
  tabbing to the red Undo opens the same row a pointer would — which is the case
  he asked for, reading what an Undo is about to take back before pressing it.
  It opens downward and the first line holds: the row's three cells come off
  centre as it grows, which leaves the Undo exactly where the hand was reaching
  for it, and the gutter mark keeps its place by centring inside a cell one Undo
  tall rather than inside the row. No transition, and so no third animation on a
  pane the design language gives two: neither of its timings is a hover timing,
  and a height transition would have to run against a max-height that clips the
  very words the row opened to show. One thing it turned up on the way: the pane's
  scroller was anchoring. Scroll anchoring keeps your place when something *above*
  you changes height, and the pane has nothing that does — a repaint replaces the
  whole of `#walks`, which leaves it no node to keep — but it did see this, and
  with the pane scrolled to its end, which is exactly where the Done shelf is, it
  answered the growth by scrolling down by as much again and slid the row, and the
  red Undo on it, up out from under the hand. `overflow-anchor:none` on the
  scroller, and the pane holds still.
- **A card waiting on the agent says so at its kerb.** The owner, 2026-10-04: "when
  you hit ask and it says 'Asked. Waiting for the agent.' can we do like a
  pulsing yellow thing or put a left-pane color thing or SOMETHING to indicate
  it's waiting? in addition to that text of course." Both, and in the Kerb's own
  vocabulary rather than a new one: the 4 px edge goes **waiting yellow**
  (`#D4A600` light, `#FFD633` dark — a fifth hue, at hue 47 against the blocked
  orange's 30; lighter than the orange on a cream slab, because a yellow dark
  enough to match its weight there reads as olive instead of yellow) and
  breathes it on the current card's own 3.2 s and easing,
  and the line grows the header's connected dot at its head, same yellow,
  breathing the header's 2.4 s. Still two animations, not four: the kerb's
  keyframes now take their colour off the card as `--kerb-breath`, so one of them
  serves both the blue current kerb and the yellow waiting one, and reduced
  motion turns all of it solid. The words are untouched. The yellow lives exactly
  as long as the line it belongs to — from the ask verdict to the person's next
  answer on that card, or the agent withdrawing the item; the agent *reading* the
  ask does not end it, and nor does replying with a new item. Precedence, now
  written down beside the code and pinned by tests: orange outranks yellow
  outranks blue, and an answered card is never waiting. Which turned up a gap
  behind it — an `ask` before a `blocked` line leaves the card answerable, so the
  orange kerb was being dropped from the one card that most needed it, the card
  whose Go had just failed, while the diagnostic sat there in orange text. The
  kerb now reads off the blocked line itself, so a failed Go always paints the
  edge.
- **The take reads at a viewer's pace.** The owner, on the Secrets short: "there's
  like 7 clicks/scene changes in 7 seconds... are you sure it isn't too fast?
  Typing words fast is fine, the mouse movements look ok, but then the clicks
  are rapid and click-to-click is too rapid." The footage agreed to three
  decimal places — eight presses in 9.956 s of it, median gap 1174 ms, minimum
  942 ms — and the cause was one missing rule: `press()` was `look`, glide,
  click, and then *nothing*, so a beat that wanted the viewer to see what it had
  just done had to hand-write a hold, and half of them didn't. `demo/pace.mjs`
  is the rule, pure and unit-tested: `settle` 400 ms after every press, and
  `read` = clamp(900 + 300 × words, 900, 5000) after a press that changed words
  on screen, the hold being `max(settle, read)` and never their sum. The 900 ms
  is Rensink 1997's measured time to notice *and identify* an unmasked change,
  which is also ITC 1999's one second for a viewer to adjust to a new picture;
  the 300 ms a word is the BBC's own subtitle figure, at the slowest rate Ofcom
  still calls comfortable. **Which words changed is measured, not declared** —
  `innerText` on both surfaces before the press and again after the settle, a
  multiset difference, so text that only went away or was merely reordered
  counts nothing and a press that changed nothing holds the settle alone; a word
  count written into each beat by hand would go stale the first time the copy
  changed, and silently. Every hold is jittered ×0.7–1.3 from the same seeded
  hash the hand uses, because a fixed beat reads as a metronome and a seeded one
  still shoots the same take twice. Typing stays at 45 ms a character — that
  part reads fine — but it now ends on a 700 ms beat before the next press; the
  mouse button is held down for 105 ms instead of Playwright's 0, which reads as
  synthetic; the click ring is up for 500 ms instead of 300, which was less time
  than the eye needs to reach it; and `--speed` is two dials, the hand divided
  by it and the holds by its square root with a 300 ms floor, because a
  rehearsal's reading time cannot be halved the way its hand can. Five
  hand-written holds went; nine stayed, each now saying whether it is the
  product's own animation, a change arriving on the agent's clock, or the take's
  own first or last picture. `timeline.json` carries the numbers the take ran on
  and every beat's `settle`, `read` and word count, so the cut can see why a
  beat took as long as it did. Measured on a check take: 93.6 s → **136.0 s**,
  the same 31 presses, median gap between presses 1417 → 3087 ms, minimum 942 →
  1283, and one press every 3.1 s over the stretch the owner was watching instead of
  every 1.17. Slower than the research's own ~122 s estimate, because that
  assumed four words a press and the measured ones are bigger — a card's controls
  coming back after an Undo counts 38 — which is a number to tune with §4.2's
  0.9 + 0.20 × words if it reads sluggish, not by going back to no hold at all.
- **The Lamppost demo's take and cut, after the owner's first viewings
  (2026-10-04).** The take is 60 fps H.264 from Chrome's screencast with a
  human hand (ghost-cursor paths, seeded) and a viewer's pace (`demo/pace.mjs`:
  400 ms settle after every press; 0.9 s + 0.2 s per word never shown
  before, capped at 3.5 s; 1.2 s after a navigation; 700 ms after typing;
  105 ms button hold; seeded jitter; holds ÷√speed). The Remotion cut, which
  lives in a separate Remotion repository, draws the pointer from the cursor
  track, cuts by beat-plus-offset, and checks its own pacing rules.
  The pack's ask reply now answers the question the take asks.
- **A Go that passes clears "Not ready here".** The Lamppost cut caught it:
  history was rebuilt, Go outlined the list, and the card kept its orange
  kerb and the old diagnostic, because the newest verdict on the item was
  still the `blocked` line and nothing ever said the page had caught up. The
  worker now remembers, per item, the last blocked seq a passing Go cleared;
  the renderer treats an older blocked line as history and the card goes
  back to new. The record is untouched (streams are append-only), and the
  same diagnostic files again if the page falls back after a pass — that is
  news, not a duplicate. One e2e: blocked, rebuilt, Go, clear; fall back,
  Go, filed again.
- **The hand moves like a hand.** The owner, on the 60 fps take: "the mouse
  movements do not really look smooth or human like". They were not. Every
  move was one `page.mouse.move(x, y, { steps: 20 })` — a straight line at a
  constant speed, fired as fast as CDP would carry it, from one target's
  centre to the next target's centre — while Playwright's `showActions` drew
  a second pointer that animated between action points on *its own* clock, so
  the two disagreed and neither eased. `demo/hand.mjs` replaces all of it: the
  arc is `ghost-cursor`'s Bézier path, the duration is Fitts's law so it grows
  with the distance and shrinks with the size of the target, the position
  along the arc is eased, a throw over 160 px goes a few pixels past and flicks
  back, and every target is landed a little off its centre — the same few
  pixels for that target for ever, from a seeded hash of its id, because
  nothing here may call `Math.random` if two takes are to come out the same
  frame for frame. 57 px in 313 ms, 455 px in 595 ms, 668 px in 653 ms,
  measured. The cursor track in `timeline.json` is the **whole path** now, one
  row a sample at 60 Hz, instead of one row at each target, and the recorder
  refuses a take where two consecutive samples on a surface are more than
  200 px apart. `showActions` is gone; what makes a raw take watchable is a
  pointer in the page's own DOM (`demo/overlay.mjs`), which has no second clock
  to disagree with, and `--no-overlay` films clean footage for the cut.
- **The take is 60 fps with a cursor.** The owner, on the first Lamppost take:
  "the video does not look smooth, are we at least 30fps? Are you building it
  with individual screenshots? (seems really inefficient)", "the start of the
  site one looks broken on crop, if you look at any of the first frames you'll
  see it", and "without seeing like, the mouse, where clicks are, etc. it's a
  bit hard to follow what's happening in the sidewalk". One cause behind all
  three: `recordVideo` is Playwright's *debugging* recorder — 25 fps, VP8
  capped at 1 Mbit/s on libvpx's fastest and worst setting, sized per context
  rather than per page, started before anything is settled, and nothing ever
  drew a pointer. The recorder now films each surface itself with
  `page.screencast` and muxes the frames to a constant **60 fps H.264 at CRF
  16** (`demo/capture.mjs`), placing each frame by the moment the compositor
  swapped it and holding the last one through an idle stretch. Nothing is
  filmed until the window is fitted and the pane is on the walk, and the
  window *is* fitted — a visible tab is filmed at its browser window's content
  area, and the pane's `setViewportSize` had been shrinking the window they
  share, which is why the site came out 500×713 in a grey field. The pane is
  filmed at its own size, so `cropPane`'s second lossy pass over 400 px of
  small text is gone. Playwright's pointer, click mark and highlight box are
  on in the footage — confirmed to reach a `chrome-extension://` page, which
  no Playwright test covers — and every scripted move, press and release is
  logged to `timeline.json` as a cursor track the cut can draw its own pointer
  from. A take whose surfaces stopped moving now exits 1 with the counts
  instead of quietly shipping a frozen video, and `timeline.json` carries each
  beat's frame number on each surface so the cut never reasons about
  milliseconds. Sizes are up to 1440×900 and 400×900: the screencast is CSS
  pixels, `deviceScaleFactor: 2` buys nothing, and the viewport is the only
  lever there is.
- **A card that lands while the worker is first reading its walk is no
  longer lost.** `openView` read a walk, awaited storage, then stored the
  view; an `item` frame in that window found no view and was dropped, and
  nothing re-read afterwards because the walk was streaming by then — a
  header with no cards, for good. The Lamppost recorder hit it live. The
  worker now keeps frames for a walk whose first read is out and replays
  them once it is in (`late.ts`), applying only what the read did not
  already carry and never rolling `delivered` or `closedAt` backwards.
- **The demo site's status link is its own origin**, not a hardcoded
  9350 — the recording serves Lamppost on 9353, and the old link was on
  camera for four beats.
- **A verdict mid-append can no longer be skipped.** `addVerdict` took its
  seq by moving the walk's counter before the file append; an agent read or
  `walk_wait` landing during that write computed its cursor from the counter
  and came back empty with a cursor one past the verdict — which that agent
  then never received. The Lamppost launcher's test caught it once in six
  runs; a stress loop of reads during posts skipped every one. The counter
  now moves only when the verdict is in the list. Held by a store test that
  reads and waits during the append. The launcher itself also gained a
  10 s deadline on every daemon call and says out loud anything a read
  throws, so a stuck or dying read can never again look like silence.
- **The ledge.** The owner, 2026-09-23, on the Lamppost demo: after answering a
  question "the way the thing scrolled me away from where I was was…
  surprising", and then "there maybe needs to be an intermediary step, where
  while the undo is still green like during that cooldown period, where it'd
  maybe either collapse to one row for a bit, or collapse and pin and stick to
  the screen for a bit". So an answered card now leaves the list the moment it
  is answered, and its one line pins to a strip at the bottom of the pane:
  newest on top, three rows before it scrolls inside itself, the green Undo on
  each row and a 2 px bar under it draining over the grace window. The agent's
  read still moves it to the Done shelf, red Undo and gutter mark as before.
  The pane no longer scrolls anywhere on submit — the card is gone from its
  group, so the next one slides up into its place and the person stays where
  they were. `GET /health` gained `graceMs`, which is where the bar's window
  comes from: **a daemon that is already running has to be restarted before
  the bars appear** (`npx -y walkd stop`, now `sidewalk-walkd`, then reconnect the agent's MCP
  server). Without it the rows are all there and still free to take back, only
  undrawn.
- **The Lamppost demo.** `demo/` is a whole walk of a product that does not
  exist: Lamppost, a four-page status page with a row of lamps, and a
  seven-card pack that between them touches every feature the pane has — Go
  and its outline, an `expect` that blocks a card until the page catches up, a
  sequence with a tick per step, a small question, a secret with a Copy
  button, an info card, an Ask the agent answers, the free Undo going from
  green to red, the Done shelf, and cards arriving mid-walk. `node
  demo/run.mjs` plays the agent over plain HTTP, so it needs no Claude session
  and runs the same way every time; nothing on the site animates but the lamps
  and nothing reads the clock, so what a camera sees is repeatable. Two test
  files of its own, in the root vitest run. `demo/README.md`.
- **The demo records itself.** `node demo/record.mjs` stands the whole product
  up — its own walkd on 8763, its own Lamppost on 9353, a Chromium with the
  unpacked extension — and plays the person's part once, at a human pace, with
  no random number anywhere: twenty-six beats from the pane opening on the walk
  to the agent closing it. It leaves `site.webm` (1280×800), `pane.webm`
  (380×800), a still of both surfaces at every beat, and a `timeline.json` the
  cut takes its cuts and its captions from. `--speed 2` halves every pause for
  a rehearsal. Footage goes to an ignored `demo/out/`, and the Remotion cut is
  made outside this repo. `demo/README.md` § Recording.
- **The MCP entry is `sidewalk`.** What a person adds to their agent is
  named like the extension, not like the daemon: the package is
  `sidewalk-mcp` (bare `sidewalk` on npm belongs to someone else), the
  server introduces itself as `sidewalk`, and the install line the pane
  offers is `claude mcp add --scope user sidewalk -- npx -y sidewalk-mcp`.
  Agents see the tools as `mcp__sidewalk__walk_*`. `walkd` stays the
  daemon's name — it is the piece a person stops and starts.
- **A walk has a brief.** Two or three sentences under the title, the
  agent's words, that never move. The owner, 2026-09-20, watching a real walk
  live: the agent had put its "read this first" note in an info card under
  a group named `0 · Read first`, and the pane — which orders groups newest
  first so a person sees what just landed — sank it to the bottom. `brief`
  on `walk_open` (and on the header in `walk.json`) is where that text
  goes now; a reopen with a new brief replaces it, and the `open` frame the
  daemon already sends on reopen is what repaints the pane.
- **The instructions say what the pane does.** Three things the owner watched
  go wrong live, all on the agent's side of the wire: a "read this first"
  info card sank to the bottom (the pane orders groups newest first, and
  nothing had told the agent); a ten-second question arrived with every
  sheet section filled; and the agent narrated each empty `walk_wait`,
  then gave up listening after half an hour. The server's instructions
  and `skills/walk-author/SKILL.md` now say: the newest group is on top and
  orientation goes in the brief; the small question is the default and
  each sheet section needs a reason; an empty wait is not news, call it
  again and say nothing, and never stop listening because of silence.
- **The store shape.** A Web Store extension cannot start a local process, so
  the npm package is the whole install on the agent's side:
  `claude mcp add --scope user sidewalk -- npx -y sidewalk-mcp`. The three Node
  packages carry what the registry needs (`files`, `license`, `repository`,
  `engines`, `publishConfig` set to public access on each, a `prepublishOnly`
  build, a README each); the publish itself came with 1.0.0.
- **The pane says what is missing.** A port no daemon has ever answered on,
  in this profile, gets a first-run note naming walkd and offering the
  install command with a Copy button, instead of *Looking for walkd* forever.
  A daemon that is down mid-walk keeps the *Looking for* line. The worker
  writes `walkd:connected:<port>` on the first answer.
- **The pane says when the daemon is another release.** `/health` always
  carried a version; the worker now keeps it, and when it differs from the
  manifest's — either direction — a notice under the header names both,
  with the remedy (stop walkd **and** reconnect the MCP server) and a Copy
  button for `npx -y walkd stop` (now `sidewalk-walkd`). Warn only; nothing is refused.
- **One version number.** `walkd` and `sidewalk-mcp` read theirs from
  `package.json`; `scripts/version.mjs check` runs before `npm test`, and
  `set X.Y.Z` is the release edit. `WALKD_ADVERTISE_VERSION` lets the e2e
  start a daemon that claims another version.
- 25 e2e (three new), 18 unit-test files.
- **The gate runs on Windows.** Nothing in the product changed; four test-side
  assumptions did. The e2e's `webServer` set its port with a `PORT=9342 node …`
  prefix, which cmd.exe cannot parse — it goes through Playwright's `env` now,
  with the script path quoted. The e2e spawned its daemon as `"node"`, and on a
  machine whose `node` is a shim (Nodist here; nvm-for-Windows behaves the
  same) that spawns the shim and the daemon is its *grand*child, so `kill()`
  stopped the shim while the daemon kept the port and both restart tests waited
  out their timeouts — `process.execPath` now, which is what sidewalk-mcp's
  `client.ts` already spawned. A sidewalk-mcp assertion spelled a screenshot path
  with POSIX separators; it builds the tail with `path.sep`. And `walkd serve`'s
  cleanup-on-SIGTERM test says what each platform can do: Windows has no
  SIGTERM to catch, `kill()` is TerminateProcess, so the shutdown handler never
  runs and the state file outlives the daemon — the stale file `walkd stop`
  health-checks and removes on its next run.
  On Windows: `npm run build` green, 184 unit tests, 22 e2e.
- **The Go outline breathes.** It used to be a still purple rectangle for
  four seconds. Now it lands at full with the press, then fades and swells
  in the kerb's own rhythm and easing (1.6 s each way, out-in-out-in-out,
  eight seconds), then goes. The owner,
  2026-09-22, walking the Lamppost demo: "when the page flips to one with it
  it's hard to notice it's trying to grab my attention sometimes." Reduced
  motion keeps the still outline. The e2e's outline check is unchanged: the
  inline outline is still `3px solid`; only its colour is animated.
- **The mark, redrawn.** The owner, 2026-09-21: the flat mark "secretly" read as
  a sidewalk and he wanted that on purpose. Four rounds with the design lead:
  Slabs / Crossing / Walk, then Walk pushed into Steep / Cropped / Seams and a crossing drawn
  with its stripes lying the right way, then Cropped against a steep cropped
  crossing. He chose **Cropped**: one-point perspective, the kerb a wedge, the
  near slab and the kerb running off the bottom edge so the tile is the
  sidewalk you stand on. `mark.svg`, `wordmark.svg` and the 48 / 128 PNGs
  are the new drawing; `mark-16.svg` keeps flat bars with the near one
  touching the bottom edge, so 16 and 32 carry the crop without the taper.

## 0.2.0 — 2026-09-18 — a real build, walked through the pane

Changes the owner asked for while walking a real build through the pane, and the design language that came out of it.
Each one hides behind a Reload of the unpacked extension.

- **One stream per daemon, not one per walk.** The worker held an SSE
  connection per open walk, and a browser gives one origin six: at the seventh
  walk the worker's own streams were all six, so its health checks, its reads
  and the verdict the person had just clicked queued behind them until they
  timed out, and the pane stalled. The daemon serves `GET /events` — every
  walk's `item` / `withdraw` / `close` / `delivered` on one connection, each
  frame naming its walk — plus an `open` frame when a walk is opened or
  reopened, so a new walk reaches the pane at once instead of on the 30 s
  alarm. The worker holds exactly one of these for as long as the daemon
  answers and demultiplexes it onto the views it already had; a port move
  aborts it and opens one against the new base. `GET /walks/:id/events` is
  unchanged for other clients. Held shut by a walkd unit test (two walks, one
  subscription, items / withdraw / close / a walk opened afterwards) and an
  e2e that opens eight walks at once — which fails on the old worker.

- **Go sits on the link row.** The look card reads get there → what to do →
  judge it: the page link and Go share the top row, and the Go that sat under
  do/see/pass is gone. Go is there even when the url earned no link. (the owner:
  "if the link is at the top of the card maybe the Go button should be near
  the top too/instead?")
- **The `sequence` item.** One page, 2–8 steps of do → see, one card: link
  row with Go, a tick per step, one note box, the five buttons once. The
  verdict carries `steps` (which were ticked, in order) and the answered card
  reads *N of M steps*. Ticks survive a repaint like drafts do. The daemon
  stores `steps`; the worker registers the page's origin and runs Go and the
  capture for a sequence exactly as for a look. (the owner, on four look cards
  for one path: "press go does it work? Try this now what does it do? Try
  this now....") A running daemon and a running walkd-mcp must be restarted
  to accept the new kind; an unreloaded pane cannot draw it.
- **A secret on a card.** `look`, `sequence` and `info` items take up to four
  `secrets: [{label, value}]`. The card shows the label, a fixed run of dots
  and a **Copy** button; pressing it puts the value on the clipboard, reads
  *Copied* for two seconds, and leaves a line saying what the person is now
  holding. On an early walk, a question card said "the key is copied to your
  clipboard right now" and it was not — no agent can reach a clipboard, and
  the pane already has his hand on a button. The value lives only in the
  daemon's memory: `items.jsonl` gets the item with the whole `secrets` key
  dropped, `walk_read` and `walk_add_items` hand an agent the labels alone,
  and it is never in the pane's DOM, so the next verdict's screenshot cannot
  show it. After a daemon restart the item has no secrets and the agent adds
  it again. Nothing auto-clears the clipboard; that would cost the
  `clipboardRead` permission.
- **Screenshots are a setting.** The gear's panel gains **Screenshots** under
  Text size: **Every verdict** (the default), **Issues only**, **Never**.
  (the owner: "should we make post-answer screenshots a disable-able option in
  settings? … or maybe a 3rd option of 'on issues only'.") The worker reads it
  when a verdict is filed, so a change lands on the next one with no reload.
  Turned down, the verdict still carries its url, console tail and build id,
  and its `screenshotError` reads `off: screenshots set to never` or `off:
  screenshots set to issues only` — the leading `off:` is how an agent tells a
  setting from a capture that failed. `blocked` verdicts are the pane's own
  and always carry their picture.
- **Server instructions.** walkd-mcp now hands every client an authoring
  guide in the MCP initialize handshake (`instructions.ts`): the loop, the
  four item kinds and when each fits, how to write items in plain words, how
  to read verdicts. `walk_add_items`'s description names `sequence` first.
  The same text is `skills/walk-author/SKILL.md`. (the owner: "we wanna encourage
  best practices a little bit.")
- **Build order.** The root `build` runs schema → walkd → walkd-mcp →
  extension, so the extension typechecks against fresh schema types on a
  clean tree.
- **Screenshots wider than the cap attach again.** The owner's first walk-11
  verdict carried `screenshotError: "Maximum call stack size exceeded"`: the
  worker spread every byte of the re-encoded JPEG into one
  `String.fromCharCode` call. A Retina capture is the first one wide enough to
  be re-encoded; the e2e window never was. Now a chunked encoder (`b64.ts`,
  unit-tested at 1.5 MB) and an e2e that captures a 2400-wide page and checks
  the JPEG comes back 1568 wide.
- **The launch-time e2e flake, found and fixed.** The worker's console (now
  printed by the e2e when a test fails) showed it: the first refresh listed
  walks from the default port, the port then moved, and the open for one of
  those walks captured the new generation — so it passed the "daemon moved"
  check while its read went to the new daemon, whose 404 body became a view
  with no items that no later refresh could drop. `open` now carries the
  generation of the refresh that listed the walk, and the daemon link refuses
  a non-2xx body or a body that is not a walk (`daemon.test.ts`). 10 of 10
  fresh launches green.
- **Undo on every answered card, green or red.** The owner: "until the other agent
  picks it up it's a free and easy click to evict it from the daemon … a
  green undo that turns red when the main agent pulls it off the queue." The
  daemon tracks `delivered` on the walk header — the highest verdict seq an
  agent has been handed by `walk_wait` / `walk_read`; the pane's reads say
  `?viewer=1` and move nothing — and tells the pane over SSE when it moves. A
  verdict above the mark gets a green Undo: one click, and the daemon marks it
  and its `undo` `quiet`, hidden from every agent read. A verdict at or below
  it gets the red one: confirm inside the card, then a loud `undo` with
  `retracts`. The person's words, option and ticks come back onto the card
  either way. The worker now brings a posted verdict's real seq back onto the
  pane's copy, which is what the colour is judged on.
- **A grace window before an agent is handed a verdict.** The owner: "i completed
  one and never saw the green undo option, did the main agent just gobble it
  up INSTANTLY? Maybe we should do a short lil cooldown like 10s". It had: a
  blocked `walk_wait` returns the instant a verdict lands. Now `walkd serve
  --grace-ms N` (default 10 000; the e2e runs 0; `new WalkStore(dir,
  { graceMs })` defaults to 0) keeps a fresh verdict out of every agent read
  until it is N ms old, wakes a blocked wait when it matures, and never hands
  back a cursor that skips a verdict still inside the window.
- **A second warning on a long-held Undo.** The owner: "if it's been more than
  like 10min … keep the buttons the same but update with one more text
  warning". When the red Undo's confirm opens on an answer the agent has held
  for 10 minutes or more, a second line reads *Are you really sure? Automated
  work built on this answer across the last 42 min may be destroyed.* with
  the real elapsed time; the two buttons are unchanged. The pane repaints
  once a minute while a confirm is open so the number stays true.
- **Empty states.** The owner: "if there's nothing on the walk can you vertically
  centered just put a lil text there saying like nothing to see here style
  text". With no walk open the pane centres *Nothing to see here yet. When an
  agent opens a walk, it shows up on its own.* A walk with nothing left to
  act on reads *Nothing left on this walk. Anything new lands here on its
  own.* above its Done shelf; a closed one reads *This walk is closed.*
- **The current card, and two pulses.** The owner: "I don't think there's an
  inherent order to things otherwise we wouldn't have go on each card
  individually, so blue should be for what you go'd to... also i want a
  subtle pulsing green dot next to connected up top and a subtle pulse on
  the blue line". The worker marks the card whose Go was pressed last as the
  walk's `current` (cleared when it is answered; an Ask keeps it), the pane
  gives that card a blue left edge that pulses, and the header's connection
  line carries a green dot that pulses while there is a walk server and sits
  grey and still without one. Both pulses stop under
  `prefers-reduced-motion`. The design pass owns the
  final look; this is the logic and a placeholder rendering.
- **The Done shelf.** The owner: "once it's read off the daemon or whatever then
  it drops down to the bottom in the 'completed' shelf? having to scroll all
  the way down to my next walk item feels wrong." A card whose verdict the
  agent has read (the red-Undo state), or a withdrawn one, moves to a *Done*
  section at the bottom of its walk, oldest first; everything the person can
  still act on stays in its group above. A card with a green Undo stays where
  it was until the agent reads it.
- **The pane follows an answered card.** The owner: "I just answered a really
  long question and when i submitted I was left stranded in the middle of the
  sidewalk bc it moved to the top and shifted underneath me". An answered
  card collapses to one line and everything under it jumps up; now, once the
  repaint lands, the pane scrolls that card to the top with its Undo in view.
  An Ask leaves the card open where it is and does not scroll.
- **File-backed secrets.** On a real walk, an agent could not put a key into a card: its own permission rules refused to read the value into its conversation, which is the right refusal.
  So a secret can now be `{label, file: "operator-key.txt"}`: a bare filename the daemon reads from
  its own `secrets/` folder under the data dir (created and printed by `walkd
  serve`). The value goes file → daemon → clipboard and never enters a
  conversation; a path or `..` is refused by the schema, a missing file is
  refused with the folder in the message, and these survive a restart.
- **The mark.** The Kerb logo from the design language (three slabs and a
  blue kerb on a dark tile) is the extension's icon: `icons/mark.svg` and
  `mark-16.svg` are the sources, `node icons/render.mjs` renders the 16 / 32 /
  48 / 128 PNGs the manifest names (toolbar, extensions page, store), and
  `wordmark.svg` is the mark with the word for listings and docs.
- **Fidelity pass on Kerb v3** (the design agent reviewing the shipped pane
  against its own spec): the blocked diagnostic is a sentence, not the
  expectation's JSON — *expect[2] text meta[name=build] content: wanted
  "fac3493f", saw "fix-001"* (`describeExpect`, unit-tested); dead buttons
  keep their slab and only their word and edge go quiet, so the row still
  reads as a keyboard; group headings sit 8 px above their cards. Kept
  against the spec: the note box's resize handle, because the owner types long
  notes.
- **The pane in Kerb v3.** The settled design language replaces the placeholder
  rendering. Atkinson Hyperlegible (OFL) is bundled as woff2 with the
  extension — nothing is fetched at runtime — and the ten-value palette is
  custom properties on `:root`, redefined under `prefers-color-scheme: dark`;
  seven type sizes are multiples of one pane base, so the gear still moves the
  whole pane. Every card carries a 4 px kerb on its left edge, painted the
  slab colour when it has no state so a state arriving never shifts the text:
  accent blue and breathing for the current card, orange for blocked (orange
  outranks blue), pass green / issue red / edge grey / ink for an answered card
  the agent has not read, none for fresh, refused and withdrawn. An answered
  card is one line — the verdict, the title, then the person's words in muted,
  which is the half allowed to trail off — with the outlined Undo at its right
  end; *Pass, with a note* collapses to *Pass*, a sequence's *N of M steps*
  leads the trail, and on a decision the option leads and the title trails. At
  the Done shelf the slabs stop: the verdict becomes a mark in a 22 px gutter
  (tick, cross, chevron, dot, dash, struck dash) in the colour its kerb had,
  under a rule, a *Done* heading and its count. The connection line names the
  daemon and its port in both states. `node e2e/shots.mjs` takes pictures of
  the real pane, light and dark.

## 0.1.2 — 2026-09-17 — the suite that walks the pane, and what it found

Fifteen end-to-end tests now drive the real extension in a real Chromium
against the fixture site (`MANUAL.md` §7). Everything below except the
first two entries is a defect the suite caught on its way in; none of them were
known when it was written.

- **The e2e no longer takes the daemon's port.** The worker reads `walkd:port`
  out of `chrome.storage.local` at startup and whenever it changes, defaulting
  to 8760, so a second daemon can be walked beside the one you are using. The
  suite starts its own walkd on 8761 and its own fixture site on 9342 and points
  the extension at them; nothing it runs binds 8760 or 9340. "Stop your daemon
  before the e2e" is gone from the README.
- **Moving the port moves everything with it.** The views on screen belong to
  the daemon they came from, so they are dropped, and a read or a refresh that
  was already in flight is abandoned rather than allowed to land on the new
  daemon — one of them subscribed the new daemon to the old one's walk, and one
  of them read the new daemon's walks as gone and emptied the pane.
- **A walk the daemon has never heard of no longer kills it.** `sse` looked the
  walk up and the rejection escaped the request handler as an unhandled
  rejection, so a single `GET /walks/<unknown>/events` took walkd down with it.
  It is a 404 now. A pane pointed at a second daemon asks that on its first
  reconnect, so this was one browser refresh away from anybody.
- **Settings were always open.** The gear set `hidden` on a section the
  stylesheet gave `display:flex`, and an author rule beats the browser's own
  `[hidden]` whatever the specificity. The button looked dead because it was.
- **Three quick presses of Go filed three `blocked` verdicts again.** The
  dedupe 0.1.1 shipped reads the item's verdicts before deciding, and a press
  can spend three seconds waiting for the page — so three impatient presses all
  read that list before any of them had written to it. Presses that overlap on
  one item are one press now; the dedupe covers the rest.
- **Undo handed back a card with the option ticked and Submit dead.** The pane
  cleared what it remembers *after* telling the worker, and telling the worker
  paints: the repaint read the maps before they were set. The same ordering
  left an asked card showing a question in a note box the pane had already
  forgotten, with Issue looking alive over an empty draft. Both are settled
  before the worker is told now.
- **A walk closing no longer erases its cards from under you.** The agent
  closing a walk took the pane with it mid-answer, which also made the refused
  card unreachable: a verdict on a closed walk is exactly the 400 that
  `walkd:dead` and *Refused by the walk server. Answer this one again.* exist
  for. A walk that closes while you are looking at it stays until the pane does.
- **`Decided: __other`** showed the token the wire uses instead of *Other*.
- **A look item's url must be a page.** `javascript:`, `data:` and `chrome://`
  all satisfied the schema's URL check. They are refused now, with a reason the
  agent reads, rather than reaching a pane that will not link them and a Go that
  cannot navigate to them.
- **A short request to the daemon gives up after ten seconds** instead of
  hanging forever with a panel waiting on a reply that never comes.

Known and not fixed: the worker opens one SSE connection per open walk, and
Chrome allows one origin six. Past that, health checks, reads and verdict posts
queue behind the streams and the pane stops moving with nothing on screen to
say why — the ten-second give-up above at least makes it say "no walk server".
Six open walks at once is not today's shape, but the fix is one stream for all
walks rather than one each, and it is a daemon route, not a patch. (Fixed
2026-09-18 — see "One stream per daemon, not one per walk" above.)

## 0.1.1 — 2026-09-17 — first hands-on feedback

The owner walked the `first-look` walk on 0.1.0. Everything below is from that
half-hour.

- **Text size.** A gear at the top right of the header opens one setting,
  *Text size*, stepping 80/90/100/110/125/150 % around the current value. The
  base font is 15px now, not 14. The choice is remembered per viewer in
  `chrome.storage.local` under `walkd:ui`.
- **Slim question cards.** Every decision-sheet section — `eli5`, `proposal`,
  `why`, `downsides`, `facts`, `recommendation`, `costIfWrong` — is optional;
  a question is a title and 2–4 options, plus whatever the question earns. The
  pane renders only the sections that are there, and a single section carries
  the card with no label at all. The first option is tagged *Recommended*.
- **Undo.** A decided question collapses to one line, `Decided: <option>`, with
  a red *Undo* beside it. It asks inside the card rather than in a browser
  dialog, and files an `undo` verdict naming the option being taken back; the
  card returns answerable with that option still picked. An `undo` after a
  `decision` reads as unanswered again.
- **Ask is a button.** The "ask the agent" tickbox is gone. `ask` is a verdict
  kind with its own button next to Skip on a look card and next to Submit on a
  question card; the note box is the question and it is required. An asked card
  stays answerable and reads *Asked. Waiting for the agent.* The `ask` boolean
  stays in the schema, optional and false, so older verdicts parse; nothing
  sets it.
- **Blocked dedupe.** Pressing Go on an item that is still not ready used to
  file another identical `blocked` every time — the owner's walk has three in a
  row. It now re-shows the card and files nothing unless the diagnostic
  changed.
- **No more machine words in the person's note.** One verdict in that walk
  carried the pane's own `blocked` diagnostic as the human's `issue` text. The
  note box was never pre-filled — three tests now hold that shut — but Issue on
  an empty box returned silently, so the button read as broken and the
  diagnostic was the only text on the card to make it work. Buttons that need
  words are disabled until there are words.
- **The page is a link.** A look card shows its `url` under the title, opening
  in its own tab, so nobody has to spend Go to go and look.

## 0.1.0 — 2026-09-16 — first cut: walkd, walkd-mcp, sidewalk extension; e2e green

- The extension takes the **all-sites host permission** (`<all_urls>`) as a
  required one: Chrome warns once when it is loaded, nothing is asked during a
  walk, and every verdict carries its screenshot. The per-site optional grant
  that shipped first could not buy a picture, so it is gone.
- A verdict the daemon refuses outright is no longer silent: the header counts
  it and the card asks for the answer again.
- A verdict clicked while the daemon was down no longer disappears from the
  pane when the daemon comes back.
