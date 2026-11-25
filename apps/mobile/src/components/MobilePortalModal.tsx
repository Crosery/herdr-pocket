import { useCallback, useEffect, useState } from "react";
import { Image, Linking, Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  DIRECT_PORTAL_FS_PREFIX,
  type Agent,
  type FileEntry,
  type PortalFramePayload,
  type PortalInputAction,
  type PortalItem,
  type PortalStreamEvent,
} from "@herdr-pocket/protocol";
import { call, getDirectEndpoint, subscribe } from "../lib/relay";
import { friendlyError } from "../lib/session";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";
import { PocketButton, PocketSpinner } from "./pocket";
import { Card, PageBackground } from "./ui";

function kindIcon(kind: PortalItem["kind"]): "web" | "monitor" | "folder-open-outline" | "file-document-outline" {
  if (kind === "browser") return "web";
  if (kind === "window") return "monitor";
  if (kind === "reveal") return "folder-open-outline";
  return "file-document-outline";
}

function mapContainedTap(opts: {
  locationX: number;
  locationY: number;
  boxW: number;
  boxH: number;
  imgW?: number;
  imgH?: number;
}): { nx: number; ny: number } {
  const { locationX, locationY, boxW, boxH, imgW, imgH } = opts;
  if (boxW <= 0 || boxH <= 0) return { nx: 0.5, ny: 0.5 };
  let drawX = 0;
  let drawY = 0;
  let drawW = boxW;
  let drawH = boxH;
  if (imgW && imgH && imgW > 0 && imgH > 0) {
    const imgAspect = imgW / imgH;
    const boxAspect = boxW / boxH;
    if (boxAspect > imgAspect) {
      drawH = boxH;
      drawW = boxH * imgAspect;
      drawX = (boxW - drawW) / 2;
    } else {
      drawW = boxW;
      drawH = boxW / imgAspect;
      drawY = (boxH - drawH) / 2;
    }
  }
  return {
    nx: Math.min(1, Math.max(0, (locationX - drawX) / Math.max(1, drawW))),
    ny: Math.min(1, Math.max(0, (locationY - drawY) / Math.max(1, drawH))),
  };
}

const unsupportedPortalHosts = new Map<string, string>();

function hostVersionKey(hostId: string, appVersion?: string): string {
  return `${hostId}:${appVersion ?? ""}`;
}

export function useAgentPortals(hostId: string, agentKey: string, hostVersion?: string): {
  items: PortalItem[];
  unsupported: boolean;
  refresh: () => void;
} {
  const [items, setItems] = useState<PortalItem[]>([]);
  const verKey = hostVersionKey(hostId, hostVersion);
  const [unsupported, setUnsupported] = useState(() => unsupportedPortalHosts.get(hostId) === verKey);

  const refresh = useCallback(() => {
    if (unsupportedPortalHosts.get(hostId) === verKey) {
      setUnsupported(true);
      setItems([]);
      return;
    }
    void call(hostId, "portal.list", { agent: agentKey })
      .then((res) => {
        unsupportedPortalHosts.delete(hostId);
        setUnsupported(false);
        setItems(res.items ?? []);
      })
      .catch((e: { code?: string; message?: string }) => {
        if (e?.code === "unsupported" || /unknown method\s+portal\./i.test(String(e?.message ?? ""))) {
          unsupportedPortalHosts.set(hostId, verKey);
          setUnsupported(true);
          setItems([]);
        }
      });
  }, [agentKey, hostId, verKey]);

  useEffect(() => {
    refresh();
    if (unsupportedPortalHosts.get(hostId) === verKey) return;
    const unsub = subscribe(hostId, "portal", { agent: agentKey }, (raw) => {
      const ev = raw as Partial<PortalStreamEvent>;
      if (ev?.kind !== "portal_event" || !ev.item) return;
      const item = ev.item;
      setItems((prev) => {
        if (ev.action === "closed") return prev.filter((x) => x.id !== item.id);
        const idx = prev.findIndex((x) => x.id === item.id);
        if (idx < 0) return [item, ...prev];
        const next = [...prev];
        next[idx] = item;
        return next;
      });
    });
    return unsub;
  }, [agentKey, hostId, refresh, verKey]);

  return { items, unsupported, refresh };
}

