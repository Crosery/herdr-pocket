import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CloudDownload,
  Cpu,
  Gauge,
  KeyRound,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Server,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  ADMIN_PROVIDER_PRESETS,
  PROTOCOL_LABEL,
  adminApi,
  fmtAgo,
  type AdminPresetItem,
  type AssistantConfigView,
  type ModelAuth,
  type ModelProtocol,
  type ModelRef,
  type ModelTestResult,
  type ProviderView,
} from "../lib/api";
import {
  PocketButton,
  PocketCard,
  PocketConfirmDialog,
  PocketDialog,
  PocketIconButton,
  PocketInput,
  PocketPopover,
  PocketSelect,
  PocketSwitch,
  useToast,
} from "../components/ui/PocketUI";

interface TestState {
  running?: boolean;
  result?: ModelTestResult;
}

const URL_HINT: Record<ModelProtocol, string> = {
  openai: "https://api.example.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  ollama: "http://localhost:11434",
};

function deriveProviderId(presetId: string | null, label: string, url: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  let raw = presetId && presetId !== "custom" ? presetId : "";
  if (!raw && label.trim()) {
    raw = label.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  }
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
  for (let i = 2; i < 99; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
  return `gw-${Date.now().toString(36).slice(-4)}`;
}

export function ModelsView({
  config,
  onConfigUpdated,
}: {
  config: AssistantConfigView;
  onConfigUpdated: (cfg: AssistantConfigView) => void;
}) {
  const toast = useToast();
  const [nameDraft, setNameDraft] = useState(config.name || "小羊");
  const [savingName, setSavingName] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [fetchedByProv, setFetchedByProv] = useState<Record<string, string[]>>({});
  const [fetchingProv, setFetchingProv] = useState<string | null>(null);

  const [newProv, setNewProv] = useState(config.providers[0]?.id ?? "");
  const [newModel, setNewModel] = useState("");
  const [addAsMain, setAddAsMain] = useState(false);

  // Provider 1-step modal state
  const [provModalOpen, setProvModalOpen] = useState(false);
  const [editingProv, setEditingProv] = useState<ProviderView | null>(null);
  const [presetId, setPresetId] = useState<string | null>("mimo");
  const [pId, setPId] = useState("");
  const [pIdEdited, setPIdEdited] = useState(false);
  const [pLabel, setPLabel] = useState("");
  const [pProtocol, setPProtocol] = useState<ModelProtocol>("openai");
  const [pAuth, setPAuth] = useState<"" | ModelAuth>("");
  const [pUrl, setPUrl] = useState("");
  const [pKey, setPKey] = useState("");
  const [pMore, setPMore] = useState(false);

  // Modal upstream scanner + model enablement
  const [modalScanned, setModalScanned] = useState<string[] | null>(null);
  const [modalScanning, setModalScanning] = useState(false);
  const [modalScanErr, setModalScanErr] = useState<string | null>(null);
  const [modalFilter, setModalFilter] = useState("");
  const [modalPicked, setModalPicked] = useState<string[]>([]);
  const [modalManualModel, setModalManualModel] = useState("");
  const [modalMakeMain, setModalMakeMain] = useState(true);
  const [modalTestModel, setModalTestModel] = useState("");
  const [modalTesting, setModalTesting] = useState(false);
  const [modalTestResult, setModalTestResult] = useState<ModelTestResult | null>(null);
  const [savingProv, setSavingProv] = useState(false);
  const [deleteProvTarget, setDeleteProvTarget] = useState<ProviderView | null>(null);
  const scanSeqRef = useRef(0);

  useEffect(() => {
    setNameDraft(config.name || "小羊");
    if (!newProv || !config.providers.some((p) => p.id === newProv)) {
      setNewProv(config.providers[0]?.id ?? "");
    }
  }, [config]);

  const effectiveId = useMemo(
    () => (editingProv ? editingProv.id : pIdEdited && pId.trim() ? pId.trim() : deriveProviderId(presetId, pLabel, pUrl, config.providers.map((x) => x.id))),
    [editingProv, pIdEdited, pId, presetId, pLabel, pUrl, config.providers],
  );

  const applyPreset = (item: AdminPresetItem | "custom") => {
    setModalScanned(null);
    setModalScanErr(null);
    setModalTestResult(null);
    if (item === "custom") {
      setPresetId("custom");
      setPLabel("");
      setPProtocol("openai");
      setPAuth("");
      setPUrl("");
      setModalPicked([]);
      setModalTestModel("");
      return;
    }
    setPresetId(item.id);
    setPLabel(item.label);
    setPProtocol(item.protocol);
    setPAuth(item.auth ?? "");
    setPUrl(item.baseUrl);
    setModalPicked(item.recommendedModel ? [item.recommendedModel] : []);
    setModalTestModel(item.recommendedModel ?? "");
  };

  const openProvModal = (p: ProviderView | null) => {
    setEditingProv(p);
    setModalScanned(null);
    setModalScanErr(null);
    setModalFilter("");
    setModalManualModel("");
    setModalTestResult(null);
    setPIdEdited(false);
    setPMore(Boolean(p?.auth));
    if (p) {
      setPresetId(null);
      setPId(p.id);
      setPLabel(p.label ?? "");
      setPProtocol(p.protocol);
      setPAuth(p.auth ?? "");
      setPUrl(p.baseUrl);
      setPKey("");
      const firstExisting = config.models.find((m) => m.provider === p.id)?.model ?? "";
      setModalPicked([]);
      setModalMakeMain(false);
      setModalTestModel(firstExisting);
    } else {
      const def = ADMIN_PROVIDER_PRESETS[0]!;
      setPresetId(def.id);
      setPId("");
      setPLabel(def.label);
      setPProtocol(def.protocol);
      setPAuth(def.auth ?? "");
      setPUrl(def.baseUrl);
      setPKey("");
      setModalPicked(def.recommendedModel ? [def.recommendedModel] : []);
      setModalMakeMain(true);
      setModalTestModel(def.recommendedModel ?? "");
    }
    setProvModalOpen(true);
  };

  const canScanDraft =
    provModalOpen &&
    /^https?:\/\/\S+$/i.test(pUrl.trim()) &&
    (Boolean(pKey.trim()) || Boolean(editingProv?.key.set) || pAuth === "none" || pProtocol === "ollama");

  const scanDraftModels = async (silent = false) => {
    if (!canScanDraft) return;
    const seq = ++scanSeqRef.current;
    setModalScanning(true);
    setModalScanErr(null);
    try {
      const draft: Record<string, unknown> = {
        id: effectiveId,
        protocol: pProtocol,
        baseUrl: pUrl.trim(),
        auth: pAuth || null,
      };
      if (pKey.trim()) draft.apiKey = pKey.trim();
      const res = await adminApi.fetchProviderModels(draft);
      if (scanSeqRef.current !== seq) return;
      setModalScanned(res.models);
      if (res.models.length && !modalTestModel.trim()) {
        setModalTestModel(res.models[0]!);
      }
      if (!res.models.length && !silent) toast("上游没有返回模型，可手动填模型名");
    } catch (e) {
      if (scanSeqRef.current !== seq) return;
      setModalScanned([]);
      setModalScanErr((e as Error).message);
    } finally {
      if (scanSeqRef.current === seq) setModalScanning(false);
    }
  };

  // Auto-scan when modal is open and URL + credentials become valid.
  useEffect(() => {
    if (!canScanDraft) return;
    const timer = setTimeout(() => {
      void scanDraftModels(true);
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provModalOpen, effectiveId, pProtocol, pUrl, pAuth, pKey]);

  const runDraftTest = async () => {
    const targetModel = modalTestModel.trim() || modalPicked[0] || modalManualModel.trim();
    if (!targetModel) {
      toast("先选一个或填写要测速的模型名", true);
      return;
    }
    setModalTesting(true);
    setModalTestResult(null);
    try {
      const draft: Record<string, unknown> = {
        id: effectiveId,
        label: pLabel.trim(),
        protocol: pProtocol,
        baseUrl: pUrl.trim(),
        auth: pAuth || null,
      };
      if (pKey.trim()) draft.apiKey = pKey.trim();
      const res = await adminApi.testModel(draft, targetModel);
      setModalTestResult(res);
    } catch (e) {
      setModalTestResult({ ok: false, error: (e as Error).message });
    } finally {
      setModalTesting(false);
    }
  };

  const saveName = async () => {
    setSavingName(true);
    try {
      const cfg = await adminApi.saveConfig({ rev: config.rev, name: nameDraft.trim() });
      onConfigUpdated(cfg);
      toast("助理名字已更新");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSavingName(false);
    }
  };

  const chosenModalModels = useMemo(() => {
    const out: string[] = [];
    for (const m of modalPicked) if (m.trim() && !out.includes(m.trim())) out.push(m.trim());
    if (modalManualModel.trim() && !out.includes(modalManualModel.trim())) out.push(modalManualModel.trim());
    return out;
  }, [modalPicked, modalManualModel]);

  const saveProvider = async () => {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(effectiveId)) {
      toast("服务商代号只能用小写字母开头 + 小写字母/数字/短横线", true);
      return;
    }
    if (!/^https?:\/\/\S+$/i.test(pUrl.trim())) {
      toast("请填写有效的 http:// 或 https:// 地址", true);
      return;
    }
    setSavingProv(true);
    try {
      const patch: Record<string, unknown> = {
        id: effectiveId,
        label: pLabel.trim(),
        protocol: pProtocol,
        baseUrl: pUrl.trim(),
        auth: pAuth || null,
      };
      if (pKey.trim()) patch.apiKey = pKey.trim();
      let nextModels: ModelRef[] | undefined;
      if (chosenModalModels.length) {
        const pickedRefs: ModelRef[] = chosenModalModels.map((model) => ({ provider: effectiveId, model }));
        const keySet = new Set(pickedRefs.map((x) => `${x.provider}:${x.model}`));
        const rest = config.models.filter((x) => !keySet.has(`${x.provider}:${x.model}`));
        nextModels = (modalMakeMain ? [...pickedRefs, ...rest] : [...rest, ...pickedRefs]).slice(0, 12);
      }
      const cfg = await adminApi.saveConfig({
        rev: config.rev,
        providers: [patch],
        ...(nextModels ? { models: nextModels } : {}),
      });
      onConfigUpdated(cfg);
      setProvModalOpen(false);
      toast(chosenModalModels.length ? `已保存「${pLabel.trim() || effectiveId}」并启用 ${chosenModalModels.join("、")}` : "服务商已保存");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSavingProv(false);
    }
  };

  const runModelTest = async (provider: string, model: string) => {
    const key = `${provider}:${model}`;
    setTests((prev) => ({ ...prev, [key]: { running: true } }));
    try {
      const result = await adminApi.testModel(provider, model);
      setTests((prev) => ({ ...prev, [key]: { result } }));
    } catch (e) {
      setTests((prev) => ({
        ...prev,
        [key]: { result: { ok: false, error: (e as Error).message } },
      }));
    }
  };

  const pullModels = async (provId: string) => {
    setFetchingProv(provId);
    try {
      const res = await adminApi.fetchProviderModels(provId);
      setFetchedByProv((prev) => ({ ...prev, [provId]: res.models }));
      if (!res.models.length) toast("服务商返回了空的模型列表", true);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setFetchingProv(null);
    }
  };

  const makeMainModel = async (idx: number) => {
    const chosen = config.models[idx];
    if (!chosen || idx === 0) return;
    const next = [chosen, ...config.models.filter((_, i) => i !== idx)];
    try {
      const cfg = await adminApi.saveConfig({ rev: config.rev, models: next });
      onConfigUpdated(cfg);
      toast(`已将 ${chosen.model} 设为主模型`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const reorderModel = async (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= config.models.length) return;
    const next = [...config.models];
    const tmp = next[idx]!;
    next[idx] = next[target]!;
    next[target] = tmp;
    try {
      const cfg = await adminApi.saveConfig({ rev: config.rev, models: next });
      onConfigUpdated(cfg);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const removeModel = async (idx: number) => {
    if (config.models.length <= 1) return;
    const next = config.models.filter((_, i) => i !== idx);
    try {
      const cfg = await adminApi.saveConfig({ rev: config.rev, models: next });
      onConfigUpdated(cfg);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const addModelToChain = async (prov = newProv, modelName = newModel, promote = addAsMain) => {
    const p = prov.trim();
    const m = modelName.trim();
    if (!p || !m) {
      toast("先选好服务商并填上模型名", true);
      return;
    }
    const rest = config.models.filter((x) => !(x.provider === p && x.model === m));
    const next = promote ? [{ provider: p, model: m }, ...rest] : [...rest, { provider: p, model: m }];
    try {
      const cfg = await adminApi.saveConfig({
        rev: config.rev,
        models: next.slice(0, 12),
      });
      onConfigUpdated(cfg);
      setNewModel("");
      toast(promote ? `已将 ${m} 添加并设为主模型` : `已追加模型 ${m}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const resetOneProvider = async (provId: string) => {
    try {
      const cfg = await adminApi.saveConfig({ rev: config.rev, providers: [{ id: provId, reset: true }] });
      onConfigUpdated(cfg);
      toast(`已恢复「${provId}」为服务器原始配置`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const fetchedForSelected = fetchedByProv[newProv] ?? [];
  const filteredModalModels = (modalScanned ?? []).filter((m) => !modalFilter.trim() || m.toLowerCase().includes(modalFilter.trim().toLowerCase()));

  return (
    <div className="stack">
      {config.warnings.length ? (
        <div
          className="pk-card"
          style={{
            background: "var(--warn-soft)",
            color: "var(--warn-text)",
            borderColor: "rgba(154, 91, 0, 0.25)",
          }}
        >
          <div className="row" style={{ alignItems: "flex-start" }}>
            <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 2 }} />
            <div className="stack" style={{ gap: 4 }}>
              <div style={{ fontWeight: 800 }}>配置需要注意</div>
              {config.warnings.map((w, i) => (
                <div key={i} style={{ fontSize: 13 }}>{w}</div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* Persona Name & Rev Meta */}
      <PocketCard>
        <div className="between wrap" style={{ gap: 16 }}>
          <div className="row wrap grow" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ minWidth: 220 }}>
              <span className="field-label">助理名字</span>
              <PocketInput value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="小羊" />
            </div>
            <PocketButton variant="primary" onClick={saveName} disabled={savingName}>
              <Save size={15} />
              <span>{savingName ? "保存中…" : "保存名字"}</span>
            </PocketButton>
          </div>
          <div className="stack" style={{ alignItems: "flex-end", gap: 8 }}>
            <span className="faint num">
              {config.edited
                ? `已修改 · rev ${config.rev} · ${fmtAgo(config.updatedAt)} · ${config.updatedBy || "控制台"}`
                : `使用服务器默认配置 · rev ${config.rev}`}
            </span>
            <PocketButton variant="danger" size="sm" onClick={() => setResetConfirmOpen(true)}>
              <RotateCcw size={14} />
              <span>恢复服务器默认</span>
            </PocketButton>
          </div>
        </div>
      </PocketCard>

      {/* Providers */}
      <PocketCard>
        <div className="pk-card-head">
          <h3 className="pk-card-title">
            <Server size={18} style={{ color: "var(--accent-text)" }} />
            <span>文字模型服务商</span>
          </h3>
          <PocketButton variant="soft" size="sm" onClick={() => openProvModal(null)}>
            <Plus size={14} />
            <span>新增服务商</span>
          </PocketButton>
        </div>

        {config.providers.length ? (
          <div className="grid-2">
            {config.providers.map((p) => {
              const pulled = fetchedByProv[p.id];
              return (
                <div key={p.id} className="agent-card">
                  <div className="between" style={{ alignItems: "flex-start" }}>
                    <div className="grow">
                      <div className="row" style={{ gap: 8 }}>
                        <span style={{ fontWeight: 800, fontSize: 15 }}>{p.label || p.id}</span>
                        <span className={`pk-pill ${p.protocol === "anthropic" ? "lavender" : "pink"} mono`}>
                          {PROTOCOL_LABEL[p.protocol] ?? p.protocol}
                        </span>
                      </div>
                      <div className="faint mono truncate" style={{ marginTop: 3 }}>
                        {p.baseUrl}
                      </div>
                    </div>
                    <span className={`pk-pill ${p.key.set || p.protocol === "ollama" || p.auth === "none" ? "working" : "blocked"}`}>
                      <KeyRound size={11} />
                      <span>
                        {p.key.set ? `··${p.key.hint || "****"}` : p.auth === "none" || p.protocol === "ollama" ? "免密钥" : "缺密钥"}
                      </span>
                    </span>
                  </div>

                  <div className="between wrap" style={{ gap: 8 }}>
                    <span className="faint">
                      来源：{p.from === "phone" ? "控制台 / 手机新增" : "服务器预设"}
                    </span>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <PocketButton variant="ghost" size="sm" onClick={() => openProvModal(p)}>
                        <Pencil size={13} />
                        <span>编辑 / 选模型</span>
                      </PocketButton>
                      <PocketPopover
                        trigger={
                          <PocketButton
                            variant="soft"
                            size="sm"
                            disabled={fetchingProv === p.id}
                            onClick={() => pullModels(p.id)}
                          >
                            <CloudDownload size={13} />
                            <span>{fetchingProv === p.id ? "拉取中…" : "拉取模型"}</span>
                          </PocketButton>
                        }
                      >
                        <div className="stack" style={{ gap: 8 }}>
                          <div style={{ fontWeight: 800, fontSize: 13 }}>
                            {p.label || p.id} 可用模型
                          </div>
                          {pulled && pulled.length ? (
                            <div style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                              {pulled.map((m) => (
                                <button
                                  key={m}
                                  type="button"
                                  className="prompt-item"
                                  style={{ padding: "6px 10px" }}
                                  onClick={() => addModelToChain(p.id, m, false)}
                                >
                                  <div className="between">
                                    <span className="mono" style={{ fontSize: 12 }}>{m}</span>
                                    <Plus size={13} style={{ color: "var(--accent-text)" }} />
                                  </div>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <div className="faint">
                              {fetchingProv === p.id ? "正在请求服务端点…" : "点击按钮拉取该服务商的模型清单"}
                            </div>
                          )}
                        </div>
                      </PocketPopover>
                      {p.from === "server" && config.edited ? (
                        <PocketButton variant="ghost" size="sm" onClick={() => resetOneProvider(p.id)}>
                          <RotateCcw size={13} />
                          <span>还原</span>
                        </PocketButton>
                      ) : null}
                      {p.from === "phone" ? (
                        <PocketButton variant="danger" size="sm" onClick={() => setDeleteProvTarget(p)}>
                          <Trash2 size={13} />
                        </PocketButton>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="faint">暂无服务商，点击右上角新增一个自定义接口或官方预设。</div>
        )}
      </PocketCard>

      {/* Model Priority Chain & Speedometer */}
      <PocketCard>
        <div className="pk-card-head">
          <div>
            <h3 className="pk-card-title">
              <Cpu size={18} style={{ color: "var(--lav-text)" }} />
              <span>模型顺位与实时测速</span>
            </h3>
            <div className="faint">首位是主模型，超首字耗时限或失败时会自动切换到后续备用模型。</div>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>顺位</th>
                <th>模型与服务商</th>
                <th>测速指标</th>
                <th style={{ width: 250 }}>调整</th>
              </tr>
            </thead>
            <tbody>
              {config.models.map((m, idx) => {
                const key = `${m.provider}:${m.model}`;
                const st = tests[key];
                const firstMs = st?.result?.firstMs ?? 0;
                const meterPct = st?.result?.ok ? Math.max(10, Math.min(100, Math.round((1 - firstMs / 4000) * 100))) : 0;
                return (
                  <tr key={key + idx}>
                    <td>
                      <span className={`pk-pill ${idx === 0 ? "pink" : ""}`}>
                        {idx === 0 ? "主模型" : `备用 ${idx}`}
                      </span>
                    </td>
                    <td>
                      <div className="mono" style={{ fontWeight: 700 }}>{m.model}</div>
                      <div className="faint">{m.provider}</div>
                    </td>
                    <td>
                      {st?.running ? (
                        <span className="pk-pill lavender">正在测试首字时延…</span>
                      ) : st?.result ? (
                        st.result.ok ? (
                          <div className="stack" style={{ gap: 5, minWidth: 160 }}>
                            <span className="pk-pill working num">
                              <Gauge size={12} />
                              <span>首字 {st.result.firstMs}ms · 总 {st.result.totalMs}ms</span>
                            </span>
                            <div className="ctx-bar">
                              <span style={{ width: `${meterPct}%` }} />
                            </div>
                          </div>
                        ) : (
                          <span className="pk-pill blocked">{st.result.error || "连接失败"}</span>
                        )
                      ) : (
                        <span className="faint">尚未测速</span>
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <PocketButton
                          variant="ghost"
                          size="sm"
                          disabled={st?.running}
                          onClick={() => runModelTest(m.provider, m.model)}
                        >
                          <Gauge size={13} />
                          <span>测速</span>
                        </PocketButton>
                        {idx > 0 ? (
                          <PocketButton variant="soft" size="sm" onClick={() => void makeMainModel(idx)}>
                            <span>设为主模型</span>
                          </PocketButton>
                        ) : null}
                        <PocketIconButton
                          size="sm"
                          tooltip="上移顺位"
                          disabled={idx === 0}
                          onClick={() => reorderModel(idx, -1)}
                        >
                          <ArrowUp size={14} />
                        </PocketIconButton>
                        <PocketIconButton
                          size="sm"
                          tooltip="下移顺位"
                          disabled={idx === config.models.length - 1}
                          onClick={() => reorderModel(idx, 1)}
                        >
                          <ArrowDown size={14} />
                        </PocketIconButton>
                        <PocketIconButton
                          size="sm"
                          tooltip="移除"
                          disabled={config.models.length <= 1}
                          onClick={() => removeModel(idx)}
                        >
                          <Trash2 size={14} />
                        </PocketIconButton>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Add model footer */}
        <div
          className="row wrap"
          style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--divider)" }}
        >
          <PocketSelect
            value={newProv}
            onValueChange={setNewProv}
            options={config.providers.map((p) => ({ value: p.id, label: `${p.label || p.id} (${p.id})` }))}
            ariaLabel="选择服务商"
          />
          <div className="grow" style={{ minWidth: 200 }}>
            <PocketInput
              mono
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              placeholder="输入模型 ID，比如 mimo-v2.6-flash"
              onKeyDown={(e) => {
                if (e.key === "Enter") addModelToChain();
              }}
            />
          </div>
          <label className="row" style={{ gap: 6, cursor: "pointer", fontSize: 13 }}>
            <PocketSwitch checked={addAsMain} onCheckedChange={setAddAsMain} label="设为默认主模型" />
            <span>设为主模型</span>
          </label>
          <PocketButton variant="primary" onClick={() => addModelToChain()}>
            <Plus size={15} />
            <span>加入顺位</span>
          </PocketButton>
        </div>

        {fetchedForSelected.length ? (
          <div className="row wrap" style={{ marginTop: 10, gap: 6 }}>
            <span className="faint">快捷填入已拉取模型：</span>
            {fetchedForSelected.slice(0, 12).map((id) => (
              <button
                key={id}
                type="button"
                className="slot-chip"
                onClick={() => setNewModel(id)}
              >
                {id}
              </button>
            ))}
          </div>
        ) : null}
      </PocketCard>

      {/* One-Step Add / Edit Provider + Auto-Scan Dialog */}
      <PocketDialog
        open={provModalOpen}
        onOpenChange={setProvModalOpen}
        title={editingProv ? `配置服务商：${editingProv.label || editingProv.id}` : "一键添加模型服务商"}
      >
        <div className="stack" style={{ gap: 12, maxHeight: "72vh", overflowY: "auto", paddingRight: 4 }}>
          {!editingProv ? (
            <div className="field">
              <span className="field-label">快捷预设</span>
              <div className="row wrap" style={{ gap: 6 }}>
                {ADMIN_PROVIDER_PRESETS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`slot-chip`}
                    style={
                      presetId === item.id
                        ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }
                        : undefined
                    }
                    onClick={() => applyPreset(item)}
                  >
                    {item.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="slot-chip"
                  style={
                    presetId === "custom"
                      ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }
                      : undefined
                  }
                  onClick={() => applyPreset("custom")}
                >
                  自定义接口
                </button>
              </div>
            </div>
          ) : null}

          <div className="grid-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="field">
              <span className="field-label">显示名称</span>
              <PocketInput value={pLabel} onChange={(e) => setPLabel(e.target.value)} placeholder="小米 MiMo" />
            </div>
            <div className="field">
              <span className="field-label">协议类型</span>
              <PocketSelect
                value={pProtocol}
                onValueChange={(v) => setPProtocol(v as ModelProtocol)}
                options={[
                  { value: "openai", label: "OpenAI 兼容" },
                  { value: "openai-responses", label: "OpenAI Responses / Codex" },
                  { value: "anthropic", label: "Anthropic Claude" },
                  { value: "gemini", label: "Google Gemini 原生" },
                  { value: "ollama", label: "Ollama 本地" },
                ]}
              />
            </div>
          </div>

          <div className="field">
            <span className="field-label">接口 Base URL</span>
            <PocketInput
              mono
              value={pUrl}
              onChange={(e) => setPUrl(e.target.value)}
              placeholder={URL_HINT[pProtocol]}
            />
          </div>

          {pProtocol !== "ollama" || pAuth === "bearer" ? (
            <div className="field">
              <span className="field-label">{editingProv?.key.set ? "API 密钥（留空保持原值）" : "API 密钥"}</span>
              <PocketInput
                mono
                type="password"
                value={pKey}
                onChange={(e) => setPKey(e.target.value)}
                placeholder={editingProv?.key.set ? `当前已设 ··${editingProv.key.hint || "****"}` : "输入或粘贴 API Key"}
              />
            </div>
          ) : (
            <div className="faint">Ollama 本地接口默认免密钥，填写地址即可直接扫描。</div>
          )}

          <div>
            <PocketButton size="sm" variant="ghost" onClick={() => setPMore((v) => !v)}>
              <span>{pMore ? "收起高级设置（代号 / 鉴权头）" : `高级设置（代号：${effectiveId}）`}</span>
            </PocketButton>
            {pMore ? (
              <div className="grid-2" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 8 }}>
                <div className="field">
                  <span className="field-label">服务商代号 ID</span>
                  <PocketInput
                    mono
                    disabled={!!editingProv}
                    value={editingProv ? editingProv.id : pIdEdited ? pId : effectiveId}
                    onChange={(e) => {
                      setPIdEdited(true);
                      setPId(e.target.value.toLowerCase());
                    }}
                    placeholder="my-gateway"
                  />
                </div>
                <div className="field">
                  <span className="field-label">鉴权方式</span>
                  <PocketSelect
                    value={pAuth}
                    onValueChange={(v) => setPAuth(v as "" | ModelAuth)}
                    options={[
                      { value: "", label: "按协议自动匹配" },
                      { value: "bearer", label: "Bearer" },
                      { value: "x-api-key", label: "x-api-key" },
                      { value: "api-key", label: "api-key" },
                      { value: "x-goog-api-key", label: "x-goog-api-key" },
                      { value: "none", label: "无需密钥" },
                    ]}
                  />
                </div>
              </div>
            ) : null}
          </div>

          {/* Inline Upstream Scanner + One-Click Enable */}
          <div style={{ borderTop: "1px solid var(--divider)", paddingTop: 10 }} className="stack">
            <div className="between wrap">
              <div>
                <div style={{ fontWeight: 800, fontSize: 13.5 }}>扫描上游模型并启用</div>
                <div className="faint">填好地址与密钥会自动扫描；点击可选中一个或多个模型</div>
              </div>
              <PocketButton size="sm" variant="soft" disabled={!canScanDraft || modalScanning} onClick={() => void scanDraftModels(false)}>
                <CloudDownload size={13} />
                <span>{modalScanning ? "扫描中…" : "扫描模型"}</span>
              </PocketButton>
            </div>

            {modalScanErr ? <div className="faint">自动扫描未取得列表（{modalScanErr}），可手动填入下方模型名。</div> : null}

            {modalScanned && modalScanned.length ? (
              <div className="stack" style={{ gap: 6 }}>
                {modalScanned.length > 8 ? (
                  <PocketInput mono value={modalFilter} onChange={(e) => setModalFilter(e.target.value)} placeholder={`筛选模型（共 ${modalScanned.length} 个）`} />
                ) : null}
                <div className="row wrap" style={{ gap: 6, maxHeight: 150, overflowY: "auto" }}>
                  {filteredModalModels.slice(0, 60).map((m) => {
                    const active = modalPicked.includes(m);
                    return (
                      <button
                        key={m}
                        type="button"
                        className="slot-chip"
                        style={
                          active
                            ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }
                            : undefined
                        }
                        onClick={() => {
                          setModalPicked((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
                          if (!active) setModalTestModel(m);
                        }}
                      >
                        {m}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="row wrap" style={{ gap: 8 }}>
              <div className="grow">
                <PocketInput
                  mono
                  value={modalManualModel}
                  onChange={(e) => {
                    setModalManualModel(e.target.value);
                    if (e.target.value.trim()) setModalTestModel(e.target.value.trim());
                  }}
                  placeholder="手动填或补充模型名，比如 mimo-v2.6-flash"
                />
              </div>
              <PocketButton
                size="sm"
                variant="soft"
                disabled={modalTesting || !canScanDraft}
                onClick={() => void runDraftTest()}
              >
                <Sparkles size={13} />
                <span>{modalTesting ? "测速中…" : "先测一下"}</span>
              </PocketButton>
            </div>

            {chosenModalModels.length ? (
              <div className="between wrap" style={{ background: "var(--bg-soft)", padding: "8px 12px", borderRadius: 10 }}>
                <div className="faint mono">待启用：{chosenModalModels.join(", ")}</div>
                <label className="row" style={{ gap: 6, cursor: "pointer", fontSize: 13 }}>
                  <PocketSwitch checked={modalMakeMain} onCheckedChange={setModalMakeMain} label="保存后设为主模型" />
                  <span>设为默认主模型</span>
                </label>
              </div>
            ) : null}

            {modalTestResult ? (
              <div className="faint" style={{ color: modalTestResult.ok ? "var(--ok-text)" : "var(--blush-text)" }}>
                {modalTestResult.ok
                  ? `通了 · 首字 ${modalTestResult.firstMs ?? "-"}ms · 总 ${modalTestResult.totalMs ?? "-"}ms${modalTestResult.reply ? ` · 回：${modalTestResult.reply}` : ""}`
                  : `没通：${modalTestResult.error || "连接失败"}`}
              </div>
            ) : null}
          </div>

          <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
            <PocketButton variant="ghost" onClick={() => setProvModalOpen(false)}>
              取消
            </PocketButton>
            <PocketButton variant="primary" onClick={saveProvider} disabled={savingProv}>
              <Save size={15} />
              <span>{savingProv ? "保存中…" : chosenModalModels.length ? "保存并启用模型" : "保存服务商"}</span>
            </PocketButton>
          </div>
        </div>
      </PocketDialog>

      <PocketConfirmDialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        title="恢复所有服务器默认配置？"
        description="这会清空通过手机或网页控制台修改的助理名、自定义服务商、模型顺位以及语音覆写。"
        confirmLabel="恢复默认"
        onConfirm={async () => {
          const cfg = await adminApi.saveConfig({ rev: config.rev, reset: true });
          onConfigUpdated(cfg);
          toast("已恢复服务器默认配置");
        }}
      />

      <PocketConfirmDialog
        open={!!deleteProvTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteProvTarget(null);
        }}
        title="删除自定义服务商？"
        description={deleteProvTarget ? `将移除服务商「${deleteProvTarget.id}」及其密封保存的密钥。` : ""}
        confirmLabel="确认删除"
        onConfirm={async () => {
          if (!deleteProvTarget) return;
          const cfg = await adminApi.saveConfig({
            rev: config.rev,
            providers: [{ id: deleteProvTarget.id, remove: true }],
          });
          onConfigUpdated(cfg);
          toast(`已删除 ${deleteProvTarget.id}`);
        }}
      />
    </div>
  );
}
