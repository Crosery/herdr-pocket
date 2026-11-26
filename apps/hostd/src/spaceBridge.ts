import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import type { HerdrDoc, HerdrDocSpace, SpaceInfo } from "@herdr-pocket/protocol";
import { docSpaceDisplayName, shortHome } from "./create.ts";
import type { HerdrWorkspaceInfo } from "./herdr.ts";

export interface SpaceBridgeCoreLike {
  docGet(name: string): Promise<{ value: unknown; version: number } | null>;
  docSetCas(name: string, value: unknown, version: number): Promise<{ ok: boolean; conflict?: boolean; version: number }>;
}

export interface SpaceBridgeHerdrLike {
  workspaces: HerdrWorkspaceInfo[];
  refreshWorkspaces(): Promise<HerdrWorkspaceInfo[]>;
  createWorkspace(label: string, cwd?: string): Promise<{ id?: string; label: string }>;
  renameWorkspace(workspaceId: string, label: string): Promise<void>;
}

export interface SpaceSyncSummary {
  syncedToCore: number;
  syncedToHerdr: number;
  herdrAvailable: boolean;
}

function normName(raw?: string): string {
  return (raw ?? "").trim().toLowerCase();
}

function normFolder(raw?: string): string {
  const s = shortHome(raw, homedir()) ?? raw?.trim() ?? "";
  return s.replace(/[\\/]+$/, "").toLowerCase();
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
    const label = ws.label.trim() || ws.id;
    const nn = normName(label);
    const nf = normFolder(ws.folder);
    const hit = (nn ? byName.get(nn) : undefined) ?? (nf && nf !== "~" ? byFolder.get(nf) : undefined);
    const extraTerms = herdrAgentCounts?.get(ws.id) ?? 0;
    if (hit) {
      hit.terminals += extraTerms;
      if (!hit.folder && ws.folder) hit.folder = shortHome(ws.folder) ?? ws.folder;
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
  const doc = await opts.core.docGet("herdr-app").catch(() => null);
  const val =
    doc?.value && typeof doc.value === "object" && !Array.isArray(doc.value)
      ? (doc.value as HerdrDoc)
      : null;

  let syncedToCore = 0;
  let syncedToHerdr = 0;

  if (val && Array.isArray(val.spaces)) {
    const coreSpaces = [...val.spaces];
    const coreNames = new Set<string>();
    const coreFolders = new Set<string>();
    const usedIds = new Set<string>();
    for (const sp of coreSpaces) {
      if (!sp || (sp as Record<string, unknown>).machine) continue;
      if (typeof sp.id === "string") usedIds.add(sp.id);
      const dn = normName(docSpaceDisplayName(sp));
      if (dn) coreNames.add(dn);
      const nf = normFolder(sp.folder);
      if (nf && nf !== "~") coreFolders.add(nf);
    }

    for (const ws of herdrWorkspaces) {
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
      syncedToCore += 1;
    }

    if (syncedToCore > 0) {
      const res = await opts.core.docSetCas("herdr-app", { ...val, spaces: coreSpaces }, doc!.version).catch(() => ({ ok: false }));
      if (!res.ok) syncedToCore = 0;
    }

    if (opts.mirrorToHerdr !== false) {
      const herdrNames = new Set(herdrWorkspaces.map((w) => normName(w.label)).filter(Boolean));
      const herdrFolders = new Set(
        herdrWorkspaces
          .map((w) => normFolder(w.folder))
          .filter((f) => Boolean(f) && f !== "~"),
      );
      for (const sp of coreSpaces) {
        if (!sp || (sp as Record<string, unknown>).machine) continue;
        const label = docSpaceDisplayName(sp).trim();
        if (!label) continue;
        const nn = normName(label);
        const nf = normFolder(sp.folder);
        if (herdrNames.has(nn) || (nf && nf !== "~" && herdrFolders.has(nf))) continue;
        try {
          await opts.herdr.createWorkspace(label, sp.folder || undefined);
          herdrNames.add(nn);
          if (nf && nf !== "~") herdrFolders.add(nf);
          syncedToHerdr += 1;
        } catch {
          // Older herdr build or read-only socket: ignore gracefully.
          break;
        }
      }
    }
  }

  return { syncedToCore, syncedToHerdr, herdrAvailable: true };
}
