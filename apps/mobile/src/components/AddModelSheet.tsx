/**
 * 添加模型: pick a provider, then type a model name or tap one the provider
 * lists. The new model goes last, as the next fallback.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, View } from "react-native";
import { ActivityIndicator, Button, Text } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { AssistantConfigView, ModelRef } from "@herdr-pocket/protocol";
import { changeConfig, listProviderModels, modelKey, providerName } from "../lib/assistantConfig";
import { useSettings } from "../lib/store";
import { Chip, Chips, Field, Input } from "./configParts";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";

const SHOWN = 30;

/** Mount it with a new `key` each time it opens: it starts fresh, on the main model's provider. */
export function AddModelSheet({ visible, onDismiss, config, onAdded }: { visible: boolean; onDismiss: () => void; config: AssistantConfigView; onAdded: (m: ModelRef) => void }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const server = useSettings((s) => s.server);
  const [provider, setProvider] = useState<string | null>(config.models[0]?.provider ?? config.providers[0]?.id ?? null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the provider lists; many list nothing, or refuse, and then the person types the name.
  const q = useQuery({
    queryKey: ["assistant.models", server, provider],
    queryFn: () => listProviderModels(provider!),
    enabled: visible && !!provider,
    staleTime: 60_000,
    retry: false,
  });

  const name = model.trim();
  const used = new Set(config.models.map(modelKey));
  const taken = !!provider && used.has(modelKey({ provider, model: name }));
  const names = q.data ?? (q.isError ? [] : null);
  const matches = names ? names.filter((n) => !name || n.toLowerCase().includes(name.toLowerCase())) : [];
  const position = config.models.length;

  async function add() {
    if (!provider || !name || taken) return;
    setBusy(true);
    setError(null);
    try {
      const ref = { provider, model: name };
      await changeConfig({ models: [...config.models, ref] });
      onAdded(ref);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onDismiss} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable accessibilityLabel="关闭" onPress={onDismiss} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(30,26,38,0.38)" }} />
        <View style={{ maxHeight: "88%", backgroundColor: p.page, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, overflow: "hidden" }}>
          <View style={{ alignItems: "center", paddingTop: space.sm }}>
            <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: p.divider }} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingTop: space.sm }}>
            <Text style={{ flex: 1, fontFamily: fonts.cute, fontSize: 22, lineHeight: 30, color: p.ink }}>添加模型</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭" onPress={onDismiss} hitSlop={8} style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}>
              <MaterialCommunityIcons name="close" size={22} color={p.muted} />
            </Pressable>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
            <Field title="服务商">
              <Chips>
                {config.providers.map((x) => (
                  <Chip key={x.id} on={provider === x.id} onPress={() => setProvider(x.id)} label={providerName(x)} a11y={`服务商 ${providerName(x)}`} />
                ))}
              </Chips>
            </Field>

            <Field title="模型名" hint="照服务商那里的写法填，也可以在下面点一个" error={taken ? "这个模型已经在列表里了" : null}>
              <Input value={model} onChangeText={setModel} placeholder="比如 gpt-6.1-terra" autoCapitalize="none" mono accessibilityLabel="模型名" />
            </Field>

            {provider ? (
              <Field title="它列出的模型">
                {!names ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 40 }}>
                    <ActivityIndicator size={14} />
                    <Text style={{ color: p.muted, fontSize: 13.5 }}>正在问它有哪些模型…</Text>
                  </View>
                ) : q.isError ? (
                  <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20 }}>没问到：{(q.error as Error).message}。直接在上面填名字就行。</Text>
                ) : !names.length ? (
                  <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20 }}>它没有列出模型，直接在上面填名字就行。</Text>
                ) : !matches.length ? (
                  <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20 }}>列表里没有名字里带“{name}”的，照你填的加也行。</Text>
                ) : (
                  <>
                    <Chips>
                      {matches.slice(0, SHOWN).map((n) => {
                        const inUse = used.has(modelKey({ provider, model: n }));
                        return <Chip key={n} on={name === n} disabled={inUse} onPress={() => setModel(n)} label={inUse ? `${n}（在用）` : n} />;
                      })}
                    </Chips>
                    {matches.length > SHOWN ? <Text style={{ color: p.faint, fontSize: 12.5 }}>还有 {matches.length - SHOWN} 个，在上面输入几个字筛一下</Text> : null}
                  </>
                )}
              </Field>
            ) : null}

            {error ? <Text style={{ color: p.error, lineHeight: 20 }}>{error}</Text> : null}
          </ScrollView>

          <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: insets.bottom + space.md, gap: space.xs, borderTopWidth: 1, borderTopColor: p.divider }}>
            <Text style={{ color: p.faint, fontSize: 12, textAlign: "center" }}>加在最后，当备用 {position}。测过觉得快，再往上挪</Text>
            <Button mode="contained" disabled={!provider || !name || taken || busy} loading={busy} onPress={add} contentStyle={{ height: 50 }} style={{ borderRadius: radius.pill }} labelStyle={{ fontSize: 16 }}>
              添加并测一下
            </Button>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
