import { useSyncExternalStore } from "react";
import {
  AppState,
  Dimensions,
  Keyboard,
  LayoutAnimation,
  Platform,
  TextInput,
  type EmitterSubscription,
  type KeyboardEvent,
  type LayoutAnimationType,
  type NativeEventSubscription,
  type ScaledSize,
} from "react-native";
import { sanitizeKeyboardCoordinates } from "./keyboardMetrics";

export interface KeyboardState {
  keyboardOpen: boolean;
  keyboardHeight: number;
  keyboardScreenY: number;
}

type KeyboardStateListener = (state: KeyboardState) => void;

const CLOSED_STATE: KeyboardState = {
  keyboardOpen: false,
  keyboardHeight: 0,
  keyboardScreenY: 0,
};

const subscribers = new Set<KeyboardStateListener>();
let currentState: KeyboardState = CLOSED_STATE;
let lastValidDockedHeight = 0;
let lastShownAt = 0;
let activeCleanup: (() => void) | null = null;
let reconcileTimers: ReturnType<typeof setTimeout>[] = [];

function clearReconcileTimers() {
  for (const t of reconcileTimers) clearTimeout(t);
  reconcileTimers = [];
}

function isAnyInputFocused(): boolean {
  try {
    return Boolean(TextInput.State?.currentlyFocusedInput?.());
  } catch {
    return false;
  }
}

function readWindowBounds(): { width: number; height: number } {
  const win = Dimensions.get("window");
  return { width: win.width, height: win.height };
}

function readCurrentKeyboardState(): KeyboardState {
  const visible = typeof Keyboard.isVisible === "function" ? Keyboard.isVisible() : false;
  if (!visible) return CLOSED_STATE;
  const metrics = typeof Keyboard.metrics === "function" ? Keyboard.metrics() : undefined;
  const { width, height } = readWindowBounds();
  const parsed = sanitizeKeyboardCoordinates(metrics, width, height, Platform.OS);
  if (parsed.kind === "shown") {
    if (parsed.height >= 120) lastValidDockedHeight = parsed.height;
    return {
      keyboardOpen: true,
      keyboardHeight: parsed.height,
      keyboardScreenY: parsed.screenY,
    };
  }
  return CLOSED_STATE;
}

function statesEqual(a: KeyboardState, b: KeyboardState): boolean {
  return (
    a.keyboardOpen === b.keyboardOpen &&
    Math.abs(a.keyboardHeight - b.keyboardHeight) < 0.5 &&
    Math.abs(a.keyboardScreenY - b.keyboardScreenY) < 0.5
  );
}

function resolveAnimationType(easing?: string): LayoutAnimationType {
  const types = LayoutAnimation.Types as Record<string, LayoutAnimationType | undefined>;
  if (easing && types[easing]) return types[easing]!;
  return LayoutAnimation.Types.keyboard;
}

function commitState(next: KeyboardState, anim?: { duration?: number; easing?: string }) {
  if (statesEqual(currentState, next)) return;

  if (
    Platform.OS === "ios" &&
    AppState.currentState === "active" &&
    typeof anim?.duration === "number" &&
    anim.duration > 10
  ) {
    const duration = Math.max(10, Math.round(anim.duration));
    LayoutAnimation.configureNext({
      duration,
      update: {
        duration,
        type: resolveAnimationType(anim.easing),
      },
    });
  }

  currentState = next;
  for (const listener of [...subscribers]) {
    listener(currentState);
  }
}

function handleShowOrChange(e: KeyboardEvent, eventName: string) {
  const { width: winW, height: winH } = readWindowBounds();
  const parsed = sanitizeKeyboardCoordinates(e?.endCoordinates, winW, winH, Platform.OS);

  if (parsed.kind === "shown") {
    if (parsed.height >= 120) lastValidDockedHeight = parsed.height;
    lastShownAt = Date.now();
    commitState(
      { keyboardOpen: true, keyboardHeight: parsed.height, keyboardScreenY: parsed.screenY },
      { duration: e?.duration, easing: e?.easing },
    );
    return;
  }

  if (parsed.kind === "hidden") {
    commitState(CLOSED_STATE, { duration: e?.duration, easing: e?.easing });
    return;
  }

  // `parsed.kind === "invalid"`: e.g. `CGRectZero` when `RCTKeyWindow()` is nil during iOS foreground switch.
  if (currentState.keyboardOpen && currentState.keyboardHeight > 0) {
    return;
  }
  if (
    (eventName === "keyboardWillShow" || eventName === "keyboardDidShow") &&
    lastValidDockedHeight > 0 &&
    winH > lastValidDockedHeight &&
    isAnyInputFocused()
  ) {
    lastShownAt = Date.now();
    commitState({
      keyboardOpen: true,
      keyboardHeight: lastValidDockedHeight,
      keyboardScreenY: winH - lastValidDockedHeight,
    });
  }
}

function handleHide(e: KeyboardEvent) {
  commitState(CLOSED_STATE, { duration: e?.duration, easing: e?.easing });
}

