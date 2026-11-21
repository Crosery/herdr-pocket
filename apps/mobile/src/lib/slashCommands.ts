import type { SlashCommandItem } from "@herdr-pocket/protocol";

export type SlashCategory = NonNullable<SlashCommandItem["category"]>;

export type SlashIconKind =
  | "usage"
  | "context"
  | "help"
  | "keyboard"
  | "status"
  | "clear"
  | "compact"
  | "new"
  | "history"
  | "branch"
  | "share"
  | "exit"
  | "model"
  | "speed"
  | "shield"
  | "memory"
  | "auth"
  | "settings"
  | "plan"
  | "review"
  | "git"
  | "mcp"
  | "browser"
  | "schedule"
  | "workspace"
  | "goal"
  | "agents"
  | "skill"
  | "custom";

export const SLASH_CATEGORIES: Array<{ id: "all" | SlashCategory; label: string }> = [
  { id: "all", label: "全部" },
  { id: "session", label: "会话" },
  { id: "model", label: "模型与设置" },
  { id: "code", label: "代码与工具" },
  { id: "skill", label: "技能" },
  { id: "custom", label: "自定义" },
];

const c = (
  name: string,
  description: string,
  category: SlashCategory = "session",
  argHint?: string,
): SlashCommandItem => ({
  name,
  description,
  category,
  source: "builtin",
  ...(argHint ? { argHint } : {}),
});

function withUsage(items: SlashCommandItem[]): SlashCommandItem[] {
  if (items.some((x) => x.name === "/usage")) return items;
  return [
    c("/usage", "查看当前会话、上下文占用与本机额度用量", "session"),
    ...items,
  ];
}

const CORE_SESSION: SlashCommandItem[] = [
  c("/help", "查看当前 Agent 支持的斜杠命令", "session"),
  c("/usage", "查看当前会话、上下文占用与本机额度用量", "session"),
  c("/clear", "清空当前会话上下文，开启全新一轮", "session"),
  c("/compact", "压缩并总结较早对话释放上下文", "session", "[focus]"),
  c("/status", "查看会话、模型与额度状态", "session"),
  c("/model", "切换或查看当前模型", "model", "[model]"),
  c("/resume", "恢复历史会话", "session", "[id]"),
  c("/cost", "查看 Token 与费用统计", "session"),
  c("/context", "查看上下文窗口明细", "session"),
];

const CLAUDE_COMMANDS: SlashCommandItem[] = [
  ...CORE_SESSION,
  c("/init", "生成或更新 CLAUDE.md 项目指引", "code"),
  c("/plan", "进入只读规划模式", "code", "[goal]"),
  c("/review", "审查当前代码改动", "code", "[pr]"),
  c("/rewind", "回退消息或文件改动", "session"),
  c("/agents", "管理自定义 Subagent", "skill"),
  c("/mcp", "管理 MCP 服务器", "code"),
  c("/hooks", "配置会话 Hook", "model"),
  c("/memory", "查看或编辑记忆文件", "model"),
  c("/permissions", "查看与调整工具权限", "model"),
  c("/add-dir", "追加工作区目录", "code", "<path>"),
  c("/config", "打开设置", "model"),
  c("/doctor", "诊断运行环境", "model"),
  c("/export", "导出当前对话", "session"),
  c("/exit", "退出会话", "session"),
];

const CODEX_COMMANDS: SlashCommandItem[] = [
  ...CORE_SESSION,
  c("/init", "初始化 AGENTS.md", "code"),
  c("/approvals", "设置执行批准与沙箱策略", "model"),
  c("/permissions", "调整工作区权限", "model"),
  c("/diff", "查看 Git 差异", "code"),
  c("/review", "触发 Codex 审查", "code"),
  c("/new", "新建对话", "session"),
  c("/mcp", "查看 MCP 服务器", "code"),
  c("/quit", "退出 Codex", "session"),
];

const GEMINI_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "显示可用命令", "session"),
  c("/clear", "清空屏幕开启新会话", "session"),
  c("/chat", "保存/恢复对话检查点", "session", "list|save|resume"),
  c("/compress", "压缩对话历史", "session"),
  c("/stats", "查看用量统计", "session"),
  c("/tools", "查看可用工具", "code"),
  c("/mcp", "查看 MCP 状态", "code"),
  c("/memory", "管理 GEMINI.md 记忆", "model"),
  c("/restore", "恢复文件检查点", "code"),
  c("/init", "生成 GEMINI.md", "code"),
  c("/quit", "退出", "session"),
]);

