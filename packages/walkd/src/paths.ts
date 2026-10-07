import os from "node:os";
import path from "node:path";

// Windows: %LOCALAPPDATA%\walkd, the per-user, non-roaming place.
const winBase = () => path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "walkd");

export function defaultDataDir(): string {
  if (process.env.WALKD_DATA_DIR) return process.env.WALKD_DATA_DIR;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "walkd");
  if (process.platform === "win32") return winBase();
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "walkd");
}
export function defaultStateDir(): string {
  if (process.env.WALKD_STATE_DIR) return process.env.WALKD_STATE_DIR;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "walkd", "state");
  if (process.platform === "win32") return path.join(winBase(), "state");
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "walkd");
}
