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
 * Deletes Kitty placements scoped by screen buffer (`alt` vs normal) or by image/placement/geometry
 * selectors (`a/A`, `c/C`, `i/I`, `p/P`, `n/N`, `z/Z`, `x/X`, `y/Y`, `q/Q`, `r/R`), returning
 * surviving placements and any image IDs whose final placement was evicted by uppercase mode.
 */
export function deleteKittyPlacementsScoped<
  T extends {
    imageId: number;
    placementId: number;
    imageNumber?: number;
    zIndex?: number;
    alt: boolean;
    bufferY: number;
    col: number;
    cols: number;
    rows: number;
  },
>(
  placements: readonly T[],
  curAlt: boolean,
  cmd: {
    deleteWhat?: string;
    id?: number;
    placementId?: number;
    imageNumber?: number;
    zIndex?: number;
    cropX?: number;
    cropY?: number;
  },
  cursorCol: number,
  cursorAbsY: number,
  viewBaseY = 0,
): { placements: T[]; removed: T[]; evictAssetIds: number[]; clearedActiveAll: boolean } {
  const rawD = cmd.deleteWhat || "a";
  const d = rawD.toLowerCase();
  const clearedActiveAll = d === "a";

  if (!["a", "c", "i", "p", "n", "z", "x", "y", "q", "r"].includes(d)) {
    return { placements: [...placements], removed: [], evictAssetIds: [], clearedActiveAll: false };
  }

  const surviving: T[] = [];
  const removed: T[] = [];
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
    } else if (d === "n") {
      remove =
        cmd.imageNumber !== undefined &&
        p.imageNumber === cmd.imageNumber &&
        (cmd.placementId === undefined || p.placementId === cmd.placementId);
    } else if (d === "z") {
      remove = p.alt === curAlt && (p.zIndex ?? 0) === (cmd.zIndex ?? 0);
    } else if (d === "x") {
      const targetCol = Math.max(0, (cmd.cropX ?? 1) - 1);
      remove = p.alt === curAlt && targetCol >= p.col && targetCol < p.col + p.cols;
    } else if (d === "y") {
      const targetY = viewBaseY + Math.max(0, (cmd.cropY ?? 1) - 1);
      remove = p.alt === curAlt && targetY >= p.bufferY && targetY < p.bufferY + p.rows;
    } else if (d === "q") {
      const targetCol = Math.max(0, (cmd.cropX ?? 1) - 1);
      const targetY = viewBaseY + Math.max(0, (cmd.cropY ?? 1) - 1);
      remove =
        p.alt === curAlt &&
        targetCol >= p.col &&
        targetCol < p.col + p.cols &&
        targetY >= p.bufferY &&
        targetY < p.bufferY + p.rows;
    } else if (d === "r") {
      const minId = cmd.cropX ?? 0;
      const maxId = cmd.cropY ?? minId;
      remove = p.imageId >= minId && p.imageId <= maxId;
    }

    if (remove) {
      candidateRemovedIds.add(p.imageId);
      removed.push(p);
    } else {
      surviving.push(p);
    }
  }

  const shouldEvict =
    rawD === "A" ||
    rawD === "C" ||
    (rawD === "I" && cmd.placementId === undefined) ||
    rawD === "P" ||
    rawD === "N" ||
    rawD === "Z" ||
    rawD === "X" ||
    rawD === "Y" ||
    rawD === "Q" ||
    rawD === "R";

  let evictAssetIds: number[] = [];
  if (shouldEvict && candidateRemovedIds.size > 0) {
    const remainingIds = new Set<number>();
    for (const p of surviving) {
      remainingIds.add(p.imageId);
    }
    evictAssetIds = Array.from(candidateRemovedIds).filter((id) => !remainingIds.has(id));
  }

  return { placements: surviving, removed, evictAssetIds, clearedActiveAll };
}

/** Filters screen-buffer placements/runs against CSI J (`ED`: 0 below, 1 above, 2 viewport, 3 scrollback). */
export function erasePlacementsInDisplay<
  T extends {
    alt: boolean;
    bufferY: number;
    col: number;
    cols: number;
    rows: number;
  },
>(
  items: readonly T[],
  ps: number,
  baseY: number,
  termRows: number,
  cursorAbsY: number,
  cursorCol: number,
  _termCols: number,
  curAlt: boolean,
): { kept: T[]; removed: T[] } {
  const kept: T[] = [];
  const removed: T[] = [];
  const viewEnd = baseY + termRows;

  for (const p of items) {
    let hit = false;
    const pTop = p.bufferY;
    const pBot = p.bufferY + Math.max(1, p.rows);
    const pRight = p.col + Math.max(1, p.cols);

    if (ps === 3) {
      if (!curAlt && !p.alt && pTop < baseY) hit = true;
    } else if (p.alt === curAlt) {
      if (ps === 2) {
        hit = pBot > baseY && pTop < viewEnd;
      } else if (ps === 1) {
        hit = pBot > baseY && (pTop < cursorAbsY || (pTop <= cursorAbsY && p.col <= cursorCol));
      } else {
        // Ps = 0 (default): from cursor to end of viewport. Side-by-side / above images remain untouched.
        const overlapsBelowRows = pBot - 1 > cursorAbsY && pTop < viewEnd;
        const overlapsCursorTail = pTop <= cursorAbsY && pBot > cursorAbsY && pRight > cursorCol;
        hit = overlapsBelowRows || overlapsCursorTail;
      }
    }

    if (hit) removed.push(p);
    else kept.push(p);
  }
  return { kept, removed };
}

/** Filters screen-buffer placements/runs against CSI K (`EL`: 0 right, 1 left, 2 whole line) or CSI X (`ECH`). */
export function erasePlacementsInLine<
  T extends {
    alt: boolean;
    bufferY: number;
    col: number;
    cols: number;
    rows: number;
  },
>(
  items: readonly T[],
  ps: number,
  absY: number,
  cursorCol: number,
  eraseCount: number | null,
  curAlt: boolean,
): { kept: T[]; removed: T[] } {
  const kept: T[] = [];
  const removed: T[] = [];
  let startCol = 0;
  let endCol = Number.MAX_SAFE_INTEGER;
  if (eraseCount !== null) {
    startCol = cursorCol;
    endCol = cursorCol + Math.max(1, eraseCount);
  } else if (ps === 0) {
    startCol = cursorCol;
  } else if (ps === 1) {
    startCol = 0;
    endCol = cursorCol + 1;
  }

  for (const p of items) {
    const rowHit = absY >= p.bufferY && absY < p.bufferY + Math.max(1, p.rows);
    const colHit = p.col < endCol && p.col + Math.max(1, p.cols) > startCol;
    if (p.alt === curAlt && rowHit && colHit) removed.push(p);
    else kept.push(p);
  }
  return { kept, removed };
}
