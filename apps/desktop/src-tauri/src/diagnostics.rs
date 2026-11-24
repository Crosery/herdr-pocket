//! A diagnostics bundle the person can attach to a bug report: system facts,
//! settings, permission states and every local log file, in one redacted text
//! file in Downloads. Nothing is sent anywhere by this module.

use crate::{logging, net, redact};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output();
        if let Ok(o) = out {
            return format!("macOS {}", String::from_utf8_lossy(&o.stdout).trim());
        }
        "macOS".into()
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = std::process::Command::new("cmd")
            .args(["/C", "ver"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(o) = out {
            return String::from_utf8_lossy(&o.stdout).trim().to_string();
        }
        "Windows".into()
    }
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|s| {
                s.lines().find_map(|l| {
                    l.strip_prefix("PRETTY_NAME=")
                        .map(|v| v.trim_matches('"').to_string())
                })
            })
            .unwrap_or_else(|| std::env::consts::OS.to_string())
    }
}

#[cfg(target_os = "macos")]
fn sysctl_string(name: &str) -> Option<String> {
    use std::ffi::CString;
    let c_name = CString::new(name).ok()?;
    let mut size: libc::size_t = 0;
    unsafe {
        if libc::sysctlbyname(
            c_name.as_ptr(),
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        ) != 0
            || size == 0
        {
            return None;
        }
        let mut buf = vec![0u8; size];
        if libc::sysctlbyname(
            c_name.as_ptr(),
            buf.as_mut_ptr() as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        ) != 0
        {
            return None;
        }
        while buf.last() == Some(&0) {
            buf.pop();
        }
        String::from_utf8(buf).ok().filter(|s| !s.is_empty())
    }
}

#[cfg(unix)]
fn total_ram_mb() -> Option<u64> {
    unsafe {
        let pages = libc::sysconf(libc::_SC_PHYS_PAGES);
        let page_size = libc::sysconf(libc::_SC_PAGESIZE);
        if pages > 0 && page_size > 0 {
            Some(((pages as u64).saturating_mul(page_size as u64)) / (1024 * 1024))
        } else {
            None
        }
    }
}

#[cfg(not(unix))]
fn total_ram_mb() -> Option<u64> {
    None
}

pub fn hardware_profile() -> Value {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    #[cfg(target_os = "macos")]
    let (cpu_brand, hw_model) = (
        sysctl_string("machdep.cpu.brand_string"),
        sysctl_string("hw.model"),
    );
    #[cfg(not(target_os = "macos"))]
    let (cpu_brand, hw_model): (Option<String>, Option<String>) = (None, None);
    json!({
        "os": os_version(),
        "arch": std::env::consts::ARCH,
        "cores": cores,
        "ramMb": total_ram_mb(),
        "cpu": cpu_brand,
        "hwModel": hw_model,
    })
}

pub fn log_startup_profile(app: &AppHandle) {
    let mut profile = hardware_profile();
    if let Value::Object(ref mut m) = profile {
        m.insert(
            "version".into(),
            Value::String(app.package_info().version.to_string()),
        );
    }
    logging::info("sys.boot", "desktop hardware & OS profile", profile);
}

