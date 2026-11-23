import type {
  HerdrDoc,
  HerdrDocNode,
  HerdrDocSpace,
  HerdrDocTab,
  SpaceInfo,
} from "@herdr-pocket/protocol";
import { listLeaves, normalizeSplitNode, type PaneContent, type SplitNode } from "./splitTree";
import type { AgentPaneMode, AgentSpaceRef, ShellTab } from "./shellStore";

function shellTabRootNode(tab: ShellTab): SplitNode {
  if (tab.split) return tab.split.root;
  if (tab.kind === "agent") {
    return {
      type: "leaf",
      id: tab.primaryPaneId ?? `p0:${tab.id}`,
      weight: 1,
      content: { kind: "agent", agentKey: tab.agentKey, ...(tab.mode ? { mode: tab.mode } : {}) },
    };
  }
  if (tab.kind === "file") {
    return {
      type: "leaf",
      id: tab.primaryPaneId ?? `p0:${tab.id}`,
      weight: 1,
      content: { kind: "file", agentKey: tab.agentKey, path: tab.path, title: tab.title },
    };
  }
  if (tab.kind === "diff") {
    return {
      type: "leaf",
      id: tab.primaryPaneId ?? `p0:${tab.id}`,
      weight: 1,
      content: {
        kind: "diff",
        deviceId: tab.deviceId,
        ...(tab.agentKey ? { agentKey: tab.agentKey } : {}),
        cwd: tab.cwd,
        path: tab.path,
        staged: tab.staged,
        title: tab.title,
      },
    };
  }
  return {
    type: "leaf",
    id: tab.primaryPaneId ?? `p0:${tab.id}`,
    weight: 1,
    content: { kind: "web", webId: tab.webId ?? tab.id, url: tab.url, title: tab.title },
  };
}

const TB_AUTO_NAME_RE = /^tb\d+$/;

/** Returns the `hc` terminal ID when `agentKey` belongs to `${hostId}/hc:<tid>`, else null. */
export function extractHcTerminalId(hostId: string, agentKey: string): string | null {
  const prefix = `${hostId}/hc:`;
  if (!agentKey.startsWith(prefix)) return null;
  const tid = agentKey.slice(prefix.length).trim();
  return tid || null;
}

/** Formats a `herdr-app` terminal agent key from a host ID and `hc` terminal ID. */
export function makeHcAgentKey(hostId: string, terminalId: string): string {
  return `${hostId}/hc:${terminalId}`;
}

/** Canonical shellStore tab ID for a synced `herdr-app` document tab. */
export function syncedHerdrTabId(hostId: string, spaceId: string, docTabId: string): string {
  return `ht:${hostId}:${spaceId}:${docTabId}`;
}

/** Generates a collision-free Herdr-style node/tab/space ID (`p1`, `s2`, `tb3`). */
export function freshHerdrId(prefix: string, used: Set<string>): string {
  let n = 1;
  while (used.has(`${prefix}${n}`)) n += 1;
  const id = `${prefix}${n}`;
  used.add(id);
  return id;
}

/**
 * Computes the display label of a tab matching `herdr-app/defaults/mods/tabs/main.js`:
 * custom name wins; legacy `tb<N>` names fall back to `primaryProgram` (or 1-based number);
 * empty names fall back to 1-based number; zoomed tabs append `" Z"`.
 */
export interface HerdrTabLeadInfo {
  programName?: string | null;
  liveTitle?: string | null;
  index?: number;
}

const GENERIC_SHELL_TITLES = new Set(["sh", "bash", "zsh", "fish", "pwsh", "cmd", "nu", "elvish", "ksh", "tcsh"]);
const LIVE_TITLE_PREFIX_RE = /^[\u2800-\u28ff\u25cb\u25cf\u2733\u23f3\u2022\s]+/;
const RAW_TERMINAL_ID_RE = /^(?:tb[0-9a-f]+|ttys?\d+|pts\/?\d+|t\d+[0-9a-z]{0,5})$/i;

