import test from "node:test";
import assert from "node:assert/strict";
import { parseTerminalChoices, type Agent, type AgentInteraction, type ConvEvent } from "@herdr-pocket/protocol";
import {
  buildAskQuestionDeck,
  buildChoiceSelectKeys,
  extractTerminalChoicePrompt,
  findOpenQuestionToolCall,
  isQuestionToolName,
  normalizeChoiceLabel,
  parseAskQuestionInput,
  summarizeAskQuestionInput,
} from "../src/lib/askQuestion";
import { shallowEqualAgent } from "../src/lib/relay.ts";

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
  assert.equal(fallbackDeck.terminalMenuSynced, false);
  assert.equal(fallbackDeck.question, "选择发布渠道？");
  assert.equal(fallbackDeck.entries.length, 3);
  assert.equal(fallbackDeck.entries[0]!.key, "1");
  assert.equal(fallbackDeck.entries[0]!.recommended, true);
  assert.equal(fallbackDeck.entries[2]!.isWriteIn, true);

  // Synced multi-select Claude AskUserQuestion with live terminal checkboxes MUST have terminalMenuSynced=true.
  const multiEvents: ConvEvent[] = [
    {
      id: "tc-multi",
      session: "s1",
      ts: 1500,
      kind: "tool_call",
      call_id: "c-multi",
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Select targets to build",
            multiSelect: true,
            options: [{ label: "macOS" }, { label: "Linux" }, { label: "Windows" }],
          },
        ],
      },
    },
  ];
  const unsyncedMulti = buildAskQuestionDeck({
    events: multiEvents,
    choiceLines: [],
    choices: [],
    agentStatus: "working",
  });
  assert.equal(unsyncedMulti?.multiSelect, true);
  assert.equal(unsyncedMulti?.terminalMenuSynced, false);

  const syncedMulti = buildAskQuestionDeck({
    events: multiEvents,
    choiceLines: ["Select targets to build", "❯ 1. [ ] macOS", "  2. [x] Linux", "  3. [ ] Windows"],
    choices: parseTerminalChoices(["❯ 1. [ ] macOS", "  2. [x] Linux", "  3. [ ] Windows"]),
    agentStatus: "blocked",
  });
  assert.equal(syncedMulti?.multiSelect, true);
  assert.equal(syncedMulti?.fromStructuredTool, true);
  assert.equal(syncedMulti?.terminalMenuSynced, true);

  const afterReply = buildAskQuestionDeck({
    events: [...events, { id: "u1", session: "s1", ts: 2000, kind: "user_message", text: "1" }],
    choiceLines: [],
    choices: [],
  });
  assert.equal(afterReply, null);
});

test("chronological tool_call -> tool_result and done/idle agentStatus immediately clear AskQuestionDeck (image-132 P0 regression)", () => {
  const askCall: ConvEvent = {
    id: "s4666:c0",
    session: "antigravity:a1",
    ts: 1000,
    kind: "tool_call",
    call_id: "s4666:0",
    name: "ask_question",
    input: {
      questions: JSON.stringify([
        { question: "对外正式名称怎么定？", is_multi_select: false, options: ["(Recommended) 小吹私人助理", "快捷命令版", "其他"] },
        { question: "飞书已回复如何划掉？", is_multi_select: false, options: ["(Recommended) 自动划掉", "手动划掉"] },
        { question: "改造如何分节奏？", is_multi_select: false, options: ["(Recommended) 分两期", "只做个人助理"] },
      ]),
    },
  };

  // Answered chronologically via tool_result -> MUST return null!
  const answeredEvents: ConvEvent[] = [
    askCall,
    { id: "s4667", session: "antigravity:a1", ts: 2000, kind: "tool_result", call_id: "s4666:0", name: "ask_question", output: "A1: 小吹私人助理", is_error: false },
  ];
  assert.deepEqual(findOpenQuestionToolCall(answeredEvents), []);
  assert.equal(buildAskQuestionDeck({ events: answeredEvents, choiceLines: [], choices: [], agentStatus: "working" }), null);

  // Even before tool_result arrives, reasoning / assistant_message / another tool_call MUST close the question & clear zombie deck!
  const resumedEvents: ConvEvent[] = [
    askCall,
    { id: "s4668:r", session: "antigravity:a1", ts: 1500, kind: "reasoning", text: "Thinking..." },
  ];
  assert.deepEqual(findOpenQuestionToolCall(resumedEvents), []);
  assert.equal(
    buildAskQuestionDeck({ events: resumedEvents, choiceLines: [], choices: [], agentStatus: "working" }),
    null,
  );
  // Zombie deck MUST NEVER render when agent is idle or done without an active hostd question interaction.
  assert.equal(
    buildAskQuestionDeck({ events: [askCall], choiceLines: [], choices: [], agentStatus: "idle" }),
    null,
  );
  assert.equal(
    buildAskQuestionDeck({ events: [askCall], choiceLines: [], choices: [], agentStatus: "done" }),
    null,
  );

  // While genuinely blocked or working with an open ask call, user dismiss hides the deck cleanly
  const blockedDeck = buildAskQuestionDeck({ events: [askCall], choiceLines: [], choices: [], agentStatus: "blocked" });
  assert.ok(blockedDeck);
  assert.equal(blockedDeck.callId, "s4666:0");
  assert.equal(
    buildAskQuestionDeck({ events: [askCall], choiceLines: [], choices: [], agentStatus: "blocked", dismissedCallId: "s4666:0" }),
    null,
  );
  assert.equal(
    buildAskQuestionDeck({ events: [askCall], choiceLines: [], choices: [], agentStatus: "working", dismissedCallId: "s4666:0" }),
    null,
  );
});

