export type SplitDirection = "left" | "right" | "up" | "down";
export type SplitAxis = "row" | "column";

export type PaneContent =
  | { kind: "agent"; agentKey: string; mode?: "chat" | "term" }
  | {
      kind: "file";
      agentKey: string;
      path: string;
      title: string;
      absPath?: string;
      line?: number;
      endLine?: number;
      spaceKey?: string | null;
    }
  | { kind: "web"; webId: string; url: string; title: string; spaceKey?: string | null }
  | {
      kind: "diff";
      deviceId: string;
      agentKey?: string;
      cwd: string;
      path: string;
      staged: boolean;
      commit?: string;
      title: string;
      spaceKey?: string | null;
    };

export interface SplitLeafNode {
  type: "leaf";
  id: string;
  weight: number;
  content: PaneContent;
}

export interface SplitBranchNode {
  type: "split";
  id: string;
  axis: SplitAxis;
  weight: number;
  children: SplitNode[];
}

export type SplitNode = SplitLeafNode | SplitBranchNode;

export interface TabSplitState {
  root: SplitNode;
  focusedPaneId: string;
  zoomedPaneId?: string | null;
}

export interface UnitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CssRect {
  left: string;
  top: string;
  width: string;
  height: string;
}

export interface SplitLeafLayout {
  leaf: SplitLeafNode;
  visible: boolean;
  unit: UnitRect;
  css: CssRect;
}

export interface SplitSashLayout {
  id: string;
  branchId: string;
  index: number;
  axis: SplitAxis;
  /** Fraction [0..1] of the split stage spanned along the drag axis by the parent branch. */
  branchSpanScale: number;
  css: CssRect;
}

export interface SplitLayoutResult {
  leaves: SplitLeafLayout[];
  sashes: SplitSashLayout[];
}

export const SPLIT_GAP_PX = 8;

const WEIGHT_MIN = 0.08;
const WEIGHT_MAX = 20;
const EPS = 1e-4;

let idSeq = 0;

