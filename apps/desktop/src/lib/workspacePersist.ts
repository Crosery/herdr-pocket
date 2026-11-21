import { isTauri, loadWorkspaceStateRaw, saveWorkspaceStateRaw } from "./bridge";

export const WORKSPACE_STATE_KEY = "herdr-pocket-workspace-state-v1";
const LOCAL_MIRROR_MAX_CHARS = 4 * 1024 * 1024;
const NATIVE_MAX_BYTES = 32 * 1024 * 1024;
const PERSIST_DEBOUNCE_MS = 250;

export type WorkspaceSectionName = "chatQueue" | "composerDrafts" | "shellState";

export interface WorkspaceSectionAdapter {
  serialize: () => unknown;
  hydrate: (raw: unknown) => void;
}

interface WorkspaceStateSnapshot {
  version: number;
  updatedAt: number;
  chatQueue?: unknown;
  composerDrafts?: unknown;
  shellState?: unknown;
}

const adapters = new Map<WorkspaceSectionName, WorkspaceSectionAdapter>();

let loadedSnapshot: WorkspaceStateSnapshot | null = null;
let hasHydrated = false;
let hydratingPromise: Promise<void> | null = null;
let applyingHydration = false;
let dirtyDuringHydrate = false;

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight: Promise<void> | null = null;
let flushRequestedAgain = false;
let lastBodyJson: string | null = null;
let listenersInstalled = false;

function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  return text.length * 3;
}

function parseSnapshot(raw: string | null | undefined): WorkspaceStateSnapshot | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    return {
      version: typeof obj.version === "number" ? obj.version : 1,
      updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : 0,
      ...(Object.hasOwn(obj, "chatQueue") ? { chatQueue: obj.chatQueue } : {}),
      ...(Object.hasOwn(obj, "composerDrafts") ? { composerDrafts: obj.composerDrafts } : {}),
      ...(Object.hasOwn(obj, "shellState") ? { shellState: obj.shellState } : {}),
    };
  } catch {
    return null;
  }
}

function readLocalStorageSnapshot(): WorkspaceStateSnapshot | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return parseSnapshot(localStorage.getItem(WORKSPACE_STATE_KEY));
  } catch {
    return null;
  }
}

function collectSections(): Partial<Record<WorkspaceSectionName, unknown>> {
  const out: Partial<Record<WorkspaceSectionName, unknown>> = {};
  for (const [name, adapter] of adapters) {
    try {
      const value = adapter.serialize();
      if (value !== undefined) out[name] = value;
    } catch {
      /* ignore section serialize failure */
    }
  }
  return out;
}

function installLifecycleListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
      void flushWorkspaceStateNow();
    });
    window.addEventListener("beforeunload", () => {
      void flushWorkspaceStateNow();
    });
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        void flushWorkspaceStateNow();
      }
    });
  }
}

installLifecycleListeners();

/**
 * Registers a state section's serializer and hydrator without introducing circular imports.
 * If hydration already completed before registration, immediately hydrates this section.
 */
export function registerWorkspaceSection(
  name: WorkspaceSectionName,
  adapter: WorkspaceSectionAdapter,
): void {
  adapters.set(name, adapter);
  if (hasHydrated && loadedSnapshot && Object.hasOwn(loadedSnapshot, name)) {
    applyingHydration = true;
    try {
      adapter.hydrate(loadedSnapshot[name]);
    } finally {
      applyingHydration = false;
    }
  }
}

/**
 * Loads persisted workspace state from Tauri (`workspace-state.json`) with `localStorage` fallback
 * for web / HarmonyOS, and hydrates all registered sections.
 */
export async function hydrateWorkspaceState(): Promise<void> {
  if (hydratingPromise) return hydratingPromise;
  hydratingPromise = (async () => {
    dirtyDuringHydrate = false;
    const nativeRaw = isTauri() ? await loadWorkspaceStateRaw() : null;
    const nativeSnap = parseSnapshot(nativeRaw);
    const localSnap = readLocalStorageSnapshot();
    const snapshot =
      nativeSnap && localSnap
        ? localSnap.updatedAt > nativeSnap.updatedAt
          ? localSnap
          : nativeSnap
        : nativeSnap ?? localSnap;

    loadedSnapshot = snapshot;
    hasHydrated = true;

    if (snapshot) {
      applyingHydration = true;
      try {
        for (const [name, adapter] of adapters) {
          if (Object.hasOwn(snapshot, name)) {
            adapter.hydrate(snapshot[name]);
          }
        }
      } finally {
        applyingHydration = false;
      }
      lastBodyJson = JSON.stringify(collectSections());
    }

    if (dirtyDuringHydrate) {
      dirtyDuringHydrate = false;
      await flushWorkspaceStateNow();
    }
  })().finally(() => {
    hydratingPromise = null;
  });
  return hydratingPromise;
}

async function performFlush(): Promise<void> {
  const body = collectSections();
  const bodyJson = JSON.stringify(body);
  if (bodyJson === lastBodyJson) return;

  const payload: WorkspaceStateSnapshot = {
    version: 1,
    updatedAt: Date.now(),
    ...body,
  };
  const raw = JSON.stringify(payload);
  if (utf8ByteLength(raw) > NATIVE_MAX_BYTES) {
    return;
  }

  try {
    if (typeof localStorage !== "undefined") {
      if (raw.length <= LOCAL_MIRROR_MAX_CHARS) {
        localStorage.setItem(WORKSPACE_STATE_KEY, raw);
      } else {
        localStorage.removeItem(WORKSPACE_STATE_KEY);
      }
    }
  } catch {
    /* ignore quota/private-mode errors */
  }

  if (isTauri()) {
    await saveWorkspaceStateRaw(raw).catch(() => {});
  }
  lastBodyJson = bodyJson;
}

/** Immediately flushes dirty workspace state to `localStorage` and native `workspace-state.json`. */
export async function flushWorkspaceStateNow(): Promise<void> {
  if (hydratingPromise) {
    await hydratingPromise;
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (flushInFlight) {
    flushRequestedAgain = true;
    return flushInFlight;
  }
  flushInFlight = (async () => {
    do {
      flushRequestedAgain = false;
      await performFlush();
    } while (flushRequestedAgain);
  })().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

/** Schedules a debounced workspace state persistence pass. */
export function scheduleWorkspacePersist(): void {
  if (applyingHydration) return;
  if (hydratingPromise) {
    dirtyDuringHydrate = true;
    return;
  }
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushWorkspaceStateNow();
  }, PERSIST_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

/** Resets in-memory persistence bookkeeping and `localStorage` key for isolated tests. */
export function resetWorkspacePersistForTest(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  loadedSnapshot = null;
  hasHydrated = false;
  hydratingPromise = null;
  applyingHydration = false;
  dirtyDuringHydrate = false;
  flushInFlight = null;
  flushRequestedAgain = false;
  lastBodyJson = null;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(WORKSPACE_STATE_KEY);
    }
  } catch {
    /* ignore */
  }
}
