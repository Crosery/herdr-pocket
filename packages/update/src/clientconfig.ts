// The user-level config file (config.json) on disk: reading never fails, writing is atomic.
// The schema, defaults and checks are in the protocol package, shared with the desktop app.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLIENT_CONFIG_FILE, parseClientConfig, withConfigValue, type ClientConfig, type ConfigProblem, type ConfigValue } from "@herdr-pocket/protocol";
import { configDir, type Env } from "./paths.ts";

let cached: { at: number; path: string; loaded: LoadedClientConfig } | undefined;

export function clientConfigPath(env: Env = process.env): string {
  return join(configDir(env), CLIENT_CONFIG_FILE);
}

export interface LoadedClientConfig {
  path: string;
  exists: boolean;
  /** The file's object as it is (unknown keys included); null when missing or unreadable. */
  raw: Record<string, unknown> | null;
  config: ClientConfig;
  problems: ConfigProblem[];
  /** The file is there but is not JSON: writers refuse to replace it. */
  broken?: string;
}

export function readClientConfig(path = clientConfigPath()): LoadedClientConfig {
  if (!existsSync(path)) return { path, exists: false, raw: null, ...parseClientConfig(undefined) };
  let raw: unknown;
  try {
    const text = readFileSync(path, "utf8").replace(/^﻿/, "");
    raw = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    const broken = (e as Error).message;
    const parsed = parseClientConfig(undefined);
    return { path, exists: true, raw: null, config: parsed.config, problems: [{ key: "", level: "error", message: `not valid JSON (${broken}); defaults are used` }], broken };
  }
  const parsed = parseClientConfig(raw);
  return { path, exists: true, raw: raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null, ...parsed };
}

/**
 * Writes the whole object: a temporary file renamed over the old one, so readers never see half a
 * file. Owner read/write only on Unix, the same as the desktop app writes it.
 */
export function writeClientConfig(raw: Record<string, unknown>, path = clientConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
    cached = undefined;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows: modes are not kept */
  }
}

/** Sets (or with undefined, removes) one key and keeps the rest of the file. Throws on a file that is not JSON. */
export function setClientConfigValue(key: string, value: ConfigValue | undefined, path = clientConfigPath()): LoadedClientConfig {
  const cur = readClientConfig(path);
  if (cur.broken) throw new Error(`${path} is not valid JSON (${cur.broken}); fix it or remove it first`);
  writeClientConfig(withConfigValue(cur.raw, key, value), path);
  return readClientConfig(path);
}

/** The file as it is now, read at most every few seconds (daemons ask often). */
export function currentClientConfig(maxAgeMs = 5000): LoadedClientConfig {
  const path = clientConfigPath();
  if (!cached || cached.path !== path || Date.now() - cached.at > maxAgeMs) cached = { at: Date.now(), path, loaded: readClientConfig(path) };
  return cached.loaded;
}
