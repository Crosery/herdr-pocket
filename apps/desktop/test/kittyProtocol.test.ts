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
  encodeRgbaBmpV4,
  lookupKittyVirtualPlacement,
  parseKittyGfxCommand,
  parseOsc66,
  parsePocketMemPayload,
  pocketTermImageUrl,
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

test("parsePocketMemPayload and pocketTermImageUrl resolve Rust zero-copy handles", () => {
  assert.deepEqual(parsePocketMemPayload("pocket-mem:42/640x480"), {
    id: "42",
    width: 640,
    height: 480,
  });
  assert.deepEqual(parsePocketMemPayload("pocket-mem:1/0x0"), {
    id: "1",
    width: 0,
    height: 0,
  });
  assert.equal(parsePocketMemPayload("pocket-mem:/64x64"), null);
  assert.equal(parsePocketMemPayload("pocket-mem:abc/64x64"), null);
  assert.equal(parsePocketMemPayload("pocket-mem:7/64"), null);
  assert.equal(parsePocketMemPayload("iVBORw0KGgo="), null);

  assert.equal(pocketTermImageUrl("42", false), "pocket-local://localhost/term-img/42");
  assert.equal(pocketTermImageUrl("42", true), "http://pocket-local.localhost/term-img/42");
});

test("parseKittyGfxCommand parses crop rect (x/y/w/h), sub-cell offsets (X/Y), and chunk split across \\x9f", () => {
  const cmd = parseKittyGfxCommand(
    "a=T,f=100,i=7,p=3,x=12,y=24,w=48,h=36,X=3,Y=5,c=4,r=2,C=1,z=-2,q=2;pocket-mem:9/128x128",
  );
  assert.equal(cmd.action, "T");
  assert.equal(cmd.format, 100);
  assert.equal(cmd.id, 7);
  assert.equal(cmd.placementId, 3);
  assert.equal(cmd.cropX, 12);
  assert.equal(cmd.cropY, 24);
  assert.equal(cmd.cropW, 48);
  assert.equal(cmd.cropH, 36);
  assert.equal(cmd.cellOffsetX, 3);
  assert.equal(cmd.cellOffsetY, 5);
  assert.equal(cmd.cols, 4);
  assert.equal(cmd.rows, 2);
  assert.equal(cmd.cursorMovement, 1);
  assert.equal(cmd.zIndex, -2);
  assert.equal(cmd.quiet, 2);
  assert.equal(cmd.payload, "pocket-mem:9/128x128");

  const splitter = new KittyApcSplitter();
  const seg1 = splitter.push("hi\x9f");
  const seg2 = splitter.push("Ga=T,i=1;pocket-mem:1/8x8\x9cdone");
  assert.deepEqual(seg1, [{ kind: "vt", data: "hi" }]);
  assert.deepEqual(seg2, [
    { kind: "kitty", raw: "a=T,i=1;pocket-mem:1/8x8" },
    { kind: "vt", data: "done" },
  ]);
});

test("encodeRgbaBmpV4 builds 122-byte top-down BI_BITFIELDS RGBA BITMAPV4HEADER BMPs", () => {
  const rgba = new Uint8Array([
    10, 20, 30, 128,
    40, 50, 60, 255,
  ]);
  const bmp32 = encodeRgbaBmpV4(2, 1, rgba, 32);
  assert.ok(bmp32);
  assert.equal(bmp32.length, 122 + 8);
  const view32 = new DataView(bmp32.buffer, bmp32.byteOffset, bmp32.byteLength);
  assert.equal(bmp32[0], 0x42);
  assert.equal(bmp32[1], 0x4d);
  assert.equal(view32.getUint32(2, true), 130);
  assert.equal(view32.getUint32(10, true), 122);
  assert.equal(view32.getUint32(14, true), 108);
  assert.equal(view32.getInt32(18, true), 2);
  assert.equal(view32.getInt32(22, true), -1);
  assert.equal(view32.getUint16(28, true), 32);
  assert.equal(view32.getUint32(30, true), 3);
  assert.equal(view32.getUint32(54, true), 0x000000ff);
  assert.equal(view32.getUint32(58, true), 0x0000ff00);
  assert.equal(view32.getUint32(62, true), 0x00ff0000);
  assert.equal(view32.getUint32(66, true), 0xff000000);
  assert.equal(view32.getUint32(70, true), 0);
  assert.deepEqual(Array.from(bmp32.subarray(122)), Array.from(rgba));

  const rgb = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const bmp24 = encodeRgbaBmpV4(1, 2, rgb, 24);
  assert.ok(bmp24);
  assert.equal(bmp24.length, 122 + 8);
  const view24 = new DataView(bmp24.buffer, bmp24.byteOffset, bmp24.byteLength);
  assert.equal(view24.getInt32(18, true), 1);
  assert.equal(view24.getInt32(22, true), -2);
  assert.deepEqual(Array.from(bmp24.subarray(122)), [1, 2, 3, 255, 4, 5, 6, 255]);

  assert.equal(encodeRgbaBmpV4(2, 2, rgba, 32), null);
});
