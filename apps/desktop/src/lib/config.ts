/**
 * The shared client config file (`config.json` next to hostd.json; docs/config.md).
 * The CLI (`herdr-pocket config`) and this app read and write the same keys; the schema,
 * labels and checks come from the protocol package. In the desktop app the native side
 * owns the file (config_load / config_set, `config://changed`); elsewhere (HarmonyOS, a
 * plain browser) the same object lives in local storage.
 */
import {
  configKeySpec,
  configValueError,
  defaultClientConfig,
  getConfigValue,
  parseClientConfig,
  withConfigValue,
  type ClientConfig,
  type ConfigProblem,
  type ConfigValue,
} from "@herdr-pocket/protocol";
import { createStore, settingsStore, updateSettings } from "./store";
import { native, onNativeEvent, type ConfigFileInfo } from "./native";
import { logger } from "./log";

const LOCAL_KEY = "herdr-pocket-client-config";

export interface ClientConfigState {
  loaded: boolean;
  config: ClientConfig;
  problems: ConfigProblem[];
  /** Where the file is, when there is one. */
  path: string | null;
  /** Why the file could not be read; writes are refused until it is fixed. */
  error: string | null;
  native: boolean;
}

export const clientConfigStore = createStore<ClientConfigState>({
  loaded: false,
  config: defaultClientConfig(),
  problems: [],
  path: null,
  error: null,
  native: false,
});

let raw: Record<string, unknown> = {};

function applyFile(file: ConfigFileInfo | null, fromNative: boolean): void {
  raw = file?.raw && typeof file.raw === "object" ? file.raw : {};
  const parsed = parseClientConfig(raw);
  clientConfigStore.set({
    loaded: true,
    config: parsed.config,
    problems: parsed.problems,
    path: file?.path ?? null,
    error: file?.error ?? null,
    native: fromNative,
  });
  // Keys the existing UI state mirrors (see syncSettingsToFile for the other direction).
  const s = settingsStore.get();
  const g = parsed.config.general;
  const patch: Parameters<typeof updateSettings>[0] = {};
  if (s.theme !== g.theme) patch.theme = g.theme;
  if (s.notifications !== g.notifications) patch.notifications = g.notifications;
  if (s.showShells !== g.showShells) patch.showShells = g.showShells;
  if (Math.round(s.textScale * 100) !== g.textScale) patch.textScale = g.textScale / 100;
  if (s.chatDisplayMode !== g.chatDisplayMode) patch.chatDisplayMode = g.chatDisplayMode;
  if (Object.keys(patch).length) {
    applying = true;
    try {
      updateSettings(patch);
    } finally {
      applying = false;
    }
  }
}

/** True while applyFile copies the file into the UI state, so that copy is not written back. */
let applying = false;

/** The UI state mirrored by config.json keys: [config key, value in the UI state]. */
function mirroredSettings(): Array<[string, ConfigValue]> {
  const s = settingsStore.get();
  return [
    ["general.theme", s.theme],
    ["general.notifications", s.notifications],
    ["general.showShells", s.showShells],
    ["general.textScale", Math.round(s.textScale * 100)],
    ["general.chatDisplayMode", s.chatDisplayMode],
  ];
}

function hasRawKey(key: string): boolean {
  const [section = "", name = ""] = key.split(".");
  const sec = raw[section];
  return Boolean(sec && typeof sec === "object" && (sec as Record<string, unknown>)[name] !== undefined);
}

/** Floating notch window stays off unless explicitly enabled in config.json (`general.dynamicIsland`). */
export function isDynamicIslandEnabled(): boolean {
  if (!hasRawKey("general.dynamicIsland")) return false;
  return Boolean(clientConfigStore.get().config.general.dynamicIsland);
}

/**
 * Screens that still call updateSettings (theme, text size, shells, notifications) end up in
 * config.json too, so the CLI sees them and the next reload does not undo them.
 */
function syncSettingsToFile(): void {
  if (applying || !clientConfigStore.get().loaded || clientConfigStore.get().error) return;
  const cfg = clientConfigStore.get().config;
  for (const [key, value] of mirroredSettings()) {
    if (getConfigValue(cfg, key) === value) continue;
    const spec = configKeySpec(key);
    if (!spec || configValueError(spec, value)) continue;
    void setConfig(key, value).catch((e) => logger.warn("config", `could not save ${key}: ${(e as Error).message}`));
  }
}

