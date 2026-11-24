import { useEffect, useState } from "react";
import {
  DIRECT_PORTAL_FS_PREFIX,
  type HostPortalCapabilities,
  type PortalFileTicket,
  type PortalFramePayload,
  type PortalInputAction,
  type PortalItem,
  type PortalKind,
  type PortalStreamEvent,
  type RemoteWindowInfo,
} from "@herdr-pocket/protocol";
import { logger } from "./log";
import { getDirectEndpoint, rpcCall, subscribeStream } from "./relay";
import { liveStore } from "./store";

export function encodePortalRelPath(rel: string): string {
  return rel
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

export function buildPortalP2pUrl(
  hostId: string,
  ticket: Pick<PortalFileTicket, "token" | "entryPath" | "port" | "addrs">,
  directOverride?: { addr: string; port: number } | null,
): string | null {
  const endpoint = directOverride !== undefined ? directOverride : getDirectEndpoint(hostId);
  const storeAddr = liveStore.get().direct[hostId];
  const addr = endpoint?.addr ?? storeAddr ?? ticket.addrs[0];
  const port = endpoint?.port ?? ticket.port;
  // Require an active P2P session unless ticket explicitly targets loopback.
  if (!endpoint && !storeAddr) return null;
  if (!addr || !port) return null;
  const host = addr.includes(":") ? `[${addr}]` : addr;
  const path = ticket.entryPath ? `/${encodePortalRelPath(ticket.entryPath)}` : "/";
  return `http://${host}:${port}${DIRECT_PORTAL_FS_PREFIX}/${encodeURIComponent(ticket.token)}${path}`;
}

export function buildPortalP2pSiblingUrl(baseEntryUrl: string, siblingName: string): string {
  const idx = baseEntryUrl.lastIndexOf("/");
  if (idx < 0) return baseEntryUrl;
  return `${baseEntryUrl.slice(0, idx + 1)}${encodeURIComponent(siblingName)}`;
}

export function filterVisiblePortalItems(opts: {
  itemsById: Record<string, PortalItem>;
  dismissedIds: Record<string, true>;
  manualIds: Record<string, true>;
  agent: { deviceId: string; key: string };
  isTauriApp: boolean;
  localHostId: string | null;
}): PortalItem[] {
  const isSameLocalMachine = opts.isTauriApp && Boolean(opts.localHostId) && opts.agent.deviceId === opts.localHostId;
  return Object.values(opts.itemsById)
    .filter((i) => {
      if (i.hostId !== opts.agent.deviceId) return false;
      if (i.agentKey && i.agentKey !== opts.agent.key) return false;
      if (opts.dismissedIds[i.id]) return false;
      if (isSameLocalMachine && !opts.manualIds[i.id]) return false;
      return true;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Maps viewer client coordinates `(clientX, clientY)` onto `[0, 1]` coordinates of the
 * remote image rendered with `object-fit: contain` inside `(rectWidth x rectHeight)`.
 */
export function mapContainedPointer(opts: {
  clientX: number;
  clientY: number;
  rectLeft: number;
  rectTop: number;
  rectWidth: number;
  rectHeight: number;
  imageWidth?: number;
  imageHeight?: number;
}): { nx: number; ny: number } {
  const { clientX, clientY, rectLeft, rectTop, rectWidth, rectHeight, imageWidth, imageHeight } = opts;
  if (rectWidth <= 0 || rectHeight <= 0) return { nx: 0.5, ny: 0.5 };
  let drawLeft = 0;
  let drawTop = 0;
  let drawW = rectWidth;
  let drawH = rectHeight;
  if (imageWidth && imageHeight && imageWidth > 0 && imageHeight > 0) {
    const imgAspect = imageWidth / imageHeight;
    const boxAspect = rectWidth / rectHeight;
    if (boxAspect > imgAspect) {
      drawH = rectHeight;
      drawW = rectHeight * imgAspect;
      drawLeft = (rectWidth - drawW) / 2;
    } else {
      drawW = rectWidth;
      drawH = rectWidth / imgAspect;
      drawTop = (rectHeight - drawH) / 2;
    }
  }
  const rx = clientX - rectLeft - drawLeft;
  const ry = clientY - rectTop - drawTop;
  return {
    nx: Math.min(1, Math.max(0, rx / Math.max(1, drawW))),
    ny: Math.min(1, Math.max(0, ry / Math.max(1, drawH))),
  };
}

interface PortalState {
  itemsById: Record<string, PortalItem>;
  framesById: Record<string, PortalFramePayload>;
  ticketsById: Record<string, PortalFileTicket>;
  capsByHost: Record<string, HostPortalCapabilities>;
  windowsByHost: Record<string, RemoteWindowInfo[]>;
  dismissedIds: Record<string, true>;
  manualIds: Record<string, true>;
}

const initialState: PortalState = {
  itemsById: {},
  framesById: {},
  ticketsById: {},
  capsByHost: {},
  windowsByHost: {},
  dismissedIds: {},
  manualIds: {},
};

let state: PortalState = initialState;
const listeners = new Set<() => void>();
const unsupportedHostVersions = new Map<string, string>();
const hostPortalWatchers = new Map<
  string,
  {
    refs: number;
    stop: () => void;
  }
>();

function hostVersionKey(hostId: string): string {
  const dev = liveStore.get().devices[hostId];
  return `${dev?.version ?? ""}:${dev?.online ? 1 : 0}`;
}

const UNSUPPORTED_PORTAL_CAPS: HostPortalCapabilities = {
  platform: "unknown",
  sessionType: "headless",
  canListWindows: false,
  canCaptureWindow: false,
  canCaptureScreen: false,
  canInjectInput: false,
  hasCdpBrowser: false,
};

export function isHostPortalUnsupported(hostId: string): boolean {
  const cached = unsupportedHostVersions.get(hostId);
  if (!cached) return false;
  if (cached === hostVersionKey(hostId)) return true;
  unsupportedHostVersions.delete(hostId);
  return false;
}

export function isPortalUnsupportedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const msg = String((err as { message?: unknown; error?: unknown }).message ?? (err as { error?: unknown }).error ?? "");
  if (code === "unsupported") return true;
  return /unknown method\s+portal\.|unknown stream\b|unsupported.*portal/i.test(msg);
}

export function markHostPortalUnsupported(hostId: string): void {
  unsupportedHostVersions.set(hostId, hostVersionKey(hostId));
}

export function resetPortalClientStateForTest(): void {
  unsupportedHostVersions.clear();
  for (const w of hostPortalWatchers.values()) {
    w.stop();
  }
  hostPortalWatchers.clear();
  state = initialState;
}

function setState(updater: (prev: PortalState) => PortalState): void {
  state = updater(state);
  for (const fn of listeners) fn();
}

export const portalStore = {
  get: () => state,
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  use<T>(selector: (s: PortalState) => T): T {
    const [val, setVal] = useState(() => selector(state));
    useEffect(() => {
      setVal(selector(state));
      return portalStore.subscribe(() => {
        setVal((prev) => {
          const next = selector(state);
          return Object.is(prev, next) ? prev : next;
        });
      });
    }, []);
    return val;
  },
};

export function ingestPortalStreamEvent(ev: unknown): void {
  if (!ev || typeof ev !== "object") return;
  const e = ev as Partial<PortalStreamEvent>;
  if (e.kind === "portal_event" && e.item) {
    const item = e.item;
    if (e.action === "closed") {
      setState((prev) => {
        if (!prev.itemsById[item.id] && !prev.framesById[item.id]) return prev;
        const itemsById = { ...prev.itemsById };
        delete itemsById[item.id];
        const framesById = { ...prev.framesById };
        delete framesById[item.id];
        const ticketsById = { ...prev.ticketsById };
        delete ticketsById[item.id];
        return { ...prev, itemsById, framesById, ticketsById };
      });
    } else {
      setState((prev) => {
        const dismissedIds = { ...prev.dismissedIds };
        if (e.action === "opened") delete dismissedIds[item.id];
        return {
          ...prev,
          itemsById: { ...prev.itemsById, [item.id]: item },
          dismissedIds,
        };
      });
    }
    return;
  }
  if (e.kind === "portal_frame" && e.portalId && e.data) {
    const frame = e as PortalFramePayload;
    setState((prev) => {
      const cur = prev.framesById[frame.portalId];
      if (cur && cur.seq >= frame.seq && cur.at >= frame.at) return prev;
      const existing = prev.itemsById[frame.portalId];
      const nextItem = existing
        ? {
            ...existing,
            ...(frame.url ? { url: frame.url } : {}),
            ...(frame.title ? { title: frame.title } : {}),
            width: frame.width,
            height: frame.height,
            updatedAt: frame.at,
          }
        : undefined;
      return {
        ...prev,
        framesById: { ...prev.framesById, [frame.portalId]: frame },
        ...(nextItem ? { itemsById: { ...prev.itemsById, [frame.portalId]: nextItem } } : {}),
      };
    });
  }
}

export function dismissPortalInUi(portalId: string): void {
  setState((prev) => ({
    ...prev,
    dismissedIds: { ...prev.dismissedIds, [portalId]: true },
  }));
}

export async function refreshHostPortals(
  hostId: string,
  agentKey?: string,
  includeWindows = false,
): Promise<{ items: PortalItem[]; windows?: RemoteWindowInfo[]; capabilities: HostPortalCapabilities }> {
  if (isHostPortalUnsupported(hostId) && !includeWindows) {
    return {
      items: [],
      capabilities: UNSUPPORTED_PORTAL_CAPS,
    };
  }
  let res: { items: PortalItem[]; windows?: RemoteWindowInfo[]; capabilities: HostPortalCapabilities };
  try {
    res = await rpcCall(hostId, "portal.list", {
      ...(agentKey ? { agent: agentKey } : {}),
      includeWindows,
    });
    unsupportedHostVersions.delete(hostId);
  } catch (err) {
    if (isPortalUnsupportedError(err)) {
      markHostPortalUnsupported(hostId);
      if (includeWindows) {
        throw new Error("这台电脑的 herdr-pocket 版本较旧，暂不支持跨端窗口回传，请先更新工具");
      }
      return {
        items: [],
        capabilities: UNSUPPORTED_PORTAL_CAPS,
      };
    }
    throw err;
  }
  setState((prev) => {
    const nextItems = { ...prev.itemsById };
    if (agentKey) {
      for (const [id, it] of Object.entries(nextItems)) {
        if (it.hostId === hostId && it.agentKey === agentKey && !res.items.some((x) => x.id === id)) {
          delete nextItems[id];
        }
      }
    } else {
      for (const [id, it] of Object.entries(nextItems)) {
        if (it.hostId === hostId && !res.items.some((x) => x.id === id)) {
          delete nextItems[id];
        }
      }
    }
    for (const item of res.items) {
      nextItems[item.id] = item;
    }
    return {
      ...prev,
      itemsById: nextItems,
      capsByHost: { ...prev.capsByHost, [hostId]: res.capabilities },
      ...(res.windows ? { windowsByHost: { ...prev.windowsByHost, [hostId]: res.windows } } : {}),
    };
  });
  return res;
}

export async function openPortalSurface(
  hostId: string,
  params: { agent?: string; kind: PortalKind; target?: string; url?: string; windowId?: string; reveal?: boolean; title?: string },
): Promise<{ item: PortalItem; ticket?: PortalFileTicket }> {
  logger.info("portal", "portal.open", { kind: params.kind, reveal: Boolean(params.reveal) });
  const res = await rpcCall(hostId, "portal.open", params, 20_000).catch((err) => {
    logger.warn("portal", `portal.open failed: ${(err as Error)?.message ?? String(err)}`, { kind: params.kind });
    throw err;
  });
  setState((prev) => {
    const dismissedIds = { ...prev.dismissedIds };
    delete dismissedIds[res.item.id];
    return {
      ...prev,
      itemsById: { ...prev.itemsById, [res.item.id]: res.item },
      ...(res.ticket ? { ticketsById: { ...prev.ticketsById, [res.item.id]: res.ticket } } : {}),
      dismissedIds,
      manualIds: { ...prev.manualIds, [res.item.id]: true },
    };
  });
  return res;
}

export async function closePortalSurface(hostId: string, portalId: string): Promise<void> {
  logger.info("portal", "portal.close", { portalId });
  await rpcCall(hostId, "portal.close", { portalId }).catch(() => {});
  setState((prev) => {
    const itemsById = { ...prev.itemsById };
    delete itemsById[portalId];
    const framesById = { ...prev.framesById };
    delete framesById[portalId];
    const ticketsById = { ...prev.ticketsById };
    delete ticketsById[portalId];
    return { ...prev, itemsById, framesById, ticketsById };
  });
}

const inflightFrames = new Map<string, Promise<PortalFramePayload | null>>();

export function capturePortalFrameOnce(hostId: string, portalId: string): Promise<PortalFramePayload | null> {
  const key = `${hostId}\0${portalId}`;
  const pending = inflightFrames.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      const res = await rpcCall(hostId, "portal.frame", { portalId }, 12_000);
      if (res.item) {
        setState((prev) => ({
          ...prev,
          itemsById: { ...prev.itemsById, [res.item!.id]: res.item! },
        }));
      }
      if (res.frame) {
        ingestPortalStreamEvent({ kind: "portal_frame", ...res.frame });
      }
      return res.frame;
    } catch (err) {
      logger.warn("portal", `portal.frame error: ${(err as Error)?.message ?? String(err)}`, { portalId });
      throw err;
    }
  })().finally(() => {
    inflightFrames.delete(key);
  });
  inflightFrames.set(key, p);
  return p;
}

