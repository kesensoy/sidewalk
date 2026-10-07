import { defineConfig } from "vitest/config";

// Vitest 4 removed the `vitest.workspace.ts` file and `test.workspace`; the
// same list of per-package configs lives here as `test.projects`.
// `demo/` is not a package — it is the Lamppost marketing demo
// (`demo/README.md`) — but its pack and its launcher have tests, and they run
// with everything else. `scripts/` holds the repo's own shape (the Claude Code
// plugin manifests) and `site/` the one-page site's install script.
export default defineConfig({ test: { projects: ["packages/*/vitest.config.ts", "demo/vitest.config.ts", "scripts/vitest.config.ts", "site/vitest.config.ts"] } });
