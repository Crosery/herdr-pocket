import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "react-native-paper";
import { router, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useLive, useSettings } from "../lib/store";
import { loadToken } from "../lib/auth";
import { persistTutorialStatus } from "../lib/relay";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";

interface MobileTourStep {
  id: string;
  route: "/devices" | "/agents" | "/" | "/settings";
  badge: string;
  icon: "laptop" | "robot-outline" | "chat-processing-outline" | "cog-outline";
  title: string;
  body: string;
  actionHint: string;
  extraAction?: { label: string; run: () => void };
}

const STEPS: MobileTourStep[] = [
  {
    id: "devices",
    route: "/devices",
    badge: "添加电脑与配对",
    icon: "laptop",
    title: "先看「设备」页：添加电脑与扫码配对",
    body: "这里显示所有已接入的电脑与手机。点顶部「添加设备」可拿到电脑端安装命令或生成配对二维码；点任意在线电脑即可只看那台电脑的 Agent。",
    actionHint: "当前已切到真实「设备」页，可以直接点「添加设备」试试",
    extraAction: {
      label: "打开添加设备",
      run: () => router.push("/pair-new"),
    },
  },
  {
    id: "agents",
    route: "/agents",
    badge: "空间、Agent 与新建",
    icon: "robot-outline",
    title: "在「Agents」页按空间管理并远程新建任务",
    body: "粉色「需要你」表示 AI 正在等你回答或确认，点开就能一键点选方案或切终端视图；点右上角/悬浮「+」可以直接在在线电脑上新建空间、终端或 AI 助手。",
    actionHint: "当前已切到真实「Agents」页，点开任意任务或点下一步继续",
  },
  {
    id: "assistant",
    route: "/",
    badge: "小羊全局助理",
    icon: "chat-processing-outline",
    title: "找「助理」小羊汇总进度与语音对话",
    body: "电脑上开了十几个任务也不用挨个翻：小羊会自动播报进展与待确认事项，还支持直接发消息或语音通话下达指令。",
    actionHint: "当前已切到真实「助理」页，点下一步看最后一步",
  },
  {
    id: "settings",
    route: "/settings",
    badge: "设置与随时重温",
    icon: "cog-outline",
    title: "随时在「设置」调整外观与重温引导",
    body: "对话展示密度、小窗样式、后台提醒、声纹过滤与电脑端组件更新都在这里。以后想再看一遍引导，随时点设置里的「重温新手引导」即可。",
    actionHint: "你刚才看的全部都是真实页面，点完成即可开始使用",
  },
];

export function MobileWalkthroughOverlay() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const server = useSettings((s) => s.server);
  const hydrated = useSettings((s) => s.hydrated);
  const tutorialStatus = useSettings((s) => s.tutorialStatus);
  const synced = useLive((s) => s.tutorialServerSynced);
  const replayOpen = useLive((s) => s.tutorialReplayOpen);
  const [graceElapsed, setGraceElapsed] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!hydrated || !server || tutorialStatus !== 0 || synced) {
      setGraceElapsed(false);
      return;
    }
    const t = setTimeout(() => setGraceElapsed(true), 1200);
    return () => clearTimeout(t);
  }, [hydrated, server, synced, tutorialStatus]);

  const autoOpen = Boolean(hydrated && server && !replayOpen && tutorialStatus === 0 && (synced || graceElapsed));
  const active = replayOpen || autoOpen;
  const mode: "replay" | "auto" = replayOpen ? "replay" : "auto";

  // Keep the real screen navigated to the active step's tab when stepping through.
  useEffect(() => {
    if (!active) return;
    const target = STEPS[step];
    if (!target) return;
    const isTabRoute = pathname === "/" || pathname === "/agents" || pathname === "/devices" || pathname === "/settings";
    if (isTabRoute && pathname !== target.route) {
      router.navigate(target.route);
    }
  }, [active, step]);

  if (!active) return null;

  const cur = STEPS[Math.min(step, STEPS.length - 1)]!;
  const isLast = step >= STEPS.length - 1;

  const closeTour = async (kind: "complete" | "skip") => {
    setStep(0);
    if (mode === "replay") {
      useLive.setState({ tutorialReplayOpen: false });
      return;
    }
    const token = await loadToken();
    await persistTutorialStatus(server, token, kind === "complete" ? 2 : 1);
    if (kind === "complete") {
      router.navigate("/agents");
    }
  };

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: space.md,
        right: space.md,
        bottom: Math.max(66, 58 + insets.bottom) + space.sm,
        zIndex: 90,
      }}
    >
      <View
        style={{
          backgroundColor: p.surface,
          borderRadius: radius.card,
          borderWidth: 1.5,
          borderColor: p.primary,
          padding: space.md,
          gap: 8,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 10 },
          shadowOpacity: p.dark ? 0.45 : 0.18,
          shadowRadius: 18,
          elevation: 10,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              backgroundColor: p.accentContainer,
              borderRadius: radius.pill,
              paddingHorizontal: 10,
              paddingVertical: 3,
            }}
          >
            <MaterialCommunityIcons name={cur.icon} size={13} color={p.accentText} />
            <Text style={{ fontFamily: fonts.bodyBold, fontSize: 11.5, color: p.accentText }}>
              {step + 1} / {STEPS.length} · {cur.badge}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={mode === "replay" ? "退出引导" : "跳过引导"}
            onPress={() => void closeTour(mode === "replay" ? "complete" : "skip")}
            style={{ paddingHorizontal: 8, paddingVertical: 3 }}
          >
            <Text style={{ fontSize: 12, fontFamily: fonts.bodyBold, color: p.muted }}>
              {mode === "replay" ? "退出" : "跳过"}
            </Text>
          </Pressable>
        </View>

        <Text style={{ fontFamily: fonts.bodyBold, fontSize: 15, color: p.ink, lineHeight: 21 }}>{cur.title}</Text>
        <Text style={{ fontSize: 12.5, color: p.muted, lineHeight: 19 }}>{cur.body}</Text>

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            backgroundColor: p.surface2,
            borderRadius: radius.md,
            paddingHorizontal: 10,
            paddingVertical: 7,
          }}
        >
          <MaterialCommunityIcons name="compass-outline" size={14} color={p.accentText} />
          <Text style={{ flex: 1, fontSize: 12, fontFamily: fonts.bodyBold, color: p.accentText }}>{cur.actionHint}</Text>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, paddingTop: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            {step > 0 ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setStep((s) => Math.max(0, s - 1))}
                style={{ paddingHorizontal: 10, paddingVertical: 7, borderRadius: radius.md, backgroundColor: p.surface2 }}
              >
                <Text style={{ fontSize: 12.5, fontFamily: fonts.bodyBold, color: p.ink }}>上一步</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {cur.extraAction ? (
              <Pressable
                accessibilityRole="button"
                onPress={cur.extraAction.run}
                style={{ paddingHorizontal: 11, paddingVertical: 7, borderRadius: radius.md, backgroundColor: p.accentContainer }}
              >
                <Text style={{ fontSize: 12.5, fontFamily: fonts.bodyBold, color: p.accentText }}>{cur.extraAction.label}</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (isLast) void closeTour("complete");
                else setStep((s) => Math.min(STEPS.length - 1, s + 1));
              }}
              style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.md, backgroundColor: p.primary }}
            >
              <Text style={{ fontSize: 12.5, fontFamily: fonts.bodyBold, color: p.onPrimary }}>
                {isLast ? "完成引导" : "下一步"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}
