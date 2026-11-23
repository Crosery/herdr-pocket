import {
  OPENAI_REALTIME_VOICES,
  clampThinkingLevel,
  extractModelExplicitEffort,
  findModelOptionForModel,
  inferModelThinkingLevels,
  normalizeSwitchHarness,
  resolveThinkingLevelsForModel,
  stripModelEffortSuffix,
  type Agent,
  type AgentModelOption,
  type AgentThinkingLevel,
  type AssistantConfigChange,
  type AssistantConfigView,
  type AssistantItem,
  type AssistantState,
  type ConvEvent,
  type Device,
  type DeviceKind,
  type HerdrDoc,
  type PairCode,
  type PairResponse,
  type PromptId,
  type PromptView,
  type ProviderPatch,
  type RpcMethod,
  type SubSession,
} from "@herdr-pocket/protocol";
import { liveStore } from "./store";

export const DEMO_URL = "demo://local";
export const isMockServer = (s?: string | null): boolean => s === DEMO_URL;

const now = Date.now();
const min = 60_000;

const DEMO_DEVICES: Device[] = [
  { id: "dev-mac", name: "workstation", kind: "host", platform: "darwin", online: true, createdAt: now - 300 * min, lastSeenAt: now, sources: ["hc", "uniflo"], version: "0.2.0" },
  { id: "dev-linux", name: "buildbox", kind: "host", platform: "linux", online: true, createdAt: now - 900 * min, lastSeenAt: now, sources: ["hc", "uniflo"], version: "0.2.0" },
  { id: "dev-viewer", name: "当前设备", kind: "viewer", platform: "desktop", online: true, createdAt: now - 60 * min, lastSeenAt: now },
];

const DEMO_AGENTS: Agent[] = [
  {
    key: "dev-mac/hc:t1",
    deviceId: "dev-mac",
    source: "hc",
    localId: "t1",
    harness: "claude-code",
    title: "重构登录回调与权限校验",
    where: "backend / auth",
    cwd: "~/work/demo-app",
    status: "blocked",
    statusSince: now - 2 * min,
    statusNote: "等待选择迁移策略",
    turn: 4,
    isShell: false,
    sessionKey: "claude:demo-1",
    updatedAt: now,
  },
  {
    key: "dev-mac/hc:t2",
    deviceId: "dev-mac",
    source: "hc",
    localId: "t2",
    harness: "codex",
    title: "补充集成测试与 CI 检查",
    where: "backend / tests",
    cwd: "~/work/demo-app",
    status: "working",
    statusSince: now - 4 * min,
    turn: 2,
    subagents: 2,
    subagentsWorking: 1,
    queued: 1,
    queuedText: "顺便检查边界用例并补充集成测试",
    queuedItems: ["顺便检查边界用例并补充集成测试"],
    queuedSince: now - 25_000,
    isShell: false,
    sessionKey: "codex:demo-2",
    updatedAt: now,
  },
  {
    key: "dev-linux/hc:t3",
    deviceId: "dev-linux",
    source: "hc",
    localId: "t3",
    harness: "gemini-cli",
    title: "优化打包脚本与资源压缩",
    where: "release / scripts",
    cwd: "~/repos/sample-cli",
    status: "done",
    statusSince: now - 11 * min,
    turn: 6,
    isShell: false,
    sessionKey: "gemini:demo-3",
    updatedAt: now,
  },
  {
    key: "dev-mac/hc:t4",
    deviceId: "dev-mac",
    source: "hc",
    localId: "t4",
    harness: "zsh",
    title: "本地日志监控终端",
    where: "backend / logs",
    cwd: "~/work/demo-app",
    status: "idle",
    statusSince: now - 35 * min,
    isShell: true,
    updatedAt: now,
  },
  {
    key: "dev-mac/hc:t5",
    deviceId: "dev-mac",
    source: "hc",
    localId: "t5",
    harness: "oh-my-pi",
    title: "OMP 模型角色与思考适配",
    where: "backend / models",
    cwd: "~/work/demo-app",
    status: "idle",
    statusSince: now - 1 * min,
    turn: 3,
    model: "demo/mimo-v2.6-pro",
    isShell: false,
    sessionKey: "omp:demo-5",
    updatedAt: now,
  },
  {
    key: "dev-mac/hc:t6",
    deviceId: "dev-mac",
    source: "hc",
    localId: "t6",
    harness: "antigravity",
    title: "动态思考等级与模型变体",
    where: "backend / models",
    cwd: "~/work/demo-app",
    status: "idle",
    statusSince: now - 2 * min,
    turn: 2,
    model: "gemini-4-neon-high",
    isShell: false,
    sessionKey: "agy:demo-6",
    updatedAt: now,
  },
];

const DEMO_EVENTS: Record<string, ConvEvent[]> = {
  "dev-mac/hc:t1": [
    { id: "e1", session: "claude:demo-1", ts: now - 8 * min, kind: "user_message", text: "检查一下 OAuth 回调校验，并对照架构图 `docs/oauth-flow.svg`。\n[Image #1] docs/oauth-flow.svg" },
    { id: "e2", session: "claude:demo-1", ts: now - 6 * min, kind: "tool_call", call_id: "c1", name: "read_file", input: { path: "src/auth/callback.ts" } },
    { id: "e3", session: "claude:demo-1", ts: now - 5 * min, kind: "tool_result", call_id: "c1", name: "read_file", output: "已读取 142 行代码。", is_error: false },
    {
      id: "e4",
      session: "claude:demo-1",
      ts: now - 2 * min,
      kind: "assistant_message",
      text: "发现旧回调允许空 state 参数，需要确认接下来怎么处理：\n\n1. 严格校验 state 并拒绝旧令牌\n2. 开启 7 天兼容过渡期并记录告警日志",
    },
  ],
  "dev-mac/hc:t2": [
    { id: "e21", session: "codex:demo-2", ts: now - 9 * min, kind: "user_message", text: "跑一遍端到端测试并修掉超时的用例，顺便核对 `README.md` 和流程图 `docs/oauth-flow.svg`。\n[Image #1] docs/oauth-flow.svg" },
    { id: "e22", session: "codex:demo-2", ts: now - 8 * min, kind: "reasoning", text: "先读取 relay 和 stream 相关测试与超时配置，找出慢测试的根因。" },
    { id: "e23", session: "codex:demo-2", ts: now - 7 * min, kind: "tool_call", call_id: "c21", name: "read_file", input: { path: "tests/relay.test.ts" } },
    { id: "e24", session: "codex:demo-2", ts: now - 7 * min + 500, kind: "tool_result", call_id: "c21", name: "read_file", output: "184 lines read", is_error: false },
    { id: "e25", session: "codex:demo-2", ts: now - 7 * min + 900, kind: "tool_call", call_id: "c22", name: "read_file", input: { path: "tests/stream.test.ts" } },
    { id: "e26", session: "codex:demo-2", ts: now - 6 * min, kind: "tool_result", call_id: "c22", name: "read_file", output: "240 lines read", is_error: false },
    { id: "e27", session: "codex:demo-2", ts: now - 6 * min + 500, kind: "tool_call", call_id: "c23", name: "read_file", input: { path: "src/socket.ts" } },
    { id: "e28", session: "codex:demo-2", ts: now - 6 * min + 800, kind: "tool_result", call_id: "c23", name: "read_file", output: "312 lines read", is_error: false },
    { id: "e29", session: "codex:demo-2", ts: now - 5 * min, kind: "tool_call", call_id: "c24", name: "run_command", input: { command: "pnpm test tests/relay.test.ts" } },
    { id: "e30", session: "codex:demo-2", ts: now - 5 * min + 1500, kind: "tool_result", call_id: "c24", name: "run_command", output: "PASS 18/18", is_error: false },
    { id: "e30b", session: "codex:demo-2", ts: now - 4 * min - 30_000, kind: "tool_call", call_id: "c25", name: "edit_file", input: { path: "src/socket.ts" } },
    { id: "e30c", session: "codex:demo-2", ts: now - 4 * min - 20_000, kind: "tool_result", call_id: "c25", name: "edit_file", output: "updated reconnect timeout", is_error: false },
    { id: "e30d", session: "codex:demo-2", ts: now - 4 * min - 10_000, kind: "tool_call", call_id: "c26", name: "run_command", input: { command: "pnpm test tests/stream.test.ts" } },
    { id: "e30e", session: "codex:demo-2", ts: now - 4 * min, kind: "tool_result", call_id: "c26", name: "run_command", output: "PASS 24/24", is_error: false },
    { id: "e30f", session: "codex:demo-2", ts: now - 3 * min, kind: "tool_call", call_id: "c27", name: "run_command", input: { command: "pnpm test" } },
    { id: "e30g", session: "codex:demo-2", ts: now - 2 * min, kind: "assistant_message", text: "正在运行 `pnpm test` 复查 mock socket 超时阈值…" },
  ],
  "dev-linux/hc:t3": [
    { id: "e31", session: "gemini:demo-3", ts: now - 20 * min, kind: "user_message", text: "把静态资源压到 10 MB 以内。" },
    { id: "e32", session: "gemini:demo-3", ts: now - 11 * min, kind: "assistant_message", text: "已完成压缩与校验：安装包体积从 18.4 MB 降至 7.9 MB，所有校验通过。" },
  ],
  "dev-mac/hc:t5": [
    { id: "e51", session: "omp:demo-5", ts: now - 6 * min, kind: "user_message", text: "确认一下 mimo-v2.6-pro 与 OMP /switch、/model 角色模型的配置情况。" },
    { id: "e52", session: "omp:demo-5", ts: now - 5 * min, kind: "reasoning", text: "检查 ~/.omp/agent/config.yml 中的 modelRoles 与当前会话模型思考强度。" },
    { id: "e53", session: "omp:demo-5", ts: now - 1 * min, kind: "assistant_message", text: "已读取本地模型与角色映射：`default` 使用 `demo/mimo-v2.6-pro`，支持 `/switch` 会话切换与 `/model` 角色分配。" },
  ],
  "dev-mac/hc:t6": [
    { id: "e61", session: "agy:demo-6", ts: now - 5 * min, kind: "user_message", text: "检查 gemini-4-neon-high、claude-opus-5-5-high、gpt-oss-120b-medium 的思考等级映射。" },
    { id: "e62", session: "agy:demo-6", ts: now - 2 * min, kind: "assistant_message", text: "当前模型 `gemini-4-neon-high` 仅展示实际支持的 `low / medium / high / xhigh` 四档思考等级。" },
  ],
};

