// Folders of a computer's install, shared by the host daemon, its CLI and the updater.
// macOS and Linux keep XDG-style folders; Windows uses %APPDATA% (settings) and %LOCALAPPDATA%
// (state). Functions take the environment and platform so tests can ask for the other OS.

import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export const IS_WINDOWS = process.platform === "win32";

export type Env = Record<string, string | undefined>;

export function appData(env: Env = process.env, home = homedir()): string {
  return env.APPDATA || win32.join(home, "AppData", "Roaming");
}

export function localAppData(env: Env = process.env, home = homedir()): string {
  return env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
}

/** Settings: hostd.json (the device token) and config.json (everything else). */
export function configDir(env: Env = process.env, windows = IS_WINDOWS, home = homedir()): string {
  if (env.HERDR_POCKET_HOME) return env.HERDR_POCKET_HOME;
  return windows ? win32.join(appData(env, home), "herdr-pocket") : posix.join(home, ".config", "herdr-pocket");
}

/** Things this computer keeps but never syncs: received pictures, the source race, the Windows service log. */
export function stateDir(env: Env = process.env, windows = IS_WINDOWS, home = homedir()): string {
  if (env.HERDR_POCKET_STATE) return env.HERDR_POCKET_STATE;
  return windows ? win32.join(localAppData(env, home), "herdr-pocket") : posix.join(home, ".local", "state", "herdr-pocket");
}
