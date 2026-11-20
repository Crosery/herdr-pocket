/**
 * What a key press in the terminal box should do. Pure, so the mapping can be checked
 * without a real agent.
 *
 * macOS keeps ⌘C / ⌘V / ⌘K for the app and sends Ctrl+letter to the terminal.
 * Windows and Linux follow Windows Terminal: Ctrl+V pastes, Ctrl+C copies when text is
 * selected and otherwise sends ^C, Ctrl+Shift+C / Ctrl+Shift+V always copy / paste.
 * Every key resolves to exactly one action.
 */
export type TermKeyAction =
  /** Send these bytes to the terminal. */
  | { kind: "send"; data: string }
  /** Copy the current selection ourselves (the browser has no default for it). */
  | { kind: "copy" }
  /** Let the browser's own copy run (Ctrl+C with a selection). */
  | { kind: "native-copy" }
  /** Paste the clipboard into the terminal. */
  | { kind: "paste" }
  /** Not for the terminal: leave the event alone (⌘ shortcuts on macOS). */
  | { kind: "pass" }
  /** Swallow and do nothing. */
  | { kind: "none" };

export interface TermKeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const NAMED: Record<string, string> = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  Delete: "\x1b[3~",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
};

function controlChar(key: string): string | null {
  const code = key.toUpperCase().charCodeAt(0) - 64;
  return key.length === 1 && code >= 1 && code <= 26 ? String.fromCharCode(code) : null;
}

export function termKeyAction(e: TermKeyInput, mac: boolean, hasSelection: boolean): TermKeyAction {
  const lower = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (mac) {
    if (e.metaKey) return { kind: "pass" };
  } else if (e.ctrlKey && !e.altKey && !e.metaKey) {
    if (e.shiftKey && lower === "c") return hasSelection ? { kind: "copy" } : { kind: "none" };
    if (lower === "v") return { kind: "paste" };
    if (lower === "c" && hasSelection) return { kind: "native-copy" };
  } else if (e.metaKey) {
    // The Windows / Super key belongs to the system.
    return { kind: "pass" };
  }

  if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey) return { kind: "send", data: "\x1b[Z" };
  if (NAMED[e.key] && !e.metaKey) return { kind: "send", data: NAMED[e.key]! };

  // AltGr on Windows reports Ctrl+Alt; the character it produced is what the user typed.
  if (!mac && e.ctrlKey && e.altKey && e.key.length === 1 && !controlChar(e.key)) return { kind: "send", data: e.key };

  if (e.ctrlKey && !e.altKey) {
    const c = controlChar(e.key);
    return c ? { kind: "send", data: c } : { kind: "pass" };
  }

  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return { kind: "send", data: e.key };
  return { kind: "pass" };
}

/** True when Ctrl+K came from a terminal box, which sends it on as ^K instead of opening the palette. */
export function terminalOwnsCtrlK(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && typeof el.closest === "function" && el.closest(".term-box"));
}