const DEMO_TERMINALS: Record<string, string[]> = {
  "dev-mac/hc:t1": [
    "\x1b[38;5;212mClaude Code\x1b[0m · ~/work/demo-app",
    "\x1b[90m────────────────────────────────────\x1b[0m",
    "\x1b[32m✓\x1b[0m 读取 src/auth/callback.ts",
    "• Explored 1 file (external-delivery-sequence.html)",
    "",
    "\x1b[33m请选择处理方式：\x1b[0m",
    "  \x1b[1m1.\x1b[0m 严格校验 state 并拒绝旧令牌",
    "  \x1b[1m2.\x1b[0m 开启 7 天兼容过渡期并记录告警日志",
    "",
    "\x1b[36m›\x1b[0m 等待你的选择…",
  ],
  "dev-mac/hc:t2": [
    "\x1b[38;5;79mCodex CLI\x1b[0m · ~/work/demo-app",
    "RUN  tests/relay.test.ts",
    "\x1b[32mPASS\x1b[0m tests/protocol.test.ts (18 tests)",
    "\x1b[33mRUN \x1b[0m tests/stream.test.ts …",
  ],
  "dev-linux/hc:t3": [
    "\x1b[38;5;221mGemini CLI\x1b[0m · ~/repos/sample-cli",
    "\x1b[32m✓\x1b[0m 构建产物大小：7.9 MB (SHA-256 校验通过)",
    "~/repos/sample-cli $",
  ],
  "dev-mac/hc:t4": [
    "~/work/demo-app $ tail -f relay.log",
    "[info] listening on :7420",
    "[info] 2 hosts online",
  ],
  "dev-mac/hc:t5": [
    "\x1b[38;5;212moh-my-pi\x1b[0m · demo/mimo-v2.6-pro · xhigh",
    "~/work/demo-app",
    "❯ ",
  ],
  "dev-mac/hc:t6": [
    "\x1b[38;5;141mantigravity\x1b[0m · gemini-4-neon-high",
    "~/work/demo-app",
    "❯ ",
  ],
};

const DEMO_FILES: Array<{ dir: string; name: string; kind: "file" | "dir"; size?: number; private?: boolean; ignored?: boolean; hidden?: boolean; gitStatus?: "M" | "A" | "D" | "R" | "U" | "?"; body?: string }> = [
  { dir: "", name: "src", kind: "dir", gitStatus: "M" },
  { dir: "", name: "docs", kind: "dir" },
  { dir: "", name: "node_modules", kind: "dir", ignored: true },
  { dir: "", name: ".env", kind: "file", size: 120, private: true, hidden: true },
  {
    dir: "docs",
    name: "oauth-flow.svg",
    kind: "file",
    size: 360,
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect width="320" height="160" rx="12" fill="#fdf2f7" stroke="#f0b6cf"/><text x="160" y="76" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#9d174d">OAuth PKCE Flow</text><text x="160" y="102" text-anchor="middle" font-family="monospace" font-size="12" fill="#be185d">callback.ts -> token verify</text></svg>',
  },
  {
    dir: "docs",
    name: "external-delivery-sequence.html",
    kind: "file",
    size: 280,
    body: "<!doctype html><html><body style=\"font-family:system-ui,sans-serif;padding:20px;line-height:1.6\"><h2>External Delivery Sequence</h2><p>Step 1: Auth Callback &rarr; Step 2: Verification Passed</p></body></html>",
  },
  {
    dir: "",
    name: "README.md",
    kind: "file",
    gitStatus: "M",
    size: 620,
    body: [
      "# demo-app",
      "",
      "演示用的小项目。",
      "",
      "> [!TIP]",
      "> 总体结论：OAuth PKCE 回调校验与零侵入隔离检查均已通过，按住 `Ctrl` 点击 `src/auth/callback.ts` 可直接跳转代码行，普通左键仅选中文本。",
      "",
      "## 基线核实",
      "",
      "| 目标模块 | 核实基线 | 是否开启隔离 | 验证方式 |",
      "| --- | --- | --- | --- |",
      "| 服务端 callback 校验 | `feat/oauth-guard` | 否（默认兼容 7 天过渡） | 只读实调 `/livez` 与单元校验 |",
      "| 回调流程示意图 | `docs/oauth-flow.svg` | 是（本地预览令牌隔离） | 独立预览窗格实测 |",
      "",
      "## 开发",
      "",
      "- `pnpm install`",
      "- `pnpm dev`",
      "",
      "登录回调在 `src/auth/callback.ts`，流程示意图在 `docs/oauth-flow.svg`。",
      "",
    ].join("\n"),
  },
  { dir: "", name: "package.json", kind: "file", size: 160, body: '{\n  "name": "demo-app",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest run"\n  }\n}\n' },
  { dir: "src", name: "auth", kind: "dir" },
  { dir: "src", name: "index.ts", kind: "file", size: 90, body: 'import { handleCallback } from "./auth/callback";\n\nexport function start(): void {\n  console.log("demo-app ready");\n}\n\nexport { handleCallback };\n' },
  {
    dir: "src/auth",
    name: "callback.ts",
    kind: "file",
    size: 300,
    body: 'export interface CallbackQuery {\n  code: string;\n  state?: string;\n}\n\n// TODO: reject an empty state once the 7-day grace period ends.\nexport function handleCallback(q: CallbackQuery): boolean {\n  if (!q.code) return false;\n  return true;\n}\n',
  },
];

