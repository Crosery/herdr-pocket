import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EgoSpacePhase, RemoteWindowInfo } from "@herdr-pocket/protocol";

export interface EgoTaskSpaceEntry {
  id: number;
  name: string;
  taskId: string;
  createdBy: string;
  ownership: string;
  profileId?: string;
  profileName?: string;
  recentTabTitles?: string[];
}

export interface EgoWindowMatchTarget {
  spaceId?: number;
  spaceName?: string;
  activeTabTitle?: string;
  recentTabTitles?: string[];
}

const EGO_SPACE_QUERY_TTL_MS = 1200;
const spaceQueryCache = new Map<string, { at: number; spaces: EgoTaskSpaceEntry[] }>();
const spaceQueryInflight = new Map<string, Promise<EgoTaskSpaceEntry[]>>();

/**
 * Resolves the local `ego-browser` CLI executable, checking common macOS/Linux user-bin directories
 * so background launchd/systemd daemons find it even under a minimal `PATH`.
 */
export function resolveEgoBrowserBin(): string | null {
  const isWin = process.platform === "win32";
  const sep = isWin ? ";" : ":";
  const pathDirs = (process.env.PATH ?? "").split(sep).filter(Boolean);
  const home = homedir();
  const extraDirs = isWin
    ? [join(home, ".local", "bin")]
    : [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const names = isWin ? ["ego-browser.exe", "ego-browser.cmd", "ego-browser"] : ["ego-browser"];

  for (const dir of [...pathDirs, ...extraDirs]) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function normalizeSpaceEntry(raw: unknown): EgoTaskSpaceEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "number" || !Number.isFinite(r.id)) return null;
  const titles = Array.isArray(r.recentTabTitles)
    ? r.recentTabTitles.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim())
    : undefined;
  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : "",
    taskId: typeof r.taskId === "string" ? r.taskId : "",
    createdBy: typeof r.createdBy === "string" ? r.createdBy : "",
    ownership: typeof r.ownership === "string" ? r.ownership : "",
    ...(typeof r.profileId === "string" && r.profileId ? { profileId: r.profileId } : {}),
    ...(typeof r.profileName === "string" && r.profileName ? { profileName: r.profileName } : {}),
    ...(titles?.length ? { recentTabTitles: titles } : {}),
  };
}

/**
 * Queries `ego-browser` read-only (`listTaskSpaces()`) with per-server inflight coalescing and a short cache.
 */
export async function defaultQueryEgoTaskSpaces(
  serverName?: string,
  timeoutMs = 2400,
): Promise<EgoTaskSpaceEntry[]> {
  const key = serverName?.trim() || "__default__";
  const cached = spaceQueryCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < EGO_SPACE_QUERY_TTL_MS) {
    return cached.spaces;
  }
  const inflight = spaceQueryInflight.get(key);
  if (inflight) return inflight;

  const bin = resolveEgoBrowserBin();
  if (!bin) return [];

  const args = [
    ...(serverName?.trim() ? [`--ego-server-name=${serverName.trim()}`] : []),
    "nodejs",
    "-e",
    "console.log(JSON.stringify(await listTaskSpaces()))",
  ];

  const promise = new Promise<EgoTaskSpaceEntry[]>((resolveQuery) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: "utf8", windowsHide: true }, (err, stdout) => {
      if (err || !stdout) {
        resolveQuery([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as unknown;
        if (!Array.isArray(parsed)) {
          resolveQuery([]);
          return;
        }
        const spaces = parsed.map(normalizeSpaceEntry).filter((x): x is EgoTaskSpaceEntry => Boolean(x));
        spaceQueryCache.set(key, { at: Date.now(), spaces });
        resolveQuery(spaces);
      } catch {
        resolveQuery([]);
      }
    });
  }).finally(() => {
    spaceQueryInflight.delete(key);
  });

  spaceQueryInflight.set(key, promise);
  return promise;
}

/** Maps Ego Lite `ownership` state (plus an optional `handOff()` hint) into a normalized phase badge. */
export function ownershipToEgoPhase(ownership?: string, handoffHint?: boolean): EgoSpacePhase {
  if (handoffHint || ownership === "agentDelegatedToUser") return "handoff";
  if (ownership === "user") return "user";
  return "running";
}

