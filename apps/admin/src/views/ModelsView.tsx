import { useEffect, useState } from "react";
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
  Trash2,
} from "lucide-react";
import {
  adminApi,
  fmtAgo,
  type AssistantConfigView,
  type ModelAuth,
  type ModelProtocol,
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
  useToast,
} from "../components/ui/PocketUI";

interface TestState {
  running?: boolean;
  result?: ModelTestResult;
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

  // Provider dialog
  const [provModalOpen, setProvModalOpen] = useState(false);
  const [editingProv, setEditingProv] = useState<ProviderView | null>(null);
  const [pId, setPId] = useState("");
  const [pLabel, setPLabel] = useState("");
  const [pProtocol, setPProtocol] = useState<ModelProtocol>("openai");
  const [pAuth, setPAuth] = useState<"" | ModelAuth>("");
  const [pUrl, setPUrl] = useState("");
  const [pKey, setPKey] = useState("");
  const [savingProv, setSavingProv] = useState(false);
  const [deleteProvTarget, setDeleteProvTarget] = useState<ProviderView | null>(null);

  useEffect(() => {
    setNameDraft(config.name || "小羊");
    if (!newProv || !config.providers.some((p) => p.id === newProv)) {
      setNewProv(config.providers[0]?.id ?? "");
    }
  }, [config]);

  const openProvModal = (p: ProviderView | null) => {
    setEditingProv(p);
    setPId(p?.id ?? "");
    setPLabel(p?.label ?? "");
    setPProtocol(p?.protocol ?? "openai");
    setPAuth(p?.auth ?? "");
    setPUrl(p?.baseUrl ?? "");
    setPKey("");
    setProvModalOpen(true);
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

  const saveProvider = async () => {
    if (!pId.trim()) {
      toast("请填写服务商 ID（小写字母/数字/短横线）", true);
      return;
    }
    setSavingProv(true);
    try {
      const patch: Record<string, unknown> = {
        id: pId.trim(),
        label: pLabel.trim(),
        protocol: pProtocol,
        baseUrl: pUrl.trim(),
        auth: pAuth || null,
      };
      if (pKey.trim()) patch.apiKey = pKey.trim();
      const cfg = await adminApi.saveConfig({ rev: config.rev, providers: [patch] });
      onConfigUpdated(cfg);
      setProvModalOpen(false);
      toast("服务商已保存");
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

  const addModelToChain = async (prov = newProv, modelName = newModel) => {
    const p = prov.trim();
    const m = modelName.trim();
    if (!p || !m) {
      toast("先选好服务商并填上模型名", true);
      return;
    }
    try {
      const cfg = await adminApi.saveConfig({
        rev: config.rev,
        models: [...config.models, { provider: p, model: m }],
      });
      onConfigUpdated(cfg);
      setNewModel("");
      toast(`已追加模型 ${m}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const fetchedForSelected = fetchedByProv[newProv] ?? [];

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
                          {p.protocol}
                        </span>
                      </div>
                      <div className="faint mono truncate" style={{ marginTop: 3 }}>
                        {p.baseUrl}
                      </div>
                    </div>
                    <span className={`pk-pill ${p.key.set ? "working" : "blocked"}`}>
                      <KeyRound size={11} />
                      <span>
                        {p.key.set ? `··${p.key.hint || "****"}` : p.auth === "none" ? "免密钥" : "缺密钥"}
                      </span>
                    </span>
                  </div>

                  <div className="between wrap" style={{ gap: 8 }}>
                    <span className="faint">
                      来源：{p.from === "phone" ? "控制台 / 手机覆盖" : "服务器预设"}
                    </span>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <PocketButton variant="ghost" size="sm" onClick={() => openProvModal(p)}>
                        <Pencil size={13} />
                        <span>编辑</span>
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
                                  onClick={() => addModelToChain(p.id, m)}
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
                <th style={{ width: 170 }}>调整</th>
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
              placeholder="输入模型 ID，或用上方「拉取模型」快速加入"
              onKeyDown={(e) => {
                if (e.key === "Enter") addModelToChain();
              }}
            />
          </div>
          <PocketButton variant="primary" onClick={() => addModelToChain()}>
            <Plus size={15} />
            <span>加入顺位</span>
          </PocketButton>
        </div>

        {fetchedForSelected.length ? (
          <div className="row wrap" style={{ marginTop: 10, gap: 6 }}>
            <span className="faint">快捷填入已拉取模型：</span>
            {fetchedForSelected.slice(0, 8).map((id) => (
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

      {/* Add / Edit Provider Modal */}
      <PocketDialog
        open={provModalOpen}
        onOpenChange={setProvModalOpen}
        title={editingProv ? `编辑服务商：${editingProv.id}` : "新增模型服务商"}
      >
        <div className="stack" style={{ gap: 12 }}>
          <div className="field">
            <span className="field-label">服务商 ID（小写字母/数字/短横线）</span>
            <PocketInput
              mono
              disabled={!!editingProv}
              value={pId}
              onChange={(e) => setPId(e.target.value)}
              placeholder="my-gateway"
            />
          </div>
          <div className="field">
            <span className="field-label">显示名称</span>
            <PocketInput value={pLabel} onChange={(e) => setPLabel(e.target.value)} placeholder="自建网关" />
          </div>
          <div className="grid-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="field">
              <span className="field-label">协议类型</span>
              <PocketSelect
                value={pProtocol}
                onValueChange={(v) => setPProtocol(v as ModelProtocol)}
                options={[
                  { value: "openai", label: "OpenAI 兼容" },
                  { value: "anthropic", label: "Anthropic" },
                ]}
              />
            </div>
            <div className="field">
              <span className="field-label">鉴权方式</span>
              <PocketSelect
                value={pAuth}
                onValueChange={(v) => setPAuth(v as "" | ModelAuth)}
                options={[
                  { value: "", label: "默认 (Bearer)" },
                  { value: "bearer", label: "Bearer" },
                  { value: "x-api-key", label: "x-api-key" },
                  { value: "api-key", label: "api-key" },
                  { value: "none", label: "无需密钥" },
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
              placeholder="https://llm.example.com/v1"
            />
          </div>
          <div className="field">
            <span className="field-label">API 密钥（留空保持原值）</span>
            <PocketInput
              mono
              type="password"
              value={pKey}
              onChange={(e) => setPKey(e.target.value)}
              placeholder="输入新密钥替换"
            />
          </div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
            <PocketButton variant="ghost" onClick={() => setProvModalOpen(false)}>
              取消
            </PocketButton>
            <PocketButton variant="primary" onClick={saveProvider} disabled={savingProv}>
              <Save size={15} />
              <span>{savingProv ? "保存中…" : "保存服务商"}</span>
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
