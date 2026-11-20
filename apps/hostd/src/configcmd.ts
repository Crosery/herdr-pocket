// `herdr-pocket config`: the user-level settings file (config.json) shared with the desktop app.
// Schema and checks: packages/protocol (CLIENT_CONFIG_KEYS); docs/config.md lists every key.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  CLIENT_CONFIG_KEYS,
  configKeySpec,
  getConfigValue,
  parseConfigText,
  type ClientConfig,
  type ConfigProblem,
  type ConfigValue,
} from "@herdr-pocket/protocol";
import { clientConfigPath, readClientConfig, setClientConfigValue, writeClientConfig, type LoadedClientConfig } from "@herdr-pocket/update";

export const CONFIG_HELP = `  config path                 Where the settings file is (config.json, shared with the desktop app).
  config show [--all] [--json]
        Settings that differ from the defaults (--all: every key) and problems in the file.
  config get <key>            One value, e.g. \`config get update.region\`.
  config set <key> <value>    Change one, e.g. \`config set update.region cn\`; lists: a,b or a JSON array.
  config unset <key>          Back to the default.
  config edit                 Open the file in $VISUAL / $EDITOR (or the system's editor), then check it.
  config keys                 Every key, its default and what it does.`;

/** Something to tell the relay's log about (the CLI runs apart from the daemon). */
export type ConfigReport = (level: "info" | "warn", msg: string, data: Record<string, unknown>) => Promise<void>;

function show(v: ConfigValue | undefined): string {
  if (v === undefined) return "(unset)";
  return Array.isArray(v) ? (v.length ? v.join(",") : "[]") : typeof v === "string" ? (v === "" ? '""' : v) : String(v);
}

/** An environment variable that wins over the file right now, e.g. "HERDR_POCKET_MIRROR=1". */
function envOverride(key: string, env = process.env): string | undefined {
  const name = configKeySpec(key)?.env;
  const v = name ? env[name] : undefined;
  return name && v !== undefined && v !== "" ? `${name}=${v}` : undefined;
}

function printProblems(problems: ConfigProblem[]): void {
  for (const p of problems) console.error(`${p.level === "error" ? "error" : "note "} ${p.key || "file"}: ${p.message}`);
}

export async function configCommand(argv: string[], report?: ConfigReport): Promise<void> {
  const [sub, ...rest] = argv;
  const path = clientConfigPath();
  switch (sub) {
    case "path":
      console.log(path);
      return;
    case undefined:
    case "show":
      return showConfig(rest, path, report);
    case "keys":
      for (const s of CLIENT_CONFIG_KEYS) {
        const range = s.values ? s.values.join("|") : s.min !== undefined ? `${s.min}–${s.max}` : s.type;
        console.log(`${s.key.padEnd(28)} ${show(s.default).padEnd(30)} ${range}`);
        console.log(`${"".padEnd(28)} ${s.doc}${s.env ? ` (${s.env} wins)` : ""}  [${s.usedBy.join(", ") || "unused"}]`);
      }
      return;
    case "get": {
      const key = rest[0];
      if (!key || rest.length > 1) fail("usage: herdr-pocket config get <key>   (keys: herdr-pocket config keys)");
      if (!configKeySpec(key)) fail(`unknown key ${key}. \`herdr-pocket config keys\` lists them.`);
      const cur = readClientConfig(path);
      await problemsToRelay(cur, report);
      console.log(show(getConfigValue(cur.config, key)));
      const env = envOverride(key);
      if (env) console.error(`note  ${env} is set and wins over the file`);
      return;
    }
    case "set":
    case "unset": {
      const [key, ...words] = rest;
      if (!key || (sub === "set" ? !words.length : words.length)) fail(sub === "set" ? "usage: herdr-pocket config set <key> <value>" : "usage: herdr-pocket config unset <key>");
      const spec = configKeySpec(key);
      if (!spec) fail(`unknown key ${key}. \`herdr-pocket config keys\` lists them.`);
      let value: ConfigValue | undefined;
      if (sub === "set") {
        const parsed = parseConfigText(key, words.join(" "));
        if ("error" in parsed) fail(parsed.error);
        value = parsed.value;
      }
      const before = readClientConfig(path);
      const from = getConfigValue(before.config, key);
      let after: LoadedClientConfig;
      try {
        after = setClientConfigValue(key, value, path);
      } catch (e) {
        fail((e as Error).message);
      }
      const to = getConfigValue(after.config, key);
      console.log(`${key} = ${show(to)}${value === undefined ? " (default)" : ""}`);
      const env = envOverride(key);
      if (env) console.error(`note  ${env} is set and wins over the file`);
      await report?.("info", `config ${sub} ${key}: ${show(from)} -> ${show(to)}`, { key, from: show(from), to: show(to), via: "cli" });
      return;
    }
    case "edit":
      return editConfig(path, report);
    default:
      fail(`unknown config command: ${sub}\n\n${CONFIG_HELP}`);
  }
}

