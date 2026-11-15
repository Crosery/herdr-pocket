/**
 * 模型: the models the assistant tries in order (the first is the main one,
 * the rest step in when one fails or stays silent), how fast each answers, and
 * the providers behind them. Every change is saved at once, for every phone.
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { ActivityIndicator, Button, IconButton, Text } from "react-native-paper";
import { router, Stack } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { ModelRef, ModelTestResult, ProviderView } from "@herdr-pocket/protocol";
import { Card, PageBackground, SectionHeader } from "../../components/ui";
import { Row, RowDivider } from "../../components/rows";
import { ConfigSnackbar, ConfirmDialog, LoadState, Note, Pill, WarningCard } from "../../components/configParts";
import { AddModelSheet } from "../../components/AddModelSheet";
import { changeConfig, keyLine, loadConfig, modelKey, PROTOCOL_LABEL, providerName, speedLine, testModel, useAssistantConfig, useConfigWatch, type ModelTest } from "../../lib/assistantConfig";
import { relTime } from "../../lib/format";
import { usePalette } from "../../theme/theme";
import { fonts, radius, space, statusColors } from "../../theme/tokens";

type Done = ModelTestResult & { running?: false; at: number };
const answered = (t: ModelTest | undefined): t is Done => !!t && !t.running;

export default function ModelsScreen() {
  const p = usePalette();
  useConfigWatch("config");
  const config = useAssistantConfig((s) => s.config);
  const error = useAssistantConfig((s) => s.configError);
  const tests = useAssistantConfig((s) => s.tests);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; undo?: ModelRef[] } | null>(null);
  const [adding, setAdding] = useState(false);
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
    void save(next, j === 0 || i === 0 ? `主模型换成了 ${next[0]!.model}` : "顺序改好了");
  };
  const makeMain = (i: number) => void save([models[i]!, ...models.filter((_, k) => k !== i)], `主模型换成了 ${models[i]!.model}`);
  const remove = (i: number) => void save(models.filter((_, k) => k !== i), `去掉了 ${models[i]!.model}`, models);

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
  const mainTest = tests[modelKey(models[0]!)];
  const mainDone = answered(mainTest) ? mainTest : null;
  // Worth saying when another one starts faster than the main model, or answered where the main one did not.
  const suggest = !round && best && best.i !== 0 && mainDone && (mainDone.ok ? !!fastest : true) ? best : null;

  return (
    <PageBackground>
      {header}
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: config.warnings.length ? space.md : 0, paddingBottom: space.xxxl }}>
        <WarningCard lines={config.warnings} />

        <SectionHeader
          title="正在用"
          right={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={round ? `正在测第 ${round.at} 个，共 ${round.total} 个，点一下停下` : "全部测一遍"}
              onPress={testAll}
              disabled={busy}
              hitSlop={6}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 5, minHeight: 34, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: pressed ? p.accentContainer : p.dark ? p.surface2 : "#FFF1F6" })}
            >
              {round ? <ActivityIndicator size={12} color={p.accentText} /> : <MaterialCommunityIcons name="speedometer" size={16} color={p.accentText} />}
              <Text style={{ color: p.accentText, fontFamily: fonts.bodyBold, fontSize: 13 }}>{round ? `正在测 ${round.at}/${round.total} · 停下` : "全部测一遍"}</Text>
            </Pressable>
          }
        />
        <Text style={{ color: p.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: space.xs, paddingBottom: space.sm }}>
          小羊按这个顺序用：第一个是主模型，它出错或一直不说话时换下一个。点一个模型，测测它多快开口。
        </Text>
        <Card style={{ paddingVertical: space.xs }}>
          {models.map((m, i) => (
            <View key={modelKey(m)}>
              {i ? <RowDivider /> : null}
              <ModelItem
                m={m}
                i={i}
                count={models.length}
                provider={providers.get(m.provider)}
                test={tests[modelKey(m)]}
                fastest={fastest?.i === i}
                busy={busy}
                onTest={() => void testModel(m)}
                onUp={() => move(i, -1)}
                onDown={() => move(i, 1)}
                onRemove={() => remove(i)}
              />
            </View>
          ))}
          <RowDivider />
          <Row icon="plus" title="添加模型" sub={models.length >= 12 ? "最多 12 个，先去掉一个" : "从服务商那里挑一个，加在最后当备用"} dim={models.length >= 12} onPress={
              models.length >= 12
                ? undefined
                : () => {
                    setSheet((n) => n + 1);
                    setAdding(true);
                  }
            }
          />
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
            <Button mode="contained" disabled={busy} onPress={() => makeMain(suggest.i)} style={{ alignSelf: "flex-start", borderRadius: radius.pill }}>
              设为主模型
            </Button>
          </Card>
        ) : null}

        <SectionHeader title="服务商" />
        <Card style={{ paddingVertical: space.xs }}>
          {config.providers.map((x, i) => (
            <View key={x.id}>
              {i ? <RowDivider /> : null}
              <Row
                icon={x.from === "server" ? "server-outline" : "cellphone-cog"}
                title={providerName(x)}
                sub={`${x.id} · ${PROTOCOL_LABEL[x.protocol]} · ${x.from === "server" ? "服务器上的" : "手机上加的"}`}
                onPress={() => router.push({ pathname: "/assistant-config/provider", params: { id: x.id } })}
              >
                <Text numberOfLines={1} style={{ color: p.muted, fontFamily: fonts.mono, fontSize: 12, lineHeight: 18, paddingTop: 2 }}>
                  {x.baseUrl || "还没有地址"}
                </Text>
                <Text style={{ color: x.key.set || x.auth === "none" ? p.muted : p.error, fontSize: 12.5, lineHeight: 18 }}>
                  密钥：{x.auth === "none" && !x.key.set ? "不用密钥" : keyLine(x.key)}
                </Text>
              </Row>
            </View>
          ))}
          <RowDivider />
          <Row icon="plus" title="添加服务商" sub="一个地址加一个密钥，Anthropic 或 OpenAI 兼容的都行" onPress={() => router.push("/assistant-config/provider")} />
        </Card>
        <View style={{ paddingTop: space.sm }}>
          <Note>服务器上配的服务商可以改，不能删；手机上加的可以删。密钥只能设、不能看，App 里只显示最后几位。</Note>
        </View>

        <SectionHeader title="恢复" />
        <Card style={{ paddingVertical: space.xs }}>
          <Row
            icon="backup-restore"
            tone="error"
            title="恢复成服务器上的设置"
            sub={config.edited ? "撤掉所有手机上的改动，手机上设的密钥也会删掉" : "现在用的就是服务器上的设置"}
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
        onAdded={(m) => {
          setAdding(false);
          setToast({ text: `加好了：${m.model}，正在测它` });
          void testModel(m);
        }}
      />
      <ConfirmDialog
        visible={askReset}
        title="恢复成服务器上的设置？"
        body="手机上改过的模型、服务商和语音都会撤掉，回到服务器自己的设置；在手机上设的密钥也会一起删掉。所有手机都会跟着变。"
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

function ModelItem({
  m,
  i,
  count,
  provider,
  test,
  fastest,
  busy,
  onTest,
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
  onTest: () => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  const p = usePalette();
  const role = i === 0 ? "主模型" : `备用 ${i}`;
  const from = provider ? `${providerName(provider)} · ${PROTOCOL_LABEL[provider.protocol]}` : `服务商 ${m.provider} 不在了`;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: space.lg, paddingRight: space.xs, paddingVertical: space.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${role}：${m.model}，${from}。点一下测速度`}
        onPress={onTest}
        disabled={test?.running}
        style={({ pressed }) => ({ flex: 1, gap: 3, paddingVertical: space.xs, opacity: pressed ? 0.6 : 1 })}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: space.sm, rowGap: 3 }}>
          <Pill text={role} tone={i === 0 ? "primary" : "soft"} />
          <Text style={{ flexShrink: 1, fontFamily: fonts.bodyBold, fontSize: 15.5, color: p.ink }}>{m.model}</Text>
          {fastest ? <Pill text="最快" tone="good" /> : null}
        </View>
        <Text numberOfLines={1} style={{ color: provider ? p.muted : p.error, fontSize: 12.5 }}>
          {from}
        </Text>
        <TestLine test={test} />
      </Pressable>
      <IconButton icon="chevron-up" size={20} disabled={busy || i === 0} onPress={onUp} accessibilityLabel={`${m.model} 上移`} style={{ margin: 0 }} />
      <IconButton icon="chevron-down" size={20} disabled={busy || i === count - 1} onPress={onDown} accessibilityLabel={`${m.model} 下移`} style={{ margin: 0 }} />
      <IconButton icon="trash-can-outline" size={20} disabled={busy || count === 1} onPress={onRemove} accessibilityLabel={`去掉 ${m.model}`} iconColor={p.error} style={{ margin: 0 }} />
    </View>
  );
}

/** The last test: first word prominently, then the whole answer; or why it failed. */
function TestLine({ test }: { test: ModelTest | undefined }) {
  const p = usePalette();
  if (!test) return <Text style={{ color: p.faint, fontSize: 12.5, lineHeight: 19 }}>点一下测测速度</Text>;
  if (test.running) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 19 }}>
        <ActivityIndicator size={12} />
        <Text style={{ color: p.muted, fontSize: 12.5 }}>正在测…</Text>
      </View>
    );
  }
  if (!test.ok) {
    return (
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 4 }}>
        <MaterialCommunityIcons name="alert-circle-outline" size={15} color={p.error} style={{ marginTop: 2 }} />
        <Text numberOfLines={3} style={{ flex: 1, color: p.error, fontSize: 12.5, lineHeight: 18 }}>
          没通：{test.error ?? "没有回话"}
        </Text>
      </View>
    );
  }
  const good = statusColors("working", p.dark).fg;
  const [first, ...rest] = speedLine(test).split(" · ");
  return (
    <View accessibilityLabel={speedLine(test)} style={{ flexDirection: "row", alignItems: "center", gap: 3, flexWrap: "wrap" }}>
      <MaterialCommunityIcons name="lightning-bolt" size={15} color={good} />
      <Text style={{ color: good, fontFamily: fonts.bodyBold, fontSize: 14 }}>{first || "通了"}</Text>
      {rest.length ? <Text style={{ color: p.muted, fontSize: 12.5 }}> · {rest.join(" · ")}</Text> : null}
    </View>
  );
}
