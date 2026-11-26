import { CheckCircle2, Download, Minimize2, RefreshCw, RotateCcw, Sparkles, X } from "lucide-react";
import { isH5Web, openExternalUrl } from "../lib/bridge";
import {
  dismissUpdatePrompt,
  minimizeUpdatePrompt,
  restartToApplyUpdate,
  startUpdateDownload,
  updateStore,
} from "../lib/updates";
import { shellStore } from "../shell/shellStore";
import { XiaoyangOrb } from "./MascotAndVendor";
import { PocketButton } from "./PocketUI";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extractReleaseHighlights(raw: string | undefined): string[] {
  if (!raw) return [];
  const items: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === "---" || line.startsWith("#")) continue;
    if (/^(?:Relay image:|[-*]\s*\*\*(?:Server|Computer daemon|Mobile clients|Desktop clients|Update)\*\*:)/.test(line)) {
      break;
    }
    const cleaned = line
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();
    if (!cleaned) continue;
    items.push(cleaned);
    if (items.length >= 5) break;
  }
  return items;
}

/**
 * Orca-style bottom-right desktop update notification card anchored above `.v3-status`,
 * with minimize-to-status-bar, version delta chip, SHA-256 staging, and session reassurance copy.
 */
export function UpdatePrompt() {
  const st = updateStore.use((s) => s);
  const viewingUpdatesPane = shellStore.use((s) => s.settings === "updates");
  if (isH5Web() || viewingUpdatesPane) return null;

  if (!st.info?.hasUpdate) {
    if (!st.manualNotice) return null;
    return (
      <aside className="update-toast-card compact" role="status" aria-live="polite" aria-label="更新状态提示">
        <div className="update-toast-head">
          <CheckCircle2 size={16} style={{ color: "var(--mint-text)", flex: "none" }} />
          <div className="update-toast-titles">
            <div className="update-toast-title">{st.manualNotice}</div>
          </div>
          <button
            type="button"
            className="update-toast-close"
            aria-label="关闭提示"
            onClick={() => updateStore.set({ manualNotice: null })}
          >
            <X size={14} />
          </button>
        </div>
      </aside>
    );
  }

  if (st.minimized) return null;
  if (st.dismissedVersion === st.info.latest && (st.installPhase === "idle" || st.installPhase === "ready")) return null;

  const info = st.info;
  const phase = st.installPhase;
  const busy =
    phase === "downloading" ||
    phase === "verifying" ||
    phase === "staging" ||
    phase === "restarting";
  const pct = st.progress?.percent ?? null;
  const highlights = extractReleaseHighlights(info.notes?.body);

  let statusLine = `来源：${info.source || "GitHub"}`;
  if (phase === "downloading") {
    const dl = st.progress ? formatBytes(st.progress.downloadedBytes) : "0 MB";
    const tot = st.progress?.totalBytes ? ` / ${formatBytes(st.progress.totalBytes)}` : "";
    const pStr = pct !== null ? ` · ${pct}%` : "";
    statusLine = `正在从 ${st.progress?.source || info.source || "GitHub"} 下载 ${dl}${tot}${pStr}`;
  } else if (phase === "verifying") {
    statusLine = st.progress?.message || "正在校验 SHA-256…";
  } else if (phase === "staging") {
    statusLine = st.progress?.message || "正在校验签名并准备更新包…";
  } else if (phase === "ready") {
    statusLine = `v${info.latest} 已下载并校验通过，重启即可完成更新`;
  } else if (phase === "restarting") {
    statusLine = "正在重启并安装新版本…";
  } else if (phase === "error") {
    statusLine = st.installError || "下载失败";
  }

  return (
    <aside key={info.latest} className="update-toast-card" role="status" aria-live="polite" aria-label="软件更新提示">
      <div className="update-toast-head">
        <XiaoyangOrb mood={phase === "ready" ? "hello" : busy ? "working" : "hello"} size={30} />
        <div className="update-toast-titles">
          <div className="update-toast-title">
            {phase === "ready" ? `v${info.latest} 更新已就绪` : `发现新版本 v${info.latest}`}
          </div>
          <div className="update-toast-sub">
            v{info.current} → v{info.latest}
            {st.supersededFrom && st.supersededFrom !== info.latest ? ` · 已直接切换至新版（跳过 v${st.supersededFrom}）` : ""}
          </div>
        </div>
        <button
          type="button"
          className="update-toast-close"
          aria-label="收起到底部状态栏"
          title="收起到底部状态栏"
          onClick={() => minimizeUpdatePrompt()}
        >
          <Minimize2 size={13} />
        </button>
        {!busy ? (
          <button
            type="button"
            className="update-toast-close"
            aria-label="忽略此版本"
            title="暂时关闭提示"
            onClick={() => dismissUpdatePrompt()}
          >
            <X size={14} />
          </button>
        ) : null}
      </div>

      {highlights.length > 0 && phase === "idle" ? (
        <div className="update-toast-notes">
          <ul className="update-toast-notes-list">
            {highlights.map((line, i) => (
              <li key={i} className="update-toast-note-line">
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="update-toast-reassure">重启更新后将自动恢复当前工作区，不会中断后台终端与 Agent</div>

      <div className={`update-toast-status${phase === "error" ? " error" : ""}`}>{statusLine}</div>

      {phase === "downloading" || phase === "verifying" || phase === "staging" ? (
        <div className="update-toast-track" aria-hidden>
          <div
            className={`update-toast-fill${pct === null || phase !== "downloading" ? " pulse" : ""}`}
            style={{ width: `${pct !== null ? Math.max(4, pct) : 100}%` }}
          />
        </div>
      ) : null}

      <div className="update-toast-actions">
        {phase === "ready" ? (
          <PocketButton size="sm" variant="primary" onClick={() => void restartToApplyUpdate()}>
            <RotateCcw size={13} />
            <span>立即重启并更新</span>
          </PocketButton>
        ) : phase === "restarting" ? (
          <PocketButton size="sm" variant="primary" disabled>
            <RefreshCw size={13} />
            <span>正在重启…</span>
          </PocketButton>
        ) : busy ? (
          <PocketButton size="sm" variant="soft" disabled>
            <span>{phase === "staging" ? "准备中…" : phase === "verifying" ? "校验中…" : "下载中…"}</span>
          </PocketButton>
        ) : phase === "error" ? (
          <>
            <PocketButton size="sm" variant="primary" onClick={() => void startUpdateDownload()}>
              <RefreshCw size={13} />
              <span>重试下载</span>
            </PocketButton>
            <PocketButton size="sm" variant="ghost" onClick={() => void openExternalUrl(info.downloadUrl)}>
              <span>浏览器下载</span>
            </PocketButton>
          </>
        ) : (
          <>
            <PocketButton size="sm" variant="primary" onClick={() => void startUpdateDownload()}>
              <Download size={13} />
              <span>立即更新</span>
            </PocketButton>
            <PocketButton size="sm" variant="ghost" onClick={() => minimizeUpdatePrompt()}>
              <span>稍后</span>
            </PocketButton>
            <button
              type="button"
              className="link-btn update-toast-link"
              onClick={() => void openExternalUrl(info.pageUrl)}
              title="在浏览器打开更新日志"
            >
              <Sparkles size={12} />
              <span>日志</span>
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
