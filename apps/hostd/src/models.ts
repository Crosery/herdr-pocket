import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  OMP_MODEL_ROLES,
  buildHarnessSwitchCommands,
  clampThinkingLevel,
  inferAgentModelAndThinking,
  inferModelThinkingLevels,
  isNonReasoningModelName,
  normalizeSwitchHarness,
  resolveThinkingLevelsForModel,
  stripModelEffortSuffix,
  type Agent,
  type AgentModelOption,
  type AgentModelsResult,
  type AgentThinkingLevel,
  type OmpModelRole,
} from "@herdr-pocket/protocol";
import { findPrograms } from "./create.ts";
import { endsInPanel } from "./hc.ts";
import { harnessId } from "./uniflo.ts";

const execFileAsync = promisify(execFile);

const CATALOG_CACHE_MS = 5 * 60_000;
const OMP_CLI_TIMEOUT_MS = 4_000;
const MAX_MODELS = 500;
const SESSION_TAIL_BYTES = 128 * 1024;
const cliCatalogCache = new Map<string, { at: number; models: AgentModelOption[] }>();
let ompRefreshInflight: Promise<AgentModelOption[]> | null = null;

function normHarnessKey(raw: string): string {
  return normalizeSwitchHarness((harnessId(raw) ?? raw).trim());
}

function extractThinkingList(raw: unknown): string[] | undefined {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { efforts?: unknown }).efforts)
      ? (raw as { efforts: unknown[] }).efforts
      : null;
  if (!arr) return undefined;
  const cleaned = arr
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().toLowerCase());
  return cleaned.length ? cleaned : undefined;
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
    const thinkingLevels = reasoning === false ? undefined : extractThinkingList(item.thinking);
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

