import { useEffect } from "react";
import type { Agent, Device, HerdrDoc, SpaceInfo } from "@herdr-pocket/protocol";
import { isTauri } from "../lib/bridge";
import { ensureLocalHostDeviceId, localHostIdStore } from "../lib/fonts";
import { native } from "../lib/native";
import { rpcCall } from "../lib/relay";
import { allAgents, liveStore } from "../lib/store";
import { extractHostHerdrDoc } from "./herdrDoc";
import { isInteractiveResizeActive, onInteractiveResizeSettled } from "./splitMotion";
import {
  focusedLeafOfTab,
  reconcileHostHerdrDoc,
  refreshHostDocSpaceNames,
  shellStore,
  splitTabPane,
  tabLeaves,
  type ShellState,
  type SplitDirection,
} from "./shellStore";

export interface HerdrDocGetResponse {
  value: HerdrDoc | null;
  version: number;
}

export interface HerdrDocSetResponse {
  ok: boolean;
  conflict?: boolean;
  value?: HerdrDoc | null;
  version: number;
}

export interface HerdrDocTransport {
  getDoc: (hostId: string) => Promise<HerdrDocGetResponse | null>;
  setDoc: (hostId: string, value: HerdrDoc, version: number) => Promise<HerdrDocSetResponse>;
  getAgents: () => Record<string, Agent[]>;
  getSpaces: () => Record<string, SpaceInfo[]>;
  getDevices: () => Record<string, Device>;
  getLocalHostId?: () => string | null;
}

