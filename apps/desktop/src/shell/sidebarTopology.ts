import type { Agent, Device, SpaceInfo } from "@herdr-pocket/protocol";
import { agentSpace, agentTitle, type SidebarAgentGrouping, type SidebarStyleScheme } from "../lib/store";
import { GROUP_RANK, LIST_GROUPS, lastChange, listGroup, type ListGroup } from "./agentInfo";
import {
  focusedLeafOfTab,
  resolveAgentSpaceKey,
  tabLeaves,
  tabSpaceKey,
  type AgentSpaceRef,
  type PaneContent,
  type ShellTab,
} from "./shellStore";

export type TopologyAgentLike = AgentSpaceRef &
  Partial<Pick<Agent, "key" | "name" | "title" | "localId" | "harness" | "status" | "isShell">>;

export interface PaneTopologyEntry {
  paneId: string;
  paneIndex: number;
  paneCount: number;
  kind: PaneContent["kind"];
  agentKey: string | null;
  title: string;
  focused: boolean;
  status: Agent["status"] | null;
  harness: string | null;
  isShell: boolean;
}

export interface SpacePageTopology {
  tabId: string;
  pageNumber: number;
  pageTotal: number;
  tabName: string;
  active: boolean;
  isSplit: boolean;
  paneCount: number;
  panes: PaneTopologyEntry[];
  hasBlocked: boolean;
  hasWorking: boolean;
}

export interface SpaceTopology {
  spaceKey: string;
  deviceId: string;
  spaceName: string;
  color: string | undefined;
  pageCount: number;
  declaredTabCount: number;
  splitPageCount: number;
  paneCount: number;
  pages: SpacePageTopology[];
}

export interface AgentTopologyPlacement {
  agentKey: string;
  tabId: string | null;
  paneId: string | null;
  spaceKey: string | null;
  spaceName: string | null;
  spaceColor: string | undefined;
  pageNumber: number | null;
  pageTotal: number;
  paneIndex: number;
  paneCount: number;
  isSplit: boolean;
  isBackground: boolean;
  isActiveTab: boolean;
  isFocusedPane: boolean;
  siblingAgentKeys: string[];
}

export interface WorkspaceTopology {
  bySpace: Map<string, SpaceTopology>;
  byAgent: Map<string, AgentTopologyPlacement>;
  tabSpaceById: Map<string, string | null>;
}

export interface TopologyBadge {
  kind: "bg" | "split" | "page";
  label: string;
  slot?: string;
}

export type AgentRowJoinRole = "single" | "split-first" | "split-mid" | "split-last";

export interface CompactDeviceBadge {
  deviceId: string;
  label: string;
  fullLabel: string;
  isLocal: boolean;
}

export interface SidebarAgentDeviceHeader extends CompactDeviceBadge {
  count: number;
}

export interface SidebarAgentItem {
  agent: Agent;
  placement: AgentTopologyPlacement;
  joinRole: AgentRowJoinRole;
  deviceHeader?: SidebarAgentDeviceHeader;
}

export interface SidebarAgentSection {
  id: string;
  kind: SidebarAgentGrouping;
  title: string;
  groupKey: string;
  spaceKey?: string;
  spaceColor?: string;
  pageCount?: number;
  splitPageCount?: number;
  hasBlocked?: boolean;
  hasWorking?: boolean;
  items: SidebarAgentItem[];
}

const UNASSIGNED_SPACE_KEY = "__unassigned__";

function parseSpaceKey(spaceKey: string | null | undefined): { deviceId: string; spaceName: string } | null {
  if (!spaceKey) return null;
  const sep = spaceKey.indexOf("\u0000");
  if (sep < 0) return null;
  const deviceId = spaceKey.slice(0, sep);
  const spaceName = spaceKey.slice(sep + 1).trim();
  if (!deviceId || !spaceName) return null;
  return { deviceId, spaceName };
}

function stripSpacePrefix(raw: string, spaceName: string | undefined): string {
  const clean = raw.trim();
  const sp = spaceName?.trim();
  if (!sp) return clean;
  const prefix = `${sp} · `;
  if (clean.startsWith(prefix)) {
    const rest = clean.slice(prefix.length).trim();
    if (rest) return rest;
  }
  return clean;
}

