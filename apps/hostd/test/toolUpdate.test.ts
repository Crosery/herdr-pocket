import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import type { HostTools } from "@herdr-pocket/protocol";
import { Host } from "../src/host.ts";
import { ToolUpdateManager, type ToolUpdateDeps } from "../src/toolUpdate.ts";

/** Build a deterministic POSIX ustar .tar.gz archive purely in memory (cross-platform). */
function buildTarGz(files: Array<{ name: string; content: string | Buffer; mode?: number }>): Buffer {
  const blocks: Buffer[] = [];
  const seenDirs = new Set<string>();

  const writeOctal = (buf: Buffer, off: number, len: number, val: number) => {
    const s = val.toString(8).padStart(len - 1, "0");
    buf.write(s, off, len - 1, "ascii");
    buf[off + len - 1] = 0;
  };

  const makeHeader = (name: string, typeflag: "0" | "5", size: number, mode: number) => {
    const h = Buffer.alloc(512, 0);
    h.write(name, 0, Math.min(name.length, 100), "utf8");
    writeOctal(h, 100, 8, mode);
    writeOctal(h, 108, 8, 0);
    writeOctal(h, 116, 8, 0);
    writeOctal(h, 124, 12, size);
    writeOctal(h, 136, 12, Math.floor(Date.now() / 1000));
    h.fill(0x20, 148, 156);
    h.write(typeflag, 156, 1, "ascii");
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i]!;
    writeOctal(h, 148, 7, sum);
    h[155] = 0x20;
    return h;
  };

  const ensureDir = (dir: string) => {
    if (!dir || dir === ".") return;
    const parts = dir.split("/").filter(Boolean);
    let acc = "";
    for (const p of parts) {
      acc += `${p}/`;
      if (seenDirs.has(acc)) continue;
      seenDirs.add(acc);
      blocks.push(makeHeader(acc, "5", 0, 0o755));
    }
  };

  for (const f of files) {
    const rel = f.name.replace(/^\/+/, "");
    const d = dirname(rel);
    if (d && d !== ".") ensureDir(d);
    const data = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, "utf8");
    blocks.push(makeHeader(rel, "0", data.length, f.mode ?? 0o644));
    if (data.length > 0) {
      blocks.push(data);
      const rem = data.length % 512;
      if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function makeDeps(overrides: Partial<ToolUpdateDeps> = {}) {
  const tools: HostTools = { hc: "0.6.2", herdr: "0.6.2", uniflo: "1.2.0", app: "0.9.4", latest: {} };
  const bins = new Map<string, string>([
    ["herdr", "/mock/bin/herdr"],
    ["uniflo", "/mock/bin/uniflo"],
  ]);
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let refreshed = 0;
  const deps: ToolUpdateDeps = {
    platform: "darwin",
    arch: "arm64",
    env: {},
    home: tmpdir(),
    hostVersion: "0.2.25",
    getTools: () => ({ ...tools, latest: { ...tools.latest } }),
    setToolVersion: (id, v) => {
      if (v) tools[id] = v;
    },
    setLatestVersion: (id, v) => {
      tools.latest = { ...(tools.latest ?? {}), [id]: v };
    },
    refreshUpstream: async () => {
      refreshed += 1;
    },
    getToolBin: (id) => bins.get(id),
    setToolBin: (id, bin) => bins.set(id, bin),
    runCmd: async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: "", stderr: "" };
    },
    ...overrides,
  };
  return { mgr: new ToolUpdateManager(deps), tools, calls, getRefreshed: () => refreshed };
}

