import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect as connectSocket, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  HostPortalCapabilities,
  PortalDisplaySession,
  PortalInputAction,
  RemoteWindowInfo,
} from "@herdr-pocket/protocol";
import { stateDir } from "@herdr-pocket/update";

export interface CaptureExecResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

export interface ProcessParentEntry {
  pid: number;
  ppid: number;
  name: string;
}

export interface OsCaptureDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  binDir?: string;
  /** Override path to Herdr Pocket.app Unix portal bridge socket (macOS). */
  portalBridgeSocket?: string;
  uid?: () => number;
  hasCmd?: (cmd: string) => boolean;
  pathExists?: (p: string) => boolean;
  readDir?: (p: string) => string[];
  execBin?: (cmd: string, args: string[], timeoutMs?: number, env?: NodeJS.ProcessEnv) => Promise<CaptureExecResult>;
  listProcesses?: () => Promise<ProcessParentEntry[]>;
}

const commandCache = new Map<string, boolean>();

function defaultHasCmd(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (cmd.includes("/")) return existsSync(cmd);
  const key = `${process.platform}:${env.PATH ?? ""}:${cmd}`;
  const cached = commandCache.get(key);
  if (cached !== undefined) return cached;
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = (env.PATH ?? "").split(sep).filter(Boolean);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com", ""] : [""];
  let found = false;
  for (const d of dirs) {
    for (const ext of exts) {
      if (existsSync(join(d, cmd + ext))) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  commandCache.set(key, found);
  return found;
}

export function defaultExecBin(
  cmd: string,
  args: string[],
  timeoutMs = 6000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CaptureExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, encoding: "buffer", windowsHide: true, maxBuffer: 12 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
        const errStr = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
        if (!err) {
          resolve({ code: 0, stdout: outBuf, stderr: errStr });
          return;
        }
        const e = err as { code?: unknown; killed?: boolean; signal?: unknown; message?: string };
        if (e.killed || e.signal != null || e.code === "ETIMEDOUT") {
          resolve({ code: -1, stdout: outBuf, stderr: errStr || e.message || "timed out" });
          return;
        }
        if (typeof e.code === "number") {
          resolve({ code: e.code, stdout: outBuf, stderr: errStr });
        } else {
          reject(err);
        }
      },
    );
  });
}

export function isWslEnv(
  env: NodeJS.ProcessEnv = process.env,
  pathExists: (p: string) => boolean = existsSync,
): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || pathExists("/proc/sys/fs/binfmt_misc/WSLInterop"));
}

/** Resolves X11 / Wayland GUI environment (including systemd services and WSLg/WSL2). */
export function resolveLinuxGuiEnv(deps: OsCaptureDeps = {}): NodeJS.ProcessEnv {
  const baseEnv: NodeJS.ProcessEnv = { ...(deps.env ?? process.env) };
  const pathExists = deps.pathExists ?? existsSync;
  const readDir =
    deps.readDir ??
    ((p: string) => {
      try {
        const fs = require("node:fs") as typeof import("node:fs");
        return fs.readdirSync(p);
      } catch {
        return [];
      }
    });

  const wsl = isWslEnv(baseEnv, pathExists);
  if (wsl && pathExists("/mnt/wslg/runtime-dir")) {
    if (!baseEnv.XDG_RUNTIME_DIR) baseEnv.XDG_RUNTIME_DIR = "/mnt/wslg/runtime-dir";
    if (!baseEnv.WAYLAND_DISPLAY) {
      const wslgFiles = readDir("/mnt/wslg/runtime-dir");
      const sock = wslgFiles.find((f) => /^wayland-\d+$/.test(f));
      if (sock) {
        baseEnv.WAYLAND_DISPLAY = sock;
        baseEnv.XDG_SESSION_TYPE ||= "wayland";
      }
    }
    if (!baseEnv.DISPLAY && pathExists("/mnt/wslg/.X11-unix")) {
      const xSock = readDir("/mnt/wslg/.X11-unix").find((f) => /^X\d+$/.test(f));
      if (xSock) {
        baseEnv.DISPLAY = `:${xSock.slice(1)}`;
      }
    }
  }

  if (baseEnv.WAYLAND_DISPLAY && baseEnv.DISPLAY) return baseEnv;

  const uid = deps.uid?.() ?? (typeof process.getuid === "function" ? process.getuid() : 1000);
  const runtimeDir = baseEnv.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  if (!baseEnv.WAYLAND_DISPLAY && pathExists(runtimeDir)) {
    baseEnv.XDG_RUNTIME_DIR = runtimeDir;
    const files = readDir(runtimeDir);
    const waylandSock = files.find((f) => /^wayland-\d+$/.test(f));
    if (waylandSock) {
      baseEnv.WAYLAND_DISPLAY = waylandSock;
      baseEnv.XDG_SESSION_TYPE ||= "wayland";
    }
  }
  const x11Dir = "/tmp/.X11-unix";
  if (!baseEnv.DISPLAY && pathExists(x11Dir)) {
    const xFiles = readDir(x11Dir);
    const xSock = xFiles.find((f) => /^X\d+$/.test(f));
    if (xSock) {
      baseEnv.DISPLAY = `:${xSock.slice(1)}`;
      baseEnv.XDG_SESSION_TYPE ||= "x11";
    }
  }
  return baseEnv;
}

export function detectPortalSession(deps: OsCaptureDeps = {}): {
  platform: NodeJS.Platform;
  sessionType: PortalDisplaySession;
  desktopEnv?: string;
  env: NodeJS.ProcessEnv;
} {
  const plat = deps.platform ?? process.platform;
  const rawEnv = deps.env ?? process.env;
  if (plat === "darwin") {
    return { platform: plat, sessionType: "macos", desktopEnv: "Aqua", env: rawEnv };
  }
  if (plat === "win32") {
    return { platform: plat, sessionType: "win32", desktopEnv: "Windows", env: rawEnv };
  }

  const pathExists = deps.pathExists ?? existsSync;
  const env = resolveLinuxGuiEnv(deps);
  const wsl = isWslEnv(env, pathExists);
  const wslg = wsl && (pathExists("/mnt/wslg/runtime-dir") || Boolean(env.WESTON_RDP_DISABLE));
  const desktop = (env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || "").trim();
  const desktopLower = desktop.toLowerCase();
  const sessType = (env.XDG_SESSION_TYPE || "").toLowerCase();
  const hasWayland = Boolean(env.WAYLAND_DISPLAY) || sessType === "wayland";
  const hasX11 = Boolean(env.DISPLAY) || sessType === "x11";

  if (hasWayland) {
    if (
      env.HYPRLAND_INSTANCE_SIGNATURE ||
      env.SWAYSOCK ||
      /(?:sway|hyprland|river|wayfire|niri|wlroots|labwc)/.test(desktopLower)
    ) {
      return { platform: plat, sessionType: "wayland-wlroots", desktopEnv: desktop || "wlroots", env };
    }
    if (env.KDE_FULL_SESSION || /kde|plasma|kwin/.test(desktopLower)) {
      return { platform: plat, sessionType: "wayland-kde", desktopEnv: desktop || "KDE Plasma", env };
    }
    if (/gnome|ubuntu|zorin|pop/.test(desktopLower)) {
      return { platform: plat, sessionType: "wayland-gnome", desktopEnv: desktop || "GNOME", env };
    }
    // WSLg Weston uses RDP backend without wlr-screencopy; route through XWayland DISPLAY when present.
    if ((wslg || wsl) && hasX11) {
      return { platform: plat, sessionType: "x11", desktopEnv: desktop || "WSLg", env };
    }
    return { platform: plat, sessionType: "wayland-other", desktopEnv: desktop || (wslg ? "WSLg" : "Wayland"), env };
  }

  if (hasX11) {
    return { platform: plat, sessionType: "x11", desktopEnv: desktop || (wsl ? "WSL X11" : "X11"), env };
  }

  return { platform: plat, sessionType: "headless", desktopEnv: desktop || undefined, env };
}

export function computeCapabilities(opts: {
  deps?: OsCaptureDeps;
  hasCdpBrowser: boolean;
  directPort?: number | null;
}): HostPortalCapabilities {
  const deps = opts.deps ?? {};
  const info = detectPortalSession(deps);
  const pathExists = deps.pathExists ?? existsSync;
  const hasCmd = (c: string) => (deps.hasCmd ?? ((cmd) => defaultHasCmd(cmd, info.env)))(c);
  const wsl = info.platform === "linux" && isWslEnv(info.env, pathExists);
  const notes: string[] = [];

  if (info.sessionType === "macos") {
    return {
      platform: info.platform,
      sessionType: info.sessionType,
      desktopEnv: info.desktopEnv,
      canListWindows: true,
      canCaptureWindow: true,
      canCaptureScreen: true,
      canInjectInput: true,
      hasCdpBrowser: opts.hasCdpBrowser,
      directPort: opts.directPort ?? null,
    };
  }

  if (info.sessionType === "win32") {
    return {
      platform: info.platform,
      sessionType: info.sessionType,
      desktopEnv: info.desktopEnv,
      canListWindows: true,
      canCaptureWindow: true,
      canCaptureScreen: true,
      canInjectInput: true,
      hasCdpBrowser: opts.hasCdpBrowser,
      directPort: opts.directPort ?? null,
    };
  }

  if (info.sessionType === "x11") {
    const canList = hasCmd("wmctrl") || hasCmd("xdotool") || hasCmd("xwininfo");
    const canCapWin =
      hasCmd("maim") ||
      hasCmd("import") ||
      hasCmd("ffmpeg") ||
      hasCmd("scrot") ||
      (hasCmd("xwd") && (hasCmd("convert") || hasCmd("ffmpeg")));
    const canInput = hasCmd("xdotool") || hasCmd("xte");
    if (!canCapWin) {
      notes.push(
        wsl
          ? "WSL X11 已就绪，安装 maim / imagemagick(import) / ffmpeg 后支持 Linux 窗口抓屏"
          : "安装 maim、imagemagick(import) 或 ffmpeg 后支持 X11 窗口抓屏",
      );
    }
    if (!canInput) notes.push("安装 xdotool 后支持 X11 远控鼠标与键盘输入");
    return {
      platform: info.platform,
      sessionType: info.sessionType,
      desktopEnv: info.desktopEnv,
      canListWindows: canList,
      canCaptureWindow: canCapWin,
      canCaptureScreen: canCapWin,
      canInjectInput: canInput,
      hasCdpBrowser: opts.hasCdpBrowser,
      directPort: opts.directPort ?? null,
      ...(notes.length ? { notes } : {}),
    };
  }

  if (info.sessionType === "wayland-wlroots") {
    const canList = hasCmd("hyprctl") || hasCmd("swaymsg") || (Boolean(info.env.DISPLAY) && (hasCmd("wmctrl") || hasCmd("xdotool")));
    const canCap = hasCmd("grim");
    const canInput = hasCmd("ydotool") || hasCmd("wlrctl") || (Boolean(info.env.DISPLAY) && hasCmd("xdotool"));
    if (!canCap) notes.push("安装 grim 后支持 Sway/Hyprland 窗口与桌面抓屏");
    if (!canInput) notes.push("安装 ydotool 或 wlrctl 后支持 Wayland wlroots 远程鼠标键盘输入");
    return {
      platform: info.platform,
      sessionType: info.sessionType,
      desktopEnv: info.desktopEnv,
      canListWindows: canList,
      canCaptureWindow: canCap,
      canCaptureScreen: canCap,
      canInjectInput: canInput,
      hasCdpBrowser: opts.hasCdpBrowser,
      directPort: opts.directPort ?? null,
      ...(notes.length ? { notes } : {}),
    };
  }

  if (info.sessionType === "wayland-kde") {
    const canList = hasCmd("kdotool") || (Boolean(info.env.DISPLAY) && (hasCmd("wmctrl") || hasCmd("xdotool")));
    const canCap = hasCmd("spectacle") || hasCmd("grim") || (Boolean(info.env.DISPLAY) && (hasCmd("maim") || hasCmd("import")));
    const canInput = hasCmd("ydotool") || (Boolean(info.env.DISPLAY) && hasCmd("xdotool"));
    if (!canCap) notes.push("安装 spectacle 后支持 KDE Wayland 抓屏");
    if (!canInput) notes.push("安装 ydotool (与 ydotoold) 后支持 KDE Wayland 原生输入");
    return {
      platform: info.platform,
      sessionType: info.sessionType,
      desktopEnv: info.desktopEnv,
      canListWindows: canList,
      canCaptureWindow: canCap,
      canCaptureScreen: canCap,
      canInjectInput: canInput,
      hasCdpBrowser: opts.hasCdpBrowser,
      directPort: opts.directPort ?? null,
      ...(notes.length ? { notes } : {}),
    };
  }

  if (info.sessionType === "wayland-gnome") {
    const canList = hasCmd("gdbus") || (Boolean(info.env.DISPLAY) && (hasCmd("wmctrl") || hasCmd("xdotool")));
    const canCap = hasCmd("gnome-screenshot") || (Boolean(info.env.DISPLAY) && (hasCmd("maim") || hasCmd("import") || hasCmd("ffmpeg")));
    const canInput = hasCmd("ydotool") || (Boolean(info.env.DISPLAY) && hasCmd("xdotool"));
    if (!canCap) notes.push("安装 gnome-screenshot 或 XWayland 抓屏工具 (maim/import) 后支持 GNOME Wayland 抓屏");
    if (!canInput) notes.push("安装 ydotool (与 ydotoold) 后支持 GNOME Wayland 原生输入");
    return {
      platform: info.platform,
      sessionType: info.sessionType,
      desktopEnv: info.desktopEnv,
      canListWindows: canList,
      canCaptureWindow: canCap,
      canCaptureScreen: canCap,
      canInjectInput: canInput,
      hasCdpBrowser: opts.hasCdpBrowser,
      directPort: opts.directPort ?? null,
      ...(notes.length ? { notes } : {}),
    };
  }

  if (info.sessionType === "wayland-other") {
    const canCap = hasCmd("grim") || (Boolean(info.env.DISPLAY) && (hasCmd("maim") || hasCmd("import") || hasCmd("ffmpeg")));
    const canInput = hasCmd("ydotool") || (Boolean(info.env.DISPLAY) && hasCmd("xdotool"));
    notes.push("检测到自定义 Wayland 合成器；安装 grim / ydotool 或开启 XWayland 可获得最佳兼容性");
    return {
      platform: info.platform,
      sessionType: info.sessionType,
      desktopEnv: info.desktopEnv,
      canListWindows: Boolean(info.env.DISPLAY) && (hasCmd("wmctrl") || hasCmd("xdotool") || hasCmd("xwininfo")),
      canCaptureWindow: canCap,
      canCaptureScreen: canCap,
      canInjectInput: canInput,
      hasCdpBrowser: opts.hasCdpBrowser,
      directPort: opts.directPort ?? null,
      notes,
    };
  }

  if (wsl) {
    notes.push("检测到 WSL 环境但未配置 X Server 或 WSLg；在 Windows 启动 VcXsrv / X410（勾选 Disable access control）并设置 DISPLAY，或使用 Windows 11 WSLg 即可回传 Linux X11 窗口");
  }
  notes.push("当前 Linux 无图形会话 (Headless)，浏览器 OAuth 与文件/HTML 预览仍可通过内置远端浏览器与 P2P 正常回传");
  return {
    platform: info.platform,
    sessionType: "headless",
    desktopEnv: info.desktopEnv,
    canListWindows: false,
    canCaptureWindow: false,
    canCaptureScreen: false,
    canInjectInput: false,
    hasCdpBrowser: opts.hasCdpBrowser,
    directPort: opts.directPort ?? null,
    notes,
  };
}

// --- Windows persistent/inline Win32 C# helper (strict C# 5 for .NET Framework csc.exe) ---

