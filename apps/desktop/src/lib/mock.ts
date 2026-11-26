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
  type AssistantSettings,
  type AssistantState,
  type ConvEvent,
  type Device,
  type DeviceKind,
  type FileEntry,
  type HerdrDoc,
  type HostPortalCapabilities,
  type HostToolId,
  type HostTools,
  type PairCode,
  type PairResponse,
  type PortalFileTicket,
  type PortalFramePayload,
  type PortalInputAction,
  type PortalItem,
  type PortalKind,
  type PortalStreamEvent,
  type PromptId,
  type PromptView,
  type ProviderPatch,
  type RemoteWindowInfo,
  type RpcMethod,
  type StreamKind,
  type SubSession,
  type ToolUpdateItemResult,
  type ToolUpdateJobSnapshot,
} from "@herdr-pocket/protocol";
import { clientConfigStore } from "./config";
import { browserSpacesStore } from "./browserSpaces";
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
    size: 760,
    body: "<!doctype html><html><body style=\"margin:0;padding:36px;font-family:system-ui,-apple-system,sans-serif;background:linear-gradient(135deg,#fff5f9,#ffeaf3);color:#20182a\"><div style=\"background:#ffffff;border:2px solid #f0b6cf;border-radius:24px;padding:28px;box-shadow:0 12px 32px rgba(235,64,122,0.12)\"><div style=\"font-size:24px;font-weight:800;color:#b81b56;margin-bottom:14px\">OAuth PKCE &amp; External Delivery</div><div style=\"display:flex;gap:14px;font-size:19px;font-weight:600;color:#4a3d55\"><span style=\"padding:10px 16px;border-radius:12px;background:#fff0f6;border:1px solid #f0b6cf\">1. Auth Callback</span><span>&rarr;</span><span style=\"padding:10px 16px;border-radius:12px;background:#ecfdf5;border:1px solid #6ee7b7;color:#065f46\">2. Token Verified</span><span>&rarr;</span><span style=\"padding:10px 16px;border-radius:12px;background:#eef2ff;border:1px solid #a5b4fc;color:#3730a3\">3. Ready</span></div></div></body></html>",
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
    {
      id: "m3",
      ts: now - 1 * min,
      role: "notice",
      text: "「release」桌面全量测试已通过，鸿蒙构建还在后台执行，暂时不用管。",
      notice: {
        id: "n2",
        kind: "done",
        title: "release · 还在跑",
        body: "桌面全量测试已通过，鸿蒙构建还在后台执行，暂时不用管。",
        verdict: "running",
        agent: "dev-mac/hc:t2",
        ts: now - 1 * min,
      },
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

const DEMO_HOST_TOOLS_STATE: Record<string, HostTools> = {
  "dev-mac": {
    app: "0.9.4",
    herdr: "0.6.2",
    hc: "0.6.2",
    uniflo: "1.3.0",
    latest: {
      app: "0.9.5",
      herdr: "0.6.3",
      hc: "0.7.0",
      uniflo: "1.3.0",
      hostd: "0.2.25",
      checkedAt: now - 3 * 60 * min,
    },
  },
  "dev-linux": {
    hc: "0.7.0",
    uniflo: "1.2.1",
    latest: {
      hc: "0.7.0",
      uniflo: "1.3.0",
      hostd: "0.2.25",
      checkedAt: now - 15 * min,
    },
  },
};

function demoEnsureHostTools(hostId: string): HostTools {
  const existing = DEMO_HOST_TOOLS_STATE[hostId];
  if (existing) {
    return { ...existing, latest: existing.latest ? { ...existing.latest } : undefined };
  }
  const created: HostTools = {
    hc: "0.7.0",
    uniflo: "1.3.0",
    latest: { hc: "0.7.0", uniflo: "1.3.0", checkedAt: Date.now() },
  };
  DEMO_HOST_TOOLS_STATE[hostId] = created;
  return { ...created, latest: { ...created.latest } };
}

const demoToolJobs: Record<string, ToolUpdateJobSnapshot> = {};
let demoPortalSeq = 10;
let demoFrameSeq = 1;

function demoCapabilities(hostId: string): HostPortalCapabilities {
  if (hostId === "dev-linux") {
    return {
      platform: "linux",
      sessionType: "wayland-wlroots",
      desktopEnv: "Hyprland",
      canListWindows: true,
      canCaptureWindow: true,
      canCaptureScreen: true,
      canInjectInput: true,
      hasCdpBrowser: true,
      directPort: null,
    };
  }
  return {
    platform: "darwin",
    sessionType: "macos",
    desktopEnv: "Aqua",
    canListWindows: true,
    canCaptureWindow: true,
    canCaptureScreen: true,
    canInjectInput: true,
    hasCdpBrowser: true,
    directPort: null,
  };
}

function demoWindowsForHost(hostId: string): RemoteWindowInfo[] {
  if (hostId === "dev-linux") {
    return [
      { id: "screen:0", appName: "Hyprland Display", title: "主显示器 2560x1440", bounds: { x: 0, y: 0, width: 2560, height: 1440 }, isScreen: true },
      { id: "win:chromium-1", appName: "Chromium", title: "OAuth Authorization - Chromium", bounds: { x: 80, y: 60, width: 1180, height: 820 }, pid: 2410 },
      { id: "win:dolphin-1", appName: "Dolphin", title: "sample-cli / dist", bounds: { x: 180, y: 120, width: 920, height: 640 }, pid: 2480 },
    ];
  }
  return [
    { id: "screen:0", appName: "macOS 桌面", title: "屏幕 1 (1728×1117)", displayIndex: 0, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1728, height: 1117 }, isScreen: true },
    { id: "screen:1", appName: "macOS 桌面", title: "扩展显示器 2 (2560×1440)", displayIndex: 1, scaleFactor: 1, bounds: { x: 1728, y: 0, width: 2560, height: 1440 }, isScreen: true },
    { id: "win:chrome-1", appName: "Google Chrome", title: "GitHub OAuth 登录授权", bounds: { x: 120, y: 90, width: 1140, height: 780 }, pid: 4120 },
    { id: "win:finder-1", appName: "Finder", title: "docs — external-delivery-sequence.html", bounds: { x: 220, y: 140, width: 880, height: 560 }, pid: 418 },
  ];
}

