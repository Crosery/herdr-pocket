/**
 * 模型: the models the assistant tries in order (the first is the main one,
 * the rest step in when one fails or stays silent), how fast each answers, and
 * the providers behind them. Every change is saved at once, for every phone.
 *
 * A model row shows its place in the order on a numbered rail and keeps one
 * visible action ("设为主"); reordering and removing live in the "调整顺序" mode.
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "react-native-paper";
import { router, Stack } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { ModelRef, ModelTestResult, ProviderView } from "@herdr-pocket/protocol";
import { Card, PageBackground, SectionHeader } from "../../components/ui";
import { Row, RowDivider } from "../../components/rows";
import { ConfigSnackbar, ConfirmDialog, LoadState, Note, Pill, WarningCard } from "../../components/configParts";
import { PocketButton, PocketSpinner, RowAction } from "../../components/pocket";
import { AddModelSheet } from "../../components/AddModelSheet";
import { changeConfig, loadConfig, modelKey, PROTOCOL_LABEL, providerName, speedLine, testModel, useAssistantConfig, useConfigWatch, type ModelTest } from "../../lib/assistantConfig";
import { modelErrorText } from "../../lib/modelErrors";
import { relTime } from "../../lib/format";
import { usePalette } from "../../theme/theme";
import { fonts, radius, space, statusColors } from "../../theme/tokens";

type Done = ModelTestResult & { running?: false; at: number };
const answered = (t: ModelTest | undefined): t is Done => !!t && !t.running;
const MAX_MODELS = 12;

export default function ModelsScreen() {
  const p = usePalette();
  useConfigWatch("config");
  const config = useAssistantConfig((s) => s.config);
  const error = useAssistantConfig((s) => s.configError);
  const tests = useAssistantConfig((s) => s.tests);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; undo?: ModelRef[] } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  /** A new sheet each time it opens, so it starts fresh. */
  const [sheet, setSheet] = useState(0);
  const [askReset, setAskReset] = useState(false);
  const [round, setRound] = useState<{ at: number; total: number } | null>(null);
  const running = useRef<{ stop: boolean } | null>(null);
  useEffect(
    () => () => {
      if (running.current) running.current.stop = true;
    },
    [],
  );

  const header = <Stack.Screen options={{ title: "模型" }} />;
  if (!config) {
    return (
      <PageBackground>
        {header}
        <LoadState error={error} onRetry={loadConfig} />
      </PageBackground>
    );
  }

  const models = config.models;
  const providers = new Map(config.providers.map((x) => [x.id, x]));
  const full = models.length >= MAX_MODELS;

  async function save(next: ModelRef[], said: string, undo?: ModelRef[]) {
    setBusy(true);
    try {
      await changeConfig({ models: next });
      setToast({ text: said, undo });
    } catch (e) {
      setToast({ text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const move = (i: number, d: -1 | 1) => {
    const next = models.slice();
    const j = i + d;
    [next[i], next[j]] = [next[j]!, next[i]!];
    void save(next, j === 0 || i === 0 ? `主模型换成了 ${next[0]!.model}` : "顺序改好了", models);
  };
  const makeMain = (i: number) => void save([models[i]!, ...models.filter((_, k) => k !== i)], `主模型换成了 ${models[i]!.model}`, models);
  const remove = (i: number) => void save(models.filter((_, k) => k !== i), `去掉了 ${models[i]!.model}`, models);
  const openAdd = () => {
    setSheet((n) => n + 1);
    setAdding(true);
  };

  /** One after another, each result showing as it comes; tapping again stops after the current one. */
  async function testAll() {
    if (running.current) {
      running.current.stop = true;
      return;
    }
    const run = { stop: false };
    running.current = run;
    const list = models.slice();
    for (let i = 0; i < list.length && !run.stop; i++) {
      setRound({ at: i + 1, total: list.length });
      await testModel(list[i]!);
    }
    if (running.current === run) running.current = null;
    setRound(null);
  }

  // The fastest first word among those that answered, once there is something to compare.
  const timed = models.map((m, i) => ({ m, i, t: tests[modelKey(m)] })).filter((x): x is { m: ModelRef; i: number; t: Done } => answered(x.t) && x.t.ok && x.t.firstMs != null);
  const best = timed.length ? timed.reduce((a, b) => (b.t.firstMs! < a.t.firstMs! ? b : a)) : null;
  const fastest = timed.length >= 2 ? best : null;
  const mainTest = models[0] ? tests[modelKey(models[0])] : undefined;
  const mainDone = answered(mainTest) ? mainTest : null;
  // Worth saying when another one starts faster than the main model, or answered where the main one did not.
  const suggest = !round && !editing && best && best.i !== 0 && mainDone && (mainDone.ok ? !!fastest : true) ? best : null;
  const inUse = (id: string) => models.filter((m) => m.provider === id).length;

  return (
    <PageBackground>
      {header}
      {/* contentInsetAdjustmentBehavior: iOS keeps the last row clear of the home indicator; Android ignores it. */}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: config.warnings.length ? space.md : 0, paddingBottom: space.xxxl }}
      >
        <WarningCard lines={config.warnings} />

        <SectionHeader
          title="正在用"
          right={
            <View style={{ flexDirection: "row", gap: space.sm }}>
              {editing ? null : (
                <PocketButton
                  size="sm"
                  variant="soft"
                  icon={round ? undefined : "speedometer"}
                  loading={false}
                  lead={round ? <PocketSpinner size={14} /> : undefined}
                  disabled={busy || !models.length}
                  onPress={testAll}
                  a11y={round ? `正在测第 ${round.at} 个，共 ${round.total} 个，点一下停下` : "全部测一遍速度"}
                >
                  {round ? `${round.at}/${round.total} · 停下` : "全部测速"}
                </PocketButton>
              )}
              {models.length > 1 ? (
                <PocketButton size="sm" variant={editing ? "primary" : "ghost"} icon={editing ? "check" : "swap-vertical"} onPress={() => setEditing((v) => !v)} a11y={editing ? "完成调整" : "调整顺序或去掉模型"}>
                  {editing ? "完成" : "调整顺序"}
                </PocketButton>
              ) : null}
            </View>
          }
        />
        <Text style={{ color: p.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: space.xs, paddingBottom: space.sm }}>
          {editing
            ? "用上下箭头排顺序，排第一的就是主模型；去掉后几秒内可以撤销。"
            : "小羊从上往下用：第 1 个是主模型，它出错或一直不说话时换下一个。点一个模型，测测它多快开口。"}
        </Text>
        <Card style={{ paddingVertical: space.sm }}>
          {models.length ? (
            models.map((m, i) => (
              <ModelItem
                key={modelKey(m)}
                m={m}
                i={i}
                count={models.length}
                provider={providers.get(m.provider)}
                test={tests[modelKey(m)]}
                fastest={fastest?.i === i}
                busy={busy}
                editing={editing}
                onTest={() => void testModel(m)}
                onMakeMain={() => makeMain(i)}
                onUp={() => move(i, -1)}
                onDown={() => move(i, 1)}
                onRemove={() => remove(i)}
              />
            ))
          ) : (
            <View style={{ padding: space.lg, gap: space.xs }}>
              <Text style={{ color: p.error, fontFamily: fonts.bodyBold }}>还没有模型，小羊没法回话</Text>
              <Text style={{ color: p.muted, fontSize: 13 }}>先加一个服务商，再从它那里挑模型。</Text>
            </View>
          )}
          {editing ? null : (
            <>
              <RowDivider />
              <Row icon="plus" title="添加模型" sub={full ? `最多 ${MAX_MODELS} 个，先去掉一个` : "从服务商那里挑一个，可以当备用或直接设为主模型"} dim={full} onPress={full ? undefined : openAdd} />
            </>
          )}
        </Card>

        {suggest ? (
          <Card style={{ marginTop: space.md, padding: space.lg, gap: space.md, borderWidth: 1.5, borderColor: p.primary }}>
            <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
              <MaterialCommunityIcons name="lightning-bolt" size={20} color={statusColors("working", p.dark).fg} />
              <Text style={{ flex: 1, color: p.ink, fontSize: 14, lineHeight: 21 }}>
                {mainDone?.ok && mainDone.firstMs != null
                  ? `「${suggest.m.model}」开口最快，首字 ${(suggest.t.firstMs! / 1000).toFixed(1)} 秒；主模型要 ${(mainDone.firstMs / 1000).toFixed(1)} 秒。`
                  : `主模型这次没通，「${suggest.m.model}」通了，首字 ${(suggest.t.firstMs! / 1000).toFixed(1)} 秒。`}
              </Text>
            </View>
            <PocketButton icon="star-outline" disabled={busy} onPress={() => makeMain(suggest.i)} style={{ alignSelf: "flex-start" }}>
              设为主模型
            </PocketButton>
          </Card>
        ) : null}

        <SectionHeader title="服务商" />
        <Card style={{ paddingVertical: space.xs }}>
          {config.providers.map((x, i) => (
            <View key={x.id}>
              {i ? <RowDivider /> : null}
              <ProviderRow x={x} used={inUse(x.id)} />
            </View>
          ))}
          {config.providers.length ? <RowDivider /> : null}
          <Row icon="plus" title="添加服务商" sub="选常用平台预设，自动扫描可用模型" onPress={() => router.push("/assistant-config/provider")} />
        </Card>
        <View style={{ paddingTop: space.sm }}>
          <Note>服务器上配的服务商可以改，不能删；App 里加的可以删。密钥只能设、不能看，App 里只显示最后几位。</Note>
        </View>

        <SectionHeader title="恢复" />
        <Card style={{ paddingVertical: space.xs }}>
          <Row
            icon="backup-restore"
            tone="error"
            title="恢复成服务器上的设置"
            sub={config.edited ? "撤掉所有 App 里的改动，App 里设的密钥也会删掉" : "现在用的就是服务器上的设置"}
            dim={!config.edited || busy}
            onPress={config.edited && !busy ? () => setAskReset(true) : undefined}
          />
        </Card>
        {config.updatedAt ? (
          <View style={{ paddingTop: space.sm }}>
            <Note>
              {relTime(config.updatedAt)}
              {config.updatedBy ? `由「${config.updatedBy}」` : ""}改过。改动马上生效，所有手机看到的都一样。
            </Note>
          </View>
        ) : null}
      </ScrollView>

      <AddModelSheet
        key={sheet}
        visible={adding}
        onDismiss={() => setAdding(false)}
        config={config}
        onAdded={(m, asMain) => {
          setAdding(false);
          setToast({ text: asMain ? `${m.model} 现在是主模型，正在测它` : `加好了：${m.model}，正在测它` });
          void testModel(m);
        }}
      />
      <ConfirmDialog
        visible={askReset}
        title="恢复成服务器上的设置？"
        body="App 里改过的模型、服务商和语音都会撤掉，回到服务器自己的设置；在 App 里设的密钥也会一起删掉。所有手机和电脑都会跟着变。"
        action="恢复"
        danger
        onDismiss={() => setAskReset(false)}
        onConfirm={async () => {
          setAskReset(false);
          setBusy(true);
          try {
            await changeConfig({ reset: true });
            setToast({ text: "已经恢复成服务器上的设置" });
          } catch (e) {
            setToast({ text: (e as Error).message });
          } finally {
            setBusy(false);
          }
        }}
      />
      <ConfigSnackbar
        message={toast?.text ?? null}
        onDismiss={() => setToast(null)}
        action={toast?.undo ? { label: "撤销", onPress: () => void save(toast.undo!, "撤销了") } : undefined}
      />
    </PageBackground>
  );
}

/** The order badge: a pink "主" for the main model, a soft number for each fallback, joined by a thin rail. */
function OrderBadge({ i, count }: { i: number; count: number }) {
  const p = usePalette();
  const main = i === 0;
  const rail = p.dark ? p.surface3 : "#F3DCE6";
  return (
    <View style={{ width: 34, alignItems: "center" }}>
      <View style={{ width: 2, flex: 1, minHeight: 6, backgroundColor: i ? rail : "transparent" }} />
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 15,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: main ? p.primary : p.accentContainer,
          borderWidth: main ? 0 : 1,
          borderColor: p.dark ? p.surface3 : "#FFD3E2",
        }}
      >
        <Text style={{ color: main ? p.onPrimary : p.accentText, fontFamily: main ? fonts.cute : fonts.bodyBold, fontSize: main ? 15 : 13.5, lineHeight: 20 }}>{main ? "主" : i + 1}</Text>
      </View>
      <View style={{ width: 2, flex: 1, minHeight: 6, backgroundColor: i < count - 1 ? rail : "transparent" }} />
    </View>
  );
}

