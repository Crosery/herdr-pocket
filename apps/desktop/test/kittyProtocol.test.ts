import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  KITTY_PLACEHOLDER_DIACRITICS,
  KITTY_SENTINEL_PREFIX,
  KittyApcSplitter,
  KittyKeyboardState,
  KittyUnicodePlaceholderRewriter,
  collectVirtualSpriteBlocks,
  decodeKittySentinel,
  deleteKittyVirtualPlacements,
  encodeKittyKey,
  encodeKittySentinel,
  lookupKittyVirtualPlacement,
  parseKittyGfxCommand,
  parseOsc66,
  registerKittyVirtualPlacement,
  shouldCreateCursorPlacement,
  terminalTextColumns,
  type KittyBufferCellSample,
  type KittyVirtualPlacementDims,
} from "../src/lib/kittyProtocol";
import type { TermKeyInput } from "../src/lib/termKeys";

function key(
  keyName: string,
  mods: Partial<Pick<TermKeyInput, "shiftKey" | "ctrlKey" | "altKey" | "metaKey">> = {},
): TermKeyInput {
  return {
    key: keyName,
    shiftKey: Boolean(mods.shiftKey),
    ctrlKey: Boolean(mods.ctrlKey),
    altKey: Boolean(mods.altKey),
    metaKey: Boolean(mods.metaKey),
  };
}

test("legacy mode encodes modified Enter sequences per shell vs agent TUI without altering plain Enter or macOS Cmd+Enter", () => {
  // Coding agent TUIs (isShell = false) receive CSI u even before/without >1u so re-attached TUIs accept Shift+Enter newlines.
  assert.equal(encodeKittyKey(key("Enter", { shiftKey: true }), 0, 0, true), "\x1b[13;2u");
  assert.equal(encodeKittyKey(key("Enter", { shiftKey: true }), 0, 0, false), "\x1b[13;2u");
  assert.equal(encodeKittyKey(key("Enter", { ctrlKey: true }), 0, 0, true), "\x1b[13;5u");
  assert.equal(encodeKittyKey(key("Enter", { ctrlKey: true, shiftKey: true }), 0, 0, true), "\x1b[13;6u");
  assert.equal(encodeKittyKey(key("Enter", { altKey: true }), 0, 0, true), "\x1b\r");

  // Shells (isShell = true) receive ESC CR so readline/zsh inserts a literal newline instead of "~".
  assert.equal(encodeKittyKey(key("Enter", { shiftKey: true }), 0, 0, true, false, true), "\x1b\r");
  assert.equal(encodeKittyKey(key("Enter", { ctrlKey: true }), 0, 0, false, false, true), "\x1b\r");
  assert.equal(encodeKittyKey(key("Enter", { altKey: true }), 0, 0, true, false, true), "\x1b\r");

  assert.equal(encodeKittyKey(key("Enter"), 0, 0, true), null);
  assert.equal(encodeKittyKey(key("Enter", { metaKey: true }), 0, 0, true), null);
});

test("Kitty keyboard protocol flags (>1u and >9u) encode Shift+Enter and plain Enter accurately", () => {
  assert.equal(encodeKittyKey(key("Enter", { shiftKey: true }), 1, 0, true), "\x1b[13;2u");
  assert.equal(encodeKittyKey(key("Enter"), 1, 0, true), null);

  assert.equal(encodeKittyKey(key("Enter"), 9, 0, true), "\x1b[13;1u");
  assert.equal(encodeKittyKey(key("Enter", { shiftKey: true }), 9, 0, true), "\x1b[13;2u");
});

test("modifyOtherKeys emits CSI 27;mod;code~ sequences when Kitty flags are off", () => {
  assert.equal(encodeKittyKey(key("Enter", { shiftKey: true }), 0, 2, true), "\x1b[27;2;13~");
  assert.equal(encodeKittyKey(key("Tab", { shiftKey: true }), 0, 2, true), "\x1b[27;2;9~");
  assert.equal(encodeKittyKey(key("Enter"), 0, 2, true), null);
});

test("win32-input-mode (?9001h) encodes modified Enter when Kitty flags are zero", () => {
  assert.equal(
    encodeKittyKey(key("Enter", { shiftKey: true }), 0, 0, false, true),
    "\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_",
  );
  assert.equal(
    encodeKittyKey(key("Enter", { ctrlKey: true }), 0, 0, false, true),
    "\x1b[13;28;10;1;8;1_\x1b[13;28;10;0;8;1_",
  );
  assert.equal(encodeKittyKey(key("Enter"), 0, 0, false, true), null);
});

test("KittyKeyboardState.reset restores win32InputMode and modifyOtherKeys", () => {
  const state = new KittyKeyboardState();
  state.push(false, 9);
  state.modifyOtherKeys = 2;
  state.win32InputMode = true;
  state.reset();
  assert.equal(state.current(false), 0);
  assert.equal(state.modifyOtherKeys, 0);
  assert.equal(state.win32InputMode, false);
});

