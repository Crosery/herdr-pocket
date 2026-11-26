import { logger } from "./log";
import { recordClickPaintSample, recordKeyPaintSample } from "./perfTelemetry";

const INTERACTIVE_SELECTOR =
  "button, a, [role='button'], [role='tab'], [role='menuitem'], [role='option'], [role='switch'], [role='checkbox'], summary, .agent-card, .mp-tab, .mp-card-btn";

function safeControlLabel(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || (el as HTMLElement).isContentEditable) {
    return el.getAttribute("aria-label") || el.getAttribute("name") || tag;
  }
  const aria = el.getAttribute("aria-label") || el.getAttribute("title") || "";
  if (aria.trim()) return aria.trim().slice(0, 48);
  const raw = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return raw.slice(0, 48) || tag;
}

/**
 * Installs global capture-phase telemetry for interactive clicks, IME/voice composition overflow checks,
 * file drops, and uncaught window/promise errors (never logging sensitive input contents).
 */
export function installGlobalActionTelemetry(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  let compStartedAt = 0;

  const onClick = (ev: MouseEvent) => {
    const rawTarget = ev.target;
    if (!(rawTarget instanceof Element)) return;
    const hit = rawTarget.closest(INTERACTIVE_SELECTOR);
    if (!hit) return;
    const tag = hit.tagName.toLowerCase();
    const role = hit.getAttribute("role") || undefined;
    const label = safeControlLabel(hit);
    const id = hit.id || hit.getAttribute("data-testid") || undefined;
    const actionLabel = `${role ?? tag}: ${label}`;
    logger.info("ui.click", actionLabel, {
      tag,
      ...(role ? { role } : {}),
      ...(id ? { id } : {}),
    });
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "visible" &&
      typeof requestAnimationFrame === "function"
    ) {
      const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
      requestAnimationFrame(() => {
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        recordClickPaintSample(now - t0, actionLabel);
      });
    }
  };

  const onCompositionStart = () => {
    compStartedAt = Date.now();
  };

  const onCompositionEnd = (ev: CompositionEvent) => {
    const el = ev.target instanceof HTMLElement ? ev.target : null;
    if (el && (el.classList.contains("xterm-helper-textarea") || el.closest(".xterm"))) {
      compStartedAt = 0;
      return;
    }
    const tag = el ? el.tagName.toLowerCase() : "unknown";
    const ms = compStartedAt > 0 ? Math.max(0, Date.now() - compStartedAt) : 0;
    compStartedAt = 0;
    const chars = typeof ev.data === "string" ? ev.data.length : 0;
    const overflowX = el ? Math.max(0, Math.round(el.scrollWidth - el.clientWidth)) : 0;
    logger.info("ui.ime", "ime.commit", {
      tag,
      ms,
      chars,
      overflowX,
    });
    if (overflowX > 2) {
      logger.warn("ui.ime", `ime.overflow_x ${tag} (+${overflowX}px)`, { tag, overflowX, chars });
    }
  };

  const onDrop = (ev: DragEvent) => {
    const files = ev.dataTransfer?.files?.length ?? 0;
    const types = Array.from(ev.dataTransfer?.types ?? []).slice(0, 6).join(",");
    logger.info("ui.drop", "files.dropped", { files, types: types || undefined });
  };

  const onError = (ev: ErrorEvent) => {
    const stack = ev.error instanceof Error ? ev.error.stack : undefined;
    logger.error("app.error", ev.message || "window error", {
      file: ev.filename || undefined,
      line: ev.lineno || undefined,
      stack: stack ? stack.slice(0, 320) : undefined,
    });
  };

  const onRejection = (ev: PromiseRejectionEvent) => {
    const reason = ev.reason;
    const msg = reason instanceof Error ? reason.message : String(reason ?? "unhandled rejection");
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error("app.error", `unhandledrejection: ${msg}`, {
      stack: stack ? stack.slice(0, 320) : undefined,
    });
  };

  document.addEventListener("click", onClick, { capture: true, passive: true });
  const onKeyDown = (ev: KeyboardEvent) => {
    if (
      ev.key === "Meta" ||
      ev.key === "Control" ||
      ev.key === "Shift" ||
      ev.key === "Alt"
    ) {
      return;
    }
    if (
      typeof document === "undefined" ||
      document.visibilityState !== "visible" ||
      typeof requestAnimationFrame !== "function"
    ) {
      return;
    }
    const startMs = performance.now();
    const keyName = `${ev.metaKey ? "Cmd+" : ""}${ev.ctrlKey ? "Ctrl+" : ""}${ev.altKey ? "Alt+" : ""}${ev.key}`;
    requestAnimationFrame(() => {
      recordKeyPaintSample(performance.now() - startMs, keyName);
    });
  };
  document.addEventListener("keydown", onKeyDown, { capture: true, passive: true });
  document.addEventListener("compositionstart", onCompositionStart, { capture: true, passive: true });
  document.addEventListener("compositionend", onCompositionEnd, { capture: true, passive: true });
  document.addEventListener("drop", onDrop, { capture: true, passive: true });
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    document.removeEventListener("click", onClick, { capture: true });
    document.removeEventListener("keydown", onKeyDown, { capture: true });
    document.removeEventListener("compositionstart", onCompositionStart, { capture: true });
    document.removeEventListener("compositionend", onCompositionEnd, { capture: true });
    document.removeEventListener("drop", onDrop, { capture: true });
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
