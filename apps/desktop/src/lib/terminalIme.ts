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
  dispose(): void;
}

const INPUT_SETTLE_MS = 6;
const COMP_SETTLE_MS = 8;
const COMMIT_MATCH_WINDOW_MS = 120;
const COMMIT_INPUT_TYPES = new Set([
  "insertText",
  "insertFromComposition",
  "insertReplacementText",
  "insertFromPaste",
]);

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

/** Keeps active IME / voice dictation preedit overlays inside `.xterm-screen` instead of clipping off the right/bottom edges. */
export function clampCompositionOverlayLayout(m: CompositionOverlayMetrics): {
  left: number;
  top: number;
  maxWidth: number;
} {
  const screenWidth = Math.max(80, m.screenWidth);
  const screenHeight = Math.max(24, m.screenHeight);
  const maxWidth = Math.max(80, screenWidth - 8);
  const width = Math.min(Math.max(1, m.naturalWidth), maxWidth);
  const height = Math.max(1, m.naturalHeight || m.cellHeight || 18);
  const left = Math.max(4, Math.min(m.cursorLeft, screenWidth - width - 4));
  let top = Math.max(2, m.cursorTop);
  if (top + height > screenHeight - 4) {
    top = Math.max(2, m.cursorTop - height - 2);
  }
  return { left: Math.round(left), top: Math.round(top), maxWidth: Math.round(maxWidth) };
}

/**
 * Splits long multi-character voice dictation / paste commits into <= 512-byte UTF-8 chunks
 * (below Darwin PTY canonical `MAX_INPUT = 1024`) and wraps plain text in bracketed paste when active.
 */
