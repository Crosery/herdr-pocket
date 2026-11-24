export interface TerminalImeKeyLike {
  isComposing?: boolean;
  keyCode?: number;
  key?: string;
}

/** Returns true when a DOM KeyboardEvent belongs to an active IME or dead-key sequence. */
export function isImeKeyEvent(e: TerminalImeKeyLike): boolean {
  return Boolean(e.isComposing || e.keyCode === 229 || e.key === "Process" || e.key === "Dead");
}

export interface TerminalImeBridge {
  handleXtermData(data: string): void;
  isComposing(): boolean;
  syncCompositionOverlay(): void;
  dispose(): void;
}

export type TerminalImeTelemetryEvent = "rescue_xpc" | "rescue_comp" | "paste_dedup";

export interface AttachTerminalImeOptions {
  onTelemetry?: (event: TerminalImeTelemetryEvent, meta: Record<string, number | string | boolean>) => void;
}

const INPUT_SETTLE_MS = 12;
const COMP_SETTLE_MS = 14;
const PASTE_SUPPRESS_MS = 80;
const COMMIT_MATCH_WINDOW_MS = 120;
const IDLE_COMPACT_AFTER_MS = 2_500;
const IDLE_COMPACT_MIN_LEN = 16_384;
const COMMIT_INPUT_TYPES = new Set([
  "insertText",
  "insertFromComposition",
  "insertReplacementText",
]);

function unwrapTerminalCommitText(data: string): string {
  let out = data;
  if (out.startsWith("\x1b[200~")) out = out.slice(6);
  if (out.endsWith("\x1b[201~")) out = out.slice(0, -6);
  return out.replace(/\r\n?/g, "\n");
}

const utf8Encoder = new TextEncoder();

export interface CompositionOverlayMetrics {
  cursorLeft: number;
  cursorTop: number;
  cellHeight: number;
  screenWidth: number;
  screenHeight: number;
  naturalWidth: number;
  naturalHeight: number;
}

/** Keeps active IME / voice dictation preedit inline and strictly inside `.xterm-screen` bounds so long voice input wraps vertically without horizontal push. */
export function clampCompositionOverlayLayout(m: CompositionOverlayMetrics): {
  left: number;
  top: number;
  maxWidth: number;
} {
  const screenWidth = Math.max(80, m.screenWidth);
  const screenHeight = Math.max(24, m.screenHeight);
  const fullMaxWidth = Math.max(76, screenWidth - 4);
  const cursorLeft = Math.max(0, Math.min(m.cursorLeft, screenWidth - 2));
  const inlineAvail = screenWidth - cursorLeft - 4;
  let left: number;
  let maxWidth: number;
  let wrappedToNextRow = false;
  if (inlineAvail >= 160 || m.naturalWidth <= inlineAvail) {
    left = cursorLeft;
    maxWidth = Math.max(76, Math.round(inlineAvail));
  } else {
    left = 2;
    maxWidth = Math.round(fullMaxWidth);
    wrappedToNextRow = cursorLeft > 8;
  }
  const cellH = Math.max(1, m.cellHeight || 18);
  const height = Math.max(1, m.naturalHeight || cellH);
  const bottomMargin = 2;
  let top = Math.max(0, m.cursorTop + (wrappedToNextRow ? cellH : 0));
  if (top + height > screenHeight - bottomMargin) {
    top = Math.max(0, Math.min(m.cursorTop - height - 2, screenHeight - height - bottomMargin));
  }
  return { left: Math.round(left), top: Math.round(top), maxWidth: Math.round(maxWidth) };
}

/**
 * Splits long multi-character voice dictation / paste commits into <= 512-byte UTF-8 chunks
 * (below Darwin PTY canonical `MAX_INPUT = 1024`) and wraps plain multi-char text in bracketed paste when active.
 */
