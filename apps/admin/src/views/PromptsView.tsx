import { useEffect, useMemo, useRef, useState } from "react";
import { FileCode2, RotateCcw, Save } from "lucide-react";
import { adminApi, fmtAgo, type PromptView } from "../lib/api";
import {
  PocketButton,
  PocketCard,
  PocketConfirmDialog,
  PocketTabs,
  PocketTabsContent,
  PocketTabsList,
  PocketTabsTrigger,
  PocketTextarea,
  useToast,
} from "../components/ui/PocketUI";

export function PromptsView({
  prompts,
  onPromptsUpdated,
}: {
  prompts: PromptView[];
  onPromptsUpdated: (next: PromptView[]) => void;
}) {
  const toast = useToast();
  const [selectedId, setSelectedId] = useState(prompts[0]?.id ?? "base");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const groups = useMemo(() => {
    const map = new Map<string, PromptView[]>();
    for (const p of prompts) {
      const list = map.get(p.group) ?? [];
      list.push(p);
      map.set(p.group, list);
    }
    return [...map.entries()];
  }, [prompts]);

  const current = useMemo(
    () => prompts.find((p) => p.id === selectedId) ?? prompts[0],
    [prompts, selectedId],
  );

  useEffect(() => {
    if (current) setDraft(current.text);
  }, [current?.id, current?.text]);

  if (!current) {
    return (
      <PocketCard>
        <div className="faint">暂无提示词数据</div>
      </PocketCard>
    );
  }

  const dirty = draft !== current.text;

  const insertSlot = (slot: string) => {
    const el = taRef.current;
    if (!el) {
      setDraft((d) => d + slot);
      return;
    }
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + slot + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + slot.length;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const updated = await adminApi.savePrompt(current.id, { text: draft });
      onPromptsUpdated(prompts.map((p) => (p.id === updated.id ? updated : p)));
      toast(`已保存「${current.title}」`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="prompt-layout">
      {/* Grouped Left Index */}
      <PocketCard>
        <div className="pk-card-head" style={{ marginBottom: 10 }}>
          <h3 className="pk-card-title">
            <FileCode2 size={17} style={{ color: "var(--accent-text)" }} />
            <span>提示词目录</span>
          </h3>
          <span className="pk-pill pink num">{prompts.length}</span>
        </div>

        <div className="stack" style={{ gap: 14 }}>
          {groups.map(([groupName, items]) => (
            <div key={groupName} className="stack" style={{ gap: 6 }}>
              <div className="faint" style={{ fontWeight: 800, paddingLeft: 4 }}>
                {groupName}
              </div>
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`prompt-item${item.id === current.id ? " active" : ""}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <div className="between">
                    <span style={{ fontWeight: 800, fontSize: 13.5 }}>{item.title}</span>
                    {item.edited ? <span className="pk-pill pink">已改</span> : null}
                  </div>
                  <span className="faint mono">{item.id}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </PocketCard>

      {/* Studio Right Pane */}
      <PocketCard>
        <div className="stack" style={{ gap: 14 }}>
          <div className="between wrap">
            <div>
              <div className="row" style={{ gap: 8 }}>
                <h3 className="pk-card-title">{current.title}</h3>
                <span className="pk-pill mono">{current.id}</span>
                {current.edited ? <span className="pk-pill pink">已覆盖</span> : null}
              </div>
              <div className="faint" style={{ marginTop: 4 }}>
                {current.about}
                {current.updatedAt ? ` · ${fmtAgo(current.updatedAt)}由 ${current.updatedBy || "控制台"} 修改` : ""}
              </div>
            </div>

            <div className="row">
              <PocketButton
                variant="ghost"
                size="sm"
                disabled={!current.edited}
                onClick={() => setResetOpen(true)}
              >
                <RotateCcw size={14} />
                <span>恢复默认</span>
              </PocketButton>
              <PocketButton variant="primary" size="sm" onClick={save} disabled={saving || !dirty}>
                <Save size={14} />
                <span>{saving ? "保存中…" : dirty ? "保存修改" : "已同步"}</span>
              </PocketButton>
            </div>
          </div>

          {current.slots.length ? (
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="faint">点击插入变量：</span>
              {current.slots.map((sl) => (
                <button
                  key={sl.slot}
                  type="button"
                  className="slot-chip"
                  title={sl.means}
                  onClick={() => insertSlot(sl.slot)}
                >
                  {sl.slot} · {sl.means}
                </button>
              ))}
            </div>
          ) : null}

          <PocketTabs defaultValue="edit">
            <div className="between wrap" style={{ marginBottom: 10 }}>
              <PocketTabsList>
                <PocketTabsTrigger value="edit">编辑当前文本</PocketTabsTrigger>
                <PocketTabsTrigger value="default">系统内置全文</PocketTabsTrigger>
              </PocketTabsList>
              <span className="faint num">{draft.length} 字符</span>
            </div>

            <PocketTabsContent value="edit">
              <PocketTextarea
                ref={taRef}
                mono
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                style={{ minHeight: 340 }}
              />
            </PocketTabsContent>

            <PocketTabsContent value="default">
              <pre
                className="mono"
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  padding: 14,
                  borderRadius: 16,
                  background: "var(--surface-2)",
                  border: "1px solid var(--divider)",
                  fontSize: 12.5,
                  lineHeight: 1.65,
                  maxHeight: 420,
                  overflowY: "auto",
                }}
              >
                {current.defaultText}
              </pre>
            </PocketTabsContent>
          </PocketTabs>
        </div>
      </PocketCard>

      <PocketConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={`恢复「${current.title}」的默认提示词？`}
        description="会清除自定义内容并立即切换回随服务发行的内置提示词。"
        confirmLabel="恢复默认"
        onConfirm={async () => {
          const updated = await adminApi.savePrompt(current.id, { reset: true });
          onPromptsUpdated(prompts.map((p) => (p.id === updated.id ? updated : p)));
          toast("已恢复系统默认提示词");
        }}
      />
    </div>
  );
}
