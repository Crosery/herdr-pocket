import { useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, CheckCircle2, ChevronDown, CloudDownload, KeyRound, Loader2, Plus, RotateCcw, Save, Server, Sparkles, Trash2, Zap } from "lucide-react";
import {
  PROVIDER_PRESETS,
  type AssistantConfigView,
  type ModelAuth,
  type ModelProtocol,
  type ModelRef,
  type ModelTestResult,
  type ProviderPatch,
  type ProviderPresetItem,
  type ProviderView,
} from "@herdr-pocket/protocol";
import { PocketButton, PocketInput, PocketSelect, PocketSwitch, useToast } from "../../components/PocketUI";
import { fetchAssistantProviderModels, saveAssistantConfig } from "../../lib/assistant";
import { modelErrorText } from "../../lib/modelErrors";
import { relTime } from "../../lib/store";
import { keyState, MAX_MODELS, PROTOCOL_LABEL, providerName, speedLine, testDraft, testModel, URL_HINTS } from "./modelTests";
import "../../styles/models.css";

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const HTTP = /^https?:\/\/\S+$/i;
const SCAN_SHOWN = 36;

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

/**
 * 服务商: one row each (name, protocol, key chip, how many models use it). Clicking a row
 * opens its editor in place; 添加服务商 opens the preset picker in place. No dialogs.
 */
export function ProvidersSection({ cfg }: { cfg: AssistantConfigView }) {
  /** Provider id being edited, "new" for the add form. */
  const [open, setOpen] = useState<string | null>(null);
  const inUse = (id: string) => cfg.models.filter((m) => m.provider === id).length;

  // A provider removed elsewhere closes its editor.
  useEffect(() => {
    if (open && open !== "new" && !cfg.providers.some((p) => p.id === open)) setOpen(null);
  }, [cfg.providers, open]);

  return (
    <section className="mm-section" aria-labelledby="mm-providers">
      <div className="mm-head">
        <h3 id="mm-providers" className="mm-head-title">
          服务商
        </h3>
      </div>
      <div className="mm-card">
        <ul className="pv-list">
          {cfg.providers.map((x) => {
            const k = keyState(x);
            const used = inUse(x.id);
            const isOpen = open === x.id;
            return (
              <li key={x.id} className={`pv-row${isOpen ? " open" : ""}`}>
                <button type="button" className="pv-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : x.id)}>
                  <span className="pv-icon" aria-hidden="true">
                    {x.from === "server" ? <Server size={17} /> : <AppWindow size={17} />}
                  </span>
                  <span className="pv-text">
                    <span className="pv-title">{providerName(x)}</span>
                    <span className="pv-sub">
                      {PROTOCOL_LABEL[x.protocol]} · {x.from === "server" ? "服务器上的" : "App 里加的"}
                    </span>
                    <span className="pv-chips">
                      <span className={`pv-key${k.ok ? " ok" : " bad"}`} title={k.ok ? k.text : "还没有密钥，用它的模型会失败"}>
                        <KeyRound size={12} />
                        {k.text}
                      </span>
                      <span className={`pv-used${used ? "" : " none"}`}>{used ? `在用 ${used} 个模型` : "没有模型在用"}</span>
                    </span>
                    <span className="pv-url">{x.baseUrl || "还没有地址"}</span>
                  </span>
                  <ChevronDown size={16} className="pv-chev" aria-hidden="true" />
                </button>
                {isOpen ? <ProviderEditor key={x.id} cfg={cfg} current={x} onClose={() => setOpen(null)} /> : null}
              </li>
            );
          })}
          <li className={`pv-row${open === "new" ? " open" : ""}`}>
            {open === "new" ? (
              <ProviderEditor key="new" cfg={cfg} current={null} onClose={() => setOpen(null)} />
            ) : (
              <button type="button" className="mm-add-row" onClick={() => setOpen("new")}>
                <span className="mm-add-icon">
                  <Plus size={17} />
                </span>
                <span className="mm-add-text">
                  <span className="mm-add-title">添加服务商</span>
                  <span className="mm-add-sub">选常用平台预设，自动扫描可用模型</span>
                </span>
              </button>
            )}
          </li>
        </ul>
      </div>
      <p className="mm-note small">服务器上配的服务商可以改，不能删；App 里加的可以删。密钥只能设、不能看，这里只显示最后几位。</p>
    </section>
  );
}

