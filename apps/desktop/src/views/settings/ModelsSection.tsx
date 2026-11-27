import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, Check, CheckCircle2, Gauge, Loader2, Plus, Search, Star, X, Zap } from "lucide-react";
import type { AssistantConfigView, ModelRef, ProviderView } from "@herdr-pocket/protocol";
import { ModelBrandIcon } from "../../components/ModelBrandIcon";
import { PocketBadge, PocketButton, PocketCheckbox, PocketInput, useToast } from "../../components/PocketUI";
import { fetchAssistantProviderModels, saveAssistantConfig } from "../../lib/assistant";
import { modelErrorText } from "../../lib/modelErrors";
import { answered, keyState, MAX_MODELS, modelKey, PROTOCOL_LABEL, providerName, speedLine, testModel, useModelTests, type ModelTest } from "./modelTests";
import "../../styles/models.css";

/**
 * 正在用: the models the assistant tries in order (the first is the main one, the rest
 * step in when one fails or stays silent). Same structure and wording as the mobile
 * app's model screen: a numbered rail, one visible action per row ("设为主"), reorder
 * and remove in "调整顺序" with an undo, click a row to test it. Changes save at once.
 */
export function ModelsSection({ cfg }: { cfg: AssistantConfigView }) {
  const toast = useToast();
  const tests = useModelTests();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  /** A fresh add panel each time it opens. */
  const [addKey, setAddKey] = useState(0);
  const [notice, setNotice] = useState<{ id: number; text: string; undo?: ModelRef[] } | null>(null);
  const [round, setRound] = useState<{ at: number; total: number } | null>(null);
  const running = useRef<{ stop: boolean } | null>(null);

  useEffect(
    () => () => {
      if (running.current) running.current.stop = true;
    },
    [],
  );

  // An undo stays offered for a few seconds, like the phone's snackbar.
  useEffect(() => {
    if (!notice) return;
    const id = notice.id;
    const t = setTimeout(() => setNotice((n) => (n?.id === id ? null : n)), notice.undo ? 7000 : 3500);
    return () => clearTimeout(t);
  }, [notice]);

  const models = cfg.models;
  const providers = new Map(cfg.providers.map((x) => [x.id, x]));
  const full = models.length >= MAX_MODELS;
  const say = (text: string, undo?: ModelRef[]) => setNotice({ id: Date.now() + Math.random(), text, undo });

  async function save(next: ModelRef[], said: string, undo?: ModelRef[]) {
    setBusy(true);
    try {
      await saveAssistantConfig({ rev: cfg.rev, models: next });
      say(said, undo);
    } catch (e) {
      toast((e as Error).message, true);
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

  /** One after another, each result showing as it comes; clicking again stops after the current one. */
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
  type Timed = { m: ModelRef; i: number; t: ModelTest & { ok: boolean; firstMs?: number } };
  const timed = models
    .map((m, i) => ({ m, i, t: tests[modelKey(m)] }))
    .filter((x): x is Timed => answered(x.t) && x.t.ok && x.t.firstMs != null);
  const best = timed.length ? timed.reduce((a, b) => (b.t.firstMs! < a.t.firstMs! ? b : a)) : null;
  const fastest = timed.length >= 2 ? best : null;
  const mainTest = models[0] ? tests[modelKey(models[0])] : undefined;
  const mainDone = answered(mainTest) ? mainTest : null;
  // Worth saying when another one starts faster than the main model, or answered where the main one did not.
  const suggest = !round && !editing && best && best.i !== 0 && mainDone && (mainDone.ok ? !!fastest : true) ? best : null;

  return (
    <section className="mm-section" aria-labelledby="mm-using">
      {cfg.warnings.length ? (
        <div className="inline-alert" role="status">
          <AlertCircle size={15} />
          <span>{cfg.warnings.join("；")}</span>
        </div>
      ) : null}

      <div className="mm-head">
        <div className="row" style={{ gap: 8, minWidth: 0, flexWrap: "wrap" }}>
          <h3 id="mm-using" className="mm-head-title">
            正在用 · {models.length} / {MAX_MODELS}
          </h3>
          <span className="mm-note small">
            {editing ? "上下调整顺延顺序，第 1 个为主模型" : "第 1 个为主模型，出错或沉默时按序顺延"}
          </span>
        </div>
        <div className="mm-head-actions">
          {editing ? null : (
            <PocketButton
              size="sm"
              variant="soft"
              disabled={busy || !models.length}
              onClick={() => void testAll()}
              aria-label={round ? `正在测第 ${round.at} 个，共 ${round.total} 个，点一下停下` : "全部测一遍速度"}
            >
              {round ? <Loader2 size={13} className="mm-spin" /> : <Gauge size={13} />}
              <span>{round ? `${round.at}/${round.total} · 停下` : "全部测速"}</span>
            </PocketButton>
          )}
          {models.length > 1 ? (
            <PocketButton
              size="sm"
              variant={editing ? "primary" : "ghost"}
              onClick={() => {
                setEditing((v) => !v);
                setAdding(false);
              }}
              aria-label={editing ? "完成调整" : "调整顺序或去掉模型"}
            >
              {editing ? <Check size={13} /> : <ArrowUpDown size={13} />}
              <span>{editing ? "完成" : "调整顺序"}</span>
            </PocketButton>
          ) : null}
          {!editing ? (
            <PocketButton
              size="sm"
              variant="primary"
              disabled={full}
              onClick={() => {
                if (adding) {
                  setAdding(false);
                } else {
                  setAddKey((n) => n + 1);
                  setAdding(true);
                }
              }}
            >
              <Plus size={13} />
              <span>{adding ? "收起添加" : "添加模型"}</span>
            </PocketButton>
          ) : null}
        </div>
      </div>

      <div className="xy-model-card">
        {models.length >= 4 && !editing ? (
          <div className="model-pop-search">
            <Search size={13} className="model-pop-search-ic" />
            <input
              type="text"
              className="model-pop-input mono"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="筛选已配置模型或服务商…"
              aria-label="筛选已配置模型"
            />
            <span className="faint" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
              点延迟徽标单测
            </span>
          </div>
        ) : null}
        {models.length ? (
          <ol className="xy-model-list">
            {models
              .map((m, i) => ({ m, i, provider: providers.get(m.provider) }))
              .filter(({ m, provider }) => {
                const q = filterQuery.trim().toLowerCase();
                if (!q) return true;
                return (
                  m.model.toLowerCase().includes(q) ||
                  m.provider.toLowerCase().includes(q) ||
                  (provider ? providerName(provider).toLowerCase().includes(q) : false)
                );
              })
              .map(({ m, i, provider }) => (
                <ModelRow
                  key={modelKey(m)}
                  m={m}
                  i={i}
                  count={models.length}
                  provider={provider}
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
              ))}
          </ol>
        ) : (
          <div className="mm-empty">
            <strong>还没有模型，小羊没法回话</strong>
            <span>先加一个服务商，再从它那里挑模型。</span>
          </div>
        )}
        {!editing && adding ? (
          <AddModelPanel
            key={addKey}
            cfg={cfg}
            onClose={() => setAdding(false)}
            onAdded={(m, asMain) => {
              setAdding(false);
              say(asMain ? `${m.model} 现在是主模型，正在测它` : `加好了：${m.model}，正在测它`);
              void testModel(m);
            }}
          />
        ) : null}
      </div>

      {notice ? (
        <div className="mm-notice" role="status">
          <CheckCircle2 size={15} />
          <span className="grow">{notice.text}</span>
          {notice.undo ? (
            <button
              type="button"
              className="mm-notice-undo"
              disabled={busy}
              onClick={() => {
                const prev = notice.undo!;
                setNotice(null);
                void save(prev, "撤销了");
              }}
            >
              撤销
            </button>
          ) : null}
          <button type="button" className="mm-notice-x" aria-label="关掉提示" onClick={() => setNotice(null)}>
            <X size={14} />
          </button>
        </div>
      ) : null}

      {suggest ? (
        <div className="mm-suggest">
          <div className="mm-suggest-text">
            <Zap size={18} />
            <span>
              {mainDone?.ok && mainDone.firstMs != null
                ? `「${suggest.m.model}」开口最快，首字 ${(suggest.t.firstMs! / 1000).toFixed(1)} 秒；主模型要 ${(mainDone.firstMs / 1000).toFixed(1)} 秒。`
                : `主模型这次没通，「${suggest.m.model}」通了，首字 ${(suggest.t.firstMs! / 1000).toFixed(1)} 秒。`}
            </span>
          </div>
          <PocketButton variant="primary" disabled={busy} onClick={() => makeMain(suggest.i)}>
            <Star size={14} />
            <span>设为主模型</span>
          </PocketButton>
        </div>
      ) : null}
    </section>
  );
}

/** Compact Agent-style model row: order chip + brand icon + mono name + provider pill + speed pill + action. */
function ModelRow({
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
  const isMain = i === 0;
  const from = provider ? `${providerName(provider)} · ${PROTOCOL_LABEL[provider.protocol]}` : `${m.provider} 不在了`;
  const failedTitle = test && !test.running && !test.ok ? modelErrorText(test.error).title : null;
  const msVal = test && !test.running && test.ok ? (test.firstMs ?? test.totalMs ?? null) : null;
  const speedClass =
    test?.running
      ? ""
      : failedTitle
        ? "bad"
        : msVal != null
          ? msVal < 1000
            ? "good"
            : "warn"
          : "idle";

  return (
    <li className="xy-model-li">
      <div
        className={`xy-model-row${isMain ? " current" : ""}${!editing && !isMain ? " can-promote" : ""}`}
        onClick={() => {
          if (!editing && !isMain && !busy) onMakeMain();
        }}
      >
        <span className="xy-order-chip" aria-label={isMain ? "主模型" : `第 ${i + 1} 备用`}>
          {isMain ? "主" : i + 1}
        </span>
        <ModelBrandIcon model={m.model} provider={provider ? providerName(provider) : m.provider} size={15} />
        <span className="xy-model-name" title={m.model}>
          {m.model}
        </span>
        <span className="xy-model-meta">
          <span className={`model-pop-badge${provider ? "" : " gone"}`}>{from}</span>
          {fastest ? <PocketBadge tone="mint">最快</PocketBadge> : null}
          {editing ? (
            <>
              <button type="button" className="mm-icon-btn" aria-label={`${m.model} 上移`} disabled={busy || i === 0} onClick={(e) => (e.stopPropagation(), onUp())}>
                <ArrowUp size={13} />
              </button>
              <button type="button" className="mm-icon-btn" aria-label={`${m.model} 下移`} disabled={busy || i === count - 1} onClick={(e) => (e.stopPropagation(), onDown())}>
                <ArrowDown size={13} />
              </button>
              <button type="button" className="mm-icon-btn danger" aria-label={`去掉 ${m.model}`} disabled={busy || count === 1} onClick={(e) => (e.stopPropagation(), onRemove())}>
                <X size={13} />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`xy-speed-pill ${speedClass}`}
                disabled={test?.running}
                aria-label={`测速 ${m.model}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onTest();
                }}
              >
                {test?.running ? (
                  <>
                    <Loader2 size={11} className="mm-spin" />
                    <span>测速中</span>
                  </>
                ) : failedTitle ? (
                  <>
                    <AlertCircle size={11} />
                    <span className="truncate" style={{ maxWidth: 86 }}>{failedTitle}</span>
                  </>
                ) : msVal != null ? (
                  <>
                    {msVal <= 650 ? <Zap size={11} /> : null}
                    <span>{(msVal / 1000).toFixed(2)}s</span>
                  </>
                ) : (
                  <>
                    <Gauge size={11} />
                    <span>测速</span>
                  </>
                )}
              </button>
              {isMain ? (
                <span className="xy-main-pill">
                  <span>主模型</span>
                  <Check size={12} />
                </span>
              ) : (
                <button
                  type="button"
                  className="xy-set-main-btn"
                  disabled={busy}
                  aria-label={`把 ${m.model} 设为主模型`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMakeMain();
                  }}
                >
                  设为主
                </button>
              )}
            </>
          )}
        </span>
      </div>
      {failedTitle && test && !test.running && !test.ok && modelErrorText(test.error).detail ? (
        <div className="xy-model-err">{modelErrorText(test.error).detail}</div>
      ) : null}
    </li>
  );
}

/** The last test: first word prominently, then the whole answer; or, in plain words, why it failed. */
export function TestLine({ test }: { test: ModelTest | undefined }) {
  if (!test) return <span className="mm-test idle">点一下测测速度</span>;
  if (test.running) {
    return (
      <span className="mm-test running">
        <Loader2 size={12} className="mm-spin" />
        <span>正在测…</span>
      </span>
    );
  }
  if (!test.ok) {
    const e = modelErrorText(test.error);
    return (
      <span className="mm-test bad">
        <AlertCircle size={14} />
        <span className="mm-test-text">
          <span className="mm-test-title">没通：{e.title}</span>
          {e.detail ? <span className="mm-test-detail">{e.detail}</span> : null}
        </span>
      </span>
    );
  }
  const [first, ...rest] = speedLine(test).split(" · ");
  return (
    <span className="mm-test good">
      <Zap size={14} />
      <strong>{first || "通了"}</strong>
      {rest.length ? <span className="mm-test-rest"> · {rest.join(" · ")}</span> : null}
    </span>
  );
}

/**
 * 添加模型, inline under the list (no dialog): pick a provider, type a model name or check
 * one it lists, say whether it is a fallback (goes last) or the new main model.
 */
function AddModelPanel({ cfg, onClose, onAdded }: { cfg: AssistantConfigView; onClose: () => void; onAdded: (m: ModelRef, asMain: boolean) => void }) {
  const [provider, setProvider] = useState<string | null>(cfg.models[0]?.provider ?? cfg.providers[0]?.id ?? null);
  const [model, setModel] = useState("");
  const [place, setPlace] = useState<"fallback" | "main">(cfg.models.length ? "fallback" : "main");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<{ of: string; names: string[] | null; error: string | null } | null>(null);

  // What the provider lists; many list nothing, or refuse, and then the person types the name.
  useEffect(() => {
    if (!provider) return;
    let live = true;
    setList({ of: provider, names: null, error: null });
    fetchAssistantProviderModels(provider)
      .then((names) => {
        if (live) setList({ of: provider, names, error: null });
      })
      .catch((e: unknown) => {
        if (live) setList({ of: provider, names: [], error: (e as Error).message });
      });
    return () => {
      live = false;
    };
  }, [provider]);

  const name = model.trim();
  const used = new Set(cfg.models.map(modelKey));
  const taken = !!provider && !!name && used.has(modelKey({ provider, model: name }));
  const names = list && list.of === provider ? list.names : null;
  const matches = names ? names.filter((n) => !name || n.toLowerCase().includes(name.toLowerCase())) : [];
  const position = cfg.models.length + 1;
  const asMain = place === "main";
  const chosen = cfg.providers.find((x) => x.id === provider);
  const keyMissing = !!chosen && !keyState(chosen).ok;
  const canAdd = !!provider && !!name && !taken && !busy && cfg.models.length < MAX_MODELS;

  async function add() {
    if (!canAdd || !provider) return;
    setBusy(true);
    setError(null);
    try {
      const ref = { provider, model: name };
      await saveAssistantConfig({ rev: cfg.rev, models: asMain ? [ref, ...cfg.models] : [...cfg.models, ref] });
      onAdded(ref, asMain);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mm-panel"
      role="group"
      aria-label="添加模型"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="mm-panel-head">
        <strong>添加模型</strong>
        <button type="button" className="mm-icon-btn" aria-label="收起添加模型" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      <div className="mm-field">
        <div className="mm-field-title">服务商</div>
        {cfg.providers.length ? (
          <div className="mm-chips" role="radiogroup" aria-label="服务商">
            {cfg.providers.map((x) => {
              const k = keyState(x);
              const on = provider === x.id;
              return (
                <button
                  key={x.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={`mm-chip${on ? " on" : ""}`}
                  title={`${PROTOCOL_LABEL[x.protocol]}，${k.ok ? k.text : "还没有密钥"}`}
                  onClick={() => setProvider(x.id)}
                >
                  <span className={`mm-dot${k.ok ? " ok" : " bad"}`} aria-hidden="true" />
                  <span>{providerName(x)}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mm-field-hint">还没有服务商，先在下面“服务商”里加一个。</div>
        )}
        {keyMissing ? <div className="mm-field-error">这个服务商还没有密钥，模型会测不通。先到服务商里设一下密钥。</div> : null}
      </div>

      <div className="mm-field">
        <label className="mm-field-title" htmlFor="mm-add-name">
          模型名
        </label>
        <PocketInput
          id="mm-add-name"
          mono
          autoFocus
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder="输入几个字，也会筛下面的列表"
          autoCapitalize="none"
          spellCheck={false}
        />
        {taken ? <div className="mm-field-error">这个模型已经在列表里了</div> : <div className="mm-field-hint">照服务商那里的写法填，或者在下面点一个</div>}
      </div>

      <div className="mm-field">
        <div className="mm-field-title">放在哪</div>
        <div className="segmented mm-place" role="radiogroup" aria-label="放在哪">
          <button type="button" role="radio" aria-checked={!asMain} className={!asMain ? "active" : ""} onClick={() => setPlace("fallback")}>
            当备用（第 {position} 个）
          </button>
          <button type="button" role="radio" aria-checked={asMain} className={asMain ? "active" : ""} onClick={() => setPlace("main")}>
            设为主模型
          </button>
        </div>
      </div>

      {provider ? (
        <div className="mm-field">
          <div className="mm-field-title">{names?.length ? `它列出的模型（${names.length} 个）` : "它列出的模型"}</div>
          {!names ? (
            <div className="mm-field-hint row" style={{ gap: 6 }}>
              <Loader2 size={13} className="mm-spin" />
              <span>正在问它有哪些模型…</span>
            </div>
          ) : list?.error ? (
            <div className="mm-field-hint">没问到（{modelErrorText(list.error).title}）。直接在上面填名字就行。</div>
          ) : !names.length ? (
            <div className="mm-field-hint">它没有列出模型，直接在上面填名字就行。</div>
          ) : !matches.length ? (
            <div className="mm-field-hint">列表里没有名字里带“{name}”的，照你填的加也行。</div>
          ) : (
            <div className="mm-pick-list xy-scan-list" role="radiogroup" aria-label="它列出的模型">
              {matches.map((n) => {
                const inUse = used.has(modelKey({ provider, model: n }));
                const on = name === n;
                return (
                  <div
                    key={n}
                    className={`mm-pick xy-scan-row${on ? " on" : ""}${inUse ? " in-use" : ""}`}
                    onClick={() => {
                      if (!inUse) setModel(n);
                    }}
                  >
                    <PocketCheckbox
                      checked={inUse || on}
                      disabled={inUse}
                      ariaLabel={inUse ? `${n} 已在使用中` : `选择模型 ${n}`}
                      onCheckedChange={() => {
                        if (!inUse) setModel(n);
                      }}
                    />
                    <ModelBrandIcon model={n} provider={provider} size={14} />
                    <span className="mm-pick-name">{n}</span>
                    {inUse ? <span className="mm-pick-tag">在用</span> : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {error ? <div className="inline-alert">{error}</div> : null}

      <div className="mm-panel-foot">
        <span className="mm-field-hint">{asMain ? "保存后马上成为小羊的主模型，原来的主模型排到第 2 个" : `排在第 ${position} 个，前面的都不通时才用它`}</span>
        <div className="mm-panel-buttons">
          <PocketButton variant="ghost" onClick={onClose}>
            取消
          </PocketButton>
          <PocketButton variant="primary" disabled={!canAdd} onClick={() => void add()}>
            {busy ? <Loader2 size={14} className="mm-spin" /> : <Gauge size={14} />}
            <span>添加并测速</span>
          </PocketButton>
        </div>
      </div>
    </div>
  );
}
