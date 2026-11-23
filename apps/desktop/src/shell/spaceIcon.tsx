import type { CSSProperties } from "react";
import {
  BookOpen,
  Bot,
  Code2,
  Coffee,
  Cpu,
  FlaskConical,
  FolderCode,
  GitBranch,
  Globe,
  Layers,
  Music,
  Server,
  ShieldCheck,
  Smartphone,
  Sparkles,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react";
import { createStore } from "../lib/store";
import { spaceColorVars } from "./spaceSync";

export type SpaceIconId =
  | "folder"
  | "code"
  | "terminal"
  | "git"
  | "flask"
  | "server"
  | "globe"
  | "layers"
  | "music"
  | "book"
  | "coffee"
  | "sparkles"
  | "cpu"
  | "smartphone"
  | "bot"
  | "shield";

export interface SpaceIconPreset {
  id: SpaceIconId;
  label: string;
  Icon: LucideIcon;
}

export const SPACE_ICON_PRESETS: readonly SpaceIconPreset[] = [
  { id: "folder", label: "工作区", Icon: FolderCode },
  { id: "code", label: "代码库", Icon: Code2 },
  { id: "terminal", label: "终端", Icon: TerminalSquare },
  { id: "git", label: "分支", Icon: GitBranch },
  { id: "flask", label: "测试", Icon: FlaskConical },
  { id: "server", label: "服务网关", Icon: Server },
  { id: "globe", label: "站点", Icon: Globe },
  { id: "layers", label: "工坊", Icon: Layers },
  { id: "music", label: "音频音乐", Icon: Music },
  { id: "book", label: "文档故事", Icon: BookOpen },
  { id: "coffee", label: "酒馆茶室", Icon: Coffee },
  { id: "bot", label: "智能体", Icon: Bot },
  { id: "smartphone", label: "移动端", Icon: Smartphone },
  { id: "cpu", label: "算力内核", Icon: Cpu },
  { id: "shield", label: "安全权限", Icon: ShieldCheck },
  { id: "sparkles", label: "创意实验", Icon: Sparkles },
];

const ICON_BY_ID: Readonly<Record<SpaceIconId, SpaceIconPreset>> = Object.fromEntries(
  SPACE_ICON_PRESETS.map((p) => [p.id, p]),
) as Record<SpaceIconId, SpaceIconPreset>;

const FALLBACK_ICON_IDS: readonly SpaceIconId[] = ["folder", "code", "terminal", "layers", "cpu"];
const STORAGE_KEY = "herdr-pocket-space-icons-v1";

function loadCustomIcons(): Record<string, SpaceIconId> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, SpaceIconId> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v in ICON_BY_ID) out[k] = v as SpaceIconId;
    }
    return out;
  } catch {
    return {};
  }
}

export const spaceIconStore = createStore<Record<string, SpaceIconId>>(loadCustomIcons());

function persistCustomIcons(map: Record<string, SpaceIconId>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage errors
  }
}

export function setCustomSpaceIcon(spaceKey: string, iconId: SpaceIconId | null): void {
  if (!spaceKey) return;
  spaceIconStore.set((prev) => {
    const next = { ...prev };
    if (!iconId) {
      if (!(spaceKey in next)) return prev;
      delete next[spaceKey];
    } else {
      if (next[spaceKey] === iconId) return prev;
      next[spaceKey] = iconId;
    }
    persistCustomIcons(next);
    return next;
  });
}

function stableHash(input: string): number {
  let h = 2166136261;
  for (const ch of input) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Infers a semantic vector icon id from a workspace's name, folder, and worktree flag. */
export function inferSpaceIconId(name: string, folder?: string, isWorktree?: boolean): SpaceIconId {
  if (isWorktree) return "git";
  const hay = `${name} ${folder ?? ""}`.toLowerCase();
  if (/(?:测试|\btest\b|\bqa\b|\bspec\b|\bdebug\b)/i.test(hay)) return "flask";
  if (/(?:弹唱|有谱|音乐|钢琴|吉他|\bmusic\b|\bstrum\b|\baudio\b|\bsong\b|\bvoice\b)/i.test(hay)) return "music";
  if (/(?:故事|文档|读书|笔记|\bstory\b|\bbook\b|\bdoc\b|\bwiki\b|\bblog\b|\bnote\b)/i.test(hay)) return "book";
  if (/(?:酒吧|咖啡|茶馆|\bbar\b|\btaproom\b|\bcafe\b|\bpub\b)/i.test(hay)) return "coffee";
  if (/(?:小吹|小羊|宠物|\bpet\b|\bbot\b|\bagent\b|\bassistant\b|\bibuki\b)/i.test(hay)) return "bot";
  if (/(?:工坊|画廊|设计|视频|图像|\bstudio\b|\bvideo\b|\bimage\b|\bdesign\b|\bmedia\b)/i.test(hay)) return "layers";
  if (/(?:网关|中继|接口|服务|\bcpa\b|\bapi\b|\brelay\b|\bproxy\b|\bgateway\b|\bserver\b|\bnewapi\b)/i.test(hay)) return "server";
  if (/(?:移动端|手机|安卓|鸿蒙|\bpocket\b|\bmobile\b|\bandroid\b|\bios\b|\bharmony\b)/i.test(hay)) return "smartphone";
  if (/(?:极客|网页|前端|站点|\bgeek\b|\bweb\b|\bsite\b|\bportal\b)/i.test(hay)) return "globe";
  if (/(?:安全|权限|认证|密钥|\bauth\b|\bsec\b|\bshield\b|\bcert\b)/i.test(hay)) return "shield";
  return FALLBACK_ICON_IDS[stableHash(name.trim() || folder || "space") % FALLBACK_ICON_IDS.length]!;
}

export function resolveSpaceIconId(spaceKey: string, name: string, folder?: string, isWorktree?: boolean): SpaceIconId {
  const custom = spaceIconStore.get()[spaceKey];
  if (custom && custom in ICON_BY_ID) return custom;
  return inferSpaceIconId(name, folder, isWorktree);
}

/** Theme-adaptive Pocket vector icon badge for spaces (sidebar and overview cards). */
export function SpaceTileIcon({
  spaceKey,
  name,
  folder,
  isWorktree,
  color,
  selected = false,
  blocked = false,
  size = "sm",
}: {
  spaceKey: string;
  name: string;
  folder?: string;
  isWorktree?: boolean;
  color?: string;
  selected?: boolean;
  blocked?: boolean;
  size?: "sm" | "md";
}) {
  const customMap = spaceIconStore.use((m) => m);
  const iconId = (spaceKey && customMap[spaceKey]) || inferSpaceIconId(name, folder, isWorktree);
  const preset = ICON_BY_ID[iconId] ?? ICON_BY_ID.folder;
  const Icon = preset.Icon;
  const customVars = spaceColorVars(color);
  const baseClass = size === "md" ? "space-badge" : "v3-tile";
  const tileStyle = customVars
    ? ({ "--sp-fg": customVars.fg, "--sp-bg": customVars.bg } as CSSProperties)
    : undefined;

  return (
    <span
      className={`${baseClass}${customVars ? " custom" : ""}${selected ? " is-selected" : ""}${blocked ? " is-blocked" : ""}`}
      style={tileStyle}
      aria-hidden
    >
      <Icon size={size === "md" ? 13 : 12} strokeWidth={2.05} />
    </span>
  );
}
