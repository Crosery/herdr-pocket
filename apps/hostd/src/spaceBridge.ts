import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import type { Agent, HerdrDoc, HerdrDocSpace, SpaceInfo } from "@herdr-pocket/protocol";
import { docSpaceDisplayName, shortHome } from "./create.ts";
import { isValidCoreAddr, type HerdrWorkspaceInfo } from "./herdr.ts";
import { base } from "./util.ts";

export interface SpaceBridgeCoreLike {
  docGet(name: string): Promise<{ value: unknown; version: number } | null>;
  docSetCas(
    name: string,
    value: unknown,
    version: number,
  ): Promise<{ ok: boolean; conflict?: boolean; value?: unknown; version: number }>;
}

export interface SpaceBridgeHerdrLike {
  workspaces: HerdrWorkspaceInfo[];
  refreshWorkspaces(): Promise<HerdrWorkspaceInfo[]>;
  createWorkspace(label: string, cwd?: string, opts?: { focus?: boolean }): Promise<{ id?: string; label: string }>;
  renameWorkspace(workspaceId: string, label: string): Promise<void>;
}

export interface AgentBridgeHerdrLike extends SpaceBridgeHerdrLike {
  findMirroredCoreAddrs(): Promise<Map<string, string>>;
  createTab(opts: {
    workspaceId: string;
    cwd?: string;
    label?: string;
    env?: Record<string, string>;
    focus?: boolean;
  }): Promise<{ tabId?: string; paneId?: string; terminalId?: string; workspaceId: string }>;
  attachCoreTerminalInPane(opts: {
    paneId: string;
    hcBin: string;
    address: string;
    harness: string;
    title?: string;
    state?: string;
    message?: string;
  }): Promise<void>;
  reportCoreMirrorMetadata(
    opts: {
      paneId: string;
      hcBin: string;
      address: string;
      harness: string;
      title?: string;
      state?: string;
      message?: string;
    },
    force?: boolean,
  ): Promise<boolean>;
}

export interface SpaceSyncSummary {
  syncedToCore: number;
  syncedToHerdr: number;
  herdrAvailable: boolean;
}

export interface CoreAgentMirrorSummary {
  syncedAgentsToHerdr: number;
  updatedMirrors: number;
}

function normName(raw?: string): string {
  return (raw ?? "").trim().toLowerCase();
}

