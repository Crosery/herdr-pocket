import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Text } from "react-native-paper";
import { Stack } from "expo-router";
import type { AssistantPluginId, AssistantWebhookTool, PocketPluginId } from "@herdr-pocket/protocol";
import { Card, PageBackground, SectionHeader } from "../../components/ui";
import { Row, RowDivider, Toggle, type RowIcon } from "../../components/rows";
import { ConfigSnackbar, Field, Input, Pill } from "../../components/configParts";
import { PocketButton, RowAction } from "../../components/pocket";
import { loadAssistant, updateAssistantPlugins, useAssistant } from "../../lib/assistant";
import { usePalette } from "../../theme/theme";
import { fonts, space } from "../../theme/tokens";

const XIAOYANG_PLUGINS: Array<{
  id: AssistantPluginId;
  icon: RowIcon;
  title: string;
  sub: string;
}> = [
  {
    id: "herdr",
    icon: "console",
    title: "Herdr",
    sub: "空间、终端与会话管理 · 13 个工具",
  },
  {
    id: "uniflo",
    icon: "database-search-outline",
    title: "Uniflo",
    sub: "会话历史、检索与用量查询 · 5 个工具",
  },
  {
    id: "browser",
    icon: "cursor-default-click-outline",
    title: "AI 浏览器操作",
    sub: "网页浏览、操作与接口抓包 · 3 个工具",
  },
  {
    id: "workspace",
    icon: "source-branch",
    title: "代码与 Git",
    sub: "文件读取、搜索与 Git 状态 · 1 个工具",
  },
  {
    id: "webfetch",
    icon: "book-open-page-variant-outline",
    title: "网页阅读",
    sub: "抓取公开网页并提取正文 · 1 个工具",
  },
  {
    id: "webhooks",
    icon: "webhook",
    title: "Webhook",
    sub: "通知外部服务 · webhook_*",
  },
];