const demoPortals: PortalItem[] = [
  {
    id: "ptl-demo-oauth",
    hostId: "dev-mac",
    agentKey: "dev-mac/hc:t2",
    terminalId: "t2",
    kind: "browser",
    title: "GitHub OAuth 登录授权 · 127.0.0.1:8787",
    subtitle: "http://127.0.0.1:8787/oauth/callback?provider=github",
    url: "http://127.0.0.1:8787/oauth/callback?provider=github",
    canInteract: true,
    transportHint: "p2p",
    width: 960,
    height: 600,
    createdAt: now - 2 * min,
    updatedAt: now - 10_000,
  },
  {
    id: "ptl-demo-reveal",
    hostId: "dev-mac",
    agentKey: "dev-mac/hc:t1",
    terminalId: "t1",
    kind: "reveal",
    title: "external-delivery-sequence.html",
    subtitle: "定位文件：external-delivery-sequence.html",
    targetPath: "docs/external-delivery-sequence.html",
    parentDir: "docs",
    highlightName: "external-delivery-sequence.html",
    mime: "text/html",
    size: 280,
    canInteract: false,
    transportHint: "p2p",
    createdAt: now - 3 * min,
    updatedAt: now - 20_000,
  },
  {
    id: "ptl-demo-html",
    hostId: "dev-mac",
    agentKey: "dev-mac/hc:t1",
    terminalId: "t1",
    kind: "html",
    title: "OAuth PKCE Architecture.html",
    subtitle: "docs/oauth-flow.html",
    targetPath: "docs/external-delivery-sequence.html",
    mime: "text/html",
    size: 280,
    canInteract: false,
    transportHint: "p2p",
    createdAt: now - 4 * min,
    updatedAt: now - 30_000,
  },
  {
    id: "ptl-demo-window",
    hostId: "dev-mac",
    agentKey: "dev-mac/hc:t4",
    terminalId: "t4",
    kind: "window",
    windowId: "win:chrome-1",
    title: "Dev Console · 127.0.0.1:3000",
    subtitle: "Google Chrome · 本地调试预览",
    canInteract: true,
    transportHint: "p2p",
    width: 1140,
    height: 780,
    createdAt: now - 5 * min,
    updatedAt: now - 40_000,
  },
];

// Minimal 1x1 PNG fallback for Node unit tests when canvas is unavailable.
const FALLBACK_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const mockCursorByPortal = new Map<string, { nx: number; ny: number; lastAction: string; showCursor: boolean; fps: number; maxWidth: number; quality: number }>();
let mockClipboardText = "https://example.com/demo-copied-from-remote";

function demoPortalMeta(portalId: string) {
  let meta = mockCursorByPortal.get(portalId);
  if (!meta) {
    meta = { nx: 0.42, ny: 0.56, lastAction: "ready", showCursor: true, fps: 60, maxWidth: 1600, quality: 72 };
    mockCursorByPortal.set(portalId, meta);
  }
  return meta;
}