export function makeSplitId(prefix: "p" | "s" = "p"): string {
  idSeq = (idSeq + 1) % 1_000_000;
  return `${prefix}:${Date.now().toString(36)}-${idSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function directionToAxis(direction: SplitDirection): SplitAxis {
  return direction === "left" || direction === "right" ? "row" : "column";
}

function clampWeight(weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) return 1;
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, weight));
}

function sumWeights(nodes: readonly SplitNode[]): number {
  let total = 0;
  for (const n of nodes) total += clampWeight(n.weight);
  return total > 0 ? total : nodes.length || 1;
}

function scaleWeight(node: SplitNode, factor: number): SplitNode {
  return { ...node, weight: clampWeight(clampWeight(node.weight) * factor) };
}

function normalizeRecursive(node: SplitNode): SplitNode | null {
  if (node.type === "leaf") {
    return { ...node, weight: clampWeight(node.weight) };
  }
  const normalizedChildren: SplitNode[] = [];
  for (const child of node.children) {
    const next = normalizeRecursive(child);
    if (!next) continue;
    if (next.type === "split" && next.axis === node.axis) {
      const subSum = sumWeights(next.children);
      const branchW = clampWeight(next.weight);
      for (const grandChild of next.children) {
        normalizedChildren.push(scaleWeight(grandChild, branchW / subSum));
      }
    } else {
      normalizedChildren.push(next);
    }
  }
  if (normalizedChildren.length === 0) return null;
  if (normalizedChildren.length === 1) {
    return { ...normalizedChildren[0]!, weight: clampWeight(node.weight) };
  }
  return {
    type: "split",
    id: node.id || makeSplitId("s"),
    axis: node.axis,
    weight: clampWeight(node.weight),
    children: normalizedChildren,
  };
}

function dedupeIds(node: SplitNode, seenLeaves: Set<string>, seenSplits: Set<string>): SplitNode {
  if (node.type === "leaf") {
    let id = typeof node.id === "string" && node.id ? node.id : makeSplitId("p");
    while (seenLeaves.has(id)) id = makeSplitId("p");
    seenLeaves.add(id);
    return id === node.id ? node : { ...node, id };
  }
  let id = typeof node.id === "string" && node.id ? node.id : makeSplitId("s");
  while (seenSplits.has(id)) id = makeSplitId("s");
  seenSplits.add(id);
  const children = node.children.map((c) => dedupeIds(c, seenLeaves, seenSplits));
  return { ...node, id, children };
}

export function normalizeSplitNode(node: SplitNode): SplitNode {
  const collapsed = normalizeRecursive(node) ?? node;
  return dedupeIds(collapsed, new Set<string>(), new Set<string>());
}

export function listLeaves(node: SplitNode): SplitLeafNode[] {
  if (node.type === "leaf") return [node];
  const out: SplitLeafNode[] = [];
  for (const child of node.children) {
    for (const leaf of listLeaves(child)) out.push(leaf);
  }
  return out;
}

export function findLeaf(node: SplitNode, paneId: string): SplitLeafNode | undefined {
  if (node.type === "leaf") return node.id === paneId ? node : undefined;
  for (const child of node.children) {
    const hit = findLeaf(child, paneId);
    if (hit) return hit;
  }
  return undefined;
}

export function updateLeafContent(node: SplitNode, paneId: string, fn: (c: PaneContent) => PaneContent): SplitNode {
  if (node.type === "leaf") {
    return node.id === paneId ? { ...node, content: fn(node.content) } : node;
  }
  let changed = false;
  const children = node.children.map((child) => {
    const next = updateLeafContent(child, paneId, fn);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

function insertIntoTree(
  node: SplitNode,
  targetPaneId: string,
  direction: SplitDirection,
  newLeaf: SplitLeafNode,
): { node: SplitNode; inserted: boolean } {
  const axis = directionToAxis(direction);
  const before = direction === "left" || direction === "up";
  if (node.type === "leaf") {
    if (node.id !== targetPaneId) return { node, inserted: false };
    const halfWeight = clampWeight(node.weight) / 2;
    const oldHalf: SplitLeafNode = { ...node, weight: halfWeight };
    const insertedLeaf: SplitLeafNode = { ...newLeaf, weight: halfWeight };
    const branch: SplitBranchNode = {
      type: "split",
      id: makeSplitId("s"),
      axis,
      weight: clampWeight(node.weight),
      children: before ? [insertedLeaf, oldHalf] : [oldHalf, insertedLeaf],
    };
    return { node: branch, inserted: true };
  }

  let inserted = false;
  const nextChildren: SplitNode[] = [];
  for (const child of node.children) {
    if (inserted) {
      nextChildren.push(child);
      continue;
    }
    if (child.type === "leaf" && child.id === targetPaneId && node.axis === axis) {
      const halfWeight = clampWeight(child.weight) / 2;
      const oldHalf: SplitLeafNode = { ...child, weight: halfWeight };
      const insertedLeaf: SplitLeafNode = { ...newLeaf, weight: halfWeight };
      if (before) nextChildren.push(insertedLeaf, oldHalf);
      else nextChildren.push(oldHalf, insertedLeaf);
      inserted = true;
    } else {
      const res = insertIntoTree(child, targetPaneId, direction, newLeaf);
      nextChildren.push(res.node);
      if (res.inserted) inserted = true;
    }
  }
  if (!inserted) return { node, inserted: false };
  return { node: { ...node, children: nextChildren }, inserted: true };
}

export function insertSplitLeaf(
  root: SplitNode,
  targetPaneId: string,
  direction: SplitDirection,
  newLeaf: SplitLeafNode,
): SplitNode {
  const res = insertIntoTree(root, targetPaneId, direction, newLeaf);
  if (!res.inserted) {
    const leaves = listLeaves(root);
    const fallbackTarget = leaves[0]?.id;
    if (!fallbackTarget) return newLeaf;
    const retry = insertIntoTree(root, fallbackTarget, direction, newLeaf);
    return normalizeSplitNode(retry.node);
  }
  return normalizeSplitNode(res.node);
}

function removeFromTree(node: SplitNode, paneId: string): { node: SplitNode | null; removed: boolean } {
  if (node.type === "leaf") {
    return node.id === paneId ? { node: null, removed: true } : { node, removed: false };
  }
  let removed = false;
  const kept: SplitNode[] = [];
  for (const child of node.children) {
    if (removed) {
      kept.push(child);
      continue;
    }
    const res = removeFromTree(child, paneId);
    if (res.removed) removed = true;
    if (res.node) kept.push(res.node);
  }
  if (!removed) return { node, removed: false };
  if (kept.length === 0) return { node: null, removed: true };
  if (kept.length === 1) {
    return { node: { ...kept[0]!, weight: clampWeight(node.weight) }, removed: true };
  }
  const origSum = sumWeights(node.children);
  const keptSum = sumWeights(kept);
  const factor = keptSum > 0 ? origSum / keptSum : 1;
  return {
    node: {
      ...node,
      children: kept.map((c) => scaleWeight(c, factor)),
    },
    removed: true,
  };
}

export function removeSplitLeaf(root: SplitNode, paneId: string): SplitNode | null {
  const res = removeFromTree(root, paneId);
  if (!res.node) return null;
  return normalizeSplitNode(res.node);
}

export function moveSplitLeaf(
  root: SplitNode,
  fromPaneId: string,
  targetPaneId: string,
  direction: SplitDirection,
): SplitNode {
  if (fromPaneId === targetPaneId) return root;
  const moving = findLeaf(root, fromPaneId);
  if (!moving || !findLeaf(root, targetPaneId)) return root;
  const stripped = removeSplitLeaf(root, fromPaneId);
  if (!stripped) return root;
  return insertSplitLeaf(stripped, targetPaneId, direction, { ...moving });
}

export function swapSplitLeaves(root: SplitNode, paneAId: string, paneBId: string): SplitNode {
  if (paneAId === paneBId) return root;
  const leafA = findLeaf(root, paneAId);
  const leafB = findLeaf(root, paneBId);
  if (!leafA || !leafB) return root;

  const swapNode = (node: SplitNode): SplitNode => {
    if (node.type === "leaf") {
      if (node.id === paneAId) return { ...node, id: leafB.id, content: leafB.content };
      if (node.id === paneBId) return { ...node, id: leafA.id, content: leafA.content };
      return node;
    }
    return { ...node, children: node.children.map(swapNode) };
  };
  return normalizeSplitNode(swapNode(root));
}

export function resizeSplitPair(
  root: SplitNode,
  branchId: string,
  index: number,
  deltaFraction: number,
  minShare = 0.12,
): SplitNode {
  if (!Number.isFinite(deltaFraction) || deltaFraction === 0) return root;
  const walk = (node: SplitNode): { node: SplitNode; changed: boolean } => {
    if (node.type === "leaf") return { node, changed: false };
    if (node.id === branchId) {
      if (index < 0 || index >= node.children.length - 1) return { node, changed: false };
      const total = sumWeights(node.children);
      const a = node.children[index]!;
      const b = node.children[index + 1]!;
      const wA = clampWeight(a.weight);
      const wB = clampWeight(b.weight);
      const pairSum = wA + wB;
      const minW = Math.min(pairSum / 2, Math.max(WEIGHT_MIN, total * minShare));
      const deltaW = deltaFraction * total;
      const nextA = Math.min(pairSum - minW, Math.max(minW, wA + deltaW));
      const nextB = pairSum - nextA;
      if (Math.abs(nextA - wA) < 1e-6) return { node, changed: false };
      const children = node.children.map((c, idx) => {
        if (idx === index) return { ...c, weight: nextA };
        if (idx === index + 1) return { ...c, weight: nextB };
        return c;
      });
      return { node: { ...node, children }, changed: true };
    }
    let changed = false;
    const children = node.children.map((c) => {
      const res = walk(c);
      if (res.changed) changed = true;
      return res.node;
    });
    return { node: changed ? { ...node, children } : node, changed };
  };
  const res = walk(root);
  return res.changed ? res.node : root;
}

export function equalizeSplitWeights(root: SplitNode, branchId?: string): SplitNode {
  const walk = (node: SplitNode): SplitNode => {
    if (node.type === "leaf") return node;
    const resetHere = !branchId || node.id === branchId;
    return {
      ...node,
      children: node.children.map((c) => {
        const mapped = walk(c);
        return resetHere ? { ...mapped, weight: 1 } : mapped;
      }),
    };
  };
  return walk(root);
}

interface AffineSpan {
  scale: number;
  offsetPx: number;
}

interface AffineBox {
  left: AffineSpan;
  top: AffineSpan;
  width: AffineSpan;
  height: AffineSpan;
}

function fmtSpan(span: AffineSpan): string {
  const pct = Number((span.scale * 100).toFixed(5));
  const px = Number(span.offsetPx.toFixed(2));
  if (Math.abs(px) < 0.01) return `${pct}%`;
  if (Math.abs(pct) < 0.0001) return `${px}px`;
  return px >= 0 ? `calc(${pct}% + ${px}px)` : `calc(${pct}% - ${Math.abs(px)}px)`;
}

function fmtBox(box: AffineBox): CssRect {
  return {
    left: fmtSpan(box.left),
    top: fmtSpan(box.top),
    width: fmtSpan(box.width),
    height: fmtSpan(box.height),
  };
}

export function computeSplitLayout(
  root: SplitNode,
  zoomedPaneId?: string | null,
  gapPx = SPLIT_GAP_PX,
): SplitLayoutResult {
  const allLeaves = listLeaves(root);
  const zoomedHit = zoomedPaneId ? allLeaves.some((l) => l.id === zoomedPaneId) : false;
  if (zoomedHit && zoomedPaneId) {
    return {
      leaves: allLeaves.map((leaf) => {
        const isZoomed = leaf.id === zoomedPaneId;
        return {
          leaf,
          visible: isZoomed,
          unit: isZoomed ? { x: 0, y: 0, w: 1, h: 1 } : { x: 0, y: 0, w: 0, h: 0 },
          css: { left: "0%", top: "0%", width: "100%", height: "100%" },
        };
      }),
      sashes: [],
    };
  }

  const leaves: SplitLeafLayout[] = [];
  const sashes: SplitSashLayout[] = [];

  const visit = (node: SplitNode, box: AffineBox, unit: UnitRect) => {
    if (node.type === "leaf") {
      leaves.push({ leaf: node, visible: true, unit, css: fmtBox(box) });
      return;
    }

    const totalW = sumWeights(node.children);
    const gapsTotal = Math.max(0, node.children.length - 1) * gapPx;
    const isRow = node.axis === "row";
    const span = isRow ? box.width : box.height;
    const origin = isRow ? box.left : box.top;
    const availScale = span.scale;
    const availOffset = span.offsetPx - gapsTotal;

    let cumFraction = 0;
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!;
      const fraction = clampWeight(child.weight) / totalW;
      const childOrigin: AffineSpan = {
        scale: origin.scale + cumFraction * availScale,
        offsetPx: origin.offsetPx + cumFraction * availOffset + i * gapPx,
      };
      const childSpan: AffineSpan = {
        scale: availScale * fraction,
        offsetPx: availOffset * fraction,
      };
      const childBox: AffineBox = isRow
        ? { left: childOrigin, top: box.top, width: childSpan, height: box.height }
        : { left: box.left, top: childOrigin, width: box.width, height: childSpan };
      const childUnit: UnitRect = isRow
        ? { x: unit.x + cumFraction * unit.w, y: unit.y, w: fraction * unit.w, h: unit.h }
        : { x: unit.x, y: unit.y + cumFraction * unit.h, w: unit.w, h: fraction * unit.h };

      visit(child, childBox, childUnit);

      if (i < node.children.length - 1) {
        const hitThickness = Math.max(gapPx, 10);
        const pad = (hitThickness - gapPx) / 2;
        const gapStart: AffineSpan = {
          scale: childOrigin.scale + childSpan.scale,
          offsetPx: childOrigin.offsetPx + childSpan.offsetPx - pad,
        };
        const sashBox: AffineBox = isRow
          ? {
              left: gapStart,
              top: box.top,
              width: { scale: 0, offsetPx: hitThickness },
              height: box.height,
            }
          : {
              left: box.left,
              top: gapStart,
              width: box.width,
              height: { scale: 0, offsetPx: hitThickness },
            };
        sashes.push({
          id: `${node.id}:${i}`,
          branchId: node.id,
          index: i,
          axis: node.axis,
          branchSpanScale: isRow ? unit.w : unit.h,
          css: fmtBox(sashBox),
        });
      }

      cumFraction += fraction;
    }
  };

  visit(
    root,
    {
      left: { scale: 0, offsetPx: 0 },
      top: { scale: 0, offsetPx: 0 },
      width: { scale: 1, offsetPx: 0 },
      height: { scale: 1, offsetPx: 0 },
    },
    { x: 0, y: 0, w: 1, h: 1 },
  );

  return { leaves, sashes };
}

export function findPaneInDirection(
  leaves: readonly SplitLeafLayout[],
  fromPaneId: string,
  direction: SplitDirection,
  focusHistory?: readonly string[],
): string | null {
  const from = leaves.find((l) => l.leaf.id === fromPaneId && l.visible);
  if (!from) return null;
  const f = from.unit;
  const horizontal = direction === "left" || direction === "right";

  interface Candidate {
    id: string;
    edgeDist: number;
    overlap: number;
    rect: UnitRect;
  }

  const overlapping: Candidate[] = [];
  const allDirectional: Candidate[] = [];

  for (const item of leaves) {
    if (!item.visible || item.leaf.id === fromPaneId) continue;
    const r = item.unit;
    let edgeDist = -1;
    if (direction === "left") edgeDist = f.x - (r.x + r.w);
    else if (direction === "right") edgeDist = r.x - (f.x + f.w);
    else if (direction === "up") edgeDist = f.y - (r.y + r.h);
    else edgeDist = r.y - (f.y + f.h);

    if (edgeDist < -EPS) continue;
    const clampedDist = Math.max(0, edgeDist);
    const overlap = horizontal
      ? Math.max(0, Math.min(f.y + f.h, r.y + r.h) - Math.max(f.y, r.y))
      : Math.max(0, Math.min(f.x + f.w, r.x + r.w) - Math.max(f.x, r.x));
    const cand: Candidate = { id: item.leaf.id, edgeDist: clampedDist, overlap, rect: r };
    allDirectional.push(cand);
    if (overlap > EPS) overlapping.push(cand);
  }

  const pool = overlapping.length > 0 ? overlapping : allDirectional;
  if (pool.length === 0) return null;

  let minEdge = Infinity;
  for (const c of pool) {
    if (c.edgeDist < minEdge) minEdge = c.edgeDist;
  }
  const nearest = pool.filter((c) => Math.abs(c.edgeDist - minEdge) <= 1e-3);

  const rankHistory = (id: string): number => {
    if (!focusHistory) return -1;
    return focusHistory.indexOf(id);
  };

  nearest.sort((a, b) => {
    const ha = rankHistory(a.id);
    const hb = rankHistory(b.id);
    if (ha !== hb) return hb - ha;
    if (Math.abs(a.overlap - b.overlap) > EPS) return b.overlap - a.overlap;
    if (Math.abs(a.rect.y - b.rect.y) > EPS) return a.rect.y - b.rect.y;
    return a.rect.x - b.rect.x;
  });

  return nearest[0]!.id;
}

function isValidPaneContent(raw: unknown): raw is PaneContent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const c = raw as Partial<PaneContent> & Record<string, unknown>;
  if (c.kind === "agent") return typeof c.agentKey === "string" && c.agentKey.length > 0;
  if (c.kind === "file") {
    return typeof c.agentKey === "string" && typeof c.path === "string" && typeof c.title === "string";
  }
  if (c.kind === "web") {
    return typeof c.webId === "string" && typeof c.url === "string" && typeof c.title === "string";
  }
  if (c.kind === "diff") {
    return (
      typeof c.deviceId === "string" &&
      typeof c.cwd === "string" &&
      typeof c.path === "string" &&
      typeof c.staged === "boolean" &&
      typeof c.title === "string"
    );
  }
  return false;
}

function parseSplitNode(raw: unknown): SplitNode | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const weight = clampWeight(Number(rec.weight ?? 1));
  if (rec.type === "leaf") {
    if (typeof rec.id !== "string" || !rec.id || !isValidPaneContent(rec.content)) return null;
    const content = rec.content;
    const cleanContent: PaneContent =
      content.kind === "agent"
        ? {
            kind: "agent",
            agentKey: content.agentKey,
            ...(content.mode === "chat" || content.mode === "term" ? { mode: content.mode } : {}),
          }
        : content;
    return { type: "leaf", id: rec.id, weight, content: cleanContent };
  }
  if (rec.type === "split" && (rec.axis === "row" || rec.axis === "column") && Array.isArray(rec.children)) {
    const children: SplitNode[] = [];
    for (const childRaw of rec.children) {
      const child = parseSplitNode(childRaw);
      if (child) children.push(child);
    }
    if (children.length === 0) return null;
    return {
      type: "split",
      id: typeof rec.id === "string" && rec.id ? rec.id : makeSplitId("s"),
      axis: rec.axis,
      weight,
      children,
    };
  }
  return null;
}

export function parsePersistedSplitState(raw: unknown): TabSplitState | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const parsedRoot = parseSplitNode(rec.root);
  if (!parsedRoot) return undefined;
  const root = normalizeSplitNode(parsedRoot);
  const leaves = listLeaves(root);
  if (leaves.length < 2) return undefined;
  const focusedPaneId =
    typeof rec.focusedPaneId === "string" && leaves.some((l) => l.id === rec.focusedPaneId)
      ? rec.focusedPaneId
      : leaves[0]!.id;
  const zoomedPaneId =
    typeof rec.zoomedPaneId === "string" && leaves.some((l) => l.id === rec.zoomedPaneId) ? rec.zoomedPaneId : null;
  return { root, focusedPaneId, ...(zoomedPaneId ? { zoomedPaneId } : {}) };
}
