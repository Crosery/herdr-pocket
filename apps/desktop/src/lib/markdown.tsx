import { useState, type ReactNode } from "react";
import { Check, Copy, FileText } from "lucide-react";
import { copyToClipboard, openExternalUrl } from "./bridge";
import { looksLikeClickableFilePath } from "./openFileTarget";

export interface ChoiceOption {
  key: string;
  label: string;
  selected: boolean;
}

const OPTION_RE = /^\s*([❯›>▶➜→●]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;

export function parseChoices(lines: string[], lookback = 20): ChoiceOption[] {
  const tail = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+$/, "")).filter((l) => l.trim()).slice(-lookback);
  let best: ChoiceOption[] = [];
  let run: ChoiceOption[] = [];
  for (const line of tail) {
    const m = OPTION_RE.exec(line.replace(/[│┃║]/g, " "));
    if (!m) continue;
    const n = Number(m[2]);
    if (n === 1) run = [];
    if (n !== run.length + 1) continue;
    const label = m[3]!
      .replace(/\s+\((?:esc|y|n|a|p|shift\+tab|tab)\)$/i, "")
      .replace(/^\[[ x✓✔]\]\s*/i, "")
      .trim();
    run.push({ key: String(n), label, selected: Boolean(m[1]) });
    if (run.length >= 2) best = [...run];
  }
  return best.length >= 2 && best.length <= 9 && best.some((c) => c.selected) ? best : [];
}

function CodeFence({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-pre-wrap">
      <div className="md-pre-head">
        <span className="md-pre-lang mono">{lang || "text"}</span>
        <button
          type="button"
          className="md-pre-copy"
          aria-label="复制代码"
          title="复制代码"
          onClick={() => {
            void copyToClipboard(code).then((ok) => {
              if (!ok) return;
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre className="md-pre mono">{code}</pre>
    </div>
  );
}

function renderInline(text: string, onOpenFile?: (target: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|\[([^\]]+)\]\(([^)\s]+)\)|https?:\/\/[^\s<>"')\]]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const full = m[0];
    if (full.startsWith("`")) {
      const inner = full.slice(1, -1);
      if (onOpenFile && looksLikeClickableFilePath(inner)) {
        out.push(
          <button
            key={idx++}
            type="button"
            className="md-code md-file-chip"
            title={`在标签页打开 ${inner}`}
            onClick={() => onOpenFile(inner)}
          >
            <FileText size={11} />
            <span>{inner}</span>
          </button>,
        );
      } else {
        out.push(
          <code key={idx++} className="md-code">
            {inner}
          </code>,
        );
      }
    } else if (full.startsWith("**")) {
      out.push(<strong key={idx++}>{full.slice(2, -2)}</strong>);
    } else if (m[2] && m[3]) {
      const label = m[2];
      const target = m[3];
      if (/^https?:\/\//i.test(target)) {
        out.push(
          <a
            key={idx++}
            href={target}
            onClick={(e) => {
              e.preventDefault();
              void openExternalUrl(target);
            }}
          >
            {label}
          </a>,
        );
      } else if (onOpenFile && looksLikeClickableFilePath(target)) {
        out.push(
          <button
            key={idx++}
            type="button"
            className="md-file-link"
            title={`在标签页打开 ${target}`}
            onClick={() => onOpenFile(target)}
          >
            {label}
          </button>,
        );
      } else {
        out.push(
          <a
            key={idx++}
            href={target}
            onClick={(e) => {
              e.preventDefault();
              if (onOpenFile) onOpenFile(target);
            }}
          >
            {label}
          </a>,
        );
      }
    } else if (full.startsWith("http")) {
      out.push(
        <a
          key={idx++}
          href={full}
          onClick={(e) => {
            e.preventDefault();
            void openExternalUrl(full);
          }}
        >
          {full}
        </a>,
      );
    }
    last = m.index + full.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = splitTableRow(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

export function RichMarkdown({
  text,
  onOpenFile,
}: {
  text: string;
  onOpenFile?: (target: string) => void;
}) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let codeFence: { lang: string; lines: string[] } | null = null;
  let k = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceOpen = /^\s*```([\w.+-]*)\s*$/.exec(line);
    if (fenceOpen) {
      if (codeFence) {
        blocks.push(<CodeFence key={k++} lang={codeFence.lang} code={codeFence.lines.join("\n")} />);
        codeFence = null;
      } else {
        codeFence = { lang: fenceOpen[1] ?? "", lines: [] };
      }
      continue;
    }
    if (/^\s*```/.test(line) && codeFence) {
      blocks.push(<CodeFence key={k++} lang={codeFence.lang} code={codeFence.lines.join("\n")} />);
      codeFence = null;
      continue;
    }
    if (codeFence) {
      codeFence.lines.push(line);
      continue;
    }
    if (!line.trim()) {
      blocks.push(<div key={k++} style={{ height: 6 }} />);
      continue;
    }
    if (/^\s*(?:---+|===+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(<hr key={k++} className="md-hr" />);
      continue;
    }
    // GFM pipe table: header row + | --- | separator row + body rows
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const headers = splitTableRow(line);
      const alignments = splitTableRow(lines[i + 1]!).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left",
      );
      const bodyRows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j]!.includes("|") && lines[j]!.trim() !== "") {
        bodyRows.push(splitTableRow(lines[j]!));
        j++;
      }
      blocks.push(
        <div key={k++} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {headers.map((h, ci) => (
                  <th key={ci} style={{ textAlign: alignments[ci] ?? "left" }}>
                    {renderInline(h, onOpenFile)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri}>
                  {headers.map((_, ci) => (
                    <td key={ci} style={{ textAlign: alignments[ci] ?? "left" }}>
                      {renderInline(row[ci] ?? "", onOpenFile)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = j - 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      let j = i;
      while (j < lines.length && /^\s*>\s?/.test(lines[j]!)) {
        quoteLines.push(lines[j]!.replace(/^\s*>\s?/, ""));
        j++;
      }
      blocks.push(
        <blockquote key={k++} className="md-quote">
          {quoteLines.map((ql, qi) => (
            <div key={qi}>{ql.trim() ? renderInline(ql, onOpenFile) : <div style={{ height: 4 }} />}</div>
          ))}
        </blockquote>,
      );
      i = j - 1;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const fontSize = level === 1 ? 16 : level === 2 ? 14.5 : 13.5;
      blocks.push(
        <div key={k++} style={{ fontWeight: 800, fontSize, marginTop: 4 }}>
          {renderInline(h[2]!, onOpenFile)}
        </div>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      blocks.push(
        <div key={k++} className="md-li">
          <span className="md-dot" />
          <span>{renderInline(line.replace(/^\s*[-*]\s+/, ""), onOpenFile)}</span>
        </div>,
      );
      continue;
    }
    const ol = /^\s*(\d+\.)\s+(.*)$/.exec(line);
    if (ol) {
      blocks.push(
        <div key={k++} className="md-li">
          <span className="md-num num">{ol[1]}</span>
          <span>{renderInline(ol[2]!, onOpenFile)}</span>
        </div>,
      );
      continue;
    }
    blocks.push(
      <div key={k++} className="md-p">
        {renderInline(line, onOpenFile)}
      </div>,
    );
  }
  if (codeFence) {
    blocks.push(<CodeFence key={k++} lang={codeFence.lang} code={codeFence.lines.join("\n")} />);
  }
  return <div className="md-root">{blocks}</div>;
}
