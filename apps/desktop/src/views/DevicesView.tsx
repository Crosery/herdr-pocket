import { useEffect, useState } from "react";
import { Check, Copy, Laptop, Plus, Smartphone, Trash2 } from "lucide-react";
import QRCode from "qrcode";
import type { Device, DeviceKind, PairCode } from "@herdr-pocket/protocol";
import { EmptyState, PocketBadge, PocketButton, PocketCard, PocketIconButton, PocketModal, useToast } from "../components/PocketUI";
import { copyToClipboard } from "../lib/bridge";
import { createPairCode, getActiveToken, revokeDevice } from "../lib/relay";
import { isMockServer } from "../lib/mock";
import { liveStore, relTime, settingsStore } from "../lib/store";

export function DevicesView({ onShowHostAgents }: { onShowHostAgents: (hostId: string) => void }) {
  const toast = useToast();
  const devicesMap = liveStore.use((s) => s.devices);
  const agentsMap = liveStore.use((s) => s.agents);
  const myId = settingsStore.use((s) => s.deviceId);
  const server = settingsStore.use((s) => s.server);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<Device | null>(null);

  const devices = Object.values(devicesMap).sort(
    (a, b) => Number(a.kind !== "host") - Number(b.kind !== "host") || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
  );
  const hosts = devices.filter((d) => d.kind === "host");
  const viewers = devices.filter((d) => d.kind === "viewer");

  const handleRevoke = async (d: Device) => {
    const token = getActiveToken();
    if (!server || !token) return;
    try {
      await revokeDevice(server, token, d.id);
      toast(`已移除 ${d.name}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="main-scroll">
      <div style={{ maxWidth: 960, margin: "0 auto" }} className="stack">
        <div className="between wrap">
          <div>
            <h2 className="cute-font" style={{ margin: 0, fontSize: 26 }}>设备管理</h2>
            <div className="faint">在线电脑 {hosts.filter((h) => h.online).length}/{hosts.length} · 客户端 {viewers.filter((v) => v.online).length}/{viewers.length}</div>
          </div>
          <PocketButton onClick={() => setInviteOpen(true)}>
            <Plus size={15} />
            <span>添加设备</span>
          </PocketButton>
        </div>

        {devices.length === 0 ? (
          <EmptyState mood="sleepy" title="还没有已配对设备" body="点“添加设备”生成配对二维码或终端命令。" />
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {devices.map((d) => {
              const count = agentsMap[d.id]?.filter((a) => !a.isShell).length ?? 0;
              const isHost = d.kind === "host";
              const isMe = d.id === myId;
              return (
                <PocketCard key={d.id}>
                  <div className="between wrap">
                    <div className="row" style={{ gap: 12 }}>
                      <div
                        style={{
                          width: 42,
                          height: 42,
                          borderRadius: 14,
                          background: d.online ? "var(--accent-soft)" : "var(--surface-3)",
                          color: d.online ? "var(--accent-text)" : "var(--faint)",
                          display: "grid",
                          placeItems: "center",
                        }}
                      >
                        {isHost ? <Laptop size={20} /> : <Smartphone size={20} />}
                      </div>
                      <div>
                        <div className="row" style={{ gap: 8 }}>
                          <span style={{ fontWeight: 800, fontSize: 15 }}>{d.name}</span>
                          {isMe ? <PocketBadge tone="pink">这台设备</PocketBadge> : null}
                          <PocketBadge tone={d.online ? "mint" : "neutral"} pulse={d.online}>
                            {d.online ? "在线" : "离线"}
                          </PocketBadge>
                        </div>
                        <div className="faint">
                          {[d.platform, d.version ? `v${d.version}` : null, isHost ? `${count} 个 Agent` : "控制器", `最后活动 ${relTime(d.lastSeenAt)}`]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                    </div>

                    <div className="row">
                      {isHost ? (
                        <PocketButton size="sm" variant="soft" onClick={() => onShowHostAgents(d.id)}>
                          看它的 Agents
                        </PocketButton>
                      ) : null}
                      {!isMe ? (
                        <PocketIconButton size="sm" tooltip="移除授权" onClick={() => setConfirmRemove(d)}>
                          <Trash2 size={15} />
                        </PocketIconButton>
                      ) : null}
                    </div>
                  </div>
                </PocketCard>
              );
            })}
          </div>
        )}
      </div>

      <AddDeviceModal open={inviteOpen} onOpenChange={setInviteOpen} />

      <PocketModal open={Boolean(confirmRemove)} onOpenChange={(v) => !v && setConfirmRemove(null)} title="移除设备？" width={380}>
        {confirmRemove ? (
          <div className="stack">
            <div className="muted">将吊销「{confirmRemove.name}」的访问令牌，它需要重新配对才能连接。</div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <PocketButton variant="ghost" onClick={() => setConfirmRemove(null)}>取消</PocketButton>
              <PocketButton
                variant="danger"
                onClick={async () => {
                  const target = confirmRemove;
                  setConfirmRemove(null);
                  await handleRevoke(target);
                }}
              >
                确认移除
              </PocketButton>
            </div>
          </div>
        ) : null}
      </PocketModal>
    </div>
  );
}

function AddDeviceModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const toast = useToast();
  const server = settingsStore.use((s) => s.server);
  const [kind, setKind] = useState<DeviceKind>("host");
  const [pair, setPair] = useState<PairCode | null>(null);
  const [qrUrl, setQrUrl] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const issue = async (k: DeviceKind) => {
    const token = getActiveToken();
    if (!server || (!token && !isMockServer(server))) return;
    setLoading(true);
    try {
      const code = await createPairCode(server, token || "", k);
      setPair(code);
      const dataUrl = await QRCode.toDataURL(code.link, { width: 220, margin: 1 });
      setQrUrl(dataUrl);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void issue(kind);
  }, [open, kind]);

  const srv = server && !isMockServer(server) ? server : "https://pocket.example.com";
  const hostCmd = `curl -fsSL https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-host.sh | bash -s -- --server ${srv}`;

  return (
    <PocketModal open={open} onOpenChange={onOpenChange} title="添加新设备" subtitle="选择新设备类型，使用二维码或命令行接入" width={480}>
      <div className="stack">
        <div className="segmented" style={{ alignSelf: "flex-start" }}>
          <button className={kind === "host" ? "active" : ""} onClick={() => setKind("host")}>接入电脑 (Host)</button>
          <button className={kind === "viewer" ? "active" : ""} onClick={() => setKind("viewer")}>接入手机 / 桌面端</button>
        </div>

        <PocketCard soft>
          {loading ? (
            <div className="muted" style={{ padding: 20, textAlign: "center" }}>正在生成配对码…</div>
          ) : pair ? (
            <div className="row wrap" style={{ justifyContent: "center", gap: 16 }}>
              {qrUrl ? <img src={qrUrl} alt="配对二维码" style={{ width: 148, height: 148, borderRadius: 14, background: "#fff", padding: 6 }} /> : null}
              <div className="stack grow" style={{ minWidth: 200 }}>
                <div>
                  <div className="faint">配对码（30 分钟内有效）</div>
                  <div className="mono" style={{ fontSize: 22, fontWeight: 800, color: "var(--accent-text)" }}>{pair.code}</div>
                </div>
                <div className="faint truncate">{pair.link}</div>
                <div className="row wrap">
                  <PocketButton
                    size="sm"
                    variant="soft"
                    onClick={async () => {
                      await copyToClipboard(`${srv} ${pair.code}`);
                      toast("已复制服务器与配对码");
                    }}
                  >
                    <Copy size={13} />
                    <span>复制配对文本</span>
                  </PocketButton>
                  <PocketButton size="sm" variant="ghost" onClick={() => void issue(kind)}>
                    <Check size={13} />
                    <span>换一个码</span>
                  </PocketButton>
                </div>
              </div>
            </div>
          ) : null}
        </PocketCard>

        {kind === "host" ? (
          <div className="stack" style={{ gap: 6 }}>
            <div className="faint">在新电脑终端运行安装：</div>
            <div className="mono" style={{ fontSize: 12, padding: 10, borderRadius: 12, background: "var(--surface-2)", border: "1px solid var(--divider)", wordBreak: "break-all" }}>
              {hostCmd}
            </div>
            <PocketButton
              size="sm"
              variant="ghost"
              style={{ alignSelf: "flex-start" }}
              onClick={async () => {
                await copyToClipboard(hostCmd);
                toast("已复制电脑端安装命令");
              }}
            >
              <Copy size={13} />
              <span>复制安装命令</span>
            </PocketButton>
          </div>
        ) : null}
      </div>
    </PocketModal>
  );
}