/** 恢复: drops every change made from the apps and goes back to the relay's own settings. */
export function ResetSection({ cfg }: { cfg: AssistantConfigView }) {
  const toast = useToast();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <section className="mm-section" aria-labelledby="mm-reset">
      <div className="mm-head">
        <h3 id="mm-reset" className="mm-head-title">
          恢复
        </h3>
      </div>
      <div className="mm-card mm-reset">
        <div className="mm-reset-text">
          <strong>恢复成服务器上的设置</strong>
          <span>
            {!cfg.edited
              ? "现在用的就是服务器上的设置"
              : ask
                ? "App 里改过的模型、服务商和语音都会撤掉，回到服务器自己的设置；在 App 里设的密钥也会一起删掉。所有手机和电脑都会跟着变。"
                : "撤掉所有 App 里的改动，App 里设的密钥也会删掉"}
          </span>
        </div>
        <div className="mm-panel-buttons">
          {ask ? (
            <PocketButton variant="ghost" size="sm" onClick={() => setAsk(false)}>
              取消
            </PocketButton>
          ) : null}
          <PocketButton
            variant="danger"
            size="sm"
            disabled={!cfg.edited || busy}
            onClick={async () => {
              if (!ask) {
                setAsk(true);
                return;
              }
              setBusy(true);
              try {
                await saveAssistantConfig({ rev: cfg.rev, reset: true });
                setAsk(false);
                toast("已经恢复成服务器上的设置");
              } catch (e) {
                toast((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RotateCcw size={13} />
            <span>{ask ? "确定恢复" : "恢复"}</span>
          </PocketButton>
        </div>
      </div>
      {cfg.updatedAt ? (
        <p className="mm-note small">
          {relTime(cfg.updatedAt)}
          {cfg.updatedBy ? `由「${cfg.updatedBy}」` : ""}改过。改动马上生效，所有手机和电脑看到的都一样。
        </p>
      ) : null}
    </section>
  );
}

/** Add (current = null) or change one provider, scan what it offers and turn models on, all in place. */
function ProviderEditor({ cfg, current, onClose }: { cfg: AssistantConfigView; current: ProviderView | null; onClose: () => void }) {
  const toast = useToast();
  const firstPreset = PROVIDER_PRESETS[0];
  const [presetId, setPresetId] = useState<string | null>(current ? null : (firstPreset?.id ?? "custom"));
  const [label, setLabel] = useState(current?.label ?? firstPreset?.label ?? "");
  const [protocol, setProtocol] = useState<ModelProtocol>(current?.protocol ?? firstPreset?.protocol ?? "openai");
  const [url, setUrl] = useState(current?.baseUrl ?? firstPreset?.baseUrl ?? "");
  const [auth, setAuth] = useState<"" | ModelAuth>(current?.auth ?? (current ? "" : (firstPreset?.auth ?? "")));
  const [apiKey, setApiKey] = useState("");
  const [more, setMore] = useState(Boolean(current?.auth));
  const [manualId, setManualId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [scanned, setScanned] = useState<string[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<string[]>(!current && firstPreset?.recommendedModel ? [firstPreset.recommendedModel] : []);
  const [manual, setManual] = useState("");
  const [makeMain, setMakeMain] = useState(!current);
  const [test, setTest] = useState<ModelTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ask, setAsk] = useState<null | "remove" | "reset">(null);
  const scanSeq = useRef(0);

  const id = useMemo(
    () => (current ? current.id : idEdited && manualId.trim() ? manualId.trim() : deriveProviderId(presetId, label, url, cfg.providers.map((x) => x.id))),
    [current, idEdited, manualId, presetId, label, url, cfg.providers],
  );
  const users = current ? cfg.models.filter((m) => m.provider === current.id) : [];
  const usedNames = new Set(users.map((m) => m.model));
  const keyFree = protocol === "ollama" || auth === "none";
  const canScan = HTTP.test(url.trim()) && (Boolean(apiKey.trim()) || Boolean(current?.key.set) || keyFree);
  const chosen = useMemo(() => {
    const out: string[] = [];
    for (const m of [...picked, manual]) if (m.trim() && !out.includes(m.trim()) && !usedNames.has(m.trim())) out.push(m.trim());
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, manual, users.length]);
  const idError = !current && !ID.test(id) ? "代号要小写字母开头，只能用字母、数字和短横线" : null;
  const urlError = url.trim() && !HTTP.test(url.trim()) ? "请填写 http:// 或 https:// 开头的地址" : null;

  const draft = (): ProviderPatch => ({
    id,
    ...(label.trim() ? { label: label.trim() } : {}),
    protocol,
    baseUrl: url.trim(),
    ...(auth ? { auth } : {}),
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
  });

  const scan = async (quiet: boolean) => {
    if (!canScan) return;
    const seq = ++scanSeq.current;
    setScanning(true);
    setScanError(null);
    try {
      const names = await fetchAssistantProviderModels(draft());
      if (scanSeq.current !== seq) return;
      setScanned(names);
      if (!names.length && !quiet) toast("它没有列出模型，直接在下面填名字就行");
    } catch (e) {
      if (scanSeq.current !== seq) return;
      setScanned([]);
      setScanError((e as Error).message);
    } finally {
      if (scanSeq.current === seq) setScanning(false);
    }
  };

  // Scans by itself once the address and key look complete.
  useEffect(() => {
    if (!canScan) return;
    const t = setTimeout(() => void scan(true), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, protocol, url, auth, apiKey]);

  const applyPreset = (item: ProviderPresetItem | "custom") => {
    setScanned(null);
    setScanError(null);
    setTest(null);
    if (item === "custom") {
      setPresetId("custom");
      setLabel("");
      setProtocol("openai");
      setUrl("");
      setAuth("");
      setPicked([]);
      return;
    }
    setPresetId(item.id);
    setLabel(item.label);
    setProtocol(item.protocol);
    setUrl(item.baseUrl);
    setAuth(item.auth ?? "");
    setPicked(item.recommendedModel ? [item.recommendedModel] : []);
  };

  const save = async () => {
    if (idError) return toast(idError, true);
    if (!HTTP.test(url.trim())) return toast("请填写 http:// 或 https:// 开头的地址", true);
    setSaving(true);
    try {
      const patch: ProviderPatch = { id, label: label.trim(), protocol, baseUrl: url.trim(), auth: auth || null, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
      let models: ModelRef[] | undefined;
      const added = chosen.map((model) => ({ provider: id, model }));
      if (added.length) {
        const keys = new Set(added.map((x) => `${x.provider}:${x.model}`));
        const rest = cfg.models.filter((x) => !keys.has(`${x.provider}:${x.model}`));
        models = (makeMain ? [...added, ...rest] : [...rest, ...added]).slice(0, MAX_MODELS);
      }
      await saveAssistantConfig({ rev: cfg.rev, providers: [patch], ...(models ? { models } : {}) });
      toast(added.length ? `已保存「${label.trim() || id}」，启用了 ${added.length} 个模型，正在测` : "服务商已保存");
      for (const m of added) void testModel(m);
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };

  const removeIt = async () => {
    if (!current) return;
    if (users.length === cfg.models.length) {
      toast("小羊的模型都在用它：先加一个别的模型，再删它", true);
      setAsk(null);
      return;
    }
    setSaving(true);
    try {
      const left = cfg.models.filter((m) => m.provider !== current.id);
      await saveAssistantConfig({ rev: cfg.rev, providers: [{ id: current.id, remove: true }], ...(users.length ? { models: left } : {}) });
      toast(`删掉了「${providerName(current)}」`);
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };

  const resetIt = async () => {
    if (!current) return;
    setSaving(true);
    try {
      await saveAssistantConfig({ rev: cfg.rev, providers: [{ id: current.id, reset: true }] });
      toast(`「${providerName(current)}」恢复成服务器上的设置了`);
      setAsk(null);
      setApiKey("");
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    const target = chosen[0] ?? users[0]?.model;
    if (!target) return;
    setTesting(true);
    setTest(null);
    try {
      setTest(await testDraft(draft(), target));
    } finally {
      setTesting(false);
    }
  };

  const shown = (scanned ?? []).filter((m) => !filter.trim() || m.toLowerCase().includes(filter.trim().toLowerCase()));
  const title = current ? providerName(current) : label.trim() || id;

  return (
    <div
      className="mm-panel pv-editor"
      role="group"
      aria-label={current ? `改服务商：${title}` : "添加服务商"}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {current ? null : (
        <div className="mm-panel-head">
          <strong>添加服务商</strong>
        </div>
      )}

      {current?.from === "server" ? (
        <div className="inline-alert soft">
          <Server size={15} />
          <span>这是服务器自带服务商：可覆盖地址和密钥，也可以一键还原成服务器原始配置。</span>
        </div>
      ) : null}

      {current ? null : (
        <div className="mm-field">
          <div className="mm-field-title">快速选平台（也可以选自定义）</div>
          <div className="mm-chips" role="radiogroup" aria-label="平台预设">
            {PROVIDER_PRESETS.map((item) => (
              <button key={item.id} type="button" role="radio" aria-checked={presetId === item.id} className={`mm-chip${presetId === item.id ? " on" : ""}`} onClick={() => applyPreset(item)}>
                {item.label}
              </button>
            ))}
            <button type="button" role="radio" aria-checked={presetId === "custom"} className={`mm-chip${presetId === "custom" ? " on" : ""}`} onClick={() => applyPreset("custom")}>
              自定义接口
            </button>
          </div>
          <div className="mm-field-hint">自动代号：{id}（可在下方“更多设置”改）</div>
        </div>
      )}

      <div className="pv-grid">
        <div className="mm-field">
          <label className="mm-field-title" htmlFor={`pv-label-${id}`}>
            名字
          </label>
          <PocketInput id={`pv-label-${id}`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={id || "比如 小米 MiMo"} />
          <div className="mm-field-hint">列表里显示的名字，留空用代号</div>
        </div>
        <div className="mm-field">
          <div className="mm-field-title">协议</div>
          <PocketSelect
            value={protocol}
            onValueChange={(v) => setProtocol(v as ModelProtocol)}
            options={(Object.keys(PROTOCOL_LABEL) as ModelProtocol[]).map((p) => ({ value: p, label: PROTOCOL_LABEL[p] }))}
          />
          <div className="mm-field-hint">支持 OpenAI Chat / Responses、Claude、Gemini 原生与 Ollama 本地</div>
        </div>
      </div>

      <div className="mm-field">
        <label className="mm-field-title" htmlFor={`pv-url-${id}`}>
          地址 (Base URL)
        </label>
        <PocketInput id={`pv-url-${id}`} mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder={URL_HINTS[protocol]} spellCheck={false} />
        {urlError ? <div className="mm-field-error">{urlError}</div> : <div className="mm-field-hint">示例：{URL_HINTS[protocol]}</div>}
      </div>

      {keyFree && !current?.key.set ? (
        <div className="mm-field-hint">Ollama 本地默认免密钥，填写地址即可直接扫描模型。</div>
      ) : (
        <div className="mm-field">
          <label className="mm-field-title" htmlFor={`pv-key-${id}`}>
            密钥
          </label>
          <PocketInput
            id={`pv-key-${id}`}
            mono
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={current?.key.set ? `已有密钥 ··${current.key.hint ?? ""}，留空保持不变` : "粘贴 API Key"}
          />
          <div className="mm-field-hint">只能设、不能看；保存后这里只显示最后几位。</div>
        </div>
      )}

      <div>
        <button type="button" className="link-btn" aria-expanded={more} onClick={() => setMore((v) => !v)}>
          {more ? "收起更多设置" : "更多设置（代号与鉴权头）"}
        </button>
        {more ? (
          <div className="pv-grid" style={{ marginTop: 10 }}>
            <div className="mm-field">
              <label className="mm-field-title" htmlFor={`pv-id-${id}`}>
                代号
              </label>
              <PocketInput
                id={`pv-id-${id}`}
                mono
                disabled={Boolean(current)}
                value={current ? current.id : idEdited ? manualId : id}
                onChange={(e) => {
                  setIdEdited(true);
                  setManualId(e.target.value.toLowerCase());
                }}
              />
              {idError ? <div className="mm-field-error">{idError}</div> : <div className="mm-field-hint">{current ? "模型记成 代号:模型名，保存后不可修改" : "默认自动生成；可改为小写字母、数字和短横线"}</div>}
            </div>
            <div className="mm-field">
              <div className="mm-field-title">鉴权头格式</div>
              <PocketSelect
                value={auth}
                onValueChange={(v) => setAuth(v as "" | ModelAuth)}
                options={[
                  { value: "", label: "按协议默认" },
                  { value: "bearer", label: "Bearer" },
                  { value: "x-api-key", label: "x-api-key" },
                  { value: "api-key", label: "api-key" },
                  { value: "x-goog-api-key", label: "x-goog-api-key" },
                  { value: "none", label: "不用密钥" },
                ]}
              />
              <div className="mm-field-hint">按协议自动匹配，特殊网关可手动指定</div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="pv-block">
        <div className="mm-head">
          <div>
            <div className="mm-field-title">选择与扫描模型</div>
            <div className="mm-field-hint">填好地址和密钥会自动拉取上游模型；点选后保存即可使用</div>
          </div>
          <PocketButton size="sm" variant="soft" disabled={!canScan || scanning} onClick={() => void scan(false)}>
            {scanning ? <Loader2 size={13} className="mm-spin" /> : <CloudDownload size={13} />}
            <span>{scanning ? "扫描中" : "扫描模型"}</span>
          </PocketButton>
        </div>
        {scanning && !scanned ? <div className="mm-field-hint">正在自动扫描上游可用模型…</div> : null}
        {scanError ? <div className="mm-field-hint">没扫到模型列表：{modelErrorText(scanError).title}。可以直接在下面手动填模型名。</div> : null}
        {scanned && scanned.length ? (
          <>
            {scanned.length > 8 ? <PocketInput mono value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`搜索模型（共 ${scanned.length} 个）`} aria-label="搜索扫描到的模型" /> : null}
            <div className="mm-pick-list" role="group" aria-label="扫描到的模型">
              {shown.slice(0, SCAN_SHOWN).map((n) => {
                const inUse = usedNames.has(n);
                const on = picked.includes(n);
                return (
                  <button
                    key={n}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    disabled={inUse}
                    className={`mm-pick${on ? " on" : ""}`}
                    onClick={() => setPicked((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]))}
                  >
                    <span className="mm-pick-name">{n}</span>
                    {inUse ? <span className="mm-pick-tag">在用</span> : on ? <CheckCircle2 size={16} /> : null}
                  </button>
                );
              })}
            </div>
            {shown.length > SCAN_SHOWN ? <div className="mm-field-hint">仅显示前 {SCAN_SHOWN} 个，可用上方输入框筛选更多</div> : null}
          </>
        ) : null}
        <div className="mm-field">
          <label className="mm-field-title" htmlFor={`pv-manual-${id}`}>
            手动填写或补充模型名
          </label>
          <PocketInput
            id={`pv-manual-${id}`}
            mono
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder={firstPreset?.recommendedModel ?? "比如 mimo-v2.6-flash"}
            spellCheck={false}
          />
        </div>
        {chosen.length ? (
          <div className="pv-chosen">
            <span className="pv-used">待启用 {chosen.length} 个</span>
            <span className="mm-pick-name grow">{chosen.join("、")}</span>
            <label className="row" style={{ gap: 8, cursor: "pointer" }}>
              <PocketSwitch checked={makeMain} onCheckedChange={setMakeMain} label="保存后设为主模型" />
              <span>保存后设为主模型（第一位使用）</span>
            </label>
          </div>
        ) : null}
        <div className="row wrap" style={{ gap: 8 }}>
          <PocketButton size="sm" variant="soft" disabled={testing || !canScan || !(chosen[0] ?? users[0])} onClick={() => void runTest()}>
            {testing ? <Loader2 size={13} className="mm-spin" /> : <Sparkles size={13} />}
            <span>{testing ? "正在测…" : `测一下${chosen[0] ?? users[0]?.model ? `：${chosen[0] ?? users[0]!.model}` : ""}`}</span>
          </PocketButton>
          {test ? (
            test.ok ? (
              <span className="mm-test good">
                <Zap size={14} />
                <strong>通了{speedLine(test) ? ` · ${speedLine(test)}` : ""}</strong>
              </span>
            ) : (
              <span className="mm-test bad">
                <span className="mm-test-text">
                  <span className="mm-test-title">没通：{modelErrorText(test.error).title}</span>
                  {modelErrorText(test.error).detail ? <span className="mm-test-detail">{modelErrorText(test.error).detail}</span> : null}
                </span>
              </span>
            )
          ) : null}
        </div>
      </div>

      {ask ? (
        <div className="inline-alert" role="alert">
          <span>
            {ask === "remove"
              ? users.length
                ? `删掉「${title}」？正在用它的 ${users.length} 个模型（${users.map((m) => m.model).join("、")}）也会一起去掉。它的地址和密钥都不留。`
                : `删掉「${title}」？它的地址和密钥都不留。`
              : `恢复「${title}」的服务器设置？这会撤销在 App 里对这个服务商的地址和密钥修改，不会影响其他服务商或语音设置。`}
          </span>
        </div>
      ) : null}

      <div className="mm-panel-foot">
        <div className="mm-panel-buttons">
          {current?.from === "phone" ? (
            <PocketButton
              size="sm"
              variant="danger"
              disabled={saving}
              onClick={() => (ask === "remove" ? void removeIt() : setAsk("remove"))}
            >
              <Trash2 size={13} />
              <span>{ask === "remove" ? "确定删掉" : "删掉这个服务商"}</span>
            </PocketButton>
          ) : null}
          {current?.from === "server" && cfg.edited ? (
            <PocketButton size="sm" variant="ghost" disabled={saving} onClick={() => (ask === "reset" ? void resetIt() : setAsk("reset"))}>
              <RotateCcw size={13} />
              <span>{ask === "reset" ? "确定恢复" : "恢复此服务商的服务器设置"}</span>
            </PocketButton>
          ) : null}
        </div>
        <div className="mm-panel-buttons">
          <PocketButton variant="ghost" onClick={() => (ask ? setAsk(null) : onClose())}>
            取消
          </PocketButton>
          <PocketButton variant="primary" disabled={saving || Boolean(idError) || !HTTP.test(url.trim())} onClick={() => void save()}>
            {saving ? <Loader2 size={14} className="mm-spin" /> : <Save size={14} />}
            <span>{chosen.length ? (makeMain ? "保存并设为主模型" : "保存并启用模型") : current ? "保存" : "添加"}</span>
          </PocketButton>
        </div>
      </div>
    </div>
  );
}