test("ToolUpdateManager updates hc via CLI and falls back to app.update_core", async () => {
  let hcVer = "0.6.2";
  const { mgr, calls } = makeDeps({
    hcBin: () => "/usr/local/bin/hc",
    hc: {
      version: "0.6.2",
      available: async () => true,
      hello: async () => ({ version: hcVer }),
    },
    runCmd: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "/usr/local/bin/hc" && args[0] === "update") {
        hcVer = "0.7.0";
        return { code: 0, stdout: '{"ok":true}', stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  });

  const res1 = await mgr.updateOne("hc");
  assert.equal(res1.ok, true);
  assert.equal(res1.status, "updated");
  assert.equal(res1.fromVersion, "0.6.2");
  assert.equal(res1.toVersion, "0.7.0");
  assert.deepEqual(calls[0], { cmd: "/usr/local/bin/hc", args: ["update", "--json"] });

  // Fallback path when `hc update` exits non-zero -> invokes `app.command("app.update_core")`
  let hcVer2 = "0.6.2";
  let coreCmdCalled = 0;
  const { mgr: mgr2 } = makeDeps({
    hcBin: () => "/missing/hc",
    runCmd: async () => ({ code: 1, stdout: "", stderr: "spawn ENOENT" }),
    app: {
      ls: async () => ({}),
      command: async (cmd) => {
        assert.equal(cmd, "app.update_core");
        coreCmdCalled += 1;
        hcVer2 = "0.7.1";
        return { ok: true };
      },
    },
    hc: {
      version: "0.6.2",
      available: async () => true,
      hello: async () => ({ version: hcVer2 }),
    },
  });
  const res2 = await mgr2.updateOne("hc");
  assert.equal(coreCmdCalled, 1);
  assert.equal(res2.ok, true);
  assert.equal(res2.status, "updated");
  assert.equal(res2.toVersion, "0.7.1");
});

test("ToolUpdateManager updates herdr and uniflo across darwin, linux, and win32", async () => {
  for (const plat of ["darwin", "linux", "win32"] as const) {
    let herdrVer = "0.6.2";
    let unifloVer = "1.2.0";
    const { mgr, tools } = makeDeps({
      platform: plat,
      runCmd: async (cmd, args) => {
        if (cmd.includes("herdr")) {
          if (args[0] === "update") herdrVer = "0.6.4";
          if (args[0] === "--version") return { code: 0, stdout: `herdr ${herdrVer}\n`, stderr: "" };
        }
        if (cmd.includes("uniflo")) {
          if (args[0] === "update") unifloVer = "1.3.2";
          if (args[0] === "--version") return { code: 0, stdout: `v${unifloVer}\n`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const rH = await mgr.updateOne("herdr");
    assert.equal(rH.ok, true);
    assert.equal(rH.status, "updated");
    assert.equal(rH.toVersion, "0.6.4");
    const rU = await mgr.updateOne("uniflo");
    assert.equal(rU.ok, true);
    assert.equal(rU.status, "updated");
    assert.equal(rU.toVersion, "1.3.2");
    assert.equal(tools.herdr, "0.6.4");
    assert.equal(tools.uniflo, "1.3.2");
  }
});

test("ToolUpdateManager verifies SHA-256 and atomically installs Herdr.app (darwin) & herdr-app (linux), rejecting tampered archives", async (t) => {
  const work = mkdtempSync(join(tmpdir(), "hp-tu-app-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));

  // 1) macOS Herdr.app verified install into isolated home/Applications
  const macHome = join(work, "mac-home");
  const existingPlist = join(macHome, "Applications", "Herdr.app", "Contents", "Info.plist");
  mkdirSync(dirname(existingPlist), { recursive: true });
  writeFileSync(existingPlist, "<plist>old-0.9.4</plist>");

  const macTar = buildTarGz([
    { name: "Herdr.app/Contents/Info.plist", content: "<plist>new-0.9.5</plist>" },
    { name: "Herdr.app/Contents/MacOS/Herdr", content: "#!/bin/sh\necho ok\n", mode: 0o755 },
  ]);
  const macSha = createHash("sha256").update(macTar).digest("hex");

  const { mgr: macMgr } = makeDeps({
    platform: "darwin",
    arch: "arm64",
    home: macHome,
    herdrAppPlaces: () => [existingPlist],
    herdrAppVersion: async (places) =>
      readFileSync(places?.[0] ?? existingPlist, "utf8").includes("new-0.9.5") ? "0.9.5" : "0.9.4",
    fetchText: async () =>
      JSON.stringify({
        version: "0.9.5",
        targets: { "macos-aarch64": { url: "https://pocket.example.com/herdr-darwin.tar.gz", sha256: macSha } },
      }),
    fetchBytes: async () => macTar,
  });

  const macRes = await macMgr.updateOne("app");
  assert.equal(macRes.ok, true);
  assert.equal(macRes.status, "updated");
  assert.equal(macRes.toVersion, "0.9.5");
  assert.equal(readFileSync(existingPlist, "utf8"), "<plist>new-0.9.5</plist>");

  // 2) Tampered SHA-256 rejection leaves existing binary intact
  const { mgr: badMgr } = makeDeps({
    platform: "darwin",
    arch: "arm64",
    home: macHome,
    herdrAppPlaces: () => [existingPlist],
    fetchText: async () =>
      JSON.stringify({
        version: "0.9.9",
        targets: { "macos-aarch64": { url: "https://pocket.example.com/bad.tar.gz", sha256: "0".repeat(64) } },
      }),
    fetchBytes: async () => macTar,
  });
  const badRes = await badMgr.updateOne("app");
  assert.equal(badRes.ok, false);
  assert.equal(badRes.status, "failed");
  assert.match(badRes.message, /SHA-256/);
  assert.equal(readFileSync(existingPlist, "utf8"), "<plist>new-0.9.5</plist>");

  // 3) Linux binary install with chmod 0755
  const linHome = join(work, "lin-home");
  const linDest = join(linHome, ".local", "share", "herdr-app", "herdr-app");
  mkdirSync(dirname(linDest), { recursive: true });
  writeFileSync(linDest, "old-bin");

  const linTar = buildTarGz([{ name: "bundle/herdr-app", content: "#!/bin/sh\necho 0.9.6\n", mode: 0o644 }]);
  const linSha = createHash("sha256").update(linTar).digest("hex");
  const { mgr: linMgr } = makeDeps({
    platform: "linux",
    arch: "x64",
    home: linHome,
    herdrAppPlaces: () => [linDest],
    herdrAppVersion: async () => "0.9.6",
    fetchText: async () =>
      JSON.stringify({
        version: "0.9.6",
        targets: { "linux-x86_64": { url: "https://pocket.example.com/herdr-linux.tar.gz", sha256: linSha } },
      }),
    fetchBytes: async () => linTar,
  });
  const linRes = await linMgr.updateOne("app");
  assert.equal(linRes.ok, true);
  assert.equal(linRes.toVersion, "0.9.6");
  assert.ok(existsSync(linDest));
  assert.equal(readFileSync(linDest, "utf8"), "#!/bin/sh\necho 0.9.6\n");
  if (process.platform !== "win32") {
    assert.equal(statSync(linDest).mode & 0o111, 0o111);
  }
});

test("ToolUpdateManager orders hostd last and exposes RPC tools.check / tools.update / tools.updateStatus", async () => {
  const executed: string[] = [];
  const { mgr, getRefreshed } = makeDeps({
    hc: { version: "0.6.2", available: async () => true, hello: async () => ({ version: "0.7.0" }) },
    runCmd: async (cmd, args) => {
      if (args[0] === "update" || args[0] === "update") executed.push(cmd.split("/").pop()!);
      return { code: 0, stdout: "", stderr: "" };
    },
    updateHostd: async () => {
      executed.push("hostd");
      return { id: "hostd", ok: true, status: "restarting", fromVersion: "0.2.24", message: "restarting" };
    },
  });

  const chk = await mgr.checkNow();
  assert.equal(chk.hostVersion, "0.2.25");
  assert.equal(getRefreshed(), 1);

  const job = await mgr.startOrJoinUpdate({ targets: ["hostd", "uniflo", "hc"], waitMs: 5000 });
  assert.equal(job.running, false);
  assert.deepEqual(job.targets, ["uniflo", "hc", "hostd"]);
  assert.equal(executed[executed.length - 1], "hostd");
  assert.equal(mgr.getStatus(job.jobId)?.jobId, job.jobId);

  // Verify Host wires tools.check and tools.updateStatus RPC handlers cleanly.
  const h = new Host({ config: { server: "http://127.0.0.1:9", token: "t", deviceId: "h1", name: "n" }, log: () => {} });
  try {
    const x = h as unknown as {
      handlers: Record<string, (p: unknown, from: string) => Promise<any>>;
      toolUpdater: ToolUpdateManager;
    };
    x.toolUpdater = mgr;
    const status = await x.handlers["tools.updateStatus"]!({ jobId: job.jobId }, "viewer1");
    assert.equal(status.jobId, job.jobId);
  } finally {
    await h.stop();
  }
});

test("updateApp returns clean Chinese timeout message when fetchBytes aborts with TimeoutError", async () => {
  const { mgr } = makeDeps({
    platform: "darwin",
    arch: "arm64",
    herdrAppVersion: async () => "0.1.0",
    fetchText: async () =>
      JSON.stringify({
        version: "0.9.9",
        targets: { "macos-aarch64": { url: "https://pocket.example.com/herdr.tar.gz", sha256: "a".repeat(64) } },
      }),
    fetchBytes: async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    },
  });

  const res = await mgr.updateOne("app");
  assert.equal(res.ok, false);
  assert.equal(res.status, "failed");
  assert.match(res.message, /连接上游更新源超时/);
  assert.ok(!/The operation was aborted due to timeout/.test(res.message));
});