let demoAssistantState: AssistantState = {
  ready: true,
  voice: true,
  busy: false,
  model: "demo-assistant",
  reminders: [{ id: "r1", text: "看一下 buildbox 的构建结果", createdAt: now - 5 * min, dueAt: now + 10 * min }],
  settings: { confirm: "never" },
  items: [
    {
      id: "m1",
      ts: now - 10 * min,
      role: "assistant",
      text: "这里是本地演示模式：你可以随便点点各个 agent、发消息、试键盘按键，或者试试和小羊对话。",
    },
    {
      id: "m2",
      ts: now - 3 * min,
      role: "notice",
      text: "「重构登录回调与权限校验」在等你做决定。",
      notice: { id: "n1", kind: "blocked", title: "workstation · 需要你", body: "OAuth state 校验策略需要选择 1 或 2", verdict: "decide", agent: "dev-mac/hc:t1", ts: now - 3 * min },
    },
  ],
};

// Demo models and providers mirror the mobile demo (apps/mobile/src/lib/mockConfig.ts).
const DEMO_SERVER_PROVIDER = { id: "custom", label: "自建网关", protocol: "openai" as const, baseUrl: "https://llm.example.com/v1", key: { set: true, hint: "a1b2", from: "server" as const }, from: "server" as const };
const DEMO_MODEL_LISTS: Record<string, string[]> = {
  custom: ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6.1-luna", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
};
const DEMO_SPEED: Record<string, [number, number]> = {
  "gpt-6.1-terra": [1800, 2400],
  "claude-sonnet-5-5": [1200, 2100],
  "gpt-6.1-sol": [900, 1600],
  "gpt-6.1-luna": [700, 1300],
  "claude-opus-5-5": [2600, 4100],
  "claude-haiku-5-5": [600, 1100],
  "deepseek-chat": [1500, 2600],
  "deepseek-reasoner": [4200, 6800],
};

function demoAssistantConfig(rev: number): AssistantConfigView {
  return {
    rev,
    name: "小羊",
    providers: [
      { ...DEMO_SERVER_PROVIDER, key: { ...DEMO_SERVER_PROVIDER.key } },
      { id: "deepseek", label: "DeepSeek", protocol: "openai", baseUrl: "https://deepseek.example.com/v1", key: { set: true, hint: "e5d4", from: "phone" }, from: "phone" },
    ],
    models: [
      { provider: "custom", model: "gpt-6.1-terra" },
      { provider: "custom", model: "claude-sonnet-5-5" },
      { provider: "custom", model: "gpt-6.1-sol" },
    ],
    voice: { provider: "openai-realtime", url: "wss://api.example.com/v1/realtime", model: "gpt-realtime", voice: "marin", speed: 1.0, key: { set: true, hint: "demo", from: "server" } },
    edited: false,
    warnings: [],
  };
}

let demoConfig: AssistantConfigView = demoAssistantConfig(1);

const demoPrompts: PromptView[] = [
  { id: "base", title: "基础规则", about: "规定小羊的行为准则", group: "性格与规矩", slots: [{ slot: "{{name}}", means: "助理名字" }], text: "你是 {{name}}，负责照看所有电脑上的开发任务。", defaultText: "你是 {{name}}，负责照看所有电脑上的开发任务。", edited: false },
  { id: "persona", title: "说话风格", about: "口吻与长度约束", group: "性格与规矩", slots: [], text: "说话简洁自然，先说结论。", defaultText: "说话简洁自然，先说结论。", edited: false },
];

const demoOmpModelRoles: Record<string, string> = {
  default: "demo/mimo-v2.6-pro",
  smol: "demo/gpt-6.2-sol-ultrafast",
  slow: "demo/claude-opus-5-5",
  plan: "demo/gpt-6.2-astra",
  commit: "demo/gpt-6.2-sol-ultrafast",
};
const demoThinkingByAgent = new Map<string, string>();

function demoModelOpt(
  harness: string,
  id: string,
  label: string,
  provider: string,
  contextWindow: number,
  source: "current" | "recent" | "catalog",
  extra?: Partial<AgentModelOption>,
): AgentModelOption {
  const rawLevels = extra?.thinkingLevels ? [...extra.thinkingLevels] : inferModelThinkingLevels(harness, id);
  const levels =
    normalizeSwitchHarness(harness) === "omp" &&
    rawLevels.length > 0 &&
    !rawLevels.some((l) => l.toLowerCase() === "off")
      ? ["off", ...rawLevels]
      : rawLevels;
  return {
    id,
    label,
    provider,
    contextWindow,
    reasoning: levels.length > 0,
    ...(levels.length > 0 ? { thinkingLevels: levels } : {}),
    source,
    ...extra,
  };
}

function buildDemoModelsPool(harness: string): AgentModelOption[] {
  const hNorm = normalizeSwitchHarness(harness);
  if (hNorm === "omp") {
    return [
      demoModelOpt(harness, "demo/mimo-v2.6-pro", "MiMo V2.6 Pro", "demo", 256_000, "recent"),
      demoModelOpt(harness, "demo/gemini-2.5-pro", "Gemini 2.5 Pro", "google", 1_048_576, "catalog"),
      demoModelOpt(harness, "demo/gemini-1.5-pro", "Gemini 1.5 Pro", "google", 2_000_000, "catalog"),
      demoModelOpt(harness, "demo/gpt-6.2-sol-ultrafast", "GPT-6.2 Sol Ultrafast", "demo", 400_000, "catalog"),
      demoModelOpt(harness, "claude-opus-5-5", "Claude Opus 5.5", "anthropic", 200_000, "recent"),
      demoModelOpt(harness, "gpt-6.2-astra", "GPT-6.2 Astra", "openai", 1_050_000, "catalog"),
    ];
  }
  if (hNorm === "antigravity") {
    return [
      demoModelOpt(harness, "gemini-4-neon-high", "Gemini 4 Neon", "google", 1_048_576, "recent", {
        thinkingLevels: ["low", "medium", "high", "xhigh"],
        effortModelMap: {
          low: "gemini-4-neon-low",
          medium: "gemini-4-neon-medium",
          high: "gemini-4-neon-high",
          xhigh: "gemini-4-neon-xhigh",
        },
      }),
      demoModelOpt(harness, "claude-opus-5-5-high", "Claude Opus 5.5", "anthropic", 200_000, "recent", {
        thinkingLevels: ["low", "medium", "high"],
        effortModelMap: {
          low: "claude-opus-5-5-low",
          medium: "claude-opus-5-5-medium",
          high: "claude-opus-5-5-high",
        },
      }),
      demoModelOpt(harness, "gpt-oss-120b-medium", "GPT-OSS 120B (Medium)", "openai", 128_000, "catalog", {
        thinkingLevels: ["medium"],
        effortModelMap: { medium: "gpt-oss-120b-medium" },
      }),
      demoModelOpt(harness, "gemini-2.5-pro", "Gemini 2.5 Pro", "google", 1_048_576, "catalog"),
      demoModelOpt(harness, "gemini-1.5-pro", "Gemini 1.5 Pro", "google", 2_000_000, "catalog"),
    ];
  }
  return [
    demoModelOpt(harness, "claude-opus-5-5", "Claude Opus 5.5", "anthropic", 200_000, "recent"),
    demoModelOpt(harness, "claude-sonnet-5", "Claude Sonnet 5", "anthropic", 200_000, "recent"),
    demoModelOpt(harness, "gpt-6.2-astra", "GPT-6.2 Astra", "openai", 1_050_000, "catalog"),
    demoModelOpt(harness, "gemini-2.5-pro", "Gemini 2.5 Pro", "google", 1_048_576, "catalog"),
    demoModelOpt(harness, "gemini-1.5-pro", "Gemini 1.5 Pro", "google", 2_000_000, "catalog"),
    demoModelOpt(harness, "deepseek-reasoner", "DeepSeek Reasoner", "deepseek", 128_000, "catalog"),
  ];
}

