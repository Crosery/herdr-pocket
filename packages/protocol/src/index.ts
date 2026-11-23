/**
 * herdr-pocket wire protocol, v1.
 *
 * Three parties:
 *   - relay  : the server every device registers with (e.g. a small VPS)
 *   - host   : a computer running herdr (GUI `hc` core and/or TUI `herdr`), via `hostd`
 *   - viewer : a phone (or any client) that watches and drives agents
 *
 * A host is also allowed to call other hosts, so computers can drive each other's
 * agents through the relay ("joint debugging").
 *
 * Versioning follows Uniflo's rule: v1 only gains optional fields and new
 * `type` / `kind` values. Clients must ignore what they don't recognise.
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export type DeviceKind = "host" | "viewer";

export interface Device {
  id: string;
  name: string;
  kind: DeviceKind;
  platform?: string; // darwin | linux | ios | android | ...
  online: boolean;
  createdAt: number; // epoch ms
  lastSeenAt: number; // epoch ms
  /** Agent sources a host can bridge, e.g. ["hc", "herdr", "uniflo"]. */
  sources?: AgentSource[];
  version?: string;
}

// ---------------------------------------------------------------------------
// Agents (unified view over herdr-core terminals and herdr TUI agents)
// ---------------------------------------------------------------------------

/** Where the agent lives on its host. */
export type AgentSource = "hc" | "herdr" | "uniflo";

/**
 * Unified status. Superset of herdr (`idle|working|blocked|done|unknown`) and
 * herdr-core status; Uniflo `work` maps to `working`.
 */
export type AgentStatus = "working" | "blocked" | "done" | "idle" | "unknown";

export interface Agent {
  /** Globally unique: `<deviceId>/<source>:<localId>`. */
  key: string;
  deviceId: string;
  source: AgentSource;
  /** Address on the host: hc `t42`, herdr terminal id, ... */
  localId: string;
  /** Harness / program, e.g. claude-code, omp, codex, sh. */
  harness: string;
  /**
   * Human title: the name given in herdr when there is one, else the Uniflo
   * session title, else the terminal title.
   */
  title?: string;
  /** Name given to the terminal in herdr (e.g. `hc run --name`); also used as `title`. */
  name?: string;
  /** "space / tab" location in the herdr GUI, with the names the desktop app shows. */
  where?: string;
  cwd?: string;
  status: AgentStatus;
  statusKind?: "permission" | "question" | "auth";
  statusSince?: number;
  /**
   * What the program says about a `blocked` state, when it says something,
   * e.g. its error message. Older hosts never send it.
   */
  statusNote?: string;
  /** Active non-input terminal subscreen hint detected by hostd. */
  subscreen?: "viewer" | "pager" | null;
  /**
   * The program stopped on an error (a model or connection failure) rather than
   * on a question. `status` is `blocked` then, so older apps still flag it.
   */
  errored?: boolean;
  turn?: number;
  /** True for plain shells; the app hides them by default. */
  isShell: boolean;
  /** Matching Uniflo session key, when found (enables the chat view). */
  sessionKey?: string;
  model?: string;
  /** Current thinking/reasoning effort inferred from the matched session, when known. */
  thinkingLevel?: string;
  /** First human prompt of the matched session. */
  preview?: string;
  costUsd?: number;
  contextTokens?: number;
  contextLimit?: number;
  /** Subagent sessions spawned by the matched session (Uniflo `parent`). */
  subagents?: number;
  subagentsWorking?: number;
  /**
   * Messages typed into it while it was busy that its program has not taken
   * yet (Claude Code and the like hold them in the input box until the turn
   * ends). Absent or 0 when nothing is waiting.
   */
  queued?: number;
  /** Individual message texts waiting in the terminal program's input queue (FIFO). */
  queuedItems?: string[];
  /** The oldest waiting message, clipped. */
  queuedText?: string;
  /** When the oldest waiting message was typed in (epoch ms). */
  queuedSince?: number;
  updatedAt: number;
}

/** A space in the desktop herdr app on one computer. */
export interface SpaceInfo {
  id: string;
  name: string;
  /** Folder its terminals started in. */
  folder?: string;
  tabs: number;
  terminals: number;
  /** Desktop Herdr App accent color token (e.g. `ansi1`..`ansi6` or hex), from `shared.json`. */
  color?: string;
  /** Whether this space is the active space in desktop Herdr App. */
  active?: boolean;
  /** Whether this space backs a git worktree in Herdr App. */
  isWorktree?: boolean;
}

/** A program the phone may start on a computer (picked by id, never a command line). */
export interface LaunchOption {
  id: string;
  label: string;
  /**
   * Whether a first message can be given at start (on its command line). Hosts
   * with `typesTask` (spaces.list) also take a task for the others, except the
   * shell: they type it in once the program is up.
   */
  takesTask: boolean;
}

/**
 * What became of the first task given to agent.create: `started` went in with
 * the program, `typed` was typed in once it was up, `failed` did not reach it
 * (`taskNote` says why; the agent is open and idle).
 */
export type FirstTask = "started" | "typed" | "failed";

/** The desktop herdr app's layout on one computer: spaces -> tabs -> terminals. */
export interface LayoutSpace {
  id: string;
  name: string;
  folder?: string;
  /** The space the desktop window shows now. */
  active: boolean;
  tabs: LayoutTab[];
}

export interface LayoutTab {
  id: string;
  name: string;
  active: boolean;
  /** Put away: out of the lists, still running. */
  settled: boolean;
  terminals: LayoutTerminal[];
}

export interface LayoutTerminal {
  /** hc address, e.g. t42. */
  terminal: string;
  pane?: string;
  /** Key of the published agent, when this terminal is one. */
  agent?: string;
  title?: string;
  harness?: string;
  status?: AgentStatus;
}

/** Node size in herdr-core's shared `herdr-app` layout document. */
export type HerdrDocSize = { weight: number } | { px: number };

/** Layout tree node inside herdr-core's `"herdr-app"` document (`mirror.rs` / `layout.rs`). */
export interface HerdrDocNode {
  id: string;
  type: "row" | "column" | "block" | "stack";
  size?: HerdrDocSize;
  content?:
    | { terminal: string; [key: string]: unknown }
    | { mod: string; props?: unknown; [key: string]: unknown }
    | Record<string, unknown>;
  children?: HerdrDocNode[];
  active?: string;
  hidden?: boolean;
  [key: string]: unknown;
}

/** Shared tab entry inside `HerdrDocSpace`. */
export interface HerdrDocTab {
  id: string;
  name: string;
  root: HerdrDocNode;
  [key: string]: unknown;
}

/** Shared space entry inside `HerdrDoc`. */
export interface HerdrDocSpace {
  id: string;
  name: string;
  folder: string;
  tabs: HerdrDocTab[];
  [key: string]: unknown;
}

/** Shared desktop workspace document stored under `"herdr-app"` in herdr-core. */
export interface HerdrDoc {
  spaces: HerdrDocSpace[];
  [key: string]: unknown;
}

/**
 * Desktop herdr commands a computer accepts over rpc (`herdr.command`), with the
 * arguments each takes. `confirm`: it ends or starts programs, so the assistant
 * asks first; the others only change the layout and can be undone.
 * Ids come from `herdr.layout`. Nothing here takes a command line.
 */
export const HERDR_COMMANDS = {
  "space.rename": { confirm: false, args: ["id", "name"], about: "给空间改名；name 为空字符串时恢复成按文件夹自动命名" },
  "space.move": { confirm: false, args: ["id", "index"], about: "把空间移到第 index 位，1 是最前" },
  "space.select": { confirm: false, args: ["id"], about: "让桌面窗口显示这个空间" },
  "space.close": { confirm: true, args: ["id"], about: "关闭空间，并结束它里面的所有终端" },
  "tab.rename": { confirm: false, args: ["id", "name"], about: "给标签改名；name 为空字符串时恢复成序号" },
  "tab.move": { confirm: false, args: ["id", "index"], about: "把标签移到所在空间的第 index 位，1 是最前" },
  "tab.select": { confirm: false, args: ["id"], about: "让桌面窗口显示这个标签" },
  "tab.settle": { confirm: false, args: ["id"], about: "把标签收起来：不在列表里显示，但继续运行；里面的 agent 需要人时会自己回来" },
  "tab.unsettle": { confirm: false, args: ["id"], about: "把收起的标签放回列表" },
  "tab.close": { confirm: true, args: ["id"], about: "关闭标签，并结束它里面的终端" },
  "pane.split": { confirm: true, args: ["pane", "direction", "launcher"], about: "把一个窗格向 right 或 down 分开，新窗格里开一个程序（launcher 是 list_launchers 里的 id，不填是普通终端）" },
  "pane.close": { confirm: true, args: ["pane"], about: "关闭窗格，并结束它的终端" },
  "pane.zoom": { confirm: false, args: ["pane"], about: "只显示这个窗格，或恢复显示全部" },
  "pane.focus": { confirm: false, args: ["pane", "terminal"], about: "把焦点放到某个窗格，或显示某个终端的窗格" },
  "terminal.pin": { confirm: false, args: ["terminal", "pinned"], about: "把 agent 置顶（pinned=true）或取消置顶（false）" },
  "terminal.keep": { confirm: false, args: ["terminal", "place"], about: "给没有窗格的后台终端（比如子 agent）一个窗格：place 是 tab、right 或 down" },
  "terminal.park": { confirm: false, args: ["terminal"], about: "收走终端的窗格，它在后台继续运行" },
  "agent.focus": { confirm: false, args: ["terminal"], about: "在桌面窗口显示这个 agent" },
} as const satisfies Record<string, { confirm: boolean; args: readonly string[]; about: string }>;

export type HerdrCommand = keyof typeof HERDR_COMMANDS;

/** A recorded agent session on one computer (Uniflo): any program, running or long finished. */
export interface SessionInfo {
  /** e.g. claude:<id>. */
  key: string;
  harness: string;
  title?: string;
  cwd?: string;
  model?: string;
  /** First prompt it was given. */
  preview?: string;
  status: "working" | "idle";
  startedAt?: number;
  updatedAt: number;
  costUsd?: number;
  steps?: number;
  /** Parent session key, for a subagent. */
  parent?: string;
  /** Key of the live agent this session is open in, if any. */
  agent?: string;
}

/** Full-text search result: one session and where the words were found in it. */
export interface SessionHit {
  session: string;
  harness: string;
  title?: string;
  cwd?: string;
  updatedAt: number;
  hits: Array<{ event: string; kind: string; ts?: number; snippet: string }>;
}

/** Tokens and cost of one group (a program, model, folder or day). */
export interface UsageRow {
  key: string;
  label: string;
  sessions: number;
  steps: number;
  prompts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

/** A subagent conversation spawned by an agent's session. */
export interface SubSession {
  key: string;
  /** Session key of the direct parent (an agent's session or another subagent). */
  parent: string;
  /** tool_call id in the parent that spawned it, links the tool card to this child. */
  parentCall?: string;
  harness: string;
  title?: string;
  /** First prompt it was given: what it was asked to do. */
  preview?: string;
  model?: string;
  status: "working" | "idle";
  statusSince?: number;
  startedAt?: number;
  updatedAt: number;
  costUsd?: number;
  /** Its own subagents. */
  children: number;
}

export function agentKey(deviceId: string, source: AgentSource, localId: string): string {
  return `${deviceId}/${source}:${localId}`;
}

export function parseAgentKey(key: string): { deviceId: string; source: AgentSource; localId: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0) return null;
  const rest = key.slice(slash + 1);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  const source = rest.slice(0, colon) as AgentSource;
  if (source !== "hc" && source !== "herdr" && source !== "uniflo") return null;
  return { deviceId: key.slice(0, slash), source, localId: rest.slice(colon + 1) };
}

// ---------------------------------------------------------------------------
// Conversation events (Uniflo schema v1 body, trimmed for the wire)
// ---------------------------------------------------------------------------

export type EventBody =
  /** `injected`: harness-added blocks stripped from the text, shown folded. */
  | { kind: "user_message"; text: string; synthetic?: boolean; injected?: string }
  | { kind: "assistant_message"; text: string; model?: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; call_id: string; name: string; input: unknown }
  | { kind: "tool_result"; call_id: string; name?: string; output: string; is_error: boolean }
  | { kind: "turn_start" }
  | { kind: "turn_end"; reason?: string }
  | { kind: "usage"; input?: number; output?: number; cost_usd?: number; model?: string }
  /** Injected by the harness, not said by anyone. `summary` is the folded one-liner. */
  | { kind: "system"; subtype?: string; text: string; summary?: string };

export type ConvEvent = EventBody & {
  id: string;
  session: string;
  ts: number;
  pos?: string;
  partial?: boolean;
  truncated?: boolean;
};

// ---------------------------------------------------------------------------
// Files sent to an agent (terminal.put)
// ---------------------------------------------------------------------------

/** A file or picture sent from a client, contents in base64. */
export interface PutFile {
  /** Original file name; the host keeps a safe form of it. */
  name: string;
  /** Media type (e.g. one of `PUT_LIMITS.mimes`, `application/pdf`, `video/mp4`, `text/markdown`). */
  mime: string;
  data: string;
}

/**
 * What one `terminal.put` may carry. The total stays well under the relay's
 * 8 MiB WebSocket frame once base64 has grown it by a third.
 */
export const PUT_LIMITS = {
  files: 6,
  /** Bytes of one file, decoded. */
  fileBytes: 5 * 1024 * 1024,
  /** Bytes of all files of one call, decoded. */
  totalBytes: 5 * 1024 * 1024,
  mimes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
} as const;

/** The message an agent gets for a text with pictures: the text, then each picture's path on a line of its own. */
export function textWithFiles(text: string, paths: string[]): string {
  return [text.trim(), ...paths].filter(Boolean).join("\n");
}

/**
 * A trailing line that stands for a picture: a path `textWithFiles` appended,
 * Claude Code's `[Image #n]` / `[Image #n, WxH]` marks, or Uniflo's `[image]` blocks.
 */
const IMAGE_TAG = /\[Image #\d+(?:,\s*\d+\s*[x×]\s*\d+)?\]/gi;
const HAS_IMAGE_TAG = /\[Image #\d+(?:,\s*\d+\s*[x×]\s*\d+)?\]/i;
const IMAGE_BLOCK = /\[image\]/gi;
const TRAILING_IMAGE_BLOCKS = /(?:\s*\[image\])+$/i;
const PICTURE_LINE = /^(?:(?:\/|[A-Za-z]:\\).*\.(?:jpe?g|png|webp|gif)|(?:\[Image #\d+(?:,\s*\d+\s*[x×]\s*\d+)?\]\s*)+|(?:\[image\]\s*)+)$/i;
/** An absolute path: `/…` (macOS, Linux) or `C:\…` (Windows). */
const FILE_PATH = /^(?:\/|[A-Za-z]:\\)/;

/** Undoes `textWithFiles`: the words, the picture marks/paths, and how many pictures those are. */
export function splitFiles(message: string): { text: string; lines: string[]; count: number } {
  const all = message.replace(/\s+$/, "").split("\n");
  const popped: string[] = [];
  while (all.length > 0) {
    const top = all[all.length - 1]!.trim();
    if (!top) {
      all.pop();
      continue;
    }
    if (!PICTURE_LINE.test(top)) break;
    popped.unshift(all.pop()!.trim());
  }
  const inlineBlocks: string[] = [];
  if (all.length > 0) {
    const last = all[all.length - 1]!;
    const trail = TRAILING_IMAGE_BLOCKS.exec(last);
    if (trail) {
      inlineBlocks.push(...(trail[0].match(IMAGE_BLOCK) ?? []));
      const trimmed = last.slice(0, trail.index).trimEnd();
      if (trimmed) all[all.length - 1] = trimmed;
      else all.pop();
    }
  }
  const inlineTags: string[] = [];
  const cleaned: string[] = [];
  for (const line of all) {
    const tags = line.match(IMAGE_TAG);
    if (!tags) {
      cleaned.push(line);
      continue;
    }
    inlineTags.push(...tags);
    const next = line.replace(IMAGE_TAG, "").replace(/[ \t]{2,}/g, " ").trim();
    if (next) cleaned.push(next);
  }
  const pathLines = popped.filter((l) => FILE_PATH.test(l));
  const poppedTagLines = popped.filter((l) => !FILE_PATH.test(l) && HAS_IMAGE_TAG.test(l));
  const poppedTags = popped.flatMap((l) => l.match(IMAGE_TAG) ?? []);
  const poppedBlocks = popped.flatMap((l) => l.match(IMAGE_BLOCK) ?? []);
  const totalTags = inlineTags.length + poppedTags.length;
  const totalBlocks = inlineBlocks.length + poppedBlocks.length;
  const count = pathLines.length + Math.max(totalTags, totalBlocks);
  const lines = [
    ...pathLines,
    ...inlineTags,
    ...poppedTagLines,
    ...(totalTags === 0 ? [...popped.filter((l) => !FILE_PATH.test(l)), ...inlineBlocks] : []),
  ];
  return { text: cleaned.join("\n").trim(), lines, count };
}

const foldMessageText = (s: string) => s.replace(/\s+/g, "");

/** Whether a conversation copy matches what was typed/sent, ignoring attached picture marks and PTY whitespace shifts. */
export function sameMessage(said: string, sent: string, hasFiles?: boolean): boolean {
  const a = splitFiles(said);
  const b = splitFiles(sent);
  const ta = foldMessageText(a.text);
  const tb = foldMessageText(b.text);
  if (ta !== tb) return false;
  if (!tb) return hasFiles ? a.count > 0 : a.count > 0 || b.count === 0;
  return true;
}

const ANSI_ESCAPE_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const ALT_M_QUEUE_HINT_RE = /\s*\((?:alt\+m\b[^)]*|option\+m\b[^)]*)\)\s*$/i;
const QUEUE_TRAILER_HINT_RE = /\s*\((?:esc to (?:cancel|clear)|tab to edit)\)\s*$/i;
const CLAUDE_QUEUE_HINT_RE = /^\s*Press\s+(?:up|↑)\s+to\s+(?:edit|select)\s+(?:a\s+)?queued\s+messages?\b/i;
const QUEUE_SECTION_HEAD_RE = /^\s*(?:[▸▶•‣›>]\s*)?(?:Queued(?:\s+messages?)?|Steer\s+queue|Follow-?up\s+queue|排队中的消息)\s*[:：]?\s*$/i;
const INLINE_QUEUE_TAG_RE = /^\s*(?:[▸▶•‣›>]\s*)?(?:Queued(?:\s+message)?|Steer(?:\s*\(next\))?|Follow-?up(?:\s+message)?)\s*[:：]\s*(.+)$/i;
const TUI_DIVIDER_OR_CHROME_RE = /^[─━═┄┈\-_=│┃┌┐└┘├┤┬┴┼╭╮╰╯▸▶•‣›❯$%#\s]+$/;
const TUI_FOOTER_RE = /(?:for shortcuts|esc to interrupt|ctrl\+c to|context left|\b\d+%\s+context\b)/i;

function normalizeQueuePreview(raw: string): string {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > 1000 ? `${clean.slice(0, 1000)}…` : clean;
}

/**
 * Extracts message texts currently waiting inside a coding-agent TUI queue
 * (Antigravity `▸ ... (alt+m to send immediately)`, Claude Code `Press up to edit queued messages`,
 * and Codex/OMP/Pi/OpenCode `Queued:` / `Steer:` / `Follow-up:` preview rows).
 */
export function extractTerminalQueuedMessages(screen: string, _harness?: string): string[] {
  if (!screen) return [];
  const plain = screen.replace(/\r\n?/g, "\n").replace(ANSI_ESCAPE_RE, "");
  const allLines = plain.split("\n");
  while (allLines.length > 0 && !allLines[allLines.length - 1]!.trim()) allLines.pop();
  if (!allLines.length) return [];

  const tail = allLines.slice(-45);
  const tailStartIdx = Math.max(0, tail.length - 30);
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const clean = normalizeQueuePreview(raw.replace(ALT_M_QUEUE_HINT_RE, "").replace(QUEUE_TRAILER_HINT_RE, ""));
    if (!clean || TUI_DIVIDER_OR_CHROME_RE.test(clean) || TUI_FOOTER_RE.test(clean)) return;
    if (seen.has(clean)) return;
    seen.add(clean);
    found.push(clean);
  };

  // 1. Antigravity (`agy`) & Alt+M queued bullets (`▸ <msg> (alt+m to send immediately)`), allowing 1-2 line wraps.
  for (let i = 0; i < tail.length; i += 1) {
    const line = tail[i]!.trim();
    if (!line) continue;
    if (ALT_M_QUEUE_HINT_RE.test(line)) {
      const stripped = line.replace(ALT_M_QUEUE_HINT_RE, "").replace(/^\s*[▸▶•‣]\s+/, "").trim();
      if (stripped) push(stripped);
      continue;
    }
    if (/^[▸▶]\s+\S/.test(line)) {
      let combined = line.replace(/^[▸▶]\s+/, "").trim();
      for (let look = 1; look <= 2 && i + look < tail.length; look += 1) {
        const nextLine = tail[i + look]!.trim();
        if (!nextLine || TUI_DIVIDER_OR_CHROME_RE.test(nextLine) || /^[▸▶]\s+/.test(nextLine)) break;
        combined = `${combined} ${nextLine}`;
        if (ALT_M_QUEUE_HINT_RE.test(nextLine)) {
          push(combined);
          i += look;
          break;
        }
      }
    }
  }

  // 2. Claude Code queued message block above `Press up to edit/select queued message(s)`.
  for (let i = 0; i < tail.length; i += 1) {
    if (!CLAUDE_QUEUE_HINT_RE.test(tail[i]!)) continue;
    const collected: string[] = [];
    let blankRun = 0;
    for (let k = i - 1; k >= Math.max(0, i - 12); k -= 1) {
      const t = tail[k]!.trim();
      if (!t) {
        blankRun += 1;
        if (collected.length > 0 && blankRun > 0) break;
        continue;
      }
      blankRun = 0;
      if (TUI_DIVIDER_OR_CHROME_RE.test(t) || TUI_FOOTER_RE.test(t) || CLAUDE_QUEUE_HINT_RE.test(t)) break;
      if (QUEUE_SECTION_HEAD_RE.test(t)) break;
      if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✶✻✽✢●]\s+/.test(t)) break;
      const itemText = t.replace(/^(?:[▸▶•‣›>❯]\s+|\d+[.)]\s+)/, "").trim();
      if (itemText) collected.unshift(itemText);
    }
    for (const item of collected) push(item);
  }

  // 3. Explicit queue headers (`Queued messages:` / `Steer queue:`) and single-line `Queued:` / `Steer:` / `Follow-up:` tags.
  for (let i = tailStartIdx; i < tail.length; i += 1) {
    const line = tail[i]!.trim();
    if (!line) continue;
    if (QUEUE_SECTION_HEAD_RE.test(line)) {
      for (let k = i + 1; k < Math.min(tail.length, i + 10); k += 1) {
        const sub = tail[k]!.trim();
        if (!sub || TUI_DIVIDER_OR_CHROME_RE.test(sub) || TUI_FOOTER_RE.test(sub) || CLAUDE_QUEUE_HINT_RE.test(sub)) break;
        if (/^[❯›>]\s*$/.test(sub)) break;
        const itemText = sub.replace(/^(?:[▸▶•‣›>]\s+|\d+[.)]\s+)/, "").trim();
        if (itemText) push(itemText);
      }
      continue;
    }
    const inlineMatch = INLINE_QUEUE_TAG_RE.exec(line);
    if (inlineMatch?.[1]) {
      push(inlineMatch[1]);
    }
  }

  return found.slice(0, 20);
}

