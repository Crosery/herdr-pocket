/**
 * 语音: which live voice service calls use (or none), its address, model,
 * voice and speed, and its key (write-only, like the model keys).
 */
import { useState } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { Button, IconButton, Text } from "react-native-paper";
import { router, Stack } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { AssistantConfigView, VoicePatch, VoiceProviderId } from "@herdr-pocket/protocol";
import { Card, PageBackground } from "../../components/ui";
import { Chip, Chips, ConfigSnackbar, ConfirmDialog, Field, Input, KeyField, LoadState, SaveBar, useLeaveGuard, WarningCard } from "../../components/configParts";
import { changeConfig, flash, loadConfig, useAssistantConfig, useConfigWatch, VOICE_LABEL } from "../../lib/assistantConfig";
import { usePalette } from "../../theme/theme";
import { fonts, radius, space } from "../../theme/tokens";

const WS = /^wss?:\/\/\S+$/i;
const SPEED = { min: 0.5, max: 1.5, step: 0.1 };
const round1 = (n: number) => Math.round(n * 10) / 10;

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [askClear, setAskClear] = useState(false);

  const switched = provider !== v.provider;
  const dirty = switched || (!!provider && (url.trim() !== (v.url ?? "") || model.trim() !== (v.model ?? "") || voice.trim() !== (v.voice ?? "") || speed !== (v.speed ?? null))) || !!apiKey;
  const { dialog: guard, leave } = useLeaveGuard(dirty);

  const urlError = provider && url.trim() && !WS.test(url.trim()) ? "地址要以 ws:// 或 wss:// 开头" : null;
  const canSave = dirty && !urlError && !busy;
  const voiceWarnings = config.warnings.filter((w) => w.startsWith("语音"));

  /** Picking another service starts from its own defaults: a MOSS address is no use to another service. */
  function pick(next: VoiceProviderId | null) {
    if (next === provider) return;
    setProvider(next);
    const back = next === v.provider;
    setUrl(back ? (v.url ?? "") : "");
    setModel(back ? (v.model ?? "") : "");
    setVoice(back ? (v.voice ?? "") : "");
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
      setToast("已清除手机上设置的密钥");
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

            {provider ? (
              <>
                <Field title="地址" hint={switched && !url.trim() ? "不填就用这种语音的默认地址" : "ws:// 或 wss:// 开头"} error={urlError}>
                  <Input value={url} onChangeText={setUrl} placeholder="wss://voice.example.com/v1/realtime" autoCapitalize="none" keyboardType="url" mono accessibilityLabel="地址" />
                </Field>
                <Field title="模型" hint={switched && !model.trim() ? "不填就用默认的" : undefined}>
                  <Input value={model} onChangeText={setModel} placeholder={provider === "moss-live" ? "moss-live-1.0" : "gpt-realtime"} autoCapitalize="none" mono accessibilityLabel="模型" />
                </Field>
                <Field title="声音" hint="服务商那里的声音名字，不填就用默认的">
                  <Input value={voice} onChangeText={setVoice} placeholder="默认的声音" autoCapitalize="none" mono accessibilityLabel="声音" />
                </Field>
                <Field title="语速" hint={speed == null ? "现在用服务商默认的语速" : "1.0 是正常速度，0.5 到 1.5 之间"}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                    <IconButton
                      icon="minus"
                      mode="contained-tonal"
                      size={20}
                      disabled={shownSpeed <= SPEED.min}
                      onPress={() => setSpeed(round1(Math.max(SPEED.min, shownSpeed - SPEED.step)))}
                      accessibilityLabel="慢一点"
                      style={{ margin: 0 }}
                    />
                    <View accessibilityLabel={speed == null ? "语速：默认" : `语速 ${speed.toFixed(1)} 倍`} style={{ minWidth: 76, alignItems: "center" }}>
                      <Text style={{ fontFamily: fonts.cute, fontSize: 22, lineHeight: 30, color: speed == null ? p.faint : p.ink }}>{speed == null ? "默认" : `${speed.toFixed(1)}×`}</Text>
                    </View>
                    <IconButton
                      icon="plus"
                      mode="contained-tonal"
                      size={20}
                      disabled={shownSpeed >= SPEED.max}
                      onPress={() => setSpeed(round1(Math.min(SPEED.max, shownSpeed + SPEED.step)))}
                      accessibilityLabel="快一点"
                      style={{ margin: 0 }}
                    />
                    {speed != null ? (
                      <Button mode="text" compact textColor={p.accentText} onPress={() => setSpeed(null)}>
                        用默认
                      </Button>
                    ) : null}
                  </View>
                </Field>
                <KeyField value={apiKey} onChange={setApiKey} current={switched ? undefined : v.key} onClearPhoneKey={() => setAskClear(true)} busy={busy} />
                {switched ? <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 18 }}>换了语音服务，原来的密钥不一定能用，最好填上这家的密钥。</Text> : null}
              </>
            ) : null}
          </Card>
          <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 18, paddingHorizontal: space.xs }}>语音没有“测一下”：改好后打一通电话试试就知道了。</Text>
          {error ? <Text style={{ color: p.error, lineHeight: 20, textAlign: "center" }}>{error}</Text> : null}
        </ScrollView>

        <SaveBar note="保存后从下一通电话开始用，所有手机都一样">
          <Button mode="contained" disabled={!canSave} loading={busy} onPress={save} style={{ flex: 1, borderRadius: radius.pill }} contentStyle={{ height: 50 }} labelStyle={{ fontSize: 16 }}>
            保存
          </Button>
        </SaveBar>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={askClear}
        title="清除手机上设置的密钥？"
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
