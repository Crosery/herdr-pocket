import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { HERDR_COMMANDS, type HerdrCommand, type HerdrDoc, type LaunchOption, type SpaceInfo } from "@herdr-pocket/protocol";
import type { AppNames, AppTerminalMeta, HcTerminal } from "./hc.ts";
import { IS_WINDOWS, onPath, programName, windowsBins } from "./platform.ts";
import { base, run } from "./util.ts";

/**
 * Programs the phone may start. The phone picks an id, never a command line,
 * so a viewer token cannot run arbitrary programs on this computer.
 */
export const LAUNCHERS: Array<LaunchOption & { argv: string[] }> = [
  { id: "claude", label: "Claude Code", argv: ["claude"], takesTask: true },
  { id: "codex", label: "Codex", argv: ["codex"], takesTask: true },
  { id: "omp", label: "omp", argv: ["omp"], takesTask: true },
  { id: "opencode", label: "OpenCode", argv: ["opencode"], takesTask: false },
  { id: "gemini", label: "Gemini CLI", argv: ["gemini"], takesTask: false },
  { id: "pi", label: "pi", argv: ["pi"], takesTask: true },
  { id: "kilo", label: "Kilo", argv: ["kilo"], takesTask: false },
  { id: "hermes", label: "Hermes", argv: ["hermes"], takesTask: false },
  // Offered only where installed. Without `takesTask` the first task is sent as a message once it's up.
  { id: "kimi", label: "Kimi Code", argv: ["kimi"], takesTask: false },
  { id: "cursor-agent", label: "Cursor Agent", argv: ["cursor-agent"], takesTask: false },
  { id: "droid", label: "Droid", argv: ["droid"], takesTask: false },
  { id: "codebuddy", label: "CodeBuddy", argv: ["codebuddy"], takesTask: false },
  { id: "qoder", label: "Qoder", argv: ["qoder"], takesTask: false },
  { id: "qwen", label: "Qwen Code", argv: ["qwen"], takesTask: false },
  { id: "copilot", label: "Copilot CLI", argv: ["copilot"], takesTask: false },
  { id: "amp", label: "Amp", argv: ["amp"], takesTask: false },
  { id: "crush", label: "Crush", argv: ["crush"], takesTask: false },
  { id: "goose", label: "Goose", argv: ["goose"], takesTask: false },
  { id: "aider", label: "Aider", argv: ["aider"], takesTask: false },
  { id: "iflow", label: "iFlow", argv: ["iflow"], takesTask: false },
  { id: "cline", label: "Cline", argv: ["cline"], takesTask: false },
  { id: "shell", label: "终端", argv: [], takesTask: false },
];

/** Where each program was last found: launching by full path works whatever PATH the desktop app has. */
const programPaths = new Map<string, string>();

