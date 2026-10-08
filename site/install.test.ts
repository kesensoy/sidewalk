/**
 * `site/install` — the script behind `curl -fsSL https://sidewalk.sh/install | sh`.
 *
 * It is run here under `sh -n` (syntax only) and then for real against a PATH
 * holding stub `node`, `npm`, `claude` and `walkd`, one run per branch, so no
 * test installs anything, starts a daemon, touches a real Claude Code config or
 * writes to the clipboard. The stubs log their arguments to a file, which is how
 * a run proves it called `npm install -g sidewalk-walkd sidewalk-mcp` and
 * `claude mcp add --scope user sidewalk -- sidewalk-mcp` and nothing else.
 *
 * The `walkd` stub is the interesting one: `walkd status` exits 0 or 1 to stand
 * for a daemon that is or is not already answering, and that one exit code is
 * what picks the whole closing half of the script.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { headersFor, readHeaders } from "./serve.mjs";

const here = import.meta.dirname;
const script = path.join(here, "install");

/** One throwaway world per run: a stub bin/, a log, and a global prefix. */
function world({ node = "v22.18.0", withNode = true, withNpm = true, withClaude = true, claudeAddExit = 0, prefixMode = 0o755,
  withWalkd = true, walkdRunning = false, walkdStartExit = 0, walkdTokenExit = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidewalk-install-"));
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "log");
  const prefix = path.join(dir, "prefix");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(prefix, "lib", "node_modules"), { recursive: true });
  fs.chmodSync(path.join(prefix, "lib", "node_modules"), prefixMode);

  const stub = (name: string, body: string) => {
    const f = path.join(bin, name);
    fs.writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$STUB_LOG"\n${body}\n`);
    fs.chmodSync(f, 0o755);
  };
  if (withNode) stub("node", `[ "$1" = "-v" ] && printf '%s\\n' "${node}"\nexit 0`);
  if (withNpm) stub("npm", `if [ "$1 $2" = "prefix -g" ]; then printf '%s\\n' "${prefix}"; fi\nexit 0`);
  if (withClaude) stub("claude", `printf '%s\\n' "claude says its own line"\nexit ${claudeAddExit}`);
  // The real walkd prints the pid, the log path and where the token went; the
  // stub prints one recognisable line per subcommand and the exit code the case
  // under test needs. `status` is the liveness answer the script branches on.
  if (withWalkd) stub("walkd", [
    `case "$1" in`,
    `  status) exit ${walkdRunning ? 0 : 1} ;;`,
    `  start) printf '%s\\n' "walkd 0.3.0 is running in the background on http://127.0.0.1:8760, pid 4242"; exit ${walkdStartExit} ;;`,
    `  token) printf '%s\\n' "walkd: token copied to the clipboard (pbcopy)"; exit ${walkdTokenExit} ;;`,
    `esac`,
    `exit 0`,
  ].join("\n"));

  const run = () => {
    const r = spawnSync("/bin/sh", [script], {
      encoding: "utf8",
      env: { PATH: bin, HOME: dir, STUB_LOG: log },
    });
    return { ...r, out: `${r.stdout}${r.stderr}`, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [] };
  };
  return { dir, run, prefix };
}

const worlds: { dir: string }[] = [];
const make = (opts?: Parameters<typeof world>[0]) => {
  const w = world(opts);
  worlds.push(w);
  return w;
};
afterEach(() => {
  while (worlds.length) {
    const w = worlds.pop()!;
    fs.chmodSync(path.join(w.dir, "prefix", "lib", "node_modules"), 0o755);
    fs.rmSync(w.dir, { recursive: true, force: true });
  }
});

