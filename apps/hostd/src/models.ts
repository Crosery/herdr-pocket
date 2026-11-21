import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  buildHarnessSwitchCommands,
  normalizeSwitchHarness,
  stripModelEffortSuffix,
  type Agent,
  type AgentModelOption,
  type AgentModelsResult,
} from "@herdr-pocket/protocol";
import { findPrograms } from "./create.ts";
import { endsInPanel } from "./hc.ts";
import { harnessId } from "./uniflo.ts";

const execFileAsync = promisify(execFile);

const CATALOG_CACHE_MS = 5 * 60_000;
const MAX_MODELS = 500;
const cliCatalogCache = new Map<string, { at: number; models: AgentModelOption[] }>();

const HARNESS_THINKING_LEVELS: Record<string, string[]> = {
  omp: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  claude: ["low", "medium", "high", "xhigh", "max", "auto"],
  codex: ["low", "medium", "high", "xhigh"],
  antigravity: ["low", "medium", "high", "xhigh", "max"],
  gemini: ["low", "medium", "high"],
  opencode: ["low", "medium", "high", "max"],
  dsh: ["low", "medium", "high"],
  hermes: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  grok: ["low", "medium", "high", "xhigh"],
  aider: ["low", "medium", "high"],
  factory: ["normal", "fast"],
  amp: ["smart", "rush"],
  cursor: ["low", "medium", "high"],
  kimi: ["low", "medium", "high"],
  qwen: ["low", "medium", "high"],
  qoder: ["low", "medium", "high"],
  codebuddy: ["low", "medium", "high"],
  goose: ["low", "medium", "high"],
};

function normHarnessKey(raw: string): string {
  return normalizeSwitchHarness((harnessId(raw) ?? raw).trim());
}

/** Parses `omp models --json` safely and extracts chat models plus per-model thinking levels. */
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
    const thinkingLevels = Array.isArray(item.thinking)
      ? item.thinking.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
      : undefined;
    out.push({
      id,
      label,
      ...(provider ? { provider } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(thinkingLevels?.length ? { thinkingLevels } : {}),
      source: "catalog",
    });
  }
  return out;
}

/** Parses `agy models` (`<id>\t<label>`) output. */
export function parseAgyModelsText(raw: string): AgentModelOption[] {
  const out: AgentModelOption[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || /^model\b/i.test(clean) && !clean.includes("\t")) continue;
    const [idPart, labelPart] = clean.split("\t");
    const id = idPart?.trim();
    if (!id || /\s/.test(id)) continue;
    const label = labelPart?.trim() || id;
    out.push({ id, label, provider: "antigravity", source: "catalog" });
  }
  return out;
}

function parseContextTokenUnit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /^(\d+(?:\.\d+)?)([km])$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * (m[2]!.toLowerCase() === "m" ? 1_000_000 : 1_000));
}

/** Parses `pi --list-models` tabular output cleanly. */
export function parsePiModelsText(raw: string): AgentModelOption[] {
  const out: AgentModelOption[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^provider\s+model\b/i.test(trimmed) || /^[-─]+$/.test(trimmed)) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 2) continue;
    const [provider, model, contextCol, _maxOut, thinkingCol] = cols;
    if (!provider || !model) continue;
    const id = model.includes("/") ? model : `${provider}/${model}`;
    const contextWindow = parseContextTokenUnit(contextCol);
    const reasoning = thinkingCol ? thinkingCol.toLowerCase() === "yes" : undefined;
    out.push({
      id,
      label: model,
      provider,
      ...(contextWindow ? { contextWindow } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      source: "catalog",
    });
  }
  return out;
}

/** Parses `opencode models` line-by-line `<provider>/<model>` output. */
export function parseOpencodeModelsText(raw: string): AgentModelOption[] {
  const out: AgentModelOption[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const id = line.trim();
    if (!id || /\s/.test(id) || id.startsWith("#")) continue;
    const slash = id.indexOf("/");
    const provider = slash > 0 ? id.slice(0, slash) : "opencode";
    const label = slash > 0 ? id.slice(slash + 1) : id;
    out.push({ id, label, provider, source: "catalog" });
  }
  return out;
}

