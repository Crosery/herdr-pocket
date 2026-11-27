import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, View } from "react-native";
import { Text } from "react-native-paper";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import type { Agent, AgentListeningPort, PortalItem, SubSession } from "@herdr-pocket/protocol";
import { call } from "../lib/relay";
import { agentTitle, relTime } from "../lib/format";
import { openSub, SUB_STATUS, subLabel, type Crumb } from "../lib/subnav";
import { showAppToast } from "../lib/store";
import { usePalette } from "../theme/theme";
import { fonts, radius, space, statusColors } from "../theme/tokens";
import { Card, EmptyState, HarnessAvatar } from "./ui";
import { PocketButton, PocketSpinner } from "./pocket";

/**
 * Per-instance runtime list:
 * - At root agent level (`!sub`): shows listening ports (`access-point`) + subagent sessions (`robot-outline`).
 * - Inside a nested subagent (`sub`): shows that subagent's own child subagents.
 */
export function SubagentList({
  agent,
  sub,
  trail,
  active,
  bottomInset,
  onOpenPortal,
  onPortalsChanged,
}: {
  agent: Agent;
  sub?: string;
  trail: Crumb[];
  active: boolean;
  bottomInset: number;
  onOpenPortal?: (item: PortalItem) => void;
  onPortalsChanged?: () => void;
}) {
  const p = usePalette();
  const [livePorts, setLivePorts] = useState<AgentListeningPort[] | null>(null);
  const [scanningPorts, setScanningPorts] = useState(false);
  const [busyPort, setBusyPort] = useState<number | null>(null);

  useEffect(() => {
    setLivePorts(null);
  }, [agent.key, agent.listeningPorts]);

  const ports = sub ? [] : (livePorts ?? agent.listeningPorts ?? []);

  const rescanPorts = useCallback(async () => {
    setScanningPorts(true);
    try {
      const res = await call(agent.deviceId, "agent.ports", { agent: agent.key, action: "list" });
      setLivePorts(res.ports ?? []);
    } catch {
      showAppToast("暂时无法刷新端口状态", { tone: "error" });
    } finally {
      setScanningPorts(false);
    }
  }, [agent.deviceId, agent.key]);

  const previewPort = useCallback(
    async (item: AgentListeningPort) => {
      const url = item.url || `http://127.0.0.1:${item.port}`;
      setBusyPort(item.port);
      try {
        const res = await call(agent.deviceId, "portal.open", {
          agent: agent.key,
          kind: "browser",
          url,
          title: item.title || `:${item.port} (${item.processName})`,
        });
        onPortalsChanged?.();
        onOpenPortal?.(res.item);
      } catch {
        showAppToast("无法打开远程预览，请检查电脑端连接", { tone: "error" });
      } finally {
        setBusyPort(null);
      }
    },
    [agent.deviceId, agent.key, onOpenPortal, onPortalsChanged],
  );

  const stopPort = useCallback(
    async (item: AgentListeningPort) => {
      setBusyPort(item.port);
      try {
        const res = await call(agent.deviceId, "agent.ports", {
          agent: agent.key,
          action: "stop",
          pid: item.pid,
          port: item.port,
        });
        setLivePorts(res.ports ?? []);
        showAppToast(`已停止 :${item.port} 服务`);
      } catch {
        showAppToast(`停止 :${item.port} 失败`, { tone: "error" });
      } finally {
        setBusyPort(null);
      }
    },
    [agent.deviceId, agent.key],
  );

  const copyPort = useCallback(async (item: AgentListeningPort) => {
    const url = item.url || `http://127.0.0.1:${item.port}`;
    await Clipboard.setStringAsync(url);
    showAppToast(`已复制 ${url}`);
  }, []);

  const q = useQuery({
    queryKey: ["session.children", agent.key, sub ?? null],
    queryFn: () => call(agent.deviceId, "session.children", { agent: agent.key, sub }),
    enabled: active,
    refetchInterval: active ? 5000 : false,
  });

  const list = q.data?.sessions ?? [];
  const good = statusColors("working", p.dark);

  const header = !sub ? (
    <View style={{ gap: space.md, marginBottom: space.md }}>
      <View style={{ gap: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <MaterialCommunityIcons name="access-point" size={16} color={good.fg} />
            <Text style={{ fontFamily: fonts.bodyBold, fontSize: 13.5, color: p.ink }}>
              运行中的端口 · {ports.length}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="刷新端口列表"
            disabled={scanningPorts}
            onPress={() => void rescanPorts()}
            hitSlop={8}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              minHeight: 32,
              paddingHorizontal: 10,
              borderRadius: radius.pill,
              backgroundColor: pressed ? p.surface3 : p.surface,
              borderWidth: 1,
              borderColor: p.divider,
            })}
          >
            {scanningPorts ? (
              <PocketSpinner size={12} />
            ) : (
              <MaterialCommunityIcons name="refresh" size={14} color={p.muted} />
            )}
            <Text style={{ fontSize: 12, fontFamily: fonts.bodySemi, color: p.muted }}>刷新</Text>
          </Pressable>
        </View>

        {ports.length > 0 ? (
          <Card style={{ paddingVertical: space.xs }}>
            {ports.map((item, idx) => {
              const url = item.url || `http://127.0.0.1:${item.port}`;
              const busy = busyPort === item.port;
              return (
                <View key={`${item.pid}-${item.port}`}>
                  {idx > 0 ? <View style={{ height: 1, backgroundColor: p.divider, marginHorizontal: space.md }} /> : null}
                  <View style={{ paddingHorizontal: space.md, paddingVertical: 11, gap: 8 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <View
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 4,
                          backgroundColor: good.bg,
                          borderRadius: radius.pill,
                          paddingHorizontal: 8,
                          paddingVertical: 3,
                        }}
                      >
                        <MaterialCommunityIcons name="access-point" size={12} color={good.fg} />
                        <Text style={{ color: good.fg, fontFamily: fonts.monoBold, fontSize: 12 }}>:{item.port}</Text>
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1} style={{ fontFamily: fonts.bodyBold, fontSize: 14, color: p.ink }}>
                          {item.title || item.processName || `服务 :${item.port}`}
                        </Text>
                        <Text numberOfLines={1} style={{ fontFamily: fonts.mono, fontSize: 11.5, color: p.faint }}>
                          {item.processName} · PID {item.pid} · {url.replace(/^https?:\/\//, "")}
                        </Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      {item.protocol === "http" && onOpenPortal ? (
                        <PocketButton
                          size="sm"
                          variant="soft"
                          icon="open-in-new"
                          loading={busy}
                          disabled={busy}
                          onPress={() => void previewPort(item)}
                        >
                          远程预览
                        </PocketButton>
                      ) : null}
                      <PocketButton
                        size="sm"
                        variant="ghost"
                        icon="content-copy"
                        disabled={busy}
                        onPress={() => void copyPort(item)}
                      >
                        复制地址
                      </PocketButton>
                      <View style={{ flex: 1 }} />
                      <PocketButton
                        size="sm"
                        variant="ghost"
                        danger
                        icon="stop-circle-outline"
                        disabled={busy}
                        onPress={() => void stopPort(item)}
                      >
                        停止
                      </PocketButton>
                    </View>
                  </View>
                </View>
              );
            })}
          </Card>
        ) : (
          <Card style={{ paddingHorizontal: space.md, paddingVertical: 12 }}>
            <Text style={{ fontSize: 12.5, color: p.faint }}>当前实例暂无监听端口服务，启动开发服务器后会自动出现。</Text>
          </Card>
        )}
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 2 }}>
        <MaterialCommunityIcons name="robot-outline" size={16} color={p.accentText} />
        <Text style={{ fontFamily: fonts.bodyBold, fontSize: 13.5, color: p.ink }}>
          子 Agent · {list.length}
        </Text>
      </View>
    </View>
  ) : null;

  if (q.isLoading && ports.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <PocketSpinner size={28} />
      </View>
    );
  }
  if (q.isError && ports.length === 0) {
    return (
      <EmptyState
        mood="waiting"
        title="子 agent 列表没拿到"
        body={(q.error as Error).message}
        action={
          <PocketButton variant="text" onPress={() => q.refetch()}>
            再试一次
          </PocketButton>
        }
      />
    );
  }

  return (
    <FlatList
      data={list}
      keyExtractor={(s) => s.key}
      ListHeaderComponent={header ?? undefined}
      renderItem={({ item }) => <SubRow s={item} onPress={() => openSub(agent.key, trail, item)} />}
      ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
      ListEmptyComponent={
        ports.length > 0 ? (
          <Card style={{ paddingHorizontal: space.md, paddingVertical: 14 }}>
            <Text style={{ fontSize: 13, color: p.muted }}>
              {q.isLoading ? "正在读取子 Agent 列表…" : q.isError ? `子 Agent 列表暂未拿到：${(q.error as Error).message}` : "这个实例还没有派出子 Agent。"}
            </Text>
          </Card>
        ) : (
          <EmptyState mood="sleepy" title="还没有子 agent" body="它派出子 agent 干活时，会出现在这里。" />
        )
      }
      contentContainerStyle={{ padding: space.lg, paddingBottom: bottomInset + space.xxl }}
    />
  );
}