function normalizeTitleToken(s?: string): string {
  return (s ?? "").trim().toLowerCase();
}

function windowMatchesAnyToken(winTitleLower: string, tokens: string[]): boolean {
  if (!winTitleLower) return false;
  return tokens.some((tok) => tok.length >= 2 && winTitleLower.includes(tok));
}

/**
 * Selects only the OS window belonging to the target Ego Lite TaskSpace.
 * Never returns a user's personal Space window when titles distinguish spaces.
 */
export function selectMatchingEgoSpaceWindow(
  wins: RemoteWindowInfo[],
  target: EgoWindowMatchTarget,
  allSpaces: EgoTaskSpaceEntry[],
): RemoteWindowInfo | undefined {
  const egoWins = wins.filter(
    (w) =>
      !w.isScreen &&
      /ego\s*lite/i.test(w.appName) &&
      (w.bounds?.width ?? 200) >= 140 &&
      (w.bounds?.height ?? 200) >= 100,
  );
  if (egoWins.length === 0) return undefined;

  const targetName = normalizeTitleToken(target.spaceName);
  const myTitleSet = new Set<string>();
  for (const raw of [target.spaceName, target.activeTabTitle, ...(target.recentTabTitles ?? [])]) {
    const norm = normalizeTitleToken(raw);
    if (norm.length >= 2 && norm !== "新标签页" && norm !== "new tab") {
      myTitleSet.add(norm);
    }
  }
  const myTabTitles: string[] = [];
  for (const raw of [target.activeTabTitle, ...(target.recentTabTitles ?? [])]) {
    const norm = normalizeTitleToken(raw);
    if (norm.length >= 2 && norm !== "新标签页" && norm !== "new tab") {
      myTabTitles.push(norm);
    }
  }

  const otherExclusiveTitles: string[] = [];
  for (const s of allSpaces) {
    const isOther =
      target.spaceId !== undefined
        ? s.id !== target.spaceId
        : s.createdBy === "user" || (Boolean(targetName) && normalizeTitleToken(s.name) !== targetName);
    if (!isOther) continue;
    for (const raw of [s.name, ...(s.recentTabTitles ?? [])]) {
      const norm = normalizeTitleToken(raw);
      if (norm.length >= 2 && !myTitleSet.has(norm) && norm !== "新标签页" && norm !== "new tab") {
        otherExclusiveTitles.push(norm);
      }
    }
  }

  // Priority 1: explicit Space name in OS window title.
  if (targetName.length >= 2) {
    const bySpaceName = egoWins.find((w) => w.title.toLowerCase().includes(targetName));
    if (bySpaceName) return bySpaceName;
  }

  // Priority 2: active or recent tab title inside the target Space.
  if (myTabTitles.length > 0) {
    const byTabTitle = egoWins.find((w) => windowMatchesAnyToken(w.title.toLowerCase(), myTabTitles));
    if (byTabTitle) return byTabTitle;
  }

  // Priority 3: untitled/generic "ego lite" window or single non-conflicting Ego Lite window.
  // Never hijack an existing user/other-space browser window when multiple spaces exist or a named
  // TaskSpace / specific tab title was requested but has not appeared in any OS window title yet.
  const hasOtherSpaces = allSpaces.some((s) =>
    target.spaceId !== undefined
      ? s.id !== target.spaceId
      : s.createdBy === "user" || (Boolean(targetName) && normalizeTitleToken(s.name) !== targetName),
  );
  const eligible = egoWins.filter((w) => !windowMatchesAnyToken(w.title.toLowerCase(), otherExclusiveTitles));
  const genericSingle = eligible.filter((w) => {
    const wt = normalizeTitleToken(w.title);
    return wt === "ego lite" || wt === "";
  });
  if (genericSingle.length === 1 && !hasOtherSpaces) {
    return genericSingle[0];
  }
  if (egoWins.length === 1 && eligible.length === 1 && !hasOtherSpaces && !targetName && myTabTitles.length === 0) {
    return eligible[0];
  }
  return undefined;
}