function ModelItem({
  m,
  i,
  count,
  provider,
  test,
  fastest,
  busy,
  editing,
  onTest,
  onMakeMain,
  onUp,
  onDown,
  onRemove,
}: {
  m: ModelRef;
  i: number;
  count: number;
  provider: ProviderView | undefined;
  test: ModelTest | undefined;
  fastest: boolean;
  busy: boolean;
  editing: boolean;
  onTest: () => void;
  onMakeMain: () => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  const p = usePalette();
  // The badge carries the place in the order; the words only say main or fallback, so there is one numbering.
  const role = i === 0 ? "主模型" : "备用";
  const from = provider ? `${providerName(provider)} · ${PROTOCOL_LABEL[provider.protocol]}` : `服务商 ${m.provider} 不在了`;
  return (
    <View style={{ flexDirection: "row", alignItems: "stretch", paddingLeft: space.md, paddingRight: space.md, gap: space.sm }}>
      <OrderBadge i={i} count={count} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`第 ${i + 1} 个，${role}：${m.model}，${from}。点一下测速度`}
        onPress={onTest}
        disabled={test?.running}
        style={({ pressed }) => ({ flex: 1, gap: 3, paddingVertical: space.md, opacity: pressed ? 0.6 : 1 })}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.sm, rowGap: 3 }}>
          <Text style={{ flexShrink: 1, fontFamily: fonts.bodyBold, fontSize: 15.5, color: p.ink }}>{m.model}</Text>
          {fastest ? <Pill text="最快" tone="good" /> : null}
        </View>
        <Text numberOfLines={1} style={{ color: provider ? p.muted : p.error, fontSize: 12.5 }}>
          {role} · {from}
        </Text>
        <TestLine test={test} />
      </Pressable>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {editing ? (
          <>
            <RowAction icon="arrow-up" a11y={`${m.model} 上移`} disabled={busy || i === 0} onPress={onUp} />
            <RowAction icon="arrow-down" a11y={`${m.model} 下移`} disabled={busy || i === count - 1} onPress={onDown} />
            <RowAction icon="close" danger a11y={`去掉 ${m.model}`} disabled={busy || count === 1} onPress={onRemove} />
          </>
        ) : i > 0 ? (
          <PocketButton size="sm" variant="soft" disabled={busy} onPress={onMakeMain} a11y={`把 ${m.model} 设为主模型`}>
            设为主
          </PocketButton>
        ) : null}
      </View>
    </View>
  );
}

