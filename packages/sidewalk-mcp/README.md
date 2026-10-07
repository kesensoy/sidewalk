# sidewalk-mcp

The MCP server for [sidewalk](https://github.com/kesensoy/sidewalk): an AI
agent writes a walkthrough of the web app it just built, and a person walks it
in a Chrome side panel beside the live site. Verdicts, with a screenshot and
the person's exact words, go back to the agent as data.

This package is the whole install on the agent's side. It starts the local
daemon (`walkd`) if none is answering, then serves six tools over stdio:
`walk_open`, `walk_add_items`, `walk_withdraw`, `walk_wait`, `walk_read`,
`walk_close`.

```bash
claude mcp add --scope user sidewalk -- npx -y sidewalk-mcp
```

Any agent that can run an MCP server over stdio works the same way. Needs
Node 22 or newer. The side panel is the sidewalk extension, loaded unpacked from a checkout, or from the store once it is listed.
It finds the daemon on `127.0.0.1:8760` on its own.

## Limits

**The daemon has a token, not a login.** A value is held in walkd's memory and
never written to its record. walkd hands it out on `127.0.0.1:8760` only to a
caller that has the token. A program that can read your user's files can read
the token, and then the value. Put demo keys, test accounts and tokens you are
willing to rotate on a card. Do not put a production credential on one.

It writes only under your own user's data directory and never into a project
repo.
