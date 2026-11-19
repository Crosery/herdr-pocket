import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AudioWaveform,
  KeyRound,
  Mic,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  adminApi,
  fmtTime,
  type AssistantConfigView,
  type VoiceOption,
  type VoiceProviderId,
} from "../lib/api";
import { XiaoyangOrb } from "../components/MascotAndVendor";
import {
  PocketButton,
  PocketCard,
  PocketChip,
  PocketConfirmDialog,
  PocketInput,
  PocketSegmented,
  useToast,
} from "../components/ui/PocketUI";

interface DiagRow {
  callId: string;
  ts: number;
  provider?: string;
  duration_ms?: number;
  turns?: number;
  ttfa_avg_ms?: number;
  asr_avg_ms?: number;
  tse_rtf?: number;
  sv_checks?: number;
  sv_passed?: number;
  tse_bypassed?: boolean;
  tse_enabled?: boolean;
  sv_enabled?: boolean;
}

const GENDER_LABEL: Record<string, string> = {
  female: "女声",
  male: "男声",
  neutral: "中性",
};

export function VoiceView({
  config,
  onConfigUpdated,
}: {
  config: AssistantConfigView;
  onConfigUpdated: (cfg: AssistantConfigView) => void;
}) {
  const toast = useToast();
  const saved = config.voice;

  const [provider, setProvider] = useState<"" | VoiceProviderId>(saved.provider ?? "");
  const [url, setUrl] = useState(saved.url ?? "");
  const [model, setModel] = useState(saved.model ?? "");
  const [voice, setVoice] = useState(saved.voice ?? (saved.provider === "openai-realtime" ? "marin" : ""));
  const [speed, setSpeed] = useState(saved.speed != null ? String(saved.speed) : "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearKeyOpen, setClearKeyOpen] = useState(false);

  const [catalog, setCatalog] = useState<VoiceOption[]>([]);
  const [diagRows, setDiagRows] = useState<DiagRow[]>([]);
  const [loadingDiag, setLoadingDiag] = useState(false);

  useEffect(() => {
    setProvider(saved.provider ?? "");
    setUrl(saved.url ?? "");
    setModel(saved.model ?? "");
    setVoice(saved.voice ?? (saved.provider === "openai-realtime" ? "marin" : ""));
    setSpeed(saved.speed != null ? String(saved.speed) : "");
    setApiKey("");
  }, [saved.provider, saved.url, saved.model, saved.voice, saved.speed, config.rev]);

  useEffect(() => {
    if (!provider) {
      setCatalog([]);
      return;
    }
    let dead = false;
    adminApi
      .voices(provider)
      .then((res) => {
        if (!dead) setCatalog(res.voices ?? []);
      })
      .catch(() => {
        if (!dead) setCatalog([]);
      });
    return () => {
      dead = true;
    };
  }, [provider]);

  const loadDiagnostics = useCallback(async () => {
    setLoadingDiag(true);
    try {
      const q = new URLSearchParams({ since: "7d", kind: "live.ai", limit: "400" });
      const res = await adminApi.logs(q);
      const byCall: Record<string, DiagRow> = {};
      for (const e of res.entries ?? []) {
        const d = (e.data ?? {}) as Record<string, unknown>;
        const cid = typeof d.callId === "string" ? d.callId : "";
        const stage = typeof d.stage === "string" ? d.stage : "";
        if (!cid || (stage !== "call_summary" && stage !== "summary")) continue;
        byCall[cid] = {
          ...(byCall[cid] ?? {}),
          ...(d as Partial<DiagRow>),
          callId: cid,
          ts: e.ts,
        };
      }
      const sorted = Object.values(byCall).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
      setDiagRows(sorted);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setLoadingDiag(false);
    }
  }, [toast]);

  useEffect(() => {
    loadDiagnostics();
  }, [loadDiagnostics]);

  const handleProviderSwitch = (nextProv: "" | VoiceProviderId) => {
    setProvider(nextProv);
    if (nextProv === (saved.provider ?? "")) {
      setUrl(saved.url ?? "");
      setModel(saved.model ?? "");
      setVoice(saved.voice ?? (nextProv === "openai-realtime" ? "marin" : ""));
      setSpeed(saved.speed != null ? String(saved.speed) : "");
    } else {
      setUrl("");
      setModel("");
      setVoice(nextProv === "openai-realtime" ? "marin" : "");
      setSpeed("");
    }
    setApiKey("");
  };

  const saveVoice = async () => {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = { provider: provider || null };
      if (provider) {
        patch.url = url.trim() || null;
        patch.model = model.trim() || null;
        patch.voice = voice.trim() || null;
        patch.speed = speed.trim() ? Number(speed.trim()) : null;
        if (apiKey.trim()) patch.apiKey = apiKey.trim();
      }
      const cfg = await adminApi.saveConfig({ rev: config.rev, voice: patch });
      onConfigUpdated(cfg);
      setApiKey("");
      toast("语音配置已保存，下一通电话直接生效");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };

  const sameProvider = provider && provider === (saved.provider ?? "");
  const avgTtfa = diagRows.filter((r) => typeof r.ttfa_avg_ms === "number");
  const avgTtfaVal = avgTtfa.length
    ? Math.round(avgTtfa.reduce((s, r) => s + (r.ttfa_avg_ms ?? 0), 0) / avgTtfa.length)
    : null;
  const fallbackCount = diagRows.filter((r) => r.tse_bypassed).length;

  return (
    <div className="stack">
      {/* Orbital Voice Studio Hero */}
      <div className="voice-hero">
        <div className="row" style={{ gap: 16 }}>
          <XiaoyangOrb mood={provider ? "speaking" : "idle"} size={84} />
          <div className="stack" style={{ gap: 6 }}>
            <div className="row" style={{ gap: 10 }}>
              <span className="cute-font" style={{ fontSize: 22 }}>
                小羊实时语音工作室
              </span>
              {provider ? (
                <span className="eq-bars" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}
            </div>
            <div className="faint" style={{ color: "var(--ink)", opacity: 0.78 }}>
              {provider
                ? `当前引擎：${provider} · 音色：${voice || "默认"} · 模型：${model || (provider === "moss-live" ? "moss-live-1.0" : "gpt-realtime")}`
                : "实时语音服务已关闭，打开后可直接在手机 App 上打电话调度电脑 Agent"}
            </div>
          </div>
        </div>

        <PocketSegmented
          value={provider}
          onChange={handleProviderSwitch}
          options={[
            { value: "openai-realtime", label: "OpenAI Realtime 兼容" },
            { value: "moss-live", label: "MOSS-Live" },
            { value: "", label: "关闭" },
          ]}
        />
      </div>

      {/* Config Body */}
      {provider ? (
        <PocketCard>
          <div className="stack" style={{ gap: 18 }}>
            <div className="grid-2">
              <div className="field">
                <span className="field-label">WebSocket 接入地址</span>
                <PocketInput
                  mono
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={provider === "moss-live" ? "wss://api.mosi.cn/v1/realtime" : "wss://api.openai.com/v1/realtime"}
                />
              </div>

              <div className="field">
                <span className="field-label">模型名称</span>
                <PocketInput
                  mono
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={provider === "moss-live" ? "moss-live-1.0" : "gpt-realtime"}
                />
                {provider === "openai-realtime" ? (
                  <div className="row wrap" style={{ gap: 6, marginTop: 2 }}>
                    <PocketChip
                      active={(model || "gpt-realtime") === "gpt-realtime"}
                      onClick={() => setModel("gpt-realtime")}
                    >
                      <Sparkles size={13} />
                      <span>gpt-realtime（最快 ~0.55s）</span>
                    </PocketChip>
                    <PocketChip
                      active={model === "gpt-realtime-2.1"}
                      onClick={() => setModel("gpt-realtime-2.1")}
                    >
                      <span>gpt-realtime-2.1（指令更强）</span>
                    </PocketChip>
                  </div>
                ) : null}
              </div>
            </div>

            {/* Selectable Voice Cards */}
            <div className="field">
              <span className="field-label">
                <span>音色选择（点击卡片切换，OpenAI 路径默认开启近场抑噪）</span>
                <span className="mono" style={{ color: "var(--accent-text)" }}>
                  当前：{voice || "默认"}
                </span>
              </span>

              {catalog.length ? (
                <div className="voice-cards-grid">
                  {catalog.map((v) => {
                    const active = voice === v.id;
                    return (
                      <button
                        key={v.id}
                        type="button"
                        className={`voice-card${active ? " active" : ""}`}
                        onClick={() => setVoice(v.id)}
                      >
                        <div className="between">
                          <span className="row" style={{ gap: 6 }}>
                            <AudioWaveform
                              size={15}
                              style={{ color: active ? "var(--accent-text)" : "var(--muted)" }}
                            />
                            <b className="mono" style={{ fontSize: 14 }}>{v.id}</b>
                          </span>
                          {v.recommended ? (
                            <span className="pk-pill pink">推荐</span>
                          ) : (
                            <span className="pk-pill">{GENDER_LABEL[v.gender ?? ""] ?? "音色"}</span>
                          )}
                        </div>
                        <div style={{ fontWeight: 800, fontSize: 13 }}>{v.label}</div>
                        {v.hint ? <div className="faint">{v.hint}</div> : null}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div
                  className="faint"
                  style={{
                    padding: "12px 14px",
                    borderRadius: 14,
                    background: "var(--surface-2)",
                    border: "1px solid var(--divider)",
                  }}
                >
                  当前服务商无预设音色目录，直接在下方输入服务端支持的音色 ID 即可（留空使用服务默认音色）。
                </div>
              )}

              <div className="grid-2" style={{ marginTop: 8 }}>
                <div className="field">
                  <span className="field-label">当前 / 自定义音色 ID</span>
                  <PocketInput
                    mono
                    value={voice}
                    onChange={(e) => setVoice(e.target.value)}
                    placeholder={provider === "openai-realtime" ? "marin" : "留空使用默认音色"}
                  />
                </div>
                <div className="field">
                  <span className="field-label">语速倍率（0.5 - 1.5，留空为默认）</span>
                  <PocketInput
                    mono
                    value={speed}
                    onChange={(e) => setSpeed(e.target.value)}
                    placeholder="例如 1.05"
                  />
                </div>
              </div>
            </div>

            {/* Key row */}
            <div className="field">
              <span className="field-label">
                <span>语音服务 API 密钥</span>
                {sameProvider && saved.key.from === "phone" ? (
                  <PocketButton variant="danger" size="sm" onClick={() => setClearKeyOpen(true)}>
                    <Trash2 size={13} />
                    <span>清除覆写密钥</span>
                  </PocketButton>
                ) : null}
              </span>
              <PocketInput
                mono
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="输入新密钥以覆写，留空保持当前设置"
              />
              <span className="faint">
                {sameProvider && saved.key.set ? (
                  <>
                    <KeyRound size={12} style={{ display: "inline", verticalAlign: "-2px", marginRight: 5 }} />
                    已配置密钥 ··{saved.key.hint || "****"}
                    {saved.key.from === "phone" ? "（控制台 / 手机覆盖）" : "（服务器默认）"}
                  </>
                ) : (
                  "换了新服务商建议填写对应的语音密钥（若服务器已同源配置则可留空）。"
                )}
              </span>
            </div>

            <div className="row" style={{ justifyContent: "flex-end" }}>
              <PocketButton variant="primary" size="lg" onClick={saveVoice} disabled={saving}>
                <Save size={16} />
                <span>{saving ? "保存中…" : "保存语音设置"}</span>
              </PocketButton>
            </div>
          </div>
        </PocketCard>
      ) : (
        <PocketCard>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <div className="faint">确认保存后会关闭语音通话能力（文字对话小羊不受影响）。</div>
            <PocketButton variant="primary" onClick={saveVoice} disabled={saving}>
              <Save size={15} />
              <span>{saving ? "保存中…" : "保存关闭状态"}</span>
            </PocketButton>
          </div>
        </PocketCard>
      )}

      {/* Call Diagnostics */}
      <PocketCard>
        <div className="pk-card-head">
          <div className="row wrap">
            <h3 className="pk-card-title">
              <Activity size={18} style={{ color: "var(--accent-text)" }} />
              <span>近 7 天通话质量与端侧声纹诊断</span>
            </h3>
            <span className="pk-pill num">共 {diagRows.length} 通</span>
            {avgTtfaVal != null ? (
              <span className="pk-pill working num">平均首响 {avgTtfaVal}ms</span>
            ) : null}
            {fallbackCount > 0 ? (
              <span className="pk-pill warn num">分离超载自动退回 {fallbackCount} 次</span>
            ) : null}
          </div>
          <PocketButton variant="ghost" size="sm" onClick={loadDiagnostics} disabled={loadingDiag}>
            <RefreshCw size={14} />
            <span>{loadingDiag ? "刷新中…" : "刷新记录"}</span>
          </PocketButton>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>语音引擎</th>
                <th>通话时长 · 轮次</th>
                <th>首字响应 / ASR</th>
                <th>分离 RTF · 声纹验证</th>
                <th>实际执行路径</th>
              </tr>
            </thead>
            <tbody>
              {diagRows.length ? (
                diagRows.slice(0, 30).map((r) => {
                  const dur = r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : "-";
                  const ttfa = r.ttfa_avg_ms != null ? `${Math.round(r.ttfa_avg_ms)}ms` : "-";
                  const asr = r.asr_avg_ms != null ? `${Math.round(r.asr_avg_ms)}ms` : "-";
                  const rtf = r.tse_rtf ? `${r.tse_rtf.toFixed(2)}x` : "-";
                  const sv = r.sv_checks ? `${r.sv_passed ?? 0}/${r.sv_checks}` : "-";
                  const pathBadge = r.tse_bypassed ? (
                    <span className="pk-pill warn">分离超载退回</span>
                  ) : r.tse_enabled ? (
                    <span className="pk-pill working">旗舰人声分离</span>
                  ) : r.sv_enabled ? (
                    <span className="pk-pill lavender">灵巧声纹门控</span>
                  ) : (
                    <span className="pk-pill">内置降噪直连</span>
                  );
                  return (
                    <tr key={r.callId}>
                      <td className="num faint" style={{ whiteSpace: "nowrap" }}>{fmtTime(r.ts)}</td>
                      <td className="mono">{r.provider || "-"}</td>
                      <td className="num">{dur}（{r.turns ?? "-"} 轮）</td>
                      <td className="num">{ttfa} / {asr}</td>
                      <td className="num">{rtf} · {sv}</td>
                      <td>{pathBadge}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="faint" style={{ padding: "20px 10px", textAlign: "center" }}>
                    <Mic size={14} style={{ display: "inline", verticalAlign: "-2px", marginRight: 6 }} />
                    最近 7 天还没有记录到完整的通话遥测汇总
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </PocketCard>

      <PocketConfirmDialog
        open={clearKeyOpen}
        onOpenChange={setClearKeyOpen}
        title="清除覆盖的语音密钥？"
        description="清除后会立即回落使用服务器环境变量中配置的默认密钥。"
        confirmLabel="清除密钥"
        onConfirm={async () => {
          const cfg = await adminApi.saveConfig({ rev: config.rev, voice: { apiKey: null } });
          onConfigUpdated(cfg);
          toast("已清除覆写语音密钥");
        }}
      />
    </div>
  );
}
