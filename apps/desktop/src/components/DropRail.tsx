import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Folder, Play, X } from "lucide-react";
import { overlayStore } from "../components/PocketUI";
import {
  KIND_TEXT_ZH,
  formatDropBytes,
  kindBadge,
  looksBinary,
  type StagedAttachment,
} from "../lib/dropPreview";

const TEXT_PREVIEW_BYTES = 64 * 1024;

function useOverflowControls(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const sync = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdges({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  }, []);

  useEffect(() => {
    sync();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count, sync]);

  const page = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(180, el.clientWidth * 0.7), behavior: "smooth" });
  };

  return { ref, ...edges, sync, page };
}

function DropLightbox({ item, onClose }: { item: StagedAttachment; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [textState, setTextState] = useState<{ status: "loading" | "ready" | "binary"; text: string }>({
    status: "loading",
    text: "",
  });

  useEffect(() => {
    overlayStore.set((p) => ({ open: p.open + 1 }));
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
      prev?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (item.kind !== "text") return;
    let alive = true;
    setTextState({ status: "loading", text: "" });
    void item.file
      .slice(0, TEXT_PREVIEW_BYTES)
      .text()
      .then((sample) => {
        if (!alive) return;
        if (looksBinary(sample)) setTextState({ status: "binary", text: "" });
        else setTextState({ status: "ready", text: sample });
      })
      .catch(() => {
        if (alive) setTextState({ status: "binary", text: "" });
      });
    return () => {
      alive = false;
    };
  }, [item]);

  const size = formatDropBytes(item.size);
  const stage = (() => {
    if (item.kind === "image" && item.previewUrl) {
      return <img className="hp-drop-stage-img" src={item.previewUrl} alt={item.name} />;
    }
    if (item.kind === "video" && item.previewUrl) {
      return (
        <video className="hp-drop-stage-video" src={item.previewUrl} controls autoPlay playsInline>
          当前浏览器不支持播放这个视频。
        </video>
      );
    }
    if (item.kind === "audio" && item.previewUrl) {
      return (
        <audio className="hp-drop-stage-audio" src={item.previewUrl} controls autoPlay>
          当前浏览器不支持播放这段音频。
        </audio>
      );
    }
    if (item.kind === "pdf" && item.previewUrl) {
      return <iframe className="hp-drop-stage-frame" src={item.previewUrl} title={item.name} />;
    }
    if (item.kind === "text") {
      if (textState.status === "loading") return <div className="hp-drop-stage-empty">正在读取文本…</div>;
      if (textState.status === "binary") return <div className="hp-drop-stage-empty">这个文件包含二进制内容，发送后会直接交给 Agent 读取。</div>;
      return (
        <pre className="hp-drop-stage-text">
          {textState.text}
          {item.size > TEXT_PREVIEW_BYTES ? `\n\n…（预览仅显示前 64 KB，发送后会完整读取）` : ""}
        </pre>
      );
    }
    return <div className="hp-drop-stage-empty">这类文件暂不支持页面内直接预览，发送后会交给 Agent 读取。</div>;
  })();

  return createPortal(
    <div className="hp-drop-lightbox" role="dialog" aria-modal="true" aria-label={item.name}>
      <div className="hp-drop-mask" aria-hidden="true" onMouseDown={onClose} />
      <div className="hp-drop-head">
        <span className="hp-drop-head-name">{item.name}</span>
        {size ? <span className="hp-drop-head-meta num">{size}</span> : null}
        <button ref={closeRef} type="button" className="hp-drop-head-close" aria-label="关闭预览" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="hp-drop-stage">{stage}</div>
    </div>,
    document.body,
  );
}

/**
 * `dsh-drop`-style unified attachment strip shown inside the top of `.composer-card`:
 * images and videos render as 64 px rounded thumbnails, while PDFs, text/code, audio,
 * documents and archives render as 64 px identity cards with folded-corner badges.
 */
export function DropRail({
  items,
  onRemove,
}: {
  items: readonly StagedAttachment[];
  onRemove: (id: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const overflow = useOverflowControls(items.length);
  const previewed = items.find((i) => i.id === openId) ?? null;

  useEffect(() => {
    if (openId && !previewed) setOpenId(null);
  }, [openId, previewed]);

  if (!items.length) return null;

  return (
    <div className="hp-drop-wrap">
      <div
        ref={overflow.ref}
        className="hp-drop-rail"
        role="group"
        aria-label="待发送附件"
        onScroll={overflow.sync}
      >
        {items.map((item) => {
          const isVisual = (item.kind === "image" || item.kind === "video") && Boolean(item.previewUrl);
          const badge = kindBadge(item.name);
          const meta = [KIND_TEXT_ZH[item.kind], formatDropBytes(item.size)].filter(Boolean).join(" · ");
          return (
            <div key={item.id} className="hp-drop-item">
              {isVisual ? (
                <button
                  type="button"
                  className="hp-drop-thumb"
                  title={item.name}
                  aria-label={`预览 ${item.name}`}
                  onClick={() => setOpenId(item.id)}
                >
                  {item.kind === "image" ? (
                    <img src={item.previewUrl} alt={item.name} />
                  ) : (
                    <video src={`${item.previewUrl}#t=0.1`} muted playsInline preload="metadata" />
                  )}
                  {item.kind === "video" ? (
                    <span className="hp-drop-play" aria-hidden="true">
                      <Play size={10} fill="currentColor" />
                    </span>
                  ) : null}
                </button>
              ) : (
                <button
                  type="button"
                  className="hp-drop-doc"
                  title={item.name}
                  aria-label={`预览 ${item.name}`}
                  onClick={() => setOpenId(item.id)}
                >
                  <span className="hp-drop-glyph" aria-hidden="true">
                    {badge ? <span className="hp-drop-badge">{badge}</span> : <Folder size={16} />}
                  </span>
                  <span className="hp-drop-lines">
                    <span className="hp-drop-name">{item.name}</span>
                    <span className="hp-drop-meta num">{meta}</span>
                  </span>
                </button>
              )}
              <button
                type="button"
                className="hp-drop-remove"
                aria-label={`移除 ${item.name}`}
                onClick={() => onRemove(item.id)}
              >
                <X size={10} strokeWidth={2.5} />
              </button>
            </div>
          );
        })}
      </div>
      {overflow.left ? (
        <button type="button" className="hp-drop-arrow left" aria-label="向左滚动" onClick={() => overflow.page(-1)}>
          <ChevronLeft size={14} />
        </button>
      ) : null}
      {overflow.right ? (
        <button type="button" className="hp-drop-arrow right" aria-label="向右滚动" onClick={() => overflow.page(1)}>
          <ChevronRight size={14} />
        </button>
      ) : null}
      {previewed ? <DropLightbox item={previewed} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}
