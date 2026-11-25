import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Text } from "react-native-paper";
import { Stack } from "expo-router";
import type { AssistantPluginId, AssistantWebhookTool } from "@herdr-pocket/protocol";
import { Card, PageBackground, SectionHeader } from "../../components/ui";
import { Row, RowDivider, Toggle, type RowIcon } from "../../components/rows";
import { ConfigSnackbar, Field, Input, Note, Pill } from "../../components/configParts";
import { PocketButton, RowAction } from "../../components/pocket";
import { loadAssistant, updateAssistantPlugins, useAssistant } from "../../lib/assistant";
import { usePalette } from "../../theme/theme";
import { fonts, space } from "../../theme/tokens";

const PLUGINS: Array<{
  id: AssistantPluginId;
  icon: RowIcon;
  title: string;
  sub: string;
}> = [
  {
    id: "browser",
    icon: "web",
    title: "网页协作（AI 浏览器）",
    sub: "联动已开启插件的电脑内置浏览器，支持读取 @ref 与演示点击，遇到登录/验证码自动交还给你。",
  },
  {
    id: "workspace",
    icon: "source-branch",
    title: "代码与 Git 只读巡检",
    sub: "只读查看仓库 Git 状态、差异或文件内容（单次最多 8 KB），不消耗完整终端轮次。",
  },
  {
    id: "webfetch",
    icon: "earth",
    title: "公开网页查阅",
    sub: "抓取公开 HTTP/HTTPS 页面正文，内置本机与内网地址 SSRF 拦截。",
  },
  {
    id: "webhooks",
    icon: "webhook",
    title: "自定义 Webhook 工具桥接",
    sub: "将个人或团队公开 Webhook 注册为小羊工具（POST JSON）。",
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
      setToast("请填写名称与公开 HTTPS/HTTP URL");
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
      setToast(`已添加 Webhook「${cleanName}」`);
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
      setToast("已移除 Webhook 工具");
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
        <Note>所有插件默认全部关闭，零外部依赖、零多余上下文开销。只有当你明确需要某项能力并打开后，小羊才会在对话里加载对应工具。</Note>

        <SectionHeader title="小羊扩展工具" />
        <Card style={{ paddingVertical: space.xs }}>
          {PLUGINS.map((item, idx) => (
            <View key={item.id}>
              {idx > 0 ? <RowDivider /> : null}
              <Row icon={item.icon} title={item.title} sub={item.sub}>
                <Toggle
                  value={Boolean(plugins[item.id])}
                  disabled={saving === item.id}
                  label={item.title}
                  onChange={(v) => void toggle(item.id, v)}
                />
              </Row>
            </View>
          ))}
        </Card>

        {(plugins.webhooks || webhooks.length > 0) ? (
          <>
            <SectionHeader title={`自定义 Webhook（${webhooks.length}/16）`} />
            <Card style={{ paddingVertical: space.xs }}>
              {webhooks.map((hook, i) => (
                <View key={hook.id}>
                  {i > 0 ? <RowDivider /> : null}
                  <Row icon="webhook" title={hook.name} sub={`${hook.description}\n${hook.url}`}>
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
                  </Row>
                </View>
              ))}
              {webhooks.length > 0 ? <RowDivider /> : null}
              <Row
                icon="plus"
                title={adding ? "收起表单" : "新增 Webhook 工具"}
                sub="调用时自动屏蔽内网/本机 IP"
                onPress={() => setAdding((v) => !v)}
              />
            </Card>

            {adding ? (
              <Card style={{ padding: space.lg, gap: space.md }}>
                <Field title="工具名称">
                  <Input value={name} onChangeText={setName} placeholder="例如：触发预览部署" />
                </Field>
                <Field title="功能说明">
                  <Input value={desc} onChangeText={setDesc} placeholder="告诉小羊什么时候使用它" />
                </Field>
                <Field title="Webhook 地址">
                  <Input mono value={url} onChangeText={setUrl} placeholder="https://hooks.example.com/trigger" autoCapitalize="none" />
                </Field>
                <Field title="X-Webhook-Secret（可选）" hint="服务端只保留脱敏状态">
                  <Input mono value={secret} onChangeText={setSecret} placeholder="可选密钥" autoCapitalize="none" />
                </Field>
                <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
                  <PocketButton variant="ghost" size="sm" onPress={() => setAdding(false)}>
                    取消
                  </PocketButton>
                  <PocketButton variant="primary" size="sm" loading={saving === "webhooks"} onPress={() => void addWebhook()}>
                    <Text style={{ color: p.onPrimary, fontFamily: fonts.bodyBold, fontSize: 13 }}>保存工具</Text>
                  </PocketButton>
                </View>
              </Card>
            ) : null}
          </>
        ) : null}
      </ScrollView>
      <ConfigSnackbar message={toast} onDismiss={() => setToast(null)} />
    </PageBackground>
  );
}
