import test from "node:test";
import assert from "node:assert/strict";
import type { ConvEvent } from "@herdr-pocket/protocol";
import {
  buildAskQuestionDeck,
  extractTerminalChoicePrompt,
  normalizeChoiceLabel,
  parseAskQuestionInput,
  summarizeAskQuestionInput,
} from "../src/lib/askQuestion";

test("parseAskQuestionInput unwraps doubly JSON-encoded questions strings cleanly", () => {
  const rawInput = {
    questions: JSON.stringify([
      {
        header: "CLI Naming",
        question: "你希望主命令用哪一个短名称？",
        options: [
          {
            label: "(Recommended) chime — 清脆提醒 / 适时同步 (chime ls / chime send)",
            description: "与 Chitrail 同源且语义直白",
          },
          {
            label: "trail — 协作脉络与留痕 (trail ls / trail send)",
          },
          {
            label: "Write-in...",
          },
        ],
      },
      {
        question: "是否同步更新 ~/.gemini hooks？",
        options: ["(Recommended) 是，立即生效", "稍后手动配置"],
      },
    ]),
  };

  const parsed = parseAskQuestionInput(rawInput);
  assert.equal(parsed.questions.length, 2);
  assert.equal(parsed.questions[0]!.question, "你希望主命令用哪一个短名称？");
  assert.equal(parsed.questions[0]!.options[0]!.recommended, true);
  assert.equal(parsed.questions[0]!.options[0]!.title, "chime — 清脆提醒 / 适时同步 (chime ls / chime send)");
  assert.equal(parsed.questions[0]!.options[0]!.description, "与 Chitrail 同源且语义直白");
  assert.equal(parsed.questions[0]!.options[2]!.isWriteIn, true);
  assert.equal(parsed.questions[0]!.options[2]!.title, "自定义输入…");

  const summary = summarizeAskQuestionInput(rawInput);
  assert.equal(summary.includes("{"), false);
  assert.equal(summary.includes("["), false);
  assert.ok(summary.includes("你希望主命令用哪一个短名称？"));
  assert.ok(summary.includes("共 2 题"));
});

test("normalizeChoiceLabel extracts (Recommended) badges, em-dash descriptions, and write-in items", () => {
  const opt1 = normalizeChoiceLabel("1. (Recommended) chime — 清脆提醒 / 适时同步".replace(/^1\.\s+/, ""));
  assert.equal(opt1.recommended, true);
  assert.equal(opt1.title, "chime");
  assert.equal(opt1.description, "清脆提醒 / 适时同步");
  assert.equal(opt1.isWriteIn, false);

  const opt5 = normalizeChoiceLabel("Write-in...");
  assert.equal(opt5.isWriteIn, true);
  assert.equal(opt5.title, "自定义输入…");
});

test("extractTerminalChoicePrompt and buildAskQuestionDeck merge terminal menu with structured metadata", () => {
  const lines = [
    "确认下面两项后，我就把新名字落地：",
    "❯ 1. (Recommended) chime — 清脆提醒",
    "  2. trail — 协作脉络",
    "  3. Write-in...",
  ];
  assert.equal(extractTerminalChoicePrompt(lines), "确认下面两项后，我就把新名字落地：");

  const events: ConvEvent[] = [
    {
      id: "tc1",
      session: "s1",
      ts: 1000,
      kind: "tool_call",
      call_id: "c1",
      name: "ask_question",
      input: {
        questions: JSON.stringify([
          {
            header: "命名确认",
            question: "确认下面哪一个作为主 CLI 名称？",
            options: ["(Recommended) chime — 清脆提醒", "trail — 协作脉络", "Write-in..."],
          },
        ]),
      },
    },
  ];
  const deck = buildAskQuestionDeck({
    events,
    choiceLines: lines,
    choices: [
      { key: "1", label: "(Recommended) chime — 清脆提醒", selected: true },
      { key: "2", label: "trail — 协作脉络", selected: false },
      { key: "3", label: "Write-in...", selected: false },
    ],
  });
  assert.ok(deck);
  assert.equal(deck.question, "确认下面哪一个作为主 CLI 名称？");
  assert.equal(deck.entries[0]!.recommended, true);
  assert.equal(deck.entries[0]!.title, "chime");
  assert.equal(deck.entries[0]!.description, "清脆提醒");
  assert.equal(deck.entries[2]!.isWriteIn, true);
});

test("buildAskQuestionDeck falls back to structured options when terminal choices are absent and clears on user reply", () => {
  const events: ConvEvent[] = [
    {
      id: "tc2",
      session: "s1",
      ts: 1000,
      kind: "tool_call",
      call_id: "c2",
      name: "ask_question",
      input: {
        questions: JSON.stringify([
          {
            question: "选择发布渠道？",
            options: ["(Recommended) Stable — 默认通道", "Beta — 内测通道", "Write-in..."],
          },
        ]),
      },
    },
  ];
  const fallbackDeck = buildAskQuestionDeck({ events, choiceLines: [], choices: [] });
  assert.ok(fallbackDeck);
  assert.equal(fallbackDeck.fromStructuredTool, true);
  assert.equal(fallbackDeck.question, "选择发布渠道？");
  assert.equal(fallbackDeck.entries.length, 3);
  assert.equal(fallbackDeck.entries[0]!.key, "1");
  assert.equal(fallbackDeck.entries[0]!.recommended, true);
  assert.equal(fallbackDeck.entries[2]!.isWriteIn, true);

  const afterReply = buildAskQuestionDeck({
    events: [...events, { id: "u1", session: "s1", ts: 2000, kind: "user_message", text: "1" }],
    choiceLines: [],
    choices: [],
  });
  assert.equal(afterReply, null);
});
