import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanAgentSlashCommands } from "../src/slash.ts";

test("scanAgentSlashCommands discovers project/user commands & skills across Claude, Antigravity, omp, minimax nested bundles, and hermes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-slash-"));
  const home = join(dir, "home");
  const cwd = join(dir, "proj");
  try {
    mkdirSync(join(cwd, ".claude/commands/ops"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude/commands/ops/deploy.md"),
      "---\ndescription: Deploy staging release\nargument-hint: <env>\n---\nSteps...",
    );
    mkdirSync(join(cwd, ".claude/skills/my-skill"), { recursive: true });
    writeFileSync(join(cwd, ".claude/skills/my-skill/SKILL.md"), "---\ndescription: Custom workflow skill\n---\n");

    mkdirSync(join(home, ".gemini/commands"), { recursive: true });
    writeFileSync(join(home, ".gemini/commands/review.toml"), 'description = "Code review helper"\nprompt = "Review"');
    mkdirSync(join(cwd, ".agent/workflows"), { recursive: true });
    writeFileSync(join(cwd, ".agent/workflows/ship.md"), "---\ndescription: Release checklist\n---\n");

    mkdirSync(join(home, ".omp/agent/skills/omp-helper"), { recursive: true });
    writeFileSync(join(home, ".omp/agent/skills/omp-helper/SKILL.md"), "---\ndescription: OMP managed skill\n---\n");

    mkdirSync(join(home, ".minimax/.builtin-skills/bundle-a/code-review"), { recursive: true });
    writeFileSync(join(home, ".minimax/.builtin-skills/bundle-a/code-review/SKILL.md"), "---\ndescription: Nested bundle review\n---\n");

    mkdirSync(join(home, ".hermes/skills/daily-sync"), { recursive: true });
    writeFileSync(join(home, ".hermes/skills/daily-sync/SKILL.md"), "---\ndescription: Hermes daily sync\n---\n");

    const claudeCmds = await scanAgentSlashCommands("claude-code", cwd, home);
    assert.ok(claudeCmds.some((c) => c.name === "/ops:deploy" && c.description === "Deploy staging release" && c.argHint === "<env>"));
    assert.ok(claudeCmds.some((c) => c.name === "/my-skill" && c.category === "skill"));

    const agyCmds = await scanAgentSlashCommands("antigravity", cwd, home);
    assert.ok(agyCmds.some((c) => c.name === "/review" && c.description === "Code review helper"));
    assert.ok(agyCmds.some((c) => c.name === "/ship" && c.description === "Release checklist"));

    const ompCmds = await scanAgentSlashCommands("omp", cwd, home);
    assert.ok(ompCmds.some((c) => c.name === "/omp-helper" && c.category === "skill" && c.source === "user"));

    const minimaxCmds = await scanAgentSlashCommands("minimax", cwd, home);
    assert.ok(minimaxCmds.some((c) => c.name === "/code-review" && c.description === "Nested bundle review"));

    const hermesCmds = await scanAgentSlashCommands("hermes", cwd, home);
    assert.ok(hermesCmds.some((c) => c.name === "/daily-sync" && c.description === "Hermes daily sync"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
