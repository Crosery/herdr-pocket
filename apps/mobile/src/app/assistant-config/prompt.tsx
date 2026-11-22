/**
 * One prompt in a large editor: what it decides, what its placeholders stand
 * for, save (once changed) and back to the default. Leaving with unsaved
 * changes asks first. Another phone saving the same prompt meanwhile is said
 * plainly instead of being written over silently.
 */
import { useState } from "react";
import { KeyboardAvoidingView, TextInput, View } from "react-native";
import { Text } from "react-native-paper";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { PromptId, PromptView } from "@herdr-pocket/protocol";
import { EmptyState, PageBackground } from "../../components/ui";
import { PocketButton } from "../../components/pocket";
import { ConfigSnackbar, ConfirmDialog, LoadState, SaveBar, useLeaveGuard } from "../../components/configParts";
import { chars, loadPrompts, resetPrompt, savePrompt, useAssistantConfig, useConfigWatch } from "../../lib/assistantConfig";
import { relTime } from "../../lib/format";
import { useKeyboardState } from "../../lib/useKeyboardState";
import { usePalette } from "../../theme/theme";
import { fonts, radius, space } from "../../theme/tokens";

export default function PromptScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = String(params.id ?? "") as PromptId;
  useConfigWatch("prompts");
  const prompts = useAssistantConfig((s) => s.prompts);
  const error = useAssistantConfig((s) => s.promptsError);
  const prompt = prompts?.find((x) => x.id === id);
  const header = <Stack.Screen options={{ title: prompt?.title ?? "提示词" }} />;
  if (!prompts) {
    return (
      <PageBackground>
        {header}
        <LoadState error={error} onRetry={loadPrompts} />
      </PageBackground>
    );
  }
  if (!prompt) {
    return (
      <PageBackground>
        {header}
        <EmptyState title="没有这段提示词" body="服务器上可能已经没有它了。" mood="waiting" action={<PocketButton variant="text" onPress={() => router.back()}>回去</PocketButton>} />
      </PageBackground>
    );
  }
  return (
    <>
      {header}
      <PromptEditor key={prompt.id} prompt={prompt} />
    </>
  );
}

