import { createElement, useEffect } from "react";
import { createStore, settingsStore } from "../lib/store";
import {
  chordFromModifierEvent,
  chordOfKeys,
  IS_MAC,
  SHORTCUTS,
  shortcutText,
  type ShortcutId,
  type ShortcutModifierChord,
} from "./shortcuts";

const HOLD_DELAY_MS = 260;

export const modifierChordStore = createStore<ShortcutModifierChord | null>(null);

export function useActiveModifierChord(): ShortcutModifierChord | null {
  return modifierChordStore.use((s) => s);
}

function isModifierKeyName(key: string): boolean {
  return key === "Meta" || key === "Control" || key === "Alt" || key === "Shift";
}

function inferChordFromText(text: string): ShortcutModifierChord {
  if (/(?:⌥⇧|Alt\+Shift)/i.test(text)) return "Mod+Alt+Shift";
  if (/(?:⇧|Shift)/i.test(text)) return "Mod+Shift";
  if (/(?:⌥|Alt)/i.test(text)) return "Mod+Alt";
  return "Mod";
}

/**
 * Progressive cmux-style modifier hold hints:
 * holding ⌘ shows ⌘-level hints; adding ⇧ or ⌥ while still holding ⌘ swaps live
 * to the deeper chord layer (⌘⇧ / ⌘⌥ / ⌘⌥⇧) and updates the guide HUD.
 */
export function useModifierHoldHints(): void {
  const enabled = settingsStore.use((s) => s.showModifierHoldHints);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    if (!enabled) {
      delete document.documentElement.dataset.shortcutHints;
      if (modifierChordStore.get() !== null) modifierChordStore.set(null);
      return;
    }

    let timer: number | null = null;
    let activeChord: ShortcutModifierChord | null = null;
    let pendingChord: ShortcutModifierChord | null = null;

    const applyChord = (next: ShortcutModifierChord | null) => {
      if (activeChord === next) return;
      activeChord = next;
      if (next) document.documentElement.dataset.shortcutHints = next;
      else delete document.documentElement.dataset.shortcutHints;
      if (modifierChordStore.get() !== next) {
        modifierChordStore.set(next);
      }
    };

    const cancel = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      pendingChord = null;
      applyChord(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const hasDialog = Boolean(document.querySelector("[role=dialog][data-state=open]"));
      if (hasDialog) {
        cancel();
        return;
      }
      if (!isModifierKeyName(e.key)) {
        cancel();
        return;
      }
      const next = chordFromModifierEvent(e);
      if (!next) {
        cancel();
        return;
      }
      pendingChord = next;
      if (activeChord !== null) {
        // Already open: step smoothly between Mod <-> Mod+Shift <-> Mod+Alt <-> Mod+Alt+Shift.
        applyChord(next);
        return;
      }
      if (e.repeat && timer !== null) return;
      if (timer === null) {
        timer = window.setTimeout(() => {
          timer = null;
          if (!document.querySelector("[role=dialog][data-state=open]") && pendingChord) {
            applyChord(pendingChord);
          }
        }, HOLD_DELAY_MS);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const remaining = chordFromModifierEvent(e);
      if (!remaining || (IS_MAC ? e.key === "Meta" : e.key === "Control")) {
        cancel();
        return;
      }
      pendingChord = remaining;
      if (activeChord !== null) {
        applyChord(remaining);
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

/** Pure CSS-toggled floating keycap badge matching `[data-shortcut-hints="<chord>"]`. */
export function SpatialHint({
  text,
  shortcut,
  chord,
  corner = "tr",
  className = "",
}: {
  text?: string;
  shortcut?: ShortcutId;
  chord?: ShortcutModifierChord;
  corner?: SpatialHintCorner;
  className?: string;
}) {
  const displayText = text ?? (shortcut ? shortcutText(shortcut) : "");
  if (!displayText) return null;
  const def = shortcut ? SHORTCUTS.find((x) => x.id === shortcut) : undefined;
  const resolvedChord = chord ?? (def ? chordOfKeys(def.keys) ?? inferChordFromText(displayText) : inferChordFromText(displayText));
  return createElement(
    "kbd",
    {
      className: `v3-spatial-hint pos-${corner}${className ? ` ${className}` : ""}`,
      "data-chord": resolvedChord,
      "aria-hidden": "true",
    },
    displayText,
  );
}
