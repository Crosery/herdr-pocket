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
  c("/help", "查看当前 Agent 支持的斜杠命令与快捷键", "session"),
  c("/usage", "查看当前会话、上下文占用与本机额度用量", "session"),
  c("/btw", "不打断主线快速旁路提问", "skill", "<question>"),
  c("/clear", "清空当前会话上下文，开启全新一轮", "session"),
  c("/compact", "压缩并总结较早的对话上下文以释放额度", "session", "[focus]"),
  c("/status", "查看当前会话、模型、额度与连接状态", "session"),
  c("/model", "切换或查看当前使用的模型", "model", "[model]"),
  c("/resume", "恢复或切换到历史会话", "session", "[id]"),
  c("/cost", "查看本轮与会话累计 Token 及费用统计", "session"),
  c("/context", "检查当前上下文窗口占用明细", "session"),
];

const CLAUDE_COMMANDS: SlashCommandItem[] = [
  ...CORE_SESSION,
  c("/init", "扫描项目并生成或更新 CLAUDE.md 项目指引", "code"),
  c("/plan", "进入只读规划模式，先出方案再执行", "code", "[goal]"),
  c("/effort", "调整当前模型的推理思考等级（low..max/auto）", "model", "[level]"),
  c("/fast", "开关 Fast 快速模式", "model", "[on|off]"),
  c("/review", "审查当前分支或工作区代码改动", "code", "[pr]"),
  c("/pr-comments", "拉取并查看 Pull Request 评论", "code"),
  c("/security-review", "针对待提交改动做安全审计", "code"),
  c("/rewind", "回退会话消息或文件改动到上一检查点", "session"),
  c("/agents", "查看、创建或管理自定义 Subagent", "skill"),
  c("/mcp", "查看与管理已连接的 MCP 服务", "code"),
  c("/hooks", "配置会话生命周期 Hook", "model"),
  c("/plugin", "管理 Claude Code 插件", "skill"),
  c("/memory", "查看或编辑 CLAUDE.md / Auto Memory", "model"),
  c("/permissions", "查看或调整工具执行权限", "model"),
  c("/add-dir", "将额外目录加入当前工作区上下文", "code", "<path>"),
  c("/config", "打开设置面板", "model"),
  c("/doctor", "诊断本地运行环境与安装状态", "model"),
  c("/export", "导出当前对话为文本或 Markdown", "session"),
  c("/vim", "切换 Vim 编辑键位模式", "model"),
  c("/login", "登录或切换 Anthropic 账号", "model"),
  c("/logout", "退出当前登录状态", "model"),
  c("/exit", "退出当前 Agent 会话", "session"),
];

const CODEX_COMMANDS: SlashCommandItem[] = [
  ...CORE_SESSION,
  c("/init", "在当前仓库初始化 AGENTS.md 指引文件", "code"),
  c("/approvals", "设置执行批准策略与沙箱模式", "model"),
  c("/permissions", "调整工作区读写与命令执行权限", "model"),
  c("/diff", "查看当前 Git 变更差异", "code"),
  c("/review", "触发 Codex 代码审查", "code", "[branch]"),
  c("/new", "新建一段 Codex 对话", "session"),
  c("/mcp", "列出与配置 MCP 工具服务器", "code"),
  c("/logout", "登出账号", "model"),
  c("/quit", "退出 Codex", "session"),
];

const GEMINI_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "显示所有可用 Gemini CLI 斜杠命令", "session"),
  c("/btw", "不打断主线快速旁路提问", "skill", "<question>"),
  c("/clear", "清空终端屏幕并开启新会话", "session"),
  c("/chat", "管理、保存或恢复对话检查点", "session", "list|save|resume"),
  c("/compress", "用摘要替换历史对话以节省上下文", "session"),
  c("/stats", "查看当前会话 Token 与耗时统计", "session"),
  c("/model", "查看或切换 Gemini 模型（/model set <name>）", "model", "set <model>"),
  c("/tools", "列出可用内置与扩展工具", "code"),
  c("/mcp", "查看或刷新 MCP Server 状态", "code"),
  c("/extensions", "查看已安装的扩展", "skill"),
  c("/memory", "查看、重载或追加 GEMINI.md 记忆", "model", "show|refresh|add"),
  c("/restore", "回滚工具修改过的文件检查点", "code", "[checkpoint]"),
  c("/init", "分析仓库生成 GEMINI.md", "code"),
  c("/theme", "切换 CLI 主题配色", "model"),
  c("/auth", "配置认证方式或 API Key", "model"),
  c("/about", "查看版本信息", "session"),
  c("/quit", "退出 Gemini CLI", "session"),
]);

const ANTIGRAVITY_COMMANDS: SlashCommandItem[] = [
  ...CORE_SESSION,
  c("/goal", "开启长程目标执行，持续推进直至达标", "skill", "<objective>"),
  c("/effort", "调整当前模型的推理思考等级（low..max）", "model", "[level]"),
  c("/plan", "切换为分步规划模式", "skill", "[task]"),
  c("/grill-me", "通过深度问答敲定设计细节", "skill"),
  c("/teamwork", "启动多智能体协作拆解大型任务", "skill"),
  c("/boost", "开启多视角深思与严格验证", "skill"),
  c("/browser", "使用内置浏览器抓取、测试或交互", "code"),
  c("/schedule", "设置一次性提醒或定时任务", "code"),
  c("/learn", "沉淀本次经验到持久规则中", "skill"),
  c("/mcp", "检查 MCP 服务列表与工具", "code"),
  c("/review", "审查最新改动与测试验证结果", "code"),
];

