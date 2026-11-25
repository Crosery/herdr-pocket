use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

mod browser;
mod browser_ai;
mod commands;
mod config;
mod cookies;
mod diagnostics;
mod drag_paths;
mod fonts;
mod local_btw;
mod local_models;
mod local_term;
mod logging;
mod mainwin;
mod net;
mod perm_companion;
mod perms;
mod portal_bridge;
mod redact;
mod relaylog;
mod resources;
mod updater;
mod voice;
mod voice_ai;
mod webdiag;
mod workspace_state;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    pub server: String,
    pub token: String,
    pub device_id: String,
    pub device_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_server: Option<String>,
}

/// A program this computer needs before its agents show up in Herdr Pocket.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDep {
    pub id: &'static str,
    pub found: bool,
    /// Agents still show up without it (Uniflo only adds conversation history).
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostdLocalStatus {
    pub installed: bool,
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    /// Whether the daemon answers on its control socket; absent where that cannot be checked (Windows).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running: Option<bool>,
    pub deps: Vec<LocalDep>,
}

/// A one-time viewer pairing code from the relay this computer's herdr-pocket is logged in
/// to. The daemon's device token that asked for it stays in this process.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPairCode {
    /// The relay, normalised like the app stores it.
    pub server: String,
    pub code: String,
    pub expires_at: i64,
    pub link: String,
}

/// A command error the UI can branch on: `{ code, message }` (message in Chinese).
#[derive(Debug, Clone, Serialize)]
pub struct CmdError {
    pub code: String,
    pub message: String,
}

impl CmdError {
    /// The message goes on screen: credentials in it (also in a relay's own words) are masked.
    fn new(code: &str, message: impl Into<String>) -> CmdError {
        let message: String = message.into();
        CmdError {
            code: code.into(),
            message: redact::text(&message).into_owned(),
        }
    }
}

/// "Cannot reach" text for the local login's relay: only host[:port] of its address.
fn offline_message(server: &str) -> String {
    let host = net::host_port(server).unwrap_or_else(|| "中转服务".into());
    format!("连不上 {host}：检查地址是否写对、服务器是否在运行；公司网络可能需要代理")
}

fn auth_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

/// The paired session (relay + device token) as the app saved it; used by the log upload and dictation.
pub(crate) fn read_session(app: &tauri::AppHandle) -> Option<SavedSession> {
    let path = auth_path(app).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<SavedSession>(&raw)
        .ok()
        .filter(|s| !s.server.is_empty() && !s.token.is_empty())
}

#[tauri::command]
fn load_auth(app: tauri::AppHandle) -> Option<SavedSession> {
    let path = auth_path(&app).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[tauri::command]
fn save_auth(app: tauri::AppHandle, session: SavedSession) -> Result<(), String> {
    let path = auth_path(&app)?;
    let data = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    // Atomic and 0600 from the first byte (the token never sits in a world-readable file).
    config::write_atomic(&path, data.as_bytes()).map_err(|e| e.to_string())?;
    logging::info(
        "pair",
        "session saved",
        json!({ "server": net::origin(&session.server), "device": session.device_name }),
    );
    relaylog::upload_soon();
    Ok(())
}

#[tauri::command]
fn clear_auth(app: tauri::AppHandle) -> Result<(), String> {
    let path = auth_path(&app)?;
    if path.exists() {
        // Lines queued under the old token go out first.
        relaylog::upload_blocking(&app, Duration::from_secs(3));
        fs::remove_file(path).map_err(|e| e.to_string())?;
        logging::info(
            "pair",
            "session cleared (signed out)",
            serde_json::Value::Null,
        );
    }
    Ok(())
}

/// Same folder as the daemon's `configDir()` in apps/hostd/src/platform.ts.
pub(crate) fn hostd_config_dir() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("HERDR_POCKET_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(custom));
    }
    #[cfg(windows)]
    {
        let base = std::env::var_os("APPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|h| h.join("AppData").join("Roaming")));
        return base.map(|dir| dir.join("herdr-pocket"));
    }
    #[cfg(not(windows))]
    {
        home_dir().map(|h| h.join(".config").join("herdr-pocket"))
    }
}

#[cfg(unix)]
fn unix_passwd_home() -> Option<PathBuf> {
    use std::ffi::CStr;
    let uid = unsafe { libc::geteuid() };
    let mut pwd = unsafe { std::mem::zeroed::<libc::passwd>() };
    let mut buf = vec![0u8; 4096];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let rc = unsafe {
        libc::getpwuid_r(
            uid,
            &mut pwd,
            buf.as_mut_ptr() as *mut libc::c_char,
            buf.len(),
            &mut result,
        )
    };
    if rc == 0 && !result.is_null() && !pwd.pw_dir.is_null() {
        let dir = unsafe { CStr::from_ptr(pwd.pw_dir) }
            .to_str()
            .ok()
            .filter(|s| !s.is_empty())?;
        return Some(PathBuf::from(dir));
    }
    None
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()))
    {
        return Some(PathBuf::from(h));
    }
    #[cfg(unix)]
    {
        unix_passwd_home()
    }
    #[cfg(not(unix))]
    {
        None
    }
}

