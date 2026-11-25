import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { PortalKind } from "@herdr-pocket/protocol";
import { stateDir } from "@herdr-pocket/update";

export interface HookOpenPayload {
  tool: string;
  argv: string[];
  cwd?: string;
  terminalId?: string;
  ppid?: number;
  kind?: PortalKind;
  target?: string;
  app?: string;
  reveal?: boolean;
}

export interface ParsedOpenInvocation {
  kind: PortalKind;
  target: string;
  reveal: boolean;
  app?: string;
  url?: string;
}

export type AutoPortalIntent =
  | {
      type: "opener";
      kind: PortalKind;
      target?: string;
      url?: string;
      reveal: boolean;
      app?: string;
    }
  | {
      type: "app_window";
      appHint: string;
      label: string;
      url?: string;
    };

export function classifyTarget(rawTarget: string, opts: { reveal?: boolean; isDir?: boolean; cwd?: string } = {}): ParsedOpenInvocation {
  let target = rawTarget.trim().replace(/^["']|["']$/g, "");
  if (opts.reveal) {
    const resolved = !/^https?:/i.test(target) && opts.cwd && !isAbsolute(target) ? resolve(opts.cwd, target) : target;
    return { kind: "reveal", target: resolved, reveal: true };
  }
  if (/^https?:\/\//i.test(target)) {
    return { kind: "browser", target, url: target, reveal: false };
  }
  if (/^file:\/\//i.test(target)) {
    target = decodeURIComponent(target.replace(/^file:\/+(?:localhost\/)?/i, process.platform === "win32" ? "" : "/"));
  }
  if (target === "~" || target.startsWith("~/") || target.startsWith("~\\")) {
    target = join(homedir(), target.slice(2));
  }
  const abs = opts.cwd && !isAbsolute(target) ? resolve(opts.cwd, target) : target;
  if (opts.isDir) {
    return { kind: "reveal", target: abs, reveal: false };
  }
  if (/\.html?$/i.test(abs)) {
    return { kind: "html", target: abs, reveal: false };
  }
  return { kind: "file", target: abs, reveal: false };
}

export function parseOpenerArgs(tool: string, argv: string[], cwd?: string): ParsedOpenInvocation | null {
  const cleanTool = tool.toLowerCase().replace(/\.(exe|cmd|bat|sh)$/i, "");
  let reveal = false;
  let app: string | undefined;
  let rest = [...argv];

  if (cleanTool === "gio") {
    if (rest[0] !== "open") return null;
    rest = rest.slice(1);
  }

  if (cleanTool === "qlmanage") {
    const pIdx = rest.indexOf("-p");
    const targetArg = pIdx >= 0 ? rest[pIdx + 1] : rest.find((a) => !a.startsWith("-"));
    return targetArg ? classifyTarget(targetArg, { reveal: false, cwd }) : null;
  }

  if (cleanTool === "start") {
    let rawStart = "";
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i]!;
      if (/^\/d$/i.test(a)) {
        i += 1;
        continue;
      }
      if (a.startsWith("/")) continue;
      positional.push(a);
    }
    if (positional.length === 0) return null;
    if (
      positional.length >= 2 &&
      (positional[0] === "" ||
        (!/^https?:/i.test(positional[0]!) && !/[\\/.]/.test(positional[0]!)))
    ) {
      rawStart = positional[1]!;
    } else {
      rawStart = positional[0]!;
    }
    if (!rawStart) return null;
    if (/^(?:chrome|msedge|firefox|explorer|notepad)$/i.test(rawStart) && positional.length >= 2) {
      const idx = positional.indexOf(rawStart);
      const nextTarget = positional[idx + 1];
      if (nextTarget) {
        const p = classifyTarget(nextTarget, { reveal: false, cwd });
        return { ...p, app: rawStart };
      }
      return { kind: "window", target: rawStart, reveal: false, app: rawStart };
    }
    return classifyTarget(rawStart, { reveal: false, cwd });
  }

  if (cleanTool === "start-process" || cleanTool === "saps" || cleanTool === "invoke-item" || cleanTool === "ii") {
    let target = "";
    let argList = "";
    for (let i = 0; i < rest.length; i += 1) {
      const a = rest[i]!;
      const low = a.toLowerCase();
      if (low === "-filepath" || low === "-path" || low === "-literalpath") {
        target = rest[++i] ?? "";
        continue;
      }
      if (low === "-argumentlist" || low === "-args") {
        argList = rest[++i] ?? "";
        continue;
      }
      if (a.startsWith("-")) continue;
      if (!target) target = a;
    }
    if (!target) return null;
    const urlMatch = /(https?:\/\/[^\s"'`<>]+)/i.exec(argList);
    if (urlMatch?.[1]) {
      return { kind: "browser", target: urlMatch[1], url: urlMatch[1], reveal: false, app: target };
    }
    if (
      (cleanTool === "start-process" || cleanTool === "saps") &&
      !/[\\/.]/.test(target)
    ) {
      return { kind: "window", target, reveal: false, app: target };
    }
    return classifyTarget(target, { reveal: false, cwd });
  }

  let rawTarget = "";
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (cleanTool === "open") {
      if (a === "-R") {
        reveal = true;
        continue;
      }
      if (a === "-a" || a === "-b") {
        app = rest[++i];
        continue;
      }
      if (a === "--args") break;
      if (a.startsWith("-")) continue;
      rawTarget = a;
      break;
    }
    if (cleanTool === "explorer" || cleanTool === "explorer.exe") {
      if (/^\/select,/i.test(a)) {
        reveal = true;
        rawTarget = a.slice("/select,".length).replace(/^["']|["']$/g, "");
        break;
      }
      if (a.startsWith("/")) continue;
      rawTarget = a;
      break;
    }
    if (a.startsWith("-")) continue;
    rawTarget = a;
    break;
  }

  if (!rawTarget) {
    if (app && (cleanTool === "open" || cleanTool === "herdr-pocket-open")) {
      return { kind: "window", target: app, reveal: false, app };
    }
    return null;
  }
  const parsed = classifyTarget(rawTarget, { reveal, cwd });
  return app ? { ...parsed, app } : parsed;
}

interface ShellSegment {
  tokens: string[];
  heredocBody: string;
}

function tokenizeSegmentText(seg: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inTok = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < seg.length; i += 1) {
    const ch = seg[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        const next = seg[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          cur += next;
          i += 1;
          continue;
        }
      }
      if (ch === '"') quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < seg.length) {
      inTok = true;
      cur += seg[i + 1]!;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inTok = true;
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inTok) {
        tokens.push(cur);
        cur = "";
        inTok = false;
      }
      continue;
    }
    if (ch === "#") break;
    inTok = true;
    cur += ch;
  }
  if (inTok) tokens.push(cur);
  return tokens;
}

