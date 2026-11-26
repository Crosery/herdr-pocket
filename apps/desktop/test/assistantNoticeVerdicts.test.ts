import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) {
      return { format: "module", shortCircuit: true, source: "export default '';" };
    }
    if ((url.endsWith(".tsx") || url.endsWith(".ts")) && !url.includes("/node_modules/") && !url.endsWith("assistantNoticeVerdicts.test.ts")) {
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

const { AlertTriangle, Bell, CheckCircle2, Flag, Hand, Moon, PauseCircle, Sparkles } = await import("lucide-react");
const { noticeBadgeVisual } = await import("../src/views/AssistantView.tsx");

test("noticeBadgeVisual separates all 7 notice verdicts and restricts blush warning to failed", () => {
  const cases = [
    { input: { kind: "done" as const, verdict: "ok" as const }, tone: "mint", pulse: false, icon: CheckCircle2 },
    { input: { kind: "done" as const, verdict: "running" as const }, tone: "sky", pulse: true, icon: Sparkles },
    { input: { kind: "done" as const, verdict: "progress" as const }, tone: "pink", pulse: false, icon: Flag },
    { input: { kind: "blocked" as const, verdict: "decide" as const }, tone: "warn", pulse: false, icon: Hand },
    { input: { kind: "done" as const, verdict: "paused" as const }, tone: "lav", pulse: false, icon: Moon },
    { input: { kind: "done" as const, verdict: "stopped" as const }, tone: "neutral", pulse: false, icon: PauseCircle },
    { input: { kind: "done" as const, verdict: "failed" as const }, tone: "blush", pulse: false, icon: AlertTriangle },
  ];

  for (const c of cases) {
    const vis = noticeBadgeVisual(c.input);
    assert.equal(vis.tone, c.tone, `tone mismatch for verdict=${c.input.verdict}`);
    assert.equal(vis.pulse, c.pulse, `pulse mismatch for verdict=${c.input.verdict}`);
    assert.equal(vis.icon.type, c.icon, `icon mismatch for verdict=${c.input.verdict}`);
  }

  // Legacy notices without explicit verdict fall back without alarming red styling unless failed.
  assert.equal(noticeBadgeVisual({ kind: "blocked" }).tone, "warn");
  assert.equal(noticeBadgeVisual({ kind: "done" }).tone, "mint");
  const rem = noticeBadgeVisual({ kind: "reminder" });
  assert.equal(rem.tone, "lav");
  assert.equal(rem.icon.type, Bell);
});
