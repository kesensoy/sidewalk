import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";

/**
 * Putting the token on the clipboard, which is the whole point of
 * `walkd token --copy`: the next thing the person does with it is paste it into
 * the pane's gear, and a token nobody can select out of a terminal is a token
 * typed by hand.
 *
 * There is no cross-platform way to do this and no dependency worth taking for
 * it, so these are the commands every desktop already has. Linux has several
 * and which one works depends on the session (Wayland or X11), so they are
 * tried in order; a headless Linux box has none of them, and that is a case
 * this has to survive rather than fail on.
 *
 * What goes there is a long-lived credential, not a one-time code, and that
 * changes two things about how it is written and how long it stays.
 *
 * **The clipboard's readers include software the person installed on purpose.**
 * Raycast, Alfred, Maccy, CopyQ, Klipper and Windows Clipboard History record
 * what passes through, some to disk and some to a cloud — none of which can
 * read a 0600 file. macOS has a convention for saying "do not keep this":
 * the pasteboard type `org.nspasteboard.ConcealedType`, which the history
 * managers above honour by default. `pbcopy` cannot set it, so on a Mac the
 * write goes through AppKit instead, with `pbcopy` as the fallback. Firefox
 * earned CVE-2021-38505 for the Windows half of this class of mistake.
 *
 * **It is cleared afterwards.** A token left on the clipboard for the rest of
 * the day has nothing to do with the paste it was put there for. So the copy
 * arms a timer — a detached `walkd clipboard-clear` — which 90 seconds later
 * reads the clipboard back, and clears it only if what is there is still the
 * token. That compare is not a defence against anyone: it is there so the timer
 * cannot throw away something the person copied in the meantime. The honest
 * sentence is the one `token.ts` already makes: a program that can read this
 * user's files can read the token either way.
 *
 * On Wayland, `wl-copy --paste-once` would hand the value over exactly once and
 * stop serving it. That is wrong for this value: a paste into the pane's gear
 * can miss, and the person may need it again a minute later. The timer is the
 * right shape for a token; `--paste-once` is the right shape for a password.
 */
export type ClipboardCommand = {
  cmd: string;
  args: string[];
  /**
   * What goes on the command's stdin. The token itself for every plain
   * clipboard command; a script with the token inside it for `osascript`, which
   * is also why the token never rides in `args` — argv is readable by other
   * users on Linux, and a habit worth keeping everywhere.
   */
  input?: (text: string) => string;
};

/** macOS pasteboard types: the one every paste reads, and the one that says "do not keep this". */
export const PLAIN_TYPE = "public.utf8-plain-text";
export const CONCEALED_TYPE = "org.nspasteboard.ConcealedType";

/**
 * The AppKit write, as a JavaScript-for-Automation script. `clearContents`
 * first, because NSPasteboard refuses a `setString` without it, then the same
 * string under both types.
 */
export function concealedScript(text: string): string {
  return [
    `ObjC.import("AppKit");`,
    `var text = ${JSON.stringify(text)};`,
    `var pb = $.NSPasteboard.generalPasteboard;`,
    `pb.clearContents;`,
    `if (!pb.setStringForType(text, ${JSON.stringify(PLAIN_TYPE)})) throw new Error("the pasteboard refused the text");`,
    `pb.setStringForType(text, ${JSON.stringify(CONCEALED_TYPE)});`,
    `"";`,
  ].join("\n");
}

