import type { Terminal as XTerm } from "@xterm/xterm";

export interface PatchedAtlasPage {
  canvas: HTMLCanvasElement & { remove?: () => void };
  ctx?: { clearRect?: (x: number, y: number, w: number, h: number) => void } | null;
  glyphs?: Array<{ texturePage: number }>;
  _glyphs?: Array<{ texturePage: number }>;
  _usedPixels?: number;
  percentageUsed?: number;
  version: number;
  currentRow?: { x: number; y: number; height: number };
  fixedRows?: Array<{ x: number; y: number; height: number }>;
  clear?: () => void;
}

export interface PatchedTextureAtlas {
  _document?: Document;
  _config?: { deviceMaxTextureSize?: number };
  _didWarmUp?: boolean;
  _cacheMap?: { clear?: () => void };
  _cacheMapCombined?: { clear?: () => void };
  _pages: PatchedAtlasPage[];
  pages?: PatchedAtlasPage[];
  _activePages?: PatchedAtlasPage[];
  _overflowSizePage?: PatchedAtlasPage;
  _textureSize?: number;
  _requestClearModel?: boolean;
  _onAddTextureAtlasCanvas?: { fire?: (canvas: HTMLCanvasElement) => void };
  _onRemoveTextureAtlasCanvas?: { fire?: (canvas: HTMLCanvasElement) => void };
  clearTexture?: () => void;
  _createNewPage?: () => PatchedAtlasPage;
  _mergePages?: (mergingPages: PatchedAtlasPage[], mergedPageIndex: number) => PatchedAtlasPage;
  _deletePage?: (pageIndex: number) => void;
  __pocketPatched?: boolean;
  __pocketEpoch?: number;
}

export interface PatchedGlyphRenderer {
  _atlasTextures?: Array<{ version: number }>;
  render?: (model: unknown) => void;
}

export interface PatchedWebglRenderer {
  _terminal?: { cols?: number; rows?: number };
  _charAtlas?: PatchedTextureAtlas;
  _glyphRenderer?: { value?: PatchedGlyphRenderer };
  _isAttached?: boolean;
  _clearModel?: (clearGlyphRenderer: boolean) => void;
  _refreshCharAtlas?: () => void;
  _updateModel?: (start: number, end: number) => void;
  _requestRedrawViewport?: () => void;
  renderRows?: (start: number, end: number) => void;
  __pocketPatched?: boolean;
  __pocketSeenAtlasEpoch?: number;
  __pocketInRenderRows?: boolean;
  __pocketInUpdateModel?: boolean;
}

export interface WebglAddonLike {
  _renderer?: PatchedWebglRenderer;
  clearTextureAtlas?: () => void;
}

const MAX_SAFE_OVERFLOW_TEXTURE_SIZE = 4096;

const mountedRenderers = new Set<PatchedWebglRenderer>();

/** Clears registered renderers (for deterministic Node unit tests). */
export function resetWebglPatchRegistryForTest(): void {
  mountedRenderers.clear();
}

/** Resets uploaded GL texture page versions and clears the renderer's cached vertex/cell model. */
export function invalidateRendererForAtlas(renderer: PatchedWebglRenderer | undefined | null): void {
  if (!renderer) return;
  try {
    const glTextures = renderer._glyphRenderer?.value?._atlasTextures;
    if (Array.isArray(glTextures)) {
      for (const tex of glTextures) {
        if (tex) tex.version = -1;
      }
    }
  } catch {
    // ignore partial teardown state
  }
  try {
    renderer._clearModel?.(true);
  } catch {
    // ignore
  }
}

function notifySiblingRenderers(atlas: PatchedTextureAtlas, exclude?: PatchedWebglRenderer): void {
  const epoch = atlas.__pocketEpoch ?? 0;
  for (const r of mountedRenderers) {
    if (r === exclude || r._charAtlas !== atlas || r.__pocketInRenderRows) continue;
    r.__pocketSeenAtlasEpoch = epoch;
    invalidateRendererForAtlas(r);
    try {
      r._requestRedrawViewport?.();
    } catch {
      // ignore
    }
  }
}

