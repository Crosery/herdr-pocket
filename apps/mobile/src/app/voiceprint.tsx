/**
 * 通话降噪与声纹: phone-local speech denoising (GTCRN) and owner voiceprint
 * verification (Silero VAD + 3D-Speaker CAM++). Everything runs on this phone;
 * audio never leaves the device for verification, and only filtered owner speech
 * reaches the live voice service.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { Button, ProgressBar, Text } from "react-native-paper";
import { Stack } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { PocketNative } from "../../modules/pocket-native";
import { Card, PageBackground } from "../components/ui";
import { Row, RowDivider as Divider, Toggle } from "../components/rows";
import { Chip, Chips, ConfigSnackbar, ConfirmDialog, Field, Pill } from "../components/configParts";
import { useSettings } from "../lib/store";
import { isMockServer } from "../lib/mock";
import { micAllowed, syncNativeVoice, useVoice } from "../lib/voice";
import { usePalette } from "../theme/theme";
import { fonts, radius, space, statusColors } from "../theme/tokens";

type Phase = "idle" | "downloading" | "recording" | "finishing" | "testing";

const SENSITIVITY = [
  { value: 0.33, label: "宽松", hint: "环境较吵或说话轻时用，不容易漏掉你的话" },
  { value: 0.38, label: "标准", hint: "日常推荐，漏人和误拦都少" },
  { value: 0.45, label: "严格", hint: "身边有声音很像的人时用，宁可多核对半秒" },
] as const;

const SAMPLE_LINES = [
  "小羊，帮我看看哪几个任务跑完了，有卡住的再叫我。",
  "今天先这样，等这个构建过了就发个新版本吧。",
];

export default function VoiceprintScreen() {
  const p = usePalette();
  const server = useSettings((x) => x.server);
  const demo = isMockServer(server);
  const voiceDenoise = useSettings((x) => x.voiceDenoise);
  const voiceFilter = useSettings((x) => x.voiceFilter);
  const voiceThreshold = useSettings((x) => x.voiceThreshold);
  const voiceprint = useSettings((x) => x.voiceprint);
  const set = useSettings((x) => x.set);
  const callStatus = useVoice((x) => x.status);
  const inCall = callStatus === "connecting" || callStatus === "ready";

  const [modelReady, setModelReady] = useState(() => (demo ? true : (PocketNative?.voiceState?.()?.modelReady ?? false)));
  const [modelSizeMb] = useState(() => Math.max(1, Math.round((PocketNative?.voiceState?.()?.modelSize ?? 28_281_164) / 1_048_576)));
  const [phase, setPhase] = useState<Phase>("idle");
  const [dlProgress, setDlProgress] = useState(0);
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [recFull, setRecFull] = useState(false);
  const [testSpeaking, setTestSpeaking] = useState(false);
  const [testResult, setTestResult] = useState<{ score: number; pass: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [askClear, setAskClear] = useState(false);
  const demoTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopDemo = useCallback(() => {
    if (demoTimer.current) {
      clearInterval(demoTimer.current);
      demoTimer.current = null;
    }
  }, []);

  const stopAny = useCallback(() => {
    stopDemo();
    PocketNative?.cancelVoiceModel?.();
    PocketNative?.cancelVoiceEnroll?.();
    PocketNative?.stopVoiceTest?.();
  }, [stopDemo]);

  useEffect(() => {
    return () => stopAny();
  }, [stopAny]);

  useEffect(() => {
    if (!PocketNative) return;
    const s1 = PocketNative.addListener("onVoiceModelProgress", (e) => {
      if (e.total > 0) setDlProgress(Math.min(1, e.received / e.total));
    });
    const s2 = PocketNative.addListener("onEnrollProgress", (e) => {
      setLevel(e.level);
      setSeconds(e.seconds);
      setRecFull(e.full);
    });
    const s3 = PocketNative.addListener("onVoiceTest", (e) => {
      setLevel(e.level);
      setTestSpeaking(e.speaking);
      if (e.score !== undefined && e.pass !== undefined) {
        setTestResult({ score: e.score, pass: e.pass });
      }
    });
    return () => {
      s1.remove();
      s2.remove();
      s3.remove();
    };
  }, []);

  async function ensureModel(): Promise<boolean> {
    if (modelReady) return true;
    if (!PocketNative?.prepareVoiceModel) {
      setError("这个版本的 App 还没带声纹功能，先更新 App");
      return false;
    }
    setPhase("downloading");
    setDlProgress(0);
    setError(null);
    try {
      await PocketNative.prepareVoiceModel();
      setModelReady(true);
      return true;
    } catch (e) {
      const msg = (e as Error).message || "下载失败";
      if (!/cancel/i.test(msg)) setError(msg);
      return false;
    } finally {
      setPhase((cur) => (cur === "downloading" ? "idle" : cur));
    }
  }

  async function beginEnroll() {
    if (inCall) {
      setToast("正在通话中，挂断后再录声纹");
      return;
    }
    setError(null);
    if (demo) {
      setPhase("recording");
      setSeconds(0);
      setRecFull(false);
      let s = 0;
      stopDemo();
      demoTimer.current = setInterval(() => {
        s = Math.min(20, s + 0.25);
        setSeconds(s);
        setLevel(0.25 + Math.random() * 0.45);
        if (s >= 20) setRecFull(true);
      }, 250);
      return;
    }
    if (!(await micAllowed())) {
      setError("没有麦克风权限，没法录声纹。可以在系统设置里打开");
      return;
    }
    if (!(await ensureModel())) return;
    if (!PocketNative?.startVoiceEnroll) {
      setError("这个版本的 App 还没带声纹功能，先更新 App");
      return;
    }
    try {
      setSeconds(0);
      setLevel(0);
      setRecFull(false);
      await PocketNative.startVoiceEnroll();
      setPhase("recording");
    } catch (e) {
      setError((e as Error).message || "打不开麦克风");
      setPhase("idle");
    }
  }

  async function finishEnroll() {
    if (phase !== "recording") return;
    if (demo) {
      stopDemo();
      set({
        voiceprint: { embedding: Array.from({ length: 192 }, () => 0), seconds: Math.max(4, seconds), consistency: 0.89, createdAt: Date.now() },
        voiceFilter: true,
      });
      setPhase("idle");
      setLevel(0);
      setToast("演示模式：声纹录好了");
      return;
    }
    if (!PocketNative?.finishVoiceEnroll) return;
    setPhase("finishing");
    setError(null);
    try {
      const vp = await PocketNative.finishVoiceEnroll();
      set({
        voiceprint: { embedding: vp.embedding, seconds: vp.seconds, consistency: vp.consistency, createdAt: Date.now() },
        voiceFilter: true,
      });
      syncNativeVoice();
      setPhase("idle");
      setLevel(0);
      setToast(
        vp.consistency < 0.55
          ? "声纹录好了，不过刚才环境有点杂，之后若经常误拦建议在安静处重录"
          : "声纹录好了，下一通电话开始只放你的声音",
      );
    } catch (e) {
      setError((e as Error).message || "声纹录入失败");
      setPhase("idle");
      setLevel(0);
    }
  }

  function cancelEnroll() {
    stopDemo();
    PocketNative?.cancelVoiceEnroll?.();
    setPhase("idle");
    setLevel(0);
    setSeconds(0);
  }

  async function beginTest() {
    if (inCall) {
      setToast("正在通话中，挂断后再测试");
      return;
    }
    setError(null);
    setTestResult(null);
    setTestSpeaking(false);
    if (demo) {
      setPhase("testing");
      stopDemo();
      let n = 0;
      demoTimer.current = setInterval(() => {
        n++;
        setLevel(0.2 + Math.random() * 0.5);
        setTestSpeaking(true);
        if (n % 4 === 0) setTestResult({ score: 0.68, pass: true });
      }, 250);
      return;
    }
    if (!(await micAllowed())) {
      setError("没有麦克风权限，没法测试");
      return;
    }
    if (!(await ensureModel())) return;
    if (!PocketNative?.startVoiceTest) return;
    try {
      syncNativeVoice();
      await PocketNative.startVoiceTest(voiceThreshold);
      setPhase("testing");
    } catch (e) {
      setError((e as Error).message || "打不开麦克风");
      setPhase("idle");
    }
  }

  function endTest() {
    stopDemo();
    PocketNative?.stopVoiceTest?.();
    setPhase("idle");
    setLevel(0);
    setTestSpeaking(false);
  }

  function clearVoiceprint() {
    setAskClear(false);
    stopAny();
    setPhase("idle");
    set({ voiceprint: null });
    PocketNative?.setVoiceprint?.(null);
    syncNativeVoice();
    setToast("已清除这台手机上的声纹");
  }

  const sensitivity = SENSITIVITY.find((x) => Math.abs(x.value - voiceThreshold) < 0.02) ?? SENSITIVITY[1];
  const good = statusColors("working", p.dark);
  const busy = phase !== "idle";

  return (
    <PageBackground>
      <Stack.Screen options={{ title: "通话降噪与声纹" }} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxxl }}>
        <Card style={{ paddingVertical: space.xs }}>
          <Row
            icon="waveform"
            title="通话降噪"
            sub={voiceDenoise ? "已开启 · 实时滤掉环境杂音，延迟约 20 毫秒" : "已关闭 · 麦克风声音原样传给小羊"}
            right={
              <Toggle
                label="通话降噪"
                value={voiceDenoise}
                disabled={busy}
                onChange={(v) => {
                  set({ voiceDenoise: v });
                  syncNativeVoice();
                }}
              />
            }
          />
          {voiceprint ? (
            <>
              <Divider />
              <Row
                icon="shield-account-outline"
                title="只认我的声音"
                sub={voiceFilter ? "已开启 · 旁人说话和外放声音会被静音" : "暂时关闭 · 已录声纹保留着，随时能打开"}
                right={
                  <Toggle
                    label="只认我的声音"
                    value={voiceFilter}
                    disabled={busy}
                    onChange={(v) => {
                      set({ voiceFilter: v });
                      syncNativeVoice();
                    }}
                  />
                }
              />
            </>
          ) : null}
        </Card>

        {voiceprint ? (
          <Card style={{ padding: space.lg, gap: space.md }}>
            <Field title="识别要求" hint={sensitivity.hint}>
              <Chips>
                {SENSITIVITY.map((item) => (
                  <Chip
                    key={item.value}
                    on={sensitivity.value === item.value}
                    disabled={busy}
                    label={item.label}
                    onPress={() => {
                      set({ voiceThreshold: item.value });
                      syncNativeVoice();
                    }}
                  />
                ))}
              </Chips>
            </Field>
          </Card>
        ) : null}

        <Card style={{ padding: space.lg, gap: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
            <Text style={{ fontFamily: fonts.cute, fontSize: 18, color: p.ink }}>我的声纹</Text>
            {voiceprint ? (
              <Pill
                tone={voiceprint.consistency >= 0.65 ? "good" : "soft"}
                text={`已录 ${voiceprint.seconds.toFixed(1)} 秒 · 稳定 ${Math.round(voiceprint.consistency * 100)}%`}
              />
            ) : (
              <Pill tone="plain" text="还没录入" />
            )}
          </View>

          {phase === "downloading" ? (
            <View style={{ gap: space.sm }}>
              <Text style={{ color: p.ink, fontSize: 14 }}>
                正在准备本地声纹模型（{modelSizeMb} MB），{Math.round(dlProgress * 100)}%
              </Text>
              <ProgressBar progress={dlProgress} color={p.primary} style={{ height: 8, borderRadius: 4, backgroundColor: p.surface3 }} />
              <Button mode="text" textColor={p.muted} onPress={() => PocketNative?.cancelVoiceModel?.()} style={{ alignSelf: "flex-end" }}>
                取消下载
              </Button>
            </View>
          ) : phase === "recording" || phase === "finishing" ? (
            <View style={{ gap: space.md }}>
              <View style={{ backgroundColor: p.surface2, borderRadius: radius.md, padding: space.md, gap: space.xs }}>
                <Text style={{ color: p.muted, fontSize: 12.5 }}>可以用平时说话的语气读这段话（6–15 秒就够）：</Text>
                <Text style={{ color: p.ink, fontSize: 14.5, lineHeight: 22 }}>{SAMPLE_LINES.join("\n")}</Text>
              </View>
              <LevelMeter level={level} active />
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Text style={{ color: p.ink, fontFamily: fonts.bodySemi, fontSize: 14, fontVariant: ["tabular-nums"] }}>
                  已录到有效说话 {seconds.toFixed(1)} 秒
                </Text>
                <Text style={{ color: seconds >= 4 ? good.fg : p.muted, fontSize: 12.5 }}>
                  {recFull ? "已经很充足了，点完成就行" : seconds >= 4 ? "可以完成了，再多说几句更稳" : "至少需要 4 秒说话"}
                </Text>
              </View>
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <Button
                  mode="outlined"
                  disabled={phase === "finishing"}
                  onPress={cancelEnroll}
                  textColor={p.muted}
                  style={{ flex: 1, borderRadius: radius.pill, borderColor: p.divider }}
                >
                  取消
                </Button>
                <Button
                  mode="contained"
                  disabled={seconds < 3.8 || phase === "finishing"}
                  loading={phase === "finishing"}
                  onPress={finishEnroll}
                  style={{ flex: 2, borderRadius: radius.pill }}
                >
                  完成录入
                </Button>
              </View>
            </View>
          ) : phase === "testing" ? (
            <View style={{ gap: space.md }}>
              <LevelMeter level={level} active={testSpeaking} />
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32 }}>
                <MaterialCommunityIcons
                  name={testResult ? (testResult.pass ? "check-circle-outline" : "close-circle-outline") : "microphone-outline"}
                  size={20}
                  color={testResult ? (testResult.pass ? good.fg : p.error) : p.muted}
                />
                <Text style={{ flex: 1, color: testResult ? (testResult.pass ? good.fg : p.error) : p.muted, fontFamily: fonts.bodySemi, fontSize: 14 }}>
                  {testResult
                    ? testResult.pass
                      ? `认出是你，会放行 · 匹配度 ${(testResult.score * 100).toFixed(0)}%`
                      : `不是你的声音，会静音 · 匹配度 ${(testResult.score * 100).toFixed(0)}%`
                    : testSpeaking
                      ? "正在核对声纹…"
                      : "对着手机说句话，或者让旁人说一句试试"}
                </Text>
              </View>
              <Button mode="contained-tonal" onPress={endTest} style={{ borderRadius: radius.pill }}>
                结束测试
              </Button>
            </View>
          ) : (
            <View style={{ gap: space.md }}>
              {!modelReady ? (
                <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20 }}>
                  首次录入需要下载一个约 {modelSizeMb} MB 的声纹模型。模型和录音都只留在你的手机里，不会上传。
                </Text>
              ) : (
                <View style={{ backgroundColor: p.surface2, borderRadius: radius.md, padding: space.md, gap: space.xs }}>
                  <Text style={{ color: p.muted, fontSize: 12.5 }}>找个安静的地方，对着手机自然说 6–15 秒就行：</Text>
                  <Text style={{ color: p.ink, fontSize: 14, lineHeight: 21 }}>{SAMPLE_LINES[0]}</Text>
                </View>
              )}
              <Button mode="contained" onPress={beginEnroll} style={{ borderRadius: radius.pill }} contentStyle={{ height: 46 }}>
                {!modelReady ? "下载声纹模型并录制" : voiceprint ? "重新录制声纹" : "录制我的声音"}
              </Button>
              {voiceprint ? (
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  <Button mode="contained-tonal" onPress={beginTest} style={{ flex: 1, borderRadius: radius.pill }}>
                    测一下效果
                  </Button>
                  <Button mode="text" textColor={p.error} onPress={() => setAskClear(true)} style={{ borderRadius: radius.pill }}>
                    清除声纹
                  </Button>
                </View>
              ) : null}
            </View>
          )}
        </Card>

        <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 19, paddingHorizontal: space.xs }}>
          每句话开头与通话全程都会持续核对声纹，先缓冲约半秒确认是你的音色再放行；旁人插话或外放声音会被立即静音。修改设置从下一通电话生效。
        </Text>

        {error ? (
          <Text style={{ color: p.error, fontSize: 13.5, lineHeight: 20, textAlign: "center" }}>{error}</Text>
        ) : null}
      </ScrollView>

      <ConfirmDialog
        visible={askClear}
        title="清除已录的声纹？"
        body="清除后，电话里所有人说话和外放声音都会照常传给小羊；降噪还会继续开着。"
        action="清除"
        danger
        onDismiss={() => setAskClear(false)}
        onConfirm={clearVoiceprint}
      />
      <ConfigSnackbar message={toast} onDismiss={() => setToast(null)} bottom={28} />
    </PageBackground>
  );
}

function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const p = usePalette();
  const pct = Math.max(4, Math.min(100, Math.round(level * 100)));
  return (
    <View style={{ height: 10, borderRadius: 5, backgroundColor: p.surface3, overflow: "hidden" }}>
      <View style={{ width: `${pct}%`, height: "100%", borderRadius: 5, backgroundColor: active ? p.primary : p.faint }} />
    </View>
  );
}