function renderDemoFramePngBase64(item: PortalItem): { data: string; width: number; height: number; cursorX: number; cursorY: number; cursorVisible: boolean } {
  const meta = demoPortalMeta(item.id);
  if (typeof document === "undefined") {
    return { data: FALLBACK_PNG_B64, width: 960, height: 600, cursorX: meta.nx, cursorY: meta.ny, cursorVisible: true };
  }
  try {
    const w = 960;
    const h = 600;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { data: FALLBACK_PNG_B64, width: w, height: h, cursorX: meta.nx, cursorY: meta.ny, cursorVisible: true };

    ctx.fillStyle = "#fff9fb";
    ctx.fillRect(0, 0, w, h);

    // Window header chrome
    ctx.fillStyle = "#fce7f3";
    ctx.fillRect(0, 0, w, 52);
    ctx.fillStyle = "#f472b6";
    ctx.beginPath();
    ctx.arc(28, 26, 7, 0, Math.PI * 2);
    ctx.arc(52, 26, 7, 0, Math.PI * 2);
    ctx.arc(76, 26, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#831843";
    ctx.font = "600 18px sans-serif";
    ctx.fillText(item.title || "Remote Return Channel", 110, 32);

    // URL / subtitle bar
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(48, 86, w - 96, 46);
    ctx.strokeStyle = "#f9a8d4";
    ctx.lineWidth = 2;
    ctx.strokeRect(48, 86, w - 96, 46);
    ctx.fillStyle = "#6b7280";
    ctx.font = "15px monospace";
    ctx.fillText((item.url || item.targetPath || `p2p://remote-surface · ${meta.maxWidth}p · ${meta.fps}fps`).slice(0, 72), 68, 114);

    // Center card
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(140, 175, w - 280, 300);
    ctx.strokeStyle = "#fbcfe8";
    ctx.strokeRect(140, 175, w - 280, 300);

    ctx.fillStyle = "#9d174d";
    ctx.font = "700 24px sans-serif";
    ctx.fillText(item.kind === "browser" ? "Remote OAuth / Browser Session" : "Remote OS Window Capture", 200, 245);

    ctx.fillStyle = "#4b5563";
    ctx.font = "16px sans-serif";
    ctx.fillText(`Transport: P2P Direct Link · Cursor (${meta.nx.toFixed(2)}, ${meta.ny.toFixed(2)}) · ${meta.lastAction}`, 200, 294);

    ctx.fillStyle = "#ec4899";
    ctx.fillRect(200, 344, 240, 48);
    ctx.fillStyle = "#ffffff";
    ctx.font = "600 16px sans-serif";
    ctx.fillText("Continue / Authorize", 238, 374);

    if (meta.showCursor) {
      const cx = meta.nx * w;
      const cy = meta.ny * h;
      ctx.fillStyle = "#18121e";
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + 16, cy + 11);
      ctx.lineTo(cx + 7, cy + 13);
      ctx.lineTo(cx + 4, cy + 21);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    const url = canvas.toDataURL("image/png");
    const b64 = url.split(",")[1];
    if (b64) return { data: b64, width: w, height: h, cursorX: meta.nx, cursorY: meta.ny, cursorVisible: true };
  } catch {
    // fallback below
  }
  return { data: FALLBACK_PNG_B64, width: 960, height: 600, cursorX: meta.nx, cursorY: meta.ny, cursorVisible: true };
}

type MockPortalWatcher = {
  to: string;
  agent?: string;
  portalId?: string;
  onEvent: (ev: PortalStreamEvent) => void;
};
const demoPortalWatchers = new Set<MockPortalWatcher>();

function emitMockPortalEvent(action: "opened" | "updated" | "closed", item: PortalItem): void {
  const ev: PortalStreamEvent = { kind: "portal_event", action, item, at: Date.now() };
  for (const w of demoPortalWatchers) {
    if (w.to !== item.hostId) continue;
    if (w.agent && item.agentKey !== w.agent) continue;
    if (w.portalId && w.portalId !== item.id) continue;
    w.onEvent(ev);
  }
}

function emitMockPortalFrame(item: PortalItem): void {
  if (item.kind !== "browser" && item.kind !== "window") return;
  const rendered = renderDemoFramePngBase64(item);
  const ev: PortalStreamEvent = {
    kind: "portal_frame",
    portalId: item.id,
    seq: demoFrameSeq++,
    mime: "image/png",
    data: rendered.data,
    width: rendered.width,
    height: rendered.height,
    cursorX: rendered.cursorX,
    cursorY: rendered.cursorY,
    cursorVisible: rendered.cursorVisible,
    captureMs: 6,
    ...(item.url ? { url: item.url } : {}),
    title: item.title,
    canGoBack: item.kind === "browser",
    canGoForward: false,
    at: Date.now(),
  };
  for (const w of demoPortalWatchers) {
    if (w.to !== item.hostId) continue;
    if (w.portalId && w.portalId !== item.id) continue;
    w.onEvent(ev);
  }
}

function demoPortalDirList(rawPath: string, highlightName?: string): {
  dirPath: string;
  parentDir: string | null;
  highlightName?: string;
  entries: FileEntry[];
  truncated: boolean;
} {
  let clean = rawPath.replace(/\\/g, "/").trim();
  clean = clean.replace(/^~\/work\/demo-app\/?/, "").replace(/^\/+|\/+$/g, "");
  if (clean === "~" || clean === "~/work" || clean === "~/work/demo-app") clean = "";
  const hitFile = DEMO_FILES.find((f) => {
    const fp = f.dir ? `${f.dir}/${f.name}` : f.name;
    return fp === clean && f.kind === "file";
  });
  let derivedHighlight = highlightName;
  if (hitFile) {
    derivedHighlight = hitFile.name;
    clean = hitFile.dir;
  }
  const entries: FileEntry[] = DEMO_FILES.filter((f) => f.dir === clean && !f.ignored && !f.private)
    .sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name))
    .map(({ dir: _d, body: _b, ...e }) => ({
      ...e,
      path: clean ? `${clean}/${e.name}` : e.name,
      mtime: now - 30 * min,
    }));
  const slash = clean.lastIndexOf("/");
  const parentDir = !clean ? null : slash > 0 ? clean.slice(0, slash) : "";
  return {
    dirPath: clean || "~/work/demo-app",
    parentDir,
    ...(derivedHighlight ? { highlightName: derivedHighlight } : {}),
    entries,
    truncated: false,
  };
}

