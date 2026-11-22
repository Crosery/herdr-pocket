/**
 * Pure soft-keyboard coordinate sanitization and avoiding-padding math.
 * Kept free of React Native runtime imports so it can be unit-tested directly in Node.
 */

export interface RawKeyboardCoordinates {
  screenX?: number;
  screenY?: number;
  width?: number;
  height?: number;
}

export interface RawKeyboardFrameLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SanitizedKeyboardFrame =
  | { kind: "invalid" }
  | { kind: "hidden" }
  | { kind: "shown"; screenY: number; height: number };

export interface KeyboardAvoidingCalcInput {
  frame: RawKeyboardFrameLayout | null;
  keyboard: SanitizedKeyboardFrame;
  keyboardVerticalOffset?: number;
  windowHeight: number;
  minRemainingHeight?: number;
}

/**
 * Validates and clamps native keyboard coordinates against the current window bounds.
 * Filters out zero/top-origin transient rects (such as `RCTKeyWindow() == nil` -> `CGRectZero`
 * during iOS foreground transitions), floating iPad keyboards, and off-screen dismiss frames.
 */
export function sanitizeKeyboardCoordinates(
  coords: RawKeyboardCoordinates | null | undefined,
  windowWidth: number,
  windowHeight: number,
  platform: string,
): SanitizedKeyboardFrame {
  if (
    !coords ||
    typeof coords.height !== "number" ||
    typeof coords.screenY !== "number" ||
    typeof coords.width !== "number" ||
    !Number.isFinite(coords.height) ||
    !Number.isFinite(coords.screenY) ||
    !Number.isFinite(coords.width) ||
    coords.height <= 0 ||
    coords.width <= 0
  ) {
    return { kind: "invalid" };
  }

  if (platform === "ios") {
    if (coords.screenY <= 0) {
      return { kind: "invalid" };
    }
    if (windowWidth > 0 && coords.width < windowWidth * 0.7) {
      return { kind: "hidden" };
    }
    if (windowHeight > 0) {
      const top = Math.max(0, coords.screenY);
      const bottom = Math.min(windowHeight, coords.screenY + coords.height);
      const visibleHeight = bottom - top;
      if (coords.screenY >= windowHeight - 2 || visibleHeight <= 2) {
        return { kind: "hidden" };
      }
      if (visibleHeight > windowHeight * 0.82) {
        return { kind: "invalid" };
      }
      return { kind: "shown", screenY: top, height: visibleHeight };
    }
    return { kind: "shown", screenY: coords.screenY, height: coords.height };
  }

  // Non-iOS platforms (e.g. Android)
  if (windowHeight > 0 && coords.screenY >= windowHeight - 2) {
    return { kind: "hidden" };
  }
  if (windowHeight > 0 && coords.screenY > 0) {
    const visibleHeight = Math.min(coords.height, Math.max(0, windowHeight - coords.screenY));
    if (visibleHeight <= 2) {
      return { kind: "hidden" };
    }
    return { kind: "shown", screenY: coords.screenY, height: visibleHeight };
  }
  if (coords.screenY === 0 && windowHeight > coords.height && coords.height <= windowHeight * 0.82) {
    return { kind: "shown", screenY: windowHeight - coords.height, height: coords.height };
  }
  return { kind: "invalid" };
}

/**
 * Computes safe bottom padding to lift a container above a docked keyboard without
 * exceeding the keyboard height or collapsing the container content.
 */
export function computeKeyboardAvoidingPadding(input: KeyboardAvoidingCalcInput): number {
  const { frame, keyboard } = input;
  if (!frame || frame.height <= 0 || keyboard.kind !== "shown") {
    return 0;
  }

  const offset =
    typeof input.keyboardVerticalOffset === "number" && Number.isFinite(input.keyboardVerticalOffset)
      ? input.keyboardVerticalOffset
      : 0;
  const keyboardY = keyboard.screenY - offset;
  const rawOverlap = frame.y + frame.height - keyboardY;
  const clampedToKeyboard = Math.min(Math.max(0, rawOverlap), keyboard.height);

  const minKeep =
    frame.height >= 260
      ? (input.minRemainingHeight ?? 140)
      : Math.floor(frame.height * 0.35);
  const maxByContainer = Math.max(0, frame.height - minKeep);

  return Math.round(Math.min(clampedToKeyboard, maxByContainer));
}
