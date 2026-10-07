# The Lamppost demo

A whole sidewalk walk, on a product that does not exist, that anybody can
start in one command and film.

**Lamppost** is the product: a status page, a row of five lamps — API,
Dashboard, Webhooks, Email, Search — green when things are fine, amber under
maintenance, red when they are not. Four pages, plain HTML, no build step,
nothing that reads the clock or a random number, so the site on camera today
is the site on camera next month.

**The walk** is seven cards over two groups, written so that between them they
touch every feature the pane has: Go and its outline, an `expect` that blocks
a card until the page catches up, a sequence with a tick per step, a small
question, a secret with a Copy button, an info card, an Ask answered by the
agent, the free Undo turning from green to red, the Done shelf, and cards
arriving in the middle of a walk.

**The launcher** plays the agent. It talks plain HTTP to the daemon, so the
demo does not need a Claude session and runs the same way every time.

## Run it

Three things have to be true first — the ordinary sidewalk setup, `MANUAL.md` §1–§2:

1. `npm run build` has been run in this checkout;
2. the daemon is up — `npm start` — on 8760;
3. the extension is loaded unpacked from `packages/extension/dist`, and its
   pane is open.

Then:

```bash
node demo/run.mjs
```

It starts Lamppost on **9350** (and leaves an already-running one alone),
opens a fresh walk, and prints what it is doing. Ctrl-C closes the walk and
stops the site if it was the one that started it.

To look at the site on its own, without a walk: `node demo/site/serve.mjs`,
then <http://127.0.0.1:9350/>.

## What happens, in order

| When | What lands | What it is there to show |
|---|---|---|
| straight away | the walk's **brief** under the title | two sentences the person reads before the first card |
| straight away | **group A**, four cards | the pack below |
| after 30 s | `/history` is rebuilt, **group B** arrives above group A | cards landing mid-walk; the pane puts the newest group on top |
| every 20 s | the launcher reads | a verdict's **Undo goes from green to red**, and the answered card drops to the **Done shelf** |

### Group A — home and lamps

- **The lamps are green** (`look`). Go navigates the tab and outlines the row;
  the card's `expect` checks the url and the build id in `meta[name=build]`
  before the card is shown at all.
- **The maintenance lock** (`sequence`). Three steps on one page: turn the lock
  on and the lamps go amber behind a banner, press *Post an update* and nothing
  happens because the button is off, turn it off and the lamps come back. One
  tick per step, one verdict, and the verdict says which steps were ticked.
- **What do we call the two paid tiers?** (`question`). A decision that takes
  ten seconds: a title and three options, the first tagged *Recommended*, and
  no decision sheet — which is what a small question is supposed to look like.
- **Last week's incidents** (`look`). This one is **blocked**. Its `expect`
  wants build `lp-24` and `/history` is still serving `lp-23`, so pressing Go
  paints the card's kerb orange and shows the diagnostic in one line instead
  of showing a card that cannot pass yet. When group B lands, the history page
  is rebuilt: press Go again and the card opens.

### Group B — settings (after 30 seconds)

- **Paste the API key** (`sequence` with a `secrets` row). The card carries
  *Demo API key* as a row of dots and a **Copy** button — the person's own
  hand puts the key on the clipboard, because no agent can. Paste it into the
  field, press Verify, and the page says *Key accepted.*
- **The status link** (`look`). Press *Copy status link* on the dashboard; the
  button reads *Copied* for two seconds.
- **Settings landed** (`info`). A note with a single Dismiss, and the nudge to
  press Go on the history card again.

### Ask, on any card

Press **Ask**, type a question, and the launcher answers it the way an agent
would: an info item with the id `lp-ask-<n>` and `supersedes` set to the card you
asked from. It is not a card of its own — it lands *on* that card, where *Asked.
Waiting for the agent.* was, and the waiting kerb goes yellow until it does. The
card was answerable the whole time, and answering it is what resolves the ask.

### The two things easiest to miss on camera

- **Green Undo, red Undo.** An answered card keeps an Undo at its right end.
  It is green while no agent has been handed the verdict — one click and it is
  as if it was never filed. The launcher's read is what hands it over, so on
  the default 20-second rhythm you have a window to film the green one, and
  then it turns red on its own.
- **The Done shelf.** Once a verdict has been read, its card leaves the group
  and becomes one gutter mark at the bottom of the walk, so what is left to do
  stays near the top.

## The flags

| Flag | Default | What it does |
|---|---|---|
| `--port` | 8760 | the walkd the extension is pointed at |
| `--site` | 9350 | the port Lamppost runs on |
| `--after` | 30 | seconds until the history page is rebuilt and group B lands |
| `--read` | 20 | seconds between agent reads |
| `--manual` | off | read only when Enter is pressed, for a take that has to hit a mark |

```bash
node demo/run.mjs --after 10 --read 5      # a quick rehearsal
node demo/run.mjs --manual                 # you decide when the Undo goes red
```

## Repeatable

- Every run **opens a new walk**, `demo-1`, `demo-2`, … The daemon will not
  reopen a closed one, so a finished take never gets mixed into the next.
- The launcher **resets the site** at the start: `/history` goes back to
  `lp-23` so the blocked card is blocked again.
