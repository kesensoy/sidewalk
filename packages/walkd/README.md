# walkd

The local daemon behind [sidewalk](https://github.com/kesensoy/sidewalk). It
owns two append-only streams per walk — items from the agent, verdicts from
the person — and serves them over HTTP and SSE on `127.0.0.1:8760`.

You rarely start it by hand: `sidewalk-mcp` starts one if none is answering.

```bash
npx -y sidewalk-walkd status       # port, pid, data dir, healthy or not
npx -y sidewalk-walkd stop         # SIGTERM; safe to run twice
npx -y sidewalk-walkd serve        # by hand, in this terminal
npx -y sidewalk-walkd start        # the same, detached; prints the pid
npx -y sidewalk-walkd token --copy # its token, onto the clipboard, for the panel's gear
```

walkd makes a token the first time it starts and keeps it in its data dir. It
answers only a caller that has it. A new token goes onto your clipboard, to
paste into the panel's gear once. A restart serves the same one; `walkd token
--rotate` replaces it.

The item, verdict and walk contract this daemon validates against is exported
at `sidewalk-walkd/schema` as zod schemas, with `toJsonSchema()` for the same
contract as JSON Schema. It imports nothing from Node, so a browser bundle can
use it.

Data lives under `~/Library/Application Support/walkd/` (macOS),
`%LOCALAPPDATA%\walkd\` (Windows) or `$XDG_DATA_HOME/walkd/` elsewhere. Node
22 or newer.

## Limits

**The daemon has a token, not a login.** A value is held in walkd's memory and
never written to its record. walkd hands it out on `127.0.0.1:8760` only to a
caller that has the token. A program that can read your user's files can read
the token, and then the value. Put demo keys, test accounts and tokens you are
willing to rotate on a card. Do not put a production credential on one.

The daemon writes nothing into any project repo.
