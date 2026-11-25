import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BrowserPluginError,
  getBrowserStatus,
  isAiBrowserEnabled,
  runBrowserAct,
  shutdownBrowserPluginCdp,
} from "../src/browserPlugin.ts";
import { normalizeWorktreeBranch } from "../src/create.ts";

test("AI browser plugin stays disabled by default with zero backend connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hp-browser-off-"));
  const cfgPath = join(dir, "config.json");
  try {
    writeFileSync(cfgPath, JSON.stringify({}), "utf8");
    assert.equal(isAiBrowserEnabled({ configPath: cfgPath }), false);

    const status = await getBrowserStatus({ configPath: cfgPath });
    assert.deepEqual(status, { enabled: false, backend: "none", spaces: [] });

    await assert.rejects(
      () => runBrowserAct({ op: "snapshot" }, { configPath: cfgPath }),
      (err: unknown) => err instanceof BrowserPluginError && err.code === "unsupported",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await shutdownBrowserPluginCdp();
  }
});

test("AI browser plugin forwards Bearer-authenticated status and act calls to local bridge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hp-browser-on-"));
  const bridgePath = join(dir, "browser-bridge.json");
  const expectedToken = "secret-bridge-token-test";
  const seenAuth: string[] = [];
  let postedBody: Record<string, unknown> = {};

  const srv = createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ""));
    if (req.headers.authorization !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/browser/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          enabled: true,
          backend: "desktop",
          activeSpaceId: "sp-work",
          spaces: [
            {
              id: "sp-work",
              name: "工作空间",
              kind: "user",
              ownership: "user",
              activePage: "p1",
              pages: [{ label: "p1", title: "Example", url: "https://example.com", active: true }],
            },
          ],
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/v1/browser/act") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        postedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            spaceId: "sp-work",
            page: "p1",
            url: "https://example.com",
            title: "Example",
            ownership: "agentWorking",
            snapshot: "@e1 button Submit",
          }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  try {
    const port = (srv.address() as AddressInfo).port;
    writeFileSync(bridgePath, JSON.stringify({ port, token: expectedToken }), "utf8");

    const status = await getBrowserStatus({ enabledOverride: true, bridgePath });
    assert.equal(status.enabled, true);
    assert.equal(status.backend, "desktop");
    assert.equal(status.activeSpaceId, "sp-work");
    assert.equal(status.spaces[0]?.pages[0]?.url, "https://example.com");

    const actRes = await runBrowserAct(
      { spaceId: "sp-work", op: "snapshot", label: "Inspect page" },
      { enabledOverride: true, bridgePath },
    );
    assert.equal(actRes.ok, true);
    assert.equal(actRes.ownership, "agentWorking");
    assert.equal(actRes.snapshot, "@e1 button Submit");
    assert.deepEqual(seenAuth, [`Bearer ${expectedToken}`, `Bearer ${expectedToken}`]);
    assert.equal(postedBody?.op, "snapshot");
    assert.equal(postedBody?.spaceId, "sp-work");
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    await shutdownBrowserPluginCdp();
  }
});

test("normalizeWorktreeBranch validates safe git branch names", () => {
  assert.equal(normalizeWorktreeBranch("  feat/login-ui "), "feat/login-ui");
  assert.equal(normalizeWorktreeBranch("fix_1.2"), "fix_1.2");

  for (const invalid of ["", "  ", "../escape", "--option", "feat.lock", "a//b", "foo@{1}", "has space"]) {
    assert.throws(() => normalizeWorktreeBranch(invalid), /Git 分支名称格式不对/);
  }
});