- The maintenance lock is deliberately **not** remembered: a reload clears it.
  The theme is remembered (it is a real product's setting) — press **System**
  on the dashboard to put it back.
- The walk closes with `Lamppost demo: <n> verdicts.`, on Ctrl-C or ten
  seconds after every card has an answer.

## The take

Everything above needs a daemon, a pane and a person. `demo/record.mjs` brings
its own: one command stands up a walkd, a Lamppost, an agent terminal and a
Chromium with the unpacked extension, plays the person's part once at a human
pace, and leaves the footage. The part is **27 beats**, each with a name and the
line the cut captions from — `BEATS` at the top of `demo/record.mjs` is the list,
and the take asserts itself against it as it plays. Two of them,
`agent-read-lamps` and `show-shelf`, are there for the cut rather than for the
product: the whole Undo story is beats 3–7, so *free until an agent reads it* can
be told in one continuous stretch instead of dissolving to a pane thirty seconds
away. The owner, on the take before this one: *"maybe you hit pass on two, then undo
one in the green, letting the second fade to red, then scroll if needed or
whatever or not, then conclude as you did."* So two answers go on the ledge, one
is taken back while its Undo is green, the other is left for the agent's read to
turn red — and because at 400×900 the Done shelf is below the pane's fold,
`show-shelf` scrolls the pane down to it on the wheel, holds, and scrolls back to
where the next press needs the pane. Both scrolls are filmed; nothing jumps.

**Three surfaces, one clock.** The Lamppost tab, the side panel, and the agent
session — a real terminal, written to on the same beats (§ The terminal surface).
There used to be a second recorder for the agent's side, which meant two takes
with two clocks and a cut that could only dissolve between them. The owner,
2026-10-05: *"I think you could probably incorporate the terminal in with the
site and regular side-walk"*. So there is one recorder, and `timeline.json`
carries all three surfaces the same way.

**Two schemes.** `--scheme light` (the default) and `--scheme dark` are two takes
of the same part, with `prefers-color-scheme` emulated on the pane and on
Lamppost — the pane follows Chrome's theme and has no toggle of its own
(`panel.css`), and Lamppost honours it too unless its own System/Light/Dark
setting has been pressed, which nothing in the take presses. The terminal's own
look is **not** the scheme: it is `--terminal-theme`, and it stays dark in both
unless you say otherwise.

```bash
node demo/record.mjs --speed 1 --no-overlay                  # the light take
node demo/record.mjs --speed 1 --no-overlay --scheme dark     # the dark one
node demo/record.mjs --terminal-size 1440x520                 # a different terminal frame
node demo/record.mjs --terminal-theme light                   # a light terminal, if ever asked for
node demo/record.mjs --out demo/out/rehearsal --speed 2       # a rehearsal: quicker hand, holds ÷ √2
node demo/record.mjs --keep-frames                            # keep the JPEGs, and every frame's stamps
node demo/record.mjs                                          # with the pointer in the footage
```

It takes nothing you are using: its walkd is on **8763**, its Lamppost on
**9353** (the pack's 9350 is rewritten on the way in, urls and expectation
regexes alike), the terminal page on **9354**, Chromium's remote debugging on
**9343**. The light take goes to `demo/out/lamppost` and the dark one to
`demo/out/lamppost-dark`; each is emptied before the take starts and the next
take of that scheme overwrites it. `--out` names a folder only while comparing
two takes, and that copy goes when the comparison is done. `demo/out` is
gitignored — footage does not live in the repo.

| What it leaves | |
|---|---|
| `site.mp4` | the Lamppost tab, 1440×900, H.264 at a constant **60 fps** |
| `pane.mp4` | the side panel page, 400×900, the same |
| `terminal.mp4` | the agent session, `--terminal-size` (1212×440), the same — drawn 1:1 by the cut |
| `timeline.json` | the index the cut works from — below |
| `shots/<nn>-<name>-pane.png`, `-site.png`, `-terminal.png` | all three surfaces at every beat |
| `frames/` + `frames/stamps.json` | only with `--keep-frames`: every JPEG, and when each one was swapped by the compositor and when it reached this process |

**It exits 1 on a take that is not worth cutting.** The one failure this
pipeline cannot see on its own is a surface that stopped moving: the muxer
holds the last frame into every empty slot, so a dead pane comes out as a
full-length *frozen video* rather than an error. So distinct frames are counted
per surface as they arrive, printed at the end, written into `timeline.json`,
and a take with fewer than **30** distinct frames on the site or the pane fails
the run.

**The terminal gets a floor of its own, and it is a count rather than a guess.**
The three surfaces are not equally busy: the site and the pane change under the
hand and count thousands, while the terminal only changes when a block prints
and counts **64** — which is honest footage of a surface that is mostly still,
and has to pass. But 30 was tuned to the two surfaces a hand moves, so under it
a terminal that lost most of its blocks would still pass. The recorder knows
how many blocks it printed (`timeline.terminal.printed`), and a take that filmed
all of them cannot have produced fewer distinct frames than that — so that count
*is* the floor, it keeps up with the transcript by itself, and it still catches
the failure the whole check exists for, because a surface that stopped
compositing produces one distinct frame and not one short of its count.

### The camera

`demo/capture.mjs` films each surface with
`page.screencast.start({ onFrame, size, quality: 100 })` and muxes the JPEGs
itself: `-f image2pipe -framerate 60 … -c:v libx264 -crf 16 -pix_fmt yuv420p`,
through the ffmpeg on your PATH (Homebrew's; Playwright's own bundled ffmpeg
has no libx264, which is why Playwright is stuck on VP8). A frame goes in the
slot `round((t − t0) × 60 ÷ 1000)` of the moment it was *swapped by the
compositor*; a slot with no frame of its own holds the last one; and the slots
before the first frame hold the first frame, so a slow first paint does not
shift everything after it. That arithmetic is `placeFrames`, and it has unit
tests.

Five things worth knowing, all of them measured by `demo/probe-capture.mjs` and
`demo/probe-paint.mjs` (one-offs, kept for the next person who doubts any of
this):

- **Nothing is filmed until all three surfaces are settled.** The window is
  fitted, the terminal is up and resting at its prompt, the pane is asked for
  the walk and its header is waited for, the site is painted — *then* the camera
  starts. There is no half-sized opening second to cut around. Group A is **not**
  waited for any more: it lands inside the `open` beat, as the terminal prints
  the call that adds it.
- **A visible tab is filmed at its browser window's content area**, not at its
  emulated viewport. `page.setViewportSize` is the call that moves the window
  (`Browser.setWindowBounds`); `bringToFront` does not resize anything, it is
  one `Page.bringToFront` and nothing else. The two pages share one window, so
  the pane's `setViewportSize` moves it to fit a 400 px page and the site's own
  call cannot move it back — Playwright early-returns when the metrics are
  unchanged. Left alone, the site films at **500×713 in a grey field, for the
  whole take**, which is what the old `recordVideo` output looked like.
  `fitWindow` measures the browser's insets by filming one frame, corrects,
  checks, and throws rather than carry on.
- **A hidden tab has no window widget and is filmed at its emulated
  viewport**, which is why the pane has never had that problem. The pane stays
  a background tab, because the extension's Go and its screenshot both work on
  `chrome.tabs.query({active: true})`.
- **A background tab stops redrawing between actions, so the recorder makes it
  redraw.** Chromium produced no frame at all for the pane while the hand was
  still: in take-11 the blocked diagnostic was in the DOM at 25.6 s and the next
  frame came 3.6 s later, in one jump, on the frame the beat's own
  `page.screenshot()` forced. (The old line here — *62 fps and 941 distinct
  frames, not throttled, a window of its own measured no better* — was measured
  by a probe that moved the hand for the whole 20 s it measured, and was wrong.)
  It is not a *visibility* problem: Playwright's own init-time
  `Emulation.setFocusEmulationEnabled` already holds the pane at
  `visibilityState: "visible"`, and sending it again changed the worst lag by
  1 ms, as did a no-op mouse move every 25 ms for a whole take. What the pane
  is short of is a **redraw**, and `Page.captureScreenshot` is the only thing
  CDP exposes that forces one — which is why the stills had the diagnostic in
  them and the footage did not. So `keepPainting` takes one every **25 ms** for
  the whole take, at `quality: 0`, and throws it away: nothing is drawn, no DOM
  event is dispatched, the pointer does not move, and the cursor track is
  untouched. Measured over a `--speed 2` take, the worst change-to-frame lag
  goes from **3558 ms to 22 ms** and the biggest gap between pane frames from
  3672 ms to 74 ms. `timeline.json` carries the count. It must not be clipped:
  Chromium emulates device metrics around a clipped capture, and at this rate
  that makes the page un-clickable. **One thing it cannot fix:** a forced
  redraw draws the page as it is and does not advance an animation's clock, so
  the pane's breathing kerb stays still while the hand does — take-12's
  left-hand 8 px over three seconds is 180 byte-identical frames. The kerb's
  *colour* changing is a DOM change and is in the footage to the frame; only
  the breathing is missing, and nothing in the cut turns on it.
- **There is no 2× master to be had.** The screencast is CSS pixels;
  `deviceScaleFactor: 2` raises `devicePixelRatio` and changes nothing about
  the JPEG. The viewport is the only lever on resolution, which is why the site
  is 1440×900 and the pane 400×900 rather than the 1280×800 and 380×800 a real
  docked pane gets.

### The pace

The owner, on the Secrets short cut from the take before this one: *"there's like 7
clicks/scene changes in 7 seconds… are you sure it isn't too fast? Typing words
fast is fine, the mouse movements look ok, but then the clicks are rapid and
click-to-click is too rapid."* The footage agreed to three decimal places: eight
presses in 9.956 s of it, median gap 1174 ms, minimum 942 ms. **One rule was
missing.** `press()` was `look` → glide → click → *nothing*, so the only thing
between two presses was the next look and the next glide, and a beat that wanted
more had to hand-write a hold — half of them didn't.

`demo/pace.mjs` is that rule and the arithmetic around it. It is pure, so it has
unit tests and no browser (`demo/pace.test.ts`). At `--speed 1`:

| Knob | ms | Where it applies | What it rests on |
|---|---|---|---|
| `look` | **500** | before every press, tick, tap and typed string | the 450–550 ms every scripted-demo project lands on; Playwright's own agent filming paces actions by 800 |
| `settle` | **400** | after **every** press, whatever it did | Potter 1976: a scene is understood in ~100 ms and needs *"about 300 msec of further processing"* to survive the next picture |
| `read(words)` | **clamp(900 + 200 × words, 900, 3500)** | after a press that changed words on screen | 900 is Rensink 1997's measured 0.9 s to notice *and identify* an unmasked change, which is also ITC 1999's *"at least one second"* to adjust to a new picture; 300 ms a word is the BBC's own subtitle figure at the slowest rate Ofcom still calls comfortable (200 wpm) |
| `land` | **900 + 300** | after a navigation. The 300 is the site's own colour transition — the product's animation, so no speed flag touches it | the 1200 ms a Go really costs, in one place at last |
| `afterTyping` | **700** | between the last typed character and the next press — and after the pasted key, which is the same event | Netflix's *"at least half a second past the end of the event"*, rounded up past Potter's 400 |
| `type` | **45** a character | typing | unchanged. The owner: *"typing words fast is fine"* |
| `clickHold` | **105** | mousedown → mouseup | a person holds a mouse button 100–120 ms; Playwright's `delay` defaults to **0**, and an instant release reads as synthetic |
| `ring` | **500** | how long `demo/overlay.mjs` leaves the ring where a press landed | ~200 ms to program the saccade and 230–330 ms for the first fixation: at the 300 ms it was, the ring was routinely gone before the eye arrived |
| `read: false` | **`settle` + `land`** | not a number but a switch, on a beat in `BEATS`: this beat's press is a confirmation the viewer already expected, so no words are counted and it holds what a Go holds, `settle` then `land` (`pace.confirm()`). One beat has it, `copy-key` | the owner, watching the Copy button in the Secrets short: *"the time after clicking copy on the secret is still a lot, it should be the same delay time as after clicking the go button right before it."* A Copied label is a receipt, and nobody reads a receipt |

Five rules sit on top of the table:

- **The hold after a press is `max(settle, read)`, never the sum.** The read
  subsumes the settle rather than stacking on it.
- **Which words are new is measured, not declared.** `innerText` on both
  surfaces before the press and again after `settle`; `freshWords` counts the
  words that have **never been on that surface before in this take** (a
  running multiset per surface, so a second copy of a word is new once). Text
  that only went away, was reordered — a card dropping to the Done shelf — or
  came back — the green Undo restoring a card's controls — counts zero, and a
  press that changed nothing holds `settle` and no more. The honest
  alternative, a word count written into each beat by hand, goes stale the
  first time the copy changes and does it silently.
- **A beat may say its press is not worth a read.** `read: false` in `BEATS`,
  and then the words are not counted at all and the press holds what a Go
  holds — `settle`, then `land`, summed the way a Go sums them — because
  the owner's measure for it was the Go right before it. `timeline.json` carries
  `readRule: "off"` and the `land` on that beat's `hold` so the cut can see
  where the time went.
  It is a switch and not a number for the same reason the count is measured:
  the judgement *"the viewer already knows what this press did"* does not go
  stale when the copy changes, and a number would. **`copy-key` is the only
  beat that has it**, and the only kind of press that earns it is a receipt —
  the Copy button saying *Copied* for a press the viewer just made.
- **Every hold is jittered ×0.7–1.3, seeded** on the beat's name and which hold
  of that beat it is, through the same `seeded()` the hand uses. A fixed beat
  reads as a metronome; a seeded one still comes out frame for frame the same
  take twice. The nudge is applied *before* the cap, so a `read` never passes
  3.5 s however the jitter falls — `go-history-blocked` reads exactly 3500 on
  take-8. (§8 of the research note nudges after the clamp instead, which let a
  capped read run to 6.5 s; it was changed when the cap came down to 3.5 s.)
- **`--speed` is two dials.** The hand — travel and typing — divides by `speed`.
  The holds divide by **√speed**, with a 300 ms floor: a rehearsal's hand can be
  made twice as quick without lying about the take, because the hand is the
  performer, but its reading time belongs to the viewer and a rehearsal still has
  to be legible enough to confirm a state change landed. So `--speed 4` is a 4×
  hand and 2× holds. **A take that will be cut is shot at `--speed 1`;** nothing
  above 1 is footage.

The beats keep only the holds no rule covers, and each says which it is: the
product's own (the outline breathing after a Go, a change that arrives on the
daemon's or the agent's clock, after the press's snapshot or with no press at
all) and the take's two ends. Everything else went.