fn read_hostd_config(dir: &Path) -> Option<serde_json::Value> {
    let raw = fs::read_to_string(dir.join("hostd.json")).ok()?;
    serde_json::from_str(&raw).ok()
}

fn config_str(cfg: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| cfg.get(*k).and_then(|v| v.as_str()))
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

fn is_program(path: &Path) -> bool {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                meta.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
        _ => false,
    }
}

/// A desktop app on macOS starts with launchd's short PATH, so this also looks where
/// installers put command-line tools (`~/.local/bin` is where herdr and herdr-pocket go).
pub(crate) fn find_program_path(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    #[cfg(not(windows))]
    {
        if let Some(home) = home_dir() {
            dirs.extend([".local/bin", ".cargo/bin", "bin"].map(|sub| home.join(sub)));
        }
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    }
    #[cfg(windows)]
    {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            dirs.push(local.join("Programs").join("herdr-core"));
            dirs.push(local.join("Programs").join("herdr-pocket").join("bin"));
        }
    }
    #[cfg(windows)]
    let names: Vec<String> = ["exe", "cmd", "bat"]
        .iter()
        .map(|ext| format!("{name}.{ext}"))
        .collect();
    #[cfg(not(windows))]
    let names: Vec<String> = vec![name.to_string()];
    for dir in dirs {
        for n in &names {
            let candidate = dir.join(n);
            if is_program(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn find_program(name: &str) -> bool {
    find_program_path(name).is_some()
}

/// The daemon's control pipe on Windows, as apps/hostd/src/platform.ts `controlAddress` names
/// it: the first 16 hex digits of sha256(config folder, lowercased). `dir` must be the exact
/// string the daemon's `configDir()` returns.
#[cfg_attr(not(windows), allow(dead_code))]
fn hostd_pipe_name(dir: &str) -> String {
    use sha2::{Digest, Sha256};
    let id: String = Sha256::digest(dir.to_lowercase().as_bytes())
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect();
    format!(r"\\.\pipe\herdr-pocket-hostd-{id}")
}

/// Whether the daemon answers on its control socket (Unix) or pipe (Windows). Blocking.
fn daemon_running(dir: &Path) -> Option<bool> {
    #[cfg(unix)]
    {
        // Connects and hangs up: the daemon ignores an empty connection.
        Some(std::os::unix::net::UnixStream::connect(dir.join("hostd.sock")).is_ok())
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_PIPE_BUSY, ERROR_SEM_TIMEOUT};
        use windows_sys::Win32::System::Pipes::WaitNamedPipeW;
        let name: Vec<u16> = hostd_pipe_name(&dir.to_string_lossy())
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // Waits up to 1 ms for a free instance without connecting; a missing pipe fails at once
        // with ERROR_FILE_NOT_FOUND, a daemon busy with every instance with a timeout.
        if unsafe { WaitNamedPipeW(name.as_ptr(), 1) } != 0 {
            return Some(true);
        }
        let err = unsafe { GetLastError() };
        Some(matches!(err, ERROR_SEM_TIMEOUT | ERROR_PIPE_BUSY))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = dir;
        None
    }
}

/// Uniflo's local API, at the daemon's default address (apps/hostd/src/uniflo.ts).
fn uniflo_running() -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], 7311));
    std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

#[tauri::command]
fn runtime_arch() -> &'static str {
    std::env::consts::ARCH
}

/// Reads this computer's hostd `deviceId` directly without blocking on socket/TCP probes.
#[tauri::command]
fn local_host_device_id() -> Option<String> {
    let dir = hostd_config_dir()?;
    let cfg = read_hostd_config(&dir)?;
    config_str(&cfg, &["deviceId", "device_id"])
}

/// The socket probes block (up to 300 ms for Uniflo): they run on the blocking pool.
#[tauri::command]
async fn hostd_status() -> HostdLocalStatus {
    let status = tauri::async_runtime::spawn_blocking(hostd_status_now)
        .await
        .unwrap_or_else(|_| hostd_status_now());
    log_hostd_change(&status);
    status
}

/// Logs what the local herdr-pocket looks like when it differs from the last look.
fn log_hostd_change(s: &HostdLocalStatus) {
    static LAST: Mutex<Option<String>> = Mutex::new(None);
    let missing: Vec<&str> = s.deps.iter().filter(|d| !d.found).map(|d| d.id).collect();
    let key = format!(
        "{}{}{:?}{:?}{:?}",
        s.installed, s.configured, s.running, s.server, missing
    );
    let Ok(mut last) = LAST.lock() else { return };
    if last.as_deref() == Some(key.as_str()) {
        return;
    }
    *last = Some(key);
    logging::info(
        "config.local",
        "local herdr-pocket detected",
        json!({
            "installed": s.installed,
            "configured": s.configured,
            "running": s.running,
            "server": s.server.as_deref().map(net::origin),
            "missing": missing,
        }),
    );
}

