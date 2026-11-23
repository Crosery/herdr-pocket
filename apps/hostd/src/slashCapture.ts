import { isCommandErrorOutput, isDismissedCommandOutput, type Agent } from "@herdr-pocket/protocol";
import { endsInPanel, isInteractiveApprovalOrQuestion } from "./hc.ts";

export type SlashTerminalClass = "viewer" | "interactive" | "normal";

export interface SlashCaptureResult {
  command: string;
  output?: string;
  isError?: boolean;
  panelState?: "none" | "closed" | "interactive_open";
}

const ANSI_STRIP_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const BOX_BORDER_ONLY_RE = /^[╭╮╰╯┌┐└┘├┤┬┴┼─━═┄┈│┃\s]+$/;
const MODAL_FOOTER_HINT_RE =
  /^(?:press\s+)?(?:esc(?:ape)?\b[^\n]{0,40}(?:close|cancel|dismiss|exit|back|return)|[↑↓←→].*\besc\b|use\s+↑\/↓|\?\s+for\s+shortcuts|按\s*esc\s*(?:返回|关闭|取消|退出))/i;

const VIEWER_COMMANDS = new Set([
  "/help",
  "/status",
  "/cost",
  "/context",
  "/stats",
  "/usage",
  "/session",
  "/hotkeys",
  "/about",
  "/version",
  "/doctor",
  "/todos",
  "/tasks",
  "/skills",
  "/tools",
  "/commands",
]);

const INTERACTIVE_PICKER_COMMANDS = new Set([
  "/config",
  "/settings",
  "/permissions",
  "/approvals",
  "/mcp",
  "/hooks",
  "/plugins",
  "/plugin",
  "/resume",
  "/tree",
  "/rewind",
  "/fork",
  "/vim",
  "/theme",
  "/models",
]);

/** Classifies a chat-sent slash command by whether it renders a read-only TUI info panel, an interactive picker, or a normal turn. */
export function classifySlashCommand(harness: string, rawText: string): SlashTerminalClass {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith("/")) return "normal";
  const parts = trimmed.split(/\s+/);
  const cmd = (parts[0] ?? "").toLowerCase();
  const args = parts.slice(1).join(" ").trim();
  const h = harness.trim().toLowerCase();

  if (cmd === "/model" && !args) return "interactive";
  if ((cmd === "/effort" || cmd === "/thinking") && !args) return "interactive";
  if (cmd === "/model" || cmd === "/effort" || cmd === "/thinking" || cmd === "/switch") {
    // Switching model/effort with explicit arg can still print inline TUI errors (e.g. Codex/CodeBuddy/Pi).
    return "normal";
  }
  if (VIEWER_COMMANDS.has(cmd)) {
    if (cmd === "/session" && args && args !== "info") return "normal";
    if ((cmd === "/skills" || cmd === "/tools") && args) return "normal";
    if (h === "omp" && (cmd === "/stats" || cmd === "/help")) return "viewer";
    return "viewer";
  }
  if (INTERACTIVE_PICKER_COMMANDS.has(cmd) && !args) {
    return "interactive";
  }
  return "normal";
}

function stripBoxDecorations(line: string): string {
  const clean = line.replace(ANSI_STRIP_RE, "").replace(/\r/g, "");
  if (BOX_BORDER_ONLY_RE.test(clean)) return "";
  return clean.replace(/^\s*[│┃]\s?/, "").replace(/\s?[│┃]\s*$/, "").trimEnd();
}

