import { useEffect, useState } from "react";
import { AppState, Image, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Text } from "react-native-paper";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { PROTOCOL_VERSION } from "@herdr-pocket/protocol";
import { Card, PageBackground, PageTitle, SectionHeader } from "../../components/ui";
import { Row, RowDivider as Divider, Toggle, type RowIcon as IconName } from "../../components/rows";
import { ConfigSnackbar } from "../../components/configParts";
import { PocketDialog, PocketProgress, PocketSegmented, PocketSpinner } from "../../components/pocket";
import { HostToolsSheet } from "../../components/HostToolsSheet";
import { Bow, Mascot } from "../../components/Mascot";
import { useLive, useSettings, type ThemeMode } from "../../lib/store";
import { signOut } from "../../lib/session";
import { isMockServer } from "../../lib/mock";
import { loadAssistant, setAssistantConfirm, useAssistant } from "../../lib/assistant";
import { useAssistantConfig, useConfigWatch, VOICE_LABEL } from "../../lib/assistantConfig";
import { alertsInBackground, alertsSupported, askNotificationPermission, refreshAlertState, useAlerts } from "../../lib/alerts";
import { checkForUpdate, currentVersion, downloadUpdate, installUpdate, resumeInstallIfAllowed, updatesSupported, useNewRelease, useUpdate } from "../../lib/update";
import { isVoiceprintLegacy, syncNativeVoice, voiceprintSupported } from "../../lib/voice";
import { horizontalPad } from "../../lib/layoutMetrics";
import { PocketNative } from "../../../modules/pocket-native";
import { usePalette } from "../../theme/theme";
import { fonts, radius, space } from "../../theme/tokens";

const LINK_TEXT = { idle: "未连接", connecting: "连接中…", online: "已连接", offline: "断开了，重连中", unauthorized: "授权失效" } as const;
const SCALES = [
  { value: 0.85, label: "小", glyph: 13 },
  { value: 1, label: "标准", glyph: 16 },
  { value: 1.15, label: "大", glyph: 19 },
  { value: 1.3, label: "特大", glyph: 22 },
] as const;
const THEMES: { value: ThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];
const PORTRAIT = require("../../../assets/mascot/default.png");