function normFolder(raw?: string): string {
  const s = shortHome(raw, homedir()) ?? raw?.trim() ?? "";
  return s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Returns true for `herdr` TUI's built-in empty default scratch workspace (`~` with no tabs/agents),
 * which should neither clutter `spaces.list` nor be resurrected into `herdr-core` after deletion.
 */
export function isEmptyDefaultHomeWorkspace(ws: HerdrWorkspaceInfo, agentCount = 0): boolean {
  const label = ws.label.trim();
  if (label !== "~") return false;
  const nf = normFolder(ws.folder);
  if (nf && nf !== "~") return false;
  const tabCount = Math.max(ws.tabs?.length ?? 0, ws.tabCount ?? 0);
  const paneCount = ws.paneCount ?? 0;
  return tabCount === 0 && paneCount === 0 && agentCount <= 0;
}

/**
 * Merges `herdr` TUI workspaces into `spaces.list` results without duplicating spaces that
 * already exist in `herdr-core` (matched by normalized name or working folder).
 */
export function mergeHerdrWorkspacesIntoSpaces(
  coreSpaces: readonly SpaceInfo[],
  herdrWorkspaces: readonly HerdrWorkspaceInfo[],
  herdrAgentCounts?: ReadonlyMap<string, number>,
): SpaceInfo[] {
  if (herdrWorkspaces.length === 0) return [...coreSpaces];
  const out = coreSpaces.map((s) => ({ ...s }));
  const byName = new Map<string, SpaceInfo>();
  const byFolder = new Map<string, SpaceInfo>();
  for (const s of out) {
    const nn = normName(s.name);
    if (nn) byName.set(nn, s);
    const nf = normFolder(s.folder);
    if (nf && nf !== "~") byFolder.set(nf, s);
  }

  for (const ws of herdrWorkspaces) {
    const extraTerms = herdrAgentCounts?.get(ws.id) ?? 0;
    if (isEmptyDefaultHomeWorkspace(ws, extraTerms)) continue;
    const label = ws.label.trim() || ws.id;
    const nn = normName(label);
    const nf = normFolder(ws.folder);
    const hit = (nn ? byName.get(nn) : undefined) ?? (nf && nf !== "~" ? byFolder.get(nf) : undefined);
    if (hit) {
      hit.terminals += extraTerms;
      if (!hit.folder && ws.folder) {
        hit.folder = shortHome(ws.folder) ?? ws.folder;
        if (nf && nf !== "~") byFolder.set(nf, hit);
      }
      continue;
    }
    const created: SpaceInfo = {
      id: `herdr:${ws.id}`,
      name: label,
      ...(ws.folder ? { folder: shortHome(ws.folder) ?? ws.folder } : {}),
      tabs: Math.max(1, ws.tabs.length),
      terminals: extraTerms,
      ...(ws.active ? { active: true } : {}),
    };
    out.push(created);
    if (nn) byName.set(nn, created);
    if (nf && nf !== "~") byFolder.set(nf, created);
  }
  return out;
}

/**
 * Seamless bidirectional space bridge between `herdr` TUI and `herdr-core`'s `"herdr-app"` doc:
 * - Mirrors any `herdr` TUI workspace missing from `herdr-core` into `docs.json` (idempotent by name/folder).
 * - Mirrors any local `herdr-core` space missing from `herdr` TUI via `workspace.create` (best-effort).
 */
export async function syncSpacesBidirectional(opts: {
  core?: SpaceBridgeCoreLike | null;
  herdr?: SpaceBridgeHerdrLike | null;
  herdrAvailable: boolean;
  mirrorToHerdr?: boolean;
}): Promise<SpaceSyncSummary> {
  if (!opts.herdrAvailable || !opts.herdr || !opts.core) {
    return { syncedToCore: 0, syncedToHerdr: 0, herdrAvailable: opts.herdrAvailable };
  }

  const herdrWorkspaces = await opts.herdr.refreshWorkspaces().catch(() => opts.herdr!.workspaces);
  let doc = await opts.core.docGet("herdr-app").catch(() => null);
  let latestCoreSpaces: HerdrDocSpace[] | null = null;
  let syncedToCore = 0;
  let syncedToHerdr = 0;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const val =
      doc?.value && typeof doc.value === "object" && !Array.isArray(doc.value)
        ? (doc.value as HerdrDoc)
        : null;
    if (!val || !Array.isArray(val.spaces)) {
      latestCoreSpaces = null;
      break;
    }

    const coreSpaces = [...val.spaces];
    const coreNames = new Set<string>();
    const coreFolders = new Set<string>();
    const usedIds = new Set<string>();
    for (const sp of coreSpaces) {
      if (!sp) continue;
      if (typeof sp.id === "string") usedIds.add(sp.id);
      if ((sp as Record<string, unknown>).machine) continue;
      const dn = normName(docSpaceDisplayName(sp));
      if (dn) coreNames.add(dn);
      const nf = normFolder(sp.folder);
      if (nf && nf !== "~") coreFolders.add(nf);
    }

    let addedThisAttempt = 0;
    for (const ws of herdrWorkspaces) {
      if (isEmptyDefaultHomeWorkspace(ws)) continue;
      const label = ws.label.trim();
      if (!label) continue;
      const nn = normName(label);
      const nf = normFolder(ws.folder);
      if (coreNames.has(nn) || (nf && nf !== "~" && coreFolders.has(nf))) continue;

      let id = `sp${randomBytes(12).toString("hex")}`;
      while (usedIds.has(id)) id = `sp${randomBytes(12).toString("hex")}`;
      usedIds.add(id);

      const nextSpace: HerdrDocSpace = {
        id,
        name: label,
        folder: ws.folder?.trim() || "",
        tabs: [],
      };
      coreSpaces.push(nextSpace);
      coreNames.add(nn);
      if (nf && nf !== "~") coreFolders.add(nf);
      addedThisAttempt += 1;
    }

    latestCoreSpaces = coreSpaces;
    if (addedThisAttempt === 0) break;

    const res = await opts.core
      .docSetCas("herdr-app", { ...val, spaces: coreSpaces }, doc!.version)
      .catch(() => ({ ok: false as const, conflict: false, value: undefined as unknown, version: doc!.version }));
    if (res.ok) {
      syncedToCore = addedThisAttempt;
      break;
    }
    if (res.conflict && attempt < 2) {
      doc =
        res.value !== undefined
          ? { value: res.value, version: res.version }
          : await opts.core.docGet("herdr-app").catch(() => null);
      continue;
    }
    latestCoreSpaces = [...val.spaces];
    break;
  }

  if (latestCoreSpaces && opts.mirrorToHerdr !== false) {
    const herdrNames = new Set(herdrWorkspaces.map((w) => normName(w.label)).filter(Boolean));
    const herdrFolders = new Set(
      herdrWorkspaces
        .map((w) => normFolder(w.folder))
        .filter((f) => Boolean(f) && f !== "~"),
    );
    for (const sp of latestCoreSpaces) {
      if (!sp || (sp as Record<string, unknown>).machine) continue;
      if (!sp.name?.trim() && !sp.folder?.trim()) continue;
      const label = docSpaceDisplayName(sp).trim();
      if (!label) continue;
      const nn = normName(label);
      const nf = normFolder(sp.folder);
      if (herdrNames.has(nn) || (nf && nf !== "~" && herdrFolders.has(nf))) continue;
      try {
        await opts.herdr.createWorkspace(label, sp.folder || undefined, { focus: false });
        herdrNames.add(nn);
        if (nf && nf !== "~") herdrFolders.add(nf);
        syncedToHerdr += 1;
      } catch {
        // Older herdr build or read-only socket: ignore gracefully.
        break;
      }
    }
  }

  return { syncedToCore, syncedToHerdr, herdrAvailable: true };
}

