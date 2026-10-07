import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// The bin is run for real: `--version` must answer before DaemonClient.connect,
// which would otherwise start a daemon. Needs `npm run build` first, like the
// rest of this package's tests.
const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "sidewalk-mcp.js");
const version = createRequire(import.meta.url)("../package.json").version as string;
const run = (args: string[]) => promisify(execFile)(process.execPath, [bin, ...args], { timeout: 10000, env: { ...process.env, WALKD_PORT: "1" } });

describe("sidewalk-mcp --version", () => {
  it("prints the package version and exits 0 without touching a daemon", async () => {
    const { stdout, stderr } = await run(["--version"]);
    expect(stdout).toBe(`${version}\n`);
    expect(stderr).toBe("");
  });

  it("prints a usage line for --help", async () => {
    const { stdout } = await run(["--help"]);
    expect(stdout).toMatch(/^usage: sidewalk-mcp \[--version\]\n/);
  });
});