export default function SettingsScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  // Each setting is read where it is shown (ThemeChoice, TextScaleChoice, AlertsCard, ShellsRow), so
  // changing one redraws its own card, not the whole page.
  const server = useSettings((x) => x.server);
  const deviceName = useSettings((x) => x.deviceName);
  const link = useLive((x) => x.link);
  const rtt = useLive((x) => x.rttMs);
  const [confirm, setConfirm] = useState(false);
  const [hostToolsOpen, setHostToolsOpen] = useState(false);
  const askFirst = useAssistant((x) => x.confirm);
  const assistantLoaded = useAssistant((x) => x.loaded);
  const [askError, setAskError] = useState<string | null>(null);
  useEffect(() => {
    if (!useAssistant.getState().loaded) void loadAssistant();
  }, []);
  useEffect(() => {
    refreshAlertState();
    // Coming back from system settings: show what changed, and carry on with an update install.
    const sub = AppState.addEventListener("change", (st) => {
      if (st !== "active") return;
      refreshAlertState();
      resumeInstallIfAllowed();
    });
    return () => sub.remove();
  }, []);

  const demo = isMockServer(server);
  const linkColor = link === "online" ? "#3FB68B" : link === "connecting" ? p.lavender : p.error;
  const padLeft = horizontalPad(space.lg, insets.left);
  const padRight = horizontalPad(space.lg, insets.right);

  async function leave() {
    setConfirm(false);
    await signOut();
    router.replace("/connect");
  }

  return (
    <PageBackground>
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + space.xl, paddingLeft: padLeft, paddingRight: padRight, paddingBottom: space.xxxl }}>
        <PageTitle sub="让小羊更合你心意">设置</PageTitle>

        {/* This phone: who it is, where it is connected, how the line is. */}
        <View
          style={{
            marginTop: space.lg,
            borderRadius: radius.xl,
            shadowColor: p.shadow,
            shadowOpacity: p.dark ? 0.3 : 0.16,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 8 },
            elevation: p.dark ? 0 : 3,
            backgroundColor: p.surface,
          }}
        >
          <LinearGradient
            colors={p.dark ? ["#4A2B3A", "#352C4A"] : ["#FFE3EC", "#EDE4FF"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ borderRadius: radius.xl, padding: space.lg, flexDirection: "row", alignItems: "center", gap: space.lg, overflow: "hidden" }}
          >
            <View style={{ width: 84, height: 84, flexShrink: 0, borderRadius: 42, backgroundColor: p.surface, padding: 3 }}>
              {link === "online" || demo ? (
                <Image source={PORTRAIT} style={{ width: 78, height: 78, borderRadius: 39 }} accessibilityLabel="小羊" />
              ) : (
                <View style={{ width: 78, height: 78, borderRadius: 39, alignItems: "center", justifyContent: "center", backgroundColor: p.surface2 }}>
                  <Mascot mood="sleepy" size={62} />
                </View>
              )}
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 5, paddingRight: 34 }}>
              <Text numberOfLines={1} style={{ fontFamily: fonts.cute, fontSize: 21, lineHeight: 28, color: p.ink }}>
                {deviceName ?? "这台手机"}
              </Text>
              <Text numberOfLines={1} style={{ color: p.muted, fontSize: 12.5, fontFamily: demo ? fonts.body : fonts.mono }}>
                {demo ? "演示模式" : (server ?? "").replace(/^https?:\/\//, "")}
              </Text>
              <View
                accessibilityLabel={`连接状态：${LINK_TEXT[link]}`}
                style={{ alignSelf: "flex-start", marginTop: 3, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: p.surface, borderRadius: radius.pill, paddingHorizontal: 11, paddingVertical: 5 }}
              >
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: linkColor }} />
                <Text style={{ color: p.ink, fontSize: 12.5, fontFamily: fonts.bodySemi }}>
                  {LINK_TEXT[link]}
                  {link === "online" && rtt != null ? ` · 延迟 ${rtt} ms` : ""}
                </Text>
              </View>
            </View>
            <View pointerEvents="none" style={{ position: "absolute", right: 16, top: 12, transform: [{ rotate: "16deg" }] }}>
              <Bow size={46} />
            </View>
          </LinearGradient>
        </View>

        <SectionHeader title="外观" />
        <Card style={{ paddingVertical: space.xs }}>
          <Row icon="theme-light-dark" title="主题" sub="浅色、深色，或者跟着系统走">
            <ThemeChoice />
          </Row>
          <Divider />
          <Row icon="format-size" title="对话字号" sub="聊天和 agent 对话里文字的大小">
            <TextScaleChoice />
          </Row>
          <Divider />
          <ChatDisplayModeChoice />
        </Card>

        <SectionHeader title="助理提醒" />
        <AlertsCard demo={demo} />

        <SectionHeader title="小羊办事" />
        <Card style={{ paddingVertical: space.xs }}>
          <Row
            icon="comment-question-outline"
            title="小羊动手前先问我"
            sub={
              askError
                ? `没改成：${askError}`
                : askFirst === null
                  ? assistantLoaded
                    ? "服务器还不支持这个设置，更新服务器后可用"
                    : "正在读取…"
                  : askFirst === "always"
                    ? "发消息、按键、开新 agent 前先等你点确认。打电话时不等，直接办"
                    : "关着：小羊直接去办，办完照实告诉你结果"
            }
            dim={askFirst === null}
            right={
              <Toggle
                label="小羊动手前先问我"
                value={askFirst === "always"}
                disabled={askFirst === null}
                onChange={async (v) => {
                  setAskError(null);
                  try {
                    await setAssistantConfirm(v ? "always" : "never");
                  } catch (e) {
                    setAskError((e as Error).message);
                  }
                }}
              />
            }
          />
        </Card>

        <SectionHeader title="小羊的模型和说话方式" />
        <AssistantConfigCard />

        <SectionHeader title="通话声音" />
        <VoiceLocalCard demo={demo} />

        <SectionHeader title="列表" />
        <Card style={{ paddingVertical: space.xs }}>
          <ShellsRow />
        </Card>

        <SectionHeader title="连接" />
        <Card style={{ paddingVertical: space.xs }}>
          <Row icon="server-network" title="更换服务器 / 重新配对" sub="换一台服务器，或者让这台手机重新授权" onPress={() => setConfirm(true)} />
        </Card>

        <SectionHeader title="版本" />
        <Card style={{ paddingVertical: space.xs }}>
          {updatesSupported ? (
            <UpdateRow demo={demo} />
          ) : (
            <Row icon="update" title="当前版本" sub={`v${currentVersion()}；iOS 版不在 App 里更新`} />
          )}
          <Divider />
          <Row
            icon="laptop"
            title="电脑端组件更新"
            sub="查看并直接更新已连接电脑上的 hc、Herdr、uniflo 与守护进程"
            onPress={() => setHostToolsOpen(true)}
          />
        </Card>

        <View style={{ alignItems: "center", gap: 6, paddingTop: space.xxxl }}>
          <Bow size={24} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <View style={{ width: 44, height: 1, backgroundColor: p.divider }} />
            <Text style={{ fontFamily: fonts.cute, fontSize: 18, color: p.accentText }}>Herdr Pocket</Text>
            <View style={{ width: 44, height: 1, backgroundColor: p.divider }} />
          </View>
          <Text style={{ color: p.faint, fontSize: 12.5 }}>
            版本 {currentVersion()} · 协议 v{PROTOCOL_VERSION}
          </Text>
        </View>
      </ScrollView>

      <PocketDialog
        visible={confirm}
        onDismiss={() => setConfirm(false)}
        title="要重新配对吗？"
        body="这台手机的授权会作废，并从设备列表里移除。服务器地址会保留，之后扫码或输入一个新的配对码就能连回来。"
        actions={[
          { label: "取消", onPress: () => setConfirm(false), tone: "ghost" },
          { label: "重新配对", onPress: () => void leave(), tone: "danger" },
        ]}
      />
      {/* A save made on a config screen just closed, or another phone's change. */}
      <ConfigSnackbar message={null} onDismiss={() => undefined} />
      <HostToolsSheet visible={hostToolsOpen} onDismiss={() => setHostToolsOpen(false)} />
    </PageBackground>
  );
}