const ANTIGRAVITY_COMMANDS: SlashCommandItem[] = [
  ...CORE_SESSION,
  c("/goal", "开启长程目标自动推进", "skill", "<objective>"),
  c("/plan", "切换分步规划模式", "skill", "[task]"),
  c("/grill-me", "通过问答细化方案", "skill"),
  c("/teamwork", "启动多智能体协作", "skill"),
  c("/boost", "开启多视角深思与严格验证", "skill"),
  c("/browser", "调用浏览器测试与抓取", "code"),
  c("/schedule", "设置定时或提醒任务", "code"),
  c("/learn", "沉淀经验到规则中", "skill"),
  c("/mcp", "检查 MCP 服务列表", "code"),
  c("/review", "审查改动与测试结果", "code"),
];

const OMP_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "查看 omp 斜杠命令", "session"),
  c("/usage", "查看会话用量与各模型账号额度", "session"),
  c("/stats", "查看统计面板", "session"),
  c("/context", "查看上下文占用明细", "session"),
  c("/clear", "清空会话上下文", "session"),
  c("/compact", "压缩会话上下文", "session", "[focus]"),
  c("/shake", "剥离大块工具输出释放上下文", "session"),
  c("/handoff", "生成交接摘要", "session"),
  c("/new", "新建会话", "session"),
  c("/resume", "恢复历史会话", "session", "[id]"),
  c("/tree", "浏览会话分支树", "session"),
  c("/branch", "回退并保留分支", "session"),
  c("/fork", "分叉当前会话", "session"),
  c("/wt", "迁移到新 Git Worktree", "code"),
  c("/model", "切换模型", "model", "[model]"),
  c("/modelpreset", "应用模型预设", "model"),
  c("/fast", "开关快速优先模式", "model"),
  c("/slow", "开关节省 Flex 模式", "model"),
  c("/prewalk", "配置规划/执行模型交接", "model"),
  c("/advisor", "开关副驾驶复核", "model"),
  c("/plan", "切换规划模式", "code"),
  c("/goal", "设定持续目标模式", "skill"),
  c("/hub", "打开 Subagent 控制台", "skill"),
  c("/agents", "配置代理与模型角色", "skill"),
  c("/skills", "搜索与管理技能", "skill"),
  c("/extensions", "打开扩展控制中心", "model"),
  c("/mcp", "管理 MCP 服务器", "code"),
  c("/tools", "查看可见工具", "code"),
  c("/git", "查看 Git 改动与提交", "code"),
  c("/commit", "提交 Agent 改动", "code"),
  c("/btw", "旁路提问", "skill"),
  c("/tan", "后台运行支线 Agent", "skill"),
  c("/exit", "退出 omp", "session"),
]);

const PI_COMMANDS: SlashCommandItem[] = withUsage([
  ...CORE_SESSION,
  c("/stats", "查看统计面板", "session"),
  c("/tree", "浏览会话分支树", "session"),
  c("/branch", "分叉新分支", "session"),
  c("/fork", "复制分支会话", "session"),
  c("/skills", "查看所有技能", "skill"),
  c("/tools", "开关可用工具", "code"),
  c("/plan", "打开规划视图", "code"),
  c("/mcp", "管理 MCP 服务", "code"),
  c("/quit", "退出 Pi", "session"),
]);

const DSH_COMMANDS: SlashCommandItem[] = withUsage([
  ...CORE_SESSION,
  c("/balance", "查看 DeepSeek 账户余额", "session"),
  c("/tokens", "查看会话 Token 明细", "session"),
  c("/recap", "生成近期会话摘要", "session"),
  c("/rewind", "回退历史消息", "session"),
  c("/tree", "浏览会话分支树", "session"),
  c("/fork", "分叉当前会话", "session"),
  c("/btw", "快速旁路提问", "skill"),
  c("/plan", "进入计划模式", "code"),
  c("/subagent", "查看与切换子智能体", "skill"),
  c("/team", "团队任务看板", "skill"),
  c("/workflow", "运行工作流脚本", "skill"),
  c("/goal", "设定持续推进目标", "skill"),
  c("/effort", "调整推理强度", "model"),
  c("/preset", "切换角色预设", "model"),
  c("/skills", "查看已加载技能", "skill"),
  c("/permissions", "切换权限预设", "model"),
  c("/settings", "打开设置", "model"),
  c("/quit", "退出", "session"),
]);