// ---------------------------------------------------------------------------
// RPC methods a host serves (callable by viewers and by other hosts)
// ---------------------------------------------------------------------------

export interface RpcMethods {
  /** Full agent list of this host. */
  "agents.list": { params: { includeShells?: boolean }; result: { agents: Agent[] } };
  /** Screen + history as plain text. */
  "terminal.read": {
    params: { agent: string; lines?: number };
    /**
     * `text`: plain screen + history. `ansi`: the same rows with SGR colors
     * only (no cursor moves), when the source can provide it; render it
     * without wrapping at `cols` cells per row.
     */
    result: { text: string; ansi?: string; cols?: number; rows?: number; how?: string; complete?: boolean };
  };
  /** Paste text and press Enter (like `hc send`). */
  "terminal.send": {
    params: { agent: string; text: string; enter?: boolean; delivery?: "auto" | "steer" };
    /**
     * Accepted into the ordered input queue; `position=0` means sent.
     * `agentStatus`: the agent's status when the text arrived. `waiting`: it was
     * in a turn, so its program holds the text until the turn ends (the agent's
     * `queued` counts these). Older hosts send neither.
     * `commandCapture`: present when a TUI-local slash command (e.g. `/status`, `/help`)
     * rendered directly onto the terminal screen rather than writing to the transcript.
     */
    result: {
      ok: true;
      queueId?: string;
      position?: number;
      agentStatus?: AgentStatus;
      waiting?: boolean;
      commandCapture?: {
        command: string;
        output?: string;
        isError?: boolean;
        panelState?: "none" | "closed" | "interactive_open";
      };
    };
  };
  /** Press keys: enter, esc, up, down, tab, ctrl+c, y, n ... */
  "terminal.keys": { params: { agent: string; keys: string[] }; result: { ok: true } };
  /**
   * Type into the terminal as the person at it would, at once: UTF-8 text with
   * control bytes ("\r" Enter, "\x7f" Backspace). No queue, no Enter added.
   * Hosts before this call answer `unsupported`; fall back to `terminal.send`.
   */
  "terminal.input": { params: { agent: string; data: string; auto?: boolean }; result: { ok: true } };
  /**
   * Resizes the attached terminal view (and optionally reports the viewer's cell size /
   * theme colors so `hc` answers display queries accurately). Hosts before this call answer
   * `unsupported`; viewers can ignore failures.
   */
  "terminal.resize": { params: { agent: string; cols: number; rows: number; display?: TerminalDisplay }; result: { ok: true } };
  /**
   * Puts files or pictures beside the agent on its computer (like `hc put`) and says
   * where each landed, in order. Nothing is typed: the caller names the paths
   * in a following `terminal.send` (see `textWithFiles`), and agents such as
   * Claude Code and Codex read files from their paths. Limits: `PUT_LIMITS`.
   * Hosts before this call answer `unsupported`.
   */
  "terminal.put": { params: { agent: string; files: PutFile[] }; result: { paths: string[] } };
  /** Conversation of the agent's matched Uniflo session, newest last. */
  "session.events": {
    /** `sub`: read a subagent session of this agent instead (from `session.children`). */
    params: { agent: string; sub?: string; limit?: number; before?: string };
    /** `nextBefore`: pass as `before` to load the previous page (null when none). */
    result: { sessionKey: string | null; events: ConvEvent[]; more: boolean; nextBefore?: string | null };
  };
  /** Subagent sessions under the agent's session (or under `sub`), newest first. */
  "session.children": { params: { agent: string; sub?: string }; result: { sessions: SubSession[] } };
  /**
   * A one-time ticket for a direct link to this computer (on the same network, or over a VPN such as
   * Tailscale), so calls, streams and files skip the relay. Asked through the relay, which has already
   * authenticated the phone. The phone connects to `ws://<one of addrs>:<port>${DIRECT_PATH}?ticket=`
   * within a minute, and both ends seal every frame with `key` (`DirectCipher`). `unsupported` when
   * the computer has direct links off.
   */
  "direct.offer": { params: Record<string, never>; result: DirectOffer };
  /** What can be created on this computer: spaces, programs, suggested folders. */
  "spaces.list": {
    params: Record<string, never>;
    /** `canCreate` false with `reason` when the desktop herdr window is closed without an active doc or the host is read-only. */
    result: {
      spaces: SpaceInfo[];
      launchers: LaunchOption[];
      folders: string[];
      canCreate: boolean;
      reason?: string;
      /** This host types a first task into programs that take none at start (agent.create waits for that, up to about a minute). */
      typesTask?: boolean;
      /**
       * No desktop herdr on this computer (herdr on Windows is herdr-core alone; servers): there are
       * no spaces, and a new agent gets a terminal of its own in the folder. `spaceName` is unused.
       */
      standalone?: boolean;
    };
  };
  /**
   * Starts an agent: in a new tab of `space`, or (no `space`) in a new space
   * named `spaceName` (empty: named after its folder). Shown at once in the desktop app.
   */
  "agent.create": {
    params: { space?: string; spaceName?: string; tabName?: string; folder?: string; launcher: string; task?: string };
    result: { agent: string; space: string; tab?: string; terminal: string; task?: FirstTask; taskNote?: string };
  };
  "host.info": {
    params: Record<string, never>;
    /**
     * `tools`: versions of the programs this host works with (see HostTools). `files`: this host
     * answers `files.list` / `files.read`.
     */
    result: { name: string; platform: string; sources: AgentSource[]; version: string; hcVersion?: string; tools?: HostTools; files?: boolean };
  };
  /**
   * The person looked at this agent: a finished turn stops counting as "done"
   * here and in the desktop app (herdr keeps this on the terminal for every client).
   */
  "agent.seen": { params: { agent: string }; result: { ok: true } };
  /** Press the stop key (like `hc interrupt`); `report` says what happened. */
  "terminal.interrupt": { params: { agent: string }; result: { ok: true; report?: string } };
  /** End the terminal and its sub-agents. */
  "terminal.kill": { params: { agent: string }; result: { ok: true } };
  /** Spaces, tabs and terminals as the desktop herdr window shows them. */
  "herdr.layout": { params: Record<string, never>; result: { spaces: LayoutSpace[] } };
  /** One of `HERDR_COMMANDS` with its arguments. */
  "herdr.command": { params: { command: HerdrCommand; args?: Record<string, unknown> }; result: { ok: true; result?: unknown } };
  /** Reads herdr-core's `"herdr-app"` layout document + CAS version. */
  "herdr.doc.get": { params: Record<string, never>; result: { value: HerdrDoc | null; version: number } };
  /** Atomically writes herdr-core's `"herdr-app"` layout document with CAS version check. */
  "herdr.doc.set": {
    params: { value: HerdrDoc; version: number };
    result: { ok: boolean; conflict?: boolean; value?: HerdrDoc | null; version: number };
  };
  /**
   * Recorded sessions on this computer, newest first. `q` is Uniflo's filter
   * (`h:claude s:work in:<folder> since:2d` and free words). Assistant only.
   */
  "sessions.list": { params: { q?: string; limit?: number }; result: { sessions: SessionInfo[] } };
  /** Full-text search over every session's transcript. Assistant only. */
  "sessions.search": { params: { q: string; limit?: number }; result: { total: number; results: SessionHit[] } };
  /** Conversation of any session by key, newest last. Assistant only. */
  "sessions.read": {
    params: { session: string; limit?: number; before?: string };
    result: { session: SessionInfo; events: ConvEvent[]; more: boolean; nextBefore?: string | null };
  };
  /** Tokens and cost since `since` (`1d`, `7d`, `2026-11-01`), grouped. Assistant only. */
  "sessions.usage": {
    params: { since?: string; groupBy?: "harness" | "model" | "cwd" | "day" | "session" };
    result: { since?: number; rows: UsageRow[]; total: UsageRow };
  };
  /**
   * Opens a finished session again in a new tab (of `space`, else a new space),
   * with the resume command Uniflo gives for it. Assistant only.
   */
  "sessions.resume": { params: { session: string; space?: string }; result: { agent: string; space: string; terminal: string } };
  /**
   * Harness icons as the computer's Uniflo draws them: 24×24 single-colour SVGs
   * (`fill="currentColor"`), only safe shape elements. For marks the app can't
   * ship itself. `ids` are Uniflo harness ids (claude, workbuddy, factory…), at
   * most HARNESS_ICON_MAX; ids it doesn't know are left out. Older hosts answer
   * `unsupported`.
   */
  "harness.icons": { params: { ids: string[] }; result: { icons: Record<string, string> } };
  /**
   * Read-only file view of the agent's working folder (its `cwd`). `path` is relative to that
   * folder, "/"-separated; "" (or none) is the folder itself. Nothing outside it is listed or read,
   * symlinks included. Heavy generated folders (`FILES_IGNORED`) are listed with `ignored: true`
   * only when `all` is set; dot files only with `hidden`. Folders first, then by name; at most
   * `limit` entries (default `FILES_LIMITS.list`, max `FILES_LIMITS.listMax`). Older hosts answer
   * `unsupported`; `not_found` when the agent has no working folder or the path is not there.
   */
  "files.list": {
    params: { agent: string; path?: string; hidden?: boolean; all?: boolean; limit?: number };
    /** `root`: the working folder as the computer names it (for display only). */
    result: { root: string; path: string; entries: FileEntry[]; truncated: boolean };
  };
/**
 * One file of the agent's working folder (same rules as `files.list`). Text comes back as
 * UTF-8 `text`, at most `maxBytes` (default `FILES_LIMITS.read`, max `FILES_LIMITS.readMax`) from
 * `offset`, cut on a character boundary. A file with NUL bytes or invalid UTF-8 near its start
 * is `binary`: no text; rich media (image, pdf, audio, video) up to `FILES_LIMITS.image` comes
 * as `base64` with its `mime` and `kind`.
 */
  "files.read": {
    params: { agent: string; path: string; maxBytes?: number; offset?: number };
    result: {
      path: string;
      size: number;
      mtime: number;
      binary: boolean;
      kind?: "text" | "image" | "pdf" | "audio" | "video" | "document" | "spreadsheet" | "presentation" | "binary";
      /** More of the file after what was sent; ask again with `offset` + the bytes received. */
      truncated: boolean;
      offset: number;
      /** Bytes of the file this answer covers. */
      bytes: number;
      text?: string;
      base64?: string;
      mime?: string;
      /** Optional host-converted HTML preview (e.g. legacy `.doc` / `.rtf` via macOS textutil). */
      previewHtml?: string;
      /** Highlighting hint from the extension: ts, tsx, py, rs, go, md, json, sh, ... */
      language?: string;
    };
  };
  /** List subdirectories inside `path` (default user home) for selecting a working directory when creating an agent. */
  "folders.list": {
    params: { path?: string; hidden?: boolean };
    result: {
      path: string;
      displayPath: string;
      parent: string | null;
      entries: Array<{ name: string; path: string }>;
    };
  };
  /** Slash commands discovered for an agent's harness & workspace (built-ins merged on client or returned by hostd). */
  "agent.commands": {
    params: { agent: string };
    result: { harness: string; commands: SlashCommandItem[] };
  };
  /** Live token usage, context pressure, model breakdown, and quota report for `/usage`. */
  "agent.usage": {
    params: { agent: string };
    result: AgentUsageReport;
  };
  /** Discover available models for switching via `/model` or composer chip. */
  "agent.models": {
    params: { agent: string };
    result: AgentModelsResult;
  };
  /** Switch an agent's active model, thinking/reasoning effort level, or OMP role slot cleanly per harness. */
  "agent.setModel": {
    params: { agent: string; modelId?: string; thinkingLevel?: string; roleSlot?: OmpModelRole };
    result: { ok: true; currentModel?: string; currentThinking?: string; modelRoles?: Record<string, string>; note?: string };
  };
  /** Sidechannel / bypass quick question against an agent's recent context without interrupting its turn. */
  "agent.btw": {
    params: { agent: string; question: string };
    result: { answer: string; model?: string; durationMs: number };
  };
  /** Close a workspace / space (and its terminals) without deleting disk folders. */
  "space.delete": {
    params: { spaceId?: string; spaceName?: string };
    result: { ok: true; closedTerminals: number };
  };
  "git.status": {
    params: { agent?: string; cwd?: string };
    result: GitStatusResult;
  };
  "git.diff": {
    params: { agent?: string; cwd?: string; path: string; staged?: boolean; commit?: string };
    result: GitDiffResult;
  };
  "git.log": {
    params: { agent?: string; cwd?: string; limit?: number };
    result: { commits: GitCommitEntry[] };
  };
  "git.stage": {
    params: { agent?: string; cwd?: string; paths: string[]; all?: boolean };
    result: { ok: true };
  };
  "git.unstage": {
    params: { agent?: string; cwd?: string; paths: string[]; all?: boolean };
    result: { ok: true };
  };
  "git.discard": {
    params: { agent?: string; cwd?: string; paths: string[]; untracked?: boolean };
    result: { ok: true };
  };
  "git.commit": {
    params: { agent?: string; cwd?: string; message: string };
    result: { hash: string; subject: string };
  };
  "git.checkout": {
    params: { agent?: string; cwd?: string; branch: string; create?: boolean };
    result: { branch: string };
  };
  "git.pull": {
    params: { agent?: string; cwd?: string };
    result: { summary: string };
  };
  "git.push": {
    params: { agent?: string; cwd?: string };
    result: { summary: string };
  };
  "tools.check": {
    params: Record<string, never>;
    result: { tools: HostTools; hostVersion: string };
  };
  "tools.update": {
    params: { targets?: HostToolId[]; waitMs?: number };
    result: ToolUpdateJobSnapshot;
  };
  "tools.updateStatus": {
    params: { jobId?: string };
    result: ToolUpdateJobSnapshot | null;
  };
  "files.readChunk": {
    params: { agent?: string; path: string; cwd?: string; offset?: number; length?: number };
    result: { path: string; size: number; mtime: number; offset: number; bytes: number; eof: boolean; mime: string; base64: string };
  };
  "portal.list": {
    params: { agent?: string; includeWindows?: boolean };
    result: { items: PortalItem[]; windows?: RemoteWindowInfo[]; capabilities: HostPortalCapabilities };
  };
  "portal.open": {
    params: { agent?: string; kind: PortalKind; target?: string; url?: string; windowId?: string; reveal?: boolean; title?: string };
    result: { item: PortalItem; ticket?: PortalFileTicket };
  };
  "portal.close": {
    params: { portalId: string };
    result: { ok: true };
  };
  "portal.frame": {
    params: { portalId: string; maxWidth?: number; quality?: number };
    result: { frame: PortalFramePayload | null; item: PortalItem | null };
  };
  "portal.input": {
    params: { portalId: string; input: PortalInputAction };
    result: { ok: true; url?: string; title?: string };
  };
  "portal.fileTicket": {
    params: { agent?: string; path: string; cwd?: string; portalId?: string };
    result: PortalFileTicket;
  };
  "portal.dirList": {
    params: { portalId?: string; agent?: string; path: string; hidden?: boolean };
    result: { dirPath: string; parentDir: string | null; highlightName?: string; entries: FileEntry[]; truncated: boolean };
  };
  "portal.bundleHtml": {
    params: { agent?: string; path: string; cwd?: string; portalId?: string };
    result: { html: string; title: string };
  };
}

export type HostToolId = "app" | "herdr" | "hc" | "uniflo" | "hostd";

export interface ToolUpdateItemResult {
  id: HostToolId;
  ok: boolean;
  status: "updated" | "up_to_date" | "restarting" | "failed";
  fromVersion?: string;
  toVersion?: string;
  message: string;
}

export interface ToolUpdateJobSnapshot {
  jobId: string;
  running: boolean;
  targets: HostToolId[];
  completed: ToolUpdateItemResult[];
  current?: HostToolId;
  tools: HostTools;
  hostVersion: string;
  startedAt: number;
  finishedAt?: number;
}

export type PortalKind = "file" | "html" | "reveal" | "browser" | "window";

export type PortalDisplaySession =
  | "macos"
  | "win32"
  | "x11"
  | "wayland-wlroots"
  | "wayland-kde"
  | "wayland-gnome"
  | "wayland-other"
  | "headless";

export interface HostPortalCapabilities {
  platform: string;
  sessionType: PortalDisplaySession;
  desktopEnv?: string;
  canListWindows: boolean;
  canCaptureWindow: boolean;
  canCaptureScreen: boolean;
  canInjectInput: boolean;
  hasCdpBrowser: boolean;
  directPort?: number | null;
  notes?: string[];
}

export interface RemoteWindowInfo {
  id: string;
  appName: string;
  title: string;
  bounds?: { x: number; y: number; width: number; height: number };
  pid?: number;
  isScreen?: boolean;
}

export interface PortalItem {
  id: string;
  hostId: string;
  agentKey?: string;
  terminalId?: string;
  kind: PortalKind;
  title: string;
  subtitle?: string;
  targetPath?: string;
  parentDir?: string;
  highlightName?: string;
  url?: string;
  windowId?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  canInteract: boolean;
  transportHint?: "p2p" | "relay";
  createdAt: number;
  updatedAt: number;
}

export interface PortalFileTicket {
  token: string;
  entryPath: string;
  port: number | null;
  addrs: string[];
  expiresAt: number;
  mime: string;
  size: number;
  isDir: boolean;
}