export function isPathLikeTitle(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s === "~" || s.startsWith("~/") || s.startsWith("./") || s.startsWith("../") || s.startsWith("/")) {
    return true;
  }
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("\\\\")) return true;
  if (s.includes("://")) return true;
  return !/\s/.test(s) && s.includes("/");
}

export function cleanLiveTabTitle(raw: string | null | undefined, programName?: string | null): string {
  if (!raw) return "";
  const cleaned = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(LIVE_TITLE_PREFIX_RE, "")
    .trim();
  if (!cleaned) return "";
  if (cleaned.includes("@") || /^\d+$/.test(cleaned) || RAW_TERMINAL_ID_RE.test(cleaned)) {
    return "";
  }
  if (isPathLikeTitle(cleaned)) return "";
  const lower = cleaned.toLowerCase();
  if (GENERIC_SHELL_TITLES.has(lower)) return "";
  const prog = programName?.trim() ?? "";
  if (prog && (lower === prog.toLowerCase() || (lower === "claude" && prog === "Claude Code"))) {
    return prog;
  }
  return cleaned;
}

export function formatHerdrTabLabel(
  tab: { name?: string },
  leadOrIndex: HerdrTabLeadInfo | number = 0,
  isZoomedOrProgram?: boolean | string,
  legacyZoomed = false,
): string {
  const isLegacy = typeof leadOrIndex === "number";
  const programName = isLegacy
    ? (typeof isZoomedOrProgram === "string" ? isZoomedOrProgram : undefined)
    : leadOrIndex.programName ?? undefined;
  const liveTitle = isLegacy ? undefined : leadOrIndex.liveTitle ?? undefined;
  const isZoomed = isLegacy ? legacyZoomed : Boolean(isZoomedOrProgram);

  const raw = tab.name?.trim() ?? "";
  let base: string;
  if (raw && !TB_AUTO_NAME_RE.test(raw)) {
    base = raw;
  } else {
    const prog = programName?.trim() || "";
    const live = cleanLiveTabTitle(liveTitle, prog);
    base = live || prog || "Terminal";
  }
  return isZoomed ? `${base} Z` : base;
}

function collectModesFromSplit(
  root: SplitNode | undefined,
): { byLeafId: Map<string, AgentPaneMode>; byAgentKey: Map<string, AgentPaneMode> } {
  const byLeafId = new Map<string, AgentPaneMode>();
  const byAgentKey = new Map<string, AgentPaneMode>();
  if (!root) return { byLeafId, byAgentKey };
  for (const leaf of listLeaves(root)) {
    if (leaf.content.kind === "agent" && leaf.content.mode) {
      byLeafId.set(leaf.id, leaf.content.mode);
      if (!byAgentKey.has(leaf.content.agentKey)) {
        byAgentKey.set(leaf.content.agentKey, leaf.content.mode);
      }
    }
  }
  return { byLeafId, byAgentKey };
}

function nodeWeight(size: HerdrDocNode["size"]): number {
  if (size && "weight" in size && typeof size.weight === "number" && Number.isFinite(size.weight) && size.weight > 0) {
    return size.weight;
  }
  return 1;
}

