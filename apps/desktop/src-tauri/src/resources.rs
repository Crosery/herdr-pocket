//! Energy, memory and disk: what this app uses, so Settings can show it and the
//! app can slow down on battery. Also tracks whether the main window is
//! visible, which background loops use to back off.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Manager};

static VISIBLE: AtomicBool = AtomicBool::new(true);

pub fn set_window_visible(v: bool) {
    VISIBLE.store(v, Ordering::Relaxed);
}

/// The main window is shown, not minimised and (macOS) not fully covered, hidden with the app
/// or on another Space.
pub fn window_visible() -> bool {
    VISIBLE.load(Ordering::Relaxed)
}

/// Re-reads visibility from the main window (window events; macOS occlusion changes).
/// `get_window`, not `get_webview_window`: once the browser panel adds a child
/// webview, "main" is no longer a single-webview window and the latter returns None.
pub fn refresh_visibility(app: &AppHandle) {
    if let Some(w) = app.get_window("main") {
        let shown =
            w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false) && on_screen(&w);
        set_window_visible(shown);
    }
}

/// macOS: whether any part of the window can be seen (AppKit's occlusion state). Only read on
/// the main thread; elsewhere the window counts as on screen.
#[cfg(target_os = "macos")]
fn on_screen(w: &tauri::Window) -> bool {
    if objc2::MainThreadMarker::new().is_none() {
        return true;
    }
    match w.ns_window() {
        Ok(p) if !p.is_null() => {
            // SAFETY: tauri's NSWindow pointer, read on the main thread while the window exists.
            let ns = unsafe { &*(p as *const objc2_app_kit::NSWindow) };
            ns.occlusionState().0 & (1 << 1) != 0 // NSWindowOcclusionStateVisible
        }
        _ => true,
    }
}

#[cfg(not(target_os = "macos"))]
fn on_screen(_w: &tauri::Window) -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessUsage {
    /// Resident memory of this process.
    pub rss_bytes: u64,
    /// What Activity Monitor calls "Memory" (macOS) / private bytes (Windows).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub footprint_bytes: Option<u64>,
    /// User + system CPU time since start.
    pub cpu_seconds: f64,
    /// Package idle wake-ups since start (macOS; a large part of "energy impact").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wakeups: Option<u64>,
    /// Memory of the WebView2 helper processes (Windows); WebKit's helpers on macOS are not ours to count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webview_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub process: ProcessUsage,
    /// CPU use since the previous call, percent of one core.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wakeups_per_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_free_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disk_total_bytes: Option<u64>,
    /// None when the OS does not say (desktops without a battery report false).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_battery: Option<bool>,
    /// macOS Low Power Mode / Windows battery saver.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_low_power: Option<bool>,
    /// `resources.lowPower` applied: on, off, or auto (on battery or system low power).
    pub low_power: bool,
    pub log_bytes: u64,
    pub cache_bytes: u64,
    pub browser_data_bytes: u64,
    pub window_visible: bool,
    /// Chinese, for Settings: memory over `resources.memoryWarnMb`, free disk under `resources.diskWarnGb`.
    pub warnings: Vec<String>,
}

#[cfg(target_os = "macos")]
fn process_usage() -> ProcessUsage {
    let mut out = ProcessUsage::default();
    unsafe {
        let mut ru: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut ru) == 0 {
            let t = |tv: libc::timeval| tv.tv_sec as f64 + tv.tv_usec as f64 / 1e6;
            out.cpu_seconds = t(ru.ru_utime) + t(ru.ru_stime);
        }
        let mut info: libc::rusage_info_v2 = std::mem::zeroed();
        let ptr = &mut info as *mut libc::rusage_info_v2 as *mut libc::rusage_info_t;
        if libc::proc_pid_rusage(libc::getpid(), libc::RUSAGE_INFO_V2, ptr) == 0 {
            out.rss_bytes = info.ri_resident_size;
            out.footprint_bytes = Some(info.ri_phys_footprint);
            out.wakeups = Some(info.ri_pkg_idle_wkups + info.ri_interrupt_wkups);
        }
    }
    out
}

