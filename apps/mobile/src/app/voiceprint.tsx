/**
 * 通话降噪与声纹: phone-local streaming speech enhancement (DPDFNet-baseline),
 * continuous target-speaker extraction (VoxLock), and multi-prototype speaker
 * verification (Silero VAD + 3D-Speaker ERes2NetV2-zh). Everything runs on this
 * phone; verification audio never leaves the device, and only isolated owner
 * speech reaches the live voice service without stalling sentence starts.
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
import { applog, uploadAppLog } from "../lib/applog";
import { useSettings } from "../lib/store";
import { isMockServer } from "../lib/mock";
import { isVoiceprintLegacy, micAllowed, syncNativeVoice, useVoice, VOICEPRINT_MODEL_VERSION } from "../lib/voice";
import { usePalette } from "../theme/theme";
import { fonts, radius, space, statusColors } from "../theme/tokens";

type Phase = "idle" | "downloading" | "recording" | "finishing" | "testing";

interface TestResult {
  score: number;
  rawScore?: number;
  protoScore?: number;
  pass: boolean;
  inferMs?: number;
  route?: string;
}

const SENSITIVITY = [
  { value: 0.33, label: "宽松", hint: "环境较吵或说话轻时用，不容易漏掉你的话" },
  { value: 0.38, label: "标准", hint: "日常推荐，漏人和误拦都少" },
  { value: 0.45, label: "严格", hint: "身边有声音很像的人时用，核对更严格、不容易串音" },
] as const;

const SAMPLE_LINES = [
  "小羊，帮我看看哪几个任务跑完了，有卡住的再叫我。",
  "今天先这样，等这个构建过了就发个新版本吧。",
];

const ROUTE_LABEL: Record<string, string> = {
  speaker: "免提扬声器",
  builtin: "机身麦克风",
  bt: "蓝牙耳机",
  wired: "有线耳机",
};

function routeLabel(route: string): string {
  return ROUTE_LABEL[route] ?? route;
}

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
  const [modelSizeMb] = useState(() => Math.max(1, Math.round((PocketNative?.voiceState?.()?.modelSize ?? 149_025_914) / 1_048_576)));
  const [nativeLegacy, setNativeLegacy] = useState(() => (demo ? false : Boolean(PocketNative?.voiceState?.()?.legacyEnrolled)));
  const [phase, setPhase] = useState<Phase>("idle");
  const [dlProgress, setDlProgress] = useState(0);
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [recFull, setRecFull] = useState(false);
  const [testSpeaking, setTestSpeaking] = useState(false);
  const [testRoute, setTestRoute] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [askClear, setAskClear] = useState(false);
  const demoTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const thresholdRef = useRef(voiceThreshold);
  thresholdRef.current = voiceThreshold;
  const lastTestLogAt = useRef(0);
  const lastTestPass = useRef<boolean | null>(null);
  const pendingFlush = useRef(false);

  const legacy = isVoiceprintLegacy(voiceprint) || (!voiceprint && nativeLegacy);

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
    if (pendingFlush.current) {
      pendingFlush.current = false;
      void uploadAppLog();
    }
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
      if (e.route) setTestRoute(e.route);
      if (e.score !== undefined && e.pass !== undefined) {
        setTestResult({
          score: e.score,
          rawScore: e.rawScore,
          protoScore: e.protoScore,
          pass: e.pass,
          inferMs: e.inferMs,
          route: e.route,
        });
        const now = Date.now();
        const flipped = lastTestPass.current !== null && lastTestPass.current !== e.pass;
        if (now - lastTestLogAt.current >= 1500 || (flipped && now - lastTestLogAt.current >= 400)) {
          lastTestLogAt.current = now;
          lastTestPass.current = e.pass;
          pendingFlush.current = true;
          const breakStr =
            e.rawScore != null || e.protoScore != null
              ? ` (raw ${e.rawScore != null ? e.rawScore.toFixed(2) : "-"}/proto ${e.protoScore != null ? e.protoScore.toFixed(2) : "-"})`
              : "";
          applog(
            "info",
            "voice.test",
            `test ${e.pass ? "pass" : "mute"}: score ${(e.score * 100).toFixed(0)}%${breakStr}${e.inferMs != null ? `, ${Math.round(e.inferMs)} ms` : ""}${e.route ? `, route ${e.route}` : ""}`,
            {
              pass: e.pass,
              score: e.score,
              rawScore: e.rawScore,
              protoScore: e.protoScore,
              inferMs: e.inferMs,
              route: e.route,
              threshold: thresholdRef.current,
            },
          );
        }
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
      const msg = (e as Error).message || "打不开麦克风";
      applog("warn", "voice.enroll", `enroll start failed: ${msg}`, { error: msg });
      void uploadAppLog();
      setError(msg);
      setPhase("idle");
    }
  }

  async function finishEnroll() {
    if (phase !== "recording") return;
    if (demo) {
      stopDemo();
      set({
        voiceprint: {
          embedding: Array.from({ length: 192 }, () => 0),
          prototypes: [Array.from({ length: 192 }, () => 0), Array.from({ length: 192 }, () => 0)],
          modelVersion: VOICEPRINT_MODEL_VERSION,
          hasSample: true,
          route: "speaker",
          snrDb: 22.4,
          seconds: Math.max(6, seconds),
          consistency: 0.89,
          createdAt: Date.now(),
        },
        voiceFilter: true,
      });
      setNativeLegacy(false);
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
      const savedModelVersion = vp.modelVersion ?? PocketNative.voiceState?.()?.modelVersion ?? (PocketNative.setVoiceprintMeta ? VOICEPRINT_MODEL_VERSION : undefined);
      set({
        voiceprint: {
          embedding: vp.embedding,
          prototypes: vp.prototypes,
          modelVersion: savedModelVersion,
          hasSample: vp.hasSample,
          route: vp.route,
          snrDb: vp.snrDb,
          seconds: vp.seconds,
          consistency: vp.consistency,
          createdAt: Date.now(),
        },
        voiceFilter: true,
      });
      setNativeLegacy(false);
      syncNativeVoice();
      applog(
        "info",
        "voice.enroll",
        `enrolled ${vp.seconds.toFixed(1)}s: consistency ${Math.round(vp.consistency * 100)}%, lowest ${vp.lowest.toFixed(2)}${vp.snrDb != null ? `, snr ${vp.snrDb.toFixed(1)} dB` : ""}${vp.route ? `, route ${vp.route}` : ""}, protos ${vp.prototypes?.length ?? 0}, sample ${Boolean(vp.hasSample)}`,
        {
          seconds: vp.seconds,
          consistency: vp.consistency,
          lowest: vp.lowest,
          snrDb: vp.snrDb,
          route: vp.route,
          hasSample: vp.hasSample,
          prototypes: vp.prototypes?.length ?? 0,
          modelVersion: savedModelVersion,
        },
      );
      pendingFlush.current = false;
      void uploadAppLog();
      setPhase("idle");
      setLevel(0);
      setToast(
        vp.consistency < 0.55
          ? "声纹录好了，不过刚才环境有点杂，之后若经常误拦建议在安静处重录"
          : "声纹录好了，下一通电话开始实时提取你的声音",
      );
    } catch (e) {
      const msg = (e as Error).message || "声纹录入失败";
      applog("warn", "voice.enroll", `enroll failed after ${seconds.toFixed(1)}s: ${msg}`, {
        seconds,
        modelVersion: PocketNative.voiceState?.()?.modelVersion,
        error: msg,
      });
      void uploadAppLog();
      setError(msg);
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
    setTestRoute(null);
    setTestSpeaking(false);
    lastTestLogAt.current = 0;
    lastTestPass.current = null;
    if (demo) {
      setPhase("testing");
      setTestRoute("speaker");
      stopDemo();
      let n = 0;
      demoTimer.current = setInterval(() => {
        n++;
        setLevel(0.2 + Math.random() * 0.5);
        setTestSpeaking(true);
        if (n % 4 === 0) {
          setTestResult({ score: 0.71, rawScore: 0.68, protoScore: 0.76, pass: true, inferMs: 28, route: "speaker" });
        }
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
    if (pendingFlush.current) {
      pendingFlush.current = false;
      void uploadAppLog();
    }
  }

  function clearVoiceprint() {
    setAskClear(false);
    stopAny();
    setPhase("idle");
    set({ voiceprint: null });
    setNativeLegacy(false);
    PocketNative?.setVoiceprint?.(null);
    PocketNative?.setVoiceprintMeta?.(null, null);
    syncNativeVoice();
    applog("info", "voice.enroll", "voiceprint cleared");
    void uploadAppLog();
    setToast("已清除这台手机上的声纹");
  }

  const sensitivity = SENSITIVITY.find((x) => Math.abs(x.value - voiceThreshold) < 0.02) ?? SENSITIVITY[1];
  const good = statusColors("working", p.dark);
  const busy = phase !== "idle";
  const activeRoute = testResult?.route ?? testRoute;

  const enrolledDetails =
    voiceprint && !legacy
      ? [
          voiceprint.hasSample ? "目标人声提取已就绪" : null,
          voiceprint.prototypes?.length ? `${voiceprint.prototypes.length} 段声纹原型` : null,
          voiceprint.snrDb != null ? `信噪比 ${voiceprint.snrDb.toFixed(0)} dB` : null,
          voiceprint.route ? routeLabel(voiceprint.route) : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "";

  return (
    <PageBackground>
      <Stack.Screen options={{ title: "通话降噪与声纹" }} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxxl }}>
        <Card style={{ paddingVertical: space.xs }}>
          <Row
            icon="waveform"
            title="通话降噪"
            sub={voiceDenoise ? "已开启 · 实时滤除环境杂音并增强人声清晰度，延迟约 20 毫秒" : "已关闭 · 麦克风声音原样传给小羊"}
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
          {voiceprint || legacy ? (
            <>
              <Divider />
              <Row
                icon="shield-account-outline"
                title="只认我的声音"
                sub={
                  legacy
                    ? "声纹引擎已升级，请重录一次以恢复声纹人声提取"
                    : voiceFilter
                      ? "已开启 · 实时提取你的声纹人声，旁人说话与外放杂音自动剥离且不断流"
                      : "暂时关闭 · 已录声纹保留着，随时能打开"
                }
                right={
                  <Toggle
                    label="只认我的声音"
                    value={voiceFilter}
                    disabled={busy || legacy}
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

        {voiceprint && !legacy ? (
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
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, flexWrap: "wrap" }}>
            <Text style={{ fontFamily: fonts.cute, fontSize: 18, color: p.ink }}>我的声纹</Text>
            {legacy ? (
              <Pill tone="soft" text="声纹引擎已升级，请重录一次" />
            ) : voiceprint ? (
              <Pill
                tone={voiceprint.consistency >= 0.65 ? "good" : "soft"}
                text={`已录 ${voiceprint.seconds.toFixed(1)} 秒 · 稳定 ${Math.round(voiceprint.consistency * 100)}%`}
              />
            ) : (
              <Pill tone="plain" text="还没录入" />
            )}
          </View>

          {enrolledDetails && phase === "idle" ? (
            <Text style={{ color: p.faint, fontSize: 12, fontVariant: ["tabular-nums"] }}>{enrolledDetails}</Text>
          ) : null}

          {phase === "downloading" ? (
            <View style={{ gap: space.sm }}>
              <Text style={{ color: p.ink, fontSize: 14 }}>
                正在准备本地声纹与人声提取模型（约 {modelSizeMb} MB），{Math.round(dlProgress * 100)}%
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
                  {recFull ? "已经很充足了，点完成就行" : seconds >= 6 ? "效果很好，随时可以完成" : seconds >= 4 ? "可以完成了，读满 6 秒更稳" : "至少需要 4 秒说话"}
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
              {testResult || activeRoute ? (
                <View
                  style={{
                    flexDirection: "row",
                    flexWrap: "wrap",
                    gap: space.md,
                    backgroundColor: p.surface2,
                    borderRadius: radius.sm,
                    paddingHorizontal: space.md,
                    paddingVertical: space.sm,
                  }}
                >
                  {testResult ? (
                    <Text style={{ color: p.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
                      {testResult.rawScore != null && testResult.protoScore != null
                        ? `综合 ${(testResult.score * 100).toFixed(0)}%（均值 ${(testResult.rawScore * 100).toFixed(0)}% / 原型 ${(testResult.protoScore * 100).toFixed(0)}%）`
                        : `匹配度 ${(testResult.score * 100).toFixed(0)}%`}
                    </Text>
                  ) : null}
                  {testResult?.inferMs != null ? (
                    <Text style={{ color: p.muted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
                      推理 {Math.round(testResult.inferMs)} ms
                    </Text>
                  ) : null}
                  {activeRoute ? (
                    <Text style={{ color: p.muted, fontSize: 12 }}>
                      路由 {routeLabel(activeRoute)}
                    </Text>
                  ) : null}
                </View>
              ) : null}
              <Button mode="contained-tonal" onPress={endTest} style={{ borderRadius: radius.pill }}>
                结束测试
              </Button>
            </View>
          ) : (
            <View style={{ gap: space.md }}>
              {legacy ? (
                <View style={{ flexDirection: "row", gap: space.sm, backgroundColor: p.accentContainer, borderRadius: radius.md, padding: space.md }}>
                  <MaterialCommunityIcons name="account-voice" size={20} color={p.accentText} style={{ marginTop: 1 }} />
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 13.5 }}>声纹引擎已升级，请重录一次</Text>
                    <Text style={{ color: p.ink, fontSize: 13, lineHeight: 19 }}>
                      已换上新一代中文声纹识别与实时目标人声提取模型，旧声纹已暂停使用。只需安静读 6–15 秒重录一次即可启用。
                    </Text>
                  </View>
                </View>
              ) : null}
              {!modelReady ? (
                <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20 }}>
                  首次录入需要下载约 {modelSizeMb} MB 的本地声纹与人声提取模型。模型和录音都只留在你的手机里，不会上传。
                </Text>
              ) : (
                <View style={{ backgroundColor: p.surface2, borderRadius: radius.md, padding: space.md, gap: space.xs }}>
                  <Text style={{ color: p.muted, fontSize: 12.5 }}>找个安静的地方，对着手机自然说 6–15 秒就行：</Text>
                  <Text style={{ color: p.ink, fontSize: 14, lineHeight: 21 }}>{SAMPLE_LINES[0]}</Text>
                </View>
              )}
              <Button mode="contained" onPress={beginEnroll} style={{ borderRadius: radius.pill }} contentStyle={{ height: 46 }}>
                {!modelReady
                  ? legacy
                    ? "下载新模型并重录"
                    : "下载声纹模型并录制"
                  : legacy
                    ? "重新录制以启用新声纹"
                    : voiceprint
                      ? "重新录制声纹"
                      : "录制我的声音"}
              </Button>
              {voiceprint || legacy ? (
                <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
                  {!legacy ? (
                    <Button mode="contained-tonal" onPress={beginTest} style={{ flex: 1, borderRadius: radius.pill }}>
                      测一下效果
                    </Button>
                  ) : null}
                  <Button mode="text" textColor={p.error} onPress={() => setAskClear(true)} style={{ borderRadius: radius.pill }}>
                    清除声纹
                  </Button>
                </View>
              ) : null}
            </View>
          )}
        </Card>

        <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 19, paddingHorizontal: space.xs }}>
          通话全程在手机本地实时提取你的声纹人声并持续核对音色，句子开头零缓冲、不断流；旁人插话与外放杂音会自动剥离静音。修改设置从下一通电话生效。
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
