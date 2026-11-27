import { useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  Clock,
  Compass,
  ExternalLink,
  FileCode2,
  FolderSearch,
  Globe,
  Maximize2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { Agent, PortalInputAction, PortalItem } from "@herdr-pocket/protocol";
import { openExternalUrl } from "../lib/bridge";
import {
  capturePortalFrameOnce,
  closePortalSurface,
  formatPortalDisplayTitle,
  portalStore,
  sendPortalInput,
  subscribeAgentPortalUpdates,
  subscribePortalFrames,
} from "../lib/portalClient";
import { relTime } from "../lib/store";
import { FileViewer } from "../views/WorkbenchView";
import { PocketButton, PocketIconButton, useToast } from "./PocketUI";
import { PortalRemoteStage, type RemoteControlMode } from "./PortalRemoteStage";

function portalTabIcon(it: PortalItem) {
  if (it.egoSpace) return <Compass size={13} />;
  if (it.kind === "browser") return <Globe size={13} />;
  if (it.kind === "window") return <AppWindow size={13} />;
  if (it.kind === "reveal") return <FolderSearch size={13} />;
  return <FileCode2 size={13} />;
}

/**
 * Unified time-ordered portal workspace tab used when an agent/terminal instance spawns
 * multiple floating windows or when a split pane is too narrow for floating PiP.
 */
export function PortalTabPane({
  hostId,
  agentKey,
  agent,
  activePortalId,
  onSelectPortalId,
  onExpandModal,
}: {
  hostId: string;
  agentKey: string;
  agent?: Agent;
  activePortalId?: string;
  onSelectPortalId: (portalId: string) => void;
  onExpandModal: (portalId: string, hostId: string) => void;
}) {
  const toast = useToast();
  const itemsById = portalStore.use((s) => s.itemsById);
  const framesById = portalStore.use((s) => s.framesById);
  const openedAtById = portalStore.use((s) => s.openedAtById);
  const [controlMode] = useState<RemoteControlMode>("pointer");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [retrying, setRetrying] = useState(false);

  useEffect(() => subscribeAgentPortalUpdates(hostId, agentKey), [agentKey, hostId]);

  const items = useMemo(() => {
    return Object.values(itemsById)
      .filter((it) => it.hostId === hostId && it.agentKey === agentKey)
      .sort(
        (a, b) =>
          (openedAtById[b.id] ?? b.updatedAt ?? b.createdAt) -
            (openedAtById[a.id] ?? a.updatedAt ?? a.createdAt) || a.id.localeCompare(b.id),
      );
  }, [agentKey, hostId, itemsById, openedAtById]);

  const active = useMemo(
    () => (activePortalId ? items.find((i) => i.id === activePortalId) : undefined) ?? items[0],
    [activePortalId, items],
  );
  const frame = active ? framesById[active.id] : undefined;

  useEffect(() => {
    if (!active || !active.canInteract) return;
    return subscribePortalFrames(active.hostId, active.id, { fps: 30, maxWidth: 1440, quality: 68, showCursor: true });
  }, [active?.canInteract, active?.hostId, active?.id]);

  const handleSendInput = (input: PortalInputAction) => {
    if (!active?.canInteract) return;
    return sendPortalInput(active.hostId, active.id, input).catch(() => {});
  };

  if (items.length === 0) {
    return (
      <div className="portal-tab-empty">
        <Clock size={24} className="faint" />
        <div>该实例当前没有活动的预览小窗</div>
        <div className="faint">当终端打开网页、窗口或运行 Ego 浏览器时，会自动按时间收录到这里。</div>
      </div>
    );
  }

  return (
    <div className="portal-tab-pane">
      <div className="portal-tab-strip" role="tablist" aria-label="按时间排列的实例预览窗口">
        {items.map((it) => {
          const isOn = active?.id === it.id;
          const ts = openedAtById[it.id] ?? it.updatedAt ?? it.createdAt;
          return (
            <button
              key={it.id}
              type="button"
              role="tab"
              aria-selected={isOn}
              className={`portal-tab-pill${isOn ? " active" : ""}`}
              title={it.url || it.title}
              onClick={() => onSelectPortalId(it.id)}
            >
              {portalTabIcon(it)}
              <span className="truncate">{formatPortalDisplayTitle(it)}</span>
              <span className="portal-tab-time">{relTime(ts)}</span>
            </button>
          );
        })}
        {active ? (
          <div className="portal-tab-strip-acts">
            {active.url ? (
              <PocketIconButton
                size="sm"
                tooltip="在外部浏览器打开"
                onClick={() => void openExternalUrl(active.url!)}
              >
                <ExternalLink size={13} />
              </PocketIconButton>
            ) : null}
            <PocketIconButton
              size="sm"
              tooltip="打开完整交互远控弹窗"
              onClick={() => onExpandModal(active.id, active.hostId)}
            >
              <Maximize2 size={13} />
            </PocketIconButton>
            <PocketIconButton
              size="sm"
              tooltip="关闭当前回传"
              onClick={() => void closePortalSurface(active.hostId, active.id)}
            >
              <Trash2 size={13} />
            </PocketIconButton>
          </div>
        ) : null}
      </div>

      {active && (active.kind === "browser" || active.kind === "window") ? (
        <div className="portal-tab-stage-wrap">
          <PortalRemoteStage
            item={active}
            frame={frame}
            controlMode={controlMode}
            showRemoteCursor
            zoom={zoom}
            pan={pan}
            onPanChange={setPan}
            onZoomChange={setZoom}
            latchedMods={[]}
            onConsumeLatchedMods={() => {}}
            onSendInput={handleSendInput}
            placeholder={
              <div className="portal-stage-placeholder">
                {portalTabIcon(active)}
                <div>{active.streamError ? "暂时无法获取远端画面" : "正在同步实时画面…"}</div>
                {active.streamError ? <div className="faint">{active.streamError}</div> : null}
                <PocketButton
                  size="sm"
                  variant="soft"
                  disabled={retrying}
                  onClick={() => {
                    setRetrying(true);
                    void capturePortalFrameOnce(active.hostId, active.id, { maxWidth: 1440, quality: 68 })
                      .catch((e: Error) => toast(e.message || "重试失败", true))
                      .finally(() => setRetrying(false));
                  }}
                >
                  <RefreshCw size={12} className={retrying ? "pk-spin" : undefined} />
                  <span>重试捕获</span>
                </PocketButton>
              </div>
            }
          />
        </div>
      ) : active ? (
        <div className="portal-tab-stage-wrap">
          <FileViewer
            key={`${active.hostId}:${active.targetPath || active.title}`}
            tab={{ path: active.targetPath || active.title, title: active.title, absPath: active.targetPath, deviceId: active.hostId }}
            agent={agent}
            embedded
          />
        </div>
      ) : null}
    </div>
  );
}
