/**
 * 语音: which live voice service calls use (or none), its address, model,
 * voice and speed, and its key (write-only, like the model keys).
 */
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { Text } from "react-native-paper";
import { router, Stack } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { AssistantConfigView, VoiceOption, VoicePatch, VoiceProviderId } from "@herdr-pocket/protocol";
import { Card, PageBackground } from "../../components/ui";
import { PocketButton, RowAction } from "../../components/pocket";
import { Row } from "../../components/rows";
import { Chip, Chips, ConfigSnackbar, ConfirmDialog, Field, Input, KeyField, LoadState, SaveBar, useLeaveGuard, WarningCard } from "../../components/configParts";
import { changeConfig, flash, loadConfig, loadVoices, useAssistantConfig, useConfigWatch, VOICE_LABEL } from "../../lib/assistantConfig";
import { useSettings } from "../../lib/store";
import { isMockServer } from "../../lib/mock";
import { isVoiceprintLegacy, voiceprintSupported } from "../../lib/voice";
import { usePalette } from "../../theme/theme";
import { fonts, space } from "../../theme/tokens";

const WS = /^wss?:\/\/\S+$/i;
const SPEED = { min: 0.5, max: 1.5, step: 0.1 };
const round1 = (n: number) => Math.round(n * 10) / 10;

interface VoiceModelPreset {
  id: string;
  label: string;
  provider: VoiceProviderId;
  url: string;
  model: string;
  defaultVoice?: string;
}

