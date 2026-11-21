import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Agent, AgentModelOption, AgentModelsResult } from "@herdr-pocket/protocol";
import { findPrograms } from "./create.ts";
import { harnessId } from "./uniflo.ts";

const execFileAsync = promisify(execFile);

const CATALOG_CACHE_MS = 5 * 60_000;
let ompModelsCache: { at: number; models: AgentModelOption[] } | null = null;

function normHarnessKey(raw: string): string {
  const h = (harnessId(raw) ?? raw).trim().toLowerCase();
  if (h.includes("claude") || h === "crosery" || h === "prime" || h === "commandcode" || h === "reasonix") return "claude";
  if (h === "oh-my-pi" || h === "omp") return "omp";
  if (h === "pi" || h === "pi-mono") return "pi";
  if (h.includes("codex")) return "codex";
  if (h.includes("gemini")) return "gemini";
  if (h.includes("antigravity") || h === "agy") return "antigravity";
  if (h.includes("deepseek") || h === "dsh") return "dsh";
  if (h.includes("opencode") || h.includes("kilo") || h.includes("crush")) return "opencode";
  return h;
}

/** Parses `omp models --json --no-extensions` safely and extracts chat models only. */
export function parseOmpModelsJson(raw: string): AgentModelOption[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows = Array.isArray((parsed as { models?: unknown })?.models)
    ? (parsed as { models: unknown[] }).models
    : Array.isArray(parsed)
      ? parsed
      : [];
  const out: AgentModelOption[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const item = r as Record<string, unknown>;
    if (typeof item.kind === "string" && item.kind !== "chat") continue;
    const id = String(item.selector ?? item.id ?? "").trim();
    if (!id) continue;
    const label = String(item.name ?? item.id ?? id).trim() || id;
    const provider = typeof item.provider === "string" && item.provider.trim() ? item.provider.trim() : undefined;
    const contextWindow = typeof item.contextWindow === "number" && item.contextWindow > 0 ? item.contextWindow : undefined;
    const reasoning = typeof item.reasoning === "boolean" ? item.reasoning : undefined;
    out.push({
      id,
      label,
      ...(provider ? { provider } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      source: "catalog",
    });
  }
  return out;
}

async function getOmpCatalog(): Promise<AgentModelOption[]> {
  if (ompModelsCache && Date.now() - ompModelsCache.at < CATALOG_CACHE_MS) return ompModelsCache.models;
  try {
    const found = await findPrograms(["omp"]);
    const bin = found.get("omp");
    if (!bin) {
      ompModelsCache = { at: Date.now(), models: [] };
      return [];
    }
    const { stdout } = await execFileAsync(bin, ["models", "--json", "--no-extensions"], {
      timeout: 3500,
      maxBuffer: 4 * 1024 * 1024,
    });
    const models = parseOmpModelsJson(stdout);
    ompModelsCache = { at: Date.now(), models };
    return models;
  } catch {
    return ompModelsCache?.models ?? [];
  }
}

/** Reads only non-secret model ID strings from local harness settings files. */
export function readLocalConfiguredModels(homeDir = homedir()): AgentModelOption[] {
  const out: AgentModelOption[] = [];

  const claudeSettings = join(homeDir, ".claude", "settings.json");
  if (existsSync(claudeSettings)) {
    try {
      const json = JSON.parse(readFileSync(claudeSettings, "utf8")) as Record<string, unknown>;
      const env = (json.env && typeof json.env === "object" ? json.env : {}) as Record<string, unknown>;
      const keys = [
        json.model,
        env.ANTHROPIC_MODEL,
        env.ANTHROPIC_DEFAULT_OPUS_MODEL,
        env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      ];
      for (const v of keys) {
        if (typeof v !== "string") continue;
        const id = v.trim();
        if (id && !/^sk-|^https?:\/\//i.test(id)) {
          out.push({ id, label: id, provider: "claude", source: "catalog" });
        }
      }
    } catch {
      /* ignore */
    }
  }

  const codexToml = join(homeDir, ".codex", "config.toml");
  if (existsSync(codexToml)) {
    try {
      const raw = readFileSync(codexToml, "utf8");
      const m = /^\s*model\s*=\s*["']([^"'\n]+)["']/m.exec(raw);
      if (m?.[1]?.trim()) {
        out.push({ id: m[1].trim(), label: m[1].trim(), provider: "codex", source: "catalog" });
      }
    } catch {
      /* ignore */
    }
  }

  const opencodeJson = join(homeDir, ".config", "opencode", "opencode.json");
  if (existsSync(opencodeJson)) {
    try {
      const json = JSON.parse(readFileSync(opencodeJson, "utf8")) as Record<string, unknown>;
      if (typeof json.model === "string" && json.model.trim()) {
        out.push({ id: json.model.trim(), label: json.model.trim(), provider: "opencode", source: "catalog" });
      }
    } catch {
      /* ignore */
    }
  }

  return out;
}

const FALLBACK_PRESETS: Record<string, AgentModelOption[]> = {
  claude: [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic", source: "catalog" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic", source: "catalog" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", provider: "anthropic", source: "catalog" },
  ],
  codex: [
    { id: "gpt-6.2-astra", label: "GPT-6.2 Astra", provider: "openai", source: "catalog" },
    { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", provider: "openai", source: "catalog" },
    { id: "gpt-6-astra", label: "GPT-6 Astra", provider: "openai", source: "catalog" },
  ],
  gemini: [
    { id: "gemini-3.5-pro", label: "Gemini 3.5 Pro", provider: "google", source: "catalog" },
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash High", provider: "google", source: "catalog" },
  ],
  antigravity: [
    { id: "gemini-4-carbon-high", label: "Gemini 4 Carbon High", provider: "google", source: "catalog" },
    { id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen High", provider: "google", source: "catalog" },
    { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 High", provider: "anthropic", source: "catalog" },
  ],
  dsh: [
    { id: "deepseek-chat", label: "DeepSeek Chat", provider: "deepseek", source: "catalog" },
    { id: "deepseek-reasoner", label: "DeepSeek Reasoner", provider: "deepseek", reasoning: true, source: "catalog" },
  ],
};

export interface ModelsUnifloLike {
  recentModels(harness?: string): Promise<string[]>;
}

export function clearModelsCacheForTest(): void {
  ompModelsCache = null;
}

export async function getAgentModels(
  agent: Agent,
  opts: {
    uniflo?: ModelsUnifloLike;
    unifloReady?: boolean;
    readCatalog?: () => Promise<AgentModelOption[]>;
    homeDir?: string;
    currentModelOverride?: string;
  } = {},
): Promise<AgentModelsResult> {
  const canSwitch = !agent.isShell && (agent.source === "hc" || agent.source === "herdr");
  const reason = agent.isShell
    ? "普通终端不支持切换模型"
    : agent.source === "uniflo"
      ? "历史只读会话无法直接切换模型"
      : undefined;

  const hNorm = normHarnessKey(agent.harness);
  const hQuery = (harnessId(agent.harness) ?? agent.harness).trim();
  const uniflo = opts.unifloReady === false ? undefined : opts.uniflo;
  const currentModel = opts.currentModelOverride?.trim() || agent.model?.trim() || undefined;

  const [harnessRecent, allRecent, catalog] = await Promise.all([
    uniflo && hQuery ? uniflo.recentModels(hQuery).catch(() => []) : Promise.resolve([]),
    uniflo ? uniflo.recentModels().catch(() => []) : Promise.resolve([]),
    opts.readCatalog
      ? opts.readCatalog().catch(() => [])
      : hNorm === "omp" || hNorm === "pi"
        ? getOmpCatalog()
        : Promise.resolve([]),
  ]);

  const merged: AgentModelOption[] = [];
  const seen = new Set<string>();
  const push = (opt: AgentModelOption) => {
    const k = opt.id.trim().toLowerCase();
    if (!k || seen.has(k) || merged.length >= 80) return;
    seen.add(k);
    merged.push({ ...opt, id: opt.id.trim() });
  };

  if (currentModel) {
    push({ id: currentModel, label: currentModel, source: "current" });
  }
  for (const id of harnessRecent) {
    push({ id, label: id, source: "recent" });
  }
  for (const id of allRecent) {
    push({ id, label: id, source: "recent" });
  }
  for (const item of catalog) {
    push(item);
  }
  for (const item of readLocalConfiguredModels(opts.homeDir)) {
    if (!item.provider || item.provider === hNorm) {
      push(item);
    }
  }
  if (merged.length < 3) {
    for (const preset of FALLBACK_PRESETS[hNorm] ?? FALLBACK_PRESETS.claude ?? []) {
      push(preset);
    }
  }

  return {
    harness: agent.harness,
    ...(currentModel ? { currentModel } : {}),
    canSwitch,
    ...(reason ? { reason } : {}),
    models: merged,
  };
}
