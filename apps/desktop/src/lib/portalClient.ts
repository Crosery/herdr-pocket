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
import { getDirectEndpoint, getDirectLink, rpcCall, subscribeStream } from "./relay";
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
  const link = directOverride === undefined ? getDirectLink(hostId) : null;
  if (link && link.transportKind === "webrtc") return null;
  const endpoint = directOverride !== undefined ? directOverride : getDirectEndpoint(hostId);
  const storeAddr = liveStore.get().direct[hostId];
  const addr = endpoint?.addr ?? storeAddr ?? ticket.addrs[0];
  const port = endpoint?.port ?? ticket.port;
  // Require an active HTTP-capable P2P session unless override supplied.
  if (!endpoint && (!storeAddr || storeAddr.startsWith("webrtc:"))) return null;
  if (!addr || !port || addr.startsWith("webrtc:")) return null;
  const isLoopback = addr === "127.0.0.1" || addr === "localhost" || addr === "::1";
  if (!isLoopback && typeof window !== "undefined" && window.location?.protocol === "https:") {
    return null;
  }
  const host = addr.includes(":") ? `[${addr}]` : addr;
  const path = ticket.entryPath ? `/${encodePortalRelPath(ticket.entryPath)}` : "/";
  return `http://${host}:${port}${DIRECT_PORTAL_FS_PREFIX}/${encodeURIComponent(ticket.token)}${path}`;
}

export async function fetchPortalFileP2p(
  hostId: string,
  ticket: PortalFileTicket,
  opts?: {
    relPath?: string;
    start?: number;
    end?: number;
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
  },
): Promise<{ blob: Blob; mime: string; size: number; via: "http-p2p" | "webrtc" } | null> {
  if (ticket.isDir) return null;
  const directUrl = buildPortalP2pUrl(hostId, ticket);
  if (directUrl) {
    const targetUrl = opts?.relPath
      ? `${directUrl.replace(/\/$/, "")}/${encodePortalRelPath(opts.relPath)}`
      : directUrl;
    const headers: Record<string, string> = {};
    if (opts?.start !== undefined) {
      headers.Range =
        opts.end !== undefined ? `bytes=${opts.start}-${opts.end}` : `bytes=${opts.start}-`;
    }
    const resp = await fetch(targetUrl, {
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    }).catch(() => null);
    if (resp && resp.ok) {
      const blob = await resp.blob();
      const total = Number.parseInt(resp.headers.get("content-length") ?? "", 10) || blob.size || ticket.size;
      return {
        blob,
        mime: resp.headers.get("content-type") || ticket.mime || blob.type || "application/octet-stream",
        size: total,
        via: "http-p2p",
      };
    }
  }
  const link = getDirectLink(hostId);
  if (link?.open && link.transportKind === "webrtc") {
    const got = await link.getFile(
      {
        token: ticket.token,
        ...(opts?.relPath ? { path: opts.relPath } : {}),
        ...(opts?.start !== undefined ? { start: opts.start } : {}),
        ...(opts?.end !== undefined ? { end: opts.end } : {}),
      },
      opts?.onProgress,
    );
    if (got) return { ...got, via: "webrtc" };
  }
  return null;
}

export function buildPortalP2pSiblingUrl(baseEntryUrl: string, siblingName: string): string {
  const idx = baseEntryUrl.lastIndexOf("/");
  if (idx < 0) return baseEntryUrl;
  return `${baseEntryUrl.slice(0, idx + 1)}${encodeURIComponent(siblingName)}`;
}

export function isLoopbackPortalUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
  } catch {
    return /^https?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(url.trim());
  }
}