test("multi-harness Ask parsing & universal arrow-key navigation work across Antigravity, Claude Code, Codex, Oh My Pi, DSH, OpenCode, and shell", () => {
  // Recognizes tool names across all major harnesses
  for (const name of ["ask_question", "AskUserQuestion", "ask_user_question", "request_user_input", "ask", "question", "ask_user"]) {
    assert.equal(isQuestionToolName(name), true, `expected ${name} to be recognized`);
  }

  // 1. Antigravity unnumbered `? ` cursor prompt (Question 2 of 3)
  const agyScreen = [
    "? 当助理检测到你在飞书里已经自己回复了某件事，应该怎么处理「划掉」？",
    "❯ (Recommended) 自动标为「本人已处理（已划掉）」",
    "  不自动划掉，仅标注",
    "  Other",
  ];
  const agyChoices = parseTerminalChoices(agyScreen);
  assert.equal(agyChoices.length, 3);
  assert.equal(agyChoices[0]!.selected, true);
  assert.deepEqual(buildChoiceSelectKeys({ entries: agyChoices, targetKey: "1", harness: "antigravity" }), ["enter"]);
  assert.deepEqual(buildChoiceSelectKeys({ entries: agyChoices, targetKey: "2", harness: "antigravity" }), ["down", "enter"]);
  assert.deepEqual(buildChoiceSelectKeys({ entries: agyChoices, targetKey: "3", harness: "antigravity" }), ["down", "down", "enter"]);

  // 2. Claude Code numbered multi-select checkboxes + Submit step
  const claudeMulti = [
    "❯ 1. [ ] Enable OAuth PKCE",
    "  2. [x] Keep legacy callback",
    "  3. [ ] Write-in...",
  ];
  const claudeChoices = parseTerminalChoices(claudeMulti);
  assert.equal(claudeChoices.length, 3);
  assert.equal(claudeChoices[0]!.checked, false);
  assert.equal(claudeChoices[1]!.checked, true);
  assert.deepEqual(buildChoiceSelectKeys({ entries: claudeChoices, targetKey: "2", harness: "claude-code", multiSelect: true }), ["down", "space"]);

  const claudeSubmit = parseTerminalChoices(["❯ 1. Submit answers", "  2. Cancel"]);
  const submitDeck = buildAskQuestionDeck({
    events: [
      {
        id: "c1",
        session: "s1",
        ts: 1000,
        kind: "tool_call",
        call_id: "call-1",
        name: "AskUserQuestion",
        input: { questions: [{ question: "Q1", options: [{ label: "A" }, { label: "B" }] }, { question: "Q2", options: [{ label: "C" }, { label: "D" }] }] },
      },
    ],
    choiceLines: ["Ready to submit?", "❯ 1. Submit answers", "  2. Cancel"],
    choices: claudeSubmit,
    agentStatus: "blocked",
  });
  assert.equal(submitDeck?.isSubmitStep, true);

  // 3. Codex CLI `request_user_input` with `›` pointer & `None of the above` write-in
  const codexChoices = parseTerminalChoices(["› 1. Fast path", "  2. Full rebuild", "  3. None of the above"]);
  assert.equal(codexChoices.length, 3);
  assert.equal(normalizeChoiceLabel(codexChoices[2]!.label).isWriteIn, true);
  assert.deepEqual(buildChoiceSelectKeys({ entries: codexChoices, targetKey: "2", harness: "codex" }), ["down", "enter"]);

  // 4. Oh My Pi (`omp` `ask`) unnumbered radio circles & `multi: true`
  const ompChoices = parseTerminalChoices(["❯ ● Approve & send", "  ○ Decline"]);
  assert.equal(ompChoices.length, 2);
  assert.equal(ompChoices[0]!.selected, true);
  assert.deepEqual(buildChoiceSelectKeys({ entries: ompChoices, targetKey: "2", harness: "oh-my-pi" }), ["down", "enter"]);
  const ompParsed = parseAskQuestionInput({ questions: [{ question: "Pick tools", multi: true, options: [{ label: "git" }, { label: "docker" }] }] });
  assert.equal(ompParsed.questions[0]?.multiSelect, true);

  // 5. DSH / OpenCode active-working terminal logs & queued messages MUST NOT trigger false-positive choices!
  const noisyWorkingScreen = [
    "○ Thought for 2m 10s (Core dispatch...)",
    "● Ran (rm -rf /tmp/test) failed",
    "● Explored 5 files (dispatch.py)",
    "▸ 1",
    "▸ 1 (alt+m to send immediately)",
    "Gemini 4 Neon (XHigh) · 46% ctx · working",
  ];
  assert.deepEqual(parseTerminalChoices(noisyWorkingScreen), []);

  // 6. Plain shell non-cursor select prompt still falls back to digit + enter
  assert.deepEqual(
    buildChoiceSelectKeys({
      entries: [{ key: "1" }, { key: "2" }],
      targetKey: "2",
      harness: "zsh",
      isShell: true,
    }),
    ["2", "enter"],
  );
});

