import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { SHELL_HARNESSES, normalizeStatus, parseTerminalChoices, type Agent, type AgentStatus, type TerminalDisplay } from "@herdr-pocket/protocol";
import { base, cleanTitle, debounce, lineSplitter, run } from "./util.ts";
import { HcScreens, type ScreenLines, type ScreenSnapshot } from "./hcscreen.ts";
import { defaultHcBin, programName } from "./platform.ts";

/** Subset of a herdr-core (`hc`) terminal object we rely on. */
export interface HcTerminal {
  address: string;
  argv?: string[];
  cwd?: string | null;
  state?: string; // live | finished
  status?: { app?: string; state?: string; kind?: string | null; msg?: string } | null;
  status_ms?: number | null;
  title?: string | null;
  turn?: number;
  name?: string | null;
  labels?: Record<string, string>;
  parent?: string | null;
  pid?: number;
  foreground?: { argv?: string[]; name?: string | null; cwd?: string; pid?: number } | null;
  created_ms?: number;
  cols?: number;
  rows?: number;
}

const VIEWER_SUBSCREEN_TAIL_PATTERNS: readonly RegExp[] = [
  /\btab\s+switch\s+pane\b.*\besc\s+back\b/i,
  /\besc\b[^\n]{0,16}?\b(?:to\s+)?(?:go\s+back|back|close|exit|return)\b/i,
  /(?:按\s*|(?<![a-z0-9]))esc\s*(?:键)?\s*(?:返回|关闭|退出)/i,
];

const MODAL_PICKER_TAIL_PATTERNS: readonly RegExp[] = [
  /\besc\b[^\n]{0,16}?\b(?:to\s+)?(?:cancel|dismiss)\b/i,
  /(?:按\s*|(?<![a-z0-9]))esc\s*(?:键)?\s*取消/i,
];