const WIN_CS_SRC = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public class HpWinPortal {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO pci);
  [DllImport("user32.dll")] public static extern bool DrawIcon(IntPtr hDC, int X, int Y, IntPtr hIcon);
  [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int val, int size);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
  [DllImport("kernel32.dll", CharSet=CharSet.Auto)] public static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
  [DllImport("kernel32.dll", CharSet=CharSet.Auto)] public static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr hObject);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }
  [StructLayout(LayoutKind.Sequential)] public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]
  public struct PROCESSENTRY32 {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)]
    public string szExeFile;
  }

  static ImageCodecInfo _jpgCodec = null;
  static ImageCodecInfo GetJpgCodec() {
    if (_jpgCodec != null) return _jpgCodec;
    ImageCodecInfo[] enc = ImageCodecInfo.GetImageEncoders();
    _jpgCodec = enc[0];
    foreach (var c in enc) if (c.MimeType == "image/jpeg") { _jpgCodec = c; break; }
    return _jpgCodec;
  }

  static string JsonEsc(string s) {
    if (s == null) return "";
    return s.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"").Replace("\\r", " ").Replace("\\n", " ");
  }

  static bool IsXServerProc(string proc) {
    if (proc == null) return false;
    string p = proc.ToLowerInvariant();
    return p.Contains("vcxsrv") || p.Contains("x410") || p.Contains("xming") || p.Contains("xwin") || p.Contains("mobaxterm") || p.Contains("msrdc") || p.Contains("wslg");
  }

  static bool LooksAllBlack(Bitmap bmp) {
    int w = bmp.Width, h = bmp.Height;
    if (w < 8 || h < 8) return true;
    int stepX = Math.Max(1, w / 5);
    int stepY = Math.Max(1, h / 5);
    for (int y = stepY; y < h - 2; y += stepY) {
      for (int x = stepX; x < w - 2; x += stepX) {
        Color c = bmp.GetPixel(x, y);
        if (c.R > 4 || c.G > 4 || c.B > 4) return false;
      }
    }
    return true;
  }

  static Bitmap ScaleDownIfNeeded(Bitmap src, int maxDim) {
    if (maxDim <= 0 || (src.Width <= maxDim && src.Height <= maxDim)) return src;
    double scale = Math.Min((double)maxDim / src.Width, (double)maxDim / src.Height);
    int tw = Math.Max(1, (int)Math.Round(src.Width * scale));
    int th = Math.Max(1, (int)Math.Round(src.Height * scale));
    var dst = new Bitmap(tw, th);
    using (var g = Graphics.FromImage(dst)) {
      g.InterpolationMode = InterpolationMode.Bilinear;
      g.DrawImage(src, 0, 0, tw, th);
    }
    src.Dispose();
    return dst;
  }

  public static string DumpWindows() {
    SetProcessDPIAware();
    var sb = new StringBuilder("[");
    bool first = true;
    Screen[] screens = Screen.AllScreens;
    for (int i = 0; i < screens.Length; i++) {
      Rectangle b = screens[i].Bounds;
      string title = screens.Length > 1
        ? string.Format("屏幕 {0} ({1}x{2})", i + 1, b.Width, b.Height)
        : string.Format("主屏幕 ({0}x{1})", b.Width, b.Height);
      if (!first) sb.Append(",");
      first = false;
      sb.AppendFormat(
        "{{\\"id\\":\\"screen:{0}\\",\\"appName\\":\\"Windows 桌面\\",\\"title\\":\\"{1}\\",\\"isScreen\\":true,\\"displayIndex\\":{0},\\"bounds\\":{{\\"x\\":{2},\\"y\\":{3},\\"width\\":{4},\\"height\\":{5}}}}}",
        i, JsonEsc(title), b.X, b.Y, b.Width, b.Height
      );
    }
    EnumWindows((h, _) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int cloaked = 0;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      var title = new StringBuilder(len + 1);
      GetWindowText(h, title, title.Capacity);
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int w = r.Right - r.Left, ht = r.Bottom - r.Top;
      if (w < 80 || ht < 60) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      string proc = "";
      try { proc = Process.GetProcessById((int)pid).ProcessName; } catch {}
      if (!first) sb.Append(",");
      first = false;
      sb.AppendFormat("{{\\"id\\":\\"{0}\\",\\"appName\\":\\"{1}\\",\\"title\\":\\"{2}\\",\\"pid\\":{3},\\"bounds\\":{{\\"x\\":{4},\\"y\\":{5},\\"width\\":{6},\\"height\\":{7}}}}}",
        h.ToInt64(), JsonEsc(proc), JsonEsc(title.ToString()), pid, r.Left, r.Top, w, ht);
      return true;
    }, IntPtr.Zero);
    sb.Append("]");
    return sb.ToString();
  }

  public static string DumpProcesses() {
    var sb = new StringBuilder("[");
    bool first = true;
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap != IntPtr.Zero && snap.ToInt64() != -1) {
      try {
        var pe = new PROCESSENTRY32();
        pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
        if (Process32First(snap, ref pe)) {
          do {
            if (!first) sb.Append(",");
            first = false;
            sb.AppendFormat("{{\\"pid\\":{0},\\"ppid\\":{1},\\"name\\":\\"{2}\\"}}",
              pe.th32ProcessID, pe.th32ParentProcessID, JsonEsc(pe.szExeFile));
          } while (Process32Next(snap, ref pe));
        }
      } finally {
        CloseHandle(snap);
      }
    }
    sb.Append("]");
    return sb.ToString();
  }

  public static string CaptureWindow(string target, string outPath, int maxDim, long quality, bool showCursor) {
    SetProcessDPIAware();
    Bitmap bmp = null;
    Rectangle srcBounds = SystemInformation.VirtualScreen;
    if (target.StartsWith("screen:")) {
      int idx = 0;
      int.TryParse(target.Substring(7), out idx);
      Screen[] screens = Screen.AllScreens;
      srcBounds = (idx >= 0 && idx < screens.Length) ? screens[idx].Bounds : Screen.PrimaryScreen.Bounds;
      if (srcBounds.Width <= 0 || srcBounds.Height <= 0) srcBounds = Screen.PrimaryScreen.Bounds;
      bmp = new Bitmap(srcBounds.Width, srcBounds.Height);
      using (var g = Graphics.FromImage(bmp)) { g.CopyFromScreen(srcBounds.Left, srcBounds.Top, 0, 0, srcBounds.Size); }
    } else {
      long hwndVal = 0;
      long.TryParse(target, out hwndVal);
      if (hwndVal > 0) {
        IntPtr hwnd = new IntPtr(hwndVal);
        RECT r;
        if (!GetWindowRect(hwnd, out r)) throw new Exception("window gone");
        int w = Math.Max(1, r.Right - r.Left);
        int h = Math.Max(1, r.Bottom - r.Top);
        srcBounds = new Rectangle(r.Left, r.Top, w, h);
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        string proc = "";
        try { proc = Process.GetProcessById((int)pid).ProcessName; } catch {}
        bool xSrv = IsXServerProc(proc);
        bmp = new Bitmap(w, h);
        using (var g = Graphics.FromImage(bmp)) {
          bool ok = false;
          if (!xSrv) {
            IntPtr hdc = g.GetHdc();
            ok = PrintWindow(hwnd, hdc, 2);
            g.ReleaseHdc(hdc);
          }
          if (!ok || LooksAllBlack(bmp)) {
            g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(w, h));
          }
        }
      } else {
        bmp = new Bitmap(srcBounds.Width, srcBounds.Height);
        using (var g = Graphics.FromImage(bmp)) { g.CopyFromScreen(srcBounds.Left, srcBounds.Top, 0, 0, srcBounds.Size); }
      }
    }

    var ci = new CURSORINFO();
    ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    double cnx = 0.5, cny = 0.5;
    int cvis = 0;
    if (GetCursorInfo(ref ci) && (ci.flags & 1) != 0) {
      int cx = ci.ptScreenPos.X - srcBounds.Left;
      int cy = ci.ptScreenPos.Y - srcBounds.Top;
      if (cx >= 0 && cx <= srcBounds.Width && cy >= 0 && cy <= srcBounds.Height) {
        cnx = Math.Max(0.0, Math.Min(1.0, (double)cx / Math.Max(1, srcBounds.Width)));
        cny = Math.Max(0.0, Math.Min(1.0, (double)cy / Math.Max(1, srcBounds.Height)));
        cvis = 1;
        if (showCursor) {
          int hx = 0, hy = 0;
          ICONINFO ii;
          if (GetIconInfo(ci.hCursor, out ii)) {
            hx = ii.xHotspot; hy = ii.yHotspot;
            if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
            if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
          }
          using (var g = Graphics.FromImage(bmp)) {
            IntPtr hdc = g.GetHdc();
            DrawIcon(hdc, cx - hx, cy - hy, ci.hCursor);
            g.ReleaseHdc(hdc);
          }
        }
      }
    }

    bmp = ScaleDownIfNeeded(bmp, maxDim);
    long q = Math.Max(35L, Math.Min(95L, quality));
    var ep = new EncoderParameters(1);
    ep.Param[0] = new EncoderParameter(Encoder.Quality, q);
    if (outPath == "-") {
      using (var ms = new MemoryStream()) {
        bmp.Save(ms, GetJpgCodec(), ep);
        string dims = string.Format(System.Globalization.CultureInfo.InvariantCulture, "dims:{0}x{1}|cursor:{2:F4},{3:F4},{4}|b64:", bmp.Width, bmp.Height, cnx, cny, cvis);
        bmp.Dispose();
        return dims + Convert.ToBase64String(ms.ToArray());
      }
    } else {
      bmp.Save(outPath, GetJpgCodec(), ep);
      string dims = string.Format(System.Globalization.CultureInfo.InvariantCulture, "dims:{0}x{1}|cursor:{2:F4},{3:F4},{4}", bmp.Width, bmp.Height, cnx, cny, cvis);
      bmp.Dispose();
      return dims;
    }
  }

  public static void SendMouse(int x, int y, string btn, string action, long hwndVal) {
    SetProcessDPIAware();
    if (hwndVal > 0 && action != "move" && action != "drag") SetForegroundWindow(new IntPtr(hwndVal));
    SetCursorPos(x, y);
    if (action == "move" || action == "drag") return;
    uint downF = btn == "right" ? 0x0008u : btn == "middle" ? 0x0020u : 0x0002u;
    uint upF = btn == "right" ? 0x0010u : btn == "middle" ? 0x0040u : 0x0004u;
    if (action == "down") {
      mouse_event(downF, 0, 0, 0, UIntPtr.Zero);
      return;
    }
    if (action == "up") {
      mouse_event(upF, 0, 0, 0, UIntPtr.Zero);
      return;
    }
    int count = 1;
    int.TryParse(action, out count);
    for (int i = 0; i < Math.Max(1, count); i++) {
      mouse_event(downF, 0, 0, 0, UIntPtr.Zero);
      mouse_event(upF, 0, 0, 0, UIntPtr.Zero);
    }
  }

  public static void SendWheel(int dy, int dx, int x, int y, long hwndVal) {
    SetProcessDPIAware();
    if (hwndVal > 0) SetForegroundWindow(new IntPtr(hwndVal));
    if (x != int.MinValue && y != int.MinValue) SetCursorPos(x, y);
    if (dy != 0) mouse_event(0x0800u, 0, 0, unchecked((uint)(-dy)), UIntPtr.Zero);
    if (dx != 0) mouse_event(0x1000u, 0, 0, unchecked((uint)(dx)), UIntPtr.Zero);
  }

  public static void SendTextB64(string b64, long hwndVal) {
    if (hwndVal > 0) SetForegroundWindow(new IntPtr(hwndVal));
    string raw = Encoding.UTF8.GetString(Convert.FromBase64String(b64));
    var sb = new StringBuilder();
    foreach (char ch in raw) {
      if (ch == '+' || ch == '^' || ch == '%' || ch == '~' || ch == '(' || ch == ')' || ch == '{' || ch == '}' || ch == '[' || ch == ']') {
        sb.Append('{').Append(ch).Append('}');
      } else {
        sb.Append(ch);
      }
    }
    SendKeys.SendWait(sb.ToString());
  }

  static byte ResolveVk(string keyName) {
    if (string.IsNullOrEmpty(keyName)) return 0;
    if (keyName == "Enter" || keyName == "Return") return 0x0D;
    if (keyName == "Tab") return 0x09;
    if (keyName == "Backspace") return 0x08;
    if (keyName == "Escape") return 0x1B;
    if (keyName == "Space" || keyName == " ") return 0x20;
    if (keyName == "Delete") return 0x2E;
    if (keyName == "Home") return 0x24;
    if (keyName == "End") return 0x23;
    if (keyName == "PageUp") return 0x21;
    if (keyName == "PageDown") return 0x22;
    if (keyName == "ArrowLeft") return 0x25;
    if (keyName == "ArrowUp") return 0x26;
    if (keyName == "ArrowRight") return 0x27;
    if (keyName == "ArrowDown") return 0x28;
    if (keyName == "Meta" || keyName == "Command") return 0x5B;
    if (keyName == "Control" || keyName == "Ctrl") return 0x11;
    if (keyName == "Alt" || keyName == "Option") return 0x12;
    if (keyName == "Shift") return 0x10;
    if (keyName.StartsWith("F") && keyName.Length <= 3) {
      int fn = 0;
      if (int.TryParse(keyName.Substring(1), out fn) && fn >= 1 && fn <= 12) return (byte)(0x70 + fn - 1);
    }
    if (keyName.Length == 1) {
      char c = char.ToUpperInvariant(keyName[0]);
      if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return (byte)c;
    }
    return 0;
  }

  public static void SendKey(string keyName, long hwndVal, string modsCsv, string phase) {
    if (hwndVal > 0) SetForegroundWindow(new IntPtr(hwndVal));
    var modList = new List<byte>();
    if (!string.IsNullOrEmpty(modsCsv)) {
      foreach (string m in modsCsv.Split(',')) {
        string ml = m.Trim().ToLowerInvariant();
        if (ml == "meta" || ml == "cmd" || ml == "command" || ml == "win") modList.Add(0x5B);
        else if (ml == "ctrl" || ml == "control") modList.Add(0x11);
        else if (ml == "alt" || ml == "option") modList.Add(0x12);
        else if (ml == "shift") modList.Add(0x10);
      }
    }
    byte vk = ResolveVk(keyName);
    if (vk == 0 && modList.Count == 0 && keyName.Length == 1) {
      SendTextB64(Convert.ToBase64String(Encoding.UTF8.GetBytes(keyName)), hwndVal);
      return;
    }
    if (vk == 0) return;
    if (phase == "down") {
      keybd_event(vk, 0, 0, UIntPtr.Zero);
      return;
    }
    if (phase == "up") {
      keybd_event(vk, 0, 2, UIntPtr.Zero);
      return;
    }
    for (int i = 0; i < modList.Count; i++) keybd_event(modList[i], 0, 0, UIntPtr.Zero);
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    keybd_event(vk, 0, 2, UIntPtr.Zero);
    for (int i = modList.Count - 1; i >= 0; i--) keybd_event(modList[i], 0, 2, UIntPtr.Zero);
  }

  public static string HandleClipboard(string action, string b64) {
    if (action == "get") {
      string txt = "";
      try { if (Clipboard.ContainsText()) txt = Clipboard.GetText(); } catch {}
      return Convert.ToBase64String(Encoding.UTF8.GetBytes(txt));
    }
    if (action == "set") {
      string txt = Encoding.UTF8.GetString(Convert.FromBase64String(b64 ?? ""));
      try { Clipboard.SetText(txt); } catch {}
      return "ok";
    }
    return "";
  }

  public static int Run(string[] args, StringBuilder outBuf) {
    if (args.Length == 0) return 1;
    string cmd = args[0];
    if (cmd == "list") { outBuf.Append(DumpWindows()); return 0; }
    if (cmd == "ps") { outBuf.Append(DumpProcesses()); return 0; }
    if (cmd == "capture" && args.Length >= 3) {
      int maxDim = args.Length >= 4 ? int.Parse(args[3]) : 1600;
      long quality = args.Length >= 5 ? long.Parse(args[4]) : 72L;
      bool showCursor = args.Length >= 6 ? args[5] != "0" : true;
      outBuf.Append(CaptureWindow(args[1], args[2], maxDim, quality, showCursor));
      return 0;
    }
    if (cmd == "click" && args.Length >= 5) {
      long hwnd = args.Length >= 6 ? long.Parse(args[5]) : 0;
      SendMouse(int.Parse(args[1]), int.Parse(args[2]), args[3], args[4], hwnd);
      return 0;
    }
    if (cmd == "wheel" && args.Length >= 2) {
      int dy = int.Parse(args[1]);
      int dx = args.Length >= 3 ? int.Parse(args[2]) : 0;
      int x = args.Length >= 4 ? int.Parse(args[3]) : int.MinValue;
      int y = args.Length >= 5 ? int.Parse(args[4]) : int.MinValue;
      long hwnd = args.Length >= 6 ? long.Parse(args[5]) : 0;
      SendWheel(dy, dx, x, y, hwnd);
      return 0;
    }
    if (cmd == "text" && args.Length >= 2) {
      long hwnd = args.Length >= 3 ? long.Parse(args[2]) : 0;
      SendTextB64(args[1], hwnd);
      return 0;
    }
    if (cmd == "key" && args.Length >= 2) {
      long hwnd = args.Length >= 3 ? long.Parse(args[2]) : 0;
      string mods = args.Length >= 4 ? args[3] : "";
      string phase = args.Length >= 5 ? args[4] : "press";
      SendKey(args[1], hwnd, mods, phase);
      return 0;
    }
    if (cmd == "clipboard" && args.Length >= 2) {
      outBuf.Append(HandleClipboard(args[1], args.Length >= 3 ? args[2] : ""));
      return 0;
    }
    return 1;
  }

  [STAThread]
  public static int Main(string[] args) {
    Console.OutputEncoding = Encoding.UTF8;
    Console.InputEncoding = Encoding.UTF8;
    if (args.Length >= 1 && args[0] == "serve") {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        if (line.Length == 0) continue;
        string[] parts = line.Split('\\t');
        var dec = new string[parts.Length];
        for (int i = 0; i < parts.Length; i++) {
          dec[i] = Encoding.UTF8.GetString(Convert.FromBase64String(parts[i]));
        }
        var outBuf = new StringBuilder();
        int code = 1;
        string err = "";
        try {
          code = Run(dec, outBuf);
        } catch (Exception ex) {
          code = 1;
          err = ex.Message;
        }
        string outB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(outBuf.ToString()));
        string errB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(err));
        Console.WriteLine(string.Format("{0}\\t{1}\\t{2}", code, outB64, errB64));
        Console.Out.Flush();
      }
      return 0;
    }
    var sb = new StringBuilder();
    int rc = Run(args, sb);
    if (sb.Length > 0) Console.Write(sb.ToString());
    return rc;
  }
}
`;

function buildWin32InlinePs(args: string[]): string {
  const escArgs = args.map((a) => "'" + a.replace(/'/g, "''") + "'").join(", ");
  return `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
