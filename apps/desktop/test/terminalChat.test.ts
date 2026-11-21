import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTerminalChatTranscript, shellTurnMatchesCommand } from "../src/lib/terminalChat.ts";

test("parseTerminalChatTranscript parses zsh commands, empty ls outputs, and multi-line output", () => {
  const raw = [
    "\x1b[32muser@macbook\x1b[0m ~/tmp % pwd",
    "/Users/demo/tmp",
    "user@macbook ~/tmp % ls",
    "user@macbook ~/tmp % git status -s",
    " M src/app.ts",
    "?? src/new.ts",
    "user@macbook ~/tmp % ",
  ].join("\n");

  const parsed = parseTerminalChatTranscript(raw);
  assert.equal(parsed.turns.length, 3);
  assert.equal(parsed.turns[0]?.command, "pwd");
  assert.deepEqual(parsed.turns[0]?.outputLines, ["/Users/demo/tmp"]);
  assert.equal(parsed.turns[0]?.completedEmpty, false);
  assert.equal(parsed.turns[0]?.hasNextPrompt, true);

  assert.equal(parsed.turns[1]?.command, "ls");
  assert.deepEqual(parsed.turns[1]?.outputLines, []);
  assert.equal(parsed.turns[1]?.completedEmpty, true);
  assert.equal(parsed.turns[1]?.hasNextPrompt, true);

  assert.equal(parsed.turns[2]?.command, "git status -s");
  assert.deepEqual(parsed.turns[2]?.outputLines, [" M src/app.ts", "?? src/new.ts"]);
  assert.equal(parsed.turns[2]?.hasNextPrompt, true);
  assert.equal(parsed.currentPrompt, "user@macbook ~/tmp %");

  assert.equal(shellTurnMatchesCommand(parsed.turns[1]!, "ls"), true);
});
