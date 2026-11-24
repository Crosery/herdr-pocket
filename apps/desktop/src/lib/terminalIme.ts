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
const COMMIT_MATCH_WINDOW_MS = 40;
const COMMIT_INPUT_TYPES = new Set([
  "insertText",
  "insertFromComposition",
  "insertReplacementText",
  "insertFromPaste",
]);

interface PendingXtermCommit {
  data: string;
  at: number;
}

/**
 * Bridges macOS WKWebView & desktop browser IME commits (`。`, `，`, `？`, `“”`, phrases)
 * onto xterm.js without duplicate sends or swallowed XPC punctuation commits.
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
    const idx = xtermCommits.findIndex((c) => c.data === data && c.at >= sinceAt - 2);
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

  const resetTextareaIfIdle = () => {
    if (!composing && textarea.value) {
      textarea.value = "";
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

  const onCompositionEnd = (ev: Event) => {
    composing = false;
    const seqAtEnd = emittedSeq;
    const compData = (ev as CompositionEvent).data ?? "";
    const endedAt = Date.now();
    if (compData) lastCompEnd = { data: compData, at: endedAt };
    scheduleTimer(COMP_SETTLE_MS, () => {
      if (composing) return;
      if (compData && emittedSeq === seqAtEnd && !consumeMatchingXtermCommit(compData, endedAt)) {
        onCommit(compData);
      } else if (compData) {
        consumeMatchingXtermCommit(compData, endedAt);
      }
      resetTextareaIfIdle();
    });
  };

  const onBubbleInput = (ev: Event) => {
    const inputEv = ev as InputEvent;
    if (composing || inputEv.isComposing || inputEv.inputType === "insertCompositionText") {
      beforeInputSeq = null;
      captureSeq = null;
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
  textarea.addEventListener("compositionend", onCompositionEnd);
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
      textarea.removeEventListener("compositionend", onCompositionEnd);
      textarea.removeEventListener("input", onBubbleInput);
    },
  };
}
