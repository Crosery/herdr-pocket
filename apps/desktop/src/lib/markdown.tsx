import { useState, type ReactNode } from "react";
import { AlertCircle, Check, Copy, FileText, Info, Sparkles } from "lucide-react";
import { parseTerminalChoices, type TerminalChoiceOption } from "@herdr-pocket/protocol";
import { copyToClipboard, openExternalUrl } from "./bridge";
import { hasFileJumpModifier, looksLikeClickableFilePath } from "./openFileTarget";
import { HighlightedCodeBlock } from "./syntaxHighlight";

export { hasFileJumpModifier };

export type ChoiceOption = TerminalChoiceOption;

export function parseChoices(lines: string[], lookback = 36): ChoiceOption[] {
  return parseTerminalChoices(lines, lookback);
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
      <HighlightedCodeBlock code={code} language={lang} className="md-pre mono" />
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
          <code
            key={idx++}
            role="link"
            tabIndex={0}
            className="md-code md-file-chip"
            title={`按住 Ctrl 点击打开 ${inner}`}
            onClick={(e) => {
              if (!hasFileJumpModifier(e)) return;
              e.preventDefault();
              e.stopPropagation();
              onOpenFile(inner);
            }}
            onContextMenu={(e) => {
              if (!e.ctrlKey) return;
              e.preventDefault();
              e.stopPropagation();
              onOpenFile(inner);
            }}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && hasFileJumpModifier(e)) {
                e.preventDefault();
                onOpenFile(inner);
              }
            }}
          >
            <FileText size={11} />
            <span>{inner}</span>
          </code>,
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
          <a
            key={idx++}
            href={target}
            className="md-file-link"
            title={`按住 Ctrl 点击打开 ${target}`}
            onClick={(e) => {
              e.preventDefault();
              if (!hasFileJumpModifier(e)) return;
              e.stopPropagation();
              onOpenFile(target);
            }}
            onContextMenu={(e) => {
              if (!e.ctrlKey) return;
              e.preventDefault();
              e.stopPropagation();
              onOpenFile(target);
            }}
          >
            {label}
          </a>,
        );
      } else {
        out.push(
          <a
            key={idx++}
            href={target}
            title={onOpenFile ? `按住 Ctrl 点击打开 ${target}` : undefined}
            onClick={(e) => {
              e.preventDefault();
              if (!hasFileJumpModifier(e)) return;
              e.stopPropagation();
              if (onOpenFile) onOpenFile(target);
            }}
            onContextMenu={(e) => {
              if (!e.ctrlKey || !onOpenFile) return;
              e.preventDefault();
              e.stopPropagation();
              onOpenFile(target);
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
      const alertMatch = quoteLines.length > 0 ? /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(quoteLines[0]!) : null;
      if (alertMatch) {
        const kind = alertMatch[1]!.toLowerCase() as "note" | "tip" | "important" | "warning" | "caution";
        const meta = {
          note: { label: "说明", Icon: Info },
          tip: { label: "提示", Icon: Sparkles },
          important: { label: "重要", Icon: AlertCircle },
          warning: { label: "注意", Icon: AlertCircle },
          caution: { label: "警告", Icon: AlertCircle },
        }[kind];
        const bodyLines = [...(alertMatch[2]?.trim() ? [alertMatch[2].trim()] : []), ...quoteLines.slice(1)];
        const AlertIcon = meta.Icon;
        blocks.push(
          <div key={k++} className={`md-alert md-alert-${kind}`} role="note">
            <div className="md-alert-head">
              <AlertIcon size={13} />
              <span>{meta.label}</span>
            </div>
            {bodyLines.length > 0 ? (
              <div className="md-alert-body">
                {bodyLines.map((ql, qi) => (
                  <div key={qi}>{ql.trim() ? renderInline(ql, onOpenFile) : <div style={{ height: 4 }} />}</div>
                ))}
              </div>
            ) : null}
          </div>,
        );
      } else {
        blocks.push(
          <blockquote key={k++} className="md-quote">
            {quoteLines.map((ql, qi) => (
              <div key={qi}>{ql.trim() ? renderInline(ql, onOpenFile) : <div style={{ height: 4 }} />}</div>
            ))}
          </blockquote>,
        );
      }
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
