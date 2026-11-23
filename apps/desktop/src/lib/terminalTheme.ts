export type TerminalThemeChoice = "system" | "light" | "dark";
export type TerminalAppearance = "light" | "dark";

export interface TerminalThemePalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface TerminalThemeSpec {
  mode: TerminalAppearance;
  bg: string;
  fg: string;
  cursor: string;
  minimumContrastRatio: number;
  theme: TerminalThemePalette;
}

// Paper preset from herdr-app/src/settings.rs
const LIGHT_SPEC: TerminalThemeSpec = {
  mode: "light",
  bg: "#ffffff",
  fg: "#25272c",
  cursor: "#25272c",
  minimumContrastRatio: 1,
  theme: {
    background: "#ffffff",
    foreground: "#25272c",
    cursor: "#25272c",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(207, 220, 245, 0.78)",
    black: "#25272c",
    red: "#c62a2a",
    green: "#1a7f37",
    yellow: "#8f5d00",
    blue: "#1f62d0",
    magenta: "#7a45c8",
    cyan: "#0f6f74",
    white: "#5f6068",
    brightBlack: "#7b7e87",
    brightRed: "#d1242f",
    brightGreen: "#1f883d",
    brightYellow: "#9a6700",
    brightBlue: "#0969da",
    brightMagenta: "#8250df",
    brightCyan: "#1b7c83",
    brightWhite: "#111214",
  },
};

// Graphite preset from herdr-app/src/settings.rs
const DARK_SPEC: TerminalThemeSpec = {
  mode: "dark",
  bg: "#17191d",
  fg: "#d2d4d9",
  cursor: "#d2d4d9",
  minimumContrastRatio: 1,
  theme: {
    background: "#17191d",
    foreground: "#d2d4d9",
    cursor: "#d2d4d9",
    cursorAccent: "#17191d",
    selectionBackground: "rgba(57, 68, 84, 0.72)",
    black: "#45484f",
    red: "#dc8c95",
    green: "#a6bd91",
    yellow: "#d8be87",
    blue: "#96b2d7",
    magenta: "#b5a2ce",
    cyan: "#8cbdc3",
    white: "#d2d4d9",
    brightBlack: "#818793",
    brightRed: "#f0a5ad",
    brightGreen: "#bad5a2",
    brightYellow: "#ead2a1",
    brightBlue: "#b0cbef",
    brightMagenta: "#cbb7e6",
    brightCyan: "#a4d5db",
    brightWhite: "#f0f0f2",
  },
};

/** Resolves effective terminal light/dark mode from app theme preference and OS color scheme. */
export function resolveTerminalAppearance(
  themeChoice: TerminalThemeChoice,
  systemDark: boolean,
): TerminalAppearance {
  if (themeChoice === "light" || themeChoice === "dark") return themeChoice;
  return systemDark ? "dark" : "light";
}

/** Returns Herdr.app-aligned xterm palette and contrast settings for light or dark mode. */
export function getTerminalThemeSpec(mode: TerminalAppearance): TerminalThemeSpec {
  return mode === "light" ? LIGHT_SPEC : DARK_SPEC;
}

/**
 * Deletes Kitty placements scoped by screen buffer (`alt` vs normal) for `d=a/A` and `d=c/C`,
 * or by image/placement ID for `d=i/I` and `d=p/P`, returning surviving placements and any
 * image IDs whose final placement was deleted by an uppercase eviction (`A`/`C`/`I`/`P`).
 */
export function deleteKittyPlacementsScoped<
  T extends {
    imageId: number;
    placementId: number;
    alt: boolean;
    bufferY: number;
    col: number;
    cols: number;
    rows: number;
  },
>(
  placements: readonly T[],
  curAlt: boolean,
  cmd: { deleteWhat?: string; id?: number; placementId?: number },
  cursorCol: number,
  cursorAbsY: number,
): { placements: T[]; evictAssetIds: number[]; clearedActiveAll: boolean } {
  const rawD = cmd.deleteWhat || "a";
  const d = rawD.toLowerCase();
  const clearedActiveAll = d === "a";

  if (d !== "a" && d !== "c" && d !== "i" && d !== "p") {
    return { placements: [...placements], evictAssetIds: [], clearedActiveAll: false };
  }

  const surviving: T[] = [];
  const candidateRemovedIds = new Set<number>();

  for (const p of placements) {
    let remove = false;
    if (d === "a") {
      remove = p.alt === curAlt;
    } else if (d === "c") {
      remove =
        p.alt === curAlt &&
        cursorAbsY >= p.bufferY &&
        cursorAbsY < p.bufferY + p.rows &&
        cursorCol >= p.col &&
        cursorCol < p.col + p.cols;
    } else if (d === "i") {
      remove =
        cmd.id !== undefined &&
        p.imageId === cmd.id &&
        (cmd.placementId === undefined || p.placementId === cmd.placementId);
    } else if (d === "p") {
      remove =
        cmd.id !== undefined &&
        cmd.placementId !== undefined &&
        p.imageId === cmd.id &&
        p.placementId === cmd.placementId;
    }

    if (remove) {
      candidateRemovedIds.add(p.imageId);
    } else {
      surviving.push(p);
    }
  }

  const shouldEvict =
    rawD === "A" ||
    rawD === "C" ||
    (rawD === "I" && cmd.placementId === undefined) ||
    rawD === "P";

  let evictAssetIds: number[] = [];
  if (shouldEvict && candidateRemovedIds.size > 0) {
    const remainingIds = new Set<number>();
    for (const p of surviving) {
      remainingIds.add(p.imageId);
    }
    evictAssetIds = Array.from(candidateRemovedIds).filter((id) => !remainingIds.has(id));
  }

  return { placements: surviving, evictAssetIds, clearedActiveAll };
}
