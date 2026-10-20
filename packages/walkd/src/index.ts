export { WalkStore, NotFound } from "./store.js";
// Which asks are still waiting. The store refuses a `supersedes` that names
// anything else, so `sidewalk-mcp` re-exports this one rather than keeping a
// second copy of the rule for `walk_read`'s `openAsks`.
export { openAsks, type OpenAsk } from "./asks.js";
export { createHttpServer, VERSION, type Auth } from "./http.js";
export { readState, serve, type State } from "./cli.js";
export { defaultDataDir, defaultStateDir } from "./paths.js";
// The token, for the two programs that have to find it rather than be handed
// it: `sidewalk-mcp` (the same machine by design) and the demo launcher.
export { TOKEN_ENV, TOKEN_FILE, bearer, newToken, readToken, tokenFromEnv, tokenPath, writeToken } from "./token.js";
// The native messaging host's identity, exported so the extension's own build
// can check that the ids it ships are the ids walkd writes into the manifests.
// The extension is the only other half that has to agree with these.
export { CHROME_ORIGINS, FIREFOX_EXTENSIONS, HOST_NAME, NATIVE_ROOT_ENV } from "./native.js";
// The writer itself, for `sidewalk-mcp`: an MCP that finds an older daemon
// already answering brings the host up to its own release without touching that
// daemon, because the stop op the panel's Restart walkd button presses lives in
// the host and not in the daemon (`sidewalk-mcp/src/host.ts` says why).
export { writeNativeHost, type NativeReport } from "./native.js";
