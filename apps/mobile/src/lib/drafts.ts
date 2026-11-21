import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Attachment } from "./attach";

const DRAFT_KEY = "herdr-pocket-mobile-drafts-v1";
const textMap = new Map<string, string>();
const picturesMap = new Map<string, Attachment[]>();
let hydrated = false;
let hydratePromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function hydrateMobileDrafts(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydratePromise) return hydratePromise;
  hydratePromise = AsyncStorage.getItem(DRAFT_KEY)
    .then((raw) => {
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && v.length > 0 && !textMap.has(k)) {
          textMap.set(k, v);
        }
      }
      for (const fn of listeners) fn();
    })
    .catch(() => {})
    .finally(() => {
      hydrated = true;
    });
  return hydratePromise;
}

export function onDraftsHydrated(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function flushTextStorage(): void {
  const entries = [...textMap.entries()].filter(([, v]) => v.length > 0).slice(-200);
  const obj = Object.fromEntries(entries);
  AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(obj)).catch(() => {});
}

export function getMobileDraft(agentKey: string): { text: string; pictures: Attachment[] } {
  return {
    text: textMap.get(agentKey) ?? "",
    pictures: picturesMap.get(agentKey) ?? [],
  };
}

export function setMobileDraftText(agentKey: string, text: string): void {
  if (!agentKey) return;
  if (!text) textMap.delete(agentKey);
  else textMap.set(agentKey, text);
  flushTextStorage();
}

export function setMobileDraftPictures(agentKey: string, pictures: Attachment[]): void {
  if (!agentKey) return;
  if (!pictures.length) picturesMap.delete(agentKey);
  else picturesMap.set(agentKey, [...pictures]);
}

export function clearMobileDraft(agentKey: string): void {
  if (!agentKey) return;
  textMap.delete(agentKey);
  picturesMap.delete(agentKey);
  flushTextStorage();
}
