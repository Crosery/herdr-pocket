import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

function readSrc(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

test("walkthrough runs strictly on real UI with zero fake sandbox screen markup", () => {
  const tour = readSrc("src/components/TutorialSandboxStage.tsx");
  const css = readSrc("src/styles/tutorial.css");

  assert.doesNotMatch(tour, /tut-sim-sidebar|tut-sim-main|周末活动海报|整理活动宣传页|示例电脑/);
  assert.doesNotMatch(css, /\.tut-sim-/);

  // Must cover all real core flows: add computer/device, phone QR pair, create space, new tab, agents, pane split/mode, right panels
  for (const anchor of [
    "sidebar-server",
    "sidebar-settings",
    "machines-add-computer",
    "add-device-modal",
    "sidebar-pair-phone",
    "pair-phone-modal",
    "sidebar-new-space",
    "create-agent-modal",
    "tabs-new-group",
    "tabs-new-popup",
    "sidebar-agents-block",
    "pane-actions",
    "shell-main-empty",
    "tabs-right-panels",
    "shell-panel",
    "mp-tab-devices",
    "mp-devices-actions",
    "mp-tab-agents",
    "mp-agents-fab",
    "mp-tab-assistant",
    "mp-tab-settings",
    "mp-settings-tutorial",
  ]) {
    assert.ok(tour.includes(anchor), `walkthrough must reference real DOM anchor "${anchor}"`);
  }
});

test("every real desktop & mobile component exposes its data-tour anchor and Radix outside-click guard", () => {
  const sidebar = readSrc("src/shell/ShellSidebar.tsx");
  const work = readSrc("src/shell/ShellWork.tsx");
  const framePanes = readSrc("src/views/settings/FramePanes.tsx");
  const settingsFrame = readSrc("src/views/settings/SettingsFrame.tsx");
  const devicesView = readSrc("src/views/DevicesView.tsx");
  const pairModal = readSrc("src/components/PairPhoneModal.tsx");
  const agentsView = readSrc("src/views/AgentsView.tsx");
  const pocketUi = readSrc("src/components/PocketUI.tsx");
  const mobileShell = readSrc("src/mobile/MobileAppShell.tsx");
  const mobileDevices = readSrc("src/mobile/MobileDevicesTab.tsx");
  const mobileAgents = readSrc("src/mobile/MobileAgentsTab.tsx");
  const mobileSettings = readSrc("src/mobile/MobileSettingsTab.tsx");

  for (const [label, src, token] of [
    ["ShellSidebar", sidebar, 'data-tour="sidebar-new-space"'],
    ["ShellSidebar", sidebar, 'data-tour="sidebar-agents-block"'],
    ["ShellSidebar", sidebar, 'data-tour="sidebar-agents-grouping"'],
    ["ShellSidebar", sidebar, 'data-tour="sidebar-settings"'],
    ["ShellSidebar", sidebar, 'data-tour="sidebar-server"'],
    ["ShellSidebar", sidebar, 'data-tour="sidebar-pair-phone"'],
    ["ShellWork", work, 'data-tour="tabs-new-group"'],
    ["ShellWork", work, 'dataTour="tabs-new-popup"'],
    ["ShellWork", work, 'data-tour="tabs-right-panels"'],
    ["ShellWork", work, 'data-tour="pane-actions"'],
    ["ShellWork", work, 'data-tour="shell-main-empty"'],
    ["ShellWork", work, 'data-tour="shell-panel"'],
    ["ShellWork", work, 'data-tour-ui="true"'],
    ["FramePanes", framePanes, 'data-tour="machines-add-computer"'],
    ["SettingsFrame", settingsFrame, 'data-tour="settings-frame"'],
    ["SettingsFrame", settingsFrame, 'data-tour-ui="true"'],
    ["DevicesView", devicesView, 'dataTour="add-device-modal"'],
    ["PairPhoneModal", pairModal, 'dataTour="pair-phone-modal"'],
    ["AgentsView", agentsView, 'dataTour="create-agent-modal"'],
    ["PocketUI", pocketUi, 'data-tour-ui="true"'],
    ["MobileAppShell", mobileShell, 'data-tour={`mp-tab-${item.id}`}'],
    ["MobileDevicesTab", mobileDevices, 'data-tour="mp-devices-actions"'],
    ["MobileAgentsTab", mobileAgents, 'data-tour="mp-agents-fab"'],
    ["MobileSettingsTab", mobileSettings, 'data-tour="mp-settings-tutorial"'],
  ] as const) {
    assert.ok(src.includes(token), `${label} must include ${token}`);
  }
});
