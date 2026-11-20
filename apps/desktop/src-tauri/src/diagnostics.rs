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