const OMP_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "查看 omp 斜杠命令与快捷键说明", "session"),
  c("/usage", "查看当前会话用量与各模型/账号速率额度", "session"),
  c("/stats", "打开本地统计面板与消耗分析", "session"),
  c("/context", "浏览上下文窗口占用明细", "session"),
  c("/clear", "清空对话上下文并保留当前会话", "session"),
  c("/compact", "手动压缩会话上下文", "session", "[focus]"),
  c("/shake", "剥离大块工具输出释放上下文", "session"),
  c("/handoff", "后台生成交接摘要并切换模型/分支", "session"),
  c("/new", "创建全新会话", "session"),
  c("/fresh", "重置连接流状态但保留本地记录", "session"),
  c("/resume", "切换到其他历史会话", "session", "[id]"),
  c("/pin", "置顶或取消置顶当前会话", "session"),
  c("/rename", "重命名当前会话", "session", "[title]"),
  c("/move", "将当前会话迁移到另一目录", "code", "<dir>"),
  c("/tree", "浏览会话分支树并切换分支", "session"),
  c("/branch", "回退到指定消息并将旧路径保留为分支", "session"),
  c("/fork", "分叉当前会话或在新窗口继续", "session"),
  c("/wt", "迁移到新的 Git Worktree 并保留改动", "code"),
  c("/model", "打开模型选择面板", "model"),
  c("/switch", "直接切换会话模型（支持 provider/id 或 :thinking）", "model", "<selector[:level]>"),
  c("/effort", "设置当前模型思考等级（off..max）", "model", "<level>"),
  c("/modelpreset", "保存或应用模型与思考强度预设", "model"),
  c("/fast", "开关 Fast 优先加速模式", "model"),
  c("/slow", "开关低优先 Flex 节省模式", "model"),
  c("/extended-context", "开关长上下文窗口模式", "model"),
  c("/prewalk", "配置规划/执行单次模型交接", "model", "[into|off]"),
  c("/advisor", "开关副驾驶 Advisor 复核", "model"),
  c("/vibe", "开关只读快速调研模式", "model"),
  c("/plan", "切换分步规划模式", "code"),
  c("/plan-review", "重新打开最近一次方案评审", "code"),
  c("/goal", "设定持续推进直到达标的目标模式", "skill", "[text]"),
  c("/guided-goal", "先问答收敛需求再开启目标模式", "skill"),
  c("/ratchet", "自动评估并迭代优化流程", "skill"),
  c("/hub", "打开活跃 Subagent 控制台", "skill"),
  c("/agents", "配置主从 Agent 模型与角色预设", "skill"),
  c("/skills", "搜索、安装或管理技能列表", "skill"),
  c("/extensions", "打开扩展控制中心", "model"),
  c("/marketplace", "浏览与安装扩展市场插件", "model"),
  c("/mcp", "管理 MCP 服务器与工具重载", "code"),
  c("/tools", "查看当前对 Agent 可见的工具", "code"),
  c("/git", "打开分栏 Diff 与 Git 提交面板", "code"),
  c("/commit", "仅提交本次 Agent 产生的改动", "code"),
  c("/add-dir", "向会话追加额外工作目录", "code", "<path>"),
  c("/remove-dir", "从会话移除工作目录", "code", "<path>"),
  c("/browser", "切换浏览器评估头less/可见模式", "code"),
  c("/computer", "开关桌面端原生评估前导", "code"),
  c("/live", "启动实时语音交互模式", "code"),
  c("/collab", "通过 Relay 分享实时只读/协作链接", "session"),
  c("/export", "导出会话为可浏览 HTML", "session"),
  c("/trace", "查看本次会话 Trace 轨迹", "session"),
  c("/dump", "复制转录文本并导出请求 JSON", "session"),
  c("/copy", "选取并复制对话代码块或链接", "session"),
  c("/btw", "旁路提问而不打断当前对话", "skill", "<question>"),
  c("/tan", "在后台独立运行支线任务 Agent", "skill", "<task>"),
  c("/cleanse", "并行调用子 Agent 检查并修复项目诊断", "code"),
  c("/omfg", "生成规则阻止重复出现的不良行为", "model"),
  c("/memory", "检查并维护持久化记忆状态", "model"),
  c("/debug", "打开调试与诊断工具", "session"),
  c("/hotkeys", "查看全部快捷键列表", "session"),
  c("/changelog", "查看版本更新日志", "session"),
  c("/login", "OAuth 登录认证服务商", "model"),
  c("/logout", "登出当前认证服务商", "model"),
  c("/restart", "保持参数与运行中子 Agent 重启", "session"),
  c("/exit", "退出 omp", "session"),
]);

const PI_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "查看 Pi 命令与快捷键", "session"),
  c("/btw", "不打断主线快速旁路提问", "skill", "<question>"),
  c("/usage", "查看会话用量、费用与上下文占比", "session"),
  c("/stats", "查看会话指标与耗时统计", "session"),
  c("/context", "检查上下文窗口内容明细", "session"),
  c("/clear", "清空当前会话上下文", "session"),
  c("/compact", "压缩历史上下文", "session", "[focus]"),
  c("/new", "开始新的会话", "session"),
  c("/resume", "恢复历史会话", "session", "[id]"),
  c("/tree", "打开会话分支树并切换节点", "session"),
  c("/branch", "从历史消息分叉新分支", "session"),
  c("/fork", "复制当前会话到新线程", "session"),
  c("/model", "切换模型", "model", "[model]"),
  c("/thinking", "切换 Pi 思考等级（off..max）", "model", "<level>"),
  c("/plan", "进入结构化规划视图", "code"),
  c("/skills", "查看已加载技能", "skill"),
  c("/extensions", "查看扩展列表", "model"),
  c("/tools", "启用或禁用工具集", "code"),
  c("/mcp", "管理 MCP 服务器", "code"),
  c("/export", "导出当前对话记录", "session"),
  c("/quit", "退出 Pi", "session"),
]);

