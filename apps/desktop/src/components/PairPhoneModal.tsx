import { useCallback, useEffect, useState } from "react";
import { Copy, RefreshCw, Smartphone } from "lucide-react";
import type { PairCode } from "@herdr-pocket/protocol";
import { PocketButton, PocketModal, useToast } from "./PocketUI";
import { copyToClipboard } from "../lib/bridge";
import { createPairCode, getActiveToken } from "../lib/relay";
import { isMockServer } from "../lib/mock";
import { liveStore, settingsStore } from "../lib/store";
import { useWindowHidden } from "../lib/layout";
import { logger } from "../lib/log";

function useCountdown(until: number | null): number {
  const hidden = useWindowHidden();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until || hidden) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until, hidden]);
  return until ? Math.max(0, until - now) : 0;
}

function mmss(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The QR panel on its own, for the modal and the onboarding step. */
export function PairPhonePanel({ onNeedRelay }: { onNeedRelay?: () => void }) {
  const toast = useToast();
  const server = settingsStore.use((s) => s.server);
  const link = liveStore.use((s) => s.link);
  const [pair, setPair] = useState<PairCode | null>(null);
  const [qr, setQr] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const left = useCountdown(pair?.expiresAt ?? null);
  const expired = Boolean(pair) && left <= 0;

  const issue = useCallback(async () => {
    const token = getActiveToken();
    if (!server || (!token && !isMockServer(server))) return;
    setLoading(true);
    setError(null);
    try {
      const code = await createPairCode(server, token || "", "viewer");
      const QRCode = await import("qrcode");
      setQr(await QRCode.toDataURL(code.link, { width: 400, margin: 1, color: { dark: "#2B2236", light: "#FFFFFF" } }));
      setPair(code);
      logger.info("pair", `phone pair code issued, expires ${new Date(code.expiresAt).toLocaleTimeString()}`);
    } catch (e) {
      const msg = (e as Error).message;
      setError(`没生成出配对码：${msg}。确认已连上中转服务器后点“换一个码”重试。`);
      logger.warn("pair", `phone pair code failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [server]);

  useEffect(() => {
    if (server) void issue();
  }, [server, issue]);

  if (!server) {
    return (
      <div className="stack" style={{ alignItems: "center", textAlign: "center", padding: "12px 0" }}>
        <Smartphone size={28} />
        <div style={{ fontWeight: 800 }}>先连接中转服务器</div>
        <div className="muted" style={{ maxWidth: 340 }}>手机要通过同一个中转服务器才能看到这台电脑上的 Agent。</div>
        {onNeedRelay ? (
          <PocketButton variant="primary" onClick={onNeedRelay}>
            连接中转服务器
          </PocketButton>
        ) : null}
      </div>
    );
  }

  return (
    <div className="pair-phone">
      <div className={`pair-qr${expired || loading ? " dim" : ""}`}>
        {qr ? <img src={qr} alt="手机配对二维码" /> : <div className="pair-qr-empty">{loading ? "正在生成…" : "暂无二维码"}</div>}
        {expired ? (
          <button className="pair-qr-cover" onClick={() => void issue()}>
            <RefreshCw size={16} />
            <span>已过期，换一个码</span>
          </button>
        ) : null}
      </div>
      <div className="stack grow" style={{ gap: 10, minWidth: 0 }}>
        <ol className="steps-list">
          <li>在手机上打开 Herdr Pocket（还没装：到项目的 GitHub Releases 下载安装包）</li>
          <li>点“扫一扫”扫这个二维码；也可以用系统相机扫，会跳到 Pocket</li>
          <li>连上后，手机会出现在“设备”页</li>
        </ol>
        {pair ? (
          <div>
            <div className="faint">配对码</div>
            <div className="pair-code mono">{pair.code}</div>
            <div className="faint num">{expired ? "已过期" : `30 分钟内有效 · 还剩 ${mmss(left)}`}</div>
          </div>
        ) : null}
        {error ? <div className="inline-alert">{error}</div> : null}
        {link !== "online" && !isMockServer(server) ? <div className="faint">提示：现在和服务器断开了，生成的码可能用不了。</div> : null}
        <div className="row wrap" style={{ gap: 8 }}>
          <PocketButton
            size="sm"
            variant="soft"
            disabled={!pair}
            onClick={async () => {
              if (!pair) return;
              const ok = await copyToClipboard(pair.link);
              toast(ok ? "配对链接已复制，可以发到手机上打开" : "复制失败，请手动抄下配对码", !ok);
            }}
          >
            <Copy size={13} />
            <span>复制链接</span>
          </PocketButton>
          <PocketButton size="sm" variant="ghost" disabled={loading} onClick={() => void issue()}>
            <RefreshCw size={13} />
            <span>换一个码</span>
          </PocketButton>
        </div>
      </div>
    </div>
  );
}

export function PairPhoneModal({
  open,
  onOpenChange,
  onNeedRelay,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onNeedRelay?: () => void;
}) {
  return (
    <PocketModal open={open} onOpenChange={onOpenChange} title="扫码连接手机" subtitle="手机扫码后就能随时查看、回复所有电脑上的 Agent" width={600}>
      {open ? <PairPhonePanel onNeedRelay={onNeedRelay} /> : null}
    </PocketModal>
  );
}
