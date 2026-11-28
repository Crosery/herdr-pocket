import { useEffect, useState, type CSSProperties } from "react";
import {
  BookOpen,
  Database,
  FolderSearch,
  Globe,
  MousePointerClick,
  Plus,
  Terminal,
  Trash2,
  Webhook,
} from "lucide-react";
import type { AssistantPluginId, AssistantWebhookTool, PocketPluginId } from "@herdr-pocket/protocol";
import { PocketBadge, PocketButton, PocketCard, PocketInput, PocketSwitch, useToast } from "../../components/PocketUI";
import {
  assistantStore,
  loadAssistantSettings,
  resolveAssistantPlugins,
  updateAssistantSettings,
} from "../../lib/assistant";
import { localHostIdStore } from "../../lib/fonts";
import { setConfig, useClientConfig } from "../../lib/config";
import { liveStore, settingsStore } from "../../lib/store";
import { closeSettingsFrame, openAiBrowserTab } from "../../shell/shellStore";
import { PaneTitle, SetHeading, SetRow } from "./rows";

const TAG_STYLE: CSSProperties = {
  fontSize: "calc(11px * var(--ts, 1))",
  color: "var(--muted)",
  background: "var(--surface-2)",
  border: "1px solid var(--divider)",
  borderRadius: 5,
  padding: "1px 6px",
  lineHeight: 1.45,
};

const XIAOYANG_PLUGINS: Array<{
  id: AssistantPluginId;
  title: string;
  about: string;
  tags: string[];
  icon: typeof Globe;
}> = [
  {
    id: "herdr",
    title: "Herdr",
    about: "空间、终端与会话管理",
    tags: ["list_agents", "herdr_do", "+11"],
    icon: Terminal,
  },
  {
    id: "uniflo",
    title: "Uniflo",
    about: "会话历史、检索与用量查询",
    tags: ["search_sessions", "usage", "+3"],
    icon: Database,
  },
  {
    id: "browser",
    title: "AI 浏览器操作",
    about: "网页浏览、操作与接口抓包",
    tags: ["browser_act", "browser_run", "browser_net"],
    icon: MousePointerClick,
  },
  {
    id: "workspace",
    title: "代码与 Git",
    about: "文件读取、搜索与 Git 状态",
    tags: ["inspect_workspace"],
    icon: FolderSearch,
  },
  {
    id: "webfetch",
    title: "网页阅读",
    about: "抓取公开网页并提取正文",
    tags: ["fetch_webpage"],
    icon: BookOpen,
  },
  {
    id: "webhooks",
    title: "Webhook",
    about: "通知外部服务",
    tags: ["webhook_*"],
    icon: Webhook,
  },
];