#[cfg(target_os = "macos")]
pub fn report_previous_crash_if_any(app: &AppHandle) {
    let Some(home) = crate::home_dir() else {
        return;
    };
    let diag_dir = home.join("Library").join("Logs").join("DiagnosticReports");
    let Ok(entries) = fs::read_dir(&diag_dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            (name.starts_with("herdr-pocket-desktop-") || name.starts_with("Herdr Pocket-"))
                && name.ends_with(".ips")
        })
        .collect();
    files.sort();
    let Some(newest) = files.pop() else {
        return;
    };
    let Some(file_name) = newest.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
        return;
    };
    let marker_path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("last-reported-crash.txt"));
    if let Some(ref mp) = marker_path {
        if fs::read_to_string(mp).ok().as_deref().map(str::trim) == Some(file_name.as_str()) {
            return;
        }
    }
    let Ok(raw) = fs::read_to_string(&newest) else {
        return;
    };
    let mut lines = raw.lines();
    let header_json: Option<Value> = lines.next().and_then(|l| serde_json::from_str(l).ok());
    let body_raw: String = lines.collect::<Vec<_>>().join("\n");
    let body_json: Option<Value> = serde_json::from_str(&body_raw).ok();
    let version = header_json
        .as_ref()
        .and_then(|h| h.get("app_version").and_then(|v| v.as_str()))
        .unwrap_or("unknown");
    let capture_time = header_json
        .as_ref()
        .and_then(|h| h.get("timestamp").and_then(|v| v.as_str()))
        .unwrap_or("");
    let exc_type = body_json
        .as_ref()
        .and_then(|b| b.pointer("/exception/type").and_then(|v| v.as_str()))
        .unwrap_or("unknown");
    let exc_sub = body_json
        .as_ref()
        .and_then(|b| b.pointer("/exception/subtype").and_then(|v| v.as_str()))
        .unwrap_or("");
    let fault_idx = body_json
        .as_ref()
        .and_then(|b| b.get("faultingThread").and_then(|v| v.as_u64()))
        .unwrap_or(0) as usize;
    let frames: Vec<String> = body_json
        .as_ref()
        .and_then(|b| b.pointer(&format!("/threads/{fault_idx}/frames")))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .take(8)
                .filter_map(|f| {
                    let sym = f.get("symbol").and_then(|v| v.as_str())?;
                    Some(redact::text(sym).into_owned())
                })
                .collect()
        })
        .unwrap_or_default();
    logging::warn(
        "sys.crash_prev",
        &format!("previous crash report detected ({file_name}): {exc_type}"),
        json!({
            "file": redact::text(&file_name).into_owned(),
            "appVersion": version,
            "captureTime": capture_time,
            "exception": exc_type,
            "subtype": exc_sub,
            "topFrames": frames,
        }),
    );
    if let Some(mp) = marker_path {
        if let Some(parent) = mp.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(mp, &file_name);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn report_previous_crash_if_any(_app: &AppHandle) {}

fn system_section(app: &AppHandle) -> Value {
    let pkg = app.package_info();
    json!({
        "app": pkg.version.to_string(),
        "identifier": app.config().identifier,
        "build": if cfg!(debug_assertions) { "debug" } else { "release" },
        "os": os_version(),
        "arch": std::env::consts::ARCH,
        "logDir": logging::log_dir().map(|d| d.display().to_string()),
        "logLevel": logging::min_level().as_str(),
        "logUpload": logging::upload_enabled(),
        "queuedForRelay": logging::relay_queue_len(),
    })
}

fn session_section(app: &AppHandle) -> Value {
    match crate::read_session(app) {
        Some(s) => json!({
            "paired": true,
            "server": net::origin(&s.server),
            "deviceName": s.device_name,
        }),
        None => json!({ "paired": false }),
    }
}

/// Everything except the log lines, each section already redacted.
pub fn summary(app: &AppHandle, context: Option<Value>) -> Vec<(&'static str, Value)> {
    let mut out = vec![
        ("system", system_section(app)),
        ("session", session_section(app)),
        (
            "local herdr-pocket",
            serde_json::to_value(crate::hostd_status_now()).unwrap_or(Value::Null),
        ),
        ("config.json", crate::config::diagnostics()),
        ("permissions", crate::perms::snapshot_value()),
        ("resources", crate::resources::snapshot_value(app)),
    ];
    if let Some(ctx) = context {
        out.push(("app context", ctx));
    }
    for (_, v) in out.iter_mut() {
        redact::value(v, 2000);
    }
    out
}

fn target_path(app: &AppHandle) -> Result<PathBuf, String> {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let name = format!("herdr-pocket-diagnostics-{stamp}.txt");
    let dir = app
        .path()
        .download_dir()
        .ok()
        .filter(|d| d.is_dir())
        .or_else(logging::log_dir)
        .ok_or_else(|| "找不到可以保存诊断文件的文件夹".to_string())?;
    Ok(dir.join(name))
}

/// Writes the bundle and returns its path.
pub fn export(app: &AppHandle, context: Option<Value>) -> Result<PathBuf, String> {
    logging::flush(std::time::Duration::from_secs(2));
    let path = target_path(app)?;
    let mut f = fs::File::create(&path).map_err(|e| format!("无法创建诊断文件：{e}"))?;
    let mut w = std::io::BufWriter::new(&mut f);
    let head = format!(
        "Herdr Pocket 诊断信息 / diagnostics\n生成时间 / generated: {}\n令牌、Cookie、配对码与主目录路径已移除 / tokens, cookies, pair codes and the home folder are removed.\n\n",
        logging::local_time(logging::now_ms())
    );
    w.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
    for (title, value) in summary(app, context) {
        let body = serde_json::to_string_pretty(&value).unwrap_or_default();
        writeln!(w, "== {title} ==\n{body}\n").map_err(|e| e.to_string())?;
    }
    writeln!(w, "== log (oldest first) ==").map_err(|e| e.to_string())?;
    if let Some(dir) = logging::log_dir() {
        for file in logging::files(&dir) {
            let Ok(src) = fs::File::open(&file) else {
                continue;
            };
            for line in BufReader::new(src).lines().map_while(Result::ok) {
                // Lines were redacted when written; again in case an older version wrote them.
                writeln!(w, "{}", redact::text(&line)).map_err(|e| e.to_string())?;
            }
        }
    }
    w.flush().map_err(|e| e.to_string())?;
    drop(w);
    logging::info(
        "app.diag",
        "diagnostics exported",
        json!({ "bytes": f.metadata().map(|m| m.len()).unwrap_or(0) }),
    );
    Ok(path)
}
