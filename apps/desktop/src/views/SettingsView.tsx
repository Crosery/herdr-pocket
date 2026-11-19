import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Bell, CloudDownload, Download, LogOut, Mic, Pencil, Plus, RefreshCw, RotateCcw, Save, Sparkles, Trash2 } from "lucide-react";
import {
  OPENAI_REALTIME_VOICES,
  PROVIDER_PRESETS,
  type ModelAuth,
  type ModelProtocol,
  type ModelRef,
  type ModelTestResult,
  type PromptId,
  type ProviderPatch,
  type ProviderPresetItem,
  type ProviderView,
  type VoiceProviderId,
} from "@herdr-pocket/protocol";
import {
  PocketBadge,
  PocketButton,
  PocketCard,
  PocketInput,
  PocketModal,
  PocketSelect,
  PocketSwitch,
  PocketTextarea,
  useToast,
} from "../components/PocketUI";
import {
  appVersion,
  checkReleaseUpdate,
  detectPlatform,
  getHostdStatus,
  openExternalUrl,
  pushSystemNotification,
  type HostdLocalStatus,
  type ReleaseUpdateInfo,
} from "../lib/bridge";
import {
  assistantConfigStore,
  fetchAssistantProviderModels,
  loadAssistantConfig,
  saveAssistantConfig,
  saveAssistantPrompt,
  testAssistantModel,
} from "../lib/assistant";
import { refreshNotifyChannel, signOut } from "../lib/relay";
import { settingsStore, updateSettings, type ThemeChoice } from "../lib/store";

const PROTOCOL_LABELS: Record<ModelProtocol, string> = {
  openai: "OpenAI 兼容",
  "openai-responses": "Responses / Codex",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  ollama: "Ollama 本地",
};

const URL_HINTS: Record<ModelProtocol, string> = {
  openai: "https://api.example.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  ollama: "http://localhost:11434",
};

function deriveProviderId(presetId: string | null, label: string, url: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  let raw = presetId && presetId !== "custom" ? presetId : "";
  if (!raw && label.trim()) raw = label.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!raw && url.trim()) {
    try {
      const host = new URL(url.trim()).hostname.replace(/^(api|llm|gateway|token-plan(?:-cn)?)\./i, "");
      raw = (host.split(".")[0] ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "");
    } catch {
      raw = "";
    }
  }
  if (!raw || !/^[a-z]/.test(raw)) raw = raw ? `p-${raw}` : "custom-gw";
  const base = raw.slice(0, 26);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 99; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `gw-${Date.now().toString(36).slice(-4)}`;
}

