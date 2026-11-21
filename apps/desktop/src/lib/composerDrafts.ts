import {
  hydrateAttachment,
  revokeAttachment,
  serializeAttachment,
  type SerializedAttachment,
  type StagedAttachment,
} from "./dropPreview";
import { registerWorkspaceSection, scheduleWorkspacePersist } from "./workspacePersist";

const STORAGE_KEY = "herdr-pocket-composer-drafts-v1";
const MAX_STORED_DRAFTS = 200;
const LOCAL_STORAGE_MAX_CHARS = 3_500_000;

interface StoredTextDraft {
  text: string;
  updatedAt: number;
}

interface StoredDraftPayload {
  text?: string;
  attachments?: SerializedAttachment[];
  updatedAt: number;
}

const textCache = new Map<string, StoredTextDraft>();
const attachmentsCache = new Map<string, { items: StagedAttachment[]; updatedAt: number }>();
const dirtyKeys = new Set<string>();
const listeners = new Set<() => void>();
let loadedFromStorage = false;

function notifyDraftListeners(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* ignore subscriber errors */
    }
  }
}

function parseSerializedAttachments(raw: unknown): StagedAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: StagedAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Partial<SerializedAttachment>;
    if (typeof rec.id !== "string" || typeof rec.name !== "string") continue;
    out.push(hydrateAttachment(rec as SerializedAttachment));
  }
  return out;
}

function ensureLoaded(): void {
  if (loadedFromStorage) return;
  loadedFromStorage = true;
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [key, val] of Object.entries(parsed)) {
      if (!val || typeof val !== "object") continue;
      const rec = val as Record<string, unknown>;
      const updatedAt = typeof rec.updatedAt === "number" ? rec.updatedAt : Date.now();
      if (typeof rec.text === "string" && rec.text.length > 0) {
        textCache.set(key, { text: rec.text, updatedAt });
      }
      const atts = parseSerializedAttachments(rec.attachments);
      if (atts.length > 0) {
        attachmentsCache.set(key, { items: atts, updatedAt });
      }
    }
  } catch {
    /* ignore storage errors */
  }
}

function buildSerializedDrafts(includeAttachments: boolean): Record<string, StoredDraftPayload> {
  const keys = new Set([...textCache.keys(), ...attachmentsCache.keys()]);
  const entries: Array<[string, StoredDraftPayload]> = [];
  for (const key of keys) {
    const t = textCache.get(key);
    const a = attachmentsCache.get(key);
    const text = t?.text ?? "";
    const atts = includeAttachments ? a?.items ?? [] : [];
    if (!text && atts.length === 0) continue;
    const updatedAt = Math.max(t?.updatedAt ?? 0, a?.updatedAt ?? 0) || Date.now();
    entries.push([
      key,
      {
        ...(text ? { text } : {}),
        ...(atts.length ? { attachments: atts.map(serializeAttachment) } : {}),
        updatedAt,
      },
    ]);
  }
  if (entries.length > MAX_STORED_DRAFTS) {
    entries.sort((x, y) => x[1].updatedAt - y[1].updatedAt);
    const dropCount = entries.length - MAX_STORED_DRAFTS;
    for (let i = 0; i < dropCount; i++) {
      const k = entries[i]![0];
      textCache.delete(k);
      const prev = attachmentsCache.get(k);
      attachmentsCache.delete(k);
      if (prev) for (const item of prev.items) revokeAttachment(item);
    }
    entries.splice(0, dropCount);
  }
  return Object.fromEntries(entries);
}

function persistLocalStorage(): void {
  try {
    if (typeof localStorage === "undefined") return;
    const full = buildSerializedDrafts(true);
    if (Object.keys(full).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const json = JSON.stringify(full);
    if (json.length <= LOCAL_STORAGE_MAX_CHARS) {
      localStorage.setItem(STORAGE_KEY, json);
      return;
    }
    const textOnly = buildSerializedDrafts(false);
    if (Object.keys(textOnly).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(textOnly));
  } catch {
    try {
      if (typeof localStorage === "undefined") return;
      const textOnly = buildSerializedDrafts(false);
      if (Object.keys(textOnly).length === 0) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(textOnly));
    } catch {
      /* quota/private mode */
    }
  }
}