function SubRow({ s, onPress }: { s: SubSession; onPress: () => void }) {
  const p = usePalette();
  const c = statusColors(s.status === "working" ? "working" : "idle", p.dark);
  const label = subLabel(s);
  const preview = s.preview?.trim().split("\n")[0];
  const metaParts = [
    s.model,
    s.children ? `${s.children} 个子任务` : null,
    relTime(s.statusSince ?? s.updatedAt),
  ].filter(Boolean);

  return (
    <Card
      onPress={onPress}
      accessibilityLabel={`子 agent ${label}，${SUB_STATUS[s.status]}`}
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, paddingLeft: space.lg, minHeight: 72 }}
    >
      <HarnessAvatar harness={s.harness} isShell={false} size={38} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <MaterialCommunityIcons name="robot-outline" size={14} color={p.accentText} />
          <Text numberOfLines={1} style={{ flex: 1, fontFamily: fonts.bodyBold, fontSize: 15, color: p.ink }}>
            {label}
          </Text>
        </View>
        {preview && preview !== label ? (
          <Text numberOfLines={1} style={{ fontSize: 13, color: p.muted }}>
            {preview}
          </Text>
        ) : null}
        {metaParts.length > 0 ? (
          <Text numberOfLines={1} style={{ fontSize: 11.5, color: p.faint }}>
            {metaParts.join(" · ")}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: "flex-end", gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: c.bg, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg }} />
          <Text style={{ color: c.fg, fontFamily: fonts.bodyBold, fontSize: 11.5 }}>{SUB_STATUS[s.status]}</Text>
        </View>
      </View>
    </Card>
  );
}

