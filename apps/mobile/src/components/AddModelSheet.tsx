/**
 * 添加模型: pick a provider, then type a model name or tap one the provider
 * lists, and say whether it is a fallback (goes last) or the new main model.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pressable, View } from "react-native";
import { Text } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { AssistantConfigView, ModelRef } from "@herdr-pocket/protocol";
import { changeConfig, listProviderModels, modelKey, PROTOCOL_LABEL, providerName } from "../lib/assistantConfig";
import { modelErrorText } from "../lib/modelErrors";
import { useSettings } from "../lib/store";
import { Field, Input } from "./configParts";
import { PocketButton, PocketChip, PocketChips, PocketSegmented, PocketSheet, PocketSpinner } from "./pocket";
import { usePalette } from "../theme/theme";
import { fonts, radius, space, statusColors } from "../theme/tokens";

const SHOWN = 30;

/** Mount it with a new `key` each time it opens: it starts fresh, on the main model's provider. */
export function AddModelSheet({ visible, onDismiss, config, onAdded }: { visible: boolean; onDismiss: () => void; config: AssistantConfigView; onAdded: (m: ModelRef, asMain: boolean) => void }) {
  const p = usePalette();
  const server = useSettings((s) => s.server);
  const [provider, setProvider] = useState<string | null>(config.models[0]?.provider ?? config.providers[0]?.id ?? null);
  const [model, setModel] = useState("");
  const [place, setPlace] = useState<"fallback" | "main">(config.models.length ? "fallback" : "main");
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
  const position = config.models.length + 1;
  const asMain = place === "main";
  const chosen = config.providers.find((x) => x.id === provider);
  const keyMissing = !!chosen && !chosen.key.set && chosen.auth !== "none" && chosen.protocol !== "ollama";

  async function add() {
    if (!provider || !name || taken) return;
    setBusy(true);
    setError(null);
    try {
      const ref = { provider, model: name };
      await changeConfig({ models: asMain ? [ref, ...config.models] : [...config.models, ref] });
      onAdded(ref, asMain);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const footer = (
    <>
      <Text style={{ color: p.faint, fontSize: 12, textAlign: "center" }}>
        {asMain ? "保存后马上成为小羊的主模型，原来的主模型排到第 2 个" : `排在第 ${position} 个，前面的都不通时才用它`}
      </Text>
      <PocketButton size="lg" block icon="speedometer" disabled={!provider || !name || taken || busy} loading={busy} onPress={add}>
        添加并测速
      </PocketButton>
    </>
  );

  return (
    <PocketSheet visible={visible} onDismiss={onDismiss} title="添加模型" footer={footer}>
      <Field title="服务商">
        <PocketChips>
          {config.providers.map((x) => {
            const ok = x.key.set || x.auth === "none" || x.protocol === "ollama";
            return (
              <PocketChip
                key={x.id}
                on={provider === x.id}
                onPress={() => setProvider(x.id)}
                label={providerName(x)}
                a11y={`服务商 ${providerName(x)}，${PROTOCOL_LABEL[x.protocol]}，${ok ? "密钥已设" : "还没有密钥"}`}
                lead={<View style={{ width: 8, height: 8, borderRadius: 4, marginLeft: 6, backgroundColor: ok ? statusColors("working", p.dark).fg : p.error }} />}
              />
            );
          })}
        </PocketChips>
        {keyMissing ? <Text style={{ color: p.error, fontSize: 12.5, lineHeight: 18 }}>这个服务商还没有密钥，模型会测不通。先到服务商里设一下密钥。</Text> : null}
      </Field>

      <Field title="模型名" hint="照服务商那里的写法填，或者在下面点一个" error={taken ? "这个模型已经在列表里了" : null}>
        <Input value={model} onChangeText={setModel} placeholder="输入几个字，也会筛下面的列表" autoCapitalize="none" mono accessibilityLabel="模型名" />
      </Field>

      <Field title="放在哪">
        <PocketSegmented
          value={place}
          onChange={setPlace}
          segments={[
            { value: "fallback", label: `当备用（第 ${position} 个）`, a11y: `当备用，排在第 ${position} 个` },
            { value: "main", label: "设为主模型", a11y: "设为主模型，排第一" },
          ]}
        />
      </Field>

      {provider ? (
        <Field title={names?.length ? `它列出的模型（${names.length} 个）` : "它列出的模型"}>
          {!names ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 40 }}>
              <PocketSpinner size={14} />
              <Text style={{ color: p.muted, fontSize: 13.5 }}>正在问它有哪些模型…</Text>
            </View>
          ) : q.isError ? (
            <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20 }}>没问到（{modelErrorText((q.error as Error).message).title}）。直接在上面填名字就行。</Text>
          ) : !names.length ? (
            <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20 }}>它没有列出模型，直接在上面填名字就行。</Text>
          ) : !matches.length ? (
            <Text style={{ color: p.muted, fontSize: 13.5, lineHeight: 20 }}>列表里没有名字里带“{name}”的，照你填的加也行。</Text>
          ) : (
            <View style={{ backgroundColor: p.surface, borderRadius: radius.card, paddingVertical: space.xs, overflow: "hidden" }}>
              {matches.slice(0, SHOWN).map((n, i) => {
                const inUse = used.has(modelKey({ provider, model: n }));
                const on = name === n;
                return (
                  <View key={n}>
                    {i ? <View style={{ height: 1, backgroundColor: p.divider, marginHorizontal: space.md }} /> : null}
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on, disabled: inUse }}
                      accessibilityLabel={inUse ? `${n}，已经在用` : n}
                      disabled={inUse}
                      onPress={() => setModel(n)}
                      style={({ pressed }) => ({
                        flexDirection: "row",
                        alignItems: "center",
                        gap: space.sm,
                        minHeight: 46,
                        paddingHorizontal: space.md,
                        backgroundColor: on ? p.accentContainer : pressed ? p.surface3 : "transparent",
                        opacity: inUse ? 0.5 : 1,
                      })}
                    >
                      <Text numberOfLines={1} style={{ flex: 1, color: p.ink, fontFamily: on ? fonts.monoBold : fonts.mono, fontSize: 13.5 }}>
                        {n}
                      </Text>
                      {inUse ? <Text style={{ color: p.faint, fontFamily: fonts.bodySemi, fontSize: 12 }}>在用</Text> : on ? <MaterialCommunityIcons name="check-circle" size={18} color={p.accentText} /> : null}
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}
          {matches.length > SHOWN ? <Text style={{ color: p.faint, fontSize: 12.5 }}>还有 {matches.length - SHOWN} 个，在上面输入几个字筛一下</Text> : null}
        </Field>
      ) : null}


      {error ? <Text style={{ color: p.error, lineHeight: 20 }}>{error}</Text> : null}
    </PocketSheet>
  );
}
