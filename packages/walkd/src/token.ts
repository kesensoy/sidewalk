import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DIR_MODE } from "./store.js";

/**
 * The daemon's token: what stops every other program on the machine from
 * reading a walk, or a card's secret, off 127.0.0.1 (secrets review). It
 * is not a login and it is not transport security — it is a shared secret in a
 * file only this user can read, so the honest sentence is that a program which
 * can read your user's files can still read a value.
 *
 * Minted once and kept, held in the daemon's memory, and written to one file in
 * the daemon's own data dir so the two halves that cannot be handed it any
 * other way can find it: `sidewalk-mcp`, which runs on the same machine by
 * design, and the person, who pastes it into the pane's gear once.
 *
 * It used to be fresh on every boot, which cost the person that paste on every
 * restart and bought nothing: rotation only kills a token somebody already
 * copied, and the one adversary it would matter against — a program running as
 * this user — reads the live file instead. So `serve`
 * reuses a file it can vouch for
 * and `walkd token --rotate` is the way a new one is asked for.
 */
export const TOKEN_FILE = "token";
export const TOKEN_ENV = "WALKD_TOKEN";

/** The one place the token lives on disk: `<data dir>/token`. */
export const tokenPath = (dataDir: string): string => path.join(dataDir, TOKEN_FILE);

/**
 * 0600, and the file is removed before it is rewritten: `writeFile`'s `mode` is
 * only honoured when it creates the file, so a token file that already existed
 * would keep whatever mode it had — including a 0644 one written by an older
 * walkd.
 */
export const TOKEN_MODE = 0o600;

/** 32 bytes of randomness, base64url so it survives a header, a shell and a paste. */
export const newToken = (): string => crypto.randomBytes(32).toString("base64url");

/**
 * Exactly what `newToken` mints: 43 base64url characters, no padding. A file
 * holding anything else is not one this daemon wrote, so it is replaced rather
 * than served — a truncated write, an editor's stray newline-and-text, or a
 * `WALKD_TOKEN` an earlier boot pinned into it all land here.
 */
export const TOKEN_FORM = /^[A-Za-z0-9_-]{43}$/;
export const wellFormed = (token: string): boolean => TOKEN_FORM.test(token);

/**
 * Can the token in `<data dir>/token` be served again? Yes only if everything
 * the file promises still holds: a regular file (not a symlink to somewhere
 * else, not a directory), 0600, owned by this user, holding one token of the
 * form above. `why` is one short phrase naming the first thing that failed, for
 * the one line `serve` prints when it replaces the file; `why: null` means
 * there was simply no file, which is the ordinary first run and says nothing.
 */
export type TokenOnDisk = { ok: true; token: string } | { ok: false; why: string | null };

export async function inspectToken(dataDir: string): Promise<TokenOnDisk> {
  const file = tokenPath(dataDir);
  let st;
  try { st = await fs.lstat(file); }
  catch (e) { return { ok: false, why: (e as NodeJS.ErrnoException).code === "ENOENT" ? null : `could not be read (${(e as Error).message})` }; }
  if (!st.isFile()) return { ok: false, why: "not a regular file" };
  // Windows has neither of these: no POSIX mode on an NTFS file and no uid at
  // all, so there the content check is the whole of it — the same place every
  // other mode assertion in this repo stops.
  if (process.platform !== "win32") {
    const mode = st.mode & 0o777;
    if (mode !== TOKEN_MODE) return { ok: false, why: `mode 0${mode.toString(8)}, not 0600` };
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) return { ok: false, why: `owned by uid ${st.uid}, not ${uid}` };
  }
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (e) { return { ok: false, why: `could not be read (${(e as Error).message})` }; }
  const token = raw.trim();
  if (!token) return { ok: false, why: "empty" };
  if (!wellFormed(token)) return { ok: false, why: "not the form walkd mints" };
  return { ok: true, token };
}

/**
 * The token this boot will serve, and the file it is in. Kept from the last
 * boot when `inspectToken` can vouch for the file; minted and written when it
 * cannot. `pinned` is `WALKD_TOKEN`, which wins outright and is written to the
 * file as before, so `walkd token` and `sidewalk-mcp` keep agreeing with the
 * daemon.
 *
 * `replaced` is `inspectToken`'s `why` when a file was there and could not be
 * used — the caller says that out loud, because a token the person had pasted
 * has just stopped working and the reason is the only actionable thing.
 */
export type EnsuredToken = { token: string; file: string; reused: boolean; replaced: string | null };

export async function ensureToken(dataDir: string, pinned?: string): Promise<EnsuredToken> {
  const found = pinned ? ({ ok: false, why: null } as TokenOnDisk) : await inspectToken(dataDir);
  if (found.ok) return { token: found.token, file: tokenPath(dataDir), reused: true, replaced: null };
  const token = pinned ?? newToken();
  return { token, file: await writeToken(dataDir, token), reused: false, replaced: found.why };
}

/** Write the daemon's token, replacing any older one. Returns the file it wrote. */
export async function writeToken(dataDir: string, token: string): Promise<string> {
  const file = tokenPath(dataDir);
  await fs.mkdir(dataDir, { recursive: true, mode: DIR_MODE });
  await fs.rm(file, { force: true });
  await fs.writeFile(file, `${token}\n`, { mode: TOKEN_MODE });
  return file;
}

/**
 * The token of the daemon whose data dir this is. Throws with the path in the
 * message: every caller of this is a program that cannot continue without it,
 * and the path is the only thing the person can act on.
 */
export async function readToken(dataDir: string): Promise<string> {
  const file = tokenPath(dataDir);
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (e) { throw new Error(`walkd's token could not be read at ${file} (${(e as Error).message}). Start walkd again, or set ${TOKEN_ENV}.`); }
  const token = raw.trim();
  if (!token) throw new Error(`walkd's token file is empty: ${file}. Start walkd again, or set ${TOKEN_ENV}.`);
  return token;
}

/**
 * `WALKD_TOKEN`, if it says anything. Both halves honour it: the daemon serves
 * that token instead of a fresh one, and a client sends it instead of reading
 * the file — which is the only way a setup where the client cannot see the
 * daemon's data dir (a container, another user) can be made to work at all. An
 * empty or blank value is not a token.
 */
export function tokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[TOKEN_ENV]?.trim();
  return v ? v : undefined;
}

/** The one header the daemon reads, as every client in this repo sends it. */
export const bearer = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

/** The token an `Authorization` header presents, or null if it presents none. */
export function presented(header: string | undefined): string | null {
  const m = /^Bearer[ \t]+(\S.*)$/i.exec((header ?? "").trim());
  return m ? m[1].trim() : null;
}

/** Compared without leaking the position of the first wrong byte. */
export function sameToken(a: string | null, b: string): boolean {
  if (a === null) return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
