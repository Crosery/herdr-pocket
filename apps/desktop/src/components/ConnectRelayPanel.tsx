import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { AlertCircle, ArrowRight, ChevronDown, ChevronRight, Copy, ExternalLink, Fingerprint, Laptop, Link2, QrCode, RefreshCw, ShieldCheck } from "lucide-react";
import { parsePairInput, type IdentityHintResponse, type JoinTicket } from "@herdr-pocket/protocol";
import { PocketBadge, PocketButton, PocketInput, useToast } from "./PocketUI";
import { copyToClipboard, defaultDeviceName, getHostdStatus, isH5Web, openExternalUrl, type HostdLocalStatus } from "../lib/bridge";
import {
  fetchIdentityHint,
  inferRelayUrlFromLocation,
  isPasskeySupported,
  recognizeWebDevice,
  reconfirmWithPasskey,
  trySilentReconfirm,
} from "../lib/h5Identity";
import { isMockServer } from "../lib/mock";
import {
  applyAuthenticatedPairResponse,
  claimWebJoinTicket,
  completePairing,
  normalizeServer,
  pairWithLocalHost,
  requestWebJoinTicket,
} from "../lib/relay";
import { settingsStore } from "../lib/store";
import { logger } from "../lib/log";

export const RELAY_EXPLAINER = "中转服务器是你自己部署的一个小服务，让手机和各台电脑隔着网络也能互相找到。";
export const RELAY_DEPLOY_DOCS = "https://github.com/Crosery/herdr-pocket/tree/main/docs/deploy";

/**
 * The ways to reach a relay: local herdr-pocket login, browser H5 identity/Passkey recovery or
 * reverse-QR approval, a pasted invite, or a typed address and pair code.
 */