export function MobilePortalBanner({
  agent,
  items,
  onOpenModal,
}: {
  agent: Agent;
  items: PortalItem[];
  onOpenModal: (item?: PortalItem) => void;
}) {
  const p = usePalette();
  const top = items[0];
  if (!top) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", paddingHorizontal: space.lg, paddingTop: 2 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="打开跨端回传画面"
          onPress={() => onOpenModal()}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: radius.pill,
            backgroundColor: pressed ? p.surface3 : p.surface2,
            borderWidth: 1,
            borderColor: p.divider,
          })}
        >
          <MaterialCommunityIcons name="monitor" size={14} color={p.accentText} />
          <Text style={{ fontSize: 12, fontFamily: fonts.bodyBold, color: p.accentText }}>回传窗口</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`展开回传窗口 ${top.title}`}
      onPress={() => onOpenModal(top)}
      style={({ pressed }) => ({
        marginHorizontal: space.lg,
        marginTop: space.xs,
        marginBottom: 2,
        paddingHorizontal: space.md,
        paddingVertical: 8,
        borderRadius: radius.md,
        backgroundColor: pressed ? p.surface3 : p.accentContainer,
        borderWidth: 1,
        borderColor: p.divider,
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
      })}
    >
      <MaterialCommunityIcons name={kindIcon(top.kind)} size={18} color={p.accentText} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontFamily: fonts.bodyBold, fontSize: 13.5, color: p.ink }}>
          {top.title}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 11.5, color: p.muted }}>
          {items.length > 1 ? `${items.length} 个回传会话 · ` : ""}
          {top.transportHint === "p2p" ? "P2P 直连优先" : "Relay 传输"} · 点击展开操作
        </Text>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={18} color={p.accentText} />
    </Pressable>
  );
}

