import { useLayoutEffect, useRef, type CompositionEvent, type KeyboardEvent } from "react";

/**
 * Window (ms) right after `compositionend` during which a `keydown("Enter")`
 * is still treated as the IME confirming raw characters (e.g. English words
 * inside macOS Pinyin) rather than the user sending the message.
 */
export const IME_GUARD_MS = 80;

const MIN_TEXTAREA_PX = 34;
const MAX_TEXTAREA_PX = 200;

export interface ComposerImeGate {
  composing: boolean;
  compositionEndedAt: number;
}

export function createImeGate(): ComposerImeGate {
  return { composing: false, compositionEndedAt: 0 };
}

export interface ComposerEnterFacts {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
}

export type ComposerEnterAction = "submit" | "steer" | "pass" | "swallow";

/**
 * Pure decision for Enter inside a desktop composer textarea:
 * - While IME composition is active (`isComposing`, `gate.composing`, or `keyCode === 229`),
 *   let the IME handle Enter (`"pass"`).
 * - Immediately after `compositionend` (< 80 ms, macOS WKWebView ordering quirk),
 *   swallow Enter without submitting (`"swallow"`).
 * - `Shift+Enter` inserts a newline (`"pass"`).
 * - Repeat `Enter` or `Ctrl+Meta+Enter` swallow without submitting.
 * - `Alt+Enter` returns `"steer"` when `allowSteer` is true, else `"swallow"`.
 * - Plain `Enter` or `Cmd/Ctrl+Enter` outside IME submits (`"submit"`).
 */
export function composerEnterAction(
  event: ComposerEnterFacts,
  gate: ComposerImeGate,
  now = Date.now(),
  allowSteer = false,
): ComposerEnterAction {
  if (event.key !== "Enter") return "pass";
  if (event.shiftKey) return "pass";
  if (event.isComposing || gate.composing || event.keyCode === 229) return "pass";
  if (gate.compositionEndedAt > 0 && now - gate.compositionEndedAt < IME_GUARD_MS) return "swallow";
  if (event.repeat) return "swallow";
  if (event.altKey && !event.ctrlKey && !event.metaKey) return allowSteer ? "steer" : "swallow";
  if (event.altKey || (event.ctrlKey && event.metaKey)) return "swallow";
  return "submit";
}

function resizeTextarea(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "0px";
  const sh = el.scrollHeight;
  const h = Math.min(Math.max(sh, MIN_TEXTAREA_PX), MAX_TEXTAREA_PX);
  el.style.height = `${h}px`;
  el.style.overflowY = sh > MAX_TEXTAREA_PX ? "auto" : "hidden";
}

/**
 * Binds IME-safe Enter-to-send (and optional Alt+Enter steer submit) and auto-grow sizing to a composer `<textarea>`.
 */
export function useComposerInput(value: string, onSubmit: () => void, onSteerSubmit?: () => void) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gateRef = useRef<ComposerImeGate>(createImeGate());

  useLayoutEffect(() => {
    resizeTextarea(textareaRef.current);
  }, [value]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => resizeTextarea(el));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onCompositionStart = (_e: CompositionEvent<HTMLTextAreaElement>) => {
    gateRef.current.composing = true;
  };

  const onCompositionEnd = (_e: CompositionEvent<HTMLTextAreaElement>) => {
    gateRef.current.composing = false;
    gateRef.current.compositionEndedAt = Date.now();
  };

  const onBlur = () => {
    gateRef.current.composing = false;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const native = e.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number };
    const action = composerEnterAction(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        isComposing: native?.isComposing,
        keyCode: native?.keyCode,
        repeat: e.repeat,
      },
      gateRef.current,
      Date.now(),
      Boolean(onSteerSubmit),
    );
    if (action === "pass") return;
    e.preventDefault();
    if (action === "steer") onSteerSubmit?.();
    else if (action === "submit") onSubmit();
  };

  return {
    textareaRef,
    textareaProps: {
      ref: textareaRef,
      rows: 1,
      onCompositionStart,
      onCompositionEnd,
      onBlur,
      onKeyDown,
    },
  };
}
