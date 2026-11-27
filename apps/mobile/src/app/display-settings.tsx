import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Text } from "react-native-paper";
import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { PortalDisplayMode } from "@herdr-pocket/protocol";
import { Card, PageBackground, SectionHeader } from "../components/ui";
import { Row, RowDivider as Divider, Toggle } from "../components/rows";
import { PocketSegmented } from "../components/pocket";
import { Mascot } from "../components/Mascot";
import { useSettings } from "../lib/store";
import { horizontalPad } from "../lib/layoutMetrics";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";

const SCALES = [
  { value: 0.85, label: "小", glyph: 13 },
  { value: 1, label: "标准", glyph: 16 },
  { value: 1.15, label: "大", glyph: 19 },
  { value: 1.3, label: "特大", glyph: 22 },
] as const;

const CHAT_MODE_OPTIONS = [
  { value: "compact", label: "精简" },
  { value: "standard", label: "标准" },
  { value: "expanded", label: "全展示" },
] as const;

const CHAT_MODE_SUB = {
  compact: "精简：把思考过程和连续工具折叠为一条",
  standard: "标准：文字思考独立成块，连续工具归到同一个标签",
  expanded: "全展示：独立展示每次思考与各个工具调用",
} as const;

const PORTAL_MODE_OPTIONS = [
  { value: "collapsed", label: "默认收起" },
  { value: "fan", label: "叠牌露头" },
  { value: "tile", label: "平铺展开" },
  { value: "cascade", label: "纵向叠列" },
] as const;

const PORTAL_MODE_SUB: Record<PortalDisplayMode, string> = {
  collapsed: "收起为右上角紧凑胶囊，不遮挡对话文字",
  fan: "默认展开跨端小窗（桌面端呈 1·2·3·4 叠牌露头）",
  tile: "默认展开跨端小窗（桌面端两列平铺预览）",
  cascade: "默认展开跨端小窗（桌面端纵向叠列）",
};

export default function DisplaySettingsScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const textScale = useSettings((x) => x.textScale);
  const chatDisplayMode = useSettings((x) => x.chatDisplayMode);
  const portalDisplayMode = useSettings((x) => x.portalDisplayMode);
  const showShells = useSettings((x) => x.showShells);
  const set = useSettings((x) => x.set);
  const padLeft = horizontalPad(space.lg, insets.left);
  const padRight = horizontalPad(space.lg, insets.right);

  return (
    <PageBackground>
      <Stack.Screen options={{ title: "显示与排版" }} />
      <ScrollView
        contentContainerStyle={{
          paddingTop: space.md,
          paddingLeft: padLeft,
          paddingRight: padRight,
          paddingBottom: insets.bottom + space.xxxl,
        }}
      >
        <SectionHeader title="字体与对话" />
        <Card style={{ paddingVertical: space.xs }}>
          <Row icon="format-size" title="对话字号" sub="聊天和 agent 对话里文字的大小">
            <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: width < 360 ? space.sm : space.md, paddingTop: space.md }}>
              {SCALES.map((x) => {
                const on = textScale === x.value;
                return (
                  <Pressable
                    key={x.value}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={`字号${x.label}`}
                    onPress={() => set({ textScale: x.value })}
                    style={{
                      width: 46,
                      height: 46,
                      borderRadius: 23,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: on ? p.primary : p.surface3,
                      borderWidth: on ? 0 : 1,
                      borderColor: p.divider,
                    }}
                  >
                    <Text style={{ fontFamily: fonts.bodyBold, fontSize: x.glyph, lineHeight: x.glyph + 6, color: on ? p.onPrimary : p.muted }}>A</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm, paddingTop: space.md }}>
              <Mascot size={30} />
              <View style={{ flexShrink: 1, minWidth: 0, backgroundColor: p.surface3, borderRadius: radius.md, borderBottomLeftRadius: 5, paddingHorizontal: space.md, paddingVertical: 7 }}>
                <Text style={{ color: p.ink, fontSize: 15.5 * textScale, lineHeight: 22 * textScale }}>迁移脚本跑完了，测试全过。</Text>
              </View>
            </View>
          </Row>
          <Divider />
          <Row icon="view-agenda-outline" title="对话展示模式" sub={CHAT_MODE_SUB[chatDisplayMode]}>
            <View style={{ paddingTop: space.sm }}>
              <PocketSegmented
                compact
                segments={CHAT_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                value={chatDisplayMode}
                onChange={(v) => set({ chatDisplayMode: v as "compact" | "standard" | "expanded" })}
              />
            </View>
          </Row>
          <Divider />
          <Row icon="dock-window" title="跨端小窗默认显示" sub={PORTAL_MODE_SUB[portalDisplayMode]}>
            <View style={{ paddingTop: space.sm }}>
              <PocketSegmented
                compact
                segments={PORTAL_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                value={portalDisplayMode}
                onChange={(v) => set({ portalDisplayMode: v as PortalDisplayMode })}
              />
            </View>
          </Row>
        </Card>

        <SectionHeader title="列表显示" />
        <Card style={{ paddingVertical: space.xs }}>
          <Row
            icon="console-line"
            title="显示普通终端"
            sub="没在跑 agent 的 shell 窗口"
            right={<Toggle label="显示普通终端" value={showShells} onChange={(v) => set({ showShells: v })} />}
          />
        </Card>
      </ScrollView>
    </PageBackground>
  );
}