export function chunkTerminalInputPayload(
  data: string,
  bracketedPaste: boolean,
  maxChunkBytes = 512,
): string[] {
  if (!data) return [];
  const cap = Math.max(64, maxChunkBytes);
  const dataBytes = utf8Encoder.encode(data).length;
  const shouldBracket = bracketedPaste && dataBytes > 240 && !data.includes("\x1b") && !data.includes("\x00");
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
 * onto xterm.js without duplicate sends, stuck preedit boxes, or swallowed XPC commits.
 */
export function attachTerminalImeBridge(
  textarea: HTMLTextAreaElement | null | undefined,
  onCommit: (data: string) => void,
): TerminalImeBridge {
  let composing = false;
  let emittedSeq = 0;
  let beforeInputSeq: number | null = null;
  let captureSeq: number | null = null;
  let lastCompEnd: { data: string; at: number } | null = null;
  const xtermCommits: PendingXtermCommit[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const pruneCommits = (now: number) => {
    while (xtermCommits.length > 0 && now - xtermCommits[0]!.at > COMMIT_MATCH_WINDOW_MS) {
      xtermCommits.shift();
    }
  };

  const consumeMatchingXtermCommit = (data: string, sinceAt: number): boolean => {
    const now = Date.now();
    pruneCommits(now);
    const idx = xtermCommits.findIndex(
      (c) =>
        c.at >= sinceAt - 4 &&
        (c.data === data || (data.length >= 16 && (c.data.endsWith(data) || data.endsWith(c.data)))),
    );
    if (idx < 0) return false;
    xtermCommits.splice(idx, 1);
    return true;
  };

  const handleXtermData = (data: string) => {
    if (!data) return;
    emittedSeq += 1;
    const now = Date.now();
    pruneCommits(now);
    xtermCommits.push({ data, at: now });
    if (xtermCommits.length > 32) xtermCommits.shift();
    onCommit(data);
  };

  if (!textarea) {
    return {
      handleXtermData,
      isComposing: () => false,
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

  const findCompositionView = (): HTMLElement | null => {
    const parent = textarea.parentElement as { querySelector?: (sel: string) => Element | null } | null;
    if (!parent || typeof parent.querySelector !== "function") return null;
    return parent.querySelector(".composition-view") as HTMLElement | null;
  };

  const clearStuckCompositionView = () => {
    if (composing) return;
    const compView = findCompositionView();
    if (!compView) return;
    compView.classList?.remove("active");
    if (compView.textContent) compView.textContent = "";
  };

  const clampCompositionOverlay = () => {
    if (!composing) return;
    const compView = findCompositionView();
    const screenEl = textarea.parentElement as HTMLElement | null;
    if (!compView || !screenEl || typeof screenEl.getBoundingClientRect !== "function") return;
    const screenRect = screenEl.getBoundingClientRect();
    if (screenRect.width <= 0 || screenRect.height <= 0) return;
    const curLeft = parseFloat(compView.style.left || "0") || 0;
    const curTop = parseFloat(compView.style.top || "0") || 0;
    const cellH = parseFloat(compView.style.lineHeight || compView.style.height || "18") || 18;
    const laidOut = clampCompositionOverlayLayout({
      cursorLeft: curLeft,
      cursorTop: curTop,
      cellHeight: cellH,
      screenWidth: screenRect.width,
      screenHeight: screenRect.height,
      naturalWidth: compView.offsetWidth || Math.min(screenRect.width, (compView.textContent?.length ?? 1) * 14),
      naturalHeight: compView.offsetHeight || cellH,
    });
    compView.style.maxWidth = `${laidOut.maxWidth}px`;
    compView.style.left = `${laidOut.left}px`;
    compView.style.top = `${laidOut.top}px`;
    textarea.style.width = "24px";
    textarea.style.maxWidth = "48px";
    textarea.style.height = `${Math.max(16, Math.round(cellH))}px`;
  };

  const resetTextareaIfIdle = () => {
    if (!composing) {
      if (textarea.value) textarea.value = "";
      clearStuckCompositionView();
    }
  };

  const captureHost: EventTarget = textarea.parentElement ?? textarea;

  const onCaptureInput = (ev: Event) => {
    if (ev.target !== textarea) return;
    captureSeq = emittedSeq;
  };

  const onBeforeInput = (ev: Event) => {
    if (ev.target !== textarea) return;
    beforeInputSeq = emittedSeq;
  };

  const onCompositionStart = () => {
    composing = true;
    beforeInputSeq = null;
    captureSeq = null;
    lastCompEnd = null;
  };

  const onCompositionUpdate = () => {
    scheduleTimer(0, clampCompositionOverlay);
  };

  const onCompositionEnd = (ev: Event) => {
    composing = false;
    const seqAtEnd = emittedSeq;
    const compData = (ev as CompositionEvent).data ?? "";
    const endedAt = Date.now();
    if (compData) lastCompEnd = { data: compData, at: endedAt };
    const settleMs = compData.length > 64 ? 18 : COMP_SETTLE_MS;
    scheduleTimer(settleMs, () => {
      if (composing) return;
      if (compData && emittedSeq === seqAtEnd && !consumeMatchingXtermCommit(compData, endedAt)) {
        onCommit(compData);
      } else if (compData) {
        consumeMatchingXtermCommit(compData, endedAt);
      }
      resetTextareaIfIdle();
    });
  };

  const onPaste = () => {
    composing = false;
    scheduleTimer(0, clearStuckCompositionView);
  };

  const onBlur = () => {
    scheduleTimer(80, () => {
      if (typeof document === "undefined" || document.activeElement !== textarea) {
        composing = false;
        clearStuckCompositionView();
      }
    });
  };

  const onBubbleInput = (ev: Event) => {
    const inputEv = ev as InputEvent;
    if (composing || inputEv.isComposing || inputEv.inputType === "insertCompositionText") {
      beforeInputSeq = null;
      captureSeq = null;
      if (composing) scheduleTimer(0, clampCompositionOverlay);
      return;
    }

    const inputType = typeof inputEv.inputType === "string" ? inputEv.inputType : "";
    const baselineSeq = beforeInputSeq ?? captureSeq ?? emittedSeq;
    beforeInputSeq = null;
    captureSeq = null;

    const rawData = typeof inputEv.data === "string" ? inputEv.data : "";
    if (!rawData || (inputType && !COMMIT_INPUT_TYPES.has(inputType))) {
      scheduleTimer(INPUT_SETTLE_MS, resetTextareaIfIdle);
      return;
    }

    const now = Date.now();
    if (inputType === "insertFromComposition" && lastCompEnd && lastCompEnd.data === rawData && now - lastCompEnd.at < 25) {
      scheduleTimer(INPUT_SETTLE_MS, resetTextareaIfIdle);
      return;
    }

    if (emittedSeq > baselineSeq || consumeMatchingXtermCommit(rawData, now)) {
      scheduleTimer(INPUT_SETTLE_MS, resetTextareaIfIdle);
      return;
    }

    // Wait past xterm's 0ms _handleAnyTextareaChanges timer before rescuing dropped WKWebView XPC commits.
    scheduleTimer(INPUT_SETTLE_MS, () => {
      if (composing) return;
      if (!consumeMatchingXtermCommit(rawData, now)) {
        onCommit(rawData);
      }
      resetTextareaIfIdle();
    });
  };

  captureHost.addEventListener("input", onCaptureInput, true);
  textarea.addEventListener("beforeinput", onBeforeInput, true);
  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionupdate", onCompositionUpdate);
  textarea.addEventListener("compositionend", onCompositionEnd);
  textarea.addEventListener("paste", onPaste);
  textarea.addEventListener("blur", onBlur);
  textarea.addEventListener("input", onBubbleInput);

  return {
    handleXtermData,
    isComposing: () => composing,
    dispose: () => {
      for (const id of timers) clearTimeout(id);
      timers.clear();
      captureHost.removeEventListener("input", onCaptureInput, true);
      textarea.removeEventListener("beforeinput", onBeforeInput, true);
      textarea.removeEventListener("compositionstart", onCompositionStart);
      textarea.removeEventListener("compositionupdate", onCompositionUpdate);
      textarea.removeEventListener("compositionend", onCompositionEnd);
      textarea.removeEventListener("paste", onPaste);
      textarea.removeEventListener("blur", onBlur);
      textarea.removeEventListener("input", onBubbleInput);
    },
  };
}
