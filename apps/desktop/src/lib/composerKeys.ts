import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";

/**
 * Window (ms) right after `compositionend` during which a `keydown("Enter")`
 * is still treated as the IME confirming raw characters (e.g. English words
 * inside macOS Pinyin) rather than the user sending the message.
 */
export const IME_GUARD_MS = 80;

export const MIN_TEXTAREA_PX = 36;
export const MAX_TEXTAREA_PX = 200;
const MIN_MEASURABLE_WIDTH_PX = 32;

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

export function resizeComposerTextarea(el: HTMLTextAreaElement | null, composing = false): void {
  if (!el) return;
  if (el.scrollLeft !== 0) el.scrollLeft = 0;

  // Invariant: an empty textarea MUST always sit at single-line height, even if
  // voice/IME composition was cancelled, cleared, blurred, or a cached tab was hidden.
  if (el.value.length === 0) {
    const emptyHeight = `${MIN_TEXTAREA_PX}px`;
    if (el.style.height !== emptyHeight) el.style.height = emptyHeight;
    if (el.style.overflowY !== "hidden") el.style.overflowY = "hidden";
    if (el.scrollTop !== 0) el.scrollTop = 0;
    return;
  }

  // Skip scrollHeight measurement while hidden or collapsed to a tiny width so
  // off-screen/mid-transition reflows can never inflate the composer to MAX_TEXTAREA_PX.
  if (el.clientWidth < MIN_MEASURABLE_WIDTH_PX) return;

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
  else if (el.scrollTop !== 0) el.scrollTop = 0;
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const lastWidthRef = useRef<number>(-1);
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
  const unmanagedRef = useRef(unmanagedDuringIme);
  unmanagedRef.current = unmanagedDuringIme;

  const setTextareaNode = useCallback((node: HTMLTextAreaElement | null) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    textareaRef.current = node;
    lastWidthRef.current = node ? node.clientWidth : -1;
    if (!node) return;
    if (unmanagedRef.current && !gateRef.current.composing && node.value !== valueRef.current) {
      node.value = valueRef.current;
    }
    resizeComposerTextarea(node, gateRef.current.composing);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        const w = node.clientWidth;
        const widthChanged = w !== lastWidthRef.current;
        if (widthChanged) lastWidthRef.current = w;
        const emptyBloated = node.value.length === 0 && node.clientHeight > MIN_TEXTAREA_PX + 2;
        if (widthChanged || emptyBloated) {
          resizeComposerTextarea(node, gateRef.current.composing);
        }
      });
      ro.observe(node);
      roRef.current = ro;
    }
  }, []);

  useEffect(
    () => () => {
      if (roRef.current) {
        roRef.current.disconnect();
        roRef.current = null;
      }
    },
    [],
  );

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (unmanagedDuringIme && !gateRef.current.composing && el && el.value !== value) {
      el.value = value;
    }
    resizeComposerTextarea(el, gateRef.current.composing);
  }, [unmanagedDuringIme, value]);

  const syncSize = useCallback(() => {
    resizeComposerTextarea(textareaRef.current, gateRef.current.composing);
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
      resizeComposerTextarea(el, true);
    }
  };

  const onCompositionEnd = (e: CompositionEvent<HTMLTextAreaElement>) => {
    gateRef.current.composing = false;
    gateRef.current.compositionEndedAt = Date.now();
    setIsComposing(false);
    setHasComposingText(false);
    onCompChangeRef.current?.(false);
    const el = e.currentTarget ?? textareaRef.current;
    if (el) {
      onValueChangeRef.current?.(el.value);
      resizeComposerTextarea(el, false);
    }
    requestAnimationFrame(() => resizeComposerTextarea(textareaRef.current, false));
  };

  const onBlur = () => {
    const wasComposing = gateRef.current.composing;
    gateRef.current.composing = false;
    setIsComposing(false);
    setHasComposingText(false);
    onCompChangeRef.current?.(false);
    const el = textareaRef.current;
    if (el) {
      if (wasComposing) {
        onValueChangeRef.current?.(el.value);
      }
      resizeComposerTextarea(el, false);
    }
  };

  const onFocus = (e: FocusEvent<HTMLTextAreaElement>) => {
    resizeComposerTextarea(e.currentTarget, gateRef.current.composing);
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const evComposing =
      gateRef.current.composing ||
      Boolean((e.nativeEvent as unknown as { isComposing?: boolean } | undefined)?.isComposing);
    if (evComposing) {
      syncHasText(el.value);
      resizeComposerTextarea(el, true);
      return;
    }
    setHasComposingText(false);
    onValueChangeRef.current?.(el.value);
    resizeComposerTextarea(el, false);
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
      resizeComposerTextarea(el, false);
    }
  };

  return {
    textareaRef,
    isComposing,
    hasText: Boolean(value.trim()) || (isComposing && hasComposingText),
    readValue,
    clearValue,
    syncSize,
    textareaProps: {
      ref: setTextareaNode,
      rows: 1,
      ...(unmanagedDuringIme ? { defaultValue: value, onChange } : {}),
      onCompositionStart,
      onCompositionUpdate,
      onCompositionEnd,
      onBlur,
      onFocus,
      onKeyDown,
    },
  };
}
