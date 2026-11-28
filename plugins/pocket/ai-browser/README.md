# AI 浏览器（操作流插件）

Herdr Pocket 首个内置操作流插件。开启后默认在 CLI 中启用 `herdr-pocket browser` 命令组，供本机所有 Agent 调用，并在工作区主标签栏实时展示画面与网络抓包。

## CLI

- `herdr-pocket browser run`：执行多步操作流脚本
- `herdr-pocket browser open | snapshot | click | fill | press`：单步页面操作
- `herdr-pocket browser net list | body | wait | clear`：HTTP 请求与响应体抓包
- `herdr-pocket browser doctor`：检查跨平台 Chromium 引擎状态
