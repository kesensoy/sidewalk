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
 */
export type ClipboardCommand = { cmd: string; args: string[] };

export function clipboardCommands(platform: NodeJS.Platform = process.platform): ClipboardCommand[] {
  if (platform === "darwin") return [{ cmd: "pbcopy", args: [] }];
  if (platform === "win32") return [{ cmd: "clip", args: [] }];
  return [
    { cmd: "wl-copy", args: [] },
    { cmd: "xclip", args: ["-selection", "clipboard"] },
    { cmd: "xsel", args: ["--clipboard", "--input"] },
  ];
}

/**
 * True if a command took it. False means this machine has none that works, and
 * the caller prints the token instead — never both, because printing a token
 * the person asked to be copied is the one thing `--copy` was for.
 */
export async function copyToClipboard(
  text: string,
  opts: { platform?: NodeJS.Platform; spawn?: typeof nodeSpawn } = {},
): Promise<ClipboardCommand | null> {
  const spawn = opts.spawn ?? nodeSpawn;
  for (const c of clipboardCommands(opts.platform)) {
    const ok = await new Promise<boolean>(resolve => {
      let child;
      // A command that is not installed throws on spawn (Windows) or emits
      // ENOENT (POSIX); either way the next candidate gets its turn.
      try { child = spawn(c.cmd, c.args, { stdio: ["pipe", "ignore", "ignore"] }); }
      catch { return resolve(false); }
      let settled = false;
      const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
      child.on("error", () => done(false));
      child.on("close", code => done(code === 0));
      try { child.stdin?.end(text); } catch { done(false); }
    });
    if (ok) return c;
  }
  return null;
}