/** Extracts newly visible TUI output/dialog lines produced after sending a slash command. */
export function diffTerminalCommandOutput(beforeRaw: string, afterRaw: string, commandText: string): string {
  const toCleanLines = (raw: string) =>
    raw
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map(stripBoxDecorations)
      .filter((l) => l.trim().length > 0);

  const beforeLines = toCleanLines(beforeRaw);
  const afterLines = toCleanLines(afterRaw);
  const beforeCounts = new Map<string, number>();
  for (const l of beforeLines) beforeCounts.set(l, (beforeCounts.get(l) ?? 0) + 1);

  const cmdNorm = commandText.trim();
  const cmdBase = cmdNorm.split(/\s+/)[0] ?? cmdNorm;
  const diff: string[] = [];
  for (const l of afterLines) {
    const trimmed = l.trim();
    const c = beforeCounts.get(l) ?? 0;
    if (c > 0) {
      beforeCounts.set(l, c - 1);
      continue;
    }
    if (!trimmed) continue;
    if (trimmed === cmdNorm || trimmed === cmdBase || trimmed === `❯ ${cmdNorm}` || trimmed === `> ${cmdNorm}`) {
      continue;
    }
    if (MODAL_FOOTER_HINT_RE.test(trimmed)) continue;
    if (/^[❯›>]\s*$/.test(trimmed)) continue;
    diff.push(l);
  }
  return diff.join("\n").trim().slice(0, 6000);
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface TerminalCaptureTransport {
  snapshotText: (localId: string, lines?: number) => Promise<string>;
  send: (localId: string, text: string, enter?: boolean) => Promise<void>;
  keys: (localId: string, keys: string[]) => Promise<void>;
  dismissSubscreens?: (localId: string) => Promise<"viewer" | "pager" | "none" | "blocked">;
}

/**
 * Sends a slash command to an idle `hc` terminal, polls briefly for TUI modal/inline output,
 * closes read-only viewer modals via `Esc`, and returns structured screen output for Chat UI.
 */
export async function sendAndCaptureSlashCommand(
  transport: TerminalCaptureTransport,
  localId: string,
  agent: Pick<Agent, "harness" | "isShell">,
  text: string,
): Promise<SlashCaptureResult | undefined> {
  if (agent.isShell) {
    await transport.send(localId, text, true);
    return undefined;
  }
  const kind = classifySlashCommand(agent.harness, text);
  const isModelArgCmd = /^\/(?:model|models|switch|effort|thinking)\s+\S/i.test(text.trim());
  if (kind === "normal" && !isModelArgCmd) {
    await transport.send(localId, text, true);
    return undefined;
  }

  const before = await transport.snapshotText(localId, 60).catch(() => "");
  await transport.send(localId, text, true);

  let after = before;
  let last = "";
  for (const delay of [180, 220, 300, 420, 550]) {
    await wait(delay);
    const snap = await transport.snapshotText(localId, 60).catch(() => "");
    if (snap && snap !== before) {
      after = snap;
      const loading = /\b(?:loading|fetching|refreshing)\b|正在(?:加载|获取|拉取)/i.test(snap) && !endsInPanel(snap);
      if (snap === last && !loading) break;
      last = snap;
    }
  }

  const isPanel = endsInPanel(after);
  const output = diffTerminalCommandOutput(before, after, text);
  const closeViewer = async () => {
    if (transport.dismissSubscreens) {
      const closed = await transport.dismissSubscreens(localId).catch(() => "none" as const);
      if (closed === "viewer" || closed === "pager") return;
    }
    await transport.keys(localId, ["esc"]).catch(() => undefined);
  };
  if (isModelArgCmd) {
    // Only return capture if TUI stayed stuck in a picker or printed an error.
    if (isPanel) {
      await closeViewer();
    }
    if (isCommandErrorOutput(output)) {
      return { command: text.trim(), output, isError: true, panelState: isPanel ? "closed" : "none" };
    }
    return undefined;
  }

  let panelState: SlashCaptureResult["panelState"] = "none";
  if (isPanel) {
    // Chat UI must never strand the underlying terminal in a non-input modal/picker screen.
    if (!isInteractiveApprovalOrQuestion(after)) {
      await closeViewer();
      panelState = "closed";
    } else {
      panelState = "interactive_open";
    }
  }

  if (!output || isDismissedCommandOutput(output)) {
    return panelState === "interactive_open" ? { command: text.trim(), panelState } : undefined;
  }
  return {
    command: text.trim(),
    output,
    isError: isCommandErrorOutput(output),
    panelState,
  };
}
