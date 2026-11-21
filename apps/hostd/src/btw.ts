import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Agent, ConvEvent } from "@herdr-pocket/protocol";
import { findPrograms } from "./create.ts";
import type { UnifloAdapter } from "./uniflo.ts";

export type BtwBinary = "omp" | "claude" | "codex" | "gemini";

export interface BtwRunnerRequest {
  binary: BtwBinary;
  binPath: string;
  args: string[];
  cwd?: string;
}

export interface BtwRunnerResult {
  stdout: string;
  stderr?: string;
  model?: string;
}

export type BtwRunner = (req: BtwRunnerRequest) => Promise<BtwRunnerResult | string>;

export interface AskAgentBtwOptions {
  uniflo?: Pick<UnifloAdapter, "events">;
  homeDir?: string;
  runner?: BtwRunner;
  /** Override binary discovery (used in unit tests). */
  findBins?: (names: string[]) => Promise<Map<string, string>>;
  timeoutMs?: number;
}

export interface AskAgentBtwResult {
  answer: string;
  model?: string;
  durationMs: number;
}

const BTW_BINARIES: BtwBinary[] = ["omp", "claude", "codex", "gemini"];
const MAX_CONTEXT_CHARS = 10_000;
const DEFAULT_TIMEOUT_MS = 50_000;

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function clipText(s: string, max: number): string {
  const clean = s.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

function safeJson(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function resolveAgentCwd(rawCwd: string | undefined, home: string): string | undefined {
  const trimmed = rawCwd?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(home, trimmed.slice(2));
  }
  return trimmed;
}

/** Preference order matching the agent's harness first, then falling back across installed CLIs. */
export function preferredBinariesForHarness(harness: string): BtwBinary[] {
  const h = harness.trim().toLowerCase();
  if (h.includes("claude") || h.includes("crosery") || h.includes("prime") || h.includes("commandcode") || h.includes("reasonix")) {
    return ["claude", "omp", "codex", "gemini"];
  }
  if (h === "omp" || h.includes("oh-my-pi") || h === "pi" || h.includes("pi-mono")) {
    return ["omp", "claude", "codex", "gemini"];
  }
  if (h.includes("codex")) {
    return ["codex", "omp", "claude", "gemini"];
  }
  if (h.includes("gemini") || h.includes("antigravity") || h === "agy") {
    return ["gemini", "omp", "claude", "codex"];
  }
  return ["omp", "claude", "codex", "gemini"];
}

function matchesHarnessBinary(harness: string, binary: BtwBinary): boolean {
  const h = harness.trim().toLowerCase();
  if (binary === "claude") return h.includes("claude") || h.includes("crosery") || h.includes("prime") || h.includes("commandcode") || h.includes("reasonix");
  if (binary === "omp") return h === "omp" || h.includes("oh-my-pi") || h === "pi" || h.includes("pi-mono");
  if (binary === "codex") return h.includes("codex");
  if (binary === "gemini") return h.includes("gemini") || h.includes("antigravity") || h === "agy";
  return false;
}

function formatEventLine(ev: ConvEvent): string | null {
  switch (ev.kind) {
    case "user_message":
      return `[User] ${clipText(ev.text, 1500)}`;
    case "assistant_message":
      return `[Assistant${ev.model ? ` (${ev.model})` : ""}] ${clipText(ev.text, 2200)}`;
    case "tool_call":
      return `[ToolCall ${ev.name}] ${clipText(safeJson(ev.input), 400)}`;
    case "tool_result":
      return `[ToolResult ${ev.name ?? ev.call_id}${ev.is_error ? " ERROR" : ""}] ${clipText(ev.output, 700)}`;
    default:
      return null;
  }
}

/** Collects the most recent events up to `maxChars` in chronological order. */
export function buildBtwContext(events: readonly ConvEvent[], maxChars = MAX_CONTEXT_CHARS): string {
  const picked: string[] = [];
  let total = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const line = formatEventLine(events[i]!);
    if (!line) continue;
    const cost = line.length + (picked.length > 0 ? 2 : 0);
    if (total + cost > maxChars) {
      if (picked.length === 0) picked.push(clipText(line, maxChars));
      break;
    }
    picked.push(line);
    total += cost;
  }
  return picked.reverse().join("\n\n");
}

