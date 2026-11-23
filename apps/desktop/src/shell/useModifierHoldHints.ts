import { createElement, useEffect } from "react";
import { settingsStore } from "../lib/store";
import { IS_MAC } from "./shortcuts";

const HOLD_DELAY_MS = 320;

function isPrimaryModifierOnly(e: KeyboardEvent): boolean {
  if (IS_MAC) {
    return e.key === "Meta" && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  }
  return e.key === "Control" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
}

/**
 * Shows cmux-style floating shortcut badges across window landmarks when holding
 * the primary modifier (⌘ on macOS, Ctrl elsewhere) alone for 320ms.
 */
export function useModifierHoldHints(): void {
  const enabled = settingsStore.use((s) => s.showModifierHoldHints);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    if (!enabled) {
      delete document.documentElement.dataset.shortcutHints;
      return;
    }

    let timer: number | null = null;
    let shown = false;

    const setShown = (next: boolean) => {
      if (shown === next) return;
      shown = next;
      if (next) document.documentElement.dataset.shortcutHints = "true";
      else delete document.documentElement.dataset.shortcutHints;
    };

    const cancel = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      setShown(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat && timer !== null) return;
      if (isPrimaryModifierOnly(e)) {
        const hasDialog = Boolean(document.querySelector("[role=dialog][data-state=open]"));
        if (hasDialog) {
          cancel();
          return;
        }
        if (timer === null && !shown) {
          timer = window.setTimeout(() => {
            timer = null;
            if (!document.querySelector("[role=dialog][data-state=open]")) {
              setShown(true);
            }
          }, HOLD_DELAY_MS);
        }
        return;
      }
      // Any second modifier or chord key dismisses hold hints immediately.
      cancel();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (IS_MAC ? !e.metaKey || e.key === "Meta" : !e.ctrlKey || e.key === "Control") {
        cancel();
      }
    };

    const onVisibility = () => {
      if (document.hidden) cancel();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("wheel", cancel, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancel();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("wheel", cancel, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);
}

export type SpatialHintCorner = "tr" | "br" | "center" | "right";

/** Pure CSS-toggled floating keycap badge (`[data-shortcut-hints="true"]` reveals it with zero layout shift). */
export function SpatialHint({
  text,
  corner = "tr",
  className = "",
}: {
  text: string;
  corner?: SpatialHintCorner;
  className?: string;
}) {
  if (!text) return null;
  return createElement(
    "kbd",
    {
      className: `v3-spatial-hint pos-${corner}${className ? ` ${className}` : ""}`,
      "aria-hidden": "true",
    },
    text,
  );
}
