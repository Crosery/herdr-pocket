import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertCircle, ArrowRight, ChevronDown, ChevronRight, ExternalLink, Laptop, Link2 } from "lucide-react";
import { parsePairInput } from "@herdr-pocket/protocol";
import { PocketButton, PocketInput, useToast } from "./PocketUI";
import { defaultDeviceName, getHostdStatus, openExternalUrl, type HostdLocalStatus } from "../lib/bridge";
import { completePairing, pairWithLocalHost } from "../lib/relay";
import { settingsStore } from "../lib/store";
import { logger } from "../lib/log";

export const RELAY_EXPLAINER = "中转服务器是你自己部署的一个小服务，让手机和各台电脑隔着网络也能互相找到。";
export const RELAY_DEPLOY_DOCS = "https://github.com/Crosery/herdr-pocket/tree/main/docs/deploy";

/**
 * The three ways to reach a relay: this computer's herdr-pocket login, a pasted invite,
 * or a typed address and pair code. Errors stay on screen with the next step.
 */
export function ConnectRelayPanel({
  onConnected,
  initialError,
  autoFocus = false,
}: {
  onConnected?: () => void;
  initialError?: string | null;
  autoFocus?: boolean;
}) {
  const toast = useToast();
  const lastServer = settingsStore.use((s) => s.lastServer);
  const [local, setLocal] = useState<HostdLocalStatus | null>(null);
  const [server, setServer] = useState(lastServer ?? "");
  const [code, setCode] = useState("");
  const [name, setName] = useState(() => defaultDeviceName());
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState<"local" | "manual" | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [manualOpen, setManualOpen] = useState(false);

  const check = useCallback(async () => {
    const status = await getHostdStatus();
    setLocal(status);
    if (status?.configured && status.server) setServer((cur) => cur || status.server!);
    if (!status?.configured) setManualOpen(true);
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    setError(initialError ?? null);
  }, [initialError]);

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
      setBusy(null);
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
      setBusy(null);
    }
  };

  const localReady = Boolean(local?.configured);

  return (
    <div className="stack" style={{ gap: 14 }}>
      {error ? (
        <div className="inline-alert" role="alert">
          <AlertCircle size={16} />
          <span>{error}</span>
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
