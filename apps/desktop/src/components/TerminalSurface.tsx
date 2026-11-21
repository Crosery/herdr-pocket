import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { applyRows, type Agent, type TerminalDisplay } from "@herdr-pocket/protocol";
import { copyToClipboard } from "../lib/bridge";
import { useClientConfig } from "../lib/config";
import {
  KittyApcSplitter,
  KittyKeyboardState,
  encodeKittyKey,
  parseKittyGfxCommand,
  parseOsc66,
  shellQuotePath,
  type KittyGfxCommand,
} from "../lib/kittyProtocol";
import { rpcCall, subscribeStream } from "../lib/relay";
import { settingsStore } from "../lib/store";
import { IS_MAC, matchShortcut } from "../shell/shortcuts";
import { useToast } from "./PocketUI";
import "../styles/terminal.css";

interface KittyImageAsset {
  id: number;
  url: string;
  width: number;
  height: number;
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
}

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

const TERM_BG = "#16141d";
const TERM_FG = "#f4eef8";
const TERM_CURSOR = "#ff71a8";

const BASE_THEME = {
  background: TERM_BG,
  foreground: TERM_FG,
  cursor: TERM_CURSOR,
  cursorAccent: "#16141d",
  selectionBackground: "rgba(255, 113, 168, 0.28)",
  black: "#252131",
  red: "#ff6b8b",
  green: "#6be0a6",
  yellow: "#f6c96b",
  blue: "#7ab8ff",
  magenta: "#eb8eff",
  cyan: "#6fdce8",
  white: "#ece5f5",
  brightBlack: "#7b7391",
  brightRed: "#ff8ba3",
  brightGreen: "#8eedbc",
  brightYellow: "#ffe08f",
  brightBlue: "#9ecbff",
  brightMagenta: "#f3b0ff",
  brightCyan: "#96eaf4",
  brightWhite: "#ffffff",
} as const;