function paneEntryTitle(
  content: PaneContent,
  lookupAgent: (agentKey: string) => TopologyAgentLike | undefined,
  spaceName: string | undefined,
): { title: string; agent: TopologyAgentLike | undefined } {
  if (content.kind === "agent") {
    const a = lookupAgent(content.agentKey);
    if (!a) return { title: "Agent", agent: undefined };
    const raw = agentTitle({
      name: a.name,
      title: a.title,
      localId: a.localId ?? content.agentKey,
      harness: a.harness ?? "agent",
    });
    return {
      title: stripSpacePrefix(raw, spaceName || agentSpace({ where: a.where })) || raw,
      agent: a,
    };
  }
  if (content.kind === "file") {
    const base = content.path.split(/[\\/]/).filter(Boolean).pop();
    return { title: content.title || base || "文件", agent: undefined };
  }
  if (content.kind === "diff") {
    const base = content.path.split(/[\\/]/).filter(Boolean).pop();
    return { title: content.title || base || "Diff", agent: undefined };
  }
  return { title: content.title || content.url || "浏览器", agent: undefined };
}

/**
 * Indexes all open tabs, split panes, spaces, and active agents into one workspace
 * topology graph so sidebar rows and space drawers share identical page numbers (`P1..PN`)
 * and split-window relationships.
 */
