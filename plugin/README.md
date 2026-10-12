# sidewalk

Walk what your agent built, in a side panel. Your agent writes a checklist of
cards through an MCP server; you walk the cards in a Chrome or Firefox side
panel beside the live site; each verdict goes back to the agent as data: your
words, a screenshot, the console tail and the page address.

This plugin adds two things to Claude Code:

- The `sidewalk` MCP server, started as `npx -y sidewalk-mcp@<version>`, the
  published package pinned to this release in the manifest. It talks only to
  the sidewalk daemon on your own machine, at `127.0.0.1:8760`, and reads the
  daemon's token from the daemon's own data folder under your user directory.
  It sends nothing anywhere else. If no daemon is running, the server starts
  one.
- The `walk-author` skill, `/sidewalk:walk-author`: how to write a walk a
  person can follow, and how to wait for and read their verdicts.

The side panel itself is a browser extension, installed separately from the
[Chrome Web Store](https://chromewebstore.google.com/detail/sidewalk/fiibejlikopcaplomihaegmbanhjjmed)
or [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/sidewalk/). The
daemon and the server are open source at
[github.com/kesensoy/sidewalk](https://github.com/kesensoy/sidewalk), and
[sidewalk.sh](https://sidewalk.sh) shows the loop.

No account, no cloud. Everything runs on your machine. Put demo keys and test
accounts on a card, never a production credential.
