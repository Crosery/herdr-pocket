import { useEffect, useRef, useState } from "react";
import { Bell, Check, ArrowRight, X } from "lucide-react";
import type { AgentStatus } from "@herdr-pocket/protocol";
import { playAttentionChime } from "../lib/alertSound";
import { allAgents, liveStore, settingsStore, spacedTitle } from "../lib/store";
import { activeTabIdForSpace, openAgentTab, shellStore, tabLeaves } from "../shell/shellStore";
import { XiaoyangOrb } from "./MascotAndVendor";

const LONG_TASK_MS = 45_000;
const AUTO_HIDE_MS = 5200;

interface DropletNotice {
  id: string;
  agentKey: string;
  title: string;
  subtitle: string;
  kind: "blocked" | "done";
}

export function PocketDroplet() {
  const notifications = settingsStore.use((s) => s.notifications);
  const agentsMap = liveStore.use((s) => s.agents);
  const spacesMap = liveStore.use((s) => s.spaces);
  const [notice, setNotice] = useState<DropletNotice | null>(null);
  const seededRef = useRef(false);
  const prevStatusRef = useRef<Map<string, AgentStatus>>(new Map());
  const workStartedAtRef = useRef<Map<string, number>>(new Map());
  const hideTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearHide = () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
    const showNotice = (next: DropletNotice) => {
      clearHide();
      setNotice(next);
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        setNotice((cur) => (cur?.id === next.id ? null : cur));
      }, AUTO_HIDE_MS);
    };

    const all = allAgents(agentsMap);
    const now = Date.now();
    if (!seededRef.current) {
      seededRef.current = true;
      for (const a of all) {
        prevStatusRef.current.set(a.key, a.status);
        if (a.status === "working") {
          workStartedAtRef.current.set(a.key, a.statusSince ?? now);
        }
      }
      return;
    }

    const s = shellStore.get();
    const byKey = new Map(all.map((a) => [a.key, a] as const));
    const activeTabId = activeTabIdForSpace(s, (k) => byKey.get(k), spacesMap);
    const activeTab = s.tabs.find((t) => t.id === activeTabId) ?? null;
    const focusedAgentKeys = new Set<string>();
    if (activeTab) {
      for (const leaf of tabLeaves(activeTab)) {
        if (leaf.content.kind === "agent") focusedAgentKeys.add(leaf.content.agentKey);
      }
    }

    for (const a of all) {
      const prev = prevStatusRef.current.get(a.key);
      prevStatusRef.current.set(a.key, a.status);

      if (a.status === "working") {
        if (!workStartedAtRef.current.has(a.key)) {
          workStartedAtRef.current.set(a.key, a.statusSince ?? now);
        }
        continue;
      }

      const workStart = workStartedAtRef.current.get(a.key);
      if (a.status === "done" || a.status === "idle" || a.status === "blocked") {
        workStartedAtRef.current.delete(a.key);
      }

      if (!prev || prev === a.status || focusedAgentKeys.has(a.key)) continue;

      if (a.status === "blocked") {
        playAttentionChime("blocked");
        if (notifications) {
          showNotice({
            id: `${a.key}:blocked:${now}`,
            agentKey: a.key,
            title: spacedTitle(a),
            subtitle: a.statusNote?.trim() || "等待你的确认或输入",
            kind: "blocked",
          });
        }
        break;
      }

      if (a.status === "done" && prev === "working") {
        const elapsed = workStart ? Math.max(0, now - workStart) : 0;
        if (elapsed >= LONG_TASK_MS) {
          playAttentionChime("done", elapsed);
          if (notifications) {
            showNotice({
              id: `${a.key}:done:${now}`,
              agentKey: a.key,
              title: spacedTitle(a),
              subtitle: `已完成（耗时 ${Math.max(1, Math.round(elapsed / 1000))} 秒）`,
              kind: "done",
            });
          }
          break;
        }
      }
    }
    return undefined;
  }, [agentsMap, notifications, spacesMap]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, []);

  if (!notice) return null;

  return (
    <div className="v3-droplet-wrap" role="status" aria-live="polite">
      <div className={`v3-droplet${notice.kind === "blocked" ? " is-blocked" : " is-done"}`}>
        <XiaoyangOrb mood={notice.kind === "blocked" ? "waiting" : "idle"} size={22} />
        <button
          type="button"
          className="v3-droplet-main"
          onClick={() => {
            openAgentTab(notice.agentKey);
            setNotice(null);
          }}
        >
          <span className="v3-droplet-tag">
            {notice.kind === "blocked" ? <Bell size={11} /> : <Check size={11} />}
            <span>{notice.kind === "blocked" ? "需要你" : "已完成"}</span>
          </span>
          <span className="v3-droplet-title truncate">{notice.title}</span>
          <span className="v3-droplet-sub truncate">{notice.subtitle}</span>
          <ArrowRight size={12} />
        </button>
        <button
          type="button"
          className="v3-droplet-close"
          aria-label="关闭提醒胶囊"
          onClick={() => setNotice(null)}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