export function computeWorkspaceTopology(
  tabs: readonly ShellTab[],
  activeTabId: string | null,
  lookupAgent: (agentKey: string) => TopologyAgentLike | undefined,
  spacesMap: Record<string, readonly SpaceInfo[]>,
  agents: readonly TopologyAgentLike[] = [],
): WorkspaceTopology {
  const spaceInfoByKey = new Map<string, { deviceId: string; spaceName: string; info: SpaceInfo }>();
  for (const [hostId, list] of Object.entries(spacesMap)) {
    for (const sp of list ?? []) {
      const name = sp.name.trim();
      if (!name) continue;
      const key = `${hostId}\u0000${name}`;
      if (!spaceInfoByKey.has(key)) {
        spaceInfoByKey.set(key, { deviceId: hostId, spaceName: name, info: sp });
      }
    }
  }

  const bySpace = new Map<string, SpaceTopology>();
  const byAgent = new Map<string, AgentTopologyPlacement>();
  const tabSpaceById = new Map<string, string | null>();

  for (const [spaceKey, meta] of spaceInfoByKey.entries()) {
    bySpace.set(spaceKey, {
      spaceKey,
      deviceId: meta.deviceId,
      spaceName: meta.spaceName,
      color: meta.info.color,
      pageCount: 0,
      declaredTabCount: Math.max(0, meta.info.tabs ?? 0),
      splitPageCount: 0,
      paneCount: 0,
      pages: [],
    });
  }

  interface RawTabEntry {
    tab: ShellTab;
    spaceKey: string | null;
    spaceName: string | undefined;
    panes: PaneTopologyEntry[];
    agentLeaves: Array<{ agentKey: string; paneId: string; paneIndex: number }>;
    allAgentKeys: string[];
    hasBlocked: boolean;
    hasWorking: boolean;
    tabName: string;
  }

  const rawTabs: RawTabEntry[] = [];
  const tabsBySpace = new Map<string, RawTabEntry[]>();

  for (const tab of tabs) {
    const resolvedSpace = tabSpaceKey(tab, lookupAgent, spacesMap);
    const parsed = parseSpaceKey(resolvedSpace);
    const spaceKey = parsed ? resolvedSpace : null;
    const spaceName = parsed?.spaceName ?? (tab.docSpaceName?.trim() || undefined);
    tabSpaceById.set(tab.id, spaceKey);

    if (spaceKey && !bySpace.has(spaceKey) && parsed) {
      const info = spaceInfoByKey.get(spaceKey)?.info;
      bySpace.set(spaceKey, {
        spaceKey,
        deviceId: parsed.deviceId,
        spaceName: parsed.spaceName,
        color: info?.color,
        pageCount: 0,
        declaredTabCount: Math.max(0, info?.tabs ?? 0),
        splitPageCount: 0,
        paneCount: 0,
        pages: [],
      });
    }

    const leaves = tabLeaves(tab);
    const focusedLeaf = focusedLeafOfTab(tab);
    const panes: PaneTopologyEntry[] = [];
    const agentLeaves: Array<{ agentKey: string; paneId: string; paneIndex: number }> = [];
    const allAgentKeys: string[] = [];
    let hasBlocked = false;
    let hasWorking = false;

    leaves.forEach((leaf, idx) => {
      const paneIndex = idx + 1;
      const { title, agent } = paneEntryTitle(leaf.content, lookupAgent, spaceName);
      const agentKey = leaf.content.kind === "agent" ? leaf.content.agentKey : null;
      const status = agent?.status ?? null;
      if (status === "blocked") hasBlocked = true;
      else if (status === "working") hasWorking = true;
      panes.push({
        paneId: leaf.id,
        paneIndex,
        paneCount: leaves.length,
        kind: leaf.content.kind,
        agentKey,
        title,
        focused: leaf.id === focusedLeaf.id,
        status,
        harness: agent?.harness ?? null,
        isShell: Boolean(agent?.isShell),
      });
      if (agentKey) {
        agentLeaves.push({ agentKey, paneId: leaf.id, paneIndex });
        if (!allAgentKeys.includes(agentKey)) allAgentKeys.push(agentKey);
      }
    });

    const explicitName = tab.docTabName?.trim();
    const tabName =
      explicitName ||
      (panes.length > 1 ? `${panes[0]?.title ?? "分屏"} 等 ${panes.length} 屏` : panes[0]?.title || "标签页");

    const entry: RawTabEntry = {
      tab,
      spaceKey,
      spaceName,
      panes,
      agentLeaves,
      allAgentKeys,
      hasBlocked,
      hasWorking,
      tabName,
    };
    rawTabs.push(entry);
    if (spaceKey) {
      const bucket = tabsBySpace.get(spaceKey);
      if (bucket) bucket.push(entry);
      else tabsBySpace.set(spaceKey, [entry]);
    }
  }

  for (const [spaceKey, list] of tabsBySpace.entries()) {
    const sp = bySpace.get(spaceKey)!;
    const pageTotal = list.length;
    sp.pageCount = pageTotal;
    sp.pages = list.map((entry, idx) => {
      const isSplit = entry.panes.length > 1;
      if (isSplit) sp.splitPageCount += 1;
      sp.paneCount += entry.panes.length;
      return {
        tabId: entry.tab.id,
        pageNumber: idx + 1,
        pageTotal,
        tabName: entry.tabName,
        active: entry.tab.id === activeTabId,
        isSplit,
        paneCount: entry.panes.length,
        panes: entry.panes,
        hasBlocked: entry.hasBlocked,
        hasWorking: entry.hasWorking,
      };
    });
  }

  for (const entry of rawTabs) {
    const spaceTopo = entry.spaceKey ? bySpace.get(entry.spaceKey) : undefined;
    const pageInfo = spaceTopo?.pages.find((p) => p.tabId === entry.tab.id);
    const pageNumber = pageInfo?.pageNumber ?? null;
    const pageTotal = spaceTopo?.pageCount ?? 1;
    const spaceName = spaceTopo?.spaceName ?? entry.spaceName ?? null;
    const spaceColor = spaceTopo?.color;
    const isActiveTab = entry.tab.id === activeTabId;
    const focusedPaneId = entry.panes.find((p) => p.focused)?.paneId ?? entry.panes[0]?.paneId ?? null;

    for (const al of entry.agentLeaves) {
      const nextPlacement: AgentTopologyPlacement = {
        agentKey: al.agentKey,
        tabId: entry.tab.id,
        paneId: al.paneId,
        spaceKey: entry.spaceKey,
        spaceName,
        spaceColor,
        pageNumber,
        pageTotal,
        paneIndex: al.paneIndex,
        paneCount: entry.panes.length,
        isSplit: entry.panes.length > 1,
        isBackground: false,
        isActiveTab,
        isFocusedPane: isActiveTab && al.paneId === focusedPaneId,
        siblingAgentKeys: entry.allAgentKeys.filter((k) => k !== al.agentKey),
      };
      const existing = byAgent.get(al.agentKey);
      // Prefer active tab placement when the same agent is referenced twice.
      if (!existing || (nextPlacement.isActiveTab && !existing.isActiveTab)) {
        byAgent.set(al.agentKey, nextPlacement);
      }
    }
  }

  for (const a of agents) {
    if (!a.key || byAgent.has(a.key)) continue;
    byAgent.set(a.key, resolveBackgroundPlacement(a, a.key, bySpace, spacesMap));
  }

  return { bySpace, byAgent, tabSpaceById };
}