/** Converts a `herdr-app` layout node tree for `hostId` into a normalized Pocket `SplitNode`. */
export function herdrRootToSplitNode(
  hostId: string,
  root: HerdrDocNode | undefined | null,
  prevRoot?: SplitNode,
): SplitNode | null {
  if (!root || typeof root !== "object") return null;
  const { byLeafId, byAgentKey } = collectModesFromSplit(prevRoot);
  const usedIds = new Set<string>();

  const convert = (node: HerdrDocNode): SplitNode | null => {
    if (!node || typeof node !== "object") return null;
    const w = nodeWeight(node.size);
    if (node.type === "block") {
      const content = node.content as { terminal?: unknown } | undefined;
      const terminal = typeof content?.terminal === "string" ? content.terminal.trim() : "";
      if (!terminal) return null;
      const agentKey = makeHcAgentKey(hostId, terminal);
      let id = typeof node.id === "string" && node.id ? node.id : "";
      if (!id || usedIds.has(id)) id = freshHerdrId("p", usedIds);
      else usedIds.add(id);
      const mode: AgentPaneMode = byLeafId.get(id) ?? byAgentKey.get(agentKey) ?? "term";
      return {
        type: "leaf",
        id,
        weight: w,
        content: { kind: "agent", agentKey, mode },
      };
    }

    if (node.type === "row" || node.type === "column") {
      const children: SplitNode[] = [];
      for (const ch of node.children ?? []) {
        const mapped = convert(ch);
        if (mapped) children.push(mapped);
      }
      if (children.length === 0) return null;
      if (children.length === 1) {
        return { ...children[0]!, weight: w };
      }
      let id = typeof node.id === "string" && node.id ? node.id : "";
      if (!id || usedIds.has(id)) id = freshHerdrId("s", usedIds);
      else usedIds.add(id);
      return {
        type: "split",
        id,
        axis: node.type,
        weight: w,
        children,
      };
    }

    if (node.type === "stack") {
      const kids = node.children ?? [];
      const active = (node.active ? kids.find((k) => k.id === node.active) : undefined) ?? kids[0];
      return active ? convert(active) : null;
    }

    return null;
  };

  const converted = convert(root);
  return converted ? normalizeSplitNode(converted) : null;
}