function serializeComposerDrafts(): Record<string, StoredDraftPayload> | undefined {
  ensureLoaded();
  const full = buildSerializedDrafts(true);
  return Object.keys(full).length ? full : undefined;
}

function hydrateComposerDrafts(raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  ensureLoaded();
  const parsed = raw as Record<string, unknown>;

  for (const key of [...textCache.keys(), ...attachmentsCache.keys()]) {
    if (dirtyKeys.has(key) || Object.hasOwn(parsed, key)) continue;
    textCache.delete(key);
    const prev = attachmentsCache.get(key);
    attachmentsCache.delete(key);
    if (prev) for (const item of prev.items) revokeAttachment(item);
  }

  for (const [key, val] of Object.entries(parsed)) {
    if (dirtyKeys.has(key)) continue;
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const rec = val as Record<string, unknown>;
    const updatedAt = typeof rec.updatedAt === "number" ? rec.updatedAt : Date.now();
    if (typeof rec.text === "string" && rec.text.length > 0) {
      textCache.set(key, { text: rec.text, updatedAt });
    } else {
      textCache.delete(key);
    }
    const prev = attachmentsCache.get(key);
    if (prev) for (const item of prev.items) revokeAttachment(item);
    const atts = parseSerializedAttachments(rec.attachments);
    if (atts.length > 0) {
      attachmentsCache.set(key, { items: atts, updatedAt });
    } else {
      attachmentsCache.delete(key);
    }
  }

  persistLocalStorage();
  notifyDraftListeners();
}

registerWorkspaceSection("composerDrafts", {
  serialize: serializeComposerDrafts,
  hydrate: hydrateComposerDrafts,
});

/** Subscribes to draft store updates triggered by async native hydration after startup. */
export function subscribeComposerDrafts(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getComposerDraft(agentKey: string): { text: string; attachments: StagedAttachment[] } {
  ensureLoaded();
  const text = textCache.get(agentKey)?.text ?? "";
  const attachments = attachmentsCache.get(agentKey)?.items ?? [];
  return { text, attachments };
}

export function setComposerDraftText(agentKey: string, text: string): void {
  ensureLoaded();
  if (!agentKey) return;
  dirtyKeys.add(agentKey);
  if (!text) textCache.delete(agentKey);
  else textCache.set(agentKey, { text, updatedAt: Date.now() });
  persistLocalStorage();
  scheduleWorkspacePersist();
}

export function setComposerDraftAttachments(agentKey: string, attachments: StagedAttachment[]): void {
  ensureLoaded();
  if (!agentKey) return;
  dirtyKeys.add(agentKey);
  if (!attachments.length) attachmentsCache.delete(agentKey);
  else attachmentsCache.set(agentKey, { items: [...attachments], updatedAt: Date.now() });
  persistLocalStorage();
  scheduleWorkspacePersist();
}

export function clearComposerDraft(agentKey: string, opts: { revoke?: boolean } = {}): void {
  ensureLoaded();
  if (agentKey) dirtyKeys.add(agentKey);
  textCache.delete(agentKey);
  const prev = attachmentsCache.get(agentKey);
  attachmentsCache.delete(agentKey);
  if (opts.revoke && prev?.items.length) {
    for (const item of prev.items) revokeAttachment(item);
  }
  persistLocalStorage();
  scheduleWorkspacePersist();
}

export function resetComposerDraftsForTest(): void {
  textCache.clear();
  for (const prev of attachmentsCache.values()) {
    for (const item of prev.items) revokeAttachment(item);
  }
  attachmentsCache.clear();
  dirtyKeys.clear();
  listeners.clear();
  loadedFromStorage = false;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
