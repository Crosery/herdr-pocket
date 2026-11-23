import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Text } from "react-native-paper";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useQuery } from "@tanstack/react-query";
import type { Agent, PortalItem } from "@herdr-pocket/protocol";
import { ChatView } from "../../components/chat";
import { Composer, InfoView, TerminalView } from "../../components/detail";
import { MobilePortalBanner, MobilePortalModal, useAgentPortals } from "../../components/MobilePortalModal";
import { PocketKeyboardAvoidingView } from "../../components/PocketKeyboardAvoidingView";
import { Breadcrumb, SubagentList } from "../../components/subagents";
import { EmptyState, HarnessAvatar, PageBackground, StatusPill } from "../../components/ui";
import { PocketSegmented, PocketSpinner, type PocketIcon } from "../../components/pocket";
import { useLive } from "../../lib/store";
import { call, pingNow } from "../../lib/relay";
import { Mascot } from "../../components/Mascot";
import { CuteIcon } from "../../components/icons";
import { agentTitle, basename, money, relTime } from "../../lib/format";
import { horizontalPad } from "../../lib/layoutMetrics";
import { parseTrail, SUB_STATUS, type Crumb } from "../../lib/subnav";
import { usePalette } from "../../theme/theme";
import { agentStatusLabel, fonts, radius, space, statusColors } from "../../theme/tokens";

type Tab = "chat" | "terminal" | "subs" | "info";

/** Finished turns already reported as looked at (agent key + turn), so each is sent once. */
const seenSent = new Set<string>();

function DeviceLine({ agent }: { agent: Agent }) {
  const p = usePalette();
  const device = useLive((s) => s.devices[agent.deviceId]);
  const online = device?.online ?? false;
  return (
    <View accessibilityLabel={`所在电脑 ${device?.name ?? agent.deviceId}，${online ? "在线" : "离线"}`} style={{ flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0 }}>
      <CuteIcon name="laptop" size={15} color={p.muted} strokeWidth={2.4} />
      <Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, color: p.ink, fontFamily: fonts.bodySemi, fontSize: 13 }}>
        {device?.name ?? agent.deviceId}
      </Text>
      <View style={{ width: 7, height: 7, borderRadius: 4, flexShrink: 0, backgroundColor: online ? "#3FB68B" : p.faint }} />
    </View>
  );
}

