import { isTauri } from "./bridge";
import { dropKindOf, mediaTypeFor, shouldSkipVideoPreview, type DropKind, type StagedAttachment } from "./dropPreview";
import { native } from "./native";

export interface DraggedOsItem {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
}

export interface SafeDroppedFiles {
  files: File[];
  folderNames: string[];
  skippedDirs: string[];
}

export interface DropEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, error?: (err: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      success: (entries: readonly DropEntryLike[]) => void,
      error?: (err: unknown) => void,
    ) => void;
  };
}

export interface DroppedDataSnapshot {
  entries: DropEntryLike[];
  files: File[];
}

const IGNORED_DROP_ENTRIES = new Set([".git", "node_modules", ".DS_Store", "target"]);
const DEFAULT_MAX_COLLECTED_FILES = 20;
const MAX_DIR_DEPTH = 16;

let osSeq = 0;

function isVisualDropKind(kind: DropKind): boolean {
  return kind === "image" || kind === "video" || kind === "audio" || kind === "pdf";
}

function pocketLocalUrl(path: string): string | undefined {
  const clean = path.trim();
  if (!clean) return undefined;
  return (
    native.localFileStreamUrl(clean) ??
    `pocket-local://localhost/file?${new URLSearchParams({ path: clean }).toString()}`
  );
}

/**
 * Reads real filesystem paths from the OS drag pasteboard on macOS Tauri windows.
 * Outside macOS Tauri (or if empty/error), returns `[]` cleanly.
 */
export async function readOsDraggedPaths(): Promise<DraggedOsItem[]> {
  if (!isTauri()) return [];
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const items = await invoke<DraggedOsItem[]>("read_os_drag_paths");
    if (!Array.isArray(items)) return [];
    return items.filter(
      (it): it is DraggedOsItem =>
        Boolean(it) &&
        typeof it.path === "string" &&
        it.path.length > 0 &&
        typeof it.name === "string" &&
        typeof it.isDir === "boolean" &&
        typeof it.size === "number",
    );
  } catch {
    return [];
  }
}

/**
 * Stages OS-dragged files and folders directly as host path references (`hostRef`),
 * using zero-copy `pocket-local://` URLs for visual media previews without FileReader IPC.
 */
export function stageOsDraggedItems(
  existing: readonly StagedAttachment[],
  items: readonly DraggedOsItem[],
  maxFiles: number,
): { added: StagedAttachment[]; notice?: string } {
  const seenSigs = new Set(existing.map((a) => a.sig));
  const seenRefs = new Set(existing.map((a) => a.hostRef).filter((v): v is string => Boolean(v)));
  const added: StagedAttachment[] = [];
  let notice: string | undefined;

  for (const item of items) {
    if (existing.length + added.length >= maxFiles) {
      notice = `一次最多附带 ${maxFiles} 个文件`;
      break;
    }
    const cleanPath = item.path.trim();
    if (!cleanPath) continue;
    const sig = `os:${cleanPath}`;
    if (seenSigs.has(sig) || seenRefs.has(cleanPath)) continue;
    seenSigs.add(sig);
    seenRefs.add(cleanPath);

    const name = item.name.trim() || cleanPath.split(/[/\\]/).pop() || cleanPath;
    const mime = item.isDir
      ? "inode/directory"
      : mediaTypeFor(name) || "application/octet-stream";
    const kind: DropKind = item.isDir ? "file" : dropKindOf(name, mime);
    const previewUrl =
      !item.isDir && isVisualDropKind(kind) && !shouldSkipVideoPreview(kind, Math.max(0, item.size))
        ? pocketLocalUrl(cleanPath)
        : undefined;

    added.push({
      id: `att-os-${++osSeq}`,
      sig,
      name,
      mime,
      size: item.isDir ? 0 : Math.max(0, item.size),
      kind,
      hostRef: cleanPath,
      isDir: item.isDir,
      previewUrl,
    });
  }

  return { added, notice };
}

/**
 * Synchronously captures `DataTransfer.items` (`webkitGetAsEntry`) and `DataTransfer.files`
 * before any async work clears browser drag state.
 */
export function snapshotDroppedDataTransfer(dataTransfer: DataTransfer | null): DroppedDataSnapshot {
  if (!dataTransfer) return { entries: [], files: [] };
  const entries: DropEntryLike[] = [];
  const rawItems = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  for (const item of rawItems) {
    const withEntry = item as DataTransferItem & {
      webkitGetAsEntry?: () => DropEntryLike | null;
    };
    if (typeof withEntry.webkitGetAsEntry === "function") {
      try {
        const entry = withEntry.webkitGetAsEntry();
        if (entry) entries.push(entry);
      } catch {
        // Ignore broken WebKit entry access; fallback files list covers regular files.
      }
    }
  }
  const files = dataTransfer.files ? Array.from(dataTransfer.files) : [];
  return { entries, files };
}

