import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, RefreshControl, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsFocused, useLocalSearchParams, useNavigation, router } from "expo-router";
import { FlashList, type ListRenderItem } from "@shopify/flash-list";
import * as Clipboard from "expo-clipboard";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { Agent, AgentStatus, Device } from "@herdr-pocket/protocol";
import { AgentRow, ConnectionBanner, SpaceBadge } from "../../components/agents";
import { EmptyState, HarnessAvatar, IconTile, PageBackground, PocketToast } from "../../components/ui";
import { PocketActionSheet, PocketDialog, PocketSearch, PocketSegmented, type SheetAction } from "../../components/pocket";
import { LiveMascot } from "../../components/LiveMascot";
import { CuteIcon } from "../../components/icons";
import { Sidebar, useSidebar } from "../../components/Sidebar";
import { CreateAgentSheet, type CreateTarget } from "../../components/CreateAgentSheet";
import { allAgents, useLive, useSettings } from "../../lib/store";
import { agentSpace, agentTitle, greeting } from "../../lib/format";
import { horizontalPad } from "../../lib/layoutMetrics";
import { call, pingNow } from "../../lib/relay";
import { usePalette } from "../../theme/theme";
import { agentStatusLabel, fonts, radius, space, statusColors } from "../../theme/tokens";

/** "新建" button height; the list leaves this much room (plus margins) at its end. */
const FAB = 56;

/** Every agent is in exactly one group; all are listed, and a group folds when its header is tapped. */
type GroupKey = "blocked" | "working" | "done" | "idle" | "offline";
const GROUPS: { key: GroupKey; title: string }[] = [
  { key: "blocked", title: "需要你" },
  { key: "working", title: "工作中" },
  { key: "done", title: "已完成" },
  { key: "idle", title: "空闲" },
  { key: "offline", title: "离线" },
];
/** Inside a space: who needs the person first, then who is busy, then the rest. */
const RANK: Record<AgentStatus, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 3 };
const NO_SPACE = "__none__";

const recent = (a: Agent) => a.statusSince ?? a.updatedAt;
const byRecent = (x: Agent, y: Agent) => recent(y) - recent(x);

type StatusSection = { key: GroupKey; title: string; count: number; folded: boolean; data: Agent[] };
type SpaceGroup = {
  fold: string;
  host: string;
  /** Null: agents outside any space (a computer without the desktop herdr). */
  space: string | null;
  counts: Record<AgentStatus, number>;
  offline: boolean;
  folded: boolean;
  data: Agent[];
  total: number;
};
type AgentListRow =
  | { kind: "header"; key: string; section: StatusSection }
  | { kind: "host"; key: string; host: Device; count: number }
  | { kind: "space"; key: string; group: SpaceGroup }
  | { kind: "agent"; key: string; agent: Agent; lastInSection: boolean; inSpace: boolean };

const noopSubscribe = () => () => {};

/**
 * A number that changes once a minute while this tab is focused: rows re-render for their
 * "N 分钟前" even when their agent did not change, and read a fresh timestamp immediately on return.
 */
const minuteNow = () => Math.floor(Date.now() / 60_000);
function onMinute(changed: () => void): () => void {
  const t = setInterval(changed, 15_000);
  return () => clearInterval(t);
}
function useMinute(active: boolean): number {
  return useSyncExternalStore(active ? onMinute : noopSubscribe, minuteNow);
}