export function MobilePortalModal({
  visible,
  agent,
  items,
  initialItem,
  onDismiss,
  onChanged,
}: {
  visible: boolean;
  agent: Agent;
  items: PortalItem[];
  initialItem?: PortalItem | null;
  onDismiss: () => void;
  onChanged: () => void;
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const [selectedId, setSelectedId] = useState<string | null>(initialItem?.id ?? null);
  const [itemPatch, setItemPatch] = useState<PortalItem | null>(null);
  const [frame, setFrame] = useState<PortalFramePayload | null>(null);
  const [boxSize, setBoxSize] = useState({ width: 320, height: 240 });
  const [urlInput, setUrlInput] = useState("");
  const [textInput, setTextInput] = useState("");
  const [newUrlInput, setNewUrlInput] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reveal / file preview state
  const [dirPath, setDirPath] = useState(agent.cwd || "~");
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [previewTitle, setPreviewTitle] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [p2pUrl, setP2pUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    if (initialItem) setSelectedId(initialItem.id);
    else if (!selectedId || !items.some((x) => x.id === selectedId)) setSelectedId(items[0]?.id ?? null);
  }, [initialItem, items, selectedId, visible]);

  const baseActive = items.find((x) => x.id === selectedId) ?? items[0] ?? null;
  const active = baseActive && itemPatch && itemPatch.id === baseActive.id ? itemPatch : baseActive;

  const fetchFrameOnce = useCallback(async () => {
    if (!active) return;
    try {
      const res = await call(agent.deviceId, "portal.frame", { portalId: active.id }, 12_000);
      if (res.item) setItemPatch(res.item);
      if (res.frame) setFrame(res.frame);
    } catch (e) {
      setErr(friendlyError(e));
    }
  }, [active, agent.deviceId]);

  useEffect(() => {
    if (!visible || !active) return;
    setErr(null);
    setItemPatch(null);
    setUrlInput(active.url ?? "");
    if (active.kind !== "browser" && active.kind !== "window") {
      setFrame(null);
      return;
    }
    let alive = true;
    void call(agent.deviceId, "portal.frame", { portalId: active.id }, 12_000)
      .then((res) => {
        if (!alive) return;
        if (res.item) setItemPatch(res.item);
        if (res.frame) setFrame(res.frame);
      })
      .catch(() => {});
    const unsub = subscribe(agent.deviceId, "portal", { portalId: active.id, fps: 10 }, (raw) => {
      const ev = raw as Partial<PortalStreamEvent>;
      if (!alive || !ev) return;
      if (ev.kind === "portal_event" && ev.item && ev.item.id === active.id) {
        setItemPatch(ev.item);
      } else if (ev.kind === "portal_frame" && ev.portalId === active.id && ev.data) {
        setFrame(ev as PortalFramePayload);
      }
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [active?.id, active?.kind, active?.url, agent.deviceId, visible]);

  const loadPreviewFile = useCallback(
    async (relOrAbs: string) => {
      setPreviewTitle(relOrAbs.split(/[\\/]/).pop() || relOrAbs);
      setPreviewText(null);
      setPreviewImg(null);
      setP2pUrl(null);
      try {
        const ep = getDirectEndpoint(agent.deviceId);
        if (ep) {
          const ticket = await call(agent.deviceId, "portal.fileTicket", { agent: agent.key, path: relOrAbs });
          const host = ep.addr.includes(":") ? `[${ep.addr}]` : ep.addr;
          const entry = ticket.entryPath ? `/${encodeURIComponent(ticket.entryPath)}` : "";
          setP2pUrl(`http://${host}:${ep.port}${DIRECT_PORTAL_FS_PREFIX}/${encodeURIComponent(ticket.token)}${entry}`);
        }
        if (/\.html?$/i.test(relOrAbs)) {
          const b = await call(agent.deviceId, "portal.bundleHtml", { agent: agent.key, path: relOrAbs });
          setPreviewText(b.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000));
          return;
        }
        const f = await call(agent.deviceId, "files.read", { agent: agent.key, path: relOrAbs });
        if (f.kind === "image" && f.base64 && f.mime) {
          setPreviewImg(`data:${f.mime};base64,${f.base64}`);
        } else if (f.text !== undefined) {
          setPreviewText(f.text);
        } else {
          setPreviewText(`(${f.mime ?? "binary"}, ${f.size} bytes)`);
        }
      } catch (e) {
        setPreviewText(friendlyError(e));
      }
    },
    [agent.deviceId, agent.key],
  );

  useEffect(() => {
    if (!visible || !active || (active.kind !== "reveal" && active.kind !== "file" && active.kind !== "html")) return;
    if (active.kind === "reveal") {
      const startDir = active.parentDir || active.targetPath || agent.cwd || "~";
      setDirPath(startDir);
      void call(agent.deviceId, "portal.dirList", { portalId: active.id, agent: agent.key, path: startDir })
        .then((res) => {
          setDirPath(res.dirPath);
          setParentDir(res.parentDir);
          setEntries(res.entries);
        })
        .catch((e) => setErr(friendlyError(e)));
    }
    if (active.targetPath) void loadPreviewFile(active.targetPath);
  }, [active?.id, active?.kind, active?.parentDir, active?.targetPath, agent.cwd, agent.deviceId, agent.key, loadPreviewFile, visible]);

  const sendInput = useCallback(
    async (input: PortalInputAction) => {
      if (!active) return;
      try {
        const res = await call(agent.deviceId, "portal.input", { portalId: active.id, input }, 10_000);
        if (res.url) setUrlInput(res.url);
      } catch (e) {
        setErr(friendlyError(e));
      }
    },
    [active, agent.deviceId],
  );

  const openNew = useCallback(
    async (kind: "browser" | "window", target?: string) => {
      setBusy(true);
      setErr(null);
      try {
        const res = await call(agent.deviceId, "portal.open", {
          agent: agent.key,
          kind,
          ...(kind === "browser" ? { url: target } : { windowId: "screen:0" }),
        });
        setSelectedId(res.item.id);
        onChanged();
      } catch (e) {
        const errObj = e as { code?: string; message?: string };
        if (errObj?.code === "unsupported" || /unknown method\s+portal\./i.test(String(errObj?.message ?? ""))) {
          setErr("这台电脑的 herdr-pocket 版本较旧，暂不支持跨端窗口回传，请先更新工具");
        } else {
          setErr(friendlyError(e));
        }
      } finally {
        setBusy(false);
      }
    },
    [agent.deviceId, agent.key, onChanged],
  );

  const closeCurrent = useCallback(async () => {
    if (!active) return;
    await call(agent.deviceId, "portal.close", { portalId: active.id }).catch(() => {});
    setSelectedId(null);
    onChanged();
  }, [active, agent.deviceId, onChanged]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onDismiss}>
      <PageBackground>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: Math.max(insets.top, space.md),
            paddingHorizontal: space.lg,
            paddingBottom: space.sm,
            borderBottomWidth: 1,
            borderBottomColor: p.divider,
            gap: space.sm,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ fontFamily: fonts.cute, fontSize: 18, color: p.ink }}>
              {active ? active.title : "跨端窗口与文件回传"}
            </Text>
            <Text numberOfLines={1} style={{ fontSize: 12, color: p.muted }}>
              {active ? (active.transportHint === "p2p" ? "P2P 直连回传" : "中转通道回传") : "投屏 remote 浏览器 / 桌面窗口 / 文件"}
            </Text>
          </View>
          {active ? (
            <PocketButton size="sm" variant="danger" onPress={() => void closeCurrent()}>
              关闭回传
            </PocketButton>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="收起"
            onPress={onDismiss}
            style={({ pressed }) => ({
              width: 38,
              height: 38,
              borderRadius: 19,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: pressed ? p.surface3 : p.surface2,
            })}
          >
            <MaterialCommunityIcons name="close" size={20} color={p.ink} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + space.xxl, gap: space.md }}>
          {items.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
              {items.map((it) => {
                const sel = it.id === active?.id;
                return (
                  <Pressable
                    key={it.id}
                    onPress={() => setSelectedId(it.id)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      paddingHorizontal: 12,
                      paddingVertical: 7,
                      borderRadius: radius.pill,
                      backgroundColor: sel ? p.primary : p.surface,
                      borderWidth: 1,
                      borderColor: sel ? p.primary : p.divider,
                    }}
                  >
                    <MaterialCommunityIcons name={kindIcon(it.kind)} size={14} color={sel ? p.onPrimary : p.accentText} />
                    <Text numberOfLines={1} style={{ maxWidth: 140, fontSize: 12.5, fontFamily: fonts.bodyBold, color: sel ? p.onPrimary : p.ink }}>
                      {it.title}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}

          {err ? (
            <Card style={{ padding: space.md, backgroundColor: p.errorContainer }}>
              <Text style={{ color: p.error, fontSize: 13 }}>{err}</Text>
            </Card>
          ) : null}

          {active && (active.kind === "browser" || active.kind === "window") ? (
            <View style={{ gap: space.sm }}>
              {active.kind === "browser" ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                  <PocketButton size="sm" variant="ghost" icon="arrow-left" onPress={() => void sendInput({ type: "navigate", action: "back" })}>
                    后退
                  </PocketButton>
                  <PocketButton size="sm" variant="ghost" icon="refresh" onPress={() => void sendInput({ type: "navigate", action: "reload" })}>
                    刷新
                  </PocketButton>
                  <TextInput
                    value={urlInput}
                    onChangeText={setUrlInput}
                    placeholder="https://..."
                    placeholderTextColor={p.faint}
                    style={{
                      flex: 1,
                      height: 36,
                      paddingHorizontal: 10,
                      borderRadius: radius.sm,
                      backgroundColor: p.surface,
                      borderWidth: 1,
                      borderColor: p.divider,
                      color: p.ink,
                      fontSize: 12.5,
                    }}
                  />
                  <PocketButton size="sm" onPress={() => void sendInput({ type: "navigate", action: "goto", url: urlInput.trim() })}>
                    前往
                  </PocketButton>
                </View>
              ) : null}

              <Pressable
                onLayout={(e) => {
                  const { width, height } = e.nativeEvent.layout;
                  setBoxSize({ width, height });
                }}
                onPress={(e) => {
                  const { nx, ny } = mapContainedTap({
                    locationX: e.nativeEvent.locationX,
                    locationY: e.nativeEvent.locationY,
                    boxW: boxSize.width,
                    boxH: boxSize.height,
                    imgW: frame?.width,
                    imgH: frame?.height,
                  });
                  void sendInput({ type: "pointer", action: "click", nx, ny, button: "left" });
                }}
                style={{
                  width: "100%",
                  height: 300,
                  borderRadius: radius.card,
                  overflow: "hidden",
                  backgroundColor: p.surface2,
                  borderWidth: 1,
                  borderColor: p.divider,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {frame ? (
                  <Image
                    source={{ uri: `data:${frame.mime};base64,${frame.data}` }}
                    resizeMode="contain"
                    style={{ width: "100%", height: "100%" }}
                  />
                ) : active.streamError ? (
                  <View style={{ alignItems: "center", gap: space.sm, paddingHorizontal: space.lg }}>
                    <Text style={{ color: p.error, fontSize: 13, fontFamily: fonts.bodyBold, textAlign: "center" }}>
                      暂时无法获取远端画面
                    </Text>
                    <Text style={{ color: p.muted, fontSize: 12, textAlign: "center" }}>{active.streamError}</Text>
                    <PocketButton size="sm" variant="soft" icon="refresh" onPress={() => void fetchFrameOnce()}>
                      重试捕获
                    </PocketButton>
                  </View>
                ) : (
                  <View style={{ alignItems: "center", gap: space.sm }}>
                    <PocketSpinner size={24} />
                    <Text style={{ color: p.muted, fontSize: 13 }}>正在等待远端画面…</Text>
                  </View>
                )}
              </Pressable>

              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                <TextInput
                  value={textInput}
                  onChangeText={setTextInput}
                  placeholder="向远端窗口输入文字…"
                  placeholderTextColor={p.faint}
                  style={{
                    flex: 1,
                    height: 38,
                    paddingHorizontal: 10,
                    borderRadius: radius.sm,
                    backgroundColor: p.surface,
                    borderWidth: 1,
                    borderColor: p.divider,
                    color: p.ink,
                    fontSize: 13,
                  }}
                />
                <PocketButton
                  size="sm"
                  onPress={() => {
                    const txt = textInput;
                    if (!txt) return;
                    setTextInput("");
                    void sendInput({ type: "text", text: txt });
                  }}
                >
                  输入
                </PocketButton>
                <PocketButton size="sm" variant="soft" onPress={() => void sendInput({ type: "key", key: "Enter" })}>
                  回车
                </PocketButton>
              </View>
            </View>
          ) : active ? (
            <View style={{ gap: space.md }}>
              {active.kind === "reveal" ? (
                <Card style={{ padding: space.md, gap: space.xs }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                    {parentDir ? (
                      <PocketButton
                        size="sm"
                        variant="ghost"
                        icon="arrow-up"
                        onPress={() => {
                          void call(agent.deviceId, "portal.dirList", { portalId: active.id, agent: agent.key, path: parentDir })
                            .then((res) => {
                              setDirPath(res.dirPath);
                              setParentDir(res.parentDir);
                              setEntries(res.entries);
                            })
                            .catch((e) => setErr(friendlyError(e)));
                        }}
                      >
                        上级
                      </PocketButton>
                    ) : null}
                    <Text numberOfLines={1} style={{ flex: 1, fontSize: 12.5, color: p.muted }}>
                      {dirPath}
                    </Text>
                  </View>
                  {entries.map((ent) => {
                    const hl = active.highlightName && ent.name === active.highlightName;
                    return (
                      <Pressable
                        key={ent.path}
                        onPress={() => {
                          if (ent.kind === "dir") {
                            void call(agent.deviceId, "portal.dirList", { portalId: active.id, agent: agent.key, path: ent.path })
                              .then((res) => {
                                setDirPath(res.dirPath);
                                setParentDir(res.parentDir);
                                setEntries(res.entries);
                              })
                              .catch((e) => setErr(friendlyError(e)));
                          } else {
                            void loadPreviewFile(ent.path);
                          }
                        }}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: space.sm,
                          paddingVertical: 8,
                          paddingHorizontal: 8,
                          borderRadius: radius.sm,
                          backgroundColor: hl ? p.accentContainer : "transparent",
                        }}
                      >
                        <MaterialCommunityIcons
                          name={ent.kind === "dir" ? "folder-outline" : "file-document-outline"}
                          size={18}
                          color={hl ? p.accentText : p.muted}
                        />
                        <Text numberOfLines={1} style={{ flex: 1, fontSize: 13.5, fontFamily: hl ? fonts.bodyBold : undefined, color: p.ink }}>
                          {ent.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </Card>
              ) : null}

              <Card style={{ padding: space.md, gap: space.sm }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text numberOfLines={1} style={{ fontFamily: fonts.bodyBold, fontSize: 14, color: p.ink, flex: 1 }}>
                    {previewTitle || active.title}
                  </Text>
                  {p2pUrl ? (
                    <PocketButton size="sm" variant="soft" icon="open-in-new" onPress={() => void Linking.openURL(p2pUrl)}>
                      P2P 原文
                    </PocketButton>
                  ) : null}
                </View>
                {previewImg ? <Image source={{ uri: previewImg }} resizeMode="contain" style={{ width: "100%", height: 220 }} /> : null}
                {previewText ? (
                  <Text selectable style={{ fontSize: 12.5, lineHeight: 19, color: p.ink }}>
                    {previewText}
                  </Text>
                ) : !previewImg ? (
                  <Text style={{ color: p.muted, fontSize: 13 }}>点选文件即可查看内容或通过 P2P 直连打开。</Text>
                ) : null}
              </Card>
            </View>
          ) : null}

          <Card style={{ padding: space.md, gap: space.sm }}>
            <Text style={{ fontFamily: fonts.bodyBold, fontSize: 14, color: p.ink }}>主动拉起远端回传</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
              <TextInput
                value={newUrlInput}
                onChangeText={setNewUrlInput}
                placeholder="输入远端机 localhost/内网 URL…"
                placeholderTextColor={p.faint}
                style={{
                  flex: 1,
                  height: 38,
                  paddingHorizontal: 10,
                  borderRadius: radius.sm,
                  backgroundColor: p.surface2,
                  borderWidth: 1,
                  borderColor: p.divider,
                  color: p.ink,
                  fontSize: 13,
                }}
              />
              <PocketButton
                size="sm"
                loading={busy}
                onPress={() => {
                  const u = newUrlInput.trim();
                  if (!u) return;
                  void openNew("browser", u);
                }}
              >
                远端浏览器
              </PocketButton>
            </View>
            <PocketButton size="sm" variant="soft" icon="monitor" loading={busy} onPress={() => void openNew("window")}>
              抓取对端主屏幕画面
            </PocketButton>
          </Card>
        </ScrollView>
      </PageBackground>
    </Modal>
  );
}