const INTERACTIVE_APPROVAL_RE =
  /\b(?:do you want to (?:proceed|continue|run|edit|create|delete|execute|allow)|would you like to|allow (?:once|always|execution|this tool)|allow tool execution|permission required|approve|reject|yes,?\s*(?:and\s+)?(?:proceed|allow|don't ask again)|press (?:a )?number to choose|\[y\/n\]|\(y\/n\)|chat about this|type your(?: own)? answer|enter to submit answer)\b|是否允许|允许执行|是否继续|按数字选择|输入.{0,8}回答|确认执行|授权确认/i;

const WORKING_INLINE_HINT_RE =
  /\(\s*(?:[^()]*[•·]\s*)?esc\s+(?:to\s+)?(?:cancel|interrupt)\s*\)\s*$|\(\s*按\s*esc\s*(?:键)?\s*(?:取消|中断)\s*\)\s*$/i;

const WORKING_SPINNER_PREFIX_RE = /^\s*[✢✶✳✻✽⠋-⣿•]/;

const PAGER_TAIL_RE =
  /^(?::|\(END\)|.*\s\(END\)|--More--(?:\s*\(\d+%\))?|lines \d+-\d+(?:\/\d+)?(?:\s*\(END\))?|.*\bpress\s+q\s+to\s+quit\b.*|.*\bq\s+(?:to\s+)?(?:quit|close|exit)\b.*\b(?:transcript|pager|manual)\b.*|\btranscript\b.*\bq\s+to\s+(?:quit|exit|return)\b.*)$/i;

const PAGER_PROCS = new Set(["less", "man", "more", "git-pager", "delta"]);
const TRANSCRIPT_CTRL_O_RE = /\bctrl\+o\s+to\s+(?:collapse|hide|exit|return)\b|\bshowing\s+detailed\s+transcript\b/i;
const TABBED_VIEWER_HEADER_RE = /(?:^|\s)(?:Settings\s+Status\s+(?:Config|Usage)|Status\s+Config\s+Usage)(?:\s|$)/i;

/**
 * Hard Veto: returns true when the visible terminal screen is waiting on a
 * human approval, permission decision, auth check, or question picker.
 */
export function isInteractiveApprovalOrQuestion(screen: string): boolean {
  const tail = screen.split("\n").map((l) => l.trim()).filter(Boolean).slice(-14).join("\n");
  return INTERACTIVE_APPROVAL_RE.test(tail);
}

/**
 * True when a full-screen interactive viewer/overlay (e.g. `/swarm board`,
 * `/status`, `/usage` viewers) is open and captures input even while the agent
 * is `"working"`. Explicitly never matches `"esc to interrupt"` or `"esc to cancel"`.
 */
export function isViewerSubscreen(screen: string): boolean {
  if (isInteractiveApprovalOrQuestion(screen)) return false;
  if (/^Swarm board\b/m.test(screen)) return true;
  const lines = screen.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.slice(0, 4).some((l) => /^Swarm board\b/.test(l))) return true;
  if (lines.slice(0, 8).some((l) => TABBED_VIEWER_HEADER_RE.test(l)) && !/shift\+tab\s+to\s+cycle/i.test(lines.slice(-4).join("\n"))) {
    return true;
  }
  const tail = lines.slice(-6);
  if (tail.some((l) => TRANSCRIPT_CTRL_O_RE.test(l)) || lines.slice(0, 4).some((l) => TRANSCRIPT_CTRL_O_RE.test(l))) return true;
  return tail.some((l) => !WORKING_INLINE_HINT_RE.test(l) && VIEWER_SUBSCREEN_TAIL_PATTERNS.some((re) => re.test(l)));
}

/**
 * True when the screen shows a viewer sub-screen or modal picker footer
 * ("Esc to cancel", "Enter to confirm · Esc to exit"…), i.e. typed text would go into the panel.
 */
export function endsInPanel(screen: string): boolean {
  if (isViewerSubscreen(screen)) return true;
  const tail = screen.split("\n").map((l) => l.trim()).filter(Boolean).slice(-6);
  return tail.some((l) => {
    if (WORKING_INLINE_HINT_RE.test(l) || WORKING_SPINNER_PREFIX_RE.test(l)) return false;
    return MODAL_PICKER_TAIL_PATTERNS.some((re) => re.test(l));
  });
}

export interface SubscreenDetection {
  kind: "viewer" | "pager";
  dismissKey: "\x1b" | "q";
  dismissAlias: "esc" | "q";
  reason: string;
}

const ACTIVE_INPUT_PROMPT_RE = /^(?:[❯›>](?:\s|$).*|.*\bshift\+tab\s+to\s+cycle\b.*|.*\?\s+for\s+shortcuts\b.*)$/i;
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;
const AGY_REVIEW_STATUS_RE = /\bctx\s*·\s*reviewing\b/i;
const AGY_NON_WORKING_FOOTER_RE = /\bctx\s*·\s*(?:idle|done|reviewing)\b/i;
const AGY_WORKING_FOOTER_RE = /\bctx\s*·\s*workin/i;
const AGY_ARTIFACT_HINT_RE = /\b\d+\s+artifacts?\s*·\s*\/artifact\s+to\s+review\b/i;
const AGY_IDLE_PROMPT_LINE_RE = /^>\s*$/;
const AGY_COMPOSER_PROMPT_LINE_RE = /^>(?:\s.*)?$/;
const AGY_BORDER_LINE_RE = /^[─━═┄┈-]{8,}$/;
const AGY_ACTIVE_SPINNER_RE =
  /^[⣾⣽⣻⢿⡿⣟⣯⣷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✢✶✳✻✽]\s+\S|^●\s+Running\b|\(\s*(?:[^()]*[•·]\s*)?esc\s+(?:to\s+)?(?:cancel|interrupt)\s*\)/i;
const AGY_MODAL_APPROVAL_RE =
  /\b(?:do you want to (?:proceed|continue|run|edit|create|delete|execute|allow)|would you like to|allow (?:once|always|execution|this tool)|allow tool execution|permission required|approve\s+plan\?|proceed\?|yes,?\s*(?:and\s+)?(?:proceed|allow|don't ask again)|press (?:a )?number to choose|press enter to (?:approve|proceed|confirm|submit)|\[y\/n\]|\(y\/n\)|enter to submit answer)\b|是否允许|允许执行|是否继续|按数字选择|输入.{0,8}回答|确认执行|授权确认/i;

/**
 * True when an agent's raw `hc` status matches the Antigravity `· reviewing` false-block
 * signature (`antigravity` + `blocked` + `permission` + `"Approve plan"`), which needs
 * live terminal screen verification before alerting the user.
 */
export function isAntigravityReviewBlockCandidate(opts: {
  harness: string;
  status: AgentStatus;
  statusKind?: Agent["statusKind"];
  statusNote?: string;
}): boolean {
  if (opts.status !== "blocked") return false;
  if (opts.harness.toLowerCase() !== "antigravity") return false;
  if (opts.statusKind && opts.statusKind !== "permission") return false;
  return (opts.statusNote ?? "").trim().toLowerCase() === "approve plan";
}

/**
 * `hc` 0.1.x can keep reporting Antigravity (`agy`) as `status: "working"` indefinitely
 * whenever background commands (`● [HH:MM:SS] ... running`) or Swarm workers
 * (`● Agent(worker: ...) Working`) appear in the footer below `>`, even though Antigravity's
 * own status bar says `· idle` / `· done` / `· reviewing` and no turn spinner is active.
 * Returns true ONLY when the live screen unambiguously shows a non-working footer + framed
 * composer prompt (`>`) with zero active spinner / foreground `Running` line above it.
 */
export function isFalseAntigravityWorkingState(opts: {
  harness: string;
  status: AgentStatus;
  screen: string;
}): boolean {
  if (opts.status !== "working") return false;
  if (opts.harness.toLowerCase() !== "antigravity") return false;

  const nonEmpty = opts.screen
    .split("\n")
    .map((l) => l.replace(ANSI_SGR_RE, "").trim())
    .filter(Boolean);
  if (nonEmpty.length === 0) return false;

  const tail24 = nonEmpty.slice(-24);
  const footerLines = tail24.slice(-3);
  if (footerLines.some((l) => AGY_WORKING_FOOTER_RE.test(l))) return false;
  if (!footerLines.some((l) => AGY_NON_WORKING_FOOTER_RE.test(l))) return false;

  let promptIdx = -1;
  for (let i = tail24.length - 1; i >= 1; i -= 1) {
    if (
      AGY_COMPOSER_PROMPT_LINE_RE.test(tail24[i]!) &&
      AGY_BORDER_LINE_RE.test(tail24[i - 1]!) &&
      i + 1 < tail24.length &&
      AGY_BORDER_LINE_RE.test(tail24[i + 1]!)
    ) {
      promptIdx = i;
      break;
    }
  }
  if (promptIdx < 1) return false;

  // Hard veto: never demote if a foreground spinner, `● Running`, or interrupt hint is visible above the composer.
  const aboveComposer = tail24.slice(Math.max(0, promptIdx - 12), promptIdx - 1);
  if (aboveComposer.some((l) => AGY_ACTIVE_SPINNER_RE.test(l))) return false;

  return true;
}

/**
 * `hc` 0.1.x can misclassify Antigravity's footer status `· reviewing` (left on screen after
 * an artifact was produced earlier in the session) as `blocked / permission / "Approve plan"`.
 * Returns true ONLY when the live screen unambiguously shows an idle composer (`>` inside
 * horizontal rules) + `· reviewing` / `/artifact to review` footer with NO interactive
 * approval dialog, NO question prompt, and NO selectable terminal choice menu.
 */
export function isFalseAntigravityReviewBlock(opts: {
  harness: string;
  status: AgentStatus;
  statusKind?: Agent["statusKind"];
  statusNote?: string;
  screen: string;
}): boolean {
  if (!isAntigravityReviewBlockCandidate(opts)) return false;

  const rawLines = opts.screen.split("\n").map((l) => l.replace(ANSI_SGR_RE, "").trimEnd());
  const nonEmpty = rawLines.map((l) => l.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return false;

  const tail16 = nonEmpty.slice(-16);
  const hasReviewFooter =
    tail16.some((l) => AGY_REVIEW_STATUS_RE.test(l)) ||
    tail16.some((l) => AGY_ARTIFACT_HINT_RE.test(l));
  if (!hasReviewFooter) return false;

  let promptIdx = -1;
  for (let i = tail16.length - 1; i >= 0; i -= 1) {
    if (AGY_IDLE_PROMPT_LINE_RE.test(tail16[i]!)) {
      promptIdx = i;
      break;
    }
  }
  if (promptIdx <= 0 || promptIdx + 1 >= tail16.length) return false;

  const hasUpperRule = AGY_BORDER_LINE_RE.test(tail16[promptIdx - 1]!);
  const hasLowerRule = AGY_BORDER_LINE_RE.test(tail16[promptIdx + 1]!);
  if (!hasUpperRule || !hasLowerRule) return false;

  // Hard vetoes: never demote if a real interactive menu or approval prompt is on screen.
  if (parseTerminalChoices(rawLines).length > 0) return false;
  if (isInteractiveApprovalOrQuestion(tail16.slice(promptIdx - 1).join("\n"))) return false;
  const aboveComposer = tail16.slice(Math.max(0, promptIdx - 4), promptIdx - 1).join("\n");
  if (aboveComposer && AGY_MODAL_APPROVAL_RE.test(aboveComposer)) return false;

  return true;
}

/**
 * True when the tail of the visible viewport shows an active chat composer prompt
 * (`❯ `, `shift+tab to cycle`, `? for shortcuts`). Scrollback lines above an active
 * prompt must never be mistaken for a modal blocker.
 */
export function hasActiveInputPrompt(screen: string): boolean {
  const tail = screen.split("\n").map((l) => l.trim()).filter(Boolean).slice(-6);
  return tail.some((l) => ACTIVE_INPUT_PROMPT_RE.test(l));
}

/**
 * Detects non-input TUI subscreens (`/usage`, `/status`, `Swarm board`, transcript overlays,
 * and `less`/`man`/`more` pagers) while obeying the Hard Veto for `"blocked"` / approval prompts,
 * normal working turns (`(esc to cancel)` / `(esc to interrupt)`), and active input prompts.
 */
export function detectDismissableSubscreen(opts: {
  screen: string;
  altScreen?: boolean;
  status: AgentStatus;
  statusKind?: Agent["statusKind"];
  fgName?: string | null;
  argv0?: string | null;
}): SubscreenDetection | null {
  if (opts.status === "blocked" || opts.statusKind) return null;
  if (isInteractiveApprovalOrQuestion(opts.screen)) return null;
  if (!opts.altScreen && !/^Swarm board\b/m.test(opts.screen) && hasActiveInputPrompt(opts.screen)) {
    return null;
  }

  const lines = opts.screen.split("\n").map((l) => l.trim()).filter(Boolean);
  const head = lines.slice(0, 6);
  const tail = lines.slice(-6);
  const fg = (opts.fgName?.trim() || programName(base(opts.argv0 ?? undefined)) || "").toLowerCase();

  if (tail.some((l) => PAGER_TAIL_RE.test(l)) && (PAGER_PROCS.has(fg) || opts.altScreen || /\btranscript\b/i.test([...head, ...tail].join(" ")))) {
    return { kind: "pager", dismissKey: "q", dismissAlias: "q", reason: "pager" };
  }
  if (tail.some((l) => TRANSCRIPT_CTRL_O_RE.test(l)) || head.some((l) => TRANSCRIPT_CTRL_O_RE.test(l))) {
    // Exit detailed transcript with Esc (idempotent exit) rather than toggling Ctrl+O (\x0f),
    // so an ambiguous or transitioning viewport can never toggle INTO non-input transcript mode.
    return { kind: "viewer", dismissKey: "\x1b", dismissAlias: "esc", reason: "transcript" };
  }
  if (isViewerSubscreen(opts.screen)) {
    return { kind: "viewer", dismissKey: "\x1b", dismissAlias: "esc", reason: "viewer" };
  }
  if (opts.status !== "working" && endsInPanel(opts.screen)) {
    return { kind: "viewer", dismissKey: "\x1b", dismissAlias: "esc", reason: "modal_picker" };
  }
  return null;
}

/** Per-terminal metadata reported by `herdr-app ls` / persisted `docs.json`. */
export interface AppTerminalMeta {
  spaceId: string;
  spaceName: string;
  tabId?: string;
  tabName?: string;
  app?: string | null;
  status?: string | null;
  name?: string | null;
}

/** Space and tab names by id, as the desktop app (`herdr-app ls`) shows them. */
export interface AppNames {
  spaces: Map<string, string>;
  tabs: Map<string, string>;
  terminals?: Map<string, AppTerminalMeta>;
}

/** Interpreters an agent program runs inside; their name says nothing about the agent. */
const RUNTIMES = new Set(["node", "bun", "deno", "python", "python3", "py", "cmd", "npx"]);

const KEY_ALIASES: Record<string, string> = {
  enter: "enter",
  return: "enter",
  esc: "esc",
  escape: "esc",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  tab: "tab",
  "shift+tab": "shift+tab",
  "shift+enter": "shift+enter",
  backspace: "backspace",
  space: "space",
  "ctrl+c": "ctrl+c",
  "ctrl+d": "ctrl+d",
  "ctrl+l": "ctrl+l",
  "ctrl+o": "ctrl+o",
  "ctrl+t": "ctrl+t",
  q: "q",
  f2: "f2",
  "shift+f2": "shift+f2",
  "alt+m": "alt+m",
  "alt+enter": "alt+enter",
};

/**
 * Bridges the herdr GUI runtime (herdr-core). Keeps one `hc connect` JSON-RPC
 * session open for live events and the full terminal list; uses the `hc` CLI
 * for read/send/keys.
 */
export class HcAdapter extends EventEmitter {
  terminals = new Map<string, HcTerminal>();
  version: string | undefined;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private waiting = new Map<number, (msg: any) => void>();
  private stopped = false;
  private backoff = 1000;
  private resync = debounce(() => void this.list(), 400);
  private titleFlush = debounce(() => this.emit("change"), 1500);
  private timer: NodeJS.Timeout | null = null;
  /** Last line from the subscription; herdr-core sends a heartbeat every 15 s. */
  private lastLine = 0;

  private hcBin: string;
  private screens: HcScreens;

  constructor(hcBin = defaultHcBin()) {
    super();
    this.hcBin = hcBin;
    this.screens = new HcScreens(hcBin);
  }

  async available(): Promise<boolean> {
    try {
      this.version = (await run(this.hcBin, ["--version"], { timeoutMs: 10_000 })).trim().split(/\s+/).pop();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The running core's own `hello` (version, protocol generation) over a connection of its own:
   * the subscribed one answers nothing else. Refreshes `version` (after an `hc update`).
   * Undefined when the core does not answer within `timeoutMs`.
   */
  hello(timeoutMs = 4000): Promise<{ version?: string; generation?: number } | undefined> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.hcBin, ["connect"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      } catch {
        return resolve(undefined);
      }
      const done = (r: { version?: string; generation?: number } | undefined) => {
        clearTimeout(timer);
        child.kill();
        resolve(r);
      };
      const timer = setTimeout(() => done(undefined), timeoutMs);
      child.on("error", () => done(undefined));
      child.on("exit", () => done(undefined));
      child.stdin!.on("error", () => {});
      child.stdout!.on(
        "data",
        lineSplitter((line) => {
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            return;
          }
          if (msg?.id !== 0) return;
          const r = msg.result ?? {};
          const version = typeof r.version === "string" ? r.version : undefined;
          if (version) this.version = version;
          done({ version, generation: typeof r.generation === "number" ? r.generation : undefined });
        }),
      );
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: {} })}\n`);
    });
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.timer = setInterval(() => {
      // A subscription that went quiet (no heartbeat) is reopened; its snapshot resyncs everything.
      if (this.child && this.lastLine && Date.now() - this.lastLine > 45_000) this.child.kill();
      void this.list();
    }, 20_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.child?.kill();
    this.screens.stop();
  }

  private connect(): void {
    const child = spawn(this.hcBin, ["connect"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    this.lastLine = Date.now();
    child.stdin?.on("error", () => {});
    child.stdout!.on(
      "data",
      lineSplitter((line) => this.onLine(line)),
    );
    child.stderr!.on("data", () => {});
    child.on("exit", () => {
      this.child = null;
      for (const r of this.waiting.values()) r({ error: { message: "hc connect exited" } });
      this.waiting.clear();
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
    child.on("error", () => {});
    void this.request("events.subscribe", {}).then((r) => {
      if (r?.result?.terminals) {
        this.backoff = 1000;
        this.setAll(r.result.terminals);
      } else {
        void this.list();
      }
    });
  }

  private request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.resolve({ error: { message: "not connected" } });
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ error: { message: "timeout" } });
      }, timeoutMs);
      this.waiting.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
      try {
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (err) => {
          if (err && this.waiting.has(id)) {
            clearTimeout(t);
            this.waiting.delete(id);
            resolve({ error: { message: err.message } });
          }
        });
      } catch (err) {
        clearTimeout(t);
        this.waiting.delete(id);
        resolve({ error: { message: (err as Error).message } });
      }
    });
  }

  private onLine(line: string): void {
    this.lastLine = Date.now();
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.waiting.has(msg.id)) {
      this.waiting.get(msg.id)!(msg);
      this.waiting.delete(msg.id);
      return;
    }
    if (msg.method === "event") {
      const p = msg.params ?? {};
      if (p.type === "doc") {
        this.emit("doc");
        this.resync();
        return;
      }
      const t = typeof p.terminal === "string" ? this.terminals.get(p.terminal) : undefined;
      if (p.type === "title" && t) {
        // Spinner frames arrive many times per second; only the human part matters.
        const before = cleanTitle(t.title);
        t.title = p.data?.title ?? t.title;
        if (cleanTitle(t.title) !== before) this.titleFlush();
        return;
      }
      if (p.type === "status" && t && p.data && "status" in p.data) {
        const next = p.data.status ?? null;
        // A finished turn waits for the list: the event comes before the new turn
        // number, and with the old one the turn would read as already seen (idle).
        if (next?.state !== "done") {
          // Applied at once: the phone must not wait for a full list. Only a change
          // of state matters; the status message changes every few seconds.
          const before = HcAdapter.status(t);
          const noteBefore = HcAdapter.note(t);
          t.status = next;
          if (HcAdapter.status(t) === before) {
            // Same state; a new error or question still has to reach the phone.
            if (HcAdapter.note(t) !== noteBefore) this.emit("change");
            return;
          }
          t.status_ms = Date.now();
          this.emit("change");
        }
      }
      this.resync();
    } else if (msg.method === "missed") {
      this.emit("doc");
      const fresh = msg.params?.terminals;
      if (Array.isArray(fresh)) this.setAll(fresh);
      else this.resync();
    }
  }

  /**
   * The full list, over a connection of its own: once a connection has
   * subscribed to events, herdr-core answers nothing else on it (hc 0.1.21), so
   * asking there only ever timed out and left the list as it was at startup.
   */
  async list(): Promise<void> {
    const r = await this.oneShot("terminal.list", {});
    if (r?.result?.terminals) this.setAll(r.result.terminals);
  }

  async docGet(name: string): Promise<{ value: unknown; version: number } | null> {
    const r = await this.oneShot("doc.get", { name });
    if (r?.error || !r?.result) return null;
    return { value: r.result.value, version: Number(r.result.version ?? 0) };
  }

  async docSet(name: string, value: unknown, version: number): Promise<number | null> {
    const r = await this.oneShot("doc.set", { name, value, version });
    if (r?.error) throw new Error(r.error.message ?? "doc.set failed");
    return typeof r?.result?.version === "number" ? r.result.version : null;
  }

  /** Atomic CAS write against `doc.set`; returns latest doc + version on conflict instead of throwing. */
  async docSetCas(
    name: string,
    value: unknown,
    version: number,
  ): Promise<{ ok: boolean; conflict?: boolean; value?: unknown; version: number }> {
    const r = await this.oneShot("doc.set", { name, value, version });
    if (r?.error) {
      const kind = r.error?.data?.kind;
      const msg = String(r.error?.message ?? "doc.set failed");
      if (kind === "conflict" || /conflict|version/i.test(msg)) {
        const fresh = await this.docGet(name).catch(() => null);
        return { ok: false, conflict: true, value: fresh?.value ?? null, version: fresh?.version ?? 0 };
      }
      throw new Error(msg);
    }
    return {
      ok: true,
      version: typeof r?.result?.version === "number" ? r.result.version : version + 1,
    };
  }

  async snapshotText(address: string, lines = 0): Promise<string> {
    try {
      const s = await this.screens.snapshot(address, lines);
      return s.text;
    } catch {
      return "";
    }
  }

  /** One request on a short-lived `hc connect`. */
  private oneShot(method: string, params: unknown, timeoutMs = 10_000): Promise<any> {
    return new Promise((resolve) => {
      let done = false;
      const child = spawn(this.hcBin, ["connect"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      const finish = (v: any) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        child.kill();
        resolve(v);
      };
      const t = setTimeout(() => finish({ error: { message: "timeout" } }), timeoutMs);
      child.stdout!.on(
        "data",
        lineSplitter((line) => {
          try {
            const msg = JSON.parse(line);
            if (msg.id === 1) finish(msg);
          } catch {
            /* not ours */
          }
        }),
      );
      child.stdin?.on("error", (e) => finish({ error: { message: e.message } }));
      child.on("error", (e) => finish({ error: { message: e.message } }));
      child.on("exit", () => finish({ error: { message: "hc connect exited" } }));
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`, (e) => {
            if (e) finish({ error: { message: e.message } });
          });
        } catch (e) {
          finish({ error: { message: (e as Error).message } });
        }
      } else {
        finish({ error: { message: "hc stdin not writable" } });
      }
    });
  }

  private setAll(list: HcTerminal[]): void {
    this.terminals = new Map(list.filter((t) => t.state !== "finished").map((t) => [t.address, t]));
    this.emit("change");
  }

  /** Program running in the terminal, e.g. claude-code, omp, sh (on Windows without `.exe`). */
  static harness(t: HcTerminal): string {
    if (t.status?.app) return t.status.app;
    const fg = programName(base(t.foreground?.argv?.[0]));
    const launched = programName(base(t.argv?.[0]));
    // An agent installed by npm on Windows (claude.cmd) runs as node.exe, which is what the
    // foreground shows; the program is the one the terminal was started with. A runtime
    // started from a shell stays what it is.
    const plain = (p: string) => RUNTIMES.has(p.toLowerCase()) || SHELL_HARNESSES.has(p.toLowerCase());
    if (launched && fg && RUNTIMES.has(fg.toLowerCase()) && !plain(launched)) return launched;
    return fg || launched || "terminal";
  }

  /**
   * Status as the desktop app shows it: a finished turn the person has already
   * looked at in the app (`herdr.seen` label >= turn) reads as idle, not done.
   */
  static status(t: HcTerminal): AgentStatus {
    if (!t.status) return "idle";
    const s = normalizeStatus(t.status.state);
    if (s !== "done") return s;
    const seen = Number(t.labels?.["herdr.seen"]);
    return Number.isFinite(seen) && typeof t.turn === "number" && seen >= t.turn ? "idle" : "done";
  }

  /** Structured prompt kind while `"blocked"` (`permission` / `question` / `auth`). */
  static statusKind(t: HcTerminal): Agent["statusKind"] {
    if (HcAdapter.status(t) !== "blocked") return undefined;
    const raw = t.status?.kind?.toLowerCase();
    return raw === "permission" || raw === "question" || raw === "auth" ? raw : undefined;
  }

  /** What the program says while it waits for a person (an error or a question), clipped. */
  static note(t: HcTerminal): string | undefined {
    if (HcAdapter.status(t) !== "blocked") return undefined;
    const msg = t.status?.msg?.replace(/\s+/g, " ").trim();
    return msg ? (msg.length > 300 ? `${msg.slice(0, 300)}…` : msg) : undefined;
  }

  /** "space / tab" with the names the desktop app shows now (renames included). */
  static where(t: HcTerminal, names?: AppNames): string | undefined {
    const meta = names?.terminals?.get(t.address);
    if (meta) {
      return meta.tabName ? `${meta.spaceName} / ${meta.tabName}` : meta.spaceName;
    }
    const label = t.labels?.where;
    const space = names?.spaces.get(t.labels?.["herdr.space"] ?? "");
    if (!space) {
      const isStaleClosed =
        Boolean(names?.terminals) &&
        !t.labels?.["herdr.space"] &&
        t.labels?.["herdr.seen"] !== undefined &&
        !(typeof t.created_ms === "number" && Date.now() - t.created_ms < 15_000);
      if (isStaleClosed) return undefined;
      return label;
    }
    const tab = names?.tabs.get(t.labels?.["herdr.tab"] ?? "") ?? label?.split(" / ").slice(1).join(" / ");
    return tab ? `${space} / ${tab}` : space;
  }

  static toAgent(t: HcTerminal, deviceId: string, names?: AppNames): Agent {
    const meta = names?.terminals?.get(t.address);
    let harness = HcAdapter.harness(t);
    const metaApp = !t.status && SHELL_HARNESSES.has(harness.toLowerCase()) ? meta?.app?.trim() : undefined;
    const restoredApp = metaApp && !SHELL_HARNESSES.has(metaApp.toLowerCase()) ? metaApp : undefined;
    if (restoredApp) harness = restoredApp;
    const name = t.name?.trim() || meta?.name?.trim() || undefined;
    return {
      key: `${deviceId}/hc:${t.address}`,
      deviceId,
      source: "hc",
      localId: t.address,
      harness,
      title: name ?? cleanTitle(t.title),
      name,
      where: HcAdapter.where(t, names),
      cwd: t.foreground?.cwd ?? t.cwd ?? undefined,
      status: HcAdapter.status(t),
      statusKind: HcAdapter.statusKind(t),
      statusSince: t.status_ms ?? undefined,
      statusNote: HcAdapter.note(t),
      errored: ["error", "failed"].includes(t.status?.state?.toLowerCase() ?? "") || undefined,
      turn: t.turn,
      isShell: !t.status && !restoredApp && SHELL_HARNESSES.has(harness.toLowerCase()),
      updatedAt: t.status_ms ?? t.created_ms ?? Date.now(),
    };
  }

  /**
   * Starts a program (empty argv: the shell) in a new terminal of hc's own, in `cwd`, and
   * returns its address. For computers without the desktop app; it belongs to no space.
   */
  async spawnTerminal(argv: string[], cwd: string, env?: Record<string, string>): Promise<string> {
    const out = await run(this.hcBin, ["run", "--bg", "--no-parent", "--no-notify", "--json", "--cwd", cwd, ...(argv.length ? ["--", ...argv] : [])], {
      timeoutMs: 30_000,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const line = out.trim().split("\n").pop() ?? "";
    let address: unknown;
    try {
      address = (JSON.parse(line) as { address?: unknown }).address;
    } catch {
      /* reported below */
    }
    if (typeof address !== "string" || !address) throw new Error(`hc run 没有返回新终端：${out.trim().slice(0, 200)}`);
    return address;
  }

  async read(
    address: string,
    lines = 200,
  ): Promise<{ text: string; ansi?: string; cols?: number; rows?: number; how?: string; complete?: boolean }> {
    try {
      const s = await this.screens.snapshot(address, lines);
      return { text: s.text, ansi: s.ansi, cols: s.cols, rows: s.rows, how: "screen", complete: true };
    } catch {
      /* finished terminals cannot be attached: fall back to the plain read */
    }
    const out = await run(this.hcBin, ["read", address, "--json", "--lines", String(lines)]);
    const r = JSON.parse(out) as { text?: string; how?: string; complete?: boolean };
    return { text: r.text ?? "", how: r.how, complete: r.complete };
  }

  async watch(address: string, history: number, onUpdate: (s: ScreenLines) => void, onError: (e: Error) => void, opts: { text?: boolean } = {}): Promise<() => void> {
    try {
      return await this.screens.watch(address, history, onUpdate, onError, opts);
    } catch (e) {
      onError(e as Error);
      throw e;
    }
  }

  async watchRaw(
    address: string,
    opts: { cols?: number; rows?: number; history?: number; display?: TerminalDisplay },
    onData: (chunk: Buffer, cols: number, rows: number) => void,
    onError: (e: Error) => void,
  ): Promise<() => void> {
    try {
      return await this.screens.watchRaw(address, opts, onData, onError);
    } catch (e) {
      onError(e as Error);
      throw e;
    }
  }

  async resize(address: string, cols: number, rows: number, display?: TerminalDisplay): Promise<void> {
    await this.screens.resize(address, cols, rows, display);
    const t = this.terminals.get(address);
    if (t) {
      t.cols = cols;
      t.rows = rows;
    }
  }

  async send(address: string, text: string, enter = true): Promise<void> {
    if (enter) {
      // Panels (/status, /config, /usage), full-screen viewers (/swarm board, transcripts),
      // and OS pagers (less/man) swallow pasted text; close up to 3 overlay levels quickly.
      const dismissed = await this.dismissSubscreens(address);
      if (dismissed === "blocked") {
        throw new Error("它开着一个面板，消息没送进去：先在终端里按 Esc 或 q 关掉再发");
      }
    }
    const t = this.terminals.get(address);
    try {
      await this.screens.paste(address, text, t?.cols || 80, t?.rows || 24, enter);
      return;
    } catch {
      /* remote / non-attachable fallback below */
    }
    if (enter) {
      try {
        await run(this.hcBin, ["send", "--force", "--", address, text]);
      } catch (err) {
        if (/--force|unexpected argument/i.test((err as Error).message)) {
          await run(this.hcBin, ["send", "--", address, text]);
        } else {
          throw err;
        }
      }
    } else {
      // Typing without Enter: one key per character keeps it literal.
      await run(this.hcBin, ["keys", address, ...[...text].map((c) => (c === " " ? "space" : c))]);
    }
  }

  /**
   * Detects and dismisses up to 3 layers of non-input subscreens (`/status`, `/usage`,
   * `Swarm board`, transcript viewers, `less`/`man`) via fast raw input before falling back
   * to `hc keys`. Never sends anything into `"blocked"` / approval prompts or working turns.
   */
  async dismissSubscreens(address: string): Promise<"viewer" | "pager" | "none" | "blocked"> {
    const t = this.terminals.get(address);
    const isShell = t ? !t.status && SHELL_HARNESSES.has(HcAdapter.harness(t).toLowerCase()) : false;
    if (isShell) return "none";

    let firstClosed: "viewer" | "pager" | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Snapshot strictly the visible viewport (history = 0) so old scrollback never triggers dismissal.
      const snap = await this.screens.snapshot(address, 0).catch((): ScreenSnapshot | null => null);
      if (!snap) return firstClosed ?? "none";
      const det = detectDismissableSubscreen({
        screen: snap.text,
        altScreen: snap.altScreen,
        status: t ? HcAdapter.status(t) : "idle",
        statusKind: t ? HcAdapter.statusKind(t) : undefined,
        fgName: t?.foreground?.name,
        argv0: t?.foreground?.argv?.[0] ?? t?.argv?.[0],
      });
      if (!det) return firstClosed ?? "none";
      if (!firstClosed) firstClosed = det.kind;

      let sentRaw = false;
      if (t) {
        try {
          await this.screens.input(address, det.dismissKey, t.cols || 80, t.rows || 24, false);
          sentRaw = true;
          await new Promise((r) => setTimeout(r, 90));
        } catch {
          sentRaw = false;
        }
      }
      const afterRaw = sentRaw ? await this.screens.snapshot(address, 0).catch((): ScreenSnapshot | null => null) : null;
      if (!afterRaw || afterRaw.text === snap.text) {
        await run(this.hcBin, ["keys", address, det.dismissAlias]).catch(() => {});
        await new Promise((r) => setTimeout(r, 120));
        const afterKeys = await this.screens.snapshot(address, 0).catch((): ScreenSnapshot | null => null);
        // Stop retrying if an ambiguous transcript/modal screen didn't respond (prevents Esc-Esc rewind/Vim transitions).
        if ((!afterKeys || afterKeys.text === snap.text) && (det.reason === "transcript" || det.reason === "modal_picker")) {
          break;
        }
      }
    }

    const remaining = await this.screens.snapshot(address, 0).catch((): ScreenSnapshot | null => null);
    if (remaining) {
      const still = detectDismissableSubscreen({
        screen: remaining.text,
        altScreen: remaining.altScreen,
        status: t ? HcAdapter.status(t) : "idle",
        statusKind: t ? HcAdapter.statusKind(t) : undefined,
        fgName: t?.foreground?.name,
        argv0: t?.foreground?.argv?.[0] ?? t?.argv?.[0],
      });
      if (still) return "blocked";
    }
    return firstClosed ?? "none";
  }

  detectSubscreenFromSnapshot(address: string, snap: { text: string; altScreen?: boolean }): "viewer" | "pager" | null {
    const t = this.terminals.get(address);
    const isShell = t ? !t.status && SHELL_HARNESSES.has(HcAdapter.harness(t).toLowerCase()) : false;
    if (isShell) return null;
    const det = detectDismissableSubscreen({
      screen: snap.text,
      altScreen: snap.altScreen,
      status: t ? HcAdapter.status(t) : "idle",
      statusKind: t ? HcAdapter.statusKind(t) : undefined,
      fgName: t?.foreground?.name,
      argv0: t?.foreground?.argv?.[0] ?? t?.argv?.[0],
    });
    return det?.kind ?? null;
  }

  /** Helper exposing current subscreen kind directly from an attached snapshot. */
  async detectSubscreen(address: string): Promise<"viewer" | "pager" | null> {
    const snap = await this.screens.snapshot(address, 0).catch((): ScreenSnapshot | null => null);
    return snap ? this.detectSubscreenFromSnapshot(address, snap) : null;
  }

  async snapshotWithMeta(address: string, lines = 60): Promise<ScreenSnapshot | null> {
    return this.screens.snapshot(address, lines).catch((): ScreenSnapshot | null => null);
  }

  /** Presses the program's stop key and says what happened (hc watches for an effect). */
  async interrupt(address: string): Promise<string> {
    const out = await run(this.hcBin, ["interrupt", address, "--json", "--timeout", "1"], { timeoutMs: 20_000 });
    try {
      const r = JSON.parse(out) as Record<string, unknown>;
      const said = [r.outcome, r.result, r.message, r.status, r.state].find((v) => typeof v === "string" && v);
      return typeof said === "string" ? said : out.trim().slice(0, 300);
    } catch {
      return out.trim().slice(0, 300);
    }
  }

  /** Ends the terminal's program (hangup, then escalate). */
  async kill(address: string): Promise<void> {
    await run(this.hcBin, ["kill", address], { timeoutMs: 20_000 });
  }

  /** Removes a finished terminal entry from herdr-core; ignores already-gone or still-running errors. */
  async rm(address: string): Promise<void> {
    await run(this.hcBin, ["rm", address], { timeoutMs: 10_000 }).catch(() => {});
  }

  /** Sets labels on a terminal; herdr keeps what every client shares (seen, pin) there. */
  async label(address: string, labels: Record<string, string>): Promise<void> {
    await run(this.hcBin, ["label", address, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`)], { timeoutMs: 10_000 });
  }

  /** Types raw text at once (see HcScreens.input); the terminal keeps its size. */
  async input(address: string, data: string, auto = false): Promise<void> {
    const t = this.terminals.get(address);
    await this.screens.input(address, data, t?.cols || 80, t?.rows || 24, auto);
  }

  async keys(address: string, keys: string[]): Promise<void> {
    const mapped = keys.map((k) => KEY_ALIASES[k.toLowerCase()] ?? (k.length === 1 ? k : null));
    if (mapped.some((k) => k === null)) throw new Error(`unknown key in ${JSON.stringify(keys)}`);
    await run(this.hcBin, ["keys", address, ...(mapped as string[])]);
  }

  /**
   * Copies a local file beside the terminal (`hc put`; herdr-core keeps it in
   * its own per-terminal folder, renaming on a clash) and returns where it landed.
   */
  async put(address: string, file: string): Promise<string> {
    const out = await run(this.hcBin, ["put", "--json", address, file], { timeoutMs: 30_000 });
    let path: unknown;
    try {
      path = (JSON.parse(out) as { path?: unknown }).path;
    } catch {
      path = undefined;
    }
    if (typeof path !== "string" || !path) throw new Error(`hc put said no path: ${out.trim().slice(0, 200)}`);
    return path;
  }
}
