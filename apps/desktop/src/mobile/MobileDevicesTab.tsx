import { useEffect, useMemo, useState } from "react";
import { Laptop, Monitor, MoreHorizontal, Plus, Smartphone } from "lucide-react";
import type { Device } from "@herdr-pocket/protocol";
import { PocketBadge, PocketButton, PocketIconButton, PocketModal, fs } from "../components/PocketUI";
import { copyToClipboard } from "../lib/bridge";
import { partitionDevices, type ClassifiedDevice } from "../lib/deviceRole";
import { useLocalHostDeviceId } from "../lib/fonts";
import { liveStore, relTime, settingsStore } from "../lib/store";
import { AddDeviceModal, RemoveDeviceDialog } from "../views/DevicesView";
import { ToolVersionsSection } from "../views/settings/ToolVersions";

export function MobileDevicesTab({
  onShowHostAgents,
  onPairPhone,
}: {
  onShowHostAgents: (hostId: string) => void;
  onPairPhone: () => void;
}) {
  const devicesMap = liveStore.use((s) => s.devices);
  const agentsMap = liveStore.use((s) => s.agents);
  const direct = liveStore.use((s) => s.direct);
  const myId = settingsStore.use((s) => s.deviceId);
  const localHostId = useLocalHostDeviceId();
  const [moreDevice, setMoreDevice] = useState<Device | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Device | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  useEffect(() => {
    const onTourCommand = (ev: Event) => {
      const cmd = (ev as CustomEvent<{ action?: string }>).detail?.action;
      if (cmd === "closeModals") {
        setInviteOpen(false);
        setMoreDevice(null);
        setConfirmRemove(null);
        setToolsOpen(false);
      } else if (cmd === "openAddComputer") {
        setInviteOpen(true);
      }
    };
    window.addEventListener("pocket:tour-command", onTourCommand);
    return () => window.removeEventListener("pocket:tour-command", onTourCommand);
  }, []);

  const { desktop, mobile, desktopOnlineCount, mobileOnlineCount } = useMemo(
    () => partitionDevices(devicesMap, { myId, localHostId }),
    [devicesMap, myId, localHostId],
  );
  const totalCount = desktop.length + mobile.length;
  const onlineCount = desktopOnlineCount + mobileOnlineCount;

  const renderCard = (item: ClassifiedDevice) => {
    const d = item.device;
    const isHost = d.kind === "host";
    const count = isHost ? agentsMap[d.id]?.filter((a) => !a.isShell).length ?? 0 : 0;
    const online = d.online || Boolean(item.mergedViewer?.online);
    const isDesktopViewer = !isHost && /控制端|desktop|桌面/i.test(item.roleLabel) && !/手机/.test(item.roleLabel);
    const Icon = isHost ? Laptop : isDesktopViewer ? Monitor : Smartphone;
    const hasDirect = isHost && Boolean(direct[d.id]);

    const sub = [
      d.platform,
      isHost ? `${count} 个 Agent` : "移动 / 网页端",
      online ? "在线" : `离线 · ${relTime(d.lastSeenAt)}`,
      hasDirect ? "直连" : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <div
        key={d.id}
        className={`mp-device-card${online ? "" : " offline"}`}
        role={isHost ? "button" : undefined}
        tabIndex={isHost ? 0 : undefined}
        onClick={() => {
          if (isHost) onShowHostAgents(d.id);
        }}
        onKeyDown={(e) => {
          if (isHost && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onShowHostAgents(d.id);
          }
        }}
      >
        <div className={`mp-device-avatar${isHost ? " host" : ""}`} style={{ opacity: online ? 1 : 0.55 }}>
          <Icon size={20} />
          <span className={`mp-device-dot${online ? " on" : ""}`} />
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6, minWidth: 0 }}>
            <span className="truncate" style={{ fontWeight: 800, fontSize: fs(15) }}>{d.name}</span>
            {item.isCurrentDevice ? <PocketBadge tone="pink">这台</PocketBadge> : null}
          </div>
          <div className="faint truncate" style={{ fontSize: fs(12.5), marginTop: 2 }}>{sub}</div>
        </div>
        {!item.isCurrentDevice ? (
          <PocketIconButton
            size="sm"
            tooltip="更多操作"
            onClick={(e) => {
              e.stopPropagation();
              setMoreDevice(d);
            }}
          >
            <MoreHorizontal size={17} />
          </PocketIconButton>
        ) : null}
      </div>
    );
  };

  return (
    <div className="mp-scroll">
      <div className="between wrap" style={{ gap: 10 }}>
        <div>
          <h1 className="cute-font mp-page-title">设备</h1>
          <div className="mp-page-sub">
            {onlineCount} 台在线 · 共 {totalCount} 台
          </div>
        </div>
        <div className="row" style={{ gap: 6 }} data-tour="mp-devices-actions">
          <PocketButton size="sm" variant="soft" onClick={onPairPhone}>
            配对手机
          </PocketButton>
          <PocketButton size="sm" variant="primary" onClick={() => setInviteOpen(true)}>
            <Plus size={14} />
            添加电脑
          </PocketButton>
        </div>
      </div>

      {desktop.length > 0 ? (
        <>
          <div className="mp-section-head">
            <span>电脑（{desktopOnlineCount}/{desktop.length}）</span>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            {desktop.map(renderCard)}
          </div>
        </>
      ) : null}

      {mobile.length > 0 ? (
        <>
          <div className="mp-section-head">
            <span>手机与网页端（{mobileOnlineCount}/{mobile.length}）</span>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            {mobile.map(renderCard)}
          </div>
        </>
      ) : null}

      <PocketModal
        open={Boolean(moreDevice)}
        onOpenChange={(open) => {
          if (!open) setMoreDevice(null);
        }}
        title={moreDevice?.name ?? "设备操作"}
        width={380}
      >
        {moreDevice ? (
          <div className="stack" style={{ gap: 8 }}>
            {moreDevice.kind === "host" ? (
              <>
                <PocketButton
                  variant="soft"
                  onClick={() => {
                    const id = moreDevice.id;
                    setMoreDevice(null);
                    onShowHostAgents(id);
                  }}
                >
                  查看这台电脑上的 Agents
                </PocketButton>
                <PocketButton
                  variant="ghost"
                  onClick={() => {
                    setMoreDevice(null);
                    setToolsOpen(true);
                  }}
                >
                  查看组件版本与更新
                </PocketButton>
              </>
            ) : null}
            <PocketButton
              variant="ghost"
              onClick={() => {
                void copyToClipboard(moreDevice.id);
                setMoreDevice(null);
              }}
            >
              复制设备 ID
            </PocketButton>
            <PocketButton
              variant="danger"
              onClick={() => {
                const target = moreDevice;
                setMoreDevice(null);
                setConfirmRemove(target);
              }}
            >
              移除设备授权
            </PocketButton>
          </div>
        ) : null}
      </PocketModal>

      <PocketModal
        open={toolsOpen}
        onOpenChange={setToolsOpen}
        title="电脑端组件版本与更新"
        width={480}
      >
        <div className="stack" style={{ gap: 10 }}>
          <ToolVersionsSection />
        </div>
      </PocketModal>

      <RemoveDeviceDialog device={confirmRemove} onClose={() => setConfirmRemove(null)} />
      <AddDeviceModal open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}
