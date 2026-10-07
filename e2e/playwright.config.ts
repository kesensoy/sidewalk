import path from "node:path";
import { defineConfig } from "@playwright/test";

// The ports this suite owns: walkd on 8761 and the fixture site on 9342 —
// neither is 8760 or 9340, so a walkd and a fixture site you are already using
// keep running while the suite does. Chrome's remote debugging is 9341; never
// 9222, which belongs to the chrome-devtools MCP on this machine.
export default defineConfig({
  testDir: ".",
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  webServer: {
    // The port goes through `env`, not a `PORT=9342 node …` prefix: Playwright
    // hands this to the platform shell, and cmd.exe has no inline env prefix.
    // The path is quoted for the same reason — a checkout can live anywhere.
    command: `node ${JSON.stringify(path.join(import.meta.dirname, "..", "fixtures", "site", "serve.mjs"))}`,
    env: { PORT: "9342" },
    port: 9342,
    reuseExistingServer: false,
  },
});
