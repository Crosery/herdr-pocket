import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// --- Windows persistent/inline Win32 C# helper (DPI-aware + DWM cloaking + X-Server black-frame CopyFromScreen) ---

const WIN_CS_SRC = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
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
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int val, int size);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);
  [DllImport("kernel32.dll", CharSet=CharSet.Auto)] public static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
  [DllImport("kernel32.dll", CharSet=CharSet.Auto)] public static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr hObject);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
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
      g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      g.DrawImage(src, 0, 0, tw, th);
    }
    src.Dispose();
    return dst;
  }

  public static string DumpWindows() {
    SetProcessDPIAware();
    var sb = new StringBuilder("[");
    bool first = true;
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

  public static string CaptureWindow(long hwndVal, string outPath, int maxDim) {
    SetProcessDPIAware();
    Bitmap bmp = null;
    if (hwndVal > 0) {
      IntPtr hwnd = new IntPtr(hwndVal);
      RECT r;
      if (!GetWindowRect(hwnd, out r)) throw new Exception("window gone");
      int w = Math.Max(1, r.Right - r.Left);
      int h = Math.Max(1, r.Bottom - r.Top);
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
      Rectangle b = SystemInformation.VirtualScreen;
      if (b.Width <= 0 || b.Height <= 0) b = Screen.PrimaryScreen.Bounds;
      bmp = new Bitmap(b.Width, b.Height);
      using (var g = Graphics.FromImage(bmp)) { g.CopyFromScreen(b.Left, b.Top, 0, 0, b.Size); }
    }
    bmp = ScaleDownIfNeeded(bmp, maxDim);
    ImageCodecInfo[] enc = ImageCodecInfo.GetImageEncoders();
    ImageCodecInfo jpg = enc[0];
    foreach (var c in enc) if (c.MimeType == "image/jpeg") { jpg = c; break; }
    var ep = new EncoderParameters(1);
    ep.Param[0] = new EncoderParameter(Encoder.Quality, 72L);
    bmp.Save(outPath, jpg, ep);
    string dims = bmp.Width + "x" + bmp.Height;
    bmp.Dispose();
    return dims;
  }

  public static void SendClick(int x, int y, string btn, int count, long hwndVal) {
    SetProcessDPIAware();
    if (hwndVal > 0) SetForegroundWindow(new IntPtr(hwndVal));
    SetCursorPos(x, y);
    uint downF = btn == "right" ? 0x0008u : btn == "middle" ? 0x0020u : 0x0002u;
    uint upF = btn == "right" ? 0x0010u : btn == "middle" ? 0x0040u : 0x0004u;
    for (int i = 0; i < Math.Max(1, count); i++) {
      mouse_event(downF, 0, 0, 0, UIntPtr.Zero);
      mouse_event(upF, 0, 0, 0, UIntPtr.Zero);
    }
  }

  public static void SendWheel(int dy, long hwndVal) {
    SetProcessDPIAware();
    if (hwndVal > 0) SetForegroundWindow(new IntPtr(hwndVal));
    mouse_event(0x0800u, 0, 0, unchecked((uint)(-dy)), UIntPtr.Zero);
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

  public static void SendKey(string keyName, long hwndVal) {
    if (hwndVal > 0) SetForegroundWindow(new IntPtr(hwndVal));
    string k = keyName;
    if (k == "Enter" || k == "Return") k = "{ENTER}";
    else if (k == "Tab") k = "{TAB}";
    else if (k == "Backspace") k = "{BS}";
    else if (k == "Escape") k = "{ESC}";
    else if (k == "ArrowUp") k = "{UP}";
    else if (k == "ArrowDown") k = "{DOWN}";
    else if (k == "ArrowLeft") k = "{LEFT}";
    else if (k == "ArrowRight") k = "{RIGHT}";
    else if (k == "Space" || k == " ") k = " ";
    SendKeys.SendWait(k);
  }

  public static int Run(string[] args) {
    if (args.Length == 0) return 1;
    string cmd = args[0];
    if (cmd == "list") { Console.OutputEncoding = Encoding.UTF8; Console.Write(DumpWindows()); return 0; }
    if (cmd == "ps") { Console.OutputEncoding = Encoding.UTF8; Console.Write(DumpProcesses()); return 0; }
    if (cmd == "capture" && args.Length >= 3) {
      long hwnd = args[1].StartsWith("screen:") ? 0 : long.Parse(args[1]);
      int maxDim = args.Length >= 4 ? int.Parse(args[3]) : 1280;
      Console.Write(CaptureWindow(hwnd, args[2], maxDim));
      return 0;
    }
    if (cmd == "click" && args.Length >= 5) {
      long hwnd = args.Length >= 6 ? long.Parse(args[5]) : 0;
      SendClick(int.Parse(args[1]), int.Parse(args[2]), args[3], int.Parse(args[4]), hwnd);
      return 0;
    }
    if (cmd == "wheel" && args.Length >= 2) {
      long hwnd = args.Length >= 3 ? long.Parse(args[2]) : 0;
      SendWheel(int.Parse(args[1]), hwnd);
      return 0;
    }
    if (cmd == "text" && args.Length >= 2) {
      long hwnd = args.Length >= 3 ? long.Parse(args[2]) : 0;
      SendTextB64(args[1], hwnd);
      return 0;
    }
    if (cmd == "key" && args.Length >= 2) {
      long hwnd = args.Length >= 3 ? long.Parse(args[2]) : 0;
      SendKey(args[1], hwnd);
      return 0;
    }
    return 1;
  }

  public static int Main(string[] args) {
    return Run(args);
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
[Environment]::ExitCode = [HpWinPortal]::Run([string[]]@(${escArgs}))
`;
}

// --- macOS Swift helper (ScreenCaptureKit on macOS 14/15+, compiled once if swiftc exists; pure JXA/screencapture fallback) ---

const MAC_SWIFT_SRC = `
import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

func activatePid(_ pid: Int32) {
  if pid <= 0 { return }
  let app = NSRunningApplication(processIdentifier: pid)
  if #available(macOS 14.0, *) {
    app?.activate()
  } else {
    app?.activate(options: .activateIgnoringOtherApps)
  }
}

let args = CommandLine.arguments
if args.count >= 2 && args[1] == "check" {
  let ok = CGPreflightScreenCaptureAccess()
  let out: [String: Any] = ["screenCapture": ok]
  if let data = try? JSONSerialization.data(withJSONObject: out) {
    FileHandle.standardOutput.write(data)
  }
} else if args.count >= 3 && args[1] == "capture" {
  if !CGPreflightScreenCaptureAccess() {
    FileHandle.standardError.write(Data("screen_recording_denied\\n".utf8))
    exit(2)
  }
  let target = args[2]
  let maxDim = args.count >= 4 ? (Int(args[3]) ?? 1280) : 1280
  if #available(macOS 14.0, *) {
    Task {
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let filter: SCContentFilter
        let srcW: Double
        let srcH: Double
        if target == "screen:0" {
          guard let disp = content.displays.first else {
            FileHandle.standardError.write(Data("capture_empty\\n".utf8))
            exit(1)
          }
          filter = SCContentFilter(display: disp, excludingWindows: [])
          srcW = max(1.0, Double(disp.width))
          srcH = max(1.0, Double(disp.height))
        } else if let wid = CGWindowID(target),
                  let win = content.windows.first(where: { $0.windowID == wid }) {
          filter = SCContentFilter(desktopIndependentWindow: win)
          srcW = max(1.0, Double(win.frame.width))
          srcH = max(1.0, Double(win.frame.height))
        } else {
          FileHandle.standardError.write(Data("capture_empty\\n".utf8))
          exit(1)
        }
        let cfg = SCStreamConfiguration()
        let longest = max(srcW, srcH)
        let scale = maxDim > 0 ? min(2.0, Double(maxDim) / longest) : 1.0
        cfg.width = max(1, Int((srcW * scale).rounded()))
        cfg.height = max(1, Int((srcH * scale).rounded()))
        cfg.showsCursor = false
        let outImg = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        let rep = NSBitmapImageRep(cgImage: outImg)
        guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: NSNumber(value: 0.66)]) else {
          FileHandle.standardError.write(Data("encode_failed\\n".utf8))
          exit(1)
        }
        FileHandle.standardError.write(Data("dims:\\(outImg.width)x\\(outImg.height)\\n".utf8))
        FileHandle.standardOutput.write(jpeg)
        fflush(stdout)
        exit(0)
      } catch {
        FileHandle.standardError.write(Data("capture_err:\\(error)\\n".utf8))
        exit(1)
      }
    }
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 4.5))
    exit(1)
  } else {
    FileHandle.standardError.write(Data("unsupported_macos_version\\n".utf8))
    exit(1)
  }
} else if args.count >= 2 && args[1] == "list" {
  let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  let info = (CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]) ?? []
  let blockedOwners: Set<String> = ["Window Server", "Dock", "Control Center", "Notification Center", "Spotlight"]
  var out: [[String: Any]] = []
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
  let data = try JSONSerialization.data(withJSONObject: out)
  FileHandle.standardOutput.write(data)
} else if args.count >= 6 && args[1] == "click" {
  let x = Double(args[2]) ?? 0
  let y = Double(args[3]) ?? 0
  let btn = args[4]
  let count = Int(args[5]) ?? 1
  if args.count >= 7, let pid = Int32(args[6]) {
    activatePid(pid)
  }
  let pt = CGPoint(x: x, y: y)
  let mouseTypeDown: CGEventType = btn == "right" ? .rightMouseDown : .leftMouseDown
  let mouseTypeUp: CGEventType = btn == "right" ? .rightMouseUp : .leftMouseUp
  let cgBtn: CGMouseButton = btn == "right" ? .right : .left
  let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)
  move?.post(tap: .cghidEventTap)
  for c in 1...max(1, count) {
    let down = CGEvent(mouseEventSource: nil, mouseType: mouseTypeDown, mouseCursorPosition: pt, mouseButton: cgBtn)
    let up = CGEvent(mouseEventSource: nil, mouseType: mouseTypeUp, mouseCursorPosition: pt, mouseButton: cgBtn)
    down?.setIntegerValueField(.mouseEventClickState, value: Int64(c))
    up?.setIntegerValueField(.mouseEventClickState, value: Int64(c))
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
  }
} else if args.count >= 4 && args[1] == "scroll" {
  let dy = Int32(args[2]) ?? 0
  let dx = Int32(args[3]) ?? 0
  let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
  ev?.post(tap: .cghidEventTap)
} else if args.count >= 3 && args[1] == "text" {
  let str = args[2]
  if args.count >= 4, let pid = Int32(args[3]) {
    activatePid(pid)
  }
  let utf16 = Array(str.utf16)
  let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
  down?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
  up?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
  down?.post(tap: .cghidEventTap)
  up?.post(tap: .cghidEventTap)
} else if args.count >= 3 && args[1] == "key" {
  let keyName = args[2]
  if args.count >= 4, let pid = Int32(args[3]) {
    activatePid(pid)
  }
  let codeMap: [String: CGKeyCode] = [
    "Return": 36, "Enter": 36, "Tab": 48, "Space": 49, " ": 49,
    "Backspace": 51, "Escape": 53, "ArrowLeft": 123, "ArrowRight": 124,
    "ArrowDown": 125, "ArrowUp": 126, "Delete": 117, "Home": 115,
    "End": 119, "PageUp": 116, "PageDown": 121
  ]
  if let code = codeMap[keyName] {
    CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
    CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
  }
}
`;

export type CaptureWindowResult = {
  mime: "image/jpeg" | "image/png";
  data: string;
  width: number;
  height: number;
  bounds?: RemoteWindowInfo["bounds"];
  pid?: number;
};

export class OsCaptureDriver {
  private deps: OsCaptureDeps;
  private macHelperBin: string | null = null;
  private macHelperTried = false;
  private winHelperBin: string | null = null;
  private winHelperTried = false;
  private macScreenRecordingCache: { denied: boolean; at: number } | null = null;
  private jxaTimedOutUntil = 0;
  private windowsCache: { at: number; list: RemoteWindowInfo[] } | null = null;
  private windowsInflight: Promise<RemoteWindowInfo[]> | null = null;
  private captureInflight = new Map<string, Promise<CaptureWindowResult | null>>();
  private lastFrameCache = new Map<string, { at: number; frame: CaptureWindowResult | null }>();

  constructor(deps: OsCaptureDeps = {}) {
    this.deps = deps;
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
    if (existsSync(binPath)) {
      await this.signMacHelperIfPossible(binPath);
      this.macHelperBin = binPath;
      return binPath;
    }
    if (!this.hasCmd("swiftc", process.env)) return null;
    try {
      mkdirSync(binDir, { recursive: true });
      const srcPath = join(binDir, "hp-mac-portal-v3.swift");
      writeFileSync(srcPath, MAC_SWIFT_SRC);
      const r = await this.exec("swiftc", ["-O", srcPath, "-o", binPath], 30_000);
      if (r.code === 0 && existsSync(binPath)) {
        await this.signMacHelperIfPossible(binPath);
        this.macHelperBin = binPath;
        return binPath;
      }
    } catch {
      // fall back to screencapture + osascript
    }
    return null;
  }

  private async ensureWinHelper(): Promise<string | null> {
    if (this.winHelperBin && existsSync(this.winHelperBin)) return this.winHelperBin;
    if (this.winHelperTried) return null;
    this.winHelperTried = true;
    const binDir = this.deps.binDir ?? join(stateDir(), "bin");
    const binPath = join(binDir, "hp-win-portal-v1.exe");
    if (existsSync(binPath)) {
      this.winHelperBin = binPath;
      return binPath;
    }
    const sysRoot = process.env.SystemRoot || "C:\\Windows";
    const cscCandidates = [
      join(sysRoot, "Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"),
      join(sysRoot, "Microsoft.NET\\Framework\\v4.0.30319\\csc.exe"),
    ];
    const csc = cscCandidates.find((p) => existsSync(p)) ?? (this.hasCmd("csc", process.env) ? "csc" : null);
    if (!csc) return null;
    try {
      mkdirSync(binDir, { recursive: true });
      const srcPath = join(binDir, "hp-win-portal-v1.cs");
      writeFileSync(srcPath, WIN_CS_SRC);
      const r = await this.exec(
        csc,
        ["/nologo", "/optimize+", "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll", `/out:${binPath}`, srcPath],
        20_000,
      );
      if (r.code === 0 && existsSync(binPath)) {
        this.winHelperBin = binPath;
        return binPath;
      }
    } catch {
      // fall back to inline powershell.exe
    }
    return null;
  }

  private async runWinHelper(args: string[], timeoutMs = 7000): Promise<CaptureExecResult> {
    const exe = await this.ensureWinHelper();
    if (exe) {
      return this.exec(exe, args, timeoutMs);
    }
    return this.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", buildWin32InlinePs(args)], timeoutMs);
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
    const noteMsg = "请在系统设置 -> 隐私与安全性 -> 屏幕录制 中勾选运行 hostd 的终端或应用，否则无法捕获其他应用窗口";
    if (this.macScreenRecordingCache && Date.now() - this.macScreenRecordingCache.at < 10_000) {
      return this.macScreenRecordingCache.denied ? noteMsg : null;
    }
    const helper = await this.ensureMacHelper();
    if (!helper) return null;
    try {
      const r = await this.exec(helper, ["check"], 2000);
      if (r.code === 0) {
        const parsed = JSON.parse(r.stdout.toString("utf8")) as { screenCapture?: boolean };
        const denied = parsed.screenCapture === false;
        this.macScreenRecordingCache = { denied, at: Date.now() };
        if (denied) return noteMsg;
      }
    } catch {
      // ignore check error
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
      if (helper) {
        try {
          const r = await this.exec(helper, ["list"], 4000);
          if (r.code === 0) {
            const list = JSON.parse(r.stdout.toString("utf8")) as RemoteWindowInfo[];
            return [
              { id: "screen:0", appName: "macOS 桌面", title: "主屏幕", isScreen: true },
              ...list,
            ];
          }
        } catch {
          // fallback below
        }
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

  async captureWindow(windowId: string): Promise<CaptureWindowResult | null> {
    const cached = this.lastFrameCache.get(windowId);
    if (cached && Date.now() - cached.at < 45) return cached.frame;
    const inflight = this.captureInflight.get(windowId);
    if (inflight) return inflight;
    const p = this.captureWindowUncached(windowId)
      .then((frame) => {
        this.lastFrameCache.set(windowId, { at: Date.now(), frame });
        return frame;
      })
      .finally(() => {
        this.captureInflight.delete(windowId);
      });
    this.captureInflight.set(windowId, p);
    return p;
  }

  private async captureWindowUncached(windowId: string): Promise<CaptureWindowResult | null> {
    const info = detectPortalSession(this.deps);
    let list: RemoteWindowInfo[] = [];
    if (windowId !== "screen:0") {
      if (this.windowsCache && Date.now() - this.windowsCache.at < 5_000) {
        list = this.windowsCache.list;
      } else {
        list = await this.listWindows().catch(() => []);
      }
    }
    const target = list.find((w) => w.id === windowId);
    const bounds = target?.bounds;

    if (info.sessionType === "macos") {
      const helper = await this.ensureMacHelper();
      if (helper && (windowId === "screen:0" || /^\d+$/.test(windowId))) {
        try {
          const r = await this.exec(helper, ["capture", windowId, "1280"], 4800);
          if (r.code === 0 && r.stdout.length > 0) {
            this.macScreenRecordingCache = { denied: false, at: Date.now() };
            const dims = /dims:(\d+)x(\d+)/.exec(r.stderr);
            return {
              mime: "image/jpeg",
              data: r.stdout.toString("base64"),
              width: dims ? Number(dims[1]) : (bounds?.width ?? 1280),
              height: dims ? Number(dims[2]) : (bounds?.height ?? 800),
              bounds,
              pid: target?.pid,
            };
          }
          if (r.code === 2) {
            this.macScreenRecordingCache = { denied: true, at: Date.now() };
            return null;
          }
        } catch {
          // fallback below to screencapture
        }
      }
      const tmp = join(tmpdir(), `hp-cap-${process.pid}-${Date.now()}.jpg`);
      try {
        const args = windowId !== "screen:0" && /^\d+$/.test(windowId)
          ? ["-x", "-o", "-l", windowId, "-t", "jpg", tmp]
          : bounds && bounds.width > 0 && bounds.height > 0
            ? ["-x", "-R", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, "-t", "jpg", tmp]
            : ["-x", "-t", "jpg", tmp];
        const r = await this.exec("/usr/sbin/screencapture", args, 5000).catch(() => null);
        if (r?.code === 0 && existsSync(tmp)) {
          this.macScreenRecordingCache = { denied: false, at: Date.now() };
          const buf = readFileSync(tmp);
          return {
            mime: "image/jpeg",
            data: buf.toString("base64"),
            width: bounds?.width ?? 1280,
            height: bounds?.height ?? 800,
            bounds,
            pid: target?.pid,
          };
        }
        if (r && /could not create image/i.test(r.stderr)) {
          this.macScreenRecordingCache = { denied: true, at: Date.now() };
        }
      } finally {
        rmSync(tmp, { force: true });
      }
      return null;
    }

    if (info.sessionType === "win32") {
      const tmp = join(tmpdir(), `hp-cap-${process.pid}-${Date.now()}.jpg`);
      try {
        const targetArg = windowId.startsWith("screen:") ? "screen:0" : String(Number(windowId) || 0);
        const r = await this.runWinHelper(["capture", targetArg, tmp, "1280"], 7000);
        if (r.code === 0 && existsSync(tmp)) {
          const dims = /(\d+)x(\d+)/.exec(r.stdout.toString("utf8"));
          const buf = readFileSync(tmp);
          return {
            mime: "image/jpeg",
            data: buf.toString("base64"),
            width: dims ? Number(dims[1]) : (bounds?.width ?? 1280),
            height: dims ? Number(dims[2]) : (bounds?.height ?? 800),
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
        bounds && windowId !== "screen:0"
          ? ["-g", `${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`, "-t", "jpeg", "-q", "74", "-"]
          : ["-t", "jpeg", "-q", "74", "-"];
      const r = await this.exec("grim", args, 5000, info.env).catch(() => null);
      if (r?.code === 0 && r.stdout.length > 0) {
        return {
          mime: "image/jpeg",
          data: r.stdout.toString("base64"),
          width: bounds?.width ?? 1280,
          height: bounds?.height ?? 800,
          bounds,
          pid: target?.pid,
        };
      }
    }

    if (info.sessionType === "wayland-kde" && this.hasCmd("spectacle", info.env)) {
      const tmp = join(tmpdir(), `hp-kde-${process.pid}-${Date.now()}.jpg`);
      try {
        const args = windowId !== "screen:0" ? ["-b", "-n", "-a", "-o", tmp] : ["-b", "-n", "-f", "-o", tmp];
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
        const args = windowId !== "screen:0" ? ["-w", "-f", tmp] : ["-f", tmp];
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
      const isWin = windowId !== "screen:0" && /^0x[0-9a-f]+$/i.test(windowId);
      if (this.hasCmd("maim", info.env)) {
        const args = isWin ? ["-i", windowId, "-f", "jpg"] : ["-f", "jpg"];
        const r = await this.exec("maim", args, 5000, info.env).catch(() => null);
        if (r?.code === 0 && r.stdout.length > 0) {
          return { mime: "image/jpeg", data: r.stdout.toString("base64"), width: bounds?.width ?? 1280, height: bounds?.height ?? 800, bounds, pid: target?.pid };
        }
      }
      if (this.hasCmd("import", info.env)) {
        const args = ["-silent", "-window", isWin ? windowId : "root", "-quality", "75", "jpeg:-"];
        const r = await this.exec("import", args, 5000, info.env).catch(() => null);
        if (r?.code === 0 && r.stdout.length > 0) {
          return { mime: "image/jpeg", data: r.stdout.toString("base64"), width: bounds?.width ?? 1280, height: bounds?.height ?? 800, bounds, pid: target?.pid };
        }
      }
      if (this.hasCmd("scrot", info.env)) {
        const tmp = join(tmpdir(), `hp-x11-${process.pid}-${Date.now()}.jpg`);
        try {
          let r = isWin && bounds
            ? await this.exec("scrot", ["-a", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, "-q", "75", "-o", tmp], 5000, info.env).catch(() => null)
            : null;
          if (!r || r.code !== 0 || !existsSync(tmp)) {
            r = await this.exec("scrot", ["-q", "75", "-o", tmp], 5000, info.env).catch(() => null);
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
              ? await this.exec("convert", [tmpXwd, "-quality", "75", tmpJpg], 4000, info.env).catch(() => null)
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

  async injectInput(windowId: string, input: PortalInputAction): Promise<void> {
    const info = detectPortalSession(this.deps);
    const list = await this.listWindows().catch(() => []);
    const target = list.find((w) => w.id === windowId);
    const bounds = target?.bounds ?? { x: 0, y: 0, width: 1280, height: 800 };
    const absPoint = (nx: number, ny: number) => ({
      x: Math.round(bounds.x + Math.min(1, Math.max(0, nx)) * bounds.width),
      y: Math.round(bounds.y + Math.min(1, Math.max(0, ny)) * bounds.height),
    });

    if (info.sessionType === "macos") {
      const helper = await this.ensureMacHelper();
      const pid = target?.pid ?? 0;
      if (helper) {
        if (input.type === "pointer" && (input.action === "click" || input.action === "dblclick" || input.action === "up")) {
          const { x, y } = absPoint(input.nx, input.ny);
          const count = input.action === "dblclick" ? "2" : "1";
          await this.exec(helper, ["click", String(x), String(y), input.button ?? "left", count, ...(pid ? [String(pid)] : [])], 3000);
          return;
        }
        if (input.type === "wheel") {
          await this.exec(helper, ["scroll", String(Math.round(-input.deltaY / 10)), String(Math.round(-input.deltaX / 10))], 3000);
          return;
        }
        if (input.type === "text") {
          await this.exec(helper, ["text", input.text, ...(pid ? [String(pid)] : [])], 3000);
          return;
        }
        if (input.type === "key") {
          await this.exec(helper, ["key", input.key, ...(pid ? [String(pid)] : [])], 3000);
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
      if (input.type === "pointer" && (input.action === "click" || input.action === "dblclick" || input.action === "up")) {
        const { x, y } = absPoint(input.nx, input.ny);
        const count = input.action === "dblclick" ? "2" : "1";
        await this.runWinHelper(["click", String(x), String(y), input.button ?? "left", count, hwnd], 4000).catch(() => {});
        return;
      }
      if (input.type === "wheel") {
        await this.runWinHelper(["wheel", String(Math.round(input.deltaY)), hwnd], 4000).catch(() => {});
        return;
      }
      if (input.type === "text") {
        const b64 = Buffer.from(input.text, "utf8").toString("base64");
        await this.runWinHelper(["text", b64, hwnd], 4000).catch(() => {});
        return;
      }
      if (input.type === "key") {
        await this.runWinHelper(["key", input.key, hwnd], 4000).catch(() => {});
      }
      return;
    }

    // Linux X11 & Wayland
    if (info.sessionType === "x11" || (info.env.DISPLAY && this.hasCmd("xdotool", info.env) && !this.hasCmd("ydotool", info.env))) {
      if (!this.hasCmd("xdotool", info.env)) return;
      const isWin = windowId !== "screen:0" && /^0x[0-9a-f]+$/i.test(windowId);
      if (isWin) {
        await this.exec("xdotool", ["windowactivate", windowId], 2000, info.env).catch(() => {});
      }
      if (input.type === "pointer") {
        const { x, y } = absPoint(input.nx, input.ny);
        const btn = input.button === "right" ? "3" : input.button === "middle" ? "2" : "1";
        await this.exec("xdotool", ["mousemove", "--sync", String(x), String(y)], 2000, info.env).catch(() => {});
        if (input.action === "click" || input.action === "up") {
          await this.exec("xdotool", ["click", btn], 2000, info.env).catch(() => {});
        } else if (input.action === "dblclick") {
          await this.exec("xdotool", ["click", "--repeat", "2", "--delay", "60", btn], 2000, info.env).catch(() => {});
        }
      } else if (input.type === "wheel") {
        const dir = input.deltaY > 0 ? "5" : "4";
        await this.exec("xdotool", ["click", "--repeat", "3", dir], 2000, info.env).catch(() => {});
      } else if (input.type === "text") {
        await this.exec("xdotool", ["type", "--delay", "0", "--", input.text], 3000, info.env).catch(() => {});
      } else if (input.type === "key") {
        const keyMap: Record<string, string> = { Enter: "Return", Backspace: "BackSpace", Escape: "Escape", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Tab: "Tab", " ": "space" };
        const xKey = keyMap[input.key] ?? input.key;
        await this.exec("xdotool", ["key", xKey], 2000, info.env).catch(() => {});
      }
      return;
    }

    if (this.hasCmd("ydotool", info.env)) {
      if (input.type === "pointer") {
        const { x, y } = absPoint(input.nx, input.ny);
        await this.exec("ydotool", ["mousemove", "--absolute", "-x", String(x), "-y", String(y)], 2000, info.env).catch(() => {});
        if (input.action === "click" || input.action === "up") {
          const btnHex = input.button === "right" ? "0xC1" : "0xC0";
          await this.exec("ydotool", ["click", btnHex], 2000, info.env).catch(() => {});
        }
      } else if (input.type === "text") {
        await this.exec("ydotool", ["type", input.text], 3000, info.env).catch(() => {});
      }
    }
  }
}