export async function sendPortalInput(
  hostId: string,
  portalId: string,
  input: PortalInputAction,
): Promise<{ url?: string; title?: string }> {
  const res = await rpcCall(hostId, "portal.input", { portalId, input }, 10_000);
  if (res.url || res.title) {
    setState((prev) => {
      const existing = prev.itemsById[portalId];
      if (!existing) return prev;
      return {
        ...prev,
        itemsById: {
          ...prev.itemsById,
          [portalId]: {
            ...existing,
            ...(res.url ? { url: res.url } : {}),
            ...(res.title ? { title: res.title } : {}),
            updatedAt: Date.now(),
          },
        },
      };
    });
  }
  return res;
}

export function subscribeAgentPortalUpdates(hostId: string, _agentKey: string): () => void {
  const existing = hostPortalWatchers.get(hostId);
  if (existing) {
    existing.refs += 1;
    return () => {
      const cur = hostPortalWatchers.get(hostId);
      if (!cur) return;
      cur.refs -= 1;
      if (cur.refs <= 0) {
        hostPortalWatchers.delete(hostId);
        cur.stop();
      }
    };
  }

  let alive = true;
  let streamFailed = false;
  let timer = 0;

  const stopRecoveryTimer = () => {
    if (timer) {
      window.clearInterval(timer);
      timer = 0;
    }
  };

  if (!isHostPortalUnsupported(hostId)) {
    void refreshHostPortals(hostId, undefined, false).catch(() => {});
  }

  const unsub = subscribeStream(
    hostId,
    "portal",
    {},
    (ev) => {
      if (alive) ingestPortalStreamEvent(ev);
    },
    (st) => {
      if (!alive) return;
      if (st?.kind === "error") {
        streamFailed = true;
        if (isPortalUnsupportedError(st)) {
          markHostPortalUnsupported(hostId);
          stopRecoveryTimer();
        }
      }
      if (st?.kind === "live" && Array.isArray(st.result?.items)) {
        unsupportedHostVersions.delete(hostId);
        for (const item of st.result.items as PortalItem[]) {
          ingestPortalStreamEvent({ kind: "portal_event", action: "updated", item, at: Date.now() });
        }
      }
    },
  );

  // Light recovery poll in case an older relay rejects `stream: "portal"`, stopping immediately if hostd lacks portal.*.
  timer = window.setInterval(() => {
    if (!alive) return;
    if (isHostPortalUnsupported(hostId)) {
      stopRecoveryTimer();
      return;
    }
    if (streamFailed) {
      void refreshHostPortals(hostId, undefined, false).catch(() => {});
    }
  }, 5000);

  const entry = {
    refs: 1,
    stop: () => {
      alive = false;
      stopRecoveryTimer();
      unsub();
    },
  };
  hostPortalWatchers.set(hostId, entry);

  return () => {
    const cur = hostPortalWatchers.get(hostId);
    if (!cur) return;
    cur.refs -= 1;
    if (cur.refs <= 0) {
      hostPortalWatchers.delete(hostId);
      cur.stop();
    }
  };
}

export function subscribePortalFrames(
  hostId: string,
  portalId: string,
  fps = 12,
): () => void {
  let alive = true;
  let streamLive = false;
  let lastStreamFrameAt = 0;
  let busy = false;

  void capturePortalFrameOnce(hostId, portalId).catch(() => {});

  const unsub = subscribeStream(
    hostId,
    "portal",
    { portalId, fps },
    (ev) => {
      if (!alive) return;
      if (ev?.kind === "portal_frame" && ev.portalId === portalId) {
        lastStreamFrameAt = Date.now();
      }
      ingestPortalStreamEvent(ev);
    },
    (st) => {
      if (alive && st?.kind === "live") streamLive = true;
      if (alive && st?.kind === "error") streamLive = false;
    },
  );

  const pollInterval = Math.max(120, Math.round(1000 / Math.max(1, Math.min(8, fps))));
  const timer = window.setInterval(() => {
    if (!alive || busy) return;
    if (streamLive && Date.now() - lastStreamFrameAt < 1200) return;
    busy = true;
    void capturePortalFrameOnce(hostId, portalId)
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, pollInterval);

  return () => {
    alive = false;
    window.clearInterval(timer);
    unsub();
  };
}