/**
 * Mirrors live non-shell `herdr-core` (`hc`) agents into matching `herdr` TUI workspaces
 * using 1:1 live PTY attachment (`exec <hcBin> attach <addr> --history 200`, zero duplicate AI processes).
 *
 * Idempotency & safety guarantees:
 * - Already-mirrored `hc` terminals are NEVER duplicated; only changed metadata/status is refreshed.
 * - New tabs are always created with `focus: false` so background sync never steals focus.
 * - Existing panes, shells, and agents are NEVER closed or killed.
 */
export async function syncCoreAgentsToHerdr(opts: {
  agents: readonly Agent[];
  herdrWorkspaces: readonly HerdrWorkspaceInfo[];
  herdr: AgentBridgeHerdrLike;
  hcBin: string;
  herdrSpace?: string;
  herdrSessionKeys?: ReadonlySet<string>;
  updateExistingOnly?: boolean;
}): Promise<CoreAgentMirrorSummary> {
  const coreAgents = opts.agents.filter((a) => a.source === "hc" && !a.isShell && isValidCoreAddr(a.localId));
  if (coreAgents.length === 0) {
    return { syncedAgentsToHerdr: 0, updatedMirrors: 0 };
  }

  const mirroredAddrs = await opts.herdr.findMirroredCoreAddrs().catch(() => new Map<string, string>());
  if (opts.updateExistingOnly && mirroredAddrs.size === 0) {
    return { syncedAgentsToHerdr: 0, updatedMirrors: 0 };
  }

  const workspaces = [...opts.herdrWorkspaces];
  const byName = new Map<string, HerdrWorkspaceInfo>();
  const byFolder = new Map<string, HerdrWorkspaceInfo>();
  const indexWorkspace = (ws: HerdrWorkspaceInfo) => {
    const nn = normName(ws.label);
    if (nn && !byName.has(nn)) byName.set(nn, ws);
    const nf = normFolder(ws.folder);
    if (nf && nf !== "~" && !byFolder.has(nf)) byFolder.set(nf, ws);
  };
  for (const ws of workspaces) indexWorkspace(ws);

  const matchWorkspace = (wsName: string, cwd?: string): HerdrWorkspaceInfo | undefined => {
    const nn = normName(wsName);
    if (nn) {
      const hit = byName.get(nn);
      if (hit) return hit;
    }
    const nf = normFolder(cwd);
    if (nf && nf !== "~") {
      const hit = byFolder.get(nf);
      if (hit) return hit;
    }
    if (!nn && nf && nf !== "~") {
      const folderBase = normName(base(cwd));
      if (folderBase) {
        const hit = byName.get(folderBase);
        if (hit) return hit;
      }
    }
    if (nf === "~") {
      const homeWs = byName.get("~");
      if (homeWs) return homeWs;
    }
    return undefined;
  };

  const spaceFilter = normName(opts.herdrSpace);
  let syncedAgentsToHerdr = 0;
  let updatedMirrors = 0;

  for (const a of coreAgents) {
    if (!isValidCoreAddr(a.localId)) continue;
    const wsName = a.where?.split(" / ")[0]?.trim() || "";
    const matchedInitial = matchWorkspace(wsName, a.cwd);
    if (spaceFilter) {
      const agentWsNorm = normName(wsName);
      const matchedWsNorm = normName(matchedInitial?.label);
      if (agentWsNorm !== spaceFilter && matchedWsNorm !== spaceFilter) continue;
    }

    const existingPaneId = mirroredAddrs.get(a.localId);
    if (existingPaneId) {
      try {
        const updated = await opts.herdr.reportCoreMirrorMetadata({
          paneId: existingPaneId,
          hcBin: opts.hcBin,
          address: a.localId,
          harness: a.harness,
          title: a.title ?? a.name ?? undefined,
          state: a.status,
          message: a.statusNote,
        });
        if (updated) updatedMirrors += 1;
      } catch {
        // Best-effort metadata refresh for existing mirror.
      }
      continue;
    }

    if (opts.updateExistingOnly) continue;
    if (a.sessionKey && opts.herdrSessionKeys?.has(a.sessionKey)) continue;

    let ws = matchedInitial;
    if (!ws) {
      const nf = normFolder(a.cwd);
      const fallbackLabel = wsName || (nf && nf !== "~" ? base(a.cwd) : "") || "";
      if (fallbackLabel) {
        try {
          const createdWs = await opts.herdr.createWorkspace(fallbackLabel, a.cwd || undefined, { focus: false });
          if (createdWs.id) {
            ws = {
              id: createdWs.id,
              label: createdWs.label || fallbackLabel,
              ...(a.cwd ? { folder: a.cwd } : {}),
              tabs: [],
            };
            workspaces.push(ws);
            indexWorkspace(ws);
          }
        } catch {
          // Best-effort workspace creation; fall back below if possible.
        }
      }
      if (!ws) ws = workspaces[0];
      if (!ws) continue;
    }

    const tabLabel = (a.title?.trim() || a.name?.trim() || `${a.harness} (${a.localId})`).slice(0, 60);
    try {
      const created = await opts.herdr.createTab({
        workspaceId: ws.id,
        ...(a.cwd?.trim() ? { cwd: a.cwd.trim() } : ws.folder ? { cwd: ws.folder } : {}),
        label: tabLabel,
        env: { HERDR_POCKET_CORE_ADDR: a.localId },
        focus: false,
      });
      if (!created.paneId) continue;
      await opts.herdr.attachCoreTerminalInPane({
        paneId: created.paneId,
        hcBin: opts.hcBin,
        address: a.localId,
        harness: a.harness,
        title: a.title ?? a.name ?? undefined,
        state: a.status,
        message: a.statusNote,
      });
      mirroredAddrs.set(a.localId, created.paneId);
      syncedAgentsToHerdr += 1;
    } catch {
      // Best-effort per agent; never abort syncing remaining agents.
    }
  }

  return { syncedAgentsToHerdr, updatedMirrors };
}