const DSH_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "查看 DeepSeek Harness 命令与快捷键", "session"),
  c("/usage", "查看会话用量、模型消耗与额度", "session"),
  c("/balance", "查看 DeepSeek 账户余额与状态", "session"),
  c("/tokens", "查看当前会话 Token 明细", "session"),
  c("/cost", "查看当前会话累计费用估算", "session"),
  c("/context", "查看已加载上下文分布", "session"),
  c("/status", "查看当前会话、模型与运行状态", "session"),
  c("/trace", "打开会话事件 Trace 时间线", "session"),
  c("/tips", "查看使用技巧与快捷键提示", "session"),
  c("/new", "开启一段新对话", "session"),
  c("/clear", "清空当前对话历史", "session"),
  c("/compact", "压缩并精简历史消息", "session", "[focus]"),
  c("/resume", "恢复历史会话", "session", "[id]"),
  c("/rename", "重命名当前会话", "session", "[title]"),
  c("/recap", "生成近期会话活动摘要", "session"),
  c("/rewind", "回退到较早的对话消息", "session"),
  c("/tree", "浏览会话家族树（回退/分叉/接管）", "session"),
  c("/fork", "分叉当前会话为可恢复副本", "session"),
  c("/export", "导出对话为 Markdown 文件", "session"),
  c("/btw", "不打断主线快速旁路提问", "skill", "<question>"),
  c("/plan", "进入计划模式先评审方案", "code"),
  c("/goal", "设定持续推进的目标模式", "skill", "[goal]"),
  c("/team", "开启团队协作任务看板", "skill"),
  c("/workflow", "查看或运行工作流脚本", "skill"),
  c("/agents", "查看当前会话下的子智能体", "skill"),
  c("/subagent", "管理或切换子智能体会话", "skill"),
  c("/model", "切换当前活跃模型", "model", "[model]"),
  c("/effort", "调整推理思考强度滑块", "model", "[level]"),
  c("/thinking", "切换详细思考过程展示", "model"),
  c("/preset", "切换 Agent 角色预设（含亮神模式）", "model"),
  c("/provider", "添加或切换模型服务商配置", "model"),
  c("/theme", "切换界面主题配色", "model"),
  c("/color", "设置当前会话强调色", "model"),
  c("/lang", "切换界面语言（zh / en）", "model"),
  c("/config", "查看配置来源与生效项", "model"),
  c("/settings", "编辑插件与运行设置", "model"),
  c("/permissions", "查看或调整工具执行权限", "model"),
  c("/reload", "热重载磁盘偏好配置", "model"),
  c("/doctor", "运行本地环境健康检查", "model"),
  c("/init", "在工作目录生成 AGENTS.md", "code"),
  c("/add-dir", "查看或扩充文件系统访问目录", "code", "<path>"),
  c("/hooks", "查看会话 Hook 状态", "model"),
  c("/mcp", "查看与管理 MCP 服务", "code"),
  c("/skills", "查看已发现技能清单", "skill"),
  c("/plugins", "查看插件契约、授权与账本诊断", "model"),
  c("/vim", "切换 Vim 编辑模式", "model"),
  c("/workspace", "打开、重命名或切换工作区", "code"),
  c("/connect", "连接到远程机器节点", "code"),
  c("/restart", "重启 dsh 并恢复当前会话", "session"),
  c("/quit", "退出 dsh 会话", "session"),
]);

