import type { Agent, Device, SpaceInfo } from "@herdr-pocket/protocol";
import { agentSpace } from "../lib/store";
import { GROUP_RANK, lastChange, listGroup, type ListGroup } from "./agentInfo";

export interface SidebarSpace {
  id: string;
  deviceId: string;
  spaceId?: string;
  name: string;
  folder?: string;
  color?: string;
  active?: boolean;
  isWorktree?: boolean;
  count: number;
  blocked: number;
  best: ListGroup;
  latest: number;
}

const ANSI_HEX: Record<string, string> = {
  ansi1: "#ef4444",
  ansi2: "#10b981",
  ansi3: "#f59e0b",
  ansi4: "#3b82f6",
  ansi5: "#d946ef",
  ansi6: "#06b6d4",
};

/** Maps Herdr App `space.colors` values (`ansi1`..`ansi6` or `#hex`) into foreground/background CSS values. */
export function spaceColorVars(color?: string): { fg: string; bg: string } | null {
  const raw = color?.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const hex = ANSI_HEX[lower] ?? (/^#[0-9a-f]{3,8}$/i.test(raw) ? raw : null);
  if (!hex) return null;
  return {
    fg: hex,
    bg: `color-mix(in srgb, ${hex} 18%, transparent)`,
  };
}

/**
 * Builds the sidebar spaces list for one computer:
 * 1. Exact order from Herdr App's `spaces.list` (including 0-agent / empty spaces and `color`).
 * 2. Orphan agent groups whose space is not listed by Herdr App (sorted by urgency).
 */
export function buildHostSpaces(
  hostId: string,
  hostSpaces: readonly SpaceInfo[] | undefined,
  hostAgents: readonly Agent[],
  devices: Record<string, Device>,
): SidebarSpace[] {
  const per = new Map<string, Agent[]>();
  for (const a of hostAgents) {
    if (a.deviceId !== hostId) continue;
    const sp = agentSpace(a)?.trim() ?? "";
    if (!sp) continue;
    const list = per.get(sp);
    if (list) list.push(a);
    else per.set(sp, [a]);
  }

  const out: SidebarSpace[] = [];
  const consumed = new Set<string>();

  for (const sp of hostSpaces ?? []) {
    const name = sp.name.trim();
    if (!name) continue;
    const list = per.get(name) ?? [];
    if (per.has(name)) consumed.add(name);
    const groups = list.map((a) => listGroup(a, devices));
    const blocked = groups.filter((g) => g === "blocked").length;
    const best = list.length
      ? groups.reduce<ListGroup>((b, g) => (GROUP_RANK[g] < GROUP_RANK[b] ? g : b), "offline")
      : devices[hostId]?.online === false
        ? "offline"
        : "idle";
    const latest = list.length ? Math.max(...list.map(lastChange)) : 0;
    out.push({
      id: `${hostId}\u0000${name}`,
      deviceId: hostId,
      spaceId: sp.id,
      name,
      folder: sp.folder,
      color: sp.color,
      active: sp.active,
      isWorktree: sp.isWorktree,
      count: list.length,
      blocked,
      best,
      latest,
    });
  }

  const orphans: SidebarSpace[] = [];
  for (const [name, list] of per.entries()) {
    if (!name.trim() || consumed.has(name)) continue;
    const groups = list.map((a) => listGroup(a, devices));
    const blocked = groups.filter((g) => g === "blocked").length;
    const best = groups.reduce<ListGroup>((b, g) => (GROUP_RANK[g] < GROUP_RANK[b] ? g : b), "offline");
    orphans.push({
      id: `${hostId}\u0000${name}`,
      deviceId: hostId,
      name,
      count: list.length,
      blocked,
      best,
      latest: Math.max(...list.map(lastChange)),
    });
  }
  orphans.sort((x, y) => y.blocked - x.blocked || GROUP_RANK[x.best] - GROUP_RANK[y.best] || y.latest - x.latest);

  return [...out, ...orphans];
}