function ThemeChoice() {
  const { width } = useWindowDimensions();
  const themeMode = useSettings((x) => x.themeMode);
  const set = useSettings((x) => x.set);
  return (
    <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: width < 360 ? space.sm : space.md, paddingTop: space.md }}>
      {THEMES.map((t) => (
        <ThemeTile key={t.value} mode={t.value} label={t.label} selected={themeMode === t.value} onPress={() => set({ themeMode: t.value })} />
      ))}
    </View>
  );
}

const CHAT_MODE_OPTIONS = [
  { value: "compact", label: "精简" },
  { value: "standard", label: "标准" },
  { value: "expanded", label: "全展示" },
] as const;

const CHAT_MODE_SUB = {
  compact: "精简：把思考过程和连续工具折叠为一条",
  standard: "标准：文字思考独立成块，连续工具归到同一个标签",
  expanded: "全展示：独立展示每次思考与各个工具调用",
} as const;

function ChatDisplayModeChoice() {
  const mode = useSettings((x) => x.chatDisplayMode);
  const set = useSettings((x) => x.set);
  return (
    <Row icon="view-agenda-outline" title="对话展示模式" sub={CHAT_MODE_SUB[mode]}>
      <View style={{ paddingTop: space.sm }}>
        <PocketSegmented
          compact
          segments={CHAT_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={mode}
          onChange={(v) => set({ chatDisplayMode: v as "compact" | "standard" | "expanded" })}
        />
      </View>
    </Row>
  );
}

/** The four sizes and a sample bubble in the chosen one. */
function TextScaleChoice() {
  const p = usePalette();
  const { width } = useWindowDimensions();
  const textScale = useSettings((x) => x.textScale);
  const set = useSettings((x) => x.set);
  return (
    <>
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: width < 360 ? space.sm : space.md, paddingTop: space.md }}>
        {SCALES.map((x) => {
          const on = textScale === x.value;
          return (
            <Pressable
              key={x.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`字号${x.label}`}
              onPress={() => set({ textScale: x.value })}
              style={{ width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center", backgroundColor: on ? p.primary : p.surface3, borderWidth: on ? 0 : 1, borderColor: p.divider }}
            >
              <Text style={{ fontFamily: fonts.bodyBold, fontSize: x.glyph, lineHeight: x.glyph + 6, color: on ? p.onPrimary : p.muted }}>A</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm, paddingTop: space.md }}>
        <Mascot size={30} />
        <View style={{ flexShrink: 1, minWidth: 0, backgroundColor: p.surface3, borderRadius: radius.md, borderBottomLeftRadius: 5, paddingHorizontal: space.md, paddingVertical: 7 }}>
          <Text style={{ color: p.ink, fontSize: 15.5 * textScale, lineHeight: 22 * textScale }}>迁移脚本跑完了，测试全过。</Text>
        </View>
      </View>
    </>
  );
}

function AlertsCard({ demo }: { demo: boolean }) {
  const alertsOn = useSettings((x) => x.alertsOn);
  const alertBlocked = useSettings((x) => x.alertBlocked);
  const alertDone = useSettings((x) => x.alertDone);
  const set = useSettings((x) => x.set);
  const alerts = useAlerts();
  const alertsLine = !alertsSupported
    ? "需要装新版 App"
    : demo
      ? "演示模式没有提醒"
      : !alertsOn
        ? "关着：只有打开 App 时才知道"
        : alerts.connected
          ? alertsInBackground
            ? "在线：App 关着也会提醒你"
            : "在线：App 开着时提醒你；iOS 上关掉 App 就收不到"
          : "正在连接服务器…";
  // iOS keeps no background connection: alerts only while the app is open.
  const alertsTitle = alertsInBackground ? "后台提醒" : "提醒";
  return (
    <Card style={{ paddingVertical: space.xs }}>
      <Row
        icon="bell-outline"
        title={alertsTitle}
        sub={alertsLine}
        right={
          <Toggle
            label={alertsTitle}
            value={alertsOn}
            disabled={!alertsSupported}
            onChange={async (v) => {
              set({ alertsOn: v });
              if (v) await askNotificationPermission();
            }}
          />
        }
      />
      <Divider />
      <Row
        icon="hand-back-left-outline"
        title="agent 在等你时"
        sub="要你确认、要你回答的时候"
        dim={!alertsOn}
        right={<Toggle label="agent 在等你时提醒" value={alertBlocked} disabled={!alertsOn} onChange={(v) => set({ alertBlocked: v })} />}
      />
      <Divider />
      <Row
        icon="check-circle-outline"
        title="agent 跑完时"
        sub="小羊先去看一眼，再告诉你结果"
        dim={!alertsOn}
        right={<Toggle label="agent 跑完时提醒" value={alertDone} disabled={!alertsOn} onChange={(v) => set({ alertDone: v })} />}
      />
      {alertsSupported && alertsOn && !alerts.notificationsAllowed ? (
        <>
          <Divider />
          <Row icon="bell-off-outline" tone="error" title="通知被关掉了" sub="去系统设置里允许 Herdr Pocket 发通知" onPress={() => PocketNative?.openNotificationSettings()} />
        </>
      ) : null}
      {alertsSupported && alertsOn && !alerts.batteryUnrestricted ? (
        <>
          <Divider />
          <Row icon="battery-heart-outline" title="允许在后台运行" sub="不然系统省电时会把提醒断掉。点这里，选“允许”或“无限制”" onPress={() => PocketNative?.requestBatteryExemption()} />
        </>
      ) : null}
      {alertsSupported && alertsOn ? (
        <>
          <Divider />
          <Row icon="bell-ring-outline" title="发一条测试提醒" sub="看看通知能不能送到这台手机" onPress={() => PocketNative?.testNotice("小羊：测试提醒", "能看到这条，说明 agent 的提醒也能送到。")} />
        </>
      ) : null}
    </Card>
  );
}

function ShellsRow() {
  const showShells = useSettings((x) => x.showShells);
  const set = useSettings((x) => x.set);
  return (
    <Row
      icon="console-line"
      title="显示普通终端"
      sub="没在跑 agent 的 shell 窗口"
      right={<Toggle label="显示普通终端" value={showShells} onChange={(v) => set({ showShells: v })} />}
    />
  );
}

/**
 * The assistant's models, voice and prompts, shared by every phone: one row
 * each, saying what is in use now. Kept fresh while the tab is in view.
 */
function AssistantConfigCard() {
  useConfigWatch("config");
  useConfigWatch("prompts");
  const config = useAssistantConfig((x) => x.config);
  const configError = useAssistantConfig((x) => x.configError);
  const prompts = useAssistantConfig((x) => x.prompts);
  const promptsError = useAssistantConfig((x) => x.promptsError);
  const main = config?.models[0];
  const spare = (config?.models.length ?? 1) - 1;
  const modelsLine = config
    ? main
      ? `${main.model}${spare ? ` · 另有 ${spare} 个备用` : " · 没有备用"}${config.warnings.length ? ` · ${config.warnings.length} 处要看一下` : ""}`
      : "还没有模型，小羊没法回话"
    : (configError ?? "正在读取…");
  const v = config?.voice;
  const voiceLine = v ? (v.provider ? `${VOICE_LABEL[v.provider]}${v.voice ? ` · ${v.voice}` : ""}${v.key.set ? "" : " · 还没有密钥"}` : "关着：不能打电话") : (configError ?? "正在读取…");
  const edited = prompts?.filter((x) => x.edited).length ?? 0;
  const promptsLine = prompts ? (edited ? `改过 ${edited} 段，共 ${prompts.length} 段` : `共 ${prompts.length} 段，都是默认的`) : (promptsError ?? "正在读取…");
  return (
    <Card style={{ paddingVertical: space.xs }}>
      <Row icon="brain" title="模型" sub={modelsLine} dim={!config} onPress={() => router.push("/assistant-config/models")} />
      <Divider />
      <Row icon="account-voice" title="语音" sub={voiceLine} dim={!config} onPress={() => router.push("/assistant-config/voice")} />
      <Divider />
      <Row icon="text-box-edit-outline" title="提示词" sub={promptsLine} dim={!prompts} onPress={() => router.push("/assistant-config/prompts")} />
    </Card>
  );
}

/** Check for a new version, download it with progress, then install. */
function UpdateRow({ demo }: { demo: boolean }) {
  const p = usePalette();
  const { phase, progress, note } = useUpdate();
  const release = useNewRelease();
  const version = currentVersion();
  const mb = release?.size ? ` · ${(release.size / 1048576).toFixed(0)} MB` : "";
  const sub =
    demo && phase === "idle"
      ? "演示模式不检查更新"
      : phase === "checking"
        ? "正在看有没有新版本…"
        : phase === "downloading"
          ? `正在下载 v${release?.version ?? ""}，${Math.round(progress * 100)}%`
          : phase === "permission"
            ? "先在系统设置里允许 Herdr Pocket 安装应用，回来就会接着装"
            : phase === "ready"
              ? (note ?? "下载好了，点这里安装")
              : release
                ? (note ?? `有新版本 v${release.version}${mb}，点这里更新`)
                : (note ?? (phase === "latest" ? `已经是最新版 v${version}` : `当前 v${version}，点一下看看有没有新版本`));
  const onPress =
    phase === "checking" || phase === "downloading"
      ? undefined
      : phase === "ready" || phase === "permission"
        ? installUpdate
        : release
          ? () => void downloadUpdate()
          : () => void checkForUpdate(true);
  const badge = release && phase === "available" ? "更新" : phase === "ready" ? "安装" : null;
  const right =
    phase === "checking" || phase === "downloading" ? (
      <PocketSpinner size={18} />
    ) : badge ? (
      <View style={{ backgroundColor: p.primary, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 5 }}>
        <Text style={{ color: p.onPrimary, fontFamily: fonts.bodyBold, fontSize: 12.5 }}>{badge}</Text>
      </View>
    ) : undefined;
  return (
    <Row icon={release ? "cellphone-arrow-down" : "update"} title={release ? "有新版本" : "检查更新"} sub={sub} right={right} onPress={onPress}>
      {phase === "downloading" ? (
        <PocketProgress progress={progress} style={{ marginTop: space.sm }} />
      ) : release?.notes && phase === "available" ? (
        <Text numberOfLines={4} style={{ color: p.faint, fontSize: 12.5, lineHeight: 18, paddingTop: space.xs }}>
          {release.notes}
        </Text>
      ) : null}
    </Row>
  );
}

function VoiceLocalCard({ demo }: { demo: boolean }) {
  const voiceDenoise = useSettings((x) => x.voiceDenoise);
  const voiceFilter = useSettings((x) => x.voiceFilter);
  const voiceFirstSpeaker = useSettings((x) => x.voiceFirstSpeaker);
  const voiceprint = useSettings((x) => x.voiceprint);
  const set = useSettings((x) => x.set);
  const ok = voiceprintSupported || demo;
  const legacy = isVoiceprintLegacy(voiceprint) || (!demo && !voiceprint && Boolean(PocketNative?.voiceState?.()?.legacyEnrolled));
  const vpSub = !ok
    ? "需要装新版 App"
    : legacy
      ? "声纹引擎已升级，请重录一次"
      : voiceprint
        ? voiceFilter
          ? `已开启 · 实时提取你的声纹人声（约 ${Math.round(voiceprint.seconds)} 秒）`
          : `已录入（约 ${Math.round(voiceprint.seconds)} 秒）· 暂时关闭`
        : voiceFirstSpeaker
          ? "已开启首个说话人锁定 · 自动屏蔽旁人插话"
          : "未录入 · 任何人说话或外放都会传给小羊";
  return (
    <Card style={{ paddingVertical: space.xs }}>
      <Row
        icon="waveform"
        title="通话降噪"
        sub={!ok ? "需要装新版 App" : voiceDenoise ? "已开启 · 实时滤除环境杂音并增强人声清晰度" : "已关闭 · 原样传给语音模型"}
        dim={!ok}
        right={
          <Toggle
            label="通话降噪"
            value={voiceDenoise}
            disabled={!ok}
            onChange={(v) => {
              set({ voiceDenoise: v });
              syncNativeVoice();
            }}
          />
        }
      />
      <Divider />
      <Row icon="shield-account-outline" title="只认我的声音" sub={vpSub} dim={!ok} onPress={ok ? () => router.push("/voiceprint") : undefined} />
    </Card>
  );
}

/** A tiny phone showing what the theme looks like. */
function ThemeTile({ mode, label, selected, onPress }: { mode: ThemeMode; label: string; selected: boolean; onPress: () => void }) {
  const p = usePalette();
  const light = { bg: "#FFF6F9", bar: "#FFC2D6", line: "#F1E4EC", icon: "#B8336A" };
  const dark = { bg: "#27212F", bar: "#FF7EA8", line: "#3A3246", icon: "#C9B6F7" };
  const half = (c: typeof light, icon: IconName | null) => (
    <View style={{ flex: 1, backgroundColor: c.bg, padding: 5, gap: 4, alignItems: "center" }}>
      <View style={{ alignSelf: "stretch", height: 5, borderRadius: 3, backgroundColor: c.bar }} />
      <View style={{ alignSelf: "stretch", height: 4, borderRadius: 2, backgroundColor: c.line }} />
      <View style={{ flex: 1, justifyContent: "center" }}>{icon ? <MaterialCommunityIcons name={icon} size={16} color={c.icon} /> : null}</View>
    </View>
  );
  return (
    <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected }} accessibilityLabel={`主题：${label}`} onPress={onPress} style={{ alignItems: "center", gap: 6 }}>
      <View style={{ padding: 3, borderRadius: 15, borderWidth: 2, borderColor: selected ? p.primary : "transparent" }}>
        <View style={{ width: 50, height: 72, borderRadius: 10, overflow: "hidden", flexDirection: "row", borderWidth: 1, borderColor: p.divider }}>
          {mode === "system" ? (
            <>
              {half(light, "white-balance-sunny")}
              {half(dark, "moon-waning-crescent")}
            </>
          ) : mode === "light" ? (
            half(light, "white-balance-sunny")
          ) : (
            half(dark, "moon-waning-crescent")
          )}
        </View>
        {selected ? (
          <View style={{ position: "absolute", right: -5, bottom: -5, width: 20, height: 20, borderRadius: 10, backgroundColor: p.primary, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: p.surface }}>
            <MaterialCommunityIcons name="check" size={12} color={p.onPrimary} />
          </View>
        ) : null}
      </View>
      <Text style={{ fontSize: 12.5, fontFamily: selected ? fonts.bodyBold : fonts.body, color: selected ? p.ink : p.muted }}>{label}</Text>
    </Pressable>
  );
}