export function clipboardCommands(platform: NodeJS.Platform = process.platform): ClipboardCommand[] {
  if (platform === "darwin") return [
    // `-` is "read the script from stdin", so the token is in no process's argv.
    { cmd: "osascript", args: ["-l", "JavaScript", "-"], input: concealedScript },
    { cmd: "pbcopy", args: [] },
  ];
  if (platform === "win32") return [{ cmd: "clip", args: [] }];
  return [
    { cmd: "wl-copy", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
  ];
}

/** How each desktop reads the clipboard back, for the compare before a clear. */
export function pasteCommands(platform: NodeJS.Platform = process.platform): ClipboardCommand[] {
  if (platform === "darwin") return [{ cmd: "pbpaste", args: [] }];
  // `Get-Clipboard` with no switch, and the answer is trimmed: the token is one
  // line, and no flag here is worth being wrong about.
  if (platform === "win32") return [{ cmd: "powershell", args: ["-NoProfile", "-Command", "Get-Clipboard"] }];
  return [
    { cmd: "wl-paste", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard", "-o"] },
    { cmd: "xsel", args: ["--clipboard", "--output"] },
  ];
}

/**
 * How each desktop empties the clipboard. Every one of these is the write
 * command with nothing to write, which is what makes them safe to use without
 * a man page in front of you — `wl-copy --clear` is the one documented switch
 * in the set, and it is the one place a flag is worth it.
 */
export function clearCommands(platform: NodeJS.Platform = process.platform): ClipboardCommand[] {
  if (platform === "darwin") return [{ cmd: "pbcopy", args: [] }];
  if (platform === "win32") return [{ cmd: "clip", args: [] }];
  return [
    { cmd: "wl-copy", args: ["--clear"] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
  ];
}

/** How long a command gets before it is given up on and the next one tried. */
export const COMMAND_TIMEOUT_MS = 5_000;

type Run = { ok: boolean; out: string };

/**
 * One command, its stdin written and its stdout collected.
 *
 * The timeout is for `osascript`: a Mac reached over ssh has no pasteboard, and
 * a window-server call from a session without one can sit rather than fail. The
 * other commands have never needed it and are not harmed by it.
 */
function runCommand(c: ClipboardCommand, stdin: string, spawn: typeof nodeSpawn, wantOut: boolean): Promise<Run> {
  return new Promise<Run>(resolve => {
    let child;
    // A command that is not installed throws on spawn (Windows) or emits
    // ENOENT (POSIX); either way the next candidate gets its turn.
    try { child = spawn(c.cmd, c.args, { stdio: ["pipe", wantOut ? "pipe" : "ignore", "ignore"] }); }
    catch { return resolve({ ok: false, out: "" }); }
    let settled = false;
    let out = "";
    const timer = setTimeout(() => { try { child.kill?.(); } catch { /* already gone */ } done(false); }, COMMAND_TIMEOUT_MS);
    const done = (v: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: v, out }); } };
    child.stdout?.on("data", (d: Buffer | string) => { out += d; });
    child.on("error", () => done(false));
    child.on("close", (code: number | null) => done(code === 0));
    try { child.stdin?.end(stdin); } catch { done(false); }
  });
}

/**
 * The command that took it, or null. Null means this machine has none that
 * works, and the caller prints the token instead — never both, because printing
 * a token the person asked to be copied is the one thing `--copy` was for.
 */
export async function copyToClipboard(
  text: string,
  opts: { platform?: NodeJS.Platform; spawn?: typeof nodeSpawn } = {},
): Promise<ClipboardCommand | null> {
  const spawn = opts.spawn ?? nodeSpawn;
  for (const c of clipboardCommands(opts.platform)) {
    const r = await runCommand(c, c.input ? c.input(text) : text, spawn, false);
    if (r.ok) return c;
  }
  return null;
}

/** The sha256 of a token, hex. What the clearing child is given instead of the token. */
export const fingerprint = (text: string): string => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** How long the token stays on the clipboard before the clearing child takes it off. */
export const CLEAR_AFTER_MS = 90_000;

export type Cleared = "cleared" | "changed" | "no-clipboard";

/**
 * Read the clipboard, and empty it only if what is on it is still the value
 * this fingerprint names.
 *
 * `changed` is the ordinary outcome when somebody has copied something since,
 * and it is the whole reason this reads before it writes: a timer that blanked
 * the clipboard regardless would be throwing away the person's own work, 90
 * seconds after they stopped thinking about walkd.
 */
export async function clearIfUnchanged(
  expect: string,
  opts: { platform?: NodeJS.Platform; spawn?: typeof nodeSpawn } = {},
): Promise<Cleared> {
  const spawn = opts.spawn ?? nodeSpawn;
  let read: Run | null = null;
  for (const c of pasteCommands(opts.platform)) {
    const r = await runCommand(c, "", spawn, true);
    if (r.ok) { read = r; break; }
  }
  if (read === null) return "no-clipboard";
  if (fingerprint(read.out.replace(/\r?\n$/, "")) !== expect) return "changed";
  for (const c of clearCommands(opts.platform)) {
    if ((await runCommand(c, "", spawn, false)).ok) return "cleared";
  }
  return "no-clipboard";
}

/**
 * Start the child that will clear the clipboard, and hand back how long it will
 * wait so the caller can say so in its one line.
 *
 * Detached, with its output thrown away, the way `walkd start` spawns a daemon:
 * it has to outlive this process, which on the `walkd serve` path exits the
 * moment the person presses ctrl-C. What it is given is the token's sha256, not
 * the token — argv is readable by other users on Linux, and a process list is
 * not where a credential belongs.
 *
 * Null when there is nothing to spawn: no entry script to re-run (an embedder
 * that imported this package rather than running the CLI).
 */
export function armClipboardClear(
  token: string,
  opts: { afterMs?: number; entry?: string; execPath?: string; execArgv?: string[]; spawn?: typeof nodeSpawn } = {},
): { afterMs: number; args: string[] } | null {
  const entry = opts.entry ?? process.argv[1];
  if (!entry) return null;
  const afterMs = opts.afterMs ?? CLEAR_AFTER_MS;
  const args = [...(opts.execArgv ?? process.execArgv), entry, "clipboard-clear", "--after", String(afterMs), "--expect", fingerprint(token)];
  try {
    const child = (opts.spawn ?? nodeSpawn)(opts.execPath ?? process.execPath, args, { detached: true, stdio: "ignore" });
    child.unref?.();
  } catch { return null; }
  return { afterMs, args };
}