const POCKET_PLUGINS: Array<{
  id: PocketPluginId;
  icon: RowIcon;
  title: string;
  categoryLabel: string;
  sub: string;
}> = [
  {
    id: "ai-browser",
    icon: "web",
    title: "AI 浏览器",
    categoryLabel: "操作流",
    sub: "内置跨平台浏览器与接口抓包 · herdr-pocket browser（电脑端启用）",
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

export default function PluginsScreen() {
  const p = usePalette();
  const plugins = useAssistant((s) => s.plugins);
  const webhooks = useAssistant((s) => s.webhooks);
  const loaded = useAssistant((s) => s.loaded);
  const [saving, setSaving] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");

  useEffect(() => {
    if (!loaded) void loadAssistant();
  }, [loaded]);

  const toggle = async (id: AssistantPluginId, next: boolean) => {
    setSaving(id);
    try {
      await updateAssistantPlugins({ plugins: { ...plugins, [id]: next } });
      setToast(next ? "已启用插件" : "已关闭插件");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const addWebhook = async () => {
    const cleanName = name.trim();
    const cleanUrl = url.trim();
    if (!cleanName || !cleanUrl) {
      setToast("请填写名称与 HTTP/HTTPS URL");
      return;
    }
    try {
      const parsed = new URL(cleanUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("URL 必须以 http:// 或 https:// 开头");
      }
    } catch (e) {
      setToast((e as Error).message || "URL 格式无效");
      return;
    }
    setSaving("webhooks");
    try {
      const next: AssistantWebhookTool[] = [
        ...webhooks,
        {
          id: slugifyHookId(cleanName, webhooks),
          name: cleanName,
          description: desc.trim() || `触发自定义 Webhook「${cleanName}」`,
          url: cleanUrl,
          ...(secret.trim() ? { secretHeader: secret.trim() } : {}),
        },
      ];
      await updateAssistantPlugins({
        plugins: { ...plugins, webhooks: true },
        webhooks: next,
      });
      setName("");
      setDesc("");
      setUrl("");
      setSecret("");
      setAdding(false);
      setToast(`已添加「${cleanName}」`);
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  const removeWebhook = async (id: string) => {
    setSaving(`rm-${id}`);
    try {
      await updateAssistantPlugins({ webhooks: webhooks.filter((w) => w.id !== id) });
      setToast("已移除 Webhook");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <PageBackground>
      <Stack.Screen options={{ title: "插件中心" }} />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 48, gap: space.md }}>
        <SectionHeader title="小羊助理插件" />
        <Card style={{ paddingVertical: space.xs }}>
          {XIAOYANG_PLUGINS.map((item, idx) => (
            <View key={item.id}>
              {idx > 0 ? <RowDivider /> : null}
              <Row
                icon={item.icon}
                title={item.title}
                sub={item.sub}
                right={
                  <Toggle
                    value={plugins[item.id]}
                    disabled={saving === item.id}
                    label={item.title}
                    onChange={(v) => void toggle(item.id, v)}
                  />
                }
              />
            </View>
          ))}
        </Card>

        {plugins.webhooks || webhooks.length > 0 ? (
          <>
            <SectionHeader title={`Webhook 列表（${webhooks.length}/16）`} />
            <Card style={{ paddingVertical: space.xs }}>
              {webhooks.map((hook, i) => (
                <View key={hook.id}>
                  {i > 0 ? <RowDivider /> : null}
                  <Row
                    icon="webhook"
                    title={hook.name}
                    sub={`${hook.description}\n${hook.url}`}
                    right={
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        {hook.secretHeader ? <Pill text="已设密钥" tone="good" /> : null}
                        <RowAction
                          icon="trash-can-outline"
                          danger
                          a11y={`删除 ${hook.name}`}
                          disabled={saving === `rm-${hook.id}`}
                          onPress={() => void removeWebhook(hook.id)}
                        />
                      </View>
                    }
                  />
                </View>
              ))}
              {webhooks.length > 0 ? <RowDivider /> : null}
              <Row
                icon="plus"
                title={adding ? "收起" : "新增 Webhook"}
                onPress={() => setAdding((v) => !v)}
              />
            </Card>

            {adding ? (
              <Card style={{ padding: space.lg, gap: space.md }}>
                <Field title="名称">
                  <Input value={name} onChangeText={setName} placeholder="如：触发部署" />
                </Field>
                <Field title="用途说明">
                  <Input value={desc} onChangeText={setDesc} placeholder="可选" />
                </Field>
                <Field title="Webhook 地址">
                  <Input
                    mono
                    value={url}
                    onChangeText={setUrl}
                    placeholder="https://hooks.example.com/trigger"
                    autoCapitalize="none"
                  />
                </Field>
                <Field title="X-Webhook-Secret（可选）">
                  <Input mono value={secret} onChangeText={setSecret} placeholder="可选密钥" autoCapitalize="none" />
                </Field>
                <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
                  <PocketButton variant="ghost" size="sm" onPress={() => setAdding(false)}>
                    取消
                  </PocketButton>
                  <PocketButton variant="primary" size="sm" loading={saving === "webhooks"} onPress={() => void addWebhook()}>
                    <Text style={{ color: p.onPrimary, fontFamily: fonts.bodyBold, fontSize: 13 }}>保存</Text>
                  </PocketButton>
                </View>
              </Card>
            ) : null}
          </>
        ) : null}

        <SectionHeader title="Herdr Pocket 插件" />
        <Card style={{ paddingVertical: space.xs }}>
          {POCKET_PLUGINS.map((item, idx) => (
            <View key={item.id}>
              {idx > 0 ? <RowDivider /> : null}
              <Row
                icon={item.icon}
                title={item.title}
                sub={item.sub}
                right={<Pill text={item.categoryLabel} tone="lavender" />}
              />
            </View>
          ))}
        </Card>
      </ScrollView>
      <ConfigSnackbar message={toast} onDismiss={() => setToast(null)} />
    </PageBackground>
  );
}