const HERMES_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "查看 Hermes 全部可用斜杠命令", "session"),
  c("/btw", "不打断主线快速旁路提问", "skill", "<question>"),
  c("/usage", "查看 Token 用量、上下文压力与限额恢复", "session", "[reset]"),
  c("/insights", "查看近几日用量分析与费用洞察", "session", "[days]"),
  c("/subscription", "查看当前订阅方案与额度入口", "model"),
  c("/topup", "查看账户余额与充值账单管理", "model"),
  c("/status", "查看会话、模型、Token 与环境状态", "session"),
  c("/context", "查看上下文仪表盘与压缩占比统计", "session", "[all]"),
  c("/palette", "打开模糊搜索命令面板", "session"),
  c("/new", "创建新会话与全新历史", "session", "[name]"),
  c("/clear", "清屏并开始新会话", "session"),
  c("/compress", "压缩历史上下文（支持保留最近 N 轮）", "session", "[focus]"),
  c("/undo", "回退 N 轮用户消息并重新提问", "session", "[N]"),
  c("/rollback", "查看或恢复文件系统检查点", "code", "[num]"),
  c("/snapshot", "创建或恢复 Hermes 配置与状态快照", "model", "[create|restore]"),
  c("/branch", "从当前位置分叉一条新的探索分支", "session", "[name]"),
  c("/worktree", "管理隔离的 Git Worktree（new/list/prune）", "code", "[new|list|prune]"),
  c("/resume", "按名称恢复历史会话", "session", "[name]"),
  c("/sessions", "浏览并恢复本地会话列表", "session"),
  c("/save", "导出对话为 json / md / html", "session", "<fmt> [file]"),
  c("/retry", "重新发送上一条消息让 Agent 重试", "session"),
  c("/title", "设置当前会话标题", "session", "[name]"),
  c("/handoff", "移交当前会话到消息网关平台", "session", "<platform>"),
  c("/stop", "终止当前正在运行的后台进程", "session"),
  c("/background", "在后台不中断主线程并行提问", "skill", "<prompt>"),
  c("/queue", "将后续消息加入排队（不打断当前轮）", "session", "<prompt>"),
  c("/steer", "在下次工具调用后立即插队注入提示", "session", "<prompt>"),
  c("/agents", "查看活跃 Agent 与后台任务状态", "skill"),
  c("/goal", "设定长期驻留目标跨轮次持续推进", "skill", "[text]"),
  c("/subgoal", "管理当前目标的附加验收条目", "skill"),
  c("/heartbeat", "设置空闲时定期唤醒执行的检查任务", "code", "[every <interval>]"),
  c("/loop", "按固定间隔循环执行指定任务", "code", "[interval] <prompt>"),
  c("/review", "启动独立子 Agent 审查代码/文档改动", "code", "[instructions]"),
  c("/refine", "提炼本轮经验并沉淀到记忆与技能库", "skill"),
  c("/learn", "从目录、URL 或当前对话提取可复用 Skill", "skill", "<source>"),
  c("/init", "扫描仓库生成或更新 AGENTS.md", "code"),
  c("/model", "切换推理模型（支持 --global 全局保存）", "model", "[model]"),
  c("/reasoning", "设置思考深度与思维链展示方式", "model", "[level]"),
  c("/fast", "开关快速推理档位", "model", "[on|off|status]"),
  c("/personality", "切换预设人格角色", "model", "[name]"),
  c("/yolo", "开关跳过危险命令审批模式", "model"),
  c("/approvals", "设置高危命令审批策略（manual/smart/off）", "model"),
  c("/diff", "查看当前工作区 Git 变更统计", "code", "[staged|all]"),
  c("/verbose", "切换工具进度详略程度", "model"),
  c("/focus", "开关专注视图（仅显示提问与最终回复）", "model"),
  c("/skin", "切换展示皮肤与主题", "model", "[name]"),
  c("/voice", "开关语音交互与朗读模式", "model"),
  c("/tools", "列出、启用或禁用可用工具", "code"),
  c("/toolsets", "查看可用工具集合", "code"),
  c("/skills", "搜索、浏览、审核与管理技能", "skill"),
  c("/memory", "审核待写入记忆或开关记忆闸门", "model"),
  c("/bundles", "查看可一键激活多个技能的技能包", "skill"),
  c("/kanban", "管理多协作看板任务与派单", "skill"),
  c("/cron", "管理定时调度任务", "code"),
  c("/browser", "通过 CDP 接入本机浏览器或 Browser Use", "code"),
  c("/plugins", "查看已安装插件状态", "model"),
  c("/reload-mcp", "重载 MCP Server 配置", "code"),
  c("/reload-skills", "重扫 ~/.hermes/skills 下新增或移除的技能", "skill"),
  c("/copy", "复制最近一次助手回复", "session"),
  c("/debug", "生成系统诊断与日志共享报告", "session"),
  c("/version", "查看 Hermes Agent 版本", "session"),
  c("/quit", "退出 Hermes 会话", "session"),
]);

const GROK_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "查看 Grok CLI 全部命令文档", "session"),
  c("/usage", "查看账号额度、剩余信用与会话 Token 明细", "session", "[manage]"),
  c("/context", "查看系统提示/消息/开销在上下文中的占比", "session"),
  c("/session-info", "查看当前会话鉴权、模型与轮次详情", "session"),
  c("/status", "查看会话连接与额度概况", "session"),
  c("/docs", "查看内置 Grok 用户手册", "session"),
  c("/new", "清空对话开始新会话", "session"),
  c("/clear", "重置当前会话上下文", "session"),
  c("/resume", "搜索并恢复历史会话", "session", "[id]"),
  c("/dashboard", "打开在线会话调度面板", "skill"),
  c("/compact", "压缩历史上下文释放窗口空间", "session"),
  c("/fork", "将当前会话分叉为新 Agent", "session"),
  c("/rewind", "回退到指定轮次并撤销后续更改", "session"),
  c("/undo", "撤销上一轮修改与对话", "code"),
  c("/copy", "复制最近一次 Markdown 回复", "session"),
  c("/export", "导出会话内容到文件或剪贴板", "session"),
  c("/rename", "重命名当前会话标题", "session", "<title>"),
  c("/delete", "删除当前会话历史", "session"),
  c("/model", "切换模型 ID、窗口大小与推理强度", "model", "<name>"),
  c("/effort", "调整当前模型的推理强度（low..xhigh）", "model", "<level>"),
  c("/context-window", "切换模型支持的上下文窗口大小", "model", "<size>"),
  c("/always-approve", "开关跳过权限确认提示", "model"),
  c("/auto", "开关智能分类器自动批准安全工具", "model"),
  c("/density", "切换工具调用与 Diff 展示密度", "model"),
  c("/compact-mode", "开关紧凑排版密度", "model"),
  c("/plan", "进入只读规划模式", "code"),
  c("/view-plan", "查看当前已生成的规划文档", "code"),
  c("/goal", "设定自动持续验证达标的目标模式", "skill", "[objective]"),
  c("/deep-research", "启动深度联网/代码检索研究", "skill", "<query>"),
  c("/workflow", "查看或执行当前工作流", "skill"),
  c("/workflows", "列出可用工作流模板", "skill"),
  c("/loop", "按间隔定时重复执行提示词", "code", "[interval] <prompt>"),
  c("/memory", "查看或编辑持久记忆", "model"),
  c("/remember", "写入一条持久项目经验规则", "model"),
  c("/dream", "整理与归纳跨会话记忆", "model"),
  c("/flush", "立即将上下文关键状态刷写到记忆", "model"),
  c("/hooks", "查看与配置生命周期 Hook", "model"),
  c("/plugins", "查看与管理已安装插件", "model"),
  c("/marketplace", "浏览扩展与技能市场", "skill"),
  c("/skills", "查看已启用 Slash 技能", "skill"),
  c("/mcps", "查看已连接的 MCP 服务", "code"),
  c("/config-agents", "管理预设子智能体与人格角色", "skill"),
  c("/personas", "切换对话与协作人格预设", "model"),
  c("/btw", "不中断当前任务发起旁路提问", "skill", "<question>"),
  c("/theme", "切换 CLI 主题皮肤", "model"),
  c("/settings", "打开完整交互设置面板", "model"),
  c("/privacy", "配置数据留存与训练隐私选项", "model"),
  c("/doctor", "检查认证、守护进程与运行诊断", "model"),
  c("/login", "登录认证账号", "model"),
  c("/logout", "登出当前账号", "model"),
  c("/quit", "退出 Grok CLI", "session"),
]);

