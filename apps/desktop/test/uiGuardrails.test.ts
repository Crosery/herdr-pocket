import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const SRC_DIR = new URL("../src", import.meta.url).pathname;

const FORBIDDEN_PATTERNS: Array<{ name: string; re: RegExp; hint: string }> = [
  {
    name: "native <select> / <option>",
    re: /<(?:select|option)\b/,
    hint: "Use PocketSelect from src/components/PocketUI.tsx",
  },
  {
    name: "native <input type=checkbox|radio|range|color|date>",
    re: /<input\b[^>]*\btype\s*=\s*["'](?:checkbox|radio|range|color|date)["']/,
    hint: "Use PocketCheckbox / PocketSwitch or a styled button/primitive",
  },
  {
    name: "native window.confirm / alert / prompt",
    re: /\bwindow\.(?:confirm|alert|prompt)\s*\(/,
    hint: "Use PocketModal or inline .inline-alert confirmation bar",
  },
];

test("desktop UI guardrails: forbid raw native OS selects, checkboxes, and confirm dialogs", () => {
  const files = collectSourceFiles(SRC_DIR);
  assert.ok(files.length > 10, "expected desktop source files");
  const violations: string[] = [];

  for (const file of files) {
    const rel = file.slice(SRC_DIR.length + 1);
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const rule of FORBIDDEN_PATTERNS) {
        if (rule.re.test(line)) {
          violations.push(`${rel}:${i + 1} [${rule.name}] -> ${line.trim()} (${rule.hint})`);
        }
      }
    }
  }

  assert.deepEqual(violations, [], `Found forbidden native UI primitives:\n${violations.join("\n")}`);
});
