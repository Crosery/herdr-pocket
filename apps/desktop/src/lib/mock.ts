import {
  OPENAI_REALTIME_VOICES,
  type Agent,
  type AssistantConfigChange,
  type AssistantConfigView,
  type AssistantItem,
  type AssistantState,
  type ConvEvent,
  type Device,
  type DeviceKind,
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
];

const DEMO_EVENTS: Record<string, ConvEvent[]> = {
  "dev-mac/hc:t1": [
    { id: "e1", session: "claude:demo-1", ts: now - 8 * min, kind: "user_message", text: "检查一下 OAuth 回调校验，并准备迁移脚本。" },
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
    { id: "e21", session: "codex:demo-2", ts: now - 9 * min, kind: "user_message", text: "跑一遍端到端测试并修掉超时的用例。" },
    { id: "e22", session: "codex:demo-2", ts: now - 5 * min, kind: "assistant_message", text: "正在运行 `pnpm test` 并复查 mock socket 超时阈值…" },
  ],
  "dev-linux/hc:t3": [
    { id: "e31", session: "gemini:demo-3", ts: now - 20 * min, kind: "user_message", text: "把静态资源压到 10 MB 以内。" },
    { id: "e32", session: "gemini:demo-3", ts: now - 11 * min, kind: "assistant_message", text: "已完成压缩与校验：安装包体积从 18.4 MB 降至 7.9 MB，所有校验通过。" },
  ],
};

const DEMO_TERMINALS: Record<string, string[]> = {
  "dev-mac/hc:t1": [
    "\x1b[38;5;212mClaude Code\x1b[0m · ~/work/demo-app",
    "\x1b[90m────────────────────────────────────\x1b[0m",
    "\x1b[32m✓\x1b[0m 读取 src/auth/callback.ts",
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
};

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

let demoConfig: AssistantConfigView = {
  rev: 1,
  name: "小羊",
  providers: [
    { id: "openai", label: "Demo Provider", protocol: "openai", baseUrl: "https://api.example.com/v1", auth: "bearer", key: { set: true, hint: "demo", from: "server" }, from: "server" },
  ],
  models: [{ provider: "openai", model: "gpt-demo" }],
  voice: { provider: "openai-realtime", url: "wss://api.example.com/v1/realtime", model: "gpt-realtime", voice: "marin", speed: 1.0, key: { set: true, hint: "demo", from: "server" } },
  edited: false,
  warnings: [],
};

const demoPrompts: PromptView[] = [
  { id: "base", title: "基础规则", about: "规定小羊的行为准则", group: "性格与规矩", slots: [{ slot: "{{name}}", means: "助理名字" }], text: "你是 {{name}}，负责照看所有电脑上的开发任务。", defaultText: "你是 {{name}}，负责照看所有电脑上的开发任务。", edited: false },
  { id: "persona", title: "说话风格", about: "口吻与长度约束", group: "性格与规矩", slots: [], text: "说话简洁自然，先说结论。", defaultText: "说话简洁自然，先说结论。", edited: false },
];

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
      rev: liveStore.get().rev + 1,
    });
  },
  createPairCode(kind?: DeviceKind): PairCode {
    const code = kind === "host" ? "DEMO-2048" : "POCK-5120";
    return { code, expiresAt: Date.now() + 30 * min, link: `https://pocket.example.com/p/${code}` };
  },
  async call(to: string, method: RpcMethod, params: any): Promise<any> {
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
        spaces: [
          { id: "sp-1", name: "backend", folder: "~/work/demo-app", tabs: 3, terminals: 3 },
          { id: "sp-2", name: "release", folder: "~/repos/sample-cli", tabs: 1, terminals: 1 },
        ],
        launchers: [
          { id: "claude", label: "Claude Code", takesTask: true },
          { id: "codex", label: "Codex", takesTask: true },
          { id: "gemini", label: "Gemini CLI", takesTask: true },
          { id: "shell", label: "普通终端", takesTask: false },
        ],
        folders: ["~/work/demo-app", "~/repos/sample-cli"],
        canCreate: true,
      };
    }
    if (method === "terminal.put") {
      return { paths: (params.files ?? []).map((f: any, i: number) => `/tmp/mock-${i}-${f.name}`) };
    }
    if (method === "terminal.send") {
      const prev = DEMO_EVENTS[params.agent] ?? [];
      DEMO_EVENTS[params.agent] = [
        ...prev,
        { id: `u-${Date.now()}`, session: params.agent, ts: Date.now(), kind: "user_message", text: params.text },
        { id: `a-${Date.now() + 1}`, session: params.agent, ts: Date.now() + 1, kind: "assistant_message", text: `（演示模式已收到：${params.text}）` },
      ];
      const term = DEMO_TERMINALS[params.agent] ?? [];
      DEMO_TERMINALS[params.agent] = [...term, `> ${params.text}`, "\x1b[32m✓ 演示指令已送达\x1b[0m"];
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
    if (method === "agent.create") {
      const id = `t${Date.now() % 10000}`;
      const key = `${to}/hc:${id}`;
      const ag: Agent = {
        key,
        deviceId: to,
        source: "hc",
        localId: id,
        harness: params.launcher || "claude-code",
        title: params.task || params.tabName || "新建 Agent",
        where: `${params.spaceName || "workspace"} / ${params.tabName || id}`,
        cwd: params.folder || "~/work/demo-app",
        status: "working",
        statusSince: Date.now(),
        isShell: params.launcher === "shell",
        sessionKey: `demo:${id}`,
        updatedAt: Date.now(),
      };
      DEMO_AGENTS.unshift(ag);
      DEMO_EVENTS[key] = params.task ? [{ id: `u-${Date.now()}`, session: ag.sessionKey!, ts: Date.now(), kind: "user_message", text: params.task }] : [];
      DEMO_TERMINALS[key] = [`${ag.harness} · ${ag.cwd}`, params.task ? `$ ${params.task}` : "$ ready"];
      mockApi.connect();
      return { agent: key, space: params.space || "sp-new", terminal: id, task: "started" };
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
      demoConfig = {
        rev: demoConfig.rev + 1,
        name: "小羊",
        providers: [{ id: "openai", label: "Demo Provider", protocol: "openai", baseUrl: "https://api.example.com/v1", auth: "bearer", key: { set: true, hint: "demo", from: "server" }, from: "server" }],
        models: [{ provider: "openai", model: "gpt-demo" }],
        voice: { provider: "openai-realtime", url: "wss://api.example.com/v1/realtime", model: "gpt-realtime", voice: "marin", speed: 1.0, key: { set: true, hint: "demo", from: "server" } },
        edited: false,
        warnings: [],
      };
      return mockApi.configView();
    }
    if (patch.name !== undefined) demoConfig.name = patch.name;
    for (const p of patch.providers ?? []) {
      const idx = demoConfig.providers.findIndex((x) => x.id === p.id);
      if (p.reset && p.id === "openai") {
        const orig = { id: "openai", label: "Demo Provider", protocol: "openai" as const, baseUrl: "https://api.example.com/v1", auth: "bearer" as const, key: { set: true, hint: "demo", from: "server" as const }, from: "server" as const };
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
    return ["gpt-demo", "gpt-demo-fast"];
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