pub(crate) fn hostd_status_now() -> HostdLocalStatus {
    let dir = hostd_config_dir();
    let cfg = dir.as_deref().and_then(read_hostd_config);
    // The page shows and pre-fills this: never with a token or pair code from the file's URL.
    let server = cfg
        .as_ref()
        .and_then(|c| config_str(c, &["server"]))
        .map(|s| net::safe_server(&s))
        .filter(|s| !s.is_empty());
    let token = cfg.as_ref().and_then(|c| config_str(c, &["token"]));
    let device_id = cfg.as_ref().and_then(|c| config_str(c, &["deviceId"]));
    let device_name = cfg
        .as_ref()
        .and_then(|c| config_str(c, &["name", "deviceName"]));
    let running = dir.as_deref().and_then(daemon_running);
    let deps = vec![
        LocalDep {
            id: "herdr",
            found: find_program("herdr"),
            optional: false,
        },
        LocalDep {
            id: "hc",
            found: find_program("hc"),
            optional: false,
        },
        LocalDep {
            id: "herdr-pocket",
            found: running == Some(true) || find_program("herdr-pocket"),
            optional: false,
        },
        LocalDep {
            id: "uniflo",
            found: uniflo_running() || find_program("uniflo"),
            optional: true,
        },
    ];
    HostdLocalStatus {
        installed: cfg.is_some(),
        // Same rule as the daemon's loadConfig(): it needs both to log in.
        configured: server.is_some() && token.is_some(),
        server,
        device_id,
        device_name,
        running,
        deps,
    }
}

/// Pairs through this computer's own herdr-pocket login: the daemon's device token asks the
/// relay that issued it for a one-time viewer code (POST /v1/pair/codes), and only the code
/// comes back. The token never reaches the webview.
#[tauri::command]
async fn hostd_local_pair_code() -> Result<LocalPairCode, CmdError> {
    let cfg = tauri::async_runtime::spawn_blocking(|| {
        hostd_config_dir().as_deref().and_then(read_hostd_config)
    })
    .await
    .ok()
    .flatten()
    .ok_or_else(|| CmdError::new("not_logged_in", "这台电脑还没有登录 herdr-pocket"))?;
    let (Some(server), Some(token)) = (config_str(&cfg, &["server"]), config_str(&cfg, &["token"]))
    else {
        logging::warn(
            "pair.local",
            "hostd.json lacks server or token",
            serde_json::Value::Null,
        );
        return Err(CmdError::new(
            "not_logged_in",
            "本机 hostd.json 缺少服务器地址或令牌，请先运行 herdr-pocket up",
        ));
    };
    let server = net::safe_server(&server);
    let res = net::client()
        .post(format!("{server}/v1/pair/codes"))
        .bearer_auth(&token)
        .json(&json!({ "kind": "viewer" }))
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| {
            logging::warn(
                "pair.local",
                "relay unreachable for local login",
                json!({ "server": net::origin(&server), "timeout": e.is_timeout() }),
            );
            CmdError::new("offline", offline_message(&server))
        })?;
    let status = res.status().as_u16();
    let body: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);
    if !(200..300).contains(&status) {
        let code = body.pointer("/error/code").and_then(|v| v.as_str());
        let msg = body.pointer("/error/message").and_then(|v| v.as_str());
        logging::warn(
            "pair.local",
            "relay refused the local login",
            json!({ "server": net::origin(&server), "status": status, "code": code }),
        );
        if status == 401 || code == Some("unauthorized") {
            return Err(CmdError::new(
                "unauthorized",
                "这台电脑的 herdr-pocket 登录已失效：在终端运行 herdr-pocket up 重新登录，或在下面手动连接",
            ));
        }
        return Err(CmdError::new(
            code.unwrap_or("internal"),
            msg.map(str::to_string)
                .unwrap_or_else(|| format!("中转服务返回 HTTP {status}")),
        ));
    }
    let field = |k: &str| {
        body.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let out = LocalPairCode {
        code: field("code"),
        link: field("link"),
        expires_at: body.get("expiresAt").and_then(|v| v.as_i64()).unwrap_or(0),
        server,
    };
    if out.code.is_empty() {
        return Err(CmdError::new("internal", "中转服务没有返回配对码"));
    }
    logging::info(
        "pair.local",
        "viewer pair code made with the local login",
        json!({ "server": net::origin(&out.server) }),
    );
    Ok(out)
}

