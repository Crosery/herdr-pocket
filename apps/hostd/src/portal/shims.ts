import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { PortalKind } from "@herdr-pocket/protocol";
import { stateDir } from "@herdr-pocket/update";

export interface HookOpenPayload {
  tool: string;
  argv: string[];
  cwd?: string;
  terminalId?: string;
  ppid?: number;
  kind?: PortalKind;
  target?: string;
  app?: string;
  reveal?: boolean;
}

export interface ParsedOpenInvocation {
  kind: PortalKind;
  target: string;
  reveal: boolean;
  app?: string;
  url?: string;
}

export function classifyTarget(rawTarget: string, opts: { reveal?: boolean; isDir?: boolean; cwd?: string } = {}): ParsedOpenInvocation {
  let target = rawTarget.trim().replace(/^["']|["']$/g, "");
  if (opts.reveal) {
    const resolved = !/^https?:/i.test(target) && opts.cwd && !isAbsolute(target) ? resolve(opts.cwd, target) : target;
    return { kind: "reveal", target: resolved, reveal: true };
  }
  if (/^https?:\/\//i.test(target)) {
    return { kind: "browser", target, url: target, reveal: false };
  }
  if (/^file:\/\//i.test(target)) {
    target = decodeURIComponent(target.replace(/^file:\/+(?:localhost\/)?/i, process.platform === "win32" ? "" : "/"));
  }
  if (target === "~" || target.startsWith("~/") || target.startsWith("~\\")) {
    target = join(homedir(), target.slice(2));
  }
  const abs = opts.cwd && !isAbsolute(target) ? resolve(opts.cwd, target) : target;
  if (opts.isDir) {
    return { kind: "reveal", target: abs, reveal: false };
  }
  if (/\.html?$/i.test(abs)) {
    return { kind: "html", target: abs, reveal: false };
  }
  return { kind: "file", target: abs, reveal: false };
}

export function parseOpenerArgs(tool: string, argv: string[], cwd?: string): ParsedOpenInvocation | null {
  const cleanTool = tool.toLowerCase().replace(/\.(exe|cmd|bat|sh)$/i, "");
  let reveal = false;
  let app: string | undefined;
  let rest = [...argv];

  if (cleanTool === "gio") {
    if (rest[0] !== "open") return null;
    rest = rest.slice(1);
  }

  let rawTarget = "";
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (cleanTool === "open") {
      if (a === "-R") {
        reveal = true;
        continue;
      }
      if (a === "-a" || a === "-b") {
        app = rest[++i];
        continue;
      }
      if (a === "--args") break;
      if (a.startsWith("-")) continue;
      rawTarget = a;
      break;
    }
    if (cleanTool === "explorer" || cleanTool === "explorer.exe") {
      if (/^\/select,/i.test(a)) {
        reveal = true;
        rawTarget = a.slice("/select,".length).replace(/^["']|["']$/g, "");
        break;
      }
      if (a.startsWith("/")) continue;
      rawTarget = a;
      break;
    }
    if (a.startsWith("-")) continue;
    rawTarget = a;
    break;
  }

  if (!rawTarget) return null;
  const parsed = classifyTarget(rawTarget, { reveal, cwd });
  return app ? { ...parsed, app } : parsed;
}

export function hookFilePath(dir = stateDir()): string {
  return join(dir, "portal-hook.json");
}

export function shimsDirPath(dir = stateDir()): string {
  return join(dir, "portal-shims");
}

export function readHookConfig(dir = stateDir()): { port: number; secret: string } | null {
  try {
    const raw = JSON.parse(readFileSync(hookFilePath(dir), "utf8")) as { port?: number; secret?: string };
    if (typeof raw.port === "number" && typeof raw.secret === "string" && raw.port > 0 && raw.secret) {
      return { port: raw.port, secret: raw.secret };
    }
  } catch {
    // not running
  }
  return null;
}

const SHIM_RUNNER_JS = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const tool = process.argv[2] || "open";
const args = process.argv.slice(3);
const stateDir = process.env.HERDR_POCKET_STATE || path.dirname(path.dirname(__filename));
const hookPath = path.join(stateDir, "portal-hook.json");

function fallbackReal() {
  if (tool === "herdr-pocket-browser") process.exit(0);
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const selfDir = path.dirname(__filename);
  const candidates = dirs.filter((d) => path.resolve(d) !== path.resolve(selfDir));
  const defaults = process.platform === "darwin" ? ["/usr/bin"] : ["/usr/bin", "/bin"];
  for (const d of [...candidates, ...defaults]) {
    const bin = path.join(d, tool);
    if (fs.existsSync(bin)) {
      const r = spawnSync(bin, args, { stdio: "inherit" });
      process.exit(r.status ?? 0);
    }
  }
  process.exit(0);
}

(async () => {
  try {
    const hook = JSON.parse(fs.readFileSync(hookPath, "utf8"));
    const res = await fetch(\`http://127.0.0.1:\${hook.port}/open\`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-portal-secret": hook.secret },
      body: JSON.stringify({
        tool,
        argv: args,
        cwd: process.cwd(),
        terminalId: process.env.HERDR_POCKET_TERMINAL || undefined,
        ppid: process.ppid,
      }),
      signal: AbortSignal.timeout(1500),
    });
    const j = await res.json();
    if (j && j.handled) process.exit(0);
  } catch {}
  fallbackReal();
})();
`;

export function ensurePortalShims(dir = stateDir()): { shimsDir: string; browserShim: string; execWrapper?: string } {
  const shimsDir = shimsDirPath(dir);
  mkdirSync(shimsDir, { recursive: true });
  const runner = join(shimsDir, "portal-open.cjs");
  writeFileSync(runner, SHIM_RUNNER_JS, { mode: 0o755 });
  chmodSync(runner, 0o755);

  const nodeBin = process.execPath;
  const tools = ["open", "xdg-open", "gio", "sensible-browser", "wslview", "herdr-pocket-open", "herdr-pocket-browser"];
  if (process.platform === "win32") {
    for (const t of tools) {
      const cmd = join(shimsDir, `${t}.cmd`);
      writeFileSync(cmd, `@echo off\r\n"${nodeBin}" "${runner}" ${t} %*\r\n`);
    }
    return { shimsDir, browserShim: join(shimsDir, "herdr-pocket-browser.cmd") };
  }

  for (const t of tools) {
    const sh = join(shimsDir, t);
    writeFileSync(sh, `#!/bin/sh\nexec "${nodeBin}" "${runner}" ${t} "$@"\n`, { mode: 0o755 });
    chmodSync(sh, 0o755);
  }
  const browserShim = join(shimsDir, "herdr-pocket-browser");
  const execWrapper = join(shimsDir, "herdr-pocket-exec");
  writeFileSync(
    execWrapper,
    `#!/bin/sh\nexport PATH="${shimsDir}:$PATH"\nexport BROWSER="${browserShim}"\nexport HERDR_POCKET_STATE="${dir}"\nexec "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(execWrapper, 0o755);
  return { shimsDir, browserShim, execWrapper };
}

export class PortalHookServer {
  private server: Server | null = null;
  private dir: string;
  private secret: string;
  private onOpen: (payload: HookOpenPayload) => Promise<{ handled: boolean; id?: string }>;
  port = 0;

  constructor(opts: {
    dir?: string;
    secret: string;
    onOpen: (payload: HookOpenPayload) => Promise<{ handled: boolean; id?: string }>;
  }) {
    this.dir = opts.dir ?? stateDir();
    this.secret = opts.secret;
    this.onOpen = opts.onOpen;
  }

  async start(): Promise<number> {
    mkdirSync(this.dir, { recursive: true });
    const srv = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/open") {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (req.headers["x-portal-secret"] !== this.secret) {
        res.statusCode = 401;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let payload: HookOpenPayload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookOpenPayload;
        } catch {
          res.statusCode = 400;
          res.end();
          return;
        }
        void this.onOpen(payload)
          .then((result) => {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(result));
          })
          .catch(() => {
            res.statusCode = 500;
            res.end();
          });
      });
    });

    const port = await new Promise<number>((resolvePort, reject) => {
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address() as { port: number } | null;
        resolvePort(addr?.port ?? 0);
      });
    });
    this.server = srv;
    this.port = port;
    writeFileSync(hookFilePath(this.dir), JSON.stringify({ port, secret: this.secret, pid: process.pid }), { mode: 0o600 });
    return port;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    rmSync(hookFilePath(this.dir), { force: true });
  }
}
