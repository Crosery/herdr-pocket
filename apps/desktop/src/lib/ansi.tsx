import type { CSSProperties, ReactNode } from "react";

interface Span {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  underline?: boolean;
}

const ANSI_16 = [
  "#3b314b",
  "#d9536f",
  "#279b79",
  "#c97a16",
  "#5a78e6",
  "#b854b0",
  "#1c92a8",
  "#dfd8ea",
  "#7b6f90",
  "#ff6b8b",
  "#4cd2a6",
  "#f4b942",
  "#84a0ff",
  "#f080da",
  "#54d1e8",
  "#ffffff",
];

function color256(n: number): string {
  if (n < 16) return ANSI_16[n] ?? "#ffffff";
  if (n < 232) {
    const k = n - 16;
    const r = Math.floor(k / 36);
    const g = Math.floor((k % 36) / 6);
    const b = k % 6;
    const c = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${c(r)},${c(g)},${c(b)})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

export function parseAnsiLine(line: string): Span[] {
  const out: Span[] = [];
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  let dim = false;
  let underline = false;
  let i = 0;
  let textStart = 0;

  const flush = (end: number) => {
    if (end > textStart) {
      out.push({ text: line.slice(textStart, end), fg, bg, bold, dim, underline });
    }
  };

  while (i < line.length) {
    if (line.charCodeAt(i) === 27 && line[i + 1] === "[") {
      const mEnd = line.indexOf("m", i + 2);
      if (mEnd > 0 && mEnd - i <= 40) {
        flush(i);
        const params = line
          .slice(i + 2, mEnd)
          .split(";")
          .map((x) => (x === "" ? 0 : Number.parseInt(x, 10)));
        for (let k = 0; k < params.length; k++) {
          const code = params[k] ?? 0;
          if (code === 0) {
            fg = undefined;
            bg = undefined;
            bold = false;
            dim = false;
            underline = false;
          } else if (code === 1) bold = true;
          else if (code === 2) dim = true;
          else if (code === 4) underline = true;
          else if (code === 22) {
            bold = false;
            dim = false;
          } else if (code === 24) underline = false;
          else if (code >= 30 && code <= 37) fg = ANSI_16[code - 30];
          else if (code === 39) fg = undefined;
          else if (code >= 40 && code <= 47) bg = ANSI_16[code - 40];
          else if (code === 49) bg = undefined;
          else if (code >= 90 && code <= 97) fg = ANSI_16[code - 90 + 8];
          else if (code >= 100 && code <= 107) bg = ANSI_16[code - 100 + 8];
          else if ((code === 38 || code === 48) && k + 1 < params.length) {
            const isFg = code === 38;
            if (params[k + 1] === 5 && k + 2 < params.length) {
              const col = color256(params[k + 2] ?? 0);
              if (isFg) fg = col;
              else bg = col;
              k += 2;
            } else if (params[k + 1] === 2 && k + 4 < params.length) {
              const col = `rgb(${params[k + 2]},${params[k + 3]},${params[k + 4]})`;
              if (isFg) fg = col;
              else bg = col;
              k += 4;
            }
          }
        }
        i = mEnd + 1;
        textStart = i;
        continue;
      }
    }
    i++;
  }
  flush(line.length);
  return out;
}

export function renderAnsiLines(lines: readonly string[]): ReactNode {
  return lines.map((raw, idx) => {
    const clean = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
    const spans = parseAnsiLine(clean);
    return (
      <div key={idx} className="term-line">
        {spans.length === 0
          ? "\u00a0"
          : spans.map((sp, sIdx) => {
              const style: CSSProperties = {};
              if (sp.fg) style.color = sp.fg;
              if (sp.bg) style.backgroundColor = sp.bg;
              if (sp.bold) style.fontWeight = 700;
              if (sp.dim) style.opacity = 0.65;
              if (sp.underline) style.textDecoration = "underline";
              return (
                <span key={sIdx} style={style}>
                  {sp.text}
                </span>
              );
            })}
      </div>
    );
  });
}