function resolveBackgroundPlacement(
  agent: TopologyAgentLike,
  agentKey: string,
  bySpace: ReadonlyMap<string, SpaceTopology>,
  spacesMap: Record<string, readonly SpaceInfo[]>,
): AgentTopologyPlacement {
  const explicitName = agentSpace({ where: agent.where })?.trim() || "";
  const resolvedKey = explicitName
    ? `${agent.deviceId}\u0000${explicitName}`
    : resolveAgentSpaceKey(agent, spacesMap);
  const parsed = parseSpaceKey(resolvedKey);
  const spaceKey = parsed ? resolvedKey : null;
  const spaceTopo = spaceKey ? bySpace.get(spaceKey) : undefined;
  return {
    agentKey,
    tabId: null,
    paneId: null,
    spaceKey,
    spaceName: spaceTopo?.spaceName ?? parsed?.spaceName ?? null,
    spaceColor: spaceTopo?.color,
    pageNumber: null,
    pageTotal: spaceTopo?.pageCount ?? 0,
    paneIndex: 1,
    paneCount: 1,
    isSplit: false,
    isBackground: true,
    isActiveTab: false,
    isFocusedPane: false,
    siblingAgentKeys: [],
  };
}

/** Returns the cached placement for an agent, synthesizing a background entry if unmounted. */
export function getAgentPlacement(
  agent: Agent,
  topology: WorkspaceTopology,
  spacesMap: Record<string, readonly SpaceInfo[]>,
): AgentTopologyPlacement {
  return (
    topology.byAgent.get(agent.key) ??
    resolveBackgroundPlacement(agent, agent.key, topology.bySpace, spacesMap)
  );
}

/** Formats concise human-readable computer chips (`本机` or short remote host name). */
export function formatCompactDeviceBadge(
  deviceId: string,
  devices: Record<string, Device>,
  localHostId?: string | null,
): CompactDeviceBadge {
  const rawName = devices[deviceId]?.name?.trim() || deviceId;
  if (localHostId && deviceId === localHostId) {
    return {
      deviceId,
      label: "本机",
      fullLabel: devices[deviceId]?.name?.trim() ? `本机 · ${rawName}` : "本机",
      isLocal: true,
    };
  }
  const short = rawName.replace(/^[A-Za-z0-9_.-]+\s*的\s*/, "").trim() || rawName;
  return {
    deviceId,
    label: short,
    fullLabel: rawName,
    isLocal: false,
  };
}

/** Formats concise user-facing page/split/background badges for an Agent row. */
export function formatTopologyBadge(p: AgentTopologyPlacement): TopologyBadge {
  if (p.isBackground) {
    return { kind: "bg", label: "后台" };
  }
  if (p.isSplit) {
    return {
      kind: "split",
      label: `${p.paneCount}分屏`,
      slot: `${p.paneIndex}/${p.paneCount}`,
    };
  }
  if (p.pageNumber !== null) {
    return {
      kind: "page",
      label: `第${p.pageNumber}页`,
    };
  }
  return { kind: "page", label: "独立页" };
}