const CODEBUDDY_COMMANDS: SlashCommandItem[] = [
  ...CORE_SESSION,
  c("/autocompact", "设置自动触发上下文压缩的阈值", "model"),
  c("/plan", "预览或切换当前规划文件模式", "code"),
  c("/review", "触发 Pull Request / 代码变更审查", "code"),
  c("/review-changes", "多维度审视工作区改动文件", "code"),
  c("/pr-comments", "拉取 PR 审查意见", "code"),
  c("/rewind", "回退代码与会话到上一检查点", "session"),
  c("/branch", "在当前对话节点创建分支", "session"),
  c("/fork", "分叉当前会话继续探索", "session"),
  c("/fork-bg", "复制会话到后台持续运行，主线程保持不变", "skill"),
  c("/background", "将当前会话切到后台运行", "skill"),
  c("/goal", "持续工作直到达成验收条件", "skill", "<condition>"),
  c("/tasks", "查看并管理后台运行任务", "skill"),
  c("/todos", "展示当前会话待办清单", "session"),
  c("/rename", "重命名当前对话", "session", "<name>"),
  c("/export", "导出当前对话至文件或剪贴板", "session"),
  c("/add-dir", "加入额外的本地工作目录", "code", "<path>"),
  c("/approve", "批准最近一次被自动拦截的操作重试", "model"),
  c("/permissions", "管理允许/拒绝工具执行的权限规则", "model"),
  c("/sandbox", "配置与管理沙箱安全策略", "model"),
  c("/mcp", "管理已接入的 MCP 服务器", "code"),
  c("/skills", "列出可用技能清单", "skill"),
  c("/hooks", "配置工具事件 Hook", "model"),
  c("/config", "管理运行时配置项", "model"),
  c("/keybindings", "打开快捷键配置", "model"),
  c("/vim", "切换 Vim / 普通编辑模式", "model"),
  c("/web", "在浏览器打开 Web UI", "code"),
  c("/gateway", "管理远程控制网关客户端", "code"),
  c("/remote-control", "管理远程控制长连接", "code"),
];

const OPENCODE_KILO_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "查看所有斜杠命令", "session"),
  c("/btw", "不打断主线快速旁路提问", "skill", "<question>"),
  c("/usage", "查看会话消耗与本机用量统计", "session"),
  c("/clear", "重置当前对话", "session"),
  c("/compact", "总结并压缩上下文", "session"),
  c("/model", "选择模型或切换 Provider", "model", "[provider/model]"),
  c("/models", "列出可用模型列表", "model"),
  c("/agent", "切换执行模式（Build / Plan / Code / Ask）", "model"),
  c("/agents", "查看或管理 Agent 配置", "skill"),
  c("/init", "初始化 AGENTS.md", "code"),
  c("/sessions", "浏览并切换历史会话", "session"),
  c("/undo", "撤销上一轮更改与消息", "code"),
  c("/redo", "重做已撤销的更改", "code"),
  c("/share", "生成会话分享链接", "session"),
  c("/themes", "切换外观主题", "model"),
  c("/editor", "用系统编辑器打开输入框草稿", "code"),
  c("/exit", "退出程序", "session"),
]);

const CURSOR_COMMANDS: SlashCommandItem[] = [
  ...CORE_SESSION,
  c("/rules", "查看或编辑项目规则（.cursor/rules）", "model"),
  c("/commands", "列出自定义 Slash Commands", "custom"),
  c("/diff", "查看工作区 Diff", "code"),
  c("/review", "审查改动", "code"),
  c("/mcp", "查看 Cursor MCP 状态", "code"),
];

const QODER_QWEN_COMMANDS: SlashCommandItem[] = [
  ...CORE_SESSION,
  c("/init", "扫描代码库生成项目记忆文档", "code"),
  c("/memory", "查看或更新项目记忆", "model"),
  c("/agents", "查看可用子智能体配置", "skill"),
  c("/skills", "查看已加载技能", "skill"),
  c("/mcp", "查看与配置 MCP Server", "code"),
  c("/permissions", "查看或更新执行权限规则", "model"),
  c("/compress", "压缩长对话历史", "session"),
  c("/quit", "退出", "session"),
];

const CLINE_ROO_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "查看可用命令与工作流", "session"),
  c("/usage", "查看当前会话与本机用量统计", "session"),
  c("/newtask", "开启全新任务上下文", "session", "[prompt]"),
  c("/smol", "压缩并精简历史上下文", "session"),
  c("/compact", "总结当前任务进度", "session"),
  c("/mode", "切换工作模式（Code / Architect / Ask / Debug）", "model", "[mode]"),
  c("/model", "切换推理模型", "model"),
  c("/newrule", "快速创建项目规则或工作流", "code"),
  c("/mcp", "管理 MCP 服务器", "code"),
  c("/reportbug", "导出调试信息反馈问题", "session"),
]);