/** A provider: its name, how it is reached, whether its key is there, and how many models use it. */
function ProviderRow({ x, used }: { x: ProviderView; used: number }) {
  const p = usePalette();
  const good = statusColors("working", p.dark);
  const keyOk = x.key.set || x.auth === "none";
  const keyText = x.auth === "none" && !x.key.set ? "不用密钥" : x.key.set ? `密钥 ··${x.key.hint ?? ""}` : "缺密钥";
  return (
    <Row
      icon={x.from === "server" ? "server-outline" : "cellphone-cog"}
      title={providerName(x)}
      sub={`${PROTOCOL_LABEL[x.protocol]} · ${x.from === "server" ? "服务器上的" : "App 里加的"}`}
      onPress={() => router.push({ pathname: "/assistant-config/provider", params: { id: x.id } })}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 6 }}>
        <View
          accessibilityLabel={keyOk ? keyText : "还没有密钥，用它的模型会失败"}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: keyOk ? good.bg : p.errorContainer, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 }}
        >
          <MaterialCommunityIcons name={keyOk ? "key-variant" : "key-alert-outline"} size={12} color={keyOk ? good.fg : p.error} />
          <Text style={{ color: keyOk ? good.fg : p.error, fontFamily: fonts.bodyBold, fontSize: 11.5 }}>{keyText}</Text>
        </View>
        <Pill text={used ? `在用 ${used} 个模型` : "没有模型在用"} tone={used ? "soft" : "plain"} />
      </View>
      <Text numberOfLines={1} style={{ color: p.faint, fontFamily: fonts.mono, fontSize: 11.5, lineHeight: 17, paddingTop: 4 }}>
        {x.baseUrl || "还没有地址"}
      </Text>
    </Row>
  );
}

