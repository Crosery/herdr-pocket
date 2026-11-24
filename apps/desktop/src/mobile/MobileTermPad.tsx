import { useEffect, useRef, useState } from "react";
import { ChevronDown, CornerDownLeft, Delete, Keyboard } from "lucide-react";
import { PAD_PAGES, PAD_SNIPPETS, padChar, padSpecial, type PadKey } from "./termpad";

function sendTermBytes(data: string): void {
  window.dispatchEvent(new CustomEvent("pocket:voice-term-input", { detail: { text: data, noFocus: true } }));
}

export function MobileTermPad({
  onClose,
}: {
  onClose: () => void;
}) {
  const [page, setPage] = useState<"letters" | "symbols">("letters");
  const [shift, setShift] = useState<"off" | "once" | "lock">("off");
  const [ctrl, setCtrl] = useState(false);
  const repeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopRepeat = () => {
    if (repeatRef.current) {
      clearInterval(repeatRef.current);
      repeatRef.current = null;
    }
  };

  useEffect(() => stopRepeat, []);

  const hit = (k: PadKey) => {
    if (k.kind === "shift") {
      setShift((s) => (s === "off" ? "once" : s === "once" ? "lock" : "off"));
      return;
    }
    if (k.kind === "ctrl") {
      setCtrl((v) => !v);
      return;
    }
    if (k.kind === "page") {
      setPage((x) => (x === "letters" ? "symbols" : "letters"));
      return;
    }
    const mods = { ctrl, shift: shift !== "off" };
    sendTermBytes(k.kind === "char" ? padChar(k.ch, mods) : padSpecial(k.key, mods));
    setCtrl(false);
    if (shift === "once") setShift("off");
  };

  const rows = PAD_PAGES[page];

  return (
    <div className="mp-termpad" role="region" aria-label="终端快捷键盘">
      <div className="mp-termpad-bar">
        <div className="mp-termpad-snippets">
          {PAD_SNIPPETS.map((snippet) => (
            <button
              key={snippet}
              type="button"
              className="mp-snippet-pill"
              onClick={() => sendTermBytes(snippet)}
            >
              {snippet}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="mp-snippet-pill"
          style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          onClick={() => {
            onClose();
            window.dispatchEvent(new CustomEvent("pocket:focus-terminal"));
          }}
          title="切回系统中文输入法"
        >
          <Keyboard size={13} />
          <span>中文键盘</span>
        </button>
        <button
          type="button"
          className="mp-snippet-pill"
          aria-label="收起终端键盘"
          onClick={onClose}
        >
          <ChevronDown size={14} />
        </button>
      </div>

      {rows.map((row, rowIdx) => (
        <div key={rowIdx} className="mp-termpad-row">
          {row.map((k, keyIdx) => {
            const flex = k.w ?? 1;
            const active =
              (k.kind === "shift" && shift !== "off") ||
              (k.kind === "ctrl" && ctrl) ||
              (k.kind === "page" && page === "symbols");
            const label =
              k.kind === "shift"
                ? shift === "lock"
                  ? "CAPS"
                  : "Shift"
                : k.kind === "ctrl"
                  ? "Ctrl"
                  : k.kind === "page"
                    ? page === "letters"
                      ? "#+="
                      : "abc"
                    : k.kind === "char"
                      ? k.ch === " "
                        ? "空格"
                        : shift !== "off"
                          ? k.ch.toUpperCase()
                          : k.ch
                      : k.label;
            const repeat = k.kind === "special" && k.repeat;

            return (
              <button
                key={`${rowIdx}-${keyIdx}`}
                type="button"
                className={`mp-termkey${active ? " on" : ""}`}
                style={{ flex }}
                aria-label={k.kind === "special" ? k.a11y : label}
                onPointerDown={(e) => {
                  e.preventDefault();
                  stopRepeat();
                  if (repeat) {
                    repeatRef.current = setInterval(() => hit(k), 75);
                  }
                }}
                onPointerUp={stopRepeat}
                onPointerCancel={stopRepeat}
                onPointerLeave={stopRepeat}
                onClick={(e) => {
                  e.preventDefault();
                  hit(k);
                }}
              >
                {k.kind === "special" && k.key === "backspace" ? (
                  <Delete size={15} />
                ) : k.kind === "special" && k.key === "enter" ? (
                  <CornerDownLeft size={15} />
                ) : (
                  <span className="mono">{label}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