function stripYamlScalar(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if ((s.startsWith('"') && s.length >= 2) || (s.startsWith("'") && s.length >= 2)) {
    const q = s[0]!;
    const end = s.indexOf(q, 1);
    if (end > 0) return s.slice(1, end).trim();
  }
  const commentIdx = s.search(/\s+#/);
  return (commentIdx >= 0 ? s.slice(0, commentIdx) : s).trim();
}

function parseYamlInlineArray(raw: string): string[] | undefined {
  const s = stripYamlScalar(raw);
  if (!s.startsWith("[") || !s.endsWith("]")) return undefined;
  const inner = s.slice(1, -1).trim();
  if (!inner) return undefined;
  const items = inner
    .split(",")
    .map((p) => stripYamlScalar(p).toLowerCase())
    .filter(Boolean);
  return items.length ? items : undefined;
}

/**
 * Parses non-secret model entries (`provider`, `id`, `name`, `contextWindow`, `reasoning`, `thinking.efforts` / `thinking`)
 * from `~/.omp/agent/models.yml`. Never reads or emits `auth`, `apiKey`, `token`, `secret`, `headers`, or URLs.
 */
export function parseOmpModelsYml(raw: string): AgentModelOption[] {
  interface Draft {
    id?: string;
    name?: string;
    kind?: string;
    contextWindow?: number;
    reasoning?: boolean;
    thinkingLevels?: string[];
  }

  const out: AgentModelOption[] = [];
  let inProviders = false;
  let providerIndent = -1;
  let currentProvider = "";
  let inModels = false;
  let modelsIndent = -1;
  let itemIndent = -1;
  let draft: Draft | null = null;
  let inThinking = false;
  let thinkingIndent = -1;
  let inEfforts = false;
  let effortsIndent = -1;
  let ignoredIndent = -1;

  const flush = () => {
    if (!draft || !currentProvider) {
      draft = null;
      return;
    }
    if (draft.kind && draft.kind !== "chat") {
      draft = null;
      return;
    }
    const rawId = draft.id?.trim();
    if (!rawId) {
      draft = null;
      return;
    }
    const prefix = `${currentProvider}/`;
    const id = rawId.startsWith(prefix) ? rawId : `${prefix}${rawId}`;
    const label = draft.name?.trim() || rawId;
    const thinkingLevels = draft.reasoning === false ? undefined : draft.thinkingLevels;
    out.push({
      id,
      label,
      provider: currentProvider,
      ...(draft.contextWindow ? { contextWindow: draft.contextWindow } : {}),
      ...(draft.reasoning !== undefined ? { reasoning: draft.reasoning } : {}),
      ...(thinkingLevels?.length ? { thinkingLevels } : {}),
      source: "catalog",
    });
    draft = null;
  };

  const applyDraftProp = (key: string, valRaw: string, indent: number) => {
    if (!draft) return;
    const val = stripYamlScalar(valRaw);
    switch (key) {
      case "id":
        if (val) draft.id = val;
        return;
      case "name":
        if (val) draft.name = val;
        return;
      case "kind":
        if (val) draft.kind = val.toLowerCase();
        return;
      case "contextWindow": {
        const n = Number(val);
        if (Number.isFinite(n) && n > 0) draft.contextWindow = Math.round(n);
        return;
      }
      case "reasoning": {
        const low = val.toLowerCase();
        if (low === "true") draft.reasoning = true;
        else if (low === "false") draft.reasoning = false;
        return;
      }
      case "thinking": {
        const inline = parseYamlInlineArray(valRaw);
        if (inline) {
          draft.thinkingLevels = inline;
        } else if (!val) {
          inThinking = true;
          thinkingIndent = indent;
          inEfforts = false;
          effortsIndent = -1;
        } else {
          draft.thinkingLevels = undefined;
        }
        return;
      }
      default:
        // Intentionally ignore non-whitelisted keys (including cost, input, auth, apiKey, token, secret, headers).
        if (!val) ignoredIndent = indent;
    }
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.search(/\S/);

    if (indent === 0) {
      flush();
      inModels = false;
      inThinking = false;
      inEfforts = false;
      ignoredIndent = -1;
      currentProvider = "";
      providerIndent = -1;
      inProviders = /^providers\s*:\s*(?:#.*)?$/.test(trimmed);
      continue;
    }

    if (!inProviders) continue;

    if (providerIndent === -1) providerIndent = indent;
    if (indent === providerIndent) {
      flush();
      inModels = false;
      inThinking = false;
      inEfforts = false;
      ignoredIndent = -1;
      const pm = /^([A-Za-z0-9._-]+|"[^"]+"|'[^']+')\s*:\s*(?:#.*)?$/.exec(trimmed);
      currentProvider = pm ? stripYamlScalar(pm[1]!) : "";
      continue;
    }

    if (!currentProvider) continue;

    if (inModels && indent <= modelsIndent && !trimmed.startsWith("-")) {
      flush();
      inModels = false;
      inThinking = false;
      inEfforts = false;
      ignoredIndent = -1;
    }

    if (!inModels) {
      const mm = /^models\s*:\s*(.*)$/.exec(trimmed);
      if (mm && !stripYamlScalar(mm[1] ?? "")) {
        inModels = true;
        modelsIndent = indent;
        itemIndent = -1;
      }
      continue;
    }

    const listMatch = /^-\s*(.*)$/.exec(trimmed);
    if (listMatch && (itemIndent === -1 || indent === itemIndent)) {
      flush();
      itemIndent = indent;
      draft = {};
      inThinking = false;
      thinkingIndent = -1;
      inEfforts = false;
      effortsIndent = -1;
      ignoredIndent = -1;
      const rest = listMatch[1]!.trim();
      if (rest && !rest.startsWith("#")) {
        const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rest);
        if (kv) applyDraftProp(kv[1]!, kv[2] ?? "", indent + 2);
      }
      continue;
    }

    if (!draft) continue;

    if (inThinking && indent <= thinkingIndent) {
      inThinking = false;
      inEfforts = false;
      effortsIndent = -1;
    }
    if (inEfforts && indent <= effortsIndent && !trimmed.startsWith("-")) {
      inEfforts = false;
    }
    if (ignoredIndent !== -1 && indent <= ignoredIndent) {
      ignoredIndent = -1;
    }

    if (inThinking) {
      if (listMatch) {
        const item = stripYamlScalar(listMatch[1] ?? "").toLowerCase();
        if (item) {
          draft.thinkingLevels ??= [];
          if (!draft.thinkingLevels.includes(item)) draft.thinkingLevels.push(item);
        }
        continue;
      }
      const em = /^efforts\s*:\s*(.*)$/.exec(trimmed);
      if (em) {
        const inline = parseYamlInlineArray(em[1] ?? "");
        if (inline) {
          draft.thinkingLevels = inline;
        } else if (!stripYamlScalar(em[1] ?? "")) {
          inEfforts = true;
          effortsIndent = indent;
        }
        continue;
      }
      continue;
    }

    if (ignoredIndent !== -1) continue;

    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (kv) applyDraftProp(kv[1]!, kv[2] ?? "", indent);
  }

  flush();
  return out.slice(0, MAX_MODELS);
}

/** Reads non-secret model definitions from `~/.omp/agent/models.yml` if present. */
export function readOmpModelsYml(homeDir = homedir()): AgentModelOption[] {
  const p = join(homeDir, ".omp", "agent", "models.yml");
  if (!existsSync(p)) return [];
  try {
    return parseOmpModelsYml(readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

const AGY_EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const AGY_EFFORT_SUFFIX_RE = /^(.+)-(minimal|low|medium|high|xhigh|max)$/i;

/** Parses `agy models` (`<id>\t<label>`) output and groups sibling effort variants by stem. */
export function parseAgyModelsText(raw: string): AgentModelOption[] {
  const entries: Array<{ id: string; label: string; stem?: string }> = [];
  const groups = new Map<string, Map<string, string>>();

  for (const line of raw.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || (/^model\b/i.test(clean) && !clean.includes("\t"))) continue;
    const [idPart, labelPart] = clean.split("\t");
    const id = idPart?.trim();
    if (!id || /\s/.test(id)) continue;
    const label = labelPart?.trim() || id;
    const m = AGY_EFFORT_SUFFIX_RE.exec(id);
    if (m?.[1] && m[2]) {
      const stem = m[1].toLowerCase();
      const effort = m[2].toLowerCase();
      let map = groups.get(stem);
      if (!map) {
        map = new Map();
        groups.set(stem, map);
      }
      if (!map.has(effort)) map.set(effort, id);
      entries.push({ id, label, stem });
    } else {
      entries.push({ id, label });
    }
  }

  return entries.map((e) => {
    const stemKey = e.stem ?? e.id.toLowerCase();
    const siblingMap = groups.get(stemKey);
    if (siblingMap && siblingMap.size > 0) {
      const thinkingLevels = AGY_EFFORT_ORDER.filter((lvl) => siblingMap.has(lvl));
      const effortModelMap: Partial<Record<AgentThinkingLevel, string>> = {};
      for (const lvl of thinkingLevels) {
        const target = siblingMap.get(lvl);
        if (target) effortModelMap[lvl] = target;
      }
      return {
        id: e.id,
        label: e.label,
        provider: "antigravity",
        reasoning: thinkingLevels.length > 0,
        ...(thinkingLevels.length > 0 ? { thinkingLevels: [...thinkingLevels], effortModelMap } : {}),
        source: "catalog",
      };
    }

    const inferred = inferModelThinkingLevels("antigravity", e.id);
    return {
      id: e.id,
      label: e.label,
      provider: "antigravity",
      reasoning: inferred.length > 0,
      ...(inferred.length > 0 ? { thinkingLevels: inferred } : {}),
      source: "catalog",
    };
  });
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

async function loadOmpCliCatalogOnce(): Promise<AgentModelOption[]> {
  const found = await findPrograms(["omp"]);
  const bin = found.get("omp");
  if (!bin) return [];
  // Keep extensions enabled so custom providers appear; fall back to --no-extensions only on fast non-timeout errors.
  try {
    const { stdout } = await execFileAsync(bin, ["models", "--json"], {
      timeout: OMP_CLI_TIMEOUT_MS,
      maxBuffer: 6 * 1024 * 1024,
    });
    const parsed = parseOmpModelsJson(stdout);
    if (parsed.length) return parsed;
  } catch (err) {
    const e = err as { killed?: boolean; signal?: string | null };
    if (e?.killed || e?.signal) return [];
  }
  try {
    const { stdout } = await execFileAsync(bin, ["models", "--json", "--no-extensions"], {
      timeout: OMP_CLI_TIMEOUT_MS,
      maxBuffer: 6 * 1024 * 1024,
    });
    return parseOmpModelsJson(stdout);
  } catch {
    return [];
  }
}

function refreshOmpCatalogBackground(): Promise<AgentModelOption[]> {
  if (ompRefreshInflight) return ompRefreshInflight;
  ompRefreshInflight = loadOmpCliCatalogOnce()
    .then((models) => {
      if (models.length > 0) {
        cliCatalogCache.set("omp", { at: Date.now(), models });
      }
      return models;
    })
    .catch(() => [])
    .finally(() => {
      ompRefreshInflight = null;
    });
  return ompRefreshInflight;
}

async function getOmpCatalog(): Promise<AgentModelOption[]> {
  const cached = cliCatalogCache.get("omp");
  if (cached && Date.now() - cached.at < CATALOG_CACHE_MS) return cached.models;
  const models = await refreshOmpCatalogBackground();
  return models.length ? models : (cached?.models ?? []);
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

function extractYamlTrailingComment(valRaw: string): string {
  const s = valRaw.trimStart();
  if (!s) return "";
  if (s.startsWith('"') || s.startsWith("'")) {
    const q = s[0]!;
    const end = s.indexOf(q, 1);
    if (end > 0) {
      const rest = s.slice(end + 1);
      const cm = /^(\s+#.*)$/.exec(rest);
      return cm?.[1] ?? "";
    }
  }
  const idx = s.search(/\s+#/);
  return idx >= 0 ? s.slice(idx) : "";
}

function formatYamlScalar(val: string): string {
  if (/[:]\s|[#'"\[\]{}]|^[-*&!%@?]|\s$/.test(val) || /^\s/.test(val)) {
    return JSON.stringify(val);
  }
  return val;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseOmpConfigYmlRaw(raw: string): {
  modelRoles: Record<string, string>;
  models: AgentModelOption[];
  defaultModel?: string;
  defaultThinking?: string;
} {
  const models: AgentModelOption[] = [];
  const modelRoles: Record<string, string> = {};
  let defaultModel: string | undefined;
  let defaultThinking: string | undefined;

  const thinkMatch = /^\s*defaultThinkingLevel\s*:\s*([^\r\n]+)/m.exec(raw);
  if (thinkMatch?.[1]) {
    const cleanThink = stripYamlScalar(thinkMatch[1]).toLowerCase();
    if (cleanThink) defaultThinking = cleanThink;
  }

  const lines = raw.split(/\r?\n/);
  let inRoles = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^modelRoles\s*:\s*(?:#.*)?$/.test(trimmed) && /^\S/.test(line)) {
      inRoles = true;
      continue;
    }
    if (inRoles) {
      if (/^\S/.test(line)) {
        inRoles = false;
        continue;
      }
      const m = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const role = m[1]!;
      const scalar = stripYamlScalar(m[2] ?? "");
      if (!scalar) continue;
      modelRoles[role] = scalar;
      const { id, effort } = splitModelAndEffort(scalar);
      if (!id) continue;
      const provider = id.includes("/") ? id.split("/")[0] : "omp";
      if (role === "default" && !defaultModel) {
        defaultModel = id;
        if (!defaultThinking && effort) defaultThinking = effort;
      }
      models.push({ id, label: id, provider, source: "recent" });
    }
  }

  return { modelRoles, models, defaultModel, defaultThinking };
}

/**
 * Safely updates `modelRoles.<slot>` in `~/.omp/agent/config.yml`, preserving all other keys,
 * comments, blank lines, and indentation.
 */
export function updateOmpRoleModel(
  homeDir: string,
  roleSlot: OmpModelRole,
  modelId: string,
): Record<string, string> {
  if (!OMP_MODEL_ROLES.includes(roleSlot)) {
    throw new Error(`不支持的 OMP 角色槽位：${roleSlot}`);
  }
  const cleanModel = modelId.trim();
  if (!cleanModel || /[\r\n]/.test(cleanModel)) {
    throw new Error("角色模型 ID 无效");
  }

  const ymlPath = join(homeDir, ".omp", "agent", "config.yml");
  mkdirSync(dirname(ymlPath), { recursive: true });
  const formatted = formatYamlScalar(cleanModel);

  if (!existsSync(ymlPath)) {
    const content = `modelRoles:\n  ${roleSlot}: ${formatted}\n`;
    writeFileSync(ymlPath, content, "utf8");
    return { [roleSlot]: cleanModel };
  }

  const raw = readFileSync(ymlPath, "utf8");
  if (!raw.trim()) {
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const content = `modelRoles:${eol}  ${roleSlot}: ${formatted}${eol}`;
    writeFileSync(ymlPath, content, "utf8");
    return { [roleSlot]: cleanModel };
  }

  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = raw.endsWith("\n");
  const lines = raw.split(/\r?\n/);
  if (hadTrailingNewline && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  let rolesHeaderIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^modelRoles\s*:\s*(?:\{\s*\}\s*)?(?:#.*)?$/.test(line)) {
      rolesHeaderIdx = i;
      break;
    }
  }

  if (rolesHeaderIdx >= 0) {
    const headerLine = lines[rolesHeaderIdx]!;
    if (/^modelRoles\s*:\s*\{\s*\}/.test(headerLine)) {
      const commentIdx = headerLine.indexOf("#");
      const comment = commentIdx >= 0 ? ` ${headerLine.slice(commentIdx)}` : "";
      lines[rolesHeaderIdx] = `modelRoles:${comment}`;
    }

    let childIndent = "  ";
    let sawChildIndent = false;
    let lastEntryIdx = rolesHeaderIdx;
    let replaced = false;
    const slotRe = new RegExp(`^([ \\t]+)${escapeRegExp(roleSlot)}(\\s*:\\s*)(.*)$`);

    for (let i = rolesHeaderIdx + 1; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (/^\S/.test(line)) break;

      const indentMatch = /^([ \t]+)/.exec(line);
      if (indentMatch && !sawChildIndent) {
        childIndent = indentMatch[1]!;
        sawChildIndent = true;
      }
      lastEntryIdx = i;

      const rm = slotRe.exec(line);
      if (rm) {
        const trailing = extractYamlTrailingComment(rm[3] ?? "");
        lines[i] = `${rm[1]}${roleSlot}: ${formatted}${trailing}`;
        replaced = true;
        break;
      }
    }

    if (!replaced) {
      lines.splice(lastEntryIdx + 1, 0, `${childIndent}${roleSlot}: ${formatted}`);
    }
  } else {
    if (lines.length > 0 && lines[lines.length - 1]!.trim() !== "") {
      lines.push("");
    }
    lines.push("modelRoles:");
    lines.push(`  ${roleSlot}: ${formatted}`);
  }

  const next = `${lines.join(eol)}${hadTrailingNewline ? eol : ""}`;
  writeFileSync(ymlPath, next, "utf8");
  return parseOmpConfigYmlRaw(next).modelRoles;
}

/** Reads `~/.omp/agent/config.yml` modelRoles + defaultThinkingLevel and `~/.omp/agent/agent.db` MRU selectors. */
export async function readOmpLocalConfig(homeDir = homedir()): Promise<{
  models: AgentModelOption[];
  modelRoles: Record<string, string>;
  defaultModel?: string;
  defaultThinking?: string;
}> {
  const models: AgentModelOption[] = [];
  let modelRoles: Record<string, string> = {};
  let defaultModel: string | undefined;
  let defaultThinking: string | undefined;

  const ymlPath = join(homeDir, ".omp", "agent", "config.yml");
  if (existsSync(ymlPath)) {
    try {
      const parsed = parseOmpConfigYmlRaw(readFileSync(ymlPath, "utf8"));
      modelRoles = parsed.modelRoles;
      defaultModel = parsed.defaultModel;
      defaultThinking = parsed.defaultThinking;
      models.push(...parsed.models);
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

  return { models, modelRoles, defaultModel, defaultThinking };
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
  sessionSourcePath?(sessionKey: string): Promise<string | undefined>;
}

export function clearModelsCacheForTest(): void {
  cliCatalogCache.clear();
  ompRefreshInflight = null;
}

interface ParsedModelSpeedMeta {
  clean: string;
  baseLeaf: string;
  tier: "" | "fast" | "ultrafast";
  providerBase: string;
  providerSegments: string[];
}

function parseModelSpeedMeta(raw: string): ParsedModelSpeedMeta {
  const clean = stripModelEffortSuffix(raw).trim().toLowerCase();
  const segments = clean.split("/").filter(Boolean);
  const leaf = segments[segments.length - 1] ?? "";
  const parentSeg = segments.length >= 2 ? segments[segments.length - 2]! : "";
  const providerSegments = segments.slice(0, -1).map((s) => s.replace(/-(?:ultra)?fast$/i, ""));

  let tier: "" | "fast" | "ultrafast" = "";
  let baseLeaf = leaf;
  if (leaf.endsWith("-ultrafast")) {
    tier = "ultrafast";
    baseLeaf = leaf.slice(0, -"-ultrafast".length);
  } else if (leaf.endsWith("-fast")) {
    tier = "fast";
    baseLeaf = leaf.slice(0, -"-fast".length);
  } else if (parentSeg.endsWith("-ultrafast")) {
    tier = "ultrafast";
  } else if (parentSeg.endsWith("-fast")) {
    tier = "fast";
  }

  const providerBase = parentSeg.replace(/-(?:ultra)?fast$/i, "");
  return { clean, baseLeaf, tier, providerBase, providerSegments };
}

export function findCatalogMatch(rawId: string, catalog: readonly AgentModelOption[]): AgentModelOption | undefined {
  const qMeta = parseModelSpeedMeta(rawId);
  const q = qMeta.clean;
  if (!q) return undefined;

  const exact = catalog.find((c) => c.id.toLowerCase() === q);
  if (exact) return exact;

  const suffix = catalog.find((c) => c.id.toLowerCase().endsWith(`/${q}`));
  if (suffix) return suffix;

  const parsedCatalog = catalog.map((c) => ({ item: c, meta: parseModelSpeedMeta(c.id) }));

  if (qMeta.providerBase) {
    const provAndTier = parsedCatalog.find(
      ({ meta }) =>
        meta.baseLeaf === qMeta.baseLeaf &&
        meta.tier === qMeta.tier &&
        meta.providerSegments.includes(qMeta.providerBase),
    );
    if (provAndTier) return provAndTier.item;
  }

  const sameTier = parsedCatalog.find(({ meta }) => meta.baseLeaf === qMeta.baseLeaf && meta.tier === qMeta.tier);
  if (sameTier) return sameTier.item;

  if (qMeta.tier) {
    if (qMeta.providerBase) {
      const provBaseLeaf = parsedCatalog.find(
        ({ meta }) => meta.baseLeaf === qMeta.baseLeaf && meta.providerSegments.includes(qMeta.providerBase),
      );
      if (provBaseLeaf) return provBaseLeaf.item;
    }
    const anyBaseLeaf = parsedCatalog.find(({ meta }) => meta.baseLeaf === qMeta.baseLeaf);
    if (anyBaseLeaf) return anyBaseLeaf.item;
  }

  return undefined;
}

function sessionSearchRoots(homeDir: string, harnessHint: string): string[] {
  const h = normHarnessKey(harnessHint);
  const all = [
    join(homeDir, ".omp", "agent", "sessions"),
    join(homeDir, ".pi", "agent", "sessions"),
    join(homeDir, ".claude", "projects"),
    join(homeDir, ".codex", "sessions"),
  ];
  if (h === "omp") return [all[0]!];
  if (h === "pi") return [all[1]!];
  if (h === "claude") return [all[2]!];
  if (h === "codex") return [all[3]!];
  return all;
}

function findSessionJsonlPath(sessionKey: string, harnessHint: string, homeDir: string): string | undefined {
  const colon = sessionKey.indexOf(":");
  const prefix = colon >= 0 ? sessionKey.slice(0, colon).trim() : "";
  const id = (colon >= 0 ? sessionKey.slice(colon + 1) : sessionKey).trim();
  if (!id || id.length < 4) return undefined;

  const exactMatches: Array<{ path: string; mtime: number }> = [];
  const prefixMatches: Array<{ path: string; mtime: number }> = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 4 || !existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === ".git" || ent.name === "node_modules") continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!ent.name.endsWith(".jsonl") || ent.name === "changes.jsonl") continue;
      const lowerName = ent.name.toLowerCase();
      const lowerId = id.toLowerCase();
      const isExact =
        lowerName === `${lowerId}.jsonl` ||
        lowerName.endsWith(`_${lowerId}.jsonl`) ||
        lowerName.endsWith(`-${lowerId}.jsonl`);
      const isPrefix =
        !isExact &&
        lowerId.length >= 6 &&
        (lowerName.startsWith(lowerId) || lowerName.includes(`_${lowerId}`) || lowerName.includes(`-${lowerId}`));
      if (!isExact && !isPrefix) continue;
      try {
        const mtime = statSync(full).mtimeMs;
        (isExact ? exactMatches : prefixMatches).push({ path: full, mtime });
      } catch {
        /* ignore unreadable */
      }
    }
  };

  for (const root of sessionSearchRoots(homeDir, harnessHint || prefix)) {
    walk(root, 0);
  }
  const pool = exactMatches.length ? exactMatches : prefixMatches;
  if (!pool.length) return undefined;
  pool.sort((a, b) => b.mtime - a.mtime);
  return pool[0]!.path;
}

function readTailText(filePath: string, maxBytes = SESSION_TAIL_BYTES): string {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= 0) return "";
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    const bytesRead = readSync(fd, buf, 0, len, start);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

/**
 * Tail-reads the newest ~128 KB of a live session `.jsonl` file backwards to extract the latest
 * `thinking_level_change`, `model_change`, Claude effort/thinkingMetadata, or Codex `reasoning_effort`.
 */
export async function readSessionLiveModelAndThinking(opts: {
  sessionKey?: string;
  harness?: string;
  homeDir?: string;
  sessionSourcePath?: string;
}): Promise<{ currentModel?: string; currentThinking?: string }> {
  const home = opts.homeDir ?? homedir();
  let filePath: string | undefined;
  if (opts.sessionSourcePath?.trim()) {
    try {
      if (existsSync(opts.sessionSourcePath) && statSync(opts.sessionSourcePath).isFile()) {
        filePath = opts.sessionSourcePath;
      }
    } catch {
      /* fall back to session scan */
    }
  }
  if (!filePath && opts.sessionKey?.trim()) {
    filePath = findSessionJsonlPath(opts.sessionKey.trim(), opts.harness ?? "", home);
  }
  if (!filePath) return {};

  let text = "";
  try {
    text = readTailText(filePath);
  } catch {
    return {};
  }
  if (!text) return {};

  let currentModel: string | undefined;
  let currentThinking: string | undefined;
  const lines = text.split(/\r?\n/);

  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]?.trim();
    if (!raw || !raw.startsWith("{")) continue;
    let obj: Record<string, any>;
    try {
      obj = JSON.parse(raw) as Record<string, any>;
    } catch {
      continue;
    }

    if (currentThinking === undefined) {
      let t: string | undefined;
      if (obj.type === "thinking_level_change") {
        t = typeof obj.thinkingLevel === "string" ? obj.thinkingLevel : typeof obj.level === "string" ? obj.level : undefined;
      } else if (obj.thinkingMetadata && typeof obj.thinkingMetadata === "object") {
        if (obj.thinkingMetadata.disabled === true) {
          t = "off";
        } else if (typeof obj.thinkingMetadata.level === "string") {
          t = obj.thinkingMetadata.level;
        } else if (typeof obj.thinkingMetadata.effort === "string") {
          t = obj.thinkingMetadata.effort;
        }
      } else if (typeof obj.perTurnEffort === "string") {
        t = obj.perTurnEffort;
      } else if (typeof obj.effort === "string") {
        t = obj.effort;
      } else if (obj.type === "turn_context" && obj.payload && typeof obj.payload === "object") {
        t =
          (typeof obj.payload.reasoning_effort === "string" && obj.payload.reasoning_effort) ||
          (typeof obj.payload.effort === "string" && obj.payload.effort) ||
          (typeof obj.payload.collaboration_mode?.settings?.reasoning_effort === "string" &&
            obj.payload.collaboration_mode.settings.reasoning_effort) ||
          undefined;
      } else if (typeof obj.reasoning_effort === "string") {
        t = obj.reasoning_effort;
      } else if (typeof obj.payload?.reasoning_effort === "string") {
        t = obj.payload.reasoning_effort;
      }
      if (t && t.trim()) currentThinking = t.trim().toLowerCase();
    }

    if (currentModel === undefined) {
      let m: string | undefined;
      if (obj.type === "model_change") {
        if (typeof obj.model === "string" && obj.model.trim()) {
          m = obj.model.trim();
        } else if (typeof obj.modelId === "string" && obj.modelId.trim()) {
          const mid = obj.modelId.trim();
          const prov = typeof obj.provider === "string" ? obj.provider.trim() : "";
          m = prov && !mid.startsWith(`${prov}/`) ? `${prov}/${mid}` : mid;
        }
      } else if (typeof obj.requestedModel === "string" && obj.requestedModel.trim() && obj.requestedModel !== "<synthetic>") {
        m = obj.requestedModel.trim();
      } else if (typeof obj.message?.model === "string" && obj.message.model.trim() && obj.message.model !== "<synthetic>") {
        m = obj.message.model.trim();
      } else if (obj.type === "turn_context" && obj.payload && typeof obj.payload === "object") {
        const pm =
          (typeof obj.payload.model === "string" && obj.payload.model) ||
          (typeof obj.payload.collaboration_mode?.settings?.model === "string" && obj.payload.collaboration_mode.settings.model) ||
          "";
        if (pm.trim()) m = pm.trim();
      }
      if (m) {
        const split = splitModelAndEffort(m);
        if (split.id) {
          currentModel = split.id;
          if (currentThinking === undefined && split.effort) currentThinking = split.effort;
        }
      }
    }

    if (currentModel !== undefined && currentThinking !== undefined) break;
  }

  return {
    ...(currentModel ? { currentModel } : {}),
    ...(currentThinking ? { currentThinking } : {}),
  };
}

function prependOmpOff(levels: readonly string[]): string[] {
  return levels.some((l) => l.toLowerCase() === "off") ? [...levels] : ["off", ...levels];
}

function enrichOmpYmlEntry(
  yItem: AgentModelOption,
  cachedOmpCatalog: readonly AgentModelOption[],
): AgentModelOption {
  if (yItem.reasoning === false || yItem.thinkingLevels?.length) {
    return yItem;
  }
  const exact = cachedOmpCatalog.find((c) => c.id.toLowerCase() === yItem.id.toLowerCase());
  const cachedMatch = exact ?? (cachedOmpCatalog.length > 0 ? findCatalogMatch(yItem.id, cachedOmpCatalog) : undefined);
  if (cachedMatch?.reasoning === false) {
    return { ...yItem, reasoning: false };
  }
  if (cachedMatch?.thinkingLevels?.length) {
    return {
      ...yItem,
      reasoning: yItem.reasoning ?? true,
      thinkingLevels: prependOmpOff(cachedMatch.thinkingLevels),
    };
  }
  const inferred = inferModelThinkingLevels("oh-my-pi", yItem.id, { reasoning: yItem.reasoning });
  if (inferred.length === 0) {
    return { ...yItem, reasoning: false };
  }
  return {
    ...yItem,
    reasoning: yItem.reasoning ?? true,
    thinkingLevels: prependOmpOff(inferred),
  };
}

export async function getAgentModels(
  agent: Agent,
  opts: {
    uniflo?: ModelsUnifloLike;
    unifloReady?: boolean;
    readCatalog?: () => Promise<AgentModelOption[]>;
    refreshOmpCatalog?: () => Promise<AgentModelOption[]>;
    homeDir?: string;
    currentModelOverride?: string;
    currentThinkingOverride?: string;
    sessionSourcePath?: string;
    hasReasoningEvents?: boolean;
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
  const localCfg = readLocalConfiguredDetails(opts.homeDir);

  const sessionSourcePromise =
    opts.sessionSourcePath !== undefined
      ? Promise.resolve(opts.sessionSourcePath)
      : uniflo?.sessionSourcePath && agent.sessionKey
        ? uniflo.sessionSourcePath(agent.sessionKey).catch(() => undefined)
        : Promise.resolve(undefined);

  // Read local OMP config/models/agent.db first (<10ms) so configured OMP hosts never block 15-30s on CLI catalog.
  const [ompLocal, ymlCatalog] =
    hNorm === "omp"
      ? await Promise.all([readOmpLocalConfig(opts.homeDir), Promise.resolve(readOmpModelsYml(opts.homeDir))])
      : [{ models: [], modelRoles: {} as Record<string, string> }, [] as AgentModelOption[]];

  const loadOmpCatalogFast = async (): Promise<AgentModelOption[]> => {
    const cached = cliCatalogCache.get("omp");
    const hasLocalModels = ymlCatalog.length > 0 || ompLocal.models.length > 0;
    const triggerRefresh = async (): Promise<AgentModelOption[]> => {
      if (!opts.refreshOmpCatalog) return refreshOmpCatalogBackground();
      const loaded = await opts.refreshOmpCatalog();
      if (loaded.length > 0) cliCatalogCache.set("omp", { at: Date.now(), models: loaded });
      return loaded;
    };
    if (hasLocalModels) {
      if (!cached || Date.now() - cached.at >= CATALOG_CACHE_MS) {
        void triggerRefresh().catch(() => []);
      }
      return cached?.models ?? [];
    }
    if (cached && Date.now() - cached.at < CATALOG_CACHE_MS) return cached.models;
    const loaded = await triggerRefresh().catch(() => []);
    return loaded.length ? loaded : (cached?.models ?? []);
  };

  const [harnessRecent, allRecent, catalog, resolvedSourcePath] = await Promise.all([
    uniflo && hQuery ? uniflo.recentModels(hQuery).catch(() => []) : Promise.resolve([]),
    uniflo ? uniflo.recentModels().catch(() => []) : Promise.resolve([]),
    opts.readCatalog
      ? opts.readCatalog().catch(() => [])
      : hNorm === "omp"
        ? loadOmpCatalogFast()
        : hNorm === "pi"
          ? getPiCatalog()
          : hNorm === "antigravity"
            ? getAgyCatalog()
            : hNorm === "opencode"
              ? getOpencodeCatalog()
              : Promise.resolve([]),
    sessionSourcePromise,
  ]);

  const liveSession =
    agent.sessionKey || resolvedSourcePath
      ? await readSessionLiveModelAndThinking({
          sessionKey: agent.sessionKey,
          harness: agent.harness,
          homeDir: opts.homeDir,
          sessionSourcePath: resolvedSourcePath,
        })
      : {};

  let rawModel = opts.currentModelOverride?.trim() || "";
  if (!rawModel) {
    const agentM = agent.model?.trim() || "";
    const liveM = liveSession.currentModel?.trim() || "";
    if (liveM) {
      rawModel =
        agentM && !liveM.includes("/") && agentM.toLowerCase().endsWith(`/${liveM.toLowerCase()}`)
          ? agentM
          : liveM;
    } else {
      rawModel = agentM;
    }
  }
  if (hNorm === "omp" && rawModel.startsWith("@")) {
    const roleTarget = ompLocal.modelRoles[rawModel.slice(1).toLowerCase()];
    if (roleTarget) rawModel = roleTarget;
  }
  const parsedCurrent = rawModel ? splitModelAndEffort(rawModel) : { id: "", effort: undefined };
  const currentModel = parsedCurrent.id || (hNorm === "omp" ? ompLocal.defaultModel : undefined) || undefined;
  const inferred = inferAgentModelAndThinking(agent.harness, currentModel, {
    hasReasoningEvents: opts.hasReasoningEvents,
  });

  let currentThinking =
    opts.currentThinkingOverride?.trim().toLowerCase() ||
    parsedCurrent.effort ||
    liveSession.currentThinking ||
    (hNorm === "omp" ? ompLocal.defaultThinking : undefined) ||
    localCfg.thinkingByHarness[hNorm] ||
    inferred.currentThinking ||
    undefined;

  const cachedOmpCatalog = hNorm === "omp" ? (catalog.length > 0 ? catalog : (cliCatalogCache.get("omp")?.models ?? [])) : [];
  const rawHadExplicitThinking = new Set(
    ymlCatalog.filter((y) => Boolean(y.thinkingLevels?.length)).map((y) => y.id.toLowerCase()),
  );
  const enrichedYmlCatalog = hNorm === "omp" ? ymlCatalog.map((y) => enrichOmpYmlEntry(y, cachedOmpCatalog)) : ymlCatalog;

  const combinedCatalog: AgentModelOption[] = catalog.map((c) => ({ ...c }));
  const catIdx = new Map<string, number>();
  for (let i = 0; i < combinedCatalog.length; i++) {
    catIdx.set(combinedCatalog[i]!.id.toLowerCase(), i);
  }
  for (const yItem of enrichedYmlCatalog) {
    const yKey = yItem.id.toLowerCase();
    const existingIdx = catIdx.get(yKey);
    if (existingIdx !== undefined) {
      const cur = combinedCatalog[existingIdx]!;
      const shouldUseEnrichedThinking =
        cur.reasoning !== false &&
        Boolean(yItem.thinkingLevels?.length) &&
        (!cur.thinkingLevels?.length || !rawHadExplicitThinking.has(yKey));
      combinedCatalog[existingIdx] = {
        ...cur,
        ...(cur.provider ? {} : yItem.provider ? { provider: yItem.provider } : {}),
        ...(cur.contextWindow ? {} : yItem.contextWindow ? { contextWindow: yItem.contextWindow } : {}),
        ...(cur.reasoning !== undefined ? {} : yItem.reasoning !== undefined ? { reasoning: yItem.reasoning } : {}),
        ...(shouldUseEnrichedThinking ? { thinkingLevels: yItem.thinkingLevels } : {}),
      };
    } else {
      catIdx.set(yKey, combinedCatalog.length);
      combinedCatalog.push(yItem);
    }
  }

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

  for (let i = 0; i < merged.length; i++) {
    const item = merged[i]!;
    if (item.thinkingLevels === undefined && item.reasoning !== false) {
      const itemLevels = inferModelThinkingLevels(agent.harness, item.id, {
        reasoning: item.reasoning,
        hasReasoningEvents: i === 0 ? opts.hasReasoningEvents : undefined,
      });
      if (itemLevels.length > 0) {
        merged[i] = { ...item, reasoning: item.reasoning ?? true, thinkingLevels: itemLevels };
      } else if (!(i === 0 && opts.hasReasoningEvents) && isNonReasoningModelName(item.id)) {
        merged[i] = { ...item, reasoning: false };
      }
    }
  }

  const finalModel = merged[0]?.source === "current" ? merged[0].id : currentModel;
  const resolvedThinkingLevels = resolveThinkingLevelsForModel(
    {
      harness: agent.harness,
      models: merged,
      currentModel: finalModel,
      modelRoles: hNorm === "omp" ? ompLocal.modelRoles : undefined,
      hasReasoningEvents: opts.hasReasoningEvents,
    },
    finalModel,
  );
  const thinkingLevels = resolvedThinkingLevels.length > 0 ? resolvedThinkingLevels : undefined;
  currentThinking = thinkingLevels ? clampThinkingLevel(thinkingLevels, currentThinking) : undefined;

  return {
    harness: agent.harness,
    ...(finalModel ? { currentModel: finalModel } : {}),
    ...(currentThinking ? { currentThinking } : {}),
    ...(thinkingLevels?.length ? { thinkingLevels, canSwitchThinking: canSwitch, thinkingLabel: "思考等级" } : { canSwitchThinking: false }),
    canSwitch,
    ...(reason ? { reason } : {}),
    ...(hNorm === "omp" && Object.keys(ompLocal.modelRoles).length > 0 ? { modelRoles: ompLocal.modelRoles } : {}),
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
  agyCatalog?: AgentModelOption[];
}

/** Switches an active agent's model, thinking effort, or OMP role slot across all supported harnesses. */
export async function setAgentModelAndThinking(
  agent: Agent,
  opts: { modelId?: string; thinkingLevel?: string; roleSlot?: OmpModelRole },
  transport: SwitchTransport,
): Promise<{ currentModel?: string; currentThinking?: string; modelRoles?: Record<string, string>; note?: string }> {
  const rawModelId = opts.modelId?.trim() || undefined;
  const rawThinkingLevel = opts.thinkingLevel?.trim().toLowerCase() || undefined;
  const roleSlot = opts.roleSlot;
  if (!rawModelId && !rawThinkingLevel && !roleSlot) throw new Error("需要指定模型或思考等级");
  if (agent.isShell || (agent.source !== "hc" && agent.source !== "herdr")) {
    throw new Error("当前会话不支持切换模型或思考等级");
  }

  const hNorm = normHarnessKey(agent.harness);
  const home = transport.homeDir ?? homedir();

  if (roleSlot) {
    if (hNorm !== "omp") {
      throw new Error("仅 OMP 会话支持角色模型配置");
    }
    if (!rawModelId) {
      throw new Error("设置角色模型需要指定模型 ID");
    }
    const selector = rawThinkingLevel ? `${stripModelEffortSuffix(rawModelId)}:${rawThinkingLevel}` : rawModelId;
    const modelRoles = updateOmpRoleModel(home, roleSlot, selector);
    return {
      modelRoles,
      note: `已更新 OMP 角色 ${roleSlot} -> ${selector}`,
    };
  }

  let modelId = rawModelId;
  const thinkingLevel = rawThinkingLevel;

  if (hNorm === "antigravity" && thinkingLevel) {
    const baseCandidate = modelId || agent.model?.trim() || "";
    const stemMatch = AGY_EFFORT_SUFFIX_RE.exec(baseCandidate);
    const stem = stemMatch?.[1] || baseCandidate;
    if (stem) {
      const cachedAgy =
        transport.agyCatalog ??
        cliCatalogCache.get("antigravity")?.models ??
        (stemMatch ? undefined : await getAgyCatalog().catch(() => []));
      const targetLower = `${stem}-${thinkingLevel}`.toLowerCase();
      const exactSibling = cachedAgy?.find((m) => m.id.toLowerCase() === targetLower);
      const siblingId = exactSibling
        ? exactSibling.id
        : cachedAgy
            ?.map((m) => m.effortModelMap?.[thinkingLevel as AgentThinkingLevel])
            .find((v) => v?.toLowerCase() === targetLower);
      if (siblingId) {
        modelId = siblingId;
      } else if (stemMatch && (!cachedAgy || cachedAgy.length === 0)) {
        const allowed = inferModelThinkingLevels("antigravity", baseCandidate);
        if (allowed.includes(thinkingLevel)) {
          modelId = `${stem}-${thinkingLevel}`;
        }
      }
    }
  } else if (hNorm === "gemini" && thinkingLevel && !modelId && agent.model?.trim()) {
    const baseAgentModel = agent.model.trim();
    if (/-(low|medium|high)$/i.test(baseAgentModel) && ["low", "medium", "high"].includes(thinkingLevel)) {
      modelId = baseAgentModel.replace(/-(low|medium|high)$/i, `-${thinkingLevel}`);
    }
  }

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

  let resolvedModel = modelId ? (hNorm === "omp" ? stripModelEffortSuffix(modelId) : modelId) : undefined;
  let resolvedThinking = thinkingLevel;
  if (hNorm === "omp" && modelId?.startsWith("@")) {
    const ompCfg = await readOmpLocalConfig(home);
    const roleVal = ompCfg.modelRoles[modelId.slice(1).toLowerCase()];
    if (roleVal) {
      const split = splitModelAndEffort(roleVal);
      if (split.id) resolvedModel = split.id;
      if (!resolvedThinking && split.effort) resolvedThinking = split.effort;
    }
  }
  if (!resolvedThinking && resolvedModel && (hNorm === "antigravity" || hNorm === "gemini")) {
    const hm = AGY_EFFORT_SUFFIX_RE.exec(resolvedModel);
    if (hm?.[2]) resolvedThinking = hm[2].toLowerCase();
  }

  return {
    ...(resolvedModel ? { currentModel: resolvedModel } : {}),
    ...(resolvedThinking ? { currentThinking: resolvedThinking } : {}),
  };
}