fn on_setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let cfg_file = config::load_at_startup();
    let cfg = config::native();
    match app.path().app_log_dir() {
        Ok(dir) => logging::init(dir, cfg.log_keep_days),
        Err(e) => eprintln!("[log] no log folder: {e}"),
    }
    let pkg = app.package_info();
    logging::info(
        "app",
        "app started",
        json!({
            "version": pkg.version.to_string(),
            "build": if cfg!(debug_assertions) { "debug" } else { "release" },
            "os": diagnostics::os_version(),
            "arch": std::env::consts::ARCH,
            "pid": std::process::id(),
            "config": { "exists": cfg_file.exists, "error": cfg_file.error, "logLevel": cfg.log_level.as_str(), "upload": cfg.log_upload },
        }),
    );
    relaylog::start(handle.clone());
    diagnostics::log_startup_profile(&handle);
    diagnostics::report_previous_crash_if_any(&handle);
    resources::start_telemetry(handle.clone());
    config::start_watch(handle.clone());
    perms::log_states("startup");
    portal_bridge::start(&handle);
    voice::init(&handle);
    browser_ai::init(&handle);
    mainwin::init(&handle);
    local_term::warmup(&handle);
    Ok(())
}

fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if mainwin::close_to_tray() {
                api.prevent_close();
                mainwin::hide_to_tray(window.app_handle());
            } else {
                // Closing the window quits, also while the hidden dictation HUD window exists
                // (otherwise "main" is not the last window and the app would linger unseen).
                window.app_handle().exit(0);
            }
        }
        tauri::WindowEvent::Moved(_) => {
            mainwin::record_window_geometry_change(window.app_handle());
        }
        tauri::WindowEvent::Focused(_) | tauri::WindowEvent::Resized(_) => {
            if matches!(event, tauri::WindowEvent::Resized(_)) {
                mainwin::record_window_geometry_change(window.app_handle());
                mainwin::sync_traffic_light_metrics(window.app_handle());
            }
            mainwin::visibility_changed(window.app_handle());
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                mainwin::sync_traffic_light_metrics(window.app_handle());
                mainwin::wake(window.app_handle(), "focus");
            }
        }
        _ => {}
    }
}

pub(crate) fn prepare_relaunch(handle: &tauri::AppHandle) {
    logging::info(
        "app",
        "app relaunch requested",
        json!({ "via": "permission" }),
    );
    mainwin::flush_window_state(handle);
    perm_companion::close(handle);
    portal_bridge::shutdown();
    local_term::shutdown();
    voice_ai::shutdown();
    voice::shutdown(handle);
    browser::on_exit(handle);
    logging::flush(Duration::from_millis(300));
}

/// Everything the app does on its way out, once, whichever quit path runs first. Bounded so
/// quitting never hangs: the upload gets 1.5 s, the file flush 1 s.
fn on_quit(handle: &tauri::AppHandle, via: &str) {
    static DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if DONE.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    logging::info("app", "app quitting", json!({ "via": via }));
    mainwin::flush_window_state(handle);
    perm_companion::close(handle);
    portal_bridge::shutdown();
    local_term::shutdown();
    voice_ai::shutdown();
    voice::shutdown(handle);
    browser::on_exit(handle);
    relaylog::upload_blocking(handle, Duration::from_millis(1500));
    logging::flush(Duration::from_secs(1));
}