const MIGRATED_KEY = "herdr-pocket-config-migrated";

/**
 * Once: preferences this app kept before config.json existed move into the file, unless the
 * file already has the key (the file wins). Without this, the file's defaults would replace them.
 */
async function migrateLocalPrefs(file: ConfigFileInfo, fromNative: boolean): Promise<ConfigFileInfo> {
  if (localStorage.getItem(MIGRATED_KEY) || file.error) return file;
  raw = file.raw && typeof file.raw === "object" ? file.raw : {};
  const changes: Record<string, ConfigValue> = {};
  for (const [key, value] of mirroredSettings()) {
    const spec = configKeySpec(key);
    if (!spec || hasRawKey(key) || value === spec.default || configValueError(spec, value)) continue;
    changes[key] = value;
  }
  let out = file;
  const keys = Object.keys(changes);
  if (keys.length) {
    if (fromNative) {
      out = await native.configSet(changes);
    } else {
      let next = raw;
      for (const k of keys) next = withConfigValue(next, k, changes[k]);
      writeLocal(next);
      out = { ...file, exists: true, raw: next };
    }
    logger.info("config", `moved earlier app preferences into config.json: ${keys.join(", ")}`);
  }
  localStorage.setItem(MIGRATED_KEY, String(Date.now()));
  return out;
}

function readLocal(): ConfigFileInfo {
  try {
    const text = window.PocketHarmony?.getPref?.(LOCAL_KEY) || localStorage.getItem(LOCAL_KEY);
    const obj = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    return { path: "", exists: Boolean(text), raw: obj };
  } catch {
    return { path: "", exists: false, raw: {} };
  }
}

function writeLocal(next: Record<string, unknown>): void {
  const text = JSON.stringify(next);
  try {
    window.PocketHarmony?.setPref?.(LOCAL_KEY, text);
  } catch {
    // ignore
  }
  try {
    localStorage.setItem(LOCAL_KEY, text);
  } catch {
    // ignore
  }
}

let started = false;

/** Loads the file once and follows outside edits (the CLI, a text editor). */
export async function startClientConfig(): Promise<void> {
  if (started) return;
  started = true;
  settingsStore.subscribe(syncSettingsToFile);
  try {
    const loaded = await native.configLoad();
    if (loaded) {
      const file = await migrateLocalPrefs(loaded, true).catch((err) => {
        logger.warn("config", `moving earlier preferences failed: ${(err as Error).message}`);
        return loaded;
      });
      applyFile(file, true);
      onNativeEvent<ConfigFileInfo>("config://changed", (f) => {
        logger.info("config", "config.json changed on disk; reloaded");
        applyFile(f, true);
      });
      if (file.error) logger.warn("config", file.error);
      return;
    }
  } catch (err) {
    logger.warn("config", `config_load failed: ${(err as Error).message}`);
  }
  applyFile(await migrateLocalPrefs(readLocal(), false).catch(() => readLocal()), false);
}

export function useClientConfig(): ClientConfig {
  return clientConfigStore.use((s) => s.config);
}

export function configValue<T extends ConfigValue>(key: string): T {
  return getConfigValue(clientConfigStore.get().config, key) as T;
}

/**
 * Sets one key (dotted, e.g. "general.theme"); `undefined` restores its default. Throws a
 * Chinese message when the value is out of range or the file can't be written.
 */
export async function setConfig(key: string, value: ConfigValue | undefined): Promise<void> {
  const spec = configKeySpec(key);
  if (!spec) throw new Error(`没有这个设置项：${key}`);
  if (value !== undefined) {
    const err = configValueError(spec, value);
    if (err) throw new Error(`${spec.label}：${err}`);
  }
  const st = clientConfigStore.get();
  if (st.native) {
    const file = await native.configSet({ [key]: value === undefined ? null : value });
    applyFile(file, true);
  } else {
    const next = withConfigValue(raw, key, value);
    writeLocal(next);
    applyFile({ path: "", exists: true, raw: next }, false);
  }
  logger.info("config", `${key} = ${value === undefined ? "(default)" : JSON.stringify(value)}`);
}
