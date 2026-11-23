import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { applyRows, configKeySpec, type Agent, type TerminalDisplay } from "@herdr-pocket/protocol";
import { copyToClipboard, detectPlatform, openExternalUrl } from "../lib/bridge";
import { openAgentFileTarget } from "../lib/openFileTarget";
import { setConfig, useClientConfig } from "../lib/config";
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
import { native, type LocalTermCloseEvent, type LocalTermSizeEvent } from "../lib/native";
import { rpcCall, subscribeStream } from "../lib/relay";
import { settingsStore } from "../lib/store";
import {
  deleteKittyPlacementsScoped,
  getTerminalThemeSpec,
  resolveTerminalAppearance,
  type TerminalThemeSpec,
} from "../lib/terminalTheme";
import { openSettingsFrame, openWebTab } from "../shell/shellStore";
import { IS_MAC, matchShortcut } from "../shell/shortcuts";
import { useToast } from "./PocketUI";
import "../styles/terminal.css";

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
  placementId: number;
  bufferY: number;
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

interface Osc66Run {
  key: string;
  alt: boolean;
  bufferY: number;
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
  try {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const ds = new DecompressionStream("deflate");
    const stream = new Blob([ab]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return bytes;
  }
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
  const overlayRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const localConnRef = useRef<string | null>(null);
  const relayPendingRef = useRef("");
  const relayFlushingRef = useRef(false);
  const kittyKeysRef = useRef(new KittyKeyboardState());
  const osc66Ref = useRef<Osc66Run[]>([]);
  const kittyAssetsRef = useRef<Map<number, KittyImageAsset>>(new Map());
  const kittyPlacementsRef = useRef<KittyPlacement[]>([]);
  const kittyVirtualDimsRef = useRef<Map<string, KittyVirtualPlacementDims>>(new Map());
  const kittyDimsByIdRef = useRef<Map<number, { cols: number; rows: number }>>(new Map());
  const overlayNodesRef = useRef<Map<string, { kind: "img" | "clip" | "osc66"; el: HTMLElement; img?: HTMLImageElement; sig: string }>>(new Map());
  const lastResizeSigRef = useRef("");
  const ptySizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const externalSizeOverrideRef = useRef(false);
  const reattachLocalRef = useRef<(() => void) | null>(null);
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
  const bracketedPasteRef = useRef(false);
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const hoveredOscLinkRef = useRef<string | null>(null);
  const lastLinkOpenRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const activeRef = useRef(active);
  activeRef.current = active;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const isShellRef = useRef(Boolean(agent.isShell));
  isShellRef.current = Boolean(agent.isShell);

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
      const term = termRef.current;
      if (term) {
        if (term.hasSelection()) term.clearSelection();
        const buf = term.buffer.active;
        if (buf === term.buffer.normal && buf.viewportY < buf.baseY) {
          term.scrollToBottom();
        }
      }
      const localConnId = localConnRef.current;
      if (localConnId) {
        try {
          await native.localTermInput(localConnId, data);
          return;
        } catch {
          // If local attach closed unexpectedly, clear and fall through to relay queue.
          if (localConnRef.current === localConnId) localConnRef.current = null;
        }
      }
      relayPendingRef.current += data;
      if (relayFlushingRef.current) return;
      relayFlushingRef.current = true;
      try {
        while (relayPendingRef.current.length > 0) {
          const batch = relayPendingRef.current.slice(0, 16_384);
          relayPendingRef.current = relayPendingRef.current.slice(batch.length);
          try {
            await rpcCall(agent.deviceId, "terminal.input", { agent: agent.key, data: batch });
          } catch {
            await rpcCall(agent.deviceId, "terminal.send", { agent: agent.key, text: batch, enter: false }).catch(() => {});
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
      const toSend = list.slice(0, 6);
      try {
        const putFiles = await Promise.all(
          toSend.map(async (f) => {
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
        if (res.paths.length) {
          await sendInput(`${res.paths.map(shellQuotePath).join(" ")} `);
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

  const syncResize = useCallback(
    (term: XTerm, forceReclaim = false) => {
      if (!activeRef.current || !hostRef.current || hostRef.current.clientWidth <= 0 || hostRef.current.clientHeight <= 0) {
        return;
      }
      if (externalSizeOverrideRef.current && !forceReclaim && !paneOwnsFocus()) {
        return;
      }
      externalSizeOverrideRef.current = false;
      fitRef.current?.fit();
      refreshCachedCellSize(term);
      centerScreenVerticalGap(hostRef.current, term);
      const display = currentDisplay(term);
      const localConnId = localConnRef.current;
      if (forceReclaim) lastResizeSigRef.current = "";
      const sig = `${localConnId ?? "relay"}:${term.cols}x${term.rows}@${display.cell[0]}x${display.cell[1]}@${display.bg}`;
      if (lastResizeSigRef.current === sig) return;
      lastResizeSigRef.current = sig;
      ptySizeRef.current = { cols: term.cols, rows: term.rows };
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
    [agent.deviceId, agent.key, currentDisplay, paneOwnsFocus, refreshCachedCellSize],
  );

  const paintOverlays = useCallback(() => {
    const term = termRef.current;
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
      if (overlay.childElementCount > 0) overlay.replaceChildren();
      return;
    }

    const screen = hostEl.querySelector<HTMLElement>(".xterm-screen");
    if (screen && overlay.parentElement !== screen) {
      screen.appendChild(overlay);
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
    if (osc66Ref.current.length > 0 && osc66Ref.current[0]!.bufferY < buf.length - (term.options.scrollback ?? 3000) - term.rows) {
      osc66Ref.current = osc66Ref.current.filter((r) => r.alt || r.bufferY >= Math.max(0, maxBufLines - 3000));
    }

    const nodeMap = overlayNodesRef.current;
    const seenKeys = new Set<string>();
    const orderedEls: HTMLElement[] = [];

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
                placement.cols = Math.max(1, Math.min(term.cols, Math.ceil(asset.width / cellPxW)));
              }
              if (placement.explicitRows === undefined) {
                placement.rows = Math.max(1, Math.min(term.rows, Math.ceil(asset.height / cellPxH)));
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
      zIndex: string,
      placement?: KittyPlacement,
    ) => {
      const sig = `img|${asset.url}|${left}|${top}|${width}|${height}|${zIndex}|${asset.needsMeasure ? 1 : 0}`;
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
        orderedEls.push(existing.el);
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
      orderedEls.push(img);
    };

    const upsertClipNode = (
      key: string,
      asset: KittyImageAsset,
      clipLeft: number,
      clipTop: number,
      clipWidth: number,
      clipHeight: number,
      zIndex: string,
      imgLeft: number,
      imgTop: number,
      imgWidth: number,
      imgHeight: number,
      placement?: KittyPlacement,
    ) => {
      const sig = `clip|${asset.url}|${clipLeft}|${clipTop}|${clipWidth}|${clipHeight}|${zIndex}|${imgLeft}|${imgTop}|${imgWidth}|${imgHeight}|${asset.needsMeasure ? 1 : 0}`;
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
        orderedEls.push(existing.el);
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
      orderedEls.push(clip);
    };

    for (const p of kittyPlacementsRef.current) {
      if (p.alt !== curAlt || p.bufferY + p.rows <= topY || p.bufferY >= botY) continue;
      const asset = kittyAssetsRef.current.get(p.imageId);
      if (!asset) continue;
      const key = `kp:${p.key}`;
      const left = Math.round(p.col * cellW + (p.cellOffsetX ?? 0) / dpr);
      const top = Math.round((p.bufferY - topY) * cellH + (p.cellOffsetY ?? 0) / dpr);
      const boxW = Math.max(cellW, Math.round(p.cols * cellW));
      const boxH = Math.max(cellH, Math.round(p.rows * cellH));
      const zIndex = String(Math.max(1, 5 + p.zIndex));

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

      upsertImgNode(key, asset, left, top, boxW, boxH, zIndex, p);
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

      const kvOcc = new Map<string, number>();
      for (const block of virtualBlocks) {
        const asset = kittyAssetsRef.current.get(block.imageId);
        if (!asset) continue;
        const vdims = lookupKittyVirtualPlacement(kittyVirtualDimsRef.current, block.imageId, block.placementId);
        const fallbackDims = kittyDimsByIdRef.current.get(block.imageId);
        const fullCols = Math.max(vdims?.cols ?? fallbackDims?.cols ?? 0, block.startTileCol + block.cols, 1);
        const fullRows = Math.max(vdims?.rows ?? fallbackDims?.rows ?? 0, block.startTileRow + block.rows, 1);
        const zIndex = String(Math.max(1, 5 + (vdims?.zIndex ?? 0)));

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
            zIndex,
            -Math.round(block.startTileCol * cellW),
            -Math.round(block.startTileRow * cellH),
            fullWidth,
            fullHeight,
          );
        } else {
          upsertImgNode(key, asset, visLeft, visTop, fullWidth, fullHeight, zIndex);
        }
      }
    }

    const fs = term.options.fontSize ?? 14;
    const ff = term.options.fontFamily ?? fontFamily;
    const fw = String(term.options.fontWeight ?? 400);
    const fg = activeSpecRef.current.fg;
    for (const r of osc66Ref.current) {
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
        orderedEls.push(existing.el);
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
      orderedEls.push(span);
    }

    for (const [key, entry] of nodeMap) {
      if (!seenKeys.has(key)) {
        nodeMap.delete(key);
        if (entry.el.parentElement === overlay) entry.el.remove();
      }
    }

    const children = overlay.children;
    let sameOrder = children.length === orderedEls.length;
    if (sameOrder) {
      for (let i = 0; i < orderedEls.length; i++) {
        if (children[i] !== orderedEls[i]) {
          sameOrder = false;
          break;
        }
      }
    }
    if (!sameOrder) {
      for (let i = 0; i < orderedEls.length; i++) {
        const wanted = orderedEls[i]!;
        const current = overlay.children[i] ?? null;
        if (current !== wanted) {
          overlay.insertBefore(wanted, current);
        }
      }
      while (overlay.childElementCount > orderedEls.length) {
        overlay.lastElementChild?.remove();
      }
    }
  }, [fontFamily]);

  // Keep font faces, theme colors, texture atlas, and overlay coordinates synchronized with live changes.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let cancelled = false;
    const apply = (familyCss: string) => {
      if (cancelled || termRef.current !== term) return;
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
      term.clearTextureAtlas();
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
  }, [activeSpec, fontFamily, lineHeight, paintOverlays, syncResize, termCfg.cursorBlink, termCfg.fontFamily, termCfg.fontSize, termCfg.fontWeight]);

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
      scrollback: 3000,
      minimumContrastRatio: activeSpec.minimumContrastRatio,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      theme: activeSpec.theme,
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (ev, text) => {
          if (ev.button !== 0 || term.hasSelection()) return;
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
      storageLimit: 128,
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

    term.open(hostEl);
    fitAddon.fit();
    refreshCachedCellSize(term);
    centerScreenVerticalGap(hostEl, term);
    bracketedPasteRef.current = false;

    let webglAddon: WebglAddon | null = null;
    let webglRetries = 0;
    let webglRetryTimer = 0;
    const mountWebgl = () => {
      if (!alive || webglAddon || termRef.current !== term) return;
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => {
          gl.dispose();
          if (webglAddon === gl) webglAddon = null;
          if (alive && webglRetries < 3) {
            webglRetries += 1;
            window.clearTimeout(webglRetryTimer);
            webglRetryTimer = window.setTimeout(mountWebgl, 300);
          }
        });
        term.loadAddon(gl);
        webglAddon = gl;
      } catch {
        // Fallback cleanly to xterm default renderer when WebGL2 is unavailable.
      }
    };
    mountWebgl();

    // Ensure OS / Herdr / Nerd fonts load asynchronously right after opening.
    void ensureFontCatalog().then(() => ensureTerminalFontLoaded(termCfg.fontFamily, termCfg.fontWeight >= 600)).then((loaded) => {
      if (loaded && alive && termRef.current === term) {
        term.options.fontFamily = buildTerminalFontFamily(termCfg.fontFamily, fontCatalogStore.get());
        term.clearTextureAtlas();
        term.refresh(0, Math.max(0, term.rows - 1));
        syncResize(term);
        requestAnimationFrame(paintOverlays);
      }
    });

    let rafOverlay = 0;
    let overlayMicroQueued = false;
    const hasOverlayContent = () =>
      kittyPlacementsRef.current.length > 0 ||
      kittyVirtualDimsRef.current.size > 0 ||
      kittyAssetsRef.current.size > 0 ||
      osc66Ref.current.length > 0 ||
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
      if (!hasOverlayContent()) return;
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

    const dispScroll = term.onScroll(scheduleOverlay);
    const dispRender = term.onRender(scheduleOverlay);
    const dispWriteParsed = term.onWriteParsed(flushOverlaySoon);
    const dispBuf = term.buffer.onBufferChange(() => {
      if (!isAlt()) {
        osc66Ref.current = osc66Ref.current.filter((r) => !r.alt);
        kittyPlacementsRef.current = kittyPlacementsRef.current.filter((p) => !p.alt);
      }
      scheduleOverlay();
    });

    // Kitty Text Sizing Protocol (OSC 66)
    const dispOsc66 = term.parser.registerOscHandler(66, (data) => {
      const parsed = parseOsc66(data);
      if (!parsed) return false;
      const buf = term.buffer.active;
      const curAlt = buf === term.buffer.alternate;
      const absY = buf.baseY + buf.cursorY;
      const col = buf.cursorX;
      osc66Ref.current.push({
        key: `o66-${absY}-${col}-${osc66Ref.current.length}`,
        alt: curAlt,
        bufferY: absY,
        col,
        widthCells: parsed.cellsWide,
        scale: parsed.scale,
        ratio: parsed.ratio,
        verticalAlign: parsed.verticalAlign,
        text: parsed.text,
      });
      if (osc66Ref.current.length > 400) osc66Ref.current.splice(0, osc66Ref.current.length - 400);
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
    const dispResetKeys = term.parser.registerEscHandler({ final: "c" }, () => {
      kittyKeys.reset();
      bracketedPasteRef.current = false;
      osc66Ref.current = [];
      kittyPlacementsRef.current = [];
      kittyVirtualDimsRef.current.clear();
      kittyDimsByIdRef.current.clear();
      placeholderRewriter.reset();
      scheduleOverlay();
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
            decorations: { pointerCursor: true, underline: true },
            activate: (ev, text) => {
              if (ev.button !== 0 || term.hasSelection()) return;
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

    // Bridge drag-to-select, double/triple-click, Shift-override, copy-on-select, and clickable links.
    let activeDragCleanup: (() => void) | null = null;
    let lastMouseHoverLink = false;
    const onHostMouseMoveHover = (e: MouseEvent) => {
      if (term.modes.mouseTrackingMode === "none") {
        if (lastMouseHoverLink) {
          lastMouseHoverLink = false;
          term.element?.classList.remove("xterm-cursor-pointer");
        }
        return;
      }
      const cell = resolvePointerCell(hostEl, term, e.clientX, e.clientY, false);
      const hasLink = Boolean(cell?.link);
      if (hasLink !== lastMouseHoverLink) {
        lastMouseHoverLink = hasLink;
        term.element?.classList.toggle("xterm-cursor-pointer", hasLink);
      }
    };
    const onHostMouseLeaveHover = () => {
      if (lastMouseHoverLink) {
        lastMouseHoverLink = false;
        term.element?.classList.remove("xterm-cursor-pointer");
      }
    };
    const onHostMouseDownCapture = (e: MouseEvent) => {
      if (e.button !== 0 || e.ctrlKey || (IS_MAC && e.altKey)) return;
      if (term.modes.mouseTrackingMode === "none") {
        window.addEventListener("mouseup", () => queueMicrotask(copyCurrentSelection), { once: true });
        return;
      }
      const startCell = resolvePointerCell(hostEl, term, e.clientX, e.clientY, false);
      if (!startCell) return;

      const bypassTuiMouse = e.shiftKey;
      const clickedLink = startCell.link;
      if (clickedLink) {
        e.stopPropagation();
        e.preventDefault();
        term.focus();
      } else if (!isShellRef.current && e.detail >= 2) {
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

      if (e.detail >= 2 && clickedLink) {
        const word = findWordSelectionAtCell(term.buffer.active, startCell.absRow, startCell.col, term.cols);
        if (word) {
          term.select(word.col, word.row, word.length);
          copyCurrentSelection();
        }
        return;
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
        if (clickedLink) {
          up.stopPropagation();
          up.preventDefault();
          activateTerminalLink(clickedLink, up.altKey, startCell.absRow);
        } else if (term.hasSelection()) {
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
    const onTermFocus = () => {
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
        // On Windows/Linux keep bare Ctrl+<letter> in the terminal (shell EOF/kill/etc.); Ctrl+Shift/Alt shortcuts bubble.
        if (IS_MAC || e.shiftKey || e.altKey) {
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
      void sendInput(data);
    });

    // Kitty Graphics APC command state
    type KittyAnchor = { bufferY: number; col: number; alt: boolean; colReady: boolean; rowReady: boolean };
    let nextImgId = 1;
    let chunkActive: { cmd: KittyGfxCommand; parts: string[]; anchor: KittyAnchor } | null = null;
    const pendingKittyAssets = new Map<number, Promise<KittyImageAsset | null>>();

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
      const placementId = cmd.placementId ?? 1;
      const next: KittyPlacement = {
        key: `kp-${asset.id}-${placementId}-${placementSeqRef.current++}`,
        alt: anchor.alt,
        imageId: asset.id,
        placementId,
        bufferY: anchor.bufferY,
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
          next.key = kittyPlacementsRef.current[idx]!.key;
          kittyPlacementsRef.current[idx] = next;
          flushOverlaySoon();
          return;
        }
      }
      kittyPlacementsRef.current.push(next);
      if (kittyPlacementsRef.current.length > 200) {
        kittyPlacementsRef.current.splice(0, kittyPlacementsRef.current.length - 200);
      }
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
        rows = Math.max(1, Math.min(term.rows, Math.round((cmd.cols * cellPxW * pxH) / (pxW * cellPxH))));
      } else if (cmd.rows !== undefined && pxW && pxH) {
        rows = cmd.rows;
        cols = Math.max(1, Math.min(term.cols, Math.round((cmd.rows * cellPxH * pxW) / (pxH * cellPxW))));
      } else {
        cols = cmd.cols ?? (pxW ? Math.max(1, Math.min(term.cols, Math.ceil(pxW / cellPxW))) : 1);
        rows = cmd.rows ?? (pxH ? Math.max(1, Math.min(term.rows, Math.ceil(pxH / cellPxH))) : 1);
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
            );
            kittyPlacementsRef.current = res.placements;

            let evictedVirtualIds: number[] = [];
            if (!curAlt && res.clearedActiveAll) {
              if (rawD === "A") {
                const keepIds = new Set(res.placements.map((p) => p.imageId));
                const vIds = new Set<number>();
                for (const key of kittyVirtualDimsRef.current.keys()) {
                  const id = Number.parseInt(key.split(":")[0] ?? "", 10);
                  if (Number.isFinite(id) && !keepIds.has(id)) vIds.add(id);
                }
                evictedVirtualIds = Array.from(vIds);
              }
              kittyVirtualDimsRef.current.clear();
            } else if ((d === "i" || d === "p") && cmd.id !== undefined) {
              deleteKittyVirtualPlacements(kittyVirtualDimsRef.current, cmd.id, cmd.placementId);
              if (rawD === "I" && cmd.placementId === undefined && !res.placements.some((p) => p.imageId === cmd.id)) {
                evictedVirtualIds = [cmd.id];
              }
            }

            const evictIds = new Set([...res.evictAssetIds, ...evictedVirtualIds]);
            for (const id of evictIds) {
              const prev = kittyAssetsRef.current.get(id);
              if (prev) revokeAssetUrl(prev.url);
              kittyAssetsRef.current.delete(id);
              kittyDimsByIdRef.current.delete(id);
            }
            flushOverlaySoon();
          });
          continue;
        }

        if (cmd.action === "p" && cmd.id !== undefined) {
          const asset = kittyAssetsRef.current.get(cmd.id);
          const pendingAsset = !asset ? pendingKittyAssets.get(cmd.id) : undefined;
          const known = kittyDimsByIdRef.current.get(cmd.id);
          const resolved = asset ? resolvePlacementCells(cmd, undefined, asset) : null;
          const cols = cmd.cols ?? resolved?.cols ?? known?.cols ?? 1;
          const rows = cmd.rows ?? resolved?.rows ?? known?.rows ?? 1;
          const replyPlaceOk = () => {
            if (cmd.quiet === 0 && cmd.id !== undefined) {
              void sendAutoInput(`\x1b_Gi=${cmd.id};OK\x1b\\`);
            }
          };
          if (!shouldCreateCursorPlacement(cmd)) {
            const targetId = cmd.id;
            registerKittyVirtualPlacement(
              kittyVirtualDimsRef.current,
              targetId,
              cmd.placementId,
              cols,
              rows,
              cmd.zIndex,
            );
            flushOverlaySoon();
            if (asset) replyPlaceOk();
            if (!asset && pendingAsset) {
              void pendingAsset.then((loaded) => {
                if (!loaded || termRef.current !== term) return;
                const dims = resolvePlacementCells(cmd, undefined, loaded);
                registerKittyVirtualPlacement(
                  kittyVirtualDimsRef.current,
                  targetId,
                  cmd.placementId,
                  cmd.cols ?? dims.cols ?? known?.cols ?? 1,
                  cmd.rows ?? dims.rows ?? known?.rows ?? 1,
                  cmd.zIndex,
                );
                flushOverlaySoon();
                replyPlaceOk();
              });
            }
            continue;
          }
          const anchor: KittyAnchor = { bufferY: 0, col: 0, alt: false, colReady: false, rowReady: false };
          term.write("", () => {
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
                const buf = term.buffer.active;
                anchor.bufferY = Math.max(0, buf.baseY + buf.cursorY - linesDown);
                anchor.rowReady = true;
              });
            }
            if (cols > 0) term.write(`\x1b[${cols}C`);
          }
          if (asset) {
            term.write("", () => {
              if (termRef.current !== term) return;
              pushPlacement(asset, cmd, anchor, cols, rows);
              replyPlaceOk();
            });
          } else if (pendingAsset) {
            void pendingAsset.then((loaded) => {
              if (!loaded || termRef.current !== term) return;
              const dims = resolvePlacementCells(cmd, undefined, loaded);
              const useCols = cmd.cols ?? dims.cols ?? known?.cols ?? 1;
              const useRows = cmd.rows ?? dims.rows ?? known?.rows ?? 1;
              if (anchor.colReady && anchor.rowReady) {
                pushPlacement(loaded, cmd, anchor, useCols, useRows);
                replyPlaceOk();
              } else {
                term.write("", () => {
                  if (termRef.current !== term) return;
                  pushPlacement(loaded, cmd, anchor, useCols, useRows);
                  replyPlaceOk();
                });
              }
            });
          }
          continue;
        }

        if (cmd.more) {
          if (!chunkActive) {
            const anchor: KittyAnchor = { bufferY: 0, col: 0, alt: false, colReady: !shouldCreateCursorPlacement(cmd), rowReady: true };
            chunkActive = { cmd, parts: [cmd.payload], anchor };
            if (shouldCreateCursorPlacement(cmd)) {
              term.write("", () => {
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
          if (firstCmd.quiet === 0 && firstCmd.id !== undefined) {
            void sendAutoInput(`\x1b_Gi=${firstCmd.id};OK\x1b\\`);
          }
          continue;
        }

        const memRef = !firstCmd.compression && fullB64 ? parsePocketMemPayload(fullB64) : null;
        const isFileMedium = firstCmd.medium === "f" || firstCmd.medium === "t";
        const canReadLocalFile =
          Boolean(localConnRef.current) ||
          (native.available() && (localHostIdStore.get() === null || localHostIdStore.get() === agent.deviceId));
        if (!memRef && ((firstCmd.medium !== "d" && !(isFileMedium && canReadLocalFile)) || !fullB64)) {
          if (firstCmd.quiet === 0 && firstCmd.id !== undefined) {
            void sendAutoInput(`\x1b_Gi=${firstCmd.id};ENOENT:unsupported\x1b\\`);
          }
          continue;
        }

        const imgId = firstCmd.id ?? nextImgId++;
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
        if (firstCmd.action === "T" && firstCmd.unicodePlaceholder) {
          registerKittyVirtualPlacement(
            kittyVirtualDimsRef.current,
            imgId,
            firstCmd.placementId,
            syncDims.cols,
            syncDims.rows,
            firstCmd.zIndex,
          );
          flushOverlaySoon();
        }
        const anchor: KittyAnchor = state
          ? state.anchor
          : { bufferY: 0, col: 0, alt: false, colReady: !shouldCreateCursorPlacement(firstCmd), rowReady: true };
        if (!state && shouldCreateCursorPlacement(firstCmd)) {
          term.write("", () => {
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

        const finishAsset = (asset: KittyImageAsset) => {
          if (termRef.current !== term) return;
          storeKittyAsset(imgId, asset);
          const commit = () => {
            if (termRef.current !== term) return;
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
                );
                flushOverlaySoon();
              }
            } else if (kittyVirtualDimsRef.current.size > 0) {
              flushOverlaySoon();
            }
            if (firstCmd.quiet === 0 && firstCmd.id !== undefined) {
              void sendAutoInput(`\x1b_Gi=${firstCmd.id};OK\x1b\\`);
            }
          };
          if (anchor.colReady && anchor.rowReady) commit();
          else term.write("", commit);
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
        const rawData = payloadBytes!;
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
        });
      }
    };

    const writeFallbackScreen = (lines: string[]) => {
      if (sawRaw) return;
      fallbackLines = lines;
      term.write(`\x1b[2J\x1b[H${lines.join("\r\n")}`);
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
    const OUTPUT_CLOCK_MS = 33;
    const INPUT_FAST_MS = 200;
    const FLUSH_BYTE_CAP = 512 * 1024;

    const flushPendingBytes = () => {
      flushMicroQueued = false;
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
        writeSegmented(textDecoder.decode(merged, { stream: true }));
      }
    };

    const queueRawBytes = (bytes: Uint8Array) => {
      if (!bytes.length) return;
      pendingBytes.push(bytes);
      pendingByteCount += bytes.length;
      const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
      const fastEcho = !sawAnyOutput || nowMs - lastInputAtRef.current < INPUT_FAST_MS || pendingByteCount >= FLUSH_BYTE_CAP;
      sawAnyOutput = true;
      if (fastEcho) {
        if (flushTimer) {
          window.clearTimeout(flushTimer);
          flushTimer = 0;
        }
        if (!flushMicroQueued) {
          flushMicroQueued = true;
          queueMicrotask(() => {
            if (flushMicroQueued) flushPendingBytes();
          });
        }
        return;
      }
      if (!flushMicroQueued && !flushTimer) {
        flushTimer = window.setTimeout(flushPendingBytes, OUTPUT_CLOCK_MS);
      }
    };

    const waitLayoutAndFonts = async () => {
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
      const runFallbackRead = () => {
        if (!alive || sawRaw) return;
        void rpcCall(agent.deviceId, "terminal.read", { agent: agent.key, lines: 200 })
          .then((res) => {
            if (alive && !sawRaw) writeFallbackScreen((res.ansi || res.text || "").split("\n"));
          })
          .catch(() => {});
      };
      unsubRelay = subscribeStream(
        agent.deviceId,
        "terminal",
        {
          agent: agent.key,
          raw: true,
          cols: term.cols,
          rows: term.rows,
          history: 800,
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
              if (fallbackLines.length) term.reset();
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
          }
        },
        (state: { kind?: string; result?: { raw?: boolean } } | undefined) => {
          if (!alive || !state) return;
          if (state.kind === "live" && state.result?.raw === true) {
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
      seedTimer = window.setTimeout(runFallbackRead, 1000);
    };

    let triggerLocalReattach: (() => void) | null = null;
    if (native.available() && (agent.source === "hc" || agent.source === "herdr") && agent.localId) {
      const localTermId = agent.localId;
      const connectLocal = async (attempt: number): Promise<void> => {
        const gen = ++attachGen;
        if (!alive) return;
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
            history: 2000,
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
          if (dims && dims.cols > 0 && dims.rows > 0 && (dims.cols !== reqCols || dims.rows !== reqRows) && attempt < 2) {
            activeLocalConnId = null;
            if (localConnRef.current === connId) localConnRef.current = null;
            void native.localTermDetach(connId);
            fitAddon.fit();
            refreshCachedCellSize(term);
            centerScreenVerticalGap(hostEl, term);
            term.reset();
            return connectLocal(attempt + 1);
          }
          ptySizeRef.current = { cols: attRes.cols, rows: attRes.rows };
          const display = currentDisplay(term);
          if (attRes.cols !== term.cols || attRes.rows !== term.rows) {
            if (!paneOwnsFocus()) {
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
          const buffered = preResolveChunks;
          preResolveChunks = null;
          for (const chunk of buffered) {
            if (!sawRaw) sawRaw = true;
            queueRawBytes(chunk);
          }
          if (alive) {
            void localTermFocus(connId, activeRef.current && focusedRef.current);
          }
        } catch {
          preResolveChunks = null;
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
        pendingBytes = [];
        pendingByteCount = 0;
        lastResizeSigRef.current = "";
        splitter.reset();
        placeholderRewriter.reset();
        kittyPlacementsRef.current = [];
        osc66Ref.current = [];
        term.reset();
        fitAddon.fit();
        refreshCachedCellSize(term);
        centerScreenVerticalGap(hostEl, term);
        void connectLocal(0);
      };
      reattachLocalRef.current = triggerLocalReattach;

      void (async () => {
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
        const { listen } = await import("@tauri-apps/api/event");
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
      void waitLayoutAndFonts().then(() => {
        if (alive) startRelayStream();
      });
    }

    let resizeRaf = 0;
    let resizeSettleTimer = 0;
    const ro = new ResizeObserver(() => {
      if (resizeSettleTimer) window.clearTimeout(resizeSettleTimer);
      resizeSettleTimer = window.setTimeout(() => {
        resizeSettleTimer = 0;
        if (resizeRaf) cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          if (alive) syncResize(term);
        });
      }, 90);
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
      window.clearTimeout(seedTimer);
      window.clearTimeout(flushTimer);
      window.clearTimeout(webglRetryTimer);
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
      relayPendingRef.current = "";
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
      dispResetKeys.dispose();
      dispLinkProvider.dispose();
      dispData.dispose();
      document.removeEventListener("copy", onDocumentCopy, true);
      activeDragCleanup?.();
      hostEl.removeEventListener("mousemove", onHostMouseMoveHover);
      hostEl.removeEventListener("mouseleave", onHostMouseLeaveHover);
      hostEl.removeEventListener("mousedown", onHostMouseDownCapture, true);
      hostEl.removeEventListener("wheel", onHostWheel);
      textarea?.removeEventListener("focus", onTermFocus);
      textarea?.removeEventListener("blur", onTermBlur);
      window.removeEventListener("focus", onWindowFocus);
      webglAddon?.dispose();
      for (const a of assetsRefForCleanup.current.values()) revokeAssetUrl(a.url);
      assetsRefForCleanup.current.clear();
      overlayNodesRef.current.clear();
      kittyPlacementsRef.current = [];
      kittyVirtualDimsRef.current.clear();
      kittyDimsByIdRef.current.clear();
      placeholderRewriter.reset();
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

  // Refocus and refit when switching back into Terminal mode or focusing this split pane.
  useEffect(() => {
    const localConnId = localConnRef.current;
    if (localConnId) {
      void localTermFocus(localConnId, active && focused);
    }
    if (!active || !termRef.current) return;
    lastResizeSigRef.current = "";
    const id = requestAnimationFrame(() => {
      if (!termRef.current) return;
      if (focusedRef.current) {
        const prevConn = localConnRef.current;
        termRef.current.focus();
        if (localConnRef.current === prevConn) {
          if (externalSizeOverrideRef.current) {
            externalSizeOverrideRef.current = false;
          }
          syncResize(termRef.current, true);
        }
      } else {
        syncResize(termRef.current);
      }
      paintOverlays();
    });
    return () => cancelAnimationFrame(id);
  }, [active, focused, paintOverlays, syncResize]);

  // Accept dictated text from desktop VoiceInput when this terminal pane is active and focused.
  useEffect(() => {
    const onVoiceInput = (ev: Event) => {
      const detail = (ev as CustomEvent<{ text?: string }>).detail;
      const text = detail?.text;
      if (!text || !activeRef.current || !focusedRef.current) return;
      const hostEl = hostRef.current;
      if (!hostEl || hostEl.offsetParent === null) return;
      void sendInput(text);
      requestAnimationFrame(() => termRef.current?.focus());
    };
    window.addEventListener("pocket:voice-term-input", onVoiceInput);
    return () => window.removeEventListener("pocket:voice-term-input", onVoiceInput);
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
        "--tp-term-scroll": activeSpec.mode === "light" ? "rgba(0, 0, 0, 0.22)" : "rgba(255, 255, 255, 0.18)",
        "--tp-term-scroll-hover": activeSpec.mode === "light" ? "rgba(0, 0, 0, 0.42)" : "rgba(255, 255, 255, 0.34)",
        "--tp-term-drop-bg": activeSpec.mode === "light" ? "rgba(255, 255, 255, 0.88)" : "rgba(23, 25, 29, 0.86)",
        "--tp-term-drop-fg": activeSpec.mode === "light" ? "#25272c" : "#f0f0f2",
      }) as CSSProperties,
    [activeSpec.bg, activeSpec.mode],
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
        const link = cell?.link || undefined;
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
      <div ref={overlayRef} className="tp-term-overlay" aria-hidden />
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
