/**
 * One model provider: change its protocol, address and key, or add a new one.
 * "先测一下" tries the values before they are saved. A key typed here is sent
 * once and the box is emptied; the app never shows or keeps it.
 */
import { useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, View } from "react-native";
import { Button, Text } from "react-native-paper";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { AssistantConfigView, ModelAuth, ModelProtocol, ModelTestResult, ProviderPatch, ProviderView } from "@herdr-pocket/protocol";
import { Card, EmptyState, PageBackground } from "../../components/ui";
import { Chip, Chips, ConfigSnackbar, ConfirmDialog, Field, Input, KeyField, LoadState, SaveBar, useLeaveGuard } from "../../components/configParts";
import { changeConfig, flash, loadConfig, PROTOCOL_LABEL, providerName, speedLine, testDraft, useAssistantConfig, useConfigWatch } from "../../lib/assistantConfig";
import { usePalette } from "../../theme/theme";
import { fonts, radius, space, statusColors } from "../../theme/tokens";

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const HTTP = /^https?:\/\/\S+$/i;
const AUTHS: { value: ModelAuth | null; label: string }[] = [
  { value: null, label: "按协议默认" },
  { value: "bearer", label: "Bearer" },
  { value: "x-api-key", label: "x-api-key" },
  { value: "api-key", label: "api-key" },
  { value: "none", label: "不用密钥" },
];

export default function ProviderScreen() {
  const p = usePalette();
  const params = useLocalSearchParams<{ id?: string }>();
  const editId = typeof params.id === "string" && params.id ? params.id : null;
  useConfigWatch("config");
  const config = useAssistantConfig((s) => s.config);
  const configError = useAssistantConfig((s) => s.configError);
  const current = editId ? config?.providers.find((x) => x.id === editId) : undefined;
  const title = editId ? (current ? providerName(current) : editId) : "添加服务商";
  const header = <Stack.Screen options={{ title }} />;
  if (!config) {
    return (
      <PageBackground>
        {header}
        <LoadState error={configError} onRetry={loadConfig} />
      </PageBackground>
    );
  }
  if (editId && !current) {
    return (
      <PageBackground>
        {header}
        <EmptyState title="这个服务商不在了" body="可能刚被另一台手机删掉了。" mood="waiting" action={<Button textColor={p.accentText} onPress={() => router.back()}>回去看看</Button>} />
      </PageBackground>
    );
  }
  return (
    <>
      {header}
      <ProviderForm key={editId ?? "new"} config={config} current={current} editId={editId} title={title} />
    </>
  );
}

