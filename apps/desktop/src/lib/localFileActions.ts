import type { PlatformKind } from "./bridge";
import { native } from "./native";
import { openWebTab } from "../shell/shellStore";

export interface LocalFileActionOptions {
  nativeAvailable: boolean;
  agentDeviceId?: string;
  agentCwd?: string;
  localHostId?: string | null;
  path: string;
  absPath?: string;
}

export interface LocalActionTargetOptions {
  path: string;
  absPath?: string;
  agentCwd?: string;
}

export function revealInFolderLabel(platform: PlatformKind): string {
  if (platform === "macos") return "在访达中定位";
  if (platform === "windows") return "在资源管理器中打开所在目录";
  return "打开所在目录";
}

export function revealInFolderShortLabel(platform: PlatformKind): string {
  if (platform === "macos") return "在访达中显示";
  if (platform === "windows") return "在资源管理器中显示";
  return "打开所在目录";
}

export function isAbsoluteOrHomePath(p: string): boolean {
  const trimmed = p.trim();
  if (!trimmed) return false;
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    /^file:\/\//i.test(trimmed)
  );
}

export function canActOnLocalFile(opts: LocalFileActionOptions): boolean {
  if (!opts.nativeAvailable) return false;
  const target = opts.absPath?.trim() || opts.path.trim();
  if (!target) return false;
  const hasUsablePath = Boolean(opts.absPath?.trim()) || Boolean(opts.agentCwd?.trim()) || isAbsoluteOrHomePath(opts.path);
  if (!hasUsablePath) return false;
  if (!opts.agentDeviceId || opts.agentDeviceId === "local") {
    return isAbsoluteOrHomePath(target) || Boolean(opts.agentCwd?.trim());
  }
  if (!opts.localHostId) {
    return Boolean(opts.absPath?.trim() && isAbsoluteOrHomePath(opts.absPath)) || isAbsoluteOrHomePath(opts.path);
  }
  return opts.agentDeviceId === opts.localHostId;
}

export function resolveLocalActionTarget(opts: LocalActionTargetOptions): { path: string; cwd?: string } {
  const abs = opts.absPath?.trim();
  const cwd = opts.agentCwd?.trim() || undefined;
  return {
    path: abs || opts.path.trim(),
    ...(cwd ? { cwd } : {}),
  };
}

export async function revealLocalFile(opts: LocalActionTargetOptions): Promise<void> {
  const target = resolveLocalActionTarget(opts);
  if (!target.path) throw new Error("文件路径为空");
  await native.localRevealInFolder(target);
}

export async function openLocalFileDefault(opts: LocalActionTargetOptions): Promise<void> {
  const target = resolveLocalActionTarget(opts);
  if (!target.path) throw new Error("文件路径为空");
  await native.localOpenFile(target);
}

export async function openLocalFileInBuiltinBrowser(
  opts: LocalActionTargetOptions & { title?: string; spaceKey?: string | null },
): Promise<void> {
  const target = resolveLocalActionTarget(opts);
  if (!target.path) throw new Error("文件路径为空");
  const url = await native.registerLocalPreviewUrl(target.path, target.cwd);
  if (!url) throw new Error("当前环境不支持内置浏览器预览本地文件");
  const title = opts.title?.trim() || target.path.split(/[\\/]/).filter(Boolean).pop() || "本地文件";
  openWebTab(url, title, opts.spaceKey !== undefined ? { spaceKey: opts.spaceKey } : undefined);
}
