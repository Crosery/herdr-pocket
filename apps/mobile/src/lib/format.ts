import type { Agent } from "@herdr-pocket/protocol";

export function basename(path?: string | null): string {
  if (!path) return "";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export function shortPath(path?: string | null): string {
  if (!path) return "";
  return path.replace(/^\/(Users|home)\/[^/]+/, "~");
}

export function relTime(ts?: number | null, now = Date.now()): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "刚刚";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString();
}

export function agentTitle(a: Agent): string {
  return a.title?.trim() || a.preview?.trim() || basename(a.cwd) || a.localId;
}

export function agentSubtitle(a: Agent): string {
  const bits = [a.where, basename(a.cwd), a.turn ? `第 ${a.turn} 轮` : null].filter(Boolean);
  return Array.from(new Set(bits)).join(" · ");
}

export function money(usd?: number): string | null {
  if (usd == null) return null;
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function compactNum(n?: number): string | null {
  if (n == null) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return "夜深啦";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

/** herdr "space": first segment of `where` ("测试 / 1" -> "测试"; herdr TUI: workspace_id). */
export function agentSpace(a: Agent): string | null {
  const head = a.where?.split(" / ")[0]?.trim();
  return head || null;
}

/** The rest of `where` after the space (tab / pane), if any. */
export function agentTab(a: Agent): string | null {
  const rest = a.where?.split(" / ").slice(1).join(" / ").trim();
  return rest || null;
}

/** Stable small hash for picking colours. */
export function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