async function cachedCliCatalog(key: string, loader: () => Promise<AgentModelOption[]>): Promise<AgentModelOption[]> {
  const cached = cliCatalogCache.get(key);
  if (cached && Date.now() - cached.at < CATALOG_CACHE_MS) return cached.models;
  const models = await loader().catch(() => []);
  // Only cache non-empty results for full 5m so a transient timeout does not strand the picker.
  if (models.length > 0) cliCatalogCache.set(key, { at: Date.now(), models });
  return models.length ? models : (cached?.models ?? []);
}

async function getOmpCatalog(): Promise<AgentModelOption[]> {
  return cachedCliCatalog("omp", async () => {
    const found = await findPrograms(["omp"]);
    const bin = found.get("omp");
    if (!bin) return [];
    // Keep extensions enabled so custom providers (e.g. crosery-fast / crosery-ultrafast) appear; fall back only on error.
    try {
      const { stdout } = await execFileAsync(bin, ["models", "--json"], {
        timeout: 15_000,
        maxBuffer: 6 * 1024 * 1024,
      });
      const parsed = parseOmpModelsJson(stdout);
      if (parsed.length) return parsed;
    } catch {
      /* fallback below */
    }
    const { stdout } = await execFileAsync(bin, ["models", "--json", "--no-extensions"], {
      timeout: 15_000,
      maxBuffer: 6 * 1024 * 1024,
    });
    return parseOmpModelsJson(stdout);
  });
}