/** "主 agent > 子 > 孙" — earlier steps are tappable and pop back to that level. */
export function Breadcrumb({ agent, trail }: { agent: Agent; trail: Crumb[] }) {
  const p = usePalette();
  const steps = [{ k: agent.key, t: agentTitle(agent) }, ...trail];
  return (
    <View accessibilityRole="header" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2 }}>
      {steps.map((st, i) => {
        const last = i === steps.length - 1;
        const back = steps.length - 1 - i;
        return (
          <View key={st.k} style={{ flexDirection: "row", alignItems: "center", gap: 2, maxWidth: last ? "100%" : "45%" }}>
            {i > 0 ? <MaterialCommunityIcons name="chevron-right" size={14} color={p.faint} /> : null}
            <Pressable
              disabled={last}
              accessibilityRole={last ? "text" : "link"}
              accessibilityLabel={last ? `当前：${st.t}` : `回到 ${st.t}`}
              onPress={() => router.dismiss(back)}
              hitSlop={6}
              style={{ minHeight: 28, justifyContent: "center" }}
            >
              <Text numberOfLines={1} style={{ fontSize: 12.5, color: last ? p.ink : p.accentText, fontFamily: last ? fonts.bodyBold : fonts.bodySemi }}>
                {i === 0 ? `主 agent · ${st.t}` : st.t}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}