function splitTopLevelShellSegments(commandLine: string): ShellSegment[] {
  const lines = commandLine.replace(/\r\n?/g, "\n").split("\n");
  const out: ShellSegment[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }

    // Extract heredoc delimiters on this line (e.g. `<<'EOF'`, `<<EOF`, `<<-EOF`).
    const heredocSpecs: Array<{ delim: string; stripTabs: boolean }> = [];
    {
      let quote: "'" | '"' | null = null;
      for (let j = 0; j < line.length; j += 1) {
        const ch = line[j]!;
        if (quote === "'") {
          if (ch === "'") quote = null;
          continue;
        }
        if (quote === '"') {
          if (ch === "\\") j += 1;
          else if (ch === '"') quote = null;
          continue;
        }
        if (ch === "\\") {
          j += 1;
          continue;
        }
        if (ch === "'" || ch === '"') {
          quote = ch;
          continue;
        }
        if (ch === "<" && line[j + 1] === "<" && line[j + 2] !== "<") {
          const m = /^<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_-]*))/.exec(line.slice(j));
          if (m) {
            const delim = m[2] ?? m[3] ?? m[4] ?? "";
            if (delim) heredocSpecs.push({ delim, stripTabs: m[1] === "-" });
            j += m[0].length - 1;
          }
        }
      }
    }

    // Split line by unquoted `;`, `&&`, `||`, `&`, `|`.
    const parts: string[] = [];
    let start = 0;
    let quote: "'" | '"' | null = null;
    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j]!;
      if (quote === "'") {
        if (ch === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        if (ch === "\\") j += 1;
        else if (ch === '"') quote = null;
        continue;
      }
      if (ch === "\\") {
        j += 1;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === "#") {
        parts.push(line.slice(start, j));
        start = line.length;
        break;
      }
      if ((ch === "&" && line[j + 1] === "&") || (ch === "|" && line[j + 1] === "|")) {
        parts.push(line.slice(start, j));
        j += 1;
        start = j + 1;
        continue;
      }
      if (ch === ";" || ch === "|" || ch === "&") {
        parts.push(line.slice(start, j));
        start = j + 1;
      }
    }
    if (start <= line.length) parts.push(line.slice(start));

    let heredocBody = "";
    i += 1;
    for (const spec of heredocSpecs) {
      const bodyLines: string[] = [];
      while (i < lines.length) {
        const nextLine = lines[i]!;
        const cmp = spec.stripTabs ? nextLine.replace(/^\t+/, "") : nextLine;
        i += 1;
        if (cmp === spec.delim) break;
        bodyLines.push(nextLine);
      }
      if (bodyLines.length) heredocBody += `${heredocBody ? "\n" : ""}${bodyLines.join("\n")}`;
    }

    const nonEmptyParts = parts.map((p) => tokenizeSegmentText(p)).filter((t) => t.length > 0);
    for (let k = 0; k < nonEmptyParts.length; k += 1) {
      out.push({
        tokens: nonEmptyParts[k]!,
        heredocBody: k === nonEmptyParts.length - 1 ? heredocBody : "",
      });
    }
  }
  return out;
}

