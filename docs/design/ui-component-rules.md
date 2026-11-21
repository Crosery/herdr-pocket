# UI 组件与视觉一致性强制规范

范围：`apps/desktop`（macOS / Windows / Linux 及 `build:harmony` 产出的鸿蒙 NEXT 网页包）与 `apps/mobile`（Android / iOS）。
目标：所有交互控件、弹窗、色彩、字体缩放、排版与图标在所有端上保持一致的 Pocket 视觉语言，禁止暴露 WebView / 浏览器原生 OS 控件样式。

---

## 1. 表单与交互原语映射（强制）

| 场景 | Desktop 必须使用 | Mobile 必须使用 | 严禁使用 |
|------|------------------|-----------------|----------|
| 下拉选择 / 切换器 | `PocketSelect`（`apps/desktop/src/components/PocketUI.tsx` 封装 `@radix-ui/react-select`）：常规表单用 `size="md"`（38px），侧栏/工具栏（如 `GitPanel`、`WorkbenchView`）用 `size="sm"`（29px） | 自定义 `Pressable` + `PocketSheet` / 底部弹层列表 | 原生 `<select>`、`<option>`（WKWebView / WebView2 会渲染系统立体边框与蓝色焦点环） |
| 复选框（多选 / 列表勾选） | `PocketCheckbox`（`role="checkbox"`，`16×16px` 粉色勾选框） | 自定义 `Pressable` 勾选块 | 原生 `<input type="checkbox">` |
| 二元即时开关 | `PocketSwitch`（`@radix-ui/react-switch`） | 自定义主题开关 / `Switch` 封装 | 原生 `<input type="checkbox">`、`role="switch"` 裸标签 |
| 单行 / 多行文本输入 | `PocketInput`、`PocketTextarea` 或已定义样式的输入容器（`.pk-input`、`.pk-textarea`、`.composer-input-wrap`、`.palette-input`，须带 `appearance: none`） | 主题化 `RNTextInput` | 未设样式的裸 `<input>`、`<textarea>`、`<input type="radio" \| "range" \| "color" \| "date">` |
| 文件选择触发 | `<input type="file" style={{ display: "none" }} />`（唯一允许保留的原生 `<input>`，禁止可见） | 系统文档/相册选择器 | 可见原生文件选择框 |
| 弹窗 / 确认对话框 | `PocketModal`（`@radix-ui/react-dialog`，自动联动 `overlayStore` 隐藏原生嵌层）或内联 `.inline-alert` 确认条 | `Modal` / `ConfirmSheet` | `window.confirm`、`window.alert`、`window.prompt`、裸 `<dialog>` |
| 按钮 / 分段切换 | `PocketButton`、`PocketIconButton`、`.segmented`、`.v3-icon-btn`、`.v3-panel-btn`、`.v3-mode-btn` | `ActionButton`、`IconTile`、`Segmented` | 浏览器默认灰底 `<button>` |

- 新建或改造弹窗/下拉层时，必须确保与原生浏览器 WebView 互斥隐藏：弹窗使用 `PocketModal`，高优先级浮层使用 `z-index` 分层并通过 `overlayStore` 管理遮挡。

---

## 2. 色彩令牌与明暗双主题

- 所有前景、背景、边框、焦点与状态色必须引用设计令牌，禁止硬编码纯白 `#fff` / 纯黑 `#000` 表面底色或浏览器默认系统蓝焦点框：
  - 页面与铬框底色：`--page`
  - 卡片 / 窗格 / 浮层底色：`--surface`、`--surface-2`
  - 分割线与描边：`--divider`、`--line-pink`
  - 文字层级：`--ink`、`--muted`、`--faint`
  - 主题主色与交互反馈：`--primary`、`--accent-soft`、`--accent-text`、`--ring-focus`
- 任何新增组件或弹窗，交付前必须在**浅色模式**与**暗色模式**下检查对比度、描边和选中态。

---

## 3. 字号缩放、等宽排版与溢出保护

- 动态正文与组件内文本字号使用 `calc(Npx * var(--ts, 1))` 或 `fs(N)`；v3 窗口固定骨架尺寸遵循 [desktop-v2.md](desktop-v2.md)。
- 路径、仓库/分支名、Commit Hash、Token / 费用数字、命令名与快捷键标签使用 `.mono`（等宽字体）。
- 弹性布局（Flex）内承载可变长度文字的子节点必须同时具备 `min-width: 0` 与 `.truncate`（单行省略）或 `overflow-wrap: anywhere`（多行折行）。
- 使用 `table-layout: fixed` 的表格必须显式声明 `<colgroup>` 与列宽，禁止依赖首行跨列单元格推断列宽。

---

## 4. 语义图标分类与无 Emoji 规范

- 界面按钮、标签、徽章、空状态与提示文案严格**不使用任何 Emoji**；桌面端统一使用 `lucide-react`，移动端统一使用 `@expo/vector-icons` / 矢量 SVG 与 `XiaoyangOrb`。
- 命令面板、斜杠命令弹层、工具栏或操作列表中的每一行必须按**功能语义**匹配对应图标，并用软底色徽章区分所属分类（会话、模型与设置、代码与工具、技能、自定义），禁止所有条目共用同一个占位图标。

---

## 5. 自动化守卫与多端验收门槛

- **单测守卫**：`apps/desktop/test/uiGuardrails.test.ts` 在每次 `pnpm --dir apps/desktop test` 运行时扫描 `apps/desktop/src/**/*.{ts,tsx}`，阻断 `<select>`、`<option>`、`<input type="checkbox|radio|range|color|date">` 与 `window.confirm/alert/prompt`。
- **多端一致**：UI 改动需同步考虑桌面端、鸿蒙 NEXT（`pnpm --dir apps/desktop build:harmony`）与移动端（`apps/mobile`），并在浏览器/模拟器中完成真实渲染截图核验，再签名打包发布。