What it costs, measured on a check take at `--speed 1`: **93.6 s → 136.0 s**,
the same 31 presses, and the median gap between two presses **1417 ms → 3087 ms**
with the minimum **942 → 1283**. Over the stretch the owner was watching — `go-key`
to `go-share`, the Secrets short — one press every **3.1 s** instead of every
1.17 s.

Two takes later, with the `read` cap at 3500, `copy-key`'s read switched off and
the 13 s `agent-read-lamps` beat added, **take-8 runs 139.3 s** — still 31
presses, median gap **2870 ms**, minimum **1281**. The longest gap in it,
**15.0 s**, is `agent-read-lamps`: a wait the product owns, with no press in it
at all. Measured from the release of the press to the next beat, the Go on the
key card holds **1916 ms** and the Copy after it **1661 ms** — the same delay,
as asked, where the old read rule had held Copy for 3.5 s.

That is slower than the research's own estimate of ~122 s and one press every
2.35 s, and the reason is worth knowing before anyone retunes a number: the
estimate assumed a text-changing press changes about **four** words, our median
on-camera string. Measured, the big ones are much bigger — pressing the green
Undo brings a whole card's controls back and counts **38** new words, the blocked
kerb's diagnostic **28**, the Copy button and its note **22** — so those presses
sat at or past the cap (then 5 s) instead of at 2.1 s. Nobody re-reads a control set,
so the count is now of words never shown on that surface before (`freshWords`
above): the restored card counts ~0, the diagnostic still counts its 28. The
cap is also applied after the jitter, so no read passes it. The remaining
lever if it still reads slow is §4.2's `0.9 + 0.20 × words` — not a shorter
cap, and not going back to no hold at all.

