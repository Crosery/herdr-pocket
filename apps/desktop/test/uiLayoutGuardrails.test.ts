import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return { format: "module", shortCircuit: true, source: "export default '';" };
    }
    if ((url.endsWith(".tsx") || url.endsWith(".ts")) && !url.includes("/node_modules/") && !url.endsWith("uiLayoutGuardrails.test.ts")) {
      const sourceText = readFileSync(fileURLToPath(url), "utf8");
      const out = ts.transpileModule(sourceText, {
        fileName: fileURLToPath(url),
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      });
      return { format: "module", shortCircuit: true, source: out.outputText };
    }
    return nextLoad(url, context);
  },
});

const { detectCodeLanguage, tokenizeCodeLines } = await import("../src/lib/syntaxHighlight.tsx");
const { fmtSubDuration, parseSubagentDisplay } = await import("../src/components/SubagentNav.tsx");
const { formatPortalDisplayTitle } = await import("../src/lib/portalClient.ts");
const { mergeTutorialStatus } = await import("../src/lib/store.ts");

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(TEST_DIR, "../src");

test("syntaxHighlight detects languages and tokenizes TS/JS/Python/JSON/CSS including multi-line comments and templates", () => {
  assert.equal(detectCodeLanguage(null, "src/index.tsx"), "ts");
  assert.equal(detectCodeLanguage(null, "scripts/build.py"), "py");
  assert.equal(detectCodeLanguage(null, "styles/tokens.css"), "css");
  assert.equal(detectCodeLanguage(null, "package.json"), "json");
  assert.equal(detectCodeLanguage(null, "Makefile"), "sh");
  assert.equal(detectCodeLanguage("rust", "foo.txt"), "rust");

  const tsLines = [
    "/* multi-line",
    " * comment block */",
    "export async function greet(name: string): Promise<number> {",
    "  const msg = `hello ${name}`;",
    "  return 42;",
    "}",
  ];
  const tsTokens = tokenizeCodeLines(tsLines, "ts");
  assert.equal(tsTokens.length, tsLines.length);
  assert.equal(tsTokens[0]?.every((t) => t.kind === "comment"), true);
  assert.equal(tsTokens[1]?.every((t) => t.kind === "comment"), true);
  assert.equal(tsTokens[2]?.some((t) => t.kind === "keyword" && t.text === "export"), true);
  assert.equal(tsTokens[2]?.some((t) => t.kind === "fn" && t.text === "greet"), true);
  assert.equal(tsTokens[2]?.some((t) => t.kind === "type" && t.text === "Promise"), true);
  assert.equal(tsTokens[3]?.some((t) => t.kind === "string"), true);
  assert.equal(tsTokens[4]?.some((t) => t.kind === "number" && t.text === "42"), true);
  // Exact round-trip fidelity: joining tokens reproduces every original line verbatim
  for (let i = 0; i < tsLines.length; i += 1) {
    assert.equal(tsTokens[i]?.map((t) => t.text).join(""), tsLines[i]);
  }

  const pyTokens = tokenizeCodeLines(["@decorator", "def fetch_items(limit: int = 10):", '    """doc"""', "    return True # ok"], "py");
  assert.equal(pyTokens[1]?.some((t) => t.kind === "keyword" && t.text === "def"), true);
  assert.equal(pyTokens[1]?.some((t) => t.kind === "fn" && t.text === "fetch_items"), true);
  assert.equal(pyTokens[3]?.some((t) => t.kind === "comment"), true);

  const jsonTokens = tokenizeCodeLines(['{ "name": "herdr-pocket", "version": 2, "ok": true }'], "json");
  assert.equal(jsonTokens[0]?.some((t) => t.kind === "prop" && t.text === '"name"'), true);
  assert.equal(jsonTokens[0]?.some((t) => t.kind === "string" && t.text === '"herdr-pocket"'), true);
  assert.equal(jsonTokens[0]?.some((t) => t.kind === "number" && t.text === "2"), true);
  assert.equal(jsonTokens[0]?.some((t) => t.kind === "keyword" && t.text === "true"), true);

  const cssTokens = tokenizeCodeLines([".btn-primary { color: #e2558d; padding: 12px; }"], "css");
  assert.equal(cssTokens[0]?.some((t) => t.kind === "prop" && t.text === "color"), true);
  assert.equal(cssTokens[0]?.some((t) => t.kind === "number"), true);
});

