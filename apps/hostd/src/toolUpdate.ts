import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareVersions,
  type HostToolId,
  type HostTools,
  type ToolUpdateItemResult,
  type ToolUpdateJobSnapshot,
} from "@herdr-pocket/protocol";
import { VERSION, extractTarGz } from "@herdr-pocket/update";
import { findPrograms, isHerdrWindowClosedError, NoDesktopApp } from "./create.ts";
import { defaultHcBin } from "./platform.ts";
import { herdrAppPlaces, herdrAppVersion, releasesUrl } from "./upstream.ts";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface AppLatestTarget {
  url: string;
  sha256: string;
}

export interface AppLatestManifest {
  version: string;
  targets?: Record<string, AppLatestTarget>;
}

export interface ToolUpdateDeps {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  hostVersion?: string;
  runCmd?: (cmd: string, args: string[], timeoutMs: number) => Promise<ExecResult>;
  fetchText?: (url: string, timeoutMs: number) => Promise<string>;
  fetchBytes?: (url: string, timeoutMs: number) => Promise<Buffer>;
  findPrograms?: (names: string[]) => Promise<Map<string, string>>;
  hcBin?: () => string;
  hc?: {
    version?: string;
    available: () => Promise<boolean>;
    hello: () => Promise<{ version?: string; generation?: number } | undefined>;
  };
  app?: {
    ls: () => Promise<unknown>;
    command: (cmd: any, args: Record<string, unknown>) => Promise<unknown>;
  };
  herdrAppPlaces?: (platform?: NodeJS.Platform, home?: string, env?: NodeJS.ProcessEnv) => string[];
  herdrAppVersion?: (places?: string[]) => Promise<string | undefined>;
  getTools: () => HostTools;
  setToolVersion: (id: "hc" | "herdr" | "uniflo" | "app", version: string | undefined) => void;
  setLatestVersion: (id: "hc" | "herdr" | "uniflo" | "app" | "hostd", version: string | undefined) => void;
  refreshUpstream: () => Promise<void>;
  getToolBin: (id: "herdr" | "uniflo") => string | undefined;
  setToolBin: (id: "herdr" | "uniflo", bin: string) => void;
  updateHostd?: () => Promise<ToolUpdateItemResult>;
  log?: (msg: string) => void;
}

const bareVer = (raw: string | undefined): string => {
  if (!raw) return "";
  return raw.match(/\d+(?:\.\d+)+(?:-[\w.]+)?/)?.[0] ?? raw.trim().replace(/^v/i, "");
};

async function defaultRunCmd(cmd: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout: stdout ?? "", stderr: stderr ?? "" });
          return;
        }
        const code = (err as { code?: unknown }).code;
        if (typeof code === "number" && !(err as { killed?: boolean }).killed) {
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
        } else {
          reject(err);
        }
      },
    );
  });
}

export function formatFetchError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /aborted due to timeout|timed out|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(msg)
  ) {
    return "连接上游更新源超时，请稍后重试";
  }
  return msg || "网络请求失败";
}

function isRetryableFetchError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    /aborted due to timeout|timed out|HTTP 5\d\d|ECONNRESET|ECONNREFUSED|ENOTFOUND|UND_ERR|fetch failed/i.test(msg)
  );
}

async function defaultFetchText(url: string, timeoutMs: number): Promise<string> {
  if (url.startsWith("file:")) {
    const { readFile } = await import("node:fs/promises");
    return readFile(fileURLToPath(url), "utf8");
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "herdr-pocket-hostd" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isRetryableFetchError(err)) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      break;
    }
  }
  throw new Error(formatFetchError(lastErr));
}

async function defaultFetchBytes(url: string, timeoutMs: number): Promise<Buffer> {
  if (url.startsWith("file:")) {
    const { readFile } = await import("node:fs/promises");
    return readFile(fileURLToPath(url));
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "User-Agent": "herdr-pocket-hostd" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && isRetryableFetchError(err)) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      break;
    }
  }
  throw new Error(formatFetchError(lastErr));
}

