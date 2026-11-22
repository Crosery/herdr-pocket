import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileSpreadsheet,
  FileText,
  Grid,
  Presentation,
  Search,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  DocBlock,
  DocPreviewData,
  DocRun,
  SlidePreviewData,
  TablePreviewData,
} from "../lib/filePreview";
import { copyToClipboard, openExternalUrl } from "../lib/bridge";
import { PocketButton, PocketInput, useToast } from "./PocketUI";
import "../styles/file-preview.css";

const ROW_HEIGHT = 31;
const OVERSCAN = 10;

function estimateColWidth(colName: string, rows: string[][], colIdx: number): number {
  let maxChars = colName.length;
  const sampleLimit = Math.min(rows.length, 60);
  for (let r = 0; r < sampleLimit; r += 1) {
    const val = rows[r]?.[colIdx];
    if (val && val.length > maxChars) maxChars = Math.min(val.length, 38);
  }
  return Math.max(96, Math.min(260, Math.round(maxChars * 8.5 + 26)));
}

/** High-speed virtualized spreadsheet / CSV / TSV / JSONL grid with search, sort & cell copy. */
export function PocketDataGrid({
  data,
  actions,
}: {
  data: TablePreviewData;
  actions?: ReactNode;
}) {
  const toast = useToast();
  const [sheetIdx, setSheetIdx] = useState(0);
  const [query, setQuery] = useState("");
  const [sortState, setSortState] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number; text: string } | null>(null);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(480);

  const safeIdx = sheetIdx < data.sheets.length ? sheetIdx : 0;
  const sheet = data.sheets[safeIdx] ?? { name: "Sheet1", columns: ["列 1"], rows: [] };

  useEffect(() => {
    setSheetIdx(0);
    setQuery("");
    setSortState(null);
    setSelectedCell(null);
    setScrollTop(0);
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [data]);

  useEffect(() => {
    setSortState(null);
    setSelectedCell(null);
    setScrollTop(0);
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [safeIdx]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => {
      if (el.clientHeight > 0) setViewHeight(el.clientHeight);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const colWidths = useMemo(
    () => sheet.columns.map((c, ci) => estimateColWidth(c, sheet.rows, ci)),
    [sheet.columns, sheet.rows],
  );
  const totalWidth = useMemo(
    () => 52 + colWidths.reduce((a, w) => a + w, 0),
    [colWidths],
  );

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = !q
      ? sheet.rows
      : sheet.rows.filter((r) => r.some((cell) => cell.toLowerCase().includes(q)));
    if (!sortState) return base;
    const { col, dir } = sortState;
    const mult = dir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => {
      const av = a[col] ?? "";
      const bv = b[col] ?? "";
      if (av === bv) return 0;
      if (av === "") return 1;
      if (bv === "") return -1;
      const an = Number(av);
      const bn = Number(bv);
      if (Number.isFinite(an) && Number.isFinite(bn)) return (an - bn) * mult;
      return av.localeCompare(bv, "zh-CN", { numeric: true, sensitivity: "base" }) * mult;
    });
  }, [query, sheet.rows, sortState]);

  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const endIdx = Math.min(filteredRows.length, startIdx + visibleCount);
  const topPad = startIdx * ROW_HEIGHT;
  const botPad = Math.max(0, (filteredRows.length - endIdx) * ROW_HEIGHT);

  const toggleSort = (ci: number) => {
    setSortState((prev) => {
      if (!prev || prev.col !== ci) return { col: ci, dir: "asc" };
      if (prev.dir === "asc") return { col: ci, dir: "desc" };
      return null;
    });
  };

  return (
    <div className="pk-pv-shell">
      <div className="pk-pv-bar">
        <div className="pk-pv-bar-left">
          <FileSpreadsheet size={14} className="pk-pv-ico" />
          {data.sheets.length > 1 ? (
            <div className="pk-pv-tabs" role="tablist" aria-label="工作表">
              {data.sheets.map((s, idx) => (
                <button
                  key={`${s.name}-${idx}`}
                  type="button"
                  role="tab"
                  aria-selected={idx === safeIdx}
                  className={`pk-pv-tab${idx === safeIdx ? " on" : ""}`}
                  onClick={() => setSheetIdx(idx)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          ) : null}
          <div className="pk-pv-search">
            <Search size={13} className="pk-pv-search-ico" />
            <PocketInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="筛选行内容…"
              aria-label="筛选表格内容"
              className="pk-pv-search-input"
            />
          </div>
        </div>
        <div className="pk-pv-bar-right">
          <span className="pk-pv-badge num">
            {filteredRows.length === sheet.rows.length
              ? `${sheet.rows.length} 行 × ${sheet.columns.length} 列`
              : `${filteredRows.length} / ${sheet.rows.length} 行`}
          </span>
          <span className="pk-pv-badge accent num">{data.parseMs} ms</span>
          {data.truncated ? <span className="pk-pv-badge warn">已截断显示</span> : null}
          {actions}
        </div>
      </div>

      <div
        ref={scrollerRef}
        className="pk-grid-scroll"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <table className="pk-grid-table" style={{ width: totalWidth }}>
          <colgroup>
            <col style={{ width: 52 }} />
            {colWidths.map((w, ci) => (
              <col key={ci} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="pk-grid-rn num">#</th>
              {sheet.columns.map((col, ci) => {
                const activeSort = sortState?.col === ci ? sortState.dir : null;
                return (
                  <th key={ci} title={`${col}（点击排序）`}>
                    <button
                      type="button"
                      className={`pk-grid-sort${activeSort ? " on" : ""}`}
                      onClick={() => toggleSort(ci)}
                    >
                      <span className="truncate">{col}</span>
                      {activeSort === "asc" ? (
                        <ArrowUp size={12} />
                      ) : activeSort === "desc" ? (
                        <ArrowDown size={12} />
                      ) : (
                        <ArrowUpDown size={11} className="pk-grid-sort-idle" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {topPad > 0 ? (
              <tr className="pk-grid-spacer" aria-hidden style={{ height: topPad }}>
                <td colSpan={sheet.columns.length + 1} />
              </tr>
            ) : null}
            {filteredRows.slice(startIdx, endIdx).map((row, offset) => {
              const ri = startIdx + offset;
              return (
                <tr key={ri} style={{ height: ROW_HEIGHT }}>
                  <td className="pk-grid-rn num">{ri + 1}</td>
                  {sheet.columns.map((_c, ci) => {
                    const val = row[ci] ?? "";
                    const isSel = selectedCell?.row === ri && selectedCell?.col === ci;
                    return (
                      <td
                        key={ci}
                        className={isSel ? "sel" : undefined}
                        title={val}
                        onClick={() => setSelectedCell({ row: ri, col: ci, text: val })}
                      >
                        {val}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {botPad > 0 ? (
              <tr className="pk-grid-spacer" aria-hidden style={{ height: botPad }}>
                <td colSpan={sheet.columns.length + 1} />
              </tr>
            ) : null}
          </tbody>
        </table>
        {filteredRows.length === 0 ? (
          <div className="pk-pv-empty">{query ? "没有匹配的记录" : "表格暂无数据行"}</div>
        ) : null}
      </div>

      {selectedCell ? (
        <div className="pk-grid-inspector">
          <span className="pk-pv-badge num">
            R{selectedCell.row + 1} · {sheet.columns[selectedCell.col] || `C${selectedCell.col + 1}`}
          </span>
          <span className="pk-grid-insp-val mono truncate" title={selectedCell.text}>
            {selectedCell.text || "（空）"}
          </span>
          <PocketButton
            size="sm"
            variant="ghost"
            onClick={() => {
              void copyToClipboard(selectedCell.text).then((ok) =>
                toast(ok ? "单元格已复制" : "复制失败", !ok),
              );
            }}
          >
            <Copy size={12} />
            <span>复制值</span>
          </PocketButton>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document Viewer (.docx / .doc / .rtf / .odt)
// ---------------------------------------------------------------------------

function DocRunSpan({ run }: { run: DocRun }) {
  const style: React.CSSProperties = {
    fontWeight: run.bold ? 700 : undefined,
    fontStyle: run.italic ? "italic" : undefined,
    textDecoration:
      run.underline && run.strike
        ? "underline line-through"
        : run.underline
          ? "underline"
          : run.strike
            ? "line-through"
            : undefined,
    color: run.color,
  };

  if (run.href) {
    return (
      <a
        href={run.href}
        className={`pk-doc-link${run.code ? " mono" : ""}`}
        style={style}
        onClick={(e) => {
          e.preventDefault();
          void openExternalUrl(run.href!);
        }}
      >
        {run.text}
      </a>
    );
  }
  if (run.code) {
    return (
      <code className="pk-doc-code mono" style={style}>
        {run.text}
      </code>
    );
  }
  return <span style={style}>{run.text}</span>;
}

function renderRuns(runs: DocRun[]) {
  if (runs.length === 0 || (runs.length === 1 && runs[0]!.text === "")) return <br />;
  return runs.map((r, i) => <DocRunSpan key={i} run={r} />);
}

function wrapConvertedDocHtml(rawHtml: string): string {
  const injection = `<style>
    :root { color-scheme: light dark; }
    body {
      margin: 0 auto;
      max-width: 820px;
      padding: 28px 34px;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
      line-height: 1.7;
      font-size: 14.5px;
      background: #ffffff;
      color: #1f2328;
      word-break: break-word;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1625; color: #f1e9fa; }
      a { color: #ff8fb8; }
      table, th, td { border-color: rgba(255, 255, 255, 0.16) !important; }
    }
    img { max-width: 100%; height: auto; border-radius: 6px; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    th, td { border: 1px solid #e2d8e8; padding: 6px 10px; text-align: left; }
    p { margin: 0 0 8px 0; }
  </style>`;
  if (/<\/head>/i.test(rawHtml)) {
    return rawHtml.replace(/<\/head>/i, `${injection}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${injection}</head><body>${rawHtml}</body></html>`;
}

/** Rich document viewer supporting native OOXML/ODT/RTF AST blocks or sandboxed converted HTML (.doc). */
export function PocketDocViewer({
  doc,
  previewHtml,
  fileName,
  formatLabel,
  actions,
}: {
  doc?: DocPreviewData | null;
  previewHtml?: string;
  fileName: string;
  formatLabel?: string;
  actions?: ReactNode;
}) {
  const styledHtml = useMemo(
    () => (previewHtml ? wrapConvertedDocHtml(previewHtml) : null),
    [previewHtml],
  );

  return (
    <div className="pk-pv-shell">
      <div className="pk-pv-bar">
        <div className="pk-pv-bar-left">
          <FileText size={14} className="pk-pv-ico" />
          <span className="pk-pv-badge">{formatLabel || "文档预览"}</span>
          {doc ? (
            <>
              <span className="pk-pv-badge num">{doc.blocks.length} 个段落/块</span>
              <span className="pk-pv-badge accent num">{doc.parseMs} ms</span>
            </>
          ) : (
            <span className="pk-pv-badge accent">系统排版渲染</span>
          )}
        </div>
        <div className="pk-pv-bar-right">{actions}</div>
      </div>

      {doc && doc.blocks.length > 0 ? (
        <div className="pk-doc-scroll">
          <article className="pk-doc-paper">
            {doc.blocks.map((b: DocBlock, bi: number) => {
              if (b.kind === "heading") {
                const Tag = `h${b.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
                return (
                  <Tag key={bi} className={`pk-doc-h pk-doc-h${b.level}`}>
                    {renderRuns(b.runs)}
                  </Tag>
                );
              }
              if (b.kind === "image") {
                return (
                  <figure key={bi} className="pk-doc-fig">
                    <img src={b.src} alt={b.alt || fileName} />
                  </figure>
                );
              }
              if (b.kind === "table") {
                const maxCols = Math.max(1, ...b.rows.map((r) => r.reduce((s, c) => s + (c.colspan ?? 1), 0)));
                const pct = `${(100 / maxCols).toFixed(2)}%`;
                return (
                  <div key={bi} className="pk-doc-tbl-wrap">
                    <table className="pk-doc-tbl">
                      <colgroup>
                        {Array.from({ length: maxCols }, (_, ci) => (
                          <col key={ci} style={{ width: pct }} />
                        ))}
                      </colgroup>
                      <tbody>
                        {b.rows.map((row, ri) => (
                          <tr key={ri}>
                            {row.map((cell, ci) => (
                              <td key={ci} colSpan={cell.colspan}>
                                {renderRuns(cell.runs)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              }
              if (b.listLevel !== undefined) {
                return (
                  <div
                    key={bi}
                    className="pk-doc-li"
                    style={{ paddingLeft: 18 + b.listLevel * 18 }}
                  >
                    <span className="pk-doc-bullet" aria-hidden>
                      {b.ordered ? "•" : "•"}
                    </span>
                    <div className="pk-doc-li-text">{renderRuns(b.runs)}</div>
                  </div>
                );
              }
              return (
                <p key={bi} className="pk-doc-p" style={b.align ? { textAlign: b.align } : undefined}>
                  {renderRuns(b.runs)}
                </p>
              );
            })}
          </article>
        </div>
      ) : styledHtml ? (
        <iframe sandbox="" srcDoc={styledHtml} className="viewer-html-frame pk-doc-iframe" title={fileName} />
      ) : (
        <div className="pk-pv-empty">这篇文档没有可提取的正文内容，可尝试用系统默认应用打开。</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PPTX Presentation Viewer
// ---------------------------------------------------------------------------

export function PocketPptxViewer({
  data,
  actions,
}: {
  data: SlidePreviewData;
  actions?: ReactNode;
}) {
  const [singleMode, setSingleMode] = useState(false);
  const [curSlide, setCurSlide] = useState(0);

  const safeIdx = Math.min(curSlide, Math.max(0, data.slides.length - 1));
  const shown = singleMode ? data.slides.slice(safeIdx, safeIdx + 1) : data.slides;

  return (
    <div className="pk-pv-shell">
      <div className="pk-pv-bar">
        <div className="pk-pv-bar-left">
          <Presentation size={14} className="pk-pv-ico" />
          <span className="pk-pv-badge num">共 {data.slides.length} 页</span>
          <span className="pk-pv-badge accent num">{data.parseMs} ms</span>
          {singleMode && data.slides.length > 1 ? (
            <div className="pk-pv-pager">
              <button
                type="button"
                className="pk-vc-btn"
                aria-label="上一页"
                disabled={safeIdx <= 0}
                onClick={() => setCurSlide((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft size={14} />
              </button>
              <span className="num pk-pv-page-num">
                {safeIdx + 1} / {data.slides.length}
              </span>
              <button
                type="button"
                className="pk-vc-btn"
                aria-label="下一页"
                disabled={safeIdx >= data.slides.length - 1}
                onClick={() => setCurSlide((p) => Math.min(data.slides.length - 1, p + 1))}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          ) : null}
        </div>
        <div className="pk-pv-bar-right">
          <div className="segmented">
            <button type="button" className={!singleMode ? "active" : ""} onClick={() => setSingleMode(false)}>
              全部滚动
            </button>
            <button type="button" className={singleMode ? "active" : ""} onClick={() => setSingleMode(true)}>
              单页切换
            </button>
          </div>
          {actions}
        </div>
      </div>

      <div className="pk-doc-scroll">
        <div className="pk-slides-stack">
          {shown.map((s) => (
            <section key={s.index} className="pk-slide-card">
              <div className="pk-slide-head">
                <span className="pk-pv-badge accent num">#{s.index}</span>
                <h3 className="pk-slide-title">{s.title}</h3>
              </div>
              {s.bullets.length > 0 ? (
                <ul className="pk-slide-list">
                  {s.bullets.map((line, li) => (
                    <li key={li}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {s.tables.map((tbl, ti) => {
                const maxCols = Math.max(1, ...tbl.map((r) => r.length));
                const pct = `${(100 / maxCols).toFixed(2)}%`;
                return (
                  <table key={ti} className="pk-doc-tbl">
                    <colgroup>
                      {Array.from({ length: maxCols }, (_, ci) => (
                        <col key={ci} style={{ width: pct }} />
                      ))}
                    </colgroup>
                    <tbody>
                      {tbl.map((r, ri) => (
                        <tr key={ri}>
                          {Array.from({ length: maxCols }, (_, ci) => (
                            <td key={ci}>{r[ci] ?? ""}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                );
              })}
              {s.images.length > 0 ? (
                <div className="pk-slide-imgs">
                  {s.images.map((src, ii) => (
                    <img key={ii} src={src} alt={`Slide ${s.index} media ${ii + 1}`} />
                  ))}
                </div>
              ) : null}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PDF & Image Viewers
// ---------------------------------------------------------------------------

const PDF_VIEWS = [
  { id: "FitH", label: "适应宽度" },
  { id: "Fit", label: "整页" },
  { id: "100", label: "100%" },
  { id: "150", label: "150%" },
] as const;

export function PocketPdfViewer({
  url,
  pageCount,
  parseMs,
  title,
  actions,
}: {
  url: string;
  pageCount?: number | null;
  parseMs?: number | null;
  title: string;
  actions?: ReactNode;
}) {
  const [view, setView] = useState<(typeof PDF_VIEWS)[number]["id"]>("FitH");
  const framedUrl = useMemo(() => {
    const hash = view === "FitH" || view === "Fit" ? `view=${view}` : `zoom=${view}`;
    return `${url.split("#")[0]}#${hash}`;
  }, [url, view]);

  return (
    <div className="pk-pv-shell">
      <div className="pk-pv-bar">
        <div className="pk-pv-bar-left">
          <FileText size={14} className="pk-pv-ico" />
          <span className="pk-pv-badge num">{pageCount ? `共 ${pageCount} 页` : "PDF"}</span>
          {parseMs !== undefined && parseMs !== null ? (
            <span className="pk-pv-badge accent num">{parseMs} ms</span>
          ) : null}
          <div className="segmented">
            {PDF_VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                className={view === v.id ? "active" : ""}
                onClick={() => setView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
        <div className="pk-pv-bar-right">{actions}</div>
      </div>
      <iframe key={framedUrl} src={framedUrl} className="viewer-pdf-frame pk-pdf-frame" title={title} />
    </div>
  );
}

export function PocketImageViewer({
  src,
  alt,
  onError,
  actions,
}: {
  src: string;
  alt: string;
  onError?: () => void;
  actions?: ReactNode;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [checker, setChecker] = useState(false);

  useEffect(() => {
    setDims(null);
    setZoom("fit");
  }, [src]);

  const pct = zoom === "fit" ? null : Math.round(zoom * 100);
  const stepZoom = (dir: -1 | 1) => {
    const cur = zoom === "fit" ? 1 : zoom;
    const next = Math.min(4, Math.max(0.25, Number((cur + dir * 0.25).toFixed(2))));
    setZoom(next);
  };

  return (
    <div className="pk-pv-shell">
      <div className="pk-pv-bar">
        <div className="pk-pv-bar-left">
          {dims ? <span className="pk-pv-badge num">{dims.w} × {dims.h}</span> : null}
          <button type="button" className="pk-vc-btn" aria-label="缩小" onClick={() => stepZoom(-1)}>
            <ZoomOut size={13} />
          </button>
          <button
            type="button"
            className={`pk-pv-tab${zoom === "fit" ? " on" : ""}`}
            onClick={() => setZoom("fit")}
          >
            适应
          </button>
          <button
            type="button"
            className={`pk-pv-tab${zoom === 1 ? " on" : ""}`}
            onClick={() => setZoom(1)}
          >
            100%
          </button>
          <button type="button" className="pk-vc-btn" aria-label="放大" onClick={() => stepZoom(1)}>
            <ZoomIn size={13} />
          </button>
          {pct ? <span className="pk-pv-badge accent num">{pct}%</span> : null}
          <button
            type="button"
            className={`pk-vc-btn${checker ? " on" : ""}`}
            aria-label="切换透明网格背景"
            aria-pressed={checker}
            title="透明底纹"
            onClick={() => setChecker((c) => !c)}
          >
            <Grid size={13} />
          </button>
        </div>
        <div className="pk-pv-bar-right">{actions}</div>
      </div>

      <div
        className={`pk-img-stage${checker ? " checker" : ""}${zoom === "fit" ? " fit" : ""}`}
        onWheel={(e) => {
          if (!e.metaKey && !e.ctrlKey) return;
          e.preventDefault();
          stepZoom(e.deltaY < 0 ? 1 : -1);
        }}
      >
        <img
          src={src}
          alt={alt}
          style={
            zoom === "fit"
              ? undefined
              : dims
                ? { width: Math.round(dims.w * zoom), height: Math.round(dims.h * zoom), maxWidth: "none", maxHeight: "none" }
                : { transform: `scale(${zoom})` }
          }
          onLoad={(e) => {
            const el = e.currentTarget;
            if (el.naturalWidth > 0 && el.naturalHeight > 0) {
              setDims({ w: el.naturalWidth, h: el.naturalHeight });
            }
          }}
          onError={onError}
        />
      </div>
    </div>
  );
}