function assignJoinRoles(
  rows: Array<{ agent: Agent; placement: AgentTopologyPlacement }>,
): SidebarAgentItem[] {
  return rows.map((row, idx) => {
    const tabId = row.placement.tabId;
    if (!tabId || !row.placement.isSplit) {
      return { ...row, joinRole: "single" };
    }
    const prevSame =
      idx > 0 && rows[idx - 1]!.placement.isSplit && rows[idx - 1]!.placement.tabId === tabId;
    const nextSame =
      idx + 1 < rows.length && rows[idx + 1]!.placement.isSplit && rows[idx + 1]!.placement.tabId === tabId;
    const joinRole: AgentRowJoinRole =
      prevSame && nextSame
        ? "split-mid"
        : !prevSame && nextSame
          ? "split-first"
          : prevSame && !nextSame
            ? "split-last"
            : "single";
    return { ...row, joinRole };
  });
}

function clusterRowsBySpaceAndSplit(
  rows: ReadonlyArray<{ agent: Agent; placement: AgentTopologyPlacement }>,
): Array<{ agent: Agent; placement: AgentTopologyPlacement }> {
  interface Cluster {
    key: string;
    unassigned: number;
    latest: number;
    rows: Array<{ agent: Agent; placement: AgentTopologyPlacement }>;
  }
  const byCluster = new Map<string, Cluster>();
  for (const row of rows) {
    const key = `${row.agent.deviceId}\u0000${row.placement.spaceKey ?? UNASSIGNED_SPACE_KEY}`;
    const existing = byCluster.get(key);
    const ch = lastChange(row.agent);
    if (existing) {
      existing.latest = Math.max(existing.latest, ch);
      existing.rows.push(row);
    } else {
      byCluster.set(key, {
        key,
        unassigned: row.placement.spaceKey ? 0 : 1,
        latest: ch,
        rows: [row],
      });
    }
  }
  const orderedClusters = [...byCluster.values()].sort(
    (a, b) => a.unassigned - b.unassigned || b.latest - a.latest || a.key.localeCompare(b.key),
  );
  const out: Array<{ agent: Agent; placement: AgentTopologyPlacement }> = [];
  for (const cl of orderedClusters) {
    cl.rows.sort((x, y) => {
      const px = x.placement;
      const py = y.placement;
      if (px.isBackground !== py.isBackground) return px.isBackground ? 1 : -1;
      if (!px.isBackground && !py.isBackground) {
        const pageDiff = (px.pageNumber ?? 9999) - (py.pageNumber ?? 9999);
        if (pageDiff !== 0) return pageDiff;
        if (px.tabId && py.tabId) {
          if (px.tabId === py.tabId) return px.paneIndex - py.paneIndex;
          return px.tabId.localeCompare(py.tabId);
        }
      }
      return lastChange(y.agent) - lastChange(x.agent) || x.agent.key.localeCompare(y.agent.key);
    });
    out.push(...cl.rows);
  }
  return out;
}

function attachContiguousDeviceHeaders(
  items: SidebarAgentItem[],
  devices: Record<string, Device>,
  localHostId?: string | null,
): SidebarAgentItem[] {
  let i = 0;
  while (i < items.length) {
    const devId = items[i]!.agent.deviceId;
    let j = i + 1;
    while (j < items.length && items[j]!.agent.deviceId === devId) j += 1;
    items[i] = {
      ...items[i]!,
      deviceHeader: {
        ...formatCompactDeviceBadge(devId, devices, localHostId),
        count: j - i,
      },
    };
    i = j;
  }
  return items;
}

/**
 * Builds sidebar Agent sections across all three view modes (`status`, `space`, `recent`),
 * supporting Scheme A (co-split clusters), Scheme B (machine subheaders), and Scheme C (split glyphs)
 * while preserving per-group stability during pointer hover.
 */