export function ConnectRelayPanel({
  onConnected,
  initialError,
  initialHint = null,
  autoFocus = false,
}: {
  onConnected?: () => void;
  initialError?: string | null;
  initialHint?: IdentityHintResponse | null;
  autoFocus?: boolean;
}) {
  const toast = useToast();
  const h5 = isH5Web();
  const lastServer = settingsStore.use((s) => s.lastServer);
  const recognized = useMemo(() => (h5 ? recognizeWebDevice() : null), [h5]);
  const [local, setLocal] = useState<HostdLocalStatus | null>(null);
  const [server, setServer] = useState(() => lastServer || (h5 && typeof window !== "undefined" ? inferRelayUrlFromLocation(window.location) : ""));
  const [code, setCode] = useState("");
  const [name, setName] = useState(() => defaultDeviceName());
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState<"local" | "manual" | "reconfirm" | "join" | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [manualOpen, setManualOpen] = useState(h5);
  const [hint, setHint] = useState<IdentityHintResponse | null>(initialHint);
  const [joinTicket, setJoinTicket] = useState<JoinTicket | null>(null);
  const [joinQr, setJoinQr] = useState("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const check = useCallback(async () => {
    if (h5) {
      setManualOpen(true);
      return;
    }
    const status = await getHostdStatus();
    if (!mountedRef.current) return;
    setLocal(status);
    if (status?.configured && status.server) setServer((cur) => cur || status.server!);
    if (!status?.configured) setManualOpen(true);
  }, [h5]);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    setError(initialError ?? null);
  }, [initialError]);

  useEffect(() => {
    if (initialHint) setHint(initialHint);
  }, [initialHint]);

  const normServer = normalizeServer(server);

  useEffect(() => {
    if (!h5 || !normServer || isMockServer(normServer)) return;
    let cancelled = false;
    void fetchIdentityHint(normServer).then((next) => {
      if (!cancelled && next) setHint(next);
    });
    return () => {
      cancelled = true;
    };
  }, [h5, normServer]);

  useEffect(() => {
    if (!joinTicket || !normServer) return;
    let cancelled = false;
    const poll = async () => {
      if (Date.now() > joinTicket.expiresAt) {
        if (!cancelled) {
          setJoinTicket(null);
          setJoinQr("");
          setError("加入申请二维码已过期，可以点一次重新生成。");
        }
        return;
      }
      try {
        const res = await claimWebJoinTicket(normServer, joinTicket.id, joinTicket.secret);
        if (cancelled) return;
        if (res.status === "approved") {
          setJoinTicket(null);
          setJoinQr("");
          await applyAuthenticatedPairResponse(normServer, { device: res.device, token: res.token });
          toast("已获准加入，正在进入");
          onConnected?.();
        } else if (res.status === "denied") {
          setJoinTicket(null);
          setJoinQr("");
          setError("另一台设备拒绝了本次加入申请。");
        }
      } catch (err) {
        if (!cancelled && /not_found|过期/.test((err as Error).message)) {
          setJoinTicket(null);
          setJoinQr("");
        }
      }
    };
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [joinTicket, normServer, onConnected, toast]);

  const handlePaste = (val: string) => {
    setPaste(val);
    const parsed = parsePairInput(val);
    if (parsed) {
      if (parsed.server) setServer(parsed.server);
      setCode(parsed.code);
      setError(null);
      toast("已识别服务器地址和配对码");
    }
  };

  const fail = (err: unknown) => {
    const msg = (err as Error)?.message || "连接失败";
    setError(msg);
    logger.warn("connect", msg);
  };

  const connectLocal = async () => {
    setBusy("local");
    setError(null);
    try {
      await pairWithLocalHost(name);
      toast("已用这台电脑的登录连上中转服务器");
      onConnected?.();
    } catch (err) {
      fail(err);
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const reconfirmIdentity = async () => {
    if (!normServer || isMockServer(normServer)) {
      return setError("先填写实际中转服务器地址再恢复本机身份");
    }
    setBusy("reconfirm");
    setError(null);
    try {
      let res = await trySilentReconfirm(normServer);
      if (!res && isPasskeySupported()) {
        res = await reconfirmWithPasskey(normServer);
      }
      if (!res) {
        throw new Error("当前浏览器尚未在此服务器上保存或绑定可验证身份，请先扫码或输入一次配对码完成绑定");
      }
      await applyAuthenticatedPairResponse(normServer, res);
      toast("已确认本机设备身份");
      onConnected?.();
    } catch (err) {
      fail(err);
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const startReverseJoin = async () => {
    if (!normServer || isMockServer(normServer)) {
      return setError("先填写中转服务器地址再生成申请二维码");
    }
    setBusy("join");
    setError(null);
    try {
      const ticket = await requestWebJoinTicket(normServer, name);
      const QRCode = await import("qrcode");
      const qr = await QRCode.toDataURL(ticket.link, { width: 280, margin: 1, color: { dark: "#2B2236", light: "#FFFFFF" } });
      if (!mountedRef.current) return;
      setJoinQr(qr);
      setJoinTicket(ticket);
    } catch (err) {
      fail(err);
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!server.trim()) return setError("先填服务器地址，例如 https://pocket.example.com");
    if (!code.trim()) return setError("先填配对码：在已登录的设备上点“扫码连接手机”，或在电脑终端运行 herdr-pocket invite 生成");
    setBusy("manual");
    setError(null);
    try {
      // The relay's log records whether the code came from a pasted invite or was typed.
      const fromLink = parsePairInput(paste)?.code?.toUpperCase() === code.trim().toUpperCase();
      await completePairing(server, code, name, fromLink ? "link" : "typed");
      toast("连接成功");
      onConnected?.();
    } catch (err) {
      const msg = (err as Error)?.message ?? "";
      fail(
        /code|配对码|expired|过期|not found|bad_request/i.test(msg)
          ? `配对码不对或已过期（30 分钟有效）：在已登录的设备上点“扫码连接手机”或运行 herdr-pocket invite 生成新码。（${msg}）`
          : err,
      );
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const localReady = !h5 && Boolean(local?.configured);
  const showH5Recovery = h5 && Boolean(normServer) && !isMockServer(normServer) && Boolean(hint?.anchored || hint?.passkeyLinked || isPasskeySupported());

  return (
    <div className="stack" style={{ gap: 14 }}>
      {error ? (
        <div className="inline-alert" role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      {recognized ? (
        <div className="h5-device-banner">
          <ShieldCheck size={15} className="h5-device-icon" />
          <div className="grow min-w-0">
            <div className="row wrap" style={{ gap: 6, alignItems: "center" }}>
              <span style={{ fontWeight: 700, fontSize: "calc(13px * var(--ts, 1))" }}>已识别当前设备</span>
              <PocketBadge tone="pink">{recognized.name}</PocketBadge>
            </div>
            <div className="faint" style={{ fontSize: "calc(12px * var(--ts, 1))", marginTop: 2 }}>
              将自动适配{recognized.formFactor === "desktop" ? "桌面多窗格" : "手机/平板触控"}界面，并绑定本地加密身份以防浏览器缓存变更产生重复设备。
            </div>
          </div>
        </div>
      ) : null}

      {localReady ? (
        <div className="choice-card primary">
          <div className="grow">
            <div className="choice-title">用这台电脑的登录一键连接</div>
            <div className="faint wrap-anywhere">
              这台电脑已登录 herdr-pocket（{local?.deviceName || "本机"} · {local?.server}）
            </div>
          </div>
          <PocketButton variant="primary" disabled={busy !== null} onClick={() => void connectLocal()}>
            <Laptop size={15} />
            <span>{busy === "local" ? "正在连接…" : "一键连接"}</span>
          </PocketButton>
        </div>
      ) : null}

      {showH5Recovery ? (
        <div className={`choice-card${hint?.anchored || hint?.passkeyLinked ? " primary" : ""}`}>
          <div className="grow min-w-0">
            <div className="choice-title">
              {hint?.deviceName ? `快速恢复已绑定身份（${hint.deviceName}）` : "用本机唯一身份 / 通行密钥恢复登录"}
            </div>
            <div className="faint wrap-anywhere">
              {hint?.anchored
                ? "检测到当前浏览器曾登记过此中转服务器，验证后将沿用原设备 ID，不新增重复设备。"
                : "如果你曾在本浏览器绑定通行密钥（Face ID / Touch ID / 指纹）或保留加密钥匙，可直接验签登录。"}
            </div>
          </div>
          <PocketButton variant={hint?.anchored || hint?.passkeyLinked ? "primary" : "soft"} disabled={busy !== null} onClick={() => void reconfirmIdentity()}>
            <Fingerprint size={15} />
            <span>{busy === "reconfirm" ? "正在验证…" : hint?.anchored ? "一键恢复身份" : "通行密钥登录"}</span>
          </PocketButton>
        </div>
      ) : null}

      {h5 ? (
        <div className="choice-card column">
          <div className="row wrap" style={{ justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <div className="grow min-w-0">
              <div className="choice-title">让已登录的手机或电脑扫码放行</div>
              <div className="faint">适合没有现成配对码时，用另一台已登录 Herdr Pocket 的设备扫一下确认。</div>
            </div>
            <PocketButton size="sm" variant="soft" disabled={busy !== null} onClick={() => void startReverseJoin()}>
              {joinTicket ? <RefreshCw size={14} /> : <QrCode size={14} />}
              <span>{busy === "join" ? "正在生成…" : joinTicket ? "刷新二维码" : "生成确认码"}</span>
            </PocketButton>
          </div>
          {joinTicket && joinQr ? (
            <div className="h5-join-box">
              <img src={joinQr} alt="等待确认加入的二维码" className="h5-join-qr" />
              <div className="stack min-w-0 grow" style={{ gap: 6 }}>
                <div style={{ fontWeight: 700, fontSize: "calc(13px * var(--ts, 1))" }}>用已登录的 Herdr Pocket 扫一扫</div>
                <div className="faint">或者点击复制链接，在已登录设备浏览器里打开同意即可（3 分钟内有效）。</div>
                <div className="row wrap" style={{ gap: 6 }}>
                  <PocketButton
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      const ok = await copyToClipboard(joinTicket.link);
                      toast(ok ? "确认链接已复制" : "复制失败", !ok);
                    }}
                  >
                    <Copy size={13} />
                    <span>复制确认链接</span>
                  </PocketButton>
                  <PocketButton
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setJoinTicket(null);
                      setJoinQr("");
                    }}
                  >
                    取消等待
                  </PocketButton>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="choice-card column">
        <button type="button" className="choice-toggle" onClick={() => setManualOpen((v) => !v)} aria-expanded={manualOpen}>
          {manualOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <span className="choice-title">{localReady ? "连接别的服务器" : "填写邀请链接或配对码"}</span>
        </button>
        {manualOpen ? (
          <form className="stack" style={{ gap: 12 }} onSubmit={submit}>
            <label className="field">
              <span className="field-label">粘贴邀请链接（最省事）</span>
              <PocketInput
                autoFocus={autoFocus && !localReady}
                placeholder="https://pocket.example.com/p/MEOW-4821"
                value={paste}
                onChange={(e) => handlePaste(e.target.value)}
              />
              <span className="field-hint">别人发给你的链接或整段邀请文字都可以，会自动识别地址和配对码。</span>
            </label>
            <div className="field-grid">
              <label className="field">
                <span className="field-label">服务器地址</span>
                <PocketInput placeholder="https://pocket.example.com" value={server} onChange={(e) => setServer(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">配对码</span>
                <PocketInput mono placeholder="MEOW-4821" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
              </label>
            </div>
            <label className="field">
              <span className="field-label">这台设备叫什么</span>
              <PocketInput value={name} onChange={(e) => setName(e.target.value)} />
              <span className="field-hint">会显示在其他设备的“设备”列表里，之后可以改。</span>
            </label>
            <div className="row wrap" style={{ justifyContent: "space-between" }}>
              <button type="button" className="link-btn" onClick={() => void openExternalUrl(RELAY_DEPLOY_DOCS)}>
                <ExternalLink size={13} />
                <span>还没有中转服务器？看部署说明</span>
              </button>
              <PocketButton variant={localReady ? "soft" : "primary"} type="submit" disabled={busy !== null}>
                <Link2 size={15} />
                <span>{busy === "manual" ? "正在连接…" : "连接"}</span>
                <ArrowRight size={15} />
              </PocketButton>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