fn webview_permission_response(
    label: &str,
    kind: tauri::webview::PermissionKind,
) -> tauri::webview::PermissionResponse {
    if label == "main" && matches!(kind, tauri::webview::PermissionKind::Microphone) {
        tauri::webview::PermissionResponse::Allow
    } else {
        tauri::webview::PermissionResponse::Default
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let version = context.package_info().version.to_string();
    let local_host_id = local_host_device_id();
    let builder = tauri::Builder::default().on_permission_request(|webview, kind| {
        webview_permission_response(webview.label(), kind)
    });
    // macOS only: Windows and Linux windows have no menu bar.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(mainwin::app_menu);
    let builder = builder.register_asynchronous_uri_scheme_protocol(
        "pocket-local",
        |ctx, req, responder| {
            let uri_str = req.uri().to_string();
            let label = ctx.webview_label();
            let parsed_uri = tauri::Url::parse(&uri_str).ok();
            let is_cap = parsed_uri
                .as_ref()
                .map(|u| u.path().starts_with("/cap/"))
                .unwrap_or(false);
            let is_mem_term_img = parsed_uri
                .as_ref()
                .map(|u| u.path().starts_with("/term-img/") || u.host_str() == Some("term-img"))
                .unwrap_or(false);
            let allowed = label == "main" || (is_cap && label.starts_with("browser-"));
            if !allowed {
                let res = tauri::http::Response::builder()
                    .status(403)
                    .body(Vec::new())
                    .unwrap();
                responder.respond(res);
                return;
            }
            let range_hdr = req
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            if is_mem_term_img {
                responder.respond(serve_pocket_local(&uri_str, range_hdr.as_deref()));
                return;
            }
            tauri::async_runtime::spawn_blocking(move || {
                let res = serve_pocket_local(&uri_str, range_hdr.as_deref());
                responder.respond(res);
            });
        },
    );
    let app = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(voice::hotkey::plugin())
        .plugin(webdiag::plugin(&version, local_host_id.as_deref()))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(on_setup)
        .on_window_event(on_window_event)
        .invoke_handler(tauri::generate_handler![
            load_auth,
            save_auth,
            clear_auth,
            hostd_status,
            hostd_local_pair_code,
            local_host_device_id,
            runtime_arch,
            commands::log_write,
            commands::log_info,
            commands::log_open_folder,
            commands::log_export_diagnostics,
            commands::log_upload_now,
            commands::config_load,
            commands::config_set,
            commands::config_reveal,
            commands::config_open,
            commands::permissions_status,
            commands::permission_request,
            commands::permission_open_settings,
            commands::permission_reveal_app_bundle,
            commands::permission_drag_app_bundle,
            commands::reset_mac_permission,
            commands::relaunch_app,
            commands::resource_usage,
            commands::clear_caches,
            commands::update_env,
            commands::update_fetch_sums,
            commands::update_source_cache_read,
            commands::update_source_cache_write,
            voice::voice_status,
            voice::voice_check_hotkey,
            voice::voice_reload,
            voice::voice_set_recording_hotkey,
            commands::voice_call_mic_start,
            commands::voice_call_mic_stop,
            commands::voice_call_mic_set_muted,
            commands::voice_call_dsp_open,
            commands::voice_call_dsp_process,
            commands::voice_call_dsp_close,
            commands::voice_hud_sync,
            commands::voice_hud_hide,
            commands::window_start_dragging,
            commands::window_toggle_maximize,
            commands::voice_ai_state,
            commands::voice_ai_set_config,
            commands::voice_ai_download,
            commands::voice_ai_cancel_download,
            commands::voice_ai_benchmark,
            commands::voice_ai_start_enroll,
            commands::voice_ai_finish_enroll,
            commands::voice_ai_cancel_enroll,
            commands::voice_ai_clear_voiceprint,
            commands::voice_ai_export_voiceprint,
            commands::voice_ai_import_voiceprint,
            commands::voice_ai_enroll_from_pcm,
            commands::voice_ai_start_test,
            commands::voice_ai_stop_test,
            browser::browser_open,
            browser::browser_set_bounds,
            browser::browser_navigate,
            browser::browser_set_visible,
            browser::browser_close,
            browser::browser_list,
            browser::browser_clear_data,
            browser::browser_store_kind,
            browser_ai::browser_ai_state,
            browser_ai::browser_sync_spaces,
            browser_ai::browser_ai_control,
            cookies::cookie_sources,
            cookies::cookie_domains,
            cookies::cookie_import,
            local_term::local_term_create_shell,
            local_term::local_term_attach,
            local_term::local_term_input,
            local_term::local_term_auto_input,
            local_term::local_term_focus,
            local_term::local_term_resize,
            local_term::local_term_detach,
            local_term::local_term_kill,
            local_term::local_herdr_doc_get,
            local_term::local_herdr_doc_set,
            local_term::local_term_read_image,
            local_term::local_term_stat_image,
            drag_paths::read_os_drag_paths,
            local_models::local_agent_models,
            local_models::local_set_omp_role_model,
            fonts::terminal_list_fonts,
            fonts::terminal_font_faces,
            fonts::terminal_font_bytes,
            commands::pick_folder,
            commands::pick_file,
            commands::local_read_file,
            commands::register_local_preview_token,
            commands::register_mem_html_preview,
            commands::local_reveal_in_folder,
            commands::local_open_file,
            commands::local_agent_btw,
            commands::query_os_modifiers,
            commands::query_traffic_light_metrics,
            commands::open_direct_tunnel,
            updater::update_fetch_github_latest,
            updater::update_download_and_stage,
            updater::update_restart_and_apply,
            workspace_state::workspace_state_load,
            workspace_state::workspace_state_save,
        ])
        .build(context)
        .expect("error while building Herdr Pocket desktop application");
    app.run(|handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } => on_quit(handle, "exit requested"),
        // macOS's terminate: path (Cmd+Q, Dock > Quit, logout, another app asking it to quit)
        // skips ExitRequested and only ends here.
        tauri::RunEvent::Exit => on_quit(handle, "exit"),
        // macOS: the Dock icon brings back a window closed to the tray.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => mainwin::show_main(handle, "dock"),
        _ => {}
    });
}

const MAX_LOCAL_RANGE_CHUNK: u64 = 2 * 1024 * 1024;