const HERMES_COMMANDS: SlashCommandItem[] = withUsage([
  ...CORE_SESSION,
  c("/insights", "查看用量洞察", "session"),
  c("/compress", "压缩历史上下文", "session"),
  c("/undo", "回退上轮用户消息", "session"),
  c("/rollback", "恢复文件检查点", "code"),
  c("/branch", "分叉新分支", "session"),
  c("/worktree", "管理 Git Worktree", "code"),
  c("/background", "后台运行旁路任务", "skill"),
  c("/queue", "加入排队", "session"),
  c("/steer", "下次工具后插队注入", "session"),
  c("/agents", "查看活跃代理", "skill"),
  c("/goal", "设定驻留目标", "skill"),
  c("/loop", "定时循环执行", "code"),
  c("/review", "启动子代理代码审查", "code"),
  c("/learn", "沉淀为可复用技能", "skill"),
  c("/reasoning", "调整思考深度", "model"),
  c("/approvals", "设置危险命令审批", "model"),
  c("/skills", "搜索与管理技能", "skill"),
  c("/quit", "退出", "session"),
]);

const GROK_COMMANDS: SlashCommandItem[] = withUsage([
  ...CORE_SESSION,
  c("/session-info", "查看会话与模型详情", "session"),
  c("/dashboard", "打开代理调度面板", "skill"),
  c("/fork", "分叉为新 Agent", "session"),
  c("/rewind", "回退对话轮次", "session"),
  c("/effort", "设置推理强度", "model"),
  c("/density", "切换输出展示密度", "model"),
  c("/always-approve", "开关跳过审批提示", "model"),
  c("/plan", "进入只读规划模式", "code"),
  c("/goal", "设定自动验证目标", "skill"),
  c("/deep-research", "深度检索调研", "skill"),
  c("/skills", "查看可用技能", "skill"),
  c("/memory", "查看持久化记忆", "model"),
  c("/settings", "打开设置", "model"),
  c("/quit", "退出 Grok", "session"),
]);

const CODEBUDDY_COMMANDS: SlashCommandItem[] = [
  ...CORE_SESSION,
  c("/autocompact", "设置自动压缩阈值", "model"),
  c("/plan", "查看规划模式", "code"),
  c("/review", "代码与 PR 审查", "code"),
  c("/review-changes", "多维度变更审查", "code"),
  c("/branch", "创建对话分支", "session"),
  c("/fork-bg", "复制会话至后台运行", "skill"),
  c("/background", "切至后台会话", "skill"),
  c("/btw", "旁路快速咨询", "skill"),
  c("/goal", "设定目标条件", "skill"),
  c("/tasks", "管理后台任务", "skill"),
  c("/permissions", "管理权限规则", "model"),
  c("/skills", "查看可用技能", "skill"),
  c("/mcp", "管理 MCP 服务器", "code"),
];

const OPENCODE_KILO_COMMANDS: SlashCommandItem[] = withUsage([
  ...CORE_SESSION,
  c("/models", "列出可用模型", "model"),
  c("/agent", "切换执行模式", "model"),
  c("/init", "初始化 AGENTS.md", "code"),
  c("/sessions", "切换历史会话", "session"),
  c("/undo", "撤销上一轮更改", "code"),
  c("/redo", "重做更改", "code"),
  c("/exit", "退出", "session"),
]);

const AIDER_COMMANDS: SlashCommandItem[] = withUsage([
  c("/add", "加入可编辑文件", "code", "<file...>"),
  c("/read-only", "加入只读参考文件", "code", "<file...>"),
  c("/drop", "移除上下文文件", "code"),
  c("/ls", "列出上下文文件", "code"),
  c("/ask", "只提问不修改代码", "code"),
  c("/architect", "架构方案确认", "code"),
  c("/diff", "显示上一轮 Diff", "code"),
  c("/undo", "撤销最近提交", "code"),
  c("/commit", "自动提交代码", "code"),
  c("/test", "运行测试并修复", "code"),
  c("/tokens", "查看 Token 统计", "session"),
  c("/clear", "清空对话", "session"),
  c("/model", "切换模型", "model"),
]);

