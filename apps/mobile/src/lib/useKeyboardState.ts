import { useEffect, useState } from "react";
import { Keyboard, Platform, type KeyboardEvent } from "react-native";

export interface KeyboardState {
  keyboardOpen: boolean;
  keyboardHeight: number;
}

/**
 * Tracks soft-keyboard visibility and height using `keyboardWillShow`/`keyboardWillHide`
 * on iOS (matching `KeyboardAvoidingView` animations) and `keyboardDidShow`/`keyboardDidHide` on Android.
 */
export function useKeyboardState(): KeyboardState {
  const [state, setState] = useState<KeyboardState>(() => {
    const open = typeof Keyboard.isVisible === "function" ? Keyboard.isVisible() : false;
    const height = open && typeof Keyboard.metrics === "function" ? (Keyboard.metrics()?.height ?? 0) : 0;
    return { keyboardOpen: open, keyboardHeight: height };
  });

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const onShow = (e: KeyboardEvent) => {
      const h = typeof e.endCoordinates?.height === "number" ? e.endCoordinates.height : 0;
      setState((prev) => (prev.keyboardOpen && prev.keyboardHeight === h ? prev : { keyboardOpen: true, keyboardHeight: h }));
    };
    const onHide = () => {
      setState((prev) => (!prev.keyboardOpen && prev.keyboardHeight === 0 ? prev : { keyboardOpen: false, keyboardHeight: 0 }));
    };

    const showSub = Keyboard.addListener(showEvent, onShow);
    const hideSub = Keyboard.addListener(hideEvent, onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return state;
}
