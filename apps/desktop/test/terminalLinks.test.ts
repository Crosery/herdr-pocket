import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findLinkAtCell,
  findTerminalLinksForBufferLine,
  findWordSelectionAtCell,
  readLogicalLineText,
  resolveBareTerminalFileLink,
  type TerminalBufferCellLike,
  type TerminalBufferLike,
  type TerminalBufferLineLike,
} from "../src/lib/terminalLinks";

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff00 && cp <= 0xffef)
  );
}

function makeMockBuffer(rowsSpec: Array<{ text: string; isWrapped?: boolean }>, cols = 80): TerminalBufferLike {
  const lines: TerminalBufferLineLike[] = rowsSpec.map((spec) => {
    const cells: Array<{ chars: string; width: number }> = [];
    for (const ch of spec.text) {
      const cp = ch.codePointAt(0) ?? 0;
      if (isWideCodePoint(cp)) {
        cells.push({ chars: ch, width: 2 });
        cells.push({ chars: "", width: 0 });
      } else {
        cells.push({ chars: ch, width: 1 });
      }
    }
    while (cells.length < cols) cells.push({ chars: "", width: 1 });
    return {
      isWrapped: Boolean(spec.isWrapped),
      length: cells.length,
      getCell(x: number): TerminalBufferCellLike | undefined {
        const entry = cells[x];
        if (!entry) return undefined;
        return {
          getChars: () => entry.chars,
          getWidth: () => entry.width,
        };
      },
    };
  });

  return {
    length: lines.length,
    getNullCell: () => ({ getChars: () => "", getWidth: () => 1 }),
    getLine: (y: number) => lines[y],
  };
}

test("findTerminalLinksForBufferLine extracts URLs surrounded by CJK text and Chinese punctuation with exact cell ranges", () => {
  const buf = makeMockBuffer([
    { text: "视觉方向决策页已在浏览器打开：http://127.0.0.1:55323/。" },
    { text: "（http://127.0.0.1:8080/path_(1)），其余" },
  ]);

  const row1Links = findTerminalLinksForBufferLine(buf, 1);
  assert.equal(row1Links.length, 1);
  assert.equal(row1Links[0]!.kind, "url");
  assert.equal(row1Links[0]!.text, "http://127.0.0.1:55323/");
  // 15 wide CJK chars = 30 columns -> URL starts at 1-based col 31, length 23 -> end col 53.
  assert.deepEqual(row1Links[0]!.range, {
    start: { x: 31, y: 1 },
    end: { x: 53, y: 1 },
  });

  const row2Links = findTerminalLinksForBufferLine(buf, 2);
  assert.equal(row2Links.length, 1);
  assert.equal(row2Links[0]!.text, "http://127.0.0.1:8080/path_(1)");
  assert.deepEqual(row2Links[0]!.range, {
    start: { x: 3, y: 2 },
    end: { x: 32, y: 2 },
  });

  assert.equal(findLinkAtCell(buf, 0, 35)?.text, "http://127.0.0.1:55323/");
  assert.equal(findLinkAtCell(buf, 0, 53), null);
});

test("findTerminalLinksForBufferLine detects wrapped URLs and file paths across soft-wrapped rows", () => {
  const buf = makeMockBuffer([
    { text: "See " }, // 4 cols: 'See '
    { text: "Edited 1 file (gen_decision_comps.py) and /tmp/demo/" },
    { text: "script.py:42 for details", isWrapped: true },
  ]);

  const linksRow2 = findTerminalLinksForBufferLine(buf, 2);
  assert.deepEqual(
    linksRow2.map((l) => [l.kind, l.text]),
    [
      ["file", "gen_decision_comps.py"],
      ["file", "/tmp/demo/script.py:42"],
    ],
  );
  assert.deepEqual(linksRow2[1]!.range, {
    start: { x: 43, y: 2 },
    end: { x: 12, y: 3 },
  });
  assert.equal(findLinkAtCell(buf, 2, 4)?.text, "/tmp/demo/script.py:42");
  assert.equal(
    readLogicalLineText(buf, 1),
    "Edited 1 file (gen_decision_comps.py) and /tmp/demo/script.py:42 for details",
  );
});

test("findWordSelectionAtCell selects URLs, filenames, and plain words cleanly", () => {
  const buf = makeMockBuffer([{ text: "Ran python3 gen_decision_comps.py ok" }]);
  assert.deepEqual(findWordSelectionAtCell(buf, 0, 16, 80), {
    col: 12,
    row: 0,
    length: 21,
  });
  assert.deepEqual(findWordSelectionAtCell(buf, 0, 6, 80), {
    col: 4,
    row: 0,
    length: 7,
  });
});

test("resolveBareTerminalFileLink resolves bare filenames from scrollback subdirectories while preserving line anchors", () => {
  const buf = makeMockBuffer([
    { text: "• Read legacy/external-delivery-sequence.html" },
    { text: "Updated docs/external-delivery-sequence.html and checked output." },
    { text: "• Explored 1 file (external-delivery-sequence.html)" },
  ]);

  // Nearest match above row 2 wins over older match on row 0.
  assert.equal(
    resolveBareTerminalFileLink(buf, "external-delivery-sequence.html", 2),
    "docs/external-delivery-sequence.html",
  );
  // Preserves line/column anchors.
  assert.equal(
    resolveBareTerminalFileLink(buf, "external-delivery-sequence.html#L12-L20", 2),
    "docs/external-delivery-sequence.html#L12-L20",
  );
  assert.equal(
    resolveBareTerminalFileLink(buf, "external-delivery-sequence.html:42", 2),
    "docs/external-delivery-sequence.html:42",
  );
  // Non-bare paths stay untouched.
  assert.equal(resolveBareTerminalFileLink(buf, "src/App.tsx", 2), "src/App.tsx");
  assert.equal(resolveBareTerminalFileLink(buf, "/tmp/out.html", 2), "/tmp/out.html");
});
