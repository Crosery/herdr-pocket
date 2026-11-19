import { useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Cpu,
  FileCode2,
  Laptop,
  Mic,
  Moon,
  QrCode,
  Search,
  Sparkles,
  Sun,
} from "lucide-react";
import type { AgentRow, Device } from "../lib/api";
import { resolveVendor } from "./MascotAndVendor";
import { PocketDialog, PocketInput, StatusPill } from "./ui/PocketUI";

export type RouteId = "overview" | "devices" | "models" | "voice" | "prompts" | "logs";

export function CommandPalette({
  open,
  onOpenChange,
  agents,
  devices,
  dark,
  onNavigate,
  onToggleTheme,
  onOpenPair,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agents: AgentRow[];
  devices: Device[];
  dark: boolean;
  onNavigate: (r: RouteId) => void;
  onToggleTheme: () => void;
  onOpenPair: () => void;
}) {
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();

  const quickActions = useMemo(
    () => [
      { id: "go-overview", label: "前往：概览与智能体", sub: "查看全网 Agent 与小羊动态", icon: <Sparkles size={15} />, run: () => onNavigate("overview") },
      { id: "go-devices", label: "前往：设备与配对", sub: "管理已连设备、批准加入与二维码", icon: <Laptop size={15} />, run: () => onNavigate("devices") },
      { id: "open-pair", label: "生成一次性配对二维码", sub: "快速邀请新手机或电脑接入", icon: <QrCode size={15} />, run: () => { onNavigate("devices"); onOpenPair(); } },
      { id: "go-models", label: "前往：模型与服务商", sub: "调整推理顺位与接口测速", icon: <Cpu size={15} />, run: () => onNavigate("models") },
      { id: "go-voice", label: "前往：语音与音色工作室", sub: "切换 marin 等音色与查看通话诊断", icon: <Mic size={15} />, run: () => onNavigate("voice") },
      { id: "go-prompts", label: "前往：提示词工作台", sub: "编辑小羊人设与通话规则", icon: <FileCode2 size={15} />, run: () => onNavigate("prompts") },
      { id: "go-logs", label: "前往：实时日志", sub: "排查 live.ai、rpc 与设备事件", icon: <Activity size={15} />, run: () => onNavigate("logs") },
      { id: "toggle-theme", label: dark ? "切换到浅色粉白模式" : "切换到暗夜模式", sub: "同步 Herdr Pocket 视觉主题", icon: dark ? <Sun size={15} /> : <Moon size={15} />, run: onToggleTheme },
    ],
    [dark, onNavigate, onOpenPair, onToggleTheme],
  );

  const filteredActions = quickActions.filter(
    (a) => !q || a.label.toLowerCase().includes(q) || a.sub.toLowerCase().includes(q),
  );

  const matchedAgents = agents
    .filter((a) => !a.isShell)
    .filter((a) => !q || `${a.title ?? ""} ${a.where ?? ""} ${a.harness} ${a.deviceName ?? ""}`.toLowerCase().includes(q))
    .slice(0, 5);

  const matchedDevices = devices
    .filter((d) => !q || `${d.name} ${d.platform ?? ""} ${d.kind}`.toLowerCase().includes(q))
    .slice(0, 4);

  const exec = (fn: () => void) => {
    onOpenChange(false);
    setQuery("");
    fn();
  };

  return (
    <PocketDialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setQuery("");
      }}
      wide
      title={
        <>
          <Search size={17} />
          <span>快捷命令与全局跳转</span>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <PocketInput
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索页面、Agent、设备或操作…"
        />
        <div style={{ maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
          {filteredActions.map((item) => (
            <button
              key={item.id}
              type="button"
              className="prompt-item"
              onClick={() => exec(item.run)}
            >
              <div className="between">
                <div className="row" style={{ gap: 8 }}>
                  <span style={{ color: "var(--accent-text)" }}>{item.icon}</span>
                  <span style={{ fontWeight: 800, fontSize: 13.5 }}>{item.label}</span>
                </div>
                <span className="faint">{item.sub}</span>
              </div>
            </button>
          ))}

          {matchedAgents.length ? (
            <>
              <div className="faint" style={{ padding: "6px 4px 2px", fontWeight: 800 }}>匹配到的 Agent</div>
              {matchedAgents.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  className="prompt-item"
                  onClick={() => exec(() => onNavigate("overview"))}
                >
                  <div className="between">
                    <div className="row" style={{ gap: 8 }}>
                      <Bot size={15} style={{ color: "var(--lav-text)" }} />
                      <span style={{ fontWeight: 800 }}>{a.title || a.name || a.localId}</span>
                      <span className="faint">{resolveVendor(a.harness, a.isShell).label} · {a.deviceName}</span>
                    </div>
                    <StatusPill status={a.status} errored={a.errored} />
                  </div>
                </button>
              ))}
            </>
          ) : null}

          {matchedDevices.length ? (
            <>
              <div className="faint" style={{ padding: "6px 4px 2px", fontWeight: 800 }}>匹配到的设备</div>
              {matchedDevices.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="prompt-item"
                  onClick={() => exec(() => onNavigate("devices"))}
                >
                  <div className="between">
                    <div className="row" style={{ gap: 8 }}>
                      <Laptop size={15} style={{ color: "var(--mint-text)" }} />
                      <span style={{ fontWeight: 800 }}>{d.name}</span>
                      <span className="faint">{d.kind === "host" ? "电脑" : "手机"} · {d.platform || "-"}</span>
                    </div>
                    <span className={`pk-pill ${d.online ? "working" : ""}`}>{d.online ? "在线" : "离线"}</span>
                  </div>
                </button>
              ))}
            </>
          ) : null}

          {!filteredActions.length && !matchedAgents.length && !matchedDevices.length ? (
            <div className="faint" style={{ textAlign: "center", padding: "20px 0" }}>
              没有找到匹配项
            </div>
          ) : null}
        </div>
      </div>
    </PocketDialog>
  );
}
