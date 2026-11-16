import { Activity, useEffect, useState, type ReactNode } from "react";
import { Redirect, Tabs, useIsFocused } from "expo-router";
import type { BottomTabBarButtonProps } from "expo-router/js-tabs";
import { NativeComponentRegistry, Pressable, View, type ViewStyle } from "react-native";
import { CuteIcon, type CuteIconName } from "../../components/icons";
import { useSettings, useLive, allAgents } from "../../lib/store";
import { useAssistant } from "../../lib/assistant";
import { UpdatePrompt } from "../../components/UpdatePrompt";
import { usePalette } from "../../theme/theme";
import { fonts } from "../../theme/tokens";

/** Tab icon; the open tab sits in a soft pink pill. */
function TabIcon({ name, focused, color }: { name: CuteIconName; focused: boolean; color: string }) {
  const p = usePalette();
  return (
    <View style={{ width: 54, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", backgroundColor: focused ? p.accentContainer : "transparent" }}>
      <CuteIcon name={name} size={22} color={color} fill={focused ? (p.dark ? p.surface : "#FFFFFF") : "none"} strokeWidth={2} />
    </View>
  );
}

/**
 * Tab button without React Navigation's default Android ripple (a borderless
 * gray circle). The open tab's pink pill is the selection cue; a press gives
 * the same small squash as the app's other buttons.
 */
function TabButton({ ref: _ref, href: _href, android_ripple: _ripple, pressColor: _pressColor, pressOpacity: _pressOpacity, hoverEffect: _hover, style, children, ...rest }: BottomTabBarButtonProps) {
  return (
    <Pressable {...rest} style={({ pressed }) => [style, { transform: [{ scale: pressed ? 0.94 : 1 }] }]}>
      {children}
    </Pressable>
  );
}

/**
 * The views of a paused tab stay on screen: React pauses an Activity by giving its top view
 * display: none, and this view turns any display into "contents" (as Expo Router's own
 * activityEnabled does), so a tab shows at once while it is still being resumed.
 */
const PausedContents = NativeComponentRegistry.get<{ style: ViewStyle; children: ReactNode }>("HerdrPocketPausedContents", () => ({
  uiViewClassName: "RCTView",
  // @ts-expect-error: React Native's attribute types do not list nested style processors.
  validAttributes: { style: { display: { process: () => "contents" } } },
}));
const CONTENTS: ViewStyle = { display: "contents" };

/** updatedAt / lastSeenAt move with every relay heartbeat without changing a row. */
const steady = (key: string, value: unknown) => (key === "updatedAt" || key === "lastSeenAt" ? undefined : value);
let lastPrint: { from: unknown[]; print: string } | null = null;
/**
 * What the Agents list is drawn from, as one string: taken when the tab is paused and again when it
 * comes back (once per store change, not on every relay snapshot while hidden). Other tabs have none
 * and always resume with the switch.
 */
function fingerprint(tab: string): string | null {
  if (tab !== "agents") return null;
  const { agents, devices, link } = useLive.getState();
  const { showShells, hostFilter, foldedGroups } = useSettings.getState();
  const from = [agents, devices, link, showShells, hostFilter, foldedGroups];
  if (!lastPrint || from.some((x, i) => x !== lastPrint!.from[i])) lastPrint = { from, print: JSON.stringify(from, steady) };
  return lastPrint.print;
}

/**
 * Tabs not in view are paused (React Activity): their effects, timers and animations stop, and a
 * theme switch or relay snapshot does not render them. Resuming re-attaches the effects of a whole
 * screen, which for a long agent list took longer than the switch itself. So when nothing the Agents
 * list shows has changed while it was away, it is drawn first and resumes two frames later; when
 * something has (a status, the order, a count), it resumes with the switch, so its first frame is
 * already current and no row moves after it appears. Pausing also waits two frames.
 */
function PauseWhenHidden({ tab, children }: { tab: string; children: ReactNode }) {
  const focused = useIsFocused();
  const [state, setState] = useState<{ mode: "visible" | "hidden"; shown?: string | null }>({ mode: focused ? "visible" : "hidden" });
  if (focused && state.mode === "hidden" && (state.shown == null || state.shown !== fingerprint(tab))) setState({ mode: "visible" });
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() =>
        setState((s) => (focused ? (s.mode === "visible" ? s : { mode: "visible" }) : { mode: "hidden", shown: fingerprint(tab) })),
      );
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [focused, tab]);
  return (
    <Activity mode={state.mode}>
      <PausedContents style={CONTENTS}>{children}</PausedContents>
    </Activity>
  );
}
const pauseWhenHidden = ({ route, children }: { route: { name: string }; children: ReactNode }) => (
  <PauseWhenHidden tab={route.name}>{children}</PauseWhenHidden>
);

export default function TabsLayout() {
  const p = usePalette();
  const server = useSettings((s) => s.server);
  const needsYou = useLive((s) => allAgents(s.agents).filter((a) => a.status === "blocked").length);
  // Waiting for a yes/no, plus what the assistant said on its own while this tab was not open.
  const pendingActions = useAssistant((s) => s.items.filter((i) => i.action?.state === "pending").length + s.unread);
  if (!server) return <Redirect href="/connect" />;

  return (
    <>
      <Tabs
        screenLayout={pauseWhenHidden}
        screenOptions={{
          headerShown: false,
          tabBarHideOnKeyboard: true,
          tabBarButton: (props) => <TabButton {...props} />,
          tabBarActiveTintColor: p.accentText,
          tabBarInactiveTintColor: p.faint,
          tabBarLabelStyle: { fontFamily: fonts.bodyBold, fontSize: 11, marginTop: 2 },
          tabBarStyle: {
            borderTopWidth: 0,
            backgroundColor: p.surface,
            elevation: 0,
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "助理",
            tabBarBadge: pendingActions || undefined,
            tabBarBadgeStyle: { backgroundColor: p.primary, color: p.onPrimary, fontFamily: fonts.bodyBold, fontSize: 11 },
            tabBarIcon: ({ color, focused }) => <TabIcon name="chat" focused={focused} color={color as string} />,
          }}
        />
        <Tabs.Screen
          name="agents"
          options={{
            title: "Agents",
            tabBarBadge: needsYou || undefined,
            tabBarBadgeStyle: { backgroundColor: p.primary, color: p.onPrimary, fontFamily: fonts.bodyBold, fontSize: 11 },
            tabBarIcon: ({ color, focused }) => <TabIcon name="robot" focused={focused} color={color as string} />,
          }}
        />
        <Tabs.Screen
          name="devices"
          options={{ title: "设备", tabBarIcon: ({ color, focused }) => <TabIcon name="laptop" focused={focused} color={color as string} /> }}
        />
        <Tabs.Screen
          name="settings"
          options={{ title: "设置", tabBarIcon: ({ color, focused }) => <TabIcon name="gear" focused={focused} color={color as string} /> }}
        />
      </Tabs>
      <UpdatePrompt />
    </>
  );
}