const AIDER_COMMANDS: SlashCommandItem[] = withUsage([
  c("/add", "将文件加入对话可编辑上下文", "code", "<file...>"),
  c("/read-only", "以只读参考形式加入文件", "code", "<file...>"),
  c("/drop", "从上下文移除指定文件", "code", "[file...]"),
  c("/ls", "列出当前上下文与仓库文件", "code"),
  c("/ask", "仅提问不改代码", "code", "<question>"),
  c("/architect", "先规划方案再确认修改", "code", "<prompt>"),
  c("/code", "切回直接改代码模式", "code", "[prompt]"),
  c("/diff", "显示上一轮编辑 Diff", "code"),
  c("/undo", "撤销 Aider 最近一次提交", "code"),
  c("/commit", "自动生成提交信息并 commit", "code"),
  c("/lint", "对相关文件执行静态检查", "code"),
  c("/test", "运行测试命令并自动修复失败项", "code", "[cmd]"),
  c("/tokens", "查看当前上下文 Token 消耗", "session"),
  c("/clear", "清空对话历史保留文件列表", "session"),
  c("/reset", "清空文件列表和对话历史", "session"),
  c("/model", "切换主模型", "model", "<model>"),
  c("/reasoning-effort", "设置推理强度（low/medium/high）", "model", "<level>"),
  c("/think-tokens", "设置推理思考 Token 预算（如 8k / 0）", "model", "<budget>"),
  c("/help", "显示 Aider 帮助", "session"),
]);

const GOOSE_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "列出 Goose 会话命令", "session"),
  c("/usage", "查看当前会话与本机用量统计", "session"),
  c("/mode", "切换执行模式（auto / approve / smart_approve / chat）", "model", "<mode>"),
  c("/plan", "进入或退出计划模式", "code"),
  c("/t", "管理或切换子任务配方", "skill"),
  c("/clear", "清空当前会话上下文", "session"),
  c("/compact", "压缩消息历史", "session"),
  c("/mcp", "查看扩展与 MCP 连接", "code"),
  c("/exit", "退出 Goose", "session"),
]);

const AMP_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "查看 Amp 命令帮助", "session"),
  c("/usage", "查看当前会话与本机用量统计", "session"),
  c("/new", "创建新对话线程", "session"),
  c("/threads", "查看并切换最近线程", "session"),
  c("/compact", "压缩长线程上下文", "session"),
  c("/model", "切换模型预设（smart / rush）", "model"),
  c("/permissions", "管理工具执行权限", "model"),
]);

const COPILOT_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "显示 Copilot CLI 命令列表", "session"),
  c("/usage", "查看用量与额度统计", "session"),
  c("/clear", "清空当前对话历史", "session"),
  c("/model", "切换 AI 模型", "model", "[model]"),
  c("/delegate", "将任务委派给远程 Copilot Coding Agent", "skill"),
  c("/cwd", "查看或切换工作目录", "code", "[dir]"),
  c("/add-dir", "允许访问额外本地目录", "code", "<dir>"),
  c("/mcp", "管理 MCP 服务器配置", "code"),
  c("/user", "查看当前登录用户", "model"),
  c("/login", "登录 GitHub Copilot", "model"),
  c("/exit", "退出会话", "session"),
]);

const KIRO_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "查看 Kiro CLI 帮助", "session"),
  c("/usage", "查看额度用量", "session"),
  c("/clear", "清空对话上下文", "session"),
  c("/model", "切换模型", "model"),
  c("/prompts", "查看或调用可用 Prompt", "skill"),
  c("/context", "查看上下文规则与文件", "code"),
  c("/tools", "列出与开关工具", "code"),
  c("/mcp", "管理 MCP Server", "code"),
  c("/quit", "退出", "session"),
]);

const KIMI_COMMANDS: SlashCommandItem[] = withUsage([
  c("/help", "查看 Kimi CLI 命令说明", "session"),
  c("/usage", "查看会话消耗与模型额度", "session"),
  c("/clear", "开启全新对话", "session"),
  c("/compact", "压缩较早上下文", "session"),
  c("/model", "切换 Kimi 模型或思考模式", "model"),
  c("/mcp", "查看与配置 MCP Server", "code"),
  c("/setup", "配置认证与默认环境", "model"),
  c("/yolo", "开关自动批准工具执行", "model"),
  c("/exit", "退出 Kimi CLI", "session"),
]);

const MIMOCODE_MINIMAX_ZCODE_COMMANDS: SlashCommandItem[] = [
  ...CORE_SESSION,
  c("/init", "扫描项目并生成项目规则指引", "code"),
  c("/plan", "先规划任务步骤再开始实施", "code"),
  c("/diff", "查看当前工作区变更", "code"),
  c("/review", "审查代码改动与隐患", "code"),
  c("/skills", "查看已加载的内置与自定义技能", "skill"),
  c("/agents", "管理子智能体任务委派", "skill"),
  c("/mcp", "查看 MCP 服务连接与工具", "code"),
  c("/permissions", "查看与配置执行权限", "model"),
  c("/memory", "查看或刷新会话记忆", "model"),
  c("/exit", "退出会话", "session"),
];

const FACTORY_COMMANDS: SlashCommandItem[] = [
  ...CORE_SESSION,
  c("/compress", "压缩长对话历史", "session"),
  c("/review", "执行 PR / Diff 代码审查", "code"),
  c("/mcp", "管理 MCP 服务", "code"),
  c("/settings", "调整 Droid / Factory 设置", "model"),
  c("/skills", "查看可用 Droid 技能", "skill"),
];

const GENERIC_AGENT_COMMANDS: SlashCommandItem[] = [
  ...CORE_SESSION,
  c("/new", "新建会话", "session"),
  c("/plan", "先规划方案再实施", "code"),
  c("/diff", "查看当前工作区变更", "code"),
  c("/review", "代码审查与总结", "code"),
  c("/mcp", "查看 MCP 服务与工具", "code"),
  c("/skills", "查看已加载技能", "skill"),
  c("/config", "打开设置或查看配置", "model"),
  c("/exit", "退出当前会话", "session"),
];