Every number above, its source, and the places the sources disagree are in the
pacing research note, kept outside the repo.

### The hand

The owner, on the take before this one: *"the mouse movements do not really look
smooth or human like"*. They were not. Every move was one
`page.mouse.move(x, y, { steps: 20 })` — a **straight line at a constant
speed**, fired as fast as CDP would carry it, from one target's **centre** to
the next target's centre. Three things wrong at once, and `demo/hand.mjs` is all
three fixed. It is pure, so it has unit tests and no browser in it.

- **The line is an arc.** The geometry comes from
  [`ghost-cursor`](https://www.npmjs.com/package/ghost-cursor)'s `path()`: a
  cubic Bézier through two anchors thrown off the line of travel, which is what
  the anti-bot people worked out a human arm does.
- **The speed is Fitts's law.** `a + b·log2(distance / width + 1)` — longer for
  a further target, longer again for a smaller one — and the position along the
  arc is eased (smootherstep), so the pointer accelerates away, coasts, and
  decelerates in. A throw over 160 px goes a few pixels **past** the target and
  flicks back, which is the other half of what a hand does. Real numbers from a
  take: 57 px in 313 ms, 455 px in 595 ms, 668 px in 653 ms.
- **The centre is not the centre.** Nobody hits the middle of a button twice.
  Each target lands a few pixels off its centre — the **same** few pixels for
  that target for ever, because they come from a seeded hash of the thing that
  names it. Nothing in here calls `Math.random`: two takes of the same beat have
  to come out the same frame for frame, or the cut has to be re-timed every time
  the footage is re-shot.

The path comes back **sampled at the take's own 60 Hz**, each sample with its own
millisecond offset. The recorder plays those samples against absolute deadlines
rather than sleeping between them, so a slow CDP round trip costs the move
nothing instead of stretching it; each one is a real `mousemove`, so hover states
happen and the pane repaints — which is what keeps frames coming out of it while
nothing else on it is changing. And `hand` passes Playwright's `position` option,
so the press lands where the hand landed: a bare `locator.click()` moves the
mouse to the element's centre itself and would undo the aim in one frame.

Three notes for whoever changes this next:

- `ghost-cursor` **1.4.2**, not `ghost-cursor-playwright` 2.2.1. The Playwright
  wrapper depends on `playwright-core ^1.63.0` and this repo is pinned to
  `@playwright/test` **1.62.1**, so taking it installs a second playwright-core
  beside the pinned one. What the wrapper sells is glue, and the glue is the part
  worth owning — our own `page.mouse.move` loop is what makes every sample a real
  event and the track the whole path. The path maths is the part worth buying.
- `path()` calls `Math.random()` four times and takes no seed, so the global is
  swapped for the run of the call. That is safe for one reason only: `path()` is
  **synchronous**, so on one thread nothing can observe the swap.
- Left to itself it bows the arc by a *random fraction* of
  `clamp(distance, 2, 200)` — so a 400 px move can bow 200 px, which is off the
  400 px-wide pane altogether; and the same randomness means an unlucky seed
  draws a straight line, which is the one thing we are here to stop. So the
  spread is a few percent of the distance, the arc is kept inside the surface,
  and the bow is measured and the spread widened until it actually arcs.

### The cursor you can see

Both ways, because they are for different readers.

**In the footage**, `demo/overlay.mjs` puts a pointer in the **DOM of both
surfaces** — a pointer SVG that follows `mousemove`, and a 500 ms ring on
`mousedown` where the press landed (`RING_MS`; it was 300, which is less time
than the eye needs to get there). Being real DOM, it is in the footage like
anything else the page draws, exactly where the hand is, with no second clock of
its own. `pointer-events: none`, `position: fixed`, appended last, and it
re-appends itself if one of the pane's rerenders takes it. It is put away around
the beat stills, because the stills are documentation. **`--no-overlay`** films
clean footage for the cut; `timeline.json` records which you got, so the cut
knows whether to draw its own.

Playwright's `screencast.showActions` used to do this job and is **gone**. Not
only because of its `Mouse move` / `Click` title, which cannot be turned off
while keeping the pointer: it animates between action points **on its own
clock**, so it did not go where the real pointer went. Two pointers disagreeing
with each other, and neither of them easing, is what the owner was looking at.
`ghost-cursor`'s own `installMouseHelper` is not the replacement either — it is
written against Puppeteer (`page.evaluateOnNewDocument`), which does not exist on
a Playwright `Page`, so it throws on contact; its README says *"use for debugging
only"*; and its 20 px translucent dot does not read as a cursor on camera.

One place the overlay does land, deliberately: the extension photographs the
active tab with `chrome.tabs.captureVisibleTab` when a verdict is filed, and that
is a real render of the site page, so **the overlay is in those verdict
screenshots**. It is not in the way of anything — those pictures are the demo
launcher's own, they reach neither the footage nor the stills nor the cut, a
cursor showing where the person was is not wrong in one, and `--no-overlay`
removes it from the whole take. The pane's own screenshots (`shots/`) never have
it: it is hidden before every one.

**In the file**, every sample of every move and every press and release is logged
as a cursor track, so the cut can draw its own pointer instead: sharp at any
zoom, with its own easing and ripple, and no dependence on what the browser
managed to composite.

### `timeline.json`

```jsonc
{
  "startedAt": "2026-10-04T05:00:10.973Z",
  "fps": 60,
  "overlay": true,
  "scheme": "light",                                  // or "dark"
  "pace": { "speed": 1, "look": 500, "settle": 400,
            "read": { "base": 900, "perWord": 200, "min": 900, "max": 3500 },
            "land": 900, "colour": 300, "landTotal": 1200, "afterTyping": 700,
            "type": 45, "clickHold": 105, "ring": 500,
            "jitter": [0.7, 1.3], "floor": 300, "rule": "…" },
  "surfaces": {
    "site": { "file": "site.mp4", "size": [1440, 900], "t0": 0, "fps": 60,
              "frames": 9878, "seconds": 164.6,
              "received": 4942, "distinct": 3707, "odd": 0 },
    "pane": { "file": "pane.mp4", "size": [400, 900], "t0": 8, "…": "…" },
    "terminal": { "file": "terminal.mp4", "size": [1212, 440], "t0": 3, "…": "…" }
  },
  "terminal": { "theme": "plain agent terminal", "scheme": "dark",
                "xterm": "6.0.0", "renderer": "dom",
                "cols": 115, "rows": 17, "wrap": 100,
                "font": { "family": "…", "size": 17, "lineHeight": 1.2 },
                "viewport": { "width": 1212, "height": 440 },
                "crop": { "x": 0, "y": 0, "w": 1212, "h": 440 } },
  "events": [
    { "t": 0, "name": "terminal-video-start", "item": null, "note": "…",
      "frame": { "site": 0, "pane": 0, "terminal": 0 } },
    { "t": 6482, "name": "go-lamps", "item": "lp-lamps", "note": "…",
      "frame": { "site": 389, "pane": 388, "terminal": 389 },
      "hold": { "settle": 326, "read": 2730, "newWords": 6, "ms": 2730 } },
    { "t": 51193, "name": "go-history-blocked", "item": "lp-history", "note": "…",
      "frame": { "site": 3072, "pane": 3071, "terminal": 3072 },
      "landed": [ { "what": "the orange kerb and the blocked diagnostic", "t": 56940 } ],
      "hold": { "settle": 743, "read": 6089, "newWords": 39, "ms": 6089 } },
    { "t": 73935, "name": "copy-key", "item": "lp-key", "note": "…",
      "frame": { "site": 4436, "pane": 4436, "terminal": 4436 },
      "hold": { "settle": 496, "read": 0, "newWords": 0, "land": 1000,
                "ms": 1496, "readRule": "off" } }
  ],
  "cursor": [
    { "t": 1144, "surface": "pane", "x": 24, "y": 876, "kind": "move" },
    { "t": 1161, "surface": "pane", "x": 26, "y": 871, "kind": "move" },
    { "t": 1178, "surface": "pane", "x": 33, "y": 854, "kind": "move" },
    { "…": "…one a frame, all the way along the arc…" },
    { "t": 1790, "surface": "pane", "x": 350, "y": 253, "kind": "move" },
    { "t": 1808, "surface": "pane", "x": 350, "y": 253, "kind": "down" },
    { "t": 1861, "surface": "pane", "x": 350, "y": 253, "kind": "up" }
  ],
  "pulse": { "beats": 5612, "failed": 0, "everyMs": 25, "msPerBeat": 19.94 },
  "pulseTerminal": { "beats": 5614, "failed": 0, "everyMs": 25, "msPerBeat": 11.0 },
  "health": { "ok": true, "floor": 30, "frozen": [] }
}
```

- **`t`** is whole milliseconds from the first frame of whichever video started
  first, and for an event it is the moment a beat *starts* — the beat runs
  until the next event.
- **`surfaces.<name>.t0`** is when that video's first frame landed on the same
  clock, so one of the three is always 0. `frames` is how many were written,
  `received` how many Chromium sent, `distinct` how many of those were not
  byte-identical to the one before, and `odd` how many came back the wrong size
  and were dropped. The three are `site`, `pane` and `terminal`, all the same
  shape — so `frameAt()` in `demo/capture.mjs` resolves any of them the same way.
- **`terminal`** is the third surface described: which look it was shot in
  (`theme` is the name, `scheme` the flag), the emulator and renderer behind it,
  the cell grid the page measured for **itself** out of the viewport it was
  given, the width the copy is wrapped to, and that viewport. `crop` is the
  whole surface, because the cut draws this one 1:1; it is in the file only so a
  cut that reads it reads something true.
- **`events[].frame`** is the frame number this moment falls on in *each*
  video, `round((t − t0) × 60 ÷ 1000)`. The cut says
  `<Sequence from={ev.frame.site}>` and never has to reason about milliseconds
  or about three files that did not start at the same instant. Four events are
  not beats: `site-video-start`, `pane-video-start`, `terminal-video-start` and
  `group-a`, which marks the four cards reaching the pane.
- **`events[].landed`** is when a change the beat *waited* for was actually in
  the DOM — the blocked diagnostic, the lamps row leaving the ledge, the
  agent's answer on the card that asked. `until`'s resolve is the moment: the
  poll that returned true is the first poll at which the pane had it, so it is
  up to a poll (100 ms) late and never early. It is there so the question "is this in the
  footage, and how late" has a number on both sides; `demo/capture.mjs`'s
  `keepPainting` exists because for three takes the answer was seconds.
- **`pulse`** is the pane's forced redraws: how many, how often, and what each
  one cost. **`pulseTerminal`** is the terminal's own, under its own name rather
  than folded into the pane's, because the two surfaces cost different amounts
  to redraw. Same section.
- **`pace`** is the numbers this take actually ran on, at this `--speed` — the
  table in § The pace, after the speed scaling, with the jitter band and the
  floor. A cut that finds a beat long can read why out of the file instead of
  re-deriving it.
- **`events[].hold`** is what the pace gave the viewer in that beat: `settle` and
  `read` totalled over the beat's presses, `newWords` the words those presses
  were measured to have changed, and `ms` what was actually slept — which is
  `max(settle, read)` per press, not their sum, so `ms` is usually `read`. A beat
  with no press holds none of it and reads zero; the hold it wrote by hand is in
  its own duration, not here. A beat that switched the read off (`read: false` in
  `BEATS` — only `copy-key`) carries **`readRule: "off"`** here, with `read` and
  `newWords` at zero because nothing was counted and `land` for the landing
  its press held instead: the hold is the rule doing what it was told, not a
  count that went wrong.
- **`overlay`** says whether the in-page pointer was in the footage (`true`
  unless `--no-overlay`). A cut that draws its own pointer over a take that
  already has one puts two pointers on screen, which is the thing being fixed.
- **`cursor[]`** is `{ t, surface, x, y, kind }` where `surface` is `"site"` or
  `"pane"`, `kind` is `"move"`, `"down"` or `"up"`, and `x, y` are that
  surface's own CSS pixels — so the pane's coordinates are inside 400×900 and
  the site's inside 1440×900.

  **It is the path, not the endpoints.** A move used to be one `move` row at the
  target; it is now **one row per sample at 60 Hz**, straight off the arc
  `demo/hand.mjs` drew, then `down` and `up` where the press landed. So a take is
  a few thousand rows rather than a hundred, and the cut can put the pointer on
  the curve the page actually saw instead of inventing a tween between two
  points. A cut that wants a sparser track can decimate it; one that wants to
  draw on its own clock can still read only the `down`s.

  Two rules the recorder refuses a take over, both about a pointer being
  somewhere it never travelled to: every `down` has a `move` before it on the
  same surface, and two consecutive `move`s on one surface are never more than
  **200 px** apart. The second is measured per surface — the pane's pointer does
  not move because the hand went to the site — and from the last *move*, because
  a press is not travel. The first move on a surface is exempt: where the pointer
  rested before the track began is not in the track.
- The stills are taken at the *end* of a beat, so they show what it produced.

**The take, in one paragraph.** The pane opens on the walk with its brief and
nothing else; the person types one line into the agent session and the walk's
four cards land on the pane as `walk_add_items` returns; Go on the lamps card
outlines the row; a Pass, and then the
tiers question decided, so two answers sit on the ledge with two green Undos
draining side by side. The decision's Undo is pressed — the question comes back
answerable with its option still picked — and the lamps row is left alone there
until the agent reads it, about ten seconds later, which takes it off the ledge,
turns its Undo red and drops it on the Done shelf. The pane scrolls down to that
shelf so the red Undo is in frame, holds, and scrolls back: the whole of *free
until an agent reads it, and after that it asks first*, in one unbroken run of
beats. Then Go on the incidents card, which is blocked because the history page
is a build behind; the maintenance lock turned on, its dead *Post an update*
pressed, a step ticked for each, and an issue in the person's own words; the
tiers question answered again; and the agent reads again, which is what hands
those two over. Group B lands mid-walk, the history page is rebuilt and the
incidents card opens this time; the API key is copied out of the card, pasted
into the field and verified; an Ask is answered by the agent on the card it was
asked from, in the place of the waiting line, and the Pass that follows is what
resolves it; the status link is copied; and the agent reads once more, puts
everything on the shelf and closes the walk.

Beside it, on the same clock, the agent session: the call that opened the walk
and the call that filled it, then four `walk_wait`s, each returning what the
person had just done — the pass, then the blocked card and the lock's issue and
the tiers decision together, then the history note and the key's pass and the
question back, then the last two — with the reply to the question added between
the third and the fourth, and `walk_close` after the last.

**Phase 3, the cut, is not in this repo.** A Remotion project reads
`timeline.json`, cuts the three videos against it with `<OffthreadVideo>`,
captions from the `note` on each event, and draws the pointer from `cursor`.

## The terminal surface

`site.mp4` and `pane.mp4` are Lamppost and the side panel. `terminal.mp4` is
**the agent session**. The owner's ask, verbatim: *"showing off that all the
directions and setup is managed through an MCP that links the sidewalk pane to
the orchestrator agent session, so like instead of showing off the mock site
you're showing a mock claude session running that mock site/walk."* It was a
recorder of its own for one round, which made it a second take with a second
clock; it is the same take now.

```bash
node demo/agent/serve.mjs          # the terminal page on its own, on 9354
```

**Seven of the twenty-seven beats print something.** In the other twenty the
agent is inside `walk_wait`, which is the claim: it wrote the walk, and then it
waited, and the person's answers came back to it as data.

| Beat | What the terminal prints | What the pane is doing |
|---|---|---|
| `open` | the person's one line types in, then `walk_open`, `walk_add_items`, the line of prose after it, and the first `walk_wait` with the spinner under it | **four cards land, because of the call** — group A is handed to the launcher empty and added at this beat |
| `agent-read-lamps` | the first wait returns with the pass in it, a line of prose, and the second `walk_wait` | the row leaves the ledge, its Undo red |
| `agent-read` | the second wait returns with **three** verdicts — the pane's own `blocked` on the incidents card, the lock's issue with the steps that were ticked, the tiers decision with the option that was picked — then prose | two more rows leave the ledge, together, because it was one read |
| `group-b` | one prose line where the add would be, then the third `walk_wait` | group B lands above group A |
| `ask-share` | the third wait returns with the history note, the key's pass and the `ask` carrying the `reply` line `ask.ts` puts on it; prose; the reply's `walk_add_items` and its result; the fourth `walk_wait` | the question is typed and asked, the card goes yellow, and the answer lands on the card that asked, where the waiting line was |
| `agent-read-2` | the last wait returns with the last two verdicts, then prose | every card is on the Done shelf |
| `closed` | `walk_close` with the summary, its result, and the prompt resting | the pane says the walk is closed |

### The two decisions, and what they cost

The owner settled the research's two open questions:

- **Expanded tool-call lines**, not the collapsed `Called sidewalk N times`
  form. The whole claim is that the directions and the verdicts travel over
  MCP, and a collapsed line hides exactly the thing being shown.
- **A generic agent terminal now, with the look in one theme file**, so a
  particular agent's theme can be swapped in later if permission ever exists.
  **No product name, no wordmark, no version-and-model header**, and the glyphs
  are plain ones (`●`, `→`) rather than the commonly-seen `⏺`/`⎿`, which §2d
  could not verify in any published doc. A unit test asserts that no vendor's
  name appears anywhere in either theme or in the transcript.

`demo/agent/theme.js` is that file: every colour, the font, the padding, the
prefix in front of each kind of line, the spinner's words, and a `chrome` slot
where a themed header would go (both themes' is `null`). **There are two of
them**, `dark` and `light`, and they differ in seven colours and a name and in
nothing else — a unit test holds them to that. `--terminal-theme` picks one and
it is **not** `--scheme`: the owner, 2026-10-05, *"I lean to keeping the terminal
dark in both schemes"*, so dark is the default in the dark take and in the light
one. The dark palette is the Kerb palette's dark half (`demo/site/styles.css`'s
dark `--page`/`--ink`/`--muted`/`--accent`, `panel.css`'s dark `--pass` and
`--waiting`); the light one is the same seven slots off the light half of those
two files. Nothing in either is invented.

### The terminal

A real `@xterm/xterm` **6.0.0** emulator, the **DOM renderer** (the default; no
addon, so the surface is one dependency rather than three), in a **hidden**
Chromium tab — the extension's Go and its verdict screenshot both work on
`chrome.tabs.query({active: true})`, so Lamppost stays the active tab and a
hidden tab is filmed at its emulated viewport. Both hidden tabs get a
`keepPainting` pulse for the reason § The camera gives, and the terminal needs
it more than the pane does: it changes only when a block prints, so without a
forced redraw it would not send a **first** frame at all and the take would die
on the camera's twenty-second timeout rather than on anything real.

**The size is a flag and the grid follows it.** `--terminal-size WxH`, 1212×440
by default — the owner, 2026-10-05: *"Film the terminal at 1212×440 … the cut draws
it 1:1, so no resampling."* Nothing in the pipeline depends on the number:
`frameFor()` in the theme file builds the frame from whatever viewport the
recorder gave the page, and the page measures one cell and divides to fill it.
At the default that is **115 columns × 17 rows** at 17 px with a 1.2 line height
(xterm's DOM renderer measures a ~20 px line box for this font, which the 1.2
takes to 24 px a row; 20 rows at 440 px would want a line height of 1.0, which
is tighter than the JSON wants). The measurement a take really got is in
`timeline.terminal`. The copy wraps to **100** columns whatever the grid comes
out at, so a narrower frame or a different font cannot soft-wrap a JSON value
somewhere arbitrary.

**The control channel is `page.evaluate`.** The research left a socket, SSE and
evaluate open; evaluate is the one with no connection to lose, no ack protocol
to write, and a return value that *is* the ack. The page exposes
`window.agent.print/type/text` and nothing else.

**Nothing on that surface has a clock of its own.** The cursor does not blink
and the spinner does not spin — one line that stands while a wait is open. Two
takes of the same beats have to come out frame for frame the same, for the same
reason the hand never calls `Math.random`, and a per-take animation is the one
thing the cut could not line up. The person's prompt types at the pace rule's
own **45 ms** a character.

**The terminal gets read holds like the pane's.** A printed block is words
arriving with no press anywhere near them, so it is held for the words that
have never been on *that surface* before — `freshWords` again, counted off the
terminal's own visible buffer rather than off `innerText`. It is **not** in the
list a press counts against: a press in the pane never changes the terminal, and
counting its whole buffer against the take's first press would put seconds of
read on a beat that earned none.

### Every number on screen comes from the daemon

`demo/agent/transcript.json` is the copy; its numbers are `{{placeholders}}`
filled as the take plays. The walk id, group A's item seqs, every verdict's seq
and kind and the person's own words, the steps they ticked, the option they
picked, the cursor each wait is called with, the reply's `lp-ask-<n>` id and its
seq, and the summary the walk closes with are all the daemon's own.

This is not fussiness. The research's §8 sketch assumed one seq counter for
items and verdicts; `packages/walkd/src/store.ts` keeps **two** (`itemSeq`,
`verdictSeq`), so its numbers were wrong and the take's are right: group A gets
item seqs 1–4, the reply is `lp-ask-9` at item seq **8**, and the four waits
return verdict seqs 1 / 4,5,6 / 7,8,9 / 10,11.

**Two of the eleven verdicts never reach the terminal at all**, and that is the
other thing a guess would have got wrong. `undo-tiers` takes back an answer no
agent has been handed, so the daemon marks the pair *quiet* and hides both from
every agent read — which is why the agent's cursor after the first wait is **1**
and not 3. The recorder reads the agent's own cursor off the launcher rather
than the pane's, for exactly this reason.

**The waits return where the daemon returns them.** A `walk_wait` returns when a
verdict **matures** past the grace window, so a beat that films one return
carrying three verdicts waits until all three have matured and then reads once
— which is also what the pane shows, all three of those cards leaving the ledge
on the one read. The recorder works out what the read is about to hand over
(`handable`, the store's own rule over a viewer read, which hands nothing to
anybody), prints it, reads, and **refuses the take** if the read then handed over
anything else. And the person's question is one constant, `ASK_TEXT`: the
recorder types it into the pane, and the beat refuses the take if the verdict the
daemon hands back says anything else. The research's warning was that a
transcript quoting words the pane does not have is the thing most likely to read
as fake.

### The secret trap

A faithful `walk_add_items` for group B would carry the pack's demo API key in
its arguments, in plain text, on screen (§3d). So **group B's add is not
printed as a tool call at all** — one prose line stands in its place, *Group B
is up: the key, the status link, a note.* — and a unit test refuses a
transcript that contains the key, or the `secrets` argument shape that would
carry one, anywhere. The key is still copied by the person's own hand in the
pane, which is the better story anyway.

## The pieces

| File | What it is |
|---|---|
| `demo/site/` | the four pages, one stylesheet, one script |
| `demo/site/serve.mjs` | the static server, and the build id `/history` serves |
| `demo/walk.json` | the walk header, the two groups, and the Ask reply |
| `demo/run.mjs` | the launcher |
| `demo/record.mjs` | the recording: the whole product stood up, the person's part played, and all three surfaces filmed |
| `demo/agent/index.html` + `agent.js` | the terminal page: `@xterm/xterm` in a hidden tab, written to by the recorder through `window.agent` |
| `demo/agent/theme.js` | **the look, both of it** — the dark and light palettes, the font, the prefixes, the spinner's words, the header slot — plus `frameFor()`, which is the camera's and follows `--terminal-size` |
| `demo/agent/transcript.json` | the terminal surface's copy, with `{{placeholders}}` the daemon fills |
| `demo/agent/transcript.mjs` | the transcript loaded, filled, rendered and checked — pure |
| `demo/agent/serve.mjs` | the terminal page's static server on 9354, and the three xterm files it maps onto that origin |
| `demo/capture.mjs` | the camera: the screencast, the 60 fps mux, the window fit, the health rule |
| `demo/hand.mjs` | the hand: the arc, Fitts's-law timing, the easing, the seeded landing spot — pure |
| `demo/pace.mjs` | the pace: the holds, the word count they are measured from, the seeded jitter, how `--speed` scales each — pure |
| `demo/overlay.mjs` | the pointer you can see: real DOM on both surfaces, `--no-overlay` to leave it out |
| `demo/probe-capture.mjs` | a one-off that measures what the camera is up against — not part of a take |
| `demo/pack.test.ts` | the pack parses, and every `[data-walk]` it names is on the page |
| `demo/run.test.ts` | the launcher, driven end to end with tiny timers and no Chrome |
| `demo/record.test.ts` | the retarget, the beat list, the flags, the camera's arithmetic and the hand's path — no Chrome |
| `demo/transcript.test.ts` | the terminal's copy: what it quotes, what it wraps to, the two themes, and that no secret and no TODO marker is in it — no Chrome |
| `demo/pace.test.ts` | the pace maths: the clamps, the `√speed` scaling and its floor, the jitter, the word count |

`serve.mjs` keeps one piece of state, the build id `/history` is serving, and
exposes it so the demo can reset itself:

```bash
curl 127.0.0.1:9350/__demo/history-build                      # {"build":"lp-23"}
curl -X POST 127.0.0.1:9350/__demo/history-build -d '{"build":"lp-24"}'
curl -X POST 127.0.0.1:9350/__demo/reset                      # back to lp-23
```

Footage and a cut video are not kept here. The site and the pack are built to
be filmed — nothing animates but the lamps, nothing is random, nothing is
dated — `demo/record.mjs` shoots the take into an ignored `demo/out/`, and the
cut is made outside the repo.