function unwrapCommandPrefix(tokens: string[]): { cmd: string; rest: string[] } | null {
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) {
    idx += 1;
  }
  while (idx < tokens.length) {
    const head = tokens[idx]!;
    const base = head.split("/").pop()?.toLowerCase() ?? head.toLowerCase();
    if (base === "sudo") {
      idx += 1;
      while (idx < tokens.length && tokens[idx]!.startsWith("-")) {
        if (tokens[idx] === "-u" || tokens[idx] === "-g") idx += 2;
        else idx += 1;
      }
      continue;
    }
    if (base === "nohup" || base === "env") {
      idx += 1;
      while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx += 1;
      continue;
    }
    if (base === "command") {
      idx += 1;
      while (idx < tokens.length && tokens[idx]!.startsWith("-")) {
        if (tokens[idx] === "-v" || tokens[idx] === "-V") return null;
        idx += 1;
      }
      continue;
    }
    if ((base === "cmd" || base === "cmd.exe") && (tokens[idx + 1] === "/c" || tokens[idx + 1] === "/k")) {
      idx += 2;
      continue;
    }
    return { cmd: base, rest: tokens.slice(idx + 1) };
  }
  return null;
}

const OPENER_TOOLS = new Set([
  "open",
  "xdg-open",
  "gio",
  "sensible-browser",
  "wslview",
  "herdr-pocket-open",
  "herdr-pocket-browser",
  "explorer",
  "explorer.exe",
  "start",
  "start-process",
  "saps",
  "invoke-item",
  "ii",
  "qlmanage",
]);

const GUI_BINARY_MAP: Record<string, { appHint: string; label: string }> = {
  "google-chrome": { appHint: "Chrome", label: "Chrome" },
  "google-chrome-stable": { appHint: "Chrome", label: "Chrome" },
  chromium: { appHint: "Chromium", label: "Chromium" },
  "chromium-browser": { appHint: "Chromium", label: "Chromium" },
  firefox: { appHint: "Firefox", label: "Firefox" },
  msedge: { appHint: "Microsoft Edge", label: "Microsoft Edge" },
  "msedge.exe": { appHint: "Microsoft Edge", label: "Microsoft Edge" },
  "brave-browser": { appHint: "Brave", label: "Brave" },
  safari: { appHint: "Safari", label: "Safari" },
  xeyes: { appHint: "xeyes", label: "X11 xeyes" },
  xclock: { appHint: "xclock", label: "X11 xclock" },
  xcalc: { appHint: "xcalc", label: "X11 xcalc" },
  feh: { appHint: "feh", label: "feh 图片查看" },
  sxiv: { appHint: "sxiv", label: "sxiv 图片查看" },
  imv: { appHint: "imv", label: "imv 图片查看" },
  mpv: { appHint: "mpv", label: "mpv 播放器" },
  ffplay: { appHint: "ffplay", label: "ffplay" },
  vlc: { appHint: "VLC", label: "VLC" },
  evince: { appHint: "evince", label: "文档预览" },
  zathura: { appHint: "zathura", label: "文档预览" },
  gedit: { appHint: "gedit", label: "gedit" },
  nautilus: { appHint: "nautilus", label: "文件管理器" },
  dolphin: { appHint: "dolphin", label: "文件管理器" },
  thunar: { appHint: "thunar", label: "文件管理器" },
  notepad: { appHint: "notepad", label: "记事本" },
  "notepad.exe": { appHint: "notepad", label: "记事本" },
  mspaint: { appHint: "mspaint", label: "画图" },
  "mspaint.exe": { appHint: "mspaint", label: "画图" },
};

