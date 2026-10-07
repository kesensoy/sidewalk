#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonClient } from "./client.js";
import { buildServer, VERSION } from "./server.js";

// A person at a terminal asking for the version must not start a daemon.
const argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) { process.stdout.write(`${VERSION}\n`); process.exit(0); }
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write("usage: sidewalk-mcp [--version]\nAn MCP server over stdio. An agent client starts it; it finds or starts walkd on 127.0.0.1:8760.\n");
  process.exit(0);
}

const client = await DaemonClient.connect();
await buildServer(client).connect(new StdioServerTransport());