#[cfg(windows)]
fn process_usage() -> ProcessUsage {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetCurrentProcessId, GetProcessTimes, OpenProcess,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    fn memory(handle: windows_sys::Win32::Foundation::HANDLE) -> Option<(u64, u64)> {
        unsafe {
            let mut pmc: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
            pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
            let ok = K32GetProcessMemoryInfo(handle, &mut pmc as *mut _ as *mut _, pmc.cb);
            (ok != 0).then_some((pmc.WorkingSetSize as u64, pmc.PrivateUsage as u64))
        }
    }

    let mut out = ProcessUsage::default();
    unsafe {
        let me = GetCurrentProcess();
        if let Some((ws, private)) = memory(me) {
            out.rss_bytes = ws;
            out.footprint_bytes = Some(private);
        }
        let mut c: FILETIME = std::mem::zeroed();
        let mut e: FILETIME = std::mem::zeroed();
        let mut k: FILETIME = std::mem::zeroed();
        let mut u: FILETIME = std::mem::zeroed();
        if GetProcessTimes(me, &mut c, &mut e, &mut k, &mut u) != 0 {
            let secs = |f: FILETIME| {
                ((u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime)) as f64 / 1e7
            };
            out.cpu_seconds = secs(k) + secs(u);
        }
        // WebView2 runs in msedgewebview2.exe processes below ours.
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap != INVALID_HANDLE_VALUE {
            let mut procs: Vec<(u32, u32)> = Vec::new();
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snap, &mut entry) != 0 {
                loop {
                    procs.push((entry.th32ProcessID, entry.th32ParentProcessID));
                    if Process32NextW(snap, &mut entry) == 0 {
                        break;
                    }
                }
            }
            CloseHandle(snap);
            let mut ours = vec![GetCurrentProcessId()];
            let mut i = 0;
            while i < ours.len() && ours.len() < 64 {
                let parent = ours[i];
                for (pid, ppid) in &procs {
                    if *ppid == parent && *pid != parent && !ours.contains(pid) {
                        ours.push(*pid);
                    }
                }
                i += 1;
            }
            let mut total = 0u64;
            for pid in ours.iter().skip(1) {
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, *pid);
                if !h.is_null() {
                    if let Some((ws, _)) = memory(h) {
                        total += ws;
                    }
                    CloseHandle(h);
                }
            }
            out.webview_bytes = Some(total);
        }
    }
    out
}

#[cfg(all(not(target_os = "macos"), not(windows)))]
fn process_usage() -> ProcessUsage {
    let mut out = ProcessUsage::default();
    if let Ok(s) = std::fs::read_to_string("/proc/self/statm") {
        let pages: u64 = s
            .split_whitespace()
            .nth(1)
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        out.rss_bytes = pages * 4096;
    }
    out
}

/// (free, total) bytes of the volume holding `p`.
#[cfg(unix)]
fn disk_space(p: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
    unsafe {
        let mut st: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut st) != 0 {
            return None;
        }
        let frsize = st.f_frsize as u64;
        Some((st.f_bavail as u64 * frsize, st.f_blocks as u64 * frsize))
    }
}

#[cfg(windows)]
fn disk_space(p: &Path) -> Option<(u64, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = p
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free = 0u64;
    let mut total = 0u64;
    let ok =
        unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, std::ptr::null_mut()) };
    (ok != 0).then_some((free, total))
}

#[cfg(target_os = "macos")]
mod power {
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPSCopyPowerSourcesInfo() -> CFTypeRef;
        fn IOPSGetProvidingPowerSourceType(snapshot: CFTypeRef) -> CFStringRef;
    }

    pub fn on_battery() -> Option<bool> {
        unsafe {
            let snap = IOPSCopyPowerSourcesInfo();
            if snap.is_null() {
                return None;
            }
            let snap = CFType::wrap_under_create_rule(snap);
            let kind = IOPSGetProvidingPowerSourceType(snap.as_CFTypeRef());
            if kind.is_null() {
                return None;
            }
            let kind = CFString::wrap_under_get_rule(kind).to_string();
            Some(kind == "Battery Power")
        }
    }

    pub fn system_low_power() -> Option<bool> {
        let info = objc2_foundation::NSProcessInfo::processInfo();
        Some(info.isLowPowerModeEnabled())
    }
}

#[cfg(windows)]
mod power {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

    fn status() -> Option<SYSTEM_POWER_STATUS> {
        unsafe {
            let mut s: SYSTEM_POWER_STATUS = std::mem::zeroed();
            (GetSystemPowerStatus(&mut s) != 0).then_some(s)
        }
    }

    pub fn on_battery() -> Option<bool> {
        // ACLineStatus: 0 offline (battery), 1 online, 255 unknown.
        status().and_then(|s| match s.ACLineStatus {
            0 => Some(true),
            1 => Some(false),
            _ => None,
        })
    }

    pub fn system_low_power() -> Option<bool> {
        // SystemStatusFlag 1: battery saver is on.
        status().map(|s| s.SystemStatusFlag == 1)
    }
}

#[cfg(all(not(target_os = "macos"), not(windows)))]
mod power {
    pub fn on_battery() -> Option<bool> {
        None
    }
    pub fn system_low_power() -> Option<bool> {
        None
    }
}