export function filterVisiblePortalItems(opts: {
  itemsById: Record<string, PortalItem>;
  dismissedIds: Record<string, true>;
  manualIds?: Record<string, true>;
  agent: { deviceId: string; key: string };
  isTauriApp?: boolean;
  localHostId?: string | null;
}): PortalItem[] {
  return Object.values(opts.itemsById)
    .filter((i) => {
      if (i.hostId !== opts.agent.deviceId) return false;
      if (i.agentKey && i.agentKey !== opts.agent.key) return false;
      if (opts.dismissedIds[i.id]) return false;
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
  const { nx, ny } = mapZoomedStagePointer(opts);
  return { nx, ny };
}

/** Computes fitted base image box `(drawLeft, drawTop, drawW, drawH)` inside container `(boxW x boxH)`. */
export function computeContainedRect(
  boxW: number,
  boxH: number,
  imageWidth?: number,
  imageHeight?: number,
): { drawLeft: number; drawTop: number; drawW: number; drawH: number } {
  if (boxW <= 0 || boxH <= 0) return { drawLeft: 0, drawTop: 0, drawW: 1, drawH: 1 };
  let drawLeft = 0;
  let drawTop = 0;
  let drawW = boxW;
  let drawH = boxH;
  if (imageWidth && imageHeight && imageWidth > 0 && imageHeight > 0) {
    const imgAspect = imageWidth / imageHeight;
    const boxAspect = boxW / boxH;
    if (boxAspect > imgAspect) {
      drawH = boxH;
      drawW = boxH * imgAspect;
      drawLeft = (boxW - drawW) / 2;
    } else {
      drawW = boxW;
      drawH = rectHeightScaled(boxW, imgAspect);
      drawTop = (boxH - drawH) / 2;
    }
  }
  return { drawLeft, drawTop, drawW, drawH };
}

function rectHeightScaled(boxW: number, imgAspect: number): number {
  return boxW / imgAspect;
}

/**
 * Maps viewer client coordinates onto `[0, 1]` coordinates of the remote frame with optional
 * stage zoom (`>= 1`) and centered pan offsets (`panX`, `panY` in CSS pixels).
 */
export function mapZoomedStagePointer(opts: {
  clientX: number;
  clientY: number;
  rectLeft: number;
  rectTop: number;
  rectWidth: number;
  rectHeight: number;
  imageWidth?: number;
  imageHeight?: number;
  zoom?: number;
  panX?: number;
  panY?: number;
}): { nx: number; ny: number; inside: boolean } {
  const {
    clientX,
    clientY,
    rectLeft,
    rectTop,
    rectWidth,
    rectHeight,
    imageWidth,
    imageHeight,
    zoom = 1,
    panX = 0,
    panY = 0,
  } = opts;
  if (rectWidth <= 0 || rectHeight <= 0) return { nx: 0.5, ny: 0.5, inside: false };
  const z = Math.max(0.5, zoom);
  const { drawLeft, drawTop, drawW, drawH } = computeContainedRect(rectWidth, rectHeight, imageWidth, imageHeight);
  const px = clientX - rectLeft;
  const py = clientY - rectTop;
  const unzoomX = (px - rectWidth / 2 - panX) / z + rectWidth / 2;
  const unzoomY = (py - rectHeight / 2 - panY) / z + rectHeight / 2;
  const rawNx = (unzoomX - drawLeft) / Math.max(1, drawW);
  const rawNy = (unzoomY - drawTop) / Math.max(1, drawH);
  return {
    nx: Math.min(1, Math.max(0, rawNx)),
    ny: Math.min(1, Math.max(0, rawNy)),
    inside: rawNx >= 0 && rawNx <= 1 && rawNy >= 0 && rawNy <= 1,
  };
}

/** Integrates relative trackpad movement `(dxPx, dyPx)` with pointer acceleration and clamping. */
export function stepTrackpadCursor(
  cur: { nx: number; ny: number },
  dxPx: number,
  dyPx: number,
  stageWidth: number,
  stageHeight: number,
): { nx: number; ny: number } {
  const w = Math.max(120, stageWidth);
  const h = Math.max(120, stageHeight);
  const speed = Math.hypot(dxPx, dyPx);
  const accel = 1 + Math.min(1.8, speed / 18) * 0.55;
  return {
    nx: Math.min(1, Math.max(0, cur.nx + (dxPx * accel) / w)),
    ny: Math.min(1, Math.max(0, cur.ny + (dyPx * accel) / h)),
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
  openSeqById: Record<string, number>;
}

const initialState: PortalState = {
  itemsById: {},
  framesById: {},
  ticketsById: {},
  capsByHost: {},
  windowsByHost: {},
  dismissedIds: {},
  manualIds: {},
  openSeqById: {},
};

let state: PortalState = initialState;
const listeners = new Set<() => void>();
const unsupportedHostVersions = new Map<string, string>();
const PORTAL_WATCHER_GRACE_MS = 120_000;
const hostPortalWatchers = new Map<
  string,
  {
    refs: number;
    disposeTimer?: ReturnType<typeof setTimeout>;
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

export function getPortalWatcherSnapshotForTest(
  hostId: string,
): { refs: number; hasDisposeTimer: boolean } | null {
  const cur = hostPortalWatchers.get(hostId);
  if (!cur) return null;
  return { refs: cur.refs, hasDisposeTimer: cur.disposeTimer !== undefined };
}

export function resetPortalClientStateForTest(): void {
  unsupportedHostVersions.clear();
  for (const w of hostPortalWatchers.values()) {
    if (w.disposeTimer !== undefined) {
      clearTimeout(w.disposeTimer);
      w.disposeTimer = undefined;
    }
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
        const openSeqById = { ...prev.openSeqById };
        if (e.action === "opened") {
          delete dismissedIds[item.id];
          openSeqById[item.id] = (openSeqById[item.id] ?? 0) + 1;
        }
        return {
          ...prev,
          itemsById: { ...prev.itemsById, [item.id]: item },
          dismissedIds,
          openSeqById,
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
      let nextItem: PortalItem | undefined;
      if (existing) {
        const { streamError: _clearedError, ...restExisting } = existing;
        nextItem = {
          ...restExisting,
          ...(frame.url ? { url: frame.url, subtitle: frame.url } : {}),
          ...(frame.title ? { title: frame.title } : {}),
          width: frame.width,
          height: frame.height,
          updatedAt: frame.at,
        };
      }
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
      openSeqById: { ...prev.openSeqById, [res.item.id]: (prev.openSeqById[res.item.id] ?? 0) + 1 },
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

export function capturePortalFrameOnce(
  hostId: string,
  portalId: string,
  opts?: { maxWidth?: number; quality?: number; showCursor?: boolean },
): Promise<PortalFramePayload | null> {
  const key = `${hostId}\0${portalId}`;
  const pending = inflightFrames.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      const res = await rpcCall(
        hostId,
        "portal.frame",
        {
          portalId,
          ...(opts?.maxWidth ? { maxWidth: opts.maxWidth } : {}),
          ...(opts?.quality ? { quality: opts.quality } : {}),
          ...(opts?.showCursor !== undefined ? { showCursor: opts.showCursor } : {}),
        },
        12_000,
      );
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
): Promise<{ url?: string; title?: string; clipboardText?: string }> {
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

export async function updatePortalStreamConfig(
  hostId: string,
  portalId: string,
  cfg: { fps?: number; maxWidth?: number; quality?: number; showCursor?: boolean },
): Promise<void> {
  await sendPortalInput(hostId, portalId, { type: "config", ...cfg }).catch(() => {});
}

export async function syncPortalClipboard(
  hostId: string,
  portalId: string,
  action: "get" | "set",
  text?: string,
): Promise<string | undefined> {
  const res = await sendPortalInput(hostId, portalId, { type: "clipboard", action, ...(text !== undefined ? { text } : {}) });
  return res.clipboardText;
}

export function subscribeAgentPortalUpdates(hostId: string, _agentKey: string): () => void {
  const releaseWatcher = () => {
    const cur = hostPortalWatchers.get(hostId);
    if (!cur) return;
    cur.refs = Math.max(0, cur.refs - 1);
    if (cur.refs <= 0 && cur.disposeTimer === undefined) {
      cur.disposeTimer = setTimeout(() => {
        const latest = hostPortalWatchers.get(hostId);
        if (latest === cur && cur.refs <= 0) {
          hostPortalWatchers.delete(hostId);
          cur.stop();
        }
      }, PORTAL_WATCHER_GRACE_MS);
    }
  };

  const existing = hostPortalWatchers.get(hostId);
  if (existing) {
    if (existing.disposeTimer !== undefined) {
      clearTimeout(existing.disposeTimer);
      existing.disposeTimer = undefined;
    }
    existing.refs += 1;
    return releaseWatcher;
  }

  let alive = true;
  let streamFailed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopRecoveryTimer = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
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
  timer = setInterval(() => {
    if (!alive) return;
    if (isHostPortalUnsupported(hostId)) {
      stopRecoveryTimer();
      return;
    }
    if (streamFailed) {
      void refreshHostPortals(hostId, undefined, false).catch(() => {});
    }
  }, 5000);

  const entry: { refs: number; disposeTimer?: ReturnType<typeof setTimeout>; stop: () => void } = {
    refs: 1,
    stop: () => {
      alive = false;
      stopRecoveryTimer();
      unsub();
    },
  };
  hostPortalWatchers.set(hostId, entry);

  return releaseWatcher;
}

export function subscribePortalFrames(
  hostId: string,
  portalId: string,
  fpsOrOpts: number | { fps?: number; maxWidth?: number; quality?: number; showCursor?: boolean } = 30,
): () => void {
  const opts = typeof fpsOrOpts === "number" ? { fps: fpsOrOpts } : fpsOrOpts;
  const fps = Math.max(1, Math.min(60, opts.fps ?? 30));
  let alive = true;
  let streamLive = false;
  let lastStreamFrameAt = 0;
  let busy = false;

  void capturePortalFrameOnce(hostId, portalId, opts).catch(() => {});

  const unsub = subscribeStream(
    hostId,
    "portal",
    {
      portalId,
      fps,
      ...(opts.maxWidth ? { maxWidth: opts.maxWidth } : {}),
      ...(opts.quality ? { quality: opts.quality } : {}),
      ...(opts.showCursor !== undefined ? { showCursor: opts.showCursor } : {}),
    },
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

  // Fallback RPC poll only kicks in when push stream isn't delivering (e.g. older relay / stalled stream).
  const pollInterval = Math.max(90, Math.round(1000 / Math.max(1, Math.min(12, fps))));
  let lastErrorPollAt = 0;
  const timer = window.setInterval(() => {
    if (!alive || busy) return;
    if (streamLive && (lastStreamFrameAt === 0 || Date.now() - lastStreamFrameAt < 1500)) return;
    if (state.itemsById[portalId]?.streamError) {
      const now = Date.now();
      if (now - lastErrorPollAt < 4000) return;
      lastErrorPollAt = now;
    }
    busy = true;
    void capturePortalFrameOnce(hostId, portalId, opts)
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
