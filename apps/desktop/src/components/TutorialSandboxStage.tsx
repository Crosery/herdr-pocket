import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  Columns2,
  Compass,
  FolderPlus,
  Laptop,
  LayoutPanelLeft,
  PanelTop,
  QrCode,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { createStore } from "../lib/store";
import { closeSettingsFrame, openSettingsFrame, shellStore } from "../shell/shellStore";
import { PocketButton, overlayStore } from "./PocketUI";
import "../styles/tutorial.css";

export type TutorialMode = "auto" | "replay";

export const tutorialReplayStore = createStore<{ open: boolean }>({ open: false });

export function openInteractiveTutorialReplay(): void {
  tutorialReplayStore.set({ open: true });
}

export function closeInteractiveTutorialReplay(): void {
  tutorialReplayStore.set({ open: false });
}

function dispatchTourCommand(action: string, extra?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("pocket:tour-command", { detail: { action, ...extra } }));
}

interface TargetRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface LiveDomFlags {
  settingsOpen: boolean;
  settingsSection: string | null;
  addDeviceOpen: boolean;
  pairPhoneOpen: boolean;
  createModalOpen: boolean;
  tabsNewMenuOpen: boolean;
  hasOpenPane: boolean;
  rightPanelOpen: boolean;
  mobileTab: string;
}

interface ResolvedStepView {
  id: string;
  badge: string;
  icon: typeof Laptop;
  title: string;
  body: string;
  points?: string[];
  actionHint: string;
  /** Whether the user already triggered the real UI for this step (green confirmed pill). */
  triggered: boolean;
  /** CSS selector(s) in priority order to spotlight a REAL mounted DOM element. */
  selectors: string[];
  /** Optional list of selectors whose bounding boxes are unioned into one combined spotlight hole. */
  unionSelectors?: string[];
  /** Extra padding around the spotlight hole (smaller for modals, larger for small buttons). */
  pad?: number;
  /** Optional quick button inside the card that performs the real UI action for the user. */
  assistAction?: { label: string; run: () => void };
}

function queryVisibleTarget(selectors: string[]): HTMLElement | null {
  if (typeof document === "undefined") return null;
  for (const sel of selectors) {
    const nodes = document.querySelectorAll<HTMLElement>(sel);
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      if (r.width >= 6 && r.height >= 6) {
        const style = window.getComputedStyle(el);
        if (style.display !== "none" && style.visibility !== "hidden") {
          return el;
        }
      }
    }
  }
  return null;
}

function measureLiveFlags(mobileTab: string): LiveDomFlags {
  const settingsFrame = shellStore.get().settings;
  const panel = shellStore.get().panel;
  const hasVisible = (sel: string) => queryVisibleTarget([sel]) !== null;
  return {
    settingsOpen: Boolean(settingsFrame) && hasVisible('[data-tour="settings-frame"]'),
    settingsSection: settingsFrame,
    addDeviceOpen: hasVisible('[data-tour="add-device-modal"]'),
    pairPhoneOpen: hasVisible('[data-tour="pair-phone-modal"]'),
    createModalOpen: hasVisible('[data-tour="create-agent-modal"]'),
    tabsNewMenuOpen: hasVisible('[data-tour="tabs-new-popup"]'),
    hasOpenPane: hasVisible('[data-tour="pane-actions"]'),
    rightPanelOpen: Boolean(panel) && hasVisible('[data-tour="shell-panel"]'),
    mobileTab,
  };
}

const DESKTOP_STEP_COUNT = 7;
const MOBILE_STEP_COUNT = 4;

