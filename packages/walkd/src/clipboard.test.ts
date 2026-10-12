import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import {
  armClipboardClear, CLEAR_AFTER_MS, clearCommands, clipboardCommands, concealedScript, CONCEALED_TYPE,
  copyToClipboard, clearIfUnchanged, fingerprint, pasteCommands, PLAIN_TYPE,
} from "./clipboard.js";

type Seen = { cmd: string; args: string[]; wrote: string };

/**
 * A spawn that behaves like the command named: present and happy, present and
 * failing, or absent. `out` is what a present command prints, which is what the
 * compare-before-clear reads.
 */
function fakeSpawn(present: Record<string, boolean>, seen: Seen[], out: Record<string, string> = {}) {
  return ((cmd: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdin: { end(s: string): void }; stdout?: EventEmitter; kill(): void };
    child.kill = () => {};
    let wrote = "";
    child.stdin = { end(s: string) { wrote = s; } };
    if (!present[cmd]) { setImmediate(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }))); return child as never; }
    const stdout = new EventEmitter();
    child.stdout = stdout;
    setImmediate(() => {
      seen.push({ cmd, args, wrote });
      const text = out[cmd];
      if (text !== undefined) stdout.emit("data", text);
      child.emit("close", 0);
    });
    return child as never;
  }) as never;
}

describe("the clipboard walkd token --copy uses", () => {
  it("is the one command each desktop already has, with the Mac's concealed write first", () => {
    // pbcopy cannot mark a value confidential, and a clipboard history manager
    // that is told nothing keeps what it is given. So the AppKit write goes
    // first on a Mac and pbcopy is the fallback.
    expect(clipboardCommands("darwin").map(c => c.cmd)).toEqual(["osascript", "pbcopy"]);
    expect(clipboardCommands("win32").map(c => c.cmd)).toEqual(["clip"]);
    // Wayland first, then the two X11 ones: which works depends on the session.
    expect(clipboardCommands("linux").map(c => c.cmd)).toEqual(["wl-copy", "xclip", "xsel"]);
  });

  it("writes the token to the first command that is installed", async () => {
    const seen: Seen[] = [];
    const got = await copyToClipboard("tok", { platform: "linux", spawn: fakeSpawn({ xclip: true }, seen) });
    expect(got?.cmd).toBe("xclip");
    expect(seen.map(s => s.cmd)).toEqual(["xclip"]);
    expect(seen[0].wrote).toBe("tok");
  });

  it("answers null when this machine has none, so the caller prints the token instead", async () => {
    expect(await copyToClipboard("tok", { platform: "linux", spawn: fakeSpawn({}, []) })).toBeNull();
  });

  it("falls back to pbcopy when osascript is not there to take it", async () => {
    const seen: Seen[] = [];
    const got = await copyToClipboard("tok", { platform: "darwin", spawn: fakeSpawn({ pbcopy: true }, seen) });
    expect(got?.cmd).toBe("pbcopy");
    expect(seen.map(s => s.cmd)).toEqual(["pbcopy"]);
    expect(seen[0].wrote).toBe("tok");
  });
});

/**
 * The Mac's concealed write. What is checked here is the script, not the
 * pasteboard: a test that wrote to the real one would be taking the person's
 * clipboard, which is the thing `--no-copy` exists to prevent.
 */
describe("the concealed pasteboard write", () => {
  it("clears, then sets the same string under the plain type and the concealed one", () => {
    const s = concealedScript("a-token");
    expect(s).toContain("ObjC.import(\"AppKit\")");
    expect(s).toContain("$.NSPasteboard.generalPasteboard");
    // clearContents before any set: NSPasteboard refuses a setString without it.
    expect(s.indexOf("clearContents")).toBeLessThan(s.indexOf("setStringForType"));
    expect(s).toContain(JSON.stringify(PLAIN_TYPE));
    expect(s).toContain(JSON.stringify(CONCEALED_TYPE));
    expect(CONCEALED_TYPE).toBe("org.nspasteboard.ConcealedType");
  });

  it("goes on the command's stdin, so the token is in no process's argv", async () => {
    const seen: Seen[] = [];
    const got = await copyToClipboard("the-token-itself", { platform: "darwin", spawn: fakeSpawn({ osascript: true }, seen) });
    expect(got?.cmd).toBe("osascript");
    expect(seen[0].args).toEqual(["-l", "JavaScript", "-"]);
    expect(seen[0].args.join(" ")).not.toContain("the-token-itself");
    expect(seen[0].wrote).toContain("the-token-itself");
  });

  it("escapes what it embeds, so a value with a quote in it cannot end the string", () => {
    const s = concealedScript(`a"b\\c\nd`);
    expect(s).toContain(JSON.stringify(`a"b\\c\nd`));
    // The whole script is still one line per statement: the newline inside the
    // value is escaped, not printed.
    expect(s.split("\n").filter(l => l.startsWith("var text")).length).toBe(1);
  });
});

