import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  MAX_WEBGL_POOL,
  acquireWebglSlot,
  getActiveWebglPoolCount,
  markWebglSlotInactive,
  releaseWebglSlot,
  resetWebglPoolForTest,
} from "../src/lib/terminalWebglPool.ts";
import {
  clearTerminalTextureAtlasSafe,
  patchTextureAtlas,
  patchWebglAddonInstance,
  refreshWarmWebglAddon,
  resetWebglPatchRegistryForTest,
  unregisterWebglAddonInstance,
  type PatchedAtlasPage,
  type PatchedTextureAtlas,
} from "../src/lib/terminalWebglPatch.ts";

afterEach(() => {
  resetWebglPoolForTest();
  resetWebglPatchRegistryForTest();
});

test("terminalWebglPool keeps up to MAX_WEBGL_POOL warm slots and reactivates in O(1)", () => {
  const keys = Array.from({ length: MAX_WEBGL_POOL }, (_, i) => Symbol(`t${i}`));
  let evictions = 0;

  for (const k of keys) {
    assert.equal(acquireWebglSlot(k, () => { evictions += 1; }), true);
    markWebglSlotInactive(k);
  }
  assert.equal(getActiveWebglPoolCount(), MAX_WEBGL_POOL);
  assert.equal(evictions, 0);

  // Reactivating an already warm slot keeps it in pool without triggering eviction.
  assert.equal(acquireWebglSlot(keys[0]!, () => { evictions += 1; }), true);
  assert.equal(getActiveWebglPoolCount(), MAX_WEBGL_POOL);
  assert.equal(evictions, 0);
});

test("terminalWebglPool evicts oldest inactive LRU slot asynchronously on overflow", async () => {
  const keys = Array.from({ length: MAX_WEBGL_POOL }, (_, i) => Symbol(`t${i}`));
  const evicted: string[] = [];

  for (let i = 0; i < keys.length; i += 1) {
    const label = `t${i}`;
    assert.equal(acquireWebglSlot(keys[i]!, () => evicted.push(label)), true);
    markWebglSlotInactive(keys[i]!);
  }
  // Touch t0 so t1 becomes the oldest inactive LRU entry.
  assert.equal(acquireWebglSlot(keys[0]!, () => evicted.push("t0")), true);
  markWebglSlotInactive(keys[0]!);

  const extra = Symbol("extra");
  assert.equal(acquireWebglSlot(extra, () => evicted.push("extra")), true);
  assert.equal(getActiveWebglPoolCount(), MAX_WEBGL_POOL);
  // Victim disposal must not block the synchronous click/acquire path.
  assert.deepEqual(evicted, []);

  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(evicted, ["t1"]);
});

test("terminalWebglPool refuses to evict active panes and cancels pending eviction if re-acquired", async () => {
  const activeKeys = Array.from({ length: MAX_WEBGL_POOL }, (_, i) => Symbol(`active${i}`));
  let evictions = 0;

  for (const k of activeKeys) {
    assert.equal(acquireWebglSlot(k, () => { evictions += 1; }), true);
  }
  const ninth = Symbol("ninth");
  assert.equal(acquireWebglSlot(ninth, () => { evictions += 1; }), false);
  assert.equal(getActiveWebglPoolCount(), MAX_WEBGL_POOL);
  assert.equal(evictions, 0);

  // Release one active slot to make room, test cancel-on-reacquire race safety.
  releaseWebglSlot(activeKeys[0]!);
  assert.equal(getActiveWebglPoolCount(), MAX_WEBGL_POOL - 1);

  const victim = Symbol("victim");
  let victimEvicted = 0;
  assert.equal(acquireWebglSlot(victim, () => { victimEvicted += 1; }), true);
  markWebglSlotInactive(victim);
  assert.equal(getActiveWebglPoolCount(), MAX_WEBGL_POOL);

  // Acquire another slot, scheduling async eviction of `victim`.
  const challenger = Symbol("challenger");
  assert.equal(acquireWebglSlot(challenger, () => {}), true);
  // Free an active slot and immediately re-acquire `victim` before macrotask fires.
  releaseWebglSlot(activeKeys[1]!);
  assert.equal(acquireWebglSlot(victim, () => { victimEvicted += 1; }), true);

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(victimEvicted, 0);
});

