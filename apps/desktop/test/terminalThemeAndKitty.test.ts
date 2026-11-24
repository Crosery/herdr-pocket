import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { configKeySpec } from "@herdr-pocket/protocol";
import {
  clearKittyVirtualPlacementsForScreen,
  lookupKittyVirtualPlacement,
  registerKittyVirtualPlacement,
  type KittyVirtualPlacementDims,
} from "../src/lib/kittyProtocol";
import {
  deleteKittyPlacementsScoped,
  erasePlacementsInDisplay,
  erasePlacementsInLine,
  getTerminalThemeSpec,
  resolveTerminalAppearance,
} from "../src/lib/terminalTheme";

interface MockPlacement {
  key: string;
  imageId: number;
  placementId: number;
  alt: boolean;
  bufferY: number;
  col: number;
  cols: number;
  rows: number;
}

function makePlacement(
  overrides: Partial<MockPlacement> & Pick<MockPlacement, "imageId" | "alt">,
): MockPlacement {
  return {
    key: `p-${overrides.imageId}-${overrides.placementId ?? 1}-${overrides.alt ? "alt" : "norm"}`,
    placementId: 1,
    bufferY: 0,
    col: 0,
    cols: 10,
    rows: 5,
    ...overrides,
  };
}

test("resolveTerminalAppearance maps system/light/dark choices accurately", () => {
  assert.equal(resolveTerminalAppearance("light", false), "light");
  assert.equal(resolveTerminalAppearance("light", true), "light");
  assert.equal(resolveTerminalAppearance("dark", false), "dark");
  assert.equal(resolveTerminalAppearance("dark", true), "dark");
  assert.equal(resolveTerminalAppearance("system", false), "light");
  assert.equal(resolveTerminalAppearance("system", true), "dark");
});

test("getTerminalThemeSpec returns Herdr.app Paper (#ffffff, #111214 brightWhite) and Graphite (#17191d) specs", () => {
  const light = getTerminalThemeSpec("light");
  assert.equal(light.mode, "light");
  assert.equal(light.bg, "#ffffff");
  assert.equal(light.fg, "#25272c");
  assert.equal(light.cursor, "#25272c");
  assert.equal(light.minimumContrastRatio, 1);
  assert.deepEqual(light.theme, {
    background: "#ffffff",
    foreground: "#25272c",
    cursor: "#25272c",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(207, 220, 245, 0.78)",
    black: "#25272c",
    red: "#c62a2a",
    green: "#1a7f37",
    yellow: "#8f5d00",
    blue: "#1f62d0",
    magenta: "#7a45c8",
    cyan: "#0f6f74",
    white: "#5f6068",
    brightBlack: "#7b7e87",
    brightRed: "#d1242f",
    brightGreen: "#1f883d",
    brightYellow: "#9a6700",
    brightBlue: "#0969da",
    brightMagenta: "#8250df",
    brightCyan: "#1b7c83",
    brightWhite: "#111214",
  });

  const dark = getTerminalThemeSpec("dark");
  assert.equal(dark.mode, "dark");
  assert.equal(dark.bg, "#17191d");
  assert.equal(dark.fg, "#d2d4d9");
  assert.equal(dark.cursor, "#d2d4d9");
  assert.equal(dark.minimumContrastRatio, 1);
  assert.deepEqual(dark.theme, {
    background: "#17191d",
    foreground: "#d2d4d9",
    cursor: "#d2d4d9",
    cursorAccent: "#17191d",
    selectionBackground: "rgba(57, 68, 84, 0.72)",
    black: "#45484f",
    red: "#dc8c95",
    green: "#a6bd91",
    yellow: "#d8be87",
    blue: "#96b2d7",
    magenta: "#b5a2ce",
    cyan: "#8cbdc3",
    white: "#d2d4d9",
    brightBlack: "#818793",
    brightRed: "#f0a5ad",
    brightGreen: "#bad5a2",
    brightYellow: "#ead2a1",
    brightBlue: "#b0cbef",
    brightMagenta: "#cbb7e6",
    brightCyan: "#a4d5db",
    brightWhite: "#f0f0f2",
  });
});

