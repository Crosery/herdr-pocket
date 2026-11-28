import { sgrOnly } from "./vt.ts";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { normalizeStatus, type Agent } from "@herdr-pocket/protocol";
import { base, cleanTitle } from "./util.ts";

/** Source tag reported to `herdr` TUI for panes mirroring a `herdr-core` terminal via `hc attach`. */
export const HERDR_BRIDGE_SOURCE = "herdr-pocket-bridge";

/** Valid `PaneAgentState` enum values accepted by `herdr` `pane.report_agent` (Protocol v22). */
export type PaneAgentState = "idle" | "working" | "blocked" | "unknown";

/** Strict validation pattern for `herdr-core` terminal addresses before shell interpolation. */
export const CORE_ADDR_RE = /^[A-Za-z0-9_.:/-]+$/;

const ATTACH_CMD_RE = /(?:^|[\s/'"])(?:herdr-core|hc)(?:\.exe)?['"]?\s+attach\s+([A-Za-z0-9_.:/-]+)/i;

export function isValidCoreAddr(addr: string | null | undefined): addr is string {
  return typeof addr === "string" && addr.length > 0 && !addr.startsWith("-") && CORE_ADDR_RE.test(addr);
}

/** POSIX-safe single-quote escaping so `hcBin` can never cause shell injection in `exec <hcBin> ...`. */
export function shellQuote(arg: string): string {
  if (!arg) throw new Error("empty command argument");
  if (/^[A-Za-z0-9_./:-]+$/.test(arg) && !arg.startsWith("-")) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Maps Pocket/herdr statuses onto `herdr`'s `PaneAgentState` enum (`done` maps to `idle`). */
export function toPaneAgentState(status?: string | null): PaneAgentState {
  switch ((status ?? "").trim().toLowerCase()) {
    case "working":
    case "work":
      return "working";
    case "blocked":
    case "need_user":
    case "needs_user":
    case "permission":
    case "question":
    case "auth":
      return "blocked";
    case "idle":
    case "done":
    case "ready":
      return "idle";
    default:
      return "unknown";
  }
}

function expandHomePath(raw?: string): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  if (s === "~") return homedir();
  if (s.startsWith("~/")) return join(homedir(), s.slice(2));
  return s;
}

function resumeCommandName(hcBin: string): string {
  const clean = hcBin.trim();
  if (!clean) return "herdr-core";
  if (clean.includes("/") || clean.includes("\\")) {
    return base(clean) || "herdr-core";
  }
  return clean;
}

function extractAddrFromArgv(argv?: readonly string[] | null): string | undefined {
  if (!Array.isArray(argv) || argv.length < 3) return undefined;
  const bin = base(argv[0])?.toLowerCase() ?? "";
  if (bin !== "hc" && bin !== "hc.exe" && bin !== "herdr-core" && bin !== "herdr-core.exe") return undefined;
  const attachIdx = argv.indexOf("attach");
  if (attachIdx < 1 || attachIdx + 1 >= argv.length) return undefined;
  for (let i = attachIdx + 1; i < argv.length; i += 1) {
    const tok = argv[i] ?? "";
    if (!tok || tok.startsWith("-")) {
      if (tok === "--history") i += 1;
      continue;
    }
    return isValidCoreAddr(tok) ? tok : undefined;
  }
  return undefined;
}

/** Subset of herdr's `AgentInfo` (src/api/schema/agents.rs). */
export interface HerdrAgentInfo {
  terminal_id: string;
  name?: string | null;
  agent?: string | null;
  display_agent?: string | null;
  workspace_id?: string;
  tab_id?: string;
  pane_id: string;
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  agent_status?: string;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent_session?: { source?: string; agent?: string; kind?: string; value?: string } | null;
  tokens?: Record<string, string> | null;
  state_labels?: Record<string, string> | null;
  command?: string | null;
  argv?: string[] | null;
  resume_argv?: string[] | null;
}

/** Subset of herdr's `PaneInfo` returned by `pane.list` (Protocol v22). */
export interface HerdrPaneInfo {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused?: boolean;
  agent?: string | null;
  display_agent?: string | null;
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  label?: string | null;
  agent_status?: string;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent_session?: { source?: string; agent?: string; kind?: string; value?: string } | null;
  tokens?: Record<string, string> | null;
  state_labels?: Record<string, string> | null;
  command?: string | null;
  argv?: string[] | null;
  resume_argv?: string[] | null;
}

export interface HerdrWorkspaceInfo {
  id: string;
  label: string;
  folder?: string;
  active?: boolean;
  paneCount?: number;
  tabCount?: number;
  tabs: Array<{ id: string; label?: string }>;
}

/** Extracts the mirrored `herdr-core` address from a `herdr` pane/agent snapshot, if any. */
export function extractMirroredCoreAddr(
  item: Partial<HerdrPaneInfo & HerdrAgentInfo> | null | undefined,
): string | undefined {
  if (!item) return undefined;
  const tokAddr = item.tokens?.core_addr?.trim();
  if (isValidCoreAddr(tokAddr)) return tokAddr;
  if (item.agent_session?.source === HERDR_BRIDGE_SOURCE && isValidCoreAddr(item.agent_session.value?.trim())) {
    return item.agent_session.value!.trim();
  }
  const fromResume = extractAddrFromArgv(item.resume_argv) ?? extractAddrFromArgv(item.argv);
  if (fromResume) return fromResume;
  for (const field of [item.command, item.title, item.terminal_title_stripped, item.terminal_title]) {
    if (typeof field !== "string" || !field) continue;
    const m = ATTACH_CMD_RE.exec(field);
    if (m?.[1] && isValidCoreAddr(m[1])) return m[1];
  }
  return undefined;
}

/**
 * Bridges the herdr terminal UI server over its NDJSON socket API
 * (one request per connection). Polls `agent.list` and `workspace.list`; herdr's list is small.
 */
export class HerdrAdapter extends EventEmitter {
  agents: HerdrAgentInfo[] = [];
  panes: HerdrPaneInfo[] = [];
  workspaces: HerdrWorkspaceInfo[] = [];
  /** Live mapping of mirrored `herdr-core` terminal address -> `herdr` `pane_id`. */
  mirroredCorePaneMap = new Map<string, string>();
  /** Set of `herdr` `pane_id`s known to be `hc attach` mirrors of `herdr-core` terminals. */
  mirroredPaneIds = new Set<string>();
  private mirroredPaneToCoreAddr = new Map<string, string>();
  private lastMirrorReportSig = new Map<string, string>();
  private workspaceLabels = new Map<string, string>();
  private tabLabels = new Map<string, string>();
  private socketPath: string;
  private timer: NodeJS.Timeout | null = null;
  private last = "";

  constructor(socketPath = process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config/herdr/herdr.sock")) {
    super();
    this.socketPath = socketPath;
  }

  async available(): Promise<boolean> {
    if (!existsSync(this.socketPath)) return false;
    try {
      await this.call("ping", {}, 3000);
      return true;
    } catch {
      return false;
    }
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 3000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refreshNow(): Promise<void> {
    await this.refresh();
  }

  private recordMirror(coreAddr: string, paneId: string): void {
    if (!isValidCoreAddr(coreAddr) || !paneId) return;
    this.mirroredCorePaneMap.set(coreAddr, paneId);
    this.mirroredPaneIds.add(paneId);
    this.mirroredPaneToCoreAddr.set(paneId, coreAddr);
  }

  async refreshWorkspaces(): Promise<HerdrWorkspaceInfo[]> {
    try {
      const wr = await this.call("workspace.list", {}, 5000);
      const rawList = Array.isArray(wr?.workspaces) ? wr.workspaces : Array.isArray(wr) ? wr : [];
      const prevFolders = new Map(this.workspaces.filter((w) => w.folder).map((w) => [w.id, w.folder!]));
      const next: HerdrWorkspaceInfo[] = [];
      const wsLabels = new Map<string, string>();
      const tbLabels = new Map<string, string>();
      for (const item of rawList) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const id = String(rec.workspace_id ?? rec.id ?? "").trim();
        if (!id) continue;
        const label = String(rec.label ?? rec.name ?? rec.title ?? id).trim() || id;
        const wt = rec.worktree && typeof rec.worktree === "object" ? (rec.worktree as Record<string, unknown>) : null;
        const folder =
          typeof rec.cwd === "string" && rec.cwd.trim()
            ? rec.cwd.trim()
            : typeof rec.folder === "string" && rec.folder.trim()
              ? rec.folder.trim()
              : typeof wt?.checkout_path === "string" && wt.checkout_path.trim()
                ? wt.checkout_path.trim()
                : prevFolders.get(id);
        const rawTabs = Array.isArray(rec.tabs) ? rec.tabs : [];
        const tabs: Array<{ id: string; label?: string }> = [];
        for (const t of rawTabs) {
          if (!t || typeof t !== "object") continue;
          const tr = t as Record<string, unknown>;
          const tid = String(tr.tab_id ?? tr.id ?? "").trim();
          const tlabel = typeof tr.label === "string" && tr.label.trim() ? tr.label.trim() : typeof tr.name === "string" && tr.name.trim() ? tr.name.trim() : undefined;
          if (tid) {
            tabs.push({ id: tid, ...(tlabel ? { label: tlabel } : {}) });
            if (tlabel) tbLabels.set(tid, tlabel);
          }
        }
        wsLabels.set(id, label);
        const isActive = Boolean(rec.focused ?? rec.active);
        const paneCount = typeof rec.pane_count === "number" ? rec.pane_count : undefined;
        const tabCount = typeof rec.tab_count === "number" ? rec.tab_count : undefined;
        next.push({
          id,
          label,
          ...(folder ? { folder } : {}),
          ...(isActive ? { active: true } : {}),
          ...(paneCount !== undefined ? { paneCount } : {}),
          ...(tabCount !== undefined ? { tabCount } : {}),
          tabs,
        });
      }
      this.workspaces = next;
      this.workspaceLabels = wsLabels;
      this.tabLabels = tbLabels;
      return next;
    } catch {
      return this.workspaces;
    }
  }

  async createWorkspace(
    label: string,
    cwd?: string,
    opts?: { focus?: boolean },
  ): Promise<{ id?: string; label: string; tabId?: string; paneId?: string }> {
    const clean = label.trim();
    const resolvedCwd = expandHomePath(cwd);
    const params: Record<string, unknown> = {
      ...(clean ? { label: clean } : {}),
      ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
      focus: opts?.focus ?? false,
    };
    const res = await this.call("workspace.create", params, 8000);
    await this.refreshWorkspaces().catch(() => {});
    const id =
      typeof res?.workspace?.workspace_id === "string"
        ? res.workspace.workspace_id
        : typeof res?.workspace_id === "string"
          ? res.workspace_id
          : typeof res?.id === "string"
            ? res.id
            : undefined;
    const tabId = typeof res?.tab?.tab_id === "string" ? res.tab.tab_id : undefined;
    const paneId = typeof res?.root_pane?.pane_id === "string" ? res.root_pane.pane_id : undefined;
    return {
      ...(id ? { id } : {}),
      label: clean,
      ...(tabId ? { tabId } : {}),
      ...(paneId ? { paneId } : {}),
    };
  }

  async renameWorkspace(workspaceId: string, label: string): Promise<void> {
    await this.call("workspace.rename", { workspace_id: workspaceId, label: label.trim() }, 8000);
    await this.refreshWorkspaces().catch(() => {});
  }

  async listPanes(workspaceId?: string): Promise<HerdrPaneInfo[]> {
    const params: Record<string, unknown> = workspaceId ? { workspace_id: workspaceId } : {};
    const res = await this.call("pane.list", params, 5000);
    const raw: unknown[] = Array.isArray(res?.panes) ? res.panes : Array.isArray(res) ? res : [];
    const panes: HerdrPaneInfo[] = raw.filter(
      (p): p is HerdrPaneInfo => Boolean(p && typeof p === "object" && typeof (p as HerdrPaneInfo).pane_id === "string"),
    );
    if (!workspaceId) {
      this.panes = panes;
      // Backfill workspace folder from live panes when `workspace.list` omits `cwd`.
      for (const ws of this.workspaces) {
        if (ws.folder) continue;
        const hit = panes.find((p) => p.workspace_id === ws.id && (p.foreground_cwd || p.cwd));
        if (hit) ws.folder = (hit.foreground_cwd ?? hit.cwd) ?? undefined;
      }
    }
    for (const p of panes) {
      const addr = extractMirroredCoreAddr(p);
      if (addr) this.recordMirror(addr, p.pane_id);
    }
    return panes;
  }

  async createTab(opts: {
    workspaceId: string;
    cwd?: string;
    label?: string;
    env?: Record<string, string>;
    focus?: boolean;
  }): Promise<{ tabId?: string; paneId?: string; terminalId?: string; workspaceId: string }> {
    const resolvedCwd = expandHomePath(opts.cwd);
    const params: Record<string, unknown> = {
      workspace_id: opts.workspaceId,
      focus: opts.focus ?? false,
      ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
      ...(opts.label?.trim() ? { label: opts.label.trim() } : {}),
      ...(opts.env && Object.keys(opts.env).length > 0 ? { env: opts.env } : {}),
    };
    const res = await this.call("tab.create", params, 8000);
    const tabId =
      typeof res?.tab?.tab_id === "string"
        ? res.tab.tab_id
        : typeof res?.tab_id === "string"
          ? res.tab_id
          : undefined;
    const paneId =
      typeof res?.root_pane?.pane_id === "string"
        ? res.root_pane.pane_id
        : typeof res?.pane_id === "string"
          ? res.pane_id
          : undefined;
    const terminalId =
      typeof res?.root_pane?.terminal_id === "string"
        ? res.root_pane.terminal_id
        : typeof res?.terminal_id === "string"
          ? res.terminal_id
          : undefined;
    return {
      ...(tabId ? { tabId } : {}),
      ...(paneId ? { paneId } : {}),
      ...(terminalId ? { terminalId } : {}),
      workspaceId: opts.workspaceId,
    };
  }

  /**
   * Reports bridge metadata (`tokens.core_addr`, `display_agent`, `title`) and agent state
   * (`pane.report_agent` with `resume_argv`) onto a mirrored `herdr` pane.
   * Returns `true` when an update was sent, `false` when the pane already matched.
   */
  async reportCoreMirrorMetadata(
    opts: {
      paneId: string;
      hcBin: string;
      address: string;
      harness: string;
      title?: string;
      state?: string;
      message?: string;
    },
    force = false,
  ): Promise<boolean> {
    if (!isValidCoreAddr(opts.address)) {
      throw new Error(`invalid herdr-core terminal address: ${opts.address}`);
    }
    if (!opts.paneId?.trim()) throw new Error("paneId is required");
    const paneId = opts.paneId.trim();
    const harness = opts.harness.trim() || "agent";
    const title = opts.title?.trim() || undefined;
    const state = toPaneAgentState(opts.state);
    const message = opts.message?.trim() || undefined;
    const sig = JSON.stringify([opts.address, harness, title ?? "", state, message ?? ""]);

    this.recordMirror(opts.address, paneId);

    if (!force) {
      const livePane = this.panes.find((p) => p.pane_id === paneId);
      const liveMatches =
        Boolean(livePane) &&
        livePane!.tokens?.core_addr === opts.address &&
        (livePane!.display_agent || livePane!.agent || "").trim() === harness &&
        (livePane!.title?.trim() || undefined) === title &&
        toPaneAgentState(livePane!.agent_status) === state;
      const lastSig = this.lastMirrorReportSig.get(paneId);
      if (lastSig === sig && (!livePane || liveMatches)) {
        return false;
      }
      if (lastSig === undefined && liveMatches && !message) {
        this.lastMirrorReportSig.set(paneId, sig);
        return false;
      }
    }

    const resumeCmd = resumeCommandName(opts.hcBin);
    await this.call(
      "pane.report_metadata",
      {
        pane_id: paneId,
        source: HERDR_BRIDGE_SOURCE,
        ...(title ? { title } : {}),
        display_agent: harness,
        tokens: { core_addr: opts.address },
        ttl_ms: 86_400_000,
      },
      5000,
    ).catch(() => {});

    await this.call(
      "pane.report_agent",
      {
        pane_id: paneId,
        source: HERDR_BRIDGE_SOURCE,
        agent: harness,
        state,
        ...(message ? { message } : {}),
        resume_argv: [resumeCmd, "attach", opts.address, "--history", "200"],
      },
      5000,
    ).catch(() => {});

    this.lastMirrorReportSig.set(paneId, sig);
    return true;
  }

  /**
   * Attaches a `herdr` pane 1:1 to a live `herdr-core` terminal via `exec <hcBin> attach <addr> --history 200`
   * (zero duplicate AI processes) and reports bridge metadata + agent state best-effort.
   */
  async attachCoreTerminalInPane(opts: {
    paneId: string;
    hcBin: string;
    address: string;
    harness: string;
    title?: string;
    state?: string;
    message?: string;
  }): Promise<void> {
    if (!isValidCoreAddr(opts.address)) {
      throw new Error(`invalid herdr-core terminal address: ${opts.address}`);
    }
    if (!opts.paneId?.trim()) throw new Error("paneId is required");
    const paneId = opts.paneId.trim();
    const quotedBin = shellQuote(opts.hcBin.trim() || "hc");
    const cmd = `exec ${quotedBin} attach ${opts.address} --history 200`;
    await this.call("pane.send_input", { pane_id: paneId, text: cmd, keys: ["enter"] }, 8000);
    await this.reportCoreMirrorMetadata({ ...opts, paneId }, true);
  }

  /**
   * Inspects live `pane.list`, `this.agents`, and in-memory bridge mappings to return
   * `coreAddr -> paneId` for every `herdr-core` terminal already mirrored in `herdr`.
   */
  async findMirroredCoreAddrs(): Promise<Map<string, string>> {
    let listedPanes: HerdrPaneInfo[] | null = null;
    try {
      listedPanes = await this.listPanes();
    } catch {
      listedPanes = null;
    }

    if (listedPanes !== null) {
      const livePaneIds = new Set(listedPanes.map((p) => p.pane_id));
      for (const [addr, pid] of [...this.mirroredCorePaneMap.entries()]) {
        if (!livePaneIds.has(pid)) {
          this.mirroredCorePaneMap.delete(addr);
          this.mirroredPaneIds.delete(pid);
          this.mirroredPaneToCoreAddr.delete(pid);
          this.lastMirrorReportSig.delete(pid);
        }
      }
      for (const pid of [...this.mirroredPaneIds]) {
        if (!livePaneIds.has(pid)) {
          this.mirroredPaneIds.delete(pid);
          this.mirroredPaneToCoreAddr.delete(pid);
          this.lastMirrorReportSig.delete(pid);
        }
      }
    }

    for (const a of this.agents) {
      const addr = extractMirroredCoreAddr(a);
      if (addr) this.recordMirror(addr, a.pane_id);
    }

    return new Map(this.mirroredCorePaneMap);
  }

  /** Returns the mirrored `herdr-core` terminal address for a `herdr` agent, if it is a bridge mirror. */
  mirroredCoreAddrOf(a: HerdrAgentInfo): string | undefined {
    const extracted = extractMirroredCoreAddr(a);
    if (extracted) {
      this.recordMirror(extracted, a.pane_id);
      return extracted;
    }
    const direct = this.mirroredPaneToCoreAddr.get(a.pane_id);
    if (direct) return direct;
    for (const [addr, pid] of this.mirroredCorePaneMap) {
      if (pid === a.pane_id) return addr;
    }
    return undefined;
  }

  /** True when a `herdr` agent entry is simply an `hc attach` mirror of a `herdr-core` terminal. */
  isMirroredCoreAgent(a: HerdrAgentInfo): boolean {
    if (this.mirroredPaneIds.has(a.pane_id)) return true;
    return Boolean(this.mirroredCoreAddrOf(a));
  }

  resolveWorkspaceName(workspaceId?: string): string | undefined {
    if (!workspaceId) return undefined;
    return this.workspaceLabels.get(workspaceId) ?? workspaceId;
  }

  resolveTabName(tabId?: string): string | undefined {
    if (!tabId) return undefined;
    return this.tabLabels.get(tabId) ?? tabId;
  }

  private async refresh(): Promise<void> {
    try {
      const [r] = await Promise.all([
        this.call("agent.list", {}),
        this.refreshWorkspaces().catch(() => []),
      ]);
      const agents = (r.agents ?? []) as HerdrAgentInfo[];
      for (const a of agents) {
        const addr = extractMirroredCoreAddr(a);
        if (addr) this.recordMirror(addr, a.pane_id);
      }
      // Infer workspace folder from its live agents when workspace.list doesn't include cwd.
      if (this.workspaces.length > 0 && agents.length > 0) {
        for (const ws of this.workspaces) {
          if (ws.folder) continue;
          const match = agents.find((a) => a.workspace_id === ws.id && (a.foreground_cwd || a.cwd));
          if (match) ws.folder = (match.foreground_cwd ?? match.cwd) ?? undefined;
        }
      }
      const sig = JSON.stringify([
        agents.map((a) => [a.terminal_id, a.agent_status, a.title, a.cwd, a.workspace_id, a.tab_id, a.tokens?.core_addr ?? ""]),
        this.workspaces.map((w) => [w.id, w.label, w.folder]),
      ]);
      this.agents = agents;
      if (sig !== this.last) {
        this.last = sig;
        this.emit("change");
      }
    } catch {
      if (this.agents.length || this.workspaces.length) {
        this.agents = [];
        this.panes = [];
        this.workspaces = [];
        this.workspaceLabels.clear();
        this.tabLabels.clear();
        this.last = "";
        this.emit("change");
      }
    }
  }

  call(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      let buf = "";
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error(`herdr ${method} timed out`));
      }, timeoutMs);
      sock.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
      sock.on("data", (d) => {
        buf += d.toString();
        const i = buf.indexOf("\n");
        if (i < 0) return;
        clearTimeout(t);
        sock.end();
        try {
          const msg = JSON.parse(buf.slice(0, i));
          if (msg.error) reject(new Error(msg.error.message ?? msg.error.code));
          else resolve(msg.result);
        } catch (e) {
          reject(e);
        }
      });
      sock.write(`${JSON.stringify({ id: `hp_${Date.now()}`, method, params })}\n`);
    });
  }

  static toAgent(
    a: HerdrAgentInfo,
    deviceId: string,
    labels?: { workspace?: (id?: string) => string | undefined; tab?: (id?: string) => string | undefined },
  ): Agent {
    const harness = a.display_agent || a.agent || "agent";
    const wsName = labels?.workspace?.(a.workspace_id) ?? a.workspace_id;
    const tabName = labels?.tab?.(a.tab_id) ?? a.tab_id;
    return {
      key: `${deviceId}/herdr:${a.terminal_id}`,
      deviceId,
      source: "herdr",
      localId: a.terminal_id,
      harness,
      title: cleanTitle(a.title ?? a.terminal_title) ?? a.name ?? undefined,
      where: [wsName, tabName].filter(Boolean).join(" / ") || undefined,
      cwd: a.foreground_cwd ?? a.cwd ?? undefined,
      status: normalizeStatus(a.agent_status),
      isShell: false,
      updatedAt: Date.now(),
    };
  }

  find(localId: string): HerdrAgentInfo | undefined {
    return this.agents.find((a) => a.terminal_id === localId);
  }

  async read(localId: string, lines = 200): Promise<{ text: string; ansi?: string; complete?: boolean }> {
    const r = await this.call("agent.read", { target: localId, source: "recent", lines, format: "text", strip_ansi: true });
    let ansi: string | undefined;
    try {
      const c = await this.call("agent.read", { target: localId, source: "recent", lines, format: "ansi", strip_ansi: false });
      if (typeof c.text === "string") ansi = sgrOnly(c.text).replace(/\n+$/, "");
    } catch {
      /* older herdr: plain text only */
    }
    return { text: r.text ?? "", ansi, complete: !r.truncated };
  }

  async send(localId: string, text: string, enter = true): Promise<void> {
    const a = this.find(localId);
    if (!a) throw new Error("agent not found");
    await this.call("pane.send_input", { pane_id: a.pane_id, text, keys: enter ? ["enter"] : [] });
  }

  async keys(localId: string, keys: string[]): Promise<void> {
    const a = this.find(localId);
    if (!a) throw new Error("agent not found");
    // herdr parses lowercase names and chords: enter, esc, up, ctrl+c, shift+tab.
    await this.call("pane.send_keys", { pane_id: a.pane_id, keys: keys.map((k) => k.toLowerCase()) });
  }
}