function makeMockAtlasPage(size = 512, glyphsCount = 2): PatchedAtlasPage {
  const removedCanvases: unknown[] = [];
  const canvas = {
    width: size,
    height: size,
    remove() {
      removedCanvases.push(this);
    },
  } as unknown as HTMLCanvasElement & { remove: () => void };
  const glyphs = Array.from({ length: glyphsCount }, () => ({ texturePage: 0 }));
  return {
    canvas,
    ctx: { clearRect: () => {} },
    _glyphs: glyphs,
    get glyphs() {
      return this._glyphs;
    },
    _usedPixels: glyphsCount * 200,
    percentageUsed: (glyphsCount * 200) / (size * size),
    version: 1,
    currentRow: { x: 100, y: 20, height: 18 },
    fixedRows: [{ x: 0, y: 0, height: 20 }],
  };
}

test("clearTerminalTextureAtlasSafe shrinks shared atlas pages and invalidates sibling WebGL renderers", () => {
  const removed: unknown[] = [];
  const p0 = makeMockAtlasPage(2048, 4);
  const p1 = makeMockAtlasPage(512, 2);
  const sharedAtlas: PatchedTextureAtlas = {
    _config: { deviceMaxTextureSize: 16384 },
    _pages: [p0, p1],
    _activePages: [p1],
    _textureSize: 512,
    _didWarmUp: true,
    _requestClearModel: false,
    _cacheMap: { clear: () => {} },
    _cacheMapCombined: { clear: () => {} },
    _onRemoveTextureAtlasCanvas: { fire: (c) => removed.push(c) },
  };

  let clearedA = 0;
  let redrawA = 0;
  const termA = { rows: 24, refresh: () => {}, clearTextureAtlas: () => {} };
  const rendererA = {
    _terminal: { cols: 80, rows: 24 },
    _charAtlas: sharedAtlas,
    _glyphRenderer: { value: { _atlasTextures: [{ version: 1 }, { version: 1 }] } },
    _clearModel: () => {
      clearedA += 1;
    },
    _requestRedrawViewport: () => {
      redrawA += 1;
    },
    _updateModel: () => {},
    renderRows: () => {},
  };

  let clearedB = 0;
  let refreshedB = 0;
  const termB = {
    rows: 24,
    refresh: () => {
      refreshedB += 1;
    },
    clearTextureAtlas: () => {},
  };
  const rendererB = {
    _terminal: { cols: 80, rows: 24 },
    _charAtlas: sharedAtlas,
    _glyphRenderer: { value: { _atlasTextures: [{ version: 1 }, { version: 1 }] } },
    _clearModel: () => {
      clearedB += 1;
    },
    _requestRedrawViewport: () => {},
    _updateModel: () => {},
    renderRows: () => {},
  };

  patchWebglAddonInstance({ _renderer: rendererA });
  patchWebglAddonInstance({ _renderer: rendererB });

  assert.equal(sharedAtlas._config?.deviceMaxTextureSize, 4096);
  const prevEpoch = sharedAtlas.__pocketEpoch ?? 0;

  clearTerminalTextureAtlasSafe(termB, { _renderer: rendererB });

  assert.equal(sharedAtlas._pages.length, 1);
  assert.equal(removed.length, 1);
  assert.equal(p0.canvas.width, 512);
  assert.equal(p0.canvas.height, 512);
  assert.equal(p0._glyphs?.length, 0);
  assert.equal(p0._usedPixels, 0);
  assert.equal((sharedAtlas.__pocketEpoch ?? 0) > prevEpoch, true);
  assert.equal(clearedB, 1);
  assert.equal(refreshedB, 1);
  // Sibling rendererA must also be invalidated so cursor-row blinks never sample old 512px UVs on a cleared atlas.
  assert.equal(clearedA, 1);
  assert.equal(redrawA, 1);
  assert.equal(rendererA._glyphRenderer.value._atlasTextures[0]!.version, -1);

  refreshWarmWebglAddon({ _renderer: rendererA });
  assert.equal(clearedA, 2);

  unregisterWebglAddonInstance({ _renderer: rendererA });
  unregisterWebglAddonInstance({ _renderer: rendererB });
});