async function defaultUpdateHostd(): Promise<ToolUpdateItemResult> {
  const fromVersion = VERSION;
  try {
    const bin = process.execPath;
    const script = process.argv[1];
    if (!script) throw new Error("找不到当前后台服务入口脚本");
    const child = spawn(bin, [script, "update"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return {
      id: "hostd",
      ok: true,
      status: "restarting",
      fromVersion,
      message: "已启动后台服务自更新，完成后将自动重连",
    };
  } catch (e) {
    return {
      id: "hostd",
      ok: false,
      status: "failed",
      fromVersion,
      message: (e as Error).message || "启动后台自更新失败",
    };
  }
}

function selectAppTarget(
  manifest: AppLatestManifest,
  plat: NodeJS.Platform,
  arch: string,
): { key: string; target: AppLatestTarget } | null {
  const targets = manifest.targets;
  if (!targets || typeof targets !== "object") return null;
  const order: string[] =
    plat === "darwin"
      ? arch === "x64"
        ? ["macos-x86_64", "macos-aarch64"]
        : ["macos-aarch64", "macos-x86_64"]
      : plat === "win32"
        ? arch === "arm64"
          ? ["windows-aarch64", "windows-x86_64"]
          : ["windows-x86_64", "windows-aarch64"]
        : arch === "arm64"
          ? ["linux-aarch64", "linux-x86_64"]
          : ["linux-x86_64", "linux-aarch64"];
  for (const key of order) {
    const t = targets[key];
    if (t && typeof t.url === "string" && typeof t.sha256 === "string" && t.url && t.sha256) {
      return { key, target: t };
    }
  }
  return null;
}

function findExtractedItem(root: string, predicate: (name: string, full: string) => boolean, maxDepth = 4): string | null {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = join(cur.dir, ent.name);
      if (predicate(ent.name, full)) return full;
      if (ent.isDirectory() && cur.depth + 1 <= maxDepth) {
        queue.push({ dir: full, depth: cur.depth + 1 });
      }
    }
  }
  return null;
}