export interface PortalFramePayload {
  portalId: string;
  seq: number;
  mime: "image/jpeg" | "image/png" | "image/webp";
  data: string;
  width: number;
  height: number;
  url?: string;
  title?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  at: number;
}

export type PortalStreamEvent =
  | { kind: "portal_event"; action: "opened" | "updated" | "closed"; item: PortalItem; at: number }
  | ({ kind: "portal_frame" } & PortalFramePayload);

export type PortalInputAction =
  | { type: "pointer"; action: "move" | "down" | "up" | "click" | "dblclick"; nx: number; ny: number; button?: "left" | "right" | "middle" }
  | { type: "wheel"; nx: number; ny: number; deltaX: number; deltaY: number }
  | { type: "key"; key: string; modifiers?: string[] }
  | { type: "text"; text: string }
  | { type: "navigate"; action: "goto" | "back" | "forward" | "reload"; url?: string };

export const DIRECT_PORTAL_FS_PREFIX = "/v1/portal-fs";

export type GitFileStatusCode = "M" | "A" | "D" | "R" | "U" | "?";

export interface GitFileChange {
  path: string;
  oldPath?: string;
  status: GitFileStatusCode;
  staged: boolean;
  additions?: number;
  deletions?: number;
}

export interface GitRepoSummary {
  root: string;
  name: string;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
}

export interface GitCommitEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  dateMs: number;
  refs?: string;
}

export interface GitStatusResult {
  isRepo: boolean;
  root?: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  branches: string[];
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  repos: GitRepoSummary[];
}

export interface GitDiffResult {
  path: string;
  staged: boolean;
  patch: string;
  oldText?: string;
  newText?: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  truncated?: boolean;
}

export interface SlashCommandItem {
  name: string;
  description: string;
  argHint?: string;
  category?: "session" | "model" | "code" | "skill" | "custom";
  source?: "builtin" | "project" | "user";
}

export interface AgentUsageModelRow {
  model: string;
  steps: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  unpricedSteps: number;
}

export interface AgentQuotaBar {
  provider: string;
  account?: string;
  label: string;
  usedPct: number;
  resetAt?: number;
  note?: string;
}

export interface AgentUsageReport {
  harness: string;
  sessionKey?: string;
  model?: string;
  session: {
    turns: number;
    steps: number;
    prompts: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    costUsd: number;
    unpricedSteps: number;
    contextTokens?: number;
    contextLimit?: number;
    contextPct?: number;
  } | null;
  models: AgentUsageModelRow[];
  day24h: { harness?: UsageRow; total: UsageRow } | null;
  day7d: { harness?: UsageRow; total: UsageRow } | null;
  quotas: AgentQuotaBar[];
}

export interface AgentModelOption {
  id: string;
  label: string;
  provider?: string;
  contextWindow?: number;
  reasoning?: boolean;
  thinkingLevels?: string[];
  effortModelMap?: Partial<Record<AgentThinkingLevel, string>>;
  source: "current" | "recent" | "catalog";
}

export interface AgentModelsResult {
  harness: string;
  currentModel?: string;
  currentThinking?: string;
  thinkingLevels?: string[];
  canSwitchThinking?: boolean;
  thinkingLabel?: string;
  canSwitch: boolean;
  reason?: string;
  modelRoles?: Record<string, string>;
  models: AgentModelOption[];
}

export interface HarnessSwitchPlan {
  commands: string[];
  keys?: string[][];
  interactiveOnly?: boolean;
}

import {
  HARNESS_DEFAULT_THINKING_LEVELS,
  OMP_MODEL_ROLES,
  OMP_QUICK_ROLE_CHIPS,
  applyTerminalModelFallback,
  clampThinkingLevel,
  extractModelExplicitEffort,
  findModelOptionForModel,
  inferAgentModelAndThinking,
  inferModelThinkingLevels,
  isNonReasoningModelName,
  normalizeSwitchHarness,
  parseTerminalModelAndThinking,
  resolveThinkingLevelsForModel,
  stripModelEffortSuffix,
  synthesizeFallbackAgentModels,
  type AgentThinkingLevel,
  type OmpModelRole,
  type ResolveThinkingLevelsInput,
} from "./modelsMeta.ts";

export {
  HARNESS_DEFAULT_THINKING_LEVELS,
  OMP_MODEL_ROLES,
  OMP_QUICK_ROLE_CHIPS,
  applyTerminalModelFallback,
  clampThinkingLevel,
  extractModelExplicitEffort,
  findModelOptionForModel,
  inferAgentModelAndThinking,
  inferModelThinkingLevels,
  isNonReasoningModelName,
  normalizeSwitchHarness,
  parseTerminalModelAndThinking,
  resolveThinkingLevelsForModel,
  stripModelEffortSuffix,
  synthesizeFallbackAgentModels,
  type AgentThinkingLevel,
  type OmpModelRole,
  type ResolveThinkingLevelsInput,
};

/** Builds per-harness slash commands / keys to switch model and/or thinking effort cleanly. */
export function buildHarnessSwitchCommands(
  harness: string,
  opts: { modelId?: string; thinkingLevel?: string; roleSlot?: OmpModelRole },
): HarnessSwitchPlan {
  const h = normalizeSwitchHarness(harness);
  const model = opts.modelId?.trim() || "";
  const effort = opts.thinkingLevel?.trim() || "";

  if (h === "omp") {
    if (opts.roleSlot) {
      return { commands: [] };
    }
    if (model && effort) {
      return { commands: [`/switch ${stripModelEffortSuffix(model)}:${effort}`] };
    }
    const commands: string[] = [];
    if (model) commands.push(`/switch ${model}`);
    if (effort) commands.push(`/effort ${effort}`);
    return { commands };
  }

  if (h === "pi") {
    const commands: string[] = [];
    if (model) commands.push(`/model ${stripModelEffortSuffix(model)}`);
    if (effort) commands.push(`/thinking ${effort}`);
    return { commands };
  }

  if (h === "gemini") {
    const commands: string[] = [];
    if (model) {
      let target = model;
      if (effort && /-(low|medium|high)$/i.test(target)) {
        target = target.replace(/-(low|medium|high)$/i, `-${effort.toLowerCase()}`);
      }
      commands.push(`/model set ${target}`);
    }
    return { commands };
  }

  if (h === "claude" || h === "antigravity" || h === "grok") {
    const commands: string[] = [];
    if (model) commands.push(`/model ${model}`);
    if (effort) commands.push(`/effort ${effort}`);
    return { commands };
  }

  if (h === "hermes") {
    const commands: string[] = [];
    if (model) commands.push(`/model ${model}`);
    if (effort) commands.push(`/reasoning ${effort}`);
    return { commands };
  }

  if (h === "aider") {
    const commands: string[] = [];
    if (model) commands.push(`/model ${model}`);
    if (effort) commands.push(`/reasoning-effort ${effort}`);
    return { commands };
  }

  if (h === "factory") {
    const commands: string[] = [];
    if (effort) {
      commands.push(effort.toLowerCase() === "fast" ? "/fast on" : "/fast off");
    }
    return { commands, ...(model ? { interactiveOnly: true } : {}) };
  }

  if (h === "opencode") {
    return {
      commands: [],
      ...(effort ? { keys: [["ctrl+t"]] } : {}),
      ...(model ? { interactiveOnly: true } : {}),
    };
  }

  if (h === "codex" || h === "dsh") {
    return { commands: [], interactiveOnly: true };
  }

  if (h === "amp") {
    if (effort && (effort === "smart" || effort === "rush") && !model) {
      return { commands: [`/model ${effort}`] };
    }
  }

  const commands: string[] = [];
  if (model) commands.push(`/model ${model}`);
  if (effort) commands.push(`/effort ${effort}`);
  return { commands };
}

/**
 * Versions of the programs a host works with (`host.info` `tools`), each as the program itself
 * says; missing when not installed. `herdr` is the herdr terminal UI, `app` the Herdr desktop app
 * (dev.herdr.app): two programs with their own version numbers.
 */
export interface HostTools {
  herdr?: string;
  hc?: string;
  uniflo?: string;
  app?: string;
  /** What hostd's daily check (`update.checkTools`) found upstream. Report only: nothing installs. */
  latest?: UpstreamLatest;
}

/**
 * The newest release each installed program can move to. hc: `core/latest.json` of the Herdr
 * release server, only when its `generation` is the installed core's (`hc update` stays within a
 * generation). app: `app/latest.json`. uniflo: `uniflo update --check`. A key is missing when that
 * program is not installed or did not answer yet; an older answer is kept while offline.
 */
export interface UpstreamLatest {
  hc?: string;
  app?: string;
  herdr?: string;
  uniflo?: string;
  hostd?: string;
  /** When a check last got an answer (ms since epoch). */
  checkedAt?: number;
}

/** One entry of `files.list`. */
export interface FileEntry {
  name: string;
  /** Relative to the agent's working folder, "/"-separated: what `files.list` / `files.read` take. */
  path: string;
  /** `link`: a symlink that leads outside the folder or nowhere; it is not followed. */
  kind: "file" | "dir" | "link";
  /** Bytes, for files. */
  size?: number;
  /** Last change, epoch ms. */
  mtime?: number;
  /** A symlink to something inside the folder (followed; `kind` is what it points to). */
  symlink?: boolean;
  hidden?: boolean;
  /** One of `FILES_IGNORED` (only listed with `all`). */
  ignored?: boolean;
  /** May hold keys (.env, .ssh, *.pem, ...): listed, but `files.read` and `files.list` refuse it (`forbidden`). */
  private?: boolean;
  /** Git working-tree status badge (`U` > `M` > `A` > `D` > `R` > `?` propagated up to directories). */
  gitStatus?: GitFileStatusCode;
}

/** Folders `files.list` leaves out unless asked: dependencies, VCS data, build output and caches. */
export const FILES_IGNORED: readonly string[] = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".pnpm-store",
  "bower_components",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".gradle",
  ".idea",
  "Pods",
  "DerivedData",
  "coverage",
];

/** Sizes in entries and bytes. */
export const FILES_LIMITS = { list: 500, listMax: 2000, read: 256 * 1024, readMax: 1024 * 1024, image: 64 * 1024 * 1024 } as const;

export const HARNESS_ICON_MAX = 40;

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M]["params"];
export type RpcResult<M extends RpcMethod> = RpcMethods[M]["result"];

export type RpcErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "offline"
  | "timeout"
  | "unsupported"
  /** The thing changed since the caller last read it (e.g. another phone saved settings first). */
  | "conflict"
  | "internal";

export interface RpcError {
  code: RpcErrorCode;
  message: string;
}

// ---------------------------------------------------------------------------
// Assistant (runs on the relay; one shared thread for the owner of all devices)
// ---------------------------------------------------------------------------

/**
 * Whether the assistant asks before it acts on real agents. `never` (the
 * default): it does what it is told at once and reports the real outcome.
 * `always`: in typed chats every action waits for the person's confirmation.
 * Voice calls never wait for a confirmation.
 */
export type AssistantConfirm = "never" | "always";

export interface AssistantSettings {
  confirm: AssistantConfirm;
}

// ---- Assistant configuration: models, keys, voice and prompts, edited from any phone ----
//
// The relay keeps it; every phone reads and changes the same copy, and the
// others are told (`assistant_config`). What the server's environment or
// POCKET_CONFIG file sets is the starting point: a phone's change overrides
// it, "reset" goes back to it. Keys go one way: a phone can set or clear one,
// it never reads one back (only whether one is set and its last characters).

export type ModelProtocol = "openai" | "openai-responses" | "anthropic" | "gemini" | "ollama";
export type ModelAuth = "bearer" | "x-api-key" | "api-key" | "x-goog-api-key" | "none";

