import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, ChevronLeft, ChevronRight, CornerDownLeft, HelpCircle, PencilLine, Terminal, X } from "lucide-react";
import type { AskQuestionDeckState, DeckChoiceEntry } from "../lib/askQuestion";
import { PocketBadge } from "./PocketUI";

export function AskQuestionDeck({
  deck,
  onSelectKey,
  onSubmitWriteIn,
  onSendRawKey,
  onDismiss,
  onOpenTerminal,
}: {
  deck: AskQuestionDeckState;
  onSelectKey: (key: string) => Promise<void> | void;
  onSubmitWriteIn: (key: string, text: string) => Promise<void> | void;
  onSendRawKey?: (key: string) => Promise<void> | void;
  onDismiss?: () => void;
  onOpenTerminal?: () => void;
}) {
  const [writeInEntry, setWriteInEntry] = useState<DeckChoiceEntry | null>(null);
  const [writeInText, setWriteInText] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setWriteInEntry(null);
    setWriteInText("");
    setBusyKey(null);
  }, [deck.callId, deck.question, deck.currentQuestionIndex, deck.entries.length]);

  useEffect(() => {
    if (writeInEntry) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [writeInEntry]);

  const submitCustom = async () => {
    const val = writeInText.trim();
    if (!writeInEntry || !val || busyKey) return;
    setBusyKey(writeInEntry.key);
    try {
      await onSubmitWriteIn(writeInEntry.key, val);
      setWriteInEntry(null);
      setWriteInText("");
    } finally {
      setBusyKey(null);
    }
  };

  const handleOptionClick = async (entry: DeckChoiceEntry) => {
    if (busyKey) return;
    if (entry.isWriteIn) {
      setWriteInEntry(entry);
      return;
    }
    setBusyKey(entry.key);
    try {
      await onSelectKey(entry.key);
    } finally {
      setBusyKey(null);
    }
  };

  const handleRawKey = async (key: string) => {
    if (!onSendRawKey || busyKey) return;
    setBusyKey(`raw:${key}`);
    try {
      await onSendRawKey(key);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="ask-deck" aria-label="等待选择确认">
      <div className="ask-deck-head">
        <div className="ask-deck-badge-row">
          <span className="ask-deck-pill">
            <HelpCircle size={12} aria-hidden="true" />
            <span>{deck.isSubmitStep ? "确认提交" : "需要你确认"}</span>
          </span>
          {deck.header ? <span className="ask-deck-header-tag">{deck.header}</span> : null}
          {deck.multiSelect ? <span className="ask-deck-header-tag">可多选</span> : null}
          {deck.totalQuestions > 1 && !deck.isSubmitStep ? (
            <span className="ask-deck-counter mono">
              问题 {deck.currentQuestionIndex + 1} / {deck.totalQuestions}
            </span>
          ) : null}
        </div>
        <div className="ask-deck-head-acts">
          {onOpenTerminal ? (
            <button
              type="button"
              className="ask-deck-term-link"
              onClick={onOpenTerminal}
              title="切换到终端视图直接交互"
            >
              <Terminal size={12} />
              <span>切到终端</span>
            </button>
          ) : null}
          {onDismiss ? (
            <button
              type="button"
              className="ask-deck-close"
              onClick={onDismiss}
              aria-label="暂时收起确认卡片"
              title="暂时收起（可随时切到终端操作）"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="ask-deck-question">{deck.question}</div>

      {!deck.terminalMenuSynced && deck.multiSelect ? (
        <div className="ask-deck-sync-hint">
          多选菜单正在同步终端光标；如需勾选多项，请先点右上角「切到终端」或稍候 1 秒待终端菜单就绪。
        </div>
      ) : null}

      <div className="ask-deck-options" role="listbox" aria-multiselectable={deck.multiSelect || undefined} aria-label="可选项">
        {deck.entries.map((entry) => {
          const isEditingWriteIn = writeInEntry?.key === entry.key;
          const isBusy = busyKey === entry.key;
          const isChecked = Boolean(entry.checked);
          const blockUnsyncedMulti = !deck.terminalMenuSynced && deck.multiSelect && !entry.isWriteIn;
          return (
            <button
              key={entry.key}
              type="button"
              role="option"
              aria-selected={deck.multiSelect ? isChecked : entry.selected || isEditingWriteIn}
              disabled={busyKey !== null || blockUnsyncedMulti}
              className={`ask-deck-opt${entry.selected ? " selected" : ""}${isChecked ? " checked" : ""}${entry.recommended ? " recommended" : ""}${isEditingWriteIn ? " editing" : ""}`}
              onClick={() => void handleOptionClick(entry)}
            >
              <span className={`ask-deck-key mono${isChecked ? " is-checked" : ""}`}>
                {deck.multiSelect ? (isChecked ? <Check size={11} /> : entry.key) : entry.key}
              </span>
              <span className="ask-deck-opt-body">
                <span className="ask-deck-opt-top">
                  <span className="ask-deck-opt-title">{entry.title}</span>
                  {entry.recommended ? <PocketBadge tone="pink">推荐</PocketBadge> : null}
                  {entry.isWriteIn ? <PencilLine size={12} className="ask-deck-edit-ic" /> : null}
                </span>
                {entry.description ? (
                  <span className="ask-deck-opt-desc">{entry.description}</span>
                ) : null}
              </span>
              {isBusy ? (
                <span className="act-spin" aria-label="提交中" />
              ) : deck.multiSelect ? (
                <span className="ask-deck-check-hint">{isChecked ? "已选" : "勾选"}</span>
              ) : (
                <ArrowRight size={13} className="ask-deck-arrow" />
              )}
            </button>
          );
        })}
      </div>

      {writeInEntry ? (
        <div className="ask-deck-writein">
          <input
            ref={inputRef}
            type="text"
            className="ask-deck-writein-input"
            value={writeInText}
            onChange={(e) => setWriteInText(e.target.value)}
            placeholder="输入你的自定义回答，按 Enter 直接发往终端…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submitCustom();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setWriteInEntry(null);
              }
            }}
          />
          <button
            type="button"
            className="ask-deck-writein-submit"
            disabled={!writeInText.trim() || busyKey !== null}
            onClick={() => void submitCustom()}
          >
            提交
          </button>
          <button
            type="button"
            className="ask-deck-writein-cancel"
            aria-label="取消自定义输入"
            onClick={() => setWriteInEntry(null)}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}

      {onSendRawKey ? (
        <div className="ask-deck-foot">
          <div className="ask-deck-foot-left">
            {deck.totalQuestions > 1 ? (
              <>
                <button
                  type="button"
                  className="ask-deck-foot-btn"
                  disabled={busyKey !== null}
                  title="切到上一题（发送 ←）"
                  onClick={() => void handleRawKey("left")}
                >
                  <ChevronLeft size={12} />
                  <span>上一题</span>
                </button>
                <button
                  type="button"
                  className="ask-deck-foot-btn"
                  disabled={busyKey !== null}
                  title="切到下一题（发送 →）"
                  onClick={() => void handleRawKey("right")}
                >
                  <span>下一题</span>
                  <ChevronRight size={12} />
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="ask-deck-foot-btn"
              disabled={busyKey !== null}
              title="发送 Esc 取消当前提问"
              onClick={() => void handleRawKey("esc")}
            >
              <span>取消 (Esc)</span>
            </button>
          </div>
          {deck.multiSelect || deck.isSubmitStep ? (
            <button
              type="button"
              className="ask-deck-foot-btn primary"
              disabled={busyKey !== null}
              title="发送 Enter 提交当前选择"
              onClick={() => void handleRawKey("enter")}
            >
              <CornerDownLeft size={12} />
              <span>{deck.isSubmitStep ? "确认提交" : "提交所选 (Enter)"}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
