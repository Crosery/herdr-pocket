import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  compareVersions,
  type Device,
  type HostToolId,
  type HostTools,
  type ToolUpdateJobSnapshot,
} from "@herdr-pocket/protocol";
import { call } from "../lib/relay";
import { friendlyError } from "../lib/session";
import { relTime } from "../lib/format";
import { useLive } from "../lib/store";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";
import { PocketButton, PocketSpinner } from "./pocket";
import { Card, PageBackground } from "./ui";

type DisplayToolId = "app" | "herdr" | "hc" | "uniflo";

const TOOLS: Array<{ id: DisplayToolId; label: string }> = [
  { id: "app", label: "Herdr 桌面版" },
  { id: "herdr", label: "Herdr 终端" },
  { id: "hc", label: "hc" },
  { id: "uniflo", label: "uniflo" },
];

const PLATFORM_LABEL: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

function bare(v: string): string {
  return v.match(/\d+(?:\.\d+)+(?:-[\w.]+)?/)?.[0] ?? v;
}

function newerOf(tools: HostTools, id: DisplayToolId): string | null {
  const have = tools[id];
  const latest = tools.latest?.[id];
  return have && latest && compareVersions(bare(latest), bare(have)) > 0 ? bare(latest) : null;
}

export function HostToolsSheet({
  visible,
  host,
  onDismiss,
}: {
  visible: boolean;
  host?: Device | null;
  onDismiss: () => void;
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const devices = useLive((s) => s.devices);
  const hostList = useMemo(
    () =>
      Object.values(devices)
        .filter((d) => d.kind === "host")
        .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    [devices],
  );
  const [pickedId, setPickedId] = useState<string>("");
  const activeHost = host ?? hostList.find((h) => h.id === pickedId) ?? hostList[0] ?? null;

  const [tools, setTools] = useState<HostTools | null>(null);
  const [hostVersion, setHostVersion] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ToolUpdateJobSnapshot | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const loadHost = useCallback(
    async (target: Device | null, activeCheck = false) => {
      if (!target || !target.online) {
        setTools(null);
        setHostVersion(target?.version ?? "");
        return;
      }
      if (activeCheck) setChecking(true);
      else setLoading(true);
      setError(null);
      try {
        if (activeCheck) {
          try {
            const res = await call(target.id, "tools.check", {}, 15_000);
            setTools(res.tools ?? {});
            setHostVersion(res.hostVersion ?? target.version ?? "");
            return;
          } catch {
            // Fall back to host.info on older daemons.
          }
        }
        const info = await call(target.id, "host.info", {}, 8_000);
        setTools(info.tools ?? {});
        setHostVersion(info.version ?? target.version ?? "");
      } catch (e) {
        setError(friendlyError(e));
      } finally {
        setLoading(false);
        setChecking(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!visible) {
      stopPolling();
      return;
    }
    setJob(null);
    setNote(null);
    void loadHost(activeHost, false);
  }, [activeHost?.id, activeHost?.online, loadHost, stopPolling, visible]);

  const finishJob = useCallback(
    (snap: ToolUpdateJobSnapshot) => {
      stopPolling();
      setJob(snap);
      if (snap.tools) setTools(snap.tools);
      if (snap.hostVersion) setHostVersion(snap.hostVersion);
      const failed = snap.completed.filter((c) => !c.ok);
      const updated = snap.completed.filter((c) => c.ok && (c.status === "updated" || c.status === "restarting"));
      if (failed.length > 0) {
        setNote(failed.map((f) => `${f.id}: ${f.message}`).join("；"));
      } else if (updated.length > 0) {
        setNote(updated.map((u) => `${u.id}: ${u.message}`).join("；"));
      } else {
        setNote("所有选定组件已是最新版本");
      }
      void loadHost(activeHost, false);
    },
    [activeHost, loadHost, stopPolling],
  );

  const runUpdate = useCallback(
    async (targets: HostToolId[]) => {
      if (!activeHost || !activeHost.online || job?.running) return;
      stopPolling();
      setError(null);
      setNote(null);
      setJob({
        jobId: "pending",
        running: true,
        targets,
        completed: [],
        current: targets[0],
        tools: tools ?? {},
        hostVersion: hostVersion || activeHost.version || "",
        startedAt: Date.now(),
      });
      try {
        const snap = await call(activeHost.id, "tools.update", { targets, waitMs: 4000 }, 20_000);
        setJob(snap);
        if (!snap.running) {
          finishJob(snap);
          return;
        }
        pollRef.current = setInterval(() => {
          void call(activeHost.id, "tools.updateStatus", { jobId: snap.jobId }, 8_000)
            .then((next) => {
              if (!next) return;
              setJob(next);
              if (!next.running) finishJob(next);
            })
            .catch(() => {});
        }, 1200);
      } catch (e) {
        stopPolling();
        setJob(null);
        setError(friendlyError(e));
      }
    },
    [activeHost, finishJob, hostVersion, job?.running, stopPolling, tools],
  );

  const installedTools = tools ? TOOLS.filter((t) => tools[t.id]) : [];
  const updateTargets = installedTools.filter((t) => Boolean(tools && newerOf(tools, t.id))).map((t) => t.id);
  const hostdLatest = tools?.latest?.hostd;
  const hostdUpdatable = Boolean(hostVersion && hostdLatest && compareVersions(bare(hostdLatest), bare(hostVersion)) > 0);
  const isJobRunning = Boolean(job?.running);
  const hostdResult = job?.completed.find((c) => c.id === "hostd");

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onDismiss}>
      <PageBackground>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: Math.max(insets.top, space.md),
            paddingHorizontal: space.lg,
            paddingBottom: space.md,
            borderBottomWidth: 1,
            borderBottomColor: p.divider,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontFamily: fonts.cute, fontSize: 20, color: p.ink }}>电脑组件版本与更新</Text>
            {activeHost ? (
              <Text numberOfLines={1} style={{ fontSize: 12.5, color: p.muted }}>
                {activeHost.name} · {PLATFORM_LABEL[activeHost.platform ?? ""] ?? activeHost.platform ?? "未知平台"}
                {activeHost.online ? " · 在线" : " · 离线"}
              </Text>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭"
            onPress={onDismiss}
            style={({ pressed }) => ({
              width: 40,
              height: 40,
              borderRadius: 20,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? p.surface3 : p.surface2,
            })}
          >
            <MaterialCommunityIcons name="close" size={20} color={p.ink} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + space.xxl, gap: space.md }}>
          {!host && hostList.length > 1 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
              {hostList.map((h) => {
                const selected = h.id === activeHost?.id;
                return (
                  <Pressable
                    key={h.id}
                    onPress={() => setPickedId(h.id)}
                    style={{
                      paddingHorizontal: space.md,
                      paddingVertical: 8,
                      borderRadius: radius.pill,
                      backgroundColor: selected ? p.primary : p.surface,
                      borderWidth: 1,
                      borderColor: selected ? p.primary : p.divider,
                    }}
                  >
                    <Text style={{ fontFamily: fonts.bodyBold, fontSize: 13, color: selected ? p.onPrimary : p.ink }}>
                      {h.name}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}

          {!activeHost ? (
            <Card style={{ padding: space.lg }}>
              <Text style={{ color: p.muted, fontSize: 14 }}>还没有已配对的电脑设备。</Text>
            </Card>
          ) : !activeHost.online ? (
            <Card style={{ padding: space.lg }}>
              <Text style={{ color: p.muted, fontSize: 14 }}>{activeHost.name} 当前离线，电脑上线后可检查并更新组件。</Text>
            </Card>
          ) : (
            <>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <PocketButton
                  size="sm"
                  variant="ghost"
                  icon="refresh"
                  loading={checking}
                  disabled={isJobRunning}
                  onPress={() => void loadHost(activeHost, true)}
                >
                  检查更新
                </PocketButton>
                {updateTargets.length > 0 ? (
                  <PocketButton
                    size="sm"
                    variant="primary"
                    icon="update"
                    loading={isJobRunning}
                    onPress={() => void runUpdate(updateTargets)}
                  >
                    {`一键更新 (${updateTargets.length})`}
                  </PocketButton>
                ) : null}
              </View>

              {error ? (
                <Card style={{ padding: space.md, backgroundColor: p.errorContainer }}>
                  <Text style={{ color: p.error, fontSize: 13.5 }}>{error}</Text>
                </Card>
              ) : null}

              {note ? (
                <Card style={{ padding: space.md, backgroundColor: p.accentContainer }}>
                  <Text style={{ color: p.accentText, fontSize: 13.5 }}>{note}</Text>
                </Card>
              ) : null}

              {loading && !tools ? (
                <View style={{ paddingVertical: space.xl, alignItems: "center", gap: space.sm }}>
                  <PocketSpinner size={24} />
                  <Text style={{ color: p.muted, fontSize: 13 }}>正在读取组件版本…</Text>
                </View>
              ) : (
                <Card style={{ padding: space.md, gap: space.sm }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6 }}>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Text style={{ fontFamily: fonts.bodyBold, fontSize: 15, color: p.ink }}>Pocket 守护进程 (hostd)</Text>
                      <Text style={{ fontSize: 13, color: p.muted }}>
                        当前 {hostVersion || "未知"}
                        {hostdLatest ? ` · 最新 ${hostdLatest}` : ""}
                      </Text>
                      {hostdResult ? (
                        <Text style={{ fontSize: 12, color: hostdResult.ok ? p.accentText : p.error }}>{hostdResult.message}</Text>
                      ) : null}
                    </View>
                    <PocketButton
                      size="sm"
                      variant={hostdUpdatable ? "primary" : "soft"}
                      loading={isJobRunning && job?.current === "hostd"}
                      disabled={isJobRunning}
                      onPress={() => void runUpdate(["hostd"])}
                    >
                      {hostdUpdatable ? "升级" : "检查/重装"}
                    </PocketButton>
                  </View>

                  {installedTools.map((t) => {
                    const ver = tools?.[t.id] ?? "";
                    const newer = tools ? newerOf(tools, t.id) : null;
                    const busyThis = isJobRunning && job?.current === t.id;
                    const done = job?.completed.find((c) => c.id === t.id);
                    return (
                      <View
                        key={t.id}
                        style={{
                          flexDirection: "row",
                          justifyContent: "space-between",
                          alignItems: "center",
                          paddingTop: space.sm,
                          borderTopWidth: 1,
                          borderTopColor: p.divider,
                          gap: space.sm,
                        }}
                      >
                        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                          <Text style={{ fontFamily: fonts.bodyBold, fontSize: 15, color: p.ink }}>{t.label}</Text>
                          <Text style={{ fontSize: 13, color: newer ? p.accentText : p.muted }}>
                            {newer ? `${ver} → ${newer}` : ver}
                          </Text>
                          {done ? (
                            <Text style={{ fontSize: 12, color: done.ok ? p.accentText : p.error }}>{done.message}</Text>
                          ) : null}
                        </View>
                        <PocketButton
                          size="sm"
                          variant={newer ? "primary" : "ghost"}
                          loading={busyThis}
                          disabled={isJobRunning}
                          onPress={() => void runUpdate([t.id])}
                        >
                          {newer ? `升级 ${newer}` : "检查/更新"}
                        </PocketButton>
                      </View>
                    );
                  })}

                  {tools?.latest?.checkedAt ? (
                    <Text style={{ fontSize: 11.5, color: p.faint, paddingTop: space.xs }}>
                      上次检查：{relTime(tools.latest.checkedAt)}
                    </Text>
                  ) : null}
                </Card>
              )}
            </>
          )}
        </ScrollView>
      </PageBackground>
    </Modal>
  );
}
