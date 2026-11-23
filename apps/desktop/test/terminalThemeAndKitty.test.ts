import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { configKeySpec } from "@herdr-pocket/protocol";
import {
  deleteKittyPlacementsScoped,
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

test("getTerminalThemeSpec returns Herdr.app light (#ffffff, 4.5 contrast) and dark (#16141d, 1 contrast) specs", () => {
  const light = getTerminalThemeSpec("light");
  assert.equal(light.mode, "light");
  assert.equal(light.bg, "#ffffff");
  assert.equal(light.fg, "#1f2328");
  assert.equal(light.cursor, "#24292f");
  assert.equal(light.minimumContrastRatio, 4.5);
  assert.deepEqual(light.theme, {
    background: "#ffffff",
    foreground: "#1f2328",
    cursor: "#24292f",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(255, 126, 168, 0.22)",
    black: "#24292f",
    red: "#d20f39",
    green: "#1a7f37",
    yellow: "#b56800",
    blue: "#1e66f5",
    magenta: "#b8336a",
    cyan: "#0f7b8a",
    white: "#dce0e8",
    brightBlack: "#6c6f85",
    brightRed: "#e64553",
    brightGreen: "#2da44e",
    brightYellow: "#df8e1d",
    brightBlue: "#3b82f6",
    brightMagenta: "#d6409f",
    brightCyan: "#179299",
    brightWhite: "#eff1f5",
  });

  const dark = getTerminalThemeSpec("dark");
  assert.equal(dark.mode, "dark");
  assert.equal(dark.bg, "#16141d");
  assert.equal(dark.fg, "#f4eef8");
  assert.equal(dark.cursor, "#ff71a8");
  assert.equal(dark.minimumContrastRatio, 1);
  assert.deepEqual(dark.theme, {
    background: "#16141d",
    foreground: "#f4eef8",
    cursor: "#ff71a8",
    cursorAccent: "#16141d",
    selectionBackground: "rgba(255, 113, 168, 0.28)",
    black: "#252131",
    red: "#ff6b8b",
    green: "#6be0a6",
    yellow: "#f6c96b",
    blue: "#7ab8ff",
    magenta: "#eb8eff",
    cyan: "#6fdce8",
    white: "#ece5f5",
    brightBlack: "#7b7391",
    brightRed: "#ff8ba3",
    brightGreen: "#8eedbc",
    brightYellow: "#ffe08f",
    brightBlue: "#9ecbff",
    brightMagenta: "#f3b0ff",
    brightCyan: "#96eaf4",
    brightWhite: "#ffffff",
  });
});

test("protocol defaults use comfortable Herdr.app 14px fontSize and 132% lineHeight", () => {
  assert.equal(configKeySpec("terminal.fontSize")?.default, 14);
  assert.equal(configKeySpec("terminal.lineHeight")?.default, 132);
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

test("TerminalSurface has zero forward references to block-scoped let/const declarations (TDZ guard)", () => {
  const cfgPath = new URL("../tsconfig.json", import.meta.url).pathname;
  const termPath = new URL("../src/components/TerminalSurface.tsx", import.meta.url).pathname;
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dirname(cfgPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(termPath);
  assert.ok(sf, "TerminalSurface.tsx must exist in tsconfig program");

  const forwardRefs: string[] = [];
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
        forwardRefs.push(`line ${refPos.line + 1} refs "${node.text}" before decl at line ${declPos.line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  assert.deepEqual(forwardRefs, [], `Found TDZ forward references:\n${forwardRefs.join("\n")}`);
});
