import { revokeAttachment, type StagedAttachment } from "./dropPreview";

const STORAGE_KEY = "herdr-pocket-composer-drafts-v1";
const MAX_STORED_DRAFTS = 200;

interface StoredTextDraft {
  text: string;
  updatedAt: number;
}

const textCache = new Map<string, StoredTextDraft>();
const attachmentsCache = new Map<string, StagedAttachment[]>();
let loadedFromStorage = false;

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
      if (typeof rec.text === "string" && rec.text.length > 0) {
        textCache.set(key, {
          text: rec.text,
          updatedAt: typeof rec.updatedAt === "number" ? rec.updatedAt : Date.now(),
        });
      }
    }
  } catch {
    /* ignore storage errors */
  }
}

function persistTextCache(): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (textCache.size > MAX_STORED_DRAFTS) {
      const oldest = [...textCache.entries()]
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
        .slice(0, textCache.size - MAX_STORED_DRAFTS);
      for (const [k] of oldest) textCache.delete(k);
    }
    const obj: Record<string, StoredTextDraft> = {};
    for (const [k, v] of textCache.entries()) {
      if (v.text.length > 0) obj[k] = v;
    }
    if (Object.keys(obj).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* quota/private mode */
  }
}

export function getComposerDraft(agentKey: string): { text: string; attachments: StagedAttachment[] } {
  ensureLoaded();
  const text = textCache.get(agentKey)?.text ?? "";
  const attachments = attachmentsCache.get(agentKey) ?? [];
  return { text, attachments };
}

export function setComposerDraftText(agentKey: string, text: string): void {
  ensureLoaded();
  if (!agentKey) return;
  if (!text) textCache.delete(agentKey);
  else textCache.set(agentKey, { text, updatedAt: Date.now() });
  persistTextCache();
}

export function setComposerDraftAttachments(agentKey: string, attachments: StagedAttachment[]): void {
  if (!agentKey) return;
  if (!attachments.length) attachmentsCache.delete(agentKey);
  else attachmentsCache.set(agentKey, [...attachments]);
}

export function clearComposerDraft(agentKey: string, opts: { revoke?: boolean } = {}): void {
  ensureLoaded();
  textCache.delete(agentKey);
  persistTextCache();
  const prev = attachmentsCache.get(agentKey);
  attachmentsCache.delete(agentKey);
  if (opts.revoke && prev?.length) {
    for (const item of prev) revokeAttachment(item);
  }
}

export function resetComposerDraftsForTest(): void {
  textCache.clear();
  attachmentsCache.clear();
  loadedFromStorage = false;
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
