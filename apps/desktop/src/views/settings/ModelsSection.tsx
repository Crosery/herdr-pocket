import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, Check, CheckCircle2, Gauge, Loader2, Plus, Star, X, Zap } from "lucide-react";
import type { AssistantConfigView, ModelRef, ProviderView } from "@herdr-pocket/protocol";
import { PocketBadge, PocketButton, PocketInput, useToast } from "../../components/PocketUI";
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
        <h3 id="mm-using" className="mm-head-title">
          正在用
        </h3>
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
        </div>
      </div>
      <p className="mm-note">
        {editing
          ? "用上下箭头排顺序，排第一的就是主模型；去掉后几秒内可以撤销。"
          : "小羊从上往下用：第 1 个是主模型，它出错或一直不说话时换下一个。点一个模型，测测它多快开口。"}
      </p>

      <div className="mm-card">
        {models.length ? (
          <ol className="mm-list">
            {models.map((m, i) => (
              <ModelRow
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
            ))}
          </ol>
        ) : (
          <div className="mm-empty">
            <strong>还没有模型，小羊没法回话</strong>
            <span>先加一个服务商，再从它那里挑模型。</span>
          </div>
        )}
        {editing ? null : adding ? (
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
        ) : (
          <button
            type="button"
            className="mm-add-row"
            disabled={full}
            onClick={() => {
              setAddKey((n) => n + 1);
              setAdding(true);
            }}
          >
            <span className="mm-add-icon">
              <Plus size={17} />
            </span>
            <span className="mm-add-text">
              <span className="mm-add-title">添加模型</span>
              <span className="mm-add-sub">{full ? `最多 ${MAX_MODELS} 个，先去掉一个` : "从服务商那里挑一个，可以当备用或直接设为主模型"}</span>
            </span>
          </button>
        )}
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

/** The order badge: a pink "主" for the main model, a soft number for each fallback, joined by a thin rail. */
function OrderBadge({ i, count }: { i: number; count: number }) {
  return (
    <span className="mm-rail" aria-hidden="true">
      <span className={`mm-rail-line${i ? "" : " none"}`} />
      <span className={`mm-badge${i === 0 ? " main" : ""}`}>{i === 0 ? "主" : i + 1}</span>
      <span className={`mm-rail-line${i < count - 1 ? "" : " none"}`} />
    </span>
  );
}

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
  // The badge carries the place in the order; the words only say main or fallback, so there is one numbering.
  const role = i === 0 ? "主模型" : "备用";
  const from = provider ? `${providerName(provider)} · ${PROTOCOL_LABEL[provider.protocol]}` : `服务商 ${m.provider} 不在了`;
  return (
    <li className={`mm-row${i === 0 ? " main" : ""}`}>
      <OrderBadge i={i} count={count} />
      <button type="button" className="mm-row-main" onClick={onTest} disabled={test?.running} title="点一下测速度">
        <span className="mm-sr">第 {i + 1} 个，</span>
        <span className="mm-title">
          <span className="mm-name">{m.model}</span>
          {fastest ? <PocketBadge tone="mint">最快</PocketBadge> : null}
        </span>
        <span className={`mm-sub${provider ? "" : " gone"}`}>
          {role} · {from}
        </span>
        <TestLine test={test} />
      </button>
      <div className="mm-actions">
        {editing ? (
          <>
            <button type="button" className="mm-icon-btn" aria-label={`${m.model} 上移`} disabled={busy || i === 0} onClick={onUp}>
              <ArrowUp size={15} />
            </button>
            <button type="button" className="mm-icon-btn" aria-label={`${m.model} 下移`} disabled={busy || i === count - 1} onClick={onDown}>
              <ArrowDown size={15} />
            </button>
            <button type="button" className="mm-icon-btn danger" aria-label={`去掉 ${m.model}`} disabled={busy || count === 1} onClick={onRemove}>
              <X size={15} />
            </button>
          </>
        ) : i > 0 ? (
          <PocketButton size="sm" variant="soft" disabled={busy} onClick={onMakeMain} aria-label={`把 ${m.model} 设为主模型`}>
            设为主
          </PocketButton>
        ) : null}
      </div>
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

const SHOWN = 30;

/**
 * 添加模型, inline under the list (no dialog): pick a provider, type a model name or click
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
            <div className="mm-pick-list" role="radiogroup" aria-label="它列出的模型">
              {matches.slice(0, SHOWN).map((n) => {
                const inUse = used.has(modelKey({ provider, model: n }));
                const on = name === n;
                return (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={inUse}
                    className={`mm-pick${on ? " on" : ""}`}
                    onClick={() => setModel(n)}
                  >
                    <span className="mm-pick-name">{n}</span>
                    {inUse ? <span className="mm-pick-tag">在用</span> : on ? <CheckCircle2 size={16} /> : null}
                  </button>
                );
              })}
            </div>
          )}
          {matches.length > SHOWN ? <div className="mm-field-hint">还有 {matches.length - SHOWN} 个，在上面输入几个字筛一下</div> : null}
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