${WIN_CS_SRC.replace(/@"/g, "@ '").replace(/"@/g, "\" @")}
"@ -ReferencedAssemblies System.Drawing,System.Windows.Forms
[Environment]::ExitCode = [HpWinPortal]::Main([string[]]@(${escArgs}))
`;
}

// --- macOS Swift helper (persistent SCStream + CGEvent real mouse/keyboard/clipboard; compiled automatically when stale) ---

export const MAC_SWIFT_SRC = `
import ApplicationServices
import AppKit
import CoreGraphics
import CoreImage
import CoreMedia
import Foundation
import ImageIO
import ScreenCaptureKit

func activatePid(_ pid: Int32) {
  if pid <= 0 { return }
  if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return }
  let app = NSRunningApplication(processIdentifier: pid)
  if #available(macOS 14.0, *) {
    app?.activate()
  } else {
    app?.activate(options: .activateIgnoringOtherApps)
  }
}

func isLocalPocketFrontmost() -> Bool {
  guard let front = NSWorkspace.shared.frontmostApplication else { return false }
  let bid = front.bundleIdentifier ?? ""
  let name = front.localizedName ?? ""
  return bid.hasPrefix("dev.crosery.herdrpocket") || name == "Herdr Pocket"
}

func parseModifierFlags(_ csv: String) -> CGEventFlags {
  var flags = CGEventFlags()
  if csv.isEmpty { return flags }
  for raw in csv.split(separator: ",") {
    switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "meta", "cmd", "command": flags.insert(.maskCommand)
    case "ctrl", "control": flags.insert(.maskControl)
    case "alt", "option": flags.insert(.maskAlternate)
    case "shift": flags.insert(.maskShift)
    default: break
    }
  }
  return flags
}

let KEY_CODES: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
  "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
  "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31,
  "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\\\": 42,
  ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "\`": 50,
  "Return": 36, "Enter": 36, "Tab": 48, "Space": 49, " ": 49, "Backspace": 51, "Escape": 53,
  "CapsLock": 57, "Delete": 117, "Help": 114, "Home": 115, "PageUp": 116, "End": 119, "PageDown": 121,
  "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
  "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100,
  "F9": 101, "F10": 109, "F11": 103, "F12": 111
]

let SHIFT_ALIAS: [String: String] = [
  "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\\\", ":": ";", "\\"": "'", "<": ",", ">": ".", "?": "/", "~": "\`"
]

func encodeJpeg(_ cgImg: CGImage, quality: Double) -> Data? {
  let out = NSMutableData()
  guard let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else {
    return nil
  }
  let q = max(0.35, min(0.95, quality))
  let props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: NSNumber(value: q)]
  CGImageDestinationAddImage(dest, cgImg, props as CFDictionary)
  guard CGImageDestinationFinalize(dest) else { return nil }
  return out as Data
}

func activeDisplays() -> [(index: Int, id: CGDirectDisplayID, bounds: CGRect, scale: Double)] {
  var ids = [CGDirectDisplayID](repeating: 0, count: 16)
  var count: UInt32 = 0
  let err = CGGetActiveDisplayList(16, &ids, &count)
  if err != .success || count == 0 {
    let mainId = CGMainDisplayID()
    let b = CGDisplayBounds(mainId)
    return [(0, mainId, b, Double(NSScreen.main?.backingScaleFactor ?? 2.0))]
  }
  let screens = NSScreen.screens
  var out: [(Int, CGDirectDisplayID, CGRect, Double)] = []
  for idx in 0..<Int(count) {
    let did = ids[idx]
    let b = CGDisplayBounds(did)
    var scale = 2.0
    for scr in screens {
      if let n = scr.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
         n.uint32Value == did {
        scale = Double(scr.backingScaleFactor)
        break
      }
    }
    out.append((idx, did, b, scale))
  }
  return out
}

func buildWindowListJson() -> Data {
  let disps = activeDisplays()
  var out: [[String: Any]] = []
  for d in disps {
    let bw = max(1, Int(d.bounds.width))
    let bh = max(1, Int(d.bounds.height))
    let title = disps.count > 1 ? "屏幕 \\(d.index + 1) (\\(bw)×\\(bh))" : "主屏幕 (\\(bw)×\\(bh))"
    out.append([
      "id": "screen:\\(d.index)",
      "appName": "macOS 桌面",
      "title": title,
      "isScreen": true,
      "displayIndex": d.index,
      "scaleFactor": d.scale,
      "bounds": ["x": Int(d.bounds.origin.x), "y": Int(d.bounds.origin.y), "width": bw, "height": bh]
    ])
  }
  let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  let info = (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
  let blockedOwners: Set<String> = ["Window Server", "Dock", "Control Center", "Notification Center", "Spotlight", "Herdr Pocket", "herdr-pocket-desktop"]
  for w in info {
    guard let wid = w[kCGWindowNumber as String] as? Int,
          let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
          let owner = w[kCGWindowOwnerName as String] as? String,
          let b = w[kCGWindowBounds as String] as? [String: Any],
          let bw = b["Width"] as? Double, let bh = b["Height"] as? Double,
          bw >= 100, bh >= 80 else { continue }
    let alpha = (w[kCGWindowAlpha as String] as? Double) ?? 1.0
    if alpha <= 0.05 { continue }
    let title = (w[kCGWindowName as String] as? String) ?? ""
    if blockedOwners.contains(owner) || title == "WatermarkWidget" { continue }
    let pid = (w[kCGWindowOwnerPID as String] as? Int) ?? 0
    let bx = (b["X"] as? Double) ?? 0
    let by = (b["Y"] as? Double) ?? 0
    out.append([
      "id": String(wid),
      "appName": owner,
      "title": title.isEmpty ? owner : title,
      "pid": pid,
      "bounds": ["x": Int(bx), "y": Int(by), "width": Int(bw), "height": Int(bh)]
    ])
  }
  return (try? JSONSerialization.data(withJSONObject: out)) ?? Data("[]".utf8)
}

func cursorMetaString(w: Int, h: Int, bounds: CGRect, seq: UInt64 = 0) -> String {
  let pt = CGEvent(source: nil)?.location ?? CGPoint.zero
  let inside = bounds.width > 0 && bounds.height > 0 &&
    pt.x >= bounds.minX && pt.x <= bounds.maxX &&
    pt.y >= bounds.minY && pt.y <= bounds.maxY
  let nx = max(0.0, min(1.0, (pt.x - bounds.minX) / max(1.0, bounds.width)))
  let ny = max(0.0, min(1.0, (pt.y - bounds.minY) / max(1.0, bounds.height)))
  return String(
    format: "dims:%dx%d\\ncursor:%.4f,%.4f,%d\\nseq:%llu\\n",
    locale: Locale(identifier: "en_US_POSIX"),
    w, h, nx, ny, inside ? 1 : 0, seq
  )
}

@available(macOS 14.0, *)
final class StreamReceiver: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let cond = NSCondition()
  var latestBuffer: CVImageBuffer?
  var latestSeq: UInt64 = 0
  var stoppedError: Error?

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sampleBuffer.isValid else { return }
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
       let statusRaw = attachments.first?[SCStreamFrameInfo.status] as? Int,
       let status = SCFrameStatus(rawValue: statusRaw),
       status != .complete {
      return
    }
    guard let buf = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    cond.lock()
    latestBuffer = buf
    latestSeq &+= 1
    if latestSeq == 0 { latestSeq = 1 }
    cond.broadcast()
    cond.unlock()
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    cond.lock()
    stoppedError = error
    cond.broadcast()
    cond.unlock()
  }

  func clear() {
    cond.lock()
    latestBuffer = nil
    latestSeq = 0
    stoppedError = nil
    cond.unlock()
  }
}

final class SendableResult<T>: @unchecked Sendable {
  var value: Result<T, Error>?
}

func runSync<T>(_ body: @escaping @Sendable () async throws -> T) throws -> T {
  let sem = DispatchSemaphore(value: 0)
  let box = SendableResult<T>()
  Task.detached(priority: .userInitiated) {
    do {
      let v = try await body()
      box.value = .success(v)
    } catch {
      box.value = .failure(error)
    }
    sem.signal()
  }
  sem.wait()
  switch box.value! {
  case .success(let v): return v
  case .failure(let e): throw e
  }
}

@available(macOS 14.0, *)
private final class StreamSlot {
  let target: String
  var cfgKey: String
  var stream: SCStream
  var receiver: StreamReceiver
  var bounds: CGRect
  var cachedFrameJpeg: (seq: UInt64, key: String, data: Data, w: Int, h: Int)?
  var lastAccessAt: Date

  init(target: String, cfgKey: String, stream: SCStream, receiver: StreamReceiver, bounds: CGRect, lastAccessAt: Date) {
    self.target = target
    self.cfgKey = cfgKey
    self.stream = stream
    self.receiver = receiver
    self.bounds = bounds
    self.lastAccessAt = lastAccessAt
  }
}

final class PortalEngine: @unchecked Sendable {
  private var heldButtons: Set<String> = []
  private var cachedShareable: (at: Date, content: AnyObject)?
  private let ciContext = CIContext(options: [.cacheIntermediates: false])
  private let srgbSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
  private let capLock = NSLock()
  private var slotObjs: [String: AnyObject] = [:]
  private let maxConcurrentStreams = 6
  private var idleTimer: DispatchSourceTimer?

