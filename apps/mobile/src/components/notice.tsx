/**
 * Something the assistant tells the person without being asked: an agent
 * finished, needs them, or a reminder is due. In the chat it reads as the
 * assistant talking — its sentence first — not as a system card.
 */
import { memo, useMemo, type ComponentProps } from "react";
import { Pressable, View } from "react-native";
import { Text } from "react-native-paper";
import { router } from "expo-router";
import Markdown from "react-native-markdown-display";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { AssistantItem, Notice } from "@herdr-pocket/protocol";
import { findAgent, useSettings } from "../lib/store";
import { fixCjkEmphasis } from "../lib/markdown";
import { usePalette } from "../theme/theme";
import { fonts, radius, space, statusColors, type Palette } from "../theme/tokens";
import { mdStyles } from "./chat";

type IconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

/** Icon and colours for what the assistant found; older notices only carry their kind. */
export function noticeLook(n: Pick<Notice, "kind" | "verdict">, p: Palette): { icon: IconName; fg: string; bg: string } {
  const verdict = n.verdict ?? (n.kind === "blocked" ? "decide" : n.kind === "done" ? "ok" : undefined);
  switch (verdict) {
    case "ok":
      return { icon: "check-circle-outline", ...statusColors("working", p.dark) };
    case "decide":
      return { icon: "hand-back-left-outline", ...statusColors("blocked", p.dark) };
    case "failed":
      return { icon: "alert-circle-outline", fg: p.error, bg: p.errorContainer };
    case "stopped":
      return { icon: "pause-circle-outline", ...statusColors("idle", p.dark) };
    default:
      return { icon: "alarm", fg: p.dusk, bg: p.duskContainer };
  }
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export const NoticeBubble = memo(function NoticeBubble({ item }: { item: AssistantItem }) {
  const p = usePalette();
  const scale = useSettings((s) => s.textScale);
  const styles = useMemo(() => {
    const md = mdStyles(p, scale * 0.9);
    return { ...md, body: { ...md.body, color: p.muted }, paragraph: { marginTop: 0, marginBottom: 4 } };
  }, [p, scale]);
  const n = item.notice!;
  const look = noticeLook(n, p);
  const agent = n.agent ? findAgent(n.agent) : undefined;
  // Shown in full: details are at most 300 characters, and folding them read as broken.
  const details = n.details?.trim();

  return (
    // A set width, not maxWidth: sized to its content, the card measured wrapped list
    // lines as one line each and the text ran out under it.
    <View style={{ alignSelf: "flex-start", width: "92%", gap: 4 }}>
      <View style={{ backgroundColor: p.surface, borderRadius: radius.card, borderBottomLeftRadius: 6, paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.sm, gap: 7 }}>
        <View style={{ alignSelf: "flex-start", maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: look.bg, borderRadius: radius.pill, paddingLeft: 7, paddingRight: 10, paddingVertical: 3 }}>
          <MaterialCommunityIcons name={look.icon} size={15} color={look.fg} />
          <Text numberOfLines={1} style={{ flexShrink: 1, color: look.fg, fontFamily: fonts.bodyBold, fontSize: 12.5 }}>
            {n.title}
          </Text>
        </View>
        {n.body ? (
          <Text style={{ color: p.ink, fontSize: 15.5 * scale, lineHeight: 22 * scale }} numberOfLines={details ? undefined : 8}>
            {n.body}
          </Text>
        ) : null}
        {details ? <Markdown style={styles}>{fixCjkEmphasis(details)}</Markdown> : null}
        {agent ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/agent/[key]", params: { key: agent.key } })}
            hitSlop={8}
            style={({ pressed }) => ({ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 2, minHeight: 32, paddingLeft: 12, paddingRight: 8, borderRadius: radius.pill, backgroundColor: pressed ? p.accentContainer : p.dark ? p.surface2 : "#FFF1F6" })}
          >
            <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 13.5 }}>去看看</Text>
            <MaterialCommunityIcons name="chevron-right" size={16} color={p.accentText} />
          </Pressable>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 4 }}>
        <MaterialCommunityIcons name="bell-ring-outline" size={12} color={p.faint} />
        <Text style={{ color: p.faint, fontSize: 11 }}>{clock(item.ts)} · 主动告诉你</Text>
      </View>
    </View>
  );
});