export interface ProviderPresetItem {
  id: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  auth?: ModelAuth;
  recommendedModel?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPresetItem[] = [
  { id: "mimo", label: "小米 MiMo", protocol: "openai", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", recommendedModel: "mimo-v2.6-flash" },
  { id: "deepseek", label: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1", recommendedModel: "deepseek-chat" },
  { id: "openai", label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", recommendedModel: "gpt-4.1-mini" },
  { id: "openai-codex", label: "OpenAI Responses / Codex", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", recommendedModel: "gpt-5-codex" },
  { id: "anthropic", label: "Anthropic Claude", protocol: "anthropic", baseUrl: "https://api.anthropic.com", recommendedModel: "claude-sonnet-4-5" },
  { id: "gemini", label: "Google Gemini 原生", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com", recommendedModel: "gemini-2.5-flash" },
  { id: "qwen", label: "通义千问 (DashScope)", protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", recommendedModel: "qwen-plus" },
  { id: "moonshot", label: "Moonshot Kimi", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", recommendedModel: "kimi-k2-0711-preview" },
  { id: "zhipu", label: "智谱 GLM", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", recommendedModel: "glm-4.5-air" },
  { id: "siliconflow", label: "SiliconFlow", protocol: "openai", baseUrl: "https://api.siliconflow.cn/v1" },
  { id: "openrouter", label: "OpenRouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "ollama", label: "Ollama 本地", protocol: "ollama", baseUrl: "http://localhost:11434", auth: "none" },
] as const;

/** Where a value comes from: the server's own settings, or a phone. */
export type ConfigSource = "server" | "phone";

/** A key as phones see it. */
export interface KeyView {
  set: boolean;
  /** Last 4 characters, for telling keys apart; null without a key. */
  hint: string | null;
  from: ConfigSource | null;
}

/** A model provider (an endpoint and its key). */
export interface ProviderView {
  /** Lowercase letters, digits and dashes: `custom`, `deepseek`, `my-gateway`. Models name it as `provider:model`. */
  id: string;
  label?: string;
  protocol: ModelProtocol;
  baseUrl: string;
  auth?: ModelAuth;
  key: KeyView;
  /** Server: defined by the environment or the config file (a phone can override it, not delete it). */
  from: ConfigSource;
}

export interface ModelRef {
  provider: string;
  model: string;
}

export type VoiceProviderId = "moss-live" | "openai-realtime";

export interface VoiceOption {
  id: string;
  label: string;
  gender?: "female" | "male" | "neutral";
  hint?: string;
  recommended?: boolean;
}

export interface VoiceCatalogResponse {
  provider: VoiceProviderId;
  defaultVoice?: string;
  voices: VoiceOption[];
}

export const OPENAI_REALTIME_VOICES: readonly VoiceOption[] = [
  { id: "marin", label: "Marin · 自然女声", gender: "female", hint: "新一代旗舰女声，自然清晰", recommended: true },
  { id: "shimmer", label: "Shimmer · 轻柔女声", gender: "female", hint: "柔和甜美，适合日常通话", recommended: true },
  { id: "coral", label: "Coral · 温暖女声", gender: "female", hint: "亲切轻快，聊天感强" },
  { id: "sage", label: "Sage · 沉稳女声", gender: "female", hint: "清晰柔和，语调平稳" },
  { id: "cedar", label: "Cedar · 沉稳男声", gender: "male", hint: "新一代旗舰男声，温暖稳重" },
  { id: "ash", label: "Ash · 磁性男声", gender: "male", hint: "表现力强的自然男声" },
  { id: "verse", label: "Verse · 明快男声", gender: "male", hint: "节奏利落，适合问答" },
  { id: "ballad", label: "Ballad · 温和男声", gender: "male", hint: "柔和叙事风格" },
  { id: "echo", label: "Echo · 清朗男声", gender: "male", hint: "干净标准的男声" },
  { id: "alloy", label: "Alloy · 中性标准", gender: "neutral", hint: "初代默认中性音色" },
] as const;

export const MOSS_LIVE_VOICES: readonly VoiceOption[] = [] as const;

export function voiceCatalogFor(provider: VoiceProviderId): VoiceCatalogResponse {
  if (provider === "openai-realtime") {
    return { provider, defaultVoice: "marin", voices: OPENAI_REALTIME_VOICES.map((v) => ({ ...v })) };
  }
  return { provider: "moss-live", voices: [] };
}

export interface VoiceView {
  /** Null: voice calls are off. */
  provider: VoiceProviderId | null;
  url?: string;
  model?: string;
  voice?: string;
  speed?: number;
  key: KeyView;
}

export interface AssistantConfigView {
  /** Goes up with every change; a change sent with an older `rev` is refused (someone else changed it first). */
  rev: number;
  /** The assistant's name, as it calls itself. */
  name: string;
  providers: ProviderView[];
  /** Tried in this order: the first is the main model, the rest step in when one fails or stays silent. */
  models: ModelRef[];
  voice: VoiceView;
  /** Whether a phone has changed anything (reset goes back to the server's settings). */
  edited: boolean;
  updatedAt?: number;
  updatedBy?: string;
  /** Things that keep part of it from working (a provider without a key, an invalid URL). */
  warnings: string[];
}

/** A change to one provider. `apiKey`: a string sets it, null removes the phone's key, absent keeps it. */
export interface ProviderPatch {
  id: string;
  label?: string;
  protocol?: ModelProtocol;
  baseUrl?: string;
  auth?: ModelAuth | null;
  apiKey?: string | null;
  /** Remove a provider a phone added (a server one can only be reset). */
  remove?: boolean;
  /** Reset a server-defined provider back to the server's settings without touching other config. */
  reset?: boolean;
}

export interface VoicePatch {
  provider?: VoiceProviderId | null;
  url?: string | null;
  model?: string | null;
  voice?: string | null;
  speed?: number | null;
  apiKey?: string | null;
}

export interface AssistantConfigChange {
  rev: number;
  name?: string;
  providers?: ProviderPatch[];
  models?: ModelRef[];
  voice?: VoicePatch;
  /** Drop every phone change and go back to the server's settings (keys a phone set are removed too). */
  reset?: boolean;
}

/** One short request to a model, to see that it answers and how fast. */
export interface ModelTestResult {
  ok: boolean;
  /** Until the first word of the answer. */
  firstMs?: number;
  totalMs?: number;
  reply?: string;
  error?: string;
}

/** The prompts a phone can edit. Wake-up material and tool descriptions stay in code. */
export type PromptId =
  | "base"
  | "act_direct"
  | "act_ask"
  | "text"
  | "cards_direct"
  | "cards_ask"
  | "call"
  | "woken"
  | "persona"
  | "voice_rules";

export interface PromptView {
  id: PromptId;
  /** Short name, for the list. */
  title: string;
  /** What it decides, one sentence. */
  about: string;
  /** Group in the list: 性格与规矩, 文字聊天, 通话, 被叫醒. */
  group: string;
  /** Placeholders the relay fills in, e.g. `{{name}}`; leaving one out leaves that part out. */
  slots: Array<{ slot: string; means: string }>;
  /** What is used now. */
  text: string;
  /** The text the relay ships with. */
  defaultText: string;
  /** Changed from a phone. */
  edited: boolean;
  updatedAt?: number;
  updatedBy?: string;
}

/**
 * Something the assistant does to a real agent. With confirmation on it waits
 * as `pending` until the person confirms it (a button in the app, or saying so
 * in a later turn); otherwise it runs at once and the card shows the outcome.
 */
export interface AssistantAction {
  id: string;
  /**
   * send / keys: input to an agent. create: a new agent. interrupt: the stop key.
   * close: end the terminal. herdr: a desktop herdr command. resume: reopen a session.
   */
  kind: "send" | "keys" | "create" | "interrupt" | "close" | "herdr" | "resume";
  /** Target agent key (send / keys / interrupt / close). */
  agent?: string;
  agentTitle?: string;
  /** send: the short name the assistant calls the agent by, the one its answer uses. Older relays leave it out. */
  agentName?: string;
  /** Target computer. */
  device?: string;
  deviceName?: string;
  /** send: exactly what is typed into the agent. create: its first task. */
  text?: string;
  /**
   * send: the person's own words the assistant made `text` from (typed, or heard
   * in a call), kept so both are on record. Absent when `text` is those words as they are.
   */
  said?: string;
  keys?: string[];
  launcher?: string;
  folder?: string;
  /** create / resume: the space to add a tab to (id); absent = a new space. */
  space?: string;
  /** create: name for the new space / the new tab. */
  spaceName?: string;
  tabName?: string;
  /** herdr: the command and its arguments. */
  command?: HerdrCommand;
  args?: Record<string, unknown>;
  /** resume: the session key. */
  session?: string;
  /** One line for people, e.g. 给「迁移脚本」发送：继续. */
  summary: string;
  state: "pending" | "running" | "done" | "cancelled" | "failed" | "expired";
  /** What happened, once it is no longer pending. */
  result?: string;
  createdAt: number;
}

export type NoticeKind = "blocked" | "done" | "reminder";

/** Something worth telling the person without being asked. */
export interface Notice {
  id: string;
  kind: NoticeKind;
  /** Short headline, e.g. 迁移脚本 · 跑完了. Also the phone notification title. */
  title: string;
  /** The one sentence the assistant says about it. Also the phone notification text. */
  body: string;
  /** What the assistant found when it looked: ok = it worked, decide = the person has to choose, failed = it did not work, stopped = it stopped without a clear result. */
  verdict?: NoticeVerdict;
  /** A few more lines for the chat (plain text or simple markdown); never read aloud. */
  details?: string;
  agent?: string;
  ts: number;
}

export type NoticeVerdict = "ok" | "decide" | "failed" | "stopped";

export interface AssistantItem {
  id: string;
  ts: number;
  role: "user" | "assistant" | "notice";
  text: string;
  /** How it was said; voice items come from the live call transcript. */
  via?: "text" | "voice";
  /** What the assistant looked at or did for this answer, one short label each. */
  steps?: string[];
  action?: AssistantAction;
  notice?: Notice;
  error?: boolean;
}

/** Something the person asked to be reminded of: at a time, or when an agent stops. */
export interface Reminder {
  id: string;
  text: string;
  createdAt: number;
  dueAt?: number;
  agent?: string;
  /** With `agent`: fire when it needs you (`blocked`) or stops working (`finished`). */
  until?: "blocked" | "finished";
}

export interface AssistantState {
  items: AssistantItem[];
  /** True while the assistant is working on an answer. */
  busy: boolean;
  /** Whether the relay has a text model configured. */
  ready: boolean;
  /** Whether live voice (MOSS-Live) is configured on the relay. */
  voice: boolean;
  model?: string;
  reminders: Reminder[];
  /** Older relays leave it out: they always ask first. */
  settings?: AssistantSettings;
}

// ---------------------------------------------------------------------------
// Logs: the relay's own events plus what phones and computers upload
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

/** One line a phone or computer uploads (`log` frame or POST /v1/logs). Never tokens or keys. */
export interface ClientLogEntry {
  ts: number;
  level: LogLevel;
  /** Short dotted area, e.g. link, rpc, stream, js, voice, update, pair, send, create. */
  kind: string;
  /** One line, at most ~500 characters; message text inside is clipped to ~200. */
  msg: string;
  data?: Record<string, unknown>;
}

// Dictation (speech to text on the relay, for quick voice input on computers)
//
// GET  /v1/transcribe  (viewer)  -> TranscribeInfo   (whether the relay can do it, with which service)
// POST /v1/transcribe  (viewer)  body: the recording, raw, with its Content-Type (one of
//      TRANSCRIBE_FORMATS); query ?language=zh|en|auto&durationMs=<length the client measured>
//      -> TranscribeResult.  400 empty or wrong type, 413 over TRANSCRIBE_LIMITS.maxBytes,
//      429 over the per-device rate, 503 `unsupported` when no speech-to-text service is set up,
//      502/504 when the service failed or did not answer. The relay keeps neither audio nor text.

/** Audio types POST /v1/transcribe takes. */
export const TRANSCRIBE_FORMATS: readonly string[] = ["audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/flac"];

/** Per request and per device. */
export const TRANSCRIBE_LIMITS = { maxBytes: 10 * 1024 * 1024, maxSeconds: 300, perMinute: 20, concurrent: 2 } as const;

export interface TranscribeInfo {
  available: boolean;
  /** Service id (a provider id of the relay's settings), never a key or address. */
  provider?: string;
  model?: string;
  /** Why it is not available, in Chinese for the settings screen. */
  reason?: string;
  maxBytes: number;
  maxSeconds: number;
  formats: readonly string[];
}

export interface TranscribeResult {
  text: string;
  provider: string;
  model: string;
  /** Time the service took. */
  ms: number;
  language?: string;
}

/** A stored log line, as GET /v1/logs returns it. */
export interface LogEntry extends ClientLogEntry {
  id: number;
  /** Who wrote it: the relay itself, or the kind of device that uploaded it. */
  source: "relay" | DeviceKind;
  /** Device the line is from or about. */
  device?: string;
  deviceName?: string;
}

// ---------------------------------------------------------------------------
// Terminal stream
// ---------------------------------------------------------------------------

/** What a viewer's own terminal looks like, reported by the client to `hc` for display queries. */
export interface TerminalDisplay {
  fg?: string | null;
  bg?: string | null;
  cursor?: string | null;
  /** Cell size in physical/CSS pixels: `[width, height]`. */
  cell?: [number, number] | null;
}

/** Raw PTY bytes from a live terminal stream (`raw: true`), base64-encoded. */
export interface TerminalDataEvent {
  kind: "terminal_data";
  seq: number;
  /** Raw UTF-8 / VT bytes from the PTY stream, base64-encoded. */
  data: string;
  cols?: number;
  rows?: number;
  at: number;
}

/**
 * `stream_subscribe` params of `stream: "terminal"`. Hosts ignore fields they
 * do not know, so a viewer can always send all of them.
 */
export interface TerminalStreamParams {
  agent: string;
  /** Lines of history above the screen (hosts default to 120, at most 600). */
  history?: number;
  /**
   * Ask for `terminal_rows` events (only the lines that changed) instead of a
   * whole `terminal` screen on every paint (`rows: true`), or pass initial row count
   * when `raw: true`. Hosts before this ignore it and keep sending `terminal` events.
   */
  rows?: boolean | number;
  /**
   * `false`: no screen at all, only `queue` notices (the message box needs no
   * picture). Hosts before this still send screens, which the viewer drops.
   */
  screen?: boolean;
  /**
   * `true`: stream raw PTY bytes (`TerminalDataEvent`) for native terminal emulators
   * supporting Kitty graphics, text sizing and keyboard protocols. Older hosts ignore
   * this and fall back to `terminal_rows` / `terminal`.
   */
  raw?: boolean;
  cols?: number;
  display?: TerminalDisplay;
}

/**
 * Turns one list of lines into the next: every line, or the lines dropped
 * from the top (a scroll) plus the lines that differ after that.
 */
export interface RowsChange {
  /** Every line; replaces all. When present the other fields are absent. */
  lines?: string[];
  /** Lines dropped from the top first. */
  shift?: number;
  /** Line count afterwards: lines past it go, new ones start as "". */
  length?: number;
  /** Changed lines as [index after the shift, line]. */
  set?: Array<[number, string]>;
}

/**
 * A terminal paint as SGR-colored lines (history first, like the `ansi` of
 * `terminal.read` split at "\n"), relative to the previous event of the same
 * stream. The first event carries `lines`. Apply with `applyRows`.
 */
export interface TerminalRowsEvent extends RowsChange {
  kind: "terminal_rows";
  /** 1 on the first event of a stream, then +1. A gap means one was missed: subscribe again. */
  seq: number;
  /** Terminal size in cells; 0 when the source does not say (the herdr terminal app). */
  cols: number;
  rows: number;
  at: number;
}

/** How far the content moved up between two paints: the shift that keeps the most lines in place. */
function scrolledBy(prev: readonly string[], next: readonly string[]): number {
  if (!prev.length || !next.length) return 0;
  // Where sampled new lines sat before; a scroll moves them all by the same amount.
  const where = new Map<string, number[]>();
  for (let j = 0; j < prev.length; j++) {
    const line = prev[j]!;
    if (!line) continue;
    const at = where.get(line);
    if (!at) where.set(line, [j]);
    else if (at.length < 4) at.push(j);
  }
  const candidates = new Set<number>([0]);
  const step = Math.max(1, Math.floor(next.length / 16));
  for (let i = 0; i < next.length; i += step) {
    for (const j of where.get(next[i]!) ?? []) if (j > i) candidates.add(j - i);
  }
  let best = 0;
  let bestHits = -1;
  for (const k of candidates) {
    let hits = 0;
    const n = Math.min(next.length, prev.length - k);
    for (let i = 0; i < n; i++) if (next[i] === prev[i + k]) hits++;
    if (hits > bestHits || (hits === bestHits && k < best)) {
      best = k;
      bestHits = hits;
    }
  }
  return best;
}

/** The change from `prev` to `next` as a shift plus changed lines (never `lines`). */
export function diffRows(prev: readonly string[], next: readonly string[]): RowsChange {
  const shift = scrolledBy(prev, next);
  const set: Array<[number, string]> = [];
  for (let i = 0; i < next.length; i++) if ((prev[i + shift] ?? "") !== next[i]) set.push([i, next[i]!]);
  const out: RowsChange = { length: next.length };
  if (shift) out.shift = shift;
  if (set.length) out.set = set;
  return out;
}

/** What to send for `next` after `prev`: the diff, or every line when that is not larger. Null when nothing changed. */
export function rowsChange(prev: readonly string[] | null, next: readonly string[]): RowsChange | null {
  if (!prev) return { lines: [...next] };
  const d = diffRows(prev, next);
  if (!d.shift && !d.set && d.length === prev.length) return null;
  const diffSize = (d.set ?? []).reduce((n, [, line]) => n + line.length + 8, 24);
  const fullSize = next.reduce((n, line) => n + line.length + 3, 0);
  return diffSize < fullSize ? d : { lines: [...next] };
}

/** Applies a `RowsChange` (a `terminal_rows` event) to the lines it was made against. */
export function applyRows(prev: readonly string[], change: RowsChange): string[] {
  if (Array.isArray(change.lines)) return change.lines.map(String);
  const out = prev.slice(Math.max(0, Number(change.shift) || 0));
  const length = typeof change.length === "number" && change.length >= 0 ? change.length : out.length;
  while (out.length < length) out.push("");
  out.length = length;
  for (const [i, line] of Array.isArray(change.set) ? change.set : []) {
    if (Number.isInteger(i) && i >= 0 && i < length && typeof line === "string") out[i] = line;
  }
  return out;
}

// ---------------------------------------------------------------------------
// WebSocket frames (JSON text frames, one message each)
// ---------------------------------------------------------------------------

export type StreamKind = "terminal" | "session" | "portal";

/** Client (host or viewer) -> relay. */
export type ClientFrame =
  /** First frame from a host: what it can do. */
  | { type: "hello"; version: number; platform?: string; sources?: AgentSource[]; appVersion?: string }
  /** Host publishes its whole agent list (replaces the previous one). */
  | { type: "agents"; agents: Agent[] }
  /** Call a method on a host. `to` is the target deviceId. */
  | { type: "rpc"; id: string; to: string; method: RpcMethod; params: unknown }
  /** Host answers an rpc it received. */
  | { type: "rpc_result"; id: string; result?: unknown; error?: RpcError }
  /** Start a long-lived host stream; `id` is scoped to the viewer connection. */
  | { type: "stream_subscribe"; id: string; to?: string; from?: string; stream: StreamKind; params: unknown }
  | { type: "stream_unsubscribe"; id: string; to?: string; from?: string }
  /** Host -> relay stream lifecycle and data frames. */
  | { type: "stream_open"; id: string; result?: unknown; error?: RpcError }
  | { type: "stream_event"; id: string; event: unknown }
  | { type: "ping"; t: number }
  /** A batch of the client's own log lines (at most 200); stored per device. Older relays ignore it. */
  | { type: "log"; entries: ClientLogEntry[] };

/** Relay -> client. */
export type ServerFrame =
  | { type: "welcome"; version: number; device: Device; seq: number }
  /** Full state snapshot, sent after welcome to every client. */
  | { type: "snapshot"; seq: number; devices: Device[]; agents: Agent[] }
  | { type: "device"; seq: number; device: Device }
  | { type: "device_removed"; seq: number; id: string }
  /** Agents of one host changed (replace all agents of that device). */
  | { type: "agents"; seq: number; deviceId: string; agents: Agent[] }
  /** Forwarded rpc for a host to execute; `from` is the caller deviceId. */
  | { type: "rpc"; id: string; from: string; method: RpcMethod; params: unknown }
  | { type: "rpc_result"; id: string; result?: unknown; error?: RpcError }
  /** Stream subscription forwarded to a host. */
  | { type: "stream_subscribe"; id: string; from: string; stream: StreamKind; params: unknown }
  | { type: "stream_unsubscribe"; id: string; from: string }
  /**
   * A host has accepted a stream subscription. With `error` after it was
   * open: the stream ended (its computer went away); subscribe again later.
   */
  | { type: "stream_open"; id: string; result?: unknown; error?: RpcError }
  /**
   * Incremental terminal/session update from a subscribed host. Terminal
   * streams carry `{ kind: "terminal", screen }` (a whole `terminal.read`
   * result), `TerminalRowsEvent`, `TerminalDataEvent` when `raw: true`, `queue` and `stale` notices.
   */
  | { type: "stream_event"; id: string; event: unknown }
  | { type: "pong"; t: number }
  | { type: "error"; error: RpcError }
  /** Assistant thread: a new item, or a newer version of one with the same id. Sent to viewers. */
  | { type: "assistant_item"; item: AssistantItem }
  /** The assistant started or stopped working; `label` says on what. */
  | { type: "assistant_busy"; busy: boolean; label?: string }
  /** The thread was cleared or reminders changed: refetch GET /v1/assistant. */
  | { type: "assistant_reset" }
  /** The assistant's configuration or a prompt changed (from some phone): refetch what is on screen. */
  | { type: "assistant_config"; rev: number; by?: string; what: "config" | "prompts" };

/**
 * GET /v1/notify?token=...&since=<ms> (WebSocket, viewers only): a light push
 * channel for a phone's background service, separate from the main socket so
 * it never replaces it. Server -> phone only, JSON text frames.
 */
export type NotifyFrame = { type: "notice"; notice: Notice } | { type: "hello"; ts: number };

/**
 * GET /v1/assistant/live?token=... (WebSocket, viewers only): a voice call.
 *
 * Phone -> relay: binary = 16 kHz mono PCM S16LE microphone audio; text = JSON
 * `{action, ...}` limited to LIVE_CLIENT_ACTIONS.
 * Relay -> phone: binary = 48 kHz mono PCM S16LE speech, each preceded by a
 * `response.audio.context` text frame; text = MOSS-Live events (`{action, data}`)
 * plus the relay's own `relay.state` and `relay.task`.
 *
 * Playback receipts follow what the speaker really played. Before
 * `playback.stopped` the phone receipts every chunk it played in full;
 * `played_audio_ms` is all of the answer it played, and the relay turns it into
 * what the service expects (MOSS-Live: only the part of the chunk being played).
 */
export const LIVE_CLIENT_ACTIONS = [
  "mic_state",
  "playback.chunk.completed",
  "playback.completed",
  "playback.stopped",
  "ping",
  "client.ai_telemetry",
] as const;

export type ClientAiTelemetryStage = "init" | "utterance" | "periodic" | "summary";

/**
 * Phone -> relay (`{ action: "client.ai_telemetry", data: ClientAiTelemetry }`):
 * on-device audio DSP, VAD, speaker verification and target-speaker extraction
 * metrics correlated with server-side call turns in `EventLog` (`live.ai`).
 * Consumed by the relay only; never forwarded upstream to the voice service.
 */
export interface ClientAiTelemetry {
  stage: ClientAiTelemetryStage;
  route?: string;
  models?: string[] | string;
  denoise_model?: string;
  tse_enabled?: boolean;
  sv_enabled?: boolean;
  vad_enabled?: boolean;
  denoise_enabled?: boolean;
  enroll_ms?: number;
  threshold?: number;
  prototypes_count?: number;
  kind?: string;
  pass?: boolean;
  sv_score?: number;
  sv_raw?: number;
  sv_proto?: number;
  sv_sess?: number;
  sv_ms?: number;
  used_ms?: number;
  vad_prob?: number;
  raw_dbfs?: number;
  tse_dbfs?: number;
  enh_dbfs?: number;
  tse_atten_db?: number;
  enh_gain_db?: number;
  frames_in?: number;
  frames_out?: number;
  ws_gap_max_ms?: number;
  dpdf_us_avg?: number;
  dpdf_us_max?: number;
  tse_ms_avg?: number;
  tse_ms_max?: number;
  tse_rtf?: number;
  tse_overruns?: number;
  tse_k?: number;
  tse_bypassed?: boolean;
  vad_speech_ratio?: number;
  gated_ratio?: number;
  utterances?: number;
  pass_count?: number;
  mute_count?: number;
  sv_checks?: number;
  sv_passed?: number;
  duration_ms?: number;
  call_ms?: number;
  [key: string]: unknown;
}

export type LiveRelayEvent =
  | { action: "relay.state"; data: { state: "connecting" | "ready" | "closed" | "error"; message?: string } }
  /** A background task the voice assistant handed to the text assistant. */
  | { action: "relay.task"; data: { id: string; title: string; status: "running" | "done" | "failed" } }
  /**
   * A proactive notice arrived during the call. `line` is what the voice will say; `how` tells when:
   * `now` (it is being said through a running task) or `next` (the voice brings it up the next time the person speaks).
   */
  | { action: "relay.notice"; data: { id: string; line: string; how: "now" | "next" } };

// ---------------------------------------------------------------------------
// Assistant REST (device token)
// ---------------------------------------------------------------------------
//
// GET    /v1/assistant                        -> AssistantState
// POST   /v1/assistant/messages  {text}       -> { item }   (answer arrives as assistant_item frames)
// POST   /v1/assistant/actions/:id {decision: "confirm"|"cancel"} -> { item }
// DELETE /v1/assistant/thread                 -> { ok: true }  (starts a new conversation)
// DELETE /v1/assistant/reminders/:id          -> { ok: true }
// GET    /v1/assistant/settings               -> AssistantSettings & { default: AssistantConfirm }
// POST   /v1/assistant/settings {confirm}     -> AssistantSettings   (phones see assistant_reset)
//
// Configuration (phones; keys are never sent back)
// GET    /v1/assistant/config                 -> AssistantConfigView
// POST   /v1/assistant/config  AssistantConfigChange -> AssistantConfigView   (409 conflict: rev is old;
//                                              other phones see assistant_config; takes effect at once)
// POST   /v1/assistant/config/test {provider, model} | {provider: ProviderPatch, model} -> ModelTestResult
// GET    /v1/assistant/config/models?provider=<id> -> { models: string[] }   (what the provider lists, if it does)
// GET    /v1/assistant/config/voices?provider=<id> -> VoiceCatalogResponse
// GET    /v1/assistant/prompts                -> { prompts: PromptView[] }
// POST   /v1/assistant/prompts/:id {text} | {reset: true} -> PromptView   (other phones see assistant_config)
//
// Logs
// POST   /v1/logs   (device)        body { entries: ClientLogEntry[] } -> { stored }   (same as the `log` frame)
// GET    /v1/logs   (device|admin)  ?since=1h|<ms>&until=&after=<id>&device=<id|name>&kind=&level=&source=&text=&limit=
//                                   -> { entries: LogEntry[] }   (oldest first; `after` for following)
// GET    /admin                     a small control panel (admin token, kept in the tab's sessionStorage)

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------
//
// GET    /v1/health                         -> { ok, version, devices, online }
// POST   /v1/pair/codes        (admin|device) body {kind?, ttlSec?} -> PairCode
// POST   /v1/pair              body PairRequest -> PairResponse   (no auth; code is the secret.
//                              Sending the device's previous token replaces that registration.)
// POST   /v1/join              body {name, kind, platform?} -> JoinTicket   (no auth; rate limited.
//                              A new device asks to join and shows `link` as a QR.)
// POST   /v1/join/:id/claim    body {secret} -> JoinClaim          (the asking device polls this)
// GET    /v1/join/:id          (device)     -> JoinRequest         (what the approver is shown)
// POST   /v1/join/:id/approve  (device)     -> { device: Device }
// POST   /v1/join/:id/deny     (device)     -> { ok: true }
// GET    /v1/devices           (device)     -> { devices: Device[] }
// DELETE /v1/devices/:id       (device)     -> { ok: true }       (revoke)
// GET    /v1/ws?token=...      WebSocket
// GET    /p/:code              HTML landing page for an invite QR (opens the app, shows the code).
// GET    /j/:id                HTML landing page for a join QR. Both only echo the URL; they never
//                              look the code or request up.
//
// First run: while the relay has no devices it keeps a one-time setup code (any device kind,
// 30 min) printed at startup and by `node apps/relay/src/bootstrap.ts`; it is deleted as soon
// as the first device registers.
//
// Auth: `Authorization: Bearer <deviceToken>` (or `?token=` for WebSocket).
// Admin endpoints also accept the relay's admin token.

export interface PairCode {
  code: string; // short human code, e.g. "MEOW-4821"
  expiresAt: number;
  /** What the QR encodes: an https page on the relay, `<server>/p/<code>` (see pairLink). */
  link: string;
}

export interface PairRequest {
  code: string;
  name: string;
  kind: DeviceKind;
  platform?: string;
  /**
   * How the code reached this device, for the relay's log only: `local-login` (the desktop app
   * asked this computer's logged-in herdr-pocket for it), `qr`, `link`, `typed`, `setup`, `cli`.
   */
  via?: string;
}

export interface PairResponse {
  device: Device;
  token: string;
}

/** A device asking to join; a paired device scans its QR and approves it. */
export interface JoinRequest {
  id: string;
  name: string;
  kind: DeviceKind;
  platform?: string;
  expiresAt: number;
}

export interface JoinTicket extends JoinRequest {
  /** Known only to the asking device; needed to collect the token. */
  secret: string;
  /** What the QR encodes: an https page on the relay, `<server>/j/<id>` (see joinLink). */
  link: string;
}

export type JoinClaim = { status: "pending" } | { status: "denied" } | ({ status: "approved" } & PairResponse);

// Links. QR codes carry an https page on the relay (`<server>/p/<code>`, `<server>/j/<id>`),
// so any camera can open them; the page hands the same data to the app through its own
// scheme (`herdrpocket://pair?...`, `herdrpocket://join?...`). The app reads both forms.

const PAIR_CODE = /^[A-Za-z]{2,8}-?\d{2,8}$/;
const JOIN_ID = /^[A-Za-z0-9_-]{8,32}$/;
const trimSlash = (s: string) => s.trim().replace(/\/+$/, "");

/** `<server>/<kind>/<value>`, allowing a trailing slash and query/fragment (chat apps append them). */
function parseWebLink(link: string, kind: "p" | "j"): { server: string; value: string } | null {
  const m = new RegExp(`^(https?:\\/\\/[^\\s?#]+)\\/${kind}\\/([A-Za-z0-9_-]+)\\/?(?:[?#]\\S*)?$`, "i").exec(link.trim());
  return m ? { server: m[1]!, value: m[2]! } : null;
}

function parseAppLink(link: string, kind: "pair" | "join", key: "code" | "id"): { server: string; value: string } | null {
  const m = new RegExp(`^herdrpocket:\\/\\/${kind}\\/?\\?(.*)$`, "i").exec(link.trim());
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const server = q.get("server");
  const value = q.get(key);
  return server && value ? { server, value } : null;
}

/** What a join QR encodes: an https page on the relay. */
export function joinLink(server: string, id: string): string {
  return `${trimSlash(server)}/j/${encodeURIComponent(id)}`;
}

/** The app's own deep link for a join request. */
export function joinAppLink(server: string, id: string): string {
  return `herdrpocket://join?server=${encodeURIComponent(trimSlash(server))}&id=${encodeURIComponent(id)}`;
}

export function parseJoinLink(link: string): { server: string; id: string } | null {
  const hit = parseWebLink(link, "j") ?? parseAppLink(link, "join", "id");
  return hit && JOIN_ID.test(hit.value) ? { server: hit.server, id: hit.value } : null;
}

/** What an invite QR encodes: an https page on the relay. */
export function pairLink(server: string, code: string): string {
  return `${trimSlash(server)}/p/${encodeURIComponent(code)}`;
}

/** The app's own deep link for an invite. */
export function pairAppLink(server: string, code: string): string {
  return `herdrpocket://pair?server=${encodeURIComponent(trimSlash(server))}&code=${encodeURIComponent(code)}`;
}

export function parsePairLink(link: string): { server: string; code: string } | null {
  const hit = parseWebLink(link, "p") ?? parseAppLink(link, "pair", "code");
  return hit && PAIR_CODE.test(hit.value.trim()) ? { server: hit.server, code: normalizeCode(hit.value) } : null;
}

/** Codes are case-insensitive and the dash is optional: "meow4821" -> "MEOW-4821". */
function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/^([A-Z]+)-?(\d+)$/, "$1-$2");
}

export function isPairCode(code: string): boolean {
  return PAIR_CODE.test(code);
}

export function isJoinId(id: string): boolean {
  return JOIN_ID.test(id);
}

/**
 * What a person may paste or type when pairing: a pair link (alone or inside a pasted
 * message), a "server code" pair, or just the code. The server is absent for a bare code.
 */
export function parsePairInput(input: string): { server?: string; code: string } | null {
  const text = input.trim();
  if (!text) return null;
  const link = parsePairLink(text);
  if (link) return link;
  // A whole message pasted from a chat: the link inside it.
  for (const m of text.matchAll(/(?:https?|herdrpocket):\/\/[^\s"'<>，。；）)]+/gi)) {
    const inner = parsePairLink(m[0]);
    if (inner) return inner;
  }
  const parts = text.split(/\s+/);
  const code = parts[parts.length - 1]!;
  if (!PAIR_CODE.test(code)) return null;
  const normalized = normalizeCode(code);
  if (parts.length === 1) return { code: normalized };
  const server = parts.slice(0, -1).join("");
  return /^(https?:\/\/)?[\w.-]+(:\d+)?(\/\S*)?$/i.test(server) ? { server, code: normalized } : null;
}

// Releases. The Android app is published as GitHub release assets; the in-app updater
// and the relay's landing pages read them from this one repository.

export const RELEASE_REPO = "Crosery/herdr-pocket";

/** Where people download the app by hand. */
export const RELEASES_PAGE = `https://github.com/${RELEASE_REPO}/releases/latest`;

/** Release asset contract: `herdr-pocket-<version>-android-arm64.apk`, version without a leading "v". */
export function apkAssetName(version: string): string {
  return `herdr-pocket-${version.trim().replace(/^v/i, "")}-android-arm64.apk`;
}

/** A release asset's address on GitHub (what a mirror is put in front of). */
export function releaseAssetUrl(version: string, name: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${version.trim().replace(/^v/i, "")}/${name}`;
}

/** The newest release's checksum list; GitHub redirects it to the current release's copy. */
export const LATEST_SUMS_URL = `https://github.com/${RELEASE_REPO}/releases/latest/download/SHA256SUMS`;

/** Per-channel release manifest shipped alongside `SHA256SUMS` (mirror-friendly, decoupled per platform). */
export const LATEST_MANIFEST_URL = `https://github.com/${RELEASE_REPO}/releases/latest/download/RELEASE-MANIFEST.json`;

export type ReleaseChannelId =
  | "android-arm64"
  | "ios-arm64"
  | "harmonyos-arm64"
  | "macos-arm64"
  | "macos-x64"
  | "windows-x64-setup"
  | "windows-x64-msi"
  | "linux-x64-appimage"
  | "linux-x64-deb"
  | "bundle";

export interface ReleaseChannelEntry {
  version: string;
  tag: string;
  fileName: string;
  sha256: string;
  size?: number;
  updatedAt?: string;
}

export interface ReleaseManifest {
  schema: 1;
  releaseVersion: string;
  updatedAt: string;
  channels: Partial<Record<ReleaseChannelId, ReleaseChannelEntry>>;
}

const RELEASE_CHANNEL_SUFFIX_RULES: Array<[RegExp, ReleaseChannelId]> = [
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-android-arm64\.apk$/, "android-arm64"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-ios-arm64\.ipa$/, "ios-arm64"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-harmonyos-arm64\.hap$/, "harmonyos-arm64"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-macos-arm64\.dmg$/, "macos-arm64"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-macos-x64\.dmg$/, "macos-x64"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-windows-x64-setup\.exe$/, "windows-x64-setup"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-windows-x64\.msi$/, "windows-x64-msi"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-linux-x64\.AppImage$/, "linux-x64-appimage"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-linux-x64\.deb$/, "linux-x64-deb"],
  [/^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tar\.gz$/, "bundle"],
];

const VALID_CHANNEL_IDS = new Set<ReleaseChannelId>(RELEASE_CHANNEL_SUFFIX_RULES.map(([, id]) => id));
const SEMVER_STR_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HEX64_RE = /^[0-9a-f]{64}$/i;

/** Maps a standard release asset filename to its `ReleaseChannelId` and clean version string. */
export function channelFromAssetName(fileName: string): { channel: ReleaseChannelId; version: string } | null {
  const name = fileName.trim().split("/").pop() ?? "";
  for (const [re, channel] of RELEASE_CHANNEL_SUFFIX_RULES) {
    const m = re.exec(name);
    if (m?.[1]) return { channel, version: m[1] };
  }
  return null;
}

/** Validates and parses a fetched `RELEASE-MANIFEST.json` body (rejecting mirror HTML/error pages). */
export function parseReleaseManifest(raw: string): ReleaseManifest | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.schema !== 1) return null;
  const releaseVersion = typeof obj.releaseVersion === "string" ? obj.releaseVersion.trim().replace(/^v/i, "") : "";
  if (!SEMVER_STR_RE.test(releaseVersion)) return null;
  const updatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt : "";
  const rawChannels = obj.channels;
  if (!rawChannels || typeof rawChannels !== "object" || Array.isArray(rawChannels)) return null;

  const channels: Partial<Record<ReleaseChannelId, ReleaseChannelEntry>> = {};
  for (const [key, val] of Object.entries(rawChannels as Record<string, unknown>)) {
    if (!VALID_CHANNEL_IDS.has(key as ReleaseChannelId)) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const item = val as Record<string, unknown>;
    const version = typeof item.version === "string" ? item.version.trim().replace(/^v/i, "") : "";
    const fileName = typeof item.fileName === "string" ? item.fileName.trim() : "";
    const sha256 = typeof item.sha256 === "string" ? item.sha256.trim().toLowerCase() : "";
    const tag = typeof item.tag === "string" && item.tag.trim() ? item.tag.trim() : `v${version}`;
    if (!SEMVER_STR_RE.test(version) || !HEX64_RE.test(sha256) || !fileName.startsWith("herdr-pocket-") || /[\\/]/.test(fileName)) {
      continue;
    }
    const size = typeof item.size === "number" && Number.isFinite(item.size) && item.size > 0 ? item.size : undefined;
    const itemUpdated = typeof item.updatedAt === "string" && item.updatedAt ? item.updatedAt : undefined;
    channels[key as ReleaseChannelId] = {
      version,
      tag,
      fileName,
      sha256,
      ...(size !== undefined ? { size } : {}),
      ...(itemUpdated ? { updatedAt: itemUpdated } : {}),
    };
  }
  return { schema: 1, releaseVersion, updatedAt, channels };
}

/** Resolves a single platform/architecture channel entry from a parsed `ReleaseManifest`. */
export function resolveChannelFromManifest(
  manifest: ReleaseManifest | null | undefined,
  channel: ReleaseChannelId,
): ReleaseChannelEntry | null {
  if (!manifest) return null;
  return manifest.channels[channel] ?? null;
}

/** Builds a merged `ReleaseManifest` by carrying forward unchanged channels from `previous` and updating newly built assets from `sums`. */
export function buildReleaseManifest(params: {
  releaseVersion: string;
  sums: Record<string, string>;
  sizes?: Record<string, number>;
  previous?: ReleaseManifest | null;
  updatedAt?: string;
}): ReleaseManifest {
  const cleanRelease = params.releaseVersion.trim().replace(/^v/i, "");
  const nowIso = params.updatedAt ?? new Date().toISOString();
  const channels: Partial<Record<ReleaseChannelId, ReleaseChannelEntry>> = {};
  if (params.previous?.channels) {
    for (const [k, v] of Object.entries(params.previous.channels)) {
      if (v) channels[k as ReleaseChannelId] = { ...v };
    }
  }
  for (const [rawName, rawHash] of Object.entries(params.sums)) {
    const fileName = rawName.trim().split("/").pop() ?? "";
    const info = channelFromAssetName(fileName);
    const sha256 = rawHash.trim().toLowerCase();
    if (!info || !HEX64_RE.test(sha256)) continue;
    const size = params.sizes?.[fileName];
    channels[info.channel] = {
      version: info.version,
      tag: `v${info.version}`,
      fileName,
      sha256,
      ...(typeof size === "number" && Number.isFinite(size) && size > 0 ? { size } : {}),
      updatedAt: nowIso,
    };
  }
  return {
    schema: 1,
    releaseVersion: cleanRelease,
    updatedAt: nowIso,
    channels,
  };
}

/**
 * Time zones of mainland China. GitHub downloads crawl there (about 100 KB/s for the APK,
 * measured 2026-11), so release files come through a mirror first.
 */
export const CHINA_TIME_ZONES: ReadonlySet<string> = new Set([
  "Asia/Shanghai",
  "Asia/Beijing",
  "Asia/Chongqing",
  "Asia/Chungking",
  "Asia/Harbin",
  "Asia/Urumqi",
  "Asia/Kashgar",
  "PRC",
]);

/** Primary public proxies that pass GitHub release downloads through, tried in this order. */
export const RELEASE_MIRRORS: readonly string[] = ["https://ghfast.top/", "https://gh-proxy.com/"];

/** Additional healthy CDN mirrors used when probing & striping parallel chunk downloads. */
export const RELEASE_EXTRA_MIRRORS: readonly string[] = ["https://cdn.gh-proxy.com/", "https://edgeone.gh-proxy.com/"];

/** This device's IANA time zone, or "" when the runtime cannot say. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

/** This device's locale (e.g. "zh-CN"), or "" when unavailable. */
export function localLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? "";
  } catch {
    return "";
  }
}

/** True when the device is in mainland China by IANA zone (or UTC+8 + zh-CN locale when the runtime reports an offset ID). */
export function inMainlandChina(timeZone?: string, locale?: string, utcOffsetMinutes?: number): boolean {
  const explicit = timeZone !== undefined;
  const tz = timeZone ?? localTimeZone();
  if (CHINA_TIME_ZONES.has(tz)) return true;
  if (tz === "" || /^(?:GMT|UTC)\+0?8(?::00)?$|^Etc\/GMT-8$/i.test(tz)) {
    const loc = locale ?? (explicit ? "" : localLocale());
    const off = utcOffsetMinutes ?? (explicit && locale === undefined ? 0 : -new Date().getTimezoneOffset());
    if (off === 480 && (/(?:^|[-_])CN(?:$|[-_])/i.test(loc) || /^zh[-_]Hans$/i.test(loc))) return true;
  }
  return false;
}

/**
 * Where to fetch a GitHub release file from, in order: the mirrors first in mainland China,
 * GitHub itself first elsewhere, and the others after it when it fails. Whatever comes
 * through a mirror is checked against SHA256SUMS, and Android only installs an update
 * signed with the app's own key.
 */
export function releaseSources(githubUrl: string, china: boolean): string[] {
  const mirrored = RELEASE_MIRRORS.map((m) => m + githubUrl);
  return china ? [...mirrored, githubUrl] : [githubUrl, ...mirrored];
}

/** Full mirror set (primary + extra edge/CDN mirrors) ordered by region for active probing & parallel striping. */
export function allReleaseSources(githubUrl: string, china: boolean): string[] {
  const mirrored = [...RELEASE_MIRRORS, ...RELEASE_EXTRA_MIRRORS].map((m) => m + githubUrl);
  return china ? [...mirrored, githubUrl] : [githubUrl, ...mirrored];
}

/** The release a `SHA256SUMS` listing belongs to: its version and each file's hash. */
export function releaseFromSums(listing: string): { version: string; sums: Record<string, string> } | null {
  const sums: Record<string, string> = {};
  let version = "";
  for (const line of listing.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (!m) continue;
    sums[m[2]!] = m[1]!.toLowerCase();
    const v = /^herdr-pocket-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:-(?:android-arm64\.apk|ios-arm64\.ipa|harmonyos-arm64\.hap|macos-(?:arm64|x64)\.dmg|windows-x64(?:-setup\.exe|\.msi)|linux-x64(?:\.deb|\.AppImage))|\.tar\.gz)$/.exec(m[2]!);
    if (v && !version) version = v[1]!;
  }
  return version ? { version, sums } : null;
}

/**
 * Compares "1.2.10" with "v1.3" part by part as numbers. A pre-release ("1.3.0-beta.1")
 * sorts before its release. Returns <0, 0 or >0.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const s = v.trim().replace(/^v/i, "");
    const dash = s.indexOf("-");
    const main = dash < 0 ? s : s.slice(0, dash);
    return { nums: main.split(".").map((x) => Number.parseInt(x, 10) || 0), pre: dash < 0 ? undefined : s.slice(dash + 1) };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  // Numbers inside pre-release tags compare as numbers: rc.10 is after rc.9.
  return x.pre.localeCompare(y.pre, "en", { numeric: true });
}

// ---------------------------------------------------------------------------
// Regions and download sources. Pure functions: the CLI, the host daemon, the install
// scripts and the desktop app make the same decision from the same inputs.
// ---------------------------------------------------------------------------

/** `cn`: mainland China, where GitHub is slow or cut, so mirrors go first. `global`: everywhere else. */
export type Region = "cn" | "global";
/** The `update.region` setting: `auto` decides from the time zone. */
export type RegionSetting = "auto" | Region;

export interface RegionDecision {
  region: Region;
  /** What decided it: HERDR_POCKET_MIRROR, the config file, the IANA zone, UTC+8 with a zh-CN locale, or nothing matched. */
  reason: "env" | "config" | "time-zone" | "locale-offset" | "default";
  /** The zone that was looked at ("" when the runtime does not say). */
  timeZone: string;
}

/** HERDR_POCKET_MIRROR: `1`/`true`/`on`/`yes`/`cn` mean mirrors first, `0`/`false`/`off`/`no`/`global` GitHub first. */
export function regionFromEnv(value: string | undefined): Region | undefined {
  const v = (value ?? "").trim();
  if (/^(1|true|on|yes|cn)$/i.test(v)) return "cn";
  if (/^(0|false|off|no|global)$/i.test(v)) return "global";
  return undefined;
}

/**
 * Which region this device downloads as. Order: the environment variable, then the config
 * file's `update.region` (unless `auto`), then the time zone (same rule as `inMainlandChina`).
 * Pass `timeZone`/`locale`/`utcOffsetMinutes` in tests; omitted ones come from the runtime.
 */
export function decideRegion(o: { env?: string; setting?: RegionSetting | string; timeZone?: string; locale?: string; utcOffsetMinutes?: number } = {}): RegionDecision {
  const tz = o.timeZone ?? localTimeZone();
  const fromEnv = regionFromEnv(o.env);
  if (fromEnv) return { region: fromEnv, reason: "env", timeZone: tz };
  if (o.setting === "cn" || o.setting === "global") return { region: o.setting, reason: "config", timeZone: tz };
  if (CHINA_TIME_ZONES.has(tz)) return { region: "cn", reason: "time-zone", timeZone: tz };
  if (inMainlandChina(tz, o.locale ?? (o.timeZone === undefined ? localLocale() : ""), o.utcOffsetMinutes ?? (o.timeZone === undefined ? -new Date().getTimezoneOffset() : 0))) {
    return { region: "cn", reason: "locale-offset", timeZone: tz };
  }
  return { region: "global", reason: "default", timeZone: tz };
}

/** GitHub itself, in a list of source prefixes (a mirror is a prefix put in front of a github.com URL). */
export const DIRECT_SOURCE = "";
/** Each source's probe gets this long; the race is over once one answers. */
export const SOURCE_PROBE_TIMEOUT_MS = 4000;
/** A source within this much of the fastest counts as fast; the earlier one in region order wins then. */
export const SOURCE_PROBE_SLACK_MS = 150;
/** How long the winner of a race is used before the next race. */
export const SOURCE_CACHE_TTL_MS = 24 * 3600_000;

/** A mirror prefix as `update.mirrors` takes it: https (plain http only on this machine), ending in "/". */
export function isMirrorPrefix(s: string): boolean {
  return /^(?:https:\/\/[A-Za-z0-9.-]+|http:\/\/(?:localhost|127\.0\.0\.1))(?::\d+)?(?:\/[^\s?#]*)?\/$/.test(s);
}

/**
 * Sources to try for a GitHub release file, best first: the person's own mirrors, then in
 * mainland China the built-in mirrors before GitHub, elsewhere GitHub before them.
 */
export function sourcePrefixes(region: Region, extra: readonly string[] = []): string[] {
  const own = [...new Set(extra.filter(isMirrorPrefix))];
  const builtIn = [...RELEASE_MIRRORS, ...RELEASE_EXTRA_MIRRORS].filter((m) => !own.includes(m));
  return region === "cn" ? [...own, ...builtIn, DIRECT_SOURCE] : [...own, DIRECT_SOURCE, ...builtIn];
}

/** A github.com URL through a source prefix. */
export function sourceUrl(prefix: string, githubUrl: string): string {
  return prefix + githubUrl;
}

/** Short name of a source for logs and settings screens: `github.com` or the mirror's host. */
export function sourceLabel(prefix: string): string {
  if (!prefix) return "github.com";
  try {
    return new URL(prefix).host;
  } catch {
    return prefix;
  }
}

/** One source's answer in a race. `ms` is the time to a usable answer (or to the failure). */
export interface SourceProbe {
  source: string;
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * The winner of a race: the fastest source that answered, except that one earlier in
 * `order` wins when it was at most `slackMs` slower (GitHub itself over a mirror elsewhere,
 * a mirror over GitHub in mainland China). Undefined when none answered.
 */
export function pickFastest(probes: readonly SourceProbe[], order: readonly string[], slackMs = SOURCE_PROBE_SLACK_MS): string | undefined {
  const ok = probes.filter((p) => p.ok);
  if (!ok.length) return undefined;
  const best = Math.min(...ok.map((p) => p.ms));
  const rank = (s: string) => {
    const i = order.indexOf(s);
    return i < 0 ? order.length : i;
  };
  return ok.filter((p) => p.ms <= best + slackMs).sort((a, b) => rank(a.source) - rank(b.source) || a.ms - b.ms)[0]!.source;
}

export {
  isRecommendedSourceForRegion,
  orderWithPreferredSource,
  pickLowestLatency,
  resolvePreferredSource,
} from "./updateSelect.ts";

/** `order` with `winner` moved to the front: the ordered fallback after a race. */
export function withWinnerFirst(order: readonly string[], winner: string | undefined): string[] {
  return winner === undefined || !order.includes(winner) ? [...order] : [winner, ...order.filter((s) => s !== winner)];
}

/** What a device remembers about its last race (the host keeps it in its state folder as `sources.json`). */
export interface SourceCache {
  region: Region;
  winner: string;
  /** When the race was run (epoch ms). */
  at: number;
  probes?: SourceProbe[];
}

/** The remembered winner, while it is fresh, for the same region and still one of `order`'s sources. */
export function cachedWinner(cache: unknown, region: Region, order: readonly string[], now = Date.now(), ttlMs = SOURCE_CACHE_TTL_MS): string | undefined {
  if (!cache || typeof cache !== "object") return undefined;
  const c = cache as Partial<SourceCache>;
  if (c.region !== region || typeof c.winner !== "string" || typeof c.at !== "number") return undefined;
  if (now - c.at < 0 || now - c.at >= ttlMs || !order.includes(c.winner)) return undefined;
  return c.winner;
}

/** `ms` moved by up to ±`fraction` at random, so many devices do not ask at the same moment. */
export function withJitter(ms: number, fraction = 0.1, rand: () => number = Math.random): number {
  return Math.max(0, Math.round(ms * (1 - fraction + 2 * fraction * rand())));
}

/** Periodic update checks: the first 15–60 s after start, then every `hours` (0.25–168), both jittered. */
export function updateCheckDelays(hours: number, rand: () => number = Math.random): { firstMs: number; everyMs: number } {
  const h = Math.min(168, Math.max(0.25, Number.isFinite(hours) ? hours : 0.5));
  return { firstMs: 15_000 + Math.round(rand() * 45_000), everyMs: withJitter(h * 3600_000, 0.1, rand) };
}

// ---------------------------------------------------------------------------
// Client config file: one user-level file shared by the CLI (`herdr-pocket config`) and
// the desktop app. docs/config.md documents every key.
// ---------------------------------------------------------------------------

/**
 * `config.json` in the config folder, next to hostd.json: `~/.config/herdr-pocket/config.json`,
 * `%APPDATA%\herdr-pocket\config.json` on Windows, `$HERDR_POCKET_HOME/config.json` when that is set.
 * Plain JSON (no comments), UTF-8. Never secrets: tokens stay in hostd.json and the desktop's
 * session file. Every key is optional; a missing or invalid value means its default. Writers change
 * only the keys they set, keep keys they do not know (a newer client's), and always write `version`.
 */
export const CLIENT_CONFIG_FILE = "config.json";
export const CLIENT_CONFIG_VERSION = 1;

export type ChatDisplayMode = "compact" | "standard" | "expanded";

export interface ClientConfig {
  version: number;
  general: {
    language: "zh-CN" | "en";
    theme: "system" | "light" | "dark";
    textScale: number;
    fontFamily: string;
    chatDisplayMode: ChatDisplayMode;
    showShells: boolean;
    useLocalLogin: boolean;
    launchAtLogin: boolean;
    closeToTray: boolean;
    notifications: boolean;
    dynamicIsland: boolean;
  };
  update: {
    region: RegionSetting;
    preferredSource: string;
    autoCheck: boolean;
    checkIntervalHours: number;
    mirrors: string[];
    checkTools: boolean;
  };
  logging: {
    level: LogLevel;
    upload: boolean;
    keepDays: number;
  };
  voiceInput: {
    enabled: boolean;
    hotkey: string;
    mode: "hold" | "toggle";
    language: string;
    insert: "paste" | "type" | "clipboard";
    maxSeconds: number;
    sounds: boolean;
    denoise: boolean;
  };
  browser: {
    homePage: string;
    searchEngine: "bing" | "google" | "baidu" | "duckduckgo";
    cookieImport: "ask" | "off";
    clearOnExit: boolean;
  };
  files: {
    showHidden: boolean;
    showIgnored: boolean;
  };
  resources: {
    lowPower: "auto" | "on" | "off";
    memoryWarnMb: number;
    diskWarnGb: number;
  };
  terminal: {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    fontWeight: number;
    cursorBlink: boolean;
  };
}

export type ConfigValue = boolean | number | string | string[];
/** Who reads a key: the `herdr-pocket` CLI, its daemon, the desktop app. */
export type ConfigReader = "cli" | "hostd" | "desktop";

export interface ConfigKeySpec {
  /** `section.name`. */
  key: string;
  type: "boolean" | "integer" | "number" | "enum" | "string" | "list";
  default: ConfigValue;
  values?: readonly string[];
  min?: number;
  max?: number;
  /** Extra check of a string (or of each list item). */
  format?: "url" | "mirror" | "sourceChoice" | "hotkey" | "language";
  /** The programs that read the key. Empty: reserved, kept valid but read by nothing yet. */
  usedBy: readonly ConfigReader[];
  /** Label for settings screens (Chinese, like the rest of the UI). */
  label: string;
  /** One line in English; docs/config.md has the details. */
  doc: string;
  /** Environment variable that wins over the file, if any. */
  env?: string;
}

const D: readonly ConfigReader[] = ["desktop"];
const ALL: readonly ConfigReader[] = ["cli", "hostd", "desktop"];

/** Every key of the file, in display order. */
export const CLIENT_CONFIG_KEYS: readonly ConfigKeySpec[] = [
  { key: "general.language", type: "enum", values: ["zh-CN", "en"], default: "zh-CN", usedBy: D, label: "界面语言", doc: "Language of the desktop app." },
  { key: "general.theme", type: "enum", values: ["system", "light", "dark"], default: "system", usedBy: D, label: "外观", doc: "Light, dark, or follow the system." },
  { key: "general.textScale", type: "integer", min: 80, max: 160, default: 100, usedBy: D, label: "文字大小（%）", doc: "Text size of the desktop app in percent." },
  { key: "general.fontFamily", type: "string", default: "", usedBy: D, label: "界面字体", doc: "Global UI font family of the desktop app; empty uses the default stack." },
  {
    key: "general.chatDisplayMode",
    type: "enum",
    values: ["compact", "standard", "expanded"],
    default: "standard",
    usedBy: D,
    label: "对话展示模式",
    doc: "compact: fold thinking and consecutive tools together. standard: separate thinking blocks, fold consecutive tools into one group. expanded: show every thinking block and tool call.",
  },
  { key: "general.showShells", type: "boolean", default: false, usedBy: D, label: "显示普通终端", doc: "List plain shells beside the agents." },
  { key: "general.useLocalLogin", type: "boolean", default: true, usedBy: D, label: "使用本机 herdr-pocket 的登录", doc: "When this computer's herdr-pocket is logged in (hostd.json), the desktop app joins the same relay with it." },
  { key: "general.launchAtLogin", type: "boolean", default: false, usedBy: D, label: "开机时启动", doc: "Start the desktop app when you log in." },
  { key: "general.closeToTray", type: "boolean", default: false, usedBy: D, label: "关闭窗口后留在托盘", doc: "Closing the window keeps the app in the menu bar / tray. Off by default: closing the window quits the app." },
  { key: "general.notifications", type: "boolean", default: true, usedBy: D, label: "系统通知", doc: "System notifications when an agent finishes or waits." },
  { key: "general.dynamicIsland", type: "boolean", default: true, usedBy: D, label: "灵动岛与顶部提醒胶囊", doc: "Show live agent reminders and quick jump in the macOS Dynamic Island / top capsule." },
  { key: "update.region", type: "enum", values: ["auto", "cn", "global"], default: "auto", usedBy: ALL, label: "下载线路", doc: "auto: by time zone. cn: mirrors first. global: GitHub first.", env: "HERDR_POCKET_MIRROR" },
  { key: "update.preferredSource", type: "string", format: "sourceChoice", default: "auto", usedBy: ALL, label: "首选镜像源", doc: "auto: recommend by time zone and pick lowest-latency reachable source. direct: GitHub directly. Or a mirror prefix URL." },
  { key: "update.autoCheck", type: "boolean", default: true, usedBy: ALL, label: "自动检查更新", doc: "Look for a new release now and then.", env: "HERDR_POCKET_UPDATE_CHECK" },
  { key: "update.checkIntervalHours", type: "number", min: 0.25, max: 168, default: 0.5, usedBy: ALL, label: "自动检查频率", doc: "Hours between automatic checks (jittered by ±10%)." },
  { key: "update.mirrors", type: "list", format: "mirror", default: [], usedBy: ALL, label: "自定义镜像", doc: "Your own GitHub mirror prefixes (https://…/), raced before the built-in ones." },
  { key: "update.checkTools", type: "boolean", default: true, usedBy: ["hostd"], label: "检查 hc、Herdr、uniflo 新版本", doc: "Once a day, look for newer hc, Herdr app and uniflo releases (report only; needs update.autoCheck)." },
  { key: "logging.level", type: "enum", values: ["debug", "info", "warn", "error"], default: "info", usedBy: ALL, label: "日志级别", doc: "Lowest level written and uploaded." },
  { key: "logging.upload", type: "boolean", default: true, usedBy: ["hostd", "desktop"], label: "上传日志到中转服务", doc: "Send this device's log lines to the relay (`herdr-pocket logs` reads them)." },
  { key: "logging.keepDays", type: "integer", min: 1, max: 90, default: 7, usedBy: D, label: "本地日志保留天数", doc: "Days of local log files the desktop app keeps." },
  { key: "voiceInput.enabled", type: "boolean", default: true, usedBy: D, label: "快捷键唤醒小羊", doc: "Toggle Xiaoyang realtime voice call with a global shortcut." },
  { key: "voiceInput.hotkey", type: "string", format: "hotkey", default: "CommandOrControl+Shift+Space", usedBy: D, label: "唤醒快捷键", doc: "A shortcut with at least one modifier (Tauri accelerator syntax), or one modifier key alone (RightOption, RightControl, RightCommand, RightShift, Fn) tapped to toggle a Xiaoyang realtime voice call." },
  { key: "voiceInput.mode", type: "enum", values: ["hold", "toggle"], default: "hold", usedBy: [], label: "唤醒方式（已停用）", doc: "Legacy dictation mode; global hotkey now toggles Xiaoyang voice call on press." },
  { key: "voiceInput.language", type: "string", format: "language", default: "auto", usedBy: [], label: "识别语言（已停用）", doc: "Legacy dictation setting; kept for config compatibility." },
  { key: "voiceInput.insert", type: "enum", values: ["paste", "type", "clipboard"], default: "paste", usedBy: [], label: "识别结果（已停用）", doc: "Legacy dictation setting; kept for config compatibility." },
  { key: "voiceInput.maxSeconds", type: "integer", min: 5, max: 300, default: 60, usedBy: [], label: "单次最长（已停用）", doc: "Legacy dictation setting; kept for config compatibility." },
  { key: "voiceInput.sounds", type: "boolean", default: true, usedBy: D, label: "通话提示音", doc: "A short sound when Xiaoyang voice call connects or disconnects." },
  // Reserved: nothing reads it yet (the desktop app's call noise suppression is its own setting).
  { key: "voiceInput.denoise", type: "boolean", default: true, usedBy: [], label: "降噪", doc: "Reserved for noise suppression on the microphone; nothing reads it yet." },
  { key: "browser.homePage", type: "string", format: "url", default: "", usedBy: D, label: "内置浏览器主页", doc: "Page a new browser tab opens; empty for a blank tab." },
  { key: "browser.searchEngine", type: "enum", values: ["bing", "google", "baidu", "duckduckgo"], default: "bing", usedBy: D, label: "搜索引擎", doc: "Used for words typed into the address bar." },
  { key: "browser.cookieImport", type: "enum", values: ["ask", "off"], default: "ask", usedBy: D, label: "从其他浏览器导入 Cookie", doc: "ask: offer it (each import asks first). off: never read other browsers' cookies." },
  { key: "browser.clearOnExit", type: "boolean", default: false, usedBy: D, label: "退出时清除浏览数据", doc: "Drop the built-in browser's cookies and cache on quit." },
  { key: "files.showHidden", type: "boolean", default: false, usedBy: D, label: "显示隐藏文件", doc: "List dot files in the file view." },
  { key: "files.showIgnored", type: "boolean", default: false, usedBy: D, label: "显示 node_modules 等目录", doc: "List heavy generated folders (node_modules, .git, dist, …)." },
  { key: "resources.lowPower", type: "enum", values: ["auto", "on", "off"], default: "auto", usedBy: D, label: "省电模式", doc: "auto: on battery. on: always. Slower polling, fewer animations." },
  { key: "resources.memoryWarnMb", type: "integer", min: 256, max: 16384, default: 1024, usedBy: D, label: "内存提醒（MB）", doc: "Warn when the desktop app uses more memory than this." },
  { key: "resources.diskWarnGb", type: "integer", min: 1, max: 1000, default: 5, usedBy: D, label: "磁盘空间提醒（GB）", doc: "Warn when free disk space falls below this." },
  { key: "terminal.fontFamily", type: "string", default: "", usedBy: D, label: "终端字体", doc: "Monospace font family for the desktop terminal; empty uses the default stack." },
  { key: "terminal.fontSize", type: "integer", min: 10, max: 28, default: 14, usedBy: D, label: "终端字号", doc: "Font size of the desktop terminal in pixels." },
  { key: "terminal.lineHeight", type: "integer", min: 100, max: 200, default: 115, usedBy: D, label: "终端行高（%）", doc: "Line height of the desktop terminal in percent." },
  { key: "terminal.fontWeight", type: "integer", min: 300, max: 700, default: 500, usedBy: D, label: "终端字重", doc: "Normal text weight of the desktop terminal (bold stays 700)." },
  { key: "terminal.cursorBlink", type: "boolean", default: true, usedBy: D, label: "终端光标闪烁", doc: "Blink the cursor in the desktop terminal." },
];

/** The file's sections, in order. */
export const CLIENT_CONFIG_SECTIONS = ["general", "update", "logging", "voiceInput", "browser", "files", "resources", "terminal"] as const;

export interface ConfigProblem {
  /** `section.name`, a section, or "" for the whole file. */
  key: string;
  level: "warn" | "error";
  message: string;
}

export function configKeySpec(key: string): ConfigKeySpec | undefined {
  return CLIENT_CONFIG_KEYS.find((s) => s.key === key);
}

export function defaultClientConfig(): ClientConfig {
  const out: Record<string, unknown> = { version: CLIENT_CONFIG_VERSION };
  for (const s of CLIENT_CONFIG_SECTIONS) out[s] = {};
  for (const spec of CLIENT_CONFIG_KEYS) {
    const [section, name] = spec.key.split(".") as [string, string];
    (out[section] as Record<string, unknown>)[name] = Array.isArray(spec.default) ? [...spec.default] : spec.default;
  }
  return out as unknown as ClientConfig;
}

/**
 * Modifier keys that work alone as a hold-to-talk key (Typeless / Doubao style). RightCommand and Fn
 * exist on macOS only; the file is per machine, so any OS takes them and the desktop app refuses
 * what its OS cannot register.
 */
export const HOTKEY_SOLO_KEYS: readonly string[] = ["RightOption", "RightControl", "RightCommand", "RightShift", "Fn"];
const HOTKEY_SOLO_ALIASES: Record<string, string> = {
  rightoption: "RightOption",
  rightalt: "RightOption",
  rightcontrol: "RightControl",
  rightctrl: "RightControl",
  rightcommand: "RightCommand",
  rightshift: "RightShift",
  fn: "Fn",
};

/** A hotkey as stored: a modifier key alone under its one name (RightAlt -> RightOption), a shortcut without spaces around "+". */
export function normalizeHotkey(v: string): string {
  const t = v.trim();
  return HOTKEY_SOLO_ALIASES[t.toLowerCase()] ?? t.split("+").map((p) => p.trim()).join("+");
}

/** A value as it is stored: aliases replaced by their one name (only hotkeys have any). */
export function normalizeConfigValue(spec: ConfigKeySpec, value: ConfigValue): ConfigValue {
  return spec.format === "hotkey" && typeof value === "string" ? normalizeHotkey(value) : value;
}

const HOTKEY_MODIFIER = /^(CommandOrControl|CmdOrCtrl|CmdOrControl|Command|Cmd|Control|Ctrl|Alt|Option|AltGr|Shift|Super|Meta)$/i;
const HOTKEY_KEY = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Enter|Return|Tab|Backspace|Delete|Escape|Esc|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus|Minus|Equal|Comma|Period|Slash|Backslash|Semicolon|Quote|Backquote|BracketLeft|BracketRight|Key[A-Z]|Digit[0-9])$/i;

function formatError(format: ConfigKeySpec["format"], v: string): string | undefined {
  switch (format) {
    case "url":
      return v === "" || /^https?:\/\/\S+$/i.test(v) ? undefined : "needs an http(s):// address or nothing";
    case "mirror":
      return isMirrorPrefix(v) ? undefined : `${JSON.stringify(v)} is not a mirror prefix like https://mirror.example.com/`;
    case "sourceChoice":
      return v === "auto" || v === "direct" || isMirrorPrefix(v)
        ? undefined
        : `${JSON.stringify(v)} must be "auto", "direct", or a mirror prefix like https://mirror.example.com/`;
    case "language":
      return v === "auto" || /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(v) ? undefined : "needs auto or a language code such as zh or en";
    case "hotkey": {
      if (HOTKEY_SOLO_KEYS.includes(normalizeHotkey(v))) return undefined;
      const parts = v.split("+").map((p) => p.trim());
      const key = parts.pop() ?? "";
      if (!parts.length || !parts.every((p) => HOTKEY_MODIFIER.test(p)) || !HOTKEY_KEY.test(key)) {
        return "needs a shortcut with a modifier (CommandOrControl+Shift+Space) or one modifier key alone (RightOption, RightControl, RightCommand, RightShift, Fn)";
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Why `value` cannot be stored under `spec`, or undefined when it can. */
export function configValueError(spec: ConfigKeySpec, value: unknown): string | undefined {
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : "needs true or false";
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return "needs a whole number";
      if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) return `needs ${spec.min}–${spec.max}`;
      return undefined;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "needs a number";
      if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) return `needs ${spec.min}–${spec.max}`;
      return undefined;
    case "enum":
      return typeof value === "string" && spec.values!.includes(value) ? undefined : `needs one of ${spec.values!.join(", ")}`;
    case "string":
      if (typeof value !== "string" || value.length > 500) return "needs a short text";
      return formatError(spec.format, value);
    case "list":
      if (!Array.isArray(value) || value.length > 20 || !value.every((x) => typeof x === "string")) return "needs a list of up to 20 texts";
      for (const x of value as string[]) {
        const e = formatError(spec.format, x);
        if (e) return e;
      }
      return undefined;
  }
}

/** Typed text (the CLI's `config set`) as a value of `key`: true/false/on/off, numbers, comma lists or a JSON array. */
export function parseConfigText(key: string, text: string): { value: ConfigValue } | { error: string } {
  const spec = configKeySpec(key);
  if (!spec) return { error: `unknown key ${key}` };
  const t = text.trim();
  let value: unknown = t;
  if (spec.type === "boolean") value = /^(true|on|yes|1)$/i.test(t) ? true : /^(false|off|no|0)$/i.test(t) ? false : t;
  else if (spec.type === "integer") value = /^-?\d+$/.test(t) ? Number(t) : t;
  else if (spec.type === "number") value = /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : t;
  else if (spec.type === "list") {
    if (t.startsWith("[")) {
      try {
        value = JSON.parse(t);
      } catch {
        return { error: "not a JSON array" };
      }
    } else value = t ? t.split(",").map((x) => x.trim()).filter(Boolean) : [];
  } else if (spec.type === "string") value = text;
  const error = configValueError(spec, value);
  return error ? { error: `${key} ${error}` } : { value: normalizeConfigValue(spec, value as ConfigValue) };
}

const SECRET_NAME = /token|secret|password|passwd|api[-_]?key|private[-_]?key|credential/i;

/** Keys anywhere in the file that look like they hold a secret. */
function secretKeys(v: unknown, at: string, out: string[]): string[] {
  if (!v || typeof v !== "object" || out.length > 20) return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const key = at ? `${at}.${k}` : k;
    if (SECRET_NAME.test(k)) out.push(key);
    else secretKeys(x, key, out);
  }
  return out;
}

/** The file's content as typed values: defaults for what is missing or wrong, and what was wrong. Never throws. */
export function parseClientConfig(raw: unknown): { config: ClientConfig; problems: ConfigProblem[] } {
  const config = defaultClientConfig() as unknown as Record<string, Record<string, unknown>> & { version: number };
  const problems: ConfigProblem[] = [];
  if (raw === undefined || raw === null) return { config: config as unknown as ClientConfig, problems };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    problems.push({ key: "", level: "error", message: "the file is not a JSON object; defaults are used" });
    return { config: config as unknown as ClientConfig, problems };
  }
  const file = raw as Record<string, unknown>;
  for (const key of secretKeys(file, "", [])) problems.push({ key, level: "error", message: "secrets do not belong in config.json (tokens stay in hostd.json)" });
  const sections: readonly string[] = CLIENT_CONFIG_SECTIONS;
  for (const [name, section] of Object.entries(file)) {
    if (name === "version") {
      if (typeof section === "number" && Number.isInteger(section) && section >= 1) config.version = section;
      else problems.push({ key: "version", level: "warn", message: `version should be ${CLIENT_CONFIG_VERSION}` });
      continue;
    }
    if (name === "$schema") continue;
    if (!sections.includes(name)) {
      problems.push({ key: name, level: "warn", message: "unknown section, kept as it is" });
      continue;
    }
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      problems.push({ key: name, level: "error", message: "needs to be an object; defaults are used" });
      continue;
    }
    for (const [k, v] of Object.entries(section as Record<string, unknown>)) {
      const key = `${name}.${k}`;
      const spec = configKeySpec(key);
      if (!spec) {
        problems.push({ key, level: "warn", message: "unknown key, kept as it is" });
        continue;
      }
      const error = configValueError(spec, v);
      if (error) problems.push({ key, level: "error", message: `${error}; the default (${JSON.stringify(spec.default)}) is used` });
      else config[name]![k] = Array.isArray(v) ? [...v] : normalizeConfigValue(spec, v as ConfigValue);
    }
  }
  if (config.version > CLIENT_CONFIG_VERSION) problems.push({ key: "version", level: "warn", message: `written by a newer version (${config.version}); keys this one does not know are kept` });
  return { config: config as unknown as ClientConfig, problems };
}

export function getConfigValue(config: ClientConfig, key: string): ConfigValue | undefined {
  const [section, name] = key.split(".");
  return (config as unknown as Record<string, Record<string, ConfigValue> | undefined>)[section ?? ""]?.[name ?? ""];
}

/**
 * The file's object with one key set (`value`) or removed (undefined: back to the default),
 * everything else as it was, and `version` written. Validate first (`parseConfigText`, `configValueError`).
 */
export function withConfigValue(raw: unknown, key: string, value: ConfigValue | undefined): Record<string, unknown> {
  const file: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? structuredClone(raw as Record<string, unknown>) : {};
  const [section, name] = key.split(".") as [string, string];
  const spec = configKeySpec(key);
  if (spec && value !== undefined) value = normalizeConfigValue(spec, value);
  const v = file.version;
  const out: Record<string, unknown> = { version: typeof v === "number" && Number.isInteger(v) && v > CLIENT_CONFIG_VERSION ? v : CLIENT_CONFIG_VERSION };
  for (const [k, x] of Object.entries(file)) if (k !== "version") out[k] = x;
  const cur = out[section];
  const sec: Record<string, unknown> = cur && typeof cur === "object" && !Array.isArray(cur) ? { ...(cur as Record<string, unknown>) } : {};
  if (value === undefined) delete sec[name];
  else sec[name] = Array.isArray(value) ? [...value] : value;
  if (Object.keys(sec).length) out[section] = sec;
  else delete out[section];
  return out;
}

// ---------------------------------------------------------------------------
// Helpers shared by host and app
// ---------------------------------------------------------------------------

export const SHELL_HARNESSES = new Set(["sh", "zsh", "bash", "fish", "nu", "pwsh", "powershell", "shell"]);

export function normalizeStatus(raw: string | null | undefined): AgentStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "working":
    case "work":
    case "busy":
      return "working";
    case "blocked":
    case "waiting":
    case "needs_input":
    // The program stopped on an error (e.g. "pick a different model"): it waits for a person too.
    // `statusNote` carries what it said.
    case "error":
    case "failed":
      return "blocked";
    case "done":
      return "done";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

/** Sort weight: what needs a human first. */
export const STATUS_ORDER: Record<AgentStatus, number> = {
  blocked: 0,
  working: 1,
  done: 2,
  idle: 3,
  unknown: 4,
};

// ---------------------------------------------------------------------------
// Direct links (phone <-> computer without the relay)

/** What `direct.offer` returns. */
export interface DirectOffer {
  port: number;
  /** This computer's addresses, the likeliest first (LAN, then VPN). */
  addrs: string[];
  /** Single use; dies at `expiresAt` if unused. */
  ticket: string;
  /** 32 bytes, base64: the ChaCha20-Poly1305 key of the one link this ticket opens. */
  key: string;
  expiresAt: number;
}

export const DIRECT_PATH = "/v1/direct";

/**
 * Authenticated encryption, RFC 8439 ChaCha20-Poly1305 (12-byte nonce, 16-byte tag appended). Each side
 * brings its own implementation: Node's crypto on the computer, a JavaScript one in the app.
 */
export interface DirectAead {
  seal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array): Uint8Array;
  /** Null when the data was not sealed with this key and nonce. */
  open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array): Uint8Array | null;
}

/** Who sealed a frame: part of the nonce, so the two directions never share one. */
export const DIRECT_FROM_PHONE = 1;
export const DIRECT_FROM_HOST = 2;

/** Nonce of the `n`th frame one side sends: its direction byte, then `n` as a 64-bit big-endian count. */
export function directNonce(from: number, n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce[0] = from;
  let x = n;
  for (let i = 11; i >= 4; i--) {
    nonce[i] = x % 256;
    x = Math.floor(x / 256);
  }
  return nonce;
}

function u32le(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

function writeU32le(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}

function rotl32(v: number, c: number): number {
  return ((v << c) | (v >>> (32 - c))) >>> 0;
}

function qr(x: Uint32Array, a: number, b: number, c: number, d: number): void {
  let xa = x[a]!;
  let xb = x[b]!;
  let xc = x[c]!;
  let xd = x[d]!;
  xa = (xa + xb) >>> 0; xd = rotl32(xd ^ xa, 16);
  xc = (xc + xd) >>> 0; xb = rotl32(xb ^ xc, 12);
  xa = (xa + xb) >>> 0; xd = rotl32(xd ^ xa, 8);
  xc = (xc + xd) >>> 0; xb = rotl32(xb ^ xc, 7);
  x[a] = xa; x[b] = xb; x[c] = xc; x[d] = xd;
}

function chacha20Block(key: Uint8Array, counter: number, nonce: Uint8Array, out: Uint8Array): void {
  const init = new Uint32Array(16);
  init[0] = 0x61707865;
  init[1] = 0x3320646e;
  init[2] = 0x79622d32;
  init[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) init[4 + i] = u32le(key, i * 4);
  init[12] = counter >>> 0;
  init[13] = u32le(nonce, 0);
  init[14] = u32le(nonce, 4);
  init[15] = u32le(nonce, 8);

  const w = new Uint32Array(init);
  for (let i = 0; i < 10; i++) {
    qr(w, 0, 4, 8, 12);
    qr(w, 1, 5, 9, 13);
    qr(w, 2, 6, 10, 14);
    qr(w, 3, 7, 11, 15);
    qr(w, 0, 5, 10, 15);
    qr(w, 1, 6, 11, 12);
    qr(w, 2, 7, 8, 13);
    qr(w, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) writeU32le(out, i * 4, (w[i]! + init[i]!) >>> 0);
}

function chacha20Xor(key: Uint8Array, nonce: Uint8Array, input: Uint8Array, out: Uint8Array): void {
  const block = new Uint8Array(64);
  let counter = 1;
  for (let offset = 0; offset < input.length; offset += 64) {
    chacha20Block(key, counter, nonce, block);
    counter = (counter + 1) >>> 0;
    const end = Math.min(64, input.length - offset);
    for (let i = 0; i < end; i++) {
      out[offset + i] = input[offset + i]! ^ block[i]!;
    }
  }
}

function poly1305ToLimbs13(bytes: Uint8Array, offset: number, len: number, out: Uint32Array | Float64Array, addHibit: boolean): void {
  // Pack up to 16 little-endian bytes (0..127 bits) + optional 2^128 bit into 10 x 13-bit limbs.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  if (len >= 16) {
    b0 = u32le(bytes, offset);
    b1 = u32le(bytes, offset + 4);
    b2 = u32le(bytes, offset + 8);
    b3 = u32le(bytes, offset + 12);
  } else {
    if (len > 0) {
      const end0 = Math.min(4, len);
      for (let i = 0; i < end0; i++) b0 |= bytes[offset + i]! << (i * 8);
    }
    if (len > 4) {
      const end1 = Math.min(8, len);
      for (let i = 4; i < end1; i++) b1 |= bytes[offset + i]! << ((i - 4) * 8);
    }
    if (len > 8) {
      const end2 = Math.min(12, len);
      for (let i = 8; i < end2; i++) b2 |= bytes[offset + i]! << ((i - 8) * 8);
    }
    if (len > 12) {
      const end3 = Math.min(16, len);
      for (let i = 12; i < end3; i++) b3 |= bytes[offset + i]! << ((i - 12) * 8);
    }
    b0 >>>= 0;
    b1 >>>= 0;
    b2 >>>= 0;
    b3 >>>= 0;
  }

  out[0] = b0 & 0x1fff;
  out[1] = (b0 >>> 13) & 0x1fff;
  out[2] = ((b0 >>> 26) | (b1 << 6)) & 0x1fff;
  out[3] = (b1 >>> 7) & 0x1fff;
  out[4] = ((b1 >>> 20) | (b2 << 12)) & 0x1fff;
  out[5] = (b2 >>> 1) & 0x1fff;
  out[6] = (b2 >>> 14) & 0x1fff;
  out[7] = ((b2 >>> 27) | (b3 << 5)) & 0x1fff;
  out[8] = (b3 >>> 8) & 0x1fff;
  out[9] = ((b3 >>> 21) & 0x07ff) | (addHibit ? 0x0800 : 0);
}

function poly1305AeadTag(otk: Uint8Array, ciphertext: Uint8Array, ctLen: number): Uint8Array {
  const rBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) rBytes[i] = otk[i]!;
  rBytes[3]! &= 15;
  rBytes[7]! &= 15;
  rBytes[11]! &= 15;
  rBytes[15]! &= 15;
  rBytes[4]! &= 252;
  rBytes[8]! &= 252;
  rBytes[12]! &= 252;

  const r = new Float64Array(10);
  poly1305ToLimbs13(rBytes, 0, 16, r, false);
  const r0 = r[0]!, r1 = r[1]!, r2 = r[2]!, r3 = r[3]!, r4 = r[4]!;
  const r5 = r[5]!, r6 = r[6]!, r7 = r[7]!, r8 = r[8]!, r9 = r[9]!;
  const s1 = r1 * 5, s2 = r2 * 5, s3 = r3 * 5, s4 = r4 * 5;
  const s5 = r5 * 5, s6 = r6 * 5, s7 = r7 * 5, s8 = r8 * 5, s9 = r9 * 5;

  let h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0, h8 = 0, h9 = 0;
  const block = new Uint32Array(10);

  const mulBlock = () => {
    const t0 = h0 + block[0]!;
    const t1 = h1 + block[1]!;
    const t2 = h2 + block[2]!;
    const t3 = h3 + block[3]!;
    const t4 = h4 + block[4]!;
    const t5 = h5 + block[5]!;
    const t6 = h6 + block[6]!;
    const t7 = h7 + block[7]!;
    const t8 = h8 + block[8]!;
    const t9 = h9 + block[9]!;

    const d0 = t0 * r0 + t1 * s9 + t2 * s8 + t3 * s7 + t4 * s6 + t5 * s5 + t6 * s4 + t7 * s3 + t8 * s2 + t9 * s1;
    const d1 = t0 * r1 + t1 * r0 + t2 * s9 + t3 * s8 + t4 * s7 + t5 * s6 + t6 * s5 + t7 * s4 + t8 * s3 + t9 * s2;
    const d2 = t0 * r2 + t1 * r1 + t2 * r0 + t3 * s9 + t4 * s8 + t5 * s7 + t6 * s6 + t7 * s5 + t8 * s4 + t9 * s3;
    const d3 = t0 * r3 + t1 * r2 + t2 * r1 + t3 * r0 + t4 * s9 + t5 * s8 + t6 * s7 + t7 * s6 + t8 * s5 + t9 * s4;
    const d4 = t0 * r4 + t1 * r3 + t2 * r2 + t3 * r1 + t4 * r0 + t5 * s9 + t6 * s8 + t7 * s7 + t8 * s6 + t9 * s5;
    const d5 = t0 * r5 + t1 * r4 + t2 * r3 + t3 * r2 + t4 * r1 + t5 * r0 + t6 * s9 + t7 * s8 + t8 * s7 + t9 * s6;
    const d6 = t0 * r6 + t1 * r5 + t2 * r4 + t3 * r3 + t4 * r2 + t5 * r1 + t6 * r0 + t7 * s9 + t8 * s8 + t9 * s7;
    const d7 = t0 * r7 + t1 * r6 + t2 * r5 + t3 * r4 + t4 * r3 + t5 * r2 + t6 * r1 + t7 * r0 + t8 * s9 + t9 * s8;
    const d8 = t0 * r8 + t1 * r7 + t2 * r6 + t3 * r5 + t4 * r4 + t5 * r3 + t6 * r2 + t7 * r1 + t8 * r0 + t9 * s9;
    const d9 = t0 * r9 + t1 * r8 + t2 * r7 + t3 * r6 + t4 * r5 + t5 * r4 + t6 * r3 + t7 * r2 + t8 * r1 + t9 * r0;

    let c: number;
    let v = d0; c = Math.floor(v / 8192); h0 = v - c * 8192;
    v = d1 + c; c = Math.floor(v / 8192); h1 = v - c * 8192;
    v = d2 + c; c = Math.floor(v / 8192); h2 = v - c * 8192;
    v = d3 + c; c = Math.floor(v / 8192); h3 = v - c * 8192;
    v = d4 + c; c = Math.floor(v / 8192); h4 = v - c * 8192;
    v = d5 + c; c = Math.floor(v / 8192); h5 = v - c * 8192;
    v = d6 + c; c = Math.floor(v / 8192); h6 = v - c * 8192;
    v = d7 + c; c = Math.floor(v / 8192); h7 = v - c * 8192;
    v = d8 + c; c = Math.floor(v / 8192); h8 = v - c * 8192;
    v = d9 + c; c = Math.floor(v / 8192); h9 = v - c * 8192;
    h0 += c * 5; c = h0 >>> 13; h0 &= 8191; h1 += c;
  };

  for (let offset = 0; offset < ctLen; offset += 16) {
    poly1305ToLimbs13(ciphertext, offset, Math.min(16, ctLen - offset), block, true);
    mulBlock();
  }

  // AEAD footer: le64(aadLen = 0) || le64(ctLen) as one 16-byte block.
  const footer = new Uint8Array(16);
  writeU32le(footer, 8, ctLen >>> 0);
  writeU32le(footer, 12, Math.floor(ctLen / 0x1_0000_0000) >>> 0);
  poly1305ToLimbs13(footer, 0, 16, block, true);
  mulBlock();

  // Final full carry & freeze mod (2^130 - 5).
  let c = h0 >>> 13; h0 &= 8191; h1 += c;
  c = h1 >>> 13; h1 &= 8191; h2 += c;
  c = h2 >>> 13; h2 &= 8191; h3 += c;
  c = h3 >>> 13; h3 &= 8191; h4 += c;
  c = h4 >>> 13; h4 &= 8191; h5 += c;
  c = h5 >>> 13; h5 &= 8191; h6 += c;
  c = h6 >>> 13; h6 &= 8191; h7 += c;
  c = h7 >>> 13; h7 &= 8191; h8 += c;
  c = h8 >>> 13; h8 &= 8191; h9 += c;
  c = h9 >>> 13; h9 &= 8191; h0 += c * 5;
  c = h0 >>> 13; h0 &= 8191; h1 += c;
  c = h1 >>> 13; h1 &= 8191; h2 += c;
  c = h2 >>> 13; h2 &= 8191; h3 += c;
  c = h3 >>> 13; h3 &= 8191; h4 += c;
  c = h4 >>> 13; h4 &= 8191; h5 += c;
  c = h5 >>> 13; h5 &= 8191; h6 += c;
  c = h6 >>> 13; h6 &= 8191; h7 += c;
  c = h7 >>> 13; h7 &= 8191; h8 += c;
  c = h8 >>> 13; h8 &= 8191; h9 += c;
  c = h9 >>> 13; h9 &= 8191; h0 += c * 5;
  c = h0 >>> 13; h0 &= 8191; h1 += c;

  let gc = 5;
  const g0 = (h0 + gc) & 8191; gc = (h0 + gc) >>> 13;
  const g1 = (h1 + gc) & 8191; gc = (h1 + gc) >>> 13;
  const g2 = (h2 + gc) & 8191; gc = (h2 + gc) >>> 13;
  const g3 = (h3 + gc) & 8191; gc = (h3 + gc) >>> 13;
  const g4 = (h4 + gc) & 8191; gc = (h4 + gc) >>> 13;
  const g5 = (h5 + gc) & 8191; gc = (h5 + gc) >>> 13;
  const g6 = (h6 + gc) & 8191; gc = (h6 + gc) >>> 13;
  const g7 = (h7 + gc) & 8191; gc = (h7 + gc) >>> 13;
  const g8 = (h8 + gc) & 8191; gc = (h8 + gc) >>> 13;
  const g9 = (h9 + gc) & 8191; gc = (h9 + gc) >>> 13;

  const mask = -gc;
  h0 = (h0 & ~mask) | (g0 & mask);
  h1 = (h1 & ~mask) | (g1 & mask);
  h2 = (h2 & ~mask) | (g2 & mask);
  h3 = (h3 & ~mask) | (g3 & mask);
  h4 = (h4 & ~mask) | (g4 & mask);
  h5 = (h5 & ~mask) | (g5 & mask);
  h6 = (h6 & ~mask) | (g6 & mask);
  h7 = (h7 & ~mask) | (g7 & mask);
  h8 = (h8 & ~mask) | (g8 & mask);
  h9 = (h9 & ~mask) | (g9 & mask);

  // Convert lowest 128 bits into 4 little-endian 32-bit words and add s = otk[16..32].
  const f0 = (h0 | (h1 << 13) | (h2 << 26)) >>> 0;
  const f1 = ((h2 >>> 6) | (h3 << 7) | (h4 << 20)) >>> 0;
  const f2 = ((h4 >>> 12) | (h5 << 1) | (h6 << 14) | (h7 << 27)) >>> 0;
  const f3 = ((h7 >>> 5) | (h8 << 8) | (h9 << 21)) >>> 0;

  let carry = 0;
  const sum0 = f0 + u32le(otk, 16) + carry; carry = sum0 >= 0x1_0000_0000 ? 1 : 0;
  const sum1 = f1 + u32le(otk, 20) + carry; carry = sum1 >= 0x1_0000_0000 ? 1 : 0;
  const sum2 = f2 + u32le(otk, 24) + carry; carry = sum2 >= 0x1_0000_0000 ? 1 : 0;
  const sum3 = f3 + u32le(otk, 28) + carry;

  const tag = new Uint8Array(16);
  writeU32le(tag, 0, sum0 >>> 0);
  writeU32le(tag, 4, sum1 >>> 0);
  writeU32le(tag, 8, sum2 >>> 0);
  writeU32le(tag, 12, sum3 >>> 0);
  return tag;
}

/**
 * Pure TypeScript RFC 8439 ChaCha20-Poly1305 (empty AAD) for runtimes that omit native ChaCha20
 * (such as WKWebView on macOS).
 */
export const jsChaCha20Poly1305: DirectAead = {
  seal(key, nonce, plain) {
    if (key.length !== 32 || nonce.length !== 12) {
      throw new Error("ChaCha20-Poly1305 requires a 32-byte key and 12-byte nonce");
    }
    const otkBlock = new Uint8Array(64);
    chacha20Block(key, 0, nonce, otkBlock);
    const out = new Uint8Array(plain.length + 16);
    chacha20Xor(key, nonce, plain, out);
    const tag = poly1305AeadTag(otkBlock, out, plain.length);
    out.set(tag, plain.length);
    return out;
  },
  open(key, nonce, sealed) {
    if (key.length !== 32 || nonce.length !== 12 || sealed.length < 16) return null;
    const ctLen = sealed.length - 16;
    const otkBlock = new Uint8Array(64);
    chacha20Block(key, 0, nonce, otkBlock);
    const expected = poly1305AeadTag(otkBlock, sealed, ctLen);
    let diff = 0;
    for (let i = 0; i < 16; i++) diff |= expected[i]! ^ sealed[ctLen + i]!;
    if (diff !== 0) return null;
    const plain = new Uint8Array(ctLen);
    chacha20Xor(key, nonce, sealed.subarray(0, ctLen), plain);
    return plain;
  },
};

/**
 * One end of a direct link. Frames are JSON text, sealed as binary WebSocket messages. Nonces are not
 * sent: each side counts the frames it sends and receives (a WebSocket keeps them in order), so a frame
 * replayed, dropped or reordered on the way fails to open and the link is closed.
 */
export class DirectCipher {
  private sent = 0;
  private received = 0;
  private aead: DirectAead;
  private key: Uint8Array;
  private me: number;
  constructor(aead: DirectAead, key: Uint8Array, me: number) {
    this.aead = aead;
    this.key = key;
    this.me = me;
  }

  seal(text: string): Uint8Array {
    return this.aead.seal(this.key, directNonce(this.me, this.sent++), utf8Encode(text));
  }

  /** The frame's text, or null when it is not the next frame from the other end. */
  open(data: Uint8Array): string | null {
    const other = this.me === DIRECT_FROM_PHONE ? DIRECT_FROM_HOST : DIRECT_FROM_PHONE;
    const plain = this.aead.open(this.key, directNonce(other, this.received), data);
    if (!plain) return null;
    this.received++;
    return utf8Decode(plain);
  }
}

type TextCodecs = { TextEncoder?: new () => { encode(s: string): Uint8Array }; TextDecoder?: new () => { decode(b: Uint8Array): string } };
const codecs = globalThis as unknown as TextCodecs;

/** UTF-8 bytes of a string (the platform's encoder when there is one). */
export function utf8Encode(s: string): Uint8Array {
  if (codecs.TextEncoder) return new codecs.TextEncoder().encode(s);
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** The string in UTF-8 bytes (the platform's decoder when there is one). */
export function utf8Decode(b: Uint8Array): string {
  if (codecs.TextDecoder) return new codecs.TextDecoder().decode(b);
  let s = "";
  const chunk: number[] = [];
  const flush = () => {
    s += String.fromCharCode(...chunk);
    chunk.length = 0;
  };
  for (let i = 0; i < b.length; ) {
    const x = b[i]!;
    let c: number;
    if (x < 0x80) (c = x), (i += 1);
    else if (x < 0xe0) (c = ((x & 31) << 6) | (b[i + 1]! & 63)), (i += 2);
    else if (x < 0xf0) (c = ((x & 15) << 12) | ((b[i + 1]! & 63) << 6) | (b[i + 2]! & 63)), (i += 3);
    else (c = ((x & 7) << 18) | ((b[i + 1]! & 63) << 12) | ((b[i + 2]! & 63) << 6) | (b[i + 3]! & 63)), (i += 4);
    if (c >= 0x10000) {
      c -= 0x10000;
      chunk.push(0xd800 + (c >> 10), 0xdc00 + (c & 1023));
    } else chunk.push(c);
    if (chunk.length > 8000) flush();
  }
  flush();
  return s;
}

// ---------------------------------------------------------------------------
// Conversation Event Ordering & Model-Switch Parsing
// ---------------------------------------------------------------------------

const CONV_KIND_RANK: Record<string, number> = {
  turn_start: 0,
  user_message: 1,
  system: 2,
  reasoning: 3,
  assistant_message: 4,
  tool_call: 5,
  tool_result: 6,
  usage: 7,
  turn_end: 8,
};

function parseConvPos(pos?: string): bigint | null {
  if (!pos) return null;
  const m = /^\s*(\d+)/.exec(pos);
  return m ? BigInt(m[1]!) : null;
}

function parseConvEventStemAndSub(id: string): { stem: string; sub: number } | null {
  const m = /^(.*?)(?::c|#)(\d+)$/i.exec(id);
  if (!m) return null;
  const sub = Number(m[2]);
  return Number.isSafeInteger(sub) ? { stem: m[1]!, sub } : null;
}

/**
 * Total, deterministic ordering over `ConvEvent` across live SSE frames and paged RPC fetches.
 * Primary key: numeric byte-offset `pos` when both events have one; breaks same-record ties
 * by same-stem block index (`#0 < #1 < #10`) and logical phase rank (`kind`).
 * Falls back cleanly to numeric `ts` (never lexicographic `pos`-vs-`ts` `localeCompare`) when `pos` is absent.
 */
export function compareConvEvents(a: ConvEvent, b: ConvEvent): number {
  const ap = parseConvPos(a.pos);
  const bp = parseConvPos(b.pos);

  if (ap !== null && bp !== null) {
    if (ap !== bp) return ap < bp ? -1 : 1;

    const aSub = parseConvEventStemAndSub(a.id);
    const bSub = parseConvEventStemAndSub(b.id);
    if (aSub && bSub && aSub.stem === bSub.stem && aSub.sub !== bSub.sub) {
      return aSub.sub - bSub.sub;
    }

    const aRank = CONV_KIND_RANK[a.kind] ?? 99;
    const bRank = CONV_KIND_RANK[b.kind] ?? 99;
    if (aRank !== bRank) return aRank - bRank;

    if (aSub && bSub && aSub.sub !== bSub.sub) {
      return aSub.sub - bSub.sub;
    }
  } else {
    const aTs = Number.isFinite(a.ts) ? a.ts : 0;
    const bTs = Number.isFinite(b.ts) ? b.ts : 0;
    if (aTs !== bTs) return aTs - bTs;
    if (ap !== null && bp === null) return -1;
    if (ap === null && bp !== null) return 1;
  }

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface ParsedModelSwitch {
  model?: string;
  thinking?: string;
  /** True when the event is a CLI acknowledgement / stdout line that should coalesce or drop if empty. */
  ackOnly?: boolean;
}

const COMMAND_NAME_RE = /<command-name>\s*\/?(model|models|switch|effort|thinking)\s*<\/command-name>/i;
const ANY_COMMAND_NAME_RE = /<command-name>\s*(\/?[^\s<]+)\s*<\/command-name>/i;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/i;
const LOCAL_STDOUT_RE = /^\s*(?:<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*)+$/i;
const LOCAL_STDERR_RE = /^\s*(?:<local-command-stderr>([\s\S]*?)<\/local-command-stderr>\s*)+$/i;
const INLINE_LOCAL_STDOUT_RE = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/i;
const KNOWN_EFFORT_WORD_RE =
  /^(?:off|none|minimal|min|low|medium|med|high|xhigh|max|ultra|auto|default|normal|fast|smart|rush)$/i;
const COMMAND_ERROR_RE =
  /(?:^|\b)(?:error:|unknown model|not available|is not supported|unsupported (?:model|effort|thinking)|invalid (?:model|effort|thinking)|failed to (?:set|switch)|does not exist|unrecognized command|unknown command|no such model|permission denied|disabled\.)/i;
const COMMAND_DISMISSED_RE =
  /^(?:cancelled|canceled|(?:status|help|model|config|usage|effort)\s+dialog\s+dismissed\.?|no change\.?)$/i;
const MODEL_ACK_ONLY_RE = /^(?:kept model as\b|model unchanged\b|already using\b)/i;

/** Returns true when local command or TUI output reports a model/effort/command failure. */
export function isCommandErrorOutput(body: string): boolean {
  const clean = body.replace(ANSI_ESCAPE_RE, "").trim();
  if (!clean) return false;
  return COMMAND_ERROR_RE.test(clean);
}

/** Returns true when a TUI modal/command output only acknowledges cancellation or dismissal. */
export function isDismissedCommandOutput(body: string): boolean {
  const clean = body.replace(ANSI_ESCAPE_RE, "").trim();
  if (!clean) return false;
  return COMMAND_DISMISSED_RE.test(clean);
}

/** Extracts `<command-name>` and `<command-args>` from an injected command echo block. */
export function parseSlashCommandTag(rawText: string): { name: string; args: string; full: string } | null {
  const m = ANY_COMMAND_NAME_RE.exec(rawText);
  if (!m?.[1]) return null;
  const rawName = m[1].trim();
  const name = rawName.startsWith("/") ? rawName : `/${rawName}`;
  const args = COMMAND_ARGS_RE.exec(rawText)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  return { name, args, full: args ? `${name} ${args}` : name };
}

/** Extracts clean text and error flag from `<local-command-stdout>` / `<local-command-stderr>` XML blocks. */
export function parseLocalCommandOutputTag(rawText: string): { body: string; isError: boolean } | null {
  const trimmed = rawText.trim();
  const errMatch = LOCAL_STDERR_RE.exec(trimmed);
  if (errMatch) {
    const body = errMatch[1]!.replace(ANSI_ESCAPE_RE, "").trim();
    return { body, isError: true };
  }
  const outMatch = LOCAL_STDOUT_RE.exec(trimmed);
  if (outMatch) {
    const body = outMatch[1]!.replace(ANSI_ESCAPE_RE, "").trim();
    return { body, isError: isCommandErrorOutput(body) };
  }
  return null;
}

/** Whether an optimistic slash send matches an incoming timeline row (`user`, `system` command, `model_switch`, or `command_result`). */
export function matchesOptimisticCommand(
  sentText: string,
  candidate: { kind: string; subtype?: string; summary?: string; text?: string; label?: string },
): boolean {
  const trimmed = sentText.trim();
  if (!trimmed.startsWith("/")) return false;
  const parts = trimmed.split(/\s+/);
  const cmdName = (parts[0] ?? "").toLowerCase();
  const cmdArgs = parts.slice(1).join(" ").trim();
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const targetFull = norm(trimmed);

  if (candidate.kind === "model_switch" || candidate.subtype === "model_switch") {
    if (cmdName === "/model" || cmdName === "/models" || cmdName === "/switch" || cmdName === "/effort" || cmdName === "/thinking") {
      if (!cmdArgs) return true;
      const hay = norm(`${candidate.label ?? ""} ${candidate.summary ?? ""} ${candidate.text ?? ""}`);
      if (hay.includes(cmdArgs.toLowerCase())) return true;
      // Effort words translate in UI summary (e.g. `high` -> `高`, `xhigh` -> `超高`).
      if (cmdName === "/effort" || cmdName === "/thinking") {
        const cn = SWITCH_EFFORT_LABELS[cmdArgs.toLowerCase()];
        if (cn && hay.includes(cn.toLowerCase())) return true;
      }
      return true;
    }
    return false;
  }

  if (candidate.kind === "system" || candidate.kind === "command_result") {
    const text = candidate.text ?? "";
    const tag = parseSlashCommandTag(text);
    if (tag) {
      if (norm(tag.full) === targetFull) return true;
      if (tag.name.toLowerCase() === cmdName && (!cmdArgs || tag.args.toLowerCase() === cmdArgs.toLowerCase())) return true;
    }
    const sum = norm((candidate.summary ?? "").replace(/^命令\s+/, "").replace(/^已取消\s+/, ""));
    if (sum === targetFull || sum === cmdName) return true;
    if (candidate.subtype === "command_error" || candidate.subtype === "command_output" || candidate.subtype === "command") {
      if (sum.startsWith(cmdName)) return true;
    }
  }
  return false;
}

const SWITCH_EFFORT_LABELS: Record<string, string> = {
  off: "关闭",
  none: "关闭",
  minimal: "极简",
  min: "极简",
  low: "低",
  medium: "中",
  med: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
  ultra: "极致",
  auto: "自动",
  default: "默认",
  normal: "标准",
  fast: "快速",
  smart: "深度",
  rush: "极速",
};

function splitModelSelector(raw: string): { model?: string; thinking?: string } {
  const cleaned = raw.trim().replace(/^['"`]|['"`]$/g, "").trim();
  if (!cleaned || /[<>]/.test(cleaned)) return {};
  const thinking = extractModelExplicitEffort(cleaned);
  const model = stripModelEffortSuffix(cleaned).trim() || cleaned;
  return {
    model,
    ...(thinking ? { thinking: thinking.toLowerCase() } : {}),
  };
}

function parseStdoutModelSwitch(stdoutBody: string): { model?: string; thinking?: string } {
  const clean = stdoutBody.replace(ANSI_ESCAPE_RE, "").trim();
  if (!clean) return {};
  let model: string | undefined;
  let thinking: string | undefined;

  const modelMatch = /(?:Set model to|Switched(?: model)? to|Model set to)\s+([^\r\n(]+)/i.exec(clean);
  if (modelMatch?.[1]) {
    const parsed = splitModelSelector(modelMatch[1].replace(/[.。]+$/, ""));
    model = parsed.model;
    thinking = parsed.thinking;
  }

  const effortMatch = /(?:Set\s+)?(?:effort|thinking)(?:\s+level)?(?:\s+set)?\s+to\s+([a-z0-9_-]+)/i.exec(clean);
  if (effortMatch?.[1] && KNOWN_EFFORT_WORD_RE.test(effortMatch[1])) {
    thinking = effortMatch[1].toLowerCase();
  }

  return {
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

/**
 * Extracts structured model / thinking-effort changes from slash commands, Claude XML
 * command blocks, or host-emitted `model_switch` system events. Returns `null` for ordinary prose.
 */
export function parseModelSwitchText(rawText: string, subtype?: string): ParsedModelSwitch | null {
  const clean = rawText.replace(ANSI_ESCAPE_RE, "").trim();
  if (!clean) return null;

  const cmdMatch = COMMAND_NAME_RE.exec(clean);
  if (cmdMatch) {
    const cmd = cmdMatch[1]!.toLowerCase();
    const argsRaw = COMMAND_ARGS_RE.exec(clean)?.[1]?.trim() ?? "";
    const stdoutRaw = INLINE_LOCAL_STDOUT_RE.exec(clean)?.[1] ?? "";
    const hasErr = Boolean(LOCAL_STDERR_RE.exec(clean)) || isCommandErrorOutput(stdoutRaw) || isDismissedCommandOutput(stdoutRaw);
    if (hasErr) return null;
    const fromStdout = stdoutRaw ? parseStdoutModelSwitch(stdoutRaw) : {};

    if (cmd === "effort" || cmd === "thinking") {
      const argEffort = argsRaw && !/[<>]/.test(argsRaw) ? argsRaw.toLowerCase() : undefined;
      const thinking = argEffort ?? fromStdout.thinking;
      if (thinking) return { ...(fromStdout.model ? { model: fromStdout.model } : {}), thinking };
      return { ackOnly: true };
    }

    if (argsRaw) {
      const split = splitModelSelector(argsRaw);
      if (split.model || split.thinking) {
        return {
          ...(split.model ? { model: split.model } : fromStdout.model ? { model: fromStdout.model } : {}),
          ...(split.thinking ? { thinking: split.thinking } : fromStdout.thinking ? { thinking: fromStdout.thinking } : {}),
        };
      }
    }
    if (fromStdout.model || fromStdout.thinking) {
      return fromStdout;
    }
    return { ackOnly: true };
  }

  const stdoutOnly = LOCAL_STDOUT_RE.exec(clean);
  if (stdoutOnly) {
    const inner = stdoutOnly[1]!.replace(ANSI_ESCAPE_RE, "").trim();
    if (!inner || isCommandErrorOutput(inner)) return null;
    if (isDismissedCommandOutput(inner)) return { ackOnly: true };
    const parsed = parseStdoutModelSwitch(inner);
    if (parsed.model || parsed.thinking || MODEL_ACK_ONLY_RE.test(inner)) {
      return { ...parsed, ackOnly: true };
    }
    return null;
  }

  if (subtype === "model_switch" || subtype === "model_change" || subtype === "thinking_level_change") {
    const fromStdout = parseStdoutModelSwitch(clean);
    if (fromStdout.model || fromStdout.thinking) return fromStdout;
    const cnMatch = /已切换模型为\s+([^\r\n·]+?)(?:\s*·\s*思考\s+(\S+))?$/.exec(clean);
    if (cnMatch?.[1]) {
      const parsed = splitModelSelector(cnMatch[1]);
      return {
        ...parsed,
        ...(cnMatch[2] ? { thinking: cnMatch[2].trim().toLowerCase() } : parsed.thinking ? { thinking: parsed.thinking } : {}),
      };
    }
    const singleToken = !/[\r\n\s]/.test(clean) ? splitModelSelector(clean) : {};
    if (singleToken.model || singleToken.thinking) return singleToken;
    return { ackOnly: true };
  }

  if (clean.startsWith("/") && !/[\r\n]/.test(clean)) {
    const modelCmd = /^\/(?:model(?:\s+set)?|models|switch)\s+(\S[^\r\n]*)$/i.exec(clean);
    if (modelCmd?.[1]) {
      const arg = modelCmd[1].trim();
      if (KNOWN_EFFORT_WORD_RE.test(arg) && /^\/model\s+/i.test(clean)) {
        return { thinking: arg.toLowerCase() };
      }
      const split = splitModelSelector(arg);
      if (split.model || split.thinking) return split;
    }

    const bareModelCmd = /^\/(?:model|models|switch)$/i.exec(clean);
    if (bareModelCmd) {
      return { ackOnly: true };
    }

    const effortCmd = /^\/(?:effort|thinking|reasoning|reasoning-effort)\s+([a-zA-Z0-9_-]+)$/i.exec(clean);
    if (effortCmd?.[1] && KNOWN_EFFORT_WORD_RE.test(effortCmd[1])) {
      return { thinking: effortCmd[1].toLowerCase() };
    }
  }

  return null;
}

/** Extracts a `ParsedModelSwitch` from a `ConvEvent` (`user_message` or `system`) if applicable. */
export function parseModelSwitchEvent(
  e: Pick<ConvEvent, "kind"> & { text?: string; injected?: string; subtype?: string },
): ParsedModelSwitch | null {
  if (e.kind === "system") {
    return typeof e.text === "string" ? parseModelSwitchText(e.text, e.subtype) : null;
  }
  if (e.kind === "user_message") {
    const text = typeof e.text === "string" ? e.text.trim() : "";
    const injected = typeof e.injected === "string" ? e.injected.trim() : "";
    if (!text && injected) return parseModelSwitchText(injected);
    if (text && !injected) return parseModelSwitchText(text);
  }
  return null;
}

/** Formats a user-facing single-line summary for a `model_switch` timeline pill. */
export function formatModelSwitchSummary(sw: { model?: string; thinking?: string }): string {
  const effort = sw.thinking ? (SWITCH_EFFORT_LABELS[sw.thinking.toLowerCase()] ?? sw.thinking) : undefined;
  if (sw.model && effort) return `已切换模型为 ${sw.model} · 思考 ${effort}`;
  if (sw.model) return `已切换模型为 ${sw.model}`;
  if (effort) return `已切换思考等级为 ${effort}`;
  return "已切换模型配置";
}
