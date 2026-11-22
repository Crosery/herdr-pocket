/**
 * One-step model provider + upstream model scanner screen:
 * - Pick a preset (MiMo, DeepSeek, OpenAI, Responses, Anthropic, Gemini, Ollama...) or custom
 * - Auto-derives clean provider id unless edited under "更多设置"
 * - Auto-scans upstream models in real time via draft POST /v1/assistant/config/models
 * - Pick one or multiple models + promote as main + speed-test + save in a single atomic request.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "react-native-paper";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  PROVIDER_PRESETS,
  type AssistantConfigView,
  type ModelAuth,
  type ModelProtocol,
  type ModelRef,
  type ModelTestResult,
  type ProviderPatch,
  type ProviderPresetItem,
  type ProviderView,
} from "@herdr-pocket/protocol";
import { Card, EmptyState, PageBackground } from "../../components/ui";
import { Chip, Chips, ConfigSnackbar, ConfirmDialog, Field, Input, KeyField, LoadState, Pill, SaveBar, useLeaveGuard } from "../../components/configParts";
import { PocketButton, PocketChip, PocketChips, PocketSpinner } from "../../components/pocket";
import { PocketKeyboardAvoidingView } from "../../components/PocketKeyboardAvoidingView";
import { Toggle } from "../../components/rows";
import { modelErrorText } from "../../lib/modelErrors";
import { changeConfig, flash, listProviderModels, loadConfig, PROTOCOL_LABEL, providerName, speedLine, testDraft, useAssistantConfig, useConfigWatch } from "../../lib/assistantConfig";
import { usePalette } from "../../theme/theme";
import { fonts, radius, space, statusColors } from "../../theme/tokens";

const EXTRA_SOTA_PRESETS: readonly ProviderPresetItem[] = [
  { id: "stepfun", label: "StepFun 阶跃星辰", protocol: "openai", baseUrl: "https://api.stepfun.com/v1", recommendedModel: "step-2-mini" },
  { id: "groq", label: "Groq", protocol: "openai", baseUrl: "https://api.groq.com/openai/v1", recommendedModel: "llama-3.3-70b-versatile" },
  { id: "xai", label: "xAI", protocol: "openai", baseUrl: "https://api.x.ai/v1", recommendedModel: "grok-3-fast" },
  { id: "lmstudio", label: "LM Studio 本地", protocol: "openai", baseUrl: "http://127.0.0.1:1234/v1", auth: "none" },
  { id: "mlx", label: "Apple Silicon MLX 本地", protocol: "openai", baseUrl: "http://127.0.0.1:8080/v1", auth: "none" },
];
const ALL_PRESETS: readonly ProviderPresetItem[] = [
  ...PROVIDER_PRESETS,
  ...EXTRA_SOTA_PRESETS.filter((item) => !PROVIDER_PRESETS.some((p) => p.id === item.id)),
];

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const HTTP = /^https?:\/\/\S+$/i;
const PROTOCOLS: readonly ModelProtocol[] = ["openai", "openai-responses", "anthropic", "gemini", "ollama"];
const AUTHS: { value: ModelAuth | null; label: string }[] = [
  { value: null, label: "按协议默认" },
  { value: "bearer", label: "Bearer" },
  { value: "x-api-key", label: "x-api-key" },
  { value: "api-key", label: "api-key" },
  { value: "x-goog-api-key", label: "x-goog-api-key" },
  { value: "none", label: "不用密钥" },
];

const URL_HINT: Record<ModelProtocol, string> = {
  openai: "https://api.example.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  ollama: "http://localhost:11434",
};

function deriveAutoId(presetId: string | null, label: string, baseUrl: string, existingIds: readonly string[]): string {
  const taken = new Set(existingIds);
  let raw = (presetId && presetId !== "custom" ? presetId : "") || "";
  if (!raw && label.trim()) {
    raw = label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
  if (!raw && baseUrl.trim()) {
    try {
      const host = new URL(baseUrl.trim()).hostname.replace(/^(api|llm|gateway|token-plan(?:-cn)?)\./i, "");
      const part = host.split(".")[0] ?? "";
      raw = part.toLowerCase().replace(/[^a-z0-9-]+/g, "");
    } catch {
      raw = "";
    }
  }
  if (!raw || !/^[a-z]/.test(raw)) raw = raw ? `p-${raw}` : "custom-gw";
  const base = raw.slice(0, 26);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 99; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `gw-${Date.now().toString(36).slice(-4)}`;
}

export default function ProviderScreen() {
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
        <EmptyState title="这个服务商不在了" body="可能刚被另一台手机删掉了。" mood="waiting" action={<PocketButton variant="soft" icon="arrow-left" onPress={() => router.back()}>回去看看</PocketButton>} />
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

/** Single-step provider setup with quick presets and automatic upstream model scanning. */
function ProviderForm({ config, current, editId, title }: { config: AssistantConfigView; current: ProviderView | undefined; editId: string | null; title: string }) {
  const p = usePalette();
  const headerHeight = useHeaderHeight();
  const [presetId, setPresetId] = useState<string | null>(editId ? null : "mimo");
  const firstPreset = !editId ? PROVIDER_PRESETS[0] : undefined;

  const [manualId, setManualId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [label, setLabel] = useState(current?.label ?? firstPreset?.label ?? "");
  const [protocol, setProtocol] = useState<ModelProtocol>(current?.protocol ?? firstPreset?.protocol ?? "openai");
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? firstPreset?.baseUrl ?? "");
  const [auth, setAuth] = useState<ModelAuth | null>(current?.auth ?? firstPreset?.auth ?? null);
  const [apiKey, setApiKey] = useState("");
  const [more, setMore] = useState(!!current?.auth);

  // Selected models + upstream scanner
  const [scanned, setScanned] = useState<string[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [selectedModels, setSelectedModels] = useState<string[]>(() => (!editId && firstPreset?.recommendedModel ? [firstPreset.recommendedModel] : []));
  const [manualModel, setManualModel] = useState("");
  const [makeMain, setMakeMain] = useState(!editId);

  const [testWith, setTestWith] = useState(() => (current ? (config.models.find((m) => m.provider === current.id)?.model ?? "") : (firstPreset?.recommendedModel ?? "")));
  const [test, setTest] = useState<ModelTestResult | "running" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [ask, setAsk] = useState<"clearKey" | "remove" | "resetProvider" | null>(null);
  const scanSeq = useRef(0);

  const existingIds = useMemo(() => config.providers.map((x) => x.id), [config.providers]);
  const autoId = useMemo(() => deriveAutoId(presetId, label, baseUrl, existingIds), [presetId, label, baseUrl, existingIds]);
  const pid = editId ?? (idEdited ? manualId.trim() : autoId);

  const base = current ? { label: current.label ?? "", protocol: current.protocol, baseUrl: current.baseUrl, auth: current.auth ?? null } : { label: "", protocol: "openai" as ModelProtocol, baseUrl: "", auth: null as ModelAuth | null };
  const chosenModels = useMemo(() => {
    const out: string[] = [];
    for (const m of selectedModels) if (m.trim() && !out.includes(m.trim())) out.push(m.trim());
    if (manualModel.trim() && !out.includes(manualModel.trim())) out.push(manualModel.trim());
    return out;
  }, [selectedModels, manualModel]);

  const dirty = label.trim() !== base.label || protocol !== base.protocol || baseUrl.trim() !== base.baseUrl || auth !== base.auth || !!apiKey || (!editId && idEdited && !!manualId.trim()) || chosenModels.length > 0;
  const { dialog: guard, leave } = useLeaveGuard(dirty);

  const idError = !editId && idEdited && manualId.trim() ? (!ID.test(manualId.trim()) ? "用小写字母、数字和短横线，字母开头，最多 32 个字" : config.providers.some((x) => x.id === manualId.trim()) ? "已经有叫这个的服务商了" : null) : null;
  const urlError = baseUrl.trim() && !HTTP.test(baseUrl.trim()) ? "地址要以 http:// 或 https:// 开头" : null;
  const complete = !!pid && !idError && !!baseUrl.trim() && !urlError;
  const canScan = complete && (!!apiKey.trim() || !!current?.key.set || auth === "none" || protocol === "ollama");
  const canSave = (dirty || (!editId && complete && chosenModels.length > 0)) && complete && !busy;
  const users = config.models.filter((m) => m.provider === editId);

  function applyPreset(item: ProviderPresetItem | "custom") {
    setScanned(null);
    setScanError(null);
    setTest(null);
    if (item === "custom") {
      setPresetId("custom");
      setLabel("");
      setProtocol("openai");
      setBaseUrl("");
      setAuth(null);
      setSelectedModels([]);
      setTestWith("");
      return;
    }
    setPresetId(item.id);
    setLabel(item.label);
    setProtocol(item.protocol);
    setBaseUrl(item.baseUrl);
    setAuth(item.auth ?? null);
    if (item.recommendedModel) {
      setSelectedModels([item.recommendedModel]);
      setTestWith(item.recommendedModel);
    } else {
      setSelectedModels([]);
      setTestWith("");
    }
  }

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

  async function scanModels(silent = false) {
    if (!canScan) return;
    const seq = ++scanSeq.current;
    setScanning(true);
    setScanError(null);
    try {
      const pArg: ProviderPatch = {
        id: pid,
        protocol,
        baseUrl: baseUrl.trim(),
        ...(auth ? { auth } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      };
      const models = await listProviderModels(pArg);
      if (scanSeq.current !== seq) return;
      setScanned(models);
      if (models.length && !testWith.trim()) {
        setTestWith(models[0]!);
      }
      if (!models.length && !silent) setToast("上游没有返回模型，可在下方手动填写");
    } catch (e) {
      if (scanSeq.current !== seq) return;
      setScanned([]);
      setScanError((e as Error).message);
    } finally {
      if (scanSeq.current === seq) setScanning(false);
    }
  }

  // Auto-scan upstream models whenever URL & credentials become ready.
  useEffect(() => {
    if (!canScan) return;
    const timer = setTimeout(() => {
      void scanModels(true);
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, protocol, baseUrl, auth, apiKey, current?.key.set]);

  function toggleModel(m: string) {
    setSelectedModels((prev) => {
      const exists = prev.includes(m);
      const next = exists ? prev.filter((x) => x !== m) : [...prev, m];
      if (!exists) setTestWith(m);
      return next;
    });
  }

  function addManual() {
    const m = manualModel.trim();
    if (!m) return;
    if (!selectedModels.includes(m)) setSelectedModels((prev) => [...prev, m]);
    setTestWith(m);
    setManualModel("");
  }

  async function runTest() {
    const targetModel = testWith.trim() || chosenModels[0] || "";
    if (!targetModel) return;
    setTest("running");
    setTest(await testDraft(patch(), targetModel));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      let nextModels: ModelRef[] | undefined;
      if (chosenModels.length) {
        const pickedRefs: ModelRef[] = chosenModels.map((model) => ({ provider: pid, model }));
        const pickedKeys = new Set(pickedRefs.map((x) => `${x.provider}:${x.model}`));
        const rest = config.models.filter((x) => !pickedKeys.has(`${x.provider}:${x.model}`));
        nextModels = (makeMain ? [...pickedRefs, ...rest] : [...rest, ...pickedRefs]).slice(0, 12);
      }
      await changeConfig({
        providers: [patch()],
        ...(nextModels ? { models: nextModels } : {}),
      });
      setApiKey("");
      const msg = chosenModels.length
        ? `已保存「${label.trim() || pid}」并${makeMain ? "启用为主模型" : "加入模型列表"}（${chosenModels[0]}）`
        : editId
          ? `「${label.trim() || pid}」已保存`
          : `已添加「${label.trim() || pid}」`;
      flash(msg);
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
      setToast("已清除 App 里设的密钥");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resetServerProvider() {
    setAsk(null);
    setBusy(true);
    try {
      await changeConfig({ providers: [{ id: pid, reset: true }] });
      flash(`已把「${pid}」恢复为服务器原始配置`);
      leave(() => router.back());
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
  const filteredModels = (scanned ?? []).filter((m) => !filterText.trim() || m.toLowerCase().includes(filterText.trim().toLowerCase()));
  const canTestNow = complete && !!(testWith.trim() || chosenModels[0]) && test !== "running";

  return (
    <PageBackground>
      <PocketKeyboardAvoidingView style={{ flex: 1 }} keyboardVerticalOffset={headerHeight}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxxl }}>
          {current?.from === "server" ? (
            <View style={{ backgroundColor: p.lavenderContainer, borderRadius: radius.card, padding: space.md, gap: space.sm }}>
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <MaterialCommunityIcons name="server-outline" size={18} color={p.dusk} style={{ marginTop: 1 }} />
                <Text style={{ flex: 1, color: p.ink, fontSize: 13.5, lineHeight: 20 }}>
                  这是服务器自带服务商：可覆盖地址和密钥，也可以一键还原成服务器原始配置。
                </Text>
              </View>
              {config.edited ? (
                <PocketButton size="sm" variant="ghost" icon="backup-restore" onPress={() => setAsk("resetProvider")} style={{ alignSelf: "flex-start" }}>
                  恢复此服务商的服务器设置
                </PocketButton>
              ) : null}
            </View>
          ) : null}

          {!editId ? (
            <Card style={{ padding: space.lg, gap: space.md }}>
              <Field title="1. 快速选平台（也可以选自定义）" hint={`自动代号：${pid}（可在下方“更多设置”改）`}>
                <Chips>
                  {ALL_PRESETS.map((item) => (
                    <Chip key={item.id} on={presetId === item.id} onPress={() => applyPreset(item)} label={item.label} />
                  ))}
                  <Chip on={presetId === "custom"} onPress={() => applyPreset("custom")} label="自定义接口" />
                </Chips>
              </Field>
            </Card>
          ) : null}

          <Card style={{ padding: space.lg, gap: space.lg }}>
            <Field title={editId ? "名字" : "2. 连接信息"} hint="列表里显示的名字，留空用代号">
              <Input value={label} onChangeText={setLabel} placeholder={pid || "比如 小米 MiMo"} accessibilityLabel="名字" />
            </Field>
            <Field title="协议" hint="支持 OpenAI Chat / Responses、Claude、Gemini 原生与 Ollama 本地">
              <Chips>
                {PROTOCOLS.map((x) => (
                  <Chip
                    key={x}
                    on={protocol === x}
                    onPress={() => {
                      setProtocol(x);
                      if (!editId && (!baseUrl.trim() || Object.values(URL_HINT).includes(baseUrl.trim()))) {
                        if (x === "ollama") setBaseUrl(URL_HINT.ollama);
                        else if (x === "gemini") setBaseUrl(URL_HINT.gemini);
                        else if (x === "anthropic") setBaseUrl(URL_HINT.anthropic);
                      }
                    }}
                    label={PROTOCOL_LABEL[x]}
                  />
                ))}
              </Chips>
            </Field>
            <Field title="地址 (Base URL)" hint={`示例：${URL_HINT[protocol]}`} error={urlError}>
              <Input value={baseUrl} onChangeText={setBaseUrl} placeholder={URL_HINT[protocol]} autoCapitalize="none" keyboardType="url" mono accessibilityLabel="地址" />
            </Field>
            {(protocol === "ollama" && auth !== "bearer") || auth === "none" ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: p.surface2, borderRadius: radius.md, padding: space.md }}>
                <MaterialCommunityIcons name="check-circle-outline" size={18} color={good} />
                <Text style={{ flex: 1, color: p.muted, fontSize: 13 }}>本地推理服务（Ollama / LM Studio / MLX）默认免密钥，填写地址即可直接扫描模型。</Text>
              </View>
            ) : (
              <KeyField value={apiKey} onChange={setApiKey} current={current?.key} onClearPhoneKey={() => setAsk("clearKey")} busy={busy} />
            )}

            <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} onPress={() => setMore(!more)} hitSlop={8} style={{ flexDirection: "row", alignItems: "center", gap: 4, minHeight: 36 }}>
              <Text style={{ color: p.accentText, fontFamily: fonts.bodySemi, fontSize: 13.5 }}>更多设置（代号与鉴权头）</Text>
              <MaterialCommunityIcons name={more ? "chevron-up" : "chevron-down"} size={18} color={p.accentText} />
            </Pressable>
            {more ? (
              <View style={{ gap: space.md }}>
                {editId ? (
                  <Field title="代号" hint="模型记成 代号:模型名，保存后不可修改">
                    <Text selectable style={{ color: p.ink, fontFamily: fonts.mono, fontSize: 14 }}>
                      {editId}
                    </Text>
                  </Field>
                ) : (
                  <Field title="代号" hint={`默认自动生成 ${autoId}；可改为小写字母、数字和短横线`} error={idError}>
                    <Input
                      value={idEdited ? manualId : autoId}
                      onChangeText={(t) => {
                        setIdEdited(true);
                        setManualId(t.toLowerCase());
                      }}
                      placeholder={autoId}
                      autoCapitalize="none"
                      mono
                      accessibilityLabel="代号"
                    />
                  </Field>
                )}
                <Field title="鉴权头格式" hint="按协议自动匹配，特殊网关可手动指定">
                  <Chips>
                    {AUTHS.map((a) => (
                      <Chip key={a.label} on={auth === a.value} onPress={() => setAuth(a.value)} label={a.label} />
                    ))}
                  </Chips>
                </Field>
              </View>
            ) : null}
          </Card>

          {/* Auto-scan upstream models + choose models + speed test in the same step */}
          <Card style={{ padding: space.lg, gap: space.md }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: fonts.bodyBold, color: p.ink, fontSize: 15 }}>3. 选择与扫描模型</Text>
                <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 18 }}>填好地址和密钥会自动拉取上游模型；点选后保存即可使用</Text>
              </View>
              <PocketButton size="sm" variant="soft" icon="magnify" disabled={!canScan || scanning} loading={scanning} onPress={() => void scanModels(false)}>
                {scanning ? "扫描中" : "扫描模型"}
              </PocketButton>
            </View>

            {scanning && !scanned ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xs }}>
                <PocketSpinner size={14} />
                <Text style={{ color: p.muted, fontSize: 13 }}>正在自动扫描上游可用模型…</Text>
              </View>
            ) : null}

            {scanError ? (
              <View style={{ gap: 2 }}>
                <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 18 }}>没扫到模型列表：{modelErrorText(scanError).title}。可以直接在下面手动填模型名。</Text>
                <Text numberOfLines={2} style={{ color: p.faint, fontSize: 11.5, lineHeight: 16 }}>
                  {scanError}
                </Text>
              </View>
            ) : null}

            {scanned && scanned.length > 0 ? (
              <View style={{ gap: space.sm }}>
                {scanned.length > 8 ? (
                  <Input value={filterText} onChangeText={setFilterText} placeholder={`搜索模型（共 ${scanned.length} 个）`} autoCapitalize="none" mono accessibilityLabel="搜索扫描到的模型" />
                ) : null}
                <PocketChips multi>
                  {filteredModels.slice(0, 36).map((m) => (
                    <PocketChip key={m} multi mono on={selectedModels.includes(m)} onPress={() => toggleModel(m)} label={m} />
                  ))}
                </PocketChips>
                {filteredModels.length > 36 ? <Text style={{ color: p.faint, fontSize: 12 }}>仅显示前 36 个，可用上方输入框筛选更多</Text> : null}
              </View>
            ) : null}

            <Field title="手动填写或补充模型名" right={manualModel.trim() ? <PocketButton size="sm" variant="soft" icon="plus" onPress={addManual}>加入</PocketButton> : undefined}>
              <Input
                value={manualModel}
                onChangeText={(t) => {
                  setManualModel(t);
                  if (t.trim()) setTestWith(t.trim());
                }}
                placeholder={firstPreset?.recommendedModel ?? "比如 mimo-v2.6-flash"}
                autoCapitalize="none"
                mono
                accessibilityLabel="手动填写模型名"
              />
            </Field>

            {chosenModels.length > 0 ? (
              <View style={{ gap: space.sm, backgroundColor: p.surface2, borderRadius: radius.md, padding: space.md }}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  <Pill text={`待启用 ${chosenModels.length} 个`} tone="primary" />
                  <Text style={{ color: p.ink, fontFamily: fonts.mono, fontSize: 12.5, flex: 1 }} numberOfLines={2}>
                    {chosenModels.join(", ")}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
                  <Text style={{ color: p.ink, fontSize: 13.5, flex: 1 }}>保存后设为主模型（第一位使用）</Text>
                  <Toggle label="保存后设为主模型" value={makeMain} onChange={setMakeMain} />
                </View>
              </View>
            ) : null}

            <Field title="测速模型">
              <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Input value={testWith} onChangeText={setTestWith} placeholder={chosenModels[0] ?? "比如 mimo-v2.6-flash"} autoCapitalize="none" mono accessibilityLabel="用哪个模型测" />
                </View>
                <PocketButton variant="soft" icon="speedometer" disabled={!canTestNow} loading={test === "running"} onPress={runTest}>
                  测一下
                </PocketButton>
              </View>
            </Field>
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
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: p.error, fontFamily: fonts.bodyBold, fontSize: 13.5, lineHeight: 20 }}>没通：{modelErrorText(test.error).title}</Text>
                    {modelErrorText(test.error).detail ? (
                      <Text numberOfLines={3} style={{ color: p.faint, fontSize: 12, lineHeight: 17 }}>
                        {modelErrorText(test.error).detail}
                      </Text>
                    ) : null}
                  </View>
                </View>
              )
            ) : null}
          </Card>

          {current?.from === "phone" ? (
            <PocketButton variant="text" danger icon="trash-can-outline" disabled={busy} onPress={() => (users.length === config.models.length && !chosenModels.length ? setToast("小羊的模型都在用它：先在模型页加一个别的模型，再删它") : setAsk("remove"))} style={{ alignSelf: "center" }}>
              删掉这个服务商
            </PocketButton>
          ) : null}
          {error ? <Text style={{ color: p.error, lineHeight: 20, textAlign: "center" }}>{error}</Text> : null}
        </ScrollView>

        <SaveBar note={chosenModels.length ? `保存服务商并启用 ${chosenModels.length} 个模型` : editId ? "保存后马上生效，所有设备同步" : "填写完成点下方保存即可"}>
          <PocketButton size="lg" grow disabled={!canSave} loading={busy} onPress={save}>
            {chosenModels.length ? (makeMain ? "保存并设为主模型" : "保存并启用模型") : editId ? "保存" : "添加"}
          </PocketButton>
        </SaveBar>
      </PocketKeyboardAvoidingView>

      <ConfirmDialog
        visible={ask === "clearKey"}
        title="清除 App 里设的密钥？"
        body={current?.from === "server" ? "清除后改回用服务器上配的密钥；服务器上没有的话，用它的模型会失败。" : "清除后它就没有密钥了，用它的模型会失败，直到再设一个。"}
        action="清除"
        danger
        onDismiss={() => setAsk(null)}
        onConfirm={clearPhoneKey}
      />
      <ConfirmDialog
        visible={ask === "resetProvider"}
        title={`恢复「${pid}」的服务器设置？`}
        body="这会撤销在 App 或控制台里对这个服务商的地址和密钥修改，不会影响其他服务商或语音设置。"
        action="恢复"
        onDismiss={() => setAsk(null)}
        onConfirm={resetServerProvider}
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