const SOTA_VOICE_PRESETS: readonly VoiceModelPreset[] = [
  { id: "gpt-realtime", label: "OpenAI gpt-realtime", provider: "openai-realtime", url: "wss://api.openai.com/v1/realtime", model: "gpt-realtime", defaultVoice: "marin" },
  { id: "gpt-4o-realtime", label: "gpt-4o-realtime-preview", provider: "openai-realtime", url: "wss://api.openai.com/v1/realtime", model: "gpt-4o-realtime-preview", defaultVoice: "marin" },
  { id: "gpt-4o-mini-realtime", label: "gpt-4o-mini-realtime", provider: "openai-realtime", url: "wss://api.openai.com/v1/realtime", model: "gpt-4o-mini-realtime-preview", defaultVoice: "marin" },
  { id: "qwen3-omni", label: "阿里 Qwen3-Omni", provider: "openai-realtime", url: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model: "qwen3-omni-flash-realtime" },
  { id: "step-audio-2", label: "阶跃 step-audio-2", provider: "openai-realtime", url: "wss://api.stepfun.com/v1/realtime", model: "step-audio-2" },
  { id: "glm-realtime", label: "智谱 glm-realtime", provider: "openai-realtime", url: "wss://open.bigmodel.cn/api/paas/v4/realtime", model: "glm-realtime" },
  { id: "gemini-live", label: "Gemini 2.5 Native Audio", provider: "openai-realtime", url: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent", model: "gemini-2.5-flash-native-audio-preview-12-2025" },
  { id: "moss-live", label: "MOSS-Live 1.0", provider: "moss-live", url: "wss://api.mosi.cn/v1/realtime", model: "moss-live-1.0" },
  { id: "mlx-local", label: "桌面本地 MLX", provider: "openai-realtime", url: "ws://127.0.0.1:8000/v1/realtime", model: "mlx-omni-realtime" },
];

export default function VoiceScreen() {
  useConfigWatch("config");
  const config = useAssistantConfig((s) => s.config);
  const configError = useAssistantConfig((s) => s.configError);
  const header = <Stack.Screen options={{ title: "语音" }} />;
  if (!config) {
    return (
      <PageBackground>
        {header}
        <LoadState error={configError} onRetry={loadConfig} />
      </PageBackground>
    );
  }
  return (
    <>
      {header}
      <VoiceForm config={config} />
    </>
  );
}

/** Starts from the voice settings as they were when the screen opened; `config` keeps the latest for comparing. */
function VoiceForm({ config }: { config: AssistantConfigView }) {
  const p = usePalette();
  const headerHeight = useHeaderHeight();
  const v = config.voice;
  const [provider, setProvider] = useState<VoiceProviderId | null>(v.provider);
  const [url, setUrl] = useState(v.url ?? "");
  const [model, setModel] = useState(v.model ?? "");
  const [voice, setVoice] = useState(v.voice ?? "");
  const [speed, setSpeed] = useState<number | null>(v.speed ?? null);
  const [apiKey, setApiKey] = useState("");
  const [voiceOptions, setVoiceOptions] = useState<VoiceOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [askClear, setAskClear] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!provider) {
      setVoiceOptions([]);
      return;
    }
    void loadVoices(provider).then((cat) => {
      if (alive) setVoiceOptions(cat.voices);
    });
    return () => {
      alive = false;
    };
  }, [provider]);

  const switched = provider !== v.provider;
  const dirty = switched || (!!provider && (url.trim() !== (v.url ?? "") || model.trim() !== (v.model ?? "") || voice.trim() !== (v.voice ?? "") || speed !== (v.speed ?? null))) || !!apiKey;
  const { dialog: guard, leave } = useLeaveGuard(dirty);

  const urlError = provider && url.trim() && !WS.test(url.trim()) ? "地址要以 ws:// 或 wss:// 开头" : null;
  const canSave = dirty && !urlError && !busy;
  const voiceWarnings = config.warnings.filter((w) => w.startsWith("语音"));
  const voiceDenoise = useSettings((x) => x.voiceDenoise);
  const voiceFilter = useSettings((x) => x.voiceFilter);
  const voiceprint = useSettings((x) => x.voiceprint);
  const server = useSettings((x) => x.server);
  const localOk = voiceprintSupported || isMockServer(server);
  const legacy = isVoiceprintLegacy(voiceprint);
  const localSub = !localOk
    ? "需要装新版 App"
    : `${voiceDenoise ? "降噪已开" : "降噪关着"} · ${
        legacy
          ? "声纹引擎已升级，请重录一次"
          : voiceprint
            ? voiceFilter
              ? "只提取你的声音"
              : "声纹已存（暂停提取）"
            : "未录声纹"
      }`;

  /** Picking a SOTA preset fills provider, endpoint and model cleanly (synced with desktop). */
  function applyPreset(preset: VoiceModelPreset) {
    setProvider(preset.provider);
    setUrl(preset.url);
    setModel(preset.model);
    if (preset.defaultVoice) setVoice(preset.defaultVoice);
    else if (preset.provider === "moss-live" && voiceOptions.some((x) => x.id === voice.trim())) setVoice("");
  }

  /** Picking another service starts from its own defaults: a MOSS address is no use to another service. */
  function pick(next: VoiceProviderId | null) {
    if (next === provider) return;
    setProvider(next);
    const back = next === v.provider;
    setUrl(back ? (v.url ?? "") : "");
    setModel(back ? (v.model ?? "") : "");
    setVoice(back ? (v.voice ?? "") : next === "openai-realtime" ? "marin" : "");
    setSpeed(back ? (v.speed ?? null) : null);
  }

  /** Only what changed; an emptied box goes back to the default (null). */
  function patch(): VoicePatch {
    const out: VoicePatch = {};
    if (switched) out.provider = provider;
    if (provider) {
      const field = (now: string, was: string | undefined) => (switched || now.trim() !== (was ?? "") ? (now.trim() ? now.trim() : null) : undefined);
      const u = field(url, v.url);
      const m = field(model, v.model);
      const vo = field(voice, v.voice);
      if (u !== undefined) out.url = u;
      if (m !== undefined) out.model = m;
      if (vo !== undefined) out.voice = vo;
      if (switched || speed !== (v.speed ?? null)) out.speed = speed;
    }
    if (apiKey) out.apiKey = apiKey;
    return out;
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await changeConfig({ voice: patch() });
      setApiKey("");
      flash(provider ? "语音设置已保存，下一通电话开始用" : "语音通话关掉了");
      leave(() => router.back());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clearPhoneKey() {
    setAskClear(false);
    setBusy(true);
    try {
      await changeConfig({ voice: { apiKey: null } });
      setToast("已清除 App 里设的密钥");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shownSpeed = speed ?? 1;

  return (
    <PageBackground>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={headerHeight}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxxl }}>
          {!switched ? <WarningCard lines={voiceWarnings} /> : null}
          <Card style={{ padding: space.lg, gap: space.lg }}>
            <Field title="打电话用哪种语音" hint={provider ? "电话里出声、听你说话的那个模型" : "关着时不能给小羊打电话，打字聊天不受影响"}>
              <Chips>
                {(["moss-live", "openai-realtime"] as const).map((x) => (
                  <Chip key={x} on={provider === x} onPress={() => pick(x)} label={VOICE_LABEL[x]} />
                ))}
                <Chip on={provider === null} onPress={() => pick(null)} label="关闭" icon={<MaterialCommunityIcons name="phone-off-outline" size={16} color={p.muted} />} />
              </Chips>
            </Field>

            <Field title="SOTA 实时语音模型预设" hint="一键填入旗舰云端或桌面本地实时语音端点（与桌面端预设同步）">
              <Chips>
                {SOTA_VOICE_PRESETS.map((preset) => {
                  const active = provider === preset.provider && model.trim().toLowerCase() === preset.model.toLowerCase();
                  return <Chip key={preset.id} on={active} onPress={() => applyPreset(preset)} label={preset.label} />;
                })}
              </Chips>
            </Field>

            {provider ? (
              <>
                <Field title="地址" hint={switched && !url.trim() ? "不填就用这种语音的默认地址" : "ws:// 或 wss:// 开头"} error={urlError}>
                  <Input value={url} onChangeText={setUrl} placeholder="wss://voice.example.com/v1/realtime" autoCapitalize="none" keyboardType="url" mono accessibilityLabel="地址" />
                </Field>
                <Field title="模型" hint={switched && !model.trim() ? "不填就用默认的" : undefined}>
                  <Input value={model} onChangeText={setModel} placeholder={provider === "moss-live" ? "moss-live-1.0" : "gpt-realtime"} autoCapitalize="none" mono accessibilityLabel="模型" />
                </Field>
                <Field
                  title="声音"
                  hint={
                    voiceOptions.find((x) => x.id === voice.trim())?.hint ??
                    (provider === "openai-realtime" ? "可点选上面的音色，也可直接填名字；留空默认用 marin" : "服务商那里的声音名字，不填就用默认的")
                  }
                >
                  {voiceOptions.length ? (
                    <Chips>
                      {voiceOptions.map((item) => (
                        <Chip key={item.id} on={voice.trim() === item.id} label={item.label} onPress={() => setVoice(item.id)} />
                      ))}
                    </Chips>
                  ) : null}
                  <Input
                    value={voice}
                    onChangeText={setVoice}
                    placeholder={provider === "openai-realtime" ? "marin（默认）" : "默认的声音"}
                    autoCapitalize="none"
                    mono
                    accessibilityLabel="声音"
                  />
                </Field>
                <Field title="语速" hint={speed == null ? "现在用服务商默认的语速" : "1.0 是正常速度，0.5 到 1.5 之间"}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                    <RowAction icon="minus" disabled={shownSpeed <= SPEED.min} onPress={() => setSpeed(round1(Math.max(SPEED.min, shownSpeed - SPEED.step)))} a11y="慢一点" />
                    <View accessibilityLabel={speed == null ? "语速：默认" : `语速 ${speed.toFixed(1)} 倍`} style={{ minWidth: 76, alignItems: "center" }}>
                      <Text style={{ fontFamily: fonts.cute, fontSize: 22, lineHeight: 30, color: speed == null ? p.faint : p.ink }}>{speed == null ? "默认" : `${speed.toFixed(1)}×`}</Text>
                    </View>
                    <RowAction icon="plus" disabled={shownSpeed >= SPEED.max} onPress={() => setSpeed(round1(Math.min(SPEED.max, shownSpeed + SPEED.step)))} a11y="快一点" />
                    {speed != null ? (
                      <PocketButton variant="text" size="sm" onPress={() => setSpeed(null)}>
                        用默认
                      </PocketButton>
                    ) : null}
                  </View>
                </Field>
                <KeyField value={apiKey} onChange={setApiKey} current={switched ? undefined : v.key} onClearPhoneKey={() => setAskClear(true)} busy={busy} />
                {switched ? <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 18 }}>换了语音服务，原来的密钥不一定能用，最好填上这家的密钥。</Text> : null}
              </>
            ) : null}
          </Card>
          <Card style={{ paddingVertical: space.xs }}>
            <Row icon="shield-account-outline" title="这台手机的降噪与声纹" sub={localSub} dim={!localOk} onPress={localOk ? () => router.push("/voiceprint") : undefined} />
          </Card>
          <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 18, paddingHorizontal: space.xs }}>语音没有“测一下”：改好后打一通电话试试就知道了。</Text>
          {error ? <Text style={{ color: p.error, lineHeight: 20, textAlign: "center" }}>{error}</Text> : null}
        </ScrollView>

        <SaveBar note="保存后从下一通电话开始用，所有手机都一样">
          <PocketButton size="lg" grow disabled={!canSave} loading={busy} onPress={save}>
            保存
          </PocketButton>
        </SaveBar>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={askClear}
        title="清除 App 里设的密钥？"
        body="清除后改回用服务器上配的语音密钥；服务器上没有的话，电话会打不通。"
        action="清除"
        danger
        onDismiss={() => setAskClear(false)}
        onConfirm={clearPhoneKey}
      />
      {guard}
      <ConfigSnackbar message={toast} onDismiss={() => setToast(null)} bottom={96} />
    </PageBackground>
  );
}