/**
 * Hardens `@xterm/addon-webgl`'s shared `TextureAtlas` against cross-terminal cache poisoning,
 * mid-frame page-merge UV shifts, unmergeable CJK/RGB page overflow, and >4096px GPU allocation.
 */
export function patchTextureAtlas(atlas: PatchedTextureAtlas | undefined | null): void {
  if (!atlas || atlas.__pocketPatched) return;
  atlas.__pocketPatched = true;
  atlas.__pocketEpoch = atlas.__pocketEpoch ?? 1;

  if (atlas._config && (atlas._config.deviceMaxTextureSize ?? 0) > MAX_SAFE_OVERFLOW_TEXTURE_SIZE) {
    atlas._config.deviceMaxTextureSize = MAX_SAFE_OVERFLOW_TEXTURE_SIZE;
  }

  const origCreateNewPage = atlas._createNewPage;

  atlas.clearTexture = function patchedClearTexture(this: PatchedTextureAtlas) {
    const baseSize = this._textureSize ?? 512;
    for (let i = this._pages.length - 1; i >= 1; i -= 1) {
      const page = this._pages[i];
      if (!page) continue;
      try {
        this._onRemoveTextureAtlasCanvas?.fire?.(page.canvas);
        page.canvas?.remove?.();
      } catch {
        // ignore detached canvas cleanup
      }
    }
    this._pages.length = Math.min(1, this._pages.length);
    this._overflowSizePage = undefined;

    const page0 = this._pages[0];
    if (page0) {
      if (page0.canvas && (page0.canvas.width !== baseSize || page0.canvas.height !== baseSize)) {
        page0.canvas.width = baseSize;
        page0.canvas.height = baseSize;
      } else {
        page0.ctx?.clearRect?.(0, 0, page0.canvas?.width ?? baseSize, page0.canvas?.height ?? baseSize);
      }
      if (Array.isArray(page0._glyphs)) {
        page0._glyphs.length = 0;
      } else if (Array.isArray(page0.glyphs)) {
        page0.glyphs.length = 0;
      }
      page0._usedPixels = 0;
      page0.currentRow = { x: 0, y: 0, height: 0 };
      if (Array.isArray(page0.fixedRows)) {
        page0.fixedRows.length = 0;
      }
      page0.version = (page0.version ?? 0) + 1;
    }

    this._activePages = page0 ? [page0] : [];
    this._cacheMap?.clear?.();
    this._cacheMapCombined?.clear?.();
    this._didWarmUp = false;
    this._requestClearModel = false;
    this.__pocketEpoch = (this.__pocketEpoch ?? 0) + 1;

    notifySiblingRenderers(this);
  };

  atlas._createNewPage = function patchedCreateNewPage(this: PatchedTextureAtlas): PatchedAtlasPage {
    const AtlasCtor = this.constructor as { maxAtlasPages?: number; maxTextureSize?: number } | undefined;
    const PageCtor = this._pages[0]?.constructor as
      | (new (doc: Document | undefined, size: number) => PatchedAtlasPage)
      | undefined;

    if (!PageCtor || !this._mergePages || !this._deletePage) {
      return origCreateNewPage ? origCreateNewPage.call(this) : this._pages[0]!;
    }

    const maxTextureDim = Math.min(AtlasCtor?.maxTextureSize || MAX_SAFE_OVERFLOW_TEXTURE_SIZE, MAX_SAFE_OVERFLOW_TEXTURE_SIZE);
    const maxPages = AtlasCtor?.maxAtlasPages ? Math.max(4, AtlasCtor.maxAtlasPages - 1) : 15;

    if (this._pages.length >= maxPages) {
      const byWidth = new Map<number, PatchedAtlasPage[]>();
      for (const p of this._pages) {
        if (!p || p === this._overflowSizePage) continue;
        const glyphs = Array.isArray(p.glyphs) ? p.glyphs : Array.isArray(p._glyphs) ? p._glyphs : null;
        if (!glyphs || glyphs.length === 0) continue;
        const w = p.canvas?.width ?? 0;
        if (w <= 0 || w * 2 > maxTextureDim) continue;
        let bucket = byWidth.get(w);
        if (!bucket) {
          bucket = [];
          byWidth.set(w, bucket);
        }
        bucket.push(p);
      }

      const mergeableWidths = [...byWidth.entries()]
        .filter(([, list]) => list.length >= 4)
        .sort((a, b) => b[0] - a[0]);

      if (mergeableWidths.length > 0) {
        const candidates = [...mergeableWidths[0]![1]].sort(
          (a, b) => (b.percentageUsed ?? 0) - (a.percentageUsed ?? 0),
        );
        const mergingPages = candidates.slice(0, 4);
        const mergingIndices = mergingPages
          .map((p) => this._pages.indexOf(p))
          .filter((idx) => idx >= 0)
          .sort((a, b) => a - b);

        if (mergingIndices.length === 4) {
          const mergedPageIndex = this._pages.length - 4;
          const mergedPage = this._mergePages(mergingPages, mergedPageIndex);
          mergedPage.version = (mergedPage.version ?? 0) + 1;
          for (let i = 3; i >= 0; i -= 1) {
            this._deletePage(mergingIndices[i]!);
          }
          this._pages.push(mergedPage);
          this._requestClearModel = false;
          this.__pocketEpoch = (this.__pocketEpoch ?? 0) + 1;
          this._onAddTextureAtlasCanvas?.fire?.(mergedPage.canvas);
          notifySiblingRenderers(this);
        } else if (this._pages[0]) {
          this.clearTexture?.();
          return this._pages[0];
        }
      } else if (this._pages[0]) {
        // Atlas filled with non-mergeable 4096px/empty pages: recycle safely before exceeding GL texture units.
        this.clearTexture?.();
        return this._pages[0];
      }
    }

    const newPage = new PageCtor(this._document, this._textureSize ?? 512);
    this._pages.push(newPage);
    if (!Array.isArray(this._activePages)) {
      this._activePages = [];
    }
    this._activePages.push(newPage);
    this._onAddTextureAtlasCanvas?.fire?.(newPage.canvas);
    return newPage;
  };
}

