#!/usr/bin/env node
// cli.js never self-runs — sidewalk-mcp/dist/cli.js used to match its argv[1]
// guard and start a daemon inside the MCP process. This is the one entry.
import { main } from "../dist/cli.js";
await main();
