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

/**
 * Rejoins hard terminal line-wraps inside Markdown `[label](url\nmore)` links outside fenced
 * code blocks and strips leaked TUI footer hints so links like `file:///.../antigravity-\ncli/...`
 * always parse as a single clickable link.
 */
export function normalizeMarkdownText(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const out: string[] = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      i += 1;
      continue;
    }
    if (inFence) {
      out.push(line);
      i += 1;
      continue;
    }
    // Strip leaked Antigravity swarm footer line from chat bubbles.
    if (/^\s*Run\s+\/swarm\s+board\b.*(?:live\s+board|worker\s+status|swarm\s+board)\.?\s*$/i.test(line)) {
      i += 1;
      continue;
    }
    // Rejoin hard line-wraps inside `[label](target\ncontinued)` or bare `file:///...\n...`
    let merged = line;
    let joined = 0;
    while (joined < 4 && i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (/^\s*```/.test(next) || !next.trim()) break;
      const openLinkUrl = /\[[^\]\n]+\]\([^)\n]*$/.test(merged);
      const openLinkLabel = /\[[^\]\n]*$/.test(merged) && /^[^[\n]*\]\([^)\n]+/.test(next.trim());
      if (openLinkUrl) {
        merged = `${merged.replace(/[ \t]+$/, "")}${next.trimStart()}`;
        i += 1;
        joined += 1;
        continue;
      }
      if (openLinkLabel) {
        merged = `${merged.replace(/[ \t]+$/, "")} ${next.trimStart()}`;
        i += 1;
        joined += 1;
        continue;
      }
      break;
    }
    out.push(merged);
    i += 1;
  }
  return out.join("\n");
}

function renderFileChip(
  target: string,
  label: string,
  key: number,
  onOpenFile: (target: string) => void,
  asLink = false,
): ReactNode {
  const cleanTarget = target.trim();
  const handleOpen = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault();
    e.stopPropagation();
    onOpenFile(cleanTarget);
  };
  if (asLink) {
    return (
      <a
        key={key}
        href={cleanTarget}
        className="md-file-link"
        title={`点击打开 ${cleanTarget}`}
        onClick={handleOpen}
        onContextMenu={(e) => {
          if (!e.ctrlKey) return;
          handleOpen(e);
        }}
      >
        {label}
      </a>
    );
  }
  return (
    <code
      key={key}
      role="link"
      tabIndex={0}
      className="md-code md-file-chip"
      title={`点击打开 ${cleanTarget}`}
      onClick={handleOpen}
      onContextMenu={(e) => {
        if (!e.ctrlKey) return;
        handleOpen(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          handleOpen(e);
        }
      }}
    >
      <FileText size={11} />
      <span>{label}</span>
    </code>
  );
}

function renderInline(text: string, onOpenFile?: (target: string) => void, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const tokenRe =
    /(`[^`\n]+`|\*\*[^*\n]+(?:\*(?!\*)[^*\n]+)*\*\*|~~[^~\n]+~~|\[([^\]]+)\]\(([^)\s]+)\)|file:\/\/[^\s<>"'`)\]]+|https?:\/\/[^\s<>"'`)\]]+|(?:~\/|\/(?:Users|home|tmp|var|opt|etc)\/)[^\s<>"'`)\],;!?]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const full = m[0];
    if (full.startsWith("`")) {
      const inner = full.slice(1, -1);
      if (onOpenFile && looksLikeClickableFilePath(inner)) {
        out.push(renderFileChip(inner, inner, idx++, onOpenFile, false));
      } else {
        out.push(
          <code key={idx++} className="md-code">
            {inner}
          </code>,
        );
      }
    } else if (full.startsWith("**") && full.endsWith("**") && full.length > 4) {
      const inner = full.slice(2, -2);
      out.push(
        <strong key={idx++}>
          {depth < 3 ? renderInline(inner, onOpenFile, depth + 1) : inner}
        </strong>,
      );
    } else if (full.startsWith("~~") && full.endsWith("~~") && full.length > 4) {
      const inner = full.slice(2, -2);
      out.push(
        <del key={idx++}>
          {depth < 3 ? renderInline(inner, onOpenFile, depth + 1) : inner}
        </del>,
      );
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
      } else if (onOpenFile && (looksLikeClickableFilePath(target) || /^file:\/\//i.test(target))) {
        out.push(renderFileChip(target, label, idx++, onOpenFile, true));
      } else {
        out.push(
          <a
            key={idx++}
            href={target}
            title={onOpenFile ? `点击打开 ${target}` : undefined}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (onOpenFile) onOpenFile(target);
            }}
          >
            {label}
          </a>,
        );
      }
    } else if (/^file:\/\//i.test(full)) {
      if (onOpenFile) {
        const display = full.split("/").filter(Boolean).pop() || full;
        out.push(renderFileChip(full, decodeURIComponentSafe(display), idx++, onOpenFile, true));
      } else {
        out.push(full);
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
    } else if (onOpenFile && looksLikeClickableFilePath(full)) {
      out.push(renderFileChip(full, full, idx++, onOpenFile, false));
    } else {
      out.push(full);
    }
    last = m.index + full.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
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
  const lines = normalizeMarkdownText(text).split("\n");
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
    const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const fontSize = level === 1 ? 16 : level === 2 ? 14.5 : level === 3 ? 13.5 : 13;
      blocks.push(
        <div key={k++} style={{ fontWeight: 800, fontSize, marginTop: 4 }}>
          {renderInline(h[2]!, onOpenFile)}
        </div>,
      );
      continue;
    }
    const ul = /^(\s*)(?:[-*+•◦▪‣])\s+(.*)$/.exec(line);
    if (ul) {
      const indent = Math.min(3, Math.floor((ul[1]?.length ?? 0) / 2));
      blocks.push(
        <div key={k++} className="md-li" style={indent > 0 ? { paddingLeft: indent * 14 } : undefined}>
          <span className="md-dot" />
          <span>{renderInline(ul[2]!, onOpenFile)}</span>
        </div>,
      );
      continue;
    }
    const ol = /^(\s*)(\d+\.)\s+(.*)$/.exec(line);
    if (ol) {
      const indent = Math.min(3, Math.floor((ol[1]?.length ?? 0) / 2));
      blocks.push(
        <div key={k++} className="md-li" style={indent > 0 ? { paddingLeft: indent * 14 } : undefined}>
          <span className="md-num num">{ol[2]}</span>
          <span>{renderInline(ol[3]!, onOpenFile)}</span>
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
