import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { SlashCommandItem } from "@herdr-pocket/protocol";

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { at: number; commands: SlashCommandItem[] }>();

interface ScanDirSpec {
  dir: string;
  source: "project" | "user";
  category: "skill" | "custom";
  mode: "markdown-cmd" | "skill-folder" | "toml-cmd";
  prefix?: string;
}

function normalizeHarness(harness: string): string {
  const h = harness.trim().toLowerCase();
  if (h.includes("claude")) return "claude";
  if (h.includes("codex")) return "codex";
  if (h.includes("antigravity") || h === "agy") return "antigravity";
  if (h.includes("gemini")) return "gemini";
  if (h.includes("deepseek") || h === "dsh") return "dsh";
  if (h === "omp" || h.includes("oh-my-pi")) return "omp";
  if (h === "pi" || h.includes("pi-mono")) return "pi";
  if (h.includes("opencode")) return "opencode";
  if (h.includes("kilo")) return "kilo";
  if (h.includes("qoder")) return "qoder";
  if (h.includes("qwen")) return "qwen";
  if (h.includes("cursor")) return "cursor";
  if (h.includes("cline")) return "cline";
  if (h.includes("roo")) return "roo";
  if (h.includes("kodu")) return "kodu";
  if (h.includes("kiro")) return "kiro";
  if (h.includes("kimi")) return "kimi";
  if (h.includes("hermes")) return "hermes";
  if (h.includes("grok")) return "grok";
  if (h.includes("mimocode") || h === "mimo") return "mimocode";
  if (h.includes("minimax")) return "minimax";
  if (h.includes("codebuddy") || h === "cbc") return "codebuddy";
  if (h.includes("workbuddy")) return "workbuddy";
  if (h.includes("zcode")) return "zcode";
  if (h.includes("reasonix")) return "reasonix";
  if (h.includes("commandcode")) return "commandcode";
  if (h.includes("copilot")) return "copilot";
  if (h.includes("prime")) return "prime";
  if (h.includes("crosery")) return "crosery";
  if (h.includes("factory") || h === "droid") return "factory";
  return h;
}

function parseMarkdownDescription(raw: string): { description: string; argHint?: string } {
  const lines = raw.split(/\r?\n/);
  let description = "";
  let argHint: string | undefined;
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i]!.trim() !== "---") {
      const m = /^([a-zA-Z0-9_-]+)\s*:\s*(.+)$/.exec(lines[i]!);
      if (m) {
        const key = m[1]!.toLowerCase();
        const val = m[2]!.trim().replace(/^["']|["']$/g, "");
        if (key === "description" && val) description = val;
        else if ((key === "argument-hint" || key === "arghint") && val) argHint = val;
      }
      i++;
    }
    if (i < lines.length && lines[i]!.trim() === "---") i++;
  }
  if (!description) {
    for (; i < lines.length; i++) {
      const l = lines[i]!.trim().replace(/^#+\s*/, "");
      if (l && !l.startsWith("<!--") && !l.startsWith("---")) {
        description = l;
        break;
      }
    }
  }
  if (description.length > 90) description = `${description.slice(0, 89)}…`;
  return { description: description || "自定义命令 / 技能", ...(argHint ? { argHint } : {}) };
}

function parseTomlDescription(raw: string): string {
  const m = /^\s*description\s*=\s*["']([^"'\n]+)["']/m.exec(raw);
  const d = m?.[1]?.trim() || "自定义 TOML 斜杠命令";
  return d.length > 90 ? `${d.slice(0, 89)}…` : d;
}

async function walkMarkdownFiles(dir: string, relParts: string[] = [], maxFiles = 80): Promise<Array<{ rel: string; full: string }>> {
  const out: Array<{ rel: string; full: string }> = [];
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    if (out.length >= maxFiles) break;
    if (d.name.startsWith(".")) continue;
    const full = join(dir, d.name);
    if (d.isDirectory()) {
      const nested = await walkMarkdownFiles(full, [...relParts, d.name], maxFiles - out.length);
      out.push(...nested);
    } else if (d.isFile() && /\.(md|markdown)$/i.test(d.name)) {
      const stem = d.name.slice(0, -extname(d.name).length);
      const rel = [...relParts, stem].join(":");
      out.push({ rel, full });
    }
  }
  return out;
}

async function walkSkillFolders(
  dir: string,
  depth = 1,
  maxDepth = 2,
  limit = 100,
): Promise<Array<{ name: string; skillFile: string }>> {
  const out: Array<{ name: string; skillFile: string }> = [];
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    if (out.length >= limit) break;
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    if (d.name.startsWith(".")) continue;
    const sub = join(dir, d.name);
    const directSkill = join(sub, "SKILL.md");
    if (existsSync(directSkill)) {
      out.push({ name: d.name, skillFile: directSkill });
      continue;
    }
    if (depth < maxDepth) {
      const nested = await walkSkillFolders(sub, depth + 1, maxDepth, limit - out.length);
      out.push(...nested);
    }
  }
  return out;
}