/** The last test: first word prominently, then the whole answer; or, in plain words, why it failed. */
function TestLine({ test }: { test: ModelTest | undefined }) {
  const p = usePalette();
  if (!test) return <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 19 }}>点一下测测速度</Text>;
  if (test.running) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 19 }}>
        <PocketSpinner size={12} />
        <Text style={{ color: p.muted, fontSize: 12.5 }}>正在测…</Text>
      </View>
    );
  }
  if (!test.ok) {
    const e = modelErrorText(test.error);
    return (
      <View accessibilityLabel={`没通：${e.title}`} style={{ flexDirection: "row", alignItems: "flex-start", gap: 4 }}>
        <MaterialCommunityIcons name="alert-circle-outline" size={15} color={p.error} style={{ marginTop: 2 }} />
        <View style={{ flex: 1, gap: 1 }}>
          <Text style={{ color: p.error, fontFamily: fonts.bodyBold, fontSize: 13, lineHeight: 19 }}>没通：{e.title}</Text>
          {e.detail ? (
            <Text numberOfLines={2} style={{ color: p.faint, fontSize: 11.5, lineHeight: 16 }}>
              {e.detail}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }
  const good = statusColors("working", p.dark).fg;
  const [first, ...rest] = speedLine(test).split(" · ");
  return (
    <View accessibilityLabel={speedLine(test) || "通了"} style={{ flexDirection: "row", alignItems: "center", gap: 3, flexWrap: "wrap" }}>
      <MaterialCommunityIcons name="lightning-bolt" size={15} color={good} />
      <Text style={{ color: good, fontFamily: fonts.bodyBold, fontSize: 14 }}>{first || "通了"}</Text>
      {rest.length ? <Text style={{ color: p.muted, fontSize: 12.5 }}> · {rest.join(" · ")}</Text> : null}
    </View>
  );
}
