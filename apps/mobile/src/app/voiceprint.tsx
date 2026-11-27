/**
 * 通话降噪与声纹: phone-local streaming speech enhancement (DPDFNet-baseline),
 * continuous target-speaker extraction (VoxLock), and multi-prototype speaker
 * verification (Silero VAD + 3D-Speaker ERes2NetV2-zh). Enrollment stays on
 * the phone. Owner-only calls use the locally extracted audio instead of
 * forwarding the original mixture when extraction is unavailable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { Text } from "react-native-paper";
import { Stack } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { PocketNative, type VoiceTier } from "../../modules/pocket-native";
import { Card, PageBackground } from "../components/ui";
import { PocketButton, PocketProgress } from "../components/pocket";
import { Row, RowDivider as Divider, Toggle } from "../components/rows";
import { Chip, Chips, ConfigSnackbar, ConfirmDialog, Field, Pill } from "../components/configParts";
import { applog, uploadAppLog } from "../lib/applog";
import { useSettings } from "../lib/store";
import { isMockServer } from "../lib/mock";
import { isVoiceprintLegacy, micAllowed, syncNativeVoice, useVoice, VOICEPRINT_MODEL_VERSION } from "../lib/voice";
import {
  cancelMobileVoiceModelDownload,
  startMobileVoiceModelDownload,
  useMobileVoiceModelDownload,
} from "../lib/voiceModelDownload";
import { usePalette } from "../theme/theme";
import { fonts, radius, space, statusColors } from "../theme/tokens";

type Phase = "idle" | "recording" | "finishing" | "testing";

const TIER_TITLE: Record<"denoise" | "sv" | "tse", string> = {
  denoise: "暂不启用声纹（建议关闭声纹）",
  sv: "灵巧声纹（68 MB）",
  tse: "旗舰声纹分离（142 MB）",
};

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
  const voiceFilter = useSettings((x) => x.voiceFilter);
  const voiceThreshold = useSettings((x) => x.voiceThreshold);
  const voiceTier = useSettings((x) => x.voiceTier);
  const effectiveChoice: "auto" | "sv" | "tse" = voiceTier === "sv" || voiceTier === "tse" ? voiceTier : "auto";
  const voiceFirstSpeaker = useSettings((x) => x.voiceFirstSpeaker);
  const voiceprint = useSettings((x) => x.voiceprint);
  const set = useSettings((x) => x.set);
  const callStatus = useVoice((x) => x.status);
  const inCall = callStatus === "connecting" || callStatus === "ready";

  const initialNative = demo ? undefined : PocketNative?.voiceState?.();
  const [svReady, setSvReady] = useState(() => (demo ? true : Boolean(initialNative?.svReady ?? initialNative?.modelReady)));
  const [tseReady, setTseReady] = useState(() => (demo ? true : Boolean(initialNative?.tseModelsReady ?? initialNative?.modelReady)));
  const [svSizeMb] = useState(() => Math.max(1, Math.round((initialNative?.svSize ?? 71_441_526) / 1_048_576)));
  const [modelSizeMb] = useState(() => Math.max(1, Math.round((initialNative?.modelSize ?? 149_025_914) / 1_048_576)));
  const [nativeLegacy, setNativeLegacy] = useState(() => (demo ? false : Boolean(initialNative?.legacyEnrolled)));
  const [bench, setBench] = useState<{ tier: "denoise" | "sv" | "tse"; reason: string } | null>(() =>
    demo
      ? { tier: "sv", reason: "演示环境：推荐 68 MB 灵巧声纹门控" }
      : initialNative?.recommendedTier
        ? { tier: initialNative.recommendedTier, reason: initialNative.recommendReason ?? "" }
        : null,
  );
  const [benchBusy, setBenchBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const dlDownloading = useMobileVoiceModelDownload((s) => s.downloading);
  const dlLabel = useMobileVoiceModelDownload((s) => s.label);
  const dlProgress = useMobileVoiceModelDownload((s) => s.progress);
  const dlCompletedSeq = useMobileVoiceModelDownload((s) => s.completedSeq);
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
  const mountedRef = useRef(true);
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

  /** Only stops active microphone capture on unmount; model downloads continue in background. */
  const stopCaptureOnly = useCallback(() => {
    stopDemo();
    PocketNative?.cancelVoiceEnroll?.();
    PocketNative?.stopVoiceTest?.();
    if (pendingFlush.current) {
      pendingFlush.current = false;
      void uploadAppLog();
    }
  }, [stopDemo]);

  const runBenchmark = useCallback(async () => {
    if (demo) {
      setBench({ tier: "sv", reason: "演示环境：降噪 2.4 ms/帧，推荐 68 MB 灵巧声纹门控" });
      return;
    }
    if (!PocketNative?.benchmarkVoiceDevice || benchBusy) return;
    setBenchBusy(true);
    try {
      const r = await PocketNative.benchmarkVoiceDevice();
      setBench({ tier: r.recommendedTier, reason: r.reason });
    } catch {
      // Keep UI usable even if device benchmark is unavailable.
    } finally {
      setBenchBusy(false);
    }
  }, [demo, benchBusy]);

  useEffect(() => {
    mountedRef.current = true;
    if (!demo && !bench && PocketNative?.benchmarkVoiceDevice) {
      void runBenchmark();
    }
    return () => {
      mountedRef.current = false;
      stopCaptureOnly();
    };
  }, [stopCaptureOnly]);

  const refreshModelFlags = useCallback(() => {
    if (demo) {
      setSvReady(true);
      setTseReady(true);
      return;
    }
    const st = PocketNative?.voiceState?.();
    if (!st) return;
    setSvReady(Boolean(st.svReady ?? st.modelReady));
    setTseReady(Boolean(st.tseModelsReady ?? st.modelReady));
  }, [demo]);

  useEffect(() => {
    refreshModelFlags();
  }, [dlCompletedSeq, refreshModelFlags]);

  useEffect(() => {
    if (!PocketNative) return;
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
      s2.remove();
      s3.remove();
    };
  }, []);

  async function ensureTierModel(target: "sv" | "tse"): Promise<boolean> {
    if (demo) return true;
    if (target === "sv" && svReady) return true;
    if (target === "tse" && svReady && tseReady) return true;
    setError(null);
    const label = target === "sv" ? `灵巧声纹模型（约 ${svSizeMb} MB）` : `旗舰人声分离包（总计约 ${modelSizeMb} MB）`;
    const res = await startMobileVoiceModelDownload(target, label);
    if (mountedRef.current) {
      if (res.ok) {
        refreshModelFlags();
      } else if (!res.cancelled && res.error) {
        setError(res.error);
      }
    }
    return res.ok;
  }

  async function chooseTier(next: VoiceTier) {
    if (busy) return;
    set({ voiceTier: next });
    syncNativeVoice();
    if (next === "sv" && !svReady) await ensureTierModel("sv");
    else if (next === "tse" && (!svReady || !tseReady)) await ensureTierModel("tse");
    else if (next === "auto") {
      if (bench?.tier === "tse" && (!svReady || !tseReady)) await ensureTierModel("tse");
      else if (bench?.tier === "sv" && !svReady) await ensureTierModel("sv");
    }
  }

  async function toggleFirstSpeaker(next: boolean) {
    if (!next) {
      set({ voiceFirstSpeaker: false });
      syncNativeVoice();
      return;
    }
    if (!(await ensureTierModel("sv"))) return;
    set({ voiceFirstSpeaker: true, ...(voiceTier === "denoise" ? { voiceTier: "auto" } : {}) });
    syncNativeVoice();
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
    const wantTse = effectiveChoice === "tse" || (effectiveChoice === "auto" && bench?.tier === "tse");
    if (!(await ensureTierModel(wantTse ? "tse" : "sv"))) return;
    if (!mountedRef.current) return;
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
    if (!(await ensureTierModel("sv"))) return;
    if (!mountedRef.current) return;
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
    stopCaptureOnly();
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
  const busy = dlDownloading || phase !== "idle";
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

  const enrollNeedDownload = !svReady || ((effectiveChoice === "tse" || (effectiveChoice === "auto" && bench?.tier === "tse")) && !tseReady);
  const autoNeedDownload = bench?.tier === "tse" ? !(svReady && tseReady) : bench?.tier === "sv" ? !svReady : false;
  const tierCards: ReadonlyArray<{
    id: "auto" | "sv" | "tse";
    title: string;
    desc: string;
    badge?: string;
    status: string;
    ready: boolean;
  }> = [
    {
      id: "auto",
      title: "自动匹配（省心默认）",
      desc: "不用手动挑：自动采用本机推荐的声纹模型，高负载时自动降级不断流",
      status: autoNeedDownload ? "点此准备模型" : "默认推荐",
      ready: !autoNeedDownload,
    },
    {
      id: "sv",
      title: `灵巧声纹 · ${svSizeMb} MB`,
      desc: "识别你本人或首个说话人，中端与主流机型最稳、不吞字",
      badge: bench?.tier === "sv" ? "本机推荐" : undefined,
      status: svReady ? "已下载" : "点此下载",
      ready: svReady,
    },
    {
      id: "tse",
      title: `旗舰声纹分离 · ${modelSizeMb} MB`,
      desc: "额外叠加实时波形分离，适合骁龙 8 系等旗舰处理器",
      badge: bench?.tier === "tse" ? "本机推荐" : undefined,
      status: svReady && tseReady ? "已下载" : svReady ? "点此补齐" : "点此下载",
      ready: svReady && tseReady,
    },
  ];

  return (
    <PageBackground>
      <Stack.Screen options={{ title: "只认我的声音" }} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxxl }}>
        <Card style={{ paddingVertical: space.xs }}>
          {voiceprint || legacy ? (
            <>
              <Row
                icon="shield-account-outline"
                title="只认我的声音"
                sub={
                  legacy
                    ? "声纹引擎已升级，请重录一次以启用"
                    : voiceFilter
                      ? "已开启 · 按已录声纹识别本人并抑制旁人说话"
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
              <Divider />
            </>
          ) : null}
          <Row
            icon="account-lock-outline"
            title="未录声纹只认第一个说话人"
            sub={
              voiceFilter && voiceprint && !legacy
                ? voiceFirstSpeaker
                  ? "已开启（当前已启用个人声纹，个人声纹优先）"
                  : "个人声纹关闭时，自动锁定每通电话首位开口的人"
                : voiceFirstSpeaker
                  ? "已开启 · 自动锁定首个说话人，抑制之后旁人插话"
                  : `关闭 · 开着时自动屏蔽旁人（需 ${svSizeMb} MB 灵巧声纹模型）`
            }
            right={
              <Toggle
                label="未录声纹只认第一个说话人"
                value={voiceFirstSpeaker}
                disabled={busy}
                onChange={(v) => void toggleFirstSpeaker(v)}
              />
            }
          />
        </Card>

        <Card style={{ padding: space.lg, gap: space.md }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
            <Text style={{ fontFamily: fonts.cute, fontSize: 18, color: p.ink }}>声纹模型档位</Text>
            <PocketButton variant="text" size="sm" disabled={benchBusy || busy} loading={benchBusy} onPress={() => void runBenchmark()}>
              {benchBusy ? "检测中" : "重测算力"}
            </PocketButton>
          </View>

          <View style={{ backgroundColor: p.surface2, borderRadius: radius.md, padding: space.md, gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
              <Pill tone={bench ? "good" : "plain"} text={bench ? `已按本机算力推荐：${TIER_TITLE[bench.tier]}` : benchBusy ? "正在检测芯片算力…" : "尚未检测性能"} />
            </View>
            <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 19 }}>
              {bench?.reason || "检测仅需不到 1 秒，保持「自动匹配」即可按本机芯片自动选中最优方案。"}
            </Text>
          </View>

          <View style={{ gap: space.sm }}>
            {tierCards.map((c) => {
              const selected = effectiveChoice === c.id;
              return (
                <Pressable
                  key={c.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: busy }}
                  disabled={busy}
                  onPress={() => void chooseTier(c.id)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.md,
                    padding: space.md,
                    borderRadius: radius.md,
                    backgroundColor: pressed ? p.surface3 : selected ? p.surface2 : p.surface,
                    borderWidth: 1.5,
                    borderColor: selected ? p.primary : p.divider,
                  })}
                >
                  <View
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 9,
                      borderWidth: 2,
                      borderColor: selected ? p.primary : p.faint,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {selected ? <View style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: p.primary }} /> : null}
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Text style={{ color: p.ink, fontFamily: fonts.bodySemi, fontSize: 13.5 }}>{c.title}</Text>
                      {c.badge ? <Pill tone="good" text={c.badge} /> : null}
                    </View>
                    <Text style={{ color: p.faint, fontSize: 12, lineHeight: 17 }}>{c.desc}</Text>
                  </View>
                  <Pill tone={c.ready ? (selected ? "good" : "plain") : "soft"} text={c.status} />
                </Pressable>
              );
            })}
          </View>
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

          {enrolledDetails && !dlDownloading && phase === "idle" ? (
            <Text style={{ color: p.faint, fontSize: 12, fontVariant: ["tabular-nums"] }}>{enrolledDetails}</Text>
          ) : null}

          {dlDownloading ? (
            <View style={{ gap: space.sm }}>
              <Text style={{ color: p.ink, fontSize: 14 }}>
                正在后台下载{dlLabel}，{Math.round(dlProgress * 100)}%
              </Text>
              <PocketProgress progress={dlProgress} height={8} />
              <Text style={{ color: p.faint, fontSize: 12, lineHeight: 17 }}>
                默认在后台下载，返回其他页面不会中断进度。
              </Text>
              <PocketButton variant="ghost" onPress={cancelMobileVoiceModelDownload} style={{ alignSelf: "flex-end" }}>
                取消下载
              </PocketButton>
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
                <PocketButton variant="ghost" grow disabled={phase === "finishing"} onPress={cancelEnroll}>
                  取消
                </PocketButton>
                <PocketButton disabled={seconds < 3.8 || phase === "finishing"} loading={phase === "finishing"} onPress={finishEnroll} style={{ flex: 2 }}>
                  完成录入
                </PocketButton>
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
                      ? `匹配录入的声纹 · 相似度 ${(testResult.score * 100).toFixed(0)}%`
                      : `未匹配录入的声纹 · 相似度 ${(testResult.score * 100).toFixed(0)}%`
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
              <PocketButton variant="soft" onPress={endTest}>
                结束测试
              </PocketButton>
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
              {!svReady ? (
                <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20 }}>
                  首次录入只需要先下载约 {svSizeMb} MB 的灵巧声纹模型；模型和录音都只留在你的手机里，不会上传。
                </Text>
              ) : (
                <View style={{ backgroundColor: p.surface2, borderRadius: radius.md, padding: space.md, gap: space.xs }}>
                  <Text style={{ color: p.muted, fontSize: 12.5 }}>找个安静的地方，对着手机自然说 6–15 秒就行：</Text>
                  <Text style={{ color: p.ink, fontSize: 14, lineHeight: 21 }}>{SAMPLE_LINES[0]}</Text>
                </View>
              )}
              <PocketButton size="lg" onPress={beginEnroll}>
                {enrollNeedDownload
                  ? legacy
                    ? "下载模型并重录"
                    : "下载推荐模型并录制"
                  : legacy
                    ? "重新录制以启用新声纹"
                    : voiceprint
                      ? "重新录制声纹"
                      : "录制我的声音"}
              </PocketButton>
              {voiceprint || legacy ? (
                <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
                  {!legacy ? (
                    <PocketButton variant="soft" grow onPress={beginTest}>
                      测一下效果
                    </PocketButton>
                  ) : null}
                  <PocketButton variant="text" danger onPress={() => setAskClear(true)}>
                    清除声纹
                  </PocketButton>
                </View>
              ) : null}
            </View>
          )}
        </Card>

        <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 19, paddingHorizontal: space.xs }}>
          开启声纹过滤后，手机会优先使用与性能匹配的过滤方案；即使旗舰人声分离在个别机型上负载过高，也会自动平滑切回灵巧声纹门控，不会再突然全静音。修改设置从下一通电话生效。
        </Text>

        {error ? (
          <View style={{ gap: space.sm, alignItems: "center" }}>
            <Text style={{ color: p.error, fontSize: 13.5, lineHeight: 20, textAlign: "center" }}>{error}</Text>
            {error.includes("系统设置") ? (
              <PocketButton size="sm" variant="soft" onPress={() => void Linking.openSettings()}>
                打开系统设置
              </PocketButton>
            ) : null}
          </View>
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
