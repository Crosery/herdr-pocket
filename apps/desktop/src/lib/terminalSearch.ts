import type { TerminalBufferCellLike, TerminalBufferLike } from "./terminalLinks";

export interface TerminalSearchMatch {
  row0: number;
  col0: number;
  length: number;
}

const MAX_WRAPPED_SPAN = 12;

function readPhysicalLineCells(
  buf: TerminalBufferLike,
  row: number,
  reusable: TerminalBufferCellLike,
): { text: string; coords: Array<{ row: number; col: number; width: number }> } | null {
  const line = buf.getLine(row);
  if (!line) return null;
  let lastNonEmpty = -1;
  for (let x = line.length - 1; x >= 0; x--) {
    const c = line.getCell(x, reusable);
    if (c && c.getWidth() > 0 && c.getChars().length > 0) {
      lastNonEmpty = x;
      break;
    }
  }
  const maxCol = Math.min(line.length - 1, lastNonEmpty);
  let text = "";
  const coords: Array<{ row: number; col: number; width: number }> = [];
  for (let x = 0; x <= maxCol; x++) {
    const c = line.getCell(x, reusable);
    if (!c) continue;
    const w = c.getWidth();
    if (w === 0) continue;
    const chars = c.getChars() || " ";
    const cellWidth = Math.max(1, w);
    for (let k = 0; k < chars.length; k++) {
      text += chars[k]!;
      coords.push({ row, col: x, width: cellWidth });
    }
  }
  return { text, coords };
}

/**
 * Searches `buf` across soft-wrapped paragraphs for `query`, returning ordered matches
 * with exact cell coordinates `(row0, col0, length)` compatible with `xterm.select(...)`.
 */
export function searchTerminalBuffer(
  buf: TerminalBufferLike,
  query: string,
  cols = 80,
): TerminalSearchMatch[] {
  const clean = query;
  if (!clean) return [];
  const lowerQuery = clean.toLowerCase();
  const reusable = buf.getNullCell();
  const out: TerminalSearchMatch[] = [];

  let row = 0;
  while (row < buf.length) {
    let paraText = "";
    const coords: Array<{ row: number; col: number; width: number }> = [];
    const first = readPhysicalLineCells(buf, row, reusable);
    if (first) {
      paraText += first.text;
      coords.push(...first.coords);
    }
    let nextRow = row + 1;
    let span = 0;
    while (nextRow < buf.length && span < MAX_WRAPPED_SPAN) {
      const nextLine = buf.getLine(nextRow);
      if (!nextLine || !nextLine.isWrapped) break;
      const chunk = readPhysicalLineCells(buf, nextRow, reusable);
      if (chunk) {
        paraText += chunk.text;
        coords.push(...chunk.coords);
      }
      nextRow += 1;
      span += 1;
    }

    if (paraText) {
      const lowerPara = paraText.toLowerCase();
      let from = 0;
      while (from <= lowerPara.length - lowerQuery.length) {
        const hitIdx = lowerPara.indexOf(lowerQuery, from);
        if (hitIdx < 0) break;
        const endIdx = hitIdx + lowerQuery.length - 1;
        const startCell = coords[hitIdx];
        const endCell = coords[endIdx];
        if (startCell && endCell) {
          const cellSpan = (endCell.row - startCell.row) * Math.max(1, cols) + (endCell.col + endCell.width - startCell.col);
          out.push({
            row0: startCell.row,
            col0: startCell.col,
            length: Math.max(1, cellSpan),
          });
        }
        from = hitIdx + Math.max(1, lowerQuery.length);
      }
    }

    row = nextRow;
  }

  return out;
}