export function chunkTerminalInputPayload(
  data: string,
  bracketedPaste: boolean,
  maxChunkBytes = 512,
): string[] {
  if (!data) return [];
  const cap = Math.max(64, maxChunkBytes);
  const dataBytes = utf8Encoder.encode(data).length;
  const shouldBracket =
    bracketedPaste &&
    dataBytes >= 6 &&
    Array.from(data).length >= 2 &&
    !data.includes("\x1b") &&
    !/[\x00-\x08\x0b-\x1f\x7f]/.test(data);
  const payload = shouldBracket ? `\x1b[200~${data}\x1b[201~` : data;
  if (utf8Encoder.encode(payload).length <= cap) return [payload];

  const chunks: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of payload) {
    const chBytes = utf8Encoder.encode(ch).length;
    if (cur && curBytes + chBytes > cap) {
      chunks.push(cur);
      cur = ch;
      curBytes = chBytes;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

interface PendingXtermCommit {
  data: string;
  at: number;
}

/**
 * Bridges macOS WKWebView & desktop browser IME commits (`。`, `，`, `？`, `“”`, phrases, voice IME)
 * onto xterm.js without duplicate sends, wiped textarea offsets, or swallowed XPC commits.
 */
export function attachTerminalImeBridge(
  textarea: HTMLTextAreaElement | null | undefined,
  onCommit: (data: string) => void,
  opts?: AttachTerminalImeOptions,
): TerminalImeBridge {
  let composing = false;
  let emittedSeq = 0;
  let beforeInputSeq: number | null = null;
  let captureSeq: number | null = null;
  let lastCompEnd: { data: string; at: number } | null = null;
  let lastPasteAt = 0;
  let lastActivityAt = Date.now();
  let compactTimer: ReturnType<typeof setTimeout> | null = null;
  const xtermCommits: PendingXtermCommit[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const emitTelemetry = (event: TerminalImeTelemetryEvent, meta: Record<string, number | string | boolean>) => {
    try {
      opts?.onTelemetry?.(event, meta);
    } catch {
      // ignore telemetry failures
    }
  };

  const pruneCommits = (now: number) => {
    while (xtermCommits.length > 0 && now - xtermCommits[0]!.at > COMMIT_MATCH_WINDOW_MS) {
      xtermCommits.shift();
    }
  };

  const consumeMatchingXtermCommit = (data: string, sinceAt: number): boolean => {
    const now = Date.now();
    pruneCommits(now);
    const normData = unwrapTerminalCommitText(data);
    const idx = xtermCommits.findIndex((c) => {
      if (c.at < sinceAt - 4) return false;
      if (c.data === data || (data.length >= 16 && (c.data.endsWith(data) || data.endsWith(c.data)))) {
        return true;
      }
      const normCommit = unwrapTerminalCommitText(c.data);
      return (
        normCommit === normData ||
        (normData.length >= 16 && (normCommit.endsWith(normData) || normData.endsWith(normCommit)))
      );
    });
    if (idx < 0) return false;
    xtermCommits.splice(idx, 1);
    return true;
  };

  const handleXtermData = (data: string) => {
    if (!data) return;
    lastActivityAt = Date.now();
    emittedSeq += 1;
    pruneCommits(lastActivityAt);
    xtermCommits.push({ data, at: lastActivityAt });
    if (xtermCommits.length > 32) xtermCommits.shift();
    onCommit(data);
  };

  if (!textarea) {
    return {
      handleXtermData,
      isComposing: () => false,
      syncCompositionOverlay: () => {},
      dispose: () => {},
    };
  }

  textarea.setAttribute?.("autocorrect", "off");
  textarea.setAttribute?.("autocapitalize", "off");
  textarea.setAttribute?.("autocomplete", "off");
  textarea.spellcheck = false;

  const scheduleTimer = (ms: number, fn: () => void) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };

  // Never reset textarea.value during active typing; xterm CompositionHelper relies on monotonic offsets.
  // Only reclaim unbounded growth after prolonged idle when no composition is active.
  const scheduleLongIdleCompact = () => {
    if (textarea.value.length <= IDLE_COMPACT_MIN_LEN) return;
    if (compactTimer !== null) clearTimeout(compactTimer);
    compactTimer = setTimeout(() => {
      compactTimer = null;
      if (!composing && textarea.value.length > IDLE_COMPACT_MIN_LEN && Date.now() - lastActivityAt >= IDLE_COMPACT_AFTER_MS) {
        textarea.value = "";
      }
    }, IDLE_COMPACT_AFTER_MS);
  };

  const findCompositionView = (): HTMLElement | null => {
    const parent = textarea.parentElement as { querySelector?: (sel: string) => Element | null } | null;
    if (!parent || typeof parent.querySelector !== "function") return null;
    return parent.querySelector(".composition-view") as HTMLElement | null;
  };

  const findScreenElement = (): HTMLElement | null => {
    const closestScreen = (textarea as unknown as { closest?: (sel: string) => Element | null }).closest?.(
      ".xterm-screen",
    ) as HTMLElement | null;
    if (closestScreen && typeof closestScreen.getBoundingClientRect === "function") {
      const r = closestScreen.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return closestScreen;
    }
    let cur = textarea.parentElement as HTMLElement | null;
    for (let depth = 0; cur && depth < 4; depth += 1) {
      if (typeof cur.getBoundingClientRect === "function") {
        const r = cur.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return cur;
      }
      cur = cur.parentElement as HTMLElement | null;
    }
    return null;
  };

  const clearStuckCompositionView = () => {
    if (composing) return;
    const compView = findCompositionView();
    if (!compView) return;
    compView.classList?.remove("active");
    compView.classList?.remove("tp-ime-clamped");
    const styleObj = compView.style as CSSStyleDeclaration & Record<string, unknown>;
    if (typeof styleObj?.removeProperty === "function") {
      styleObj.removeProperty("--tp-ime-left");
      styleObj.removeProperty("--tp-ime-top");
      styleObj.removeProperty("--tp-ime-max-w");
      styleObj.removeProperty("--tp-ime-line-h");
    }
    if (compView.textContent) compView.textContent = "";
  };

  const clampCompositionOverlay = () => {
    if (!composing) return;
    const compView = findCompositionView();
    const screenEl = findScreenElement();
    if (!compView || !screenEl) return;
    if (typeof screenEl.scrollLeft === "number" && screenEl.scrollLeft !== 0) screenEl.scrollLeft = 0;
    const screenRect = screenEl.getBoundingClientRect();
    if (screenRect.width <= 0 || screenRect.height <= 0) return;

    const taLeft = textarea.style ? parseFloat(textarea.style.left || "") : Number.NaN;
    const taTop = textarea.style ? parseFloat(textarea.style.top || "") : Number.NaN;
    const curLeft = Number.isFinite(taLeft) && taLeft >= 0 ? taLeft : parseFloat(compView.style?.left || "0") || 0;
    const curTop = Number.isFinite(taTop) && taTop >= 0 ? taTop : parseFloat(compView.style?.top || "0") || 0;
    const cellH = parseFloat(compView.style?.lineHeight || compView.style?.height || "18") || 18;
    const initialHeight = compView.offsetHeight || cellH;
    const firstPass = clampCompositionOverlayLayout({
      cursorLeft: curLeft,
      cursorTop: curTop,
      cellHeight: cellH,
      screenWidth: screenRect.width,
      screenHeight: screenRect.height,
      naturalWidth: compView.offsetWidth || Math.min(screenRect.width, (compView.textContent?.length ?? 1) * 14),
      naturalHeight: initialHeight,
    });
    if (compView.style) {
      compView.classList?.add?.("tp-ime-clamped");
      const setCssVar = (name: string, val: string) => {
        const s = compView.style as CSSStyleDeclaration & Record<string, string>;
        if (typeof s.setProperty === "function") s.setProperty(name, val);
        else s[name] = val;
      };
      setCssVar("--tp-ime-max-w", `${firstPass.maxWidth}px`);
      setCssVar("--tp-ime-left", `${firstPass.left}px`);
      setCssVar("--tp-ime-line-h", `${Math.max(12, Math.round(cellH))}px`);
      compView.style.maxWidth = `${firstPass.maxWidth}px`;
      if (firstPass.left !== Math.round(curLeft)) {
        compView.style.left = `${firstPass.left}px`;
      }
      const wrappedHeight = compView.offsetHeight || cellH;
      const finalPass =
        wrappedHeight > initialHeight
          ? clampCompositionOverlayLayout({
              cursorLeft: curLeft,
              cursorTop: curTop,
              cellHeight: cellH,
              screenWidth: screenRect.width,
              screenHeight: screenRect.height,
              naturalWidth: compView.offsetWidth || firstPass.maxWidth,
              naturalHeight: wrappedHeight,
            })
          : firstPass;
      setCssVar("--tp-ime-top", `${finalPass.top}px`);
      setCssVar("--tp-ime-left", `${finalPass.left}px`);
      setCssVar("--tp-ime-max-w", `${finalPass.maxWidth}px`);
      if (finalPass.top !== Math.round(curTop)) {
        compView.style.top = `${finalPass.top}px`;
      }
    }
  };

  const captureHost: EventTarget = textarea.parentElement ?? textarea;

  const onCaptureInput = (ev: Event) => {
    if (ev.target !== textarea) return;
    lastActivityAt = Date.now();
    captureSeq = emittedSeq;
  };

  const onBeforeInput = (ev: Event) => {
    if (ev.target !== textarea) return;
    lastActivityAt = Date.now();
    beforeInputSeq = emittedSeq;
  };

  const onCompositionStart = () => {
    composing = true;
    lastActivityAt = Date.now();
    beforeInputSeq = null;
    captureSeq = null;
    lastCompEnd = null;
    clampCompositionOverlay();
    scheduleTimer(0, clampCompositionOverlay);
  };

  const onCompositionUpdate = () => {
    lastActivityAt = Date.now();
    clampCompositionOverlay();
    scheduleTimer(0, clampCompositionOverlay);
    scheduleTimer(4, clampCompositionOverlay);
  };

  const onCompositionEnd = (ev: Event) => {
    composing = false;
    lastActivityAt = Date.now();
    const compData = (ev as CompositionEvent).data ?? "";
    const endedAt = Date.now();
    if (compData) lastCompEnd = { data: compData, at: endedAt };
    const settleMs = compData.length > 64 ? 20 : COMP_SETTLE_MS;
    scheduleTimer(settleMs, () => {
      if (composing) return;
      if (compData && !consumeMatchingXtermCommit(compData, endedAt)) {
        emitTelemetry("rescue_comp", { chars: compData.length });
        onCommit(compData);
      }
      clearStuckCompositionView();
      scheduleLongIdleCompact();
    });
  };

  const onPaste = (ev: Event) => {
    composing = false;
    lastPasteAt = Date.now();
    lastActivityAt = lastPasteAt;
    if ((ev as ClipboardEvent).clipboardData) {
      ev.preventDefault?.();
    }
    scheduleTimer(0, clearStuckCompositionView);
  };

  const onBubbleInput = (ev: Event) => {
    const inputEv = ev as InputEvent;
    lastActivityAt = Date.now();
    if (composing || inputEv.isComposing || inputEv.inputType === "insertCompositionText") {
      beforeInputSeq = null;
      captureSeq = null;
      if (composing) scheduleTimer(0, clampCompositionOverlay);
      return;
    }

    const inputType = typeof inputEv.inputType === "string" ? inputEv.inputType : "";
    if (inputType === "insertFromPaste" || Date.now() - lastPasteAt < PASTE_SUPPRESS_MS) {
      beforeInputSeq = null;
      captureSeq = null;
      emitTelemetry("paste_dedup", { inputType: inputType || "recent_paste" });
      scheduleLongIdleCompact();
      return;
    }
    const baselineSeq = beforeInputSeq ?? captureSeq ?? emittedSeq;
    beforeInputSeq = null;
    captureSeq = null;

    const rawData = typeof inputEv.data === "string" ? inputEv.data : "";
    if (!rawData || (inputType && !COMMIT_INPUT_TYPES.has(inputType))) {
      scheduleLongIdleCompact();
      return;
    }

    const now = Date.now();
    if (inputType === "insertFromComposition" && lastCompEnd && lastCompEnd.data === rawData && now - lastCompEnd.at < 25) {
      scheduleLongIdleCompact();
      return;
    }

    if (emittedSeq > baselineSeq || consumeMatchingXtermCommit(rawData, now)) {
      scheduleLongIdleCompact();
      return;
    }

    // Wait past xterm's 0ms _handleAnyTextareaChanges timer before rescuing dropped WKWebView XPC commits.
    scheduleTimer(INPUT_SETTLE_MS, () => {
      if (composing) return;
      if (!consumeMatchingXtermCommit(rawData, now)) {
        emitTelemetry("rescue_xpc", { chars: rawData.length, inputType: inputType || "unknown" });
        onCommit(rawData);
      }
      scheduleLongIdleCompact();
    });
  };

  captureHost.addEventListener("input", onCaptureInput, true);
  textarea.addEventListener("beforeinput", onBeforeInput, true);
  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionupdate", onCompositionUpdate);
  textarea.addEventListener("compositionend", onCompositionEnd);
  textarea.addEventListener("paste", onPaste);
  textarea.addEventListener("input", onBubbleInput);

  return {
    handleXtermData,
    isComposing: () => composing,
    syncCompositionOverlay: clampCompositionOverlay,
    dispose: () => {
      if (compactTimer !== null) {
        clearTimeout(compactTimer);
        compactTimer = null;
      }
      for (const id of timers) clearTimeout(id);
      timers.clear();
      captureHost.removeEventListener("input", onCaptureInput, true);
      textarea.removeEventListener("beforeinput", onBeforeInput, true);
      textarea.removeEventListener("compositionstart", onCompositionStart);
      textarea.removeEventListener("compositionupdate", onCompositionUpdate);
      textarea.removeEventListener("compositionend", onCompositionEnd);
      textarea.removeEventListener("paste", onPaste);
      textarea.removeEventListener("input", onBubbleInput);
    },
  };
}