function canWriteTarget(targetPath: string): boolean {
  try {
    if (existsSync(targetPath)) {
      accessSync(targetPath, constants.W_OK);
    }
    accessSync(dirname(targetPath), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export class ToolUpdateManager {
  private deps: ToolUpdateDeps;
  private activeJob: {
    snapshot: ToolUpdateJobSnapshot;
    donePromise: Promise<ToolUpdateJobSnapshot>;
  } | null = null;

  constructor(deps: ToolUpdateDeps) {
    this.deps = deps;
  }

  getStatus(jobId?: string): ToolUpdateJobSnapshot | null {
    if (!this.activeJob) return null;
    if (jobId && this.activeJob.snapshot.jobId !== jobId) return this.activeJob.snapshot;
    return this.cloneSnapshot(this.activeJob.snapshot);
  }

  async checkNow(): Promise<{ tools: HostTools; hostVersion: string }> {
    await this.deps.refreshUpstream();
    return {
      tools: this.deps.getTools(),
      hostVersion: this.deps.hostVersion ?? VERSION,
    };
  }

  async startOrJoinUpdate(opts: { targets?: HostToolId[]; waitMs?: number } = {}): Promise<ToolUpdateJobSnapshot> {
    if (this.activeJob?.snapshot.running) {
      const wait = Math.min(Math.max(Number(opts.waitMs ?? 2000), 0), 25_000);
      if (wait > 0) {
        await Promise.race([this.activeJob.donePromise, new Promise((r) => setTimeout(r, wait))]);
      }
      return this.cloneSnapshot(this.activeJob.snapshot);
    }

    const now = this.deps.now ?? Date.now;
    const tools = this.deps.getTools();
    const validTargets: HostToolId[] = ["hc", "herdr", "app", "uniflo", "hostd"];
    const requested = Array.isArray(opts.targets) && opts.targets.length > 0
      ? opts.targets.filter((t): t is HostToolId => validTargets.includes(t))
      : (validTargets.filter((t) => t !== "hostd" && Boolean(tools[t])) as HostToolId[]);

    const dedupTargets = [...new Set(requested)];
    if (dedupTargets.length === 0) {
      return {
        jobId: `tu-${randomUUID().slice(0, 8)}`,
        running: false,
        targets: [],
        completed: [],
        tools,
        hostVersion: this.deps.hostVersion ?? VERSION,
        startedAt: now(),
        finishedAt: now(),
      };
    }

    // Move hostd last because updating hostd restarts this daemon process.
    dedupTargets.sort((a, b) => (a === "hostd" ? 1 : b === "hostd" ? -1 : 0));

    const snap: ToolUpdateJobSnapshot = {
      jobId: `tu-${randomUUID().slice(0, 8)}`,
      running: true,
      targets: dedupTargets,
      completed: [],
      current: dedupTargets[0],
      tools,
      hostVersion: this.deps.hostVersion ?? VERSION,
      startedAt: now(),
    };

    const donePromise = this.runJob(snap);
    this.activeJob = { snapshot: snap, donePromise };

    const waitMs = Math.min(Math.max(Number(opts.waitMs ?? 15_000), 0), 25_000);
    if (waitMs > 0) {
      await Promise.race([donePromise, new Promise((r) => setTimeout(r, waitMs))]);
    }
    return this.cloneSnapshot(snap);
  }

  private cloneSnapshot(snap: ToolUpdateJobSnapshot): ToolUpdateJobSnapshot {
    return {
      ...snap,
      targets: [...snap.targets],
      completed: snap.completed.map((c) => ({ ...c })),
      tools: this.deps.getTools(),
    };
  }

  private async runJob(snap: ToolUpdateJobSnapshot): Promise<ToolUpdateJobSnapshot> {
    const now = this.deps.now ?? Date.now;
    try {
      for (const target of snap.targets) {
        snap.current = target;
        let res: ToolUpdateItemResult;
        try {
          res = await this.updateOne(target);
        } catch (e) {
          res = {
            id: target,
            ok: false,
            status: "failed",
            message: (e as Error).message || `${target} 更新失败`,
          };
        }
        snap.completed.push(res);
        this.deps.log?.(`tool update ${target}: ${res.status} (${res.message})`);
      }
      await this.deps.refreshUpstream().catch(() => {});
      snap.tools = this.deps.getTools();
    } finally {
      snap.current = undefined;
      snap.running = false;
      snap.finishedAt = now();
    }
    return this.cloneSnapshot(snap);
  }

  private async resolveBin(id: "herdr" | "uniflo"): Promise<string> {
    const cached = this.deps.getToolBin(id);
    if (cached) return cached;
    const finder = this.deps.findPrograms ?? findPrograms;
    const found = await finder([id]);
    const bin = found.get(id) ?? id;
    this.deps.setToolBin(id, bin);
    return bin;
  }

  private async readCliVersion(bin: string, runCmd: NonNullable<ToolUpdateDeps["runCmd"]>): Promise<string | undefined> {
    try {
      const r = await runCmd(bin, ["--version"], 6000);
      if (r.code !== 0) return undefined;
      const ver = bareVer(r.stdout.trim() || r.stderr.trim());
      return ver || undefined;
    } catch {
      return undefined;
    }
  }

  async updateOne(id: HostToolId): Promise<ToolUpdateItemResult> {
    const runCmd = this.deps.runCmd ?? defaultRunCmd;
    const env = this.deps.env ?? process.env;
    const plat = this.deps.platform ?? process.platform;
    const arch = this.deps.arch ?? process.arch;
    const home = this.deps.home ?? homedir();
    const tools = this.deps.getTools();

    if (id === "hostd") {
      return (this.deps.updateHostd ?? defaultUpdateHostd)();
    }

    if (id === "hc") {
      const fromVersion = tools.hc;
      const hcBin = this.deps.hcBin?.() ?? defaultHcBin(env, plat === "win32");
      let ok = false;
      let errMsg = "";
      try {
        const res = await runCmd(hcBin, ["update", "--json"], 120_000);
        if (res.code === 0) {
          ok = true;
        } else {
          errMsg = (res.stderr || res.stdout || `exit ${res.code}`).trim().split("\n").pop() ?? `exit ${res.code}`;
        }
      } catch (e) {
        errMsg = (e as Error).message;
      }

      if (!ok && this.deps.app) {
        try {
          await this.deps.app.command("app.update_core", {});
          ok = true;
        } catch (e) {
          if (!(e instanceof NoDesktopApp) && !isHerdrWindowClosedError(e)) {
            errMsg = errMsg || (e as Error).message;
          }
        }
      }

      const hello = await this.deps.hc?.hello().catch(() => undefined);
      await this.deps.hc?.available().catch(() => false);
      const toVersion = hello?.version ?? this.deps.hc?.version ?? this.deps.getTools().hc;
      if (toVersion) {
        this.deps.setToolVersion("hc", toVersion);
        if (!ok && fromVersion && compareVersions(bareVer(toVersion), bareVer(fromVersion)) > 0) ok = true;
      }
      if (!ok) {
        return { id: "hc", ok: false, status: "failed", fromVersion, toVersion, message: errMsg || "hc 更新失败" };
      }
      const changed = Boolean(fromVersion && toVersion && compareVersions(bareVer(toVersion), bareVer(fromVersion)) > 0);
      return {
        id: "hc",
        ok: true,
        status: changed ? "updated" : "up_to_date",
        fromVersion,
        toVersion,
        message: changed ? `hc 已更新到 ${toVersion}（运行中的终端不受影响）` : `hc 已是最新 ${toVersion ?? ""}`.trim(),
      };
    }

    if (id === "herdr") {
      const fromVersion = tools.herdr;
      const bin = await this.resolveBin("herdr");
      const res = await runCmd(bin, ["update"], 120_000);
      if (res.code !== 0) {
        const msg = (res.stderr || res.stdout || `herdr update exited ${res.code}`).trim().split("\n").pop()!;
        return { id: "herdr", ok: false, status: "failed", fromVersion, message: msg };
      }
      const toVersion = (await this.readCliVersion(bin, runCmd)) ?? fromVersion;
      if (toVersion) {
        this.deps.setToolVersion("herdr", toVersion);
        this.deps.setLatestVersion("herdr", toVersion);
      }
      const changed = Boolean(fromVersion && toVersion && compareVersions(bareVer(toVersion), bareVer(fromVersion)) > 0);
      return {
        id: "herdr",
        ok: true,
        status: changed ? "updated" : "up_to_date",
        fromVersion,
        toVersion,
        message: changed ? `Herdr 终端已更新到 ${toVersion}` : `Herdr 终端已是最新 ${toVersion ?? ""}`.trim(),
      };
    }

    if (id === "uniflo") {
      const fromVersion = tools.uniflo;
      const bin = await this.resolveBin("uniflo");
      const res = await runCmd(bin, ["update"], 240_000);
      if (res.code !== 0) {
        const msg = (res.stderr || res.stdout || `uniflo update exited ${res.code}`).trim().split("\n").pop()!;
        return { id: "uniflo", ok: false, status: "failed", fromVersion, message: msg };
      }
      const toVersion = (await this.readCliVersion(bin, runCmd)) ?? fromVersion;
      if (toVersion) {
        this.deps.setToolVersion("uniflo", toVersion);
        this.deps.setLatestVersion("uniflo", toVersion);
      }
      const changed = Boolean(fromVersion && toVersion && compareVersions(bareVer(toVersion), bareVer(fromVersion)) > 0);
      return {
        id: "uniflo",
        ok: true,
        status: changed ? "updated" : "up_to_date",
        fromVersion,
        toVersion,
        message: changed ? `uniflo 已更新到 ${toVersion}` : `uniflo 已是最新 ${toVersion ?? ""}`.trim(),
      };
    }

    // "app" — Herdr 桌面版 across macOS, Linux, Windows
    return this.updateHerdrDesktopApp(plat, arch, env, home, tools.app, runCmd);
  }

  private async updateHerdrDesktopApp(
    plat: NodeJS.Platform,
    arch: string,
    env: NodeJS.ProcessEnv,
    home: string,
    fromVersion: string | undefined,
    runCmd: NonNullable<ToolUpdateDeps["runCmd"]>,
  ): Promise<ToolUpdateItemResult> {
    const fetchText = this.deps.fetchText ?? defaultFetchText;
    const fetchBytes = this.deps.fetchBytes ?? defaultFetchBytes;
    const getPlaces = this.deps.herdrAppPlaces ?? herdrAppPlaces;
    const readVer = this.deps.herdrAppVersion ?? herdrAppVersion;
    const places = getPlaces(plat, home, env);

    // 1) Try native in-app update when the Herdr desktop window is open.
    if (this.deps.app) {
      let windowOpen = false;
      try {
        await this.deps.app.ls();
        windowOpen = true;
      } catch {
        windowOpen = false;
      }
      if (windowOpen) {
        try {
          await this.deps.app.command("app.check_updates", {});
          await this.deps.app.command("app.update", {});
          for (let i = 0; i < 6; i += 1) {
            await new Promise((r) => setTimeout(r, 500));
            const next = await readVer(places);
            if (next && (!fromVersion || compareVersions(bareVer(next), bareVer(fromVersion)) > 0)) {
              this.deps.setToolVersion("app", next);
              return {
                id: "app",
                ok: true,
                status: "updated",
                fromVersion,
                toVersion: next,
                message: `Herdr 桌面版已更新到 ${next}`,
              };
            }
          }
        } catch {
          // Fall back to direct verified archive installation below.
        }
      }
    }

    // 2) Direct verified archive install from releases server (<releases>/app/latest.json)
    const base = releasesUrl(env);
    let manifest: AppLatestManifest;
    try {
      manifest = JSON.parse(await fetchText(`${base}/app/latest.json`, 15_000)) as AppLatestManifest;
    } catch (e) {
      return {
        id: "app",
        ok: false,
        status: "failed",
        fromVersion,
        message: `检查 Herdr 桌面版安装包失败：${formatFetchError(e)}`,
      };
    }

    const latestVersion = typeof manifest?.version === "string" ? manifest.version.trim() : "";
    if (!latestVersion) {
      return { id: "app", ok: false, status: "failed", fromVersion, message: "app/latest.json 缺少版本号" };
    }
    if (fromVersion && compareVersions(bareVer(latestVersion), bareVer(fromVersion)) <= 0) {
      return {
        id: "app",
        ok: true,
        status: "up_to_date",
        fromVersion,
        toVersion: fromVersion,
        message: `Herdr 桌面版已是最新 ${fromVersion}`,
      };
    }

    const picked = selectAppTarget(manifest, plat, arch);
    if (!picked) {
      return {
        id: "app",
        ok: false,
        status: "failed",
        fromVersion,
        message: `Herdr 桌面版暂未提供 ${plat}-${arch} 预编译包`,
      };
    }

    let bytes: Buffer;
    try {
      bytes = await fetchBytes(picked.target.url, 120_000);
    } catch (e) {
      return {
        id: "app",
        ok: false,
        status: "failed",
        fromVersion,
        message: `下载 Herdr 桌面版安装包失败：${formatFetchError(e)}`,
      };
    }
    const actualSha = createHash("sha256").update(bytes).digest("hex").toLowerCase();
    const expectedSha = picked.target.sha256.trim().toLowerCase();
    if (actualSha !== expectedSha) {
      return {
        id: "app",
        ok: false,
        status: "failed",
        fromVersion,
        message: `安装包 SHA-256 校验不匹配（期望 ${expectedSha.slice(0, 12)}，实际 ${actualSha.slice(0, 12)}）`,
      };
    }

    const stage = mkdtempSync(join(tmpdir(), "hp-herdr-app-"));
    try {
      const archivePath = join(stage, basename(picked.target.url.split("?")[0] || "app.tar.gz") || "app.tar.gz");
      writeFileSync(archivePath, bytes);
      const extractDir = join(stage, "out");
      mkdirSync(extractDir, { recursive: true });

      if (/\.zip$/i.test(archivePath)) {
        if (plat === "win32") {
          const r = await runCmd("powershell.exe", [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
          ], 60_000);
          if (r.code !== 0) throw new Error(r.stderr || "Expand-Archive 失败");
        } else {
          const r = await runCmd("unzip", ["-q", archivePath, "-d", extractDir], 60_000);
          if (r.code !== 0) throw new Error(r.stderr || "unzip 失败");
        }
      } else {
        extractTarGz(archivePath, extractDir, { strip: 0 });
      }

      if (plat === "darwin") {
        const extractedApp = findExtractedItem(extractDir, (name, full) => name.endsWith(".app") && statSync(full).isDirectory(), 3);
        if (!extractedApp) throw new Error("安装包内未找到 Herdr.app");
        const existingAppDirs = places.filter((p) => p.endsWith("Info.plist") && existsSync(p)).map((p) => dirname(dirname(p)));
        let destApp = existingAppDirs.find((d) => canWriteTarget(d)) ?? "";
        if (!destApp) {
          const systemApp = "/Applications/Herdr.app";
          const userApp = join(home, "Applications", "Herdr.app");
          destApp = canWriteTarget(systemApp) ? systemApp : userApp;
        }
        mkdirSync(dirname(destApp), { recursive: true });
        await runCmd("xattr", ["-dr", "com.apple.quarantine", extractedApp], 15_000).catch(() => {});
        const backup = `${destApp}.prev-${process.pid}`;
        rmSync(backup, { recursive: true, force: true });
        if (existsSync(destApp)) renameSync(destApp, backup);
        try {
          renameSync(extractedApp, destApp);
          rmSync(backup, { recursive: true, force: true });
        } catch (err) {
          if (existsSync(backup) && !existsSync(destApp)) renameSync(backup, destApp);
          throw err;
        }
      } else if (plat === "win32") {
        const extractedExe = findExtractedItem(extractDir, (name, full) => name.toLowerCase() === "herdr-app.exe" && statSync(full).isFile(), 3);
        if (!extractedExe) throw new Error("安装包内未找到 herdr-app.exe");
        const destExe = places[0] ?? join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "herdr-app", "herdr-app.exe");
        mkdirSync(dirname(destExe), { recursive: true });
        const oldExe = `${destExe}.old-${process.pid}`;
        rmSync(oldExe, { force: true });
        if (existsSync(destExe)) renameSync(destExe, oldExe);
        try {
          renameSync(extractedExe, destExe);
        } catch (err) {
          if (existsSync(oldExe) && !existsSync(destExe)) renameSync(oldExe, destExe);
          throw err;
        }
        rmSync(oldExe, { force: true });
      } else {
        const extractedBin = findExtractedItem(extractDir, (name, full) => (name === "herdr-app" || name === "Herdr") && statSync(full).isFile(), 3);
        if (!extractedBin) throw new Error("安装包内未找到 herdr-app 可执行文件");
        chmodSync(extractedBin, 0o755);
        const destBin = places[0] ?? join(env.XDG_DATA_HOME || join(home, ".local", "share"), "herdr-app", "herdr-app");
        mkdirSync(dirname(destBin), { recursive: true });
        const oldBin = `${destBin}.old-${process.pid}`;
        rmSync(oldBin, { force: true });
        if (existsSync(destBin)) renameSync(destBin, oldBin);
        try {
          renameSync(extractedBin, destBin);
          chmodSync(destBin, 0o755);
          rmSync(oldBin, { force: true });
        } catch (err) {
          if (existsSync(oldBin) && !existsSync(destBin)) renameSync(oldBin, destBin);
          throw err;
        }
      }

      const verifiedVersion = (await readVer(places)) ?? latestVersion;
      this.deps.setToolVersion("app", verifiedVersion);
      this.deps.setLatestVersion("app", verifiedVersion);
      return {
        id: "app",
        ok: true,
        status: "updated",
        fromVersion,
        toVersion: verifiedVersion,
        message: `Herdr 桌面版已更新到 ${verifiedVersion}`,
      };
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
}
