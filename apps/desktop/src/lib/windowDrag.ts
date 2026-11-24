import { isTauri } from "./bridge";
import { native } from "./native";

const DRAG_ATTR = "data-tauri-drag-region";
const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
  "combobox",
  "slider",
  "separator",
]);

function readAttr(el: object, name: string): string | null {
  const fn = (el as { getAttribute?: (k: string) => string | null }).getAttribute;
  return typeof fn === "function" ? fn.call(el, name) : null;
}

function hasAttr(el: object, name: string): boolean {
  const fn = (el as { hasAttribute?: (k: string) => boolean }).hasAttribute;
  return typeof fn === "function" ? fn.call(el, name) : false;
}

function isInteractiveElement(el: object): boolean {
  const tag = String((el as { tagName?: string }).tagName ?? "").toUpperCase();
  if (INTERACTIVE_TAGS.has(tag)) return true;
  if (hasAttr(el, "contenteditable") && readAttr(el, "contenteditable") !== "false") return true;
  const tabIndex = readAttr(el, "tabindex");
  if (tabIndex !== null && tabIndex !== "-1") return true;
  const role = (readAttr(el, "role") ?? "").toLowerCase();
  return Boolean(role && INTERACTIVE_ROLES.has(role));
}

/**
 * Pure check matching Tauri's drag-region semantics (`"deep"`, `"true"`/`""`, `"false"`)
 * while allowing SVG/span children inside interactive buttons to block drags cleanly and
 * SVG/img/span decorations inside `"deep"` containers (such as `.v3-brand`) to initiate drags.
 */
export function isWindowDragTarget(composedPath: readonly unknown[]): boolean {
  if (!composedPath.length) return false;
  const firstEl = composedPath.find((n) => Boolean(n && typeof n === "object" && "tagName" in n)) ?? null;
  for (const node of composedPath) {
    if (!node || typeof node !== "object" || !("tagName" in node)) continue;
    if (typeof (node as { getAttribute?: unknown }).getAttribute !== "function") continue;
    const attr = readAttr(node, DRAG_ATTR);
    if (attr === "false") return false;
    if (isInteractiveElement(node) && attr === null) return false;
    if (attr === null) continue;
    if (attr === "deep") return true;
    if (attr === "" || attr === "true") return node === firstEl;
  }
  return false;
}

/**
 * Capture-phase native window drag handler that supersedes Tauri's built-in `drag.js`.
 * Avoids macOS's `detail === 2` press-drag hole and routes drags through `window_start_dragging`,
 * which synthesizes a valid main-window `LeftMouseDown` NSEvent if WebKit IPC arrived after
 * a mouse-move/key-up/HUD event overwrote `NSApp.currentEvent`.
 */
export function installWindowDragBridge(): () => void {
  if (!isTauri() || typeof window === "undefined") return () => {};

  let cleanupDouble: (() => void) | null = null;

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    if (document.documentElement.dataset.splitResizing) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (!isWindowDragTarget(path)) return;

    cleanupDouble?.();
    cleanupDouble = null;

    e.preventDefault();
    e.stopImmediatePropagation();

    if (e.detail === 2) {
      const startX = e.clientX;
      const startY = e.clientY;
      const clear = () => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        window.removeEventListener("blur", clear);
        cleanupDouble = null;
      };
      const onMove = (mv: MouseEvent) => {
        if ((mv.buttons & 1) === 0) {
          clear();
          return;
        }
        if (Math.hypot(mv.clientX - startX, mv.clientY - startY) >= 3) {
          clear();
          void native.windowStartDragging();
        }
      };
      const onUp = (up: MouseEvent) => {
        const movedTooFar = Math.hypot(up.clientX - startX, up.clientY - startY) >= 3;
        clear();
        if (!movedTooFar) {
          void native.windowToggleMaximize();
        }
      };
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
      window.addEventListener("blur", clear);
      cleanupDouble = clear;
      return;
    }

    void native.windowStartDragging();
  };

  window.addEventListener("mousedown", onMouseDown, true);
  return () => {
    cleanupDouble?.();
    cleanupDouble = null;
    window.removeEventListener("mousedown", onMouseDown, true);
  };
}