  func startIdleReaper() {
    if idleTimer != nil { return }
    let t = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    t.schedule(deadline: .now() + 2.0, repeating: 2.0)
    t.setEventHandler { [weak self] in
      guard let self = self else { return }
      if #available(macOS 14.0, *) {
        self.stopStreamIfIdle()
      }
    }
    t.resume()
    idleTimer = t
  }

  @available(macOS 14.0, *)
  private func stopStreamIfIdle() {
    let now = Date()
    var evicted: [StreamSlot] = []
    capLock.lock()
    for (key, obj) in slotObjs {
      if let slot = obj as? StreamSlot, now.timeIntervalSince(slot.lastAccessAt) > 8.0 {
        evicted.append(slot)
        slotObjs.removeValue(forKey: key)
      }
    }
    capLock.unlock()
    for slot in evicted {
      try? runSync {
        try await slot.stream.stopCapture()
      }
      slot.receiver.clear()
    }
  }

  @available(macOS 14.0, *)
  private func shareableContent(forceRefresh: Bool = false) throws -> SCShareableContent {
    if !forceRefresh, let c = cachedShareable, Date().timeIntervalSince(c.at) < 4.0,
       let sc = c.content as? SCShareableContent {
      return sc
    }
    let sc = try runSync {
      try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    }
    cachedShareable = (Date(), sc)
    return sc
  }

  @available(macOS 14.0, *)
  private func resolveFilterAndBounds(target: String, content: SCShareableContent) -> (SCContentFilter, CGRect, Double)? {
    if target.hasPrefix("screen:") {
      let idx = Int(target.dropFirst(7)) ?? 0
      let disps = activeDisplays()
      let chosen = (idx >= 0 && idx < disps.count) ? disps[idx] : disps[0]
      guard let scDisp = content.displays.first(where: { $0.displayID == chosen.id }) ?? content.displays.first else {
        return nil
      }
      let f = SCContentFilter(display: scDisp, excludingWindows: [])
      return (f, chosen.bounds, chosen.scale)
    }
    guard let wid = CGWindowID(target),
          let win = content.windows.first(where: { $0.windowID == wid }) else {
      return nil
    }
    let f = SCContentFilter(desktopIndependentWindow: win)
    return (f, win.frame, 2.0)
  }

  @available(macOS 14.0, *)
  func capture(target: String, maxDim: Int, quality: Double, showCursor: Bool, fps: Int, persistentStream: Bool, sinceSeq: UInt64 = 0) -> (code: Int32, out: Data, err: String) {
    if !CGPreflightScreenCaptureAccess() {
      return (2, Data(), "screen_recording_denied\\n")
    }
    let now = Date()
    let clampedFps = max(1, min(60, fps))

    var content: SCShareableContent
    do {
      content = try shareableContent(forceRefresh: false)
    } catch {
      return (1, Data(), "capture_err:\\(error)\\n")
    }

    var resolved = resolveFilterAndBounds(target: target, content: content)
    if resolved == nil {
      if let refreshed = try? shareableContent(forceRefresh: true) {
        content = refreshed
        resolved = resolveFilterAndBounds(target: target, content: refreshed)
      }
    }
    guard let (filter, bounds, scaleFactor) = resolved else {
      return (1, Data(), "capture_empty\\n")
    }

    let srcW = max(1.0, Double(bounds.width))
    let srcH = max(1.0, Double(bounds.height))
    let longest = max(srcW, srcH)
    let scale = maxDim > 0 ? min(max(1.0, scaleFactor), Double(maxDim) / longest) : 1.0
    let outW = max(2, Int((srcW * scale).rounded()) & ~1)
    let outH = max(2, Int((srcH * scale).rounded()) & ~1)

    let cfg = SCStreamConfiguration()
    cfg.width = outW
    cfg.height = outH
    cfg.showsCursor = showCursor
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(clampedFps))
    cfg.queueDepth = 3
    cfg.pixelFormat = persistentStream ? kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange : kCVPixelFormatType_32BGRA

    if !persistentStream {
      do {
        let outImg = try runSync {
          try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        }
        guard let jpeg = encodeJpeg(outImg, quality: quality) else {
          return (1, Data(), "encode_failed\\n")
        }
        return (0, jpeg, cursorMetaString(w: outImg.width, h: outImg.height, bounds: bounds))
      } catch {
        return (1, Data(), "capture_err:\\(error)\\n")
      }
    }

    let cfgKey = "\\(outW)x\\(outH):\\(showCursor ? 1 : 0):\\(clampedFps)"
    var slot: StreamSlot?
    var oldToStop: [StreamSlot] = []
    var needStart = false
    var needUpdate = false

    capLock.lock()
    if let existing = slotObjs[target] as? StreamSlot {
      if existing.receiver.stoppedError != nil {
        oldToStop.append(existing)
        slotObjs.removeValue(forKey: target)
        needStart = true
      } else {
        existing.lastAccessAt = now
        existing.bounds = bounds
        if existing.cfgKey != cfgKey {
          existing.cfgKey = cfgKey
          existing.cachedFrameJpeg = nil
          needUpdate = true
        }
        slot = existing
      }
    } else {
      needStart = true
      while slotObjs.count >= maxConcurrentStreams {
        if let oldestEntry = slotObjs.compactMap({ (k, v) -> (String, StreamSlot)? in
          guard let s = v as? StreamSlot else { return nil }
          return (k, s)
        }).min(by: { $0.1.lastAccessAt < $1.1.lastAccessAt }) {
          oldToStop.append(oldestEntry.1)
          slotObjs.removeValue(forKey: oldestEntry.0)
        } else {
          break
        }
      }
    }
    capLock.unlock()

    for os in oldToStop {
      try? runSync { try await os.stream.stopCapture() }
      os.receiver.clear()
    }

    if needStart {
      let newRecv = StreamReceiver()
      let newStream = SCStream(filter: filter, configuration: cfg, delegate: newRecv)
      let queue = DispatchQueue(label: "hp.scstream.\\(target)", qos: .userInteractive)
      do {
        try newStream.addStreamOutput(newRecv, type: .screen, sampleHandlerQueue: queue)
        try runSync {
          try await newStream.startCapture()
        }
        let created = StreamSlot(target: target, cfgKey: cfgKey, stream: newStream, receiver: newRecv, bounds: bounds, lastAccessAt: Date())
        capLock.lock()
        slotObjs[target] = created
        capLock.unlock()
        slot = created
      } catch {
        slot = nil
      }
    } else if needUpdate, let curSlot = slot {
      try? runSync {
        try await curSlot.stream.updateConfiguration(cfg)
      }
    }

    if let active = slot {
      let recv = active.receiver
      recv.cond.lock()
      if recv.latestBuffer == nil {
        let dl = Date(timeIntervalSinceNow: 0.09)
        while recv.latestBuffer == nil && recv.stoppedError == nil && Date() < dl {
          if !recv.cond.wait(until: dl) { break }
        }
      }
      let buf = recv.latestBuffer
      let seq = recv.latestSeq
      recv.cond.unlock()

      if let pxBuf = buf {
        let cacheKey = "\\(cfgKey):q\\(Int((quality * 100).rounded()))"
        capLock.lock()
        active.lastAccessAt = Date()
        if let c = active.cachedFrameJpeg, c.seq == seq, c.key == cacheKey {
          if sinceSeq > 0 && seq == sinceSeq {
            let meta = "unchanged\\n" + cursorMetaString(w: c.w, h: c.h, bounds: bounds, seq: seq)
            capLock.unlock()
            return (0, Data(), meta)
          }
          let meta = cursorMetaString(w: c.w, h: c.h, bounds: bounds, seq: seq)
          capLock.unlock()
          return (0, c.data, meta)
        }
        capLock.unlock()

        let w = CVPixelBufferGetWidth(pxBuf)
        let h = CVPixelBufferGetHeight(pxBuf)
        let ci = CIImage(cvImageBuffer: pxBuf)
        let clampedQ = max(0.35, min(0.95, quality))
        let opts: [CIImageRepresentationOption: Any] = [
          CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): clampedQ
        ]
        if let jpeg = ciContext.jpegRepresentation(of: ci, colorSpace: srgbSpace, options: opts)
            ?? ciContext.createCGImage(ci, from: CGRect(x: 0, y: 0, width: w, height: h)).flatMap({ encodeJpeg($0, quality: clampedQ) }) {
          capLock.lock()
          active.cachedFrameJpeg = (seq, cacheKey, jpeg, w, h)
          capLock.unlock()
          return (0, jpeg, cursorMetaString(w: w, h: h, bounds: bounds, seq: seq))
        }
      }
    }

    do {
      let outImg = try runSync {
        try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
      }
      guard let jpeg = encodeJpeg(outImg, quality: quality) else {
        return (1, Data(), "encode_failed\\n")
      }
      return (0, jpeg, cursorMetaString(w: outImg.width, h: outImg.height, bounds: bounds))
    } catch {
      return (1, Data(), "capture_err:\\(error)\\n")
    }
  }

  func handleMouse(_ args: [String]) {
    let x = Double(args[1]) ?? 0
    let y = Double(args[2]) ?? 0
    let btn = args[3]
    let action = args[4]
    let pid = args.count >= 6 ? (Int32(args[5]) ?? 0) : 0
    let flags = args.count >= 7 ? parseModifierFlags(args[6]) : CGEventFlags()
    let pt = CGPoint(x: x, y: y)
    let cgBtn: CGMouseButton = btn == "right" ? .right : (btn == "middle" ? .center : .left)

    if action == "move" || action == "drag" {
      if action == "move" && isLocalPocketFrontmost() {
        // Avoid warping the local user's cursor back out of Herdr Pocket when hovering a local portal preview.
        return
      }
      CGWarpMouseCursorPosition(pt)
      CGAssociateMouseAndMouseCursorPosition(boolean_t(1))
      let isDrag = action == "drag" || !heldButtons.isEmpty
      let activeBtn = heldButtons.contains("right") ? "right" : (heldButtons.contains("middle") ? "middle" : btn)
      let evType: CGEventType
      let dragCgBtn: CGMouseButton
      if isDrag {
        if activeBtn == "right" {
          evType = .rightMouseDragged; dragCgBtn = .right
        } else if activeBtn == "middle" {
          evType = .otherMouseDragged; dragCgBtn = .center
        } else {
          evType = .leftMouseDragged; dragCgBtn = .left
        }
      } else {
        evType = .mouseMoved; dragCgBtn = .left
      }
      if let ev = CGEvent(mouseEventSource: nil, mouseType: evType, mouseCursorPosition: pt, mouseButton: dragCgBtn) {
        if !flags.isEmpty { ev.flags = flags }
        ev.post(tap: .cghidEventTap)
      }
      return
    }

    if pid > 0 { activatePid(pid) }
    let downType: CGEventType = btn == "right" ? .rightMouseDown : (btn == "middle" ? .otherMouseDown : .leftMouseDown)
    let upType: CGEventType = btn == "right" ? .rightMouseUp : (btn == "middle" ? .otherMouseUp : .leftMouseUp)

    if action == "down" {
      heldButtons.insert(btn)
      if let mv = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left) {
        mv.post(tap: .cghidEventTap)
      }
      if let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: pt, mouseButton: cgBtn) {
        down.setIntegerValueField(.mouseEventClickState, value: 1)
        if !flags.isEmpty { down.flags = flags }
        down.post(tap: .cghidEventTap)
      }
      return
    }
    if action == "up" {
      heldButtons.remove(btn)
      if let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: pt, mouseButton: cgBtn) {
        up.setIntegerValueField(.mouseEventClickState, value: 1)
        if !flags.isEmpty { up.flags = flags }
        up.post(tap: .cghidEventTap)
      }
      return
    }

    heldButtons.remove(btn)
    let count = max(1, Int(action) ?? 1)
    if let mv = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left) {
      mv.post(tap: .cghidEventTap)
    }
    for c in 1...count {
      if let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: pt, mouseButton: cgBtn) {
        down.setIntegerValueField(.mouseEventClickState, value: Int64(c))
        if !flags.isEmpty { down.flags = flags }
        down.post(tap: .cghidEventTap)
      }
      if let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: pt, mouseButton: cgBtn) {
        up.setIntegerValueField(.mouseEventClickState, value: Int64(c))
        if !flags.isEmpty { up.flags = flags }
        up.post(tap: .cghidEventTap)
      }
    }
  }

  func handleScroll(_ args: [String]) {
    let dy = Int32(args[1]) ?? 0
    let dx = Int32(args[2]) ?? 0
    if args.count >= 5 && !isLocalPocketFrontmost(), let x = Double(args[3]), let y = Double(args[4]) {
      let pt = CGPoint(x: x, y: y)
      CGWarpMouseCursorPosition(pt)
      CGAssociateMouseAndMouseCursorPosition(boolean_t(1))
    }
    let flags = args.count >= 6 ? parseModifierFlags(args[5]) : CGEventFlags()
    if let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
      if !flags.isEmpty { ev.flags = flags }
      ev.post(tap: .cghidEventTap)
    }
  }

  func handleKey(_ args: [String]) {
    let rawKey = args[1]
    if args.count >= 3, let pid = Int32(args[2]) { activatePid(pid) }
    var flags = args.count >= 4 ? parseModifierFlags(args[3]) : CGEventFlags()
    let phase = args.count >= 5 ? args[4] : "press"

    var lookup = rawKey
    if KEY_CODES[lookup] == nil {
      if let alias = SHIFT_ALIAS[lookup] {
        lookup = alias
        flags.insert(.maskShift)
      } else {
        let lower = lookup.lowercased()
        if KEY_CODES[lower] != nil {
          if rawKey.count == 1 && rawKey != lower { flags.insert(.maskShift) }
          lookup = lower
        }
      }
    }

    if let code = KEY_CODES[lookup] {
      if phase == "down" || phase == "press" {
        if let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) {
          if !flags.isEmpty { down.flags = flags }
          down.post(tap: .cghidEventTap)
        }
      }
      if phase == "up" || phase == "press" {
        if let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
          if !flags.isEmpty { up.flags = flags }
          up.post(tap: .cghidEventTap)
        }
      }
    } else if flags.isEmpty && phase != "up" {
      let utf16 = Array(rawKey.utf16)
      let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
      let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
      down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
      up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
      down?.post(tap: .cghidEventTap)
      up?.post(tap: .cghidEventTap)
    }
  }

  func execute(_ args: [String], persistentStream: Bool) -> (code: Int32, out: Data, err: String) {
    guard let cmd = args.first else { return (1, Data(), "missing_cmd") }
    switch cmd {
    case "check":
      let scOk = CGPreflightScreenCaptureAccess()
      let axOk = AXIsProcessTrusted()
      let obj: [String: Any] = ["screenCapture": scOk, "accessibility": axOk]
      let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
      return (0, data, "")
    case "list":
      return (0, buildWindowListJson(), "")
    case "capture":
      guard args.count >= 2 else { return (1, Data(), "missing_target") }
      let target = args[1]
      let maxDim = args.count >= 3 ? (Int(args[2]) ?? 1600) : 1600
      let qRaw = args.count >= 4 ? (Double(args[3]) ?? 72.0) : 72.0
      let quality = qRaw > 1.0 ? (qRaw / 100.0) : qRaw
      let showCursor = args.count >= 5 ? (args[4] != "0") : true
      let fps = args.count >= 6 ? (Int(args[5]) ?? 30) : 30
      let sinceSeq = args.count >= 7 ? (UInt64(args[6]) ?? 0) : 0
      if #available(macOS 14.0, *) {
        return capture(target: target, maxDim: maxDim, quality: quality, showCursor: showCursor, fps: fps, persistentStream: persistentStream, sinceSeq: sinceSeq)
      } else {
        return (1, Data(), "unsupported_macos_version\\n")
      }
    case "click":
      guard args.count >= 5 else { return (1, Data(), "bad_click_args") }
      handleMouse(args)
      return (0, Data(), "")
    case "scroll":
      guard args.count >= 3 else { return (1, Data(), "bad_scroll_args") }
      handleScroll(args)
      return (0, Data(), "")
    case "text":
      guard args.count >= 2 else { return (1, Data(), "bad_text_args") }
      if args.count >= 3, let pid = Int32(args[2]) { activatePid(pid) }
      let utf16 = Array(args[1].utf16)
      let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
      let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
      down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
      up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
      down?.post(tap: .cghidEventTap)
      up?.post(tap: .cghidEventTap)
      return (0, Data(), "")
    case "key":
      guard args.count >= 2 else { return (1, Data(), "bad_key_args") }
      handleKey(args)
      return (0, Data(), "")
    case "clipboard":
      guard args.count >= 2 else { return (1, Data(), "bad_clipboard_args") }
      if args[1] == "get" {
        let str = NSPasteboard.general.string(forType: .string) ?? ""
        return (0, Data(str.utf8), "")
      }
      if args[1] == "set" {
        let b64 = args.count >= 3 ? args[2] : ""
        let decoded = Data(base64Encoded: b64).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(decoded, forType: .string)
        return (0, Data("ok".utf8), "")
      }
      return (1, Data(), "bad_clipboard_action")
    default:
      return (1, Data(), "unknown_command")
    }
  }
}

func writeBinaryPacket(code: Int32, meta: String, out: Data) {
  let metaData = Data(meta.utf8)
  var header = Data(capacity: 16)
  header.append(contentsOf: [0x48, 0x50, 0x42, 0x31]) // "HPB1"
  var codeBE = code.bigEndian
  var metaLenBE = UInt32(clamping: metaData.count).bigEndian
  var outLenBE = UInt32(clamping: out.count).bigEndian
  withUnsafeBytes(of: &codeBE) { header.append(contentsOf: $0) }
  withUnsafeBytes(of: &metaLenBE) { header.append(contentsOf: $0) }
  withUnsafeBytes(of: &outLenBE) { header.append(contentsOf: $0) }
  FileHandle.standardOutput.write(header)
  if !metaData.isEmpty { FileHandle.standardOutput.write(metaData) }
  if !out.isEmpty { FileHandle.standardOutput.write(out) }
}