const GENERIC_COMMANDS: SlashCommandItem[] = [
  ...CORE_SESSION,
  c("/new", "新建会话", "session"),
  c("/plan", "先规划方案再执行", "code"),
  c("/diff", "查看改动", "code"),
  c("/review", "审查代码", "code"),
  c("/mcp", "查看 MCP 服务", "code"),
  c("/skills", "查看技能列表", "skill"),
  c("/exit", "退出", "session"),
];

export function canonicalHarnessId(harness: string): string {
  const h = harness.trim().toLowerCase();
  if (!h) return "generic";
  if (h.includes("claude")) return "claude";
  if (h.includes("codex")) return "codex";
  if (h.includes("antigravity") || h === "agy") return "antigravity";
  if (h.includes("gemini")) return "gemini";
  if (h.includes("deepseek") || h === "dsh") return "dsh";
  if (h === "omp" || h.includes("oh-my-pi")) return "omp";
  if (h === "pi" || h.includes("pi-mono")) return "pi";
  if (h.includes("opencode") || h.includes("kilo") || h.includes("crush")) return "opencode";
  if (h.includes("hermes")) return "hermes";
  if (h.includes("grok")) return "grok";
  if (h.includes("codebuddy") || h.includes("workbuddy") || h === "cbc") return "codebuddy";
  if (h.includes("aider")) return "aider";
  if (h.includes("qoder") || h.includes("qwen") || h.includes("mimocode") || h.includes("minimax") || h.includes("zcode")) return "claude";
  if (h.includes("crosery") || h.includes("prime") || h.includes("commandcode") || h.includes("reasonix")) return "claude";
  return h;
}

const BY_HARNESS: Record<string, SlashCommandItem[]> = {
  claude: CLAUDE_COMMANDS,
  codex: CODEX_COMMANDS,
  gemini: GEMINI_COMMANDS,
  antigravity: ANTIGRAVITY_COMMANDS,
  omp: OMP_COMMANDS,
  pi: PI_COMMANDS,
  dsh: DSH_COMMANDS,
  hermes: HERMES_COMMANDS,
  grok: GROK_COMMANDS,
  codebuddy: CODEBUDDY_COMMANDS,
  opencode: OPENCODE_KILO_COMMANDS,
  aider: AIDER_COMMANDS,
};

export function builtinSlashCommands(harness: string, isShell = false): SlashCommandItem[] {
  if (isShell) return [];
  return BY_HARNESS[canonicalHarnessId(harness)] ?? GENERIC_COMMANDS;
}