/** Folders that installers add to PATH in shell rc files, which a login-only shell never reads. */
function commonBins(): string[] {
  const h = homedir();
  return [
    `${h}/.bun/bin`,
    `${h}/.local/bin`,
    `${h}/.npm-global/bin`,
    `${h}/.volta/bin`,
    `${h}/.cargo/bin`,
    `${h}/.deno/bin`,
    `${h}/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
  ];
}

function executable(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Finds programs the way the person's own terminal does. A service started by
 * launchd/systemd has a bare PATH, and a login shell (`-l`) skips ~/.zshrc,
 * where e.g. bun puts ~/.bun/bin (claude, codex, gemini...): so ask an
 * interactive login shell, then look in the usual install folders as well.
 */
export async function findPrograms(names: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (IS_WINDOWS) {
    // A service started at logon has the person's full PATH; npm, bun and other installers' folders cover the rest.
    const extra = windowsBins();
    for (const name of names) {
      const hit = onPath(name, process.env, true, extra);
      if (hit) found.set(name, hit);
    }
    return found;
  }
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const out = await run(shell, ["-lic", `for c in ${names.join(" ")}; do p=$(command -v "$c" 2>/dev/null) && echo "@@$c=$p"; done; true`], {
      timeoutMs: 15_000,
      input: "",
      env: { ...process.env, TERM: "dumb" },
    });
    for (const line of out.split("\n")) {
      const m = /^@@([\w.-]+)=(\/.+)$/.exec(line.trim());
      if (m && names.includes(m[1]!) && executable(m[2]!)) found.set(m[1]!, m[2]!);
    }
  } catch {
    /* rc files that hang or fail: the folder scan below still works */
  }
  for (const name of names) {
    if (found.has(name)) continue;
    const hit = commonBins().map((d) => `${d}/${name}`).find(executable);
    if (hit) found.set(name, hit);
  }
  return found;
}

/** argv with its program as the full path found here, so it starts whatever PATH the service has. */
export function withProgramPath(argv: string[]): string[] {
  return argv.length ? [programPaths.get(argv[0]!) ?? argv[0]!, ...argv.slice(1)] : argv;
}

/** What a launcher runs (empty: the computer's own shell). */
export function launcherArgv(id: string): string[] {
  const l = LAUNCHERS.find((x) => x.id === id);
  if (!l) throw new Error("不支持启动这个程序");
  return withProgramPath(l.argv);
}

/** Which launchers exist here (the shell is always there). */
export async function installedLaunchers(): Promise<LaunchOption[]> {
  const names = LAUNCHERS.filter((l) => l.argv.length).map((l) => l.argv[0]!);
  const found = await findPrograms(names);
  programPaths.clear();
  for (const [k, v] of found) programPaths.set(k, v);
  return LAUNCHERS.filter((l) => !l.argv.length || found.has(l.argv[0]!)).map(({ argv: _argv, ...o }) => o);
}

/** `~`-expanded absolute folder that exists, or an error message. */
export function checkFolder(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("请选一个文件夹");
  let p = raw.trim();
  if (p === "~" || p.startsWith("~/") || (IS_WINDOWS && p.startsWith("~\\"))) p = homedir() + p.slice(1);
  if (!isAbsolute(p)) throw new Error("文件夹要写完整路径，比如 ~/work_file/项目");
  p = resolve(p);
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`这台电脑上没有这个文件夹：${raw}`);
  return p;
}

export interface AppLsTerminal {
  terminal?: string;
  id?: string;
  pane?: string;
  status?: string | null;
  app?: string | null;
  name?: string | null;
  sub_agents?: Array<{
    terminal?: string;
    id?: string;
    status?: string | null;
    app?: string | null;
    name?: string | null;
  }>;
}

export interface AppLs {
  spaces: Array<{
    id: string;
    name: string;
    folder?: string;
    machine?: string | null;
    active?: boolean;
    tabs?: Array<{
      id?: string;
      name?: string;
      active?: boolean;
      settled?: boolean;
      terminals?: AppLsTerminal[];
    }>;
  }>;
}

/** Shortens paths inside `home` to `~` / `~/...` so folder chips stay concise and deduplicate cleanly. */
export function shortHome(p: string | undefined, home = homedir()): string | undefined {
  const clean = p?.trim();
  if (!clean) return undefined;
  const h = home.replace(/[\\/]+$/, "");
  const c = clean.length > 1 && !/^[A-Za-z]:[\\/]?$/.test(clean) ? clean.replace(/[\\/]+$/, "") : clean;
  if (c === h) return "~";
  if (c.startsWith(`${h}/`) || (IS_WINDOWS && c.startsWith(`${h}\\`))) {
    return `~${c.slice(h.length)}`;
  }
  return c;
}

const SHELL_BINS = new Set(["sh", "zsh", "bash", "fish", "pwsh", "powershell", "cmd"]);

export type SpaceTerminalMeta = {
  cwd?: string | null;
  foreground?: { argv?: string[]; cwd?: string | null } | null;
  status?: { app?: string | null } | null;
  argv?: string[];
};

/**
 * Resolves a space's real working folder from live terminals inside it (`hc`), because `herdr-app ls`
 * keeps each space's initial creation-time `s.folder` (often `~` or `~/tmp`) even after moving into a repo.
 */
export function resolveSpaceFolder(
  space: AppLs["spaces"][number],
  terminals?: ReadonlyMap<string, SpaceTerminalMeta>,
  home = homedir(),
): string | undefined {
  const counts = new Map<string, number>();
  if (terminals?.size) {
    for (const tab of space.tabs ?? []) {
      for (const term of tab.terminals ?? []) {
        if (!term.terminal) continue;
        const t = terminals.get(term.terminal);
        const rawCwd = (t?.foreground?.cwd || t?.cwd)?.trim();
        if (!rawCwd || rawCwd === "/") continue;
        const prog = (t?.status?.app || base(t?.foreground?.argv?.[0]) || base(t?.argv?.[0])).toLowerCase();
        const isAgent = Boolean(prog) && !SHELL_BINS.has(prog);
        const weight = (isAgent ? 2 : 1) + (tab.active ? 0.5 : 0);
        counts.set(rawCwd, (counts.get(rawCwd) ?? 0) + weight);
      }
    }
  }
  for (const a of counts.keys()) {
    for (const [b, scoreB] of counts.entries()) {
      if (a !== b && a !== home && (b.startsWith(`${a}/`) || b.startsWith(`${a}\\`))) {
        counts.set(a, counts.get(a)! + scoreB * 0.6);
      }
    }
  }
  const best = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].length - y[0].length)[0]?.[0] ?? space.folder;
  return shortHome(best, home);
}

/**
 * The desktop herdr app is not installed on this computer: herdr-core alone, as on Windows
 * (where herdr has no desktop app) or a server. Terminals are then started with `hc run`.
 */
export class NoDesktopApp extends Error {
  constructor() {
    super("这台电脑上没有桌面 herdr");
  }
}

const notInstalled = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

function defaultSharedJsonPath(): string {
  const cfg = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(cfg, "herdr-app", "shared.json");
}

function defaultDocsJsonPath(): string {
  const state = process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(state, "herdr-core", "default", "docs.json");
}

export function collectTerminalIdsFromRoot(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectTerminalIdsFromRoot(item, out);
    return out;
  }
  const rec = node as Record<string, unknown>;
  if (typeof rec.terminal === "string" && rec.terminal.trim()) out.push(rec.terminal.trim());
  if (typeof rec.terminalId === "string" && rec.terminalId.trim()) out.push(rec.terminalId.trim());
  for (const key of ["content", "children", "left", "right", "first", "second", "tabs", "panes"]) {
    if (key in rec && rec[key] !== undefined) collectTerminalIdsFromRoot(rec[key], out);
  }
  return out;
}

function isDoomedTerminalRec(rec: Record<string, unknown>, doomed: ReadonlySet<string>): boolean {
  const tid =
    typeof rec.terminal === "string"
      ? rec.terminal.trim()
      : typeof rec.terminalId === "string"
        ? rec.terminalId.trim()
        : "";
  return Boolean(tid && doomed.has(tid));
}

function pruneRootNode(
  node: unknown,
  doomed: ReadonlySet<string>,
): { node: unknown; changed: boolean } {
  if (!node || typeof node !== "object") return { node, changed: false };
  if (Array.isArray(node)) {
    let changed = false;
    const next: unknown[] = [];
    for (const item of node) {
      const res = pruneRootNode(item, doomed);
      if (res.changed) changed = true;
      if (res.node !== null) next.push(res.node);
      else changed = true;
    }
    if (next.length === 0) return { node: null, changed: true };
    return { node: changed ? next : node, changed };
  }

  const rec = node as Record<string, unknown>;
  if (isDoomedTerminalRec(rec, doomed)) return { node: null, changed: true };
  if (rec.content && typeof rec.content === "object" && !Array.isArray(rec.content)) {
    if (isDoomedTerminalRec(rec.content as Record<string, unknown>, doomed)) {
      return { node: null, changed: true };
    }
  }

  let changed = false;
  const copy: Record<string, unknown> = { ...rec };

  for (const listKey of ["children", "panes", "tabs"] as const) {
    if (!Array.isArray(rec[listKey])) continue;
    const arr = rec[listKey] as unknown[];
    const nextArr: unknown[] = [];
    let listChanged = false;
    for (const child of arr) {
      const res = pruneRootNode(child, doomed);
      if (res.changed) listChanged = true;
      if (res.node !== null) nextArr.push(res.node);
      else listChanged = true;
    }
    if (listChanged) {
      changed = true;
      if (nextArr.length === 0 && !rec.content && typeof rec.terminal !== "string" && typeof rec.terminalId !== "string") {
        return { node: null, changed: true };
      }
      copy[listKey] = nextArr;
    }
  }

  for (const [kA, kB] of [["first", "second"], ["left", "right"]] as const) {
    if (kA in rec || kB in rec) {
      const resA = rec[kA] !== undefined ? pruneRootNode(rec[kA], doomed) : { node: null, changed: false };
      const resB = rec[kB] !== undefined ? pruneRootNode(rec[kB], doomed) : { node: null, changed: false };
      if (resA.changed || resB.changed) {
        changed = true;
        if (resA.node === null && resB.node === null) return { node: null, changed: true };
        if (resA.node === null) return { node: resB.node, changed: true };
        if (resB.node === null) return { node: resA.node, changed: true };
        copy[kA] = resA.node;
        copy[kB] = resB.node;
      }
    }
  }

  if (rec.content !== undefined && typeof rec.content === "object") {
    const res = pruneRootNode(rec.content, doomed);
    if (res.changed) {
      changed = true;
      if (res.node === null) return { node: null, changed: true };
      copy.content = res.node;
    }
  }

  return { node: changed ? copy : node, changed };
}

/** The desktop herdr app (`herdr-app`), driven through its own commands. */
export class HerdrApp {
  private bin: string;
  private sharedJsonPath: string;
  private docsJsonPath: string;

  constructor(
    bin = process.env.HERDR_APP_BIN ?? "herdr-app",
    opts?: { sharedJsonPath?: string; docsJsonPath?: string },
  ) {
    this.bin = bin;
    this.sharedJsonPath = opts?.sharedJsonPath ?? defaultSharedJsonPath();
    this.docsJsonPath = opts?.docsJsonPath ?? defaultDocsJsonPath();
  }

  private readSpaceColors(): Record<string, string> {
    try {
      const raw = JSON.parse(readFileSync(this.sharedJsonPath, "utf8")) as { "space.colors"?: unknown };
      const map = raw?.["space.colors"];
      if (!map || typeof map !== "object" || Array.isArray(map)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) out[k] = v.trim();
      }
      return out;
    } catch {
      return {};
    }
  }

  private readDocsWorktreeIds(): Set<string> {
    const out = new Set<string>();
    try {
      const raw = JSON.parse(readFileSync(this.docsJsonPath, "utf8")) as Record<string, any>;
      const docVal = raw?.["herdr-app"]?.value ?? raw?.docs?.["herdr-app"]?.value;
      const list = Array.isArray(docVal?.spaces) ? docVal.spaces : [];
      for (const s of list) {
        if (s && typeof s.id === "string" && s.isWorktree) out.add(s.id);
      }
    } catch {
      // ignore missing/invalid docs.json
    }
    return out;
  }

  /** Reads persisted `"herdr-app"` doc and CAS version from `docs.json` when available. */
  readHerdrDocFromDisk(): { value: HerdrDoc | null; version: number } | null {
    try {
      const raw = JSON.parse(readFileSync(this.docsJsonPath, "utf8")) as Record<string, any>;
      const entry = raw?.["herdr-app"] ?? raw?.docs?.["herdr-app"];
      if (!entry || typeof entry !== "object") return null;
      const val = entry.value;
      const doc = val && typeof val === "object" && Array.isArray(val.spaces) ? (val as HerdrDoc) : null;
      const version = Number(entry.version ?? 0);
      return { value: doc, version: Number.isFinite(version) ? version : 0 };
    } catch {
      return null;
    }
  }

  /** Reads spaces, order, folders, and colors directly from Herdr's persisted docs.json + shared.json. */
  spacesFromDocs(terminals?: ReadonlyMap<string, SpaceTerminalMeta>): SpaceInfo[] {
    try {
      const raw = JSON.parse(readFileSync(this.docsJsonPath, "utf8")) as Record<string, any>;
      const docVal = raw?.["herdr-app"]?.value ?? raw?.docs?.["herdr-app"]?.value;
      const list = Array.isArray(docVal?.spaces) ? docVal.spaces : [];
      const activeSpaceId = typeof docVal?.activeSpaceId === "string" ? docVal.activeSpaceId : undefined;
      const colors = this.readSpaceColors();
      const out: SpaceInfo[] = [];
      for (const s of list) {
        if (!s || typeof s.id !== "string" || typeof s.name !== "string" || s.machine) continue;
        const rawTabs = Array.isArray(s.tabs) ? s.tabs : [];
        const synthTabs = rawTabs.map((t: any) => {
          const directTerms = Array.isArray(t?.terminals)
            ? t.terminals.map((x: any) => ({ terminal: typeof x?.terminal === "string" ? x.terminal : x?.id }))
            : [];
          if (directTerms.length > 0) return { terminals: directTerms };
          const termIds = collectTerminalIdsFromRoot(t?.root);
          return { terminals: termIds.map((id) => ({ terminal: id })) };
        });
        const folder = resolveSpaceFolder({ id: s.id, name: s.name, folder: s.folder, tabs: synthTabs }, terminals);
        const termCount = synthTabs.reduce((n: number, t: { terminals: unknown[] }) => n + t.terminals.length, 0);
        const color = colors[s.id] ?? colors[s.name] ?? (typeof s.color === "string" ? s.color : undefined);
        const active = activeSpaceId === s.id || Boolean(s.active);
        out.push({
          id: s.id,
          name: s.name,
          ...(folder ? { folder } : {}),
          tabs: rawTabs.length,
          terminals: termCount,
          ...(color ? { color } : {}),
          ...(active ? { active: true } : {}),
          ...(s.isWorktree ? { isWorktree: true } : {}),
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** The window's spaces, tabs and terminals; throws when the window is not open. */
  async ls(): Promise<AppLs> {
    const out = await run(this.bin, ["ls"], { timeoutMs: 8000 }).catch((e: unknown) => {
      throw notInstalled(e) ? new NoDesktopApp() : e;
    });
    const ls = JSON.parse(out) as AppLs;
    if (!Array.isArray(ls?.spaces)) throw new Error("herdr-app ls: no spaces");
    return ls;
  }

  /** Space, tab, and terminal metadata by id as the open window shows them; throws when the window is not open. */
  async names(): Promise<AppNames> {
    const spaces = new Map<string, string>();
    const tabs = new Map<string, string>();
    const terminals = new Map<string, AppTerminalMeta>();
    for (const s of (await this.ls()).spaces) {
      if (s.machine) continue;
      if (s.id && s.name) spaces.set(s.id, s.name);
      for (const t of s.tabs ?? []) {
        if (t.id && t.name) tabs.set(t.id, t.name);
        if (!s.id || !s.name) continue;
        for (const term of t.terminals ?? []) {
          const addr = (term.terminal ?? term.id)?.trim();
          if (addr) {
            terminals.set(addr, {
              spaceId: s.id,
              spaceName: s.name,
              ...(t.id ? { tabId: t.id } : {}),
              ...(t.name ? { tabName: t.name } : {}),
              ...(term.app !== undefined ? { app: term.app } : {}),
              ...(term.status !== undefined ? { status: term.status } : {}),
              ...(term.name !== undefined ? { name: term.name } : {}),
            });
          }
          for (const sub of term.sub_agents ?? []) {
            const subAddr = (sub?.terminal ?? sub?.id)?.trim();
            if (!subAddr) continue;
            terminals.set(subAddr, {
              spaceId: s.id,
              spaceName: s.name,
              ...(t.id ? { tabId: t.id } : {}),
              ...(t.name ? { tabName: t.name } : {}),
              ...(sub.app !== undefined ? { app: sub.app } : {}),
              ...(sub.status !== undefined ? { status: sub.status } : {}),
              ...(sub.name !== undefined ? { name: sub.name } : {}),
            });
          }
        }
      }
    }
    return { spaces, tabs, terminals };
  }

  /** Fallback space, tab, and terminal names from persisted docs.json when the window is closed. */
  namesFromDocs(): AppNames | null {
    try {
      const raw = JSON.parse(readFileSync(this.docsJsonPath, "utf8")) as Record<string, any>;
      const docVal = raw?.["herdr-app"]?.value ?? raw?.docs?.["herdr-app"]?.value;
      const list = Array.isArray(docVal?.spaces) ? docVal.spaces : null;
      if (!list) return null;
      const spaces = new Map<string, string>();
      const tabs = new Map<string, string>();
      const terminals = new Map<string, AppTerminalMeta>();
      for (const s of list) {
        if (!s || typeof s.id !== "string" || typeof s.name !== "string" || s.machine) continue;
        spaces.set(s.id, s.name);
        const rawTabs = Array.isArray(s.tabs) ? s.tabs : [];
        for (const t of rawTabs) {
          if (typeof t?.id === "string" && typeof t?.name === "string") tabs.set(t.id, t.name);
          const tabId = typeof t?.id === "string" ? t.id : undefined;
          const tabName = typeof t?.name === "string" ? t.name : undefined;
          const directTerms = Array.isArray(t?.terminals) ? t.terminals : [];
          if (directTerms.length > 0) {
            for (const x of directTerms) {
              const addr = (typeof x?.terminal === "string" ? x.terminal : typeof x?.id === "string" ? x.id : "").trim();
              if (!addr) continue;
              terminals.set(addr, {
                spaceId: s.id,
                spaceName: s.name,
                ...(tabId ? { tabId } : {}),
                ...(tabName ? { tabName } : {}),
                ...(x?.app !== undefined ? { app: x.app } : {}),
                ...(x?.status !== undefined ? { status: x.status } : {}),
                ...(x?.name !== undefined ? { name: x.name } : {}),
              });
            }
          } else {
            for (const addr of collectTerminalIdsFromRoot(t?.root)) {
              terminals.set(addr, {
                spaceId: s.id,
                spaceName: s.name,
                ...(tabId ? { tabId } : {}),
                ...(tabName ? { tabName } : {}),
              });
            }
          }
        }
      }
      return { spaces, tabs, terminals };
    } catch {
      return null;
    }
  }

  /** Spaces of this computer in the open window (exact Herdr App order + colors); throws when the window is not open. */
  async spaces(terminals?: ReadonlyMap<string, SpaceTerminalMeta>): Promise<SpaceInfo[]> {
    const ls = await this.ls();
    const colors = this.readSpaceColors();
    const worktrees = this.readDocsWorktreeIds();
    return ls.spaces
      .filter((s) => !s.machine)
      .map((s) => {
        const extra = s as { active?: boolean; isWorktree?: boolean; color?: string };
        const color = colors[s.id] ?? colors[s.name] ?? extra.color;
        const isWorktree = Boolean(extra.isWorktree || worktrees.has(s.id));
        return {
          id: s.id,
          name: s.name,
          folder: resolveSpaceFolder(s, terminals),
          tabs: s.tabs?.length ?? 0,
          terminals: (s.tabs ?? []).reduce((n, t) => n + (t.terminals?.length ?? 0), 0),
          ...(color ? { color } : {}),
          ...(extra.active ? { active: true } : {}),
          ...(isWorktree ? { isWorktree: true } : {}),
        };
      });
  }

  /**
   * New space (`space` absent) or new tab in a space, with the chosen program
   * and its first message. Returns the new terminal address.
   */
  async create(o: { space?: string; spaceName?: string; tabName?: string; folder?: string; launcher: string; task?: string }): Promise<{
    space: string;
    tab: string;
    terminal: string;
  }> {
    const argv = launcherArgv(o.launcher);
    const task = o.task?.trim();
    return this.open({ ...o, argv, task: task && argv.length ? task : undefined });
  }

  /** New tab in `space`, or a new space, running `argv` (empty: a shell). Callers decide what may run. */
  async open(o: { space?: string; spaceName?: string; tabName?: string; folder?: string; argv: string[]; task?: string }): Promise<{
    space: string;
    tab: string;
    terminal: string;
  }> {
    const args: Record<string, unknown> = {};
    if (o.argv.length) args.argv = o.argv;
    if (o.task) args.task = o.task;
    if (o.folder) args.folder = o.folder;
    let cmd: string;
    if (o.space) {
      cmd = "tab.new";
      args.space = o.space;
      if (o.tabName?.trim()) args.name = o.tabName.trim();
    } else {
      cmd = "space.new";
      args.machine = ""; // this computer, not the focused space's machine
      if (o.spaceName?.trim()) args.name = o.spaceName.trim();
      if (o.tabName?.trim()) args.tab = o.tabName.trim();
    }
    const out = await doCommand(this.bin, cmd, args);
    const r = parseDoResult(out);
    if (!r.terminal) throw new Error(`桌面 herdr 没有返回新终端：${out.trim().slice(0, 200)}`);
    return r;
  }

  /** Runs one checked command (see `herdrCommandArgs`) and returns what the app answered. */
  async command(command: HerdrCommand, args: Record<string, unknown>): Promise<unknown> {
    return parseDo(await doCommand(this.bin, command, args));
  }

  /**
   * Closes a space and ends its terminals (matching `herdr-app`'s `space.close`):
   * uses `herdr-app do space.close` when open, falls back to mutating the `herdr-app`
   * doc via `hc` when closed, and cleans up standalone orphan `hc` / `herdr` terminals.
   * Never deletes any folders or files on disk.
   */
  async deleteSpace(
    opts: { spaceId?: string; spaceName?: string },
    hc: {
      terminals: ReadonlyMap<string, HcTerminal>;
      docGet?: (name: string) => Promise<{ value: unknown; version: number } | null>;
      docSet?: (name: string, value: unknown, version: number) => Promise<number | null>;
      kill: (address: string) => Promise<void>;
      label?: (address: string, labels: Record<string, string>) => Promise<void>;
    },
    deps: {
      names?: AppNames;
      herdr?: {
        agents: Array<{ workspace_id?: string }>;
        call: (method: string, params: unknown) => Promise<unknown>;
      };
    } = {},
  ): Promise<{ closedTerminals: number }> {
    const reqId = opts.spaceId?.trim() || "";
    const reqName = opts.spaceName?.trim() || "";
    if (!reqId && !reqName) throw new Error("需要提供 spaceId 或 spaceName");

    let targetId = reqId;
    if (!targetId && reqName) {
      const listed = await this.spaces(hc.terminals).catch(() => this.spacesFromDocs(hc.terminals));
      const matched = listed.find((s) => s.name === reqName);
      if (matched) targetId = matched.id;
    }

    const doomed = new Set<string>();
    for (const [addr, t] of hc.terminals.entries()) {
      if (targetId && t.labels?.["herdr.space"] === targetId) {
        doomed.add(addr);
      } else if (!targetId && reqName) {
        const spName = t.labels?.["herdr.space"]
          ? deps.names?.spaces.get(t.labels["herdr.space"])
          : t.labels?.where?.split(" / ")[0]?.trim();
        if (spName === reqName) doomed.add(addr);
      }
    }

    let closedByApp = false;
    if (targetId) {
      try {
        await this.command("space.close", { id: targetId, confirmed: true });
        closedByApp = true;
      } catch (e) {
        const msg = (e as Error).message || "";
        if (!(e instanceof NoDesktopApp) && !/没有打开|no herdr window|no window|not running/i.test(msg)) {
          throw e;
        }
      }
    }

    if (!closedByApp && hc.docGet && hc.docSet) {
      const doc = await hc.docGet("herdr-app").catch(() => null);
      const val = doc?.value && typeof doc.value === "object" && !Array.isArray(doc.value)
        ? (doc.value as Record<string, unknown>)
        : null;
      const list = Array.isArray(val?.spaces) ? (val!.spaces as Array<Record<string, unknown>>) : null;
      if (val && list) {
        const idx = list.findIndex((s) => {
          if (!s || s.machine) return false;
          if (targetId) return s.id === targetId;
          return s.name === reqName;
        });
        if (idx >= 0) {
          const removed = list[idx]!;
          if (!targetId && typeof removed.id === "string") targetId = removed.id;
          const tabs = Array.isArray(removed.tabs) ? removed.tabs : [];
          for (const tab of tabs) {
            if (!tab || typeof tab !== "object") continue;
            const tRec = tab as Record<string, unknown>;
            for (const id of collectTerminalIdsFromRoot(tRec.root)) doomed.add(id);
            if (Array.isArray(tRec.terminals)) {
              for (const x of tRec.terminals) {
                const tid = typeof (x as any)?.terminal === "string" ? (x as any).terminal : (x as any)?.id;
                if (typeof tid === "string" && tid.trim()) doomed.add(tid.trim());
              }
            }
          }
          if (targetId) {
            for (const [addr, t] of hc.terminals.entries()) {
              if (t.labels?.["herdr.space"] === targetId) doomed.add(addr);
            }
          }
          const remaining = list.filter((_, i) => i !== idx);
          const nextVal: Record<string, unknown> = { ...val, spaces: remaining };
          if (typeof val.activeSpaceId === "string" && val.activeSpaceId === removed.id) {
            const fallbackId = remaining.find((s) => s && !s.machine && typeof s.id === "string")?.id;
            nextVal.activeSpaceId = typeof fallbackId === "string" ? fallbackId : null;
          }
          await hc.docSet("herdr-app", nextVal, doc!.version);
        }
      }
    }

    // Collect un-kept child sub-agents recursively (matching Herdr App window.rs)
    let added = true;
    while (added) {
      added = false;
      for (const [addr, t] of hc.terminals.entries()) {
        if (doomed.has(addr)) continue;
        if (t.parent && doomed.has(t.parent) && !t.labels?.["herdr.space"]) {
          doomed.add(addr);
          added = true;
        }
      }
    }

    let closedTerminals = doomed.size;
    if (doomed.size > 0) {
      await Promise.all(
        [...doomed].map(async (addr) => {
          // Clear space/tab labels first so Herdr.app reconcile() cannot resurrect the deleted space
          if (hc.label) {
            await hc.label(addr, { "herdr.space": "", "herdr.tab": "", where: "" }).catch(() => {});
          }
          await hc.kill(addr).catch(() => {});
        }),
      );
    }

    if (!closedByApp && !targetId && reqName && deps.herdr) {
      const hasTuiWs = deps.herdr.agents.some((a) => a.workspace_id === reqName);
      if (hasTuiWs) {
        const count = deps.herdr.agents.filter((a) => a.workspace_id === reqName).length;
        await deps.herdr.call("workspace.close", { workspace_id: reqName, close_group: true }).catch(() => {});
        closedTerminals += count;
      }
    }

    return { closedTerminals };
  }

  /**
   * Closes a single agent/terminal tab (matching `herdr-app`'s `tab.close` / `pane.close`):
   * - Uses `herdr-app do tab.close` (or `pane.close` for shared split panes) when `Herdr.app` is open.
   * - Falls back to mutating the `herdr-app` doc via `hc` when `Herdr.app` is closed, pruning `localId`
   *   from split panes and removing empty tabs cleanly while updating `activeTabId`.
   * - Recursively collects un-kept child sub-agents, clears `herdr.space`/`herdr.tab`/`where` labels
   *   first so `Herdr.app reconcile()` cannot resurrect the closed tab, then runs `hc.kill` and `hc.rm`.
   */
  async closeAgentTerminal(
    opts: { localId: string },
    hc: {
      terminals: ReadonlyMap<string, HcTerminal>;
      docGet?: (name: string) => Promise<{ value: unknown; version: number } | null>;
      docSet?: (name: string, value: unknown, version: number) => Promise<number | null>;
      kill: (address: string) => Promise<void>;
      rm?: (address: string) => Promise<void>;
      label?: (address: string, labels: Record<string, string>) => Promise<void>;
    },
    _deps: {
      herdr?: {
        agents: Array<{ terminal_id?: string; pane_id?: string; workspace_id?: string; tab_id?: string }>;
        call: (method: string, params: unknown) => Promise<unknown>;
      };
    } = {},
  ): Promise<{ closedTab: boolean; closedTerminals: number }> {
    const localId = opts.localId?.trim();
    if (!localId) return { closedTab: false, closedTerminals: 0 };

    const t = hc.terminals.get(localId);
    const tabId = t?.labels?.["herdr.tab"]?.trim() || undefined;

    // Collect un-kept child sub-agents recursively BEFORE checking whether another terminal shares `tabId`.
    const doomed = new Set<string>([localId]);
    let added = true;
    while (added) {
      added = false;
      for (const [addr, term] of hc.terminals.entries()) {
        if (doomed.has(addr)) continue;
        if (term.parent && doomed.has(term.parent) && !term.labels?.["herdr.space"]) {
          doomed.add(addr);
          added = true;
        }
      }
    }

    const sharesTab = tabId
      ? [...hc.terminals.entries()].some(([addr, term]) => !doomed.has(addr) && term.labels?.["herdr.tab"] === tabId)
      : false;

    let closedByApp = false;
    let closedTab = false;
    let appNotOpen = false;
    const isWindowClosed = (e: unknown): boolean =>
      e instanceof NoDesktopApp || /没有打开|no herdr window|no window|not running/i.test((e as Error)?.message || "");

    if (tabId && !sharesTab) {
      try {
        await this.command("tab.close", { id: tabId, confirmed: true });
        closedByApp = true;
        closedTab = true;
      } catch (e) {
        if (isWindowClosed(e)) appNotOpen = true;
        else throw e;
      }
    } else if (tabId && sharesTab) {
      try {
        const ls = await this.ls();
        const tabRec = ls.spaces
          .flatMap((s) => s.tabs ?? [])
          .find((tb) => tb.id === tabId || tb.terminals?.some((x) => x.terminal === localId));
        const paneId = tabRec?.terminals?.find((x) => x.terminal === localId)?.pane;
        if (paneId) {
          await this.command("pane.close", { pane: paneId });
          closedByApp = true;
          closedTab = false;
        }
      } catch (e) {
        if (isWindowClosed(e)) appNotOpen = true;
        else throw e;
      }
    } else {
      appNotOpen = true;
    }

    if (!closedByApp && appNotOpen && hc.docGet && hc.docSet) {
      const doc = await hc.docGet("herdr-app").catch(() => null);
      const val =
        doc?.value && typeof doc.value === "object" && !Array.isArray(doc.value)
          ? (doc.value as Record<string, unknown>)
          : null;
      const spaces = Array.isArray(val?.spaces) ? (val!.spaces as Array<Record<string, unknown>>) : null;
      if (val && spaces) {
        let docChanged = false;
        const removedTabIds = new Set<string>();
        let globalFallbackTabId: string | null = null;

        const nextSpaces = spaces.map((s) => {
          if (!s || typeof s !== "object" || s.machine) return s;
          const tabs = Array.isArray(s.tabs) ? (s.tabs as unknown[]) : null;
          if (!tabs) return s;

          let spaceChanged = false;
          let firstRemovedIdx = -1;
          const spaceRemovedTabIds = new Set<string>();
          let removedActiveFlag = false;
          const nextTabs: Array<Record<string, unknown>> = [];

          for (let i = 0; i < tabs.length; i++) {
            const tab = tabs[i];
            if (!tab || typeof tab !== "object") {
              continue;
            }
            const tRec = tab as Record<string, unknown>;
            const hasRoot = tRec.root !== undefined && tRec.root !== null;
            const hasTermsArray = Array.isArray(tRec.terminals);
            const prunedRoot = hasRoot ? pruneRootNode(tRec.root, doomed) : { node: tRec.root, changed: false };
            const nextTerms = hasTermsArray
              ? (tRec.terminals as unknown[]).filter((x) => {
                  const tid =
                    typeof (x as any)?.terminal === "string"
                      ? (x as any).terminal.trim()
                      : typeof (x as any)?.id === "string"
                        ? (x as any).id.trim()
                        : "";
                  return !(tid && doomed.has(tid));
                })
              : undefined;
            const termsChanged = Boolean(hasTermsArray && nextTerms!.length !== (tRec.terminals as unknown[]).length);
            const tabMatchesId = Boolean(tabId && tRec.id === tabId);
            const tabTouched = tabMatchesId || prunedRoot.changed || termsChanged;

            if (!tabTouched) {
              nextTabs.push(tRec);
              continue;
            }

            const rootEmpty = !hasRoot || prunedRoot.node === null;
            const termsEmpty = !hasTermsArray || nextTerms!.length === 0;
            if (rootEmpty && termsEmpty) {
              spaceChanged = true;
              docChanged = true;
              closedTab = true;
              if (firstRemovedIdx < 0) firstRemovedIdx = i;
              if (typeof tRec.id === "string") {
                spaceRemovedTabIds.add(tRec.id);
                removedTabIds.add(tRec.id);
              }
              if (tRec.active === true) removedActiveFlag = true;
              continue;
            }

            if (prunedRoot.changed || termsChanged) {
              spaceChanged = true;
              docChanged = true;
              const nextTab: Record<string, unknown> = { ...tRec };
              if (prunedRoot.changed) nextTab.root = prunedRoot.node;
              if (termsChanged) nextTab.terminals = nextTerms;
              nextTabs.push(nextTab);
            } else {
              nextTabs.push(tRec);
            }
          }

          if (!spaceChanged) return s;

          const fallbackTabIdx = nextTabs.length > 0 ? Math.min(Math.max(0, firstRemovedIdx), nextTabs.length - 1) : -1;
          const fallbackTab = fallbackTabIdx >= 0 ? nextTabs[fallbackTabIdx] : undefined;
          const fallbackTabId = typeof fallbackTab?.id === "string" ? fallbackTab.id : null;
          if (globalFallbackTabId === null && fallbackTabId !== null) globalFallbackTabId = fallbackTabId;

          const nextSpace: Record<string, unknown> = { ...s, tabs: nextTabs };
          if (typeof s.activeTabId === "string" && spaceRemovedTabIds.has(s.activeTabId)) {
            nextSpace.activeTabId = fallbackTabId;
          }
          if (removedActiveFlag && fallbackTab && !nextTabs.some((tb) => tb.active === true)) {
            nextTabs[fallbackTabIdx] = { ...fallbackTab, active: true };
          }
          return nextSpace;
        });

        if (docChanged) {
          const nextVal: Record<string, unknown> = { ...val, spaces: nextSpaces };
          if (typeof val.activeTabId === "string" && removedTabIds.has(val.activeTabId)) {
            nextVal.activeTabId = globalFallbackTabId;
          }
          await hc.docSet("herdr-app", nextVal, doc!.version);
        }
      }
    }

    // Clear space/tab labels FIRST so Herdr.app reconcile() cannot resurrect the closed tab.
    if (hc.label) {
      await Promise.all(
        [...doomed].map((addr) => hc.label!(addr, { "herdr.space": "", "herdr.tab": "", where: "" }).catch(() => {})),
      );
    }
    await Promise.all(
      [...doomed].map(async (addr) => {
        await hc.kill(addr).catch(() => {});
        await hc.rm?.(addr).catch(() => {});
      }),
    );

    return { closedTab, closedTerminals: doomed.size };
  }
}

const ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/**
 * Checks a `herdr.command` request against `HERDR_COMMANDS` and turns it into
 * the app's own arguments. Only listed commands and arguments pass; a program
 * is named by launcher id (`installed`), never by a command line.
 */
export function herdrCommandArgs(command: unknown, raw: unknown, installed: string[]): { command: HerdrCommand; args: Record<string, unknown> } {
  if (typeof command !== "string" || !Object.hasOwn(HERDR_COMMANDS, command)) throw new Error("不支持这个 herdr 命令");
  const cmd = command as HerdrCommand;
  const allowed: readonly string[] = HERDR_COMMANDS[cmd].args;
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (!allowed.includes(k)) throw new Error(`${cmd} 不接受参数 ${k}`);
    switch (k) {
      case "id":
      case "pane":
      case "terminal":
        if (typeof v !== "string" || !ID.test(v)) throw new Error(`${k} 要填 id`);
        out[k] = v;
        break;
      case "name":
        if (typeof v !== "string" || v.length > 60) throw new Error("名字要在 60 个字以内");
        out.name = v.trim();
        break;
      case "index": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error("index 要是从 1 开始的整数");
        out.index = n;
        break;
      }
      case "direction":
        if (v !== "right" && v !== "down") throw new Error("direction 只能是 right 或 down");
        out.direction = v;
        break;
      case "place":
        if (v !== "tab" && v !== "right" && v !== "down") throw new Error("place 只能是 tab、right 或 down");
        out.place = v;
        break;
      case "pinned":
        if (typeof v !== "boolean") throw new Error("pinned 要是 true 或 false");
        out.pinned = v;
        break;
      case "launcher": {
        const l = LAUNCHERS.find((x) => x.id === v);
        if (!l || !installed.includes(l.id)) throw new Error("这台电脑上没有这个程序");
        if (l.argv.length) out.argv = l.argv;
        break;
      }
    }
  }
  const optional = cmd === "pane.split" ? ["launcher"] : cmd === "terminal.keep" ? ["place"] : cmd === "pane.focus" ? ["pane", "terminal"] : [];
  for (const k of allowed) if (!optional.includes(k) && !(k in out)) throw new Error(`${cmd} 需要参数 ${k}`);
  if (cmd === "pane.focus" && !("pane" in out) && !("terminal" in out)) throw new Error("pane.focus 需要 pane 或 terminal");
  // The person already confirmed on the phone: no second question on the desktop.
  if (cmd === "space.close" || cmd === "tab.close") out.confirmed = true;
  return { command: cmd, args: out };
}

/** A resume command Uniflo gives is run only when it starts one of the known programs. */
export function resumeArgv(argv: unknown, installed: string[]): string[] {
  if (!Array.isArray(argv) || !argv.length || argv.length > 12 || !argv.every((a) => typeof a === "string" && a.length > 0 && a.length <= 300)) {
    throw new Error("这个会话没有可用的续跑命令");
  }
  const program = programName(base(argv[0] as string));
  const l = LAUNCHERS.find((x) => x.argv[0] === program);
  if (!l || !installed.includes(l.id)) throw new Error(`这台电脑上不能从手机启动 ${program}`);
  return [l.argv[0]!, ...(argv.slice(1) as string[])];
}

/** Runs `herdr-app do`; its answer (also an error) is JSON on stdout. */
function doCommand(bin: string, cmd: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, ["do", cmd, JSON.stringify(args)], { timeout: 20_000, encoding: "utf8", windowsHide: true }, (err, stdout, stderr) => {
      if (stdout.trim() || !err) return resolve(stdout);
      if (notInstalled(err)) return reject(new NoDesktopApp());
      const msg = String(stderr || err?.message || "").trim();
      reject(new Error(/no herdr window|no window|not running/i.test(msg) ? "桌面 herdr 没有打开，先在电脑上打开它" : `桌面 herdr：${msg.slice(0, 200)}`));
    });
  });
}

/** `herdr-app do` prints the command's JSON result (possibly after other lines). */
export function parseDoResult(out: string): { space: string; tab: string; terminal: string } {
  const lines = out.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const chunk = lines.slice(i).join("\n");
    try {
      const v = JSON.parse(chunk);
      if (v && typeof v.error === "string") throw new DoError(v.error);
      const r = v?.result ?? v;
      if (r && typeof r.terminal === "string") return { space: String(r.space ?? ""), tab: String(r.tab ?? ""), terminal: r.terminal };
    } catch (e) {
      if (e instanceof DoError) throw new Error(`桌面 herdr：${e.message}`);
      /* keep looking upward */
    }
  }
  throw new Error(`桌面 herdr 的回复看不懂：${out.trim().slice(0, 200)}`);
}

class DoError extends Error {}

/** Any command's answer: its JSON result (null when it printed nothing); an `error` answer throws. */
export function parseDo(out: string): unknown {
  const lines = out.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let v: unknown;
    try {
      v = JSON.parse(lines.slice(i).join("\n"));
    } catch {
      continue;
    }
    if (v && typeof v === "object") {
      const o = v as { error?: unknown; result?: unknown };
      if (typeof o.error === "string") throw new Error(`桌面 herdr：${o.error}`);
      if ("result" in o) return o.result;
    }
    return v;
  }
  return out.trim() ? out.trim().slice(0, 300) : null;
}
