import type { ReactNode } from "react";
import { openExternalUrl } from "./bridge";

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

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>"')\]]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const full = m[0];
    if (full.startsWith("`")) {
      out.push(
        <code key={idx++} className="md-code">
          {full.slice(1, -1)}
        </code>,
      );
    } else if (full.startsWith("**")) {
      out.push(<strong key={idx++}>{full.slice(2, -2)}</strong>);
    } else if (m[2] && m[3]) {
      const url = m[3];
      out.push(
        <a
          key={idx++}
          href={url}
          onClick={(e) => {
            e.preventDefault();
            void openExternalUrl(url);
          }}
        >
          {m[2]}
        </a>,
      );
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

export function RichMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let codeFence: string[] | null = null;
  let k = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      if (codeFence) {
        blocks.push(
          <pre key={k++} className="md-pre mono">
            {codeFence.join("\n")}
          </pre>,
        );
        codeFence = null;
      } else {
        codeFence = [];
      }
      continue;
    }
    if (codeFence) {
      codeFence.push(line);
      continue;
    }
    if (!line.trim()) {
      blocks.push(<div key={k++} style={{ height: 6 }} />);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(
        <div key={k++} style={{ fontWeight: 800, fontSize: h[1]!.length === 1 ? 16 : 14.5, marginTop: 4 }}>
          {renderInline(h[2]!)}
        </div>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      blocks.push(
        <div key={k++} className="md-li">
          <span className="md-dot" />
          <span>{renderInline(line.replace(/^\s*[-*]\s+/, ""))}</span>
        </div>,
      );
      continue;
    }
    const ol = /^\s*(\d+\.)\s+(.*)$/.exec(line);
    if (ol) {
      blocks.push(
        <div key={k++} className="md-li">
          <span className="md-num num">{ol[1]}</span>
          <span>{renderInline(ol[2]!)}</span>
        </div>,
      );
      continue;
    }
    blocks.push(
      <div key={k++} className="md-p">
        {renderInline(line)}
      </div>,
    );
  }
  if (codeFence) {
    blocks.push(
      <pre key={k++} className="md-pre mono">
        {codeFence.join("\n")}
      </pre>,
    );
  }
  return <div className="md-root">{blocks}</div>;
}
