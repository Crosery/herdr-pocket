import { createElement, useEffect } from "react";
import { native, type OsModifierState } from "../lib/native";
import { createStore, settingsStore } from "../lib/store";
import { isImeKeyEvent } from "../lib/terminalIme";
import { trackModifierGhostBlocked, trackModifierHudHide, trackModifierHudShow } from "../lib/uiTelemetry";
import {
  chordFromModifierEvent,
  chordIncludesPrefix,
  chordOfKeys,
  IS_MAC,
  remainingSuffixChip,
  SHORTCUTS,
  shortcutText,
  type ShortcutId,
  type ShortcutModifierChord,
} from "./shortcuts";

export const HOLD_DELAY_MS = 450;
const OS_MODIFIER_POLL_MS = 200;

export const modifierChordStore = createStore<ShortcutModifierChord | null>(null);

export function useActiveModifierChord(): ShortcutModifierChord | null {
  return modifierChordStore.use((s) => s);
}

/** Resolves the active shortcut chord from OS HID modifier flags (returns null if OS unsupported or Mod not held). */
export function chordFromOsModifiers(
  state: OsModifierState,
  isMac = IS_MAC,
): ShortcutModifierChord | null {
  if (!state.supported) return null;
  return chordFromModifierEvent(
    {
      metaKey: state.meta,
      ctrlKey: state.ctrl,
      altKey: state.alt,
      shiftKey: state.shift,
    },
    isMac,
  );
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

function parseDisplayKeys(displayText: string, chord: ShortcutModifierChord): string[] {
  const cleaned = displayText
    .replace(/^⌘/, "")
    .replace(/^Ctrl\+/i, "")
    .replace(/^[⌥⇧]+/, "")
    .replace(/^(?:Alt\+|Shift\+)+/i, "");
  const parts = chord.split("+");
  return [...parts, cleaned || displayText];
}

export type SpatialHintCorner = "tr" | "br" | "center" | "right" | "stack" | "top" | "top-right" | "bottom";

/** Pure CSS-toggled floating keycap badge matching held modifier prefix `[data-shortcut-hints]`. */
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
  const resolvedKeys = def?.keys ?? parseDisplayKeys(displayText, resolvedChord);
  const chipProps: Record<string, string> = {};
  if (chordIncludesPrefix(resolvedChord, "Mod")) {
    chipProps["data-chip-mod"] = remainingSuffixChip(resolvedKeys, "Mod");
  }
  if (chordIncludesPrefix(resolvedChord, "Mod+Shift")) {
    chipProps["data-chip-mod-shift"] = remainingSuffixChip(resolvedKeys, "Mod+Shift");
  }
  if (chordIncludesPrefix(resolvedChord, "Mod+Alt")) {
    chipProps["data-chip-mod-alt"] = remainingSuffixChip(resolvedKeys, "Mod+Alt");
  }
  if (chordIncludesPrefix(resolvedChord, "Mod+Alt+Shift")) {
    chipProps["data-chip-mod-alt-shift"] = remainingSuffixChip(resolvedKeys, "Mod+Alt+Shift");
  }
  return createElement("kbd", {
    className: `v3-spatial-hint pos-${corner}${className ? ` ${className}` : ""}`,
    "data-chord": resolvedChord,
    "aria-hidden": "true",
    ...chipProps,
  });
}

/**
 * Progressive cmux-style modifier hold hints guarded by OS HID polling:
 * prevents WKWebView/NSMenu swallowed keyups or WeType XPC events from popping phantom ⌘ hints.
 */