test("protocol defaults use Herdr.app 14px fontSize, 115% lineHeight, and 500 fontWeight", () => {
  assert.equal(configKeySpec("terminal.fontSize")?.default, 14);
  assert.equal(configKeySpec("terminal.lineHeight")?.default, 115);
  assert.equal(configKeySpec("terminal.fontWeight")?.default, 500);
});

test("deleteKittyPlacementsScoped d=a and d=A only clear active screen buffer and preserve other buffer assets", () => {
  const normalFastfetch = makePlacement({ imageId: 1, alt: false, bufferY: 2, col: 0 });
  const sharedNormal = makePlacement({ imageId: 3, alt: false, bufferY: 10, col: 4 });
  const yaziPreview = makePlacement({ imageId: 2, alt: true, bufferY: 1, col: 20 });
  const sharedAlt = makePlacement({ imageId: 3, alt: true, bufferY: 5, col: 1 });
  const all = [normalFastfetch, sharedNormal, yaziPreview, sharedAlt];

  // Lowercase d=a in alt screen removes only alt entries and evicts nothing.
  const resLower = deleteKittyPlacementsScoped(all, true, { deleteWhat: "a" }, 0, 0);
  assert.equal(resLower.clearedActiveAll, true);
  assert.deepEqual(resLower.placements, [normalFastfetch, sharedNormal]);
  assert.deepEqual(resLower.evictAssetIds, []);

  // Omitted deleteWhat defaults to d=a on active buffer.
  const resDefault = deleteKittyPlacementsScoped(all, false, {}, 0, 0);
  assert.equal(resDefault.clearedActiveAll, true);
  assert.deepEqual(resDefault.placements, [yaziPreview, sharedAlt]);
  assert.deepEqual(resDefault.evictAssetIds, []);

  // Uppercase d=A in alt screen evicts only alt-only imageId=2, keeping shared imageId=3 and normal imageId=1.
  const resUpperAlt = deleteKittyPlacementsScoped(all, true, { deleteWhat: "A" }, 0, 0);
  assert.equal(resUpperAlt.clearedActiveAll, true);
  assert.deepEqual(resUpperAlt.placements, [normalFastfetch, sharedNormal]);
  assert.deepEqual(resUpperAlt.evictAssetIds, [2]);
});

test("deleteKittyPlacementsScoped d=c and d=C match cursor coordinates within active buffer only", () => {
  const normHitBox = makePlacement({ imageId: 10, alt: false, col: 5, cols: 4, bufferY: 10, rows: 3 });
  const altSameBox = makePlacement({ imageId: 11, alt: true, col: 5, cols: 4, bufferY: 10, rows: 3 });
  const normShared = makePlacement({ imageId: 11, alt: false, col: 20, cols: 4, bufferY: 1, rows: 2 });
  const all = [normHitBox, altSameBox, normShared];

  // Right outside exclusive end boundary (col + cols = 9, bufferY + rows = 13) -> miss.
  const missCol = deleteKittyPlacementsScoped(all, false, { deleteWhat: "C" }, 9, 10);
  assert.equal(missCol.clearedActiveAll, false);
  assert.equal(missCol.placements.length, 3);
  assert.deepEqual(missCol.evictAssetIds, []);

  const missRow = deleteKittyPlacementsScoped(all, false, { deleteWhat: "C" }, 5, 13);
  assert.equal(missRow.placements.length, 3);
  assert.deepEqual(missRow.evictAssetIds, []);

  // Inside normHitBox on normal screen: removes normHitBox only, leaves altSameBox untouched.
  const hitNormLower = deleteKittyPlacementsScoped(all, false, { deleteWhat: "c" }, 5, 10);
  assert.deepEqual(hitNormLower.placements, [altSameBox, normShared]);
  assert.deepEqual(hitNormLower.evictAssetIds, []);

  const hitNormUpper = deleteKittyPlacementsScoped(all, false, { deleteWhat: "C" }, 8, 12);
  assert.deepEqual(hitNormUpper.placements, [altSameBox, normShared]);
  assert.deepEqual(hitNormUpper.evictAssetIds, [10]);

  // Deleting altSameBox with d=C does NOT evict imageId=11 because normShared still uses 11.
  const hitAltUpper = deleteKittyPlacementsScoped(all, true, { deleteWhat: "C" }, 6, 11);
  assert.deepEqual(hitAltUpper.placements, [normHitBox, normShared]);
  assert.deepEqual(hitAltUpper.evictAssetIds, []);
});

