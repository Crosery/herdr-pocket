import { Laptop, Layers, Plus, Settings, Smartphone, X } from "lucide-react";
import type { Device } from "@herdr-pocket/protocol";
import { XiaoyangOrb } from "../components/MascotAndVendor";
import { PocketIconButton } from "../components/PocketUI";
import { SpaceTileIcon } from "../shell/spaceIcon";

export function MobileSidebarDrawer({
  open,
  onClose,
  hosts,
  hostCounts,
  allCount,
  hostFilter,
  onSelectHost,
  spaces,
  scopeCount,
  spaceFilter,
  onSelectSpace,
  onNewInSpace,
  onOpenDevices,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  hosts: Device[];
  hostCounts: Record<string, number>;
  allCount: number;
  hostFilter: string | null;
  onSelectHost: (id: string | null) => void;
  spaces: Array<[string, number]>;
  scopeCount: number;
  spaceFilter: string | null;
  onSelectSpace: (space: string | null) => void;
  onNewInSpace: (space: string) => void;
  onOpenDevices: () => void;
  onOpenSettings: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="mp-drawer-backdrop"
      role="presentation"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="mp-drawer" aria-label="电脑与空间筛选">
        <div className="between" style={{ padding: "0 14px 10px" }}>
          <div className="row" style={{ gap: 10 }}>
            <XiaoyangOrb mood="hello" size={38} />
            <div>
              <div className="cute-font" style={{ fontSize: 18 }}>Herdr Pocket</div>
              <div className="faint" style={{ fontSize: 11.5 }}>按电脑或空间筛选</div>
            </div>
          </div>
          <PocketIconButton size="sm" tooltip="关闭菜单" onClick={onClose}>
            <X size={16} />
          </PocketIconButton>
        </div>

        <div className="mp-drawer-scroll">
          <div className="mp-section-head" style={{ padding: "0 10px", marginTop: 6 }}>
            <span>电脑</span>
          </div>
          <button
            type="button"
            className={`mp-drawer-row${hostFilter === null ? " active" : ""}`}
            onClick={() => {
              onSelectHost(null);
              onClose();
            }}
          >
            <Laptop size={16} />
            <span className="grow truncate">全部电脑</span>
            <span className="faint num">{allCount}</span>
          </button>
          {hosts.map((h) => (
            <button
              key={h.id}
              type="button"
              className={`mp-drawer-row${hostFilter === h.id ? " active" : ""}`}
              onClick={() => {
                onSelectHost(h.id);
                onClose();
              }}
            >
              <span className={`status-pip${h.online ? " ok" : ""}`} />
              <span className="grow truncate">{h.name}</span>
              <span className="faint num">{hostCounts[h.id] ?? 0}</span>
            </button>
          ))}

          {/* 空间 stays fixed (never collapsible) per design guardrail */}
          <div className="mp-section-head" style={{ padding: "0 10px" }}>
            <span>空间</span>
          </div>
          <button
            type="button"
            className={`mp-drawer-row${spaceFilter === null ? " active" : ""}`}
            onClick={() => {
              onSelectSpace(null);
              onClose();
            }}
          >
            <Layers size={16} />
            <span className="grow truncate">全部空间</span>
            <span className="faint num">{scopeCount}</span>
          </button>
          {spaces.map(([name, cnt]) => (
            <div key={name} className="row" style={{ gap: 2 }}>
              <button
                type="button"
                className={`mp-drawer-row grow${spaceFilter === name ? " active" : ""}`}
                onClick={() => {
                  onSelectSpace(name);
                  onClose();
                }}
              >
                <SpaceTileIcon spaceKey={`${hostFilter ?? ""}\u0000${name}`} name={name} size="sm" />
                <span className="grow truncate">{name}</span>
                <span className="faint num">{cnt}</span>
              </button>
              <PocketIconButton
                size="sm"
                tooltip={`在 ${name} 新建`}
                onClick={() => {
                  onClose();
                  onNewInSpace(name);
                }}
              >
                <Plus size={14} />
              </PocketIconButton>
            </div>
          ))}
        </div>

        <div style={{ borderTop: "1px solid var(--mp-divider)", padding: "8px 10px 0", display: "flex", flexDirection: "column", gap: 2 }}>
          <button
            type="button"
            className="mp-drawer-row"
            onClick={() => {
              onClose();
              onOpenDevices();
            }}
          >
            <Smartphone size={16} />
            <span>设备管理</span>
          </button>
          <button
            type="button"
            className="mp-drawer-row"
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
          >
            <Settings size={16} />
            <span>设置</span>
          </button>
        </div>
      </aside>
    </div>
  );
}