fn parse_byte_range(header: &str, total: u64) -> Option<Result<(u64, u64), ()>> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || total == 0 {
        return Some(Err(()));
    }
    let (start_s, end_s) = spec.split_once('-')?;
    let start_s = start_s.trim();
    let end_s = end_s.trim();
    if start_s.is_empty() {
        let suffix: u64 = end_s.parse().ok()?;
        if suffix == 0 {
            return Some(Err(()));
        }
        let start = total.saturating_sub(suffix);
        return Some(Ok((start, total - 1)));
    }
    let start: u64 = start_s.parse().ok()?;
    if start >= total {
        return Some(Err(()));
    }
    let end = if end_s.is_empty() {
        (start + MAX_LOCAL_RANGE_CHUNK - 1).min(total - 1)
    } else {
        let parsed: u64 = end_s.parse().ok()?;
        if parsed < start {
            return Some(Err(()));
        }
        parsed.min(total - 1)
    };
    Some(Ok((start, end)))
}

fn serve_pocket_local(uri_str: &str, range_hdr: Option<&str>) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};

    let empty_err = |status: u16| {
        tauri::http::Response::builder()
            .status(status)
            .header("cache-control", "no-store")
            .header("access-control-allow-origin", "*")
            .body(Vec::new())
            .unwrap()
    };

    let parsed = tauri::Url::parse(uri_str)
        .or_else(|_| tauri::Url::parse(&format!("pocket-local://localhost{uri_str}")));
    let Ok(url) = parsed else {
        return empty_err(400);
    };

    let term_img_id: Option<Option<u64>> = if url.host_str() == Some("term-img") {
        let trimmed = url.path().trim_matches('/');
        let raw = trimmed.strip_prefix("term-img/").unwrap_or(trimmed);
        Some((!raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()))
            .then(|| raw.parse::<u64>().ok())
            .flatten())
    } else if let Some(rest) = url.path().strip_prefix("/term-img/") {
        let raw = rest.trim_matches('/');
        Some((!raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()))
            .then(|| raw.parse::<u64>().ok())
            .flatten())
    } else {
        None
    };

    if let Some(id_opt) = term_img_id {
        let Some(id) = id_opt else {
            return empty_err(404);
        };
        let Some((mime, bytes)) = local_term::get_mem_image(id) else {
            return empty_err(404);
        };
        return tauri::http::Response::builder()
            .status(200)
            .header("content-type", mime)
            .header("content-length", bytes.len().to_string())
            .header("cache-control", "public, max-age=3600, immutable")
            .body((*bytes).clone())
            .unwrap();
    }

    if let Some(rest) = url.path().strip_prefix("/cap/") {
        let (token, rel) = match rest.split_once('/') {
            Some((t, r)) => (t, r),
            None => (rest, ""),
        };
        if token.starts_with("mem-") {
            let Some(bytes) = commands::get_mem_html_preview(token, rel) else {
                return empty_err(404);
            };
            return tauri::http::Response::builder()
                .status(200)
                .header("content-type", "text/html; charset=utf-8")
                .header("cache-control", "no-store")
                .header("access-control-allow-origin", "*")
                .body(bytes)
                .unwrap();
        }
    }

    let resolved = if let Some(rest) = url.path().strip_prefix("/cap/") {
        let (token, rel) = match rest.split_once('/') {
            Some((t, r)) => (t, r),
            None => (rest, ""),
        };
        match commands::resolve_cap_preview_file(token, rel) {
            Ok(r) => r,
            Err(status) => return empty_err(status),
        }
    } else {
        let mut path_param: Option<String> = None;
        let mut cwd_param: Option<String> = None;
        for (k, v) in url.query_pairs() {
            if k == "path" {
                path_param = Some(v.into_owned());
            } else if k == "cwd" {
                cwd_param = Some(v.into_owned());
            }
        }
        let Some(ref raw_path) = path_param else {
            return empty_err(400);
        };

        match commands::resolve_safe_local_file(cwd_param.as_deref(), raw_path) {
            Ok(r) => r,
            Err(msg) => {
                let status = if msg.contains("密钥") || msg.contains("设置目录") {
                    403
                } else {
                    404
                };
                return empty_err(status);
            }
        }
    };

    let mime = commands::local_stream_mime(&resolved.ext);
    let total = resolved.size;
    if total == 0 {
        return tauri::http::Response::builder()
            .status(200)
            .header("content-type", mime)
            .header("accept-ranges", "bytes")
            .header("content-length", "0")
            .header("cache-control", "private, max-age=60")
            .header("access-control-allow-origin", "*")
            .header(
                "access-control-expose-headers",
                "content-length, content-range, accept-ranges, content-type",
            )
            .body(Vec::new())
            .unwrap();
    }

    if let Some(rh) = range_hdr {
        if let Some(range_res) = parse_byte_range(rh, total) {
            match range_res {
                Ok((start, end)) => {
                    let mut file = match fs::File::open(&resolved.canon) {
                        Ok(f) => f,
                        Err(_) => return empty_err(404),
                    };
                    if file.seek(SeekFrom::Start(start)).is_err() {
                        return empty_err(500);
                    }
                    let want = end - start + 1;
                    let mut buf = Vec::with_capacity((want as usize).min(4 * 1024 * 1024));
                    if file.take(want).read_to_end(&mut buf).is_err() {
                        return empty_err(500);
                    }
                    return tauri::http::Response::builder()
                        .status(206)
                        .header("content-type", mime)
                        .header("accept-ranges", "bytes")
                        .header("content-range", format!("bytes {start}-{end}/{total}"))
                        .header("content-length", buf.len().to_string())
                        .header("cache-control", "private, max-age=60")
                        .header("access-control-allow-origin", "*")
                        .header(
                            "access-control-expose-headers",
                            "content-length, content-range, accept-ranges, content-type",
                        )
                        .body(buf)
                        .unwrap();
                }
                Err(()) => {
                    return tauri::http::Response::builder()
                        .status(416)
                        .header("content-range", format!("bytes */{total}"))
                        .header("access-control-allow-origin", "*")
                        .body(Vec::new())
                        .unwrap();
                }
            }
        }
    }

    if total > 8 * 1024 * 1024 {
        let file = match fs::File::open(&resolved.canon) {
            Ok(f) => f,
            Err(_) => return empty_err(404),
        };
        let end = (MAX_LOCAL_RANGE_CHUNK - 1).min(total - 1);
        let want = end + 1;
        let mut buf = Vec::with_capacity(want as usize);
        if file.take(want).read_to_end(&mut buf).is_err() {
            return empty_err(500);
        }
        return tauri::http::Response::builder()
            .status(206)
            .header("content-type", mime)
            .header("accept-ranges", "bytes")
            .header("content-range", format!("bytes 0-{end}/{total}"))
            .header("content-length", buf.len().to_string())
            .header("cache-control", "private, max-age=60")
            .header("access-control-allow-origin", "*")
            .header(
                "access-control-expose-headers",
                "content-length, content-range, accept-ranges, content-type",
            )
            .body(buf)
            .unwrap();
    }

    let Ok(bytes) = fs::read(&resolved.canon) else {
        return empty_err(404);
    };
    tauri::http::Response::builder()
        .status(200)
        .header("content-type", mime)
        .header("accept-ranges", "bytes")
        .header("content-length", bytes.len().to_string())
        .header("cache-control", "private, max-age=60")
        .header("access-control-allow-origin", "*")
        .header(
            "access-control-expose-headers",
            "content-length, content-range, accept-ranges, content-type",
        )
        .body(bytes)
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::{hostd_pipe_name, offline_message, parse_byte_range, CmdError};

    #[test]
    fn local_login_errors_show_no_secrets() {
        // A hostd.json server with a pair-link path, a pair code and a token in the query.
        let raw = "https://127.0.0.1:7499/p/ABCD-2345?token=s3cr3t-tok&pc=ABCD-2345&x=1";
        let server = crate::net::clean_base(&crate::net::normalize_server(raw));
        let e = CmdError::new("offline", offline_message(&server));
        assert!(
            e.message.starts_with("连不上 127.0.0.1:7499："),
            "{}",
            e.message
        );
        for leak in ["s3cr3t", "ABCD-2345", "/p/", "token", "?"] {
            assert!(!e.message.contains(leak), "{leak} in {}", e.message);
        }
        // Without a scheme the address still reduces to host[:port].
        let e = CmdError::new(
            "offline",
            offline_message(&crate::net::normalize_server(
                "pocket.example.com/p/x?token=y",
            )),
        );
        assert!(
            e.message.starts_with("连不上 pocket.example.com："),
            "{}",
            e.message
        );
        // A relay's own words are masked too.
        let e = CmdError::new("internal", "bad request: token=s3cr3t-tok");
        assert!(!e.message.contains("s3cr3t"), "{}", e.message);
    }

    #[test]
    fn pipe_name_matches_hostd() {
        // Reference values from apps/hostd/src/platform.ts `controlAddress` (Node's sha256).
        assert_eq!(
            hostd_pipe_name(r"C:\Users\Alice\AppData\Roaming\herdr-pocket"),
            r"\\.\pipe\herdr-pocket-hostd-ffa03030cd691aeb"
        );
        assert_eq!(
            hostd_pipe_name(r"D:\Pocket Home"),
            r"\\.\pipe\herdr-pocket-hostd-7b2f6d134de49fff"
        );
    }

    #[test]
    fn byte_range_parser_handles_open_suffix_and_invalid() {
        assert_eq!(parse_byte_range("bytes=0-99", 500), Some(Ok((0, 99))));
        assert_eq!(parse_byte_range("bytes=450-", 500), Some(Ok((450, 499))));
        assert_eq!(parse_byte_range("bytes=-64", 500), Some(Ok((436, 499))));
        assert_eq!(parse_byte_range("bytes=500-510", 500), Some(Err(())));
        assert_eq!(parse_byte_range("bytes=10-5", 500), Some(Err(())));
    }

    #[test]
    fn serve_pocket_local_serves_term_img_from_memory_cache() {
        let _guard = crate::local_term::MEM_IMAGE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];
        let id = crate::local_term::insert_mem_image("image/png", png.clone()).unwrap();

        for uri in [
            format!("pocket-local://localhost/term-img/{id}"),
            format!("http://pocket-local.localhost/term-img/{id}"),
            format!("pocket-local://term-img/{id}"),
        ] {
            let resp = super::serve_pocket_local(&uri, None);
            assert_eq!(resp.status().as_u16(), 200, "uri={uri}");
            assert_eq!(
                resp.headers().get("content-type").and_then(|v| v.to_str().ok()),
                Some("image/png")
            );
            assert_eq!(
                resp.headers().get("content-length").and_then(|v| v.to_str().ok()),
                Some("12")
            );
            assert_eq!(
                resp.headers().get("cache-control").and_then(|v| v.to_str().ok()),
                Some("public, max-age=3600, immutable")
            );
            assert_eq!(resp.body(), &png);
        }

        let miss = super::serve_pocket_local("pocket-local://localhost/term-img/99999999", None);
        assert_eq!(miss.status().as_u16(), 404);
        let bad = super::serve_pocket_local("pocket-local://localhost/term-img/not-an-id", None);
        assert_eq!(bad.status().as_u16(), 404);
    }

    #[test]
    fn serve_pocket_local_serves_capability_and_blocks_escape_or_private() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("herdr-pocket-cap-{nanos}"));
        let sub = dir.join("assets");
        std::fs::create_dir_all(&sub).unwrap();
        let html = dir.join("preview.html");
        let img = sub.join("shot.png");
        let env_file = dir.join(".env");
        let png = [0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        std::fs::write(&html, b"<html><img src='./assets/shot.png'></html>").unwrap();
        std::fs::write(&img, png).unwrap();
        std::fs::write(&env_file, b"SECRET=1").unwrap();

        let cap_url = crate::commands::issue_local_preview_url(None, &html.to_string_lossy()).unwrap();
        assert!(cap_url.contains("/cap/"));
        let token = cap_url.split("/cap/").nth(1).unwrap().split('/').next().unwrap();

        let html_resp = super::serve_pocket_local(&cap_url, None);
        assert_eq!(html_resp.status().as_u16(), 200);
        assert_eq!(
            html_resp.headers().get("content-type").and_then(|v| v.to_str().ok()),
            Some("text/html; charset=utf-8")
        );

        let asset_uri = format!("pocket-local://localhost/cap/{token}/assets/shot.png");
        let img_resp = super::serve_pocket_local(&asset_uri, None);
        assert_eq!(img_resp.status().as_u16(), 200);
        assert_eq!(img_resp.body(), &png);
        assert_eq!(
            img_resp.headers().get("content-type").and_then(|v| v.to_str().ok()),
            Some("image/png")
        );

        let norm_escape_uri = format!("pocket-local://localhost/cap/{token}/../etc/passwd");
        let norm_escape_status = super::serve_pocket_local(&norm_escape_uri, None).status().as_u16();
        assert!(norm_escape_status == 403 || norm_escape_status == 404);
        assert_eq!(crate::commands::resolve_cap_preview_file(token, "../etc/passwd").err(), Some(403));
        assert_eq!(crate::commands::resolve_cap_preview_file(token, "%2e%2e/etc/passwd").err(), Some(403));

        let env_uri = format!("pocket-local://localhost/cap/{token}/.env");
        assert_eq!(super::serve_pocket_local(&env_uri, None).status().as_u16(), 403);

        assert_eq!(
            super::serve_pocket_local("pocket-local://localhost/cap/deadbeef/index.html", None)
                .status()
                .as_u16(),
            404
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn serve_pocket_local_serves_mem_html_preview_and_blocks_mismatch() {
        let html = "<!doctype html><html><body><script>window.__ok=1</script></body></html>";
        let url = crate::commands::issue_mem_html_preview_url("架构关系图.html", html).unwrap();
        assert!(url.contains("/cap/mem-"));

        let resp = super::serve_pocket_local(&url, None);
        assert_eq!(resp.status().as_u16(), 200);
        assert_eq!(
            resp.headers().get("content-type").and_then(|v| v.to_str().ok()),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(resp.body(), html.as_bytes());

        let token = url.split("/cap/").nth(1).unwrap().split('/').next().unwrap();
        let bad = format!("pocket-local://localhost/cap/{token}/other.html");
        assert_eq!(super::serve_pocket_local(&bad, None).status().as_u16(), 404);
    }

    #[test]
    fn main_webview_microphone_permission_is_allowed_and_others_default() {
        use tauri::webview::{PermissionKind, PermissionResponse};
        assert!(matches!(
            super::webview_permission_response("main", PermissionKind::Microphone),
            PermissionResponse::Allow
        ));
        assert!(matches!(
            super::webview_permission_response("main", PermissionKind::Camera),
            PermissionResponse::Default
        ));
        assert!(matches!(
            super::webview_permission_response("browser-1", PermissionKind::Microphone),
            PermissionResponse::Default
        ));
    }
}