function syncRendererAtlasEpoch(renderer: PatchedWebglRenderer): void {
  const atlas = renderer._charAtlas;
  if (!atlas) return;
  patchTextureAtlas(atlas);
  renderer.__pocketSeenAtlasEpoch = atlas.__pocketEpoch ?? 1;
}

/**
 * Patches a mounted `WebglAddon`'s internal `WebglRenderer` so cross-terminal atlas invalidations
 * and mid-frame page merges rebuild the full viewport model before drawing to WebGL.
 */
export function patchWebglAddonInstance(addon: unknown): void {
  const renderer = (addon as WebglAddonLike | null | undefined)?._renderer;
  if (!renderer) return;
  mountedRenderers.add(renderer);
  syncRendererAtlasEpoch(renderer);

  if (renderer.__pocketPatched) return;
  renderer.__pocketPatched = true;

  const origRefreshCharAtlas = renderer._refreshCharAtlas;
  if (typeof origRefreshCharAtlas === "function") {
    renderer._refreshCharAtlas = function patchedRefreshCharAtlas(this: PatchedWebglRenderer) {
      origRefreshCharAtlas.call(this);
      syncRendererAtlasEpoch(this);
    };
  }

  const origUpdateModel = renderer._updateModel;
  if (typeof origUpdateModel === "function") {
    renderer._updateModel = function patchedUpdateModel(this: PatchedWebglRenderer, start: number, end: number) {
      if (this.__pocketInUpdateModel) {
        return origUpdateModel.call(this, start, end);
      }
      this.__pocketInUpdateModel = true;
      try {
        origUpdateModel.call(this, start, end);
        const atlas = this._charAtlas;
        if (atlas && (atlas._requestClearModel || this.__pocketSeenAtlasEpoch !== atlas.__pocketEpoch)) {
          const midFrameClearRequested = Boolean(atlas._requestClearModel);
          atlas._requestClearModel = false;
          if (midFrameClearRequested && this.__pocketSeenAtlasEpoch === atlas.__pocketEpoch) {
            atlas.__pocketEpoch = (atlas.__pocketEpoch ?? 0) + 1;
          }
          this.__pocketSeenAtlasEpoch = atlas.__pocketEpoch;
          invalidateRendererForAtlas(this);
          notifySiblingRenderers(atlas, this);
          const lastRow = Math.max(0, (this._terminal?.rows ?? 1) - 1);
          origUpdateModel.call(this, 0, lastRow);
        }
      } finally {
        this.__pocketInUpdateModel = false;
      }
    };
  }

  const origRenderRows = renderer.renderRows;
  if (typeof origRenderRows === "function") {
    renderer.renderRows = function patchedRenderRows(this: PatchedWebglRenderer, start: number, end: number) {
      let nextStart = start;
      let nextEnd = end;
      const atlas = this._charAtlas;
      if (atlas) {
        patchTextureAtlas(atlas);
        if (atlas._requestClearModel || this.__pocketSeenAtlasEpoch !== atlas.__pocketEpoch) {
          if (atlas._requestClearModel) {
            atlas._requestClearModel = false;
            if (this.__pocketSeenAtlasEpoch === atlas.__pocketEpoch) {
              atlas.__pocketEpoch = (atlas.__pocketEpoch ?? 0) + 1;
            }
          }
          this.__pocketSeenAtlasEpoch = atlas.__pocketEpoch;
          invalidateRendererForAtlas(this);
          nextStart = 0;
          nextEnd = Math.max(0, (this._terminal?.rows ?? 1) - 1);
        }
      }

      this.__pocketInRenderRows = true;
      try {
        origRenderRows.call(this, nextStart, nextEnd);
      } finally {
        this.__pocketInRenderRows = false;
        if (this._charAtlas) {
          syncRendererAtlasEpoch(this);
        }
      }
    };
  }
}