function indexDocNodes(root: HerdrDocNode | undefined | null): Map<string, HerdrDocNode> {
  const map = new Map<string, HerdrDocNode>();
  if (!root || typeof root !== "object") return map;
  const walk = (n: HerdrDocNode) => {
    if (n.id) map.set(n.id, n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return map;
}

function collectDocNodeIds(root: HerdrDocNode | undefined | null, out: Set<string>): void {
  if (!root || typeof root !== "object") return;
  if (root.id) out.add(root.id);
  for (const c of root.children ?? []) collectDocNodeIds(c, out);
}

function extraNodeFields(prev: HerdrDocNode | undefined): Record<string, unknown> {
  if (!prev) return {};
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(prev)) {
    if (
      k === "id" ||
      k === "type" ||
      k === "size" ||
      k === "content" ||
      k === "children" ||
      k === "active"
    ) {
      continue;
    }
    extra[k] = v;
  }
  return extra;
}

function isModBlock(node: HerdrDocNode): boolean {
  if (node.type !== "block" || !node.content || typeof node.content !== "object") return false;
  return "mod" in node.content && !("terminal" in node.content);
}

function formatWeightSize(weight: number, prevSize?: HerdrDocNode["size"]): HerdrDocNode["size"] | undefined {
  if (Math.abs(weight - 1) < 1e-4) {
    if (prevSize && "weight" in prevSize && Math.abs(prevSize.weight - 1) < 1e-4) {
      return prevSize;
    }
    return undefined;
  }
  return { weight: Number(weight.toFixed(6)) };
}

function serializePaneId(rawId: string, used: Set<string>, prefix: "p" | "s"): string {
  // Replace Pocket's synthetic `p0:...` placeholder with a clean Herdr id, keeping real node IDs stable.
  if (rawId && !rawId.startsWith("p0:") && !used.has(rawId)) {
    used.add(rawId);
    return rawId;
  }
  return freshHerdrId(prefix, used);
}

/**
 * Serializes a Pocket `SplitNode` into a `herdr-app` `HerdrDocNode`.
 * Preserves unknown node fields and sibling `mod` blocks from `prevDocRoot`, and
 * omits Pocket-only leaves (`file` / `diff` / `web` / `uniflo`). Returns `null` if
 * no `hc` terminal leaf belongs to `hostId`.
 */
export function splitNodeToHerdrRoot(
  hostId: string,
  node: SplitNode,
  prevDocRoot?: HerdrDocNode | null,
): HerdrDocNode | null {
  const prevById = indexDocNodes(prevDocRoot);
  const usedIds = new Set<string>();
  const seenTerminals = new Set<string>();

  const serialize = (cur: SplitNode): HerdrDocNode | null => {
    if (cur.type === "leaf") {
      if (cur.content.kind !== "agent") return null;
      const terminal = extractHcTerminalId(hostId, cur.content.agentKey);
      if (!terminal || seenTerminals.has(terminal)) return null;
      seenTerminals.add(terminal);
      const prev = prevById.get(cur.id);
      const id = serializePaneId(cur.id, usedIds, "p");
      const size = formatWeightSize(cur.weight, prev?.size);
      const prevContent =
        prev?.type === "block" && prev.content && typeof prev.content === "object" ? prev.content : {};
      return {
        ...extraNodeFields(prev),
        id,
        type: "block",
        ...(size ? { size } : {}),
        content: { ...prevContent, terminal },
      };
    }

    const prev = prevById.get(cur.id);
    const children: HerdrDocNode[] = [];
    for (const child of cur.children) {
      const next = serialize(child);
      if (next) children.push(next);
    }

    // Preserve any embedded Mod blocks owned by Herdr.app in the same container.
    if (prev?.children?.length) {
      for (let i = 0; i < prev.children.length; i++) {
        const modChild = prev.children[i]!;
        if (!isModBlock(modChild)) continue;
        const modId = serializePaneId(modChild.id, usedIds, "p");
        const insertAt = Math.min(children.length, i);
        children.splice(insertAt, 0, { ...modChild, id: modId });
      }
    }

    if (children.length === 0) return null;
    if (children.length === 1 && !prev?.children?.some(isModBlock)) {
      const sole = children[0]!;
      const size = formatWeightSize(cur.weight, prev?.size);
      return size ? { ...sole, size } : { ...sole };
    }

    const id = serializePaneId(cur.id, usedIds, "s");
    const size = formatWeightSize(cur.weight, prev?.size);
    return {
      ...extraNodeFields(prev),
      id,
      type: cur.axis,
      ...(size ? { size } : {}),
      children,
    };
  };

  return serialize(node);
}

function agentSpaceName(where?: string): string {
  const raw = (where ?? "").trim();
  if (!raw) return "";
  const slash = raw.indexOf(" / ");
  return (slash >= 0 ? raw.slice(0, slash) : raw).trim();
}

function pickDocTabId(tab: ShellTab, usedTabIds: Set<string>): string {
  if (tab.docTabId && !usedTabIds.has(tab.docTabId)) {
    usedTabIds.add(tab.docTabId);
    return tab.docTabId;
  }
  return freshHerdrId("tb", usedTabIds);
}

export interface HostSpaceMeta {
  id: string;
  name: string;
  folder?: string;
}

/**
 * Builds an updated `HerdrDoc` for `hostId` from current `shellStore.tabs`,
 * preserving untouched spaces/tabs' extra metadata and unknown fields from `baseDoc`.
 */
export function extractHostHerdrDoc(
  hostId: string,
  tabs: readonly ShellTab[],
  baseDoc: HerdrDoc | null | undefined,
  hostSpaces: readonly SpaceInfo[] | readonly HostSpaceMeta[],
  lookupAgent: (agentKey: string) => (AgentSpaceRef & { cwd?: string }) | undefined,
): HerdrDoc {
  const spaces: HerdrDocSpace[] = [];
  const usedSpaceIds = new Set<string>();
  const usedTabIds = new Set<string>();

  const findOrCreateSpace = (spaceIdHint: string | undefined, spaceNameHint: string, folderHint: string): HerdrDocSpace => {
    const knownMeta =
      (spaceIdHint ? hostSpaces.find((s) => s.id === spaceIdHint) : undefined) ??
      (spaceNameHint ? hostSpaces.find((s) => s.name === spaceNameHint) : undefined);
    const effectiveId = spaceIdHint || knownMeta?.id;
    if (effectiveId) {
      const byId = spaces.find((s) => s.id === effectiveId);
      if (byId) return byId;
    }
    if (spaceNameHint) {
      const byName = spaces.find((s) => s.name === spaceNameHint);
      if (byName) return byName;
    }
    const id =
      effectiveId && !usedSpaceIds.has(effectiveId)
        ? (usedSpaceIds.add(effectiveId), effectiveId)
        : freshHerdrId("sp", usedSpaceIds);
    const name = spaceNameHint || knownMeta?.name || folderHint.split(/[\\/]/).filter(Boolean).pop() || "workspace";
    const folder = knownMeta?.folder || folderHint || "";
    const created: HerdrDocSpace = { id, name, folder, tabs: [] };
    spaces.push(created);
    return created;
  };

  // Seed spaces from baseDoc first to keep their exact order, IDs, folders, and extra metadata.
  const prevTabMap = new Map<string, HerdrDocTab>();
  for (const rawSp of baseDoc?.spaces ?? []) {
    if (!rawSp || typeof rawSp !== "object") continue;
    const id = rawSp.id && !usedSpaceIds.has(rawSp.id) ? (usedSpaceIds.add(rawSp.id), rawSp.id) : freshHerdrId("sp", usedSpaceIds);
    for (const rt of rawSp.tabs ?? []) {
      if (rt?.id) prevTabMap.set(`${id}\u0000${rt.id}`, rt);
    }
    const { tabs: _dropTabs, ...restSpace } = rawSp;
    spaces.push({
      ...restSpace,
      id,
      name: rawSp.name ?? "",
      folder: rawSp.folder ?? "",
      tabs: [],
    });
  }

  // Also ensure active hostSpaces exist if no baseDoc space exists yet for a newly opened tab.
  const hostDefaultFolder = hostSpaces[0]?.folder ?? "";

  for (const tab of tabs) {
    const rootNode = shellTabRootNode(tab);
    const leaves = listLeaves(rootNode);
    const hostLeaf = leaves.find((l) => l.content.kind === "agent" && extractHcTerminalId(hostId, l.content.agentKey) !== null);
    if (!hostLeaf || hostLeaf.content.kind !== "agent") continue;

    // Only own-host synced tabs OR un-synced hc tabs belonging to this host are serialized into this host's doc.
    if (tab.docHostId && tab.docHostId !== hostId) continue;

    const agent = lookupAgent(hostLeaf.content.agentKey);
    const inferredSpaceName = tab.docSpaceName || agentSpaceName(agent?.where) || hostSpaces[0]?.name || "";
    const targetSpace = findOrCreateSpace(tab.docSpaceId, inferredSpaceName, agent?.cwd || hostDefaultFolder);

    const prevTab = tab.docTabId ? prevTabMap.get(`${targetSpace.id}\u0000${tab.docTabId}`) : undefined;
    const serializedRoot = splitNodeToHerdrRoot(hostId, rootNode, prevTab?.root);
    if (!serializedRoot) continue;

    const docTabId = pickDocTabId(tab, usedTabIds);
    const rawName = tab.docTabName !== undefined ? tab.docTabName : (prevTab?.name ?? "");
    const nextTab: HerdrDocTab = {
      ...(prevTab ?? {}),
      id: docTabId,
      name: rawName,
      root: serializedRoot,
    };
    const usedInTab = new Set<string>();
    collectDocNodeIds(nextTab.root, usedInTab);
    targetSpace.tabs.push(nextTab);
  }

  const baseRest: Record<string, unknown> = {};
  if (baseDoc) {
    for (const [k, v] of Object.entries(baseDoc)) {
      if (k !== "spaces") baseRest[k] = v;
    }
  }
  return { ...baseRest, spaces };
}