test("parseTerminalChoices rejects Antigravity reviewing footer and background task bullet lists (IMG_0092 regression)", () => {
  const antigravityReviewingScreen = [
    "已完成巡检，当前无新消息。",
    "                              1 artifact · /artifact to review",
    "──────────────────────────────────────────────────────────────",
    ">",
    "──────────────────────────────────────────────────────────────",
    "  ● [12:15:38] cron (every 3 minutes) running",
    "  ● [12:10:53] nginx -g 'daemon off;' -c /tmp/nginx.conf running",
    "──────────────────────────────────────────────────────────────",
    "Gemini 4 Neon (XHigh) · 15% ctx · reviewing",
  ];
  assert.deepEqual(parseTerminalChoices(antigravityReviewingScreen), []);

  // Pure all-filled bullet lists with no cursor pointer and no unfilled radio (`○`) are log lists, not menus.
  assert.deepEqual(
    parseTerminalChoices([
      "  ● Background worker A running",
      "  ● Background worker B running",
    ]),
    [],
  );

  // Genuine radio menus (with at least one unfilled `○` or an explicit pointer) still parse cleanly.
  const validRadio = parseTerminalChoices(["  ● Keep current config", "  ○ Reset to defaults"]);
  assert.equal(validRadio.length, 2);
  assert.equal(validRadio[0]!.selected, true);
  assert.equal(validRadio[1]!.selected, false);
});