/** One compact row of three counts (需要你 / 工作中 / 已完成); tap one to filter. */
function StatRow({ counts, active, onPick }: { counts: Record<AgentStatus, number>; active: AgentStatus | null; onPick: (s: AgentStatus | null) => void }) {
  const p = usePalette();
  const { width } = useWindowDimensions();
  const narrow = width < 390;
  const items: { s: AgentStatus; label: string }[] = [
    { s: "blocked", label: "需要你" },
    { s: "working", label: "工作中" },
    { s: "done", label: "已完成" },
  ];
  return (
    <View style={{ flexDirection: "row", gap: width < 360 ? 6 : space.sm }}>
      {items.map(({ s, label }) => {
        const c = statusColors(s, p.dark);
        const on = active === s;
        return (
          <Pressable
            key={s}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${label} ${counts[s]} 个，点按${on ? "取消" : ""}筛选`}
            onPress={() => onPick(on ? null : s)}
            style={({ pressed }) => ({
              flex: 1,
              minWidth: 0,
              minHeight: 64,
              paddingHorizontal: narrow ? 9 : space.md,
              paddingVertical: space.sm,
              borderRadius: radius.card,
              backgroundColor: c.bg,
              borderWidth: 2,
              borderColor: on ? c.fg : "transparent",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: space.xs,
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            <View style={{ gap: 2, flexShrink: 1, minWidth: 0 }}>
              <CuteIcon name={s === "blocked" ? "blocked" : s === "working" ? "working" : "done"} size={17} color={c.fg} fill={p.dark ? "transparent" : "#FFFFFF"} strokeWidth={2.3} />
              <Text numberOfLines={1} style={{ fontFamily: fonts.bodyBold, fontSize: narrow ? 12 : 12.5, color: c.fg }}>
                {label}
              </Text>
            </View>
            <Text style={{ flexShrink: 0, fontFamily: fonts.cute, fontSize: narrow ? 24 : 28, lineHeight: narrow ? 30 : 34, color: c.fg }}>{counts[s]}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Removable small tag showing an active sidebar filter. */
function FilterTag({ label, lead, onClear }: { label: string; lead?: React.ReactNode; onClear: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`筛选：${label}，点按取消`}
      onPress={onClear}
      hitSlop={{ top: 5, bottom: 5 }}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 34, paddingLeft: lead ? 6 : 12, paddingRight: 10, borderRadius: radius.pill, backgroundColor: p.accentContainer }}
    >
      {lead}
      <Text numberOfLines={1} style={{ maxWidth: 160, color: p.ink, fontFamily: fonts.bodyBold, fontSize: 13 }}>
        {label}
      </Text>
      <CuteIcon name="close" size={14} color={p.accentText} strokeWidth={2.6} />
    </Pressable>
  );
}

/** Tiny status counts for a space header: only the ones that are there, each in its colour. */
function StatusDots({ counts }: { counts: Record<AgentStatus, number> }) {
  const p = usePalette();
  const shown = (["blocked", "working", "done"] as const).filter((s) => counts[s] > 0);
  if (!shown.length) return null;
  return (
    <View style={{ flexDirection: "row", gap: 4 }}>
      {shown.map((s) => {
        const c = statusColors(s, p.dark);
        return (
          <View key={s} style={{ flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: c.bg, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.fg }} />
            <Text style={{ color: c.fg, fontFamily: fonts.bodyBold, fontSize: 11.5 }}>{counts[s]}</Text>
          </View>
        );
      })}
    </View>
  );
}

function countsLine(c: Record<AgentStatus, number>): string {
  return [c.blocked ? `${c.blocked} 个需要你` : null, c.working ? `${c.working} 个工作中` : null, c.done ? `${c.done} 个已完成` : null].filter(Boolean).join("，");
}

export default function AgentsHub() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { host } = useLocalSearchParams<{ host?: string }>();
  const agentsByHost = useLive((s) => s.agents);
  const devices = useLive((s) => s.devices);
  const link = useLive((s) => s.link);
  const showShellsDefault = useSettings((s) => s.showShells);
  const hostFilterSaved = useSettings((s) => s.hostFilter);
  const foldedGroups = useSettings((s) => s.foldedGroups);
  const grouping = useSettings((s) => s.agentGrouping) ?? "space";
  const setSettings = useSettings((s) => s.set);
  const sidebar = useSidebar();
  const focused = useIsFocused();
  const navigation = useNavigation();
  // The sidebar is a full-height overlay: hide the tab bar while it is open.
  useEffect(() => {
    navigation.setOptions({ tabBarStyle: { borderTopWidth: 0, backgroundColor: p.surface, elevation: 0, display: sidebar.open ? "none" : "flex" } });
  }, [navigation, sidebar.open, p.surface]);

  const [filter, setFilter] = useState<AgentStatus | null>(null);
  const [spaceFilter, setSpaceFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [showShells, setShowShells] = useState(showShellsDefault);
  const [refreshing, setRefreshing] = useState(false);
  const [create, setCreate] = useState<CreateTarget | null>(null);
  const [menu, setMenu] = useState<Agent | null>(null);
  const [deleteSpaceTarget, setDeleteSpaceTarget] = useState<{ host: string; name: string; count: number } | null>(null);
  const [deletingSpace, setDeletingSpace] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const qc = useQueryClient();
  // The "新建" button slides away while the list scrolls down (it would cover rows and the spaces' own "+"),
  // and comes back as soon as the list moves up again.
  const fabAway = useSharedValue(0);
  const fabStyle = useAnimatedStyle(() => ({ opacity: 1 - fabAway.value, transform: [{ translateY: fabAway.value * (FAB + space.xl) }] }));
  const [fabHidden, setFabHidden] = useState(false);
  const lastY = useRef(0);

  // "Show this computer" from the devices tab arrives as ?host=; store it as the remembered choice.
  useEffect(() => {
    if (host) {
      setSettings({ hostFilter: host });
      router.setParams({ host: undefined });
    }
  }, [host, setSettings]);

  const hosts = useMemo(() => {
    const list = Object.values(devices).filter((d) => d.kind === "host");
    for (const id of Object.keys(agentsByHost)) if (!devices[id]) list.push({ id, name: id, kind: "host", online: false, createdAt: 0, lastSeenAt: 0 });
    return list.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }, [devices, agentsByHost]);
  const hostFilter = hostFilterSaved && hosts.some((h) => h.id === hostFilterSaved) ? hostFilterSaved : null;
  const isOnline = useCallback((a: Agent) => devices[a.deviceId]?.online ?? false, [devices]);

  const all = useMemo(() => allAgents(agentsByHost).filter((a) => showShells || !a.isShell), [agentsByHost, showShells]);
  const hostCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of all) m[a.deviceId] = (m[a.deviceId] ?? 0) + 1;
    return m;
  }, [all]);
  const onHost = useMemo(() => all.filter((a) => !hostFilter || a.deviceId === hostFilter), [all, hostFilter]);
  const spaces = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of onHost) {
      const sp = agentSpace(a);
      if (sp) m.set(sp, (m.get(sp) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [onHost]);
  const activeSpace = spaceFilter && spaces.some(([s]) => s === spaceFilter) ? spaceFilter : null;
  const inScope = useMemo(() => onHost.filter((a) => !activeSpace || agentSpace(a) === activeSpace), [onHost, activeSpace]);

  const counts = useMemo(() => {
    const c: Record<AgentStatus, number> = { blocked: 0, working: 0, done: 0, idle: 0, unknown: 0 };
    for (const a of inScope) if (isOnline(a)) c[a.status]++;
    return c;
  }, [inScope, isOnline]);

  const q = query.trim().toLowerCase();
  const match = useCallback((a: Agent) => !q || [agentTitle(a), a.harness, a.where, a.cwd, a.preview].some((s) => s?.toLowerCase().includes(q)), [q]);
  // A search or a picked status always shows what it found; folding is for browsing.
  const canFold = !q && !filter;
  const shown = useCallback(
    (a: Agent) => match(a) && (!filter || (isOnline(a) && (filter === "idle" ? a.status === "idle" || a.status === "unknown" : a.status === filter))),
    [filter, isOnline, match],
  );

  const sections = useMemo((): StatusSection[] => {
    if (grouping !== "status") return [];
    const by: Record<GroupKey, Agent[]> = { blocked: [], working: [], done: [], idle: [], offline: [] };
    for (const a of inScope) {
      if (!shown(a)) continue;
      const g: GroupKey = !isOnline(a) ? "offline" : a.status === "blocked" || a.status === "working" || a.status === "done" ? a.status : "idle";
      by[g].push(a);
    }
    return GROUPS.filter((g) => by[g.key].length).map((g) => {
      const folded = canFold && foldedGroups.includes(g.key);
      return { key: g.key, title: g.title, count: by[g.key].length, folded, data: folded ? [] : by[g.key].sort(byRecent) };
    });
  }, [canFold, foldedGroups, grouping, inScope, isOnline, shown]);

  /** Computer → space groups, each sorted by who needs attention first. */
  const spaceGroups = useMemo((): { host: Device; groups: SpaceGroup[]; count: number }[] => {
    if (grouping !== "space") return [];
    const byHost = new Map<string, Map<string, Agent[]>>();
    for (const a of inScope) {
      if (!shown(a)) continue;
      const sp = agentSpace(a) ?? NO_SPACE;
      const m = byHost.get(a.deviceId) ?? new Map<string, Agent[]>();
      byHost.set(a.deviceId, m);
      m.set(sp, [...(m.get(sp) ?? []), a]);
    }
    const out: { host: Device; groups: SpaceGroup[]; count: number }[] = [];
    for (const h of hosts) {
      const m = byHost.get(h.id);
      if (!m) continue;
      const groups: SpaceGroup[] = [];
      let count = 0;
      for (const [sp, list] of m) {
        const c: Record<AgentStatus, number> = { blocked: 0, working: 0, done: 0, idle: 0, unknown: 0 };
        for (const a of list) if (h.online) c[a.status]++;
        list.sort((x, y) => (h.online ? RANK[x.status] - RANK[y.status] : 0) || byRecent(x, y));
        const fold = `space:${h.id}:${sp}`;
        const folded = canFold && foldedGroups.includes(fold);
        count += list.length;
        groups.push({ fold, host: h.id, space: sp === NO_SPACE ? null : sp, counts: c, offline: !h.online, folded, data: folded ? [] : list, total: list.length });
      }
      // Spaces with someone waiting first, then the busiest, then the most recently active; "no space" last.
      groups.sort((x, y) => {
        if ((x.space === null) !== (y.space === null)) return x.space === null ? 1 : -1;
        const r = (g: SpaceGroup) => (g.counts.blocked ? 0 : g.counts.working ? 1 : 2);
        const latest = (g: SpaceGroup) => Math.max(0, ...(m.get(g.space ?? NO_SPACE) ?? []).map(recent));
        return r(x) - r(y) || latest(y) - latest(x);
      });
      out.push({ host: h, groups, count });
    }
    return out;
  }, [canFold, foldedGroups, grouping, hosts, inScope, shown]);

  const multiHost = hosts.length > 1 && !hostFilter;

  const rows = useMemo<AgentListRow[]>(() => {
    const out: AgentListRow[] = [];
    if (grouping === "status") {
      for (const s of sections) {
        out.push({ kind: "header", key: `h:${s.key}`, section: s });
        s.data.forEach((agent, i) => out.push({ kind: "agent", key: agent.key, agent, lastInSection: i === s.data.length - 1, inSpace: false }));
      }
      return out;
    }
    for (const h of spaceGroups) {
      if (multiHost) out.push({ kind: "host", key: `c:${h.host.id}`, host: h.host, count: h.count });
      for (const g of h.groups) {
        out.push({ kind: "space", key: `s:${g.fold}`, group: g });
        g.data.forEach((agent, i) => out.push({ kind: "agent", key: agent.key, agent, lastInSection: i === g.data.length - 1, inSpace: true }));
      }
    }
    return out;
  }, [grouping, multiHost, sections, spaceGroups]);

  const toggleFold = useCallback(
    (key: string) => setSettings({ foldedGroups: foldedGroups.includes(key) ? foldedGroups.filter((k) => k !== key) : [...foldedGroups, key] }),
    [foldedGroups, setSettings],
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    pingNow();
    setTimeout(() => setRefreshing(false), 700);
  }, []);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    const dy = y - lastY.current;
    if (Math.abs(dy) < 6) return;
    lastY.current = y;
    const hide = y > 80 && dy > 0;
    fabAway.set(withTiming(hide ? 1 : 0, { duration: 180 }));
    setFabHidden(hide);
  }, [fabAway]);

  const openMenu = useCallback((a: Agent) => setMenu(a), []);
  const minute = useMinute(focused);
  const renderRow = useCallback<ListRenderItem<AgentListRow>>(
    ({ item }) => {
      if (item.kind === "header") {
        const { section } = item;
        return (
          <Pressable
            disabled={!canFold}
            accessibilityRole={canFold ? "button" : "header"}
            accessibilityState={canFold ? { expanded: !section.folded } : undefined}
            accessibilityLabel={`${section.title} ${section.count} 个${canFold ? `，点按${section.folded ? "展开" : "收起"}` : ""}`}
            onPress={() => toggleFold(section.key)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: space.xs,
              minHeight: 44,
              marginTop: space.sm,
              marginBottom: section.folded ? space.xs : 0,
              paddingHorizontal: space.xs,
              borderRadius: radius.card,
              backgroundColor: pressed ? p.surface3 : "transparent",
            })}
          >
            <Text style={{ fontFamily: fonts.bodyBold, color: p.muted, fontSize: 14 }}>{section.title}</Text>
            <Text style={{ flex: 1, fontFamily: fonts.bodyBold, color: p.faint, fontSize: 13 }}>{section.count}</Text>
            {canFold ? <CuteIcon name={section.folded ? "chevronRight" : "chevronDown"} size={18} color={p.faint} /> : null}
          </Pressable>
        );
      }
      if (item.kind === "host") {
        const { host: h } = item;
        return (
          <View accessibilityRole="header" accessibilityLabel={`${h.name}，${h.online ? "在线" : "离线"}，${item.count} 个 agent`} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 40, marginTop: space.md, paddingHorizontal: space.xs }}>
            <CuteIcon name="laptop" size={18} color={p.ink} fill={p.accentContainer} />
            <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: fonts.cute, fontSize: 17, lineHeight: 24, color: p.ink }}>
              {h.name}
            </Text>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: h.online ? "#3FB68B" : p.faint }} />
            <Text style={{ flex: 1, color: p.faint, fontFamily: fonts.bodyBold, fontSize: 12.5 }}>{h.online ? `${item.count} 个` : "离线"}</Text>
          </View>
        );
      }
      if (item.kind === "space") {
        const g = item.group;
        const name = g.space ?? "不在空间里";
        const summary = countsLine(g.counts);
        return (
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, marginTop: space.sm, marginBottom: g.folded ? space.xs : 2 }}>
            <Pressable
              disabled={!canFold}
              accessibilityRole={canFold ? "button" : "header"}
              accessibilityState={canFold ? { expanded: !g.folded } : undefined}
              accessibilityLabel={`空间 ${name}，${g.total} 个${summary ? `，${summary}` : ""}${canFold ? `，点按${g.folded ? "展开" : "收起"}` : ""}`}
              onPress={() => toggleFold(g.fold)}
              style={({ pressed }) => ({ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, paddingHorizontal: space.xs, borderRadius: radius.card, backgroundColor: pressed ? p.surface3 : "transparent", opacity: g.offline ? 0.7 : 1 })}
            >
              {g.space ? <SpaceBadge name={g.space} size={24} /> : <CuteIcon name="terminal" size={20} color={p.muted} />}
              <Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, fontFamily: fonts.bodyBold, color: p.ink, fontSize: 15 }}>
                {name}
              </Text>
              <Text style={{ color: p.faint, fontFamily: fonts.bodyBold, fontSize: 13 }}>{g.total}</Text>
              <View style={{ flex: 1, minWidth: 0 }}>
                <StatusDots counts={g.counts} />
              </View>
              {canFold ? <CuteIcon name={g.folded ? "chevronRight" : "chevronDown"} size={18} color={p.faint} /> : null}
            </Pressable>
            {g.offline ? null : (
              <View style={{ flexShrink: 0, flexDirection: "row", alignItems: "center", gap: space.xs }}>
                {g.space ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`关闭空间 ${g.space}`}
                    onPress={() => setDeleteSpaceTarget({ host: g.host, name: g.space!, count: g.total })}
                    hitSlop={6}
                    style={({ pressed }) => ({
                      width: 34,
                      height: 34,
                      borderRadius: 17,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: pressed ? p.surface3 : "transparent",
                    })}
                  >
                    <MaterialCommunityIcons name="trash-can-outline" size={17} color={p.muted} />
                  </Pressable>
                ) : null}
                <IconTile icon="plus" tone="soft" size={36} iconSize={18} onPress={() => setCreate({ host: g.host, spaceName: g.space })} a11y={g.space ? `在空间 ${g.space} 新建 agent` : "在这台电脑上新建 agent"} />
              </View>
            )}
          </View>
        );
      }
      return (
        <View style={{ paddingBottom: item.lastInSection ? space.xs : space.sm }}>
          <AgentRow
            agent={item.agent}
            offline={!isOnline(item.agent)}
            deviceName={multiHost && !item.inSpace ? devices[item.agent.deviceId]?.name : undefined}
            minute={minute}
            plainTitle={item.inSpace}
            onLongPress={openMenu}
          />
        </View>
      );
    },
    [canFold, devices, isOnline, minute, multiHost, openMenu, p, toggleFold],
  );
  const rowKey = useCallback((r: AgentListRow) => r.key, []);
  const rowType = useCallback((r: AgentListRow) => r.kind, []);
  const allDone = counts.blocked === 0 && counts.working === 0 && counts.done > 0;
  const headline = counts.blocked ? `有 ${counts.blocked} 个 agent 在等你` : counts.working ? `${counts.working} 个 agent 正在忙` : allDone ? "大家都忙完啦" : "大家都歇着呢";
  const hostName = hostFilter ? hosts.find((h) => h.id === hostFilter)?.name ?? "这台电脑" : null;

  const header = (
    <View style={{ gap: space.md, paddingBottom: space.xs }}>
      {/* Raised so the mascot's speech bubble draws over the stat cards below. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, zIndex: 5, elevation: 5 }}>
        <IconTile icon="menu" tone="plain" size={44} onPress={sidebar.show} a11y="打开侧栏：电脑和空间" />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={{ fontFamily: fonts.cute, fontSize: 24, lineHeight: 32, color: p.ink }}>{greeting()}</Text>
          <Text numberOfLines={1} style={{ color: p.muted, fontSize: 13.5 }}>
            {headline}
          </Text>
        </View>
        <IconTile icon="search" tone="plain" size={44} active={searching} onPress={() => setSearching((v) => !v)} a11y={searching ? "收起搜索" : "搜索"} />
        <LiveMascot counts={counts} mood={allDone ? "yay" : counts.blocked ? "waiting" : "hello"} size={60} onLongPress={() => router.navigate("/")} />
      </View>

      <StatRow counts={counts} active={filter} onPick={setFilter} />

      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <PocketSegmented
          style={{ flex: 1 }}
          value={grouping}
          onChange={(v) => setSettings({ agentGrouping: v })}
          segments={[
            { value: "space", label: "按空间", icon: "folder-outline", a11y: "按电脑和空间分组" },
            { value: "status", label: "按状态", icon: "list-status", a11y: "按状态分组" },
          ]}
        />
        <IconTile icon="terminal" tone="plain" size={44} active={showShells} onPress={() => setShowShells((v) => !v)} a11y={showShells ? "隐藏普通终端" : "显示普通终端"} />
      </View>

      {hostName || activeSpace ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {hostName ? (
            <FilterTag
              label={hostName}
              lead={
                <View style={{ marginLeft: 4 }}>
                  <CuteIcon name="laptop" size={16} color={p.ink} fill={p.surface} />
                </View>
              }
              onClear={() => setSettings({ hostFilter: null })}
            />
          ) : null}
          {activeSpace ? <FilterTag label={activeSpace} lead={<SpaceBadge name={activeSpace} size={22} />} onClear={() => setSpaceFilter(null)} /> : null}
        </View>
      ) : null}
      {searching ? <PocketSearch autoFocus placeholder="搜标题、项目、目录" value={query} onChangeText={setQuery} /> : null}
    </View>
  );

  const empty =
    link !== "online" ? (
      <EmptyState mood="sleepy" title="还在连服务器" body="连上以后，各台电脑上的 agent 会出现在这里。" />
    ) : hosts.length === 0 ? (
      <EmptyState mood="sleepy" title="还没有电脑加入" body="在电脑上运行 herdr-pocket up，再到“设备”页点“扫一扫”扫它显示的二维码。" />
    ) : (
      <EmptyState mood="sleepy" title={filter || q ? "这里空空的" : "还没有 agent"} body={filter || q ? "换个筛选条件试试。" : "点右下角的“新建”开一个。"} />
    );

  const menuSpace = menu ? agentSpace(menu) : null;
  const menuOnline = menu ? isOnline(menu) : false;
  const menuActions: SheetAction[] = menu
    ? [
        { key: "chat", label: "打开对话", icon: "chat-processing-outline", onPress: () => router.push({ pathname: "/agent/[key]", params: { key: menu.key, tab: "chat" } }) },
        { key: "term", label: "看终端", icon: "console", onPress: () => router.push({ pathname: "/agent/[key]", params: { key: menu.key, tab: "terminal" } }) },
        {
          key: "new",
          label: menuSpace ? `在「${menuSpace}」再开一个` : "在这台电脑上再开一个",
          sub: menuOnline ? undefined : "电脑离线",
          icon: "plus-circle-outline",
          disabled: !menuOnline,
          onPress: () => setCreate({ host: menu.deviceId, spaceName: menuSpace, folder: menu.cwd }),
        },
        {
          key: "copy",
          label: "复制文件夹路径",
          sub: menu.cwd ?? "没有记录文件夹",
          icon: "content-copy",
          disabled: !menu.cwd,
          onPress: () => {
            void Clipboard.setStringAsync(menu.cwd ?? "").then(() => setToast("路径已复制"));
          },
        },
      ]
    : [];

  const padLeft = horizontalPad(space.lg, insets.left);
  const padRight = horizontalPad(space.lg, insets.right);

  return (
    <PageBackground>
      <View style={{ paddingTop: insets.top + space.sm }}>
        <ConnectionBanner />
      </View>
      <FlashList
        data={rows}
        keyExtractor={rowKey}
        getItemType={rowType}
        renderItem={renderRow}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        removeClippedSubviews={false}
        drawDistance={500}
        onScroll={onScroll}
        scrollEventThrottle={64}
        contentContainerStyle={{ paddingLeft: padLeft, paddingRight: padRight, paddingBottom: FAB + space.lg * 2, paddingTop: space.sm }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[p.primary]} />}
        keyboardShouldPersistTaps="handled"
      />

      {/* One "新建" in the thumb zone, bottom right; it opens on the computer and space being viewed. */}
      <Animated.View pointerEvents={fabHidden ? "none" : "auto"} style={[{ position: "absolute", right: padRight, bottom: space.lg }, fabStyle]}>
        <Pressable
          accessibilityRole="button"
          accessibilityElementsHidden={fabHidden}
          importantForAccessibility={fabHidden ? "no-hide-descendants" : "auto"}
          accessibilityLabel={activeSpace ? `在空间 ${activeSpace} 新建 agent` : "新建 agent 或空间"}
          onPress={() => setCreate({ host: hostFilter, spaceName: activeSpace })}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            height: FAB,
            minWidth: FAB,
            paddingHorizontal: 20,
            borderRadius: FAB / 2,
            backgroundColor: pressed ? p.primaryPressed : p.primary,
            transform: [{ scale: pressed ? 0.95 : 1 }],
            shadowColor: p.shadow,
            shadowOpacity: p.dark ? 0 : 0.35,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 5 },
            elevation: 5,
          })}
        >
          <CuteIcon name="plus" size={26} color={p.onPrimary} strokeWidth={2.8} />
          <Text style={{ color: p.onPrimary, fontFamily: fonts.bodyBold, fontSize: 16 }}>新建</Text>
        </Pressable>
      </Animated.View>

      <Sidebar
        s={sidebar}
        d={{
          hosts,
          hostCounts,
          allCount: all.length,
          hostFilter,
          onHost: (id) => setSettings({ hostFilter: id }),
          spaces,
          scopeCount: onHost.length,
          spaceFilter: activeSpace,
          onSpace: setSpaceFilter,
          onNewSpace: () => {
            sidebar.hide();
            setCreate({ host: hostFilter, spaceName: null });
          },
          onNewInSpace: (name) => {
            sidebar.hide();
            setCreate({ host: hostFilter, spaceName: name });
          },
          onDeleteSpace: (name) => {
            sidebar.hide();
            const matchAgents = onHost.filter((a) => agentSpace(a) === name);
            const targetHost = hostFilter ?? matchAgents[0]?.deviceId ?? hosts.find((h) => h.online)?.id;
            if (!targetHost) {
              setToast("找不到在线电脑，无法关闭空间");
              return;
            }
            setDeleteSpaceTarget({ host: targetHost, name, count: matchAgents.length });
          },
        }}
      />
      <PocketDialog
        visible={!!deleteSpaceTarget}
        onDismiss={() => { if (!deletingSpace) setDeleteSpaceTarget(null); }}
        title={deleteSpaceTarget ? `关闭空间「${deleteSpaceTarget.name}」？` : ""}
        body={
          deleteSpaceTarget
            ? `${deleteSpaceTarget.count > 0 ? `将关闭该空间并结束其中的 ${deleteSpaceTarget.count} 个运行中终端/Agent。` : "将移除该空间。"}磁盘上的文件夹与代码文件不会被删除。`
            : undefined
        }
        actions={[
          { label: "取消", tone: "ghost", disabled: deletingSpace, onPress: () => setDeleteSpaceTarget(null) },
          {
            label: "关闭空间",
            tone: "danger",
            loading: deletingSpace,
            onPress: () => {
              const tgt = deleteSpaceTarget;
              if (!tgt || deletingSpace) return;
              setDeletingSpace(true);
              void call(tgt.host, "space.delete", { spaceName: tgt.name })
                .then(() => {
                  if (activeSpace === tgt.name) setSpaceFilter(null);
                  setDeleteSpaceTarget(null);
                  qc.invalidateQueries({ queryKey: ["spaces.list", tgt.host] });
                  pingNow();
                  setToast(`已关闭空间「${tgt.name}」`);
                })
                .catch((e) => setToast((e as Error).message || "关闭空间失败"))
                .finally(() => setDeletingSpace(false));
            },
          },
        ]}
      />
      <PocketActionSheet
        visible={!!menu}
        onDismiss={() => setMenu(null)}
        title={menu ? agentTitle(menu) : ""}
        sub={menu ? [menuSpace, devices[menu.deviceId]?.name, menuOnline ? agentStatusLabel(menu) : "电脑离线"].filter(Boolean).join(" · ") : undefined}
        lead={menu ? <HarnessAvatar harness={menu.harness} isShell={menu.isShell} size={40} /> : undefined}
        actions={menuActions}
      />
      <CreateAgentSheet visible={!!create} onDismiss={() => setCreate(null)} target={create ?? {}} hosts={hosts} />
      <PocketToast visible={!!toast} message={toast} onDismiss={() => setToast(null)} bottom={FAB + space.lg * 2} />
    </PageBackground>
  );
}
