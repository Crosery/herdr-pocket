import { parseTerminalChoices, type TerminalChoiceOption } from "@herdr-pocket/protocol";

/**
 * Interactive choice options parsed off the bottom of an agent's terminal screen
 * across Claude Code, Antigravity, Codex, Oh My Pi, Gemini CLI, OpenCode, and DSH.
 */
export type Choice = TerminalChoiceOption;

export function parseChoices(lines: string[], lookback = 36): Choice[] {
  return parseTerminalChoices(lines, lookback);
}