function reconcileAfterForeground(activatedAt: number, settled: boolean) {
  const visible = typeof Keyboard.isVisible === "function" ? Keyboard.isVisible() : false;
  const focused = isAnyInputFocused();
  const metrics = typeof Keyboard.metrics === "function" ? Keyboard.metrics() : undefined;
  const { width: winW, height: winH } = readWindowBounds();

  if (!visible && (!focused || (settled && lastShownAt < activatedAt))) {
    commitState(CLOSED_STATE);
    return;
  }

  if (visible && metrics) {
    const parsed = sanitizeKeyboardCoordinates(metrics, winW, winH, Platform.OS);
    if (parsed.kind === "shown") {
      if (parsed.height >= 120) lastValidDockedHeight = parsed.height;
      commitState({
        keyboardOpen: true,
        keyboardHeight: parsed.height,
        keyboardScreenY: parsed.screenY,
      });
    } else if (parsed.kind === "hidden") {
      commitState(CLOSED_STATE);
    } else if (
      focused &&
      !currentState.keyboardOpen &&
      lastValidDockedHeight > 0 &&
      winH > lastValidDockedHeight
    ) {
      commitState({
        keyboardOpen: true,
        keyboardHeight: lastValidDockedHeight,
        keyboardScreenY: winH - lastValidDockedHeight,
      });
    }
  }
}

function getKeyboardSnapshot(): KeyboardState {
  if (!activeCleanup) {
    const next = readCurrentKeyboardState();
    if (!statesEqual(currentState, next)) {
      currentState = next;
    }
  }
  return currentState;
}

function ensureStarted() {
  if (activeCleanup) return;
  const initial = readCurrentKeyboardState();
  if (!statesEqual(currentState, initial)) {
    currentState = initial;
  }

  const kbSubs: EmitterSubscription[] =
    Platform.OS === "ios"
      ? [
          Keyboard.addListener("keyboardWillShow", (e) => handleShowOrChange(e, "keyboardWillShow")),
          Keyboard.addListener("keyboardWillChangeFrame", (e) => handleShowOrChange(e, "keyboardWillChangeFrame")),
          Keyboard.addListener("keyboardDidShow", (e) => handleShowOrChange(e, "keyboardDidShow")),
          Keyboard.addListener("keyboardDidChangeFrame", (e) => handleShowOrChange(e, "keyboardDidChangeFrame")),
          Keyboard.addListener("keyboardWillHide", handleHide),
          Keyboard.addListener("keyboardDidHide", handleHide),
        ]
      : [
          Keyboard.addListener("keyboardDidShow", (e) => handleShowOrChange(e, "keyboardDidShow")),
          Keyboard.addListener("keyboardDidHide", handleHide),
        ];

  let prevAppState: string = AppState.currentState ?? "active";
  const appSub: NativeEventSubscription = AppState.addEventListener("change", (nextAppState) => {
    const wasInactive = prevAppState !== "active";
    prevAppState = nextAppState;
    if (nextAppState !== "active") {
      clearReconcileTimers();
      return;
    }
    if (!wasInactive) return;

    clearReconcileTimers();
    const activatedAt = Date.now();
    reconcileAfterForeground(activatedAt, false);
    reconcileTimers = [
      setTimeout(() => reconcileAfterForeground(activatedAt, false), 80),
      setTimeout(() => reconcileAfterForeground(activatedAt, true), 220),
    ];
  });

  const dimSub: NativeEventSubscription = Dimensions.addEventListener("change", ({ window }: { window: ScaledSize }) => {
    if (!currentState.keyboardOpen) return;
    const metrics = typeof Keyboard.metrics === "function" ? Keyboard.metrics() : undefined;
    if (metrics) {
      const parsed = sanitizeKeyboardCoordinates(metrics, window.width, window.height, Platform.OS);
      if (parsed.kind === "shown") {
        commitState({
          keyboardOpen: true,
          keyboardHeight: parsed.height,
          keyboardScreenY: parsed.screenY,
        });
        return;
      }
      if (parsed.kind === "hidden") {
        commitState(CLOSED_STATE);
        return;
      }
    }
    if (window.height > 0 && currentState.keyboardHeight > window.height * 0.82) {
      commitState(CLOSED_STATE);
    }
  });

  activeCleanup = () => {
    clearReconcileTimers();
    for (const sub of kbSubs) sub.remove();
    appSub.remove();
    dimSub.remove();
    activeCleanup = null;
  };
}

function subscribeKeyboardStore(listener: KeyboardStateListener): () => void {
  subscribers.add(listener);
  ensureStarted();
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0 && activeCleanup) {
      activeCleanup();
    }
  };
}

/**
 * Tracks soft-keyboard visibility, height, and screen-Y across foreground/background
 * transitions, filtering out transient zero/off-screen coordinates on iOS UIScene apps.
 */
export function useKeyboardState(): KeyboardState {
  return useSyncExternalStore(subscribeKeyboardStore, getKeyboardSnapshot, getKeyboardSnapshot);
}
