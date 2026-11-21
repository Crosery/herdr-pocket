/**
 * "新建 agent / 新建空间" bottom sheet. Talks to the chosen host with `spaces.list` (read-only)
 * and `agent.create`; on success jumps to the new agent (which may take a moment to appear).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import { Text } from "react-native-paper";
import { router } from "expo-router";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { Device } from "@herdr-pocket/protocol";
import { call, type RelayError } from "../lib/relay";
import { harnessLook } from "../lib/harness";
import { useSettings } from "../lib/store";
import { usePalette } from "../theme/theme";
import { fonts, radius, space } from "../theme/tokens";
import { HarnessAvatar } from "./ui";
import { SpaceBadge } from "./agents";
import { PocketButton, PocketChip, PocketSheet, PocketSpinner } from "./pocket";
import { Input } from "./configParts";

export interface CreateTarget {
  /** Preferred host id. */
  host?: string | null;
  /** Existing space name to add a tab to; null = new space. */
  spaceName?: string | null;
  /** Folder to start in when that space is not there (any more): e.g. the folder of the agent it came from. */
  folder?: string | null;
}

const NEW = "__new__";

function Chip({ on, label, onPress, lead, a11y, disabled }: { on: boolean; label: string; onPress: () => void; lead?: React.ReactNode; a11y?: string; disabled?: boolean }) {
  return <PocketChip on={on} label={label} onPress={onPress} lead={lead} a11y={a11y} disabled={disabled} maxWidth={180} />;
}

function Field({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  const p = usePalette();
  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ fontFamily: fonts.bodyBold, color: p.ink, fontSize: 14 }}>{title}</Text>
      {children}
      {hint ? <Text style={{ color: p.faint, fontSize: 12 }}>{hint}</Text> : null}
    </View>
  );
}

