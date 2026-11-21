import { Download, RefreshCw, RotateCcw, Sparkles, X } from "lucide-react";
import { isTauri, openExternalUrl } from "../lib/bridge";
import {
  dismissUpdatePrompt,
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

function briefReleaseText(raw: string | undefined): string {
  if (!raw) return "";
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").replace(/^[-*]\s+/, "• ").trim())
    .filter(Boolean);
  const text = lines.slice(0, 3).join("  ");
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

/**
 * Bottom-right desktop update notification card: prompts on new GitHub Releases,
 * streams & SHA-256 verifies installer assets natively, and offers one-click restart.
 */
export function UpdatePrompt() {
  const st = updateStore.use((s) => s);
  const viewingUpdatesPane = shellStore.use((s) => s.settings === "updates");
  if (!isTauri() || viewingUpdatesPane || !st.info?.hasUpdate) return null;
  if (st.dismissedVersion === st.info.latest && (st.installPhase === "idle" || st.installPhase === "ready")) return null;

  const info = st.info;
  const phase = st.installPhase;
  const busy =
    phase === "downloading" ||
    phase === "verifying" ||
    phase === "staging" ||
    phase === "restarting";
  const pct = st.progress?.percent ?? null;
  const summary = briefReleaseText(info.notes?.body);

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
    statusLine = `v${info.latest} 已下载并校验通过，重启后完成替换`;
  } else if (phase === "restarting") {
    statusLine = "正在重启并安装新版本…";
  } else if (phase === "error") {
    statusLine = st.installError || "下载失败";
  }

  return (
    <aside className="update-toast-card" role="status" aria-live="polite" aria-label="软件更新提示">
      <div className="update-toast-head">
        <XiaoyangOrb mood={phase === "ready" ? "hello" : busy ? "working" : "hello"} size={30} />
        <div className="update-toast-titles">
          <div className="update-toast-title">
            {phase === "ready" ? `v${info.latest} 已就绪` : `发现新版本 v${info.latest}`}
          </div>
          <div className="update-toast-sub">当前 v{info.current}</div>
        </div>
        {!busy ? (
          <button
            type="button"
            className="update-toast-close"
            aria-label="稍后提醒"
            onClick={() => dismissUpdatePrompt()}
          >
            <X size={14} />
          </button>
        ) : null}
      </div>

      {summary && phase === "idle" ? (
        <div className="update-toast-notes">
          <div className="update-toast-notes-clamp">{summary}</div>
        </div>
      ) : null}

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
              <span>立即下载更新</span>
            </PocketButton>
            <PocketButton size="sm" variant="ghost" onClick={() => dismissUpdatePrompt()}>
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