interface HostSlot {
  version: number;
  baseDoc: HerdrDoc | null;
  lastSyncedJson: string;
  lastLocalJson: string;
  readAttempted: boolean;
  readSucceeded: boolean;
  inflight: boolean;
  dirty: boolean;
  blocked: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

export interface PendingSplitPlacement {
  terminalId: string;
  agentKey: string;
  targetTabId: string;
  targetDocTabId?: string;
  anchorPaneId?: string | null;
  direction: SplitDirection;
  createdAt?: number;
}

interface StoredPendingSplit extends Omit<PendingSplitPlacement, "createdAt"> {
  createdAt: number;
}

const PENDING_SPLIT_TTL_MS = 6_000;
const pendingSplits = new Map<string, StoredPendingSplit>();

/** Records a fallback split about to be created so an immediate CAS conflict/doc pull cannot revert it to a standalone tab. */
export function registerPendingSplitPlacement(hostId: string, placement: PendingSplitPlacement): void {
  pendingSplits.set(hostId, {
    ...placement,
    createdAt: placement.createdAt ?? Date.now(),
  });
}

export function clearPendingSplitPlacements(): void {
  pendingSplits.clear();
}

export interface HerdrDocSyncController {
  syncHost: (hostId: string, opts?: { forcePull?: boolean }) => Promise<void>;
  syncAllOnlineHosts: () => Promise<void>;
  handleShellChange: (state?: ShellState) => void;
  flushHost: (hostId: string) => Promise<void>;
  reset: () => void;
  getSlotSnapshot: (hostId: string) => {
    version: number;
    readSucceeded: boolean;
    dirty: boolean;
    blocked: boolean;
  } | null;
}

function stableDocJson(doc: HerdrDoc | null | undefined): string {
  return doc ? JSON.stringify({ spaces: doc.spaces ?? [] }) : "";
}

function defaultTransport(): HerdrDocTransport {
  return {
    async getDoc(hostId) {
      const localId = localHostIdStore.get() ?? (isTauri() ? await ensureLocalHostDeviceId() : null);
      if (isTauri() && native.available() && localId && localId === hostId) {
        const localRes = await native.localHerdrDocGet();
        if (localRes) return localRes;
      }
      return rpcCall(hostId, "herdr.doc.get", {}, 8_000).catch((err: unknown) => {
        const msg = (err as Error)?.message ?? "";
        const code = (err as { code?: string })?.code ?? "";
        if (code === "unsupported" || /unknown method|unsupported/i.test(msg)) {
          return null;
        }
        throw err;
      });
    },
    async setDoc(hostId, value, version) {
      const localId = localHostIdStore.get() ?? (isTauri() ? await ensureLocalHostDeviceId() : null);
      if (isTauri() && native.available() && localId && localId === hostId) {
        try {
          return await native.localHerdrDocSet(value, version);
        } catch {
          // Fall back to daemon RPC if direct hc doc.set failed cleanly.
        }
      }
      return rpcCall(hostId, "herdr.doc.set", { value, version }, 8_000);
    },
    getAgents: () => liveStore.get().agents,
    getSpaces: () => liveStore.get().spaces,
    getDevices: () => liveStore.get().devices,
    getLocalHostId: () => localHostIdStore.get(),
  };
}

/**
 * Latest-state CAS sync engine matching `herdr-app/src/mirror_sync.rs`:
 * pulls `"herdr-app"` docs per host into `shellStore`, debounces local layout edits,
 * pushes via CAS `version`, and reconciles cleanly on conflict.
 */
export function createHerdrDocSyncController(
  transport: HerdrDocTransport = defaultTransport(),
  debounceMs = 120,
): HerdrDocSyncController {
  const slots = new Map<string, HostSlot>();
  let reconciling = false;

  const ensureSlot = (hostId: string): HostSlot => {
    let slot = slots.get(hostId);
    if (!slot) {
      slot = {
        version: 0,
        baseDoc: null,
        lastSyncedJson: "",
        lastLocalJson: "",
        readAttempted: false,
        readSucceeded: false,
        inflight: false,
        dirty: false,
        blocked: false,
        debounceTimer: null,
      };
      slots.set(hostId, slot);
    }
    return slot;
  };

  const makeAgentLookup = () => {
    const byKey = new Map<string, Agent>();
    for (const a of allAgents(transport.getAgents())) {
      byKey.set(a.key, a);
    }
    return (k: string) => byKey.get(k);
  };

  const applyInboundDoc = (hostId: string, slot: HostSlot, doc: HerdrDoc, version: number): boolean => {
    const json = stableDocJson(doc);
    slot.version = version;
    slot.baseDoc = doc;
    slot.readSucceeded = true;
    const lookup = makeAgentLookup();
    const hostSpaces = transport.getSpaces()[hostId] ?? [];
    if (json !== slot.lastSyncedJson || doc.spaces.length > 0) {
      reconciling = true;
      try {
        reconcileHostHerdrDoc(hostId, doc, lookup, hostSpaces);
      } finally {
        reconciling = false;
      }
    }

    let preservedPendingSplit = false;
    const pending = pendingSplits.get(hostId);
    if (pending) {
      if (Date.now() - pending.createdAt > PENDING_SPLIT_TTL_MS) {
        pendingSplits.delete(hostId);
      } else {
        const curTabs = shellStore.get().tabs;
        const targetTab =
          curTabs.find((t) => t.id === pending.targetTabId) ??
          (pending.targetDocTabId
            ? curTabs.find((t) => t.docHostId === hostId && t.docTabId === pending.targetDocTabId)
            : undefined) ??
          (pending.anchorPaneId
            ? curTabs.find((t) => tabLeaves(t).some((l) => l.id === pending.anchorPaneId))
            : undefined);
        const alreadyInTarget = Boolean(
          targetTab && tabLeaves(targetTab).some((l) => l.content.kind === "agent" && l.content.agentKey === pending.agentKey),
        );
        pendingSplits.delete(hostId);
        if (!alreadyInTarget && targetTab) {
          const anchor =
            pending.anchorPaneId && tabLeaves(targetTab).some((l) => l.id === pending.anchorPaneId)
              ? pending.anchorPaneId
              : focusedLeafOfTab(targetTab).id;
          reconciling = true;
          try {
            const paneId = splitTabPane(
              targetTab.id,
              anchor,
              pending.direction,
              { kind: "agent", agentKey: pending.agentKey, mode: "term" },
              { dedupeOtherTabs: true },
            );
            preservedPendingSplit = Boolean(paneId);
          } finally {
            reconciling = false;
          }
        }
      }
    }

    slot.lastSyncedJson = json;
    const postDoc = extractHostHerdrDoc(
      hostId,
      shellStore.get().tabs,
      doc,
      hostSpaces,
      lookup,
    );
    const postJson = stableDocJson(postDoc);
    slot.lastLocalJson = postJson;
    slot.dirty = preservedPendingSplit && postJson !== json;
    return preservedPendingSplit;
  };

  const flushHost = async (hostId: string): Promise<void> => {
    const slot = ensureSlot(hostId);
    if (slot.debounceTimer) {
      clearTimeout(slot.debounceTimer);
      slot.debounceTimer = null;
    }
    if (slot.inflight || slot.blocked || !slot.readSucceeded || !slot.dirty) return;
    slot.inflight = true;
    let conflictRetries = 0;
    try {
      while (slot.dirty && !slot.blocked) {
        const lookup = makeAgentLookup();
        const nextDoc = extractHostHerdrDoc(
          hostId,
          shellStore.get().tabs,
          slot.baseDoc,
          transport.getSpaces()[hostId] ?? [],
          lookup,
        );
        const nextJson = stableDocJson(nextDoc);
        if (nextJson === slot.lastSyncedJson) {
          slot.lastLocalJson = nextJson;
          slot.dirty = false;
          break;
        }
        slot.dirty = false;
        const res = await transport.setDoc(hostId, nextDoc, slot.version);
        if (res.ok) {
          slot.version = res.version;
          slot.baseDoc = nextDoc;
          slot.lastSyncedJson = nextJson;
          slot.lastLocalJson = nextJson;
          continue;
        }
        if (res.conflict) {
          if (res.value) {
            const shouldRetry = applyInboundDoc(hostId, slot, res.value, res.version);
            if (shouldRetry && slot.dirty && conflictRetries < 1) {
              conflictRetries += 1;
              continue;
            }
          } else {
            slot.version = res.version;
          }
          break;
        }
        break;
      }
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "";
      if (code === "unsupported") slot.blocked = true;
    } finally {
      slot.inflight = false;
    }
  };

  const syncHost = async (hostId: string, opts?: { forcePull?: boolean }): Promise<void> => {
    if (isInteractiveResizeActive()) return;
    const slot = ensureSlot(hostId);
    if (opts?.forcePull) {
      if (slot.debounceTimer) {
        clearTimeout(slot.debounceTimer);
        slot.debounceTimer = null;
      }
      slot.dirty = false;
    }
    if (slot.inflight || slot.blocked) return;
    if (slot.dirty) {
      await flushHost(hostId);
      return;
    }
    slot.inflight = true;
    slot.readAttempted = true;
    try {
      const res = await transport.getDoc(hostId);
      if (!res) {
        slot.blocked = true;
        return;
      }
      slot.version = res.version;
      slot.readSucceeded = true;
      if (res.value) {
        applyInboundDoc(hostId, slot, res.value, res.version);
      } else {
        const lookup = makeAgentLookup();
        const currentDoc = extractHostHerdrDoc(
          hostId,
          shellStore.get().tabs,
          null,
          transport.getSpaces()[hostId] ?? [],
          lookup,
        );
        slot.lastLocalJson = stableDocJson(currentDoc);
        slot.lastSyncedJson = "";
      }
    } catch {
      // Transient RPC/offline error: keep slot retryable without marking blocked.
    } finally {
      slot.inflight = false;
    }
    if (slot.dirty) {
      await flushHost(hostId);
    }
  };

  const syncAllOnlineHosts = async (): Promise<void> => {
    const devs = transport.getDevices();
    const hostIds = new Set<string>();
    for (const d of Object.values(devs)) {
      if (d.kind === "host" && d.online) hostIds.add(d.id);
    }
    const localId = transport.getLocalHostId?.();
    if (localId) hostIds.add(localId);
    await Promise.all(Array.from(hostIds).map((id) => syncHost(id)));
  };

  const handleShellChange = (state: ShellState = shellStore.get()): void => {
    if (reconciling || isInteractiveResizeActive()) return;
    const devs = transport.getDevices();
    const spacesMap = transport.getSpaces();
    const lookup = makeAgentLookup();
    const candidateHosts = new Set<string>(slots.keys());
    for (const t of state.tabs) {
      if (t.docHostId) candidateHosts.add(t.docHostId);
    }
    for (const hostId of candidateHosts) {
      const slot = slots.get(hostId);
      if (!slot || !slot.readSucceeded || slot.blocked) continue;
      if (devs[hostId] && devs[hostId]!.online === false && hostId !== transport.getLocalHostId?.()) {
        continue;
      }
      const nextDoc = extractHostHerdrDoc(hostId, state.tabs, slot.baseDoc, spacesMap[hostId] ?? [], lookup);
      const nextJson = stableDocJson(nextDoc);
      if (nextJson === slot.lastLocalJson) continue;
      slot.lastLocalJson = nextJson;
      if (nextJson === slot.lastSyncedJson) {
        slot.dirty = false;
        if (slot.debounceTimer) {
          clearTimeout(slot.debounceTimer);
          slot.debounceTimer = null;
        }
        continue;
      }
      slot.dirty = true;
      if (slot.debounceTimer) clearTimeout(slot.debounceTimer);
      slot.debounceTimer = setTimeout(() => {
        slot.debounceTimer = null;
        void flushHost(hostId);
      }, debounceMs);
    }
  };

  const reset = (): void => {
    for (const slot of slots.values()) {
      if (slot.debounceTimer) clearTimeout(slot.debounceTimer);
    }
    slots.clear();
  };

  const getSlotSnapshot = (hostId: string) => {
    const slot = slots.get(hostId);
    if (!slot) return null;
    return {
      version: slot.version,
      readSucceeded: slot.readSucceeded,
      dirty: slot.dirty,
      blocked: slot.blocked,
    };
  };

  return {
    syncHost,
    syncAllOnlineHosts,
    handleShellChange,
    flushHost,
    reset,
    getSlotSnapshot,
  };
}

let sharedController: HerdrDocSyncController | null = null;

function getSharedController(): HerdrDocSyncController {
  if (!sharedController) sharedController = createHerdrDocSyncController();
  return sharedController;
}

/** Pulls the latest `herdr-app` layout doc for `hostId` right away (for example after `herdr.command pane.split`). */
export function syncHostNow(hostId: string): Promise<void> {
  return getSharedController().syncHost(hostId);
}

/** Forces an authoritative inbound pull of `herdr-app` doc for `hostId` (used after host-side `agent.create`). */
export function pullHostDocNow(hostId: string): Promise<void> {
  return getSharedController().syncHost(hostId, { forcePull: true });
}

/** Flushes local `herdr-app` doc changes for `hostId` without waiting for the debounce timer. */
export function flushHostNow(hostId: string): Promise<void> {
  const ctrl = getSharedController();
  ctrl.handleShellChange(shellStore.get());
  return ctrl.flushHost(hostId);
}

/**
 * Mounts bidirectional `herdr-app` layout sync on desktop:
 * reacts to local Tauri `local-term://doc-changed` push events, `shellStore` edits,
 * host online changes, and periodic visible catch-up polls.
 */
export function useHerdrDocSync(): void {
  const link = liveStore.use((s) => s.link);
  const devices = liveStore.use((s) => s.devices);
  const spacesMap = liveStore.use((s) => s.spaces);
  const localHostId = localHostIdStore.use((s) => s);

  useEffect(() => {
    for (const [hostId, list] of Object.entries(spacesMap)) {
      if (list?.length) refreshHostDocSpaceNames(hostId, list);
    }
  }, [spacesMap]);

  useEffect(() => {
    const ctrl = getSharedController();
    void ctrl.syncAllOnlineHosts();
  }, [link, devices, localHostId]);

  useEffect(() => {
    const ctrl = getSharedController();
    const unsubShell = shellStore.subscribe(() => {
      ctrl.handleShellChange(shellStore.get());
    });
    const unsubResizeSettle = onInteractiveResizeSettled(() => {
      ctrl.handleShellChange(shellStore.get());
    });

    let docPullTimer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const offListeners: Array<() => void> = [];

    if (isTauri() && native.available()) {
      void (async () => {
        const { listen } = await import("@tauri-apps/api/event");
        if (!alive) return;
        const scheduleLocalPull = () => {
          if (docPullTimer) clearTimeout(docPullTimer);
          docPullTimer = setTimeout(() => {
            docPullTimer = null;
            const id = localHostIdStore.get();
            if (id) void ctrl.syncHost(id);
          }, 80);
        };
        const offDoc = await listen("local-term://doc-changed", scheduleLocalPull);
        const offTerms = await listen("local-term://terminals-changed", scheduleLocalPull);
        if (!alive) {
          offDoc();
          offTerms();
          return;
        }
        offListeners.push(offDoc, offTerms);
      })();
    }

    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        void ctrl.syncAllOnlineHosts();
      }
    };
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void ctrl.syncAllOnlineHosts();
    }, 15_000);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      alive = false;
      unsubShell();
      unsubResizeSettle();
      clearInterval(timer);
      if (docPullTimer) clearTimeout(docPullTimer);
      for (const off of offListeners) off();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, []);
}