export default function AgentDetail() {
  const p = usePalette();
  const params = useLocalSearchParams<{ key: string; tab?: Tab; sub?: string; trail?: string; fresh?: string }>();
  const key = decodeURIComponent(String(params.key));
  const agent = useLive((s) => s.agents[key.split("/")[0] ?? ""]?.find((a) => a.key === key));
  const trail = useMemo(() => parseTrail(params.trail), [params.trail]);

  // Just created from the phone: it shows up in agents.list a moment later.
  const fresh = params.fresh ? Number(params.fresh) : 0;
  const [, tick] = useState(0);
  useEffect(() => {
    if (agent || !fresh) return;
    const t = setInterval(() => {
      pingNow();
      tick((n) => n + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [agent, fresh]);

  if (!agent && fresh && Date.now() - fresh < 12_000) {
    return (
      <PageBackground>
        <Stack.Screen options={{ title: "" }} />
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.md }}>
          <Mascot mood="hello" size={120} />
          <PocketSpinner size={28} />
          <Text style={{ fontFamily: fonts.cute, fontSize: 20, color: p.ink }}>正在启动…</Text>
          <Text style={{ color: p.muted }}>电脑上的新终端打开后就会显示</Text>
        </View>
      </PageBackground>
    );
  }
  if (!agent) {
    return (
      <PageBackground>
        <Stack.Screen options={{ title: "" }} />
        <EmptyState mood="waiting" title="找不到这个 agent" body="它可能已经关掉了，或者电脑离线了。" />
      </PageBackground>
    );
  }
  if (params.sub) return <SubDetail agent={agent} sub={String(params.sub)} trail={trail} />;
  return <MainDetail agent={agent} initialTab={params.tab} />;
}

function MainDetail({ agent, initialTab }: { agent: Agent; initialTab?: Tab }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const [tab, setTab] = useState<Tab>(initialTab ?? (agent.isShell ? "terminal" : "chat"));
  const [chatVisited, setChatVisited] = useState(tab === "chat");
  const [termVisited, setTermVisited] = useState(tab === "terminal");
  const { items: portalItems, refresh: refreshPortals } = useAgentPortals(agent.deviceId, agent.key);
  const [portalOpen, setPortalOpen] = useState(false);
  const [portalFocus, setPortalFocus] = useState<PortalItem | null>(null);
  useEffect(() => {
    if (tab === "chat") setChatVisited(true);
    else if (tab === "terminal") setTermVisited(true);
  }, [tab]);
  const subs = agent.subagents ?? 0;

  // Opening a finished agent is looking at it: herdr stops counting it as "已完成", on the desktop too.
  useEffect(() => {
    if (agent.status !== "done") return;
    const mark = `${agent.key}:${agent.turn ?? ""}`;
    if (seenSent.has(mark)) return;
    seenSent.add(mark);
    useLive.setState((s) => {
      const list = s.agents[agent.deviceId];
      if (!list?.some((a) => a.key === agent.key && a.status === "done")) return s;
      return {
        agents: {
          ...s.agents,
          [agent.deviceId]: list.map((a) =>
            a.key === agent.key && a.status === "done" ? { ...a, status: "idle" } : a,
          ),
        },
      };
    });
    call(agent.deviceId, "agent.seen", { agent: agent.key }).catch(() => {
      /* an older computer does not know this; the list just keeps showing it as done */
    });
  }, [agent.key, agent.deviceId, agent.status, agent.turn]);

  const meta = [agent.where, money(agent.costUsd)].filter(Boolean).join(" · ");
  const icons: Partial<Record<Tab, PocketIcon>> = { chat: "chat-processing-outline", terminal: "console", info: "information-outline" };
  // Four tabs don't fit with icons on a phone; icons only when there are three.
  const buttons = ([
    { value: "chat", label: "对话" },
    { value: "terminal", label: "终端" },
    ...(subs > 0 ? [{ value: "subs" as const, label: "子 agent" }] : []),
    { value: "info", label: "信息" },
  ] as { value: Tab; label: string }[]).map((b) => ({ ...b, icon: subs > 0 ? undefined : icons[b.value] }));

  const padLeft = horizontalPad(space.lg, insets.left);
  const padRight = horizontalPad(space.lg, insets.right);

  return (
    <PageBackground>
      {/* The title lives in the bar; one slim line of context below, so the conversation gets the screen. */}
      <Stack.Screen options={{ title: agentTitle(agent) }} />
      <PocketKeyboardAvoidingView style={{ flex: 1 }} keyboardVerticalOffset={headerHeight}>
        <View style={{ flexShrink: 0, paddingLeft: padLeft, paddingRight: padRight, paddingTop: space.xs, gap: space.sm }}>
          <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center", minHeight: 30 }}>
            <HarnessAvatar harness={agent.harness} isShell={agent.isShell} size={28} />
            <View style={{ flexShrink: 1, minWidth: 0, maxWidth: "48%" }}>
              <DeviceLine agent={agent} />
            </View>
            <Text numberOfLines={1} style={{ flex: 1, minWidth: 40, color: p.muted, fontSize: 12.5 }}>
              {meta}
            </Text>
            <StatusPill status={agent.status} label={agentStatusLabel(agent)} compact />
          </View>
          <PocketSegmented value={tab} onChange={setTab} segments={buttons} compact={subs > 0} />
        </View>
        <MobilePortalBanner
          agent={agent}
          items={portalItems}
          onOpenModal={(item) => {
            setPortalFocus(item ?? null);
            setPortalOpen(true);
          }}
        />
        <View style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          {chatVisited ? (
            <View style={{ flex: 1, display: tab === "chat" ? "flex" : "none" }}>
              <ChatView agent={agent} active={tab === "chat"} bottomInset={0} childCount={subs} onSwitchToTerminal={() => setTab("terminal")} />
            </View>
          ) : null}
          {termVisited ? (
            <View style={{ flex: 1, display: tab === "terminal" ? "flex" : "none" }}>
              <TerminalView agent={agent} active={tab === "terminal"} />
            </View>
          ) : null}
          {tab === "subs" ? <SubagentList agent={agent} trail={[]} active bottomInset={insets.bottom} /> : null}
          {tab === "info" ? <InfoView agent={agent} bottomInset={0} /> : null}
        </View>
        {tab === "chat" || tab === "terminal" ? (
          <Composer agent={agent} bottomInset={insets.bottom} mode={tab} onOpenTerminal={() => setTab("terminal")} />
        ) : (
          <View style={{ height: insets.bottom, flexShrink: 0 }} />
        )}
      </PocketKeyboardAvoidingView>
      <MobilePortalModal
        visible={portalOpen}
        agent={agent}
        items={portalItems}
        initialItem={portalFocus}
        onDismiss={() => setPortalOpen(false)}
        onChanged={refreshPortals}
      />
    </PageBackground>
  );
}

/** Read-only view of a subagent session: breadcrumb, its conversation and its own children. No composer. */
function SubDetail({ agent, sub, trail }: { agent: Agent; sub: string; trail: Crumb[] }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const padLeft = horizontalPad(space.lg, insets.left);
  const padRight = horizontalPad(space.lg, insets.right);
  const [tab, setTab] = useState<"chat" | "subs">("chat");
  const parentSub = trail.length > 1 ? trail[trail.length - 2]?.k : undefined;
  // Fresh status/details of this subagent come from its parent's children list.
  const siblings = useQuery({
    queryKey: ["session.children", agent.key, parentSub ?? null],
    queryFn: () => call(agent.deviceId, "session.children", { agent: agent.key, sub: parentSub }),
    refetchInterval: 5000,
    retry: false,
  });
  const me = siblings.data?.sessions.find((s) => s.key === sub);
  const title = trail[trail.length - 1]?.t ?? "子 agent";
  const kids = me?.children ?? 0;
  const c = statusColors(me?.status === "working" ? "working" : "idle", p.dark);
  const meta = [me?.model, money(me?.costUsd), me ? relTime(me.statusSince ?? me.updatedAt) : null].filter(Boolean).join(" · ");

  return (
    <PageBackground>
      <Stack.Screen options={{ title: "子 agent" }} />
      <View style={{ paddingLeft: padLeft, paddingRight: padRight, paddingTop: space.sm, gap: space.md }}>
        <Breadcrumb agent={agent} trail={trail} />
        <View style={{ flexDirection: "row", gap: space.md, alignItems: "center" }}>
          <HarnessAvatar harness={me?.harness ?? agent.harness} isShell={false} size={42} />
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text numberOfLines={2} style={{ fontFamily: fonts.cute, fontSize: 19, lineHeight: 26, color: p.ink }}>
              {title}
            </Text>
            {meta ? (
              <Text numberOfLines={1} style={{ color: p.muted, fontSize: 12.5 }}>
                {meta}
              </Text>
            ) : null}
          </View>
          {me ? (
            <View style={{ flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: c.bg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.fg }} />
              <Text style={{ color: c.fg, fontFamily: fonts.bodyBold, fontSize: 13 }}>{SUB_STATUS[me.status]}</Text>
            </View>
          ) : null}
        </View>
        {kids > 0 ? (
          <PocketSegmented
            value={tab}
            onChange={setTab}
            segments={[
              { value: "chat", label: "对话", icon: "chat-processing-outline" },
              { value: "subs", label: `子 agent ${kids}`, icon: "source-branch" },
            ]}
          />
        ) : null}
      </View>
      <View style={{ flex: 1 }}>
        {tab === "chat" ? <ChatView agent={agent} sub={sub} childCount={kids} trail={trail} active bottomInset={0} /> : null}
        {tab === "subs" ? <SubagentList agent={agent} sub={sub} trail={trail} active bottomInset={insets.bottom} /> : null}
      </View>
      <View style={{ alignItems: "center", paddingTop: space.sm, paddingBottom: insets.bottom + space.sm }}>
        <Text style={{ color: p.faint, fontSize: 12.5 }}>子 agent 只能查看，不能直接发消息</Text>
      </View>
    </PageBackground>
  );
}


