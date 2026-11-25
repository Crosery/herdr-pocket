import { useEffect, useState } from "react";
import { Blocks, FolderSearch, Globe, Plus, ShieldCheck, Sparkles, Trash2, Webhook } from "lucide-react";
import type { AssistantPluginId, AssistantWebhookTool } from "@herdr-pocket/protocol";
import { PocketBadge, PocketButton, PocketCard, PocketInput, PocketSwitch, useToast } from "../../components/PocketUI";
import { assistantStore, loadAssistantSettings, updateAssistantSettings } from "../../lib/assistant";
import { isTauri } from "../../lib/bridge";
import { setConfig, useClientConfig } from "../../lib/config";
import { settingsStore } from "../../lib/store";
import { PaneTitle, SetHeading, SetRow } from "./rows";

const XIAOYANG_PLUGINS: Array<{
  id: AssistantPluginId;
  title: string;
  toolName: string;
  about: string;
  icon: typeof Globe;
}> = [
  {
    id: "browser",
    title: "小羊网页协作",
    toolName: "browser_act",
    about: "允许小羊在你的 AI 浏览空间打开网页、读取结构化 @ref 并演示点击；登录、密码或验证码会自动停下交还给你。",
    icon: Globe,
  },
  {
    id: "workspace",
    title: "代码与 Git 只读巡检",
    toolName: "inspect_workspace",
    about: "无需开启完整对话终端即可只读查看仓库 Git 状态、差异与文件内容（单次最多读取 8 KB）。",
    icon: FolderSearch,
  },
  {
    id: "webfetch",
    title: "公开网页查阅",
    toolName: "fetch_webpage",
    about: "抓取公开 HTTP/HTTPS 网页正文供小羊阅读参考，内置 SSRF 阻断（禁止访问本机与内网地址）。",
    icon: Sparkles,
  },
  {
    id: "webhooks",
    title: "自定义 Webhook 工具桥接",
    toolName: "webhook_*",
    about: "将你自己的 HTTP POST 自动化端点以零依赖工具的形式接入小羊（开启“动手前先问”时需你确认）。",
    icon: Webhook,
  },
];

