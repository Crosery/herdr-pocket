import type { Device } from "@herdr-pocket/protocol";

const DESKTOP_PLATFORM = /mac|darwin|win|linux/i;

export function isDesktopPlatform(platform?: string | null): boolean {
  return Boolean(platform && DESKTOP_PLATFORM.test(platform));
}

export interface ClassifiedDevice {
  device: Device;
  /** Primary entry represents the device running this app right now. */
  isCurrentDevice: boolean;
  /** Runs directly on this computer via local `hc connect` / hostd. */
  isLocalHost: boolean;
  /** Host machine running hc / hostd (not just a viewer). */
  isExecutionHost: boolean;
  roleLabel: string;
  mergedViewer?: Device;
}

export interface PartitionedDevices {
  desktop: ClassifiedDevice[];
  mobile: ClassifiedDevice[];
  desktopOnlineCount: number;
  mobileOnlineCount: number;
}

/**
 * Classifies relay devices into execution-capable desktop nodes vs portable mobile controllers,
 * merging this computer's local hostd record with its own desktop viewer record into one row.
 */
export function partitionDevices(
  devicesMap: Record<string, Device>,
  options: { myId?: string | null; localHostId?: string | null },
): PartitionedDevices {
  const all = Object.values(devicesMap);
  const myId = options.myId?.trim() || null;
  const localHostId = options.localHostId?.trim() || null;

  const hosts = all.filter((d) => d.kind === "host");
  const viewers = all.filter((d) => d.kind === "viewer");

  const localHost = localHostId ? hosts.find((h) => h.id === localHostId) : undefined;
  const myViewer = myId ? viewers.find((v) => v.id === myId) : undefined;
  const mergeViewerIntoLocalHost = Boolean(
    localHost && myViewer && (localHost.id === myViewer.id || isDesktopPlatform(myViewer.platform) || myViewer.name === localHost.name),
  );

  const byDesktopPriority = (a: ClassifiedDevice, b: ClassifiedDevice) =>
    Number(b.isCurrentDevice) - Number(a.isCurrentDevice) ||
    Number(b.isExecutionHost) - Number(a.isExecutionHost) ||
    Number(b.device.online) - Number(a.device.online) ||
    a.device.name.localeCompare(b.device.name);

  const byMobilePriority = (a: ClassifiedDevice, b: ClassifiedDevice) =>
    Number(b.isCurrentDevice) - Number(a.isCurrentDevice) ||
    Number(b.device.online) - Number(a.device.online) ||
    a.device.name.localeCompare(b.device.name);

  const desktop: ClassifiedDevice[] = hosts.map((host) => {
    const isLocal = Boolean(localHostId && host.id === localHostId);
    return {
      device: host,
      isCurrentDevice: isLocal || host.id === myId,
      isLocalHost: isLocal,
      isExecutionHost: true,
      roleLabel: isLocal ? "运行载体 · 本地直连" : "外部桌面 · 远程联调",
      mergedViewer: isLocal && mergeViewerIntoLocalHost ? myViewer : undefined,
    };
  });

  const mobile: ClassifiedDevice[] = [];
  for (const viewer of viewers) {
    if (mergeViewerIntoLocalHost && myViewer && viewer.id === myViewer.id) continue;
    const isMe = Boolean(myId && viewer.id === myId);
    if (isDesktopPlatform(viewer.platform)) {
      desktop.push({
        device: viewer,
        isCurrentDevice: isMe,
        isLocalHost: false,
        isExecutionHost: false,
        roleLabel: isMe ? "当前控制端 · 本机" : "桌面控制端",
      });
    } else {
      mobile.push({
        device: viewer,
        isCurrentDevice: isMe,
        isLocalHost: false,
        isExecutionHost: false,
        roleLabel: isMe ? "当前手机 · 便携控制" : "便携控制端",
      });
    }
  }

  desktop.sort(byDesktopPriority);
  mobile.sort(byMobilePriority);

  return {
    desktop,
    mobile,
    desktopOnlineCount: desktop.filter((item) => item.device.online || Boolean(item.mergedViewer?.online)).length,
    mobileOnlineCount: mobile.filter((item) => item.device.online).length,
  };
}
