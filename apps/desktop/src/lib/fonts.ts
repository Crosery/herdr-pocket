import { useEffect } from "react";
import { getHostdStatus } from "./bridge";
import { native, type FontCatalog, type FontFaceMeta } from "./native";
import { createStore } from "./store";

const BASE_FALLBACK_FONTS =
  '"JetBrains Mono", "Symbols Nerd Font Mono", "JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "Pocket Maple Mono", "SF Mono", Menlo, Monaco, ui-monospace, "Cascadia Mono", Consolas';
const CJK_FALLBACK_FONTS = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei"';

const GENERIC_FAMILIES = new Set([
  "monospace",
  "sans-serif",
  "serif",
  "ui-monospace",
  "system-ui",
  "cursive",
  "fantasy",
]);

function initialLocalHostId(): string | null {
  if (typeof window === "undefined") return null;
  const raw = window.__POCKET_LOCAL_HOST_ID__;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

export const localHostIdStore = createStore<string | null>(initialLocalHostId());
export const fontCatalogStore = createStore<FontCatalog | null>(null);

let hostIdInflight: Promise<string | null> | null = null;
let catalogInflight: Promise<FontCatalog | null> | null = null;

const loadedFamilies = new Set<string>();
const loadedFaceIds = new Set<number>();
const fontLoadInflight = new Map<string, Promise<boolean>>();
let loadedFontFaceEpoch = 0;

/** Monotonic counter incremented only when a new FontFace is actually added to `document.fonts`. */
export function getLoadedFontFaceEpoch(): number {
  return loadedFontFaceEpoch;
}

export async function refreshLocalHostIdFast(force = false): Promise<string | null> {
  const existing = localHostIdStore.get();
  if (existing && !force) return existing;
  if (!native.available()) return null;
  const direct = (await native.localHostDeviceId())?.trim() || null;
  if (direct) {
    if (direct !== existing) localHostIdStore.set(direct);
    return direct;
  }
  return ensureLocalHostDeviceId();
}

/** Fetches and caches this computer's local hostd deviceId when running inside Tauri. */
export async function ensureLocalHostDeviceId(): Promise<string | null> {
  const existing = localHostIdStore.get();
  if (existing) return existing;
  if (!native.available()) return null;
  if (hostIdInflight) return hostIdInflight;

  hostIdInflight = native
    .localHostDeviceId()
    .then(async (fast) => {
      const direct = fast?.trim() || null;
      if (direct) return direct;
      const status = await getHostdStatus().catch(() => null);
      return status?.deviceId?.trim() || null;
    })
    .then((id) => {
      if (id) localHostIdStore.set(id);
      return id;
    })
    .catch(() => null)
    .finally(() => {
      hostIdInflight = null;
    });

  return hostIdInflight;
}

export function useLocalHostDeviceId(): string | null {
  const deviceId = localHostIdStore.use((s) => s);
  useEffect(() => {
    void ensureLocalHostDeviceId();
    if (typeof window === "undefined") return;
    const onFocus = () => {
      void refreshLocalHostIdFast(true);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return deviceId;
}

/** Scans OS-installed monospace/Nerd fonts and Herdr/Symbols fonts via Tauri, once per session. */
export async function ensureFontCatalog(): Promise<FontCatalog | null> {
  const existing = fontCatalogStore.get();
  if (existing) return existing;
  if (!native.available()) return null;
  if (catalogInflight) return catalogInflight;

  catalogInflight = native
    .terminalListFonts()
    .then((catalog) => {
      if (catalog) {
        fontCatalogStore.set(catalog);
        if (catalog.symbolsFont) {
          void loadSingleFontFamily(catalog.symbolsFont, false);
        }
        if (catalog.herdrFont) {
          void loadSingleFontFamily(catalog.herdrFont, false);
        }
        if (catalog.families.some((f) => f.toLowerCase() === "jetbrains mono")) {
          void loadSingleFontFamily("JetBrains Mono", false);
        }
      }
      return catalog;
    })
    .catch(() => null)
    .finally(() => {
      catalogInflight = null;
    });

  return catalogInflight;
}

export function useTerminalFontCatalog(): FontCatalog | null {
  const catalog = fontCatalogStore.use((s) => s);
  useEffect(() => {
    void ensureFontCatalog().then((cat) => {
      if (cat?.symbolsFont) void loadSingleFontFamily(cat.symbolsFont, false);
      if (cat?.herdrFont) void loadSingleFontFamily(cat.herdrFont, false);
    });
  }, []);
  return catalog;
}

function quoteCssFont(name: string): string {
  const clean = name.trim();
  if (!clean) return "";
  if (/^[A-Za-z0-9_-]+$/.test(clean) || /^["'].*["']$/.test(clean)) return clean;
  return JSON.stringify(clean);
}

export function splitFontFamilies(raw: string): string[] {
  return raw
    .split(",")
    .map((p) => p.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * Builds the CSS font-family list used by xterm.js and the settings preview.
 * Keeps user choice first, inserts any detected Nerd Symbols font before CJK/system
 * fallbacks so PUA icons align cleanly, and falls back to bundled Pocket Maple Mono.
 */
export function buildTerminalFontFamily(
  customFamily: string,
  catalog: FontCatalog | null = fontCatalogStore.get(),
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined | null) => {
    const clean = raw?.trim().replace(/^["']|["']$/g, "");
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(quoteCssFont(clean));
  };

  const customList = splitFontFamilies(customFamily);
  if (customList.length > 0) {
    for (const f of customList) push(f);
  } else if (catalog?.herdrFont) {
    push(catalog.herdrFont);
  }

  if (catalog?.symbolsFont) {
    push(catalog.symbolsFont);
  }

  const baseList = `${BASE_FALLBACK_FONTS}, ${CJK_FALLBACK_FONTS}`;
  for (const f of splitFontFamilies(baseList)) push(f);
  push("Pocket Maple Mono");
  push("monospace");

  return parts.join(", ");
}

async function registerFontFace(face: FontFaceMeta, aliasFamily?: string): Promise<boolean> {
  if (loadedFaceIds.has(face.id)) return true;
  if (typeof document === "undefined" || typeof FontFace === "undefined") return false;

  const bytes = await native.terminalFontBytes(face.id);
  if (!bytes || bytes.byteLength === 0) return false;

  const targetFamily =
    aliasFamily && aliasFamily.toLowerCase() !== face.family.toLowerCase()
      ? aliasFamily
      : face.family;

  const descriptors: FontFaceDescriptors = {
    weight: String(face.weight || 400),
    style: face.style === "italic" ? "italic" : "normal",
  };

  try {
    const ff = new FontFace(targetFamily, bytes, descriptors);
    await ff.load();
    document.fonts.add(ff);
    loadedFaceIds.add(face.id);
    loadedFontFaceEpoch += 1;
    return true;
  } catch {
    return false;
  }
}

async function loadSingleFontFamily(family: string, preferBold: boolean): Promise<boolean> {
  const clean = family.trim().replace(/^["']|["']$/g, "");
  if (!clean) return false;
  const key = clean.toLowerCase();
  if (GENERIC_FAMILIES.has(key)) return false;
  if (loadedFamilies.has(key)) return true;
  if (!native.available() || typeof document === "undefined" || typeof FontFace === "undefined") {
    return false;
  }

  const pending = fontLoadInflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const faces = await native.terminalFontFaces(clean);
    if (!faces || faces.length === 0) return false;

    const primary: FontFaceMeta[] = [];
    const secondary: FontFaceMeta[] = [];

    for (const face of faces) {
      const isNormal = face.style !== "italic";
      const isCoreWeight =
        face.weight === 400 ||
        face.weight === 500 ||
        face.weight === 700 ||
        (preferBold && face.weight >= 500 && face.weight <= 800);
      if (isNormal && isCoreWeight) {
        primary.push(face);
      } else {
        secondary.push(face);
      }
    }

    if (primary.length === 0 && faces.length > 0) {
      const first = secondary.shift();
      if (first) primary.push(first);
    }

    const coreResults = await Promise.all(primary.map((face) => registerFontFace(face, clean)));
    const ok = coreResults.some(Boolean);
    if (ok) {
      loadedFamilies.add(key);
    }

    // Load italics and extra weights in background without blocking terminal readiness.
    if (secondary.length > 0) {
      void Promise.all(secondary.map((face) => registerFontFace(face, clean))).catch(() => {});
    }

    try {
      await document.fonts.ready;
    } catch {
      // ignore
    }
    return ok;
  })()
    .catch(() => false)
    .finally(() => {
      fontLoadInflight.delete(key);
    });

  fontLoadInflight.set(key, task);
  return task;
}

export const DEFAULT_UI_BODY_STACK =
  '"Nunito", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';
export const DEFAULT_UI_CUTE_STACK =
  '"Pocket Digits", "ZCOOL KuaiLe", "Nunito", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';

const CANDIDATE_UI_FONTS = [
  "PingFang SC",
  "HarmonyOS Sans SC",
  "MiSans",
  "LXGW WenKai",
  "Source Han Sans SC",
  "Noto Sans SC",
  "SF Pro Text",
  "Inter",
  "Nunito",
  "Microsoft YaHei UI",
  "Segoe UI",
];

let cachedUiFallbackFonts: string[] | null = null;

/** Browser / HarmonyOS fallback list of installed UI fonts when native catalog is unavailable. */
export function detectInstalledUiFonts(): string[] {
  if (cachedUiFallbackFonts) return cachedUiFallbackFonts;
  if (typeof document === "undefined") return [];
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    const sample = "Herdr Pocket 简体中文 012345 ABCDE";
    ctx.font = "48px sans-serif";
    const baseSans = ctx.measureText(sample).width;
    ctx.font = "48px monospace";
    const baseMono = ctx.measureText(sample).width;
    const found: string[] = [];
    for (const font of CANDIDATE_UI_FONTS) {
      const q = JSON.stringify(font);
      ctx.font = `48px ${q}, sans-serif`;
      const wSans = ctx.measureText(sample).width;
      ctx.font = `48px ${q}, monospace`;
      const wMono = ctx.measureText(sample).width;
      if (wSans !== baseSans || wMono !== baseMono) found.push(font);
    }
    cachedUiFallbackFonts = found;
    return found;
  } catch {
    return [];
  }
}

/** Builds `--font-body` with user-chosen global UI fonts first, keeping CJK and system sans fallbacks. */
export function buildUiFontFamily(customFamily: string): string {
  const customList = splitFontFamilies(customFamily);
  if (customList.length === 0) return DEFAULT_UI_BODY_STACK;
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const clean = raw.trim().replace(/^["']|["']$/g, "");
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(quoteCssFont(clean));
  };
  for (const f of customList) push(f);
  for (const f of splitFontFamilies(DEFAULT_UI_BODY_STACK)) push(f);
  return parts.join(", ");
}

/** Builds `--font-cute`, keeping `"Pocket Digits"` numeric styling while honoring user's UI font. */
export function buildCuteFontFamily(customFamily: string): string {
  const customList = splitFontFamilies(customFamily);
  if (customList.length === 0) return DEFAULT_UI_CUTE_STACK;
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const clean = raw.trim().replace(/^["']|["']$/g, "");
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(quoteCssFont(clean));
  };
  push("Pocket Digits");
  for (const f of customList) push(f);
  for (const f of splitFontFamilies(DEFAULT_UI_CUTE_STACK)) push(f);
  return parts.join(", ");
}

/** Loads user-chosen global UI font files into `document.fonts` via FontFace inside Tauri WKWebView. */
export async function ensureUiFontLoaded(customFamily: string): Promise<boolean> {
  if (!native.available() || typeof document === "undefined" || typeof FontFace === "undefined") {
    return false;
  }
  const families = splitFontFamilies(customFamily);
  if (families.length === 0) return false;
  await ensureFontCatalog();
  const results = await Promise.all(families.map((fam) => loadSingleFontFamily(fam, true)));
  return results.some(Boolean);
}

/**
 * Loads OS font files into `document.fonts` via FontFace so WKWebView's privacy
 * font restriction does not block user-installed fonts (~/Library/Fonts/*, Nerd Fonts).
 * Returns true when at least one face was newly or previously loaded.
 */
export async function ensureTerminalFontLoaded(customFamily: string, preferBold = false): Promise<boolean> {
  if (!native.available() || typeof document === "undefined" || typeof FontFace === "undefined") {
    return false;
  }

  const catalog = await ensureFontCatalog();
  const families = splitFontFamilies(customFamily);
  if (families.length === 0) {
    if (catalog?.herdrFont) {
      families.push(catalog.herdrFont);
    }
    if (
      catalog?.families.some((f) => f.toLowerCase() === "jetbrains mono") &&
      !families.some((f) => f.toLowerCase() === "jetbrains mono")
    ) {
      families.push("JetBrains Mono");
    }
  }
  if (catalog?.symbolsFont && !families.some((f) => f.toLowerCase() === catalog.symbolsFont!.toLowerCase())) {
    families.push(catalog.symbolsFont);
  }

  if (families.length === 0) return false;
  const results = await Promise.all(families.map((fam) => loadSingleFontFamily(fam, preferBold)));
  return results.some(Boolean);
}