/** Canonicalize any harness identifier (e.g. `claude-code`, `oh-my-pi`, `agy`) across Uniflo + Herdr. */
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
  if (h.includes("opencode")) return "opencode";
  if (h.includes("kilo")) return "kilo";
  if (h.includes("cursor")) return "cursor";
  if (h.includes("qoder")) return "qoder";
  if (h.includes("qwen")) return "qwen";
  if (h.includes("cline")) return "cline";
  if (h.includes("roo")) return "roo";
  if (h.includes("kodu")) return "kodu";
  if (h.includes("kiro")) return "kiro";
  if (h.includes("kimi")) return "kimi";
  if (h.includes("grok")) return "grok";
  if (h.includes("minimax")) return "minimax";
  if (h.includes("zcode")) return "zcode";
  if (h.includes("mimocode") || h === "mimo") return "mimocode";
  if (h.includes("workbuddy")) return "workbuddy";
  if (h.includes("codebuddy") || h === "cbc") return "codebuddy";
  if (h.includes("copilot")) return "copilot";
  if (h.includes("devin")) return "devin";
  if (h.includes("craft")) return "craft";
  if (h.includes("openclaw")) return "openclaw";
  if (h.includes("hermes")) return "hermes";
  if (h.includes("factory") || h === "droid") return "factory";
  if (h.includes("reasonix")) return "reasonix";
  if (h.includes("commandcode")) return "commandcode";
  if (h.includes("prime")) return "prime";
  if (h.includes("crosery")) return "crosery";
  if (h.includes("aider")) return "aider";
  if (h.includes("goose")) return "goose";
  if (h === "amp" || h.includes("ampcode")) return "amp";
  if (h.includes("crush")) return "crush";
  if (h.includes("iflow")) return "iflow";
  return h;
}

const CATALOG_BY_HARNESS: Record<string, SlashCommandItem[]> = {
  claude: CLAUDE_COMMANDS,
  crosery: CLAUDE_COMMANDS,
  prime: CLAUDE_COMMANDS,
  commandcode: CLAUDE_COMMANDS,
  reasonix: CLAUDE_COMMANDS,
  codex: CODEX_COMMANDS,
  gemini: GEMINI_COMMANDS,
  antigravity: ANTIGRAVITY_COMMANDS,
  dsh: DSH_COMMANDS,
  omp: OMP_COMMANDS,
  pi: PI_COMMANDS,
  opencode: OPENCODE_KILO_COMMANDS,
  kilo: OPENCODE_KILO_COMMANDS,
  crush: OPENCODE_KILO_COMMANDS,
  cursor: CURSOR_COMMANDS,
  qoder: QODER_QWEN_COMMANDS,
  qwen: QODER_QWEN_COMMANDS,
  iflow: QODER_QWEN_COMMANDS,
  workbuddy: CODEBUDDY_COMMANDS,
  codebuddy: CODEBUDDY_COMMANDS,
  hermes: HERMES_COMMANDS,
  grok: GROK_COMMANDS,
  mimocode: MIMOCODE_MINIMAX_ZCODE_COMMANDS,
  minimax: MIMOCODE_MINIMAX_ZCODE_COMMANDS,
  zcode: MIMOCODE_MINIMAX_ZCODE_COMMANDS,
  cline: CLINE_ROO_COMMANDS,
  roo: CLINE_ROO_COMMANDS,
  kodu: CLINE_ROO_COMMANDS,
  aider: AIDER_COMMANDS,
  goose: GOOSE_COMMANDS,
  amp: AMP_COMMANDS,
  copilot: COPILOT_COMMANDS,
  kiro: KIRO_COMMANDS,
  kimi: KIMI_COMMANDS,
  factory: FACTORY_COMMANDS,
  devin: GENERIC_AGENT_COMMANDS,
  craft: GENERIC_AGENT_COMMANDS,
  openclaw: GENERIC_AGENT_COMMANDS,
};

