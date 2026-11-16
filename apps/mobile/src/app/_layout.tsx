import { useEffect } from "react";
import { Platform, View } from "react-native";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import { Nunito_400Regular, Nunito_600SemiBold, Nunito_700Bold } from "@expo-google-fonts/nunito";
import { ZCOOLKuaiLe_400Regular } from "@expo-google-fonts/zcool-kuaile";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeRoot, usePalette } from "../theme/theme";
import { useSettings } from "../lib/store";
import { loadToken } from "../lib/auth";
import { startLink, stopLink } from "../lib/relay";
import { isMockServer } from "../lib/mock";
import { startAppLog } from "../lib/applog";
import { fonts } from "../theme/tokens";
import { useAlertSync } from "../lib/alerts";
import { IconTile } from "../components/ui";
import { useHarnessIconSync } from "../lib/harnessRemote";
import { syncNativeVoice } from "../lib/voice";

SplashScreen.preventAutoHideAsync().catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 2_000, refetchOnWindowFocus: false } },
});

/** Opens the relay socket whenever a server + token are known. */
function useRelayLink() {
  const hydrated = useSettings((s) => s.hydrated);
  const server = useSettings((s) => s.server);
  // Re-pairing on the same server issues a new token: the device id changes, so the link must restart.
  const deviceId = useSettings((s) => s.deviceId);
  useEffect(() => {
    if (!hydrated) return;
    if (!server) {
      stopLink();
      return;
    }
    let cancelled = false;
    (async () => {
      const token = isMockServer(server) ? "mock-token" : await loadToken();
      if (!cancelled && token) startLink(server, token);
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated, server, deviceId]);
}

function Navigator() {
  const p = usePalette();
  useRelayLink();
  useAlertSync();
  useHarnessIconSync();
  return (
    <>
      <StatusBar style={p.dark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerTransparent: false,
          headerStyle: { backgroundColor: p.pageTop },
          headerTintColor: p.ink,
          headerTitleStyle: { fontFamily: fonts.cute, color: p.ink, fontSize: 18 },
          headerBackButtonDisplayMode: "minimal",
          // The app's own back button instead of the system arrow.
          headerLeft: ({ canGoBack }) =>
            canGoBack ? (
              <View style={{ marginRight: 10 }}>
                <IconTile icon="back" tone="plain" size={40} onPress={() => router.back()} a11y="返回" />
              </View>
            ) : null,
          contentStyle: { backgroundColor: p.page },
          // iOS takes the status bar from each screen, not from <StatusBar>: without these a page with a
          // header follows the navigation theme (light) and one without follows the system, not the app's theme.
          ...(Platform.OS === "ios"
            ? { statusBarStyle: p.dark ? "light" : "dark", headerUserInterfaceStyle: p.dark ? "dark" : "light" }
            : null),
        }}
      >
        {/* Paused while an agent or another screen covers it: snapshots render it later, its animations stop. */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} activityEnabled={1} />
        <Stack.Screen name="connect" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="scan" options={{ title: "扫一扫", animation: "slide_from_bottom" }} />
        <Stack.Screen name="pair" options={{ title: "连接", animation: "fade" }} />
        <Stack.Screen name="join" options={{ title: "让它加入", animation: "fade" }} />
        <Stack.Screen name="pair-new" options={{ title: "邀请设备", animation: "slide_from_bottom" }} />
        <Stack.Screen name="agent/[key]" options={{ title: "" }} />
        <Stack.Screen name="assistant" options={{ headerShown: false, animation: "none" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [loaded, error] = useFonts({
    Nunito_400Regular,
    Nunito_600SemiBold,
    Nunito_700Bold,
    ZCOOLKuaiLe_400Regular,
    [fonts.mono]: require("../../assets/fonts/MapleMono-Regular.ttf"),
    [fonts.monoBold]: require("../../assets/fonts/MapleMono-Bold.ttf"),
  });
  const hydrated = useSettings((s) => s.hydrated);
  // Neither goes back once true, so this stays true once reached.
  const ready = (loaded || !!error) && hydrated;

  // The phone's own log goes to the relay every minute and when the app is put away.
  useEffect(() => startAppLog(), []);

  useEffect(() => {
    if (ready) {
      syncNativeVoice();
      SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [ready]);

  if (!ready) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeRoot>
        <Navigator />
      </ThemeRoot>
    </QueryClientProvider>
  );
}