const ICON_BY_NAME: Record<string, SlashIconKind> = {
  usage: "usage",
  cost: "usage",
  tokens: "usage",
  stats: "usage",
  balance: "usage",
  topup: "usage",
  subscription: "usage",
  insights: "usage",
  context: "context",
  "context-window": "context",
  "extended-context": "context",
  density: "context",
  help: "help",
  docs: "help",
  tutorial: "help",
  tips: "help",
  about: "help",
  version: "help",
  changelog: "help",
  hotkeys: "keyboard",
  keybindings: "keyboard",
  vim: "keyboard",
  status: "status",
  "session-info": "status",
  info: "status",
  doctor: "status",
  debug: "status",
  trace: "status",
  clear: "clear",
  reset: "clear",
  fresh: "clear",
  delete: "clear",
  compact: "compact",
  compress: "compact",
  smol: "compact",
  shake: "compact",
  handoff: "compact",
  autocompact: "compact",
  new: "new",
  newtask: "new",
  home: "new",
  resume: "history",
  sessions: "history",
  threads: "history",
  history: "history",
  chat: "history",
  recap: "history",
  dashboard: "history",
  tree: "branch",
  branch: "branch",
  fork: "branch",
  "fork-bg": "branch",
  worktree: "branch",
  wt: "branch",
  rewind: "branch",
  undo: "branch",
  redo: "branch",
  restore: "branch",
  rollback: "branch",
  export: "share",
  save: "share",
  share: "share",
  copy: "share",
  rename: "share",
  title: "share",
  quit: "exit",
  exit: "exit",
  logout: "exit",
  stop: "exit",
  model: "model",
  models: "model",
  modelpreset: "model",
  agent: "model",
  mode: "model",
  preset: "model",
  personality: "model",
  provider: "model",
  fast: "speed",
  slow: "speed",
  effort: "speed",
  reasoning: "speed",
  prewalk: "speed",
  advisor: "speed",
  permissions: "shield",
  approvals: "shield",
  approve: "shield",
  sandbox: "shield",
  yolo: "shield",
  "always-approve": "shield",
  privacy: "shield",
  memory: "memory",
  remember: "memory",
  init: "memory",
  login: "auth",
  auth: "auth",
  setup: "auth",
  config: "settings",
  settings: "settings",
  theme: "settings",
  hooks: "settings",
  plugins: "settings",
  extensions: "settings",
  plan: "plan",
  architect: "plan",
  ask: "plan",
  review: "review",
  "review-changes": "review",
  "security-review": "review",
  "pr-comments": "review",
  diff: "git",
  git: "git",
  commit: "git",
  mcp: "mcp",
  mcps: "mcp",
  tools: "mcp",
  browser: "browser",
  web: "browser",
  schedule: "schedule",
  loop: "schedule",
  cron: "schedule",
  queue: "schedule",
  steer: "schedule",
  add: "workspace",
  "read-only": "workspace",
  drop: "workspace",
  ls: "workspace",
  "add-dir": "workspace",
  test: "workspace",
  goal: "goal",
  subgoal: "goal",
  agents: "agents",
  subagent: "agents",
  subagents: "agents",
  hub: "agents",
  team: "agents",
  teamwork: "agents",
  background: "agents",
  btw: "agents",
  tan: "agents",
  tasks: "agents",
  skills: "skill",
  skill: "skill",
  learn: "skill",
  workflow: "skill",
  "deep-research": "skill",
  boost: "skill",
  "grill-me": "skill",
};

export function slashCommandIconKind(cmd: SlashCommandItem): SlashIconKind {
  const bare = cmd.name.trim().toLowerCase().replace(/^\//, "");
  const direct = ICON_BY_NAME[bare];
  if (direct) return direct;
  if (cmd.category === "skill") return "skill";
  if (cmd.category === "custom") return "custom";
  if (cmd.category === "model") return "settings";
  if (cmd.category === "code") return "mcp";
  return "status";
}

export function mergeSlashCommands(builtins: SlashCommandItem[], discovered: SlashCommandItem[]): SlashCommandItem[] {
  const byName = new Map<string, SlashCommandItem>();
  for (const b of builtins) byName.set(b.name.toLowerCase(), b);
  for (const d of discovered) {
    const k = d.name.toLowerCase();
    const prev = byName.get(k);
    byName.set(k, prev ? { ...prev, ...d } : d);
  }
  return [...byName.values()];
}

export function extractSlashQuery(text: string): string | null {
  const trimmedLeft = text.replace(/^[ \t]+/, "");
  if (!trimmedLeft.startsWith("/")) return null;
  if (/\s/.test(trimmedLeft)) return null;
  return trimmedLeft.slice(1).toLowerCase();
}

export function matchSlashCommands(
  commands: SlashCommandItem[],
  query: string,
  category: "all" | SlashCategory = "all",
): SlashCommandItem[] {
  const q = query.trim().toLowerCase().replace(/^\//, "");
  const pool = category === "all" ? commands : commands.filter((item) => item.category === category);
  if (!q) return pool;
  const scored: Array<{ item: SlashCommandItem; rank: number }> = [];
  for (const item of pool) {
    const bare = item.name.slice(1).toLowerCase();
    const desc = item.description.toLowerCase();
    if (bare === q) scored.push({ item, rank: 0 });
    else if (bare.startsWith(q)) scored.push({ item, rank: 1 });
    else if (bare.includes(q)) scored.push({ item, rank: 2 });
    else if (desc.includes(q)) scored.push({ item, rank: 3 });
  }
  scored.sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name));
  return scored.map((s) => s.item);
}
