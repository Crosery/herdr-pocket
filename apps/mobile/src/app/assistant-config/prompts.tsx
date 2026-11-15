/** 提示词: every prompt a phone can change, grouped as the relay groups them. */
import { Fragment } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { Text } from "react-native-paper";
import { router, Stack } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { PromptView } from "@herdr-pocket/protocol";
import { Card, PageBackground, SectionHeader } from "../../components/ui";
import { RowDivider } from "../../components/rows";
import { ConfigSnackbar, LoadState, Note, Pill } from "../../components/configParts";
import { chars, loadPrompts, useAssistantConfig, useConfigWatch } from "../../lib/assistantConfig";
import { relTime } from "../../lib/format";
import { usePalette } from "../../theme/theme";
import { fonts, radius, space } from "../../theme/tokens";

/** Groups in the order their first prompt comes. */
function grouped(list: PromptView[]): [string, PromptView[]][] {
  const out = new Map<string, PromptView[]>();
  for (const x of list) out.set(x.group, [...(out.get(x.group) ?? []), x]);
  return [...out.entries()];
}

export default function PromptsScreen() {
  const p = usePalette();
  useConfigWatch("prompts");
  const prompts = useAssistantConfig((s) => s.prompts);
  const error = useAssistantConfig((s) => s.promptsError);
  const header = <Stack.Screen options={{ title: "提示词" }} />;
  if (!prompts) {
    return (
      <PageBackground>
        {header}
        <LoadState error={error} onRetry={loadPrompts} />
      </PageBackground>
    );
  }
  const edited = prompts.filter((x) => x.edited).length;
  return (
    <PageBackground>
      {header}
      {/* contentInsetAdjustmentBehavior: iOS keeps the last row clear of the home indicator; Android ignores it. */}
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xxxl }}>
        <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20, paddingHorizontal: space.xs }}>
          小羊怎么说话、怎么办事，都写在这里。改了从下一条消息或下一通电话开始生效，所有手机都一样。{edited ? `现在改过 ${edited} 段。` : "现在都是默认的。"}
        </Text>
        {grouped(prompts).map(([group, items]) => (
          <Fragment key={group}>
            <SectionHeader title={group} />
            <Card style={{ paddingVertical: space.xs }}>
              {items.map((x, i) => (
                <View key={x.id}>
                  {i ? <RowDivider /> : null}
                  <PromptRow prompt={x} />
                </View>
              ))}
            </Card>
          </Fragment>
        ))}
        <View style={{ paddingTop: space.md }}>
          <Note>叫醒时看的资料和工具的说明写在程序里，这里改不了。</Note>
        </View>
      </ScrollView>
      <ConfigSnackbar message={null} onDismiss={() => undefined} />
    </PageBackground>
  );
}

function PromptRow({ prompt: x }: { prompt: PromptView }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${x.title}${x.edited ? "，改过" : ""}，${chars(x.text.length)}。${x.about}`}
      onPress={() => router.push({ pathname: "/assistant-config/prompt", params: { id: x.id } })}
      android_ripple={{ color: p.surface3 }}
      // iOS has no ripple: the same tint while pressed.
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
        pressed && Platform.OS === "ios" ? { backgroundColor: p.surface3 } : null,
      ]}
    >
      <View style={{ width: 40, height: 40, borderRadius: radius.sm, backgroundColor: x.edited ? p.accentContainer : p.surface3, alignItems: "center", justifyContent: "center" }}>
        <MaterialCommunityIcons name={x.edited ? "text-box-edit-outline" : "text-box-outline"} size={21} color={x.edited ? p.accentText : p.muted} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Text style={{ flexShrink: 1, fontFamily: fonts.bodyBold, fontSize: 15.5, color: p.ink }}>{x.title}</Text>
          {x.edited ? <Pill text="改过" /> : null}
        </View>
        <Text numberOfLines={2} style={{ color: p.muted, fontSize: 12.5, lineHeight: 17 }}>
          {x.about}
        </Text>
        <Text style={{ color: p.faint, fontSize: 12, lineHeight: 16 }}>
          {chars(x.text.length)}
          {x.edited && x.updatedAt ? ` · ${relTime(x.updatedAt)}${x.updatedBy ? `由「${x.updatedBy}」` : ""}改的` : ""}
        </Text>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={22} color={p.faint} />
    </Pressable>
  );
}
