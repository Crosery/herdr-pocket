import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Terminal as XTerm, type IMarker } from "@xterm/xterm";
import {
  isInteractiveResizeActive,
  isSplitMotionActive,
  onInteractiveResizeSettled,
  onSplitMotionSettled,
  proposeGridFast,
} from "../shell/splitMotion";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { LARGE_PUT_LIMITS, PUT_LIMITS, applyRows, configKeySpec, type Agent, type TerminalDisplay } from "@herdr-pocket/protocol";
import { copyToClipboard, detectPlatform, openExternalUrl } from "../lib/bridge";
import { hasFileJumpModifier, openAgentFileTarget } from "../lib/openFileTarget";
import { setConfig, useClientConfig } from "../lib/config";
import { attachTerminalImeBridge, chunkTerminalInputPayload, isImeKeyEvent } from "../lib/terminalIme";
import { isTerminalRendererReady, snapTerminalViewportImmediate } from "../lib/terminalScroll";
import { trackTerminalImeEvent, trackTerminalLayoutJump } from "../lib/uiTelemetry";
import {
  findLinkAtCell,
  findTerminalLinksForBufferLine,
  findWordSelectionAtCell,
  readLogicalLineText,
  resolveBareTerminalFileLink,
} from "../lib/terminalLinks";
import { searchTerminalBuffer, type TerminalSearchMatch } from "../lib/terminalSearch";
import {
  endWorkspaceDrag,
  hasPaneDrag,
  hasPanelDrag,
  hasTabDrag,
  hasWorkspaceDrag,
  readWorkspaceDrag,
  resolveDropPath,
} from "../lib/fileDrag";
import {
  collectDroppedFilesSafe,
  readOsDraggedPaths,
  snapshotDroppedDataTransfer,
} from "../lib/finderDrop";
import {
  buildTerminalFontFamily,
  ensureFontCatalog,
  ensureLocalHostDeviceId,
  ensureTerminalFontLoaded,
  fontCatalogStore,
  localHostIdStore,
  useLocalHostDeviceId,
  useTerminalFontCatalog,
} from "../lib/fonts";
import {
  KITTY_SENTINEL_PREFIX,
  KittyApcSplitter,
  KittyKeyboardState,
  KittyUnicodePlaceholderRewriter,
  clearKittyVirtualPlacementsForScreen,
  collectVirtualSpriteBlocks,
  deleteKittyVirtualPlacements,
  encodeKittyKey,
  encodeRgbaBmpV4,
  lookupKittyVirtualPlacement,
  parseKittyGfxCommand,
  parseOsc66,
  parsePngDimensions,
  parsePocketMemPayload,
  pocketTermImageUrl,
  registerKittyVirtualPlacement,
  shellQuotePath,
  shouldCreateCursorPlacement,
  type KittyBufferCellSample,
  type KittyGfxCommand,
  type KittyVirtualPlacementDims,
} from "../lib/kittyProtocol";
import { logAction, logger } from "../lib/log";
import { native, type LocalTermCloseEvent, type LocalTermSizeEvent } from "../lib/native";
import { registerWebglCounter } from "../lib/perfTelemetry";
import { ingestPortalStreamEvent } from "../lib/portalClient";
import { isDirectConnected, rpcCall, subscribeStream } from "../lib/relay";
import { uploadRemoteFile } from "../lib/uploadLargeFile";
import { settingsStore } from "../lib/store";
import {
  deleteKittyPlacementsScoped,
  erasePlacementsInDisplay,
  erasePlacementsInLine,
  getTerminalThemeSpec,
  resolveTerminalAppearance,
  type TerminalThemeSpec,
} from "../lib/terminalTheme";
import { openSettingsFrame, openWebTab } from "../shell/shellStore";
import { IS_MAC, matchShortcut } from "../shell/shortcuts";
import { useToast } from "./PocketUI";
import "../styles/terminal.css";

const tauriEventPromise = native.available() ? import("@tauri-apps/api/event") : null;

const MAX_ACTIVE_WEBGL = 6;
let activeWebglCount = 0;
registerWebglCounter(() => activeWebglCount);

export function getActiveWebglTerminalCount(): number {
  return activeWebglCount;
}

export { buildTerminalFontFamily };

interface KittyImageAsset {
  id: number;
  url: string;
  width: number;
  height: number;
  needsMeasure?: boolean;
}

interface KittyPlacement {
  key: string;
  alt: boolean;
  imageId: number;
  imageNumber?: number;
  placementId: number;
  bufferY: number;
  endMarker?: IMarker;
  col: number;
  cols: number;
  rows: number;
  zIndex: number;
  explicitCols?: number;
  explicitRows?: number;
  cropX?: number;
  cropY?: number;
  cropW?: number;
  cropH?: number;
  cellOffsetX?: number;
  cellOffsetY?: number;
}

const IS_WINDOWS = detectPlatform() === "windows";
const SYNC_OPEN_BYTES = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68] as const;
const SYNC_CLOSE_BYTES = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c] as const;

function findLastSeqInChunks(chunks: Uint8Array[], seq: readonly number[]): number {
  let offset = 0;
  let lastFound = -1;
  const n = seq.length;
  for (const chunk of chunks) {
    if (chunk.length >= n) {
      for (let i = chunk.length - n; i >= 0; i--) {
        let match = true;
        for (let k = 0; k < n; k++) {
          if (chunk[i + k] !== seq[k]) {
            match = false;
            break;
          }
        }
        if (match) {
          lastFound = offset + i;
          break;
        }
      }
    }
    offset += chunk.length;
  }
  return lastFound;
}

function chunksHaveOpenSyncOutput(chunks: Uint8Array[]): boolean {
  const openPos = findLastSeqInChunks(chunks, SYNC_OPEN_BYTES);
  if (openPos < 0) return false;
  const closePos = findLastSeqInChunks(chunks, SYNC_CLOSE_BYTES);
  return openPos > closePos;
}

interface Osc66Run {
  key: string;
  alt: boolean;
  bufferY: number;
  marker?: IMarker;
  col: number;
  widthCells: number;
  scale: number;
  ratio: number;
  verticalAlign: 0 | 1 | 2;
  text: string;
}

function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function decompressZlibIfNeeded(bytes: Uint8Array, compressed?: "z"): Promise<Uint8Array> {
  if (compressed !== "z" || typeof DecompressionStream === "undefined") return bytes;
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  for (const alg of ["deflate", "deflate-raw"] as const) {
    try {
      const ds = new DecompressionStream(alg);
      const stream = new Blob([ab]).stream().pipeThrough(ds);
      const out = new Uint8Array(await new Response(stream).arrayBuffer());
      if (out.length > 0) return out;
    } catch {
      /* try next deflate container */
    }
  }
  return bytes;
}

function buildBmpBlobUrl(width: number, height: number, bytes: Uint8Array, format: 24 | 32): string | null {
  const bmp = encodeRgbaBmpV4(width, height, bytes, format);
  if (!bmp) return null;
  return URL.createObjectURL(new Blob([bmp.buffer as ArrayBuffer], { type: "image/bmp" }));
}

function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return "image/png";
}

async function decodeKittyAsset(cmd: KittyGfxCommand, rawBytes: Uint8Array, id: number): Promise<KittyImageAsset | null> {
  const bytes = await decompressZlibIfNeeded(rawBytes, cmd.compression);
  if (!bytes.length) return null;

  if (cmd.format === 100) {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const blob = new Blob([copy], { type: sniffImageMime(bytes) });
    const url = URL.createObjectURL(blob);
    const pngDims = parsePngDimensions(bytes);
    if (pngDims) {
      return { id, url, width: pngDims.width, height: pngDims.height };
    }
    const dims = await new Promise<{ w: number; h: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth || 64, h: img.naturalHeight || 64 });
      img.onerror = () => resolve({ w: 64, h: 64 });
      img.src = url;
    });
    return { id, url, width: dims.w, height: dims.h };
  }

  const w = cmd.width ?? 0;
  const h = cmd.height ?? 0;
  const url = buildBmpBlobUrl(w, h, bytes, cmd.format === 24 ? 24 : 32);
  return url ? { id, url, width: w, height: h } : null;
}

interface LocalImageStat {
  urlPath: string;
  width: number;
  height: number;
  mime: string;
}

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

async function localTermFocus(id: string, focused: boolean): Promise<void> {
  if (!native.available()) return;
  await invokeTauri<void>("local_term_focus", { id, focused }).catch(() => {});
}

async function localTermAutoInput(id: string, data: string): Promise<void> {
  await invokeTauri<void>("local_term_auto_input", { id, data });
}

async function localTermStatImage(path: string, deleteAfter: boolean): Promise<LocalImageStat | null> {
  if (!native.available()) return null;
  return invokeTauri<LocalImageStat>("local_term_stat_image", { path, deleteAfter }).catch(() => null);
}

function revokeAssetUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

function hasDropFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt?.types) return false;
  const types = Array.from(dt.types);
  return types.includes("Files") || types.includes("public.file-url");
}

function measureCellCss(hostEl: HTMLElement | null, term: XTerm): [number, number] {
  const screen = hostEl?.querySelector<HTMLElement>(".xterm-screen");
  if (screen && term.cols > 0 && term.rows > 0 && screen.clientWidth > 0 && screen.clientHeight > 0) {
    return [screen.clientWidth / term.cols, screen.clientHeight / term.rows];
  }
  const fs = term.options.fontSize ?? 14;
  const lh = term.options.lineHeight ?? 1.15;
  return [Math.max(5, fs * 0.6), Math.max(10, fs * lh)];
}

/** Centers residual vertical sub-row slack like herdr-app's terminal renderer without detaching overlays. */
function centerScreenVerticalGap(hostEl: HTMLElement | null, term: XTerm): void {
  const screen = hostEl?.querySelector<HTMLElement>(".xterm-screen");
  if (!hostEl || !screen || term.rows <= 0) return;
  const spare = hostEl.clientHeight - screen.clientHeight;
  screen.style.marginTop = spare > 1 ? `${Math.floor(spare / 2)}px` : "";
}