test("Kitty diacritics table has 297 strictly increasing entries and lossless sentinel round-trip", () => {
  assert.equal(KITTY_PLACEHOLDER_DIACRITICS.length, 297);
  assert.equal(KITTY_PLACEHOLDER_DIACRITICS[0], 0x0305);
  assert.equal(KITTY_PLACEHOLDER_DIACRITICS[1], 0x030d);
  assert.equal(KITTY_PLACEHOLDER_DIACRITICS[296], 0x1d244);
  for (let i = 1; i < KITTY_PLACEHOLDER_DIACRITICS.length; i++) {
    assert.ok(KITTY_PLACEHOLDER_DIACRITICS[i]! > KITTY_PLACEHOLDER_DIACRITICS[i - 1]!);
  }

  for (let idx = 0; idx < KITTY_PLACEHOLDER_DIACRITICS.length; idx++) {
    const sentinel = encodeKittySentinel({ row: idx, col: 296 - idx, idMsb: idx % 256 });
    assert.ok(sentinel.startsWith(KITTY_SENTINEL_PREFIX));
    assert.deepEqual(decodeKittySentinel(sentinel), { row: idx, col: 296 - idx, idMsb: idx % 256 });
  }

  assert.deepEqual(decodeKittySentinel(encodeKittySentinel({})), { row: undefined, col: undefined, idMsb: undefined });
  assert.deepEqual(decodeKittySentinel(encodeKittySentinel({ row: 14 })), { row: 14, col: undefined, idMsb: undefined });
  assert.deepEqual(decodeKittySentinel(encodeKittySentinel({ row: 2, col: 6 })), { row: 2, col: 6, idMsb: undefined });
  assert.equal(decodeKittySentinel("A"), null);
  assert.equal(decodeKittySentinel(`${KITTY_SENTINEL_PREFIX}bad`), null);
});

test("KittyUnicodePlaceholderRewriter handles split UTF-16 chunks and astral diacritic surrogate pairs", () => {
  const placeholder = String.fromCodePoint(0x10eeee);
  const d0 = String.fromCodePoint(KITTY_PLACEHOLDER_DIACRITICS[0]!);
  const d286 = String.fromCodePoint(KITTY_PLACEHOLDER_DIACRITICS[286]!); // 0x1D185 (astral surrogate pair)
  const d296 = String.fromCodePoint(KITTY_PLACEHOLDER_DIACRITICS[296]!); // 0x1D244 (astral surrogate pair)
  const raw = `pre${placeholder}${d286}${d296}${d0}post${placeholder}X`;

  // Feed character-by-character (1 UTF-16 code unit per chunk) to exercise every surrogate & diacritic split.
  const rewriter = new KittyUnicodePlaceholderRewriter();
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    out += rewriter.push(raw[i]!);
  }
  out += rewriter.flush();

  assert.ok(!out.includes(placeholder), "must strip raw U+10EEEE");
  assert.ok(out.startsWith("pre"));
  assert.ok(out.endsWith("X"));
  const firstIdx = out.indexOf(KITTY_SENTINEL_PREFIX);
  const secondIdx = out.indexOf(KITTY_SENTINEL_PREFIX, firstIdx + 1);
  assert.ok(firstIdx === 3 && secondIdx > firstIdx);
  assert.deepEqual(decodeKittySentinel(out.slice(firstIdx, firstIdx + 29)), { row: 286, col: 296, idMsb: 0 });
  assert.equal(out.slice(firstIdx + 29, secondIdx), "post");
  assert.deepEqual(decodeKittySentinel(out.slice(secondIdx, secondIdx + 29)), {
    row: undefined,
    col: undefined,
    idMsb: undefined,
  });

  // Non-placeholder astral emoji split across chunks passes through cleanly.
  rewriter.reset();
  const rocket = "🚀";
  assert.equal(rewriter.push(`ok${rocket[0]!}`) + rewriter.push(rocket[1]!), "ok🚀");

  // Rewritten sentinels are also ignored by OSC 66 text-sizing parser.
  assert.equal(parseOsc66(`s=2;${encodeKittySentinel({ row: 0, col: 0 })}`), null);
});

test("U=1 virtual placements never enqueue cursor placements and track virtual dimensions", () => {
  const virtualPlace = parseKittyGfxCommand("a=p,U=1,q=2,i=7,p=7,c=7,r=3");
  const virtualTransmitPlace = parseKittyGfxCommand("a=T,U=1,q=2,i=8,c=7,r=3;AAAA");
  const cursorPlace = parseKittyGfxCommand("a=p,i=7,c=7,r=3");
  const cursorTransmitPlace = parseKittyGfxCommand("a=T,i=8,c=7,r=3;AAAA");

  assert.equal(shouldCreateCursorPlacement(virtualPlace), false);
  assert.equal(shouldCreateCursorPlacement(virtualTransmitPlace), false);
  assert.equal(shouldCreateCursorPlacement(cursorPlace), true);
  assert.equal(shouldCreateCursorPlacement(cursorTransmitPlace), true);

  const dimsMap = new Map<string, KittyVirtualPlacementDims>();
  registerKittyVirtualPlacement(dimsMap, 7, 19, 7, 3, -1);
  assert.deepEqual(lookupKittyVirtualPlacement(dimsMap, 7, 19), { cols: 7, rows: 3, zIndex: -1 });
  assert.deepEqual(lookupKittyVirtualPlacement(dimsMap, 7, 0), { cols: 7, rows: 3, zIndex: -1 });
  deleteKittyVirtualPlacements(dimsMap, 7);
  assert.equal(lookupKittyVirtualPlacement(dimsMap, 7, 19), undefined);
});

