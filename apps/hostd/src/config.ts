import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HostConfig {
  server: string;
  token: string;
  deviceId: string;
  name: string;
}

export const CONFIG_DIR = process.env.HERDR_POCKET_HOME ?? join(homedir(), ".config", "herdr-pocket");
export const CONFIG_PATH = join(CONFIG_DIR, "hostd.json");
export const CONTROL_SOCKET = join(CONFIG_DIR, "hostd.sock");

export function loadConfig(): HostConfig | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const c = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as HostConfig;
    return c.server && c.token ? c : null;
  } catch {
    return null;
  }
}

/** The file holds the device token: owner read/write only. */
export function saveConfig(c: HostConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}