async function scanSpec(spec: ScanDirSpec): Promise<SlashCommandItem[]> {
  if (!existsSync(spec.dir)) return [];
  const out: SlashCommandItem[] = [];
  if (spec.mode === "markdown-cmd") {
    const files = await walkMarkdownFiles(spec.dir);
    for (const f of files) {
      const content = await readFile(f.full, "utf8").catch(() => "");
      const meta = parseMarkdownDescription(content);
      const name = `/${spec.prefix ? `${spec.prefix}:` : ""}${f.rel}`;
      out.push({
        name,
        description: meta.description,
        ...(meta.argHint ? { argHint: meta.argHint } : {}),
        category: spec.category,
        source: spec.source,
      });
    }
  } else if (spec.mode === "skill-folder") {
    const skills = await walkSkillFolders(spec.dir);
    for (const s of skills) {
      const content = await readFile(s.skillFile, "utf8").catch(() => "");
      const meta = parseMarkdownDescription(content);
      out.push({
        name: `/${s.name}`,
        description: meta.description,
        ...(meta.argHint ? { argHint: meta.argHint } : {}),
        category: "skill",
        source: spec.source,
      });
    }
  } else if (spec.mode === "toml-cmd") {
    let dirents;
    try {
      dirents = await readdir(spec.dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const d of dirents.slice(0, 60)) {
      if (!d.isFile() || !d.name.endsWith(".toml")) continue;
      const full = join(spec.dir, d.name);
      const content = await readFile(full, "utf8").catch(() => "");
      const stem = basename(d.name, ".toml");
      out.push({
        name: `/${stem}`,
        description: parseTomlDescription(content),
        category: spec.category,
        source: spec.source,
      });
    }
  }
  return out;
}

/**
 * Scans workspace and user custom `/` commands & skills for a given harness.
 * Returns normalized slash commands deduplicated by `name`.
 */
export async function scanAgentSlashCommands(harness: string, cwd?: string, homeDir = homedir()): Promise<SlashCommandItem[]> {
  const norm = normalizeHarness(harness);
  const cacheKey = `${norm}\0${cwd ?? ""}\0${homeDir}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.commands;

  const specs: ScanDirSpec[] = [];
  const addProj = (relDir: string, mode: ScanDirSpec["mode"], category: ScanDirSpec["category"]) => {
    if (cwd) specs.push({ dir: join(cwd, relDir), source: "project", mode, category });
  };
  const addHome = (relDir: string, mode: ScanDirSpec["mode"], category: ScanDirSpec["category"]) => {
    specs.push({ dir: join(homeDir, relDir), source: "user", mode, category });
  };

  if (norm === "claude") {
    addProj(".claude/commands", "markdown-cmd", "custom");
    addProj(".claude/skills", "skill-folder", "skill");
    addHome(".claude/commands", "markdown-cmd", "custom");
    addHome(".claude/skills", "skill-folder", "skill");
  } else if (norm === "codex") {
    addProj(".codex/prompts", "markdown-cmd", "custom");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".codex/prompts", "markdown-cmd", "custom");
    addHome(".agents/skills", "skill-folder", "skill");
  } else if (norm === "antigravity" || norm === "gemini") {
    addProj(".gemini/commands", "toml-cmd", "custom");
    addProj(".agent/workflows", "markdown-cmd", "skill");
    addProj(".agents/workflows", "markdown-cmd", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".gemini/commands", "toml-cmd", "custom");
    addHome(".gemini/antigravity/global_workflows", "markdown-cmd", "skill");
    addHome(".gemini/antigravity-cli/skills", "skill-folder", "skill");
    addHome(".gemini/antigravity-cli/builtin/skills", "skill-folder", "skill");
    addHome(".gemini/skills", "skill-folder", "skill");
    addHome(".gemini/config/skills", "skill-folder", "skill");
  } else if (norm === "omp") {
    addProj(".omp/commands", "markdown-cmd", "custom");
    addProj(".omp/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".omp/commands", "markdown-cmd", "custom");
    addHome(".omp/agent/skills", "skill-folder", "skill");
    addHome(".omp/agent/managed-skills", "skill-folder", "skill");
    addHome(".omp/agent/skills-upstream", "skill-folder", "skill");
    addHome(".agents/skills", "skill-folder", "skill");
  } else if (norm === "pi") {
    addProj(".pi/prompts", "markdown-cmd", "custom");
    addProj(".pi/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".pi/prompts", "markdown-cmd", "custom");
    addHome(".pi/agent/prompts", "markdown-cmd", "custom");
    addHome(".pi/agent/skills", "skill-folder", "skill");
    addHome(".pi/agent/pi-hermes-memory/skills", "skill-folder", "skill");
  } else if (norm === "dsh") {
    addProj(".dsh/commands", "markdown-cmd", "custom");
    addProj(".dsh/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".dsh/commands", "markdown-cmd", "custom");
    addHome(".dsh/skills", "skill-folder", "skill");
  } else if (norm === "hermes") {
    addProj(".hermes/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".hermes/skills", "skill-folder", "skill");
    addHome(".hermes/hermes-agent/skills", "skill-folder", "skill");
  } else if (norm === "grok") {
    addProj(".grok/commands", "markdown-cmd", "custom");
    addProj(".grok/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".grok/commands", "markdown-cmd", "custom");
    addHome(".grok/skills", "skill-folder", "skill");
    addHome(".grok/bundled/skills", "skill-folder", "skill");
  } else if (norm === "mimocode") {
    addProj(".mimocode/commands", "markdown-cmd", "custom");
    addProj(".mimocode/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".mimocode/skills", "skill-folder", "skill");
    addHome(".local/share/mimocode/skills", "skill-folder", "skill");
    addHome(".local/share/mimocode/builtin_skills", "skill-folder", "skill");
  } else if (norm === "minimax") {
    addProj(".minimax/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".minimax/skills", "skill-folder", "skill");
    addHome(".minimax/.builtin-skills", "skill-folder", "skill");
  } else if (norm === "codebuddy" || norm === "workbuddy") {
    addProj(".codebuddy/commands", "markdown-cmd", "custom");
    addProj(".codebuddy/skills", "skill-folder", "skill");
    addProj(".workbuddy/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".codebuddy/commands", "markdown-cmd", "custom");
    addHome(".codebuddy/skills", "skill-folder", "skill");
    addHome(".workbuddy/skills", "skill-folder", "skill");
  } else if (norm === "qoder" || norm === "qwen") {
    addProj(".qoder/commands", "markdown-cmd", "custom");
    addProj(".qoder/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".qoder/commands", "markdown-cmd", "custom");
    addHome(".qoder/skills", "skill-folder", "skill");
    addHome(".qoder-cn/skills", "skill-folder", "skill");
    addHome(".qwenworkcn/skills", "skill-folder", "skill");
  } else if (norm === "cursor") {
    addProj(".cursor/commands", "markdown-cmd", "custom");
    addHome(".cursor/commands", "markdown-cmd", "custom");
  } else if (norm === "opencode") {
    addProj(".opencode/command", "markdown-cmd", "custom");
    addProj(".opencode/commands", "markdown-cmd", "custom");
    addHome(".config/opencode/command", "markdown-cmd", "custom");
  } else if (norm === "kilo") {
    addProj(".kilocode/workflows", "markdown-cmd", "skill");
    addHome(".kilocode/workflows", "markdown-cmd", "skill");
  } else if (norm === "cline") {
    addProj(".clinerules/workflows", "markdown-cmd", "skill");
  } else if (norm === "roo") {
    addProj(".roo/commands", "markdown-cmd", "custom");
    addHome(".roo/commands", "markdown-cmd", "custom");
  } else if (norm === "kiro") {
    addProj(".kiro/prompts", "markdown-cmd", "custom");
    addHome(".kiro/prompts", "markdown-cmd", "custom");
  } else if (norm === "factory") {
    addProj(".factory/commands", "markdown-cmd", "custom");
    addHome(".factory/commands", "markdown-cmd", "custom");
  } else if (norm === "reasonix") {
    addProj(".reasonix/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".reasonix/skills", "skill-folder", "skill");
  } else if (norm === "commandcode") {
    addProj(".commandcode/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".commandcode/skills", "skill-folder", "skill");
  } else if (norm === "copilot") {
    addProj(".copilot/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".copilot/skills", "skill-folder", "skill");
  } else if (norm === "prime") {
    addProj(".prime/agent/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".prime/agent/skills", "skill-folder", "skill");
  } else if (norm === "crosery") {
    addProj(".crosery/commands", "markdown-cmd", "custom");
    addProj(".claude/commands", "markdown-cmd", "custom");
    addHome(".claude/commands", "markdown-cmd", "custom");
  } else if (norm === "kimi") {
    addProj(".kimi-code/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".kimi-code/skills", "skill-folder", "skill");
  } else if (norm === "zcode") {
    addProj(".zcode/skills", "skill-folder", "skill");
    addProj(".agents/skills", "skill-folder", "skill");
    addHome(".zcode/skills", "skill-folder", "skill");
  } else {
    addProj(".agents/skills", "skill-folder", "skill");
    addProj(`.${norm}/commands`, "markdown-cmd", "custom");
    addProj(`.${norm}/skills`, "skill-folder", "skill");
    addHome(`.${norm}/commands`, "markdown-cmd", "custom");
    addHome(`.${norm}/skills`, "skill-folder", "skill");
    addHome(".agents/skills", "skill-folder", "skill");
  }

  const results = await Promise.all(specs.map(scanSpec));
  const merged: SlashCommandItem[] = [];
  const seen = new Set<string>();
  for (const list of results) {
    for (const cmd of list) {
      const k = cmd.name.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(cmd);
    }
  }
  cache.set(cacheKey, { at: Date.now(), commands: merged });
  return merged;
}
