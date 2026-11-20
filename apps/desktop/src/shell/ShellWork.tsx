import { Suspense, lazy, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ExternalLink, File, FileText, FolderTree, Globe, Laptop, Layers, Mic, Plus, Sparkles, SquareArrowOutUpRight, X } from "lucide-react";
import type { Agent } from "@herdr-pocket/protocol";
import { PocketButton, PocketSelect, overlayStore, useToast } from "../components/PocketUI";
import { XiaoyangOrb, VendorIcon } from "../components/MascotAndVendor";
import { serverLabel } from "../components/Sidebar";
import { prettyHotkey } from "../components/VoiceInput";
import { AgentDetailPanel } from "../views/AgentsView";
import { FileTree, FileViewer, WebPane } from "../views/WorkbenchView";
import { copyToClipboard } from "../lib/bridge";
import { useClientConfig } from "../lib/config";
import { isMockServer } from "../lib/mock";
import { native } from "../lib/native";
import { pingRelay } from "../lib/relay";
import { agentSpace, agentTitle, allAgents, liveStore, settingsStore, spacedTitle } from "../lib/store";
import { homeFolder, listGroup } from "./agentInfo";
import { StatusMark } from "./ShellSidebar";
import {
  closeTab,
  openAgentTab,
  openFileTab,
  openWebTab,
  setActiveTab,
  setPalette,
  setPanelWidth,
  setPeek,
  shellStore,
  showPanel,
  togglePanel,
  updateWebTab,
  type PanelId,
  type ShellTab,
} from "./shellStore";
import { comboText, shortcutText, SHORTCUTS } from "./shortcuts";

const AssistantView = lazy(() => import("../views/AssistantView").then((m) => ({ default: m.AssistantView })));

function useAgent(key: string | null | undefined): Agent | undefined {
  return liveStore.use((s) => (key ? allAgents(s.agents).find((a) => a.key === key) : undefined));
}

/** Closes a tab; a web tab's native view goes with it. */
export function closeShellTab(tab: ShellTab): void {
  if (tab.kind === "web") void native.browserClose(tab.id);
  closeTab(tab.id);
}

// Tabs bar ---------------------------------------------------------------------

function TabChip({ tab, active, onMenu }: { tab: ShellTab; active: boolean; onMenu: (e: ReactMouseEvent, tab: ShellTab) => void }) {
  const agent = useAgent(tab.kind === "agent" ? tab.agentKey : null);
  const devices = liveStore.use((s) => s.devices);
  const group = agent ? listGroup(agent, devices) : null;
  const title =
    tab.kind === "agent" ? (agent ? agentTitle(agent) : "已结束的 Agent") : tab.title === "about:blank" ? "新网页" : tab.title;
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`v3-tab${active ? " active" : ""}${tab.kind === "agent" && !agent ? " gone" : ""}`}
      title={tab.kind === "agent" ? (agent ? spacedTitle(agent) : title) : tab.kind === "file" ? tab.path : tab.url}
      onClick={() => setActiveTab(tab.id)}
      onAuxClick={(e) => e.button === 1 && closeShellTab(tab)}
      onContextMenu={(e) => onMenu(e, tab)}
    >
      {tab.kind === "agent" ? (
        agent ? <VendorIcon harness={agent.harness} isShell={agent.isShell} size={14} /> : <File size={14} />
      ) : tab.kind === "file" ? (
        <FileText size={14} />
      ) : (
        <Globe size={14} />
      )}
      <span className="v3-tab-label truncate">{title}</span>
      {group === "working" ? <span className="v3-spinner small" aria-label="运行中" /> : null}
      {group === "blocked" ? <span className="v3-dot blocked" aria-label="需要你" /> : null}
      {group === "done" ? <span className="v3-dot done" aria-label="已完成" /> : null}
      <button
        className="v3-tab-x"
        aria-label={`关闭 ${title}`}
        title={`关闭（${shortcutText("closeTab")}）`}
        onClick={(e) => {
          e.stopPropagation();
          closeShellTab(tab);
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
}

function Popup({ x, y, onClose, children, width = 220 }: { x: number; y: number; onClose: () => void; children: React.ReactNode; width?: number }) {
  useEffect(() => {
    const off = () => onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", off);
    window.addEventListener("blur", off);
    window.addEventListener("keydown", esc);
    overlayStore.set((p) => ({ open: p.open + 1 }));
    return () => {
      window.removeEventListener("pointerdown", off);
      window.removeEventListener("blur", off);
      window.removeEventListener("keydown", esc);
      overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
    };
  }, [onClose]);
  return (
    <div
      className="ctx-menu v3-popup"
      role="menu"
      // Menus open inside the tabs bar, which is a drag region: a press on a menu's padding must not move the window.
      data-tauri-drag-region="false"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - width - 8)), top: Math.min(y, window.innerHeight - 200), width }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function MenuItem({ label, keys, icon: Icon, onClick, disabled }: { label: string; keys?: string; icon?: typeof Plus; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="menu-item v3-menu-item" role="menuitem" disabled={disabled} onClick={onClick}>
      {Icon ? <Icon size={14} /> : null}
      <span className="grow">{label}</span>
      {keys ? <span className="v3-keys-text">{keys}</span> : null}
    </button>
  );
}