export function buildTerminalFontFamily(customFamily: string): string {
  const custom = customFamily.trim();
  const fallback =
    'ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", monospace';
  if (!custom) return fallback;
  const formatted = custom
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (/^[A-Za-z0-9_-]+$/.test(p) || /^["'].*["']$/.test(p) ? p : JSON.stringify(p)))
    .join(", ");
  return formatted ? `${formatted}, ${fallback}` : fallback;
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

async function decodeKittyAsset(cmd: KittyGfxCommand, rawBytes: Uint8Array, id: number): Promise<KittyImageAsset | null> {
  const bytes = await decompressZlibIfNeeded(rawBytes, cmd.compression);
  if (!bytes.length) return null;

  if (cmd.format === 100) {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const blob = new Blob([copy], { type: "image/png" });
    const url = URL.createObjectURL(blob);
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
  if (w <= 0 || h <= 0 || w * h > 4096 * 4096) return null;
  const rgba = new Uint8ClampedArray(w * h * 4);
  if (cmd.format === 32) {
    rgba.set(bytes.subarray(0, rgba.length));
  } else {
    // f=24 (RGB -> RGBA)
    for (let src = 0, dst = 0; dst < rgba.length && src + 2 < bytes.length; src += 3, dst += 4) {
      rgba[dst] = bytes[src]!;
      rgba[dst + 1] = bytes[src + 1]!;
      rgba[dst + 2] = bytes[src + 2]!;
      rgba[dst + 3] = 255;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  const url = await new Promise<string | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), "image/png");
  });
  return url ? { id, url, width: w, height: h } : null;
}

function measureCellCss(hostEl: HTMLElement | null, term: XTerm): [number, number] {
  const screen = hostEl?.querySelector<HTMLElement>(".xterm-screen");
  if (screen && term.cols > 0 && term.rows > 0 && screen.clientWidth > 0 && screen.clientHeight > 0) {
    return [screen.clientWidth / term.cols, screen.clientHeight / term.rows];
  }
  const fs = term.options.fontSize ?? 13;
  const lh = term.options.lineHeight ?? 1.2;
  return [Math.max(5, fs * 0.6), Math.max(10, fs * lh)];
}

export function TerminalSurface({
  agent,
  active,
}: {
  agent: Agent;
  active: boolean;
}) {
  const toast = useToast();
  const termCfg = useClientConfig().terminal;
  const themeChoice = settingsStore.use((s) => s.theme);
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const kittyKeysRef = useRef(new KittyKeyboardState());
  const osc66Ref = useRef<Osc66Run[]>([]);
  const kittyAssetsRef = useRef<Map<number, KittyImageAsset>>(new Map());
  const kittyPlacementsRef = useRef<KittyPlacement[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  const fontFamily = useMemo(() => buildTerminalFontFamily(termCfg.fontFamily), [termCfg.fontFamily]);
  const lineHeight = useMemo(() => Number((termCfg.lineHeight / 100).toFixed(2)), [termCfg.lineHeight]);

  const sendInput = useCallback(
    async (data: string) => {
      if (!data) return;
      for (let off = 0; off < data.length; off += 16_384) {
        const chunk = data.slice(off, off + 16_384);
        try {
          await rpcCall(agent.deviceId, "terminal.input", { agent: agent.key, data: chunk });
        } catch {
          await rpcCall(agent.deviceId, "terminal.send", { agent: agent.key, text: chunk, enter: false }).catch(() => {});
        }
      }
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

  const currentDisplay = useCallback((term: XTerm): TerminalDisplay => {
    const [cw, ch] = measureCellCss(hostRef.current, term);
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    return {
      fg: TERM_FG,
      bg: TERM_BG,
      cursor: TERM_CURSOR,
      cell: [Math.max(1, Math.round(cw * dpr)), Math.max(1, Math.round(ch * dpr))],
    };
  }, []);

  const syncResize = useCallback(
    (term: XTerm) => {
      if (!activeRef.current || !hostRef.current || hostRef.current.clientWidth <= 0 || hostRef.current.clientHeight <= 0) {
        return;
      }
      fitRef.current?.fit();
      void rpcCall(agent.deviceId, "terminal.resize", {
        agent: agent.key,
        cols: term.cols,
        rows: term.rows,
        display: currentDisplay(term),
      }).catch(() => {});
    },
    [agent.deviceId, agent.key, currentDisplay],
  );

  const paintOverlays = useCallback(() => {
    const term = termRef.current;
    const overlay = overlayRef.current;
    const hostEl = hostRef.current;
    if (!term || !overlay || !hostEl) return;

    const screen = hostEl.querySelector<HTMLElement>(".xterm-screen");
    if (screen && overlay.parentElement !== screen) {
      screen.appendChild(overlay);
    }

    const [cellW, cellH] = measureCellCss(hostEl, term);
    const buf = term.buffer.active;
    const curAlt = buf === term.buffer.alternate;
    const topY = buf.viewportY;
    const botY = topY + term.rows;
    const maxBufLines = buf.length;

    // Drop items scrolled out of buffer retention cleanly.
    if (osc66Ref.current.length > 0 && osc66Ref.current[0]!.bufferY < buf.length - (term.options.scrollback ?? 3000) - term.rows) {
      osc66Ref.current = osc66Ref.current.filter((r) => r.alt || r.bufferY >= Math.max(0, maxBufLines - 3000));
    }

    const frag = document.createDocumentFragment();

    for (const p of kittyPlacementsRef.current) {
      if (p.alt !== curAlt || p.bufferY + p.rows <= topY || p.bufferY >= botY) continue;
      const asset = kittyAssetsRef.current.get(p.imageId);
      if (!asset) continue;
      const img = document.createElement("img");
      img.className = "tp-kitty-img";
      img.src = asset.url;
      img.alt = "";
      img.style.left = `${Math.round(p.col * cellW)}px`;
      img.style.top = `${Math.round((p.bufferY - topY) * cellH)}px`;
      img.style.width = `${Math.max(cellW, Math.round(p.cols * cellW))}px`;
      img.style.height = `${Math.max(cellH, Math.round(p.rows * cellH))}px`;
      img.style.zIndex = String(Math.max(1, 5 + p.zIndex));
      frag.appendChild(img);
    }

    const fs = term.options.fontSize ?? 13;
    const ff = term.options.fontFamily ?? fontFamily;
    for (const r of osc66Ref.current) {
      if (r.alt !== curAlt || r.bufferY < topY || r.bufferY >= botY) continue;
      const span = document.createElement("div");
      span.className = "tp-osc66-run";
      span.textContent = r.text;
      span.style.left = `${Math.round(r.col * cellW)}px`;
      span.style.top = `${Math.round((r.bufferY - topY) * cellH)}px`;
      span.style.minWidth = `${Math.round(r.widthCells * cellW)}px`;
      span.style.height = `${Math.round(r.scale * cellH)}px`;
      span.style.fontFamily = ff;
      span.style.fontSize = `${Number((fs * r.scale * r.ratio).toFixed(2))}px`;
      span.style.fontWeight = String(term.options.fontWeight ?? 400);
      span.style.color = TERM_FG;
      span.style.lineHeight = "1";
      frag.appendChild(span);
    }

    overlay.replaceChildren(frag);
  }, [fontFamily]);

  // Keep overlay coordinates synchronized with live font changes.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontFamily;
    term.options.fontSize = termCfg.fontSize;
    term.options.lineHeight = lineHeight;
    term.options.fontWeight = termCfg.fontWeight as 300 | 400 | 500 | 600 | 700;
    term.options.fontWeightBold = Math.min(900, Math.max(700, termCfg.fontWeight + 200)) as 700 | 800 | 900;
    term.options.cursorBlink = termCfg.cursorBlink;
    term.clearTextureAtlas();
    syncResize(term);
    requestAnimationFrame(paintOverlays);
  }, [fontFamily, lineHeight, paintOverlays, syncResize, termCfg.cursorBlink, termCfg.fontSize, termCfg.fontWeight, themeChoice]);

  useEffect(() => {
    const hostEl = hostRef.current;
    if (!hostEl) return;

    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: termCfg.cursorBlink,
      cursorStyle: "bar",
      fontFamily,
      fontSize: termCfg.fontSize,
      lineHeight,
      fontWeight: termCfg.fontWeight as 300 | 400 | 500 | 600 | 700,
      fontWeightBold: Math.min(900, Math.max(700, termCfg.fontWeight + 200)) as 700 | 800 | 900,
      scrollback: 3000,
      minimumContrastRatio: 1,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      theme: BASE_THEME,
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

    termRef.current = term;
    fitRef.current = fitAddon;
    const kittyKeys = kittyKeysRef.current;
    kittyKeys.reset();

    term.open(hostEl);
    fitAddon.fit();

    let rafOverlay = 0;
    const scheduleOverlay = () => {
      if (rafOverlay) return;
      rafOverlay = requestAnimationFrame(() => {
        rafOverlay = 0;
        paintOverlays();
      });
    };

    const dispScroll = term.onScroll(scheduleOverlay);
    const dispRender = term.onRender(scheduleOverlay);
    const dispWrite = term.onWriteParsed(scheduleOverlay);
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
    const isAlt = () => term.buffer.active === term.buffer.alternate;
    const numParam = (p: number | number[] | undefined, def = 0): number =>
      typeof p === "number" ? p : Array.isArray(p) ? (p[0] ?? def) : def;

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
      void sendInput(`\x1b[?${kittyKeys.current(isAlt())}u`);
      return true;
    });
    const dispModifyOther = term.parser.registerCsiHandler({ prefix: ">", final: "m" }, (params) => {
      if (numParam(params[0], -1) === 4) {
        kittyKeys.modifyOtherKeys = numParam(params[1], 0);
        return true;
      }
      return false;
    });
    const dispResetKeys = term.parser.registerEscHandler({ final: "c" }, () => {
      kittyKeys.reset();
      osc66Ref.current = [];
      kittyPlacementsRef.current = [];
      scheduleOverlay();
      return false;
    });

    // Key handling: preserve global app shortcuts (⌘T/⌘W/⌘P/...), Herdr macOS keys, and Kitty CSI u.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== "keydown") return true;
      const appShortcut = matchShortcut(e);
      if (appShortcut) {
        // On Windows/Linux Ctrl+K stays inside the terminal; global handler honors terminalOwnsCtrlK.
        if (IS_MAC || appShortcut !== "palette" || e.key.toLowerCase() === "p") {
          return false;
        }
      }

      if (IS_MAC && e.metaKey && !e.ctrlKey && !e.altKey) {
        const lower = e.key.toLowerCase();
        if (lower === "c") {
          if (term.hasSelection()) {
            void copyToClipboard(term.getSelection());
            term.clearSelection();
          }
          return false;
        }
        if (lower === "v") {
          // Allow WebKit native paste event to fire into capture listener / xterm textarea once.
          return true;
        }
        if (lower === "a") {
          term.selectAll();
          return false;
        }
        // macOS terminal line-navigation & erase matching herdr-app/defaults/keys.macos.json
        if (e.key === "ArrowLeft") {
          void sendInput("\x01");
          return false;
        }
        if (e.key === "ArrowRight") {
          void sendInput("\x05");
          return false;
        }
        if (e.key === "Backspace") {
          void sendInput("\x15");
          return false;
        }
        return false;
      }

      if (IS_MAC && e.altKey && !e.metaKey && !e.ctrlKey) {
        if (e.key === "ArrowLeft") {
          void sendInput("\x1bb");
          return false;
        }
        if (e.key === "ArrowRight") {
          void sendInput("\x1bf");
          return false;
        }
        if (e.key === "Backspace") {
          void sendInput("\x17");
          return false;
        }
      }

      if (!IS_MAC && e.ctrlKey && !e.altKey && !e.metaKey) {
        const lower = e.key.toLowerCase();
        if (lower === "c" && term.hasSelection()) {
          void copyToClipboard(term.getSelection());
          term.clearSelection();
          return false;
        }
        if (e.shiftKey && lower === "c" && term.hasSelection()) {
          void copyToClipboard(term.getSelection());
          return false;
        }
        if (lower === "v") return true;
      }

      const kFlags = kittyKeys.current(isAlt());
      const encoded = encodeKittyKey(e, kFlags, kittyKeys.modifyOtherKeys, IS_MAC);
      if (encoded) {
        void sendInput(encoded);
        return false;
      }
      return true;
    });

    const dispData = term.onData((data) => {
      void sendInput(data);
    });

    // Kitty Graphics APC command state
    type KittyAnchor = { bufferY: number; col: number; alt: boolean };
    let nextImgId = 1;
    let chunkActive: { cmd: KittyGfxCommand; parts: string[]; anchor: KittyAnchor } | null = null;

    const captureAnchor = (): KittyAnchor => {
      const buf = term.buffer.active;
      return { bufferY: buf.baseY + buf.cursorY, col: buf.cursorX, alt: isAlt() };
    };

    const handleKittyCommand = (raw: string) => {
      const cmd = parseKittyGfxCommand(raw);
      if (cmd.action === "d") {
        const d = (cmd.deleteWhat || "a").toLowerCase();
        if (d === "a") kittyPlacementsRef.current = [];
        else if (d === "i" && cmd.id !== undefined) {
          kittyPlacementsRef.current = kittyPlacementsRef.current.filter((p) => p.imageId !== cmd.id);
        } else if (d === "c") {
          const cy = term.buffer.active.baseY + term.buffer.active.cursorY;
          kittyPlacementsRef.current = kittyPlacementsRef.current.filter((p) => cy < p.bufferY || cy >= p.bufferY + p.rows);
        }
        scheduleOverlay();
        return;
      }

      if (cmd.action === "p" && cmd.id !== undefined) {
        const asset = kittyAssetsRef.current.get(cmd.id);
        if (asset) placeAsset(asset, cmd, captureAnchor());
        return;
      }

      if (cmd.more) {
        if (!chunkActive) chunkActive = { cmd, parts: [cmd.payload], anchor: captureAnchor() };
        else chunkActive.parts.push(cmd.payload);
        return;
      }

      const firstCmd = chunkActive ? chunkActive.cmd : cmd;
      const syncAnchor = chunkActive ? chunkActive.anchor : captureAnchor();
      const fullB64 = chunkActive ? [...chunkActive.parts, cmd.payload].join("") : cmd.payload;
      chunkActive = null;

      if (firstCmd.action === "q") {
        if (firstCmd.quiet === 0 && firstCmd.id !== undefined) {
          void sendInput(`\x1b_Gi=${firstCmd.id};OK\x1b\\`);
        }
        return;
      }

      if (firstCmd.medium !== "d" || !fullB64) return;
      const imgId = firstCmd.id ?? nextImgId++;
      let rawBytes: Uint8Array;
      try {
        rawBytes = decodeBase64Bytes(fullB64);
      } catch {
        return;
      }

      let rowsReserved = false;
      if (firstCmd.action === "T" && firstCmd.rows && firstCmd.cursorMovement === 0 && !firstCmd.unicodePlaceholder) {
        const linesDown = Math.max(0, firstCmd.rows - 1);
        if (linesDown > 0) term.write(`${"\n".repeat(linesDown)}\r`);
        rowsReserved = true;
      }

      void decodeKittyAsset(firstCmd, rawBytes, imgId).then((asset) => {
        if (!asset || termRef.current !== term) return;
        const prev = kittyAssetsRef.current.get(imgId);
        if (prev) URL.revokeObjectURL(prev.url);
        kittyAssetsRef.current.set(imgId, asset);
        if (kittyAssetsRef.current.size > 64) {
          const oldest = kittyAssetsRef.current.keys().next().value;
          if (oldest !== undefined) {
            const old = kittyAssetsRef.current.get(oldest);
            if (old) URL.revokeObjectURL(old.url);
            kittyAssetsRef.current.delete(oldest);
          }
        }
        if (firstCmd.action === "T") placeAsset(asset, firstCmd, syncAnchor, rowsReserved);
        if (firstCmd.quiet === 0 && firstCmd.id !== undefined) {
          void sendInput(`\x1b_Gi=${firstCmd.id};OK\x1b\\`);
        }
      });
    };

    const placeAsset = (asset: KittyImageAsset, cmd: KittyGfxCommand, anchor?: KittyAnchor, rowsReserved = false) => {
      const [cellW, cellH] = measureCellCss(hostRef.current, term);
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      const cols = cmd.cols ?? Math.max(1, Math.min(term.cols, Math.ceil(asset.width / Math.max(1, cellW * dpr))));
      const rows = cmd.rows ?? Math.max(1, Math.min(term.rows, Math.ceil(asset.height / Math.max(1, cellH * dpr))));
      const buf = term.buffer.active;
      const bufferY = anchor?.bufferY ?? (buf.baseY + buf.cursorY);
      const col = anchor?.col ?? buf.cursorX;
      const alt = anchor?.alt ?? isAlt();
      kittyPlacementsRef.current.push({
        key: `kp-${asset.id}-${Date.now()}-${kittyPlacementsRef.current.length}`,
        alt,
        imageId: asset.id,
        placementId: cmd.placementId ?? 1,
        bufferY,
        col,
        cols,
        rows,
        zIndex: cmd.zIndex,
      });
      if (kittyPlacementsRef.current.length > 200) kittyPlacementsRef.current.splice(0, kittyPlacementsRef.current.length - 200);
      if (!rowsReserved && cmd.cursorMovement === 0 && !cmd.unicodePlaceholder) {
        // Reserve vertical rows below image like native Kitty so shell prompts don't overwrite the image.
        const linesDown = Math.max(0, rows - 1);
        if (linesDown > 0) term.write(`${"\n".repeat(linesDown)}\r`);
      }
      scheduleOverlay();
    };

    // PTY Stream + graceful fallback for mock/legacy hosts
    let alive = true;
    let sawRaw = false;
    let fallbackLines: string[] = [];
    const splitter = new KittyApcSplitter();
    const textDecoder = new TextDecoder("utf-8", { fatal: false });

    const writeSegmented = (rawText: string) => {
      const segments = splitter.push(rawText);
      for (const seg of segments) {
        if (seg.kind === "vt") {
          term.write(seg.data);
        } else {
          term.write("", () => handleKittyCommand(seg.raw));
        }
      }
    };

    const writeFallbackScreen = (lines: string[]) => {
      if (sawRaw) return;
      fallbackLines = lines;
      term.write(`\x1b[2J\x1b[H${lines.join("\r\n")}`);
    };

    const unsub = subscribeStream(
      agent.deviceId,
      "terminal",
      {
        agent: agent.key,
        raw: true,
        cols: term.cols,
        rows: term.rows,
        history: 2000,
        display: currentDisplay(term),
      },
      (ev) => {
        if (!alive || !ev) return;
        if (ev.kind === "terminal_data" && typeof ev.data === "string") {
          if (!sawRaw) {
            sawRaw = true;
            if (fallbackLines.length) term.reset();
          }
          try {
            const bytes = decodeBase64Bytes(ev.data);
            writeSegmented(textDecoder.decode(bytes, { stream: true }));
          } catch {
            /* ignore malformed chunk */
          }
        } else if (ev.kind === "terminal" && ev.screen) {
          writeFallbackScreen(String(ev.screen.ansi || ev.screen.text || "").split("\n"));
        } else if (ev.kind === "terminal_rows") {
          writeFallbackScreen(applyRows(fallbackLines, ev));
        }
      },
    );

    const seedTimer = window.setTimeout(() => {
      if (!alive || sawRaw) return;
      void rpcCall(agent.deviceId, "terminal.read", { agent: agent.key, lines: 200 })
        .then((res) => {
          if (alive && !sawRaw) writeFallbackScreen((res.ansi || res.text || "").split("\n"));
        })
        .catch(() => {});
    }, 150);

    let resizeTimer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (alive) syncResize(term);
      }, 50);
    });
    ro.observe(hostEl);

    if (activeRef.current) {
      requestAnimationFrame(() => term.focus());
    }

    const assetsRefForCleanup = kittyAssetsRef;

    return () => {
      alive = false;
      window.clearTimeout(seedTimer);
      window.clearTimeout(resizeTimer);
      if (rafOverlay) cancelAnimationFrame(rafOverlay);
      ro.disconnect();
      unsub();
      dispScroll.dispose();
      dispRender.dispose();
      dispWrite.dispose();
      dispBuf.dispose();
      dispOsc66.dispose();
      dispCsiPush.dispose();
      dispCsiPop.dispose();
      dispCsiSet.dispose();
      dispCsiQuery.dispose();
      dispModifyOther.dispose();
      dispResetKeys.dispose();
      dispData.dispose();
      for (const a of assetsRefForCleanup.current.values()) URL.revokeObjectURL(a.url);
      assetsRefForCleanup.current.clear();
      kittyPlacementsRef.current = [];
      osc66Ref.current = [];
      term.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fitAddon) fitRef.current = null;
    };
    // Intentionally mounts once per agent session key; live font/display props synchronize in separate effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.deviceId, agent.key]);

  // Refocus and refit when switching back into Terminal mode.
  useEffect(() => {
    if (!active || !termRef.current) return;
    const id = requestAnimationFrame(() => {
      if (!termRef.current) return;
      syncResize(termRef.current);
      termRef.current.focus();
      paintOverlays();
    });
    return () => cancelAnimationFrame(id);
  }, [active, paintOverlays, syncResize]);

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    dragDepthRef.current = 0;
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    e.preventDefault();
    e.stopPropagation();
    void sendFilesToPty(files);
  };

  return (
    <div
      className={`tp-term-wrap${dragOver ? " drop-over" : ""}`}
      onMouseDown={() => termRef.current?.focus()}
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
    </div>
  );
}