function resolveDesktopStep(
  step: number,
  flags: LiveDomFlags,
  ctx: { isDemo: boolean; groupingTouched: boolean; paneTouched: boolean },
): ResolvedStepView {
  switch (step) {
    case 0: {
      // Step 1: 添加电脑 / 管理设备
      if (flags.addDeviceOpen) {
        return {
          id: "desktop-add-device-modal",
          badge: "添加电脑与设备",
          icon: Laptop,
          title: "新设备就是在这里接入的",
          body: "这就是「添加新设备」真实弹窗，里面的按钮都可以直接操作：",
          points: [
            "接入电脑 (Host)：复制下方安装命令，贴到另一台 Mac / Windows / Linux 终端运行即可上线",
            "接入手机 / 桌面端：切到右侧标签生成 30 分钟有效的二维码与配对码",
          ],
          actionHint: "已打开真实添加设备窗口，看完点「下一步」继续",
          triggered: true,
          selectors: ['[data-tour="add-device-modal"]'],
          pad: 4,
        };
      }
      if (flags.settingsOpen && flags.settingsSection === "machines") {
        return {
          id: "desktop-machines-pane",
          badge: "添加电脑与设备",
          icon: Laptop,
          title: "点「+ 添加电脑」获取安装命令与配对码",
          body: "「电脑与中继」集中管理你接入的所有运行主机与移动端，也支持 Herdr ↔ Herdr Core 空间无感同步。",
          actionHint: "点击高亮的「+ 添加电脑」按钮打开真实配对窗口",
          triggered: false,
          selectors: ['[data-tour="machines-add-computer"]', '[data-tour="settings-frame"]'],
          pad: 6,
          assistAction: {
            label: "打开添加电脑弹窗",
            run: () => dispatchTourCommand("openAddComputer"),
          },
        };
      }
      const targetSel = ctx.isDemo
        ? ['[data-tour="sidebar-settings"]', '[data-tour="sidebar-server"]']
        : ['[data-tour="sidebar-server"]', '[data-tour="sidebar-settings"]'];
      return {
        id: "desktop-machines-entry",
        badge: "添加电脑与设备",
        icon: Laptop,
        title: "先认识设备入口：把电脑接进来",
        body: "Agent 运行在你自己的电脑上。从左下角进入「电脑与中继」，可以随时查看在线电脑并把更多电脑加入同一个工作台。",
        actionHint: ctx.isDemo
          ? "点左下角高亮按钮（或下方「帮我打开」）进入「电脑与中继」"
          : "点击左下角高亮的服务器入口，打开「电脑与中继」",
        triggered: false,
        selectors: targetSel,
        pad: 5,
        assistAction: {
          label: "打开「电脑与中继」",
          run: () => dispatchTourCommand("openMachinesSettings"),
        },
      };
    }

    case 1: {
      // Step 2: 手机扫码连接设备
      if (flags.pairPhoneOpen) {
        return {
          id: "desktop-pair-modal",
          badge: "手机扫码配对",
          icon: QrCode,
          title: "扫码后手机就能控制全部在线电脑",
          body: "现在屏幕上展示的就是真实配对二维码：",
          points: [
            "手机端打开 Herdr Pocket 点「扫一扫」，或直接用手机系统相机扫码打开网页端",
            "也可以点「复制链接」发到手机点开；连上后就能随时查看、回复、审批并语音找小羊",
          ],
          actionHint: "已打开真实扫码弹窗，现在就能扫码，或点「下一步」",
          triggered: true,
          selectors: ['[data-tour="pair-phone-modal"]'],
          pad: 4,
        };
      }
      return {
        id: "desktop-pair-entry",
        badge: "手机扫码配对",
        icon: QrCode,
        title: "手机扫码连接对应设备",
        body: "不用手动填地址或配端口。点左下角「扫码连接手机」即可生成当前中转的专属配对码，手机扫一下就能接管你名下所有在线电脑。",
        actionHint: "点击左下角高亮的「扫码连接手机」按钮",
        triggered: false,
        selectors: ['[data-tour="sidebar-pair-phone"]'],
        pad: 5,
        assistAction: {
          label: "打开扫码弹窗",
          run: () => dispatchTourCommand("openPairPhone"),
        },
      };
    }

    case 2: {
      // Step 3: 创建空间（Space）
      if (flags.createModalOpen) {
        return {
          id: "desktop-create-space-modal",
          badge: "创建工作空间",
          icon: FolderPlus,
          title: "选电脑、选项目文件夹、选工具，一键建空间",
          body: "这就是新建空间的真实窗口，按顺序选好就能建出一个独立项目空间：",
          points: [
            "① 选择目标电脑（多台电脑在线时可自由切换）",
            "② 选最近目录或点「选择目录…」挑选文件夹，空间名会自动带出",
            "③ 选择启动普通终端，或直接拉起 Claude Code / Codex / Antigravity 等 AI 工具",
          ],
          actionHint: "可以直接创建，或先看完点「下一步」（右键已有空间可重命名/换图标）",
          triggered: true,
          selectors: ['[data-tour="create-agent-modal"]'],
          pad: 4,
        };
      }
      return {
        id: "desktop-create-space-entry",
        badge: "创建工作空间",
        icon: FolderPlus,
        title: "如何创建空间（Space）",
        body: "每个「空间」对应电脑上的一个项目目录，用来隔离不同项目的标签页和 Agent。点「空间」栏右侧的 `+`（或某台在线电脑行上的 `+`）即可创建。",
        actionHint: "点击左侧「空间」栏旁边高亮的 `+` 按钮",
        triggered: false,
        selectors: ['[data-tour="sidebar-new-space"]', '[data-tour="sidebar-spaces-block"]'],
        pad: 6,
        assistAction: {
          label: "打开新建空间弹窗",
          run: () => dispatchTourCommand("openCreateSpace"),
        },
      };
    }

    case 3: {
      // Step 4: 新建 Tab（终端 / Agent / 网页 / 本地文件）
      if (flags.tabsNewMenuOpen) {
        return {
          id: "desktop-tabs-new-popup",
          badge: "新建 Tab 标签页",
          icon: PanelTop,
          title: "所有新建 Tab 入口都在这个菜单里",
          body: "从上到下可以直接在当前空间新建终端、启动新 Agent、打开内置网页标签或打开本地代码文件。标签支持双击改名和拖拽排序。",
          actionHint: "已展开真实新建菜单，可点任意一项试试，或点「下一步」",
          triggered: true,
          selectors: ['[data-tour="tabs-new-popup"]'],
          pad: 5,
        };
      }
      return {
        id: "desktop-tabs-new-entry",
        badge: "新建 Tab 标签页",
        icon: PanelTop,
        title: "如何新建 Tab 标签页",
        body: "顶部标签栏的 `+` 会直接在当前空间新开一个终端标签页；点旁边的下拉箭头 `▾`（或右键 `+`）可以选择新建终端、新建 Agent、打开网页或打开文件。",
        actionHint: "点击顶栏高亮区域的 `▾` 下拉箭头展开新建菜单",
        triggered: false,
        selectors: ['[data-tour="tabs-new-group"]'],
        pad: 6,
      };
    }

    case 4: {
      // Step 5: 左侧 Agent 列表与状态/空间视角
      return {
        id: "desktop-agents-list",
        badge: "Agent 状态与列表",
        icon: Bot,
        title: "在这里看清每个 Agent 的实时状态",
        body: "所有电脑上的 AI 助手与终端都在左侧汇总：粉色「需要你」表示正等你确认或回答选择题，转圈是运行中，绿点是已完成。点击打开标签，右键可直接向右/向下分屏。",
        actionHint: ctx.groupingTouched
          ? "已切换真实列表视角！看完点「下一步」"
          : "试着点一下高亮区顶部的「状态 / 空间 / 最近」切换视角",
        triggered: ctx.groupingTouched,
        selectors: ['[data-tour="sidebar-agents-block"]'],
        pad: 5,
      };
    }

    case 5: {
      // Step 6: 主工作区：对话/终端翻面、分屏、端口与回传
      if (flags.hasOpenPane) {
        return {
          id: "desktop-pane-actions",
          badge: "对话/终端与分屏",
          icon: Columns2,
          title: "对话 ↔ 终端切换、分屏与监听端口",
          body: "每个真实窗格右上角都集成了高频操作按钮：",
          points: [
            "终端 / 对话图标：在聊天气泡和真实底层终端视图之间一键翻面",
            "向右 / 向下分屏图标：同一标签页内并排对照多个 Agent、终端或网页",
            "跨端回传 & 绿色端口胶囊：AI 启动本地服务或浏览器时一键展开预览",
          ],
          actionHint: ctx.paneTouched
            ? "已体验窗格按钮，点「下一步」看右侧面板"
            : "可以点击高亮区里的「切换终端/对话」按钮试试，或点「下一步」",
          triggered: ctx.paneTouched,
          selectors: [
            '[data-tour="pane-actions"][data-tour-focused="true"]',
            '[data-tour="pane-actions"]',
          ],
          pad: 6,
        };
      }
      return {
        id: "desktop-pane-empty",
        badge: "主工作区与分屏",
        icon: Columns2,
        title: "主工作区：打开后支持对话/终端翻面与分屏",
        body: "当前还没有打开标签页。点击左侧任意 Agent，或直接点这里的新建终端 / 新建 Agent 打开后，窗格右上角就会出现「对话 ↔ 终端翻面」「向右/向下分屏」「跨端回传」和本地端口预览。",
        actionHint: "点击「下一步」看最后一步：右侧四大工具面板",
        triggered: false,
        selectors: ['[data-tour="shell-main-empty"]', ".v3-main"],
        pad: 8,
      };
    }

    default: {
      // Step 7: 右侧面板（文件 / Git / 浏览器 / 小羊）
      if (flags.rightPanelOpen) {
        return {
          id: "desktop-right-panel-open",
          badge: "右侧随手面板",
          icon: LayoutPanelLeft,
          title: "全部核心操作都带你走了一遍",
          body: "你刚才看到的全部是真实工作台界面：文件目录（含语法高亮）、Git Diff、内置浏览器和小羊管家都能随时从右上角拉出。以后想再看一遍，随时在「设置 → 重温新手引导」打开。",
          actionHint: "已打开真实右侧面板，点右上角可切换其他面板，或点下方完成引导",
          triggered: true,
          selectors: ['[data-tour="shell-panel"]'],
          unionSelectors: ['[data-tour="tabs-right-panels"]', '[data-tour="shell-panel"]'],
          pad: 5,
        };
      }
      return {
        id: "desktop-right-panels-entry",
        badge: "右侧随手面板",
        icon: LayoutPanelLeft,
        title: "右侧四大随手面板：文件、Git、浏览器、小羊",
        body: "不用切出应用：点右上角「文件」看项目代码（带语法高亮），点「Git」看改动 Diff，点「浏览器」内置预览网页，点「小羊」一键汇总所有电脑的任务进度并支持语音对话。",
        actionHint: "点击右上角高亮区任意按钮（如「小羊」或「浏览器」）打开试试，或直接点「完成引导」",
        triggered: false,
        selectors: ['[data-tour="tabs-right-panels"]'],
        pad: 6,
      };
    }
  }
}