let mockTermSeq = 20;
let mockPaneSeq = 20;
let mockSplitSeq = 20;

const demoHerdrDocs: Record<string, { value: HerdrDoc; version: number }> = {
  "dev-mac": {
    version: 1,
    value: {
      spaces: [
        {
          id: "sp-1",
          name: "backend",
          folder: "~/work/demo-app",
          tabs: [
            {
              id: "tb1",
              name: "",
              root: {
                id: "s1",
                type: "row",
                children: [
                  { id: "p1", type: "block", size: { weight: 1 }, content: { terminal: "t1" } },
                  { id: "p2", type: "block", size: { weight: 1 }, content: { terminal: "t4" } },
                ],
              },
            },
            {
              id: "tb2",
              name: "",
              root: { id: "p3", type: "block", content: { terminal: "t2" } },
            },
            {
              id: "tb3",
              name: "",
              root: { id: "p4", type: "block", content: { terminal: "t5" } },
            },
          ],
        },
        { id: "sp-2", name: "release", folder: "~/repos/sample-cli", tabs: [] },
        { id: "sp-3", name: "sandbox", folder: "~/scratch", tabs: [] },
      ],
    },
  },
  "dev-linux": {
    version: 1,
    value: {
      spaces: [
        {
          id: "sp-lin-1",
          name: "release",
          folder: "~/repos/sample-cli",
          tabs: [
            {
              id: "tb1",
              name: "",
              root: { id: "p1", type: "block", content: { terminal: "t3" } },
            },
          ],
        },
      ],
    },
  },
};

const DEMO_SPACE_COLORS: Record<string, string> = {
  "sp-1": "ansi6",
  "sp-2": "ansi3",
  "sp-3": "ansi5",
  "sp-lin-1": "ansi3",
};

function countDocRootTerminals(node: any): number {
  if (!node || typeof node !== "object") return 0;
  if (node.type === "block") return node.content?.terminal ? 1 : 0;
  if (Array.isArray(node.children)) {
    return node.children.reduce((n: number, c: any) => n + countDocRootTerminals(c), 0);
  }
  return 0;
}

function demoSpacesForHost(hostId: string) {
  const entry = demoHerdrDocs[hostId];
  if (!entry) return [];
  return entry.value.spaces.map((sp, i) => ({
    id: sp.id,
    name: sp.name,
    folder: sp.folder,
    tabs: sp.tabs.length,
    terminals: sp.tabs.reduce((n, tb) => n + countDocRootTerminals(tb.root), 0),
    ...(DEMO_SPACE_COLORS[sp.id] ? { color: DEMO_SPACE_COLORS[sp.id] } : {}),
    ...(i === 0 ? { active: true } : {}),
  }));
}