export function SettingsView() {
  const toast = useToast();
  const s = settingsStore.use((v) => v);
  const cfg = assistantConfigStore.use((v) => v.config);
  const prompts = assistantConfigStore.use((v) => v.prompts);

  const [hostd, setHostd] = useState<HostdLocalStatus | null>(null);
  const [updateInfo, setUpdateInfo] = useState<ReleaseUpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  // Assistant config section states
  const [subTab, setSubTab] = useState<"app" | "models" | "voice" | "prompts">("app");
  const [assistantName, setAssistantName] = useState("小羊");
  const [voiceProvider, setVoiceProvider] = useState<VoiceProviderId | "off">("openai-realtime");
  const [voiceUrl, setVoiceUrl] = useState("");
  const [voiceModel, setVoiceModel] = useState("gpt-realtime");
  const [voiceId, setVoiceId] = useState("marin");
  const [voiceKey, setVoiceKey] = useState("");
  const [testingModel, setTestingModel] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<{ id: PromptId; text: string } | null>(null);

  // Provider & scanner modal states
  const [provModalOpen, setProvModalOpen] = useState(false);
  const [editingProv, setEditingProv] = useState<ProviderView | null>(null);
  const [presetId, setPresetId] = useState<string | null>("mimo");
  const [pLabel, setPLabel] = useState("");
  const [pProtocol, setPProtocol] = useState<ModelProtocol>("openai");
  const [pUrl, setPUrl] = useState("");
  const [pKey, setPKey] = useState("");
  const [pAuth, setPAuth] = useState<"" | ModelAuth>("");
  const [pMore, setPMore] = useState(false);
  const [pManualId, setPManualId] = useState("");
  const [pIdEdited, setPIdEdited] = useState(false);
  const [scannedModels, setScannedModels] = useState<string[] | null>(null);
  const [scanningModels, setScanningModels] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanFilter, setScanFilter] = useState("");
  const [pickedModels, setPickedModels] = useState<string[]>([]);
  const [manualModel, setManualModel] = useState("");
  const [makeMainOnSave, setMakeMainOnSave] = useState(true);
  const [draftTestRes, setDraftTestRes] = useState<ModelTestResult | null>(null);
  const [draftTesting, setDraftTesting] = useState(false);
  const [savingProv, setSavingProv] = useState(false);
  const scanSeq = useRef(0);

  useEffect(() => {
    void getHostdStatus().then(setHostd);
    void loadAssistantConfig();
  }, []);

  useEffect(() => {
    if (!cfg) return;
    setAssistantName(cfg.name || "小羊");
    setVoiceProvider(cfg.voice.provider ?? "off");
    setVoiceUrl(cfg.voice.url ?? "");
    setVoiceModel(cfg.voice.model ?? "gpt-realtime");
    setVoiceId(cfg.voice.voice ?? "marin");
  }, [cfg]);

  const effectiveId = useMemo(
    () =>
      editingProv
        ? editingProv.id
        : pIdEdited && pManualId.trim()
          ? pManualId.trim()
          : deriveProviderId(presetId, pLabel, pUrl, cfg?.providers.map((x) => x.id) ?? []),
    [editingProv, pIdEdited, pManualId, presetId, pLabel, pUrl, cfg?.providers],
  );

  const canScanDraft =
    provModalOpen &&
    /^https?:\/\/\S+$/i.test(pUrl.trim()) &&
    (Boolean(pKey.trim()) || Boolean(editingProv?.key.set) || pAuth === "none" || pProtocol === "ollama");

  const runDraftScan = async (silent = false) => {
    if (!canScanDraft) return;
    const seq = ++scanSeq.current;
    setScanningModels(true);
    setScanError(null);
    try {
      const draft: ProviderPatch = {
        id: effectiveId,
        protocol: pProtocol,
        baseUrl: pUrl.trim(),
        ...(pAuth ? { auth: pAuth } : {}),
        ...(pKey.trim() ? { apiKey: pKey.trim() } : {}),
      };
      const models = await fetchAssistantProviderModels(draft);
      if (scanSeq.current !== seq) return;
      setScannedModels(models);
      if (!models.length && !silent) toast("上游未列出模型，可在下方手动填写");
    } catch (e) {
      if (scanSeq.current !== seq) return;
      setScannedModels([]);
      setScanError((e as Error).message);
    } finally {
      if (scanSeq.current === seq) setScanningModels(false);
    }
  };

  useEffect(() => {
    if (!canScanDraft) return;
    const t = setTimeout(() => {
      void runDraftScan(true);
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provModalOpen, effectiveId, pProtocol, pUrl, pAuth, pKey]);

  const applyPreset = (item: ProviderPresetItem | "custom") => {
    setScannedModels(null);
    setScanError(null);
    setDraftTestRes(null);
    if (item === "custom") {
      setPresetId("custom");
      setPLabel("");
      setPProtocol("openai");
      setPUrl("");
      setPAuth("");
      setPickedModels([]);
      return;
    }
    setPresetId(item.id);
    setPLabel(item.label);
    setPProtocol(item.protocol);
    setPUrl(item.baseUrl);
    setPAuth(item.auth ?? "");
    setPickedModels(item.recommendedModel ? [item.recommendedModel] : []);
  };

  const openProviderModal = (p: ProviderView | null) => {
    setEditingProv(p);
    setScannedModels(null);
    setScanError(null);
    setScanFilter("");
    setManualModel("");
    setDraftTestRes(null);
    setPIdEdited(false);
    setPManualId("");
    setPMore(Boolean(p?.auth));
    if (p) {
      setPresetId(null);
      setPLabel(p.label ?? "");
      setPProtocol(p.protocol);
      setPUrl(p.baseUrl);
      setPAuth(p.auth ?? "");
      setPKey("");
      setPickedModels([]);
      setMakeMainOnSave(false);
    } else {
      const def = PROVIDER_PRESETS[0]!;
      setPresetId(def.id);
      setPLabel(def.label);
      setPProtocol(def.protocol);
      setPUrl(def.baseUrl);
      setPAuth(def.auth ?? "");
      setPKey("");
      setPickedModels(def.recommendedModel ? [def.recommendedModel] : []);
      setMakeMainOnSave(true);
    }
    setProvModalOpen(true);
  };

  const chosenModalModels = useMemo(() => {
    const out: string[] = [];
    for (const m of pickedModels) if (m.trim() && !out.includes(m.trim())) out.push(m.trim());
    if (manualModel.trim() && !out.includes(manualModel.trim())) out.push(manualModel.trim());
    return out;
  }, [pickedModels, manualModel]);

  const saveProviderModal = async () => {
    if (!cfg) return;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(effectiveId)) {
      toast("代号格式不对（小写字母开头+字母/数字/短横线）", true);
      return;
    }
    if (!/^https?:\/\/\S+$/i.test(pUrl.trim())) {
      toast("请填写 http:// 或 https:// 开头的地址", true);
      return;
    }
    setSavingProv(true);
    try {
      const patch: ProviderPatch = {
        id: effectiveId,
        label: pLabel.trim(),
        protocol: pProtocol,
        baseUrl: pUrl.trim(),
        auth: pAuth || null,
        ...(pKey.trim() ? { apiKey: pKey.trim() } : {}),
      };
      let nextModels: ModelRef[] | undefined;
      if (chosenModalModels.length) {
        const addRefs = chosenModalModels.map((model) => ({ provider: effectiveId, model }));
        const keySet = new Set(addRefs.map((x) => `${x.provider}:${x.model}`));
        const rest = cfg.models.filter((x) => !keySet.has(`${x.provider}:${x.model}`));
        nextModels = (makeMainOnSave ? [...addRefs, ...rest] : [...rest, ...addRefs]).slice(0, 12);
      }
      await saveAssistantConfig({
        rev: cfg.rev,
        providers: [patch],
        ...(nextModels ? { models: nextModels } : {}),
      });
      setProvModalOpen(false);
      toast(chosenModalModels.length ? `已保存「${pLabel.trim() || effectiveId}」并启用模型` : "服务商已保存");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSavingProv(false);
    }
  };

  const promoteModel = async (idx: number) => {
    if (!cfg || idx <= 0) return;
    const picked = cfg.models[idx];
    if (!picked) return;
    const next = [picked, ...cfg.models.filter((_, i) => i !== idx)];
    try {
      await saveAssistantConfig({ rev: cfg.rev, models: next });
      toast(`已将 ${picked.model} 设为主模型`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const moveModel = async (idx: number, dir: -1 | 1) => {
    if (!cfg) return;
    const to = idx + dir;
    if (to < 0 || to >= cfg.models.length) return;
    const next = cfg.models.slice();
    [next[idx], next[to]] = [next[to]!, next[idx]!];
    try {
      await saveAssistantConfig({ rev: cfg.rev, models: next });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const removeModel = async (idx: number) => {
    if (!cfg || cfg.models.length <= 1) return;
    const next = cfg.models.filter((_, i) => i !== idx);
    try {
      await saveAssistantConfig({ rev: cfg.rev, models: next });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const checkUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const info = await checkReleaseUpdate();
      setUpdateInfo(info);
      if (info.hasUpdate) {
        toast(`发现新版本 v${info.latest}`);
      } else {
        toast(`当前已是最新版本 v${info.current}`);
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setCheckingUpdate(false);
    }
  };

  const saveVoice = async () => {
    if (!cfg) return;
    try {
      await saveAssistantConfig({
        rev: cfg.rev,
        name: assistantName.trim() || "小羊",
        voice:
          voiceProvider === "off"
            ? { provider: null }
            : {
                provider: voiceProvider,
                url: voiceUrl.trim() || undefined,
                model: voiceModel.trim() || undefined,
                voice: voiceId.trim() || undefined,
                ...(voiceKey.trim() ? { apiKey: voiceKey.trim() } : {}),
              },
      });
      setVoiceKey("");
      toast("小羊设置已保存");
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const platform = detectPlatform();
  const filteredScanned = (scannedModels ?? []).filter((m) => !scanFilter.trim() || m.toLowerCase().includes(scanFilter.trim().toLowerCase()));

  return (
    <div className="main-scroll">
      <div style={{ maxWidth: 860, margin: "0 auto" }} className="stack">
        <div className="between wrap">
          <div>
            <h2 className="cute-font" style={{ margin: 0, fontSize: 26 }}>设置</h2>
            <div className="faint">{s.deviceName || "当前设备"} · {s.server || "未连接"}</div>
          </div>
          <div className="segmented">
            <button className={subTab === "app" ? "active" : ""} onClick={() => setSubTab("app")}>应用与外观</button>
            <button className={subTab === "models" ? "active" : ""} onClick={() => setSubTab("models")}>小羊模型</button>
            <button className={subTab === "voice" ? "active" : ""} onClick={() => setSubTab("voice")}>语音音色</button>
            <button className={subTab === "prompts" ? "active" : ""} onClick={() => setSubTab("prompts")}>提示词</button>
          </div>
        </div>

        {subTab === "app" ? (
          <div className="stack">
            <PocketCard>
              <div className="stack">
                <div style={{ fontWeight: 800, fontSize: 15 }}>外观与显示</div>
                <div className="between wrap">
                  <div>
                    <div style={{ fontWeight: 700 }}>主题颜色</div>
                    <div className="faint">支持浅色粉紫与暗夜紫色模式</div>
                  </div>
                  <PocketSelect
                    value={s.theme}
                    onValueChange={(v) => updateSettings({ theme: v as ThemeChoice })}
                    options={[
                      { value: "system", label: "跟随系统" },
                      { value: "light", label: "浅色模式" },
                      { value: "dark", label: "暗夜模式" },
                    ]}
                  />
                </div>
                <div className="between wrap">
                  <div>
                    <div style={{ fontWeight: 700 }}>文字大小</div>
                    <div className="faint">当前缩放 {Math.round(s.textScale * 100)}%</div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    {[0.9, 1, 1.15, 1.3].map((sc) => (
                      <PocketButton
                        key={sc}
                        size="sm"
                        variant={Math.abs(s.textScale - sc) < 0.02 ? "primary" : "ghost"}
                        onClick={() => updateSettings({ textScale: sc })}
                      >
                        {sc === 1 ? "标准" : `${sc}x`}
                      </PocketButton>
                    ))}
                  </div>
                </div>
              </div>
            </PocketCard>

            <PocketCard>
              <div className="stack">
                <div style={{ fontWeight: 800, fontSize: 15 }}>通话声音与提醒</div>
                <div className="between">
                  <div className="row">
                    <Mic size={16} />
                    <div>
                      <div style={{ fontWeight: 700 }}>通话降噪</div>
                      <div className="faint">语音通话时开启系统回声消除与环境降噪</div>
                    </div>
                  </div>
                  <PocketSwitch
                    checked={s.denoise}
                    onCheckedChange={(v) => updateSettings({ denoise: v })}
                    label="通话降噪"
                  />
                </div>
                <div className="between">
                  <div className="row">
                    <Bell size={16} />
                    <div>
                      <div style={{ fontWeight: 700 }}>桌面 / 系统通知</div>
                      <div className="faint">Agent 卡住或完成时弹出提醒</div>
                    </div>
                  </div>
                  <div className="row">
                    <PocketButton
                      size="sm"
                      variant="ghost"
                      onClick={() => void pushSystemNotification("Herdr Pocket", "通知通道工作正常")}
                    >
                      测试通知
                    </PocketButton>
                    <PocketSwitch
                      checked={s.notifications}
                      onCheckedChange={(v) => {
                        updateSettings({ notifications: v });
                        void refreshNotifyChannel();
                      }}
                      label="系统通知"
                    />
                  </div>
                </div>
              </div>
            </PocketCard>

            {hostd ? (
              <PocketCard>
                <div className="stack" style={{ gap: 6 }}>
                  <div style={{ fontWeight: 800, fontSize: 15 }}>本机 hostd 守护进程</div>
                  <div className="faint">
                    {hostd.installed
                      ? hostd.configured
                        ? `已配置（${hostd.deviceName || "本机"} -> ${hostd.server || ""}）`
                        : "已检测到配置目录，尚未配对"
                      : "未在本机检测到 ~/.config/herdr-pocket/hostd.json"}
                  </div>
                </div>
              </PocketCard>
            ) : null}

            <PocketCard>
              <div className="between wrap">
                <div>
                  <div style={{ fontWeight: 800, fontSize: 15 }}>版本与更新</div>
                  <div className="faint">
                    当前版本 v{appVersion()} · 平台：{platform}
                  </div>
                </div>
                <div className="row">
                  <PocketButton size="sm" variant="soft" disabled={checkingUpdate} onClick={() => void checkUpdate()}>
                    <RefreshCw size={14} />
                    <span>{checkingUpdate ? "检查中…" : "检查更新"}</span>
                  </PocketButton>
                  {updateInfo?.hasUpdate ? (
                    <PocketButton size="sm" variant="primary" onClick={() => void openExternalUrl(updateInfo.downloadUrl)}>
                      <Download size={14} />
                      <span>下载 v{updateInfo.latest}</span>
                    </PocketButton>
                  ) : null}
                </div>
              </div>
            </PocketCard>

            <PocketButton variant="danger" onClick={() => void signOut()}>
              <LogOut size={15} />
              <span>退出登录并解绑这台设备</span>
            </PocketButton>
          </div>
        ) : null}

        {subTab === "models" ? (
          <div className="stack">
            <PocketCard>
              <div className="stack">
                <div className="between wrap">
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>文字模型路由</div>
                    <div className="faint">第一位是默认主模型；失败或慢响应时自动切换后续备用模型</div>
                  </div>
                  <PocketButton size="sm" variant="ghost" onClick={() => void loadAssistantConfig()}>
                    <RefreshCw size={13} />
                    <span>刷新</span>
                  </PocketButton>
                </div>
                {cfg ? (
                  <>
                    <div className="stack" style={{ gap: 8 }}>
                      {cfg.models.map((m, i) => (
                        <PocketCard key={`${m.provider}:${m.model}:${i}`} soft>
                          <div className="between wrap" style={{ gap: 8 }}>
                            <div className="row">
                              <PocketBadge tone={i === 0 ? "pink" : "neutral"}>{i === 0 ? "主模型" : `备用 ${i}`}</PocketBadge>
                              <span className="mono" style={{ fontWeight: 700 }}>{m.provider}:{m.model}</span>
                            </div>
                            <div className="row wrap" style={{ gap: 6 }}>
                              <PocketButton
                                size="sm"
                                variant="soft"
                                disabled={testingModel}
                                onClick={async () => {
                                  setTestingModel(true);
                                  try {
                                    const res = await testAssistantModel({ provider: m.provider, model: m.model });
                                    toast(res.ok ? `响应正常 (${res.firstMs ?? "-"}ms)` : res.error || "测试失败", !res.ok);
                                  } catch (e) {
                                    toast((e as Error).message, true);
                                  } finally {
                                    setTestingModel(false);
                                  }
                                }}
                              >
                                <Sparkles size={13} />
                                <span>测速</span>
                              </PocketButton>
                              {i > 0 ? (
                                <PocketButton size="sm" variant="primary" onClick={() => void promoteModel(i)}>
                                  <span>设为主模型</span>
                                </PocketButton>
                              ) : null}
                              <PocketButton size="sm" variant="ghost" disabled={i === 0} onClick={() => void moveModel(i, -1)} aria-label="上移">
                                <ArrowUp size={13} />
                              </PocketButton>
                              <PocketButton size="sm" variant="ghost" disabled={i === cfg.models.length - 1} onClick={() => void moveModel(i, 1)} aria-label="下移">
                                <ArrowDown size={13} />
                              </PocketButton>
                              <PocketButton size="sm" variant="ghost" disabled={cfg.models.length <= 1} onClick={() => void removeModel(i)} aria-label="移除">
                                <Trash2 size={13} />
                              </PocketButton>
                            </div>
                          </div>
                        </PocketCard>
                      ))}
                    </div>
                    {cfg.warnings.length > 0 ? (
                      <div className="faint" style={{ color: "var(--blush-text)" }}>{cfg.warnings.join("；")}</div>
                    ) : null}
                  </>
                ) : (
                  <div className="muted">暂未加载到小羊配置。</div>
                )}
              </div>
            </PocketCard>

            <PocketCard>
              <div className="stack">
                <div className="between wrap">
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>文字模型服务商</div>
                    <div className="faint">支持 OpenAI Chat / Responses / Claude / Gemini 原生 / Ollama，添加时自动扫描上游模型</div>
                  </div>
                  <PocketButton size="sm" variant="primary" onClick={() => openProviderModal(null)}>
                    <Plus size={14} />
                    <span>添加服务商</span>
                  </PocketButton>
                </div>
                {cfg?.providers.length ? (
                  <div className="stack" style={{ gap: 8 }}>
                    {cfg.providers.map((p) => (
                      <PocketCard key={p.id} soft>
                        <div className="between wrap" style={{ gap: 8 }}>
                          <div>
                            <div className="row" style={{ gap: 6 }}>
                              <strong>{p.label || p.id}</strong>
                              <PocketBadge tone="lav">{PROTOCOL_LABELS[p.protocol] ?? p.protocol}</PocketBadge>
                              <PocketBadge tone={p.key.set || p.protocol === "ollama" || p.auth === "none" ? "mint" : "blush"}>
                                {p.key.set ? `··${p.key.hint || "****"}` : p.protocol === "ollama" || p.auth === "none" ? "免密钥" : "缺密钥"}
                              </PocketBadge>
                            </div>
                            <div className="faint mono">{p.id} · {p.baseUrl}</div>
                          </div>
                          <div className="row wrap" style={{ gap: 6 }}>
                            <PocketButton size="sm" variant="soft" onClick={() => openProviderModal(p)}>
                              <Pencil size={13} />
                              <span>编辑 / 选模型</span>
                            </PocketButton>
                            {p.from === "server" && cfg.edited ? (
                              <PocketButton
                                size="sm"
                                variant="ghost"
                                onClick={async () => {
                                  try {
                                    await saveAssistantConfig({ rev: cfg.rev, providers: [{ id: p.id, reset: true }] });
                                    toast(`已恢复「${p.id}」默认配置`);
                                  } catch (e) {
                                    toast((e as Error).message, true);
                                  }
                                }}
                              >
                                <RotateCcw size={13} />
                                <span>还原</span>
                              </PocketButton>
                            ) : null}
                            {p.from === "phone" ? (
                              <PocketButton
                                size="sm"
                                variant="danger"
                                onClick={async () => {
                                  try {
                                    const left = cfg.models.filter((m) => m.provider !== p.id);
                                    await saveAssistantConfig({
                                      rev: cfg.rev,
                                      providers: [{ id: p.id, remove: true }],
                                      ...(left.length ? { models: left } : {}),
                                    });
                                    toast(`已删除 ${p.id}`);
                                  } catch (e) {
                                    toast((e as Error).message, true);
                                  }
                                }}
                              >
                                <Trash2 size={13} />
                              </PocketButton>
                            ) : null}
                          </div>
                        </div>
                      </PocketCard>
                    ))}
                  </div>
                ) : null}
              </div>
            </PocketCard>
          </div>
        ) : null}

        {subTab === "voice" ? (
          <PocketCard>
            <div className="stack">
              <div style={{ fontWeight: 800, fontSize: 15 }}>小羊名字与实时语音服务</div>
              <div className="stack" style={{ gap: 6 }}>
                <label className="faint">助理名称</label>
                <PocketInput value={assistantName} onChange={(e) => setAssistantName(e.target.value)} />
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <label className="faint">实时语音协议</label>
                <PocketSelect
                  value={voiceProvider}
                  onValueChange={(v) => setVoiceProvider(v as VoiceProviderId | "off")}
                  options={[
                    { value: "openai-realtime", label: "OpenAI Realtime 兼容" },
                    { value: "moss-live", label: "MOSS-Live" },
                    { value: "off", label: "关闭语音通话" },
                  ]}
                />
              </div>
              {voiceProvider !== "off" ? (
                <>
                  <div className="stack" style={{ gap: 6 }}>
                    <label className="faint">WebSocket 接入地址</label>
                    <PocketInput mono value={voiceUrl} onChange={(e) => setVoiceUrl(e.target.value)} placeholder="wss://api.example.com/v1/realtime" />
                  </div>
                  <div className="stack" style={{ gap: 6 }}>
                    <label className="faint">模型名称</label>
                    <PocketInput mono value={voiceModel} onChange={(e) => setVoiceModel(e.target.value)} />
                  </div>
                  {voiceProvider === "openai-realtime" ? (
                    <div className="stack" style={{ gap: 6 }}>
                      <label className="faint">音色（默认 marin）</label>
                      <div className="row wrap" style={{ gap: 6 }}>
                        {OPENAI_REALTIME_VOICES.map((v) => (
                          <PocketButton
                            key={v.id}
                            size="sm"
                            variant={voiceId === v.id ? "primary" : "ghost"}
                            onClick={() => setVoiceId(v.id)}
                          >
                            {v.label}
                          </PocketButton>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="stack" style={{ gap: 6 }}>
                    <label className="faint">覆盖语音服务密钥（留空保持当前配置）</label>
                    <PocketInput mono type="password" value={voiceKey} onChange={(e) => setVoiceKey(e.target.value)} placeholder={cfg?.voice.key.set ? `已配密钥 ···${cfg.voice.key.hint || ""}` : "输入新 API Key"} />
                  </div>
                </>
              ) : null}
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <PocketButton onClick={() => void saveVoice()}>保存语音配置</PocketButton>
              </div>
            </div>
          </PocketCard>
        ) : null}

        {subTab === "prompts" ? (
          <PocketCard>
            <div className="stack">
              <div style={{ fontWeight: 800, fontSize: 15 }}>提示词工作台</div>
              {editingPrompt ? (
                <div className="stack">
                  <div className="between">
                    <strong>编辑：{editingPrompt.id}</strong>
                    <div className="row" style={{ gap: 6 }}>
                      <PocketButton size="sm" variant="ghost" onClick={() => setEditingPrompt(null)}>返回</PocketButton>
                      <PocketButton
                        size="sm"
                        variant="soft"
                        onClick={async () => {
                          try {
                            await saveAssistantPrompt(editingPrompt.id, { reset: true });
                            setEditingPrompt(null);
                            toast("已恢复默认提示词");
                          } catch (e) {
                            toast((e as Error).message, true);
                          }
                        }}
                      >
                        恢复默认
                      </PocketButton>
                      <PocketButton
                        size="sm"
                        variant="primary"
                        onClick={async () => {
                          try {
                            await saveAssistantPrompt(editingPrompt.id, { text: editingPrompt.text });
                            setEditingPrompt(null);
                            toast("提示词已保存");
                          } catch (e) {
                            toast((e as Error).message, true);
                          }
                        }}
                      >
                        保存
                      </PocketButton>
                    </div>
                  </div>
                  <PocketTextarea rows={10} mono value={editingPrompt.text} onChange={(e) => setEditingPrompt({ ...editingPrompt, text: e.target.value })} />
                </div>
              ) : (
                <div className="stack" style={{ gap: 8 }}>
                  {prompts.map((p) => (
                    <PocketCard key={p.id} soft>
                      <div className="between wrap">
                        <div>
                          <div className="row" style={{ gap: 8 }}>
                            <strong>{p.title}</strong>
                            {p.edited ? <PocketBadge tone="pink">已改写</PocketBadge> : null}
                          </div>
                          <div className="faint">{p.about}</div>
                        </div>
                        <PocketButton size="sm" variant="soft" onClick={() => setEditingPrompt({ id: p.id, text: p.text })}>
                          编辑
                        </PocketButton>
                      </div>
                    </PocketCard>
                  ))}
                </div>
              )}
            </div>
          </PocketCard>
        ) : null}
      </div>

      <PocketModal
        open={provModalOpen}
        onOpenChange={setProvModalOpen}
        title={editingProv ? `配置服务商：${editingProv.label || editingProv.id}` : "一键添加服务商与模型"}
        subtitle={`服务商代号：${effectiveId}`}
        width={620}
      >
        <div className="stack" style={{ gap: 12, maxHeight: "72vh", overflowY: "auto" }}>
          {!editingProv ? (
            <div className="stack" style={{ gap: 6 }}>
              <label className="faint">快捷预设</label>
              <div className="row wrap" style={{ gap: 6 }}>
                {PROVIDER_PRESETS.map((item) => (
                  <PocketButton
                    key={item.id}
                    size="sm"
                    variant={presetId === item.id ? "primary" : "ghost"}
                    onClick={() => applyPreset(item)}
                  >
                    {item.label}
                  </PocketButton>
                ))}
                <PocketButton size="sm" variant={presetId === "custom" ? "primary" : "ghost"} onClick={() => applyPreset("custom")}>
                  自定义
                </PocketButton>
              </div>
            </div>
          ) : null}

          <div className="row wrap" style={{ gap: 10 }}>
            <div className="stack grow" style={{ gap: 6 }}>
              <label className="faint">显示名称</label>
              <PocketInput value={pLabel} onChange={(e) => setPLabel(e.target.value)} placeholder="小米 MiMo" />
            </div>
            <div className="stack" style={{ gap: 6, minWidth: 200 }}>
              <label className="faint">协议类型</label>
              <PocketSelect
                value={pProtocol}
                onValueChange={(v) => setPProtocol(v as ModelProtocol)}
                options={[
                  { value: "openai", label: "OpenAI 兼容" },
                  { value: "openai-responses", label: "Responses / Codex" },
                  { value: "anthropic", label: "Anthropic" },
                  { value: "gemini", label: "Google Gemini" },
                  { value: "ollama", label: "Ollama 本地" },
                ]}
              />
            </div>
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <label className="faint">接口 Base URL</label>
            <PocketInput mono value={pUrl} onChange={(e) => setPUrl(e.target.value)} placeholder={URL_HINTS[pProtocol]} />
          </div>

          {pProtocol !== "ollama" || pAuth === "bearer" ? (
            <div className="stack" style={{ gap: 6 }}>
              <label className="faint">{editingProv?.key.set ? "API 密钥（留空保持原值）" : "API 密钥"}</label>
              <PocketInput mono type="password" value={pKey} onChange={(e) => setPKey(e.target.value)} placeholder="粘贴 API Key" />
            </div>
          ) : (
            <div className="faint">Ollama 本地默认免密钥，填写地址后可直接扫描可用模型。</div>
          )}

          <div>
            <PocketButton size="sm" variant="ghost" onClick={() => setPMore((v) => !v)}>
              {pMore ? "收起高级设置" : `高级设置（代号 / 鉴权方式）`}
            </PocketButton>
            {pMore ? (
              <div className="row wrap" style={{ gap: 10, marginTop: 8 }}>
                <div className="stack grow" style={{ gap: 6 }}>
                  <label className="faint">代号 ID</label>
                  <PocketInput
                    mono
                    disabled={!!editingProv}
                    value={editingProv ? editingProv.id : pIdEdited ? pManualId : effectiveId}
                    onChange={(e) => {
                      setPIdEdited(true);
                      setPManualId(e.target.value.toLowerCase());
                    }}
                  />
                </div>
                <div className="stack" style={{ gap: 6, minWidth: 180 }}>
                  <label className="faint">鉴权头格式</label>
                  <PocketSelect
                    value={pAuth}
                    onValueChange={(v) => setPAuth(v as "" | ModelAuth)}
                    options={[
                      { value: "", label: "按协议默认" },
                      { value: "bearer", label: "Bearer" },
                      { value: "x-api-key", label: "x-api-key" },
                      { value: "api-key", label: "api-key" },
                      { value: "x-goog-api-key", label: "x-goog-api-key" },
                      { value: "none", label: "不用密钥" },
                    ]}
                  />
                </div>
              </div>
            ) : null}
          </div>

          <div className="stack" style={{ borderTop: "1px solid var(--divider)", paddingTop: 10, gap: 8 }}>
            <div className="between wrap">
              <div>
                <div style={{ fontWeight: 700 }}>扫描上游模型并启用</div>
                <div className="faint">填完地址与密钥后会自动拉取，点击即可选中</div>
              </div>
              <PocketButton size="sm" variant="soft" disabled={!canScanDraft || scanningModels} onClick={() => void runDraftScan(false)}>
                <CloudDownload size={13} />
                <span>{scanningModels ? "扫描中…" : "扫描模型"}</span>
              </PocketButton>
            </div>
            {scanError ? <div className="faint">自动扫描未取到列表（{scanError}），可直接手动填模型名</div> : null}
            {scannedModels && scannedModels.length ? (
              <div className="stack" style={{ gap: 6 }}>
                {scannedModels.length > 8 ? (
                  <PocketInput mono value={scanFilter} onChange={(e) => setScanFilter(e.target.value)} placeholder={`搜索模型（共 ${scannedModels.length} 个）`} />
                ) : null}
                <div className="row wrap" style={{ gap: 6, maxHeight: 140, overflowY: "auto" }}>
                  {filteredScanned.slice(0, 60).map((m) => {
                    const active = pickedModels.includes(m);
                    return (
                      <PocketButton
                        key={m}
                        size="sm"
                        variant={active ? "primary" : "ghost"}
                        onClick={() => setPickedModels((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]))}
                      >
                        {m}
                      </PocketButton>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="row wrap" style={{ gap: 8 }}>
              <div className="grow">
                <PocketInput mono value={manualModel} onChange={(e) => setManualModel(e.target.value)} placeholder="手动填或补充模型名，如 mimo-v2.6-flash" />
              </div>
              <PocketButton
                size="sm"
                variant="soft"
                disabled={draftTesting || !canScanDraft || !chosenModalModels.length}
                onClick={async () => {
                  const target = chosenModalModels[0];
                  if (!target) return;
                  setDraftTesting(true);
                  setDraftTestRes(null);
                  try {
                    const res = await testAssistantModel({
                      provider: {
                        id: effectiveId,
                        label: pLabel.trim(),
                        protocol: pProtocol,
                        baseUrl: pUrl.trim(),
                        ...(pAuth ? { auth: pAuth } : {}),
                        ...(pKey.trim() ? { apiKey: pKey.trim() } : {}),
                      },
                      model: target,
                    });
                    setDraftTestRes(res);
                  } catch (e) {
                    setDraftTestRes({ ok: false, error: (e as Error).message });
                  } finally {
                    setDraftTesting(false);
                  }
                }}
              >
                <Sparkles size={13} />
                <span>{draftTesting ? "测速中…" : "先测一下"}</span>
              </PocketButton>
            </div>
            {chosenModalModels.length ? (
              <div className="between wrap" style={{ gap: 8 }}>
                <span className="faint mono">待启用：{chosenModalModels.join(", ")}</span>
                <label className="row" style={{ gap: 6, cursor: "pointer", fontSize: 13 }}>
                  <PocketSwitch checked={makeMainOnSave} onCheckedChange={setMakeMainOnSave} label="保存后设为主模型" />
                  <span>设为默认主模型</span>
                </label>
              </div>
            ) : null}
            {draftTestRes ? (
              <div className="faint" style={{ color: draftTestRes.ok ? "var(--ok-text)" : "var(--blush-text)" }}>
                {draftTestRes.ok
                  ? `通了 · 首字 ${draftTestRes.firstMs ?? "-"}ms · 总 ${draftTestRes.totalMs ?? "-"}ms`
                  : `没通：${draftTestRes.error || "连接失败"}`}
              </div>
            ) : null}
          </div>

          <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
            <PocketButton variant="ghost" onClick={() => setProvModalOpen(false)}>取消</PocketButton>
            <PocketButton variant="primary" disabled={savingProv} onClick={() => void saveProviderModal()}>
              <Save size={14} />
              <span>{savingProv ? "保存中…" : chosenModalModels.length ? "保存并启用模型" : "保存"}</span>
            </PocketButton>
          </div>
        </div>
      </PocketModal>
    </div>
  );
}
