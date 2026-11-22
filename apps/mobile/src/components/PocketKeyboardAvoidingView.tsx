import { useCallback, useState } from "react";
import { useIsFocused } from "expo-router";
import { useWindowDimensions, View, type LayoutChangeEvent, type ViewProps } from "react-native";
import { computeKeyboardAvoidingPadding, type RawKeyboardFrameLayout } from "../lib/keyboardMetrics";
import { useKeyboardState } from "../lib/useKeyboardState";

export interface PocketKeyboardAvoidingViewProps extends ViewProps {
  keyboardVerticalOffset?: number;
  enabled?: boolean;
  /** Set true when rendered inside a React Native `<Modal>` so screen focus gating is skipped. */
  insideModal?: boolean;
}

function framesClose(a: RawKeyboardFrameLayout | null, b: RawKeyboardFrameLayout): boolean {
  if (!a) return false;
  return (
    Math.abs(a.x - b.x) <= 0.5 &&
    Math.abs(a.y - b.y) <= 0.5 &&
    Math.abs(a.width - b.width) <= 0.5 &&
    Math.abs(a.height - b.height) <= 0.5
  );
}

function PocketKeyboardAvoidingInner({
  keyboardVerticalOffset = 0,
  enabled = true,
  active,
  style,
  children,
  onLayout,
  ...rest
}: Omit<PocketKeyboardAvoidingViewProps, "insideModal"> & { active: boolean }) {
  const [frame, setFrame] = useState<RawKeyboardFrameLayout | null>(null);
  const kb = useKeyboardState();
  const { height: windowHeight } = useWindowDimensions();

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const next = e.nativeEvent.layout;
      setFrame((prev) => (framesClose(prev, next) ? prev : next));
      onLayout?.(e);
    },
    [onLayout],
  );

  const bottomPadding =
    enabled && active
      ? computeKeyboardAvoidingPadding({
          frame,
          keyboard:
            kb.keyboardOpen && kb.keyboardHeight > 0
              ? { kind: "shown", screenY: kb.keyboardScreenY, height: kb.keyboardHeight }
              : { kind: "hidden" },
          keyboardVerticalOffset,
          windowHeight,
        })
      : 0;

  return (
    <View
      {...rest}
      onLayout={handleLayout}
      style={[style, bottomPadding > 0 ? { paddingBottom: bottomPadding } : null]}
    >
      {children}
    </View>
  );
}

function FocusedPocketKeyboardAvoiding(props: Omit<PocketKeyboardAvoidingViewProps, "insideModal">) {
  const focused = useIsFocused();
  return <PocketKeyboardAvoidingInner {...props} active={focused} />;
}

/**
 * Drop-in replacement for React Native's `KeyboardAvoidingView` that validates native
 * keyboard frames against transient zero coordinates on iOS scene foreground transitions
 * and clamps bottom padding to prevent header/composer collisions.
 */
export function PocketKeyboardAvoidingView({ insideModal, ...rest }: PocketKeyboardAvoidingViewProps) {
  if (insideModal) {
    return <PocketKeyboardAvoidingInner {...rest} active />;
  }
  return <FocusedPocketKeyboardAvoiding {...rest} />;
}