test("deleteKittyPlacementsScoped d=i/I and d=p/P filter accurately and evict only unreferenced assets", () => {
  const p1a = makePlacement({ imageId: 7, placementId: 1, alt: false });
  const p1b = makePlacement({ imageId: 7, placementId: 2, alt: true });
  const p2 = makePlacement({ imageId: 8, placementId: 1, alt: false });
  const all = [p1a, p1b, p2];

  // d=i without id is a no-op.
  assert.deepEqual(deleteKittyPlacementsScoped(all, false, { deleteWhat: "i" }, 0, 0), {
    placements: all,
    removed: [],
    evictAssetIds: [],
    clearedActiveAll: false,
  });

  // d=i with id=7 and placementId=1 removes only placement 1, no eviction.
  const diSingle = deleteKittyPlacementsScoped(all, false, { deleteWhat: "i", id: 7, placementId: 1 }, 0, 0);
  assert.deepEqual(diSingle.placements, [p1b, p2]);
  assert.deepEqual(diSingle.evictAssetIds, []);

  // d=I with placementId specified does NOT evict (matches spec: I evicts only when placementId is undefined).
  const dIScoped = deleteKittyPlacementsScoped(all, false, { deleteWhat: "I", id: 7, placementId: 1 }, 0, 0);
  assert.deepEqual(dIScoped.placements, [p1b, p2]);
  assert.deepEqual(dIScoped.evictAssetIds, []);

  // d=I with id=7 and no placementId removes all placements of 7 and evicts [7].
  const dIAll = deleteKittyPlacementsScoped(all, false, { deleteWhat: "I", id: 7 }, 0, 0);
  assert.deepEqual(dIAll.placements, [p2]);
  assert.deepEqual(dIAll.evictAssetIds, [7]);

  // d=p requires both id and placementId.
  const dpMissing = deleteKittyPlacementsScoped(all, false, { deleteWhat: "P", id: 7 }, 0, 0);
  assert.deepEqual(dpMissing.placements, all);
  assert.deepEqual(dpMissing.evictAssetIds, []);

  // d=P on placement 1 of image 7 keeps asset 7 alive because p1b still uses 7.
  const dPRemaining = deleteKittyPlacementsScoped(all, false, { deleteWhat: "P", id: 7, placementId: 1 }, 0, 0);
  assert.deepEqual(dPRemaining.placements, [p1b, p2]);
  assert.deepEqual(dPRemaining.evictAssetIds, []);

  // d=P on image 8's only placement evicts [8].
  const dPLast = deleteKittyPlacementsScoped(all, false, { deleteWhat: "P", id: 8, placementId: 1 }, 0, 0);
  assert.deepEqual(dPLast.placements, [p1a, p1b]);
  assert.deepEqual(dPLast.evictAssetIds, [8]);

  // d=p (lowercase) never evicts.
  const dpLower = deleteKittyPlacementsScoped(all, false, { deleteWhat: "p", id: 8, placementId: 1 }, 0, 0);
  assert.deepEqual(dpLower.placements, [p1a, p1b]);
  assert.deepEqual(dpLower.evictAssetIds, []);
});