describe("clearing the clipboard afterwards", () => {
  it("names the token by its sha256, never by its value", () => {
    expect(fingerprint("tok")).toBe(crypto.createHash("sha256").update("tok").digest("hex"));
    expect(fingerprint("tok")).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint("tok")).not.toContain("tok");
  });

  it("reads the clipboard back and empties it when the token is still there", async () => {
    const seen: Seen[] = [];
    const spawn = fakeSpawn({ "wl-paste": true, "wl-copy": true }, seen, { "wl-paste": "tok\n" });
    expect(await clearIfUnchanged(fingerprint("tok"), { platform: "linux", spawn })).toBe("cleared");
    expect(seen.map(s => s.cmd)).toEqual(["wl-paste", "wl-copy"]);
    // The one documented switch in the set, and the only place a flag is used.
    expect(seen[1].args).toEqual(["--clear"]);
  });

  it("leaves alone whatever the person copied since", async () => {
    const seen: Seen[] = [];
    const spawn = fakeSpawn({ pbpaste: true, pbcopy: true }, seen, { pbpaste: "a shopping list" });
    expect(await clearIfUnchanged(fingerprint("tok"), { platform: "darwin", spawn })).toBe("changed");
    expect(seen.map(s => s.cmd)).toEqual(["pbpaste"]);
  });

  it("says so rather than throwing when this machine cannot be read", async () => {
    expect(await clearIfUnchanged(fingerprint("tok"), { platform: "linux", spawn: fakeSpawn({}, []) })).toBe("no-clipboard");
  });

  it("reads through the same three Linux commands, and the one each platform has", () => {
    expect(pasteCommands("darwin").map(c => c.cmd)).toEqual(["pbpaste"]);
    expect(pasteCommands("win32").map(c => c.cmd)).toEqual(["powershell"]);
    expect(pasteCommands("linux").map(c => c.cmd)).toEqual(["wl-paste", "xclip", "xsel"]);
    expect(clearCommands("darwin").map(c => c.cmd)).toEqual(["pbcopy"]);
    expect(clearCommands("win32").map(c => c.cmd)).toEqual(["clip"]);
    expect(clearCommands("linux").map(c => c.cmd)).toEqual(["wl-copy", "xclip", "xsel"]);
  });
});

describe("arming the clearing child", () => {
  it("spawns a detached walkd clipboard-clear carrying the fingerprint, not the token", () => {
    const calls: { exe: string; args: readonly string[]; detached?: boolean; stdio?: unknown }[] = [];
    const fake = ((exe: string, args: readonly string[], o: { detached?: boolean; stdio?: unknown }) => {
      calls.push({ exe, args, ...o });
      return { unref() {} };
    }) as never;
    const armed = armClipboardClear("the-token-itself", { entry: "/x/walkd.js", execPath: "/x/node", execArgv: [], spawn: fake });
    expect(armed?.afterMs).toBe(CLEAR_AFTER_MS);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["/x/walkd.js", "clipboard-clear", "--after", String(CLEAR_AFTER_MS), "--expect", fingerprint("the-token-itself")]);
    expect(calls[0].args.join(" ")).not.toContain("the-token-itself");
    // It has to outlive the process that copied: `walkd serve` ends the moment
    // the person presses ctrl-C, and the clipboard would still hold the token.
    expect(calls[0].detached).toBe(true);
    expect(calls[0].stdio).toBe("ignore");
  });

  it("arms nothing, rather than guessing, when there is no entry script to re-run", () => {
    expect(armClipboardClear("tok", { entry: "", spawn: (() => { throw new Error("never"); }) as never })).toBeNull();
  });

  it("answers null when the child could not be spawned at all", () => {
    const boom = (() => { throw new Error("EPERM"); }) as never;
    expect(armClipboardClear("tok", { entry: "/x/walkd.js", spawn: boom })).toBeNull();
  });
});
