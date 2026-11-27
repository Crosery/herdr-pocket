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
import { ModelBrandIcon } from "../../components/ModelBrandIcon";
import { changeConfig, loadConfig, modelKey, PROTOCOL_LABEL, providerName, testModel, useAssistantConfig, useConfigWatch, type ModelTest } from "../../lib/assistantConfig";
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
        <Text style={{ color: p.muted, fontSize: 12.5, lineHeight: 18, paddingHorizontal: space.xs, paddingBottom: space.sm }}>
          {editing
            ? "上下箭头调顺序，第 1 个为主模型；移除后可撤销。"
            : "第 1 个为主模型，出错或沉默时按序顺延；点延迟徽标可单测。"}
        </Text>
        <Card style={{ paddingVertical: 4, overflow: "hidden" }}>
          {models.length ? (
            models.map((m, i) => (
              <View key={modelKey(m)}>
                {i > 0 ? <RowDivider /> : null}
                <ModelItem
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
              </View>
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

/** Compact Agent-style model row (no tall vertical timeline rail). */
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
  const isMain = i === 0;
  const from = provider ? `${providerName(provider)} · ${PROTOCOL_LABEL[provider.protocol]}` : `${m.provider} 不在了`;
  const good = statusColors("working", p.dark);
  const msVal = test && !test.running && test.ok ? (test.firstMs ?? test.totalMs ?? null) : null;
  const failed = test && !test.running && !test.ok ? modelErrorText(test.error) : null;

  return (
    <View
      style={{
        backgroundColor: isMain ? p.accentContainer : "transparent",
        paddingHorizontal: space.md,
        paddingVertical: 10,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 9, minHeight: 38 }}>
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: isMain ? p.primary : p.surface2,
            borderWidth: isMain ? 0 : 1,
            borderColor: p.divider,
          }}
        >
          <Text
            style={{
              color: isMain ? p.onPrimary : p.faint,
              fontFamily: isMain ? fonts.bodyBold : fonts.mono,
              fontSize: 11,
            }}
          >
            {isMain ? "主" : i + 1}
          </Text>
        </View>

        <ModelBrandIcon
          model={m.model}
          provider={provider ? providerName(provider) : m.provider}
          size={16}
          color={isMain ? p.accentText : p.ink}
        />

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${isMain ? "主模型" : `第 ${i + 1} 备用`}：${m.model}，${from}`}
          disabled={editing || isMain || busy}
          onPress={onMakeMain}
          style={({ pressed }) => ({ flex: 1, minWidth: 0, gap: 2, opacity: pressed ? 0.65 : 1 })}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text
              numberOfLines={1}
              style={{
                flexShrink: 1,
                fontFamily: fonts.mono,
                fontSize: 13,
                fontWeight: isMain ? "700" : "600",
                color: isMain ? p.accentText : p.ink,
              }}
            >
              {m.model}
            </Text>
            {fastest ? <Pill text="最快" tone="good" /> : null}
          </View>
          <Text numberOfLines={1} style={{ color: provider ? p.faint : p.error, fontSize: 11.5 }}>
            {from}
          </Text>
        </Pressable>

        {editing ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <RowAction icon="arrow-up" a11y={`${m.model} 上移`} disabled={busy || i === 0} onPress={onUp} />
            <RowAction icon="arrow-down" a11y={`${m.model} 下移`} disabled={busy || i === count - 1} onPress={onDown} />
            <RowAction icon="close" danger a11y={`去掉 ${m.model}`} disabled={busy || count === 1} onPress={onRemove} />
          </View>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`测速 ${m.model}`}
              disabled={test?.running}
              onPress={onTest}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 3,
                minHeight: 28,
                paddingHorizontal: 8,
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: failed ? p.error : msVal != null ? good.fg : p.divider,
                backgroundColor: failed ? p.errorContainer : msVal != null ? good.bg : p.surface,
                opacity: pressed ? 0.65 : 1,
              })}
            >
              {test?.running ? (
                <PocketSpinner size={11} />
              ) : failed ? (
                <MaterialCommunityIcons name="alert-circle-outline" size={12} color={p.error} />
              ) : msVal != null ? (
                <MaterialCommunityIcons name="lightning-bolt" size={12} color={good.fg} />
              ) : (
                <MaterialCommunityIcons name="speedometer" size={12} color={p.faint} />
              )}
              <Text
                numberOfLines={1}
                style={{
                  fontFamily: msVal != null ? fonts.mono : fonts.bodySemi,
                  fontSize: 11,
                  color: failed ? p.error : msVal != null ? good.fg : p.muted,
                  maxWidth: 74,
                }}
              >
                {test?.running ? "测速" : failed ? failed.title : msVal != null ? `${(msVal / 1000).toFixed(2)}s` : "测速"}
              </Text>
            </Pressable>
            {isMain ? (
              <MaterialCommunityIcons name="check" size={16} color={p.accentText} />
            ) : (
              <PocketButton size="sm" variant="soft" disabled={busy} onPress={onMakeMain} a11y={`把 ${m.model} 设为主模型`}>
                设为主
              </PocketButton>
            )}
          </View>
        )}
      </View>
      {failed?.detail ? (
        <Text numberOfLines={2} style={{ color: p.error, fontSize: 11.5, marginTop: 4, paddingLeft: 31 }}>
          {failed.detail}
        </Text>
      ) : null}
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