function buildBtwPrompt(agent: Agent, question: string, context: string): string {
  return [
    "[Herdr Pocket Sidechannel /btw]",
    "You are answering a side-channel question about an agent session without interrupting the main agent.",
    "Constraints:",
    "- Read-only query: do NOT invoke tools, edit files, or mutate session files.",
    "- Answer directly, concisely, and accurately in Markdown.",
    "- Respond in the user's question language.",
    "",
    "Agent Metadata:",
    `- Harness: ${agent.harness}`,
    `- Status: ${agent.status}`,
    `- Title: ${agent.title || agent.name || "(untitled)"}`,
    `- Working Directory: ${agent.cwd || "(unknown)"}`,
    `- Model: ${agent.model || "(unknown)"}`,
    "",
    "Recent Session Transcript (read-only):",
    context || "(No transcript available; answer from agent metadata and the question.)",
    "",
    "User Question:",
    question,
  ].join("\n");
}

export function buildBtwCliArgs(binary: BtwBinary, prompt: string, cwd?: string): string[] {
  switch (binary) {
    case "omp":
      return ["-p", "--no-session", "--no-tools", ...(cwd ? ["--cwd", cwd] : []), prompt];
    case "claude":
      return ["-p", "--no-session-persistence", "--tools", "", prompt];
    case "codex":
      return ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never", ...(cwd ? ["-C", cwd] : []), prompt];
    case "gemini":
      return ["-p", prompt, "--approval-mode", "plan"];
  }
}

function defaultRunner(req: BtwRunnerRequest, timeoutMs: number): Promise<BtwRunnerResult> {
  return new Promise((resolveRun, rejectRun) => {
    const spawnCwd = req.cwd && existsSync(req.cwd) ? req.cwd : undefined;
    const child = execFile(
      req.binPath,
      req.args,
      {
        ...(spawnCwd ? { cwd: spawnCwd } : {}),
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, TERM: "dumb" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || "").trim();
          rejectRun(new Error(`${req.binary} failed: ${detail}`));
          return;
        }
        resolveRun({ stdout, stderr });
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end("");
  });
}

/**
 * Answers a `/btw` sidechannel question about `agent` in read-only ephemeral mode
 * without writing to the agent's PTY, stdin, or session history.
 */
export async function askAgentBtw(
  agent: Agent,
  question: string,
  opts: AskAgentBtwOptions = {},
): Promise<AskAgentBtwResult> {
  const cleanQuestion = question.trim();
  if (!cleanQuestion) {
    throw new Error("请输入要旁路提问的内容");
  }

  const startedAt = Date.now();
  const home = opts.homeDir ?? homedir();
  const cwd = resolveAgentCwd(agent.cwd, home);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let context = "";
  if (agent.sessionKey && opts.uniflo) {
    try {
      const page = await opts.uniflo.events(agent.sessionKey, 16);
      context = buildBtwContext(page.events, MAX_CONTEXT_CHARS);
    } catch {
      // Uniflo unavailable or session not indexed yet: continue cleanly with agent metadata.
    }
  }

  const findBins = opts.findBins ?? findPrograms;
  const found = await findBins([...BTW_BINARIES]);
  const candidates = preferredBinariesForHarness(agent.harness).filter((bin) => found.has(bin));

  if (candidates.length === 0) {
    throw new Error("本机未找到可用的旁路 CLI（需要 omp / claude / codex / gemini 之一）");
  }

  const prompt = buildBtwPrompt(agent, cleanQuestion, context);
  const runCli: BtwRunner = opts.runner ?? ((req) => defaultRunner(req, timeoutMs));

  let lastError: Error | null = null;
  for (const binary of candidates) {
    const binPath = found.get(binary)!;
    const args = buildBtwCliArgs(binary, prompt, cwd);
    try {
      const raw = await runCli({ binary, binPath, args, cwd });
      const stdout = typeof raw === "string" ? raw : raw.stdout;
      const reportedModel = typeof raw === "string" ? undefined : raw.model;
      const answer = stripAnsi(stdout).trim();
      if (!answer) {
        lastError = new Error(`${binary} 返回了空内容`);
        continue;
      }
      const model = reportedModel ?? (matchesHarnessBinary(agent.harness, binary) && agent.model ? agent.model : binary);
      return {
        answer,
        model,
        durationMs: Math.max(1, Date.now() - startedAt),
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("旁路提问执行失败");
}
