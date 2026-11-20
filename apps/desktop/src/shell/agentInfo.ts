import type { Agent, Device } from "@herdr-pocket/protocol";

/** Agent groups of the sidebar list, Herdr's "Working 5 / Idle 43" in our words. */
export type ListGroup = "blocked" | "working" | "done" | "idle" | "offline";

export const LIST_GROUPS: Array<{ key: ListGroup; title: string }> = [
  { key: "blocked", title: "需要你" },
  { key: "working", title: "运行中" },
  { key: "done", title: "已完成" },
  { key: "idle", title: "空闲" },
  { key: "offline", title: "离线" },
];

export const GROUP_RANK: Record<ListGroup, number> = { blocked: 0, working: 1, done: 2, idle: 3, offline: 4 };

export function listGroup(a: Agent, devices: Record<string, Device>): ListGroup {
  if (!devices[a.deviceId]?.online) return "offline";
  return a.status === "blocked" || a.status === "working" || a.status === "done" ? a.status : "idle";
}

export const lastChange = (a: Agent): number => a.statusSince ?? a.updatedAt;

/** Compact age for list rows: 刚刚, 4分钟, 3小时, 2天. */
export function shortAgo(ts: number, now = Date.now()): string {
  const min = Math.floor(Math.max(0, now - ts) / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时`;
  return `${Math.floor(hr / 24)}天`;
}

/** A path with the home folder written as ~ (macOS, Linux and Windows homes). */
export function homeFolder(path: string | undefined): string {
  if (!path) return "";
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~");
}

/** A stable colour slot (0-4) for a space's letter tile; same hash as the agents page. */
export function toneIndex(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 5;
}

/** First letter of a space name for its tile. */
export function tileLetter(name: string): string {
  return ([...name][0] ?? "?").toUpperCase();
}