/** Unregisters a disposed `WebglAddon` instance from the global atlas invalidation registry. */
export function unregisterWebglAddonInstance(addon: unknown): void {
  const renderer = (addon as WebglAddonLike | null | undefined)?._renderer;
  if (renderer) {
    mountedRenderers.delete(renderer);
  }
}

/** Invalidates cached GL cell UVs when reactivating a warm WebGL terminal from a background tab. */
export function refreshWarmWebglAddon(addon: unknown): void {
  const renderer = (addon as WebglAddonLike | null | undefined)?._renderer;
  if (!renderer) return;
  if (renderer._charAtlas) {
    patchTextureAtlas(renderer._charAtlas);
    renderer.__pocketSeenAtlasEpoch = renderer._charAtlas.__pocketEpoch ?? 1;
  }
  invalidateRendererForAtlas(renderer);
}

/**
 * Safely clears a terminal's texture atlas without corrupting sibling terminals sharing `charAtlasCache`.
 */
export function clearTerminalTextureAtlasSafe(term: Pick<XTerm, "rows" | "refresh" | "clearTextureAtlas">, addon?: unknown): void {
  const renderer = (addon as WebglAddonLike | null | undefined)?._renderer;
  const atlas = renderer?._charAtlas;
  if (renderer && atlas) {
    patchTextureAtlas(atlas);
    const alreadyTracked = mountedRenderers.has(renderer);
    atlas.clearTexture?.();
    renderer.__pocketSeenAtlasEpoch = atlas.__pocketEpoch ?? 1;
    if (!alreadyTracked) {
      invalidateRendererForAtlas(renderer);
    }
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      // ignore if terminal is tearing down
    }
    return;
  }
  term.clearTextureAtlas?.();
}