export const mockApi = {
  pair(_code: string, name: string, platform: string): PairResponse {
    const me: Device = { id: "dev-viewer", name, kind: "viewer", platform, online: true, createdAt: Date.now(), lastSeenAt: Date.now() };
    DEMO_DEVICES[2] = me;
    return { device: me, token: "demo-token" };
  },
  connect(): void {
    const agents: Record<string, Agent[]> = {};
    for (const a of DEMO_AGENTS) (agents[a.deviceId] ??= []).push(a);
    liveStore.set({
      link: "online",
      devices: Object.fromEntries(DEMO_DEVICES.map((d) => [d.id, d])),
      agents,
      spaces: {
        "dev-mac": demoSpacesForHost("dev-mac"),
        "dev-linux": demoSpacesForHost("dev-linux"),
      },
      rev: liveStore.get().rev + 1,
    });
  },
  createPairCode(kind?: DeviceKind): PairCode {
    const code = kind === "host" ? "DEMO-2048" : "POCK-5120";
    return { code, expiresAt: Date.now() + 30 * min, link: `https://pocket.example.com/p/${code}` };
  },
  async call(to: string, method: RpcMethod, params: any): Promise<any> {
    if (method === "host.info") {
      const d = DEMO_DEVICES.find((x) => x.id === to);
      // One computer with a checked, partly outdated set and one that has not checked yet.
      const tools =
        to === "dev-mac"
          ? { app: "0.9.4", herdr: "0.6.2", hc: "0.6.2", uniflo: "1.3.0", latest: { app: "0.9.4", hc: "0.7.0", uniflo: "1.3.0", checkedAt: Date.now() - 3 * 60 * min } }
          : { hc: "0.7.0", uniflo: "1.2.1" };
      return { name: d?.name ?? "demo", platform: d?.platform ?? "darwin", sources: ["hc", "uniflo"], version: d?.version ?? "0.2.0", tools, files: true };
    }
    if (method === "terminal.read") {
      const lines = DEMO_TERMINALS[params.agent] ?? ["(demo terminal)"];
      return { text: lines.join("\n"), ansi: lines.join("\n"), cols: 80, rows: 24, complete: true };
    }
    if (method === "session.events") {
      return { sessionKey: params.agent, events: DEMO_EVENTS[params.agent] ?? [], more: false, nextBefore: null };
    }
    if (method === "session.children") {
      const children: SubSession[] =
        params.agent === "dev-mac/hc:t2"
          ? [
              { key: "sub-1", parent: "codex:demo-2", harness: "codex", title: "测试 WS 重连", status: "working", updatedAt: Date.now(), children: 0 },
              { key: "sub-2", parent: "codex:demo-2", harness: "codex", title: "校验类型定义", status: "idle", updatedAt: Date.now() - 2 * min, children: 0 },
            ]
          : [];
      return { sessions: children };
    }
    if (method === "spaces.list") {
      return {
        spaces: demoSpacesForHost(to),
        launchers: [
          { id: "shell", label: "终端", takesTask: false },
          { id: "claude", label: "Claude Code", takesTask: true },
          { id: "codex", label: "Codex", takesTask: true },
          { id: "gemini", label: "Gemini CLI", takesTask: true },
        ],
        folders: ["~/work/demo-app", "~/repos/sample-cli"],
        canCreate: true,
      };
    }
    if (method === "files.list") {
      const path: string = (params.path ?? "").replace(/^\/+|\/+$/g, "");
      const all = DEMO_FILES.filter((f) => f.dir === path && (params.hidden || !f.name.startsWith(".")) && (params.all || !f.ignored));
      return {
        root: DEMO_AGENTS.find((a) => a.key === params.agent)?.cwd ?? "~/work/demo-app",
        path,
        entries: all
          .sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name))
          .map(({ dir: _d, body: _b, ...e }) => ({ ...e, path: path ? `${path}/${e.name}` : e.name, mtime: now - 30 * min })),
        truncated: false,
      };
    }
    if (method === "files.read") {
      const fullPath = (f: (typeof DEMO_FILES)[number]) => (f.dir ? `${f.dir}/${f.name}` : f.name);
      const req = String(params.path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
      let hit = DEMO_FILES.find((f) => fullPath(f) === req);
      if (!hit && req && !/^(\/|~\/|\.\.\/)/.test(req)) {
        const suffix = `/${req}`;
        hit = DEMO_FILES.find(
          (f) => f.kind === "file" && !f.ignored && !f.private && (fullPath(f) === req || fullPath(f).endsWith(suffix)),
        );
      }
      if (!hit || hit.kind !== "file") throw new Error("没有这个文件");
      if (hit.private) throw new Error("这个文件可能含有密钥，不能查看");
      const text = hit.body ?? "";
      const resolvedPath = fullPath(hit);
      return {
        path: resolvedPath,
        size: text.length,
        mtime: now - 30 * min,
        binary: false,
        truncated: false,
        offset: 0,
        bytes: text.length,
        text,
        language: hit.name.split(".").pop(),
      };
    }
    if (method === "herdr.doc.get") {
      const entry = demoHerdrDocs[to];
      return entry
        ? { value: JSON.parse(JSON.stringify(entry.value)), version: entry.version }
        : { value: { spaces: [] }, version: 1 };
    }
    if (method === "herdr.doc.set") {
      const cur = demoHerdrDocs[to] ?? { value: { spaces: [] }, version: 0 };
      const expected = typeof params?.version === "number" ? params.version : 0;
      if (expected !== cur.version) {
        return {
          ok: false,
          conflict: true,
          value: JSON.parse(JSON.stringify(cur.value)),
          version: cur.version,
        };
      }
      const nextVal = (params?.value ?? { spaces: [] }) as HerdrDoc;
      const nextVersion = cur.version + 1;
      demoHerdrDocs[to] = { value: JSON.parse(JSON.stringify(nextVal)), version: nextVersion };
      return { ok: true, version: nextVersion };
    }
    if (method === "herdr.command" && params?.command === "pane.split") {
      const paneId = String(params?.args?.pane ?? "").trim();
      const direction = params?.args?.direction === "down" ? "down" : "right";
      const axis = direction === "right" ? "row" : "column";
      const entry = demoHerdrDocs[to];
      if (!paneId || !entry) throw new Error(`no pane ${paneId}`);
      const termId = `t${++mockTermSeq}`;
      const newPaneId = `p${++mockPaneSeq}`;
      let hitSpaceName = "";
      let hitTabName = "1";
      let hitFolder = to === "dev-linux" ? "~/repos/sample-cli" : "~/work/demo-app";
      let inserted = false;

      const splitNode = (node: any): any => {
        if (!node || typeof node !== "object") return node;
        if (node.type === "block" && node.id === paneId) {
          inserted = true;
          const share = node.size?.weight ?? 1;
          const prevCopy = { ...node, size: { weight: share / 2 } };
          const nextBlock = { id: newPaneId, type: "block", size: { weight: share / 2 }, content: { terminal: termId } };
          return { id: `s${++mockSplitSeq}`, type: axis, children: [prevCopy, nextBlock] };
        }
        if ((node.type === "row" || node.type === "column") && Array.isArray(node.children)) {
          if (node.type === axis) {
            const idx = node.children.findIndex((c: any) => c?.id === paneId);
            if (idx >= 0) {
              inserted = true;
              const target = node.children[idx];
              const share = target.size?.weight ?? 1;
              const kids = [...node.children];
              kids.splice(
                idx,
                1,
                { ...target, size: { weight: share / 2 } },
                { id: newPaneId, type: "block", size: { weight: share / 2 }, content: { terminal: termId } },
              );
              return { ...node, children: kids };
            }
          }
          return { ...node, children: node.children.map(splitNode) };
        }
        return node;
      };

      for (const sp of entry.value.spaces) {
        for (const tb of sp.tabs) {
          const prevInserted = inserted;
          tb.root = splitNode(tb.root);
          if (!prevInserted && inserted) {
            hitSpaceName = sp.name || "";
            hitTabName = tb.name || "1";
            hitFolder = sp.folder || hitFolder;
            break;
          }
        }
        if (inserted) break;
      }
      if (!inserted) throw new Error(`no pane ${paneId}`);
      entry.version += 1;

      const key = `${to}/hc:${termId}`;
      const ag: Agent = {
        key,
        deviceId: to,
        source: "hc",
        localId: termId,
        harness: "zsh",
        title: "终端",
        where: hitSpaceName ? `${hitSpaceName} / ${hitTabName}` : hitTabName,
        cwd: hitFolder,
        status: "idle",
        statusSince: Date.now(),
        isShell: true,
        updatedAt: Date.now(),
      };
      DEMO_AGENTS.unshift(ag);
      DEMO_TERMINALS[key] = [`zsh · ${hitFolder}`, `${hitFolder} $ `];
      mockApi.connect();
      return { ok: true, result: { pane: newPaneId, terminal: termId } };
    }
    if (method === "herdr.command" && params?.command === "space.rename") {
      const spaceId = String(params?.args?.id ?? "").trim();
      const rawName = String(params?.args?.name ?? "").trim();
      const entry = demoHerdrDocs[to];
      const sp = entry?.value.spaces.find((s) => s.id === spaceId);
      if (!sp || !entry) throw new Error("找不到这个空间");
      const autoName = (sp.folder || "").replace(/[\\/]+$/, "").split("/").filter(Boolean).pop() || sp.id;
      const nextName = rawName || autoName;
      const oldName = sp.name;
      sp.name = nextName;
      entry.version += 1;
      for (const ag of DEMO_AGENTS) {
        if (ag.deviceId !== to || !ag.where) continue;
        if (ag.where === oldName) {
          ag.where = nextName;
        } else if (oldName && ag.where.startsWith(`${oldName} / `)) {
          ag.where = `${nextName}${ag.where.slice(oldName.length)}`;
        }
      }
      mockApi.connect();
      return { ok: true, result: { id: sp.id, name: nextName } };
    }
    if (method === "folders.list") {
      const req = (params.path ?? "").trim() || "~";
      const dirs: Record<string, Array<{ name: string; path: string }>> = {
        "~": [
          { name: "work", path: "~/work" },
          { name: "repos", path: "~/repos" },
          { name: "tmp", path: "~/tmp" },
        ],
        "~/work": [
          { name: "demo-app", path: "~/work/demo-app" },
          { name: "herdr-pocket", path: "~/work/herdr-pocket" },
        ],
        "~/repos": [{ name: "sample-cli", path: "~/repos/sample-cli" }],
      };
      const norm = req.replace(/\/+$/, "") || "~";
      const slash = norm.lastIndexOf("/");
      const parent = norm === "~" ? null : slash > 0 ? norm.slice(0, slash) : "~";
      return { path: norm, displayPath: norm, parent, entries: dirs[norm] ?? [] };
    }
    if (method === "agent.commands") {
      const a = DEMO_AGENTS.find((x) => x.key === params.agent);
      return {
        harness: a?.harness ?? "claude",
        commands: [
          { name: "/deploy", description: "部署到预发布环境并运行冒烟检查", argHint: "[env]", category: "custom", source: "project" },
          { name: "/plan", description: "切换结构化分步规划视图", category: "skill", source: "user" },
        ],
      };
    }
    if (method === "agent.usage") {
      const a = DEMO_AGENTS.find((x) => x.key === params.agent);
      const activeModel = a?.model ?? "claude-opus-5-5";
      return {
        harness: a?.harness ?? "claude-code",
        sessionKey: a?.sessionKey,
        model: activeModel,
        session: {
          turns: 4,
          steps: 18,
          prompts: 4,
          input: 141_017,
          output: 26_551,
          cacheRead: 530_620,
          cacheWrite: 12_400,
          reasoning: 1_840,
          costUsd: 1.42,
          unpricedSteps: 0,
          contextTokens: 73_266,
          contextLimit: 200_000,
          contextPct: 36.63,
        },
        models: [
          { model: activeModel, steps: 14, input: 118_000, output: 22_100, cacheRead: 490_000, cacheWrite: 12_400, costUsd: 1.31, unpricedSteps: 0 },
          { model: "claude-haiku-5-5", steps: 4, input: 23_017, output: 4_451, cacheRead: 40_620, cacheWrite: 0, costUsd: 0.11, unpricedSteps: 0 },
        ],
        day24h: {
          harness: { key: "claude", label: a?.harness ?? "claude-code", sessions: 6, steps: 84, prompts: 18, input: 320_000, output: 54_000, cacheRead: 1_900_000, cacheWrite: 45_000, costUsd: 4.86 },
          total: { key: "total", label: "total", sessions: 11, steps: 142, prompts: 31, input: 580_000, output: 88_000, cacheRead: 2_840_000, cacheWrite: 62_000, costUsd: 8.15 },
        },
        day7d: {
          harness: { key: "claude", label: a?.harness ?? "claude-code", sessions: 28, steps: 512, prompts: 109, input: 1_840_000, output: 310_000, cacheRead: 9_600_000, cacheWrite: 220_000, costUsd: 26.4 },
          total: { key: "total", label: "total", sessions: 44, steps: 890, prompts: 192, input: 3_120_000, output: 495_000, cacheRead: 14_200_000, cacheWrite: 310_000, costUsd: 41.8 },
        },
        quotas: [
          { provider: "anthropic", account: "us***@example.com", label: "5 小时滑动窗口", usedPct: 34.5, resetAt: Date.now() + 2 * 3_600_000 },
          { provider: "anthropic", account: "us***@example.com", label: "7 天周额度", usedPct: 18.0, resetAt: Date.now() + 4 * 86_400_000 },
        ],
      };
    }
    if (method === "agent.models") {
      const a = DEMO_AGENTS.find((x) => x.key === params.agent);
      const harness = a?.harness ?? "claude-code";
      const hNorm = normalizeSwitchHarness(harness);
      const isOmp = hNorm === "omp";
      const cur = a?.model ?? (isOmp ? "demo/mimo-v2.6-pro" : hNorm === "antigravity" ? "gemini-4-neon-high" : "claude-opus-5-5");
      const pool = buildDemoModelsPool(harness);
      const matched = findModelOptionForModel(pool, cur, { harness, modelRoles: isOmp ? demoOmpModelRoles : undefined });
      const curEntry: AgentModelOption = matched
        ? { ...matched, id: matched.effortModelMap ? matched.id : cur, source: "current" }
        : demoModelOpt(harness, cur, cur, "custom", 200_000, "current");
      const models = [curEntry, ...pool.filter((x) => x.id !== curEntry.id)];
      const thinkingLevels = resolveThinkingLevelsForModel(
        {
          harness,
          models,
          currentModel: cur,
          modelRoles: isOmp ? demoOmpModelRoles : undefined,
        },
        cur,
      );
      const currentThinking =
        thinkingLevels.length > 0
          ? clampThinkingLevel(
              thinkingLevels,
              demoThinkingByAgent.get(a?.key ?? "") ?? extractModelExplicitEffort(cur) ?? (isOmp ? "xhigh" : "high"),
              cur,
            )
          : undefined;
      return {
        harness,
        currentModel: cur,
        ...(currentThinking ? { currentThinking } : {}),
        thinkingLevels,
        canSwitchThinking: !a?.isShell && thinkingLevels.length > 0,
        canSwitch: !a?.isShell,
        ...(isOmp ? { modelRoles: { ...demoOmpModelRoles } } : {}),
        ...(a?.isShell ? { reason: "普通终端不支持切换模型" } : {}),
        models,
      };
    }
    if (method === "agent.setModel") {
      const a = DEMO_AGENTS.find((x) => x.key === params.agent);
      const harness = a?.harness ?? "claude-code";
      const cleanModel = typeof params.modelId === "string" ? params.modelId.trim() : undefined;
      const cleanThinking = typeof params.thinkingLevel === "string" ? params.thinkingLevel.trim().toLowerCase() : undefined;
      if (typeof params.roleSlot === "string" && cleanModel) {
        const selector = cleanThinking ? `${stripModelEffortSuffix(cleanModel)}:${cleanThinking}` : cleanModel;
        demoOmpModelRoles[params.roleSlot] = selector;
        return {
          ok: true as const,
          modelRoles: { ...demoOmpModelRoles },
          note: `已更新 OMP 角色 ${params.roleSlot} -> ${selector}`,
        };
      }
      const pool = buildDemoModelsPool(harness);
      let resolvedModel = cleanModel?.startsWith("@")
        ? demoOmpModelRoles[cleanModel.slice(1).toLowerCase()] ?? cleanModel
        : cleanModel;
      if (!resolvedModel && cleanThinking && a?.model) {
        const matched = findModelOptionForModel(pool, a.model, { harness });
        const mapped = matched?.effortModelMap?.[cleanThinking as AgentThinkingLevel];
        if (mapped) resolvedModel = mapped;
      }
      const nextModelForInfer = resolvedModel ?? a?.model;
      const matchedOpt = findModelOptionForModel(pool, nextModelForInfer, { harness });
      const levels = resolveThinkingLevelsForModel(
        {
          harness,
          models: pool,
          currentModel: nextModelForInfer,
        },
        nextModelForInfer,
      );
      const clampedThinking =
        levels.length > 0
          ? clampThinkingLevel(
              levels,
              cleanThinking ?? extractModelExplicitEffort(resolvedModel) ?? demoThinkingByAgent.get(a?.key ?? ""),
              nextModelForInfer,
            )
          : undefined;
      const storedModel = resolvedModel ? stripModelEffortSuffix(resolvedModel) : undefined;
      if (a && resolvedModel) a.model = matchedOpt?.effortModelMap ? resolvedModel : storedModel ?? resolvedModel;
      if (a) {
        if (clampedThinking) demoThinkingByAgent.set(a.key, clampedThinking);
        else demoThinkingByAgent.delete(a.key);
      }
      return {
        ok: true as const,
        ...(resolvedModel ? { currentModel: resolvedModel } : {}),
        ...(clampedThinking ? { currentThinking: clampedThinking } : {}),
      };
    }
    if (method === "agent.btw") {
      const a = DEMO_AGENTS.find((x) => x.key === params.agent);
      const q = typeof params.question === "string" ? params.question.trim() : "";
      return {
        answer: `（演示旁路 \`/btw\`）已只读查看 **${a?.title || a?.harness || "Agent"}** 最近上下文，不会向主终端输入。\n\n- 提问：${q}\n- 主会话状态：\`${a?.status ?? "idle"}\``,
        model: a?.model ?? "demo-sidechannel",
        durationMs: 42,
      };
    }
    if (method === "space.delete") {
      const entry = demoHerdrDocs[to];
      const reqId = typeof params?.spaceId === "string" ? params.spaceId : "";
      const reqName = typeof params?.spaceName === "string" ? params.spaceName : "";
      let closedTerminals = 0;
      if (entry) {
        const sp = entry.value.spaces.find((s) => (reqId ? s.id === reqId : s.name === reqName));
        if (sp) {
          entry.value.spaces = entry.value.spaces.filter((s) => s.id !== sp.id);
          entry.version += 1;
          const spName = sp.name;
          for (let i = DEMO_AGENTS.length - 1; i >= 0; i -= 1) {
            const ag = DEMO_AGENTS[i]!;
            const agSp = ag.where?.split(" / ")[0]?.trim() ?? "";
            if (ag.deviceId === to && agSp === spName) {
              DEMO_AGENTS.splice(i, 1);
              delete DEMO_EVENTS[ag.key];
              delete DEMO_TERMINALS[ag.key];
              closedTerminals += 1;
            }
          }
          mockApi.connect();
        }
      }
      return { ok: true as const, closedTerminals };
    }
    if (method === "git.status") {
      const root = (typeof params.cwd === "string" && params.cwd.trim()) || "~/work/demo-app";
      return {
        isRepo: true,
        root,
        branch: "feat/oauth-guard",
        upstream: "origin/feat/oauth-guard",
        ahead: 1,
        behind: 0,
        branches: ["feat/oauth-guard", "main", "release/0.2"],
        staged: [
          { path: "src/auth/state.ts", status: "A", staged: true, additions: 28, deletions: 0 },
        ],
        unstaged: [
          { path: "src/auth/callback.ts", status: "M", staged: false, additions: 14, deletions: 3 },
          { path: "README.md", status: "M", staged: false, additions: 4, deletions: 1 },
          { path: "notes/todo.md", status: "?", staged: false },
        ],
        repos: [
          { root: "~/work/demo-app", name: "demo-app", branch: "feat/oauth-guard", upstream: "origin/feat/oauth-guard", ahead: 1, behind: 0, dirtyCount: 4 },
          { root: "~/repos/sample-cli", name: "sample-cli", branch: "main", upstream: "origin/main", ahead: 0, behind: 1, dirtyCount: 0 },
        ],
      };
    }
    if (method === "git.diff") {
      return {
        path: params.path ?? "src/auth/callback.ts",
        staged: Boolean(params.staged),
        patch: [
          `diff --git a/${params.path} b/${params.path}`,
          `--- a/${params.path}`,
          `+++ b/${params.path}`,
          "@@ -12,6 +12,11 @@ export async function verifyOAuthCallback(req: Request) {",
          "   const state = req.searchParams.get('state');",
          "-  if (!state) throw new Error('missing state');",
          "+  if (!state || !isValidPkceState(state)) {",
          "+    throw new AuthError('invalid_state', 401);",
          "+  }",
          "+  await consumeStateToken(state);",
          "   return exchangeCode(req);",
          " }",
        ].join("\n"),
        additions: 4,
        deletions: 1,
      };
    }
    if (method === "git.log") {
      return {
        commits: [
          { hash: "a1b2c3d4e5f6", shortHash: "a1b2c3d", subject: "feat(auth): enforce PKCE state signature", author: "crosery", dateMs: now - 18 * min, refs: "HEAD -> feat/oauth-guard" },
          { hash: "9876543210fe", shortHash: "9876543", subject: "fix(relay): tighten socket pong timeout", author: "crosery", dateMs: now - 140 * min, refs: "main" },
        ],
      };
    }
    if (method === "git.stage" || method === "git.unstage" || method === "git.discard") {
      return { ok: true };
    }
    if (method === "git.commit") {
      return { hash: "f9e8d7c", subject: String(params.message ?? "").split("\n")[0] || "demo commit" };
    }
    if (method === "git.checkout") {
      return { branch: String(params.branch ?? "main") };
    }
    if (method === "git.pull") {
      return { summary: "Already up to date." };
    }
    if (method === "git.push") {
      return { summary: "Everything up-to-date." };
    }
    if (method === "terminal.put") {
      return { paths: (params.files ?? []).map((f: any, i: number) => `/tmp/mock-${i}-${f.name}`) };
    }
    if (method === "terminal.send") {
      const textStr = String(params.text ?? "");
      const modelMatch = /^\/model\s+(\S+)/i.exec(textStr.trim());
      if (modelMatch) {
        const targetAgent = DEMO_AGENTS.find((x) => x.key === params.agent);
        if (targetAgent) {
          targetAgent.model = modelMatch[1];
          mockApi.connect();
        }
      }
      const prev = DEMO_EVENTS[params.agent] ?? [];
      DEMO_EVENTS[params.agent] = [
        ...prev,
        { id: `u-${Date.now()}`, session: params.agent, ts: Date.now(), kind: "user_message", text: textStr },
        {
          id: `a-${Date.now() + 1}`,
          session: params.agent,
          ts: Date.now() + 1,
          kind: "assistant_message",
          text: modelMatch ? `（演示模式已切换模型为 \`${modelMatch[1]}\`）` : `（演示模式已收到：${textStr}）`,
        },
      ];
      const term = DEMO_TERMINALS[params.agent] ?? [];
      DEMO_TERMINALS[params.agent] = [...term, `> ${textStr}`, "\x1b[32m✓ 演示指令已送达\x1b[0m"];
      return { ok: true };
    }
    if (method === "terminal.keys") {
      const term = DEMO_TERMINALS[params.agent] ?? [];
      DEMO_TERMINALS[params.agent] = [...term, `\x1b[90m[key: ${(params.keys ?? []).join(" + ")}]\x1b[0m`];
      return { ok: true };
    }
    if (method === "terminal.input") {
      return { ok: true };
    }
    if (method === "terminal.kill") {
      const key = String(params?.agent ?? "");
      const idx = DEMO_AGENTS.findIndex((x) => x.key === key || x.localId === key);
      if (idx >= 0) {
        const [removed] = DEMO_AGENTS.splice(idx, 1);
        if (removed) {
          delete DEMO_EVENTS[removed.key];
          delete DEMO_TERMINALS[removed.key];
          const docEntry = demoHerdrDocs[removed.deviceId];
          if (docEntry && removed.localId) {
            const prune = (n: any): any => {
              if (!n) return null;
              if (n.type === "block") return n.content?.terminal === removed.localId ? null : n;
              if (Array.isArray(n.children)) {
                const kids = n.children.map(prune).filter(Boolean);
                if (!kids.length) return null;
                if (kids.length === 1) return kids[0];
                return { ...n, children: kids };
              }
              return n;
            };
            for (const sp of docEntry.value.spaces) {
              sp.tabs = sp.tabs
                .map((t) => ({ ...t, root: prune(t.root) }))
                .filter((t) => Boolean(t.root)) as any;
            }
            docEntry.version += 1;
          }
        }
        mockApi.connect();
      } else {
        liveStore.set((prev) => {
          const nextAgents: Record<string, Agent[]> = {};
          let changed = false;
          for (const [devId, list] of Object.entries(prev.agents)) {
            const filtered = list.filter((a) => a.key !== key && a.localId !== key);
            if (filtered.length !== list.length) changed = true;
            nextAgents[devId] = filtered;
          }
          return changed ? { ...prev, agents: nextAgents, rev: prev.rev + 1 } : prev;
        });
      }
      return { ok: true };
    }
    if (method === "agent.create") {
      const id = `t${++mockTermSeq}`;
      const newTabId = `tb${++mockTermSeq}`;
      const newPaneId = `p${++mockPaneSeq}`;
      const key = `${to}/hc:${id}`;
      const isShell = params.launcher === "shell";
      const docEntry = (demoHerdrDocs[to] ??= { value: { spaces: [] }, version: 1 });
      let targetSpace =
        (params.space ? docEntry.value.spaces.find((sp) => sp.id === params.space) : undefined) ??
        (params.spaceName ? docEntry.value.spaces.find((sp) => sp.name === params.spaceName) : undefined);
      if (!targetSpace) {
        const spId = params.space || `sp-${++mockTermSeq}`;
        const spFolder = params.folder || "~/work/demo-app";
        const spName = params.spaceName || spFolder.split("/").filter(Boolean).pop() || "workspace";
        targetSpace = { id: spId, name: spName, folder: spFolder, tabs: [] };
        docEntry.value.spaces.push(targetSpace);
      }
      targetSpace.tabs.push({
        id: newTabId,
        name: params.tabName || "",
        root: { id: newPaneId, type: "block", content: { terminal: id } },
      });
      docEntry.version += 1;

      const resolvedCwd = params.folder || targetSpace.folder || "~/work/demo-app";
      const tabLabel = params.tabName || `${targetSpace.tabs.length}`;
      const ag: Agent = {
        key,
        deviceId: to,
        source: "hc",
        localId: id,
        harness: isShell ? "zsh" : params.launcher || "claude-code",
        title: params.task || params.tabName || (isShell ? "终端" : "新建 Agent"),
        where: `${targetSpace.name} / ${tabLabel}`,
        cwd: resolvedCwd,
        status: isShell ? "idle" : "working",
        statusSince: Date.now(),
        isShell,
        sessionKey: isShell ? undefined : `demo:${id}`,
        updatedAt: Date.now(),
      };
      DEMO_AGENTS.unshift(ag);
      DEMO_EVENTS[key] = !isShell && params.task ? [{ id: `u-${Date.now()}`, session: ag.sessionKey!, ts: Date.now(), kind: "user_message", text: params.task }] : [];
      DEMO_TERMINALS[key] = [`${ag.harness} · ${ag.cwd}`, params.task ? `$ ${params.task}` : "$ ready"];
      mockApi.connect();
      return { agent: key, space: targetSpace.id, tab: newTabId, terminal: id, task: "started" };
    }
    if (method === "agent.seen") {
      const reqKey = String(params?.agent ?? "");
      let changed = false;
      for (const a of DEMO_AGENTS) {
        if ((a.key === reqKey || a.localId === reqKey) && a.status === "done") {
          a.status = "idle";
          a.updatedAt = Date.now();
          changed = true;
        }
      }
      if (changed) mockApi.connect();
      return { ok: true };
    }
    return { ok: true };
  },
  assistantState: (): AssistantState => ({ ...demoAssistantState, items: [...demoAssistantState.items] }),
  say(text: string): AssistantItem {
    const userItem: AssistantItem = { id: `u-${Date.now()}`, ts: Date.now(), role: "user", text };
    const reply: AssistantItem = {
      id: `a-${Date.now() + 1}`,
      ts: Date.now() + 1,
      role: "assistant",
      text: `（演示模式）目前 **workstation** 上「重构登录回调与权限校验」正在等你选择迁移方案，**buildbox** 的打包任务已完成。`,
      steps: ["查看 2 台电脑状态", "检查最新会话"],
    };
    demoAssistantState = { ...demoAssistantState, items: [...demoAssistantState.items, userItem, reply] };
    return userItem;
  },
  clearAssistant(): void {
    demoAssistantState = { ...demoAssistantState, items: [] };
  },
  configView: (): AssistantConfigView => ({ ...demoConfig, providers: demoConfig.providers.map((p) => ({ ...p })), models: demoConfig.models.map((m) => ({ ...m })) }),
  saveConfig(patch: AssistantConfigChange): AssistantConfigView {
    if (patch.reset) {
      const base = demoAssistantConfig(demoConfig.rev + 1);
      // Reset drops what apps added: only the server's provider stays.
      demoConfig = { ...base, providers: base.providers.filter((p) => p.from === "server") };
      return mockApi.configView();
    }
    if (patch.name !== undefined) demoConfig.name = patch.name;
    for (const p of patch.providers ?? []) {
      const idx = demoConfig.providers.findIndex((x) => x.id === p.id);
      if (p.reset && p.id === DEMO_SERVER_PROVIDER.id) {
        const orig = { ...DEMO_SERVER_PROVIDER, key: { ...DEMO_SERVER_PROVIDER.key } };
        if (idx >= 0) demoConfig.providers[idx] = orig;
        else demoConfig.providers.unshift(orig);
        continue;
      }
      if (p.remove) {
        if (idx >= 0 && demoConfig.providers[idx]!.from === "phone") demoConfig.providers.splice(idx, 1);
        continue;
      }
      if (idx >= 0) {
        const cur = demoConfig.providers[idx]!;
        demoConfig.providers[idx] = {
          ...cur,
          ...(p.label !== undefined ? { label: p.label || undefined } : {}),
          ...(p.protocol !== undefined ? { protocol: p.protocol } : {}),
          ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
          ...(p.auth !== undefined ? { auth: p.auth ?? undefined } : {}),
          ...(p.apiKey !== undefined
            ? {
                key:
                  p.apiKey === null
                    ? { set: false, hint: null, from: null }
                    : { set: true, hint: p.apiKey.slice(-4), from: "phone" },
              }
            : {}),
        };
      } else {
        demoConfig.providers.push({
          id: p.id,
          label: p.label || p.id,
          protocol: p.protocol ?? "openai",
          baseUrl: p.baseUrl ?? "https://api.example.com/v1",
          ...(p.auth ? { auth: p.auth } : {}),
          key: p.apiKey ? { set: true, hint: p.apiKey.slice(-4), from: "phone" } : { set: false, hint: null, from: null },
          from: "phone",
        });
      }
    }
    if (patch.models) demoConfig.models = patch.models;
    if (patch.voice) {
      const v = patch.voice;
      demoConfig.voice = {
        provider: v.provider === undefined ? demoConfig.voice.provider : v.provider,
        url: v.url === null ? undefined : (v.url ?? demoConfig.voice.url),
        model: v.model === null ? undefined : (v.model ?? demoConfig.voice.model),
        voice: v.voice === null ? undefined : (v.voice ?? demoConfig.voice.voice),
        speed: v.speed === null ? undefined : (v.speed ?? demoConfig.voice.speed),
        key:
          v.apiKey === null
            ? { set: false, hint: null, from: null }
            : v.apiKey
              ? { set: true, hint: v.apiKey.slice(-4), from: "phone" }
              : demoConfig.voice.key,
      };
    }
    demoConfig = { ...demoConfig, rev: demoConfig.rev + 1, edited: true };
    return mockApi.configView();
  },
  listModels(provider: string | ProviderPatch): string[] {
    const id = typeof provider === "string" ? provider : provider.id;
    const url = typeof provider === "string" ? "" : provider.baseUrl ?? "";
    if (id.includes("mimo") || url.includes("xiaomimimo.com")) return ["mimo-v2.6-flash", "mimo-v2.6-pro"];
    if (id.includes("gemini") || (typeof provider !== "string" && provider.protocol === "gemini")) return ["gemini-2.5-flash", "gemini-2.5-pro"];
    if (id.includes("ollama") || (typeof provider !== "string" && provider.protocol === "ollama")) return ["qwen3:8b", "llama3.3"];
    return DEMO_MODEL_LISTS[id] ?? ["gpt-demo", "gpt-demo-fast"];
  },
  /** A demo speed test: plausible times, a 404 for a model the provider does not list, a key error without a key. */
  async testModel(body: { provider: string | ProviderPatch; model: string }): Promise<{ ok: boolean; firstMs?: number; totalMs?: number; reply?: string; error?: string }> {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const model = body.model.trim();
    const id = typeof body.provider === "string" ? body.provider : body.provider.id;
    const saved = demoConfig.providers.find((p) => p.id === id);
    const keyed = typeof body.provider === "string" ? Boolean(saved?.key.set) : Boolean(body.provider.apiKey || saved?.key.set);
    const free = typeof body.provider === "string" ? saved?.auth === "none" || saved?.protocol === "ollama" : body.provider.auth === "none" || body.provider.protocol === "ollama";
    await wait(300);
    if (typeof body.provider === "string" && !saved) return { ok: false, error: `没有叫 ${id} 的服务商。` };
    if (!keyed && !free) return { ok: false, totalMs: 320, error: "HTTP 401: invalid api key" };
    const list = DEMO_MODEL_LISTS[id];
    if (list && !list.includes(model)) {
      await wait(300);
      return { ok: false, totalMs: 640, error: `服务商说没有这个模型：${model}（404）` };
    }
    const [first, total] = DEMO_SPEED[model] ?? [1400, 2300];
    const jitter = () => 0.88 + Math.random() * 0.24;
    const firstMs = Math.round(first * jitter());
    const totalMs = Math.max(firstMs + 200, Math.round(total * jitter()));
    await wait(Math.min(Math.round(totalMs / 3), 900));
    return { ok: true, firstMs, totalMs, reply: "你好，我在。" };
  },
  voiceCatalog: () => ({ provider: "openai-realtime" as const, defaultVoice: "marin", voices: [...OPENAI_REALTIME_VOICES] }),
  prompts: (): PromptView[] => demoPrompts.map((p) => ({ ...p })),
  savePrompt(id: PromptId, body: { text?: string; reset?: boolean }): PromptView {
    const p = demoPrompts.find((x) => x.id === id);
    if (!p) throw new Error("未找到提示词");
    p.text = body.reset ? p.defaultText : (body.text ?? p.text);
    p.edited = p.text !== p.defaultText;
    return { ...p };
  },
};