async function showConfig(argv: string[], path: string, report?: ConfigReport): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { all: { type: "boolean", default: false }, json: { type: "boolean", default: false } } });
  const cur = readClientConfig(path);
  await problemsToRelay(cur, report);
  if (values.json) {
    console.log(JSON.stringify({ path, exists: cur.exists, config: cur.config, problems: cur.problems }, null, 2));
    return;
  }
  console.log(`# ${path}${cur.exists ? "" : " (not created yet: every key is at its default)"}`);
  let shown = 0;
  for (const s of CLIENT_CONFIG_KEYS) {
    const v = getConfigValue(cur.config, s.key);
    const changed = JSON.stringify(v) !== JSON.stringify(s.default);
    if (!values.all && !changed) continue;
    shown++;
    const env = envOverride(s.key);
    console.log(`${s.key.padEnd(28)} ${show(v)}${changed ? `   (default ${show(s.default)})` : ""}${env ? `   [${env} wins]` : ""}`);
  }
  if (!shown) console.log("everything is at its default. `herdr-pocket config show --all` lists every key.");
  printProblems(cur.problems);
}

/** Reading the file is not news, but a file with mistakes in it is: those go to the relay's log once. */
async function problemsToRelay(cur: LoadedClientConfig, report?: ConfigReport): Promise<void> {
  const errors = cur.problems.filter((p) => p.level === "error");
  if (errors.length && report) await report("warn", `config.json has ${errors.length} problem(s): ${errors.map((p) => `${p.key || "file"}: ${p.message}`).join("; ")}`, { path: cur.path, via: "cli" });
}

function editorCommand(): { cmd: string; args: string[]; shell: boolean; waits: boolean } | undefined {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (editor) return { cmd: editor, args: [], shell: true, waits: true };
  if (process.platform === "win32") return { cmd: "notepad.exe", args: [], shell: false, waits: true };
  if (process.platform === "darwin") return process.stdin.isTTY ? { cmd: "vi", args: [], shell: false, waits: true } : { cmd: "open", args: ["-t"], shell: false, waits: false };
  return process.stdin.isTTY ? { cmd: "vi", args: [], shell: false, waits: true } : { cmd: "xdg-open", args: [], shell: false, waits: false };
}

async function editConfig(path: string, report?: ConfigReport): Promise<void> {
  const before = readClientConfig(path);
  if (!existsSync(path)) writeClientConfig({ version: 1 }, path);
  const ed = editorCommand();
  if (!ed) fail(`no editor found. Edit ${path} by hand.`);
  // An EDITOR such as "code -w" carries its own arguments, so it goes through the shell (the path is quoted).
  const r = ed.shell
    ? spawnSync(`${ed.cmd} ${JSON.stringify(path)}`, { stdio: "inherit", shell: true })
    : spawnSync(ed.cmd, [...ed.args, path], { stdio: "inherit" });
  if (r.error || r.status !== 0) fail(`the editor did not run (${r.error?.message ?? `exit ${r.status}`}). Edit ${path} by hand.`);
  if (!ed.waits) {
    console.log(`opened ${path}. Check it afterwards with \`herdr-pocket config show\`.`);
    return;
  }
  const after = readClientConfig(path);
  const changed = changedKeys(before.config, after.config);
  console.log(changed.length ? `changed: ${changed.join(", ")}` : "nothing changed.");
  printProblems(after.problems);
  if (changed.length) await report?.("info", `config edited: ${changed.join(", ")}`, { keys: changed.join(","), via: "cli" });
  await problemsToRelay(after, report);
}

/** Keys whose value differs between two readings of the file. */
export function changedKeys(a: ClientConfig, b: ClientConfig): string[] {
  return CLIENT_CONFIG_KEYS.filter((s) => JSON.stringify(getConfigValue(a, s.key)) !== JSON.stringify(getConfigValue(b, s.key))).map((s) => s.key);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