function resolveMobileStep(step: number, flags: LiveDomFlags): ResolvedStepView {
  switch (step) {
    case 0: {
      if (flags.addDeviceOpen) {
        return {
          id: "mobile-add-device-modal",
          badge: "添加电脑与设备",
          icon: Laptop,
          title: "添加新电脑或配对新设备",
          body: "选「接入电脑 (Host)」复制一行安装命令贴到电脑终端即可上线；切到「接入手机 / 桌面端」可生成二维码与配对码。",
          actionHint: "已打开真实添加设备弹窗，看完点「下一步」",
          triggered: true,
          selectors: ['[data-tour="add-device-modal"]'],
          pad: 4,
        };
      }
      if (flags.pairPhoneOpen) {
        return {
          id: "mobile-pair-modal",
          badge: "配对手机与设备",
          icon: QrCode,
          title: "扫码或复制链接让其他设备加入",
          body: "让新手机扫码，或复制配对链接发到新设备打开，即可接入同一个中转服务器控制所有在线电脑。",
          actionHint: "已打开真实配对弹窗，看完点「下一步」",
          triggered: true,
          selectors: ['[data-tour="pair-phone-modal"]'],
          pad: 4,
        };
      }
      if (flags.mobileTab === "devices") {
        return {
          id: "mobile-devices-actions",
          badge: "添加电脑与扫码配对",
          icon: Laptop,
          title: "在这里添加电脑与配对其他手机",
          body: "点「+ 添加电脑」获取电脑端安装命令和配对码；点「配对手机」生成二维码。下方点任意在线电脑即可只看那台电脑上的 Agent。",
          actionHint: "点高亮区的「+ 添加电脑」或「配对手机」看看，或点「下一步」",
          triggered: true,
          selectors: ['[data-tour="mp-devices-actions"]'],
          pad: 6,
        };
      }
      return {
        id: "mobile-tab-devices",
        badge: "设备管理",
        icon: Laptop,
        title: "第 1 步 · 先到「设备」页看怎么加电脑和配对",
        body: "点击底部「设备」标签，管理所有在线电脑、添加新电脑以及生成配对二维码。",
        actionHint: "点击底部高亮的「设备」标签",
        triggered: false,
        selectors: ['[data-tour="mp-tab-devices"]'],
        pad: 5,
        assistAction: {
          label: "切换到「设备」页",
          run: () => dispatchTourCommand("setMobileTab", { tab: "devices" }),
        },
      };
    }

    case 1: {
      if (flags.createModalOpen) {
        return {
          id: "mobile-create-modal",
          badge: "创建空间与新建任务",
          icon: FolderPlus,
          title: "远程在电脑上建空间、开终端或启动 AI",
          body: "选在线电脑、选项目目录、选终端或 Claude Code / Codex / Antigravity 等工具，就能直接远程启动新任务。",
          actionHint: "已打开真实新建弹窗，看完点「下一步」",
          triggered: true,
          selectors: ['[data-tour="create-agent-modal"]'],
          pad: 4,
        };
      }
      if (flags.mobileTab === "agents") {
        return {
          id: "mobile-agents-fab",
          badge: "Agents 与新建任务",
          icon: Bot,
          title: "看状态、切空间，点右下角「+ 新建」远程开任务",
          body: "左上角菜单可按电脑/空间筛选；点任意 Agent 可直接回复、点选方案或切终端；点右下角「+ 新建」能直接在电脑上新建空间、终端或 AI 助手。",
          actionHint: "点右下角高亮的「+ 新建」按钮看看，或点「下一步」",
          triggered: true,
          selectors: ['[data-tour="mp-agents-fab"]', '[data-tour="mp-agents-drawer-btn"]'],
          pad: 6,
        };
      }
      return {
        id: "mobile-tab-agents",
        badge: "Agents 列表",
        icon: Bot,
        title: "第 2 步 · 切到「Agents」页操作任务与新建",
        body: "点击底部「Agents」标签查看所有电脑上正在干活和等你的 AI 助手。",
        actionHint: "点击底部高亮的「Agents」标签",
        triggered: false,
        selectors: ['[data-tour="mp-tab-agents"]'],
        pad: 5,
        assistAction: {
          label: "切换到「Agents」页",
          run: () => dispatchTourCommand("setMobileTab", { tab: "agents" }),
        },
      };
    }

    case 2: {
      return {
        id: "mobile-tab-assistant",
        badge: "小羊全局助理",
        icon: Sparkles,
        title: "第 3 步 · 找「助理」小羊汇总全部进度",
        body: "电脑上同时跑十几个任务也不用挨个翻。切到「助理」页，小羊会自动汇总待办提醒，还支持直接发消息或语音通话下指令。",
        actionHint:
          flags.mobileTab === "assistant"
            ? "已进入真实「助理」页，点「下一步」看最后一步"
            : "点击底部高亮的「助理」标签进入看看",
        triggered: flags.mobileTab === "assistant",
        selectors: ['[data-tour="mp-tab-assistant"]'],
        pad: 5,
        assistAction:
          flags.mobileTab === "assistant"
            ? undefined
            : {
                label: "切换到「助理」页",
                run: () => dispatchTourCommand("setMobileTab", { tab: "assistant" }),
              },
      };
    }

    default: {
      if (flags.mobileTab === "settings") {
        return {
          id: "mobile-settings-tutorial",
          badge: "设置与随时重温",
          icon: Settings,
          title: "以后想再看一遍，随时在「设置」里打开",
          body: "设置页里可以管理中转连接、通行密钥唯一身份锁、主题外观和组件更新。点这里随时可以重温本次真实界面引导。",
          actionHint: "准备好了就点下方按钮完成引导",
          triggered: true,
          selectors: ['[data-tour="mp-settings-tutorial"]', '[data-tour="mp-tab-settings"]'],
          pad: 6,
        };
      }
      return {
        id: "mobile-tab-settings",
        badge: "设置与重温入口",
        icon: Settings,
        title: "最后一步 · 认识「设置」与重温入口",
        body: "点底部「设置」可以随时管理服务器连接、主题和重温新手引导。",
        actionHint: "点击底部高亮的「设置」标签，或直接点「完成引导」",
        triggered: false,
        selectors: ['[data-tour="mp-tab-settings"]'],
        pad: 5,
        assistAction: {
          label: "切换到「设置」页",
          run: () => dispatchTourCommand("setMobileTab", { tab: "settings" }),
        },
      };
    }
  }
}