function expandTildePath(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return raw;
}

/** Extracts file/browser/window auto-portal intents from shell commands while ignoring quoted prose. */
export function extractAutoPortalIntents(commandLine: string, cwd?: string): AutoPortalIntent[] {
  if (!commandLine || !commandLine.trim()) return [];
  const segments = splitTopLevelShellSegments(commandLine);
  const intents: AutoPortalIntent[] = [];
  let effectiveCwd = cwd?.trim() || undefined;

  for (const seg of segments) {
    const unwrapped = unwrapCommandPrefix(seg.tokens);
    if (!unwrapped) continue;
    const { cmd, rest } = unwrapped;

    if (cmd === "cd" && rest[0] && !rest[0].startsWith("-")) {
      const targetDir = expandTildePath(rest[0]);
      effectiveCwd = effectiveCwd && !isAbsolute(targetDir) ? resolve(effectiveCwd, targetDir) : targetDir;
      continue;
    }

    if (cmd === "wsl" || cmd === "wsl.exe") {
      let i = 0;
      let innerCwd = effectiveCwd;
      while (i < rest.length && rest[i]!.startsWith("-")) {
        const f = rest[i]!;
        if (f === "-d" || f === "--distribution" || f === "-u" || f === "--user" || f === "--shell-type") {
          i += 2;
          continue;
        }
        if (f === "--cd" && rest[i + 1]) {
          innerCwd = rest[i + 1];
          i += 2;
          continue;
        }
        if (f === "-e" || f === "--exec" || f === "--") {
          i += 1;
          break;
        }
        i += 1;
      }
      const wslTail = rest.slice(i);
      const tailHead = wslTail[0]?.split("/").pop()?.toLowerCase();
      if ((tailHead === "bash" || tailHead === "sh" || tailHead === "zsh") && (wslTail[1] === "-c" || wslTail[1] === "-lc") && wslTail[2]) {
        const inner = extractAutoPortalIntents(wslTail[2], innerCwd);
        intents.push(...inner);
      } else if (wslTail.length > 0) {
        const joined = wslTail.map((t) => (/\s/.test(t) ? JSON.stringify(t) : t)).join(" ");
        const inner = extractAutoPortalIntents(joined, innerCwd);
        if (inner.length > 0) {
          intents.push(...inner);
        } else {
          intents.push({ type: "app_window", appHint: "x11", label: "Linux X11 窗口" });
        }
      }
      continue;
    }

    if (OPENER_TOOLS.has(cmd)) {
      const parsed = parseOpenerArgs(cmd, rest, effectiveCwd);
      if (!parsed) continue;
      if (parsed.kind === "window" && parsed.app) {
        intents.push({
          type: "app_window",
          appHint: parsed.app,
          label: parsed.app,
        });
      } else {
        intents.push({
          type: "opener",
          kind: parsed.kind,
          target: parsed.target,
          ...(parsed.url ? { url: parsed.url } : {}),
          reveal: parsed.reveal,
          ...(parsed.app ? { app: parsed.app } : {}),
        });
      }
      continue;
    }

    const guiInfo = GUI_BINARY_MAP[cmd];
    if (guiInfo) {
      const scanText = rest.join(" ");
      const urlMatch = /(https?:\/\/[^\s"'`<>()\\;]+)/i.exec(scanText);
      intents.push({
        type: "app_window",
        appHint: guiInfo.appHint,
        label: guiInfo.label,
        ...(urlMatch?.[1] ? { url: urlMatch[1] } : {}),
      });
      continue;
    }

    if (cmd === "ego-browser" || cmd === "tabbit" || cmd === "agent-browser") {
      const nonFlag = rest.find((t) => !t.startsWith("-"))?.toLowerCase();
      if (
        rest.some((t) => t === "--help" || t === "-h" || t === "--version" || t === "-v") ||
        (nonFlag && (nonFlag === "skill" || nonFlag === "help" || nonFlag === "upgrade" || nonFlag === "import"))
      ) {
        continue;
      }
      const scanText = `${rest.join(" ")}\n${seg.heredocBody}`;
      const urlMatch = /(https?:\/\/[^\s"'`<>()\\;]+)/i.exec(scanText);
      const url = urlMatch?.[1];
      if (cmd === "ego-browser") {
        const spaceMatch = /taskSpace\(\s*["']([^"'\n]{1,60})["']/.exec(scanText);
        intents.push({
          type: "app_window",
          appHint: "ego lite",
          label: spaceMatch?.[1] ? `ego lite · ${spaceMatch[1]}` : "ego lite 浏览器",
          ...(url ? { url } : {}),
        });
      } else if (cmd === "tabbit") {
        intents.push({
          type: "app_window",
          appHint: "Tabbit",
          label: "Tabbit 浏览器",
          ...(url ? { url } : {}),
        });
      } else {
        intents.push({
          type: "app_window",
          appHint: "Chrome",
          label: "Agent 浏览器",
          ...(url ? { url } : {}),
        });
      }
    }
  }

  return intents;
}

const ANSI_STRIP_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bO[\s\S]?|\x1b[\s\S]?/g;

/** Reconstructs submitted shell command lines from raw PTY keystrokes/pastes per agent terminal. */
export class TerminalInputLineTracker {
  private buffers = new Map<string, { chars: string[]; lastHadCr: boolean }>();

  feed(agentKey: string, rawData: string): string[] {
    if (!rawData) return [];
    let entry = this.buffers.get(agentKey);
    if (!entry) {
      entry = { chars: [], lastHadCr: false };
      this.buffers.set(agentKey, entry);
    }

    const cleaned = rawData.replace(ANSI_STRIP_RE, "");
    const submitted: string[] = [];

    for (const ch of cleaned) {
      if (ch === "\r") {
        const line = entry.chars.join("").trim();
        entry.chars.length = 0;
        entry.lastHadCr = true;
        if (line) submitted.push(line);
        continue;
      }
      if (ch === "\n") {
        if (entry.lastHadCr) {
          entry.lastHadCr = false;
          continue;
        }
        const line = entry.chars.join("").trim();
        entry.chars.length = 0;
        if (line) submitted.push(line);
        continue;
      }
      entry.lastHadCr = false;
      if (ch === "\x03" || ch === "\x15") {
        entry.chars.length = 0;
        continue;
      }
      if (ch === "\x7f" || ch === "\x08") {
        entry.chars.pop();
        continue;
      }
      if (ch === "\x17") {
        while (entry.chars.length && entry.chars[entry.chars.length - 1] === " ") entry.chars.pop();
        while (entry.chars.length && entry.chars[entry.chars.length - 1] !== " ") entry.chars.pop();
        continue;
      }
      if (ch === "\t") {
        if (entry.chars.length < 4096) entry.chars.push(" ");
        continue;
      }
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20) continue;
      if (entry.chars.length < 4096) entry.chars.push(ch);
    }

    if (this.buffers.size > 64) {
      const oldest = this.buffers.keys().next().value;
      if (oldest && oldest !== agentKey) this.buffers.delete(oldest);
    }
    return submitted;
  }

  clear(agentKey: string): void {
    this.buffers.delete(agentKey);
  }
}

export function hookFilePath(dir = stateDir()): string {
  return join(dir, "portal-hook.json");
}

export function shimsDirPath(dir = stateDir()): string {
  return join(dir, "portal-shims");
}

export function readHookConfig(dir = stateDir()): { port: number; secret: string } | null {
  try {
    const raw = JSON.parse(readFileSync(hookFilePath(dir), "utf8")) as { port?: number; secret?: string };
    if (typeof raw.port === "number" && typeof raw.secret === "string" && raw.port > 0 && raw.secret) {
      return { port: raw.port, secret: raw.secret };
    }
  } catch {
    // not running
  }
  return null;
}

const SHIM_RUNNER_JS = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const tool = process.argv[2] || "open";
const args = process.argv.slice(3);
const stateDir = process.env.HERDR_POCKET_STATE || path.dirname(path.dirname(__filename));
const hookPath = path.join(stateDir, "portal-hook.json");

function fallbackReal() {
  if (tool === "herdr-pocket-browser") process.exit(0);
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const selfDir = path.dirname(__filename);
  const candidates = dirs.filter((d) => path.resolve(d) !== path.resolve(selfDir));
  const defaults = process.platform === "darwin" ? ["/usr/bin"] : ["/usr/bin", "/bin"];
  for (const d of [...candidates, ...defaults]) {
    const bin = path.join(d, tool);
    if (fs.existsSync(bin)) {
      const r = spawnSync(bin, args, { stdio: "inherit" });
      process.exit(r.status ?? 0);
    }
  }
  process.exit(0);
}

(async () => {
  try {
    const hook = JSON.parse(fs.readFileSync(hookPath, "utf8"));
    const res = await fetch(\`http://127.0.0.1:\${hook.port}/open\`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-portal-secret": hook.secret },
      body: JSON.stringify({
        tool,
        argv: args,
        cwd: process.cwd(),
        terminalId: process.env.HERDR_POCKET_TERMINAL || undefined,
        ppid: process.ppid,
      }),
      signal: AbortSignal.timeout(1500),
    });
    const j = await res.json();
    if (j && j.handled) process.exit(0);
  } catch {}
  fallbackReal();
})();
`;

export function ensurePortalShims(dir = stateDir()): { shimsDir: string; browserShim: string; execWrapper?: string } {
  const shimsDir = shimsDirPath(dir);
  mkdirSync(shimsDir, { recursive: true });
  const runner = join(shimsDir, "portal-open.cjs");
  writeFileSync(runner, SHIM_RUNNER_JS, { mode: 0o755 });
  chmodSync(runner, 0o755);

  const nodeBin = process.execPath;
  const tools = ["open", "xdg-open", "gio", "sensible-browser", "wslview", "herdr-pocket-open", "herdr-pocket-browser"];
  if (process.platform === "win32") {
    for (const t of tools) {
      const cmd = join(shimsDir, `${t}.cmd`);
      writeFileSync(cmd, `@echo off\r\n"${nodeBin}" "${runner}" ${t} %*\r\n`);
    }
    return { shimsDir, browserShim: join(shimsDir, "herdr-pocket-browser.cmd") };
  }

  for (const t of tools) {
    const sh = join(shimsDir, t);
    writeFileSync(sh, `#!/bin/sh\nexec "${nodeBin}" "${runner}" ${t} "$@"\n`, { mode: 0o755 });
    chmodSync(sh, 0o755);
  }
  const browserShim = join(shimsDir, "herdr-pocket-browser");
  const execWrapper = join(shimsDir, "herdr-pocket-exec");
  writeFileSync(
    execWrapper,
    `#!/bin/sh\nexport PATH="${shimsDir}:$PATH"\nexport BROWSER="${browserShim}"\nexport HERDR_POCKET_STATE="${dir}"\nexec "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(execWrapper, 0o755);
  return { shimsDir, browserShim, execWrapper };
}

export class PortalHookServer {
  private server: Server | null = null;
  private dir: string;
  private secret: string;
  private onOpen: (payload: HookOpenPayload) => Promise<{ handled: boolean; id?: string }>;
  port = 0;

  constructor(opts: {
    dir?: string;
    secret: string;
    onOpen: (payload: HookOpenPayload) => Promise<{ handled: boolean; id?: string }>;
  }) {
    this.dir = opts.dir ?? stateDir();
    this.secret = opts.secret;
    this.onOpen = opts.onOpen;
  }

  async start(): Promise<number> {
    mkdirSync(this.dir, { recursive: true });
    const srv = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/open") {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (req.headers["x-portal-secret"] !== this.secret) {
        res.statusCode = 401;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let payload: HookOpenPayload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookOpenPayload;
        } catch {
          res.statusCode = 400;
          res.end();
          return;
        }
        void this.onOpen(payload)
          .then((result) => {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(result));
          })
          .catch(() => {
            res.statusCode = 500;
            res.end();
          });
      });
    });

    const port = await new Promise<number>((resolvePort, reject) => {
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as { port: number } | null;
        resolvePort(addr?.port ?? 0);
      });
    });
    this.server = srv;
    this.port = port;
    writeFileSync(hookFilePath(this.dir), JSON.stringify({ port, secret: this.secret, pid: process.pid }), { mode: 0o600 });
    return port;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    rmSync(hookFilePath(this.dir), { force: true });
  }
}
