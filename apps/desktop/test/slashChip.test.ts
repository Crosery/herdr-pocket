import assert from "node:assert/strict";
import { test } from "node:test";
import type { SlashCommandItem } from "@herdr-pocket/protocol";
import {
  BUILTIN_SLASH,
  builtinSlashCommands,
  parseLeadingSlashToken,
} from "../src/lib/slashCommands.ts";

test("parseLeadingSlashToken recognizes /btw, /dev, /commit, /review and /skills... chips", () => {
  const known: SlashCommandItem[] = [
    ...builtinSlashCommands("claude-code"),
    { name: "/dev", description: "开发协作统一入口", category: "skill", source: "user", argHint: "[task]" },
  ];

  // Matches known command with trailing space and preserves rest
  const devMatch = parseLeadingSlashToken("/dev fix login flow", known);
  assert.ok(devMatch);
  assert.equal(devMatch.command.name, "/dev");
  assert.equal(devMatch.command.category, "skill");
  assert.equal(devMatch.rawToken, "/dev");
  assert.equal(devMatch.rest, "fix login flow");

  // Matches /btw with space or newline
  const btwSpace = parseLeadingSlashToken("/btw 为什么这步挂了？", known);
  assert.ok(btwSpace);
  assert.equal(btwSpace.command.name, "/btw");
  assert.equal(btwSpace.command.category, "skill");
  assert.equal(btwSpace.rest, "为什么这步挂了？");

  const btwNewline = parseLeadingSlashToken("/btw\n总结一下刚才改的文件", []);
  assert.ok(btwNewline);
  assert.equal(btwNewline.command.name, "/btw");
  assert.equal(btwNewline.rest, "总结一下刚才改的文件");

  // Empty trailing rest right after space still produces the chip
  const btwTrailingSpace = parseLeadingSlashToken("/btw ", []);
  assert.ok(btwTrailingSpace);
  assert.equal(btwTrailingSpace.command.name, "/btw");
  assert.equal(btwTrailingSpace.rest, "");

  // Falls back to BUILTIN_SLASH for commands from other harnesses (e.g. /commit, /review)
  const commitMatch = parseLeadingSlashToken("/commit only staged", []);
  assert.ok(commitMatch);
  assert.equal(commitMatch.command.name, "/commit");
  assert.equal(commitMatch.rest, "only staged");

  const reviewMatch = parseLeadingSlashToken("/review pr-42", []);
  assert.ok(reviewMatch);
  assert.equal(reviewMatch.command.name, "/review");
  assert.equal(reviewMatch.rest, "pr-42");

  // Case-insensitive match
  const upperMatch = parseLeadingSlashToken("/REVIEW check diff", []);
  assert.ok(upperMatch);
  assert.equal(upperMatch.command.name, "/review");
  assert.equal(upperMatch.rawToken, "/REVIEW");
  assert.equal(upperMatch.rest, "check diff");

  // Skill prefix fallback (/skills:... or /skill:...)
  const skillFallback = parseLeadingSlashToken("/skills:frontend-design make card", []);
  assert.ok(skillFallback);
  assert.equal(skillFallback.command.name, "/skills:frontend-design");
  assert.equal(skillFallback.command.category, "skill");
  assert.equal(skillFallback.rest, "make card");

  // Does NOT match while still typing without space/newline, mid-sentence, or Unix file paths
  assert.equal(parseLeadingSlashToken("/btw", known), null);
  assert.equal(parseLeadingSlashToken("hello /btw world", known), null);
  assert.equal(parseLeadingSlashToken("/Users/demo/work/example-project ", known), null);
  assert.equal(parseLeadingSlashToken("/unknown-non-command test", []), null);
});

test("/btw is discovered across major harnesses and BUILTIN_SLASH", () => {
  for (const harness of ["claude", "omp", "codex", "antigravity", "dsh", "grok", "codebuddy", "gemini", "pi", "hermes"]) {
    const cmds = builtinSlashCommands(harness);
    const btw = cmds.find((c) => c.name === "/btw");
    assert.ok(btw, `${harness} must include /btw`);
    assert.equal(btw.argHint, "<question>");
  }
  assert.ok(BUILTIN_SLASH.some((c) => c.name === "/btw"));
  assert.ok(BUILTIN_SLASH.some((c) => c.name === "/commit"));
  assert.ok(BUILTIN_SLASH.some((c) => c.name === "/review"));
});