function rectsOverlapArea(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
): number {
  const x = Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left));
  const y = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
  return x * y;
}

function computeCardPlacement(
  rect: TargetRect | null,
  cardW: number,
  cardH: number,
  mobileLayout: boolean,
): { left: number; top: number; width: number } {
  if (typeof window === "undefined") {
    return { left: 16, top: 80, width: cardW };
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 12;
  const gap = 14;
  const w = Math.min(cardW, vw - margin * 2);
  const h = Math.min(cardH, vh - margin * 2);

  if (!rect) {
    return {
      left: Math.round(Math.max(margin, (vw - w) / 2)),
      top: Math.round(Math.max(margin, vh - h - 28)),
      width: w,
    };
  }

  if (mobileLayout || vw < 680) {
    const targetCenterY = rect.top + rect.height / 2;
    const preferTop = targetCenterY > vh * 0.46;
    const aboveTop = rect.top - gap - h;
    const belowTop = rect.top + rect.height + gap;
    let chosenTop: number;
    if (preferTop && aboveTop >= margin) {
      chosenTop = aboveTop;
    } else if (!preferTop && belowTop + h <= vh - margin) {
      chosenTop = belowTop;
    } else if (aboveTop >= margin) {
      chosenTop = aboveTop;
    } else if (belowTop + h <= vh - margin) {
      chosenTop = belowTop;
    } else {
      chosenTop = preferTop ? margin : Math.max(margin, vh - h - 72);
    }
    return {
      left: Math.round(Math.max(margin, (vw - w) / 2)),
      top: Math.round(Math.max(margin, Math.min(vh - h - margin, chosenTop))),
      width: w,
    };
  }

  const clampX = (x: number) => Math.max(margin, Math.min(vw - w - margin, x));
  const clampY = (y: number) => Math.max(margin, Math.min(vh - h - margin, y));

  const candidates = [
    // Right of target (aligned vertically to target center, clamped)
    { left: rect.left + rect.width + gap, top: clampY(rect.top + Math.min(0, rect.height - h) / 2) },
    // Left of target
    { left: rect.left - gap - w, top: clampY(rect.top + Math.min(0, rect.height - h) / 2) },
    // Below target
    { left: clampX(rect.left), top: rect.top + rect.height + gap },
    // Above target
    { left: clampX(rect.left), top: rect.top - gap - h },
  ];

  for (const c of candidates) {
    const inBounds = c.left >= margin && c.left + w <= vw - margin && c.top >= margin && c.top + h <= vh - margin;
    if (inBounds && rectsOverlapArea({ left: c.left, top: c.top, width: w, height: h }, rect) === 0) {
      return { left: Math.round(c.left), top: Math.round(c.top), width: w };
    }
  }

  // Fallback when target is a large modal: pick the viewport corner with least overlap
  // (preferring bottom-right and avoiding covering the modal's top-right close button).
  const modalCloseCorner = {
    left: rect.left + rect.width - 56,
    top: rect.top,
    width: 56,
    height: 56,
  };
  const corners = [
    { left: vw - w - 16, top: vh - h - 16 },
    { left: 16, top: vh - h - 16 },
    { left: 16, top: 16 },
    { left: vw - w - 16, top: 16 },
  ];
  let best = corners[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of corners) {
    const box = { left: clampX(c.left), top: clampY(c.top), width: w, height: h };
    const score = rectsOverlapArea(box, rect) + rectsOverlapArea(box, modalCloseCorner) * 50;
    if (score < bestScore) {
      bestScore = score;
      best = box;
    }
  }
  return { left: Math.round(best.left), top: Math.round(best.top), width: w };
}

export function TutorialSandboxStage({
  mode,
  mobileLayout = false,
  mobileTab = "agents",
  isDemo = false,
  sidebarCollapsed = false,
  canToggleSidebar = false,
  onSetSidebarCollapsed,
  onComplete,
  onSkip,
}: {
  mode: TutorialMode;
  mobileLayout?: boolean;
  mobileTab?: string;
  isDemo?: boolean;
  sidebarCollapsed?: boolean;
  canToggleSidebar?: boolean;
  onSetSidebarCollapsed?: (collapsed: boolean) => void;
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [step, setStep] = useState(0);
  const [exiting, setExiting] = useState(false);
  const [pulseCount, setPulseCount] = useState(0);
  const [groupingTouched, setGroupingTouched] = useState(false);
  const [paneTouched, setPaneTouched] = useState(false);
  const [flags, setFlags] = useState<LiveDomFlags>(() => measureLiveFlags(mobileTab));
  const [rect, setRect] = useState<TargetRect | null>(null);
  const [cardSize, setCardSize] = useState<{ w: number; h: number }>({ w: 356, h: 256 });
  const cardRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledTargetRef = useRef<HTMLElement | null>(null);
  const initialSidebarCollapsedRef = useRef(sidebarCollapsed);
  const initialMobileTabRef = useRef(mobileTab);
  const wasCollapsedByUserRef = useRef(false);

  const totalSteps = mobileLayout ? MOBILE_STEP_COUNT : DESKTOP_STEP_COUNT;
  const clampedStep = Math.min(step, totalSteps - 1);

  // Reset step cleanly if layout mode flips between desktop and mobile mid-tour.
  useEffect(() => {
    setStep(0);
    setGroupingTouched(false);
    setPaneTouched(false);
  }, [mobileLayout]);

  // Expand collapsed desktop sidebar during the walkthrough so real space/agent/QR buttons are visible.
  useEffect(() => {
    if (!mobileLayout && sidebarCollapsed && canToggleSidebar && onSetSidebarCollapsed) {
      wasCollapsedByUserRef.current = true;
      onSetSidebarCollapsed(false);
    }
  }, [canToggleSidebar, mobileLayout, onSetSidebarCollapsed, sidebarCollapsed]);

  // Isolate native Tauri browser sub-WebViews while the spotlight scrim is active.
  useEffect(() => {
    overlayStore.set((p) => ({ open: p.open + 1 }));
    return () => {
      overlayStore.set((p) => ({ open: Math.max(0, p.open - 1) }));
    };
  }, []);

  // Demo mode convenience: if the user clicks footer "设置" on Step 1A, jump straight to "machines".
  const settingsFrameNow = shellStore.use((s) => s.settings);
  useEffect(() => {
    if (!mobileLayout && clampedStep === 0 && isDemo && settingsFrameNow && settingsFrameNow !== "machines") {
      openSettingsFrame("machines");
    }
  }, [clampedStep, isDemo, mobileLayout, settingsFrameNow]);

  const currentView = useMemo(
    () =>
      mobileLayout
        ? resolveMobileStep(clampedStep, flags)
        : resolveDesktopStep(clampedStep, flags, { isDemo, groupingTouched, paneTouched }),
    [clampedStep, flags, groupingTouched, isDemo, mobileLayout, paneTouched],
  );

  // Cleanly close temporary tutorial modals when transitioning or exiting.
  const closeTemporaryModals = useCallback(() => {
    closeSettingsFrame();
    dispatchTourCommand("closeModals");
  }, []);

  const finishAndClose = useCallback(
    (kind: "complete" | "skip") => {
      if (exiting) return;
      setExiting(true);
      closeTemporaryModals();
      if (mode === "replay" && wasCollapsedByUserRef.current && initialSidebarCollapsedRef.current && onSetSidebarCollapsed) {
        onSetSidebarCollapsed(true);
      }
      if (mobileLayout && kind === "complete" && initialMobileTabRef.current === "agents") {
        dispatchTourCommand("setMobileTab", { tab: "agents" });
      }
      window.setTimeout(() => {
        if (kind === "complete") onComplete();
        else onSkip();
      }, 150);
    },
    [closeTemporaryModals, exiting, mobileLayout, mode, onComplete, onSetSidebarCollapsed, onSkip],
  );

  const goToStep = useCallback(
    (nextStep: number) => {
      const bounded = Math.max(0, Math.min(totalSteps - 1, nextStep));
      closeTemporaryModals();
      lastScrolledTargetRef.current = null;
      setStep(bounded);
    },
    [closeTemporaryModals, totalSteps],
  );

  // Track real user clicks inside Step 5 (grouping) & Step 6 (pane toolbar) for instant feedback.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-tour="sidebar-agents-grouping"]')) {
        setGroupingTouched(true);
      }
      if (target.closest('[data-tour="pane-actions"]')) {
        setPaneTouched(true);
      }
    };
    document.addEventListener("click", onDocClick, true);
    return () => document.removeEventListener("click", onDocClick, true);
  }, []);

  // Escape closes an open modal first; if no modal is open, exits the tour cleanly.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const hasRealDialog = Boolean(
        queryVisibleTarget([
          '[data-tour="add-device-modal"]',
          '[data-tour="pair-phone-modal"]',
          '[data-tour="create-agent-modal"]',
          '[data-tour="settings-frame"]',
          '[data-tour="tabs-new-popup"]',
        ]),
      );
      if (hasRealDialog) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      finishAndClose(clampedStep >= totalSteps - 1 ? "complete" : "skip");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [clampedStep, finishAndClose, totalSteps]);

  // Continuously track real DOM state (modals, popups, panels, layout bounds) cleanly via MutationObserver + RAF.
  const syncLiveDom = useCallback(() => {
    const nextFlags = measureLiveFlags(mobileTab);
    setFlags((prev) =>
      prev.settingsOpen === nextFlags.settingsOpen &&
      prev.settingsSection === nextFlags.settingsSection &&
      prev.addDeviceOpen === nextFlags.addDeviceOpen &&
      prev.pairPhoneOpen === nextFlags.pairPhoneOpen &&
      prev.createModalOpen === nextFlags.createModalOpen &&
      prev.tabsNewMenuOpen === nextFlags.tabsNewMenuOpen &&
      prev.hasOpenPane === nextFlags.hasOpenPane &&
      prev.rightPanelOpen === nextFlags.rightPanelOpen &&
      prev.mobileTab === nextFlags.mobileTab
        ? prev
        : nextFlags,
    );
  }, [mobileTab]);

  useEffect(() => {
    syncLiveDom();
    const unsubShell = shellStore.subscribe(syncLiveDom);
    let rafId = 0;
    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        syncLiveDom();
      });
    };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-state", "data-tour"] });
    const interval = window.setInterval(syncLiveDom, 280);
    window.addEventListener("resize", schedule);
    return () => {
      unsubShell();
      mo.disconnect();
      window.clearInterval(interval);
      window.removeEventListener("resize", schedule);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [syncLiveDom]);

  // Measure active target bounding box, scroll instantly into view once per target, and observe target resizes.
  const measureActiveTarget = useCallback(() => {
    const el = queryVisibleTarget(currentView.selectors);
    if (!el) {
      setRect(null);
      return null;
    }
    if (lastScrolledTargetRef.current !== el) {
      lastScrolledTargetRef.current = el;
      const raw = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const scrollParent = el.closest(".sf-main, .v3-block-body, .mp-scroll, .pk-dialog") as HTMLElement | null;
      const clipBox = scrollParent?.getBoundingClientRect();
      const clipped =
        raw.top < 12 ||
        raw.bottom > vh - 12 ||
        raw.left < 0 ||
        raw.right > vw ||
        (clipBox ? raw.top < clipBox.top + 8 || raw.bottom > clipBox.bottom - 8 : false);
      if (clipped) {
        el.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center", inline: "nearest" });
      }
    }
    const r = el.getBoundingClientRect();
    const pad = currentView.pad ?? 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let rawLeft = r.left;
    let rawTop = r.top;
    let rawRight = r.right;
    let rawBottom = r.bottom;
    if (currentView.unionSelectors && currentView.unionSelectors.length > 0) {
      for (const uSel of currentView.unionSelectors) {
        const uEl = queryVisibleTarget([uSel]);
        if (!uEl) continue;
        const ur = uEl.getBoundingClientRect();
        rawLeft = Math.min(rawLeft, ur.left);
        rawTop = Math.min(rawTop, ur.top);
        rawRight = Math.max(rawRight, ur.right);
        rawBottom = Math.max(rawBottom, ur.bottom);
      }
    }
    const left = Math.max(2, Math.round(rawLeft - pad));
    const top = Math.max(2, Math.round(rawTop - pad));
    const right = Math.min(vw - 2, Math.round(rawRight + pad));
    const bottom = Math.min(vh - 2, Math.round(rawBottom + pad));
    const next: TargetRect = {
      left,
      top,
      width: Math.max(20, right - left),
      height: Math.max(20, bottom - top),
    };
    setRect((prev) =>
      prev &&
      Math.abs(prev.left - next.left) < 1 &&
      Math.abs(prev.top - next.top) < 1 &&
      Math.abs(prev.width - next.width) < 1 &&
      Math.abs(prev.height - next.height) < 1
        ? prev
        : next,
    );
    return el;
  }, [currentView.pad, currentView.selectors, currentView.unionSelectors]);

  useLayoutEffect(() => {
    const activeEl = measureActiveTarget();
    let rafId = 0;
    const onTrack = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        measureActiveTarget();
      });
    };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(onTrack) : null;
    if (ro && activeEl) ro.observe(activeEl);
    const t1 = window.setTimeout(measureActiveTarget, 60);
    const t2 = window.setTimeout(measureActiveTarget, 180);
    const poll = window.setInterval(measureActiveTarget, 220);
    window.addEventListener("resize", onTrack);
    window.addEventListener("scroll", onTrack, true);
    return () => {
      ro?.disconnect();
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearInterval(poll);
      window.removeEventListener("resize", onTrack);
      window.removeEventListener("scroll", onTrack, true);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [measureActiveTarget, currentView.id, flags]);

  // Keep actual rendered card size up to date so placement never clips or overlaps.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const update = () => {
      const w = Math.ceil(el.offsetWidth);
      const h = Math.ceil(el.offsetHeight);
      if (w > 40 && h > 40) {
        setCardSize((prev) => (Math.abs(prev.w - w) < 2 && Math.abs(prev.h - h) < 2 ? prev : { w, h }));
      }
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [currentView.id]);

  const cardPos = computeCardPlacement(rect, cardSize.w || 356, cardSize.h || 256, mobileLayout);
  const StepIcon = currentView.icon;
  const isLastStep = clampedStep >= totalSteps - 1;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;

  const pulseSpotlight = () => setPulseCount((c) => c + 1);

  const content = (
    <div
      className={`tour-layer${exiting ? " is-exiting" : ""}`}
      data-tour-ui="true"
      role="region"
      aria-label="Herdr Pocket 实景新手引导"
    >
      {/* 4-panel dim scrim around the live spotlight hole so the REAL app control inside the hole is 100% clickable */}
      {rect ? (
        <>
          <div
            className="tour-scrim-pane"
            style={{ left: 0, top: 0, width: "100vw", height: Math.max(0, rect.top) }}
            onClick={pulseSpotlight}
          />
          <div
            className="tour-scrim-pane"
            style={{
              left: 0,
              top: rect.top + rect.height,
              width: "100vw",
              height: Math.max(0, vh - (rect.top + rect.height)),
            }}
            onClick={pulseSpotlight}
          />
          <div
            className="tour-scrim-pane"
            style={{ left: 0, top: rect.top, width: Math.max(0, rect.left), height: rect.height }}
            onClick={pulseSpotlight}
          />
          <div
            className="tour-scrim-pane"
            style={{
              left: rect.left + rect.width,
              top: rect.top,
              width: Math.max(0, vw - (rect.left + rect.width)),
              height: rect.height,
            }}
            onClick={pulseSpotlight}
          />
          <div
            key={`ring-${currentView.id}-${pulseCount}`}
            className="tour-spotlight-ring"
            style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          />
        </>
      ) : (
        <div className="tour-scrim-pane" style={{ inset: 0 }} onClick={pulseSpotlight} />
      )}

      {/* Floating real-UI coachmark card */}
      <div
        ref={cardRef}
        className="tour-card"
        data-tour-ui="true"
        role="dialog"
        aria-modal="false"
        aria-label={currentView.title}
        style={{ left: cardPos.left, top: cardPos.top, width: cardPos.width }}
      >
        <div className="tour-card-top">
          <span className="tour-step-pill">
            <StepIcon size={12} />
            <span className="num">
              {clampedStep + 1} / {totalSteps}
            </span>
            <span>·</span>
            <span>{currentView.badge}</span>
          </span>
          <button
            type="button"
            className="tour-exit-btn"
            aria-label={mode === "replay" ? "退出引导" : "跳过引导"}
            onClick={() => finishAndClose(mode === "replay" ? "complete" : "skip")}
          >
            <span>{mode === "replay" ? "退出" : "跳过"}</span>
            <X size={13} />
          </button>
        </div>

        <h3 className="tour-card-title">{currentView.title}</h3>
        <p className="tour-card-body">{currentView.body}</p>

        {currentView.points && currentView.points.length > 0 ? (
          <ul className="tour-card-points">
            {currentView.points.map((pt) => (
              <li key={pt}>
                <Check size={12} className="tour-point-ic" />
                <span>{pt}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className={`tour-action-pill${currentView.triggered ? " is-done" : ""}`}>
          {currentView.triggered ? <CheckCircle2 size={13} /> : <Compass size={13} />}
          <span>{currentView.actionHint}</span>
        </div>

        <div className="tour-progress-dots" aria-hidden="true">
          {Array.from({ length: totalSteps }, (_, idx) => (
            <button
              key={idx}
              type="button"
              className={`tour-dot${idx === clampedStep ? " is-cur" : idx < clampedStep ? " is-past" : ""}`}
              title={`跳到第 ${idx + 1} 步`}
              onClick={() => goToStep(idx)}
            />
          ))}
        </div>

        <div className="tour-card-foot">
          <div className="tour-foot-left">
            {clampedStep > 0 ? (
              <PocketButton size="sm" variant="ghost" onClick={() => goToStep(clampedStep - 1)}>
                <ArrowLeft size={13} />
                <span>上一步</span>
              </PocketButton>
            ) : null}
          </div>
          <div className="tour-foot-right">
            {currentView.assistAction ? (
              <PocketButton size="sm" variant="soft" onClick={currentView.assistAction.run}>
                <span>{currentView.assistAction.label}</span>
              </PocketButton>
            ) : null}
            {isLastStep ? (
              <PocketButton size="sm" variant="primary" onClick={() => finishAndClose("complete")}>
                <Check size={13} />
                <span>完成引导</span>
              </PocketButton>
            ) : (
              <PocketButton
                size="sm"
                variant={currentView.assistAction ? "ghost" : "primary"}
                onClick={() => goToStep(clampedStep + 1)}
              >
                <span>下一步</span>
                <ArrowRight size={13} />
              </PocketButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(content, document.body) : content;
}