export function ShellTabs({ onNewAgent, padForLights }: { onNewAgent: () => void; padForLights: boolean }) {
  const toast = useToast();
  const tabs = shellStore.use((s) => s.tabs);
  const active = shellStore.use((s) => s.active);
  const panel = shellStore.use((s) => s.panel);
  const homePage = useClientConfig().browser.homePage;
  const [menu, setMenu] = useState<{ x: number; y: number; tab: ShellTab } | null>(null);
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the active chip in view, as Herdr does.
  useEffect(() => {
    scrollRef.current?.querySelector<HTMLElement>(".v3-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  const panelBtn = (id: PanelId, label: string, Icon: typeof Plus, keys?: string) => (
    <button
      className={`v3-panel-btn${panel === id ? " on" : ""}`}
      aria-pressed={panel === id}
      title={keys ? `${label}（${keys}）` : label}
      onClick={() => togglePanel(id)}
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  );

  return (
    <div className={`v3-tabs${padForLights ? " lights" : ""}`} data-tauri-drag-region="deep">
      <div
        ref={scrollRef}
        className="v3-tab-scroll"
        role="tablist"
        aria-label="标签"
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {tabs.map((t) => (
          <TabChip key={t.id} tab={t} active={t.id === active} onMenu={(e, tab) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, tab }))} />
        ))}
      </div>
      <button
        className="v3-icon-btn"
        aria-label="新建"
        title="新建 Agent、网页或文件"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setNewMenu(newMenu ? null : { x: r.left, y: r.bottom + 4 });
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Plus size={16} />
      </button>
      <div className="v3-tabs-right">
        {panelBtn("files", "文件", FolderTree, shortcutText("togglePanel"))}
        {panelBtn("browser", "浏览器", Globe)}
        {panelBtn("assistant", "小羊", Sparkles, shortcutText("assistant"))}
      </div>

      {newMenu ? (
        <Popup x={newMenu.x} y={newMenu.y} onClose={() => setNewMenu(null)}>
          <MenuItem label="新建 Agent" icon={Plus} keys={shortcutText("newAgent")} onClick={() => (setNewMenu(null), onNewAgent())} />
          <MenuItem label="打开网页" icon={Globe} onClick={() => (setNewMenu(null), openWebTab(homePage || "about:blank"))} />
          <MenuItem label="打开文件" icon={FolderTree} onClick={() => (setNewMenu(null), showPanel("files"))} />
        </Popup>
      ) : null}
      {menu ? (
        <Popup x={menu.x} y={menu.y} onClose={() => setMenu(null)} width={190}>
          <MenuItem label="关闭" keys={shortcutText("closeTab")} onClick={() => (setMenu(null), closeShellTab(menu.tab))} />
          <MenuItem
            label="关闭其他"
            disabled={tabs.length < 2}
            onClick={() => {
              setMenu(null);
              for (const t of tabs) if (t.id !== menu.tab.id) closeShellTab(t);
            }}
          />
          <MenuItem
            label="关闭右侧"
            disabled={tabs.findIndex((t) => t.id === menu.tab.id) === tabs.length - 1}
            onClick={() => {
              setMenu(null);
              const i = tabs.findIndex((t) => t.id === menu.tab.id);
              for (const t of tabs.slice(i + 1)) closeShellTab(t);
            }}
          />
          {menu.tab.kind !== "agent" ? <div className="menu-sep" /> : null}
          {menu.tab.kind === "file" ? (
            <MenuItem label="复制路径" onClick={() => (setMenu(null), void copyToClipboard((menu.tab as { path: string }).path).then((ok) => toast(ok ? "路径已复制" : "复制失败", !ok)))} />
          ) : null}
          {menu.tab.kind === "web" ? (
            <MenuItem label="复制网址" onClick={() => (setMenu(null), void copyToClipboard((menu.tab as { url: string }).url).then((ok) => toast(ok ? "网址已复制" : "复制失败", !ok)))} />
          ) : null}
        </Popup>
      ) : null}
    </div>
  );
}