test("TerminalSurface keeps customGlyphs enabled across both light and dark modes", () => {
  const src = readFileSync(new URL("../src/components/TerminalSurface.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("customGlyphs: true"), "XTerm initialization must enable customGlyphs");
  assert.ok(src.includes("term.options.customGlyphs = true"), "live option updates must keep customGlyphs enabled");
  assert.equal(/customGlyphs\s*[:=]\s*(?:false|activeSpec\.mode)/.test(src), false);
});

test("TerminalSurface subscribes to local-term://size and fonts.ts prefers 1-cell Mono Nerd fonts", () => {
  const termSrc = readFileSync(new URL("../src/components/TerminalSurface.tsx", import.meta.url), "utf8");
  assert.ok(termSrc.includes('"local-term://size"'), "TerminalSurface must subscribe to local-term://size");
  const fontsSrc = readFileSync(new URL("../src/lib/fonts.ts", import.meta.url), "utf8");
  const idxSymbolsMono = fontsSrc.indexOf('"Symbols Nerd Font Mono"');
  const idxJbMono = fontsSrc.indexOf('"JetBrainsMono Nerd Font Mono"');
  const idxJbProp = fontsSrc.indexOf('"JetBrainsMono Nerd Font"');
  assert.ok(idxSymbolsMono >= 0 && idxJbMono > idxSymbolsMono && idxJbProp > idxJbMono, "Mono Nerd fonts must precede proportional JetBrainsMono Nerd Font");
});

test("pane header right group (.v3-pane-right) stays flush right and .v3-pane-actions never jumps horizontally on hover", () => {
  const css = readFileSync(new URL("../src/styles/shell.css", import.meta.url), "utf8");
  const rightMatch = css.match(/\.v3-pane-right\s*\{([^}]*)\}/);
  assert.ok(rightMatch, "shell.css must define .v3-pane-right");
  assert.match(rightMatch[1]!, /margin-left\s*:\s*auto/);
  assert.match(rightMatch[1]!, /justify-content\s*:\s*flex-end/);
  const actionsBody = css.match(/\.v3-pane-actions\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(actionsBody, /display\s*:\s*inline-flex/);
  assert.equal(/opacity\s*:\s*0(?![.\d])/.test(actionsBody), false, ".v3-pane-actions must not hide completely with opacity: 0");
  assert.match(actionsBody, /opacity\s*:\s*0\.72/);
  assert.match(css, /\.v3-pane-head:hover\s+\.v3-pane-actions[\s\S]*?opacity\s*:\s*1\s*;/);
  assert.equal(/@media\s*\(hover:\s*hover\)[\s\S]*?\.v3-pane-actions\s*\{\s*display\s*:\s*none;/.test(css), false);
});

test("Touched desktop UI & sync modules have zero forward references to block-scoped let/const declarations (TDZ guard)", () => {
  const cfgPath = new URL("../tsconfig.json", import.meta.url).pathname;
  const targets = [
    "../src/components/TerminalSurface.tsx",
    "../src/shell/ShellWork.tsx",
    "../src/shell/ShellSidebar.tsx",
    "../src/shell/shellStore.ts",
    "../src/shell/DesktopShell.tsx",
    "../src/shell/herdrDoc.ts",
    "../src/shell/herdrDocSync.ts",
    "../src/views/WorkbenchView.tsx",
    "../src/views/AgentsView.tsx",
    "../src/lib/mock.ts",
    "../src/lib/fileDrag.ts",
    "../src/lib/terminalSearch.ts",
  ];
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dirname(cfgPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();

  const forwardRefs: string[] = [];
  for (const rel of targets) {
    const absPath = new URL(rel, import.meta.url).pathname;
    const sf = program.getSourceFile(absPath);
    assert.ok(sf, `${rel} must exist in tsconfig program`);

    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const sym = checker.getSymbolAtLocation(node);
        const decl = sym?.valueDeclaration;
        if (
          decl &&
          decl.getSourceFile() === sf &&
          ts.isVariableDeclaration(decl) &&
          decl.parent &&
          ts.isVariableDeclarationList(decl.parent) &&
          (decl.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0 &&
          node.pos < decl.pos
        ) {
          const refPos = sf.getLineAndCharacterOfPosition(node.getStart());
          const declPos = sf.getLineAndCharacterOfPosition(decl.getStart());
          forwardRefs.push(`${rel}:${refPos.line + 1} refs "${node.text}" before decl at line ${declPos.line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  assert.deepEqual(forwardRefs, [], `Found TDZ forward references:\n${forwardRefs.join("\n")}`);
});

test("deleteKittyPlacementsScoped handles d=n/z/x/y/q/r scopes and erase helpers clear overlapped regions", () => {
  const base = [
    { ...makePlacement({ imageId: 10, alt: false, bufferY: 12, col: 4, cols: 4, rows: 3 }), imageNumber: 77, zIndex: 2 },
    { ...makePlacement({ imageId: 12, alt: false, bufferY: 16, col: 10, cols: 3, rows: 2 }), imageNumber: 88, zIndex: 5 },
    { ...makePlacement({ imageId: 14, alt: false, bufferY: 2, col: 0, cols: 2, rows: 2 }), imageNumber: 99, zIndex: 0 },
  ];

  // d=q with viewBaseY=10 and cell (6, 4) -> buffer col 5, row 13 (1-based cropX=6, cropY=4)
  const qRes = deleteKittyPlacementsScoped(base, false, { deleteWhat: "q", cropX: 6, cropY: 4 }, 0, 10, 10);
  assert.deepEqual(qRes.removed.map((x) => x.imageId), [10]);

  const nRes = deleteKittyPlacementsScoped(base, false, { deleteWhat: "n", imageNumber: 88 }, 0, 10, 10);
  assert.deepEqual(nRes.removed.map((x) => x.imageId), [12]);

  const zRes = deleteKittyPlacementsScoped(base, false, { deleteWhat: "z", zIndex: 5 }, 0, 10, 10);
  assert.deepEqual(zRes.removed.map((x) => x.imageId), [12]);

  const xRes = deleteKittyPlacementsScoped(base, false, { deleteWhat: "x", cropX: 11 }, 0, 10, 10);
  assert.deepEqual(xRes.removed.map((x) => x.imageId), [12]);

  const yRes = deleteKittyPlacementsScoped(base, false, { deleteWhat: "y", cropY: 13 }, 0, 10, 0);
  assert.deepEqual(yRes.removed.map((x) => x.imageId), [10]);

  const rRes = deleteKittyPlacementsScoped(base, false, { deleteWhat: "r", cropX: 10, cropY: 12 }, 0, 10, 0);
  assert.deepEqual(rRes.removed.map((x) => x.imageId), [10, 12]);

  // CSI J (ED): Ps=2 clears viewport [10..34) while keeping scrollback id=14; Ps=3 clears scrollback only
  const ed2 = erasePlacementsInDisplay(base, 2, 10, 24, 15, 0, 80, false);
  assert.deepEqual(ed2.kept.map((x) => x.imageId), [14]);
  const ed3 = erasePlacementsInDisplay(base, 3, 10, 24, 15, 0, 80, false);
  assert.deepEqual(ed3.removed.map((x) => x.imageId), [14]);

  // CSI K / X: cursor at (row=13, col=6) hits id=10 [col 4..8, row 12..15)
  const el0 = erasePlacementsInLine(base, 0, 13, 6, null, false);
  assert.deepEqual(el0.removed.map((x) => x.imageId), [10]);
  const ech = erasePlacementsInLine(base, 0, 13, 6, 2, false);
  assert.deepEqual(ech.removed.map((x) => x.imageId), [10]);
});

test("clearKittyVirtualPlacementsForScreen isolates alt vs main screen and terminal.css layers z<0 underlay beneath text", () => {
  const vmap = new Map<string, KittyVirtualPlacementDims>();
  registerKittyVirtualPlacement(vmap, 100, 1, 20, 12, -1, true);
  registerKittyVirtualPlacement(vmap, 200, 1, 10, 6, 0, false);

  assert.equal(lookupKittyVirtualPlacement(vmap, 100, 1, true)?.cols, 20);
  assert.equal(lookupKittyVirtualPlacement(vmap, 200, 1, false)?.cols, 10);

  clearKittyVirtualPlacementsForScreen(vmap, true);
  assert.equal(lookupKittyVirtualPlacement(vmap, 100, 1, true), undefined);
  assert.equal(lookupKittyVirtualPlacement(vmap, 200, 1, false)?.cols, 10);

  const termCss = readFileSync(new URL("../src/styles/terminal.css", import.meta.url), "utf8");
  const zUnder = Number(termCss.match(/\.tp-term-underlay\s*\{[^}]*z-index:\s*(\d+)/)?.[1] ?? -1);
  const zRows = Number(termCss.match(/\.tp-term-host(?:\s+\.xterm)?\s+\.xterm-rows\s*\{[^}]*z-index:\s*(\d+)/)?.[1] ?? -1);
  const zOver = Number(termCss.match(/\.tp-term-overlay\s*\{[^}]*z-index:\s*(\d+)/)?.[1] ?? -1);
  assert.ok(zUnder > 0 && zUnder < zRows && zRows < zOver, `expected underlay (${zUnder}) < rows (${zRows}) < overlay (${zOver})`);
});
