import { useMemo, useState } from "react";
import { FlatList, View } from "react-native";
import { Button, Dialog, IconButton, Menu, Portal, Text } from "react-native-paper";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { Device } from "@herdr-pocket/protocol";
import { ConnectionBanner } from "../../components/agents";
import { Card, EmptyState, PageBackground, PageTitle, SectionHeader } from "../../components/ui";
import { useLive, useSettings } from "../../lib/store";
import { loadToken } from "../../lib/auth";
import { revokeDevice } from "../../lib/relay";
import { friendlyError } from "../../lib/session";
import { relTime } from "../../lib/format";
import { usePalette } from "../../theme/theme";
import { fonts, radius, space } from "../../theme/tokens";

const PLATFORM_ICON: Record<string, "apple" | "linux" | "microsoft-windows" | "cellphone" | "laptop" | "android"> = {
  darwin: "apple",
  linux: "linux",
  win32: "microsoft-windows",
  ios: "cellphone",
  android: "android",
};
const PLATFORM_LABEL: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows", ios: "iOS", android: "Android" };

function DeviceRow({ d, isSelf, agentCount, onRevoke }: { d: Device; isSelf: boolean; agentCount: number; onRevoke: () => void }) {
  const p = usePalette();
  const [menu, setMenu] = useState(false);
  const icon = PLATFORM_ICON[d.platform ?? ""] ?? (d.kind === "host" ? "laptop" : "cellphone");
  const sub = [PLATFORM_LABEL[d.platform ?? ""] ?? d.platform, d.kind === "host" ? `${agentCount} 个 agent` : "手机端", d.online ? "在线" : `离线 · ${relTime(d.lastSeenAt)}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <Card
      onPress={d.kind === "host" ? () => router.navigate({ pathname: "/agents", params: { host: d.id } }) : undefined}
      accessibilityLabel={`${d.name}，${d.online ? "在线" : "离线"}`}
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, paddingLeft: space.lg, paddingRight: space.xs, minHeight: 72, backgroundColor: d.online ? p.surface : p.surface2 }}
    >
      <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: d.kind === "host" ? p.lavenderContainer : p.accentContainer, alignItems: "center", justifyContent: "center", opacity: d.online ? 1 : 0.55 }}>
        <MaterialCommunityIcons name={icon} size={21} color={p.ink} />
        <View style={{ position: "absolute", right: -1, bottom: -1, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: p.surface, backgroundColor: d.online ? "#3FB68B" : p.faint }} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: fonts.bodyBold, fontSize: 16, color: d.online ? p.ink : p.muted }}>
            {d.name}
          </Text>
          {isSelf ? (
            <View style={{ backgroundColor: p.accentContainer, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 1 }}>
              <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 11.5 }}>这台</Text>
            </View>
          ) : null}
        </View>
        <Text numberOfLines={1} style={{ fontSize: 13, color: d.online ? p.muted : p.faint }}>
          {sub}
        </Text>
      </View>
      {isSelf ? (
        <View style={{ width: 44 }} />
      ) : (
        <Menu
          visible={menu}
          onDismiss={() => setMenu(false)}
          anchor={<IconButton icon="dots-vertical" accessibilityLabel={`${d.name} 的更多操作`} onPress={() => setMenu(true)} style={{ margin: 0 }} />}
          contentStyle={{ backgroundColor: p.surface, borderRadius: radius.md }}
        >
          <Menu.Item
            leadingIcon="link-off"
            title="移除这台设备"
            titleStyle={{ color: p.error, fontFamily: fonts.bodySemi }}
            onPress={() => {
              setMenu(false);
              onRevoke();
            }}
          />
        </Menu>
      )}
    </Card>
  );
}

export default function DevicesScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const devices = useLive((s) => s.devices);
  const agents = useLive((s) => s.agents);
  const self = useLive((s) => s.self);
  const server = useSettings((s) => s.server);
  const [target, setTarget] = useState<Device | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const list = useMemo(
    () => Object.values(devices).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "host" ? -1 : 1) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    [devices],
  );
  const hosts = list.filter((d) => d.kind === "host");
  const viewers = list.filter((d) => d.kind === "viewer");
  const online = list.filter((d) => d.online).length;

  async function revoke() {
    if (!target || !server) return;
    setBusy(true);
    setError(null);
    try {
      const token = (await loadToken()) ?? "mock-token";
      await revokeDevice(server, token, target.id);
      setTarget(null);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  const rows: Array<{ kind: "header"; title: string } | { kind: "device"; d: Device }> = [
    ...(hosts.length ? [{ kind: "header" as const, title: "电脑" }, ...hosts.map((d) => ({ kind: "device" as const, d }))] : []),
    ...(viewers.length ? [{ kind: "header" as const, title: "手机和其他客户端" }, ...viewers.map((d) => ({ kind: "device" as const, d }))] : []),
  ];

  return (
    <PageBackground>
      <View style={{ paddingTop: insets.top + space.sm }}>
        <ConnectionBanner />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r, i) => (r.kind === "header" ? `h${i}` : r.d.id)}
        renderItem={({ item }) =>
          item.kind === "header" ? (
            <SectionHeader title={item.title} />
          ) : (
            <View style={{ marginBottom: space.sm }}>
              <DeviceRow d={item.d} isSelf={item.d.id === self?.id} agentCount={agents[item.d.id]?.length ?? 0} onRevoke={() => setTarget(item.d)} />
            </View>
          )
        }
        ListHeaderComponent={
          <View style={{ gap: space.lg }}>
            <PageTitle sub={`${list.length} 台设备，${online} 台在线`}>我的设备</PageTitle>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Button mode="contained" icon="qrcode-scan" onPress={() => router.push("/scan")} contentStyle={{ height: 50 }} style={{ flex: 1, borderRadius: radius.pill }} labelStyle={{ fontSize: 16 }}>
                扫一扫
              </Button>
              <Button mode="contained-tonal" icon="qrcode" onPress={() => router.push("/pair-new")} contentStyle={{ height: 50 }} style={{ flex: 1, borderRadius: radius.pill }} labelStyle={{ fontSize: 16 }}>
                邀请设备
              </Button>
            </View>
            <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 18, paddingHorizontal: space.xs }}>
              加电脑：在那台电脑上运行 herdr-pocket up，扫它显示的二维码。加手机：点“邀请设备”，让对方扫你的二维码。
            </Text>
          </View>
        }
        ListEmptyComponent={<EmptyState mood="sleepy" title="还没有设备" body="用上面的“扫一扫”或“邀请设备”把电脑和手机加进来。" />}
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xxl }}
      />
      <Portal>
        <Dialog visible={!!target} onDismiss={() => setTarget(null)} style={{ borderRadius: radius.xl, backgroundColor: p.surface }}>
          <Dialog.Title style={{ fontFamily: fonts.cute, color: p.ink }}>移除“{target?.name}”？</Dialog.Title>
          <Dialog.Content style={{ gap: space.sm }}>
            <Text style={{ color: p.muted, lineHeight: 22 }}>
              它会马上断开，授权作废，之后要重新配对才能再连上。{target?.kind === "host" ? "这台电脑上的 agent 也会从列表里消失。" : ""}
            </Text>
            {error ? <Text style={{ color: p.error }}>{error}</Text> : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setTarget(null)} textColor={p.ink}>
              取消
            </Button>
            <Button textColor={p.error} loading={busy} onPress={revoke}>
              移除并断开
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </PageBackground>
  );
}