function slugifyHookId(raw: string, existing: AssistantWebhookTool[]): string {
  const base =
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "hook";
  const taken = new Set(existing.map((h) => h.id));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base.slice(0, 20)}_${i}`)) i += 1;
  return `${base.slice(0, 20)}_${i}`;
}

/**
 * Plugin Center (`插件中心`): all optional plugins are disabled by default (zero bloat,
 * zero external dependencies) and appear only when the user chooses to enable them.
 */
export function PluginsPane() {
  const toast = useToast();
  const cfg = useClientConfig();
  const server = settingsStore.use((s) => s.server);
  const assistantSettings = assistantStore.use((s) => s.settings);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [addingHook, setAddingHook] = useState(false);
  const [hookName, setHookName] = useState("");
  const [hookDesc, setHookDesc] = useState("");
  const [hookUrl, setHookUrl] = useState("");
  const [hookSecret, setHookSecret] = useState("");

  useEffect(() => {
    if (!server) return;
    void loadAssistantSettings().catch(() => undefined);
  }, [server]);

  const plugins = assistantSettings.plugins ?? {};
  const webhooks = assistantSettings.webhooks ?? [];
  const enabledCount =
    (cfg.plugins.aiBrowser ? 1 : 0) +
    Object.values(plugins).filter(Boolean).length;

  const toggleAiBrowser = async (next: boolean) => {
    setSavingKey("aiBrowser");
    try {
      await setConfig("plugins.aiBrowser", next);
      toast(next ? "已启用本机 AI 浏览器协作插件" : "已关闭 AI 浏览器协作插件");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSavingKey(null);
    }
  };

  const toggleAssistantPlugin = async (id: AssistantPluginId, next: boolean) => {
    if (!server) {
      toast("请先连接中继或进入演示模式再调整小羊插件", true);
      return;
    }
    setSavingKey(id);
    try {
      await updateAssistantSettings({ plugins: { ...plugins, [id]: next } });
      toast(next ? "已启用小羊插件" : "已关闭小羊插件");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSavingKey(null);
    }
  };

  const addWebhook = async () => {
    const name = hookName.trim();
    const url = hookUrl.trim();
    if (!name || !url) {
      toast("请填写 Webhook 名称与公开 HTTPS/HTTP URL", true);
      return;
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("URL 必须以 http:// 或 https:// 开头");
      }
    } catch (e) {
      toast((e as Error).message || "URL 格式不正确", true);
      return;
    }
    setSavingKey("webhooks");
    try {
      const next: AssistantWebhookTool[] = [
        ...webhooks,
        {
          id: slugifyHookId(name, webhooks),
          name,
          description: hookDesc.trim() || `调用自定义 Webhook「${name}」`,
          url,
          ...(hookSecret.trim() ? { secretHeader: hookSecret.trim() } : {}),
        },
      ];
      await updateAssistantSettings({
        plugins: { ...plugins, webhooks: true },
        webhooks: next,
      });
      setHookName("");
      setHookDesc("");
      setHookUrl("");
      setHookSecret("");
      setAddingHook(false);
      toast(`已添加工具「${name}」`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSavingKey(null);
    }
  };

  const removeWebhook = async (id: string) => {
    setSavingKey(`rm-${id}`);
    try {
      const next = webhooks.filter((w) => w.id !== id);
      await updateAssistantSettings({ webhooks: next });
      toast("已移除 Webhook 工具");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div className="pane">
      <PaneTitle
        title="插件中心"
        about="按需开启 · 默认全部关闭 · 零外部依赖；未启用时零后台驻留、零额外上下文占用"
      />

      <PocketCard className="plugins-hero-card">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--accent-soft)",
                color: "var(--primary)",
                flex: "none",
              }}
            >
              <Blocks size={18} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: "calc(13.5px * var(--ts, 1))", color: "var(--ink)" }}>
                零负担可选能力扩展
              </div>
              <div style={{ fontSize: "calc(12px * var(--ts, 1))", color: "var(--muted)", marginTop: 2 }}>
                不要求安装 Playwright/Puppeteer 等三方包；只在你明确启用后才注册对应桥接与工具。
              </div>
            </div>
          </div>
          <PocketBadge tone={enabledCount > 0 ? "pink" : "neutral"}>
            已启用 {enabledCount} / 5
          </PocketBadge>
        </div>
      </PocketCard>

      <SetHeading>本机桌面与内置浏览器插件</SetHeading>
      <SetRow
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span>AI 浏览器协作与虚拟光标</span>
            <PocketBadge tone="lav">本机内置</PocketBadge>
          </span>
        }
        about={
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span>
              启用后在侧边内置浏览器开启 AI 空间隔离、@ref 页面结构快照、粉色虚拟光标指示与“我来接管 / 交还 AI”状态栏。关闭时不监听任何本地端口、不注入页面脚本。
            </span>
            {isTauri() ? (
              <code
                className="mono"
                style={{
                  display: "block",
                  padding: "6px 10px",
                  borderRadius: 8,
                  background: "var(--surface-2)",
                  border: "1px solid var(--divider)",
                  fontSize: "calc(11.5px * var(--ts, 1))",
                  color: "var(--ink)",
                }}
              >
                herdr-pocket browser open https://example.com · herdr-pocket browser snapshot
              </code>
            ) : null}
          </div>
        }
      >
        <PocketSwitch
          checked={cfg.plugins.aiBrowser}
          disabled={savingKey === "aiBrowser"}
          label="AI 浏览器协作与虚拟光标"
          onCheckedChange={(v) => void toggleAiBrowser(v)}
        />
      </SetRow>

      <SetHeading>小羊助理工具插件（跨端同步）</SetHeading>
      {!server ? (
        <div className="faint" style={{ padding: "8px 0 12px" }}>
          连接中继或进入演示模式后，即可管理跨设备共享的小羊助理插件开关。
        </div>
      ) : null}

      {XIAOYANG_PLUGINS.map((item) => {
        const Icon = item.icon;
        const checked = Boolean(plugins[item.id]);
        return (
          <SetRow
            key={item.id}
            title={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Icon size={14} style={{ color: "var(--primary)", flex: "none" }} />
                <span>{item.title}</span>
                <code className="mono" style={{ fontSize: "calc(11px * var(--ts, 1))", color: "var(--muted)" }}>
                  {item.toolName}
                </code>
              </span>
            }
            about={
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>{item.about}</span>
                {item.id === "browser" && checked && !cfg.plugins.aiBrowser ? (
                  <span style={{ color: "var(--blush-text)", fontWeight: 600 }}>
                    提示：当前这台电脑的「AI 浏览器协作与虚拟光标」仍处于关闭状态，请在上方同步开启。
                  </span>
                ) : null}
              </div>
            }
          >
            <PocketSwitch
              checked={checked}
              disabled={!server || savingKey === item.id}
              label={item.title}
              onCheckedChange={(v) => void toggleAssistantPlugin(item.id, v)}
            />
          </SetRow>
        );
      })}

      {(plugins.webhooks || webhooks.length > 0) && server ? (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: "calc(12.5px * var(--ts, 1))", fontWeight: 600, color: "var(--ink)", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <ShieldCheck size={14} style={{ color: "var(--primary)" }} />
              已配置的 Webhook 工具（{webhooks.length}/16）
            </span>
            <PocketButton size="sm" variant="soft" onClick={() => setAddingHook((v) => !v)}>
              <Plus size={13} />
              <span>{addingHook ? "收起表单" : "新增 Webhook"}</span>
            </PocketButton>
          </div>

          {addingHook ? (
            <PocketCard>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <PocketInput
                  value={hookName}
                  onChange={(e) => setHookName(e.target.value)}
                  placeholder="工具名称（例如：触发测试部署 / 写入 Notion 日报）"
                />
                <PocketInput
                  value={hookDesc}
                  onChange={(e) => setHookDesc(e.target.value)}
                  placeholder="工具说明（告诉小羊什么时候应该调用它）"
                />
                <PocketInput
                  value={hookUrl}
                  onChange={(e) => setHookUrl(e.target.value)}
                  placeholder="公开地址（例如：https://hooks.example.com/trigger）"
                  spellCheck={false}
                />
                <PocketInput
                  value={hookSecret}
                  onChange={(e) => setHookSecret(e.target.value)}
                  placeholder="X-Webhook-Secret 请求头密钥（可选，服务端脱敏保存）"
                  spellCheck={false}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <PocketButton size="sm" variant="ghost" onClick={() => setAddingHook(false)}>
                    取消
                  </PocketButton>
                  <PocketButton size="sm" variant="primary" disabled={savingKey === "webhooks"} onClick={() => void addWebhook()}>
                    保存工具
                  </PocketButton>
                </div>
              </div>
            </PocketCard>
          ) : null}

          {webhooks.map((w) => (
            <PocketCard key={w.id}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <strong style={{ color: "var(--ink)", fontSize: "calc(13px * var(--ts, 1))" }}>{w.name}</strong>
                    <code className="mono" style={{ fontSize: "calc(11px * var(--ts, 1))", color: "var(--muted)" }}>
                      webhook_{w.id}
                    </code>
                    {w.secretHeader ? <PocketBadge tone="mint">已设密钥</PocketBadge> : null}
                  </div>
                  <div style={{ fontSize: "calc(12px * var(--ts, 1))", color: "var(--muted)" }}>{w.description}</div>
                  <div className="mono truncate" style={{ fontSize: "calc(11.5px * var(--ts, 1))", color: "var(--faint)" }}>
                    {w.url}
                  </div>
                </div>
                <PocketButton
                  size="sm"
                  variant="ghost"
                  aria-label={`移除 ${w.name}`}
                  disabled={savingKey === `rm-${w.id}`}
                  onClick={() => void removeWebhook(w.id)}
                >
                  <Trash2 size={14} />
                </PocketButton>
              </div>
            </PocketCard>
          ))}
        </div>
      ) : null}
    </div>
  );
}