const POCKET_PLUGINS: Array<{
  id: PocketPluginId;
  title: string;
  categoryLabel: string;
  cli: string;
  about: string;
  icon: typeof Globe;
}> = [
  {
    id: "ai-browser",
    title: "AI 浏览器",
    categoryLabel: "操作流",
    cli: "herdr-pocket browser",
    about: "内置跨平台浏览器，提供页面操作流、主标签画面与接口抓包",
    icon: Globe,
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

  const plugins = resolveAssistantPlugins(assistantSettings.plugins);
  const webhooks = assistantSettings.webhooks ?? [];

  const toggleAiBrowser = async (next: boolean) => {
    setSavingKey("ai-browser");
    try {
      await setConfig("plugins.aiBrowser", next);
      toast(next ? "已启用 AI 浏览器" : "已关闭 AI 浏览器");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSavingKey(null);
    }
  };

  const handleOpenAiBrowser = () => {
    const localId = localHostIdStore.get();
    const devs = liveStore.get().devices;
    const hostId =
      (localId && devs[localId]?.online ? localId : "") ||
      Object.values(devs).find((d) => d.kind === "host" && d.online)?.id ||
      Object.values(devs).find((d) => d.kind === "host")?.id ||
      "";
    if (!hostId) {
      toast("请先连接至少一台主机或进入演示模式", true);
      return;
    }
    closeSettingsFrame();
    openAiBrowserTab(hostId, "ai-1", "AI 浏览器", { focus: true });
  };

  const toggleAssistantPlugin = async (id: AssistantPluginId, next: boolean) => {
    if (!server) {
      toast("请先连接中继或进入演示模式", true);
      return;
    }
    setSavingKey(id);
    try {
      await updateAssistantSettings({ plugins: { ...plugins, [id]: next } });
      toast(next ? "已启用插件" : "已关闭插件");
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
      toast("请填写名称与 HTTP/HTTPS URL", true);
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
      toast(`已添加「${name}」`);
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
      toast("已移除 Webhook");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div className="pane">
      <PaneTitle title="插件中心" />

      <SetHeading>小羊助理插件</SetHeading>
      {!server ? (
        <div className="faint" style={{ padding: "4px 0 8px" }}>
          连接中继或进入演示模式后可调整小羊插件开关。
        </div>
      ) : null}

      {XIAOYANG_PLUGINS.map((item) => {
        const Icon = item.icon;
        const checked = plugins[item.id];
        return (
          <SetRow
            key={item.id}
            title={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
                <Icon size={15} style={{ color: "var(--primary)", flex: "none" }} />
                <span>{item.title}</span>
                {item.tags.map((tag) => (
                  <code key={tag} className="mono" style={TAG_STYLE}>
                    {tag}
                  </code>
                ))}
              </span>
            }
            about={
              item.id === "browser" && checked && !cfg.plugins.aiBrowser ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span>{item.about}</span>
                  <span style={{ color: "var(--blush-text)", fontWeight: 600 }}>
                    需同时开启下方「AI 浏览器」插件。
                  </span>
                </div>
              ) : (
                item.about
              )
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
            <span style={{ fontSize: "calc(12.5px * var(--ts, 1))", fontWeight: 600, color: "var(--ink)" }}>
              Webhook 列表（{webhooks.length}/16）
            </span>
            <PocketButton size="sm" variant="soft" onClick={() => setAddingHook((v) => !v)}>
              <Plus size={13} />
              <span>{addingHook ? "收起" : "新增 Webhook"}</span>
            </PocketButton>
          </div>

          {addingHook ? (
            <PocketCard>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <PocketInput
                  value={hookName}
                  onChange={(e) => setHookName(e.target.value)}
                  placeholder="名称（如：触发部署）"
                />
                <PocketInput
                  value={hookDesc}
                  onChange={(e) => setHookDesc(e.target.value)}
                  placeholder="用途说明（可选）"
                />
                <PocketInput
                  value={hookUrl}
                  onChange={(e) => setHookUrl(e.target.value)}
                  placeholder="https://hooks.example.com/trigger"
                  spellCheck={false}
                />
                <PocketInput
                  value={hookSecret}
                  onChange={(e) => setHookSecret(e.target.value)}
                  placeholder="X-Webhook-Secret（可选）"
                  spellCheck={false}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <PocketButton size="sm" variant="ghost" onClick={() => setAddingHook(false)}>
                    取消
                  </PocketButton>
                  <PocketButton
                    size="sm"
                    variant="primary"
                    disabled={savingKey === "webhooks"}
                    onClick={() => void addWebhook()}
                  >
                    保存
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
                    <code className="mono" style={TAG_STYLE}>
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

      <SetHeading>Herdr Pocket 插件</SetHeading>
      {POCKET_PLUGINS.map((item) => {
        const Icon = item.icon;
        const checked = cfg.plugins.aiBrowser;
        return (
          <SetRow
            key={item.id}
            title={
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
                <Icon size={15} style={{ color: "var(--primary)", flex: "none" }} />
                <span>{item.title}</span>
                <PocketBadge tone="lav">{item.categoryLabel}</PocketBadge>
                <code className="mono" style={TAG_STYLE}>
                  {item.cli}
                </code>
              </span>
            }
            about={item.about}
          >
            <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              {checked ? (
                <PocketButton size="sm" variant="soft" onClick={handleOpenAiBrowser}>
                  打开标签
                </PocketButton>
              ) : null}
              <PocketSwitch
                checked={checked}
                disabled={savingKey === item.id}
                label={item.title}
                onCheckedChange={(v) => void toggleAiBrowser(v)}
              />
            </div>
          </SetRow>
        );
      })}
    </div>
  );
}