export function useModifierHoldHints(): void {
  const enabled = settingsStore.use((s) => s.showModifierHoldHints);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    if (!enabled) {
      const prev = modifierChordStore.get();
      delete document.documentElement.dataset.shortcutHints;
      if (prev !== null) {
        modifierChordStore.set(null);
        trackModifierHudHide(prev, 0, "disabled");
      }
      return;
    }

    let disposed = false;
    let gen = 0;
    let timer: number | null = null;
    let pollTimer: number | null = null;
    let pollInFlight = false;
    let activeChord: ShortcutModifierChord | null = null;
    let pendingChord: ShortcutModifierChord | null = null;
    let shownAt = 0;

    const stopPolling = () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const startPolling = () => {
      if (pollTimer !== null || !native.available()) return;
      pollTimer = window.setInterval(() => {
        if (disposed || activeChord === null || pollInFlight) return;
        const myGen = gen;
        pollInFlight = true;
        void native
          .queryOsModifiers()
          .then((os) => {
            if (disposed || myGen !== gen || activeChord === null) return;
            if (document.hidden || !document.hasFocus()) {
              cancel("blur");
              return;
            }
            if (!os.supported) return;
            const osChord = chordFromOsModifiers(os, IS_MAC);
            if (!osChord) {
              cancel("os_poll_released");
              return;
            }
            if (osChord !== activeChord) {
              pendingChord = osChord;
              applyChord(osChord);
            }
          })
          .finally(() => {
            pollInFlight = false;
          });
      }, OS_MODIFIER_POLL_MS);
    };

    const applyChord = (next: ShortcutModifierChord | null, reason?: string) => {
      if (activeChord === next) return;
      const prev = activeChord;
      activeChord = next;
      if (next) {
        if (!prev) {
          shownAt = Date.now();
          trackModifierHudShow(next);
          startPolling();
        }
        document.documentElement.dataset.shortcutHints = next;
      } else {
        stopPolling();
        delete document.documentElement.dataset.shortcutHints;
        if (prev) {
          trackModifierHudHide(prev, shownAt ? Date.now() - shownAt : 0, reason || "cancelled");
          shownAt = 0;
        }
      }
      if (modifierChordStore.get() !== next) {
        modifierChordStore.set(next);
      }
    };

    const cancel = (reason = "cancelled") => {
      gen += 1;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      pendingChord = null;
      applyChord(null, reason);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const hasDialog = Boolean(document.querySelector("[role=dialog][data-state=open]"));
      if (hasDialog) {
        cancel("dialog");
        return;
      }
      if (e.isTrusted === false || isImeKeyEvent(e)) {
        cancel("ime");
        return;
      }
      if (!isModifierKeyName(e.key)) {
        cancel("chord_key");
        return;
      }
      const next = chordFromModifierEvent(e);
      if (!next) {
        cancel("keyup");
        return;
      }
      pendingChord = next;
      if (activeChord !== null) {
        applyChord(next);
        return;
      }
      if (e.repeat && timer !== null) return;
      if (timer === null) {
        const scheduledGen = gen;
        timer = window.setTimeout(() => {
          timer = null;
          if (disposed || scheduledGen !== gen || !pendingChord) return;
          if (document.hidden || !document.hasFocus() || document.querySelector("[role=dialog][data-state=open]")) {
            trackModifierGhostBlocked(
              pendingChord,
              { supported: false, meta: false, ctrl: false, alt: false, shift: false },
              "unfocused",
            );
            cancel("blur");
            return;
          }
          const expected = pendingChord;
          if (!native.available()) {
            applyChord(expected);
            return;
          }
          void native.queryOsModifiers().then((os) => {
            if (disposed || scheduledGen !== gen || !pendingChord) return;
            if (document.hidden || !document.hasFocus() || document.querySelector("[role=dialog][data-state=open]")) {
              trackModifierGhostBlocked(expected, os, "unfocused");
              cancel("blur");
              return;
            }
            if (os.supported) {
              const osChord = chordFromOsModifiers(os, IS_MAC);
              if (!osChord) {
                trackModifierGhostBlocked(expected, os, "os_hid");
                cancel("os_poll_released");
                return;
              }
              pendingChord = osChord;
              applyChord(osChord);
              return;
            }
            applyChord(expected);
          });
        }, HOLD_DELAY_MS);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const remaining = chordFromModifierEvent(e);
      if (!remaining || (IS_MAC ? e.key === "Meta" : e.key === "Control")) {
        cancel("keyup");
        return;
      }
      pendingChord = remaining;
      if (activeChord !== null) {
        applyChord(remaining);
      }
    };

    const onClipboardCancel = () => cancel("clipboard");
    const onImeCancel = () => cancel("ime");
    const onPointerDown = () => cancel("pointerdown");
    const onWheel = () => cancel("wheel");
    const onBlur = () => cancel("blur");
    const onPointerMove = (e: PointerEvent | MouseEvent) => {
      if (pendingChord === null && activeChord === null) return;
      const modHeld = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!modHeld) {
        if (activeChord === null && pendingChord !== null) {
          trackModifierGhostBlocked(
            pendingChord,
            {
              supported: false,
              meta: Boolean(e.metaKey),
              ctrl: Boolean(e.ctrlKey),
              alt: Boolean(e.altKey),
              shift: Boolean(e.shiftKey),
            },
            "dom_mismatch",
          );
        }
        cancel("pointer_mismatch");
      }
    };
    const onVisibility = () => {
      if (document.hidden) cancel("blur");
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("paste", onClipboardCancel, true);
    window.addEventListener("copy", onClipboardCancel, true);
    window.addEventListener("cut", onClipboardCancel, true);
    window.addEventListener("beforeinput", onImeCancel, true);
    window.addEventListener("input", onImeCancel, true);
    window.addEventListener("compositionstart", onImeCancel, true);
    window.addEventListener("compositionupdate", onImeCancel, true);
    window.addEventListener("contextmenu", onPointerDown, true);
    window.addEventListener("dragstart", onPointerDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("wheel", onWheel, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      cancel("unmount");
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("paste", onClipboardCancel, true);
      window.removeEventListener("copy", onClipboardCancel, true);
      window.removeEventListener("cut", onClipboardCancel, true);
      window.removeEventListener("beforeinput", onImeCancel, true);
      window.removeEventListener("input", onImeCancel, true);
      window.removeEventListener("compositionstart", onImeCancel, true);
      window.removeEventListener("compositionupdate", onImeCancel, true);
      window.removeEventListener("contextmenu", onPointerDown, true);
      window.removeEventListener("dragstart", onPointerDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);
}