export function builtinSlashCommands(harness: string, isShell = false): SlashCommandItem[] {
  if (isShell) return [];
  const canonical = canonicalHarnessId(harness);
  return CATALOG_BY_HARNESS[canonical] ?? GENERIC_AGENT_COMMANDS;
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
  "release-notes": "help",
  hotkeys: "keyboard",
  keybindings: "keyboard",
  vim: "keyboard",
  "vim-mode": "keyboard",
  multiline: "keyboard",
  status: "status",
  "session-info": "status",
  info: "status",
  doctor: "status",
  diagnose: "status",
  debug: "status",
  trace: "status",
  activity: "status",
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
  "compact-mode": "compact",
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
  pin: "history",
  unpin: "history",
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
  snapshot: "branch",
  export: "share",
  save: "share",
  share: "share",
  copy: "share",
  dump: "share",
  collab: "share",
  rename: "share",
  title: "share",
  quit: "exit",
  exit: "exit",
  logout: "exit",
  leave: "exit",
  stop: "exit",
  model: "model",
  models: "model",
  modelpreset: "model",
  agent: "model",
  mode: "model",
  preset: "model",
  personality: "model",
  provider: "model",
  providers: "model",
  fast: "speed",
  slow: "speed",
  effort: "speed",
  reasoning: "speed",
  thinking: "speed",
  prewalk: "speed",
  advisor: "speed",
  vibe: "speed",
  moa: "speed",
  permissions: "shield",
  approvals: "shield",
  approve: "shield",
  sandbox: "shield",
  yolo: "shield",
  auto: "shield",
  "always-approve": "shield",
  privacy: "shield",
  memory: "memory",
  remember: "memory",
  dream: "memory",
  flush: "memory",
  rules: "memory",
  newrule: "memory",
  init: "memory",
  omfg: "memory",
  login: "auth",
  auth: "auth",
  user: "auth",
  whoami: "auth",
  setup: "auth",
  config: "settings",
  settings: "settings",
  theme: "settings",
  themes: "settings",
  skin: "settings",
  color: "settings",
  lang: "settings",
  hooks: "settings",
  plugins: "settings",
  plugin: "settings",
  extensions: "settings",
  marketplace: "settings",
  reload: "settings",
  commands: "settings",
  plan: "plan",
  "plan-review": "plan",
  "view-plan": "plan",
  architect: "plan",
  ultraplan: "plan",
  ask: "plan",
  code: "plan",
  review: "review",
  ultrareview: "review",
  "security-review": "review",
  "review-changes": "review",
  "code-review": "review",
  "pr-comments": "review",
  "autofix-pr": "review",
  cleanse: "review",
  diff: "git",
  git: "git",
  commit: "git",
  mcp: "mcp",
  mcps: "mcp",
  "reload-mcp": "mcp",
  tools: "mcp",
  toolsets: "mcp",
  ide: "mcp",
  gateway: "mcp",
  "remote-control": "mcp",
  ssh: "mcp",
  connect: "mcp",
  browser: "browser",
  chrome: "browser",
  web: "browser",
  open: "browser",
  computer: "browser",
  live: "browser",
  voice: "browser",
  schedule: "schedule",
  loop: "schedule",
  cron: "schedule",
  heartbeat: "schedule",
  queue: "schedule",
  steer: "schedule",
  retry: "schedule",
  add: "workspace",
  "read-only": "workspace",
  drop: "workspace",
  ls: "workspace",
  "add-dir": "workspace",
  "remove-dir": "workspace",
  cwd: "workspace",
  move: "workspace",
  workspace: "workspace",
  test: "workspace",
  lint: "workspace",
  editor: "workspace",
  goal: "goal",
  "guided-goal": "goal",
  subgoal: "goal",
  ratchet: "goal",
  agents: "agents",
  subagent: "agents",
  subagents: "agents",
  hub: "agents",
  team: "agents",
  teamwork: "agents",
  delegate: "agents",
  background: "agents",
  bg: "agents",
  btw: "agents",
  tan: "agents",
  tasks: "agents",
  todos: "agents",
  kanban: "agents",
  "config-agents": "agents",
  personas: "agents",
  skills: "skill",
  skill: "skill",
  "reload-skills": "skill",
  bundles: "skill",
  boost: "skill",
  "grill-me": "skill",
  learn: "skill",
  refine: "skill",
  workflow: "skill",
  workflows: "skill",
  "deep-research": "skill",
  prompts: "skill",
  t: "skill",
};

/** Maps a slash command to a functional semantic icon kind (never one generic placeholder). */
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

/**
 * Extracts the active slash command query when typing at the beginning of the composer.
 * Stops matching once a whitespace separates the command from arguments (e.g. `/model gpt-5`).
 */
export function extractSlashQuery(text: string): string | null {
  const trimmedLeft = text.replace(/^[ \t]+/, "");
  if (!trimmedLeft.startsWith("/")) return null;
  if (/\s/.test(trimmedLeft)) return null;
  return trimmedLeft.slice(1).toLowerCase();
}

export const BUILTIN_SLASH: readonly SlashCommandItem[] = (() => {
  const byName = new Map<string, SlashCommandItem>();
  const all = [
    ...CORE_SESSION,
    ...CLAUDE_COMMANDS,
    ...OMP_COMMANDS,
    ...ANTIGRAVITY_COMMANDS,
    ...CODEX_COMMANDS,
    ...GEMINI_COMMANDS,
    ...DSH_COMMANDS,
    ...HERMES_COMMANDS,
    ...GROK_COMMANDS,
    ...CODEBUDDY_COMMANDS,
    ...PI_COMMANDS,
    ...OPENCODE_KILO_COMMANDS,
    ...CURSOR_COMMANDS,
    ...QODER_QWEN_COMMANDS,
    ...CLINE_ROO_COMMANDS,
    ...AIDER_COMMANDS,
    ...GOOSE_COMMANDS,
    ...AMP_COMMANDS,
    ...COPILOT_COMMANDS,
    ...KIRO_COMMANDS,
    ...KIMI_COMMANDS,
    ...MIMOCODE_MINIMAX_ZCODE_COMMANDS,
    ...FACTORY_COMMANDS,
    ...GENERIC_AGENT_COMMANDS,
  ];
  for (const item of all) {
    const k = item.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, item);
  }
  return [...byName.values()];
})();

export interface LeadingSlashToken {
  command: SlashCommandItem;
  rawToken: string;
  rest: string;
}

const LEADING_SLASH_RE = /^[ \t]*(\/[A-Za-z0-9][A-Za-z0-9_.:-]*)(?:\r?\n|[ \t])([\s\S]*)$/;

/**
 * Recognizes when composer text starts with `<slashCmd> ` or `<slashCmd>\n`
 * (e.g. `/btw `, `/dev `, `/commit `, `/review `) matching `knownCommands`
 * or `BUILTIN_SLASH` / `/skills...` fallback, returning the matched item and trailing `rest`.
 */
export function parseLeadingSlashToken(
  text: string,
  knownCommands: readonly SlashCommandItem[] = [],
): LeadingSlashToken | null {
  const m = LEADING_SLASH_RE.exec(text);
  if (!m) return null;
  const rawToken = m[1]!;
  const rest = m[2] ?? "";
  const lower = rawToken.toLowerCase();

  const fromKnown = knownCommands.find((item) => item.name.toLowerCase() === lower);
  if (fromKnown) return { command: fromKnown, rawToken, rest };

  const fromBuiltin = BUILTIN_SLASH.find((item) => item.name.toLowerCase() === lower);
  if (fromBuiltin) return { command: fromBuiltin, rawToken, rest };

  if (/^\/skills?(?::[a-z0-9_.:-]+)?$/i.test(rawToken)) {
    return {
      command: {
        name: rawToken,
        description: "调用或管理 Agent 技能",
        category: "skill",
        source: "user",
      },
      rawToken,
      rest,
    };
  }

  return null;
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
