import type { DragEvent } from "react";

export interface WorkspaceDragItem {
  agentKey: string;
  hostId: string;
  relPath: string;
  absPath?: string;
  name: string;
  kind: "file" | "dir";
}

export type PanelDragItem =
  | { kind: "browser"; url: string; title: string; spaceKey?: string | null }
  | { kind: "agent"; agentKey: string };

export interface PaneDragItem {
  tabId: string;
  paneId: string;
}

export const WORKSPACE_FILE_MIME = "application/x-herdr-pocket-file";
export const TAB_DRAG_MIME = "application/x-herdr-pocket-tab";
export const PANEL_DRAG_MIME = "application/x-herdr-pocket-panel";
export const PANE_DRAG_MIME = "application/x-herdr-pocket-pane";

let activeWorkspaceDrag: WorkspaceDragItem | null = null;
let activeTabDragId: string | null = null;
let activePanelDrag: PanelDragItem | null = null;
let activePaneDrag: PaneDragItem | null = null;

export function startWorkspaceDrag(e: DragEvent<HTMLElement>, item: WorkspaceDragItem): void {
  activeWorkspaceDrag = item;
  try {
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData(WORKSPACE_FILE_MIME, JSON.stringify(item));
    e.dataTransfer.setData("text/plain", item.absPath || item.relPath);
  } catch {
    // WebKit may restrict custom MIME types; module state covers intra-window drops.
  }
}

export function endWorkspaceDrag(): void {
  activeWorkspaceDrag = null;
}

export function hasWorkspaceDrag(e: DragEvent<HTMLElement>): boolean {
  if (activeWorkspaceDrag) return true;
  const types = e.dataTransfer?.types;
  return Boolean(types && (Array.from(types).includes(WORKSPACE_FILE_MIME)));
}

export function readWorkspaceDrag(e: DragEvent<HTMLElement>): WorkspaceDragItem | null {
  try {
    const raw = e.dataTransfer?.getData(WORKSPACE_FILE_MIME);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WorkspaceDragItem>;
      if (parsed.agentKey && parsed.hostId && parsed.relPath && parsed.name && (parsed.kind === "file" || parsed.kind === "dir")) {
        return parsed as WorkspaceDragItem;
      }
    }
  } catch {
    // fall back to active in-memory item
  }
  return activeWorkspaceDrag;
}

export function resolveDropPath(item: WorkspaceDragItem, targetHostId: string): string {
  if (item.hostId === targetHostId && item.absPath) return item.absPath;
  if (!item.relPath) return ".";
  return item.relPath.startsWith("./") || item.relPath.startsWith("/") ? item.relPath : `./${item.relPath}`;
}

export function startTabDrag(e: DragEvent<HTMLElement>, tabId: string): void {
  activeTabDragId = tabId;
  try {
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData(TAB_DRAG_MIME, tabId);
    e.dataTransfer.setData("text/plain", `tab:${tabId}`);
  } catch {
    // WebKit fallback via module singleton
  }
}

export function endTabDrag(): void {
  activeTabDragId = null;
}

export function hasTabDrag(e: DragEvent<HTMLElement>): boolean {
  if (activeTabDragId) return true;
  const types = e.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes(TAB_DRAG_MIME));
}

export function readTabDrag(e: DragEvent<HTMLElement>): string | null {
  try {
    const raw = e.dataTransfer?.getData(TAB_DRAG_MIME);
    if (raw) return raw;
  } catch {
    // ignore
  }
  return activeTabDragId;
}

export function startPanelDrag(e: DragEvent<HTMLElement>, item: PanelDragItem): void {
  activePanelDrag = item;
  try {
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData(PANEL_DRAG_MIME, JSON.stringify(item));
    e.dataTransfer.setData("text/plain", item.kind === "agent" ? item.agentKey : item.url);
  } catch {
    // WebKit fallback via module singleton
  }
}

export function endPanelDrag(): void {
  activePanelDrag = null;
}

export function hasPanelDrag(e: DragEvent<HTMLElement>): boolean {
  if (activePanelDrag) return true;
  const types = e.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes(PANEL_DRAG_MIME));
}

export function readPanelDrag(e: DragEvent<HTMLElement>): PanelDragItem | null {
  try {
    const raw = e.dataTransfer?.getData(PANEL_DRAG_MIME);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PanelDragItem>;
      if (parsed.kind === "browser" && typeof parsed.url === "string") {
        return { kind: "browser", url: parsed.url, title: parsed.title || parsed.url, spaceKey: parsed.spaceKey };
      }
      if (parsed.kind === "agent" && typeof parsed.agentKey === "string") {
        return { kind: "agent", agentKey: parsed.agentKey };
      }
    }
  } catch {
    // fall back to module singleton
  }
  return activePanelDrag;
}

export function startPaneDrag(e: DragEvent<HTMLElement>, item: PaneDragItem): void {
  activePaneDrag = item;
  try {
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData(PANE_DRAG_MIME, JSON.stringify(item));
    e.dataTransfer.setData("text/plain", `${item.tabId}:${item.paneId}`);
  } catch {
    // WebKit fallback via module singleton
  }
}

export function endPaneDrag(): void {
  activePaneDrag = null;
}

export function hasPaneDrag(e: DragEvent<HTMLElement>): boolean {
  if (activePaneDrag) return true;
  const types = e.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes(PANE_DRAG_MIME));
}

export function readPaneDrag(e: DragEvent<HTMLElement>): PaneDragItem | null {
  try {
    const raw = e.dataTransfer?.getData(PANE_DRAG_MIME);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PaneDragItem>;
      if (typeof parsed.tabId === "string" && parsed.tabId && typeof parsed.paneId === "string" && parsed.paneId) {
        return { tabId: parsed.tabId, paneId: parsed.paneId };
      }
    }
  } catch {
    // fall back to module singleton
  }
  return activePaneDrag;
}