test("7x3 avatar grids keep column 7 text aligned with zero raw U+10EEEE and merge clipped blocks", () => {
  const placeholder = String.fromCodePoint(0x10eeee);
  const d = (n: number) => String.fromCodePoint(KITTY_PLACEHOLDER_DIACRITICS[n]!);
  const splitter = new KittyApcSplitter();
  const rewriter = new KittyUnicodePlaceholderRewriter();

  const makeRow = (imgId: number, rowIdx: number, label: string, idMsb?: number) => {
    const fg = `\x1b[38;2;${(imgId >> 16) & 255};${(imgId >> 8) & 255};${imgId & 255}m`;
    let cells = "";
    for (let col = 0; col < 7; col++) {
      cells += placeholder + d(rowIdx) + d(col) + (idMsb !== undefined ? d(idMsb) : "");
    }
    return `${fg}${cells}\x1b[39;59m ${label}`;
  };

  const labels = ["coordinator", "btw-slash", "monitor", "omp-models"];
  const rawStream =
    "\x1b_Ga=p,U=1,q=2,i=42,p=42,c=7,r=3\x1b\\" +
    [
      makeRow(42, 0, labels[0]!),
      makeRow(42, 1, labels[1]!),
      makeRow(42, 2, labels[2]!),
      // Adjacent sprite sharing baseId=42 on rows below (distinct tileRow reset to 0 + omitted cols + idMsb=2).
      `\x1b[38;2;0;0;42m${placeholder}${d(0)}${d(0)}${d(2)}${placeholder.repeat(6)}\x1b[39;59m ${labels[3]!}`,
    ].join("\n");

  let vtOut = "";
  for (const seg of splitter.push(rawStream)) {
    if (seg.kind === "vt") vtOut += rewriter.push(seg.data);
  }
  vtOut += rewriter.flush();

  assert.ok(!vtOut.includes(placeholder), "raw U+10EEEE must not reach terminal");
  const lines = vtOut.split("\n");
  assert.equal(lines.length, 4);
  for (let r = 0; r < 4; r++) {
    const clean = lines[r]!.replace(/\x1b\[[0-9;:]*m/g, "");
    // 7 avatar sentinel columns + 1 space + label
    assert.equal(terminalTextColumns(clean), 7 + 1 + labels[r]!.length);
    assert.equal(terminalTextColumns(clean.slice(0, clean.indexOf(" "))), 7);
    assert.ok(clean.endsWith(` ${labels[r]!}`));
  }

  // Build mock cell buffer from rewritten lines and verify virtual sprite block merging + scroll clipping.
  const grid: Array<Array<{ chars: string; fgColor: number }>> = lines.map((line) => {
    const stripped = line.replace(/\x1b\[[0-9;:]*m/g, "");
    const rowCells: Array<{ chars: string; fgColor: number }> = [];
    let i = 0;
    while (i < stripped.length) {
      if (stripped.startsWith(KITTY_SENTINEL_PREFIX, i)) {
        rowCells.push({ chars: stripped.slice(i, i + 29), fgColor: 42 });
        i += 29;
      } else {
        rowCells.push({ chars: stripped[i]!, fgColor: 0 });
        i += 1;
      }
    }
    return rowCells;
  });

  const readCell = (absY: number, x: number, out: KittyBufferCellSample): boolean => {
    const cell = grid[absY]?.[x];
    if (!cell || !cell.chars.startsWith(KITTY_SENTINEL_PREFIX)) return false;
    out.chars = cell.chars;
    out.width = 1;
    out.fgMode = "rgb";
    out.fgColor = cell.fgColor;
    out.placementId = 0;
    return true;
  };

  const fullBlocks = collectVirtualSpriteBlocks(0, 4, 30, readCell);
  assert.equal(fullBlocks.length, 2, "row 3 restarts at tileRow=0 and idMsb=2, forming a distinct block");
  assert.deepEqual(fullBlocks[0], {
    imageId: 42,
    placementId: 0,
    startAbsY: 0,
    startX: 0,
    cols: 7,
    rows: 3,
    startTileCol: 0,
    startTileRow: 0,
  });
  assert.equal(fullBlocks[1]!.imageId, 42 + (2 << 24));
  assert.equal(fullBlocks[1]!.cols, 7);
  assert.equal(fullBlocks[1]!.rows, 1);

  // When scrolled down 1 row (topY = 1), first avatar shrinks to rows=2 with startTileRow=1 for top clipping.
  const scrolledBlocks = collectVirtualSpriteBlocks(1, 4, 30, readCell);
  assert.equal(scrolledBlocks[0]!.startAbsY, 1);
  assert.equal(scrolledBlocks[0]!.rows, 2);
  assert.equal(scrolledBlocks[0]!.startTileRow, 1);
});
