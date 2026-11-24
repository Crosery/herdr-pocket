import type { Agent } from "@herdr-pocket/protocol";
import { agentSpace, agentTitle } from "../lib/store";

const GENERIC_TITLES = new Set([
  "",
  "终端",
  "新建 agent",
  "agent",
  "shell",
  "claude",
  "claude-code",
  "codex",
  "antigravity",
  "agy",
  "omp",
  "oh-my-pi",
  "gemini",
  "gemini-cli",
  "cursor",
  "cursor-agent",
  "opencode",
  "kimi",
  "kimi-code",
  "kimi-cli",
  "qwen",
  "qwen-code",
  "zsh",
  "bash",
  "fish",
  "sh",
  "pwsh",
  "cmd",
]);

function isGenericAgentTitle(title: string, harness: string, isShell?: boolean): boolean {
  const low = title.trim().toLowerCase();
  if (GENERIC_TITLES.has(low)) return true;
  const h = (harness || "").trim().toLowerCase();
  if (h && low === h) return true;
  if (isShell && /^(zsh|bash|fish|sh|pwsh|cmd)(?:\s|$)/i.test(low)) return true;
  return false;
}

export interface SidebarAgentRowText {
  primary: string;
  secondary: string | null;
}

/**
 * Formats an Agent row into a readable primary title + compact contextual subline
 * so long task names are never crushed by repeated remote computer names.
 */
export function formatSidebarAgentRow(
  agent: Pick<Agent, "name" | "title" | "localId" | "harness" | "where" | "isShell">,
  opts: { showMachine: boolean; machineName?: string },
): SidebarAgentRowText {
  const rawTitle = agentTitle(agent).trim();
  const spaceName = agentSpace(agent)?.trim() || "";
  const prefix = spaceName ? `${spaceName} · ` : "";
  const stripped = prefix && rawTitle.startsWith(prefix) ? rawTitle.slice(prefix.length).trim() : "";
  const cleanTitle = stripped || rawTitle;
  const machine = opts.showMachine && opts.machineName?.trim() ? opts.machineName.trim() : null;

  if (isGenericAgentTitle(cleanTitle, agent.harness, agent.isShell)) {
    const primary = spaceName && !cleanTitle.startsWith(spaceName) ? `${spaceName} · ${cleanTitle}` : cleanTitle;
    return { primary, secondary: machine };
  }

  const secondaryParts = [spaceName || null, machine].filter((v): v is string => Boolean(v));
  return {
    primary: cleanTitle,
    secondary: secondaryParts.length ? secondaryParts.join(" · ") : null,
  };
}