function PromptEditor({ prompt }: { prompt: PromptView }) {
  const p = usePalette();
  const headerHeight = useHeaderHeight();
  const id = prompt.id;
  /** What is in the editor, and the saved text it is compared with. */
  const [text, setText] = useState(prompt.text);
  const [base, setBase] = useState(prompt.text);
  /** The saved text this screen last took notice of. */
  const [seen, setSeen] = useState(prompt.text);
  /** The text this phone's own save or reset will bring back, so it is not taken for someone else's. */
  const [expect, setExpect] = useState<string | null>(null);
  /** Another phone saved this prompt while it was being changed here. */
  const [newer, setNewer] = useState<PromptView | null>(null);
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [askReset, setAskReset] = useState(false);
  const { keyboardOpen: keyboard } = useKeyboardState();
  const [focused, setFocused] = useState(false);

  // A new saved text (another phone's save): follow it quietly when nothing is being changed here, else say so.
  if (prompt.text !== seen) {
    setSeen(prompt.text);
    if (prompt.text !== expect && prompt.text !== base) {
      if (text === base) {
        setText(prompt.text);
        setBase(prompt.text);
      } else setNewer(prompt);
    }
  }

  const dirty = text !== base;
  const { dialog: guard } = useLeaveGuard(dirty);

  async function save() {
    if (!text.trim()) return;
    setBusy("save");
    setExpect(text);
    try {
      const v = await savePrompt(id, text);
      // Only the base: anything typed while it was saving stays, and counts as unsaved.
      setBase(v.text);
      setNewer(null);
      setToast("保存好了，下一条消息或下一通电话开始用");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setExpect(null);
      setBusy(null);
    }
  }

  async function reset() {
    setAskReset(false);
    setBusy("reset");
    setExpect(prompt.defaultText);
    try {
      const v = await resetPrompt(id);
      setText(v.text);
      setBase(v.text);
      setNewer(null);
      setToast("已恢复默认");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setExpect(null);
      setBusy(null);
    }
  }

  const sameAsDefault = text === prompt.defaultText;
  const empty = !text.trim();

  return (
    <PageBackground>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={headerHeight}>
        <View style={{ flex: 1, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm, gap: space.sm }}>
          {/* What it is and its placeholders; folded away while typing so the editor keeps the room. */}
          {!keyboard ? (
            <View style={{ gap: space.sm }}>
              <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20 }}>{prompt.about}</Text>
              {prompt.slots.length ? (
                <>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                    {prompt.slots.map((s) => {
                      const used = text.includes(s.slot);
                      return (
                        <View
                          key={s.slot}
                          accessibilityLabel={`${s.slot}：${s.means}${used ? "" : "，现在没用上"}`}
                          style={{ maxWidth: "100%", flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: used ? p.lavenderContainer : p.surface3, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4, opacity: used ? 1 : 0.75 }}
                        >
                          <Text style={{ color: p.dusk, fontFamily: fonts.mono, fontSize: 12.5 }}>{s.slot}</Text>
                          <Text style={{ flexShrink: 1, color: p.ink, fontSize: 12.5, lineHeight: 17 }}>
                            {s.means}
                            {used ? "" : "（没用上）"}
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                  <Text style={{ color: p.faint, fontSize: 12, lineHeight: 17 }}>花括号里的会换成实际内容；删掉一个，那部分就不放进去。</Text>
                </>
              ) : null}
            </View>
          ) : null}

          {newer ? (
            <View style={{ backgroundColor: p.errorContainer, borderRadius: radius.md, padding: space.md, gap: space.sm }}>
              <View style={{ flexDirection: "row", gap: space.sm }}>
                <MaterialCommunityIcons name="cellphone-arrow-down" size={18} color={p.error} />
                <Text style={{ flex: 1, color: p.ink, fontSize: 13.5, lineHeight: 20 }}>
                  {newer.updatedBy ? `「${newer.updatedBy}」` : "另一台手机"}刚改过这段。保存的话，会换成你现在写的。
                </Text>
              </View>
              <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
                <PocketButton variant="ghost" size="sm" onPress={() => {
                    setText(newer.text);
                    setBase(newer.text);
                    setNewer(null);
                  }}>
                  用它改的
                </PocketButton>
                <PocketButton variant="text" size="sm" onPress={() => {
                    setBase(newer.text);
                    setNewer(null);
                  }}>
                  留着我的
                </PocketButton>
              </View>
            </View>
          ) : null}

          <View style={{ flex: 1, backgroundColor: p.surface, borderRadius: radius.card, borderWidth: focused ? 1.5 : 1, borderColor: focused ? p.primary : p.divider, overflow: "hidden" }}>
            <TextInput
              value={text}
              onChangeText={setText}
              multiline
              scrollEnabled
              textAlignVertical="top"
              autoCorrect={false}
              autoCapitalize="none"
              placeholder="写给小羊的话…"
              placeholderTextColor={p.faint}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              accessibilityLabel={`${prompt.title}的内容`}
              style={{ flex: 1, paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.md, color: p.ink, fontFamily: fonts.body, fontSize: 15, lineHeight: 23 }}
            />
          </View>
          <Text style={{ color: empty ? p.error : p.faint, fontSize: 12, lineHeight: 17, paddingHorizontal: space.xs }}>
            {empty
              ? "不能是空的；想用原来的就点恢复默认"
              : `${chars(text.length)}${sameAsDefault ? " · 和默认的一样" : ` · 默认的 ${chars(prompt.defaultText.length)}`}${prompt.edited && prompt.updatedAt && !dirty ? ` · ${relTime(prompt.updatedAt)}${prompt.updatedBy ? `由「${prompt.updatedBy}」` : ""}改的` : ""}`}
          </Text>
        </View>

        <SaveBar note={dirty ? "还没保存。保存后从下一条消息或下一通电话开始生效" : "保存后从下一条消息或下一通电话开始生效"} keyboardOpen={keyboard}>
          <PocketButton variant="ghost" size="lg" disabled={!!busy || (!prompt.edited && sameAsDefault)} loading={busy === "reset"} onPress={() => setAskReset(true)}>
            恢复默认
          </PocketButton>
          <PocketButton size="lg" grow disabled={!dirty || empty || !!busy} loading={busy === "save"} onPress={save}>
            保存
          </PocketButton>
        </SaveBar>
      </KeyboardAvoidingView>

      <ConfirmDialog
        visible={askReset}
        title="恢复成默认的提示词？"
        body="这一段会换回服务器自带的默认内容，你改的部分不会留下。所有手机都会跟着变。"
        action="恢复默认"
        danger
        onDismiss={() => setAskReset(false)}
        onConfirm={reset}
      />
      {guard}
      <ConfigSnackbar message={toast} onDismiss={() => setToast(null)} bottom={keyboard ? 80 : 104} />
    </PageBackground>
  );
}