export function buildSidebarAgentSections(opts: {
  agents: readonly Agent[];
  devices: Record<string, Device>;
  topology: WorkspaceTopology;
  spacesMap: Record<string, readonly SpaceInfo[]>;
  selectedSpace: string | null;
  grouping: SidebarAgentGrouping;
  scheme?: SidebarStyleScheme;
  localHostId?: string | null;
  hoverFreeze?: boolean;
  previousOrder?: ReadonlyMap<string, string[]>;
}): SidebarAgentSection[] {
  const {
    agents,
    devices,
    topology,
    spacesMap,
    selectedSpace,
    grouping,
    scheme = "a",
    localHostId = null,
    hoverFreeze = false,
    previousOrder,
  } = opts;

  if (grouping === "recent") {
    const sorted = [...agents]
      .sort((x, y) => lastChange(y) - lastChange(x))
      .map((agent) => ({ agent, placement: getAgentPlacement(agent, topology, spacesMap) }));
    const items = assignJoinRoles(sorted);
    if (scheme === "b") {
      attachContiguousDeviceHeaders(items, devices, localHostId);
    }
    return [
      {
        id: "recent",
        kind: "recent",
        title: "最近",
        groupKey: "recent",
        items,
      },
    ];
  }

  if (grouping === "space") {
    interface SpaceBucket {
      key: string;
      title: string;
      spaceKey?: string;
      spaceColor?: string;
      pageCount: number;
      splitPageCount: number;
      bestRank: number;
      hasBlocked: boolean;
      hasWorking: boolean;
      latest: number;
      rows: Array<{ agent: Agent; placement: AgentTopologyPlacement }>;
    }
    const buckets = new Map<string, SpaceBucket>();
    for (const agent of agents) {
      const placement = getAgentPlacement(agent, topology, spacesMap);
      const bucketKey = placement.spaceKey ?? UNASSIGNED_SPACE_KEY;
      const spaceTopo = placement.spaceKey ? topology.bySpace.get(placement.spaceKey) : undefined;
      const g = listGroup(agent, devices);
      const rank = GROUP_RANK[g];
      const existing = buckets.get(bucketKey);
      if (existing) {
        existing.bestRank = Math.min(existing.bestRank, rank);
        if (g === "blocked") existing.hasBlocked = true;
        if (g === "working") existing.hasWorking = true;
        existing.latest = Math.max(existing.latest, lastChange(agent));
        existing.rows.push({ agent, placement });
      } else {
        buckets.set(bucketKey, {
          key: bucketKey,
          title: placement.spaceName || "未归属空间",
          ...(placement.spaceKey ? { spaceKey: placement.spaceKey } : {}),
          spaceColor: spaceTopo?.color ?? placement.spaceColor,
          pageCount: spaceTopo?.pageCount ?? 0,
          splitPageCount: spaceTopo?.splitPageCount ?? 0,
          bestRank: rank,
          hasBlocked: g === "blocked",
          hasWorking: g === "working",
          latest: lastChange(agent),
          rows: [{ agent, placement }],
        });
      }
    }

    const orderedBuckets = [...buckets.values()].sort((a, b) => {
      const aUnassigned = a.key === UNASSIGNED_SPACE_KEY ? 1 : 0;
      const bUnassigned = b.key === UNASSIGNED_SPACE_KEY ? 1 : 0;
      if (aUnassigned !== bUnassigned) return aUnassigned - bUnassigned;
      if (a.hasBlocked !== b.hasBlocked) return a.hasBlocked ? -1 : 1;
      if (a.hasWorking !== b.hasWorking) return a.hasWorking ? -1 : 1;
      const aSel = selectedSpace && a.key === selectedSpace ? 0 : 1;
      const bSel = selectedSpace && b.key === selectedSpace ? 0 : 1;
      if (aSel !== bSel) return aSel - bSel;
      if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
      return b.pageCount - a.pageCount || b.latest - a.latest || a.title.localeCompare(b.title);
    });

    return orderedBuckets.map((bucket) => {
      const sortedRows = [...bucket.rows].sort((x, y) => {
        const px = x.placement;
        const py = y.placement;
        if (px.isBackground !== py.isBackground) return px.isBackground ? 1 : -1;
        if (!px.isBackground && !py.isBackground) {
          const pageDiff = (px.pageNumber ?? 9999) - (py.pageNumber ?? 9999);
          if (pageDiff !== 0) return pageDiff;
          if (px.tabId === py.tabId) {
            return px.paneIndex - py.paneIndex;
          }
        }
        return GROUP_RANK[listGroup(x.agent, devices)] - GROUP_RANK[listGroup(y.agent, devices)] || lastChange(y.agent) - lastChange(x.agent);
      });
      return {
        id: `space:${bucket.key}`,
        kind: "space",
        title: bucket.title,
        groupKey: `space:${bucket.key}`,
        ...(bucket.spaceKey ? { spaceKey: bucket.spaceKey } : {}),
        ...(bucket.spaceColor ? { spaceColor: bucket.spaceColor } : {}),
        pageCount: bucket.pageCount,
        splitPageCount: bucket.splitPageCount,
        hasBlocked: bucket.hasBlocked,
        hasWorking: bucket.hasWorking,
        items: assignJoinRoles(sortedRows),
      };
    });
  }

  const by = new Map<ListGroup, Agent[]>();
  for (const a of agents) {
    const g = listGroup(a, devices);
    const list = by.get(g);
    if (list) list.push(a);
    else by.set(g, [a]);
  }

  return LIST_GROUPS.filter((g) => by.get(g.key)?.length).map((g) => {
    const list = [...by.get(g.key)!];
    const prevOrder = hoverFreeze ? previousOrder?.get(g.key) : undefined;
    if (prevOrder?.length) {
      const rank = new Map<string, number>();
      prevOrder.forEach((k, idx) => rank.set(k, idx));
      const newlyEntered: Agent[] = [];
      const existing: Agent[] = [];
      for (const item of list) {
        if (rank.has(item.key)) existing.push(item);
        else newlyEntered.push(item);
      }
      newlyEntered.sort((x, y) => lastChange(y) - lastChange(x));
      existing.sort((x, y) => rank.get(x.key)! - rank.get(y.key)!);
      const orderedAgents = [...newlyEntered, ...existing];
      const rows = orderedAgents.map((agent) => ({
        agent,
        placement: getAgentPlacement(agent, topology, spacesMap),
      }));
      const items = assignJoinRoles(rows);
      if (scheme === "b") {
        attachContiguousDeviceHeaders(items, devices, localHostId);
      }
      return {
        id: g.key,
        kind: "status",
        title: g.title,
        groupKey: g.key,
        items,
      };
    }

    const rawRows = list.map((agent) => ({
      agent,
      placement: getAgentPlacement(agent, topology, spacesMap),
    }));

    if (scheme === "b") {
      const byDevice = new Map<string, { rows: Array<{ agent: Agent; placement: AgentTopologyPlacement }>; latest: number }>();
      for (const r of rawRows) {
        const dId = r.agent.deviceId;
        const cur = byDevice.get(dId);
        const ch = lastChange(r.agent);
        if (cur) {
          cur.latest = Math.max(cur.latest, ch);
          cur.rows.push(r);
        } else {
          byDevice.set(dId, { rows: [r], latest: ch });
        }
      }
      const orderedDevs = [...byDevice.entries()].sort(([aId, aInfo], [bId, bInfo]) => {
        const aLoc = localHostId && aId === localHostId ? 1 : 0;
        const bLoc = localHostId && bId === localHostId ? 1 : 0;
        if (aLoc !== bLoc) return bLoc - aLoc;
        const aOn = devices[aId]?.online ? 1 : 0;
        const bOn = devices[bId]?.online ? 1 : 0;
        if (aOn !== bOn) return bOn - aOn;
        return bInfo.latest - aInfo.latest || aId.localeCompare(bId);
      });
      const items: SidebarAgentItem[] = [];
      for (const [devId, info] of orderedDevs) {
        const clustered = clusterRowsBySpaceAndSplit(info.rows);
        const devItems = assignJoinRoles(clustered);
        if (devItems.length > 0) {
          devItems[0] = {
            ...devItems[0]!,
            deviceHeader: {
              ...formatCompactDeviceBadge(devId, devices, localHostId),
              count: devItems.length,
            },
          };
          items.push(...devItems);
        }
      }
      return {
        id: g.key,
        kind: "status",
        title: g.title,
        groupKey: g.key,
        items,
      };
    }

    const clustered = clusterRowsBySpaceAndSplit(rawRows);
    return {
      id: g.key,
      kind: "status",
      title: g.title,
      groupKey: g.key,
      items: assignJoinRoles(clustered),
    };
  });
}
