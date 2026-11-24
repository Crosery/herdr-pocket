export interface CarriedAssetPlanItem {
  channel: string;
  version: string;
  tag: string;
  fileName: string;
  sha256?: string;
}

export const ALL_RELEASE_CHANNELS: readonly string[];

export function planCarriedReleaseAssets(params: {
  distFiles?: readonly string[];
  prevManifest?: Record<string, unknown> | null;
  recentReleases?: ReadonlyArray<Record<string, unknown>>;
  currentTag?: string;
}): CarriedAssetPlanItem[];

export function renderLatestDownloadsMarkdown(params: {
  manifest: Record<string, unknown>;
  repo: string;
  releaseTag: string;
}): string;