// Panes ----------------------------------------------------------------------------

function PaneHead({ tab, agent, onClose }: { tab: ShellTab; agent: Agent | undefined; onClose: () => void }) {
  const devices = liveStore.use((s) => s.devices);
  const group = agent ? listGroup(agent, devices) : null;
  let icon: React.ReactNode;
  let name: string;
  let sub: string;
  if (tab.kind === "agent") {
    icon = agent ? <VendorIcon harness={agent.harness} isShell={agent.isShell} size={14} /> : <File size={14} />;
    name = agent ? spacedTitle(agent) : "这个 Agent 已经结束了";
    sub = agent ? homeFolder(agent.cwd) || agent.where || "" : "";
  } else if (tab.kind === "file") {
    icon = <FileText size={14} />;
    name = tab.title;
    sub = tab.path === tab.title ? "" : tab.path;
  } else {
    icon = <Globe size={14} />;
    name = tab.title === "about:blank" ? "新网页" : tab.title;
    sub = tab.url === "about:blank" ? "" : tab.url;
  }
  return (
    <div className="v3-pane-head">
      {icon}
      <span className="v3-pane-name truncate">{name}</span>
      <span className="v3-pane-sub truncate" title={sub}>{sub}</span>
      {group && group !== "idle" && group !== "offline" ? <StatusMark group={group} /> : null}
      {group === "offline" ? <span className="v3-pane-off">电脑离线</span> : null}
      <button className="v3-icon-btn small hover-only" aria-label="关闭标签" title={`关闭标签（${shortcutText("closeTab")}）`} onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}

function AgentPane({ tab, agentKey }: { tab: ShellTab; agentKey: string }) {
  const agent = useAgent(agentKey);
  return (
    <section className="v3-pane" aria-label={agent ? spacedTitle(agent) : "Agent"}>
      <PaneHead tab={tab} agent={agent} onClose={() => closeShellTab(tab)} />
      <div className="v3-pane-body">
        {agent ? (
          <AgentDetailPanel
            key={agent.key}
            agent={agent}
            embedded
            onBack={() => closeShellTab(tab)}
            onOpenWorkbench={() => showPanel("files")}
          />
        ) : (
          <div className="v3-pane-empty">
            <p>这个 Agent 已经结束，或者它的电脑离线了。</p>
            <PocketButton size="sm" variant="soft" onClick={() => closeShellTab(tab)}>
              关闭标签
            </PocketButton>
          </div>
        )}
      </div>
    </section>
  );
}

function EmptyMain({ onNewAgent }: { onNewAgent: () => void }) {
  const homePage = useClientConfig().browser.homePage;
  const rows: Array<{ label: string; keys?: string; run: () => void }> = [
    { label: "新建 Agent", keys: shortcutText("newAgent"), run: onNewAgent },
    { label: "打开网页", run: () => openWebTab(homePage || "about:blank") },
    { label: "命令面板", keys: shortcutText("palette"), run: () => setPalette("command") },
  ];
  return (
    <section className="v3-pane v3-pane-blank" aria-label="没有打开的标签">
      <div className="v3-blank">
        <div className="v3-blank-mascot">
          <XiaoyangOrb mood="hello" size={72} />
        </div>
        <h2>没有打开的标签</h2>
        <p>在左边的 Agent 列表点一个，它会在这里以标签打开。</p>
        <div className="v3-blank-actions">
          {rows.map((r) => (
            <button key={r.label} className="v3-blank-row" onClick={r.run}>
              <span className="grow">{r.label}</span>
              {r.keys ? <span className="v3-keys-text">{r.keys}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export function ShellMain({ onNewAgent }: { onNewAgent: () => void }) {
  const tabs = shellStore.use((s) => s.tabs);
  const activeId = shellStore.use((s) => s.active);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const fileAgent = useAgent(active?.kind === "file" ? active.agentKey : null);

  return (
    <div className="v3-main">
      {!active ? <EmptyMain onNewAgent={onNewAgent} /> : null}
      {active?.kind === "agent" ? <AgentPane key={active.id} tab={active} agentKey={active.agentKey} /> : null}
      {active?.kind === "file" ? (
        <section className="v3-pane" aria-label={active.title}>
          <PaneHead tab={active} agent={undefined} onClose={() => closeShellTab(active)} />
          <div className="v3-pane-body">
            <FileViewer key={active.id} tab={active} agent={fileAgent} />
          </div>
        </section>
      ) : null}
      {/* Web pages stay mounted so their native views keep their pages. */}
      {tabs.map((t) =>
        t.kind === "web" ? (
          <section key={t.id} className="v3-pane" aria-label={t.title} style={{ display: t.id === activeId ? undefined : "none" }}>
            <PaneHead tab={t} agent={undefined} onClose={() => closeShellTab(t)} />
            <div className="v3-pane-body">
              <WebPane tab={t} active={t.id === activeId} onChange={(patch) => updateWebTab(t.id, patch)} />
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}

// Side panel -----------------------------------------------------------------------

const PANEL_TITLE: Record<PanelId, string> = { files: "文件", browser: "浏览器", assistant: "小羊" };

function FilesPanel() {
  const tabs = shellStore.use((s) => s.tabs);
  const activeId = shellStore.use((s) => s.active);
  const agentsMap = liveStore.use((s) => s.agents);
  const devices = liveStore.use((s) => s.devices);
  const withFolder = useMemo(() => allAgents(agentsMap).filter((a) => a.cwd && !a.isShell), [agentsMap]);
  const active = tabs.find((t) => t.id === activeId);
  const followKey = active?.kind === "agent" || active?.kind === "file" ? active.agentKey : null;
  const [picked, setPicked] = useState<string | null>(null);
  // Follows the active tab's agent; a pick in the menu holds until the tab changes.
  useEffect(() => setPicked(null), [followKey]);
  const agent = withFolder.find((a) => a.key === (picked ?? followKey)) ?? withFolder[0];

  if (!agent) return <div className="v3-empty-line">还没有带工作目录的 Agent。开一个 Agent 后，这里会列出它的文件。</div>;
  return (
    <div className="v3-files">
      <div className="v3-files-pick">
        <PocketSelect
          value={agent.key}
          onValueChange={setPicked}
          options={withFolder.map((a) => ({ value: a.key, label: `${devices[a.deviceId]?.name ?? a.deviceId} · ${spacedTitle(a)}` }))}
        />
      </div>
      <FileTree key={agent.key} agent={agent} onOpen={(path, name) => openFileTab(agent.key, path, name)} />
    </div>
  );
}

const PANEL_WEB_ID = "panel-web";

function BrowserPanel() {
  const homePage = useClientConfig().browser.homePage;
  const [url, setUrl] = useState(homePage || "about:blank");
  return (
    <div className="v3-panel-web">
      <WebPane tab={{ id: PANEL_WEB_ID, url: homePage || "about:blank" }} active onChange={(p) => p.url && setUrl(p.url)} />
      <button className="v3-mini-btn v3-panel-web-pop" onClick={() => openWebTab(url, url)} title="在标签里打开这个网页">
        <SquareArrowOutUpRight size={12} />
        <span>在标签中打开</span>
      </button>
    </div>
  );
}

export function ShellPanel() {
  const panel = shellStore.use((s) => s.panel);
  const width = shellStore.use((s) => s.panelWidth);
  const drag = useRef<{ x: number; w: number } | null>(null);

  // The browser panel's native view closes with the panel.
  useEffect(() => {
    if (panel !== "browser") void native.browserClose(PANEL_WEB_ID).catch(() => undefined);
  }, [panel]);

  if (!panel) return null;
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current) setPanelWidth(drag.current.w + (drag.current.x - e.clientX));
  };
  const onUp = () => {
    drag.current = null;
  };

  return (
    <aside className="v3-panel" style={{ width }} aria-label={PANEL_TITLE[panel]}>
      <div
        className="v3-panel-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整面板宽度"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={() => setPanelWidth(368)}
      />
      <div className="v3-pane-head">
        {panel === "files" ? <FolderTree size={14} /> : panel === "browser" ? <Globe size={14} /> : <Sparkles size={14} />}
        <span className="v3-pane-name grow">{PANEL_TITLE[panel]}</span>
        <button className="v3-icon-btn small" aria-label="关闭面板" onClick={() => showPanel(null)}>
          <X size={13} />
        </button>
      </div>
      <div className={`v3-pane-body v3-panel-body ${panel}`}>
        {panel === "files" ? <FilesPanel /> : null}
        {panel === "browser" ? <BrowserPanel /> : null}
        {panel === "assistant" ? (
          <Suspense fallback={<div className="v3-empty-line">正在打开小羊…</div>}>
            <AssistantView onOpenAgent={openAgentTab} />
          </Suspense>
        ) : null}
      </div>
    </aside>
  );
}

// Status bar -----------------------------------------------------------------------

export function ShellStatus({ onConnectRelay }: { onConnectRelay: () => void }) {
  const link = liveStore.use((s) => s.link);
  const devices = liveStore.use((s) => s.devices);
  const agentsMap = liveStore.use((s) => s.agents);
  const server = settingsStore.use((s) => s.server);
  const showShells = settingsStore.use((s) => s.showShells);
  const activeTab = shellStore.use((s) => s.tabs.find((t) => t.id === s.active) ?? null);
  const voice = useClientConfig().voiceInput;
  const agent = useAgent(activeTab && activeTab.kind !== "web" ? activeTab.agentKey : null);

  const all = useMemo(() => allAgents(agentsMap).filter((a) => showShells || !a.isShell), [agentsMap, showShells]);
  const blocked = all.filter((a) => listGroup(a, devices) === "blocked").length;
  const host = agent ? devices[agent.deviceId] : Object.values(devices).find((d) => d.kind === "host" && d.online);
  const space = agent ? agentSpace(agent) : undefined;
  const demo = isMockServer(server);

  const linkText = !server
    ? "未连接中转服务器"
    : link === "online"
      ? demo
        ? "演示模式"
        : `已连接 ${serverLabel(server)}`
      : link === "connecting"
        ? "正在连接…"
        : link === "unauthorized"
          ? "授权失效，点这里重新连接"
          : "已断开，点这里重连";
  const linkTone = link === "online" ? "ok" : link === "connecting" ? "warn" : "off";

  return (
    <footer className="v3-status">
      <span className="v3-status-item" title={host ? (host.online ? `${host.name} 在线` : `${host.name} 离线`) : undefined}>
        <Laptop size={13} />
        <span className="truncate">{host?.name ?? "还没有电脑"}</span>
      </span>
      {space ? (
        <span className="v3-status-item" title="空间">
          <Layers size={13} />
          <span className="truncate">{space}</span>
        </span>
      ) : null}
      <span className="v3-status-item">
        <span className="v3-dot dim" />
        <span>{all.length} 个 Agent</span>
        {blocked ? <span className="v3-status-need">· {blocked} 个需要你</span> : null}
      </span>
      <span className="grow" />
      <button
        className="v3-status-item v3-status-btn"
        onClick={() => (!server || link === "unauthorized" ? onConnectRelay() : link === "online" ? undefined : pingRelay())}
        title={link === "online" ? undefined : "点这里处理连接"}
      >
        <span className={`v3-dot ${linkTone}`} />
        <span className="truncate">{linkText}</span>
      </button>
      {voice.enabled && native.voiceSupported() ? (
        <span className="v3-status-item" title="语音输入">
          <Mic size={13} />
          <span>{voice.mode === "toggle" ? "按" : "按住"} {prettyHotkey(voice.hotkey)} 说话</span>
        </span>
      ) : null}
      <button className="v3-status-item v3-status-btn" onClick={() => setPalette("command")} title="打开命令面板">
        <span className="v3-keys-text">{comboText(SHORTCUTS[0]!.keys)}</span>
        <span>命令</span>
      </button>
    </footer>
  );
}

// Peek -----------------------------------------------------------------------------

/** An agent shown over the work area without opening a tab (Herdr's peek). */
export function PeekOverlay() {
  const key = shellStore.use((s) => s.peek);
  const agent = useAgent(key);
  useEffect(() => {
    if (!key) return;
    overlayStore.set((p) => ({ open: p.open + 1 }));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPeek(null);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("keydown", esc);
      overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
    };
  }, [key]);
  if (!key) return null;
  return (
    <div className="v3-peek-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setPeek(null)}>
      <section className="v3-pane v3-peek" role="dialog" aria-label="预览 Agent">
        <div className="v3-pane-head">
          {agent ? <VendorIcon harness={agent.harness} isShell={agent.isShell} size={14} /> : null}
          <span className="v3-pane-name truncate">{agent ? spacedTitle(agent) : "这个 Agent 已经结束了"}</span>
          <span className="v3-pane-sub truncate">{agent ? homeFolder(agent.cwd) : ""}</span>
          {agent ? (
            <button className="v3-mini-btn" onClick={() => openAgentTab(agent.key)}>
              <ExternalLink size={12} />
              <span>保留为标签</span>
            </button>
          ) : null}
          <button className="v3-icon-btn small" aria-label="关闭预览" title="关闭（Esc）" onClick={() => setPeek(null)}>
            <X size={13} />
          </button>
        </div>
        <div className="v3-pane-body">{agent ? <AgentDetailPanel key={agent.key} agent={agent} embedded onBack={() => setPeek(null)} /> : null}</div>
      </section>
    </div>
  );
}
