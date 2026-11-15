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

/**
 * Tabs not in view are paused (React Activity): their effects, timers and animations stop, and a
 * theme switch or relay snapshot does not render them. Pausing and resuming wait two frames after
 * the switch: resuming re-attaches the effects of a whole screen, which for a long agent list took
 * longer than the switch itself, so the tab is drawn first and resumes right after.
 */
function PauseWhenHidden({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  const [mode, setMode] = useState<"visible" | "hidden">(focused ? "visible" : "hidden");
  useEffect(() => {
    const next = focused ? "visible" : "hidden";
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setMode(next));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [focused]);
  return (
    <Activity mode={mode}>
      <PausedContents style={CONTENTS}>{children}</PausedContents>
    </Activity>
  );
}
const pauseWhenHidden = ({ children }: { children: ReactNode }) => <PauseWhenHidden>{children}</PauseWhenHidden>;

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
