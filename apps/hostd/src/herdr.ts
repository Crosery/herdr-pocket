import { sgrOnly } from "./vt.ts";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { normalizeStatus, type Agent } from "@herdr-pocket/protocol";
import { cleanTitle } from "./util.ts";

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
  agent_status?: string;
  cwd?: string | null;
  foreground_cwd?: string | null;
  agent_session?: { source?: string; agent?: string; kind?: string; value?: string } | null;
}

export interface HerdrWorkspaceInfo {
  id: string;
  label: string;
  folder?: string;
  active?: boolean;
  tabs: Array<{ id: string; label?: string }>;
}

/**
 * Bridges the herdr terminal UI server over its NDJSON socket API
 * (one request per connection). Polls `agent.list` and `workspace.list`; herdr's list is small.
 */
export class HerdrAdapter extends EventEmitter {
  agents: HerdrAgentInfo[] = [];
  workspaces: HerdrWorkspaceInfo[] = [];
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

  async refreshWorkspaces(): Promise<HerdrWorkspaceInfo[]> {
    try {
      const wr = await this.call("workspace.list", {}, 5000);
      const rawList = Array.isArray(wr?.workspaces) ? wr.workspaces : Array.isArray(wr) ? wr : [];
      const next: HerdrWorkspaceInfo[] = [];
      const wsLabels = new Map<string, string>();
      const tbLabels = new Map<string, string>();
      for (const item of rawList) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const id = String(rec.id ?? rec.workspace_id ?? "").trim();
        if (!id) continue;
        const label = String(rec.label ?? rec.name ?? rec.title ?? id).trim() || id;
        const folder = typeof rec.cwd === "string" && rec.cwd.trim() ? rec.cwd.trim() : typeof rec.folder === "string" && rec.folder.trim() ? rec.folder.trim() : undefined;
        const rawTabs = Array.isArray(rec.tabs) ? rec.tabs : [];
        const tabs: Array<{ id: string; label?: string }> = [];
        for (const t of rawTabs) {
          if (!t || typeof t !== "object") continue;
          const tr = t as Record<string, unknown>;
          const tid = String(tr.id ?? tr.tab_id ?? "").trim();
          const tlabel = typeof tr.label === "string" && tr.label.trim() ? tr.label.trim() : typeof tr.name === "string" && tr.name.trim() ? tr.name.trim() : undefined;
          if (tid) {
            tabs.push({ id: tid, ...(tlabel ? { label: tlabel } : {}) });
            if (tlabel) tbLabels.set(tid, tlabel);
          }
        }
        wsLabels.set(id, label);
        next.push({
          id,
          label,
          ...(folder ? { folder } : {}),
          ...(rec.active ? { active: true } : {}),
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

  async createWorkspace(label: string, cwd?: string): Promise<{ id?: string; label: string }> {
    const clean = label.trim();
    const params: Record<string, unknown> = {
      ...(clean ? { label: clean, name: clean } : {}),
      ...(cwd?.trim() ? { cwd: cwd.trim() } : {}),
    };
    const res = await this.call("workspace.create", params, 8000);
    await this.refreshWorkspaces().catch(() => {});
    const id = typeof res?.workspace_id === "string" ? res.workspace_id : typeof res?.id === "string" ? res.id : undefined;
    return { ...(id ? { id } : {}), label: clean };
  }

  async renameWorkspace(workspaceId: string, label: string): Promise<void> {
    await this.call("workspace.rename", { workspace_id: workspaceId, label: label.trim(), name: label.trim() }, 8000);
    await this.refreshWorkspaces().catch(() => {});
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
      // Infer workspace folder from its live agents when workspace.list doesn't include cwd.
      if (this.workspaces.length > 0 && agents.length > 0) {
        for (const ws of this.workspaces) {
          if (ws.folder) continue;
          const match = agents.find((a) => a.workspace_id === ws.id && (a.foreground_cwd || a.cwd));
          if (match) ws.folder = (match.foreground_cwd ?? match.cwd) ?? undefined;
        }
      }
      const sig = JSON.stringify([
        agents.map((a) => [a.terminal_id, a.agent_status, a.title, a.cwd, a.workspace_id, a.tab_id]),
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
