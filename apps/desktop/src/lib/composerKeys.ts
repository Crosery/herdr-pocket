import { useLayoutEffect, useRef, useState, type ChangeEvent, type CompositionEvent, type KeyboardEvent } from "react";

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
 * - `Cmd/Ctrl+Enter` returns `"steer"` when `allowSteer` is true, else `"submit"`.
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
  if (event.ctrlKey && event.metaKey) return "swallow";
  if (event.altKey && (event.ctrlKey || event.metaKey)) return "swallow";
  if (event.altKey) return allowSteer ? "steer" : "swallow";
  if (allowSteer && (event.metaKey || event.ctrlKey)) return "steer";
  return "submit";
}

function resizeTextarea(el: HTMLTextAreaElement | null, composing = false): void {
  if (!el) return;
  if (el.scrollLeft !== 0) el.scrollLeft = 0;
  if (composing) {
    // Never collapse height to 0px during active voice/IME composition, which shifts cursor baseline.
    const curH = el.clientHeight || MIN_TEXTAREA_PX;
    const nextH = Math.min(Math.max(curH, el.scrollHeight, MIN_TEXTAREA_PX), MAX_TEXTAREA_PX);
    if (nextH > curH) el.style.height = `${nextH}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_PX ? "auto" : "hidden";
    return;
  }
  const prevTop = el.scrollTop;
  el.style.height = "0px";
  const sh = el.scrollHeight;
  const h = Math.min(Math.max(sh, MIN_TEXTAREA_PX), MAX_TEXTAREA_PX);
  el.style.height = `${h}px`;
  el.style.overflowY = sh > MAX_TEXTAREA_PX ? "auto" : "hidden";
  if (sh > MAX_TEXTAREA_PX) el.scrollTop = prevTop;
}

/**
 * Binds IME-safe Enter-to-send (and optional Alt+Enter steer submit) and auto-grow sizing to a composer `<textarea>`.
 * When `onValueChange` is supplied, keeps the DOM `<textarea>` uncontrolled during active voice/IME composition
 * so React re-renders never reset WebKit `NSTextInputClient` `markedTextRange` or displace pre-existing text.
 */
export function useComposerInput(
  value: string,
  onSubmit: () => void,
  onSteerSubmit?: () => void,
  onCompositionChange?: (composing: boolean) => void,
  onValueChange?: (next: string) => void,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gateRef = useRef<ComposerImeGate>(createImeGate());
  const valueRef = useRef(value);
  const onSubmitRef = useRef(onSubmit);
  const onSteerRef = useRef(onSteerSubmit);
  const onCompChangeRef = useRef(onCompositionChange);
  const onValueChangeRef = useRef(onValueChange);
  valueRef.current = value;
  onSubmitRef.current = onSubmit;
  onSteerRef.current = onSteerSubmit;
  onCompChangeRef.current = onCompositionChange;
  onValueChangeRef.current = onValueChange;

  const [isComposing, setIsComposing] = useState(false);
  const [hasComposingText, setHasComposingText] = useState(false);
  const unmanagedDuringIme = Boolean(onValueChange);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (unmanagedDuringIme && !gateRef.current.composing && el && el.value !== value) {
      el.value = value;
    }
    resizeTextarea(el, gateRef.current.composing);
  }, [unmanagedDuringIme, value]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => resizeTextarea(el, gateRef.current.composing));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const syncHasText = (raw: string) => {
    const next = raw.trim().length > 0;
    setHasComposingText((prev) => (prev === next ? prev : next));
  };

  const onCompositionStart = (e: CompositionEvent<HTMLTextAreaElement>) => {
    gateRef.current.composing = true;
    setIsComposing(true);
    syncHasText(e.currentTarget?.value ?? "");
    onCompChangeRef.current?.(true);
  };

  const onCompositionUpdate = (e: CompositionEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (el) {
      syncHasText(el.value);
      resizeTextarea(el, true);
    }
  };

  const onCompositionEnd = (e: CompositionEvent<HTMLTextAreaElement>) => {
    gateRef.current.composing = false;
    gateRef.current.compositionEndedAt = Date.now();
    setIsComposing(false);
    setHasComposingText(false);
    onCompChangeRef.current?.(false);
    const committed = e.currentTarget?.value;
    if (typeof committed === "string") {
      onValueChangeRef.current?.(committed);
    }
    requestAnimationFrame(() => resizeTextarea(textareaRef.current, false));
  };

  const onBlur = () => {
    const wasComposing = gateRef.current.composing;
    gateRef.current.composing = false;
    setIsComposing(false);
    setHasComposingText(false);
    onCompChangeRef.current?.(false);
    if (wasComposing && textareaRef.current) {
      onValueChangeRef.current?.(textareaRef.current.value);
    }
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const evComposing =
      gateRef.current.composing ||
      Boolean((e.nativeEvent as unknown as { isComposing?: boolean } | undefined)?.isComposing);
    if (evComposing) {
      syncHasText(el.value);
      resizeTextarea(el, true);
      return;
    }
    setHasComposingText(false);
    onValueChangeRef.current?.(el.value);
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
      Boolean(onSteerRef.current),
    );
    if (action === "pass") return;
    e.preventDefault();
    if (action === "steer") onSteerRef.current?.();
    else if (action === "submit") onSubmitRef.current();
  };

  const readValue = (): string => textareaRef.current?.value ?? valueRef.current;

  const clearValue = (): void => {
    gateRef.current.composing = false;
    setIsComposing(false);
    setHasComposingText(false);
    onCompChangeRef.current?.(false);
    const el = textareaRef.current;
    if (el) {
      el.value = "";
      resizeTextarea(el, false);
    }
  };

  return {
    textareaRef,
    isComposing,
    hasText: Boolean(value.trim()) || (isComposing && hasComposingText),
    readValue,
    clearValue,
    textareaProps: {
      ref: textareaRef,
      rows: 1,
      ...(unmanagedDuringIme ? { defaultValue: value, onChange } : {}),
      onCompositionStart,
      onCompositionUpdate,
      onCompositionEnd,
      onBlur,
      onKeyDown,
    },
  };
}
