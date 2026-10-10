# sidewalk

Your agent builds something, then writes the checklist for you to walk. Cards
open in a Chrome side panel next to the live site. Each one says where to go
and what to look for. Answer it, and the answer goes back to the agent with a
screenshot and your exact words.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://assets.sidewalk.sh/dark/hero-readme.gif">
  <img alt="A terminal on the left shows an agent calling walk_open and walk_add_items, and the four cards appear in the side panel on the right as the result prints. A pass comes back to the terminal as a verdict, then a question with its reply line, and the agent's answer lands on the card." src="https://assets.sidewalk.sh/hero-readme.gif">
</picture>

*The agent writes the walk through an MCP. Your answers come back to it as data.*

## Install

Node 22 and Chrome. Two lines:

```bash
npx -y sidewalk-walkd serve
claude mcp add --scope user sidewalk -- npx -y sidewalk-mcp
```

Then the extension: [sidewalk on the Chrome Web Store](https://chromewebstore.google.com/detail/sidewalk/fiibejlikopcaplomihaegmbanhjjmed), or [the same add-on on Firefox](https://addons.mozilla.org/firefox/addon/sidewalk/). To build it from a checkout instead: `npx -y npm@11 install && npm run build`, then `chrome://extensions` → Developer mode → Load unpacked → `packages/extension/dist`.

walkd makes a token the first time it starts and answers only a caller that has
it. Your agent reads it from walkd's own folder. The panel cannot read files, so
you paste it into the gear once. The token that was just made is already on
your clipboard. A restart serves the same token.

Works on macOS, Linux and Windows. [`MANUAL.md`](MANUAL.md) §1–§3
has the longer version, including the JSON form of the MCP entry.

### One line

It installs both packages, starts the daemon, and puts the token on your
clipboard:

```bash
curl -fsSL https://sidewalk.sh/install | sh
```

### From a checkout

```bash
npx -y npm@11 install
npm run build
npm start                       # walkd on 8760
# chrome://extensions → Developer mode → Load unpacked → packages/extension/dist
claude mcp add --scope user sidewalk -- node /absolute/path/to/packages/sidewalk-mcp/bin/sidewalk-mcp.js
node packages/walkd/bin/walkd.js token --copy   # paste it into the panel's gear
```

### As a Claude Code plugin

It adds the MCP server and the `walk-author` skill, with no file path:

```bash
claude plugin marketplace add kesensoy/sidewalk
claude plugin install sidewalk@sidewalk
```

## How it works

The agent opens a walk and adds cards to it, then blocks in `walk_wait`.
Nothing can push to an agent, so that blocking call is how it hears you. You
press Go on a card, do what it says, and answer: Pass, Issue, Skip, a decision
on a question, or a question of your own back to the agent. The verdict lands
in the agent's conversation with the page's screenshot and console tail
attached, and the agent carries on.

Three pieces, one repo:

| Piece | What it is |
| --- | --- |
| `packages/walkd` | the local daemon; two append-only streams per walk, HTTP + SSE on `127.0.0.1:8760` |
| `packages/sidewalk-mcp` | the MCP server an agent session launches; six tools: `walk_open`, `walk_add_items`, `walk_withdraw`, `walk_wait`, `walk_read`, `walk_close` |
| `packages/extension` | the Chrome side panel (Manifest V3), on the Chrome Web Store or loaded unpacked from `packages/extension/dist` |

## What a card can do

The clips below are from the Lamppost demo, a four-page status site that
exists to be walked. `node demo/run.mjs` runs the same walk on your own
machine; [`demo/README.md`](demo/README.md) says what each card is there to
show.

### Go

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://assets.sidewalk.sh/dark/go.gif">
  <img alt="The side panel on the right shows a card titled The lamps are green. Go is pressed, the status page on the left opens, and the row of lamps is outlined." src="https://assets.sidewalk.sh/go.gif">
</picture>

*Press Go. It opens the page and points at the thing to check.*

### A sequence

One page, several steps in order, a tick for each. The verdict carries which
steps were ticked, so an Issue says how far it got.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://assets.sidewalk.sh/dark/sequence.gif">
  <img alt="A card with three steps about a maintenance lock. Each step is ticked as the lamps on the left go amber and back to green, then Issue is pressed with a note." src="https://assets.sidewalk.sh/sequence.gif">
</picture>

*Tick each step as it works. If one breaks, say where.*

### Undo

An answer stays yours for ten seconds before any agent can read it. Its Undo
is green in that window and one click takes the answer back as if it was never
filed. Once an agent has it the Undo turns red and asks first.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://assets.sidewalk.sh/dark/undo.gif">
  <img alt="Two answers sit at the bottom of the pane with green Undo buttons. One is pressed and its card returns. The other's Undo turns red when the agent reads it, and the card drops to the Done shelf." src="https://assets.sidewalk.sh/undo.gif">
</picture>

*Every answer has an Undo.*

### Secrets

A card can carry a key as a row of dots with a Copy button. The value is held
in the daemon's memory only: it is not in the walk's record, not in the pane's
DOM, and not handed back to the agent that wrote it. On a card that carries
one, what the page shows goes back to the agent as a length, not as words.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://assets.sidewalk.sh/dark/secrets.gif">
  <img alt="A card titled Paste the API key with a row of dots and a Copy button. Copy is pressed, the key is pasted into the settings page on the left, and Verify says the key was accepted." src="https://assets.sidewalk.sh/secrets.gif">
</picture>

*Secrets stay out of the chat and out of the screenshots.*

### Ask

Ask on any card sends a question to the agent. The card stays answerable while
you wait, and the answer lands on the card itself, where the waiting line was.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://assets.sidewalk.sh/dark/ask.gif">
  <img alt="Ask is pressed on a card and a question typed. The card reads Asked, waiting for the agent, and after a pause the answer appears on the same card in place of that line." src="https://assets.sidewalk.sh/ask.gif">
</picture>

*Ask a question. The answer lands on the card.*

### The agent's side

Everything the agent does goes through the MCP server, as the reel at the top
shows. Your verdicts come back to it as data, your words verbatim, and a
question of yours arrives with the line that tells it to answer in the pane.

## Limits

The daemon listens on loopback only. It answers only a caller that has the
token it makes when it starts; that is a token, not a login, and not transport
security. A program that can read your user's files can read a walk, or a
value a card carries. Put demo keys and test accounts on a card, never a
production credential. It writes only under your own user's data directory and
never into a project repo. Safari and a shared daemon are not here. Firefox
is: the same tree builds a sidebar add-on (`npm run package`), and it has been
run against a real walk. Both stores have it: [Chrome](https://chromewebstore.google.com/detail/sidewalk/fiibejlikopcaplomihaegmbanhjjmed) and [Firefox](https://addons.mozilla.org/firefox/addon/sidewalk/).

## Read more

- [`MANUAL.md`](MANUAL.md) is the operator manual: running the
  daemon, adding the MCP entry, a walk from open to close, the item rules,
  testing.
- [`CHANGELOG.md`](CHANGELOG.md) is what shipped when.
- [`PRIVACY.md`](PRIVACY.md) is what is stored where, and what is sent.
- [`skills/walk-author/SKILL.md`](skills/walk-author/SKILL.md) is how to
  write a good walk. Agents get the same text as MCP server instructions the
  moment they connect.

## Licence

MIT, see [`LICENSE`](LICENSE).