let engine = PortalEngine()
let cliArgs = Array(CommandLine.arguments.dropFirst())
if cliArgs.first == "serve-bin" {
  engine.startIdleReaper()
  DispatchQueue.global(qos: .userInteractive).async {
    while let line = readLine(strippingNewline: true) {
      let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty { continue }
      var code: Int32 = -1
      var out = Data()
      var meta = "invalid_request"
      if let data = trimmed.data(using: .utf8),
         let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let reqArgs = obj["args"] as? [String] {
        let res = engine.execute(reqArgs, persistentStream: true)
        code = res.code
        out = res.out
        meta = res.err
      }
      writeBinaryPacket(code: code, meta: meta, out: out)
    }
    exit(0)
  }
  RunLoop.main.run()
} else if cliArgs.first == "serve" {
  engine.startIdleReaper()
  DispatchQueue.global(qos: .userInteractive).async {
    while let line = readLine(strippingNewline: true) {
      let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty { continue }
      var respObj: [String: Any] = ["code": -1, "stdoutBase64": "", "stderr": "invalid_request"]
      if let data = trimmed.data(using: .utf8),
         let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let reqArgs = obj["args"] as? [String] {
        let res = engine.execute(reqArgs, persistentStream: true)
        respObj = [
          "code": Int(res.code),
          "stdoutBase64": res.out.base64EncodedString(),
          "stderr": res.err
        ]
      }
      if let outData = try? JSONSerialization.data(withJSONObject: respObj),
         let outStr = String(data: outData, encoding: .utf8) {
        print(outStr)
        fflush(stdout)
      }
    }
    exit(0)
  }
  RunLoop.main.run()
} else if !cliArgs.isEmpty {
  let res = engine.execute(cliArgs, persistentStream: false)
  if !res.err.isEmpty {
    FileHandle.standardError.write(Data(res.err.utf8))
  }
  if !res.out.isEmpty {
    FileHandle.standardOutput.write(res.out)
  }
  fflush(stdout)
  exit(res.code)
} else {
  exit(1)
}
`;

export type CaptureWindowResult = {
  mime: "image/jpeg" | "image/png";
  data: string;
  rawBytes?: Buffer;
  width: number;
  height: number;
  bounds?: RemoteWindowInfo["bounds"];
  pid?: number;
  cursorX?: number;
  cursorY?: number;
  cursorVisible?: boolean;
  captureMs?: number;
  nativeSeq?: string;
  unchanged?: boolean;
};

export interface CaptureWindowOptions {
  maxWidth?: number;
  quality?: number;
  showCursor?: boolean;
  fps?: number;
  sinceNativeSeq?: string;
  skipBase64?: boolean;
}

/** Persistent keep-alive Unix domain socket client that degrades cleanly on one-shot mock servers. */
class PersistBridgeSocket {
  private sock: Socket | null = null;
  private currentPath = "";
  private rxChunks: Buffer[] = [];
  private active: { finish: (res: CaptureExecResult | null) => void } | null = null;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  request(sockPath: string, args: string[], timeoutMs: number): Promise<CaptureExecResult | null> {
    if (this.disposed) return Promise.resolve(null);
    const run = async (): Promise<CaptureExecResult | null> => {
      if (this.disposed) return null;
      if (this.currentPath && this.currentPath !== sockPath) {
        this.resetSocket();
      }
      this.currentPath = sockPath;

      const attempt = (allowReuse: boolean): Promise<{ ok: boolean; res: CaptureExecResult | null }> =>
        new Promise((resolve) => {
          let done = false;
          let entry: { finish: (res: CaptureExecResult | null) => void } | null = null;
          let reused = false;
          let delivered = false;
          const finish = (res: CaptureExecResult | null, dropSocket = false, ok = res !== null) => {
            if (done) return;
            done = true;
            clearTimeout(connectTimer);
            clearTimeout(totalTimer);
            if (entry && this.active === entry) this.active = null;
            if (dropSocket) this.resetSocket();
            resolve({ ok, res });
          };

          entry = {
            finish: (r) => {
              delivered = true;
              finish(r, false, true);
            },
          };
          const handleParsed = (parsed: {
            code?: number;
            stdoutBase64?: string;
            stderr?: string;
            keepAlive?: boolean;
          }) => {
            if (!parsed.keepAlive) this.resetSocket();
            if (typeof parsed.code === "number" && parsed.stderr !== "helper_missing") {
              delivered = true;
              finish(
                {
                  code: parsed.code,
                  stdout: Buffer.from(parsed.stdoutBase64 || "", "base64"),
                  stderr: parsed.stderr || "",
                },
                !parsed.keepAlive,
                true,
              );
            } else {
              delivered = true;
              finish(null, !parsed.keepAlive, true);
            }
          };
          this.active = entry;
          const connectTimer = setTimeout(() => {
            finish(null, true, false);
          }, 250);
          const totalTimer = setTimeout(() => {
            finish(null, true, false);
          }, Math.max(450, timeoutMs));

          const writeReq = (s: Socket) => {
            clearTimeout(connectTimer);
            try {
              s.write(`${JSON.stringify({ args, timeoutMs })}\n`);
            } catch {
              finish(null, true, false);
            }
          };

          const canReuse = Boolean(
            allowReuse &&
              this.sock &&
              !this.sock.destroyed &&
              this.sock.readable &&
              this.sock.writable &&
              !this.sock.readableEnded,
          );
          if (canReuse && this.sock) {
            reused = true;
            writeReq(this.sock);
            return;
          }
          if (this.sock) {
            this.resetSocket();
          }

          const sock = connectSocket(sockPath);
          this.sock = sock;
          this.rxChunks = [];

          const drainLines = () => {
            let nl = -1;
            let buf: Buffer | null = null;
            const ensureBuf = () => {
              if (!buf && this.rxChunks.length > 0) {
                buf = this.rxChunks.length === 1 ? this.rxChunks[0]! : Buffer.concat(this.rxChunks);
                this.rxChunks = buf.length > 0 ? [buf] : [];
              }
              return buf;
            };
            const merged = ensureBuf();
            if (!merged) return;
            let offset = 0;
            nl = merged.indexOf(0x0a, offset);
            while (nl >= 0) {
              const line = merged.toString("utf8", offset, nl).trim();
              offset = nl + 1;
              nl = merged.indexOf(0x0a, offset);
              if (!line || !this.active) continue;
              try {
                const parsed = JSON.parse(line) as {
                  code?: number;
                  stdoutBase64?: string;
                  stderr?: string;
                  keepAlive?: boolean;
                };
                handleParsed(parsed);
              } catch {
                this.active.finish(null);
              }
            }
            if (offset > 0) {
              this.rxChunks = offset < merged.length ? [merged.subarray(offset)] : [];
            }
          };

          sock.on("data", (chunk: Buffer | string) => {
            if (this.sock !== sock) return;
            const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
            this.rxChunks.push(b);
            if (b.includes(0x0a)) drainLines();
          });

          sock.once("end", () => {
            if (this.sock !== sock) return;
            const trimmed = this.rxChunks.length ? Buffer.concat(this.rxChunks).toString("utf8").trim() : "";
            this.rxChunks = [];
            if (trimmed && this.active === entry && entry) {
              try {
                const parsed = JSON.parse(trimmed) as {
                  code?: number;
                  stdoutBase64?: string;
                  stderr?: string;
                  keepAlive?: boolean;
                };
                handleParsed(parsed);
                return;
              } catch {
                // fall through
              }
            }
            this.resetSocket();
            if (!delivered) finish(null, false, !reused);
          });

          sock.once("error", () => {
            if (this.sock !== sock) return;
            this.resetSocket();
            if (!delivered) finish(null, false, !reused);
          });

          sock.once("close", () => {
            if (this.sock === sock) {
              this.sock = null;
              this.rxChunks = [];
            }
            if (!delivered && entry && this.active === entry) {
              finish(null, false, !reused);
            }
          });

          sock.once("connect", () => {
            if (this.sock === sock && !done) writeReq(sock);
          });
        });

      const first = await attempt(true);
      if (first.ok || this.disposed) return first.res;
      const retry = await attempt(false);
      return retry.res;
    };

    const next = this.chain.then(run, run);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private resetSocket(): void {
    const s = this.sock;
    this.sock = null;
    this.rxChunks = [];
    if (s && !s.destroyed) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    const cur = this.active;
    this.active = null;
    cur?.finish(null);
    this.resetSocket();
  }
}

/** Persistent child process runner speaking binary HPB1 / JSON (macOS) or base64-TSV (Windows). */
class PersistServeChild {
  private proc: ChildProcess | null = null;
  private binPath = "";
  private rxChunks: Buffer[] = [];
  private rxLen = 0;
  private active: { finish: (res: CaptureExecResult | null) => void } | null = null;
  private chain: Promise<void> = Promise.resolve();
  private unsupported = false;
  private disposed = false;
  private mode: "json" | "tsv" | "bin";

  constructor(mode: "json" | "tsv" | "bin") {
    this.mode = mode;
  }

  isUnsupported(): boolean {
    return this.unsupported;
  }

  request(bin: string, args: string[], timeoutMs: number): Promise<CaptureExecResult | null> {
    if (this.disposed || this.unsupported) return Promise.resolve(null);
    if (this.binPath && this.binPath !== bin) this.killProc();
    this.binPath = bin;

    const run = async (): Promise<CaptureExecResult | null> => {
      if (this.disposed || this.unsupported) return null;
      return new Promise<CaptureExecResult | null>((resolve) => {
        let done = false;
        let entry: { finish: (res: CaptureExecResult | null) => void } | null = null;
        const finish = (res: CaptureExecResult | null, kill = false) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (entry && this.active === entry) this.active = null;
          if (kill) this.killProc();
          resolve(res);
        };
        entry = { finish: (r) => finish(r, false) };
        this.active = entry;
        const timer = setTimeout(() => finish(null, true), Math.max(450, timeoutMs));

        if (!this.proc || this.proc.killed || this.proc.exitCode !== null) {
          this.rxChunks = [];
          this.rxLen = 0;
          const spawnArg = this.mode === "bin" ? "serve-bin" : "serve";
          const child = spawn(bin, [spawnArg], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
          child.unref?.();
          this.proc = child;

          const consumeTextLines = () => {
            if (!this.rxChunks.length) return;
            const buf = this.rxChunks.length === 1 ? this.rxChunks[0]! : Buffer.concat(this.rxChunks, this.rxLen);
            let offset = 0;
            let nl = buf.indexOf(0x0a, offset);
            while (nl >= 0) {
              const line = buf.toString("utf8", offset, nl).trim();
              offset = nl + 1;
              nl = buf.indexOf(0x0a, offset);
              if (!line || !this.active) continue;
              if (this.mode === "json") {
                try {
                  const parsed = JSON.parse(line) as { code?: number; stdoutBase64?: string; stderr?: string };
                  if (typeof parsed.code === "number") {
                    this.active.finish({
                      code: parsed.code,
                      stdout: Buffer.from(parsed.stdoutBase64 || "", "base64"),
                      stderr: parsed.stderr || "",
                    });
                    continue;
                  }
                } catch {
                  // fall through
                }
                this.active.finish(null);
              } else {
                const parts = line.split("\t");
                if (parts.length >= 2) {
                  this.active.finish({
                    code: Number.parseInt(parts[0]!, 10) || 0,
                    stdout: Buffer.from(parts[1]!, "base64"),
                    stderr: parts[2] ? Buffer.from(parts[2]!, "base64").toString("utf8") : "",
                  });
                } else {
                  this.active.finish(null);
                }
              }
            }
            if (offset > 0) {
              const rem = buf.subarray(offset);
              this.rxChunks = rem.length > 0 ? [rem] : [];
              this.rxLen = rem.length;
            } else {
              this.rxChunks = [buf];
              this.rxLen = buf.length;
            }
          };

          const consumeBinaryPackets = () => {
            if (this.rxLen < 16) return;
            const buf = this.rxChunks.length === 1 ? this.rxChunks[0]! : Buffer.concat(this.rxChunks, this.rxLen);
            let offset = 0;
            while (buf.length - offset >= 16) {
              if (
                buf[offset] !== 0x48 ||
                buf[offset + 1] !== 0x50 ||
                buf[offset + 2] !== 0x42 ||
                buf[offset + 3] !== 0x31
              ) {
                this.unsupported = true;
                this.active?.finish(null);
                this.killProc();
                return;
              }
              const code = buf.readInt32BE(offset + 4);
              const metaLen = buf.readUInt32BE(offset + 8);
              const outLen = buf.readUInt32BE(offset + 12);
              const totalLen = 16 + metaLen + outLen;
              if (metaLen > 1024 * 1024 || outLen > 64 * 1024 * 1024) {
                this.unsupported = true;
                this.active?.finish(null);
                this.killProc();
                return;
              }
              if (buf.length - offset < totalLen) break;
              const meta = metaLen > 0 ? buf.toString("utf8", offset + 16, offset + 16 + metaLen) : "";
              const outSlice = outLen > 0 ? Buffer.from(buf.subarray(offset + 16 + metaLen, offset + totalLen)) : Buffer.alloc(0);
              offset += totalLen;
              this.active?.finish({ code, stdout: outSlice, stderr: meta });
            }
            const rem = buf.subarray(offset);
            this.rxChunks = rem.length > 0 ? [rem] : [];
            this.rxLen = rem.length;
          };

          child.stdout?.on("data", (chunk: Buffer) => {
            this.rxChunks.push(chunk);
            this.rxLen += chunk.length;
            if (this.mode === "bin") {
              consumeBinaryPackets();
            } else if (chunk.includes(0x0a)) {
              consumeTextLines();
            }
          });

          const onExit = () => {
            if (this.proc === child) this.proc = null;
            if (this.active) {
              // Binary exited before replying to serve request -> old binary without serve/serve-bin support.
              this.unsupported = true;
              const cur = this.active;
              this.active = null;
              cur.finish(null);
            }
          };
          child.once("error", onExit);
          child.once("exit", onExit);
        }

        const p = this.proc;
        if (!p || !p.stdin?.writable) {
          finish(null, true);
          return;
        }
        try {
          if (this.mode === "json" || this.mode === "bin") {
            p.stdin.write(`${JSON.stringify({ args })}\n`);
          } else {
            p.stdin.write(`${args.map((a) => Buffer.from(a, "utf8").toString("base64")).join("\t")}\n`);
          }
        } catch {
          finish(null, true);
        }
      });
    };

    const next = this.chain.then(run, run);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private killProc(): void {
    const p = this.proc;
    this.proc = null;
    this.rxChunks = [];
    this.rxLen = 0;
    if (p) {
      try {
        p.kill();
      } catch {
        // ignore
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    const cur = this.active;
    this.active = null;
    cur?.finish(null);
    this.killProc();
  }
}

function parseCaptureMeta(stderr: string, fallbackW: number, fallbackH: number): {
  width: number;
  height: number;
  cursorX?: number;
  cursorY?: number;
  cursorVisible?: boolean;
  seq?: string;
  unchanged?: boolean;
} {
  const dims = /dims:(\d+)x(\d+)/.exec(stderr);
  const cur = /cursor:([0-9.]+),([0-9.]+),([01])/.exec(stderr);
  const seq = /seq:(\d+)/.exec(stderr);
  const unchanged = /(?:^|\n)unchanged\b/.test(stderr);
  return {
    width: dims ? Number(dims[1]) : fallbackW,
    height: dims ? Number(dims[2]) : fallbackH,
    ...(seq && seq[1] !== "0" ? { seq: seq[1] } : {}),
    ...(unchanged ? { unchanged: true } : {}),
    ...(cur
      ? {
          cursorX: Math.min(1, Math.max(0, Number(cur[1]))),
          cursorY: Math.min(1, Math.max(0, Number(cur[2]))),
          cursorVisible: cur[3] === "1",
        }
      : {}),
  };
}

export class OsCaptureDriver {
  private deps: OsCaptureDeps;
  private macHelperBin: string | null = null;
  private macHelperTried = false;
  private winHelperBin: string | null = null;
  private winHelperTried = false;
  private macScreenRecordingCache: { denied: boolean; accessibility: boolean; at: number } | null = null;
  private desktopBridgeVersion: number | null = null;
  private macDirectCaptureDenied = false;
  private jxaTimedOutUntil = 0;
  private windowsCache: { at: number; list: RemoteWindowInfo[] } | null = null;
  private windowsInflight: Promise<RemoteWindowInfo[]> | null = null;
  private captureInflight = new Map<string, Promise<CaptureWindowResult | null>>();
  private lastFrameCache = new Map<string, { at: number; frame: CaptureWindowResult | null }>();
  private bridgeCapture = new PersistBridgeSocket();
  private bridgeControl = new PersistBridgeSocket();
  private macServeCaptureBin = new PersistServeChild("bin");
  private macServeCapture = new PersistServeChild("json");
  private macServeControl = new PersistServeChild("json");
  private winServeCapture = new PersistServeChild("tsv");
  private winServeControl = new PersistServeChild("tsv");

  constructor(deps: OsCaptureDeps = {}) {
    this.deps = deps;
  }

  dispose(): void {
    this.bridgeCapture.dispose();
    this.bridgeControl.dispose();
    this.macServeCaptureBin.dispose();
    this.macServeCapture.dispose();
    this.macServeControl.dispose();
    this.winServeCapture.dispose();
    this.winServeControl.dispose();
  }

  private exec(cmd: string, args: string[], timeoutMs = 6000, env?: NodeJS.ProcessEnv): Promise<CaptureExecResult> {
    return (this.deps.execBin ?? defaultExecBin)(cmd, args, timeoutMs, env);
  }

  private hasCmd(cmd: string, env: NodeJS.ProcessEnv): boolean {
    return (this.deps.hasCmd ?? ((c) => defaultHasCmd(c, env)))(cmd);
  }

  private pathExists(p: string): boolean {
    return (this.deps.pathExists ?? existsSync)(p);
  }

  private async signMacHelperIfPossible(binPath: string): Promise<void> {
    if (this.deps.execBin) return;
    try {
      const info = await defaultExecBin("codesign", ["-dv", binPath], 3000);
      if (info.code === 0 && !info.stderr.includes("Signature=adhoc")) return;
      const ids = await defaultExecBin("security", ["find-identity", "-v", "-p", "codesigning"], 3000);
      if (ids.code !== 0) return;
      const stdout = ids.stdout.toString("utf8");
      const pick =
        /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"Developer ID Application:/m.exec(stdout)?.[1] ??
        /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"Apple Development:/m.exec(stdout)?.[1];
      if (!pick) return;
      await defaultExecBin(
        "codesign",
        ["--force", "--timestamp=none", "-i", "dev.crosery.herdrpocket.portal-helper", "--sign", pick, binPath],
        5000,
      );
    } catch {
      // keep working ad-hoc helper when keychain identity is unavailable
    }
  }

  private async ensureMacHelper(): Promise<string | null> {
    if (this.macHelperBin && existsSync(this.macHelperBin)) return this.macHelperBin;
    if (this.macHelperTried) return null;
    this.macHelperTried = true;
    const binDir = this.deps.binDir ?? join(stateDir(), "bin");
    const binPath = join(binDir, "hp-mac-portal-v3");
    const srcPath = join(binDir, "hp-mac-portal-v3.swift");
    const hasCustomSrc = existsSync(srcPath);
    const sameSource = hasCustomSrc && (() => {
      try {
        return readFileSync(srcPath, "utf8") === MAC_SWIFT_SRC;
      } catch {
        return false;
      }
    })();
    if (existsSync(binPath) && (sameSource || (this.deps.execBin && !hasCustomSrc))) {
      await this.signMacHelperIfPossible(binPath);
      this.macHelperBin = binPath;
      return binPath;
    }
    if (!this.hasCmd("swiftc", process.env)) {
      if (existsSync(binPath)) {
        this.macHelperBin = binPath;
        return binPath;
      }
      return null;
    }
    try {
      mkdirSync(binDir, { recursive: true });
      const tmpSrc = join(binDir, `hp-mac-portal-v3.tmp-${process.pid}.swift`);
      const tmpBin = join(binDir, `hp-mac-portal-v3.tmp-${process.pid}`);
      writeFileSync(tmpSrc, MAC_SWIFT_SRC);
      const r = await this.exec("swiftc", ["-O", tmpSrc, "-o", tmpBin], 45_000);
      rmSync(tmpSrc, { force: true });
      if (r.code === 0 && existsSync(tmpBin)) {
        await this.signMacHelperIfPossible(tmpBin);
        renameSync(tmpBin, binPath);
        writeFileSync(srcPath, MAC_SWIFT_SRC);
        this.macHelperBin = binPath;
        return binPath;
      }
      rmSync(tmpBin, { force: true });
      if (existsSync(binPath)) {
        this.macHelperBin = binPath;
        return binPath;
      }
    } catch {
      // fall back to existing helper or screencapture + osascript
      if (existsSync(binPath)) {
        this.macHelperBin = binPath;
        return binPath;
      }
    }
    return null;
  }

  private async ensureWinHelper(): Promise<string | null> {
    if (this.winHelperBin && existsSync(this.winHelperBin)) return this.winHelperBin;
    if (this.winHelperTried) return null;
    this.winHelperTried = true;
    const binDir = this.deps.binDir ?? join(stateDir(), "bin");
    const binPath = join(binDir, "hp-win-portal-v1.exe");
    const srcPath = join(binDir, "hp-win-portal-v1.cs");
    const hasCustomSrc = existsSync(srcPath);
    const sameSource = hasCustomSrc && (() => {
      try {
        return readFileSync(srcPath, "utf8") === WIN_CS_SRC;
      } catch {
        return false;
      }
    })();
    if (existsSync(binPath) && (sameSource || (this.deps.execBin && !hasCustomSrc))) {
      this.winHelperBin = binPath;
      return binPath;
    }
    const sysRoot = process.env.SystemRoot || "C:\\Windows";
    const cscCandidates = [
      join(sysRoot, "Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"),
      join(sysRoot, "Microsoft.NET\\Framework\\v4.0.30319\\csc.exe"),
    ];
    const csc = cscCandidates.find((p) => existsSync(p)) ?? (this.hasCmd("csc", process.env) ? "csc" : null);
    if (!csc) {
      if (existsSync(binPath)) {
        this.winHelperBin = binPath;
        return binPath;
      }
      return null;
    }
    try {
      mkdirSync(binDir, { recursive: true });
      const tmpSrc = join(binDir, `hp-win-portal-v1.tmp-${process.pid}.cs`);
      const tmpBin = join(binDir, `hp-win-portal-v1.tmp-${process.pid}.exe`);
      writeFileSync(tmpSrc, WIN_CS_SRC);
      const r = await this.exec(
        csc,
        ["/nologo", "/optimize+", "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll", `/out:${tmpBin}`, tmpSrc],
        25_000,
      );
      rmSync(tmpSrc, { force: true });
      if (r.code === 0 && existsSync(tmpBin)) {
        renameSync(tmpBin, binPath);
        writeFileSync(srcPath, WIN_CS_SRC);
        this.winHelperBin = binPath;
        return binPath;
      }
      rmSync(tmpBin, { force: true });
      if (existsSync(binPath)) {
        this.winHelperBin = binPath;
        return binPath;
      }
    } catch {
      if (existsSync(binPath)) {
        this.winHelperBin = binPath;
        return binPath;
      }
    }
    return null;
  }

  private async runWinHelper(
    args: string[],
    timeoutMs = 7000,
    channel: "capture" | "control" = "control",
  ): Promise<CaptureExecResult> {
    const exe = await this.ensureWinHelper();
    if (exe) {
      if (!this.deps.execBin) {
        const served = await (channel === "capture" ? this.winServeCapture : this.winServeControl).request(
          exe,
          args,
          timeoutMs,
        );
        if (served) return served;
      }
      return this.exec(exe, args, timeoutMs);
    }
    return this.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", buildWin32InlinePs(args)], timeoutMs);
  }

  private resolvePortalBridgeSocket(): string {
    return this.deps.portalBridgeSocket ?? join(stateDir(this.deps.env), "desktop-portal.sock");
  }

  private async execViaDesktopBridge(
    args: string[],
    timeoutMs: number,
    channel: "capture" | "control",
  ): Promise<CaptureExecResult | null> {
    if (this.deps.execBin && !this.deps.portalBridgeSocket) return null;
    const sockPath = this.resolvePortalBridgeSocket();
    if (!this.pathExists(sockPath)) return null;
    const client = channel === "capture" ? this.bridgeCapture : this.bridgeControl;
    return client.request(sockPath, args, timeoutMs);
  }

  private async execMacHelper(
    helperPath: string | null,
    args: string[],
    timeoutMs: number,
  ): Promise<{ res: CaptureExecResult; viaBridge: boolean } | null> {
    const channel: "capture" | "control" = args[0] === "capture" ? "capture" : "control";
    if (
      channel === "capture" &&
      !this.deps.portalBridgeSocket &&
      this.desktopBridgeVersion === null &&
      !this.deps.execBin &&
      this.pathExists(this.resolvePortalBridgeSocket())
    ) {
      await this.refreshMacPerms();
    }
    const useBridgeForChannel =
      channel !== "capture" ||
      Boolean(this.deps.portalBridgeSocket) ||
      (this.desktopBridgeVersion ?? 0) >= 2 ||
      this.macDirectCaptureDenied;
    if (useBridgeForChannel) {
      const bridged = await this.execViaDesktopBridge(args, timeoutMs, channel);
      if (bridged && !bridged.stderr.startsWith("helper_missing:") && bridged.stderr !== "disallowed_command") {
        return { res: bridged, viaBridge: true };
      }
    }
    if (!helperPath) {
      const bridged = await this.execViaDesktopBridge(args, timeoutMs, channel);
      if (bridged && !bridged.stderr.startsWith("helper_missing:") && bridged.stderr !== "disallowed_command") {
        return { res: bridged, viaBridge: true };
      }
      return null;
    }
    if (!this.deps.execBin) {
      let served: CaptureExecResult | null = null;
      if (channel === "capture") {
        served = await this.macServeCaptureBin.request(helperPath, args, timeoutMs);
        if (!served && this.macServeCaptureBin.isUnsupported()) {
          served = await this.macServeCapture.request(helperPath, args, timeoutMs);
        }
      } else {
        served = await this.macServeControl.request(helperPath, args, timeoutMs);
      }
      if (served) {
        if (channel === "capture" && served.code === 2 && !useBridgeForChannel) {
          const bridged = await this.execViaDesktopBridge(args, timeoutMs, channel);
          if (bridged && !bridged.stderr.startsWith("helper_missing:") && bridged.stderr !== "disallowed_command") {
            if (bridged.code === 0) {
              this.macDirectCaptureDenied = true;
            }
            return { res: bridged, viaBridge: true };
          }
        }
        return { res: served, viaBridge: false };
      }
    }
    return { res: await this.exec(helperPath, args, timeoutMs), viaBridge: false };
  }

  private async refreshMacPerms(): Promise<{ denied: boolean; accessibility: boolean } | null> {
    const cacheTtl = this.macScreenRecordingCache?.denied ? 1_200 : 4_000;
    if (this.macScreenRecordingCache && Date.now() - this.macScreenRecordingCache.at < cacheTtl) {
      return {
        denied: this.macScreenRecordingCache.denied,
        accessibility: this.macScreenRecordingCache.accessibility,
      };
    }
    const helper = await this.ensureMacHelper();
    try {
      const execOut = await this.execMacHelper(helper, ["check"], 2000);
      if (execOut && execOut.res.code === 0) {
        const parsed = JSON.parse(execOut.res.stdout.toString("utf8")) as {
          screenCapture?: boolean;
          accessibility?: boolean;
          bridgeVersion?: number;
        };
        if (execOut.viaBridge) {
          this.desktopBridgeVersion = typeof parsed.bridgeVersion === "number" ? parsed.bridgeVersion : 1;
        }
        const denied = parsed.screenCapture === false;
        const accessibility = parsed.accessibility !== false;
        this.macScreenRecordingCache = { denied, accessibility, at: Date.now() };
        return { denied, accessibility };
      }
    } catch {
      // ignore check error
    }
    return null;
  }

  async checkPermissionNote(): Promise<string | null> {
    const info = detectPortalSession(this.deps);
    if (info.sessionType === "win32") {
      if (this.hasCmd("wsl.exe", info.env) || this.hasCmd("wsl", info.env)) {
        const procs = await this.listProcessParents().catch(() => new Map<number, { ppid: number; name: string }>());
        const hasXOrWslg = [...procs.values()].some((p) =>
          /(?:vcxsrv|x410|xming|xwin|mobaxterm|msrdc|wslg)/i.test(p.name),
        );
        const wslgExe = "C:\\ProgramData\\Microsoft\\WSL\\wslg.exe";
        if (!hasXOrWslg && !this.pathExists(wslgExe)) {
          return "检测到本机安装了 WSL；如需将 Linux X11 GUI 窗口回传，请开启 Windows 11 WSLg 或启动 VcXsrv / X410（勾选 Disable access control）";
        }
      }
      return null;
    }
    if (info.sessionType !== "macos") return null;
    const bridgeLive = this.pathExists(this.resolvePortalBridgeSocket());
    const desktopInstalled = bridgeLive || this.pathExists("/Applications/Herdr Pocket.app");
    const noteMsg = desktopInstalled
      ? "需开启 Herdr Pocket「屏幕录制」权限以捕获窗口画面"
      : "请在系统设置 → 隐私与安全性 → 屏幕录制 中开启抓屏权限";
    const st = await this.refreshMacPerms();
    if (st?.denied) return noteMsg;
    return null;
  }

  async checkInputPermissionNote(): Promise<string | null> {
    const info = detectPortalSession(this.deps);
    if (info.sessionType !== "macos") return null;
    const st = await this.refreshMacPerms();
    if (st && !st.accessibility) {
      return "需开启「辅助功能」权限以支持远程鼠标移动、点击、拖拽与键盘控制";
    }
    return null;
  }

  async listProcessParents(): Promise<Map<number, { ppid: number; name: string }>> {
    const out = new Map<number, { ppid: number; name: string }>();
    if (this.deps.listProcesses) {
      const rows = await this.deps.listProcesses().catch(() => []);
      for (const row of rows) {
        if (row.pid > 0) out.set(row.pid, { ppid: row.ppid, name: row.name });
      }
      return out;
    }
    const info = detectPortalSession(this.deps);
    if (info.sessionType === "win32") {
      try {
        const r = await this.runWinHelper(["ps"], 4500);
        if (r.code === 0 && r.stdout.length > 0) {
          const rows = JSON.parse(r.stdout.toString("utf8")) as Array<{ pid?: number; ppid?: number; name?: string }>;
          for (const row of rows) {
            if (typeof row.pid === "number" && row.pid > 0) {
              out.set(row.pid, { ppid: Number(row.ppid ?? 0), name: String(row.name ?? "") });
            }
          }
          if (out.size > 0) return out;
        }
      } catch {
        // fallback below
      }
      const r = await this.exec(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"],
        5000,
      ).catch(() => null);
      if (r?.code === 0 && r.stdout.length > 0) {
        try {
          const parsed = JSON.parse(r.stdout.toString("utf8"));
          const list = Array.isArray(parsed) ? parsed : [parsed];
          for (const row of list) {
            const pid = Number(row?.ProcessId ?? 0);
            if (pid > 0) out.set(pid, { ppid: Number(row?.ParentProcessId ?? 0), name: String(row?.Name ?? "") });
          }
        } catch {
          // ignore
        }
      }
      return out;
    }

    const r = await this.exec("ps", ["-eo", "pid=,ppid=,comm="], 2500, info.env).catch(() => null);
    if (r?.code === 0) {
      for (const line of r.stdout.toString("utf8").split("\n")) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        const name = basename(m[3]!);
        if (pid > 0) out.set(pid, { ppid, name });
      }
    }
    return out;
  }

  async listWindows(): Promise<RemoteWindowInfo[]> {
    if (this.windowsInflight) return this.windowsInflight;
    const p = this.listWindowsUncached()
      .then((list) => {
        this.windowsCache = { at: Date.now(), list };
        return list;
      })
      .finally(() => {
        this.windowsInflight = null;
      });
    this.windowsInflight = p;
    return p;
  }

  private async listWindowsUncached(): Promise<RemoteWindowInfo[]> {
    const info = detectPortalSession(this.deps);
    if (info.sessionType === "macos") {
      const helper = await this.ensureMacHelper();
      try {
        const execOut = await this.execMacHelper(helper, ["list"], 4000);
        if (execOut && execOut.res.code === 0) {
          const list = JSON.parse(execOut.res.stdout.toString("utf8")) as RemoteWindowInfo[];
          return [
            { id: "screen:0", appName: "macOS 桌面", title: "主屏幕", isScreen: true },
            ...list,
          ];
        }
      } catch {
        // fallback below
      }
      // Pure JXA fallback listing front processes
      if (Date.now() < this.jxaTimedOutUntil) {
        return [{ id: "screen:0", appName: "macOS 桌面", title: "主屏幕", isScreen: true }];
      }
      try {
        const jxa = `
          var se = Application("System Events");
          var out = [];
          for (var p of se.applicationProcesses.whose({backgroundOnly: false})()) {
            try {
              var name = p.name();
              var pid = p.unixId();
              var wins = p.windows();
              for (var i = 0; i < wins.length; i++) {
                var w = wins[i];
                var pos = w.position();
                var sz = w.size();
                out.push({ id: "jxa:" + pid + ":" + i, appName: name, title: w.name() || name, pid: pid, bounds: { x: pos[0], y: pos[1], width: sz[0], height: sz[1] } });
              }
            } catch (e) {}
          }
          JSON.stringify(out);
        `;
        const r = await this.exec("osascript", ["-l", "JavaScript", "-e", jxa], 1500);
        if (r.code === 0) {
          this.jxaTimedOutUntil = 0;
          const list = JSON.parse(r.stdout.toString("utf8")) as RemoteWindowInfo[];
          return [{ id: "screen:0", appName: "macOS 桌面", title: "主屏幕", isScreen: true }, ...list];
        }
        if (r.code === -1) {
          this.jxaTimedOutUntil = Date.now() + 15_000;
        }
      } catch {
        // ignore
      }
      return [{ id: "screen:0", appName: "macOS 桌面", title: "主屏幕", isScreen: true }];
    }

    if (info.sessionType === "win32") {
      try {
        const r = await this.runWinHelper(["list"], 7000);
        if (r.code === 0) {
          const list = JSON.parse(r.stdout.toString("utf8")) as RemoteWindowInfo[];
          return [{ id: "screen:0", appName: "Windows 桌面", title: "主屏幕", isScreen: true }, ...list];
        }
      } catch {
        // ignore
      }
      return [{ id: "screen:0", appName: "Windows 桌面", title: "主屏幕", isScreen: true }];
    }

    if (info.sessionType === "headless") return [];

    const out: RemoteWindowInfo[] = [
      { id: "screen:0", appName: `${info.desktopEnv || "Linux"} 桌面`, title: "整个屏幕", isScreen: true },
    ];

    if (info.sessionType === "wayland-wlroots") {
      if (info.env.HYPRLAND_INSTANCE_SIGNATURE && this.hasCmd("hyprctl", info.env)) {
        const r = await this.exec("hyprctl", ["clients", "-j"], 3000, info.env).catch(() => null);
        if (r?.code === 0) {
          const items = JSON.parse(r.stdout.toString("utf8")) as any[];
          for (const c of items) {
            if (!c?.size?.[0] || !c?.size?.[1]) continue;
            out.push({
              id: `hypr:${String(c.address ?? c.pid)}`,
              appName: String(c.class || c.initialClass || "App"),
              title: String(c.title || c.class || "Window"),
              pid: typeof c.pid === "number" ? c.pid : undefined,
              bounds: { x: Number(c.at?.[0] ?? 0), y: Number(c.at?.[1] ?? 0), width: Number(c.size[0]), height: Number(c.size[1]) },
            });
          }
          return out;
        }
      }
      if (info.env.SWAYSOCK && this.hasCmd("swaymsg", info.env)) {
        const r = await this.exec("swaymsg", ["-t", "get_tree"], 3000, info.env).catch(() => null);
        if (r?.code === 0) {
          const tree = JSON.parse(r.stdout.toString("utf8")) as any;
          const walk = (n: any) => {
            if (!n) return;
            if ((n.type === "con" || n.type === "floating_con") && n.name && n.rect?.width > 60 && n.rect?.height > 40 && n.pid) {
              out.push({
                id: `sway:${n.id}`,
                appName: String(n.app_id || n.window_properties?.class || "Wayland"),
                title: String(n.name),
                pid: Number(n.pid),
                bounds: { x: n.rect.x, y: n.rect.y, width: n.rect.width, height: n.rect.height },
              });
            }
            for (const c of [...(n.nodes ?? []), ...(n.floating_nodes ?? [])]) walk(c);
          };
          walk(tree);
          return out;
        }
      }
    }

    if (info.sessionType === "wayland-kde" && this.hasCmd("kdotool", info.env)) {
      const r = await this.exec("kdotool", ["search", "--name", "."], 3000, info.env).catch(() => null);
      if (r?.code === 0) {
        const ids = r.stdout.toString("utf8").split(/\s+/).filter(Boolean).slice(0, 24);
        for (const wid of ids) {
          const [nameR, clsR] = await Promise.all([
            this.exec("kdotool", ["getwindowname", wid], 1200, info.env).catch(() => null),
            this.exec("kdotool", ["getwindowclassname", wid], 1200, info.env).catch(() => null),
          ]);
          const title = nameR?.code === 0 ? nameR.stdout.toString("utf8").trim() : wid;
          const appName = clsR?.code === 0 ? clsR.stdout.toString("utf8").trim() : "KDE";
          out.push({ id: `kde:${wid}`, appName: appName || "KDE", title: title || wid });
        }
      }
    }

    if (info.sessionType === "wayland-gnome" && this.hasCmd("gdbus", info.env)) {
      const r = await this.exec(
        "gdbus",
        ["call", "--session", "--dest", "org.gnome.Shell", "--object-path", "/org/gnome/Shell/Introspect", "--method", "org.gnome.Shell.Introspect.GetWindows"],
        3000,
        info.env,
      ).catch(() => null);
      if (r?.code === 0) {
        const text = r.stdout.toString("utf8");
        const matches = [...text.matchAll(/uint64\s+(\d+).*?'title':\s*<'([^']*)'>.*?'app-id':\s*<'([^']*)'>/gs)];
        for (const m of matches) {
          out.push({ id: `gnome:${m[1]}`, appName: m[3] || "GNOME", title: m[2] || m[3] || "Window" });
        }
      }
    }

    // X11 / XWayland window enumeration: wmctrl -lpGx (fallback -lpG) -> xdotool -> xwininfo
    if (info.env.DISPLAY && this.hasCmd("wmctrl", info.env)) {
      let added = 0;
      const rx = await this.exec("wmctrl", ["-lpGx"], 3000, info.env).catch(() => null);
      if (rx?.code === 0) {
        for (const line of rx.stdout.toString("utf8").split("\n")) {
          const m = /^(0x[0-9a-f]+)\s+-?\d+\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+\S+\s+(.*)$/i.exec(line.trim());
          if (!m) continue;
          const [, wid, pidStr, x, y, w, h, wmClass, title] = m;
          if (Number(w) < 80 || Number(h) < 60) continue;
          const appName = wmClass && wmClass !== "N/A" ? wmClass.split(".").pop() || wmClass : "X11";
          out.push({
            id: wid!,
            appName,
            title: title?.trim() || wid!,
            pid: Number(pidStr) || undefined,
            bounds: { x: Number(x), y: Number(y), width: Number(w), height: Number(h) },
          });
          added += 1;
        }
      }
      if (added === 0) {
        const r = await this.exec("wmctrl", ["-lpG"], 3000, info.env).catch(() => null);
        if (r?.code === 0) {
          for (const line of r.stdout.toString("utf8").split("\n")) {
            const m = /^(0x[0-9a-f]+)\s+-?\d+\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.*)$/i.exec(line.trim());
            if (!m) continue;
            const [, wid, pidStr, x, y, w, h, title] = m;
            if (Number(w) < 80 || Number(h) < 60) continue;
            out.push({
              id: wid!,
              appName: "X11",
              title: title?.trim() || wid!,
              pid: Number(pidStr) || undefined,
              bounds: { x: Number(x), y: Number(y), width: Number(w), height: Number(h) },
            });
            added += 1;
          }
        }
      }
      if (added > 0) return out;
    }

    if (info.env.DISPLAY && this.hasCmd("xdotool", info.env)) {
      let sRes = await this.exec("xdotool", ["search", "--onlyvisible", "--name", ""], 3000, info.env).catch(() => null);
      if (sRes?.code === 0 && !sRes.stdout.toString("utf8").trim()) {
        sRes = await this.exec("xdotool", ["search", "--onlyvisible", "--name", "."], 3000, info.env).catch(() => null);
      }
      const decIds = sRes?.code === 0 ? sRes.stdout.toString("utf8").trim().split(/\s+/).filter(Boolean).slice(0, 30) : [];
      let added = 0;
      for (const dec of decIds) {
        const nId = Number(dec);
        if (!Number.isFinite(nId) || nId <= 0) continue;
        const hexId = `0x${nId.toString(16)}`;
        const [geomR, nameR, pidR] = await Promise.all([
          this.exec("xdotool", ["getwindowgeometry", "--shell", dec], 1200, info.env).catch(() => null),
          this.exec("xdotool", ["getwindowname", dec], 1200, info.env).catch(() => null),
          this.exec("xdotool", ["getwindowpid", dec], 1200, info.env).catch(() => null),
        ]);
        const gTxt = geomR?.code === 0 ? geomR.stdout.toString("utf8") : "";
        const gx = Number(/X=(-?\d+)/.exec(gTxt)?.[1] ?? 0);
        const gy = Number(/Y=(-?\d+)/.exec(gTxt)?.[1] ?? 0);
        const gw = Number(/WIDTH=(\d+)/.exec(gTxt)?.[1] ?? 0);
        const gh = Number(/HEIGHT=(\d+)/.exec(gTxt)?.[1] ?? 0);
        if (gw < 80 || gh < 60) continue;
        const title = nameR?.code === 0 ? nameR.stdout.toString("utf8").trim() : hexId;
        const pid = pidR?.code === 0 ? Number(pidR.stdout.toString("utf8").trim()) || undefined : undefined;
        out.push({
          id: hexId,
          appName: "X11",
          title: title || hexId,
          ...(pid ? { pid } : {}),
          bounds: { x: gx, y: gy, width: gw, height: gh },
        });
        added += 1;
      }
      if (added > 0) return out;
    }

    if (info.env.DISPLAY && this.hasCmd("xwininfo", info.env)) {
      let allowedIds: Set<number> | null = null;
      if (this.hasCmd("xprop", info.env)) {
        const xp = await this.exec("xprop", ["-root", "_NET_CLIENT_LIST"], 2000, info.env).catch(() => null);
        if (xp?.code === 0) {
          const ids = [...xp.stdout.toString("utf8").matchAll(/0x[0-9a-f]+/gi)].map((m) => Number.parseInt(m[0], 16));
          if (ids.length > 0) allowedIds = new Set(ids);
        }
      }
      const r = await this.exec("xwininfo", ["-root", "-tree"], 3000, info.env).catch(() => null);
      if (r?.code === 0) {
        for (const line of r.stdout.toString("utf8").split("\n")) {
          const m = /^\s*(0x[0-9a-f]+)\s+(?:"([^"]+)"|\(has no name\)):\s+\("([^"]*)"\s+"([^"]*)"\).*?\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/i.exec(line)
            ?? /^\s*(0x[0-9a-f]+)\s+"([^"]+)":.*?\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/i.exec(line);
          if (!m) continue;
          const hasClass = m.length >= 9;
          const wid = m[1]!;
          const numId = Number.parseInt(wid, 16);
          if (allowedIds && !allowedIds.has(numId)) continue;
          const title = (hasClass ? m[2] : m[2]) || wid;
          const cls = hasClass ? (m[4] || m[3] || "X11") : "X11";
          const w = Number(hasClass ? m[5] : m[3]);
          const h = Number(hasClass ? m[6] : m[4]);
          const x = Number(hasClass ? m[7] : m[5]);
          const y = Number(hasClass ? m[8] : m[6]);
          if (w < 80 || h < 60) continue;
          out.push({
            id: wid,
            appName: cls,
            title,
            bounds: { x, y, width: w, height: h },
          });
        }
      }
    }

    return out;
  }

  async captureWindow(windowId: string, opts?: CaptureWindowOptions): Promise<CaptureWindowResult | null> {
    const maxWidth = Math.max(480, Math.min(2560, Math.round(opts?.maxWidth ?? 1600)));
    const quality = Math.max(40, Math.min(92, Math.round(opts?.quality ?? 72)));
    const showCursor = opts?.showCursor ?? true;
    const explicitFps = opts?.fps;
    const fps = Math.max(1, Math.min(60, Math.round(explicitFps ?? 30)));
    const sinceNativeSeq = opts?.sinceNativeSeq;
    const skipBase64 = Boolean(opts?.skipBase64);
    const cacheKey = `${windowId}:${maxWidth}:${quality}:${showCursor ? 1 : 0}`;
    const cacheTtlMs = explicitFps === undefined ? 45 : fps >= 45 ? 3 : fps >= 25 ? 6 : 16;

    const cached = !sinceNativeSeq ? this.lastFrameCache.get(cacheKey) : undefined;
    if (cached && cached.frame && !cached.frame.unchanged && Date.now() - cached.at < cacheTtlMs) {
      const f = cached.frame;
      return !skipBase64 && !f.data && f.rawBytes ? { ...f, data: f.rawBytes.toString("base64") } : f;
    }

    const inflightKey = sinceNativeSeq ? `${cacheKey}:s${sinceNativeSeq}` : cacheKey;
    const existing = this.captureInflight.get(inflightKey);
    if (existing) {
      const f = await existing;
      if (!f) return null;
      return !skipBase64 && !f.unchanged && !f.data && f.rawBytes ? { ...f, data: f.rawBytes.toString("base64") } : f;
    }

    const p = this.captureWindowUncached(windowId, {
      maxWidth,
      quality,
      showCursor,
      fps,
      sinceNativeSeq,
      skipBase64,
    })
      .then((frame) => {
        if (frame && !frame.unchanged) {
          this.lastFrameCache.set(cacheKey, { at: Date.now(), frame });
          if (this.lastFrameCache.size > 32) {
            const oldest = this.lastFrameCache.keys().next().value;
            if (oldest) this.lastFrameCache.delete(oldest);
          }
        } else if (!frame) {
          this.lastFrameCache.delete(cacheKey);
        }
        return frame;
      })
      .finally(() => {
        this.captureInflight.delete(inflightKey);
      });
    this.captureInflight.set(inflightKey, p);
    const res = await p;
    if (!res) return null;
    return !skipBase64 && !res.unchanged && !res.data && res.rawBytes
      ? { ...res, data: res.rawBytes.toString("base64") }
      : res;
  }

  private async captureWindowUncached(
    windowId: string,
    opts: { maxWidth: number; quality: number; showCursor: boolean; fps: number; sinceNativeSeq?: string; skipBase64: boolean },
  ): Promise<CaptureWindowResult | null> {
    const t0 = Date.now();
    const info = detectPortalSession(this.deps);
    let list: RemoteWindowInfo[] = [];
    if (this.windowsCache && Date.now() - this.windowsCache.at < 5_000) {
      list = this.windowsCache.list;
    } else if (windowId !== "screen:0") {
      list = await this.listWindows().catch(() => []);
    }
    const target = list.find((w) => w.id === windowId);
    const bounds = target?.bounds;

    if (info.sessionType === "macos") {
      const helper = await this.ensureMacHelper();
      if (windowId.startsWith("screen:") || /^\d+$/.test(windowId)) {
        try {
          const macArgs = [
            "capture",
            windowId,
            String(opts.maxWidth),
            String(opts.quality),
            opts.showCursor ? "1" : "0",
            String(opts.fps),
            ...(opts.sinceNativeSeq ? [opts.sinceNativeSeq] : []),
          ];
          const execOut = await this.execMacHelper(helper, macArgs, 4800);
          if (execOut) {
            const { res: r } = execOut;
            const meta = parseCaptureMeta(r.stderr, bounds?.width ?? 1280, bounds?.height ?? 800);
            if (r.code === 0 && r.stdout.length === 0 && meta.unchanged) {
              this.macScreenRecordingCache = {
                denied: false,
                accessibility: this.macScreenRecordingCache?.accessibility ?? true,
                at: Date.now(),
              };
              return {
                mime: "image/jpeg",
                data: "",
                width: meta.width,
                height: meta.height,
                unchanged: true,
                ...(meta.seq ? { nativeSeq: meta.seq } : {}),
                ...(meta.cursorX !== undefined ? { cursorX: meta.cursorX, cursorY: meta.cursorY, cursorVisible: meta.cursorVisible } : {}),
                captureMs: Math.max(1, Date.now() - t0),
                bounds,
                pid: target?.pid,
              };
            }
            if (r.code === 0 && r.stdout.length > 0) {
              this.macScreenRecordingCache = {
                denied: false,
                accessibility: this.macScreenRecordingCache?.accessibility ?? true,
                at: Date.now(),
              };
              return {
                mime: "image/jpeg",
                data: opts.skipBase64 ? "" : r.stdout.toString("base64"),
                rawBytes: r.stdout,
                width: meta.width,
                height: meta.height,
                ...(meta.seq ? { nativeSeq: meta.seq } : {}),
                ...(meta.cursorX !== undefined ? { cursorX: meta.cursorX, cursorY: meta.cursorY, cursorVisible: meta.cursorVisible } : {}),
                captureMs: Math.max(1, Date.now() - t0),
                bounds,
                pid: target?.pid,
              };
            }
            if (r.code === 2) {
              this.macScreenRecordingCache = {
                denied: true,
                accessibility: this.macScreenRecordingCache?.accessibility ?? true,
                at: Date.now(),
              };
              return null;
            }
          }
        } catch {
          // fallback below to screencapture
        }
      }
      const tmp = join(tmpdir(), `hp-cap-${process.pid}-${Date.now()}.jpg`);
      try {
        const args = !windowId.startsWith("screen:") && /^\d+$/.test(windowId)
          ? ["-x", "-o", "-l", windowId, "-t", "jpg", tmp]
          : bounds && bounds.width > 0 && bounds.height > 0
            ? ["-x", "-R", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, "-t", "jpg", tmp]
            : ["-x", "-t", "jpg", tmp];
        const r = await this.exec("/usr/sbin/screencapture", args, 5000).catch(() => null);
        if (r?.code === 0 && existsSync(tmp)) {
          this.macScreenRecordingCache = {
            denied: false,
            accessibility: this.macScreenRecordingCache?.accessibility ?? true,
            at: Date.now(),
          };
          await this.exec(
            "/usr/bin/sips",
            ["-Z", String(opts.maxWidth), "-s", "format", "jpeg", "-s", "formatOptions", String(opts.quality), tmp],
            3000,
          ).catch(() => null);
          const buf = readFileSync(tmp);
          return {
            mime: "image/jpeg",
            data: buf.toString("base64"),
            rawBytes: buf,
            width: bounds?.width ?? 1280,
            height: bounds?.height ?? 800,
            captureMs: Math.max(1, Date.now() - t0),
            bounds,
            pid: target?.pid,
          };
        }
        if (r && /could not create image/i.test(r.stderr)) {
          this.macScreenRecordingCache = {
            denied: true,
            accessibility: this.macScreenRecordingCache?.accessibility ?? true,
            at: Date.now(),
          };
        }
      } finally {
        rmSync(tmp, { force: true });
      }
      return null;
    }

    if (info.sessionType === "win32") {
      const targetArg = windowId.startsWith("screen:") ? windowId : String(Number(windowId) || 0);
      const argsBase = ["capture", targetArg];
      const streamArgs = [...argsBase, "-", String(opts.maxWidth), String(opts.quality), opts.showCursor ? "1" : "0"];
      const rMem = await this.runWinHelper(streamArgs, 5000, "capture").catch(() => null);
      if (rMem?.code === 0) {
        const txt = rMem.stdout.toString("utf8");
        const b64Idx = txt.indexOf("|b64:");
        if (b64Idx > 0) {
          const meta = parseCaptureMeta(txt.slice(0, b64Idx), bounds?.width ?? 1280, bounds?.height ?? 800);
          const data = txt.slice(b64Idx + 5).trim();
          return {
            mime: "image/jpeg",
            data,
            rawBytes: Buffer.from(data, "base64"),
            width: meta.width,
            height: meta.height,
            ...(meta.cursorX !== undefined ? { cursorX: meta.cursorX, cursorY: meta.cursorY, cursorVisible: meta.cursorVisible } : {}),
            captureMs: Math.max(1, Date.now() - t0),
            bounds,
            pid: target?.pid,
          };
        }
      }
      const tmp = join(tmpdir(), `hp-cap-${process.pid}-${Date.now()}.jpg`);
      try {
        const r = await this.runWinHelper(
          [...argsBase, tmp, String(opts.maxWidth), String(opts.quality), opts.showCursor ? "1" : "0"],
          7000,
          "capture",
        );
        if (r.code === 0 && existsSync(tmp)) {
          const meta = parseCaptureMeta(r.stdout.toString("utf8"), bounds?.width ?? 1280, bounds?.height ?? 800);
          const buf = readFileSync(tmp);
          return {
            mime: "image/jpeg",
            data: buf.toString("base64"),
            rawBytes: buf,
            width: meta.width,
            height: meta.height,
            ...(meta.cursorX !== undefined ? { cursorX: meta.cursorX, cursorY: meta.cursorY, cursorVisible: meta.cursorVisible } : {}),
            captureMs: Math.max(1, Date.now() - t0),
            bounds,
            pid: target?.pid,
          };
        }
      } finally {
        rmSync(tmp, { force: true });
      }
      return null;
    }

    if (info.sessionType === "headless") return null;

    if (info.sessionType === "wayland-wlroots" && this.hasCmd("grim", info.env)) {
      const args =
        bounds && !windowId.startsWith("screen:")
          ? ["-g", `${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`, "-t", "jpeg", "-q", String(opts.quality), "-"]
          : ["-t", "jpeg", "-q", String(opts.quality), "-"];
      const r = await this.exec("grim", args, 5000, info.env).catch(() => null);
      if (r?.code === 0 && r.stdout.length > 0) {
        return {
          mime: "image/jpeg",
          data: r.stdout.toString("base64"),
          rawBytes: r.stdout,
          width: bounds?.width ?? 1280,
          height: bounds?.height ?? 800,
          captureMs: Math.max(1, Date.now() - t0),
          bounds,
          pid: target?.pid,
        };
      }
    }

    if (info.sessionType === "wayland-kde" && this.hasCmd("spectacle", info.env)) {
      const tmp = join(tmpdir(), `hp-kde-${process.pid}-${Date.now()}.jpg`);
      try {
        const args = !windowId.startsWith("screen:") ? ["-b", "-n", "-a", "-o", tmp] : ["-b", "-n", "-f", "-o", tmp];
        const r = await this.exec("spectacle", args, 5000, info.env).catch(() => null);
        if (r?.code === 0 && existsSync(tmp)) {
          const buf = readFileSync(tmp);
          return { mime: "image/jpeg", data: buf.toString("base64"), width: bounds?.width ?? 1280, height: bounds?.height ?? 800, bounds, pid: target?.pid };
        }
      } finally {
        rmSync(tmp, { force: true });
      }
    }

    if (info.sessionType === "wayland-gnome" && this.hasCmd("gnome-screenshot", info.env)) {
      const tmp = join(tmpdir(), `hp-gnome-${process.pid}-${Date.now()}.png`);
      try {
        const args = !windowId.startsWith("screen:") ? ["-w", "-f", tmp] : ["-f", tmp];
        const r = await this.exec("gnome-screenshot", args, 5000, info.env).catch(() => null);
        if (r?.code === 0 && existsSync(tmp)) {
          const buf = readFileSync(tmp);
          return { mime: "image/png", data: buf.toString("base64"), width: bounds?.width ?? 1280, height: bounds?.height ?? 800, bounds, pid: target?.pid };
        }
      } finally {
        rmSync(tmp, { force: true });
      }
    }

    // X11 / XWayland capture chain: maim -> imagemagick import -> scrot -> ffmpeg -> xwd
    if (info.env.DISPLAY) {
      const isWin = !windowId.startsWith("screen:") && /^0x[0-9a-f]+$/i.test(windowId);
      if (this.hasCmd("maim", info.env)) {
        const args = isWin ? ["-i", windowId, "-f", "jpg"] : ["-f", "jpg"];
        const r = await this.exec("maim", args, 5000, info.env).catch(() => null);
        if (r?.code === 0 && r.stdout.length > 0) {
          return { mime: "image/jpeg", data: r.stdout.toString("base64"), width: bounds?.width ?? 1280, height: bounds?.height ?? 800, bounds, pid: target?.pid };
        }
      }
      if (this.hasCmd("import", info.env)) {
        const args = ["-silent", "-window", isWin ? windowId : "root", "-quality", String(opts.quality), "jpeg:-"];
        const r = await this.exec("import", args, 5000, info.env).catch(() => null);
        if (r?.code === 0 && r.stdout.length > 0) {
          return { mime: "image/jpeg", data: r.stdout.toString("base64"), width: bounds?.width ?? 1280, height: bounds?.height ?? 800, bounds, pid: target?.pid };
        }
      }
      if (this.hasCmd("scrot", info.env)) {
        const tmp = join(tmpdir(), `hp-x11-${process.pid}-${Date.now()}.jpg`);
        try {
          let r = isWin && bounds
            ? await this.exec("scrot", ["-a", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, "-q", String(opts.quality), "-o", tmp], 5000, info.env).catch(() => null)
            : null;
          if (!r || r.code !== 0 || !existsSync(tmp)) {
            r = await this.exec("scrot", ["-q", String(opts.quality), "-o", tmp], 5000, info.env).catch(() => null);
          }
          if (r?.code === 0 && existsSync(tmp)) {
            const buf = readFileSync(tmp);
            return { mime: "image/jpeg", data: buf.toString("base64"), width: bounds?.width ?? 1280, height: bounds?.height ?? 800, bounds, pid: target?.pid };
          }
        } finally {
          rmSync(tmp, { force: true });
        }
      }
      if (this.hasCmd("ffmpeg", info.env)) {
        const baseArgs = ["-y", "-loglevel", "error", "-f", "x11grab"];
        const primaryArgs = [
          ...baseArgs,
          ...(isWin ? ["-window_id", windowId] : []),
          "-i",
          info.env.DISPLAY,
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "pipe:1",
        ];
        let r = await this.exec("ffmpeg", primaryArgs, 5000, info.env).catch(() => null);
        if ((!r || r.code !== 0 || r.stdout.length === 0) && isWin && bounds && bounds.width > 0 && bounds.height > 0) {
          const regionArgs = [
            ...baseArgs,
            "-video_size",
            `${bounds.width}x${bounds.height}`,
            "-i",
            `${info.env.DISPLAY}+${bounds.x},${bounds.y}`,
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
          ];
          r = await this.exec("ffmpeg", regionArgs, 5000, info.env).catch(() => null);
        }
        if (r?.code === 0 && r.stdout.length > 0) {
          return { mime: "image/jpeg", data: r.stdout.toString("base64"), width: bounds?.width ?? 1280, height: bounds?.height ?? 800, bounds, pid: target?.pid };
        }
      }
      if (this.hasCmd("xwd", info.env) && (this.hasCmd("convert", info.env) || this.hasCmd("ffmpeg", info.env))) {
        const stamp = `${process.pid}-${Date.now()}`;
        const tmpXwd = join(tmpdir(), `hp-xwd-${stamp}.xwd`);
        const tmpJpg = join(tmpdir(), `hp-xwd-${stamp}.jpg`);
        try {
          const r = await this.exec("xwd", ["-silent", ...(isWin ? ["-id", windowId] : ["-root"]), "-out", tmpXwd], 4000, info.env).catch(() => null);
          if (r?.code === 0 && existsSync(tmpXwd)) {
            let conv = this.hasCmd("convert", info.env)
              ? await this.exec("convert", [tmpXwd, "-quality", String(opts.quality), tmpJpg], 4000, info.env).catch(() => null)
              : null;
            if ((!conv || conv.code !== 0 || !existsSync(tmpJpg)) && this.hasCmd("ffmpeg", info.env)) {
              conv = await this.exec("ffmpeg", ["-y", "-loglevel", "error", "-i", tmpXwd, "-frames:v", "1", "-q:v", "5", tmpJpg], 4000, info.env).catch(() => null);
            }
            if (conv?.code === 0 && existsSync(tmpJpg)) {
              const buf = readFileSync(tmpJpg);
              return { mime: "image/jpeg", data: buf.toString("base64"), width: bounds?.width ?? 1280, height: bounds?.height ?? 800, bounds, pid: target?.pid };
            }
          }
        } finally {
          rmSync(tmpXwd, { force: true });
          rmSync(tmpJpg, { force: true });
        }
      }
    }

    return null;
  }

  private resolveTargetWindowSyncOrCached(windowId: string): Promise<RemoteWindowInfo | undefined> {
    if (this.windowsCache) {
      const hit = this.windowsCache.list.find((w) => w.id === windowId);
      if (Date.now() - this.windowsCache.at > 3_000 && !this.windowsInflight) {
        void this.listWindows().catch(() => {});
      }
      if (hit) return Promise.resolve(hit);
    }
    return this.listWindows()
      .then((list) => list.find((w) => w.id === windowId))
      .catch(() => undefined);
  }

  async handleClipboard(action: "get" | "set", text?: string): Promise<string | undefined> {
    const info = detectPortalSession(this.deps);
    if (info.sessionType === "macos") {
      const helper = await this.ensureMacHelper();
      if (action === "get") {
        const res = await this.execMacHelper(helper, ["clipboard", "get"], 2500);
        if (res && res.res.code === 0) return res.res.stdout.toString("utf8");
        const pb = await this.exec("pbpaste", [], 2000).catch(() => null);
        return pb?.code === 0 ? pb.stdout.toString("utf8") : "";
      }
      const b64 = Buffer.from(text ?? "", "utf8").toString("base64");
      await this.execMacHelper(helper, ["clipboard", "set", b64], 2500);
      return undefined;
    }
    if (info.sessionType === "win32") {
      if (action === "get") {
        const r = await this.runWinHelper(["clipboard", "get"], 3000, "control").catch(() => null);
        return r?.code === 0 ? Buffer.from(r.stdout.toString("utf8").trim(), "base64").toString("utf8") : "";
      }
      const b64 = Buffer.from(text ?? "", "utf8").toString("base64");
      await this.runWinHelper(["clipboard", "set", b64], 3000, "control").catch(() => {});
      return undefined;
    }
    return action === "get" ? "" : undefined;
  }

  async promptPermission(kind: "accessibility" | "screenRecording"): Promise<void> {
    const info = detectPortalSession(this.deps);
    if (info.sessionType !== "macos") return;
    const cmd = kind === "accessibility" ? "open_accessibility" : "open_screen_recording";
    const bridged = await this.execViaDesktopBridge([cmd], 3000, "control");
    if (bridged && bridged.code === 0) return;
    const url =
      kind === "accessibility"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        : "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
    await this.exec("open", [url], 2500).catch(() => {});
  }

  async injectInput(windowId: string, input: PortalInputAction): Promise<void> {
    if (input.type === "ack" || input.type === "config" || input.type === "navigate") return;
    if (input.type === "clipboard") {
      await this.handleClipboard(input.action, input.text);
      return;
    }
    if (input.type === "promptPermission") {
      await this.promptPermission(input.kind);
      return;
    }
    const info = detectPortalSession(this.deps);
    const target = await this.resolveTargetWindowSyncOrCached(windowId);
    const bounds = target?.bounds ?? { x: 0, y: 0, width: 1280, height: 800 };
    const absPoint = (nx: number, ny: number) => ({
      x: Math.round(bounds.x + Math.min(1, Math.max(0, nx)) * bounds.width),
      y: Math.round(bounds.y + Math.min(1, Math.max(0, ny)) * bounds.height),
    });

    if (info.sessionType === "macos") {
      const helper = await this.ensureMacHelper();
      const pid = target?.isScreen ? 0 : (target?.pid ?? 0);
      const runMacHelperInput = async (args: string[]) => {
        const res = await this.execMacHelper(helper, args, 2500);
        return Boolean(res && res.res.code === 0);
      };
      if (input.type === "pointer") {
        const { x, y } = absPoint(input.nx, input.ny);
        const btn = input.button ?? "left";
        const act =
          input.action === "dblclick"
            ? "2"
            : input.action === "click"
              ? "1"
              : input.action;
        const modsCsv = (input.modifiers ?? []).join(",");
        if (await runMacHelperInput(["click", String(x), String(y), btn, act, String(pid), modsCsv])) {
          return;
        }
      }
      if (input.type === "wheel") {
        const { x, y } = absPoint(input.nx, input.ny);
        const scaleWheel = (d: number) => {
          if (!d) return 0;
          const v = Math.round(-d * 0.6);
          return v === 0 ? (d > 0 ? -1 : 1) : v;
        };
        const modsCsv = (input.modifiers ?? []).join(",");
        if (
          await runMacHelperInput([
            "scroll",
            String(scaleWheel(input.deltaY)),
            String(scaleWheel(input.deltaX)),
            String(x),
            String(y),
            modsCsv,
          ])
        ) {
          return;
        }
      }
      if (input.type === "text") {
        if (await runMacHelperInput(["text", input.text, String(pid)])) {
          return;
        }
      }
      if (input.type === "key") {
        const modsCsv = (input.modifiers ?? []).join(",");
        const phase = input.action ?? "press";
        if (await runMacHelperInput(["key", input.key, String(pid), modsCsv, phase])) {
          return;
        }
      }
      // JXA fallback for key/text
      if (input.type === "text" || input.type === "key") {
        const text = input.type === "text" ? input.text : input.key;
        const esc = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        await this.exec("osascript", ["-l", "JavaScript", "-e", `Application("System Events").keystroke("${esc}")`], 3000).catch(() => {});
      }
      return;
    }

    if (info.sessionType === "win32") {
      const hwnd = target && !target.isScreen ? String(Number(target.id) || 0) : "0";
      if (input.type === "pointer") {
        const { x, y } = absPoint(input.nx, input.ny);
        const act =
          input.action === "dblclick"
            ? "2"
            : input.action === "click"
              ? "1"
              : input.action;
        await this.runWinHelper(["click", String(x), String(y), input.button ?? "left", act, hwnd], 2500, "control").catch(() => {});
        return;
      }
      if (input.type === "wheel") {
        const { x, y } = absPoint(input.nx, input.ny);
        await this.runWinHelper(
          ["wheel", String(Math.round(input.deltaY)), String(Math.round(input.deltaX)), String(x), String(y), hwnd],
          2500,
          "control",
        ).catch(() => {});
        return;
      }
      if (input.type === "text") {
        const b64 = Buffer.from(input.text, "utf8").toString("base64");
        await this.runWinHelper(["text", b64, hwnd], 3000, "control").catch(() => {});
        return;
      }
      if (input.type === "key") {
        const modsCsv = (input.modifiers ?? []).join(",");
        const phase = input.action ?? "press";
        await this.runWinHelper(["key", input.key, hwnd, modsCsv, phase], 3000, "control").catch(() => {});
      }
      return;
    }

    // Linux X11 & Wayland
    if (info.sessionType === "x11" || (info.env.DISPLAY && this.hasCmd("xdotool", info.env) && !this.hasCmd("ydotool", info.env))) {
      if (!this.hasCmd("xdotool", info.env)) return;
      const isWin = !windowId.startsWith("screen:") && /^0x[0-9a-f]+$/i.test(windowId);
      if (isWin && input.type !== "pointer") {
        await this.exec("xdotool", ["windowactivate", windowId], 2000, info.env).catch(() => {});
      }
      if (input.type === "pointer") {
        const { x, y } = absPoint(input.nx, input.ny);
        const btn = input.button === "right" ? "3" : input.button === "middle" ? "2" : "1";
        await this.exec("xdotool", ["mousemove", "--sync", String(x), String(y)], 1500, info.env).catch(() => {});
        if (input.action === "down") {
          await this.exec("xdotool", ["mousedown", btn], 1500, info.env).catch(() => {});
        } else if (input.action === "up") {
          await this.exec("xdotool", ["mouseup", btn], 1500, info.env).catch(() => {});
        } else if (input.action === "click") {
          await this.exec("xdotool", ["click", btn], 1500, info.env).catch(() => {});
        } else if (input.action === "dblclick") {
          await this.exec("xdotool", ["click", "--repeat", "2", "--delay", "60", btn], 1500, info.env).catch(() => {});
        }
      } else if (input.type === "wheel") {
        const dir = input.deltaY > 0 ? "5" : "4";
        await this.exec("xdotool", ["click", "--repeat", "3", dir], 1500, info.env).catch(() => {});
      } else if (input.type === "text") {
        await this.exec("xdotool", ["type", "--delay", "0", "--", input.text], 3000, info.env).catch(() => {});
      } else if (input.type === "key") {
        const keyMap: Record<string, string> = { Enter: "Return", Backspace: "BackSpace", Escape: "Escape", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Tab: "Tab", " ": "space" };
        const xKey = keyMap[input.key] ?? input.key;
        const modPrefix = (input.modifiers ?? [])
          .map((m) => (m === "meta" ? "super" : m === "ctrl" ? "ctrl" : m === "alt" ? "alt" : m === "shift" ? "shift" : ""))
          .filter(Boolean);
        const combo = modPrefix.length ? `${modPrefix.join("+")}+${xKey}` : xKey;
        await this.exec("xdotool", ["key", combo], 2000, info.env).catch(() => {});
      }
      return;
    }

    if (this.hasCmd("ydotool", info.env)) {
      if (input.type === "pointer") {
        const { x, y } = absPoint(input.nx, input.ny);
        await this.exec("ydotool", ["mousemove", "--absolute", "-x", String(x), "-y", String(y)], 1500, info.env).catch(() => {});
        if (input.action === "click" || input.action === "up") {
          const btnHex = input.button === "right" ? "0xC1" : "0xC0";
          await this.exec("ydotool", ["click", btnHex], 1500, info.env).catch(() => {});
        }
      } else if (input.type === "text") {
        await this.exec("ydotool", ["type", input.text], 3000, info.env).catch(() => {});
      }
    }
  }
}