async function getPiCatalog(): Promise<AgentModelOption[]> {
  const piList = await cachedCliCatalog("pi", async () => {
    const found = await findPrograms(["pi"]);
    const bin = found.get("pi");
    if (!bin) return [];
    const { stdout } = await execFileAsync(bin, ["--list-models"], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return parsePiModelsText(stdout);
  });
  return piList.length ? piList : getOmpCatalog();
}

async function getAgyCatalog(): Promise<AgentModelOption[]> {
  return cachedCliCatalog("antigravity", async () => {
    const found = await findPrograms(["agy"]);
    const bin = found.get("agy");
    if (!bin) return [];
    const { stdout } = await execFileAsync(bin, ["models"], {
      timeout: 8000,
      maxBuffer: 1024 * 1024,
    });
    return parseAgyModelsText(stdout);
  });
}

async function getOpencodeCatalog(): Promise<AgentModelOption[]> {
  return cachedCliCatalog("opencode", async () => {
    const found = await findPrograms(["opencode", "kilo"]);
    const bin = found.get("opencode") ?? found.get("kilo");
    if (!bin) return [];
    const { stdout } = await execFileAsync(bin, ["models"], {
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return parseOpencodeModelsText(stdout);
  });
}

function splitModelAndEffort(raw: string): { id: string; effort?: string } {
  const trimmed = raw.trim();
  const base = stripModelEffortSuffix(trimmed);
  if (base !== trimmed && trimmed.length > base.length + 1) {
    return { id: base, effort: trimmed.slice(base.length + 1).toLowerCase() };
  }
  return { id: trimmed };
}

/** Reads `~/.omp/agent/config.yml` modelRoles + defaultThinkingLevel and `~/.omp/agent/agent.db` MRU selectors. */
export async function readOmpLocalConfig(homeDir = homedir()): Promise<{
  models: AgentModelOption[];
  defaultModel?: string;
  defaultThinking?: string;
}> {
  const models: AgentModelOption[] = [];
  let defaultModel: string | undefined;
  let defaultThinking: string | undefined;

  const ymlPath = join(homeDir, ".omp", "agent", "config.yml");
  if (existsSync(ymlPath)) {
    try {
      const raw = readFileSync(ymlPath, "utf8");
      const thinkMatch = /^\s*defaultThinkingLevel\s*:\s*["']?([A-Za-z0-9_-]+)["']?/m.exec(raw);
      if (thinkMatch?.[1]) defaultThinking = thinkMatch[1].trim().toLowerCase();

      const lines = raw.split(/\r?\n/);
      let inRoles = false;
      for (const line of lines) {
        if (/^modelRoles\s*:/.test(line)) {
          inRoles = true;
          continue;
        }
        if (inRoles) {
          if (/^\S/.test(line)) {
            inRoles = false;
            continue;
          }
          const m = /^\s+([A-Za-z0-9_-]+)\s*:\s*["']?([^\s"']+)["']?/.exec(line);
          if (!m) continue;
          const role = m[1]!;
          const { id, effort } = splitModelAndEffort(m[2]!);
          if (!id) continue;
          const provider = id.includes("/") ? id.split("/")[0] : "omp";
          if (role === "default" && !defaultModel) {
            defaultModel = id;
            if (!defaultThinking && effort) defaultThinking = effort;
          }
          models.push({ id, label: id, provider, source: "recent" });
        }
      }
    } catch {
      /* ignore invalid yml */
    }
  }

  const dbPath = join(homeDir, ".omp", "agent", "agent.db");
  if (existsSync(dbPath)) {
    try {
      const mod = await import("node:sqlite").catch(() => null);
      if (mod?.DatabaseSync) {
        const db = new mod.DatabaseSync(dbPath, { readOnly: true });
        try {
          const rows = db.prepare("SELECT model_key FROM model_usage ORDER BY last_used_at DESC LIMIT 60").all() as Array<{ model_key?: unknown }>;
          for (const row of rows) {
            if (typeof row.model_key !== "string" || !row.model_key.trim()) continue;
            const { id } = splitModelAndEffort(row.model_key);
            if (!id) continue;
            const provider = id.includes("/") ? id.split("/")[0] : "omp";
            models.push({ id, label: id, provider, source: "recent" });
          }
        } finally {
          db.close();
        }
      }
    } catch {
      /* ignore sqlite unavailability or lock */
    }
  }

  return { models, defaultModel, defaultThinking };
}

/** Reads only non-secret model ID and default thinking-level strings from local harness settings files. */
export function readLocalConfiguredModels(homeDir = homedir()): AgentModelOption[] {
  return readLocalConfiguredDetails(homeDir).models;
}

function readLocalConfiguredDetails(homeDir = homedir()): {
  models: AgentModelOption[];
  thinkingByHarness: Record<string, string>;
} {
  const out: AgentModelOption[] = [];
  const thinkingByHarness: Record<string, string> = {};

  const claudeSettings = join(homeDir, ".claude", "settings.json");
  if (existsSync(claudeSettings)) {
    try {
      const json = JSON.parse(readFileSync(claudeSettings, "utf8")) as Record<string, unknown>;
      const env = (json.env && typeof json.env === "object" ? json.env : {}) as Record<string, unknown>;
      if (typeof json.effortLevel === "string" && json.effortLevel.trim()) {
        thinkingByHarness.claude = json.effortLevel.trim().toLowerCase();
      }
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
      const e = /^\s*model_reasoning_effort\s*=\s*["']([^"'\n]+)["']/m.exec(raw);
      if (e?.[1]?.trim()) {
        thinkingByHarness.codex = e[1].trim().toLowerCase();
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

  const geminiJson = join(homeDir, ".gemini", "settings.json");
  if (existsSync(geminiJson)) {
    try {
      const json = JSON.parse(readFileSync(geminiJson, "utf8")) as Record<string, any>;
      const modelName = typeof json?.model?.name === "string" ? json.model.name.trim() : typeof json?.model === "string" ? json.model.trim() : "";
      if (modelName) {
        out.push({ id: modelName, label: modelName, provider: "gemini", source: "catalog" });
      }
      const think = json?.thinkingConfig?.thinkingLevel;
      if (typeof think === "string" && think.trim()) {
        thinkingByHarness.gemini = think.trim().toLowerCase();
      }
    } catch {
      /* ignore */
    }
  }

  const piSettings = join(homeDir, ".pi", "agent", "settings.json");
  if (existsSync(piSettings)) {
    try {
      const json = JSON.parse(readFileSync(piSettings, "utf8")) as Record<string, unknown>;
      if (typeof json.defaultModel === "string" && json.defaultModel.trim()) {
        const prov = typeof json.defaultProvider === "string" && json.defaultProvider.trim() ? json.defaultProvider.trim() : "";
        const id = prov && !json.defaultModel.includes("/") ? `${prov}/${json.defaultModel.trim()}` : json.defaultModel.trim();
        out.push({ id, label: id, provider: "pi", source: "catalog" });
      }
      if (typeof json.defaultThinkingLevel === "string" && json.defaultThinkingLevel.trim()) {
        thinkingByHarness.pi = json.defaultThinkingLevel.trim().toLowerCase();
      }
    } catch {
      /* ignore */
    }
  }

  const hermesYaml = join(homeDir, ".hermes", "config.yaml");
  if (existsSync(hermesYaml)) {
    try {
      const raw = readFileSync(hermesYaml, "utf8");
      const m = /^\s*default\s*:\s*["']?([^\s"'#]+)["']?/m.exec(raw);
      if (m?.[1]?.trim()) {
        out.push({ id: m[1].trim(), label: m[1].trim(), provider: "hermes", source: "catalog" });
      }
      const r = /^\s*reasoning_effort\s*:\s*["']?([A-Za-z0-9_-]+)["']?/m.exec(raw);
      if (r?.[1]?.trim()) {
        thinkingByHarness.hermes = r[1].trim().toLowerCase();
      }
    } catch {
      /* ignore */
    }
  }

  const aiderConf = join(homeDir, ".aider.conf.yml");
  if (existsSync(aiderConf)) {
    try {
      const raw = readFileSync(aiderConf, "utf8");
      const m = /^\s*model\s*:\s*["']?([^\s"'#]+)["']?/m.exec(raw);
      if (m?.[1]?.trim()) {
        out.push({ id: m[1].trim(), label: m[1].trim(), provider: "aider", source: "catalog" });
      }
      const r = /^\s*reasoning-effort\s*:\s*["']?([A-Za-z0-9_-]+)["']?/m.exec(raw);
      if (r?.[1]?.trim()) {
        thinkingByHarness.aider = r[1].trim().toLowerCase();
      }
    } catch {
      /* ignore */
    }
  }

  return { models: out, thinkingByHarness };
}

const FALLBACK_PRESETS: Record<string, AgentModelOption[]> = {
  claude: [
    { id: "default", label: "Default", provider: "anthropic", source: "catalog" },
    { id: "opus", label: "Opus", provider: "anthropic", source: "catalog" },
    { id: "sonnet", label: "Sonnet", provider: "anthropic", source: "catalog" },
    { id: "haiku", label: "Haiku", provider: "anthropic", source: "catalog" },
    { id: "opusplan", label: "Opus Plan", provider: "anthropic", source: "catalog" },
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
    { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)", provider: "google", source: "catalog" },
    { id: "gemini-4-carbon-high", label: "Gemini 4 Carbon (High)", provider: "google", source: "catalog" },
    { id: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)", provider: "google", source: "catalog" },
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
  cliCatalogCache.clear();
}

function findCatalogMatch(rawId: string, catalog: readonly AgentModelOption[]): AgentModelOption | undefined {
  const q = rawId.trim().toLowerCase();
  if (!q) return undefined;
  const exact = catalog.find((c) => c.id.toLowerCase() === q);
  if (exact) return exact;
  return catalog.find((c) => c.id.toLowerCase().endsWith(`/${q}`));
}

export async function getAgentModels(
  agent: Agent,
  opts: {
    uniflo?: ModelsUnifloLike;
    unifloReady?: boolean;
    readCatalog?: () => Promise<AgentModelOption[]>;
    homeDir?: string;
    currentModelOverride?: string;
    currentThinkingOverride?: string;
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
  const rawModel = opts.currentModelOverride?.trim() || agent.model?.trim() || "";
  const parsedCurrent = rawModel ? splitModelAndEffort(rawModel) : { id: "", effort: undefined };

  const localCfg = readLocalConfiguredDetails(opts.homeDir);

  const [harnessRecent, allRecent, catalog, ompLocal] = await Promise.all([
    uniflo && hQuery ? uniflo.recentModels(hQuery).catch(() => []) : Promise.resolve([]),
    uniflo ? uniflo.recentModels().catch(() => []) : Promise.resolve([]),
    opts.readCatalog
      ? opts.readCatalog().catch(() => [])
      : hNorm === "omp"
        ? getOmpCatalog()
        : hNorm === "pi"
          ? getPiCatalog()
          : hNorm === "antigravity"
            ? getAgyCatalog()
            : hNorm === "opencode"
              ? getOpencodeCatalog()
              : Promise.resolve([]),
    hNorm === "omp" ? readOmpLocalConfig(opts.homeDir) : Promise.resolve<{ models: AgentModelOption[]; defaultModel?: string; defaultThinking?: string }>({ models: [] }),
  ]);

  const currentModel = parsedCurrent.id || (hNorm === "omp" ? ompLocal.defaultModel : undefined) || undefined;
  let currentThinking =
    opts.currentThinkingOverride?.trim().toLowerCase() ||
    parsedCurrent.effort ||
    (hNorm === "omp" ? ompLocal.defaultThinking : undefined) ||
    localCfg.thinkingByHarness[hNorm] ||
    undefined;

  if (!currentThinking && hNorm === "gemini" && currentModel) {
    const gm = /-(low|medium|high)$/i.exec(currentModel);
    if (gm?.[1]) currentThinking = gm[1].toLowerCase();
  }

  const combinedCatalog = [...catalog];
  const merged: AgentModelOption[] = [];
  const seen = new Set<string>();
  const bareAliasesSeen = new Set<string>();

  const push = (opt: AgentModelOption, preferCatalogUpgrade = false) => {
    const cleanId = opt.id.trim();
    const k = cleanId.toLowerCase();
    if (!k || merged.length >= MAX_MODELS) return;
    if (seen.has(k) || bareAliasesSeen.has(k)) return;

    if (preferCatalogUpgrade) {
      const catMatch = findCatalogMatch(cleanId, combinedCatalog);
      if (catMatch) {
        const matchKey = catMatch.id.toLowerCase();
        if (seen.has(matchKey)) return;
        seen.add(matchKey);
        bareAliasesSeen.add(k);
        merged.push({
          ...catMatch,
          source: opt.source,
        });
        return;
      }
    }

    seen.add(k);
    merged.push({ ...opt, id: cleanId });
  };

  if (currentModel) {
    const catMatch = findCatalogMatch(currentModel, combinedCatalog);
    if (catMatch) {
      seen.add(catMatch.id.toLowerCase());
      bareAliasesSeen.add(currentModel.toLowerCase());
      merged.push({ ...catMatch, source: "current" });
    } else {
      push({ id: currentModel, label: currentModel, source: "current" });
    }
  }

  if (hNorm === "omp") {
    for (const item of ompLocal.models) {
      push(item, true);
    }
  }

  for (const item of localCfg.models) {
    if (!item.provider || item.provider === hNorm) {
      push(item, true);
    }
  }

  for (const id of harnessRecent) {
    push({ id, label: id, source: "recent" }, hNorm === "omp" || hNorm === "pi");
  }

  for (const item of combinedCatalog) {
    push(item);
  }

  if (merged.length < 5) {
    const presets = FALLBACK_PRESETS[hNorm] ?? (merged.length === 0 ? FALLBACK_PRESETS.claude ?? [] : []);
    for (const preset of presets) {
      push(preset);
    }
  }

  if (merged.length < MAX_MODELS) {
    for (const id of allRecent) {
      push({ id, label: id, source: "recent" }, hNorm === "omp" || hNorm === "pi");
    }
  }

  const currentOpt = merged[0]?.source === "current" ? merged[0] : undefined;
  const thinkingLevels =
    currentOpt?.thinkingLevels?.length
      ? currentOpt.thinkingLevels
      : HARNESS_THINKING_LEVELS[hNorm] ?? undefined;

  return {
    harness: agent.harness,
    ...(merged[0]?.source === "current" ? { currentModel: merged[0].id } : currentModel ? { currentModel } : {}),
    ...(currentThinking ? { currentThinking } : {}),
    ...(thinkingLevels?.length ? { thinkingLevels, canSwitchThinking: canSwitch, thinkingLabel: "思考等级" } : { canSwitchThinking: false }),
    canSwitch,
    ...(reason ? { reason } : {}),
    models: merged,
  };
}

function updateTomlKey(filePath: string, key: string, value: string): boolean {
  if (!existsSync(filePath)) return false;
  const raw = readFileSync(filePath, "utf8");
  const escaped = JSON.stringify(value);
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*)([^\\r\\n]+)`, "m");
  let next: string;
  if (re.test(raw)) {
    next = raw.replace(re, `$1${escaped}`);
  } else {
    const firstSection = raw.search(/^\[/m);
    const line = `${key} = ${escaped}\n`;
    next = firstSection >= 0 ? `${raw.slice(0, firstSection)}${line}${raw.slice(firstSection)}` : `${line}${raw}`;
  }
  writeFileSync(filePath, next, "utf8");
  return true;
}

function updateJsonObjectField(filePath: string, patch: (obj: Record<string, unknown>) => void): boolean {
  try {
    let obj: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    patch(obj);
    writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface SwitchTransport {
  hc: {
    send: (address: string, text: string, enter?: boolean) => Promise<void>;
    input: (address: string, data: string) => Promise<void>;
    keys: (address: string, keys: string[]) => Promise<void>;
    snapshotText: (address: string, lines?: number) => Promise<string>;
  };
  herdr?: {
    send: (localId: string, text: string, enter?: boolean) => Promise<void>;
    keys: (localId: string, keys: string[]) => Promise<void>;
  };
  homeDir?: string;
}

/** Switches an active agent's model and/or thinking effort across all supported harnesses. */
export async function setAgentModelAndThinking(
  agent: Agent,
  opts: { modelId?: string; thinkingLevel?: string },
  transport: SwitchTransport,
): Promise<{ currentModel?: string; currentThinking?: string; note?: string }> {
  const modelId = opts.modelId?.trim() || undefined;
  const thinkingLevel = opts.thinkingLevel?.trim().toLowerCase() || undefined;
  if (!modelId && !thinkingLevel) throw new Error("需要指定模型或思考等级");
  if (agent.isShell || (agent.source !== "hc" && agent.source !== "herdr")) {
    throw new Error("当前会话不支持切换模型或思考等级");
  }

  const hNorm = normHarnessKey(agent.harness);
  const home = transport.homeDir ?? homedir();
  const plan = buildHarnessSwitchCommands(agent.harness, { modelId, thinkingLevel });

  const sendLine = async (line: string) => {
    if (agent.source === "hc") await transport.hc.send(agent.localId, line, true);
    else if (transport.herdr) await transport.herdr.send(agent.localId, line, true);
  };
  const sendKeys = async (keys: string[]) => {
    if (agent.source === "hc") await transport.hc.keys(agent.localId, keys);
    else if (transport.herdr) await transport.herdr.keys(agent.localId, keys);
  };

  if (hNorm === "gemini" && thinkingLevel) {
    const targetModel = modelId || agent.model || "";
    if (!/-(low|medium|high)$/i.test(targetModel)) {
      const saved = updateJsonObjectField(join(home, ".gemini", "settings.json"), (obj) => {
        const cur = obj.thinkingConfig && typeof obj.thinkingConfig === "object" ? (obj.thinkingConfig as Record<string, unknown>) : {};
        obj.thinkingConfig = { ...cur, thinkingLevel };
      });
      if (modelId && plan.commands.length) {
        await sendLine(plan.commands[0]!);
      }
      return {
        ...(modelId ? { currentModel: modelId } : {}),
        currentThinking: thinkingLevel,
        note: saved
          ? `已写入 Gemini 思考等级（${thinkingLevel}），将在下一次启动生效`
          : "Gemini CLI 思考等级通常随模型名后缀（如 -high/-medium）切换",
      };
    }
  }

  if (hNorm === "opencode") {
    if (modelId) {
      updateJsonObjectField(join(home, ".config", "opencode", "opencode.json"), (obj) => {
        obj.model = modelId;
      });
      if (agent.source === "hc") {
        await sendLine("/models");
        await wait(260);
        await transport.hc.input(agent.localId, modelId);
        await wait(160);
        await sendKeys(["enter"]);
        await wait(260);
        const scr = await transport.hc.snapshotText(agent.localId, 0);
        if (endsInPanel(scr)) await sendKeys(["esc"]);
      }
    }
    if (thinkingLevel) {
      await sendKeys(["ctrl+t"]);
    }
    return {
      ...(modelId ? { currentModel: modelId } : {}),
      ...(thinkingLevel ? { currentThinking: thinkingLevel } : {}),
      ...(modelId && agent.source !== "hc" ? { note: "已写入 opencode.json 默认模型" } : {}),
    };
  }

  if (hNorm === "codex") {
    const cfgPath = join(home, ".codex", "config.toml");
    let wroteToml = false;
    if (modelId) wroteToml = updateTomlKey(cfgPath, "model", modelId) || wroteToml;
    if (thinkingLevel) wroteToml = updateTomlKey(cfgPath, "model_reasoning_effort", thinkingLevel) || wroteToml;

    if (agent.source === "hc") {
      await sendLine("/model");
      await wait(280);
      if (modelId) {
        await transport.hc.input(agent.localId, modelId);
        await wait(180);
      }
      await sendKeys(["enter"]);
      await wait(240);
      if (thinkingLevel) {
        await transport.hc.input(agent.localId, thinkingLevel);
        await wait(140);
      }
      await sendKeys(["enter"]);
      await wait(240);
      const scr = await transport.hc.snapshotText(agent.localId, 0);
      if (endsInPanel(scr)) await sendKeys(["esc"]);
    }
    return {
      ...(modelId ? { currentModel: modelId } : {}),
      ...(thinkingLevel ? { currentThinking: thinkingLevel } : {}),
      ...(wroteToml ? { note: "已同步更新 Codex 配置" } : {}),
    };
  }

  if (hNorm === "factory" || hNorm === "dsh") {
    if (plan.commands.length) {
      for (const cmd of plan.commands) {
        await sendLine(cmd);
        await wait(180);
      }
    }
    if (modelId && agent.source === "hc") {
      await sendLine("/model");
      await wait(280);
      await transport.hc.input(agent.localId, modelId);
      await wait(160);
      await sendKeys(["enter"]);
      await wait(240);
      if (thinkingLevel && hNorm === "dsh") {
        await transport.hc.input(agent.localId, thinkingLevel);
        await wait(140);
        await sendKeys(["enter"]);
        await wait(200);
      }
      const scr = await transport.hc.snapshotText(agent.localId, 0);
      if (endsInPanel(scr)) await sendKeys(["esc"]);
    } else if (thinkingLevel && hNorm === "dsh" && !modelId && agent.source === "hc") {
      await sendLine("/model");
      await wait(280);
      await sendKeys(["enter"]);
      await wait(220);
      await transport.hc.input(agent.localId, thinkingLevel);
      await wait(140);
      await sendKeys(["enter"]);
      await wait(200);
      const scr = await transport.hc.snapshotText(agent.localId, 0);
      if (endsInPanel(scr)) await sendKeys(["esc"]);
    }
    return {
      ...(modelId ? { currentModel: modelId } : {}),
      ...(thinkingLevel ? { currentThinking: thinkingLevel } : {}),
    };
  }

  for (let i = 0; i < plan.commands.length; i++) {
    if (i > 0) await wait(200);
    await sendLine(plan.commands[i]!);
  }
  for (const chord of plan.keys ?? []) {
    await wait(120);
    await sendKeys(chord);
  }

  return {
    ...(modelId ? { currentModel: hNorm === "omp" ? stripModelEffortSuffix(modelId) : modelId } : {}),
    ...(thinkingLevel ? { currentThinking: thinkingLevel } : {}),
  };
}