test("parseSubagentDisplay promotes preview headlines for generic role slugs and fmtSubDuration never fabricates 0秒", () => {
  const generic = parseSubagentDisplay({
    key: "sub-1",
    harness: "codex",
    title: "research",
    role: "research",
    preview: "[Message] timestamp=2026-11-26T12:00:00Z content=排查 WebSocket 断线重连根因",
  });
  assert.equal(generic.roleLabel, "调研");
  assert.equal(generic.headline, "排查 WebSocket 断线重连根因");

  const named = parseSubagentDisplay({
    key: "sub-2",
    harness: "codex",
    title: "校验类型定义",
    role: "review",
    preview: "完成契约审核",
  });
  assert.equal(named.roleLabel, "审核");
  assert.equal(named.headline, "校验类型定义");
  assert.equal(named.secondary, "完成契约审核");

  const now = 1_700_000_300_000;
  // Completed subagent without explicit startedAt where statusSince === updatedAt must NOT say "0秒"
  const idleNoStart = fmtSubDuration(
    {
      key: "sub-idle",
      parent: "p1",
      harness: "codex",
      status: "idle",
      statusSince: now - 120_000,
      updatedAt: now - 120_000,
      children: 0,
    },
    now,
  );
  assert.notEqual(idleNoStart, "0秒");
  assert.ok(idleNoStart && idleNoStart.length > 0);

  // Working subagent reports real elapsed time
  const running = fmtSubDuration(
    {
      key: "sub-run",
      parent: "p1",
      harness: "codex",
      status: "working",
      statusSince: now - 75_000,
      updatedAt: now,
      children: 0,
    },
    now,
  );
  assert.equal(running, "1分15秒");
});

test("formatPortalDisplayTitle compresses 260-char OAuth URLs cleanly and mergeTutorialStatus is monotonic", () => {
  const longOauth =
    "https://accounts.example.com/oauth2/authorize?response_type=code&client_id=pocket_desktop_998877665544&redirect_uri=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback&scope=openid+profile+email&state=abcdef1234567890abcdef1234567890&code_challenge=xyz1234567890";
  const formatted = formatPortalDisplayTitle({ kind: "browser", title: longOauth, url: longOauth });
  assert.equal(formatted.includes("accounts.example.com"), true);
  assert.equal(formatted.includes("登录授权"), true);
  assert.equal(formatted.length <= 44, true);

  assert.equal(mergeTutorialStatus(0, 0), 0);
  assert.equal(mergeTutorialStatus(0, 2), 2);
  assert.equal(mergeTutorialStatus(2, 0), 2);
  assert.equal(mergeTutorialStatus(1, 2), 2);
});

test("CSS layout and theme guardrails preserve responsive container queries, modal overflow protection, and light/dark syntax tokens", () => {
  const tokensCss = readFileSync(resolve(SRC_DIR, "styles/tokens.css"), "utf8");
  const appCss = readFileSync(resolve(SRC_DIR, "styles/app.css"), "utf8");
  const shellCss = readFileSync(resolve(SRC_DIR, "styles/shell.css"), "utf8");
  const chatToolsCss = readFileSync(resolve(SRC_DIR, "styles/chat-tools.css"), "utf8");
  const allCss = `${tokensCss}\n${appCss}\n${shellCss}\n${chatToolsCss}`;

  // Syntax highlight tokens exist in both light and dark themes
  const synMatches = tokensCss.match(/--syn-keyword\s*:/g) ?? [];
  assert.equal(synMatches.length >= 2, true, "tokens.css must define --syn-keyword in both Light and Dark themes");
  assert.equal(appCss.includes(".tok-keyword"), true);
  assert.equal(appCss.includes(".tok-comment"), true);

  // Container queries prevent overlap in narrow split panes
  assert.equal(allCss.includes("container-name: composer"), true);
  assert.equal(allCss.includes("@container composer"), true);
  assert.equal(allCss.includes("container-name: panehead"), true);
  assert.equal(allCss.includes("@container panehead"), true);
  assert.equal(allCss.includes("container-name: usagecard"), true);
  assert.equal(allCss.includes("@container usagecard"), true);

  // Modal header protects close button from long URL titles
  assert.equal(appCss.includes(".pk-dialog-head-copy"), true);
  assert.equal(/\.pk-dialog-head-copy\s*\{[^}]*min-width:\s*0/.test(appCss), true);

  // Collapsed floating PiP stays fixed and compact
  const collapsedPip = /\.session-portal-pip\.is-collapsed\s*\{[^}]*\}/.exec(appCss)?.[0] ?? "";
  assert.equal(/max-width:\s*(?:min\(\s*)?(?:2[0-7]\d|280)px/.test(collapsedPip), true, "collapsed PiP max-width must stay <= 280px");
});