/** The form starts from the provider as it was when the screen opened; later refreshes leave what is typed alone. */
function ProviderForm({ config, current, editId, title }: { config: AssistantConfigView; current: ProviderView | undefined; editId: string | null; title: string }) {
  const p = usePalette();
  const headerHeight = useHeaderHeight();
  const [id, setId] = useState("");
  const [label, setLabel] = useState(current?.label ?? "");
  const [protocol, setProtocol] = useState<ModelProtocol>(current?.protocol ?? "openai");
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? "");
  const [auth, setAuth] = useState<ModelAuth | null>(current?.auth ?? null);
  const [apiKey, setApiKey] = useState("");
  const [more, setMore] = useState(!!current?.auth);
  const [testWith, setTestWith] = useState(() => (current ? (config.models.find((m) => m.provider === current.id)?.model ?? "") : ""));
  const [test, setTest] = useState<ModelTestResult | "running" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [ask, setAsk] = useState<"clearKey" | "remove" | null>(null);

  const base = current ? { label: current.label ?? "", protocol: current.protocol, baseUrl: current.baseUrl, auth: current.auth ?? null } : { label: "", protocol: "openai" as ModelProtocol, baseUrl: "", auth: null };
  const dirty = label.trim() !== base.label || protocol !== base.protocol || baseUrl.trim() !== base.baseUrl || auth !== base.auth || !!apiKey || (!editId && !!id.trim());
  const { dialog: guard, leave } = useLeaveGuard(dirty);

  const pid = editId ?? id.trim();
  const idError = !editId && id.trim() ? (!ID.test(id.trim()) ? "用小写字母、数字和短横线，字母开头，最多 32 个字" : config.providers.some((x) => x.id === id.trim()) ? "已经有叫这个的服务商了" : null) : null;
  const urlError = baseUrl.trim() && !HTTP.test(baseUrl.trim()) ? "地址要以 http:// 或 https:// 开头" : null;
  const complete = !!pid && !idError && !!baseUrl.trim() && !urlError;
  const canSave = dirty && complete && !busy;
  const users = config.models.filter((m) => m.provider === editId);

  /** Only what changed for a provider that exists; everything for a new one. The key only when typed. */
  function patch(): ProviderPatch {
    const url = baseUrl.trim();
    const name = label.trim();
    if (!current) return { id: pid, protocol, baseUrl: url, ...(name ? { label: name } : {}), ...(auth ? { auth } : {}), ...(apiKey ? { apiKey } : {}) };
    return {
      id: pid,
      ...(name !== base.label ? { label: name } : {}),
      ...(protocol !== base.protocol ? { protocol } : {}),
      ...(url !== base.baseUrl ? { baseUrl: url } : {}),
      ...(auth !== base.auth ? { auth } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
  }

  async function runTest() {
    setTest("running");
    setTest(await testDraft(patch(), testWith.trim()));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await changeConfig({ providers: [patch()] });
      setApiKey("");
      flash(editId ? `「${label.trim() || pid}」已保存` : `加好了「${label.trim() || pid}」，在“添加模型”里就能选它`);
      leave(() => router.back());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clearPhoneKey() {
    setAsk(null);
    setBusy(true);
    try {
      await changeConfig({ providers: [{ id: pid, apiKey: null }] });
      setToast("已清除手机上设置的密钥");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeIt() {
    setAsk(null);
    setBusy(true);
    try {
      const left = config.models.filter((m) => m.provider !== pid);
      await changeConfig({ providers: [{ id: pid, remove: true }], ...(users.length ? { models: left } : {}) });
      flash(`删掉了「${title}」`);
      leave(() => router.back());
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const good = statusColors("working", p.dark).fg;

  return (
    <PageBackground>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={headerHeight}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxxl }}>
          {current?.from === "server" ? (
            <View style={{ flexDirection: "row", gap: space.sm, backgroundColor: p.lavenderContainer, borderRadius: radius.card, padding: space.md }}>
              <MaterialCommunityIcons name="server-outline" size={18} color={p.dusk} style={{ marginTop: 1 }} />
              <Text style={{ flex: 1, color: p.ink, fontSize: 13.5, lineHeight: 20 }}>这是服务器上配的服务商：可以改，不能删。想撤掉手机上的改动，到“模型”页最下面恢复成服务器上的设置。</Text>
            </View>
          ) : null}

          <Card style={{ padding: space.lg, gap: space.lg }}>
            {editId ? (
              <Field title="代号" hint="模型记成 代号:模型名，改不了">
                <Text selectable style={{ color: p.ink, fontFamily: fonts.mono, fontSize: 14 }}>
                  {editId}
                </Text>
              </Field>
            ) : (
              <Field title="代号" hint="模型会记成 代号:模型名。用小写字母、数字和短横线，比如 deepseek" error={idError}>
                <Input value={id} onChangeText={(t) => setId(t.toLowerCase())} placeholder="my-gateway" autoCapitalize="none" mono accessibilityLabel="代号" />
              </Field>
            )}
            <Field title="名字" hint="列表里显示的名字，不填就用代号">
              <Input value={label} onChangeText={setLabel} placeholder={pid || "比如 自建网关"} accessibilityLabel="名字" />
            </Field>
            <Field title="协议">
              <Chips>
                {(["openai", "anthropic"] as const).map((x) => (
                  <Chip key={x} on={protocol === x} onPress={() => setProtocol(x)} label={PROTOCOL_LABEL[x]} />
                ))}
              </Chips>
            </Field>
            <Field title="地址" hint="接口的根地址，比如 https://llm.example.com/v1" error={urlError}>
              <Input value={baseUrl} onChangeText={setBaseUrl} placeholder="https://" autoCapitalize="none" keyboardType="url" mono accessibilityLabel="地址" />
            </Field>
            <KeyField value={apiKey} onChange={setApiKey} current={current?.key} onClearPhoneKey={() => setAsk("clearKey")} busy={busy} />
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} onPress={() => setMore(!more)} hitSlop={8} style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 36 }}>
              <Text style={{ color: p.accentText, fontFamily: fonts.bodySemi, fontSize: 13.5 }}>更多设置</Text>
              <MaterialCommunityIcons name={more ? "chevron-up" : "chevron-down"} size={18} color={p.accentText} />
            </Pressable>
            {more ? (
              <Field title="密钥怎么带上" hint="一般不用改。本地模型不要密钥时选“不用密钥”">
                <Chips>
                  {AUTHS.map((a) => (
                    <Chip key={a.label} on={auth === a.value} onPress={() => setAuth(a.value)} label={a.label} />
                  ))}
                </Chips>
              </Field>
            ) : null}
          </Card>

          <Card style={{ padding: space.lg, gap: space.md }}>
            <Text style={{ fontFamily: fonts.bodyBold, color: p.ink, fontSize: 15 }}>先测一下</Text>
            <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20 }}>用上面的设置（没保存的也算）问模型一句话，看它通不通、多快开口。</Text>
            <Field title="用哪个模型测">
              <Input value={testWith} onChangeText={setTestWith} placeholder="比如 gpt-6.1-terra" autoCapitalize="none" mono accessibilityLabel="用哪个模型测" />
            </Field>
            {users.length > 1 ? (
              <Chips>
                {users.map((m) => (
                  <Chip key={m.model} on={testWith.trim() === m.model} onPress={() => setTestWith(m.model)} label={m.model} />
                ))}
              </Chips>
            ) : null}
            <Button
              mode="contained-tonal"
              icon="speedometer"
              disabled={!complete || !testWith.trim() || test === "running"}
              loading={test === "running"}
              onPress={runTest}
              style={{ borderRadius: radius.pill }}
              contentStyle={{ height: 46 }}
            >
              先测一下
            </Button>
            {test && test !== "running" ? (
              test.ok ? (
                <View style={{ gap: 4 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                    <MaterialCommunityIcons name="lightning-bolt" size={16} color={good} />
                    <Text style={{ color: good, fontFamily: fonts.bodyBold, fontSize: 14.5 }}>通了{speedLine(test) ? ` · ${speedLine(test)}` : ""}</Text>
                  </View>
                  {test.reply ? (
                    <Text numberOfLines={3} style={{ color: p.muted, fontSize: 13, lineHeight: 19 }}>
                      它说：{test.reply}
                    </Text>
                  ) : null}
                </View>
              ) : (
                <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 4 }}>
                  <MaterialCommunityIcons name="alert-circle-outline" size={16} color={p.error} style={{ marginTop: 2 }} />
                  <Text style={{ flex: 1, color: p.error, fontSize: 13.5, lineHeight: 20 }}>没通：{test.error ?? "没有回话"}</Text>
                </View>
              )
            ) : null}
          </Card>

          {current?.from === "phone" ? (
            <Button mode="text" icon="trash-can-outline" textColor={p.error} disabled={busy} onPress={() => (users.length === config.models.length ? setToast("小羊的模型都在用它：先在模型页加一个别的模型，再删它") : setAsk("remove"))} style={{ alignSelf: "center" }}>
              删掉这个服务商
            </Button>
          ) : null}
          {error ? <Text style={{ color: p.error, lineHeight: 20, textAlign: "center" }}>{error}</Text> : null}
        </ScrollView>

        <SaveBar note={editId ? "保存后马上生效，所有手机都一样" : "加好后，到“添加模型”里选它的模型"}>
          <Button mode="contained" disabled={!canSave} loading={busy} onPress={save} style={{ flex: 1, borderRadius: radius.pill }} contentStyle={{ height: 50 }} labelStyle={{ fontSize: 16 }}>
            {editId ? "保存" : "添加"}
          </Button>
        </SaveBar>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={ask === "clearKey"}
        title="清除手机上设置的密钥？"
        body={current?.from === "server" ? "清除后改回用服务器上配的密钥；服务器上没有的话，用它的模型会失败。" : "清除后它就没有密钥了，用它的模型会失败，直到再设一个。"}
        action="清除"
        danger
        onDismiss={() => setAsk(null)}
        onConfirm={clearPhoneKey}
      />
      <ConfirmDialog
        visible={ask === "remove"}
        title={`删掉「${title}」？`}
        body={users.length ? `正在用它的 ${users.length} 个模型（${users.map((m) => m.model).join("、")}）也会一起去掉。它的地址和密钥都不留。` : "它的地址和密钥都不留。"}
        action="删掉"
        danger
        onDismiss={() => setAsk(null)}
        onConfirm={removeIt}
      />
      {guard}
      <ConfigSnackbar message={toast} onDismiss={() => setToast(null)} bottom={96} />
    </PageBackground>
  );
}