function demoFindFile(reqPath: string) {
  const fullPath = (f: (typeof DEMO_FILES)[number]) => (f.dir ? `${f.dir}/${f.name}` : f.name);
  const req = reqPath.replace(/\\/g, "/").replace(/^~\/work\/demo-app\/?/, "").replace(/^\.\//, "").replace(/^\/+/, "");
  let hit = DEMO_FILES.find((f) => fullPath(f) === req);
  if (!hit && req && !/^(\/|~\/|\.\.\/)/.test(req)) {
    const suffix = `/${req}`;
    hit = DEMO_FILES.find(
      (f) => f.kind === "file" && !f.ignored && !f.private && (fullPath(f) === req || fullPath(f).endsWith(suffix)),
    );
  }
  return hit;
}

type MockTermWatcher = {
  to: string;
  agent: string;
  cols: number;
  rows: number;
  onEvent: (ev: any) => void;
};
const demoTermWatchers = new Set<MockTermWatcher>();

function buildDemoRawTerminalPayload(agentKey: string): string {
  const existing = DEMO_TERMINALS[agentKey] ?? [`\x1b[38;5;212mHerdr Agent\x1b[0m · ${agentKey}`];
  const lines: string[] = [];
  for (let i = 1; i <= 120; i += 1) {
    lines.push(`\x1b[90m[${String(i).padStart(3, "0")}]\x1b[0m 检查分屏宽度重排与跨端同步基线状态，验证中文宽字符自动折行对齐 (${agentKey})`);
  }
  lines.push(
    "\x1b[90m+------------------+--------------------+--------------------+----------------------------+\x1b[0m",
    "| 服务模块         | 独立容器架构       | 前端宿主路径       | 改 UI 要不要重打发布包     |",
    "|------------------+--------------------+--------------------+----------------------------|",
    "| api-gateway      | 独立容器运行       | /apps/:appId       | 不需要，直接部署服务端即可 |",
    "| cron-runner      | 已拆出至总控台     | apps/console/dist  | 需随总控台版本统一构建发布 |",
    "\x1b[90m+------------------+--------------------+--------------------+----------------------------+\x1b[0m",
  );
  lines.push(...existing);
  lines.push(
    "\x1b[90m────────────────────────────────────────────────────────────────────────────────────\x1b[0m",
    "\x1b[1;34m>\x1b[0m ",
    "\x1b[90m────────────────────────────────────────────────────────────────────────────────────\x1b[0m",
    "\x1b[32m●\x1b[0m [16:55:10] cron (every 3 minutes) running",
    "\x1b[90mGemini 4 Neon (XHigh) · 32% ctx · idle\x1b[0m",
  );
  return `${lines.join("\r\n")}\r\n`;
}

function emitMockTermRaw(agentKey: string, textChunk: string): void {
  const b64 = demoBytesToBase64(new TextEncoder().encode(textChunk));
  for (const w of demoTermWatchers) {
    if (w.agent !== agentKey) continue;
    w.onEvent({ kind: "terminal_data", data: b64, cols: w.cols, rows: w.rows });
  }
}

function demoBytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
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
      const tools = demoEnsureHostTools(to);
      return {
        name: d?.name ?? "demo",
        platform: d?.platform ?? "darwin",
        sources: ["hc", "uniflo"],
        version: d?.version ?? "0.2.25",
        tools,
        files: true,
        portal: demoCapabilities(to),
      };
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
    if (method === "terminal.putBegin") {
      return { uploadId: `mock-up-${Date.now()}`, chunkBytes: 2 * 1024 * 1024 };
    }
    if (method === "terminal.putChunk") {
      return { receivedBytes: (Number(params.index ?? 0) + 1) * 1024 };
    }
    if (method === "terminal.putFinish") {
      return { path: `/tmp/mock-large-${String(params.uploadId ?? "file")}.mp4` };
    }
    if (method === "terminal.putAbort") {
      return { ok: true };
    }
    if (method === "webrtc.offer") {
      throw new Error("演示模式不支持 WebRTC 直连");
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
      emitMockTermRaw(String(params.agent), `\r\n\x1b[1;34m>\x1b[0m ${textStr}\r\n\x1b[32m✓ 演示指令已送达\x1b[0m\r\n\x1b[1;34m>\x1b[0m `);
      return { ok: true };
    }
    if (method === "terminal.keys") {
      const term = DEMO_TERMINALS[params.agent] ?? [];
      DEMO_TERMINALS[params.agent] = [...term, `\x1b[90m[key: ${(params.keys ?? []).join(" + ")}]\x1b[0m`];
      return { ok: true };
    }
    if (method === "terminal.input") {
      if (params?.agent && typeof params?.data === "string") {
        emitMockTermRaw(String(params.agent), String(params.data));
      }
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
        const rawFolder = params.folder || "~/work/demo-app";
        const spFolder = params.worktreeBranch
          ? `~/work/.herdr-worktrees/${rawFolder.split("/").filter(Boolean).pop() || "repo"}-${String(params.worktreeBranch).replace(/[^a-zA-Z0-9._-]+/g, "-")}`
          : rawFolder;
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

      const resolvedCwd = targetSpace.folder || params.folder || "~/work/demo-app";
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
      return { agent: key, space: targetSpace.id, tab: newTabId, terminal: id, task: "started", folder: resolvedCwd };
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
    if (method === "tools.check") {
      const tools = DEMO_HOST_TOOLS_STATE[to] ?? demoEnsureHostTools(to);
      tools.latest = {
        ...(tools.latest ?? {}),
        ...(tools.hc ? { hc: tools.latest?.hc ?? tools.hc } : {}),
        ...(tools.herdr ? { herdr: tools.latest?.herdr ?? tools.herdr } : {}),
        ...(tools.app ? { app: tools.latest?.app ?? tools.app } : {}),
        ...(tools.uniflo ? { uniflo: tools.latest?.uniflo ?? tools.uniflo } : {}),
        hostd: "0.2.25",
        checkedAt: Date.now(),
      };
      DEMO_HOST_TOOLS_STATE[to] = tools;
      return { tools: demoEnsureHostTools(to), hostVersion: "0.2.25" };
    }
    if (method === "tools.update") {
      const tools = DEMO_HOST_TOOLS_STATE[to] ?? demoEnsureHostTools(to);
      const validIds: HostToolId[] = ["hc", "herdr", "app", "uniflo", "hostd"];
      const reqTargets: HostToolId[] =
        Array.isArray(params?.targets) && params.targets.length > 0
          ? params.targets.filter((x: unknown): x is HostToolId => validIds.includes(x as HostToolId))
          : (validIds.filter((id) => id !== "hostd" && Boolean(tools[id])) as HostToolId[]);
      const startedAt = Date.now();
      const completed: ToolUpdateItemResult[] = reqTargets.map((id) => {
        if (id === "hostd") {
          return {
            id,
            ok: true,
            status: "up_to_date",
            fromVersion: "0.2.25",
            toVersion: "0.2.25",
            message: "Pocket 守护进程已是最新 0.2.25",
          };
        }
        const cur = tools[id];
        const next = tools.latest?.[id] ?? cur;
        if (cur && next && cur !== next) {
          tools[id] = next;
          return {
            id,
            ok: true,
            status: "updated",
            fromVersion: cur,
            toVersion: next,
            message: `已更新到 ${next}`,
          };
        }
        return {
          id,
          ok: true,
          status: "up_to_date",
          fromVersion: cur,
          toVersion: next ?? cur,
          message: `${id} 已是最新版本`,
        };
      });
      const snap: ToolUpdateJobSnapshot = {
        jobId: `tu-demo-${Date.now().toString(36)}`,
        running: false,
        targets: reqTargets,
        completed,
        tools: demoEnsureHostTools(to),
        hostVersion: "0.2.25",
        startedAt,
        finishedAt: Date.now(),
      };
      demoToolJobs[to] = snap;
      return snap;
    }
    if (method === "tools.updateStatus") {
      return demoToolJobs[to] ?? null;
    }
    if (method === "files.readChunk") {
      const hit = demoFindFile(String(params?.path ?? ""));
      if (!hit || hit.kind !== "file") throw new Error("没有这个文件");
      if (hit.private) throw new Error("禁止读取可能包含密钥的私有文件");
      const text = hit.body ?? "";
      const encoded = new TextEncoder().encode(text);
      const offset = Math.max(0, Math.min(encoded.length, Number(params?.offset ?? 0) || 0));
      const length = Math.max(1, Number(params?.length ?? 65536) || 65536);
      const slice = encoded.subarray(offset, Math.min(encoded.length, offset + length));
      const fullPath = hit.dir ? `${hit.dir}/${hit.name}` : hit.name;
      return {
        path: fullPath,
        size: encoded.length,
        mtime: now - 30 * min,
        offset,
        bytes: slice.length,
        eof: offset + slice.length >= encoded.length,
        mime: hit.name.endsWith(".svg") ? "image/svg+xml" : hit.name.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        base64: demoBytesToBase64(slice),
      };
    }
    if (method === "portal.list") {
      const agentFilter = typeof params?.agent === "string" ? params.agent : undefined;
      const items = demoPortals
        .filter((p) => p.hostId === to && (!agentFilter || p.agentKey === agentFilter))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      return {
        items,
        ...(params?.includeWindows ? { windows: demoWindowsForHost(to) } : {}),
        capabilities: demoCapabilities(to),
      };
    }
    if (method === "portal.open") {
      const kind = (params?.kind as PortalKind) || "browser";
      const target = typeof params?.target === "string" ? params.target.trim() : undefined;
      const url = typeof params?.url === "string" ? params.url.trim() : kind === "browser" ? target || "http://127.0.0.1:8787/auth" : undefined;
      const windowId = kind === "window" ? String(params?.windowId || "screen:0") : undefined;
      const id = `ptl-demo-${++demoPortalSeq}`;
      const hitFile = target ? demoFindFile(target) : undefined;
      const resolvedPath = hitFile ? (hitFile.dir ? `${hitFile.dir}/${hitFile.name}` : hitFile.name) : target;
      const ts = Date.now();
      const item: PortalItem = {
        id,
        hostId: to,
        ...(typeof params?.agent === "string" ? { agentKey: params.agent } : {}),
        kind,
        title:
          (typeof params?.title === "string" && params.title.trim()) ||
          (kind === "browser"
            ? url || "远程浏览器"
            : kind === "window"
              ? demoWindowsForHost(to).find((w) => w.id === windowId)?.title || "远程桌面窗口"
              : resolvedPath?.split("/").pop() || "跨端回传"),
        subtitle: kind === "browser" ? url : resolvedPath,
        ...(resolvedPath ? { targetPath: resolvedPath } : {}),
        ...(kind === "reveal"
          ? {
              parentDir: hitFile ? hitFile.dir || "docs" : "docs",
              highlightName: hitFile?.name || resolvedPath?.split("/").pop(),
            }
          : {}),
        ...(url ? { url } : {}),
        ...(windowId ? { windowId } : {}),
        ...(kind === "html" ? { mime: "text/html" } : {}),
        canInteract: kind === "browser" || kind === "window",
        transportHint: "p2p",
        width: 960,
        height: 600,
        createdAt: ts,
        updatedAt: ts,
      };
      demoPortals.unshift(item);
      emitMockPortalEvent("opened", item);
      let ticket: PortalFileTicket | undefined;
      if (kind === "file" || kind === "html" || kind === "reveal") {
        ticket = {
          token: `demo-tok-${id}`,
          entryPath: hitFile?.name || "README.md",
          port: null,
          addrs: [],
          expiresAt: ts + 30 * 60_000,
          mime: kind === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
          size: hitFile?.size ?? 256,
          isDir: false,
        };
      }
      return { item, ...(ticket ? { ticket } : {}) };
    }
    if (method === "portal.close") {
      const idx = demoPortals.findIndex((p) => p.id === params?.portalId);
      if (idx >= 0) {
        const [removed] = demoPortals.splice(idx, 1);
        if (removed) emitMockPortalEvent("closed", removed);
      }
      return { ok: true };
    }
    if (method === "portal.frame") {
      const item = demoPortals.find((p) => p.id === params?.portalId) ?? null;
      if (!item || (item.kind !== "browser" && item.kind !== "window")) {
        return { frame: null, item };
      }
      const rendered = renderDemoFramePngBase64(item);
      const frame: PortalFramePayload = {
        portalId: item.id,
        seq: demoFrameSeq++,
        mime: "image/png",
        data: rendered.data,
        width: rendered.width,
        height: rendered.height,
        cursorX: rendered.cursorX,
        cursorY: rendered.cursorY,
        cursorVisible: rendered.cursorVisible,
        captureMs: 6,
        ...(item.url ? { url: item.url } : {}),
        title: item.title,
        canGoBack: item.kind === "browser",
        canGoForward: false,
        at: Date.now(),
      };
      return { frame, item };
    }
    if (method === "portal.input") {
      const item = demoPortals.find((p) => p.id === params?.portalId);
      if (!item) throw new Error("回传窗口不存在或已关闭");
      const input = params?.input as PortalInputAction | undefined;
      const meta = demoPortalMeta(item.id);
      if (input?.type === "navigate") {
        if (input.action === "goto" && input.url) {
          item.url = input.url;
          item.subtitle = input.url;
          item.updatedAt = Date.now();
          emitMockPortalEvent("updated", item);
        }
        meta.lastAction = `nav:${input.action}`;
        emitMockPortalFrame(item);
      } else if (input?.type === "pointer") {
        meta.nx = Math.max(0, Math.min(1, input.nx));
        meta.ny = Math.max(0, Math.min(1, input.ny));
        meta.lastAction = `${input.action}:${input.button ?? "left"}`;
        emitMockPortalFrame(item);
      } else if (input?.type === "wheel") {
        if (typeof input.nx === "number" && typeof input.ny === "number") {
          meta.nx = Math.max(0, Math.min(1, input.nx));
          meta.ny = Math.max(0, Math.min(1, input.ny));
        }
        meta.lastAction = `wheel(${Math.round(input.deltaX ?? 0)},${Math.round(input.deltaY ?? 0)})`;
        emitMockPortalFrame(item);
      } else if (input?.type === "key") {
        meta.lastAction = `key:${input.modifiers?.length ? `${input.modifiers.join("+")}+` : ""}${input.key}`;
        emitMockPortalFrame(item);
      } else if (input?.type === "text") {
        meta.lastAction = `text:${String(input.text ?? "").slice(0, 14)}`;
        emitMockPortalFrame(item);
      } else if (input?.type === "config") {
        if (typeof input.fps === "number") meta.fps = Math.max(0, Math.min(60, input.fps));
        if (typeof input.maxWidth === "number") meta.maxWidth = Math.max(480, Math.min(3840, input.maxWidth));
        if (typeof input.quality === "number") meta.quality = Math.max(20, Math.min(100, input.quality));
        if (typeof input.showCursor === "boolean") meta.showCursor = input.showCursor;
        meta.lastAction = `config:${meta.maxWidth}p/${meta.fps}fps`;
        emitMockPortalFrame(item);
      } else if (input?.type === "clipboard") {
        if (input.action === "set") {
          mockClipboardText = String(input.text ?? "");
          meta.lastAction = "clipboard:set";
          emitMockPortalFrame(item);
          return { ok: true, clipboardText: mockClipboardText, ...(item.url ? { url: item.url } : {}), title: item.title };
        }
        meta.lastAction = "clipboard:get";
        emitMockPortalFrame(item);
        return { ok: true, clipboardText: mockClipboardText, ...(item.url ? { url: item.url } : {}), title: item.title };
      } else if (input?.type === "promptPermission") {
        meta.lastAction = `perm:${input.kind}`;
        emitMockPortalFrame(item);
      }
      return { ok: true, ...(item.url ? { url: item.url } : {}), title: item.title };
    }
    if (method === "portal.fileTicket") {
      const hit = demoFindFile(String(params?.path ?? ""));
      return {
        token: `demo-tok-${Date.now().toString(36)}`,
        entryPath: hit?.name || String(params?.path ?? "README.md"),
        port: null,
        addrs: [],
        expiresAt: Date.now() + 30 * 60_000,
        mime: hit?.name.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        size: hit?.size ?? 256,
        isDir: hit?.kind === "dir",
      } satisfies PortalFileTicket;
    }
    if (method === "portal.dirList") {
      const item = params?.portalId ? demoPortals.find((p) => p.id === params.portalId) : undefined;
      return demoPortalDirList(String(params?.path ?? item?.parentDir ?? ""), item?.highlightName);
    }
    if (method === "portal.bundleHtml") {
      const hit = demoFindFile(String(params?.path ?? ""));
      const html =
        hit?.body ??
        "<!doctype html><html><body style='font-family:system-ui;padding:20px'><h2>Demo HTML Portal</h2><p>Inline cross-device HTML bundle preview.</p></body></html>";
      return { html, title: hit?.name || "index.html" };
    }
    if (method === "portal.observeCommand") {
      return { ok: true };
    }
    if (method === "browser.status") {
      const enabled = clientConfigStore.get().config.plugins.aiBrowser;
      if (!enabled) {
        return { enabled: false, backend: "none", spaces: [] };
      }
      const b = browserSpacesStore.get();
      return {
        enabled: true,
        backend: "desktop",
        activeSpaceId: b.activeSpaceId,
        spaces: b.spaces.map((sp) => ({
          id: sp.id,
          name: sp.name,
          kind: sp.kind,
          ownership: sp.ownership,
          ...(sp.statusText ? { statusText: sp.statusText } : {}),
          ...(sp.handoffReason ? { handoffReason: sp.handoffReason } : {}),
          activePage: sp.tabs.find((t) => t.id === sp.activeTabId)?.label ?? "p1",
          pages: sp.tabs.map((t, idx) => ({
            label: t.label || `p${idx + 1}`,
            title: t.title,
            url: t.url,
            active: t.id === sp.activeTabId,
          })),
        })),
      };
    }
    if (method === "browser.act") {
      const enabled = clientConfigStore.get().config.plugins.aiBrowser;
      if (!enabled) {
        throw new Error("AI 浏览器插件默认关闭，请在 设置 › 插件中心 按需启用");
      }
      const sid = typeof params?.spaceId === "string" && params.spaceId ? params.spaceId : "ai-demo";
      return {
        ok: true,
        spaceId: sid,
        page: typeof params?.page === "string" && params.page ? params.page : "p1",
        url: typeof params?.url === "string" ? params.url : "https://pocket.example.com",
        title: "Demo Browser Space",
        ownership: params?.op === "handoff" ? "agentHandoff" : params?.op === "finish" ? "user" : "agentWorking",
        ...(params?.op === "handoff" ? { handoffReason: String(params?.reason ?? "请完成验证后交还 AI") } : {}),
        ...(params?.op === "snapshot"
          ? { snapshot: "Title: Demo Workspace\nURL: https://pocket.example.com\n---\n@e1 [link] \"Docs\"\n@e2 [button] \"Deploy\"" }
          : {}),
      };
    }
    return { ok: true };
  },
  subscribe(
    to: string,
    stream: StreamKind,
    params: any,
    onEvent: (event: any) => void,
    onState?: (event: any) => void,
  ): () => void {
    if (stream === "portal") {
      const agent = typeof params?.agent === "string" ? params.agent : undefined;
      const portalId = typeof params?.portalId === "string" ? params.portalId : undefined;
      const watcher: MockPortalWatcher = { to, agent, portalId, onEvent };
      demoPortalWatchers.add(watcher);
      const items = demoPortals.filter((p) => p.hostId === to && (!agent || p.agentKey === agent));
      onState?.({ kind: "live", result: { items } });
      let timer: ReturnType<typeof setInterval> | null = null;
      if (portalId) {
        const target = demoPortals.find((p) => p.id === portalId);
        if (target && (target.kind === "browser" || target.kind === "window")) {
          const meta = demoPortalMeta(target.id);
          if (typeof params?.fps === "number") meta.fps = Math.max(0, Math.min(60, params.fps));
          if (typeof params?.maxWidth === "number") meta.maxWidth = Math.max(480, Math.min(3840, params.maxWidth));
          if (typeof params?.quality === "number") meta.quality = Math.max(20, Math.min(100, params.quality));
          if (typeof params?.showCursor === "boolean") meta.showCursor = params.showCursor;
          const rendered = renderDemoFramePngBase64(target);
          onEvent({
            kind: "portal_frame",
            portalId: target.id,
            seq: demoFrameSeq++,
            mime: "image/png",
            data: rendered.data,
            width: rendered.width,
            height: rendered.height,
            cursorX: rendered.cursorX,
            cursorY: rendered.cursorY,
            cursorVisible: rendered.cursorVisible,
            captureMs: 6,
            ...(target.url ? { url: target.url } : {}),
            title: target.title,
            canGoBack: target.kind === "browser",
            canGoForward: false,
            at: Date.now(),
          } satisfies PortalStreamEvent);
          timer = setInterval(() => {
            if (meta.fps <= 0) return;
            const liveTarget = demoPortals.find((p) => p.id === portalId);
            if (!liveTarget || (liveTarget.kind !== "browser" && liveTarget.kind !== "window")) return;
            const liveRendered = renderDemoFramePngBase64(liveTarget);
            onEvent({
              kind: "portal_frame",
              portalId: liveTarget.id,
              seq: demoFrameSeq++,
              mime: "image/png",
              data: liveRendered.data,
              width: liveRendered.width,
              height: liveRendered.height,
              cursorX: liveRendered.cursorX,
              cursorY: liveRendered.cursorY,
              cursorVisible: liveRendered.cursorVisible,
              captureMs: 6,
              ...(liveTarget.url ? { url: liveTarget.url } : {}),
              title: liveTarget.title,
              canGoBack: liveTarget.kind === "browser",
              canGoForward: false,
              at: Date.now(),
            } satisfies PortalStreamEvent);
          }, 500);
        }
      }
      return () => {
        if (timer !== null) clearInterval(timer);
        demoPortalWatchers.delete(watcher);
      };
    }
    if (stream === "terminal" && params?.raw && typeof params?.agent === "string") {
      const cols = Math.max(20, Number(params.cols) || 80);
      const rows = Math.max(5, Number(params.rows) || 24);
      const watcher: MockTermWatcher = {
        to,
        agent: params.agent,
        cols,
        rows,
        onEvent,
      };
      demoTermWatchers.add(watcher);
      let alive = true;
      queueMicrotask(() => {
        if (!alive) return;
        onState?.({ kind: "live", result: { raw: true } });
        const payload = buildDemoRawTerminalPayload(watcher.agent);
        onEvent({
          kind: "terminal_data",
          data: demoBytesToBase64(new TextEncoder().encode(payload)),
          cols: watcher.cols,
          rows: watcher.rows,
        });
      });
      return () => {
        alive = false;
        demoTermWatchers.delete(watcher);
      };
    }
    onState?.({ kind: "live" });
    return () => {};
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
  assistantSettings: (): AssistantSettings => {
    const cur: AssistantSettings = demoAssistantState.settings ?? { confirm: "never" };
    return {
      confirm: cur.confirm,
      ...(cur.plugins ? { plugins: { ...cur.plugins } } : {}),
      ...(cur.webhooks ? { webhooks: cur.webhooks.map((w) => ({ ...w })) } : {}),
    };
  },
  saveAssistantSettings(patch: Partial<AssistantSettings>): AssistantSettings {
    const cur: AssistantSettings = demoAssistantState.settings ?? { confirm: "never" };
    const nextPlugins = patch.plugins ? { ...(cur.plugins ?? {}), ...patch.plugins } : cur.plugins;
    const nextWebhooks = patch.webhooks !== undefined ? patch.webhooks.map((w) => ({ ...w })) : cur.webhooks;
    const cleanPlugins: AssistantSettings["plugins"] = {};
    if (nextPlugins) {
      for (const k of ["browser", "workspace", "webfetch", "webhooks"] as const) {
        if (nextPlugins[k]) cleanPlugins[k] = true;
      }
    }
    demoAssistantState = {
      ...demoAssistantState,
      settings: {
        confirm: patch.confirm ?? cur.confirm,
        ...(Object.keys(cleanPlugins).length ? { plugins: cleanPlugins } : {}),
        ...(nextWebhooks?.length ? { webhooks: nextWebhooks } : {}),
      },
    };
    return mockApi.assistantSettings();
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