export function TerminalSurface({
  agent,
  active,
  focused = true,
}: {
  agent: Agent;
  active: boolean;
  focused?: boolean;
}) {
  const toast = useToast();
  const termCfg = useClientConfig().terminal;
  const themeChoice = settingsStore.use((s) => s.theme);
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-color-scheme: dark)")?.matches),
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const onChange = (ev: MediaQueryListEvent) => setSystemDark(ev.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  const activeSpec = useMemo<TerminalThemeSpec>(
    () => getTerminalThemeSpec(resolveTerminalAppearance(themeChoice, systemDark)),
    [themeChoice, systemDark],
  );
  const activeSpecRef = useRef<TerminalThemeSpec>(activeSpec);
  activeSpecRef.current = activeSpec;

  useLocalHostDeviceId();
  const fontCatalog = useTerminalFontCatalog();
  const hostRef = useRef<HTMLDivElement>(null);
  const underlayRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const attachWebglRef = useRef<(() => void) | null>(null);
  const detachWebglRef = useRef<(() => void) | null>(null);
  const localConnRef = useRef<string | null>(null);
  const relayPendingRef = useRef<string[]>([]);
  const relayFlushingRef = useRef(false);
  const kittyKeysRef = useRef(new KittyKeyboardState());
  const osc66Ref = useRef<Osc66Run[]>([]);
  const kittyAssetsRef = useRef<Map<number, KittyImageAsset>>(new Map());
  const kittyPlacementsRef = useRef<KittyPlacement[]>([]);
  const kittyVirtualDimsRef = useRef<Map<string, KittyVirtualPlacementDims>>(new Map());
  const kittyDimsByIdRef = useRef<Map<number, { cols: number; rows: number }>>(new Map());
  const overlayNodesRef = useRef<Map<string, { kind: "img" | "clip" | "osc66"; el: HTMLElement; img?: HTMLImageElement; sig: string }>>(new Map());
  const lastResizeSigRef = useRef("");
  const ptyResizeTimerRef = useRef<number | null>(null);
  const appliedVisualSigRef = useRef("");
  const ptySizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastPtyBoxRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const externalSizeOverrideRef = useRef(false);
  const lastObservedBoxRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const resizeHudTimerRef = useRef<number>(0);
  const [resizeHud, setResizeHud] = useState<{ cols: number; rows: number } | null>(null);
  const reattachLocalRef = useRef<(() => void) | null>(null);
  const onActivatedAttachRef = useRef<(() => void) | null>(null);
  const clearOverlaysRef = useRef<(() => void) | null>(null);
  const onMissingVirtualAssetRef = useRef<(() => void) | null>(null);
  const placementSeqRef = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    absRow?: number;
    link?: string;
    isHttpLink?: boolean;
    lineText?: string;
  } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatches, setSearchMatches] = useState<TerminalSearchMatch[]>([]);
  const [searchIdx, setSearchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const lastInputAtRef = useRef(0);
  const lastInputLenRef = useRef(0);
  const lastActivateAtRef = useRef(0);
  const bracketedPasteRef = useRef(false);
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const hoveredOscLinkRef = useRef<string | null>(null);
  const lastLinkOpenRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const ctrlLinkConsumedAtRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const isShellRef = useRef(Boolean(agent.isShell));
  isShellRef.current = Boolean(agent.isShell);
  const wasAtBottomRef = useRef(true);
  const savedOffsetFromBottomRef = useRef(0);
  const pendingViewportSyncRef = useRef(true);

  const paneOwnsFocus = useCallback(() => {
    if (typeof document === "undefined" || !document.hasFocus()) return false;
    if (!activeRef.current || !focusedRef.current) return false;
    const hostEl = hostRef.current;
    if (!hostEl) return false;
    const ae = document.activeElement;
    return ae === termRef.current?.textarea || (ae !== null && hostEl.contains(ae));
  }, []);

  const wrapBracketedPaste = useCallback((text: string): string => {
    const t = termRef.current;
    const bp =
      bracketedPasteRef.current ||
      Boolean((t?.modes as { bracketedPasteMode?: boolean } | undefined)?.bracketedPasteMode);
    return bp ? `\x1b[200~${text}\x1b[201~` : text;
  }, []);

  const activateTerminalLink = useCallback((raw: string, preferInternalWeb = false, hintAbsRow0?: number) => {
    const text = raw.trim();
    if (!text) return;
    const now = Date.now();
    if (lastLinkOpenRef.current.text === text && now - lastLinkOpenRef.current.at < 180) return;
    lastLinkOpenRef.current = { text, at: now };
    if (/^https?:\/\//i.test(text)) {
      if (preferInternalWeb) openWebTab(text);
      else void openExternalUrl(text);
      return;
    }
    if (/^mailto:/i.test(text)) {
      void openExternalUrl(text);
      return;
    }
    const term = termRef.current;
    const resolvedText = term
      ? resolveBareTerminalFileLink(
          term.buffer.active,
          text,
          hintAbsRow0 ?? (term.buffer.active.baseY + term.buffer.active.cursorY),
        )
      : text;
    const opened = openAgentFileTarget(agentRef.current, resolvedText);
    if (!opened && /^file:\/\//i.test(resolvedText)) {
      void openExternalUrl(resolvedText);
    }
  }, []);

  const resolvePointerCell = useCallback(
    (
      hostEl: HTMLElement,
      term: XTerm,
      clientX: number,
      clientY: number,
      clampToGrid = false,
    ): { col: number; absRow: number; link: string | null } | null => {
      const screen = hostEl.querySelector<HTMLElement>(".xterm-screen") ?? hostEl;
      const rect = screen.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || term.cols <= 0 || term.rows <= 0) return null;
      const rawX = clientX - rect.left;
      const rawY = clientY - rect.top;
      if (!clampToGrid && (rawX < 0 || rawY < 0 || rawX >= rect.width || rawY >= rect.height)) return null;
      const clampedX = Math.max(0, Math.min(rect.width - 0.01, rawX));
      const clampedY = Math.max(0, Math.min(rect.height - 0.01, rawY));
      const col = Math.max(0, Math.min(term.cols - 1, Math.floor((clampedX / rect.width) * term.cols)));
      const viewRow = Math.max(0, Math.min(term.rows - 1, Math.floor((clampedY / rect.height) * term.rows)));
      const absRow = term.buffer.active.viewportY + viewRow;
      const detected = findLinkAtCell(term.buffer.active, absRow, col)?.text ?? null;
      return { col, absRow, link: detected ?? hoveredOscLinkRef.current };
    },
    [],
  );

  const fontFamily = useMemo(() => buildTerminalFontFamily(termCfg.fontFamily, fontCatalog), [termCfg.fontFamily, fontCatalog]);
  const lineHeight = useMemo(() => Number((termCfg.lineHeight / 100).toFixed(2)), [termCfg.lineHeight]);
  const cellSizeRef = useRef<[number, number]>([
    Math.max(5, termCfg.fontSize * 0.6),
    Math.max(10, termCfg.fontSize * lineHeight),
  ]);
  const fontSizeRef = useRef(termCfg.fontSize);
  fontSizeRef.current = termCfg.fontSize;

  const refreshCachedCellSize = useCallback((term: XTerm): [number, number] => {
    const next = measureCellCss(hostRef.current, term);
    cellSizeRef.current = next;
    return next;
  }, []);

  const adjustFontSize = useCallback((action: "in" | "out" | "reset") => {
    const spec = configKeySpec("terminal.fontSize");
    const min = spec?.min ?? 10;
    const max = spec?.max ?? 28;
    const def = Number(spec?.default ?? 14);
    const cur = fontSizeRef.current;
    const next = action === "reset" ? def : Math.min(max, Math.max(min, cur + (action === "in" ? 1 : -1)));
    if (next !== cur) {
      void setConfig("terminal.fontSize", next).catch(() => {});
    }
  }, []);

  const sendInput = useCallback(
    async (data: string) => {
      if (!data) return;
      lastInputAtRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
      lastInputLenRef.current = data.length;
      const term = termRef.current;
      if (term) {
        if (term.hasSelection()) term.clearSelection();
        savedOffsetFromBottomRef.current = 0;
        wasAtBottomRef.current = true;
        snapTerminalViewportImmediate(term, true, 0);
      }
      const bpActive =
        bracketedPasteRef.current ||
        Boolean((term?.modes as { bracketedPasteMode?: boolean } | undefined)?.bracketedPasteMode);
      const chunks = chunkTerminalInputPayload(data, bpActive);
      const localConnId = localConnRef.current;
      if (localConnId) {
        try {
          for (let i = 0; i < chunks.length; i++) {
            await native.localTermInput(localConnId, chunks[i]!);
            if (i + 1 < chunks.length) {
              await new Promise((r) => setTimeout(r, 4));
            }
          }
          return;
        } catch {
          // If local attach closed unexpectedly, clear and fall through to relay queue.
          if (localConnRef.current === localConnId) localConnRef.current = null;
        }
      }
      relayPendingRef.current.push(...chunks);
      if (relayFlushingRef.current) return;
      relayFlushingRef.current = true;
      try {
        while (relayPendingRef.current.length > 0) {
          const batch = relayPendingRef.current.shift()!;
          try {
            await rpcCall(agent.deviceId, "terminal.input", { agent: agent.key, data: batch });
          } catch {
            await rpcCall(agent.deviceId, "terminal.send", { agent: agent.key, text: batch, enter: false }).catch(() => {});
          }
          if (relayPendingRef.current.length > 0) {
            await new Promise((r) => setTimeout(r, 4));
          }
        }
      } finally {
        relayFlushingRef.current = false;
      }
    },
    [agent.deviceId, agent.key],
  );

  const sendAutoInput = useCallback(
    async (data: string) => {
      if (!data) return;
      const localConnId = localConnRef.current;
      if (localConnId && native.available()) {
        try {
          await localTermAutoInput(localConnId, data);
          return;
        } catch {
          if (localConnRef.current === localConnId) localConnRef.current = null;
        }
      }
      await rpcCall(agent.deviceId, "terminal.input", { agent: agent.key, data, auto: true }).catch(() => {});
    },
    [agent.deviceId, agent.key],
  );

  const sendFilesToPty = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (!list.length) return;
      const toSend = list.slice(0, PUT_LIMITS.files);
      const smallFiles: File[] = [];
      const largeFiles: File[] = [];
      for (const f of toSend) {
        if (f.size > LARGE_PUT_LIMITS.maxFileBytes) {
          toast(`「${f.name}」超过 ${Math.floor(LARGE_PUT_LIMITS.maxFileBytes / 1024 / 1024)} MB 上限，无法发送`, true);
          continue;
        }
        const isRaster = f.type.startsWith("image/") || /\.(?:jpe?g|png|webp|gif)$/i.test(f.name);
        const streamOverP2p =
          f.size > PUT_LIMITS.fileBytes ||
          (f.size > 512 * 1024 && !isRaster && (!native.available() || isDirectConnected(agent.deviceId)));
        if (streamOverP2p) largeFiles.push(f);
        else smallFiles.push(f);
      }
      try {
        const landedPaths: string[] = [];
        if (smallFiles.length > 0) {
          const putFiles = await Promise.all(
            smallFiles.map(async (f) => {
              const buf = await f.arrayBuffer();
              const bytes = new Uint8Array(buf);
              let bin = "";
              for (let i = 0; i < bytes.length; i += 0x8000) {
                bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
              }
              return { name: f.name || "file", mime: f.type || "application/octet-stream", data: btoa(bin) };
            }),
          );
          const res = await rpcCall(agent.deviceId, "terminal.put", { agent: agent.key, files: putFiles }, 30_000);
          landedPaths.push(...res.paths);
        }
        for (const lf of largeFiles) {
          toast(`正在发送大文件「${lf.name}」…`);
          const path = await uploadRemoteFile(agent.deviceId, agent.key, lf);
          landedPaths.push(path);
        }
        if (landedPaths.length) {
          await sendInput(`${landedPaths.map(shellQuotePath).join(" ")} `);
        }
      } catch (e) {
        toast((e as Error).message, true);
      }
    },
    [agent.deviceId, agent.key, sendInput, toast],
  );

  const currentDisplay = useCallback(
    (_term: XTerm): TerminalDisplay & { cell: [number, number] } => {
      const [cw, ch] = cellSizeRef.current;
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const spec = activeSpecRef.current;
      return {
        fg: spec.fg,
        bg: spec.bg,
        cursor: spec.cursor,
        cell: [Math.max(1, Math.round(cw * dpr)), Math.max(1, Math.round(ch * dpr))],
      };
    },
    [],
  );

  const sendPtyResizeNow = useCallback(
    (term: XTerm, forceReclaim = false) => {
      if (term.cols < 24 || term.rows < 6) return;
      const display = currentDisplay(term);
      const localConnId = localConnRef.current;
      if (forceReclaim) lastResizeSigRef.current = "";
      const sig = `${localConnId ?? "relay"}:${term.cols}x${term.rows}@${display.cell[0]}x${display.cell[1]}@${display.bg}`;
      if (lastResizeSigRef.current === sig) return;
      lastResizeSigRef.current = sig;
      const prevPty = ptySizeRef.current;
      const curBoxW = hostRef.current?.clientWidth ?? 0;
      const curBoxH = hostRef.current?.clientHeight ?? 0;
      const prevPtyBox = lastPtyBoxRef.current;
      ptySizeRef.current = { cols: term.cols, rows: term.rows };
      lastPtyBoxRef.current = { w: curBoxW, h: curBoxH };
      if (!prevPty || prevPty.cols !== term.cols || prevPty.rows !== term.rows) {
        logger.debug("term", "term.resize", { cols: term.cols, rows: term.rows });
        if (
          prevPty &&
          Math.abs(term.cols - prevPty.cols) > 20 &&
          prevPtyBox.w > 0 &&
          Math.abs(curBoxW - prevPtyBox.w) <= 4
        ) {
          trackTerminalLayoutJump({
            prevCols: prevPty.cols,
            prevRows: prevPty.rows,
            cols: term.cols,
            rows: term.rows,
            deltaCols: term.cols - prevPty.cols,
            deltaRows: term.rows - prevPty.rows,
            mode: localConnId ? "local" : "relay",
          });
        }
      }
      if (localConnId) {
        void native.localTermResize(localConnId, term.cols, term.rows, display as unknown as Record<string, unknown>).catch(() => {});
        return;
      }
      void rpcCall(agent.deviceId, "terminal.resize", {
        agent: agent.key,
        cols: term.cols,
        rows: term.rows,
        display,
      }).catch(() => {});
    },
    [agent.deviceId, agent.key, currentDisplay],
  );

  const flushPtyResize = useCallback(
    (term: XTerm, forceReclaim = false) => {
      if (term.cols < 24 || term.rows < 6) return;
      if (forceReclaim || !ptySizeRef.current) {
        if (ptyResizeTimerRef.current !== null) {
          window.clearTimeout(ptyResizeTimerRef.current);
          ptyResizeTimerRef.current = null;
        }
        sendPtyResizeNow(term, forceReclaim);
        return;
      }
      if (ptyResizeTimerRef.current !== null) {
        window.clearTimeout(ptyResizeTimerRef.current);
      }
      ptyResizeTimerRef.current = window.setTimeout(() => {
        ptyResizeTimerRef.current = null;
        const curTerm = termRef.current;
        if (!curTerm || curTerm.cols < 24 || curTerm.rows < 6) return;
        sendPtyResizeNow(curTerm, false);
      }, 90);
    },
    [sendPtyResizeNow],
  );

  useEffect(() => {
    return () => {
      if (ptyResizeTimerRef.current !== null) {
        window.clearTimeout(ptyResizeTimerRef.current);
        ptyResizeTimerRef.current = null;
      }
    };
  }, []);

  const syncResize = useCallback(
    (term: XTerm, forceReclaim = false) => {
      if (
        !activeRef.current ||
        !hostRef.current ||
        hostRef.current.clientWidth < 180 ||
        hostRef.current.clientHeight < 90
      ) {
        return;
      }
      if (externalSizeOverrideRef.current && !forceReclaim && !paneOwnsFocus()) {
        return;
      }
      externalSizeOverrideRef.current = false;
      fitRef.current?.fit();
      refreshCachedCellSize(term);
      centerScreenVerticalGap(hostRef.current, term);
      flushPtyResize(term, forceReclaim);
    },
    [flushPtyResize, paneOwnsFocus, refreshCachedCellSize],
  );

  const paintOverlays = useCallback(() => {
    const term = termRef.current;
    const underlay = underlayRef.current;
    const overlay = overlayRef.current;
    const hostEl = hostRef.current;
    if (!term || !overlay || !hostEl) return;

    if (
      kittyPlacementsRef.current.length === 0 &&
      kittyVirtualDimsRef.current.size === 0 &&
      kittyAssetsRef.current.size === 0 &&
      osc66Ref.current.length === 0
    ) {
      if (overlayNodesRef.current.size > 0) overlayNodesRef.current.clear();
      if (underlay && underlay.childElementCount > 0) underlay.replaceChildren();
      if (overlay.childElementCount > 0) overlay.replaceChildren();
      return;
    }

    const screen = hostEl.querySelector<HTMLElement>(".xterm-screen");
    if (screen) {
      if (underlay && underlay.parentElement !== screen) {
        screen.insertBefore(underlay, screen.firstChild);
      }
      if (overlay.parentElement !== screen) {
        screen.appendChild(overlay);
      }
    }

    const [cellW, cellH] = measureCellCss(hostEl, term);
    cellSizeRef.current = [cellW, cellH];
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const buf = term.buffer.active;
    const curAlt = buf === term.buffer.alternate;
    const topY = buf.viewportY;
    const botY = topY + term.rows;
    const maxBufLines = buf.length;

    // Drop items scrolled out of buffer retention cleanly.
    if (osc66Ref.current.some((r) => !r.alt && r.marker && (r.marker.isDisposed || r.marker.line < 0))) {
      osc66Ref.current = osc66Ref.current.filter((r) => {
        if (!r.alt && r.marker && (r.marker.isDisposed || r.marker.line < 0)) {
          r.marker.dispose();
          return false;
        }
        return true;
      });
    }
    if (osc66Ref.current.length > 0 && osc66Ref.current[0]!.bufferY < buf.length - (term.options.scrollback ?? 1500) - term.rows) {
      osc66Ref.current = osc66Ref.current.filter((r) => r.alt || r.bufferY >= Math.max(0, maxBufLines - 1500));
    }

    const nodeMap = overlayNodesRef.current;
    const seenKeys = new Set<string>();
    const orderedUnderlayEls: HTMLElement[] = [];
    const orderedOverlayEls: HTMLElement[] = [];
    const pushLayeredEl = (zNum: number, el: HTMLElement) => {
      if (zNum < 0 && underlay) orderedUnderlayEls.push(el);
      else orderedOverlayEls.push(el);
    };

    const createKittyImg = (): HTMLImageElement => {
      const img = document.createElement("img");
      img.className = "tp-kitty-img";
      img.alt = "";
      img.decoding = "sync";
      img.loading = "eager";
      return img;
    };

    const bindMeasure = (img: HTMLImageElement, asset: KittyImageAsset, placement?: KittyPlacement) => {
      if (asset.needsMeasure) {
        img.onload = () => {
          asset.needsMeasure = false;
          if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            asset.width = img.naturalWidth;
            asset.height = img.naturalHeight;
            if (placement) {
              const cellPxW = Math.max(1, cellW * dpr);
              const cellPxH = Math.max(1, cellH * dpr);
              if (placement.explicitCols === undefined) {
                placement.cols = Math.max(1, Math.ceil(asset.width / cellPxW));
              }
              if (placement.explicitRows === undefined) {
                placement.rows = Math.max(1, Math.ceil(asset.height / cellPxH));
              }
            }
            requestAnimationFrame(paintOverlays);
          }
        };
      } else if (img.onload) {
        img.onload = null;
      }
    };

    const upsertImgNode = (
      key: string,
      asset: KittyImageAsset,
      left: number,
      top: number,
      width: number,
      height: number,
      zNum: number,
      zIndex: string,
      placement?: KittyPlacement,
    ) => {
      const sig = `img|${asset.url}|${left}|${top}|${width}|${height}|${zIndex}|${zNum < 0 ? "u" : "o"}|${asset.needsMeasure ? 1 : 0}`;
      const existing = nodeMap.get(key);
      if (existing && existing.kind === "img" && existing.img) {
        if (existing.sig !== sig) {
          if (existing.img.getAttribute("src") !== asset.url) existing.img.src = asset.url;
          existing.img.style.left = `${left}px`;
          existing.img.style.top = `${top}px`;
          existing.img.style.width = `${width}px`;
          existing.img.style.height = `${height}px`;
          existing.img.style.zIndex = zIndex;
          bindMeasure(existing.img, asset, placement);
          existing.sig = sig;
        }
        seenKeys.add(key);
        pushLayeredEl(zNum, existing.el);
        return;
      }
      const img = createKittyImg();
      img.src = asset.url;
      img.style.left = `${left}px`;
      img.style.top = `${top}px`;
      img.style.width = `${width}px`;
      img.style.height = `${height}px`;
      img.style.zIndex = zIndex;
      bindMeasure(img, asset, placement);
      nodeMap.set(key, { kind: "img", el: img, img, sig });
      seenKeys.add(key);
      pushLayeredEl(zNum, img);
    };

    const upsertClipNode = (
      key: string,
      asset: KittyImageAsset,
      clipLeft: number,
      clipTop: number,
      clipWidth: number,
      clipHeight: number,
      zNum: number,
      zIndex: string,
      imgLeft: number,
      imgTop: number,
      imgWidth: number,
      imgHeight: number,
      placement?: KittyPlacement,
    ) => {
      const sig = `clip|${asset.url}|${clipLeft}|${clipTop}|${clipWidth}|${clipHeight}|${zIndex}|${zNum < 0 ? "u" : "o"}|${imgLeft}|${imgTop}|${imgWidth}|${imgHeight}|${asset.needsMeasure ? 1 : 0}`;
      const existing = nodeMap.get(key);
      if (existing && existing.kind === "clip" && existing.img) {
        if (existing.sig !== sig) {
          existing.el.style.left = `${clipLeft}px`;
          existing.el.style.top = `${clipTop}px`;
          existing.el.style.width = `${clipWidth}px`;
          existing.el.style.height = `${clipHeight}px`;
          existing.el.style.zIndex = zIndex;
          if (existing.img.getAttribute("src") !== asset.url) existing.img.src = asset.url;
          existing.img.style.left = `${imgLeft}px`;
          existing.img.style.top = `${imgTop}px`;
          existing.img.style.width = `${imgWidth}px`;
          existing.img.style.height = `${imgHeight}px`;
          bindMeasure(existing.img, asset, placement);
          existing.sig = sig;
        }
        seenKeys.add(key);
        pushLayeredEl(zNum, existing.el);
        return;
      }
      const clip = document.createElement("div");
      clip.className = "tp-kitty-clip";
      clip.style.left = `${clipLeft}px`;
      clip.style.top = `${clipTop}px`;
      clip.style.width = `${clipWidth}px`;
      clip.style.height = `${clipHeight}px`;
      clip.style.zIndex = zIndex;
      const img = createKittyImg();
      img.src = asset.url;
      img.style.left = `${imgLeft}px`;
      img.style.top = `${imgTop}px`;
      img.style.width = `${imgWidth}px`;
      img.style.height = `${imgHeight}px`;
      bindMeasure(img, asset, placement);
      clip.appendChild(img);
      nodeMap.set(key, { kind: "clip", el: clip, img, sig });
      seenKeys.add(key);
      pushLayeredEl(zNum, clip);
    };

    if (kittyPlacementsRef.current.length > 0) {
      const keptPlacements: KittyPlacement[] = [];
      let changedPlacements = false;
      for (const p of kittyPlacementsRef.current) {
        if (!p.alt && p.endMarker) {
          if (p.endMarker.isDisposed || p.endMarker.line < 0) {
            p.endMarker.dispose();
            changedPlacements = true;
            continue;
          }
          if (p.endMarker.line !== p.bufferY) {
            p.bufferY = p.endMarker.line;
          }
        }
        keptPlacements.push(p);
      }
      if (changedPlacements) {
        kittyPlacementsRef.current = keptPlacements;
      }
    }

    for (const p of kittyPlacementsRef.current) {
      if (p.alt !== curAlt || p.bufferY + p.rows <= topY || p.bufferY >= botY) continue;
      const asset = kittyAssetsRef.current.get(p.imageId);
      if (!asset) continue;
      const key = `kp:${p.key}`;
      const left = Math.round(p.col * cellW + (p.cellOffsetX ?? 0) / dpr);
      const top = Math.round((p.bufferY - topY) * cellH + (p.cellOffsetY ?? 0) / dpr);
      const isDirectPixel =
        p.explicitCols === undefined &&
        p.explicitRows === undefined &&
        !asset.needsMeasure &&
        asset.width > 0 &&
        asset.height > 0;
      const directSrcW = isDirectPixel ? (p.cropW && p.cropW > 0 ? p.cropW : asset.width) : 0;
      const directSrcH = isDirectPixel ? (p.cropH && p.cropH > 0 ? p.cropH : asset.height) : 0;
      const boxW = isDirectPixel ? Math.max(1, Math.round(directSrcW / dpr)) : Math.max(cellW, Math.round(p.cols * cellW));
      const boxH = isDirectPixel ? Math.max(1, Math.round(directSrcH / dpr)) : Math.max(cellH, Math.round(p.rows * cellH));
      const zNum = p.zIndex;
      const zIndex = zNum < 0 ? String(Math.max(1, 100 + Math.max(-99, zNum))) : String(Math.max(1, 5 + zNum));

      const hasExplicitCrop =
        !asset.needsMeasure &&
        (p.cropX !== undefined || p.cropY !== undefined || p.cropW !== undefined || p.cropH !== undefined);
      if (hasExplicitCrop && asset.width > 0 && asset.height > 0) {
        const sx = Math.max(0, Math.min(asset.width - 1, p.cropX ?? 0));
        const sy = Math.max(0, Math.min(asset.height - 1, p.cropY ?? 0));
        const maxSw = Math.max(1, asset.width - sx);
        const maxSh = Math.max(1, asset.height - sy);
        const sw = Math.max(1, Math.min(maxSw, p.cropW && p.cropW > 0 ? p.cropW : maxSw));
        const sh = Math.max(1, Math.min(maxSh, p.cropH && p.cropH > 0 ? p.cropH : maxSh));
        if (sx > 0 || sy > 0 || sw < asset.width || sh < asset.height) {
          const scale = Math.min(boxW / sw, boxH / sh);
          const clipW = Math.min(boxW, Math.max(1, Math.round(sw * scale)));
          const clipH = Math.min(boxH, Math.max(1, Math.round(sh * scale)));
          upsertClipNode(
            key,
            asset,
            left,
            top,
            clipW,
            clipH,
            zNum,
            zIndex,
            -Math.round(sx * scale),
            -Math.round(sy * scale),
            Math.max(1, Math.round(asset.width * scale)),
            Math.max(1, Math.round(asset.height * scale)),
            p,
          );
          continue;
        }
      }

      upsertImgNode(key, asset, left, top, boxW, boxH, zNum, zIndex, p);
    }

    if (kittyAssetsRef.current.size > 0 || kittyVirtualDimsRef.current.size > 0) {
      const scratch = buf.getNullCell();
      let cachedAbsY = -1;
      let cachedLine: ReturnType<typeof buf.getLine> | undefined;
      const virtualBlocks = collectVirtualSpriteBlocks(topY, botY, term.cols, (absY, x, out: KittyBufferCellSample) => {
        if (absY !== cachedAbsY) {
          cachedAbsY = absY;
          cachedLine = buf.getLine(absY);
        }
        if (!cachedLine) return false;
        const cell = cachedLine.getCell(x, scratch);
        if (!cell) return false;
        const chars = cell.getChars();
        if (!chars.startsWith(KITTY_SENTINEL_PREFIX)) return false;
        out.chars = chars;
        out.width = cell.getWidth();
        if (cell.isFgRGB()) {
          out.fgMode = "rgb";
          out.fgColor = cell.getFgColor();
        } else if (cell.isFgPalette()) {
          out.fgMode = "palette";
          out.fgColor = cell.getFgColor();
        } else {
          out.fgMode = "default";
          out.fgColor = 0;
        }
        const rawCell = cell as unknown as {
          hasExtendedAttrs?: () => number | boolean;
          extended?: { underlineColor?: number };
          isUnderlineColorDefault?: () => boolean;
          isUnderlineColorRGB?: () => boolean;
          isUnderlineColorPalette?: () => boolean;
          getUnderlineColor?: () => number;
        };
        let placementId = 0;
        if (
          rawCell.hasExtendedAttrs?.() &&
          rawCell.extended &&
          rawCell.extended.underlineColor !== undefined &&
          rawCell.extended.underlineColor !== -1 &&
          !rawCell.isUnderlineColorDefault?.() &&
          (rawCell.isUnderlineColorRGB?.() || rawCell.isUnderlineColorPalette?.())
        ) {
          placementId = rawCell.getUnderlineColor?.() ?? 0;
        }
        out.placementId = placementId;
        return true;
      });

      let missingVirtual = false;
      const kvOcc = new Map<string, number>();
      for (const block of virtualBlocks) {
        const asset = kittyAssetsRef.current.get(block.imageId);
        if (!asset) {
          missingVirtual = true;
          continue;
        }
        const vdims = lookupKittyVirtualPlacement(kittyVirtualDimsRef.current, block.imageId, block.placementId, curAlt);
        const fallbackDims = kittyDimsByIdRef.current.get(block.imageId);
        const fullCols = Math.max(vdims?.cols ?? fallbackDims?.cols ?? 0, block.startTileCol + block.cols, 1);
        const fullRows = Math.max(vdims?.rows ?? fallbackDims?.rows ?? 0, block.startTileRow + block.rows, 1);
        const zNum = vdims?.zIndex ?? 0;
        const zIndex = zNum < 0 ? String(Math.max(1, 100 + Math.max(-99, zNum))) : String(Math.max(1, 5 + zNum));

        const baseKey = `kv:${block.imageId}:${block.placementId}:${block.startX}:${block.startTileCol}:${block.startAbsY - block.startTileRow}`;
        const occ = kvOcc.get(baseKey) ?? 0;
        kvOcc.set(baseKey, occ + 1);
        const key = `${baseKey}:${occ}`;

        const visLeft = Math.round(block.startX * cellW);
        const visTop = Math.round((block.startAbsY - topY) * cellH);
        const visWidth = Math.max(1, Math.round(block.cols * cellW));
        const visHeight = Math.max(1, Math.round(block.rows * cellH));
        const fullWidth = Math.max(1, Math.round(fullCols * cellW));
        const fullHeight = Math.max(1, Math.round(fullRows * cellH));

        const isCropped =
          block.startTileCol > 0 ||
          block.startTileRow > 0 ||
          block.cols < fullCols ||
          block.rows < fullRows;

        if (isCropped) {
          upsertClipNode(
            key,
            asset,
            visLeft,
            visTop,
            visWidth,
            visHeight,
            zNum,
            zIndex,
            -Math.round(block.startTileCol * cellW),
            -Math.round(block.startTileRow * cellH),
            fullWidth,
            fullHeight,
          );
        } else {
          upsertImgNode(key, asset, visLeft, visTop, fullWidth, fullHeight, zNum, zIndex);
        }
      }
      if (missingVirtual) {
        onMissingVirtualAssetRef.current?.();
      }
    }

    const fs = term.options.fontSize ?? 14;
    const ff = term.options.fontFamily ?? fontFamily;
    const fw = String(term.options.fontWeight ?? 400);
    const fg = activeSpecRef.current.fg;
    for (const r of osc66Ref.current) {
      if (!r.alt && r.marker) {
        if (r.marker.isDisposed || r.marker.line < 0) continue;
        r.bufferY = r.marker.line;
      }
      if (r.alt !== curAlt || r.bufferY < topY || r.bufferY >= botY) continue;
      const key = `o66:${r.key}`;
      const left = Math.round(r.col * cellW);
      const top = Math.round((r.bufferY - topY) * cellH);
      const minW = Math.round(r.widthCells * cellW);
      const h = Math.round(r.scale * cellH);
      const fSize = Number((fs * r.scale * r.ratio).toFixed(2));
      const sig = `o66|${r.text}|${left}|${top}|${minW}|${h}|${ff}|${fSize}|${fw}|${fg}`;
      const existing = nodeMap.get(key);
      if (existing && existing.kind === "osc66") {
        if (existing.sig !== sig) {
          existing.el.textContent = r.text;
          existing.el.style.left = `${left}px`;
          existing.el.style.top = `${top}px`;
          existing.el.style.minWidth = `${minW}px`;
          existing.el.style.height = `${h}px`;
          existing.el.style.fontFamily = ff;
          existing.el.style.fontSize = `${fSize}px`;
          existing.el.style.fontWeight = fw;
          existing.el.style.color = fg;
          existing.sig = sig;
        }
        seenKeys.add(key);
        orderedOverlayEls.push(existing.el);
        continue;
      }
      const span = document.createElement("div");
      span.className = "tp-osc66-run";
      span.textContent = r.text;
      span.style.left = `${left}px`;
      span.style.top = `${top}px`;
      span.style.minWidth = `${minW}px`;
      span.style.height = `${h}px`;
      span.style.fontFamily = ff;
      span.style.fontSize = `${fSize}px`;
      span.style.fontWeight = fw;
      span.style.color = fg;
      span.style.lineHeight = "1";
      nodeMap.set(key, { kind: "osc66", el: span, sig });
      seenKeys.add(key);
      orderedOverlayEls.push(span);
    }

    for (const [key, entry] of nodeMap) {
      if (!seenKeys.has(key)) {
        nodeMap.delete(key);
        entry.el.remove();
      }
    }

    const syncContainerChildren = (container: HTMLElement | null, wantedEls: HTMLElement[]) => {
      if (!container) return;
      const children = container.children;
      let sameOrder = children.length === wantedEls.length;
      if (sameOrder) {
        for (let i = 0; i < wantedEls.length; i++) {
          if (children[i] !== wantedEls[i]) {
            sameOrder = false;
            break;
          }
        }
      }
      if (!sameOrder) {
        for (let i = 0; i < wantedEls.length; i++) {
          const wanted = wantedEls[i]!;
          const current = container.children[i] ?? null;
          if (current !== wanted) {
            container.insertBefore(wanted, current);
          }
        }
        while (container.childElementCount > wantedEls.length) {
          container.lastElementChild?.remove();
        }
      }
    };

    syncContainerChildren(underlay ?? null, orderedUnderlayEls);
    syncContainerChildren(overlay, orderedOverlayEls);
    if (orderedUnderlayEls.length > 0) {
      detachWebglRef.current?.();
    } else if (activeRef.current) {
      attachWebglRef.current?.();
    }
  }, [fontFamily]);

  const visualSig = useCallback(
    (familyCss: string) =>
      `${familyCss}|${termCfg.fontSize}|${lineHeight}|${termCfg.fontWeight}|${termCfg.cursorBlink ? 1 : 0}|${activeSpec.fg}|${activeSpec.bg}|${activeSpec.cursor}|${activeSpec.minimumContrastRatio}`,
    [activeSpec.bg, activeSpec.cursor, activeSpec.fg, activeSpec.minimumContrastRatio, lineHeight, termCfg.cursorBlink, termCfg.fontSize, termCfg.fontWeight],
  );

  // Keep font faces, theme colors, texture atlas, and overlay coordinates synchronized with live changes.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let cancelled = false;
    const apply = (familyCss: string) => {
      if (cancelled || termRef.current !== term) return;
      const nextSig = visualSig(familyCss);
      if (appliedVisualSigRef.current === nextSig) return;
      appliedVisualSigRef.current = nextSig;
      term.options.fontFamily = familyCss;
      term.options.fontSize = termCfg.fontSize;
      term.options.lineHeight = lineHeight;
      term.options.fontWeight = termCfg.fontWeight as 300 | 400 | 500 | 600 | 700;
      term.options.fontWeightBold = Math.min(900, Math.max(700, termCfg.fontWeight + 200)) as 700 | 800 | 900;
      term.options.cursorBlink = termCfg.cursorBlink;
      term.options.customGlyphs = true;
      term.options.theme = activeSpec.theme;
      term.options.minimumContrastRatio = activeSpec.minimumContrastRatio;
      for (const entry of overlayNodesRef.current.values()) {
        if (entry.kind === "osc66") {
          entry.el.style.color = activeSpec.fg;
        }
      }
      term.clearTextureAtlas?.();
      term.refresh(0, Math.max(0, term.rows - 1));
      syncResize(term);
      requestAnimationFrame(paintOverlays);
    };
    apply(fontFamily);
    void ensureTerminalFontLoaded(termCfg.fontFamily, termCfg.fontWeight >= 600).then((loaded) => {
      if (loaded && !cancelled && termRef.current === term) {
        apply(buildTerminalFontFamily(termCfg.fontFamily, fontCatalogStore.get()));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeSpec, fontFamily, lineHeight, paintOverlays, syncResize, termCfg.cursorBlink, termCfg.fontFamily, termCfg.fontSize, termCfg.fontWeight, visualSig]);

  useEffect(() => {
    const hostEl = hostRef.current;
    if (!hostEl) return;

    let alive = true;
    let sawRaw = false;
    let fallbackLines: string[] = [];
    const splitter = new KittyApcSplitter();
    const placeholderRewriter = new KittyUnicodePlaceholderRewriter();
    const textDecoder = new TextDecoder("utf-8", { fatal: false });
    let pendingBytes: Uint8Array[] = [];
    let flushRaf = 0;

    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: termCfg.cursorBlink,
      cursorStyle: "block",
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      fontFamily,
      fontSize: termCfg.fontSize,
      lineHeight,
      fontWeight: termCfg.fontWeight as 300 | 400 | 500 | 600 | 700,
      fontWeightBold: Math.min(900, Math.max(700, termCfg.fontWeight + 200)) as 700 | 800 | 900,
      scrollback: 1500,
      minimumContrastRatio: activeSpec.minimumContrastRatio,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      theme: activeSpec.theme,
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (ev, text) => {
          if (ev.button !== 0 || !hasFileJumpModifier(ev) || term.hasSelection()) return;
          activateTerminalLink(text, ev.altKey);
        },
        hover: (_ev, text) => {
          hoveredOscLinkRef.current = text;
        },
        leave: () => {
          hoveredOscLinkRef.current = null;
        },
      },
      windowOptions: {
        getWinSizePixels: true,
        getCellSizePixels: true,
        getWinSizeChars: true,
      },
    });
    const fitAddon = new FitAddon();
    const unicode11 = new Unicode11Addon();
    const imageAddon = new ImageAddon({
      enableSizeReports: true,
      storageLimit: 32,
      showPlaceholder: true,
      sixelSupport: true,
      iipSupport: true,
    });
    term.loadAddon(fitAddon);
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
    term.loadAddon(imageAddon);

    const isAlt = () => term.buffer.active === term.buffer.alternate;
    const numParam = (p: number | number[] | undefined, def = 0): number =>
      typeof p === "number" ? p : Array.isArray(p) ? (p[0] ?? def) : def;

    termRef.current = term;
    fitRef.current = fitAddon;
    const kittyKeys = kittyKeysRef.current;
    kittyKeys.reset();

    hostEl.dataset.ready = "false";
    let initialReadyDone = false;
    let initialAttachPending = false;
    const markHostReady = () => {
      if (initialReadyDone) return;
      initialReadyDone = true;
      initialAttachPending = false;
      hostEl.dataset.ready = "true";
    };
    let hostReadyFallback = 0;
    term.open(hostEl);
    appliedVisualSigRef.current = visualSig(fontFamily);
    fitAddon.fit();
    refreshCachedCellSize(term);
    centerScreenVerticalGap(hostEl, term);
    bracketedPasteRef.current = false;

    // GPU WebGL rendering runs strictly on visible, active panes (up to MAX_ACTIVE_WEBGL)
    // and detaches immediately when hidden or underlaid so WKWebView never retains stale atlases.
    const detachWebgl = () => {
      const addon = webglRef.current;
      if (!addon) return;
      webglRef.current = null;
      activeWebglCount = Math.max(0, activeWebglCount - 1);
      try {
        addon.dispose();
      } catch {
        // ignore already disposed addon
      }
    };
    const attachWebgl = () => {
      if (!alive || termRef.current !== term) return;
      if (!activeRef.current || (underlayRef.current?.childElementCount ?? 0) > 0) {
        detachWebgl();
        return;
      }
      if (webglRef.current || activeWebglCount >= MAX_ACTIVE_WEBGL) return;
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          if (webglRef.current === addon) detachWebgl();
        });
        term.loadAddon(addon);
        webglRef.current = addon;
        activeWebglCount += 1;
      } catch {
        // Environments without WebGL2 fall back cleanly to xterm's DOM renderer.
      }
    };
    attachWebglRef.current = attachWebgl;
    detachWebglRef.current = detachWebgl;
    attachWebgl();

    // Ensure OS / Herdr / Nerd fonts load asynchronously right after opening without flashing an already-ready atlas.
    const fontWeightSpec = termCfg.fontWeight >= 600 ? 600 : 400;
    const wasFontReady =
      typeof document !== "undefined" &&
      Boolean(document.fonts?.check?.(`${fontWeightSpec} ${termCfg.fontSize}px ${fontFamily}`));
    void ensureFontCatalog().then(() => ensureTerminalFontLoaded(termCfg.fontFamily, termCfg.fontWeight >= 600)).then((loaded) => {
      if (loaded && alive && termRef.current === term) {
        const nextFamily = buildTerminalFontFamily(termCfg.fontFamily, fontCatalogStore.get());
        const nextSig = visualSig(nextFamily);
        if (!wasFontReady || appliedVisualSigRef.current !== nextSig) {
          appliedVisualSigRef.current = nextSig;
          term.options.fontFamily = nextFamily;
          term.clearTextureAtlas?.();
          term.refresh(0, Math.max(0, term.rows - 1));
          syncResize(term);
          requestAnimationFrame(paintOverlays);
        }
      }
    });

    let rafOverlay = 0;
    let overlayMicroQueued = false;
    let didOrphanNudge = false;
    let orphanNudgeTimer = 0;
    let nextImgId = 1;
    let lastUnnumberedImgId: number | null = null;
    const imageNumberToId = new Map<number, number>();
    const pendingKittyAssets = new Map<number, Promise<KittyImageAsset | null>>();
    const scheduleOrphanVirtualNudge = () => {
      if (didOrphanNudge || orphanNudgeTimer || !alive || !localConnRef.current) return;
      orphanNudgeTimer = window.setTimeout(() => {
        orphanNudgeTimer = 0;
        if (!alive || didOrphanNudge || termRef.current !== term) return;
        const buf = term.buffer.active;
        const scratch = buf.getNullCell();
        const blocks = collectVirtualSpriteBlocks(buf.viewportY, buf.viewportY + term.rows, term.cols, (absY, x, out) => {
          const line = buf.getLine(absY);
          const cell = line?.getCell(x, scratch);
          if (!cell) return false;
          const chars = cell.getChars();
          if (!chars.startsWith(KITTY_SENTINEL_PREFIX)) return false;
          out.chars = chars;
          out.width = cell.getWidth();
          if (cell.isFgRGB()) {
            out.fgMode = "rgb";
            out.fgColor = cell.getFgColor();
          } else if (cell.isFgPalette()) {
            out.fgMode = "palette";
            out.fgColor = cell.getFgColor();
          } else {
            out.fgMode = "default";
            out.fgColor = 0;
          }
          out.placementId = 0;
          return true;
        });
        const hasMissing = blocks.some(
          (b) => !kittyAssetsRef.current.has(b.imageId) && !pendingKittyAssets.has(b.imageId),
        );
        if (!hasMissing) return;
        didOrphanNudge = true;
        const origCols = term.cols;
        const origRows = term.rows;
        const nudgeCols = origCols > 22 ? origCols - 1 : origCols + 1;
        const disp = currentDisplay(term) as unknown as Record<string, unknown>;
        const connId = localConnRef.current;
        if (connId && native.available()) {
          void native.localTermResize(connId, nudgeCols, origRows, disp).catch(() => {});
          window.setTimeout(() => {
            if (!alive || termRef.current !== term || localConnRef.current !== connId) return;
            void native.localTermResize(connId, origCols, origRows, currentDisplay(term) as unknown as Record<string, unknown>).catch(() => {});
          }, 24);
        }
      }, 90);
    };
    onMissingVirtualAssetRef.current = scheduleOrphanVirtualNudge;

    const hasOverlayContent = () =>
      kittyPlacementsRef.current.length > 0 ||
      kittyVirtualDimsRef.current.size > 0 ||
      kittyAssetsRef.current.size > 0 ||
      osc66Ref.current.length > 0 ||
      (underlayRef.current?.childElementCount ?? 0) > 0 ||
      (overlayRef.current?.childElementCount ?? 0) > 0;

    const scheduleOverlay = () => {
      if (!hasOverlayContent()) return;
      if (rafOverlay || overlayMicroQueued) return;
      rafOverlay = requestAnimationFrame(() => {
        rafOverlay = 0;
        if (alive && termRef.current === term) paintOverlays();
      });
    };

    const flushOverlaySoon = () => {
      if (!hasOverlayContent()) {
        if (!didOrphanNudge && kittyAssetsRef.current.size === 0) {
          scheduleOrphanVirtualNudge();
        }
        return;
      }
      if (overlayMicroQueued) return;
      overlayMicroQueued = true;
      queueMicrotask(() => {
        overlayMicroQueued = false;
        if (!alive || termRef.current !== term) return;
        if (rafOverlay) {
          cancelAnimationFrame(rafOverlay);
          rafOverlay = 0;
        }
        paintOverlays();
      });
    };

    const syncBottomSticky = () => {
      if (
        !initialReadyDone ||
        !activeRef.current ||
        hostEl.clientHeight <= 40 ||
        pendingViewportSyncRef.current ||
        !isTerminalRendererReady(term)
      ) {
        return;
      }
      const buf = term.buffer.active;
      if (buf === term.buffer.normal) {
        const atBottom = buf.viewportY >= buf.baseY - 1;
        wasAtBottomRef.current = atBottom;
        savedOffsetFromBottomRef.current = atBottom ? 0 : Math.max(0, buf.baseY - buf.viewportY);
      } else {
        wasAtBottomRef.current = true;
        savedOffsetFromBottomRef.current = 0;
      }
    };
    const dispScroll = term.onScroll(() => {
      syncBottomSticky();
      scheduleOverlay();
    });
    const dispRender = term.onRender(() => {
      if (pendingViewportSyncRef.current && activeRef.current) {
        if (snapTerminalViewportImmediate(term, wasAtBottomRef.current, savedOffsetFromBottomRef.current)) {
          pendingViewportSyncRef.current = false;
        }
      }
      scheduleOverlay();
    });
    const dispWriteParsed = term.onWriteParsed(() => {
      if (wasAtBottomRef.current && term.buffer.active === term.buffer.normal) {
        snapTerminalViewportImmediate(term, true, 0);
      }
      syncBottomSticky();
      flushOverlaySoon();
    });
    const clearOverlayMarkers = (altOnly = false) => {
      osc66Ref.current = osc66Ref.current.filter((r) => {
        if (altOnly && !r.alt) return true;
        r.marker?.dispose();
        return false;
      });
      kittyPlacementsRef.current = kittyPlacementsRef.current.filter((p) => {
        if (altOnly && !p.alt) return true;
        p.endMarker?.dispose();
        return false;
      });
    };

    const dispBuf = term.buffer.onBufferChange(() => {
      if (!isAlt()) {
        clearOverlayMarkers(true);
      }
      scheduleOverlay();
    });

    let invalidateInFlightAnchors = () => {};
    const clearAllTerminalOverlays = (altOnly = false) => {
      if (!altOnly) invalidateInFlightAnchors();
      clearOverlayMarkers(altOnly);
      if (!altOnly) {
        kittyVirtualDimsRef.current.clear();
        kittyDimsByIdRef.current.clear();
        imageNumberToId.clear();
        lastUnnumberedImgId = null;
        for (const a of kittyAssetsRef.current.values()) revokeAssetUrl(a.url);
        kittyAssetsRef.current.clear();
        placeholderRewriter.reset();
        if (underlayRef.current && underlayRef.current.childElementCount > 0) underlayRef.current.replaceChildren();
        if (overlayRef.current && overlayRef.current.childElementCount > 0) overlayRef.current.replaceChildren();
      }
      flushOverlaySoon();
    };
    clearOverlaysRef.current = () => clearAllTerminalOverlays(false);

    // Kitty Text Sizing Protocol (OSC 66)
    const dispOsc66 = term.parser.registerOscHandler(66, (data) => {
      const parsed = parseOsc66(data);
      if (!parsed) return false;
      const buf = term.buffer.active;
      const curAlt = buf === term.buffer.alternate;
      const absY = buf.baseY + buf.cursorY;
      const col = buf.cursorX;
      const marker = !curAlt ? term.registerMarker(0) : undefined;
      osc66Ref.current.push({
        key: `o66-${absY}-${col}-${osc66Ref.current.length}`,
        alt: curAlt,
        bufferY: absY,
        ...(marker && marker.line >= 0 ? { marker } : {}),
        col,
        widthCells: parsed.cellsWide,
        scale: parsed.scale,
        ratio: parsed.ratio,
        verticalAlign: parsed.verticalAlign,
        text: parsed.text,
      });
      if (osc66Ref.current.length > 400) {
        const trimmed = osc66Ref.current.splice(0, osc66Ref.current.length - 400);
        for (const t of trimmed) t.marker?.dispose();
      }
      // Advance xterm cursor cleanly across the reserved columns.
      const advance = Math.max(1, Math.min(term.cols - col, parsed.cellsWide));
      term.write(" ".repeat(advance));
      scheduleOverlay();
      return true;
    });

    // Kitty Keyboard Protocol CSI handlers (`> flags u`, `< n u`, `= flags ; mode u`, `? u`)
    const dispCsiPush = term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
      kittyKeys.push(isAlt(), numParam(params[0], 0));
      return true;
    });
    const dispCsiPop = term.parser.registerCsiHandler({ prefix: "<", final: "u" }, (params) => {
      kittyKeys.pop(isAlt(), Math.max(1, numParam(params[0], 1)));
      return true;
    });
    const dispCsiSet = term.parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
      kittyKeys.set(isAlt(), numParam(params[0], 0), numParam(params[1], 1));
      return true;
    });
    const dispCsiQuery = term.parser.registerCsiHandler({ prefix: "?", final: "u" }, () => {
      void sendAutoInput(`\x1b[?${kittyKeys.current(isAlt())}u`);
      return true;
    });
    const dispModifyOther = term.parser.registerCsiHandler({ prefix: ">", final: "m" }, (params) => {
      if (numParam(params[0], -1) === 4) {
        kittyKeys.modifyOtherKeys = numParam(params[1], 0);
        return true;
      }
      return false;
    });
    const dispOsc52 = term.parser.registerOscHandler(52, (data) => {
      const semi = data.indexOf(";");
      if (semi < 0) return false;
      const b64 = data.slice(semi + 1).trim();
      if (!b64 || b64 === "?") return true;
      try {
        const bytes = decodeBase64Bytes(b64);
        const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        if (text) void copyToClipboard(text);
      } catch {
        /* ignore malformed OSC 52 payload */
      }
      return true;
    });
    const dispDecSet = term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      for (let i = 0; i < params.length; i++) {
        const v = numParam(params[i], -1);
        if (v === 9001) kittyKeys.win32InputMode = true;
        else if (v === 2004) bracketedPasteRef.current = true;
      }
      return false;
    });
    const dispDecRst = term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      for (let i = 0; i < params.length; i++) {
        const v = numParam(params[i], -1);
        if (v === 9001) kittyKeys.win32InputMode = false;
        else if (v === 2004) bracketedPasteRef.current = false;
      }
      return false;
    });
    const dispCsiWindowOps = term.parser.registerCsiHandler({ final: "t" }, (params) => {
      const p0 = numParam(params[0], -1);
      const p1 = numParam(params[1], 0);
      if (p0 === 14 && p1 !== 2) {
        refreshCachedCellSize(term);
        const [cw, ch] = currentDisplay(term).cell;
        void sendAutoInput(`\x1b[4;${Math.max(1, term.rows * ch)};${Math.max(1, term.cols * cw)}t`);
        return true;
      }
      if (p0 === 16) {
        refreshCachedCellSize(term);
        const [cw, ch] = currentDisplay(term).cell;
        void sendAutoInput(`\x1b[6;${ch};${cw}t`);
        return true;
      }
      if (p0 === 18) {
        void sendAutoInput(`\x1b[8;${term.rows};${term.cols}t`);
        return true;
      }
      return false;
    });
    const handleEraseDisplay = (ps: number) => {
      const curAlt = isAlt();
      const buf = term.buffer.active;
      if (ps === 2 || ps === 3) {
        invalidateInFlightAnchors();
      }
      // Kitty spec & libghostty-vt never erase Kitty graphics placements on partial CSI 0 J / 1 J or inside alt screen TUI redraws except explicit full CSI 2 J.
      const erasableKitty = kittyPlacementsRef.current.filter((p) => {
        if (ps === 2 || ps === 3) return true;
        return !curAlt && !p.alt && p.zIndex >= 0 && ps === 0 && buf.cursorY === 0 && buf.cursorX === 0;
      });
      const preservedKitty = kittyPlacementsRef.current.filter((p) => !erasableKitty.includes(p));
      const kp =
        erasableKitty.length > 0
          ? erasePlacementsInDisplay(
              erasableKitty,
              ps,
              buf.baseY,
              term.rows,
              buf.baseY + buf.cursorY,
              buf.cursorX,
              term.cols,
              curAlt,
            )
          : { kept: [], removed: [] };
      if (kp.removed.length > 0) {
        for (const r of kp.removed) r.endMarker?.dispose();
        kittyPlacementsRef.current = [...preservedKitty, ...kp.kept];
      }
      const mappedOsc = osc66Ref.current.map((r) => ({
        alt: r.alt,
        bufferY: r.bufferY,
        col: r.col,
        cols: r.widthCells,
        rows: 1,
        orig: r,
      }));
      const o66 = erasePlacementsInDisplay(
        mappedOsc,
        ps,
        buf.baseY,
        term.rows,
        buf.baseY + buf.cursorY,
        buf.cursorX,
        term.cols,
        curAlt,
      );
      if (o66.removed.length > 0) {
        for (const r of o66.removed) r.orig.marker?.dispose();
        osc66Ref.current = o66.kept.map((x) => x.orig);
      }
      if (!curAlt && (ps === 2 || ps === 3) && kittyVirtualDimsRef.current.size > 0) {
        clearKittyVirtualPlacementsForScreen(kittyVirtualDimsRef.current, false);
      }
      if (kp.removed.length > 0 || o66.removed.length > 0) {
        flushOverlaySoon();
      }
      return false;
    };

    const handleEraseLine = (ps: number, isEch: boolean) => {
      const curAlt = isAlt();
      const buf = term.buffer.active;
      const eraseCount = isEch ? Math.max(1, ps || 1) : null;
      // Per Kitty specification, CSI K (EL) and CSI X (ECH) never delete Kitty graphics placements (including KgpOld z=-1 overlays).
      const mappedOsc = osc66Ref.current.map((r) => ({
        alt: r.alt,
        bufferY: r.bufferY,
        col: r.col,
        cols: r.widthCells,
        rows: 1,
        orig: r,
      }));
      const o66 = erasePlacementsInLine(
        mappedOsc,
        ps,
        buf.baseY + buf.cursorY,
        buf.cursorX,
        eraseCount,
        curAlt,
      );
      if (o66.removed.length > 0) {
        for (const r of o66.removed) r.orig.marker?.dispose();
        osc66Ref.current = o66.kept.map((x) => x.orig);
        flushOverlaySoon();
      }
      return false;
    };

    const dispCsiEd = term.parser.registerCsiHandler({ final: "J" }, (params) => handleEraseDisplay(numParam(params[0], 0)));
    const dispCsiDecEd = term.parser.registerCsiHandler({ prefix: "?", final: "J" }, (params) => handleEraseDisplay(numParam(params[0], 0)));
    const dispCsiEl = term.parser.registerCsiHandler({ final: "K" }, (params) => handleEraseLine(numParam(params[0], 0), false));
    const dispCsiDecEl = term.parser.registerCsiHandler({ prefix: "?", final: "K" }, (params) => handleEraseLine(numParam(params[0], 0), false));
    const dispCsiEch = term.parser.registerCsiHandler({ final: "X" }, (params) => handleEraseLine(Math.max(1, numParam(params[0], 1)), true));
    const dispDecStr = term.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
      kittyKeys.reset();
      bracketedPasteRef.current = false;
      return false;
    });
    const dispResetKeys = term.parser.registerEscHandler({ final: "c" }, () => {
      kittyKeys.reset();
      bracketedPasteRef.current = false;
      clearAllTerminalOverlays(false);
      return false;
    });

    const dispLinkProvider = term.registerLinkProvider({
      provideLinks(bufferLineNumber, cb) {
        const detected = findTerminalLinksForBufferLine(term.buffer.active, bufferLineNumber);
        if (!detected.length) {
          cb(undefined);
          return;
        }
        cb(
          detected.map((item) => ({
            range: item.range,
            text: item.text,
            decorations: { pointerCursor: false, underline: true },
            activate: (ev, text) => {
              if (ev.button !== 0 || !hasFileJumpModifier(ev) || term.hasSelection()) return;
              activateTerminalLink(text, ev.altKey, item.range.start.y - 1);
            },
          })),
        );
      },
    });

    // Capture native macOS Edit->Copy (`Cmd+C`) DOM copy events when xterm holds a selection.
    const onDocumentCopy = (e: ClipboardEvent) => {
      if (!activeRef.current || !focusedRef.current || !term.hasSelection()) return;
      const domSel = window.getSelection();
      const domText = domSel?.toString() ?? "";
      if (domText && domSel?.anchorNode && !hostEl.contains(domSel.anchorNode)) return;
      const sel = term.getSelection();
      if (!sel) return;
      e.preventDefault();
      e.stopPropagation();
      e.clipboardData?.setData("text/plain", sel);
      void copyToClipboard(sel);
    };
    document.addEventListener("copy", onDocumentCopy, true);

    const copyCurrentSelection = () => {
      if (!term.hasSelection()) return;
      const sel = term.getSelection();
      if (sel) void copyToClipboard(sel);
    };

    // Bridge drag-to-select, double/triple-click, Shift-override, copy-on-select, and Ctrl/Cmd+Click links.
    let activeDragCleanup: (() => void) | null = null;
    let lastMouseHoverLink = false;
    const onHostMouseMoveHover = (e: MouseEvent) => {
      if (!hasFileJumpModifier(e)) {
        if (lastMouseHoverLink) {
          lastMouseHoverLink = false;
          term.element?.classList.remove("xterm-cursor-pointer");
        }
        return;
      }
      const cell = resolvePointerCell(hostEl, term, e.clientX, e.clientY, false);
      const hasLink = Boolean(cell?.link || hoveredOscLinkRef.current);
      if (hasLink !== lastMouseHoverLink) {
        lastMouseHoverLink = hasLink;
        term.element?.classList.toggle("xterm-cursor-pointer", hasLink);
      }
    };
    const onModifierKeyUp = (e: KeyboardEvent) => {
      if ((e.key === "Control" || e.key === "Meta") && !hasFileJumpModifier(e) && lastMouseHoverLink) {
        lastMouseHoverLink = false;
        term.element?.classList.remove("xterm-cursor-pointer");
      }
    };
    const onHostMouseLeaveHover = () => {
      if (lastMouseHoverLink) {
        lastMouseHoverLink = false;
        term.element?.classList.remove("xterm-cursor-pointer");
      }
    };
    const onHostMouseDownCapture = (e: MouseEvent) => {
      if (e.button === 0 && hasFileJumpModifier(e)) {
        const modCell = resolvePointerCell(hostEl, term, e.clientX, e.clientY, false);
        const modLink = modCell?.link || hoveredOscLinkRef.current;
        if (modLink) {
          e.stopPropagation();
          e.preventDefault();
          ctrlLinkConsumedAtRef.current = Date.now();
          term.focus();
          const startX = e.clientX;
          const startY = e.clientY;
          const absRow = modCell?.absRow;
          const onModUp = (up: MouseEvent) => {
            window.removeEventListener("mouseup", onModUp, true);
            if (Math.hypot(up.clientX - startX, up.clientY - startY) < 5) {
              up.stopPropagation();
              up.preventDefault();
              activateTerminalLink(modLink, up.altKey, absRow);
            }
          };
          window.addEventListener("mouseup", onModUp, true);
          return;
        }
      }
      if (e.button !== 0 || e.ctrlKey || (IS_MAC && e.altKey)) return;
      if (term.modes.mouseTrackingMode === "none") {
        window.addEventListener("mouseup", () => queueMicrotask(copyCurrentSelection), { once: true });
        return;
      }
      const startCell = resolvePointerCell(hostEl, term, e.clientX, e.clientY, false);
      if (!startCell) return;

      const bypassTuiMouse = e.shiftKey;
      if (!isShellRef.current && e.detail >= 2) {
        e.stopPropagation();
        e.preventDefault();
        term.focus();
        if (e.detail === 2) {
          const word = findWordSelectionAtCell(term.buffer.active, startCell.absRow, startCell.col, term.cols);
          if (word) {
            term.select(word.col, word.row, word.length);
            copyCurrentSelection();
          }
        } else {
          term.selectLines(startCell.absRow, startCell.absRow);
          copyCurrentSelection();
        }
        return;
      } else if (bypassTuiMouse) {
        e.stopPropagation();
        e.preventDefault();
        term.focus();
      }

      activeDragCleanup?.();
      const startX = e.clientX;
      const startY = e.clientY;
      let draggingSelection = false;

      const onWinMove = (mv: MouseEvent) => {
        if (!draggingSelection && Math.hypot(mv.clientX - startX, mv.clientY - startY) < 5) return;
        draggingSelection = true;
        mv.stopPropagation();
        mv.preventDefault();
        const cur = resolvePointerCell(hostEl, term, mv.clientX, mv.clientY, true);
        if (!cur) return;
        const startOffset = startCell.absRow * term.cols + startCell.col;
        const curOffset = cur.absRow * term.cols + cur.col;
        const from = Math.min(startOffset, curOffset);
        const to = Math.max(startOffset, curOffset);
        const col0 = from % term.cols;
        const row0 = Math.floor(from / term.cols);
        const len = Math.max(1, to - from + 1);
        term.select(col0, row0, len);
      };

      let cleanup: () => void = () => {};

      const finishDrag = (up: MouseEvent) => {
        cleanup();
        if (draggingSelection) {
          up.stopPropagation();
          up.preventDefault();
          copyCurrentSelection();
          return;
        }
        if (term.hasSelection()) {
          term.clearSelection();
        }
      };

      cleanup = () => {
        window.removeEventListener("mousemove", onWinMove, true);
        window.removeEventListener("mouseup", finishDrag, true);
        window.removeEventListener("blur", cleanup, true);
        if (activeDragCleanup === cleanup) activeDragCleanup = null;
      };

      activeDragCleanup = cleanup;
      window.addEventListener("mousemove", onWinMove, true);
      window.addEventListener("mouseup", finishDrag, true);
      window.addEventListener("blur", cleanup, true);
    };

    const onHostWheel = (e: WheelEvent) => {
      if (!isAlt() || term.modes.mouseTrackingMode !== "none") return;
      if (Math.abs(e.deltaY) < 1) return;
      e.preventDefault();
      e.stopPropagation();
      const ticks = Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / 36) || 1));
      const appCursor = Boolean(
        (term.modes as { applicationCursorKeysMode?: boolean }).applicationCursorKeysMode,
      );
      const unit = e.deltaY < 0 ? (appCursor ? "\x1bOA" : "\x1b[A") : appCursor ? "\x1bOB" : "\x1b[B";
      void sendInput(unit.repeat(ticks));
    };

    hostEl.addEventListener("mousemove", onHostMouseMoveHover);
    hostEl.addEventListener("mouseleave", onHostMouseLeaveHover);
    hostEl.addEventListener("mousedown", onHostMouseDownCapture, true);
    hostEl.addEventListener("wheel", onHostWheel, { passive: false });
    window.addEventListener("keyup", onModifierKeyUp, true);

    const reclaimFocusAndSize = () => {
      const localConnId = localConnRef.current;
      if (localConnId) void localTermFocus(localConnId, true);
      if (!activeRef.current || !focusedRef.current) return;
      const dims = fitAddon.proposeDimensions();
      const pty = ptySizeRef.current;
      const diverged =
        externalSizeOverrideRef.current ||
        Boolean(pty && dims && (pty.cols !== dims.cols || pty.rows !== dims.rows));
      if (diverged && localConnId) {
        externalSizeOverrideRef.current = false;
        if (dims) ptySizeRef.current = { cols: dims.cols, rows: dims.rows };
      }
      syncResize(term, true);
    };
    const textarea = term.textarea;
    const imeBridge = attachTerminalImeBridge(
      textarea,
      (data) => {
        void sendInput(data);
      },
      {
        onTelemetry: (ev, meta) => trackTerminalImeEvent(ev, meta),
      },
    );
    const compHelper = (
      term as unknown as { _core?: { _compositionHelper?: { updateCompositionElements?: (re?: boolean) => void } } }
    )._core?._compositionHelper;
    if (compHelper && typeof compHelper.updateCompositionElements === "function") {
      const origUpdate = compHelper.updateCompositionElements.bind(compHelper);
      compHelper.updateCompositionElements = (recursed?: boolean) => {
        origUpdate(recursed);
        imeBridge.syncCompositionOverlay();
      };
    }
    const onHostCaptureScroll = () => {
      if (hostEl.scrollLeft !== 0) hostEl.scrollLeft = 0;
    };
    hostEl.addEventListener("scroll", onHostCaptureScroll, true);
    const onTermFocus = () => {
      const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (nowMs - lastActivateAtRef.current < 80) return;
      reclaimFocusAndSize();
    };
    const onTermBlur = () => {
      const localConnId = localConnRef.current;
      if (localConnId) void localTermFocus(localConnId, false);
    };
    const onWindowFocus = () => {
      if (!activeRef.current || !focusedRef.current) return;
      const ae = document.activeElement;
      if (ae === textarea || (ae !== null && hostEl.contains(ae))) {
        reclaimFocusAndSize();
      }
    };
    textarea?.addEventListener("focus", onTermFocus);
    textarea?.addEventListener("blur", onTermBlur);
    window.addEventListener("focus", onWindowFocus);

    // Key handling: preserve global app shortcuts (⌘T/⌘W/⌘P/...), Herdr macOS keys, and Kitty CSI u.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type === "keyup") return true;
      if (isImeKeyEvent(e) || imeBridge.isComposing()) return true;
      if (e.type !== "keydown") {
        // Prevent xterm's CoreBrowserTerminal._keyPress from emitting a stray "\r" after modified Enter.
        if (
          (e.key === "Enter" && (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey)) ||
          encodeKittyKey(
            e,
            kittyKeys.current(isAlt()),
            kittyKeys.modifyOtherKeys,
            IS_MAC,
            kittyKeys.win32InputMode,
            isShellRef.current,
          ) !== null
        ) {
          e.preventDefault();
          return false;
        }
        return true;
      }
      const consume = () => {
        e.preventDefault();
        return false;
      };
      const modTabJump = (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key);
      if (modTabJump) {
        return false;
      }
      const appShortcut = matchShortcut(e);
      if (appShortcut) {
        // On Windows/Linux keep bare Ctrl+<letter> in the terminal (shell EOF/kill/etc.); Ctrl+Shift/Alt and Ctrl+punctuation shortcuts bubble.
        if (IS_MAC || e.shiftKey || e.altKey || !/^[a-z]$/i.test(e.key)) {
          if (e.key === "Enter") e.preventDefault();
          return false;
        }
      }

      if (IS_MAC && e.metaKey && !e.ctrlKey && !e.altKey) {
        const lower = e.key.toLowerCase();
        if (lower === "c") {
          if (term.hasSelection()) {
            void copyToClipboard(term.getSelection());
          }
          return consume();
        }
        if (lower === "v") {
          // Allow WebKit native paste event to fire into capture listener / xterm textarea once.
          return true;
        }
        if (lower === "a") {
          term.selectAll();
          return consume();
        }
        if (e.key === "=" || e.key === "+") {
          adjustFontSize("in");
          return consume();
        }
        if (e.key === "-") {
          adjustFontSize("out");
          return consume();
        }
        if (e.key === "0") {
          adjustFontSize("reset");
          return consume();
        }
        // macOS terminal line-navigation & erase matching herdr-app/defaults/keys.macos.json
        if (e.key === "ArrowLeft") {
          void sendInput("\x01");
          return consume();
        }
        if (e.key === "ArrowRight") {
          void sendInput("\x05");
          return consume();
        }
        if (e.key === "Backspace") {
          void sendInput("\x15");
          return consume();
        }
        return consume();
      }

      if (IS_MAC && e.altKey && !e.metaKey && !e.ctrlKey) {
        if (e.key === "ArrowLeft") {
          void sendInput("\x1bb");
          return consume();
        }
        if (e.key === "ArrowRight") {
          void sendInput("\x1bf");
          return consume();
        }
        if (e.key === "Backspace") {
          void sendInput("\x17");
          return consume();
        }
      }

      if (!IS_MAC && e.ctrlKey && !e.altKey && !e.metaKey) {
        const lower = e.key.toLowerCase();
        if (lower === "c" && term.hasSelection()) {
          void copyToClipboard(term.getSelection());
          return consume();
        }
        if (e.shiftKey && lower === "c") {
          if (term.hasSelection()) void copyToClipboard(term.getSelection());
          return consume();
        }
        if (lower === "v") return true;
        if (e.key === "=" || e.key === "+") {
          adjustFontSize("in");
          return consume();
        }
        if (e.key === "-") {
          adjustFontSize("out");
          return consume();
        }
        if (e.key === "0") {
          adjustFontSize("reset");
          return consume();
        }
      }

      const kFlags = kittyKeys.current(isAlt());
      const encoded = encodeKittyKey(
        e,
        kFlags,
        kittyKeys.modifyOtherKeys,
        IS_MAC,
        kittyKeys.win32InputMode,
        isShellRef.current,
      );
      if (encoded) {
        void sendInput(encoded);
        return consume();
      }
      return true;
    });

    const dispData = term.onData((data) => {
      imeBridge.handleXtermData(data);
    });

    // Kitty Graphics APC command state
    type KittyAnchor = {
      bufferY: number;
      col: number;
      alt: boolean;
      colReady: boolean;
      rowReady: boolean;
      invalidated?: boolean;
    };
    let chunkActive: { cmd: KittyGfxCommand; parts: string[]; anchor: KittyAnchor } | null = null;
    const inFlightAnchors = new Set<KittyAnchor>();
    invalidateInFlightAnchors = () => {
      for (const a of inFlightAnchors) a.invalidated = true;
      inFlightAnchors.clear();
      chunkActive = null;
    };
    const formatReplyTarget = (id: number | undefined, num: number | undefined): string => {
      const parts: string[] = [];
      if (id !== undefined) parts.push(`i=${id}`);
      if (num !== undefined) parts.push(`I=${num}`);
      return parts.join(",");
    };

    const captureAnchor = (): KittyAnchor => {
      const buf = term.buffer.active;
      return { bufferY: buf.baseY + buf.cursorY, col: buf.cursorX, alt: isAlt(), colReady: true, rowReady: true };
    };

    const pushPlacement = (
      asset: KittyImageAsset,
      cmd: KittyGfxCommand,
      anchor: KittyAnchor,
      cols: number,
      rows: number,
    ) => {
      if (anchor.invalidated) return;
      const placementId = cmd.placementId ?? 1;
      const buf = term.buffer.active;
      const rawMarker = !anchor.alt ? term.registerMarker(anchor.bufferY - (buf.baseY + buf.cursorY)) : undefined;
      const endMarker = rawMarker && rawMarker.line >= 0 ? rawMarker : undefined;
      if (rawMarker && !endMarker) rawMarker.dispose();
      const next: KittyPlacement = {
        key: `kp-${asset.id}-${placementId}-${placementSeqRef.current++}`,
        alt: anchor.alt,
        imageId: asset.id,
        ...(cmd.imageNumber !== undefined ? { imageNumber: cmd.imageNumber } : {}),
        placementId,
        bufferY: endMarker ? endMarker.line : anchor.bufferY,
        ...(endMarker ? { endMarker } : {}),
        col: anchor.col,
        cols,
        rows,
        zIndex: cmd.zIndex,
        explicitCols: cmd.cols,
        explicitRows: cmd.rows,
        cropX: cmd.cropX,
        cropY: cmd.cropY,
        cropW: cmd.cropW,
        cropH: cmd.cropH,
        cellOffsetX: cmd.cellOffsetX,
        cellOffsetY: cmd.cellOffsetY,
      };
      if (cmd.placementId !== undefined && cmd.placementId > 0) {
        const idx = kittyPlacementsRef.current.findIndex(
          (p) => p.alt === anchor.alt && p.imageId === asset.id && p.placementId === placementId,
        );
        if (idx >= 0) {
          kittyPlacementsRef.current[idx]!.endMarker?.dispose();
          next.key = kittyPlacementsRef.current[idx]!.key;
          kittyPlacementsRef.current[idx] = next;
          logger.debug("term", "term.kitty.place", { cols, rows, alt: anchor.alt, replaced: true });
          flushOverlaySoon();
          return;
        }
      }
      kittyPlacementsRef.current.push(next);
      if (kittyPlacementsRef.current.length > 200) {
        const trimmed = kittyPlacementsRef.current.splice(0, kittyPlacementsRef.current.length - 200);
        for (const t of trimmed) t.endMarker?.dispose();
      }
      logger.debug("term", "term.kitty.place", { cols, rows, alt: anchor.alt });
      flushOverlaySoon();
    };

    const storeKittyAsset = (imgId: number, asset: KittyImageAsset) => {
      const prev = kittyAssetsRef.current.get(imgId);
      if (prev && prev.url !== asset.url) revokeAssetUrl(prev.url);
      kittyAssetsRef.current.set(imgId, asset);
      if (kittyAssetsRef.current.size > 64) {
        const oldest = kittyAssetsRef.current.keys().next().value;
        if (oldest !== undefined) {
          const old = kittyAssetsRef.current.get(oldest);
          if (old) revokeAssetUrl(old.url);
          kittyAssetsRef.current.delete(oldest);
        }
      }
    };

    const resolvePlacementCells = (
      cmd: KittyGfxCommand,
      rawBytes?: Uint8Array,
      asset?: KittyImageAsset,
    ): { cols: number; rows: number; colsKnown: boolean; rowsKnown: boolean } => {
      const [cellW, cellH] = cellSizeRef.current;
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const cellPxW = Math.max(1, cellW * dpr);
      const cellPxH = Math.max(1, cellH * dpr);
      let pxW = cmd.width;
      let pxH = cmd.height;
      if ((!pxW || !pxH) && asset) {
        pxW = asset.width;
        pxH = asset.height;
      }
      if ((!pxW || !pxH) && rawBytes && cmd.format === 100 && !cmd.compression) {
        const png = parsePngDimensions(rawBytes);
        if (png) {
          pxW = png.width;
          pxH = png.height;
        }
      }
      const cropSx = Math.max(0, cmd.cropX ?? 0);
      const cropSy = Math.max(0, cmd.cropY ?? 0);
      if (cmd.cropW && cmd.cropW > 0) {
        pxW = pxW ? Math.min(cmd.cropW, Math.max(1, pxW - cropSx)) : cmd.cropW;
      } else if (pxW && cropSx > 0) {
        pxW = Math.max(1, pxW - cropSx);
      }
      if (cmd.cropH && cmd.cropH > 0) {
        pxH = pxH ? Math.min(cmd.cropH, Math.max(1, pxH - cropSy)) : cmd.cropH;
      } else if (pxH && cropSy > 0) {
        pxH = Math.max(1, pxH - cropSy);
      }
      const colsKnown = cmd.cols !== undefined || Boolean(pxW);
      const rowsKnown = cmd.rows !== undefined || Boolean(pxH);
      let cols: number;
      let rows: number;
      if (cmd.cols !== undefined && cmd.rows !== undefined) {
        cols = cmd.cols;
        rows = cmd.rows;
      } else if (cmd.cols !== undefined && pxW && pxH) {
        cols = cmd.cols;
        rows = Math.max(1, Math.round((cmd.cols * cellPxW * pxH) / (pxW * cellPxH)));
      } else if (cmd.rows !== undefined && pxW && pxH) {
        rows = cmd.rows;
        cols = Math.max(1, Math.round((cmd.rows * cellPxH * pxW) / (pxH * cellPxW)));
      } else {
        cols = cmd.cols ?? (pxW ? Math.max(1, Math.ceil(pxW / cellPxW)) : 1);
        rows = cmd.rows ?? (pxH ? Math.max(1, Math.ceil(pxH / cellPxH)) : 1);
      }
      return { cols, rows, colsKnown, rowsKnown };
    };

    // PTY Stream: prefer direct `hc connect` for local mac/pc hc terminals, with Relay fallback.
    const writeSegmented = (rawText: string) => {
      const segments = splitter.push(rawText);
      for (const seg of segments) {
        if (seg.kind === "vt") {
          const rewritten = placeholderRewriter.push(seg.data);
          if (rewritten) term.write(rewritten);
          continue;
        }
        const flushed = placeholderRewriter.flush();
        if (flushed) term.write(flushed);

        const cmd = parseKittyGfxCommand(seg.raw);
        if (cmd.action === "d") {
          term.write("", () => {
            const buf = term.buffer.active;
            const curAlt = buf === term.buffer.alternate;
            const rawD = cmd.deleteWhat || "a";
            const d = rawD.toLowerCase();
            const res = deleteKittyPlacementsScoped(
              kittyPlacementsRef.current,
              curAlt,
              cmd,
              buf.cursorX,
              buf.baseY + buf.cursorY,
              buf.baseY,
            );
            for (const r of res.removed) r.endMarker?.dispose();
            kittyPlacementsRef.current = res.placements;
            if (res.removed.length > 0) {
              logger.debug("term", "term.kitty.delete", { count: res.removed.length, alt: curAlt });
            }

            let evictedVirtualIds: number[] = [];
            if (res.clearedActiveAll) {
              if (rawD === "A") {
                const vIds = new Set<number>();
                for (const key of kittyVirtualDimsRef.current.keys()) {
                  const id = Number.parseInt(key.split(":")[0] ?? "", 10);
                  if (Number.isFinite(id)) vIds.add(id);
                }
                evictedVirtualIds = Array.from(vIds);
              }
              clearKittyVirtualPlacementsForScreen(kittyVirtualDimsRef.current, curAlt);
            } else if ((d === "i" || d === "p") && cmd.id !== undefined) {
              deleteKittyVirtualPlacements(kittyVirtualDimsRef.current, cmd.id, cmd.placementId, curAlt);
              if (rawD === "I" && cmd.placementId === undefined) {
                evictedVirtualIds = [cmd.id];
              }
            } else if (d === "n" && cmd.imageNumber !== undefined) {
              const targetId = imageNumberToId.get(cmd.imageNumber);
              if (targetId !== undefined) {
                deleteKittyVirtualPlacements(kittyVirtualDimsRef.current, targetId, cmd.placementId, curAlt);
                if (rawD === "N" && cmd.placementId === undefined) {
                  evictedVirtualIds = [targetId];
                }
              }
            }

            const stillReferencedIds = new Set<number>(res.placements.map((p) => p.imageId));
            for (const key of kittyVirtualDimsRef.current.keys()) {
              const id = Number.parseInt(key.split(":")[0] ?? "", 10);
              if (Number.isFinite(id)) stillReferencedIds.add(id);
            }
            const evictIds = new Set([...res.evictAssetIds, ...evictedVirtualIds]);
            for (const id of evictIds) {
              if (stillReferencedIds.has(id)) continue;
              const prev = kittyAssetsRef.current.get(id);
              if (prev) revokeAssetUrl(prev.url);
              kittyAssetsRef.current.delete(id);
              kittyDimsByIdRef.current.delete(id);
              for (const [num, mapped] of imageNumberToId) {
                if (mapped === id) imageNumberToId.delete(num);
              }
              if (lastUnnumberedImgId === id) lastUnnumberedImgId = null;
            }
            flushOverlaySoon();
          });
          continue;
        }

        if (cmd.action === "p") {
          const targetId =
            cmd.id ??
            (cmd.imageNumber !== undefined ? imageNumberToId.get(cmd.imageNumber) : lastUnnumberedImgId ?? undefined);
          if (targetId === undefined) continue;
          const asset = kittyAssetsRef.current.get(targetId);
          const pendingAsset = !asset ? pendingKittyAssets.get(targetId) : undefined;
          const known = kittyDimsByIdRef.current.get(targetId);
          const resolved = asset ? resolvePlacementCells(cmd, undefined, asset) : null;
          const cols = cmd.cols ?? resolved?.cols ?? known?.cols ?? 1;
          const rows = cmd.rows ?? resolved?.rows ?? known?.rows ?? 1;
          const replyPlaceOk = () => {
            if (cmd.quiet === 0) {
              const tgt = formatReplyTarget(cmd.id, cmd.imageNumber);
              if (tgt) void sendAutoInput(`\x1b_G${tgt};OK\x1b\\`);
            }
          };
          if (!shouldCreateCursorPlacement(cmd)) {
            const vAnchor: KittyAnchor = { bufferY: 0, col: 0, alt: false, colReady: true, rowReady: true };
            inFlightAnchors.add(vAnchor);
            const commitVirtualPlace = (loadedAsset?: KittyImageAsset) => {
              inFlightAnchors.delete(vAnchor);
              if (vAnchor.invalidated || termRef.current !== term) return;
              const dims = loadedAsset ? resolvePlacementCells(cmd, undefined, loadedAsset) : null;
              registerKittyVirtualPlacement(
                kittyVirtualDimsRef.current,
                targetId,
                cmd.placementId,
                cmd.cols ?? dims?.cols ?? known?.cols ?? 1,
                cmd.rows ?? dims?.rows ?? known?.rows ?? 1,
                cmd.zIndex,
                isAlt(),
              );
              flushOverlaySoon();
              replyPlaceOk();
            };
            if (asset) {
              term.write("", () => commitVirtualPlace(asset));
            } else if (pendingAsset) {
              void pendingAsset.then((loaded) => {
                if (!loaded || vAnchor.invalidated || termRef.current !== term) {
                  inFlightAnchors.delete(vAnchor);
                  return;
                }
                term.write("", () => commitVirtualPlace(loaded));
              });
            } else {
              inFlightAnchors.delete(vAnchor);
            }
            continue;
          }
          const anchor: KittyAnchor = { bufferY: 0, col: 0, alt: false, colReady: false, rowReady: false };
          inFlightAnchors.add(anchor);
          const finishPlacementAsync = (targetAsset: KittyImageAsset, useCols: number, useRows: number) => {
            inFlightAnchors.delete(anchor);
            if (anchor.invalidated || termRef.current !== term) return;
            pushPlacement(targetAsset, { ...cmd, id: targetId }, anchor, useCols, useRows);
            replyPlaceOk();
          };
          term.write("", () => {
            if (anchor.invalidated) return;
            const a = captureAnchor();
            anchor.col = a.col;
            anchor.bufferY = a.bufferY;
            anchor.alt = a.alt;
            anchor.colReady = true;
            anchor.rowReady = true;
          });
          if (cmd.cursorMovement === 0) {
            const linesDown = Math.max(0, rows - 1);
            if (linesDown > 0) {
              anchor.rowReady = false;
              term.write("\n".repeat(linesDown));
              term.write("", () => {
                if (anchor.invalidated) return;
                const buf = term.buffer.active;
                anchor.bufferY = Math.max(0, buf.baseY + buf.cursorY - linesDown);
                anchor.rowReady = true;
              });
            }
            if (cols > 0) term.write(`\x1b[${cols}C`);
          }
          if (asset) {
            term.write("", () => {
              finishPlacementAsync(asset, cols, rows);
            });
          } else if (pendingAsset) {
            void pendingAsset.then((loaded) => {
              if (!loaded || anchor.invalidated || termRef.current !== term) {
                inFlightAnchors.delete(anchor);
                return;
              }
              const dims = resolvePlacementCells(cmd, undefined, loaded);
              const useCols = cmd.cols ?? dims.cols ?? known?.cols ?? 1;
              const useRows = cmd.rows ?? dims.rows ?? known?.rows ?? 1;
              if (anchor.colReady && anchor.rowReady) {
                finishPlacementAsync(loaded, useCols, useRows);
              } else {
                term.write("", () => {
                  finishPlacementAsync(loaded, useCols, useRows);
                });
              }
            });
          } else {
            inFlightAnchors.delete(anchor);
          }
          continue;
        }

        if (cmd.more) {
          if (!chunkActive) {
            const anchor: KittyAnchor = { bufferY: 0, col: 0, alt: false, colReady: !shouldCreateCursorPlacement(cmd), rowReady: true };
            inFlightAnchors.add(anchor);
            chunkActive = { cmd, parts: [cmd.payload], anchor };
            if (shouldCreateCursorPlacement(cmd)) {
              term.write("", () => {
                if (anchor.invalidated) return;
                const a = captureAnchor();
                anchor.col = a.col;
                anchor.bufferY = a.bufferY;
                anchor.alt = a.alt;
                anchor.colReady = true;
              });
            }
          } else {
            chunkActive.parts.push(cmd.payload);
          }
          continue;
        }

        const state = chunkActive;
        const firstCmd = state ? state.cmd : cmd;
        const fullB64 = state ? [...state.parts, cmd.payload].join("") : cmd.payload;
        chunkActive = null;

        if (firstCmd.action === "q") {
          if (firstCmd.quiet === 0) {
            const tgt = formatReplyTarget(firstCmd.id, firstCmd.imageNumber);
            if (tgt) void sendAutoInput(`\x1b_G${tgt};OK\x1b\\`);
          }
          continue;
        }

        const memRef = !firstCmd.compression && fullB64 ? parsePocketMemPayload(fullB64) : null;
        const isFileMedium = firstCmd.medium === "f" || firstCmd.medium === "t";
        const canReadLocalFile =
          Boolean(localConnRef.current) ||
          (native.available() && (localHostIdStore.get() === null || localHostIdStore.get() === agent.deviceId));
        if (!memRef && ((firstCmd.medium !== "d" && !(isFileMedium && canReadLocalFile)) || !fullB64)) {
          if (firstCmd.quiet < 2) {
            const tgt = formatReplyTarget(firstCmd.id, firstCmd.imageNumber);
            if (tgt) void sendAutoInput(`\x1b_G${tgt};ENOENT:unsupported\x1b\\`);
          }
          continue;
        }

        const imgId = firstCmd.id ?? nextImgId++;
        if (firstCmd.id === undefined) lastUnnumberedImgId = imgId;
        if (firstCmd.imageNumber !== undefined) imageNumberToId.set(firstCmd.imageNumber, imgId);
        let payloadBytes: Uint8Array | null = null;
        if (!memRef) {
          try {
            payloadBytes = decodeBase64Bytes(fullB64);
          } catch {
            continue;
          }
        }

        const dimCmd =
          memRef && memRef.width > 0 && memRef.height > 0 && (!firstCmd.width || !firstCmd.height)
            ? { ...firstCmd, width: memRef.width, height: memRef.height }
            : firstCmd;
        const syncDims =
          !memRef && firstCmd.medium === "d" && payloadBytes
            ? resolvePlacementCells(dimCmd, payloadBytes)
            : resolvePlacementCells(dimCmd);
        kittyDimsByIdRef.current.set(imgId, { cols: syncDims.cols, rows: syncDims.rows });
        const anchor: KittyAnchor = state
          ? state.anchor
          : { bufferY: 0, col: 0, alt: false, colReady: !shouldCreateCursorPlacement(firstCmd), rowReady: true };
        inFlightAnchors.add(anchor);
        if (!state && shouldCreateCursorPlacement(firstCmd)) {
          term.write("", () => {
            if (anchor.invalidated) return;
            const a = captureAnchor();
            anchor.col = a.col;
            anchor.bufferY = a.bufferY;
            anchor.alt = a.alt;
            anchor.colReady = true;
          });
        }

        // Reserve rows & cursor advance synchronously inside writeSegmented so subsequent
        // cursor-up sequences (e.g. fastfetch `\x1b[28A\x1b[57C`) run after row reservation.
        let reservedInline = false;
        if (shouldCreateCursorPlacement(firstCmd) && firstCmd.action === "T" && firstCmd.cursorMovement === 0 && syncDims.rowsKnown) {
          const linesDown = Math.max(0, syncDims.rows - 1);
          if (linesDown > 0) {
            anchor.rowReady = false;
            term.write("\n".repeat(linesDown));
            term.write("", () => {
              if (anchor.invalidated) return;
              const buf = term.buffer.active;
              anchor.bufferY = Math.max(0, buf.baseY + buf.cursorY - linesDown);
              anchor.rowReady = true;
            });
          }
          if (syncDims.colsKnown && syncDims.cols > 0) {
            term.write(`\x1b[${syncDims.cols}C`);
          }
          reservedInline = syncDims.colsKnown;
        }

        // Queue commit through term.write("", ...) so FIFO ordering with any earlier `a=d` callback is strictly preserved.
        const finishAsset = (asset: KittyImageAsset) => {
          if (anchor.invalidated || termRef.current !== term) {
            inFlightAnchors.delete(anchor);
            return;
          }
          const commit = () => {
            inFlightAnchors.delete(anchor);
            if (anchor.invalidated || termRef.current !== term) return;
            storeKittyAsset(imgId, asset);
            if (firstCmd.id === undefined) lastUnnumberedImgId = imgId;
            if (firstCmd.imageNumber !== undefined) imageNumberToId.set(firstCmd.imageNumber, imgId);
            const finalDims =
              firstCmd.cols && firstCmd.rows
                ? { cols: syncDims.cols, rows: syncDims.rows }
                : resolvePlacementCells(firstCmd, undefined, asset);
            kittyDimsByIdRef.current.set(imgId, { cols: finalDims.cols, rows: finalDims.rows });
            if (firstCmd.action === "T") {
              if (shouldCreateCursorPlacement(firstCmd)) {
                if (!reservedInline && firstCmd.cursorMovement === 0) {
                  if (!syncDims.rowsKnown) {
                    const linesDown = Math.max(0, finalDims.rows - 1);
                    if (linesDown > 0) term.write("\n".repeat(linesDown));
                  }
                  if (finalDims.cols > 0) term.write(`\x1b[${finalDims.cols}C`);
                }
                pushPlacement(asset, firstCmd, anchor, finalDims.cols, finalDims.rows);
              } else {
                registerKittyVirtualPlacement(
                  kittyVirtualDimsRef.current,
                  imgId,
                  firstCmd.placementId,
                  finalDims.cols,
                  finalDims.rows,
                  firstCmd.zIndex,
                  isAlt(),
                );
                flushOverlaySoon();
              }
            } else if (kittyVirtualDimsRef.current.size > 0) {
              flushOverlaySoon();
            }
            if (firstCmd.quiet === 0) {
              const tgt = formatReplyTarget(firstCmd.id, firstCmd.imageNumber);
              if (tgt) void sendAutoInput(`\x1b_G${tgt};OK\x1b\\`);
            }
          };
          term.write("", commit);
        };

        // Zero-copy Rust memory cache path (`pocket-mem:<id>/<W>x<H>`): <1ms synchronous handoff.
        if (memRef) {
          const w = memRef.width || firstCmd.width || 0;
          const h = memRef.height || firstCmd.height || 0;
          finishAsset({
            id: imgId,
            url: pocketTermImageUrl(memRef.id, IS_WINDOWS),
            width: w || 64,
            height: h || 64,
            needsMeasure: w <= 0 || h <= 0,
          });
          continue;
        }

        // Fast synchronous paths for `t=d` without zlib: PNG header parse or uncompressed BMP v4 wrapper.
        const rawDataFull = payloadBytes!;
        const sliceOff = firstCmd.dataOffset ?? 0;
        const rawData =
          sliceOff > 0 || firstCmd.dataSize !== undefined
            ? rawDataFull.subarray(
                sliceOff,
                firstCmd.dataSize !== undefined ? sliceOff + firstCmd.dataSize : undefined,
              )
            : rawDataFull;
        if (firstCmd.medium === "d" && !firstCmd.compression) {
          if (firstCmd.format === 100) {
            const pngDims = parsePngDimensions(rawData);
            const width = pngDims?.width ?? firstCmd.width;
            const height = pngDims?.height ?? firstCmd.height;
            if (width && height) {
              const copy = rawData.buffer.slice(
                rawData.byteOffset,
                rawData.byteOffset + rawData.byteLength,
              ) as ArrayBuffer;
              const url = URL.createObjectURL(new Blob([copy], { type: sniffImageMime(rawData) }));
              finishAsset({ id: imgId, url, width, height });
              continue;
            }
          } else if (firstCmd.format === 32 || firstCmd.format === 24) {
            const width = firstCmd.width ?? 0;
            const height = firstCmd.height ?? 0;
            const url = buildBmpBlobUrl(width, height, rawData, firstCmd.format === 24 ? 24 : 32);
            if (url) {
              finishAsset({ id: imgId, url, width, height });
              continue;
            }
          }
        }

        const assetPromise: Promise<KittyImageAsset | null> =
          firstCmd.medium === "d"
            ? decodeKittyAsset(firstCmd, rawData, imgId)
            : (() => {
                const decodedPath = new TextDecoder("utf-8").decode(rawData).trim();
                if (firstCmd.format === 100) {
                  return localTermStatImage(decodedPath, firstCmd.medium === "t").then((stat) => {
                    if (!stat) return null;
                    const url = native.localFileStreamUrl(stat.urlPath);
                    if (!url) return null;
                    const measuredW = stat.width || firstCmd.width || 0;
                    const measuredH = stat.height || firstCmd.height || 0;
                    const needsMeasure = (!measuredW || !measuredH) && (!firstCmd.cols || !firstCmd.rows);
                    return {
                      id: imgId,
                      url,
                      width: measuredW || 64,
                      height: measuredH || 64,
                      needsMeasure,
                    };
                  });
                }
                return native
                  .localTermReadImage(decodedPath)
                  .then((buf) => (buf ? decodeKittyAsset(firstCmd, new Uint8Array(buf), imgId) : null));
              })();

        pendingKittyAssets.set(imgId, assetPromise);
        void assetPromise.then((asset) => {
          if (pendingKittyAssets.get(imgId) === assetPromise) {
            pendingKittyAssets.delete(imgId);
          }
          if (asset) finishAsset(asset);
          else inFlightAnchors.delete(anchor);
        });
      }
    };

    const writeFallbackScreen = (lines: string[]) => {
      if (sawRaw) return;
      fallbackLines = lines;
      term.write(`\x1b[2J\x1b[H${lines.join("\r\n")}`, () => {
        if (!alive || termRef.current !== term) return;
        if (!initialReadyDone || wasAtBottomRef.current) {
          wasAtBottomRef.current = true;
          savedOffsetFromBottomRef.current = 0;
          pendingViewportSyncRef.current = !snapTerminalViewportImmediate(term, true, 0);
          if (!initialReadyDone) markHostReady();
        }
        paintOverlays();
      });
    };

    let unsubRelay: (() => void) | null = null;
    let seedTimer = 0;
    let unsubLocalClose: (() => void) | null = null;
    let unsubLocalSize: (() => void) | null = null;
    let activeLocalConnId: string | null = null;
    let attachGen = 0;

    let flushMicroQueued = false;
    let flushTimer = 0;
    let pendingByteCount = 0;
    let sawAnyOutput = false;
    let syncHoldDeadline = 0;
    let initialBurstStartAt = 0;
    let initialRevealQueued = false;
    const INPUT_FAST_MS = 200;
    const FLUSH_BYTE_CAP = 512 * 1024;
    const HIDDEN_OUTPUT_CLOCK_MS = 64;
    const SYNC_HOLD_MAX_MS = 32;
    const INITIAL_BURST_MAX_MS = 650;

    const flushPendingBytes = () => {
      flushMicroQueued = false;
      syncHoldDeadline = 0;
      if (flushTimer) {
        window.clearTimeout(flushTimer);
        flushTimer = 0;
      }
      if (flushRaf) {
        cancelAnimationFrame(flushRaf);
        flushRaf = 0;
      }
      if (!pendingBytes.length) return;
      const merged = new Uint8Array(pendingByteCount);
      let off = 0;
      for (const chunk of pendingBytes) {
        merged.set(chunk, off);
        off += chunk.length;
      }
      pendingBytes = [];
      pendingByteCount = 0;
      if (alive) {
        const needsInitialReveal = !initialReadyDone;
        writeSegmented(textDecoder.decode(merged, { stream: true }));
        if (needsInitialReveal && !initialRevealQueued) {
          initialRevealQueued = true;
          term.write("", () => {
            initialRevealQueued = false;
            if (!alive || termRef.current !== term) return;
            wasAtBottomRef.current = true;
            savedOffsetFromBottomRef.current = 0;
            pendingViewportSyncRef.current = !snapTerminalViewportImmediate(term, true, 0);
            markHostReady();
            paintOverlays();
          });
        }
      }
    };

    const queueRawBytes = (bytes: Uint8Array) => {
      if (!bytes.length) return;
      pendingBytes.push(bytes);
      pendingByteCount += bytes.length;
      const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      const hitCap = pendingByteCount >= FLUSH_BYTE_CAP;

      // Batch initial history bursts silently while data-ready="false" so xterm jumps
      // straight to the latest progress instead of replaying top-to-bottom on switch.
      if (!initialReadyDone) {
        if (!initialBurstStartAt) initialBurstStartAt = nowMs;
        const burstElapsed = nowMs - initialBurstStartAt;
        if (initialAttachPending && burstElapsed >= 450) {
          initialAttachPending = false;
        }
        const maxRemain = Math.max(0, INITIAL_BURST_MAX_MS - burstElapsed);
        if (!hitCap && (initialAttachPending || maxRemain > 2)) {
          if (flushRaf) {
            cancelAnimationFrame(flushRaf);
            flushRaf = 0;
          }
          if (flushTimer) window.clearTimeout(flushTimer);
          const quietMs = activeLocalConnId ? 75 : 110;
          flushTimer = window.setTimeout(
            flushPendingBytes,
            Math.min(quietMs, Math.max(8, Math.ceil(maxRemain))),
          );
          return;
        }
        sawAnyOutput = true;
        if (flushTimer) {
          window.clearTimeout(flushTimer);
          flushTimer = 0;
        }
        if (flushRaf) {
          cancelAnimationFrame(flushRaf);
          flushRaf = 0;
        }
        if (!flushMicroQueued) {
          flushMicroQueued = true;
          queueMicrotask(() => {
            if (flushMicroQueued) flushPendingBytes();
          });
        }
        return;
      }

      // DEC ?2026 synchronized output: hold briefly (<= 32ms) so full-screen TUI / SIGWINCH
      // redraws commit atomically on a single VSync frame without mid-frame blanking or tearing.
      if (!hitCap && chunksHaveOpenSyncOutput(pendingBytes)) {
        if (!syncHoldDeadline) syncHoldDeadline = nowMs + SYNC_HOLD_MAX_MS;
        const remainMs = syncHoldDeadline - nowMs;
        if (remainMs > 2) {
          if (flushRaf) {
            cancelAnimationFrame(flushRaf);
            flushRaf = 0;
          }
          if (!flushTimer) {
            flushTimer = window.setTimeout(flushPendingBytes, Math.min(SYNC_HOLD_MAX_MS, Math.ceil(remainMs)));
          }
          return;
        }
      }
      syncHoldDeadline = 0;

      const fastEcho =
        !sawAnyOutput ||
        (nowMs - lastInputAtRef.current < INPUT_FAST_MS && lastInputLenRef.current <= 4) ||
        hitCap;
      sawAnyOutput = true;
      if (fastEcho) {
        if (flushTimer) {
          window.clearTimeout(flushTimer);
          flushTimer = 0;
        }
        if (flushRaf) {
          cancelAnimationFrame(flushRaf);
          flushRaf = 0;
        }
        if (!flushMicroQueued) {
          flushMicroQueued = true;
          queueMicrotask(() => {
            if (flushMicroQueued) flushPendingBytes();
          });
        }
        return;
      }
      const isVisible =
        activeRef.current &&
        (typeof document === "undefined" || document.visibilityState === "visible");
      if (isVisible && typeof requestAnimationFrame === "function") {
        if (flushTimer) {
          window.clearTimeout(flushTimer);
          flushTimer = 0;
        }
        if (!flushMicroQueued && !flushRaf) {
          flushRaf = requestAnimationFrame(() => {
            flushRaf = 0;
            flushPendingBytes();
          });
        }
        return;
      }
      if (!flushMicroQueued && !flushTimer) {
        flushTimer = window.setTimeout(flushPendingBytes, HIDDEN_OUTPUT_CLOCK_MS);
      }
    };

    const waitLayoutAndFonts = async () => {
      if (hostEl.clientWidth > 0 && hostEl.clientHeight > 0 && fontCatalogStore.get() !== null) {
        fitAddon.fit();
        refreshCachedCellSize(term);
        centerScreenVerticalGap(hostEl, term);
        return;
      }
      if (hostEl.clientWidth <= 0 || hostEl.clientHeight <= 0) {
        await new Promise<void>((r) => {
          requestAnimationFrame(() => r());
        });
      }
      if (!alive) return;
      await Promise.race([
        ensureFontCatalog().then(() => ensureTerminalFontLoaded(termCfg.fontFamily, termCfg.fontWeight >= 600)),
        new Promise<void>((r) => {
          window.setTimeout(r, 120);
        }),
      ]);
      if (!alive || termRef.current !== term) return;
      fitAddon.fit();
      refreshCachedCellSize(term);
      centerScreenVerticalGap(hostEl, term);
    };

    const startRelayStream = () => {
      if (!alive || unsubRelay) return;
      if (!initialReadyDone) {
        initialAttachPending = true;
      }
      if (!initialReadyDone && !hostReadyFallback) {
        hostReadyFallback = window.setTimeout(markHostReady, 950);
      }
      let rawModeConfirmed = false;
      const runFallbackRead = () => {
        if (!alive || sawRaw || rawModeConfirmed) return;
        initialAttachPending = false;
        void rpcCall(agent.deviceId, "terminal.read", { agent: agent.key, lines: 200 })
          .then((res) => {
            if (alive && !sawRaw && !rawModeConfirmed) writeFallbackScreen((res.ansi || res.text || "").split("\n"));
          })
          .catch(() => {
            if (alive && !initialReadyDone) markHostReady();
          });
      };
      unsubRelay = subscribeStream(
        agent.deviceId,
        "terminal",
        {
          agent: agent.key,
          raw: true,
          cols: term.cols,
          rows: term.rows,
          history: 600,
          display: currentDisplay(term),
        },
        (ev) => {
          if (!alive || !ev) return;
          if (ev.kind === "terminal_data" && typeof ev.data === "string") {
            if (seedTimer) {
              clearTimeout(seedTimer);
              seedTimer = 0;
            }
            if (!sawRaw) {
              sawRaw = true;
              if (fallbackLines.length) {
                initialReadyDone = false;
                initialBurstStartAt = 0;
                initialRevealQueued = false;
                hostEl.dataset.ready = "false";
                window.clearTimeout(hostReadyFallback);
                hostReadyFallback = window.setTimeout(markHostReady, 950);
                term.reset();
              }
            }
            try {
              queueRawBytes(decodeBase64Bytes(ev.data));
            } catch {
              /* ignore malformed chunk */
            }
          } else if (ev.kind === "terminal" && ev.screen) {
            writeFallbackScreen(String(ev.screen.ansi || ev.screen.text || "").split("\n"));
          } else if (ev.kind === "terminal_rows") {
            writeFallbackScreen(applyRows(fallbackLines, ev));
          } else if (ev.kind === "portal_event") {
            ingestPortalStreamEvent(ev);
          }
        },
        (state: { kind?: string; result?: { raw?: boolean } } | undefined) => {
          if (!alive || !state) return;
          if (state.kind === "live" && state.result?.raw === true) {
            rawModeConfirmed = true;
            initialAttachPending = false;
            if (seedTimer) {
              clearTimeout(seedTimer);
              seedTimer = 0;
            }
          } else if (state.kind === "error") {
            if (seedTimer) {
              clearTimeout(seedTimer);
              seedTimer = 0;
            }
            runFallbackRead();
          }
        },
      );
      seedTimer = window.setTimeout(runFallbackRead, 900);
    };

    let readyToAttachResolve: (() => void) | null = null;
    const isLayoutAttachable = () =>
      activeRef.current && hostEl.clientWidth >= 60 && hostEl.clientHeight >= 40;
    const notifyAttachReady = () => {
      if (readyToAttachResolve && isLayoutAttachable()) {
        const resolve = readyToAttachResolve;
        readyToAttachResolve = null;
        resolve();
      }
    };
    onActivatedAttachRef.current = notifyAttachReady;
    const waitUntilAttachable = async (): Promise<void> => {
      if (isLayoutAttachable()) return;
      await new Promise<void>((resolve) => {
        readyToAttachResolve = resolve;
      });
    };

    let triggerLocalReattach: (() => void) | null = null;
    if (native.available() && (agent.source === "hc" || agent.source === "herdr") && agent.localId) {
      const localTermId = agent.localId;
      const connectLocal = async (attempt: number): Promise<void> => {
        const gen = ++attachGen;
        if (!alive) return;
        if (!initialReadyDone) {
          initialAttachPending = true;
        }
        if (!initialReadyDone && !hostReadyFallback) {
          hostReadyFallback = window.setTimeout(markHostReady, 950);
        }
        fitAddon.fit();
        refreshCachedCellSize(term);
        centerScreenVerticalGap(hostEl, term);
        const reqCols = term.cols;
        const reqRows = term.rows;
        const connId = `${localTermId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        activeLocalConnId = connId;
        localConnRef.current = connId;
        let preResolveChunks: Uint8Array[] | null = [];
        try {
          const attRes = await native.localTermAttach({
            id: connId,
            terminal: localTermId,
            cols: reqCols,
            rows: reqRows,
            history: 1200,
            focused: activeRef.current && focusedRef.current,
            display: currentDisplay(term) as unknown as Record<string, unknown>,
            onData: (bytes) => {
              if (!alive || activeLocalConnId !== connId || gen !== attachGen || bytes.byteLength === 0) return;
              if (preResolveChunks !== null) {
                preResolveChunks.push(bytes);
                return;
              }
              if (!sawRaw) sawRaw = true;
              queueRawBytes(bytes);
            },
          });
          if (!alive || activeLocalConnId !== connId || gen !== attachGen) {
            void native.localTermDetach(connId);
            return;
          }
          const dims = fitAddon.proposeDimensions();
          if (dims && dims.cols > 0 && dims.rows > 0 && (dims.cols !== reqCols || dims.rows !== reqRows)) {
            fitAddon.fit();
            refreshCachedCellSize(term);
            centerScreenVerticalGap(hostEl, term);
            syncResize(term, true);
          }
          ptySizeRef.current = { cols: attRes.cols, rows: attRes.rows };
          logger.info("term", "term.attach", { mode: "local", cols: attRes.cols, rows: attRes.rows });
          const display = currentDisplay(term);
          if (attRes.cols !== term.cols || attRes.rows !== term.rows) {
            const ownsInitialSize =
              paneOwnsFocus() ||
              (activeRef.current && focusedRef.current && (typeof document === "undefined" || document.hasFocus()));
            if (!ownsInitialSize) {
              externalSizeOverrideRef.current = true;
              term.resize(attRes.cols, attRes.rows);
              refreshCachedCellSize(term);
            } else {
              lastResizeSigRef.current = `${connId}:${term.cols}x${term.rows}@${display.cell[0]}x${display.cell[1]}@${display.bg}`;
              ptySizeRef.current = { cols: term.cols, rows: term.rows };
              void native.localTermResize(connId, term.cols, term.rows, display as unknown as Record<string, unknown>).catch(() => {});
            }
          } else {
            lastResizeSigRef.current = `${connId}:${term.cols}x${term.rows}@${display.cell[0]}x${display.cell[1]}@${display.bg}`;
          }
          // Batch buffered pre-resolve PTY chunks with the initial burst so partial scrollback never reveals early.
          const buffered = preResolveChunks;
          preResolveChunks = null;
          initialAttachPending = false;
          for (const chunk of buffered) {
            if (!sawRaw) sawRaw = true;
            queueRawBytes(chunk);
          }
          if (buffered.length === 0 && !initialReadyDone) {
            window.clearTimeout(hostReadyFallback);
            hostReadyFallback = window.setTimeout(markHostReady, 650);
          }
          if (alive) {
            void localTermFocus(connId, activeRef.current && focusedRef.current);
          }
        } catch {
          preResolveChunks = null;
          initialAttachPending = false;
          if (localConnRef.current === connId) localConnRef.current = null;
          if (activeLocalConnId === connId) activeLocalConnId = null;
          if (alive && gen === attachGen) startRelayStream();
        }
      };

      triggerLocalReattach = () => {
        if (!alive) return;
        const oldId = activeLocalConnId;
        activeLocalConnId = null;
        if (localConnRef.current === oldId) localConnRef.current = null;
        externalSizeOverrideRef.current = false;
        flushPendingBytes();
        if (oldId) void native.localTermDetach(oldId);
        sawRaw = false;
        sawAnyOutput = false;
        didOrphanNudge = false;
        initialReadyDone = false;
        initialBurstStartAt = 0;
        initialRevealQueued = false;
        wasAtBottomRef.current = true;
        savedOffsetFromBottomRef.current = 0;
        pendingViewportSyncRef.current = true;
        hostEl.dataset.ready = "false";
        window.clearTimeout(hostReadyFallback);
        hostReadyFallback = window.setTimeout(markHostReady, 950);
        window.clearTimeout(orphanNudgeTimer);
        orphanNudgeTimer = 0;
        pendingBytes = [];
        pendingByteCount = 0;
        lastResizeSigRef.current = "";
        splitter.reset();
        clearAllTerminalOverlays(false);
        term.reset();
        fitAddon.fit();
        refreshCachedCellSize(term);
        centerScreenVerticalGap(hostEl, term);
        void connectLocal(0);
      };
      reattachLocalRef.current = triggerLocalReattach;

      void (async () => {
        await waitUntilAttachable();
        if (!alive) return;
        const [resolvedLocalId] = await Promise.all([
          localHostIdStore.get() ? Promise.resolve(localHostIdStore.get()) : ensureLocalHostDeviceId(),
          waitLayoutAndFonts(),
        ]);
        if (!alive) return;
        if (!resolvedLocalId || resolvedLocalId !== agent.deviceId) {
          if (reattachLocalRef.current === triggerLocalReattach) reattachLocalRef.current = null;
          startRelayStream();
          return;
        }
        const { listen } = await (tauriEventPromise ?? import("@tauri-apps/api/event"));
        if (!alive) return;
        const [offClose, offSize] = await Promise.all([
          listen<LocalTermCloseEvent>("local-term://close", (e) => {
            if (!alive || !activeLocalConnId || e.payload.id !== activeLocalConnId) return;
            const closedId = activeLocalConnId;
            flushPendingBytes();
            if (localConnRef.current === closedId) localConnRef.current = null;
            activeLocalConnId = null;
            startRelayStream();
          }),
          listen<LocalTermSizeEvent>("local-term://size", (e) => {
            if (!alive || e.payload.terminal !== localTermId) return;
            const { cols, rows } = e.payload;
            ptySizeRef.current = { cols, rows };
            const externalOwner = typeof document === "undefined" || !document.hasFocus() || !activeRef.current;
            if ((cols !== term.cols || rows !== term.rows) && externalOwner) {
              flushPendingBytes();
              externalSizeOverrideRef.current = true;
              term.resize(cols, rows);
              refreshCachedCellSize(term);
              scheduleOverlay();
            }
          }),
        ]);
        if (!alive) {
          offClose();
          offSize();
          return;
        }
        unsubLocalClose = offClose;
        unsubLocalSize = offSize;
        await connectLocal(0);
      })();
    } else {
      void waitUntilAttachable().then(() => {
        if (!alive) return;
        return waitLayoutAndFonts().then(() => {
          if (alive) startRelayStream();
        });
      });
    }

    let resizeRaf = 0;
    let resizeSettleTimer = 0;
    let lastPtySyncAt = 0;
    let lastLiveResizeAt = 0;
    let lastResizeCostMs = 0;
    let pendingRectW = hostEl.clientWidth;
    let pendingRectH = hostEl.clientHeight;
    if (pendingRectW > 0 && pendingRectH > 0) {
      lastObservedBoxRef.current = { w: pendingRectW, h: pendingRectH };
    }
    let offSplitSettle: (() => void) | null = null;
    let offInteractiveSettle: (() => void) | null = null;

    const flashResizeHud = (cols: number, rows: number) => {
      if (!alive || !activeRef.current) return;
      setResizeHud((prev) => (prev && prev.cols === cols && prev.rows === rows ? prev : { cols, rows }));
      if (resizeHudTimerRef.current) window.clearTimeout(resizeHudTimerRef.current);
      resizeHudTimerRef.current = window.setTimeout(() => {
        resizeHudTimerRef.current = 0;
        if (alive) setResizeHud(null);
      }, 360);
    };

    const applyLiveResize = (rectW: number, rectH: number, showHud = false) => {
      if (!alive || !activeRef.current || !hostRef.current) return;
      const w = rectW > 0 ? rectW : hostRef.current.clientWidth;
      const h = rectH > 0 ? rectH : hostRef.current.clientHeight;
      if (w <= 0 || h <= 0) return;

      const prevBox = lastObservedBoxRef.current;
      const boxChanged = Math.abs(w - prevBox.w) >= 1 || Math.abs(h - prevBox.h) >= 1;
      const canClaimLayout =
        typeof document === "undefined" || document.hasFocus() || isInteractiveResizeActive();
      if (boxChanged) {
        lastObservedBoxRef.current = { w, h };
        if (canClaimLayout) externalSizeOverrideRef.current = false;
      }
      if (externalSizeOverrideRef.current && !paneOwnsFocus()) return;
      externalSizeOverrideRef.current = false;

      if (cellSizeRef.current[0] <= 1 || cellSizeRef.current[1] <= 1) {
        refreshCachedCellSize(term);
      }
      const [cw, ch] = cellSizeRef.current;
      const grid = proposeGridFast(w, h, cw, ch);
      if (!grid) {
        syncResize(term);
        return;
      }
      const dimsChanged = grid.cols !== term.cols || grid.rows !== term.rows;
      if (dimsChanged) {
        const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
        term.resize(grid.cols, grid.rows);
        lastResizeCostMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
        if (showHud && prevBox.w > 0 && prevBox.h > 0) {
          flashResizeHud(grid.cols, grid.rows);
        }
      }
      centerScreenVerticalGap(hostRef.current, term);
      paintOverlays();

      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      const inInteractive =
        isInteractiveResizeActive() || Boolean(hostEl.closest('[data-sash-dragging="true"]'));
      if (now - lastPtySyncAt >= (inInteractive ? 65 : 55)) {
        lastPtySyncAt = now;
        flushPtyResize(term);
      }
    };

    const scheduleSettleFlush = (delayMs: number) => {
      if (resizeSettleTimer) window.clearTimeout(resizeSettleTimer);
      resizeSettleTimer = window.setTimeout(() => {
        resizeSettleTimer = 0;
        if (!alive || isSplitMotionActive() || isInteractiveResizeActive()) return;
        applyLiveResize(hostRef.current?.clientWidth ?? pendingRectW, hostRef.current?.clientHeight ?? pendingRectH, false);
        lastPtySyncAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        flushPtyResize(term);
      }, delayMs);
    };

    const ro = new ResizeObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) {
        pendingRectW = last.contentRect.width;
        pendingRectH = last.contentRect.height;
      }
      if (pendingRectW >= 60 && pendingRectH >= 40) {
        notifyAttachReady();
      }
      if (isSplitMotionActive()) {
        if (!offSplitSettle) {
          offSplitSettle = onSplitMotionSettled(() => {
            offSplitSettle = null;
            if (!alive || !activeRef.current || !hostRef.current) return;
            applyLiveResize(hostRef.current.clientWidth || pendingRectW, hostRef.current.clientHeight || pendingRectH, false);
            lastPtySyncAt = typeof performance !== "undefined" ? performance.now() : Date.now();
            flushPtyResize(term);
          });
        }
        return;
      }

      const inInteractive =
        isInteractiveResizeActive() || Boolean(hostEl.closest('[data-sash-dragging="true"]'));
      if (inInteractive && !offInteractiveSettle) {
        offInteractiveSettle = onInteractiveResizeSettled(() => {
          offInteractiveSettle?.();
          offInteractiveSettle = null;
          scheduleSettleFlush(24);
        });
      }

      const frameIntervalMs = lastResizeCostMs >= 6 ? 32 : 16;
      if (!resizeRaf) {
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          if (isSplitMotionActive()) return;
          const now = typeof performance !== "undefined" ? performance.now() : Date.now();
          if (now - lastLiveResizeAt < frameIntervalMs) {
            scheduleSettleFlush(inInteractive ? 45 : 75);
            return;
          }
          lastLiveResizeAt = now;
          applyLiveResize(pendingRectW, pendingRectH, true);
        });
      }
      scheduleSettleFlush(inInteractive ? 85 : 100);
    });
    ro.observe(hostEl);

    let unwatchDpr: (() => void) | null = null;
    const watchDpr = () => {
      unwatchDpr?.();
      unwatchDpr = null;
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      const onChange = () => {
        if (!alive || termRef.current !== term) return;
        lastResizeSigRef.current = "";
        syncResize(term);
        paintOverlays();
        watchDpr();
      };
      mq.addEventListener?.("change", onChange, { once: true });
      unwatchDpr = () => mq.removeEventListener?.("change", onChange);
    };
    watchDpr();

    if (activeRef.current && focusedRef.current) {
      requestAnimationFrame(() => term.focus());
    }

    const assetsRefForCleanup = kittyAssetsRef;

    return () => {
      alive = false;
      if (onActivatedAttachRef.current === notifyAttachReady) {
        onActivatedAttachRef.current = null;
      }
      if (readyToAttachResolve) {
        const resolve = readyToAttachResolve;
        readyToAttachResolve = null;
        resolve();
      }
      window.clearTimeout(hostReadyFallback);
      window.clearTimeout(seedTimer);
      window.clearTimeout(flushTimer);
      window.clearTimeout(orphanNudgeTimer);
      onMissingVirtualAssetRef.current = null;
      clearOverlaysRef.current = null;
      if (attachWebglRef.current === attachWebgl) attachWebglRef.current = null;
      if (detachWebglRef.current === detachWebgl) detachWebglRef.current = null;
      detachWebgl();
      offSplitSettle?.();
      offSplitSettle = null;
      offInteractiveSettle?.();
      offInteractiveSettle = null;
      if (resizeHudTimerRef.current) {
        window.clearTimeout(resizeHudTimerRef.current);
        resizeHudTimerRef.current = 0;
      }
      if (resizeSettleTimer) window.clearTimeout(resizeSettleTimer);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      flushMicroQueued = false;
      overlayMicroQueued = false;
      if (flushRaf) {
        cancelAnimationFrame(flushRaf);
        flushRaf = 0;
      }
      pendingBytes = [];
      pendingByteCount = 0;
      if (rafOverlay) cancelAnimationFrame(rafOverlay);
      unwatchDpr?.();
      ro.disconnect();
      unsubRelay?.();
      unsubLocalClose?.();
      unsubLocalSize?.();
      if (triggerLocalReattach && reattachLocalRef.current === triggerLocalReattach) {
        reattachLocalRef.current = null;
      }
      if (activeLocalConnId) {
        if (localConnRef.current === activeLocalConnId) localConnRef.current = null;
        void native.localTermDetach(activeLocalConnId);
      }
      lastResizeSigRef.current = "";
      relayPendingRef.current = [];
      dispScroll.dispose();
      dispRender.dispose();
      dispWriteParsed.dispose();
      dispBuf.dispose();
      dispOsc52.dispose();
      dispOsc66.dispose();
      dispCsiPush.dispose();
      dispCsiPop.dispose();
      dispCsiSet.dispose();
      dispCsiQuery.dispose();
      dispModifyOther.dispose();
      dispDecSet.dispose();
      dispDecRst.dispose();
      dispCsiWindowOps.dispose();
      dispCsiEd.dispose();
      dispCsiDecEd.dispose();
      dispCsiEl.dispose();
      dispCsiDecEl.dispose();
      dispCsiEch.dispose();
      dispDecStr.dispose();
      dispResetKeys.dispose();
      dispLinkProvider.dispose();
      dispData.dispose();
      imeBridge.dispose();
      document.removeEventListener("copy", onDocumentCopy, true);
      activeDragCleanup?.();
      hostEl.removeEventListener("mousemove", onHostMouseMoveHover);
      hostEl.removeEventListener("mouseleave", onHostMouseLeaveHover);
      hostEl.removeEventListener("mousedown", onHostMouseDownCapture, true);
      hostEl.removeEventListener("wheel", onHostWheel);
      hostEl.removeEventListener("scroll", onHostCaptureScroll, true);
      window.removeEventListener("keyup", onModifierKeyUp, true);
      textarea?.removeEventListener("focus", onTermFocus);
      textarea?.removeEventListener("blur", onTermBlur);
      window.removeEventListener("focus", onWindowFocus);
      for (const a of assetsRefForCleanup.current.values()) revokeAssetUrl(a.url);
      assetsRefForCleanup.current.clear();
      overlayNodesRef.current.clear();
      for (const p of kittyPlacementsRef.current) p.endMarker?.dispose();
      kittyPlacementsRef.current = [];
      kittyVirtualDimsRef.current.clear();
      kittyDimsByIdRef.current.clear();
      placeholderRewriter.reset();
      for (const r of osc66Ref.current) r.marker?.dispose();
      osc66Ref.current = [];
      term.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fitAddon) fitRef.current = null;
    };
    // Intentionally mounts once per agent session key; live font/display props synchronize in separate effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.deviceId, agent.key]);

  // Close context menu cleanly on outside pointer click, Escape, or blur.
  useEffect(() => {
    if (!ctxMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement | null)?.closest("[data-term-ctx-menu]")) return;
      setCtxMenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    const onBlur = () => setCtxMenu(null);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [ctxMenu]);

  // Refocus, refit, and repaint synchronously before browser paint when switching back into Terminal mode or focusing this split pane.
  useLayoutEffect(() => {
    const localConnId = localConnRef.current;
    if (localConnId) {
      void localTermFocus(localConnId, active && focused);
    }
    if (!active || !termRef.current) {
      pendingViewportSyncRef.current = true;
      detachWebglRef.current?.();
      return;
    }
    pendingViewportSyncRef.current = true;
    onActivatedAttachRef.current?.();
    attachWebglRef.current?.();
    const term = termRef.current;
    const stickToBottom = wasAtBottomRef.current;
    const savedOffset = savedOffsetFromBottomRef.current;
    lastActivateAtRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (externalSizeOverrideRef.current) {
      lastResizeSigRef.current = "";
    }
    if (focusedRef.current) {
      const prevConn = localConnRef.current;
      syncResize(term, true);
      term.focus();
      if (localConnRef.current === prevConn && externalSizeOverrideRef.current) {
        externalSizeOverrideRef.current = false;
      }
    } else {
      syncResize(term);
    }
    if (snapTerminalViewportImmediate(term, stickToBottom, savedOffset)) {
      pendingViewportSyncRef.current = false;
    }
    term.refresh(0, Math.max(0, term.rows - 1));
    paintOverlays();
    const id = requestAnimationFrame(() => {
      onActivatedAttachRef.current?.();
      if (termRef.current === term) {
        if (pendingViewportSyncRef.current && snapTerminalViewportImmediate(term, stickToBottom, savedOffset)) {
          pendingViewportSyncRef.current = false;
        }
        paintOverlays();
      }
    });
    return () => {
      cancelAnimationFrame(id);
    };
  }, [active, focused, paintOverlays, syncResize]);

  // Accept dictated text or virtual mobile pad keys when this terminal pane is active and focused.
  useEffect(() => {
    const onVoiceInput = (ev: Event) => {
      const detail = (ev as CustomEvent<{ text?: string; noFocus?: boolean }>).detail;
      const text = detail?.text;
      if (!text || !activeRef.current || !focusedRef.current) return;
      const hostEl = hostRef.current;
      if (!hostEl || hostEl.offsetParent === null) return;
      void sendInput(text);
      if (!detail?.noFocus) {
        requestAnimationFrame(() => termRef.current?.focus());
      }
    };
    const onFocusTerminal = () => {
      if (!activeRef.current || !focusedRef.current) return;
      const hostEl = hostRef.current;
      if (!hostEl || hostEl.offsetParent === null) return;
      termRef.current?.focus();
    };
    window.addEventListener("pocket:voice-term-input", onVoiceInput);
    window.addEventListener("pocket:focus-terminal", onFocusTerminal);
    return () => {
      window.removeEventListener("pocket:voice-term-input", onVoiceInput);
      window.removeEventListener("pocket:focus-terminal", onFocusTerminal);
    };
  }, [sendInput]);

  const jumpToSearchMatch = useCallback((matches: TerminalSearchMatch[], idx: number) => {
    const term = termRef.current;
    if (!term || !matches.length) return;
    const clamped = ((idx % matches.length) + matches.length) % matches.length;
    const m = matches[clamped]!;
    term.select(m.col0, m.row0, m.length);
    const buf = term.buffer.active;
    const targetTop = Math.max(0, Math.min(buf.baseY, m.row0 - Math.floor(term.rows / 2)));
    const delta = targetTop - buf.viewportY;
    if (delta !== 0) term.scrollLines(delta);
    setSearchIdx(clamped);
  }, []);

  useEffect(() => {
    const onOpenSearch = (ev: Event) => {
      const detail = (ev as CustomEvent<{ agentKey?: string }>).detail;
      const matchesAgent = detail?.agentKey
        ? detail.agentKey === agentRef.current.key
        : activeRef.current && focusedRef.current;
      if (!matchesAgent) return;
      const hostEl = hostRef.current;
      if (!hostEl || hostEl.offsetParent === null) return;
      setSearchOpen(true);
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    };
    window.addEventListener("pocket:term-search", onOpenSearch);
    return () => window.removeEventListener("pocket:term-search", onOpenSearch);
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    const term = termRef.current;
    if (!term || !searchQuery) {
      setSearchMatches([]);
      setSearchIdx(0);
      if (!searchQuery) term?.clearSelection();
      return;
    }
    const found = searchTerminalBuffer(term.buffer.active, searchQuery, term.cols);
    setSearchMatches(found);
    if (found.length > 0) {
      jumpToSearchMatch(found, found.length - 1);
    } else {
      setSearchIdx(0);
      term.clearSelection();
    }
  }, [jumpToSearchMatch, searchOpen, searchQuery]);

  const isSplitOnlyDrag = (e: DragEvent<HTMLDivElement>): boolean =>
    hasTabDrag(e) || hasPanelDrag(e) || hasPaneDrag(e) || (hasWorkspaceDrag(e) && e.altKey);

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (isSplitOnlyDrag(e)) return;
    if (!hasDropFiles(e.dataTransfer) && !hasWorkspaceDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (isSplitOnlyDrag(e)) return;
    if (!hasDropFiles(e.dataTransfer) && !hasWorkspaceDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (isSplitOnlyDrag(e)) return;
    if (!hasDropFiles(e.dataTransfer) && !hasWorkspaceDrag(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    dragDepthRef.current = 0;
    setDragOver(false);
    if (isSplitOnlyDrag(e)) return;
    const wsItem = readWorkspaceDrag(e);
    if (wsItem) {
      e.preventDefault();
      e.stopPropagation();
      endWorkspaceDrag();
      const targetPath = resolveDropPath(wsItem, agent.deviceId);
      void sendInput(wrapBracketedPaste(`${shellQuotePath(targetPath)} `));
      requestAnimationFrame(() => termRef.current?.focus());
      return;
    }
    const dt = e.dataTransfer;
    if (!dt) return;
    const hasFileItem = Array.from(dt.items ?? []).some((item) => item.kind === "file");
    const hasPayload = hasDropFiles(dt) || (dt.files?.length ?? 0) > 0 || hasFileItem;
    if (!hasPayload) return;
    e.preventDefault();
    e.stopPropagation();

    const snapshot = snapshotDroppedDataTransfer(dt);
    void (async () => {
      const localHostId =
        localHostIdStore.get() ?? (native.available() ? await ensureLocalHostDeviceId() : null);
      if (native.available() && localHostId === agent.deviceId) {
        const osItems = await readOsDraggedPaths();
        if (osItems.length > 0) {
          await sendInput(wrapBracketedPaste(`${osItems.map((it) => shellQuotePath(it.path)).join(" ")} `));
          requestAnimationFrame(() => termRef.current?.focus());
          return;
        }
      }
      const safe = await collectDroppedFilesSafe(snapshot, { maxFiles: 6 });
      if (safe.files.length > 0) {
        await sendFilesToPty(safe.files);
        if (safe.skippedDirs.length > 0) {
          toast(`已跳过空文件夹：${safe.skippedDirs.join("、")}`, true);
        }
      } else if (safe.skippedDirs.length > 0 || safe.folderNames.length > 0) {
        const names = (safe.skippedDirs.length ? safe.skippedDirs : safe.folderNames).join("、");
        toast(`不支持直接上传空文件夹：${names}`, true);
      }
      requestAnimationFrame(() => termRef.current?.focus());
    })();
  };

  const wrapStyle = useMemo(
    () =>
      ({
        "--tp-term-bg": activeSpec.bg,
        "--tp-term-fg": activeSpec.fg,
        "--tp-term-scroll": activeSpec.mode === "light" ? "rgba(0, 0, 0, 0.22)" : "rgba(255, 255, 255, 0.18)",
        "--tp-term-scroll-hover": activeSpec.mode === "light" ? "rgba(0, 0, 0, 0.42)" : "rgba(255, 255, 255, 0.34)",
        "--tp-term-drop-bg": activeSpec.mode === "light" ? "rgba(255, 255, 255, 0.88)" : "rgba(23, 25, 29, 0.86)",
        "--tp-term-drop-fg": activeSpec.mode === "light" ? "#25272c" : "#f0f0f2",
      }) as CSSProperties,
    [activeSpec.bg, activeSpec.fg, activeSpec.mode],
  );

  return (
    <div
      className={`tp-term-wrap${dragOver ? " drop-over" : ""}`}
      style={wrapStyle}
      onMouseDown={(e) => {
        if (ctxMenu) setCtxMenu(null);
        if ((e.target as HTMLElement | null)?.closest(".tp-term-search")) return;
        termRef.current?.focus();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const term = termRef.current;
        const hostEl = hostRef.current;
        const cell = term && hostEl ? resolvePointerCell(hostEl, term, e.clientX, e.clientY, false) : null;
        const link = cell?.link || hoveredOscLinkRef.current || undefined;
        if (Date.now() - ctrlLinkConsumedAtRef.current < 400 || (e.ctrlKey && link)) {
          if (e.ctrlKey && link && Date.now() - ctrlLinkConsumedAtRef.current >= 400) {
            activateTerminalLink(link, e.altKey, cell?.absRow);
          }
          return;
        }
        const isHttpLink = Boolean(link && /^https?:\/\//i.test(link));
        const lineText = term && cell ? readLogicalLineText(term.buffer.active, cell.absRow).trim() : "";
        setCtxMenu({
          x: e.clientX,
          y: e.clientY,
          ...(cell ? { absRow: cell.absRow } : {}),
          ...(link ? { link, isHttpLink } : {}),
          ...(lineText ? { lineText } : {}),
        });
      }}
      onPasteCapture={(e) => {
        const files = e.clipboardData?.files;
        if (files && files.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          void sendFilesToPty(files);
        }
      }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div ref={hostRef} className="tp-term-host" />
      <div ref={underlayRef} className="tp-term-underlay" aria-hidden />
      <div ref={overlayRef} className="tp-term-overlay" aria-hidden />
      {resizeHud ? (
        <div className="tp-resize-hud num" aria-hidden="true">
          {resizeHud.cols} × {resizeHud.rows}
        </div>
      ) : null}
      {searchOpen ? (
        <div
          className="tp-term-search"
          role="search"
          aria-label="搜索终端输出"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            ref={searchInputRef}
            type="text"
            placeholder="搜索终端输出…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setSearchOpen(false);
                requestAnimationFrame(() => termRef.current?.focus());
              } else if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                if (searchMatches.length > 0) {
                  jumpToSearchMatch(searchMatches, searchIdx + (e.shiftKey ? -1 : 1));
                }
              }
            }}
          />
          <span className="tp-term-search-count">
            {searchQuery
              ? searchMatches.length > 0
                ? `${searchIdx + 1}/${searchMatches.length}`
                : "无结果"
              : ""}
          </span>
          <button
            type="button"
            className="v3-icon-btn small"
            aria-label="上一处"
            title="上一处 (Shift+Enter)"
            disabled={searchMatches.length === 0}
            onClick={() => jumpToSearchMatch(searchMatches, searchIdx - 1)}
          >
            <ChevronUp size={13} />
          </button>
          <button
            type="button"
            className="v3-icon-btn small"
            aria-label="下一处"
            title="下一处 (Enter)"
            disabled={searchMatches.length === 0}
            onClick={() => jumpToSearchMatch(searchMatches, searchIdx + 1)}
          >
            <ChevronDown size={13} />
          </button>
          <button
            type="button"
            className="v3-icon-btn small"
            aria-label="关闭搜索"
            title="关闭 (Esc)"
            onClick={() => {
              setSearchOpen(false);
              requestAnimationFrame(() => termRef.current?.focus());
            }}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}
      {ctxMenu ? (
        <div
          className="ctx-menu"
          data-term-ctx-menu
          role="menu"
          style={{
            left: Math.min(ctxMenu.x, (typeof window !== "undefined" ? window.innerWidth : 800) - 210),
            top: Math.min(ctxMenu.y, (typeof window !== "undefined" ? window.innerHeight : 600) - 360),
            zIndex: 2300,
          }}
        >
          {ctxMenu.link ? (
            <>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  const target = ctxMenu.link!;
                  const row = ctxMenu.absRow;
                  setCtxMenu(null);
                  activateTerminalLink(target, false, row);
                }}
              >
                {ctxMenu.isHttpLink ? "打开链接" : "打开文件"}
              </button>
              {ctxMenu.isHttpLink ? (
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    const target = ctxMenu.link!;
                    const row = ctxMenu.absRow;
                    setCtxMenu(null);
                    activateTerminalLink(target, true, row);
                  }}
                >
                  在内置浏览器打开
                </button>
              ) : null}
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  const target = ctxMenu.link!;
                  setCtxMenu(null);
                  void copyToClipboard(target).then((ok) => toast(ok ? "已复制链接" : "复制失败", !ok));
                }}
              >
                复制链接
              </button>
              <div className="menu-sep" />
            </>
          ) : null}
          <button
            type="button"
            className="menu-item"
            disabled={!termRef.current?.hasSelection()}
            onClick={() => {
              const t = termRef.current;
              if (t?.hasSelection()) {
                void copyToClipboard(t.getSelection()).then((ok) => toast(ok ? "已复制" : "复制失败", !ok));
              }
              setCtxMenu(null);
            }}
          >
            复制
          </button>
          {ctxMenu.lineText ? (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                const line = ctxMenu.lineText!;
                setCtxMenu(null);
                void copyToClipboard(line).then((ok) => toast(ok ? "已复制当前行" : "复制失败", !ok));
              }}
            >
              复制当前行
            </button>
          ) : null}
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              termRef.current?.selectAll();
              setCtxMenu(null);
              termRef.current?.focus();
            }}
          >
            全选
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setCtxMenu(null);
              void navigator.clipboard
                ?.readText()
                .then((text) => {
                  if (text) void sendInput(wrapBracketedPaste(text));
                })
                .catch(() => {});
              termRef.current?.focus();
            }}
          >
            粘贴
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              clearOverlaysRef.current?.();
              termRef.current?.clear();
              setCtxMenu(null);
              termRef.current?.focus();
            }}
          >
            清屏
          </button>
          <div className="menu-sep" />
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              adjustFontSize("in");
              setCtxMenu(null);
            }}
          >
            放大字号
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              adjustFontSize("out");
              setCtxMenu(null);
            }}
          >
            缩小字号
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              adjustFontSize("reset");
              setCtxMenu(null);
            }}
          >
            重置字号
          </button>
          <div className="menu-sep" />
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setCtxMenu(null);
              openSettingsFrame("look");
            }}
          >
            切换终端字体…
          </button>
        </div>
      ) : null}
    </div>
  );
}
