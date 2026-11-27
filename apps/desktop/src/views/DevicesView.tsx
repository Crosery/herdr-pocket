import { useEffect, useMemo, useState } from "react";
import { Activity, Check, Copy, Laptop, Monitor, Plus, Smartphone, Trash2 } from "lucide-react";
import type { Device, DeviceKind, PairCode } from "@herdr-pocket/protocol";
import { EmptyState, PocketBadge, PocketButton, PocketCard, PocketIconButton, PocketModal, fs, useToast } from "../components/PocketUI";
import { copyToClipboard, isH5Web } from "../lib/bridge";
import { partitionDevices, type ClassifiedDevice } from "../lib/deviceRole";
import { useLocalHostDeviceId } from "../lib/fonts";
import { installHostCommand } from "../components/LocalHostDeps";
import { classifyLatency, describeHostTransport } from "../lib/networkMeta";
import { createPairCode, getActiveToken, measureHostRtt, measureRelayRtt, revokeDevice } from "../lib/relay";
import { isMockServer } from "../lib/mock";
import { liveStore, relTime, settingsStore } from "../lib/store";

export function DevicesView({
  onShowHostAgents,
  addHostNonce = 0,
  onPairPhone,
}: {
  onShowHostAgents: (hostId: string) => void;
  /** Bumped by the sidebar's "添加电脑" to open the add dialog on the computer tab. */
  addHostNonce?: number;
  onPairPhone?: () => void;
}) {
  const devicesMap = liveStore.use((s) => s.devices);
  const agentsMap = liveStore.use((s) => s.agents);
  const directMap = liveStore.use((s) => s.direct);
  const directMeta = liveStore.use((s) => s.directMeta);
  const hostProbeRttMs = liveStore.use((s) => s.hostProbeRttMs);
  const relayRttMs = liveStore.use((s) => s.rttMs);
  const myId = settingsStore.use((s) => s.deviceId);
  const localHostId = useLocalHostDeviceId();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  useEffect(() => {
    if (addHostNonce) setInviteOpen(true);
  }, [addHostNonce]);
  const [confirmRemove, setConfirmRemove] = useState<Device | null>(null);

  const { desktop, mobile, desktopOnlineCount, mobileOnlineCount } = useMemo(
    () => partitionDevices(devicesMap, { myId, localHostId }),
    [devicesMap, myId, localHostId],
  );
  const totalCount = desktop.length + mobile.length;

  const probeAll = async () => {
    setProbing(true);
    try {
      const onlineHosts = Object.values(devicesMap).filter((d) => d.kind === "host" && d.online);
      await Promise.all([measureRelayRtt(4_000), ...onlineHosts.map((h) => measureHostRtt(h.id, 4_000))]);
    } finally {
      setProbing(false);
    }
  };

  const renderCard = (item: ClassifiedDevice) => {
    const d = item.device;
    const isHost = d.kind === "host";
    const count = isHost ? agentsMap[d.id]?.filter((a) => !a.isShell).length ?? 0 : 0;
    const online = d.online || Boolean(item.mergedViewer?.online);
    const isDesktopViewer = !isHost && /控制端|desktop|桌面/i.test(item.roleLabel) && !/手机/.test(item.roleLabel);
    const Icon = isHost ? Laptop : isDesktopViewer ? Monitor : Smartphone;
    const roleTone = item.isLocalHost ? "mint" : item.isExecutionHost ? "lav" : "neutral";
    const transport = isHost ? describeHostTransport(directMap[d.id], directMeta[d.id]) : null;
    const shownRtt = isHost
      ? (directMap[d.id] ? (directMeta[d.id]?.rttMs ?? hostProbeRttMs[d.id] ?? null) : (hostProbeRttMs[d.id] ?? relayRttMs ?? null))
      : null;
    const latInfo = classifyLatency(shownRtt);
    return (
      <PocketCard key={d.id}>
        <div className="device-card">
          <div className="device-main">
            <div className={`device-icon${online ? " on" : ""}`}>
              <Icon size={20} />
            </div>
            <div className="device-text">
              <div className="device-name-row">
                <span className="device-name" title={d.name}>{d.name}</span>
                {item.isCurrentDevice ? <PocketBadge tone="pink">当前设备 · 本机</PocketBadge> : null}
                {item.isCurrentDevice && !isHost ? null : <PocketBadge tone={roleTone}>{item.roleLabel}</PocketBadge>}
                {isHost && online && transport ? (
                  <PocketBadge tone={latInfo.tone}>
                    <span className="mono">
                      {transport.shortLabel}{typeof shownRtt === "number" ? ` · ${shownRtt}ms` : ""}
                    </span>
                  </PocketBadge>
                ) : (
                  <PocketBadge tone={online ? "mint" : "neutral"} pulse={online}>
                    {online ? "在线" : "离线"}
                  </PocketBadge>
                )}
              </div>
              <div className="faint device-meta">
                {[
                  d.platform,
                  d.version ? `v${d.version}` : null,
                  isHost ? `${count} 个 Agent` : item.isCurrentDevice ? item.roleLabel : null,
                  `最后活动 ${relTime(d.lastSeenAt)}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          </div>

          <div className="device-actions">
            {isHost ? (
              <PocketButton size="sm" variant="soft" onClick={() => onShowHostAgents(d.id)}>
                看它的 Agents
              </PocketButton>
            ) : null}
            {!item.isCurrentDevice ? (
              <PocketIconButton size="sm" tooltip="移除授权" onClick={() => setConfirmRemove(d)}>
                <Trash2 size={15} />
              </PocketIconButton>
            ) : null}
          </div>
        </div>
      </PocketCard>
    );
  };

  const h5 = isH5Web();
  return (
    <div className="main-scroll">
      <div style={{ maxWidth: 960, margin: "0 auto" }} className="stack">
        <div className="between wrap" style={{ gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 220px", minWidth: 0 }}>
            <h2 className="cute-font" style={{ margin: 0, fontSize: fs(26) }}>设备管理</h2>
            <div className="faint">
              桌面运行载体 {desktopOnlineCount}/{desktop.length} · 移动控制端 {mobileOnlineCount}/{mobile.length}
              {typeof relayRttMs === "number" ? ` · 中继 ${relayRttMs} ms` : ""}
            </div>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <PocketButton variant="ghost" disabled={probing} onClick={() => void probeAll()}>
              <Activity size={15} className={probing ? "pk-spin" : undefined} />
              <span>{probing ? "测速中…" : "测速"}</span>
            </PocketButton>
            {onPairPhone ? (
              <PocketButton variant="soft" onClick={onPairPhone}>
                <Smartphone size={15} />
                <span>{h5 ? "生成配对码" : "扫码连接手机"}</span>
              </PocketButton>
            ) : null}
            <PocketButton onClick={() => setInviteOpen(true)}>
              <Plus size={15} />
              <span>添加电脑</span>
            </PocketButton>
          </div>
        </div>

        {totalCount === 0 ? (
          <EmptyState
            mood="sleepy"
            title="还没有已配对设备"
            body={h5 ? "点“添加电脑”拿到安装命令，或点“生成配对码”。" : "点“添加电脑”拿到安装命令，或点“扫码连接手机”。"}
          />
        ) : (
          <div className="stack" style={{ gap: 18 }}>
            <div className="stack" style={{ gap: 10 }}>
              <div className="device-section-head">
                <span className="device-section-title">桌面端 · 运行载体</span>
                <span className="faint device-section-sub">可直接运行终端/Agent 并本地直连，也可互相远程联调</span>
              </div>
              {desktop.length ? (
                desktop.map(renderCard)
              ) : (
                <div className="faint device-section-empty">还没有桌面端加入。</div>
              )}
            </div>

            <div className="stack" style={{ gap: 10 }}>
              <div className="device-section-head">
                <span className="device-section-title">移动端 · 便携控制</span>
                <span className="faint device-section-sub">随时随地查看消息、排队发送并控制任意在线桌面端</span>
              </div>
              {mobile.length ? (
                mobile.map(renderCard)
              ) : (
                <div className="faint device-section-empty">还没有手机端加入，点右上角“扫码连接手机”即可控制桌面端。</div>
              )}
            </div>
          </div>
        )}
      </div>

      <AddDeviceModal open={inviteOpen} onOpenChange={setInviteOpen} />

      <RemoveDeviceDialog device={confirmRemove} onClose={() => setConfirmRemove(null)} />
    </div>
  );
}

/** Asks before revoking a device's token on the relay; `device` null = closed. */
export function RemoveDeviceDialog({ device, onClose }: { device: Device | null; onClose: () => void }) {
  const toast = useToast();
  const server = settingsStore.use((s) => s.server);
  const revoke = async (d: Device) => {
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
    <PocketModal open={Boolean(device)} onOpenChange={(v) => !v && onClose()} title="移除设备？" width={380}>
      {device ? (
        <div className="stack">
          <div className="muted">将吊销「{device.name}」的访问令牌，它需要重新配对才能连接。</div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <PocketButton variant="ghost" onClick={onClose}>取消</PocketButton>
            <PocketButton
              variant="danger"
              onClick={async () => {
                onClose();
                await revoke(device);
              }}
            >
              确认移除
            </PocketButton>
          </div>
        </div>
      ) : null}
    </PocketModal>
  );
}

export function AddDeviceModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
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
      const QRCode = await import("qrcode");
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
  const hostCmd = installHostCommand(srv);

  return (
    <PocketModal open={open} onOpenChange={onOpenChange} title="添加新设备" subtitle="选择新设备类型，使用二维码或命令行接入" width={480} dataTour="add-device-modal">
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
                  <div className="mono" style={{ fontSize: fs(22), fontWeight: 800, color: "var(--accent-text)" }}>{pair.code}</div>
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
            <div className="faint">在要接入的电脑上打开终端（Windows 用 PowerShell），运行：</div>
            <div className="mono" style={{ fontSize: fs(12), padding: 10, borderRadius: 12, background: "var(--surface-2)", border: "1px solid var(--divider)", wordBreak: "break-all" }}>
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