/// Size of everything under `dir`, stopping after `limit` entries so a huge cache never stalls.
pub fn dir_size(dir: &Path, limit: usize) -> u64 {
    let mut total = 0u64;
    let mut seen = 0usize;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in rd.flatten() {
            seen += 1;
            if seen > limit {
                return total;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

struct Last {
    at: Instant,
    cpu: f64,
    wakeups: Option<u64>,
}

fn last() -> &'static Mutex<Option<Last>> {
    static L: OnceLock<Mutex<Option<Last>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(None))
}

pub fn low_power_active(setting: &str, on_battery: Option<bool>, system_low: Option<bool>) -> bool {
    match setting {
        "on" => true,
        "off" => false,
        _ => on_battery == Some(true) || system_low == Some(true),
    }
}

fn data_dirs(app: &AppHandle) -> (Option<PathBuf>, Option<PathBuf>) {
    (
        app.path().app_cache_dir().ok(),
        crate::browser::data_dir(app),
    )
}

pub fn usage(app: &AppHandle) -> Usage {
    let process = process_usage();
    let now = Instant::now();
    let (cpu_percent, wakeups_per_sec) = {
        let mut guard = last().lock().ok();
        let prev = guard.as_mut().and_then(|g| g.take());
        let out = match prev {
            Some(p) => {
                let dt = now.duration_since(p.at).as_secs_f64();
                if dt > 0.2 {
                    let cpu = ((process.cpu_seconds - p.cpu) / dt * 100.0).max(0.0);
                    let wk = match (process.wakeups, p.wakeups) {
                        (Some(a), Some(b)) => Some(a.saturating_sub(b) as f64 / dt),
                        _ => None,
                    };
                    (
                        Some((cpu * 10.0).round() / 10.0),
                        wk.map(|w| (w * 10.0).round() / 10.0),
                    )
                } else {
                    (None, None)
                }
            }
            None => (None, None),
        };
        if let Some(g) = guard.as_mut() {
            **g = Some(Last {
                at: now,
                cpu: process.cpu_seconds,
                wakeups: process.wakeups,
            });
        }
        out
    };
    let cfg = crate::config::native();
    let (cache, browser) = data_dirs(app);
    let base = app.path().app_data_dir().ok().or_else(|| cache.clone());
    let disk = base.as_deref().and_then(|p| {
        let mut probe = p.to_path_buf();
        while !probe.exists() {
            if !probe.pop() {
                break;
            }
        }
        disk_space(&probe)
    });
    let on_battery = power::on_battery();
    let system_low_power = power::system_low_power();
    let mut warnings = Vec::new();
    let mem =
        process.footprint_bytes.unwrap_or(process.rss_bytes) + process.webview_bytes.unwrap_or(0);
    if mem > cfg.memory_warn_mb * 1024 * 1024 {
        warnings.push(format!(
            "Herdr Pocket 占用内存约 {} MB，超过了你设的 {} MB",
            mem / 1024 / 1024,
            cfg.memory_warn_mb
        ));
    }
    if let Some((free, _)) = disk {
        if free < cfg.disk_warn_gb * 1024 * 1024 * 1024 {
            warnings.push(format!(
                "磁盘剩余空间约 {:.1} GB，低于 {} GB",
                free as f64 / 1e9,
                cfg.disk_warn_gb
            ));
        }
    }
    Usage {
        process,
        cpu_percent,
        wakeups_per_sec,
        disk_free_bytes: disk.map(|d| d.0),
        disk_total_bytes: disk.map(|d| d.1),
        on_battery,
        system_low_power,
        low_power: low_power_active(&cfg.low_power, on_battery, system_low_power),
        log_bytes: crate::logging::log_dir()
            .map(|d| dir_size(&d, 100))
            .unwrap_or(0),
        cache_bytes: cache.map(|d| dir_size(&d, 20_000)).unwrap_or(0),
        browser_data_bytes: browser.map(|d| dir_size(&d, 20_000)).unwrap_or(0),
        window_visible: window_visible(),
        warnings,
    }
}

pub fn snapshot_value(app: &AppHandle) -> Value {
    serde_json::to_value(usage(app)).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn low_power_rules() {
        assert!(low_power_active("on", Some(false), None));
        assert!(!low_power_active("off", Some(true), Some(true)));
        assert!(low_power_active("auto", Some(true), None));
        assert!(low_power_active("auto", None, Some(true)));
        assert!(!low_power_active("auto", None, None));
    }

    #[test]
    fn process_usage_reads_something() {
        let u = process_usage();
        assert!(u.rss_bytes > 0);
    }
}
