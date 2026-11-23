import type { Agent } from "@herdr-pocket/protocol";
import { openFileTab } from "../shell/shellStore";
import { logAction } from "./log";

export interface ParsedFileTarget {
  path: string;
  title: string;
  absPath?: string;
  line?: number;
  endLine?: number;
}

const KNOWN_FILE_EXTS = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  "rs", "py", "go", "java", "kt", "kts", "swift",
  "c", "h", "cc", "cpp", "cxx", "hpp", "cs", "rb", "php", "lua",
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "md", "markdown", "mdx", "txt", "log", "csv", "tsv",
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "conf", "xml",
  "html", "htm", "css", "scss", "less", "sql", "vue", "svelte", "ets", "dart", "gradle",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg",
  "pdf", "doc", "docx", "rtf", "odt", "xls", "xlsx", "ods", "pptx", "lock", "diff", "patch",
  "ipa", "apk", "hap", "dmg", "pkg", "msi", "exe", "deb", "rpm", "appimage",
  "zip", "tar", "gz", "tgz", "xz", "zst", "7z", "rar", "wasm", "bin",
  "mp3", "wav", "m4a", "mp4", "mov", "webm",
]);

const KNOWN_BASENAMES = new Set([
  "dockerfile", "makefile", "cargo.toml", "cargo.lock", "package.json",
  "tsconfig.json", "cmakelists.txt", "readme", "license",
]);

const URL_SCHEME_RE = /^(?:https?|mailto|wss?|data|tel):/i;
const LINE_HASH_RE = /#L(\d+)(?:-L?(\d+))?$/i;
const LINE_COLON_RE = /:(\d+)(?::\d+)?$/;

function splitFileLineSuffixRaw(raw: string): { target: string; suffix: string; line?: number; endLine?: number } {
  let target = raw;
  const hashMatch = LINE_HASH_RE.exec(target);
  if (hashMatch) {
    target = target.slice(0, hashMatch.index);
    const line = Number(hashMatch[1]);
    const endLine = hashMatch[2] ? Number(hashMatch[2]) : undefined;
    return {
      target,
      suffix: hashMatch[0],
      line: Number.isFinite(line) && line > 0 ? line : undefined,
      endLine: endLine && Number.isFinite(endLine) && endLine >= line ? endLine : undefined,
    };
  }
  const colonMatch = LINE_COLON_RE.exec(target);
  if (colonMatch) {
    const prefix = target.slice(0, colonMatch.index);
    if (prefix && !/^[A-Za-z]$/.test(prefix)) {
      const line = Number(colonMatch[1]);
      return {
        target: prefix,
        suffix: colonMatch[0],
        line: Number.isFinite(line) && line > 0 ? line : undefined,
      };
    }
  }
  return { target, suffix: "" };
}

/** Splits optional `#L12` / `#L12-L20` / `:12[:4]` line suffix from a file token. */
export function splitFileLineSuffix(raw: string): { target: string; suffix: string; line?: number; endLine?: number } {
  return splitFileLineSuffixRaw(raw);
}

function stripLineSuffix(raw: string): { target: string; line?: number; endLine?: number } {
  const { target, line, endLine } = splitFileLineSuffixRaw(raw);
  return {
    target,
    ...(line !== undefined ? { line } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

function stripHomePrefix(p: string): string | null {
  if (p.startsWith("~/")) return p.slice(2);
  const m = /^\/(?:Users|home)\/[^/]+\/(.+)$/.exec(p);
  return m ? m[1]! : null;
}

export function looksLikeClickableFilePath(rawToken: string): boolean {
  const token = rawToken.trim().replace(/^[<("'`]+|[>)"'`.,;!?]+$/g, "");
  if (!token || /\s/.test(token) || URL_SCHEME_RE.test(token)) return false;
  if (/^file:\/\//i.test(token)) return true;

  const { target, line } = stripLineSuffix(token);
  const normalized = target.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized === "..") return false;

  const hasPathHint =
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.includes("/");
  const base = normalized.split("/").pop() ?? "";
  if (!base) return false;
  if (KNOWN_BASENAMES.has(base.toLowerCase())) return true;

  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return Boolean(hasPathHint && line);
  }
  const ext = base.slice(dot + 1).toLowerCase();
  return KNOWN_FILE_EXTS.has(ext) && (hasPathHint || Boolean(line) || ext !== "md" ? KNOWN_FILE_EXTS.has(ext) : true);
}

export function parseFileTarget(raw: string, cwd?: string): ParsedFileTarget | null {
  let clean = raw.trim().replace(/^[<("'`]+|[>)"'`]+$/g, "");
  if (!clean || URL_SCHEME_RE.test(clean)) return null;
  if (/^file:\/\//i.test(clean)) {
    clean = clean.slice("file://".length);
    if (clean.startsWith("localhost/")) clean = clean.slice("localhost".length);
    try {
      clean = decodeURIComponent(clean);
    } catch {
      // keep raw string if percent-encoding is malformed
    }
  }

  const { target, line, endLine } = stripLineSuffix(clean);
  const normTarget = target.replace(/\\/g, "/");
  if (!normTarget) return null;

  const normCwd = cwd?.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "";
  let path = normTarget;
  let absPath: string | undefined;

  if (normTarget.startsWith("/") || normTarget.startsWith("~/") || /^[A-Za-z]:\//.test(normTarget)) {
    absPath = normTarget;
    if (normCwd && normTarget.startsWith(`${normCwd}/`)) {
      path = normTarget.slice(normCwd.length + 1);
    } else if (normCwd) {
      const homeRelTarget = stripHomePrefix(normTarget);
      const homeRelCwd = stripHomePrefix(normCwd);
      if (homeRelTarget && homeRelCwd && homeRelTarget.startsWith(`${homeRelCwd}/`)) {
        path = homeRelTarget.slice(homeRelCwd.length + 1);
      }
    }
  } else {
    path = normTarget.replace(/^\.\//, "");
    if (normCwd && !path.startsWith("../")) {
      absPath = `${normCwd}/${path}`;
    }
  }

  const title = path.split("/").filter(Boolean).pop() || path;
  return {
    path,
    title,
    ...(absPath ? { absPath } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

export function openAgentFileTarget(agent: Pick<Agent, "key" | "cwd"> | undefined, raw: string): boolean {
  if (!agent) return false;
  const parsed = parseFileTarget(raw, agent.cwd);
  if (!parsed) return false;
  const ext = parsed.title.includes(".") ? parsed.title.split(".").pop()?.toLowerCase() ?? "" : "";
  if (typeof document !== "undefined" && !document.querySelector(".v3") && typeof window !== "undefined") {
    logAction("files", "files.open", {
      layout: "mobile",
      ext,
      hasLine: parsed.line !== undefined,
    });
    window.dispatchEvent(
      new CustomEvent("pocket:open-mobile-file", {
        detail: { agentKey: agent.key, path: parsed.path, title: parsed.title },
      }),
    );
    return true;
  }
  logAction("files", "files.open", {
    layout: "desktop",
    ext,
    hasLine: parsed.line !== undefined,
  });
  openFileTab(agent.key, parsed.path, parsed.title, {
    absPath: parsed.absPath,
    line: parsed.line,
    endLine: parsed.endLine,
  });
  return true;
}

/** Requires Ctrl (or Cmd on macOS) before clicking inline file links to jump. */
export function hasFileJumpModifier(ev: { ctrlKey?: boolean; metaKey?: boolean }): boolean {
  return Boolean(ev.ctrlKey || ev.metaKey);
}