function isSnapshot(
  input: DataTransfer | DroppedDataSnapshot | null,
): input is DroppedDataSnapshot {
  return Boolean(
    input &&
      typeof input === "object" &&
      "entries" in input &&
      Array.isArray((input as DroppedDataSnapshot).entries) &&
      "files" in input &&
      Array.isArray((input as DroppedDataSnapshot).files),
  );
}

async function probeReadableFile(file: File): Promise<boolean> {
  try {
    const slice = typeof file.slice === "function" ? file.slice(0, 1) : file;
    await slice.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

function readEntryFile(entry: DropEntryLike): Promise<File | null> {
  if (typeof entry.file !== "function") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      entry.file!(
        (file) => resolve(file),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

async function readAllDirectoryEntries(entry: DropEntryLike): Promise<DropEntryLike[]> {
  if (typeof entry.createReader !== "function") return [];
  let reader: ReturnType<NonNullable<DropEntryLike["createReader"]>>;
  try {
    reader = entry.createReader();
  } catch {
    return [];
  }
  const collected: DropEntryLike[] = [];
  for (;;) {
    const batch = await new Promise<readonly DropEntryLike[]>((resolve) => {
      try {
        reader.readEntries(
          (entries) => resolve(entries),
          () => resolve([]),
        );
      } catch {
        resolve([]);
      }
    });
    if (!batch.length) break;
    collected.push(...batch);
  }
  return collected;
}

async function walkDirectoryEntry(
  entry: DropEntryLike,
  out: File[],
  maxFiles: number,
  depth = 0,
): Promise<number> {
  if (depth > MAX_DIR_DEPTH || out.length >= maxFiles) return 0;
  const children = await readAllDirectoryEntries(entry);
  let addedCount = 0;
  for (const child of children) {
    if (out.length >= maxFiles) break;
    if (IGNORED_DROP_ENTRIES.has(child.name)) continue;
    if (child.isFile) {
      const f = await readEntryFile(child);
      if (f && (await probeReadableFile(f))) {
        out.push(f);
        addedCount += 1;
      }
    } else if (child.isDirectory) {
      addedCount += await walkDirectoryEntry(child, out, maxFiles, depth + 1);
    }
  }
  return addedCount;
}

/**
 * Safely collects readable `File` objects from an HTML5 drop payload without throwing
 * `NotReadableError` / `EISDIR` on dropped OS folders.
 */
export async function collectDroppedFilesSafe(
  dataTransfer: DataTransfer | DroppedDataSnapshot | null,
  opts?: { maxFiles?: number },
): Promise<SafeDroppedFiles> {
  const maxFiles = Math.max(1, Math.min(DEFAULT_MAX_COLLECTED_FILES, opts?.maxFiles ?? DEFAULT_MAX_COLLECTED_FILES));
  if (!dataTransfer) return { files: [], folderNames: [], skippedDirs: [] };

  const snapshot = isSnapshot(dataTransfer)
    ? dataTransfer
    : snapshotDroppedDataTransfer(dataTransfer);

  const files: File[] = [];
  const folderNames: string[] = [];
  const skippedDirs: string[] = [];

  if (snapshot.entries.length > 0) {
    for (const entry of snapshot.entries) {
      if (entry.isDirectory) {
        const dirName = entry.name || "文件夹";
        folderNames.push(dirName);
        const before = files.length;
        if (files.length < maxFiles) {
          await walkDirectoryEntry(entry, files, maxFiles, 0);
        }
        if (files.length === before) {
          skippedDirs.push(dirName);
        }
      } else if (entry.isFile) {
        if (files.length >= maxFiles) continue;
        const f = await readEntryFile(entry);
        if (f && (await probeReadableFile(f))) {
          files.push(f);
        } else if (f) {
          const fallbackName = f.name || entry.name || "文件夹";
          folderNames.push(fallbackName);
          skippedDirs.push(fallbackName);
        }
      }
    }
    return { files, folderNames, skippedDirs };
  }

  for (const file of snapshot.files) {
    const readable = await probeReadableFile(file);
    if (!readable) {
      const name = file.name || "文件夹";
      folderNames.push(name);
      skippedDirs.push(name);
      continue;
    }
    if (files.length < maxFiles) {
      files.push(file);
    }
  }

  return { files, folderNames, skippedDirs };
}
