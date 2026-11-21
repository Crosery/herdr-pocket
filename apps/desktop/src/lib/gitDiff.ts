export interface UnifiedDiffLine {
  kind: "hunk" | "ctx" | "add" | "del" | "meta";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface SplitDiffRow {
  kind: "hunk" | "pair";
  header?: string;
  left: { no: number | null; kind: "ctx" | "del" | "empty"; text: string };
  right: { no: number | null; kind: "ctx" | "add" | "empty"; text: string };
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parseUnifiedPatch(patch: string): UnifiedDiffLine[] {
  if (!patch) return [];
  const raw = patch.replace(/\r\n/g, "\n").split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();

  const out: UnifiedDiffLine[] = [];
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;

  for (const line of raw) {
    const hm = HUNK_RE.exec(line);
    if (hm) {
      inHunk = true;
      oldLine = Number(hm[1]);
      newLine = Number(hm[2]);
      out.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
      continue;
    }
    if (!inHunk) {
      if (
        line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("new file ") ||
        line.startsWith("deleted file ") ||
        line.startsWith("rename ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
      ) {
        continue;
      }
      out.push({ kind: "meta", oldNo: null, newNo: null, text: line });
      continue;
    }
    if (line.startsWith("+")) {
      out.push({ kind: "add", oldNo: null, newNo: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith("-")) {
      out.push({ kind: "del", oldNo: oldLine, newNo: null, text: line.slice(1) });
      oldLine += 1;
    } else if (line.startsWith("\\ No newline")) {
      out.push({ kind: "meta", oldNo: null, newNo: null, text: line });
    } else {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      out.push({ kind: "ctx", oldNo: oldLine, newNo: newLine, text: content });
      oldLine += 1;
      newLine += 1;
    }
  }
  return out;
}

export function buildSplitDiffRows(patch: string): SplitDiffRow[] {
  const lines = parseUnifiedPatch(patch);
  const rows: SplitDiffRow[] = [];
  let i = 0;

  while (i < lines.length) {
    const cur = lines[i]!;
    if (cur.kind === "hunk") {
      rows.push({
        kind: "hunk",
        header: cur.text,
        left: { no: null, kind: "empty", text: "" },
        right: { no: null, kind: "empty", text: "" },
      });
      i += 1;
      continue;
    }
    if (cur.kind === "ctx") {
      rows.push({
        kind: "pair",
        left: { no: cur.oldNo, kind: "ctx", text: cur.text },
        right: { no: cur.newNo, kind: "ctx", text: cur.text },
      });
      i += 1;
      continue;
    }
    if (cur.kind === "meta") {
      i += 1;
      continue;
    }
    const dels: UnifiedDiffLine[] = [];
    const adds: UnifiedDiffLine[] = [];
    while (i < lines.length && (lines[i]!.kind === "del" || lines[i]!.kind === "add")) {
      if (lines[i]!.kind === "del") dels.push(lines[i]!);
      else adds.push(lines[i]!);
      i += 1;
    }
    const maxLen = Math.max(dels.length, adds.length);
    for (let j = 0; j < maxLen; j += 1) {
      const d = dels[j];
      const a = adds[j];
      rows.push({
        kind: "pair",
        left: d ? { no: d.oldNo, kind: "del", text: d.text } : { no: null, kind: "empty", text: "" },
        right: a ? { no: a.newNo, kind: "add", text: a.text } : { no: null, kind: "empty", text: "" },
      });
    }
  }
  return rows;
}