export function CreateAgentSheet({ visible, onDismiss, target, hosts }: { visible: boolean; onDismiss: () => void; target: CreateTarget; hosts: Device[] }) {
  const p = usePalette();
  const online = hosts.filter((h) => h.online);
  const lastHost = useSettings((s) => s.lastCreateHost);
  // No computer asked for: try the one created on last time, then the others as listed.
  const auto = !(target.host && hosts.some((h) => h.id === target.host));
  const ids = online.map((h) => h.id);
  const order = lastHost && ids.includes(lastHost) ? [lastHost, ...ids.filter((id) => id !== lastHost)] : ids;
  const pickHost = () => (auto ? order[0] ?? null : target.host!);
  const [host, setHost] = useState<string | null>(pickHost);
  // The computer is decided once per opening (picked below, or tapped); it is not swapped under the person later.
  const [settled, setSettled] = useState(false);
  // Which computers can create right now is only known from their `spaces.list` (same cache as below).
  const probes = useQueries({
    queries: order.map((id) => ({
      queryKey: ["spaces.list", id],
      queryFn: () => call(id, "spaces.list", {}),
      enabled: visible && auto,
      staleTime: 5000,
      retry: false,
    })),
  });
  // One letter per computer in `order`: "?" still asking, "y" can create, "n" cannot or did not answer.
  const canCreateByOrder = probes.map((r) => (r.isPending ? "?" : r.data?.canCreate ? "y" : "n")).join("");
  const [spaceId, setSpaceId] = useState<string>(NEW);
  const [spaceName, setSpaceName] = useState("");
  const [folder, setFolder] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);
  const initKeyRef = useRef<string>("");
  const [launcher, setLauncher] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["spaces.list", host],
    queryFn: () => call(host!, "spaces.list", {}),
    enabled: visible && !!host,
    staleTime: 5000,
    retry: false,
  });

  // Reset when the sheet opens.
  useEffect(() => {
    if (!visible) {
      initKeyRef.current = "";
      return;
    }
    setHost(pickHost());
    setSettled(false);
    setSpaceName("");
    setFolderTouched(false);
    setTask("");
    setError(null);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Settle on the first computer in `order` that can create, once every computer before it has answered;
  // if none can, the first online one, whose notice then says why.
  useEffect(() => {
    if (!visible || !auto || settled) return;
    let best: string | null = null;
    for (let i = 0; i < order.length; i++) {
      const s = canCreateByOrder[i];
      if (s === "?") return;
      if (s === "y") {
        best = order[i]!;
        break;
      }
    }
    setHost(best ?? online[0]?.id ?? null);
    setSettled(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, auto, settled, canCreateByOrder]);

  // Once spaces arrive for the active host: initialize space, folder, and launcher once per host switch.
  useEffect(() => {
    const d = q.data;
    if (!d || !visible || !host) return;
    const initKey = `${host}:${target.spaceName ?? ""}`;
    if (initKeyRef.current === initKey) {
      if (!folderTouched && spaceId !== NEW) {
        const spNow = d.spaces.find((s) => s.id === spaceId);
        if (spNow?.folder) setFolder(spNow.folder);
      }
      return;
    }
    initKeyRef.current = initKey;
    const sp = target.spaceName ? d.spaces.find((s) => s.name === target.spaceName) : undefined;
    setSpaceId(sp ? sp.id : NEW);
    setFolder(sp?.folder ?? target.folder ?? "");
    setFolderTouched(false);
    // Asked for a space this computer does not list: offer a new one under the same name, not a blank form.
    if (target.spaceName && !sp) setSpaceName(target.spaceName);
    setLauncher((l) => (l && d.launchers.some((x) => x.id === l) ? l : d.launchers[0]?.id ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, visible, host, target.spaceName]);

  const d = q.data;
  // A computer without the desktop herdr (Windows): no spaces, just a terminal in a folder.
  const standalone = !!d?.standalone;
  const isNew = spaceId === NEW && !standalone;
  const chosenSpace = d?.spaces.find((s) => s.id === spaceId);
  const missingSpace = !!d && !standalone && isNew && !!target.spaceName && !d.spaces.some((s) => s.name === target.spaceName) ? target.spaceName : null;
  const launch = d?.launchers.find((l) => l.id === launcher);
  // Programs that can't take a task at start get it typed in once they're up, where the computer does that.
  const takesTask = !!launch && launch.id !== "shell" && (launch.takesTask || !!d?.typesTask);
  const folders = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of [...(chosenSpace?.folder ? [chosenSpace.folder] : []), ...(d?.folders ?? [])]) {
      const clean = raw.trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
      if (out.length >= 8) break;
    }
    return out;
  }, [d?.folders, chosenSpace?.folder]);
  const canSubmit = !!host && !!d?.canCreate && !!launcher && !busy;

  async function submit() {
    if (!host || !launcher || !d) return;
    setBusy(true);
    setError(null);
    try {
      const first = takesTask && task.trim() ? task.trim() : undefined;
      // A task typed in after start makes the computer wait for the program (up to about 45 s).
      const typed = !!first && !launch?.takesTask;
      const res = await call(
        host,
        "agent.create",
        {
          ...(standalone ? {} : isNew ? { spaceName: spaceName.trim() || undefined } : { space: spaceId }),
          folder: folder.trim() || undefined,
          launcher,
          task: first,
        },
        typed ? 90_000 : undefined,
      );
      useSettings.getState().set({ lastCreateHost: host });
      onDismiss();
      if (res.task === "failed") Alert.alert("开好了，但第一句话没交给它", res.taskNote ?? "它现在空着，没在做这件事。");
      router.push({ pathname: "/agent/[key]", params: { key: res.agent, tab: "chat", fresh: String(Date.now()) } });
    } catch (e) {
      const err = e as RelayError;
      // It may well be open already: say so, so nobody taps again and gets two.
      setError(err.code === "timeout" ? "电脑那边还没回话，它可能已经开好了。先去 Agents 列表看一眼，别重复点" : err.message);
    } finally {
      setBusy(false);
    }
  }

  const hostName = hosts.find((h) => h.id === host)?.name;
  // Until the computer answers, the title follows what was asked for, so it does not flip once spaces arrive.
  const title = !d ? (target.spaceName ? `在「${target.spaceName}」新建` : "新建") : standalone ? "新建 agent" : isNew ? "新建空间" : `在「${chosenSpace?.name ?? "这个空间"}」新建`;
  const what = standalone ? "开一个新终端" : !d ? (target.spaceName ? "开一个新标签" : "新建") : isNew ? "开一个新空间，并在里面启动程序" : "开一个新标签";
  const sub = hostName ? `在 ${hostName} 上${what}` : undefined;

  const footer = (
    <>
      <Text style={{ color: p.faint, fontSize: 12, textAlign: "center" }}>
        {busy && takesTask && task.trim() && !launch?.takesTask ? "等它启动好再把第一句话打进去，可能要半分钟到一分钟" : standalone ? "建好后，在电脑上用 hc attach 可以接手它" : "建好后，电脑上的 herdr 会自动切到这个空间"}
      </Text>
      <PocketButton size="lg" block icon="plus" disabled={!canSubmit} loading={busy} onPress={submit}>
        {isNew ? "新建空间并启动" : "新建 agent"}
      </PocketButton>
    </>
  );

  return (
    <PocketSheet visible={visible} onDismiss={onDismiss} title={title} sub={sub} footer={footer}>
      <Field title="电脑">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {hosts.map((h) => (
            <Chip
              key={h.id}
              on={host === h.id}
              disabled={!h.online}
              onPress={() => {
                setSettled(true);
                setHost(h.id);
              }}
              label={h.online ? h.name : `${h.name}（离线）`}
              a11y={`${h.name}，${h.online ? "在线" : "离线"}`}
              lead={<View style={{ width: 8, height: 8, borderRadius: 4, marginLeft: 6, backgroundColor: h.online ? "#3FB68B" : p.faint }} />}
            />
          ))}
        </View>
      </Field>

      {!host ? (
        <Text style={{ color: p.muted }}>没有在线的电脑。</Text>
      ) : q.isLoading ? (
        <View style={{ alignItems: "center", gap: space.sm, marginVertical: space.xl }}>
          <PocketSpinner size={28} />
          <Text style={{ color: p.muted, fontSize: 13 }}>正在问这台电脑有哪些空间和程序…</Text>
        </View>
      ) : q.isError ? (
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center", backgroundColor: p.errorContainer, borderRadius: radius.md, padding: space.md }}>
          <MaterialCommunityIcons name="alert-circle-outline" size={18} color={p.error} />
          <Text style={{ flex: 1, color: p.error, fontSize: 13.5, lineHeight: 19 }}>{(q.error as Error).message}</Text>
          <PocketButton size="sm" variant="ghost" onPress={() => void q.refetch()}>
            再试
          </PocketButton>
        </View>
      ) : d ? (
        <>
          {!d.canCreate ? (
            <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center", backgroundColor: p.errorContainer, borderRadius: radius.md, padding: space.md }}>
              <MaterialCommunityIcons name="information-outline" size={18} color={p.error} />
              <Text style={{ flex: 1, color: p.error, fontSize: 13.5 }}>{d.reason ?? "这台电脑现在不能新建。"}</Text>
            </View>
          ) : null}

          {standalone ? null : (
            <Field title="空间">
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                <Chip
                  on={isNew}
                  onPress={() => {
                    setSpaceId(NEW);
                    setFolder("");
                    setFolderTouched(false);
                  }}
                  label="新建空间"
                  lead={<MaterialCommunityIcons name="plus" size={18} color={isNew ? p.accentText : p.ink} style={{ marginLeft: 4 }} />}
                />
                {d.spaces.map((s) => (
                  <Chip
                    key={s.id}
                    on={spaceId === s.id}
                    onPress={() => {
                      setSpaceId(s.id);
                      setFolder(s.folder ?? "");
                      setFolderTouched(false);
                    }}
                    label={s.name}
                    lead={<SpaceBadge name={s.name} size={26} />}
                    a11y={`空间 ${s.name}`}
                  />
                ))}
              </View>
            </Field>
          )}

          {missingSpace ? (
            <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start", backgroundColor: p.lavenderContainer, borderRadius: radius.md, padding: space.md }}>
              <MaterialCommunityIcons name="information-outline" size={18} color={p.dusk} style={{ marginTop: 1 }} />
              <Text style={{ flex: 1, color: p.ink, fontSize: 13.5, lineHeight: 20 }}>{`这台电脑现在没有「${missingSpace}」这个空间，可能已经关了。会新建一个同名空间；也可以在上面挑一个现有的。`}</Text>
            </View>
          ) : null}

          {isNew ? (
            <Field title="空间名字">
              <Input value={spaceName} onChangeText={setSpaceName} placeholder="不填就用文件夹名" accessibilityLabel="空间名字" />
            </Field>
          ) : null}

          <Field title="文件夹" hint={isNew || standalone ? "不填就是 ~" : "不填就用这个空间的文件夹"}>
            {folders.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
                {folders.map((f) => (
                  <Chip
                    key={f}
                    on={folder.trim() === f}
                    onPress={() => {
                      setFolder(folder.trim() === f ? "" : f);
                      setFolderTouched(true);
                    }}
                    label={f}
                  />
                ))}
              </ScrollView>
            ) : null}
            <Input
              value={folder}
              onChangeText={(v) => {
                setFolder(v);
                setFolderTouched(true);
              }}
              placeholder="~/work_file/项目"
              autoCapitalize="none"
              mono
              accessibilityLabel="文件夹路径"
            />
          </Field>

          <Field title="程序">
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {d.launchers.map((l) => (
                <Chip
                  key={l.id}
                  on={launcher === l.id}
                  onPress={() => setLauncher(l.id)}
                  label={l.label}
                  lead={<HarnessAvatar harness={l.id === "shell" ? "sh" : l.id} isShell={l.id === "shell"} size={28} />}
                  a11y={harnessLook(l.id, l.id === "shell").label}
                />
              ))}
            </View>
          </Field>

          {takesTask ? (
            <Field title="第一句话" hint={launch?.takesTask ? "可选，启动后直接发给它" : "可选，等它启动好后由电脑打进去"}>
              <Input
                value={task}
                onChangeText={setTask}
                multiline
                placeholder="比如：帮我看看这个项目的测试为什么挂了"
                style={{ minHeight: 88, paddingVertical: space.sm, textAlignVertical: "top" }}
                accessibilityLabel="第一句话"
              />
            </Field>
          ) : null}

          {error ? (
            <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start", backgroundColor: p.errorContainer, borderRadius: radius.md, padding: space.md }}>
              <MaterialCommunityIcons name="alert-circle-outline" size={18} color={p.error} style={{ marginTop: 1 }} />
              <Text style={{ flex: 1, color: p.error, lineHeight: 20 }}>{error}</Text>
            </View>
          ) : null}
        </>
      ) : null}
    </PocketSheet>
  );
}
