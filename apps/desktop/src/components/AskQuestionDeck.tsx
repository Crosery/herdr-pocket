import { useEffect, useRef, useState } from "react";
import { ArrowRight, HelpCircle, PencilLine, Terminal, X } from "lucide-react";
import type { AskQuestionDeckState, DeckChoiceEntry } from "../lib/askQuestion";
import { PocketBadge } from "./PocketUI";

export function AskQuestionDeck({
  deck,
  onSelectKey,
  onSubmitWriteIn,
  onOpenTerminal,
}: {
  deck: AskQuestionDeckState;
  onSelectKey: (key: string) => Promise<void> | void;
  onSubmitWriteIn: (key: string, text: string) => Promise<void> | void;
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
  }, [deck.question, deck.entries.length]);

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

  return (
    <section className="ask-deck" aria-label="等待选择确认">
      <div className="ask-deck-head">
        <div className="ask-deck-badge-row">
          <span className="ask-deck-pill">
            <HelpCircle size={12} aria-hidden="true" />
            <span>需要你确认</span>
          </span>
          {deck.header ? <span className="ask-deck-header-tag">{deck.header}</span> : null}
          {deck.totalQuestions > 1 ? (
            <span className="ask-deck-counter mono">
              问题 {deck.currentQuestionIndex + 1} / {deck.totalQuestions}
            </span>
          ) : null}
        </div>
        {onOpenTerminal ? (
          <button
            type="button"
            className="ask-deck-term-link"
            onClick={onOpenTerminal}
            title="切换到终端视图交互"
          >
            <Terminal size={12} />
            <span>切到终端</span>
          </button>
        ) : null}
      </div>

      <div className="ask-deck-question">{deck.question}</div>

      <div className="ask-deck-options" role="listbox" aria-label="可选项">
        {deck.entries.map((entry) => {
          const isEditingWriteIn = writeInEntry?.key === entry.key;
          const isBusy = busyKey === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              role="option"
              aria-selected={entry.selected || isEditingWriteIn}
              disabled={busyKey !== null}
              className={`ask-deck-opt${entry.selected ? " selected" : ""}${entry.recommended ? " recommended" : ""}${isEditingWriteIn ? " editing" : ""}`}
              onClick={() => void handleOptionClick(entry)}
            >
              <span className="ask-deck-key mono">{entry.key}</span>
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
              {isBusy ? <span className="act-spin" aria-label="提交中" /> : <ArrowRight size={13} className="ask-deck-arrow" />}
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
    </section>
  );
}