describe("the script itself", () => {
  const text = fs.readFileSync(script, "utf8");

  it("parses as POSIX sh", () => {
    const r = spawnSync("/bin/sh", ["-n", script], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("sets -eu and never runs sudo", () => {
    expect(text).toMatch(/^set -eu$/m);
    // It says the word once, in the sentence promising not to; it never runs it.
    expect(text).not.toMatch(/^\s*sudo\s/m);
    expect(text).not.toMatch(/[|&;]\s*sudo\s/);
  });

  it("carries no review marker: every sentence it prints is settled", () => {
    // Spelled in parts so a tree-wide grep for the marker stays empty.
    expect(text).not.toContain(["TODO", "COPY", "REVIEW"].join("-"));
  });
});

describe("a machine with everything", () => {
  it("installs the two packages, adds the server, starts the daemon, and says what is left", () => {
    const { run } = make();
    const { status, out, calls } = run();
    expect(status).toBe(0);
    expect(calls).toContain("npm install -g sidewalk-walkd sidewalk-mcp");
    expect(calls).toContain("claude mcp add --scope user sidewalk -- sidewalk-mcp");
    // It asks whether one is answering, and starts one because none is.
    expect(calls).toContain("walkd status");
    expect(calls).toContain("walkd start");
    expect(calls.join("\n")).not.toContain("walkd token");
    // walkd's own line about the pid comes through, and then the two steps.
    expect(out).toContain("running in the background");
    expect(out).toContain("Two things left:");
    expect(out).toContain("Add the extension from the Chrome Web Store");
    expect(out).toContain("paste the token, Save");
  });

  it("changes nothing on a second run: the daemon is left alone and its token copied", () => {
    // claude refuses a server it already has, and a walkd is already answering.
    const { run } = make({ claudeAddExit: 1, walkdRunning: true });
    const { status, out, calls } = run();
    expect(status).toBe(0);
    expect(out).toContain("claude mcp add --scope user sidewalk -- sidewalk-mcp");
    expect(out).toContain("already running; this script left it alone");
    expect(calls).toContain("walkd token --copy");
    expect(calls.join("\n")).not.toContain("walkd start");
    expect(out).toContain("Two things left:");
  });
});

describe("a machine missing something", () => {
  it("stops when there is no node", () => {
    const { run } = make({ withNode: false });
    const { status, out, calls } = run();
    expect(status).toBe(1);
    expect(out).toContain("Node 22 or newer");
    expect(calls).toEqual([]);
  });

  it("stops when node is too old, and names the version it found", () => {
    const { run } = make({ node: "v20.19.0" });
    const { status, out, calls } = run();
    expect(status).toBe(1);
    expect(out).toContain("v20.19.0");
    expect(calls.join("\n")).not.toContain("install -g");
  });

  it("stops when there is no npm", () => {
    const { run } = make({ withNpm: false });
    const { status, out } = run();
    expect(status).toBe(1);
    expect(out).toContain("npm is not on this PATH");
  });

  it("prints the command instead of running it when claude is not on PATH", () => {
    const { run } = make({ withClaude: false });
    const { status, out, calls } = run();
    expect(status).toBe(0);
    expect(calls).toContain("npm install -g sidewalk-walkd sidewalk-mcp");
    expect(out).toContain("claude mcp add --scope user sidewalk -- sidewalk-mcp");
    expect(out).toContain("Two things left:");
  });

  it("says so, and never claims a daemon, when walkd is not on PATH after the install", () => {
    const { run } = make({ withWalkd: false });
    const { status, out, calls } = run();
    expect(status).toBe(0);
    expect(calls).toContain("npm install -g sidewalk-walkd sidewalk-mcp");
    expect(out).toContain("not on this PATH");
    expect(out).toContain("walkd start");
    expect(out).not.toContain("running in the background");
    expect(out).toContain("Two things left:");
  });

  it("points at the foreground form when the daemon will not start", () => {
    const { run } = make({ walkdStartExit: 1 });
    const { status, out, calls } = run();
    expect(status).toBe(0);
    expect(calls).toContain("walkd start");
    expect(out).toContain("walkd did not start");
    expect(out).toContain("walkd serve runs");
    // Still worth finishing: the extension and the paste are unchanged.
    expect(out).toContain("Two things left:");
  });

  it("offers the token command when a running daemon's token could not be read", () => {
    const { run } = make({ walkdRunning: true, walkdTokenExit: 1 });
    const { status, out } = run();
    expect(status).toBe(0);
    expect(out).toContain("Run walkd token --copy when you want its token");
  });

  it("says what to do about a prefix it cannot write to, and installs nothing", () => {
    const { run, prefix } = make({ prefixMode: 0o500 });
    const { status, out, calls } = run();
    expect(status).toBe(1);
    expect(out).toContain(prefix);
    expect(out).toContain("npm config set prefix");
    // It offers a folder the person owns, not a command that escalates.
    expect(out).not.toMatch(/sudo npm/);
    expect(calls.join("\n")).not.toContain("install -g");
  });
});

describe("_headers", () => {
  const CSP = "default-src 'self'; img-src 'self' https://assets.sidewalk.sh; style-src 'self'; script-src 'self'; font-src 'self'";

  it("serves /install as text, so a person can read it first", () => {
    const rules = readHeaders(path.join(here, "_headers"));
    expect(headersFor("/install", rules)["content-type"]).toBe("text/plain; charset=utf-8");
  });

  it("puts the policy and nosniff on every response", () => {
    const rules = readHeaders(path.join(here, "_headers"));
    for (const p of ["/", "/privacy", "/site.css", "/site.js", "/install"]) {
      expect(headersFor(p, rules)["x-content-type-options"]).toBe("nosniff");
      expect(headersFor(p, rules)["content-security-policy"]).toBe(CSP);
    }
  });

  it("has no inline style or script to make an exception for", () => {
    for (const page of ["index.html", "privacy.html"]) {
      const html = fs.readFileSync(path.join(here, page), "utf8");
      expect(html).not.toMatch(/<style[\s>]/i);
      expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
      expect(html).not.toMatch(/\sstyle="/i);
      expect(html).not.toMatch(/\son[a-z]+="/i);
    }
  });
});
