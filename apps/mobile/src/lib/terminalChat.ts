export interface ShellChatTurn {
  id: string;
  prompt: string;
  command: string;
  outputLines: string[];
  hasNextPrompt: boolean;
  completedEmpty: boolean;
}

export interface ParsedShellChat {
  preambleLines: string[];
  turns: ShellChatTurn[];
  currentPrompt: string | null;
}

const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_APC_RE = /\x1b_[\s\S]*?(?:\x07|\x1b\\)/g;
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_ESC_RE = /\x1b[@-Z\\-_]/g;

export function stripTermAnsi(raw: string): string {
  return raw
    .replace(ANSI_APC_RE, "")
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_ESC_RE, "")
    .replace(/\r\n/g, "\n");
}

function applyCarriageReturns(line: string): string {
  if (!line.includes("\r")) return line;
  const parts = line.split("\r");
  return parts[parts.length - 1] ?? "";
}

export function matchShellPromptLine(line: string): { prompt: string; command: string } | null {
  const trimmedRight = line.replace(/\s+$/, "");
  if (!trimmedRight) return null;

  const unixHostMatch = /^([^\s@]+@[^\s]+\s+[^%#$>\n]{0,80}[%#$>])(?:\s+(.*))?$/.exec(trimmedRight);
  if (unixHostMatch) {
    return { prompt: unixHostMatch[1]!.trim(), command: (unixHostMatch[2] ?? "").trim() };
  }

  const psMatch = /^(PS\s+[^>]+>)(?:\s+(.*))?$/.exec(trimmedRight);
  if (psMatch) {
    return { prompt: psMatch[1]!.trim(), command: (psMatch[2] ?? "").trim() };
  }

  const glyphMatch = /^((?:➜\s+\S+(?:\s+git:\([^)]+\))?|❯|λ|\S+\s*[❯λ]|(?:[~\/][\w./-]*\s+)?[$%#]))(?:\s+(.*))?$/.exec(trimmedRight);
  if (glyphMatch) {
    const prompt = glyphMatch[1]!.trim();
    const command = (glyphMatch[2] ?? "").trim();
    if ((prompt === "$" || prompt === "%" || prompt === "#") && /^\d/.test(command)) return null;
    return { prompt, command };
  }

  return null;
}

export function parseTerminalChatTranscript(raw: string): ParsedShellChat {
  const clean = stripTermAnsi(raw);
  const rawLines = clean.split("\n").map(applyCarriageReturns);
  const preambleLines: string[] = [];
  const turns: ShellChatTurn[] = [];
  let currentPrompt: string | null = null;
  let openTurn: ShellChatTurn | null = null;

  const closeOpenTurn = () => {
    if (!openTurn) return;
    while (openTurn.outputLines.length > 0 && !openTurn.outputLines[openTurn.outputLines.length - 1]!.trim()) {
      openTurn.outputLines.pop();
    }
    while (openTurn.outputLines.length > 0 && !openTurn.outputLines[0]!.trim()) {
      openTurn.outputLines.shift();
    }
    openTurn.hasNextPrompt = true;
    openTurn.completedEmpty = openTurn.outputLines.length === 0;
    openTurn = null;
  };

  for (const line of rawLines) {
    const promptHit = matchShellPromptLine(line);
    if (promptHit) {
      closeOpenTurn();
      currentPrompt = promptHit.prompt;
      if (promptHit.command) {
        const turn: ShellChatTurn = {
          id: `sh-${turns.length}-${promptHit.command.slice(0, 24)}`,
          prompt: promptHit.prompt,
          command: promptHit.command,
          outputLines: [],
          hasNextPrompt: false,
          completedEmpty: false,
        };
        turns.push(turn);
        openTurn = turn;
      }
      continue;
    }

    if (openTurn) {
      openTurn.outputLines.push(line);
    } else if (line.trim()) {
      preambleLines.push(line);
    }
  }

  if (openTurn) {
    while (openTurn.outputLines.length > 0 && !openTurn.outputLines[openTurn.outputLines.length - 1]!.trim()) {
      openTurn.outputLines.pop();
    }
    while (openTurn.outputLines.length > 0 && !openTurn.outputLines[0]!.trim()) {
      openTurn.outputLines.shift();
    }
  }

  return { preambleLines, turns, currentPrompt };
}

export function normalizeShellCommand(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function shellTurnMatchesCommand(turn: ShellChatTurn, sentText: string): boolean {
  const a = normalizeShellCommand(turn.command);
  const b = normalizeShellCommand(sentText);
  return Boolean(a && b && (a === b || a.endsWith(b)));
}
