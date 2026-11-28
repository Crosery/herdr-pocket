import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return { format: "module", shortCircuit: true, source: "export default '';" };
    }
    if ((url.endsWith(".tsx") || url.endsWith(".ts")) && !url.includes("/node_modules/") && !url.endsWith("markdownAndFiles.test.ts")) {
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

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { toolInputFilePath, toolInputSummary } = await import("../src/lib/chatFold.ts");
const { normalizeMarkdownText, RichMarkdown } = await import("../src/lib/markdown.tsx");
const { parseFileTarget } = await import("../src/lib/openFileTarget.ts");

test("normalizeMarkdownText rejoins hard-wrapped file:// links and strips leaked swarm board footer", () => {
  const input = [
    "• **[overview.html](file:///Users/demo/.gemini/antigravity-",
    "cli/brain/a1f764a6-81ca-4c79-a92f-dd19b1e430ca/overview.html)** — 架构总览",
    "• **[data-map.html](file:///Users/demo/.gemini/antigravity-",
    "cli/brain/a1f764a6-81ca-4c79-a92f-dd19b1e430ca/data-map.html)** — 数据流图",
    "",
    "Run /swarm board (or press Cmd/Ctrl+Shift+B) to inspect live worker status.",
  ].join("\n");

  const normalized = normalizeMarkdownText(input);
  assert.ok(
    normalized.includes(
      "**[overview.html](file:///Users/demo/.gemini/antigravity-cli/brain/a1f764a6-81ca-4c79-a92f-dd19b1e430ca/overview.html)**",
    ),
    `expected rejoined file URL, got:\n${normalized}`,
  );
  assert.ok(!normalized.includes("Run /swarm board"), "should strip leaked swarm board hint");
});

test("RichMarkdown renders bold file links, Unicode bullets, and bare absolute paths as clickable file links", () => {
  const sample = [
    "• **[overview.html](file:///Users/demo/.gemini/antigravity-",
    "cli/brain/a1f764a6/overview.html)** — 系统全貌",
    "◦ 详情见 /Users/demo/project/docs/design.md",
  ].join("\n");

  const html = renderToStaticMarkup(
    React.createElement(RichMarkdown, {
      text: sample,
      onOpenFile: () => true,
    }),
  );

  // Must parse Unicode bullets into actual `.md-li` list items (not raw "• " paragraph soup)
  assert.match(html, /class="md-li"/);
  assert.doesNotMatch(html, /•|◦/);
  // Bold markdown link must render as clickable link inside <strong> (not literal "[overview.html](file://...)")
  assert.doesNotMatch(html, /\[overview\.html\]/);
  assert.match(html, /<strong><a[^>]+class="md-file-link"[^>]*>overview\.html<\/a><\/strong>/);
  assert.match(html, /class="md-code md-file-chip"[^>]*>.*design\.md/);
});

test("toolInputFilePath preserves full file paths and strips accidental trailing quotes even on truncated JSON", () => {
  const fullPath =
    "/Users/demo/.gemini/antigravity-cli/brain/a1f764a6-81ca-4c79-a92f-dd19b1e430ca/ibuki-data-storage-map.html";

  assert.equal(toolInputFilePath({ Path: fullPath }), fullPath);
  assert.equal(toolInputFilePath({ path: `${fullPath}"` }), fullPath);
  const partialJson = `{"Path":"${fullPath}","Content":"<!doctype html>...`;
  assert.equal(toolInputFilePath(partialJson), fullPath);

  const summary = toolInputSummary({ Path: `${fullPath}"` }, "write_file");
  assert.ok(!summary.endsWith('"'), `summary should not keep trailing quote: ${summary}`);
});

test("parseFileTarget cleans quotes, zero-width chars, and embedded line breaks in file URLs", () => {
  const parsed = parseFileTarget(
    'file:///Users/demo/.gemini/antigravity-\ncli/brain/a1f764a6/report.html"',
    "/Users/demo/work",
  );
  assert.ok(parsed, "should parse wrapped file URL");
  assert.equal(parsed.absPath, "/Users/demo/.gemini/antigravity-cli/brain/a1f764a6/report.html");
  assert.equal(parsed.title, "report.html");
});
