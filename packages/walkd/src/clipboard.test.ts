import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { clipboardCommands, copyToClipboard } from "./clipboard.js";

/** A spawn that behaves like the command named: present and happy, or absent. */
function fakeSpawn(present: Record<string, boolean>, seen: { cmd: string; args: string[]; wrote: string }[]) {
  return ((cmd: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdin: { end(s: string): void } };
    let wrote = "";
    child.stdin = { end(s: string) { wrote = s; setImmediate(() => child.emit("close", 0)); } };
    if (!present[cmd]) { setImmediate(() => child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }))); return child as never; }
    setImmediate(() => { seen.push({ cmd, args, wrote }); });
    return child as never;
  }) as never;
}

describe("the clipboard walkd token --copy uses", () => {
  it("is the one command each desktop already has", () => {
    expect(clipboardCommands("darwin").map(c => c.cmd)).toEqual(["pbcopy"]);
    expect(clipboardCommands("win32").map(c => c.cmd)).toEqual(["clip"]);
    // Wayland first, then the two X11 ones: which works depends on the session.
    expect(clipboardCommands("linux").map(c => c.cmd)).toEqual(["wl-copy", "xclip", "xsel"]);
  });

  it("writes the token to the first command that is installed", async () => {
    const seen: { cmd: string; wrote: string }[] = [];
    const got = await copyToClipboard("tok", { platform: "linux", spawn: fakeSpawn({ xclip: true }, seen as never) });
    expect(got?.cmd).toBe("xclip");
    expect(seen.map(s => s.cmd)).toEqual(["xclip"]);
    expect(seen[0].wrote).toBe("tok");
  });

  it("answers null when this machine has none, so the caller prints the token instead", async () => {
    expect(await copyToClipboard("tok", { platform: "linux", spawn: fakeSpawn({}, []) })).toBeNull();
  });
});