test("buildAskQuestionDeck renders cross-harness working asks and hostd interaction choices instantly, while blocking done/idle zombies", () => {
  // 1. Open ask / ask_question / request_user_input tool calls render immediately even when agentStatus === "working"
  for (const toolName of ["ask", "ask_question", "request_user_input"] as const) {
    const ev: ConvEvent = {
      id: `tc-${toolName}`,
      session: "s-cross",
      ts: 1000,
      kind: "tool_call",
      call_id: `call-${toolName}`,
      name: toolName,
      input: {
        questions: [
          {
            question: `(${toolName}) 选择构建模式？`,
            options: ["(Recommended) 增量构建 — 更快", "全量重建", "Write-in..."],
          },
        ],
      },
    };
    const deck = buildAskQuestionDeck({
      events: [ev],
      choiceLines: [],
      choices: [],
      agentStatus: "working",
    });
    assert.ok(deck, `expected working deck for ${toolName}`);
    assert.equal(deck.callId, `call-${toolName}`);
    assert.equal(deck.question, `(${toolName}) 选择构建模式？`);
    assert.equal(deck.entries.length, 3);
    assert.equal(deck.entries[0]!.recommended, true);
    assert.equal(deck.entries[2]!.isWriteIn, true);
  }

  // 2. hostd interaction.kind === "question" renders immediately using interaction.choices + prompt + multiSelect before terminal.read arrives
  const interaction: AgentInteraction = {
    kind: "question",
    prompt: "勾选要启用的功能模块",
    multiSelect: true,
    source: "terminal",
    choices: [
      { key: "1", label: "(Recommended) 缓存加速 — 默认开启", selected: true, checked: true },
      { key: "2", label: "详细日志", selected: false, checked: false },
      { key: "3", label: "Other", selected: false, checked: false },
    ],
  };
  const instantDeck = buildAskQuestionDeck({
    events: [],
    choiceLines: [],
    choices: [],
    agentStatus: "working",
    interaction,
  });
  assert.ok(instantDeck);
  assert.equal(instantDeck.question, "勾选要启用的功能模块");
  assert.equal(instantDeck.multiSelect, true);
  assert.equal(instantDeck.entries.length, 3);
  assert.equal(instantDeck.entries[0]!.title, "缓存加速");
  assert.equal(instantDeck.entries[0]!.description, "默认开启");
  assert.equal(instantDeck.entries[0]!.recommended, true);
  assert.equal(instantDeck.entries[0]!.checked, true);
  assert.equal(instantDeck.entries[2]!.isWriteIn, true);

  // Live terminal choices override interaction.choices once terminal.read returns
  const liveOverrides = buildAskQuestionDeck({
    events: [],
    choiceLines: ["勾选要启用的功能模块", "  1. [x] 缓存加速", "❯ 2. [x] 详细日志"],
    choices: [
      { key: "1", label: "缓存加速", selected: false, checked: true },
      { key: "2", label: "详细日志", selected: true, checked: true },
    ],
    agentStatus: "working",
    interaction,
  });
  assert.ok(liveOverrides);
  assert.equal(liveOverrides.entries.length, 2);
  assert.equal(liveOverrides.entries[1]!.selected, true);
  assert.equal(liveOverrides.entries[1]!.checked, true);

  // 3. NEVER renders zombie decks on done / idle without a live question interaction (even with stale choices or permission interaction)
  const staleChoices = [
    { key: "1", label: "A", selected: true },
    { key: "2", label: "B", selected: false },
  ];
  assert.equal(
    buildAskQuestionDeck({ events: [], choiceLines: [], choices: staleChoices, agentStatus: "done" }),
    null,
  );
  assert.equal(
    buildAskQuestionDeck({ events: [], choiceLines: [], choices: staleChoices, agentStatus: "idle" }),
    null,
  );
  assert.equal(
    buildAskQuestionDeck({
      events: [],
      choiceLines: [],
      choices: staleChoices,
      agentStatus: "idle",
      interaction: { kind: "permission", prompt: "Allow?", source: "terminal" },
    }),
    null,
  );
});

test("shallowEqualAgent detects agent.interaction additions, field/choice updates, and removals", () => {
  const base: Agent = {
    key: "d1/hc:t1",
    deviceId: "d1",
    source: "hc",
    localId: "t1",
    harness: "codex",
    status: "working",
    isShell: false,
    updatedAt: 1000,
  };
  const baseCopy: Agent = { ...base };
  assert.equal(shallowEqualAgent(base, baseCopy), true);

  const withInteraction: Agent = {
    ...base,
    interaction: {
      kind: "question",
      prompt: "Choose target",
      multiSelect: false,
      source: "terminal",
      choices: [
        { key: "1", label: "Alpha", selected: true },
        { key: "2", label: "Beta", selected: false },
      ],
    },
  };
  // Addition detected
  assert.equal(shallowEqualAgent(base, withInteraction), false);
  // Removal detected
  assert.equal(shallowEqualAgent(withInteraction, base), false);
  // Structurally identical interaction returns true
  const sameInteraction: Agent = {
    ...base,
    interaction: {
      kind: "question",
      prompt: "Choose target",
      multiSelect: false,
      source: "terminal",
      choices: [
        { key: "1", label: "Alpha", selected: true },
        { key: "2", label: "Beta", selected: false },
      ],
    },
  };
  assert.equal(shallowEqualAgent(withInteraction, sameInteraction), true);

  // Cursor selection change detected
  const cursorMoved: Agent = {
    ...withInteraction,
    interaction: {
      ...withInteraction.interaction!,
      choices: [
        { key: "1", label: "Alpha", selected: false },
        { key: "2", label: "Beta", selected: true },
      ],
    },
  };
  assert.equal(shallowEqualAgent(withInteraction, cursorMoved), false);

  // Checkbox checked state change detected
  const checkedChanged: Agent = {
    ...withInteraction,
    interaction: {
      ...withInteraction.interaction!,
      multiSelect: true,
      choices: [
        { key: "1", label: "Alpha", selected: true, checked: true },
        { key: "2", label: "Beta", selected: false, checked: false },
      ],
    },
  };
  assert.equal(shallowEqualAgent(withInteraction, checkedChanged), false);

  // Prompt change detected
  const promptChanged: Agent = {
    ...withInteraction,
    interaction: { ...withInteraction.interaction!, prompt: "Choose another target" },
  };
  assert.equal(shallowEqualAgent(withInteraction, promptChanged), false);
});