test("patched TextureAtlas merges safely mid-frame with full-model rebuild and resets cleanly on 4096px page overflow", () => {
  class MockPage implements PatchedAtlasPage {
    canvas: HTMLCanvasElement & { remove: () => void };
    ctx = { clearRect: () => {} };
    _glyphs: Array<{ texturePage: number }>;
    get glyphs() {
      return this._glyphs;
    }
    _usedPixels: number;
    percentageUsed: number;
    version = 0;
    currentRow = { x: 0, y: 0, height: 0 };
    fixedRows: Array<{ x: number; y: number; height: number }> = [];
    constructor(_doc: Document | undefined, size: number, pageIndex = 0) {
      this.canvas = {
        width: size,
        height: size,
        remove() {},
      } as unknown as HTMLCanvasElement & { remove: () => void };
      this._glyphs = [{ texturePage: pageIndex }];
      this._usedPixels = size * size * 0.5;
      this.percentageUsed = 0.5;
    }
  }

  class MockAtlas implements PatchedTextureAtlas {
    static maxAtlasPages = 16;
    static maxTextureSize = 16384;
    _config = { deviceMaxTextureSize: 16384 };
    _pages: PatchedAtlasPage[] = [];
    _activePages: PatchedAtlasPage[] = [];
    _textureSize = 512;
    _requestClearModel = false;
    _cacheMap = { clear: () => {} };
    _cacheMapCombined = { clear: () => {} };
    _onAddTextureAtlasCanvas = { fire: () => {} };
    _onRemoveTextureAtlasCanvas = { fire: () => {} };
    constructor(count: number, size: number) {
      for (let i = 0; i < count; i += 1) {
        const p = new MockPage(undefined, size, i);
        this._pages.push(p);
        this._activePages.push(p);
      }
    }
    _mergePages(pages: PatchedAtlasPage[], mergedPageIndex: number): PatchedAtlasPage {
      const merged = new MockPage(undefined, pages[0]!.canvas.width * 2, mergedPageIndex);
      for (const p of pages) {
        const idx = this._activePages.indexOf(p);
        if (idx >= 0) this._activePages.splice(idx, 1);
      }
      return merged;
    }
    _deletePage(pageIndex: number): void {
      this._pages.splice(pageIndex, 1);
      for (let j = pageIndex; j < this._pages.length; j += 1) {
        for (const g of this._pages[j]!._glyphs ?? []) g.texturePage -= 1;
        this._pages[j]!.version += 1;
      }
    }
  }

  // Case 1: Mid-frame 4-page same-size merge at maxPages triggers full-viewport _updateModel(0, 23) BEFORE glyphRenderer.render.
  const atlas1 = new MockAtlas(15, 512);
  const calls: string[] = [];
  let triggeredMerge = false;
  const texList1 = Array.from({ length: 16 }, () => ({ version: 2 }));
  const renderer1 = {
    _terminal: { cols: 80, rows: 24 },
    _charAtlas: atlas1,
    _isAttached: true,
    _glyphRenderer: {
      value: {
        _atlasTextures: texList1,
        render: () => {
          calls.push("gl.render");
        },
      },
    },
    _clearModel: () => {
      calls.push("clearModel");
    },
    _updateModel: (s: number, e: number) => {
      calls.push(`updateModel(${s},${e})`);
      if (!triggeredMerge) {
        triggeredMerge = true;
        atlas1._createNewPage?.();
      }
    },
    renderRows: function (s: number, e: number) {
      this._updateModel(s, e);
      this._glyphRenderer.value.render({});
    },
  };

  patchWebglAddonInstance({ _renderer: renderer1 });
  renderer1.renderRows(10, 12);

  assert.deepEqual(calls, ["updateModel(10,12)", "clearModel", "updateModel(0,23)", "gl.render"]);
  assert.equal(texList1[0]!.version, -1);
  // 15 - 4 merged + 1 merged + 1 new = 13 pages (< 16 texture units).
  assert.equal(atlas1._pages.length, 13);

  // Case 2: 15 unmergeable 4096px pages recycle safely via clearTexture() instead of pushing page #16/#17.
  const atlas2 = new MockAtlas(15, 4096);
  patchTextureAtlas(atlas2);
  const recycled = atlas2._createNewPage?.();
  assert.equal(atlas2._pages.length, 1);
  assert.equal(recycled, atlas2._pages[0]);
  assert.equal(atlas2._pages[0]!.canvas.width, 512);
});
