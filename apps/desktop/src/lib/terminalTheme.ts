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

const LIGHT_SPEC: TerminalThemeSpec = {
  mode: "light",
  bg: "#ffffff",
  fg: "#1f2328",
  cursor: "#24292f",
  minimumContrastRatio: 4.5,
  theme: {
    background: "#ffffff",
    foreground: "#1f2328",
    cursor: "#24292f",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(255, 126, 168, 0.22)",
    black: "#24292f",
    red: "#d20f39",
    green: "#1a7f37",
    yellow: "#b56800",
    blue: "#1e66f5",
    magenta: "#b8336a",
    cyan: "#0f7b8a",
    white: "#dce0e8",
    brightBlack: "#6c6f85",
    brightRed: "#e64553",
    brightGreen: "#2da44e",
    brightYellow: "#df8e1d",
    brightBlue: "#3b82f6",
    brightMagenta: "#d6409f",
    brightCyan: "#179299",
    brightWhite: "#eff1f5",
  },
};

const DARK_SPEC: TerminalThemeSpec = {
  mode: "dark",
  bg: "#16141d",
  fg: "#f4eef8",
  cursor: "#ff71a8",
  minimumContrastRatio: 1,
  theme: {
    background: "#16141d",
    foreground: "#f4eef8",
    cursor: "#ff71a8",
    cursorAccent: "#16141d",
    selectionBackground: "rgba(255, 113, 168, 0.28)",
    black: "#252131",
    red: "#ff6b8b",
    green: "#6be0a6",
    yellow: "#f6c96b",
    blue: "#7ab8ff",
    magenta: "#eb8eff",
    cyan: "#6fdce8",
    white: "#ece5f5",
    brightBlack: "#7b7391",
    brightRed: "#ff8ba3",
    brightGreen: "#8eedbc",
    brightYellow: "#ffe08f",
    brightBlue: "#9ecbff",
    brightMagenta: "#f3b0ff",
    brightCyan: "#96eaf4",
    brightWhite: "#ffffff",
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
