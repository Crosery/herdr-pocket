# Herdr Pocket 插件规范

所有插件按「**一个插件一个文件夹**」组织在仓库根目录 `plugins/` 下，遵循同一套模板（`plugins/_template/`）。

## 目录结构

```text
plugins/
├── _template/                  # 新增插件的标准模板
│   ├── manifest.json           # 插件清单（必填）
│   ├── README.md               # 功能与接口说明（必填）
│   └── index.ts                # 插件定义导出（必填）
├── assistant/                  # 小羊助理插件（Tools 工具包）
│   ├── herdr/                  # Herdr 空间、标签与终端工具包（默认开启）
│   ├── uniflo/                 # Uniflo 会话检索与用量工具包（默认开启）
│   ├── browser/                # AI 浏览器工具包（browser_act / browser_run / browser_net）
│   ├── workspace/              # 代码与 Git 只读巡检（inspect_workspace）
│   ├── webfetch/               # 公开网页阅读（fetch_webpage）
│   └── webhooks/               # 自定义 Webhook 工具（webhook_*）
├── pocket/                     # Herdr Pocket 插件（CLI 与操作流扩展）
│   └── ai-browser/             # 操作流 · AI 浏览器（开启后激活 herdr-pocket browser）
└── registry.ts                 # 统一插件注册表
```

## 插件分类

1. **小羊助理插件（`scope: "assistant"`，`category: "tools"`）**
   - 凡是让小羊访问外部工具/系统的能力均作为插件管理，核心产物是一组 `tools` 接口。
   - 如 `herdr` 提供空间/标签/终端管理接口，`uniflo` 提供历史会话搜索与用量接口。
2. **Herdr Pocket 插件（`scope: "pocket"`，`category: "cli" | "workflow"`）**
   - 给本机与所有 Agent 提供的扩展能力，开启后直接在 `herdr-pocket` CLI 中可用。
   - 操作流类插件（如 `ai-browser`）标记为 `category: "workflow"`，后续可按同一模板继续扩展更多操作流插件。

## `manifest.json` 必填字段

```json
{
  "id": "my-plugin",
  "scope": "assistant",
  "category": "tools",
  "name": "插件名称",
  "summary": "一句话说明功能",
  "defaultEnabled": false,
  "tools": ["tool_name_1", "tool_name_2"],
  "icon": "blocks"
}
```

- `pocket` 插件需声明 `configKey`（如 `"plugins.aiBrowser"`）和 `cli`（如 `["herdr-pocket browser"]`）。
- 图标名对应桌面端 `lucide-react` / 移动端矢量图标，不使用 Emoji。

## 新增插件步骤

1. 复制 `plugins/_template/` 到 `plugins/assistant/<id>/` 或 `plugins/pocket/<id>/`。
2. 填写 `manifest.json`、`README.md` 与 `index.ts`。
3. 在 `packages/protocol/src/index.ts` 添加 ID 类型，并在 `plugins/registry.ts` 注册；运行单测验证目录规范与清单一致性。
