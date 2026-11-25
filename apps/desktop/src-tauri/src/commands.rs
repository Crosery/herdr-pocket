//! Commands for logging, the config file, permissions and resource use.
//! Voice input and the browser panel have theirs in `voice` and `browser`.

use crate::logging::{self, Level};
use crate::{config, diagnostics, perms, relaylog, resources};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn log_write(level: String, kind: String, msg: String, data: Option<Value>) {
    let parsed = Level::parse(&level).unwrap_or(Level::Info);
    logging::write(parsed, "web", &kind, &msg, data.unwrap_or(Value::Null));
    if parsed >= Level::Error {
        relaylog::upload_soon();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    name: String,
    bytes: u64,
    modified: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFolderInfo {
    dir: String,
    files: Vec<LogFile>,
    total_bytes: u64,
    queued_for_relay: usize,
}

#[tauri::command]
pub fn log_info() -> Option<LogFolderInfo> {
    let dir = logging::log_dir()?;
    let files: Vec<LogFile> = logging::files(&dir)
        .into_iter()
        .rev()
        .filter_map(|p| {
            let meta = fs::metadata(&p).ok()?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            Some(LogFile {
                name: p.file_name()?.to_string_lossy().into_owned(),
                bytes: meta.len(),
                modified,
            })
        })
        .collect();
    let total_bytes = files.iter().map(|f| f.bytes).sum();
    Some(LogFolderInfo {
        dir: dir.display().to_string(),
        files,
        total_bytes,
        queued_for_relay: logging::relay_queue_len(),
    })
}

#[tauri::command]
pub fn log_open_folder() -> Result<(), String> {
    let dir = logging::log_dir().ok_or_else(|| "日志文件夹还没有创建".to_string())?;
    tauri_plugin_opener::open_path(dir.display().to_string(), None::<&str>)
        .map_err(|e| format!("无法打开日志文件夹：{e}"))
}

#[tauri::command]
pub async fn log_export_diagnostics(
    app: AppHandle,
    context: Option<Value>,
) -> Result<String, String> {
    let path = tauri::async_runtime::spawn_blocking(move || diagnostics::export(&app, context))
        .await
        .map_err(|e| e.to_string())??;
    let _ = tauri_plugin_opener::reveal_item_in_dir(&path);
    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn log_upload_now(app: AppHandle) -> usize {
    relaylog::upload(&app).await
}

#[tauri::command]
pub fn config_load() -> config::ConfigFile {
    config::read()
}

#[tauri::command]
pub fn config_set(
    app: AppHandle,
    changes: Map<String, Value>,
) -> Result<config::ConfigFile, String> {
    let had_changes = !changes.is_empty();
    let res = config::set(Some(&app), changes)?;
    if had_changes {
        crate::voice::refresh_cached_voice_sounds();
        crate::voice_ai::invalidate_hud_badge_cache();
    }
    Ok(res)
}

#[tauri::command]
pub fn config_reveal() -> Result<(), String> {
    let p = config::path().ok_or_else(|| "找不到配置文件夹".to_string())?;
    if p.exists() {
        tauri_plugin_opener::reveal_item_in_dir(&p).map_err(|e| e.to_string())
    } else {
        let dir = p
            .parent()
            .map(|d| d.to_path_buf())
            .ok_or_else(|| "找不到配置文件夹".to_string())?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        tauri_plugin_opener::open_path(dir.display().to_string(), None::<&str>)
            .map_err(|e| e.to_string())
    }
}

/// Opens config.json in the app the system uses for .json files (created first if missing,
/// the same way Settings writes it). With no such app: the default text editor (macOS) or
/// Notepad (Windows).
#[tauri::command]
pub fn config_open(app: AppHandle) -> Result<(), String> {
    let p = config::path().ok_or_else(|| "找不到配置文件夹".to_string())?;
    if !p.exists() {
        config::set(Some(&app), Map::new())?;
    }
    let shown = p.display().to_string();
    let r = tauri_plugin_opener::open_path(&shown, None::<&str>).or_else(|e| {
        #[cfg(target_os = "macos")]
        let fallback = std::process::Command::new("open")
            .arg("-t")
            .arg(&p)
            .status();
        #[cfg(windows)]
        let fallback = std::process::Command::new("notepad.exe")
            .arg(&p)
            .spawn()
            .map(|_| ());
        #[cfg(not(any(target_os = "macos", windows)))]
        let fallback: std::io::Result<()> = Err(std::io::Error::other(e.to_string()));
        match fallback {
            #[cfg(target_os = "macos")]
            Ok(s) if !s.success() => Err(format!("打不开配置文件：{e}")),
            Ok(_) => Ok(()),
            Err(_) => Err(format!("打不开配置文件：{e}")),
        }
    });
    logging::info(
        "config",
        if r.is_ok() {
            "config file opened"
        } else {
            "config file open failed"
        },
        serde_json::json!({ "error": r.as_ref().err() }),
    );
    r
}

/// Also notices a permission granted in System Settings: the voice hotkey retries then.
#[tauri::command]
pub async fn permissions_status(app: AppHandle) -> perms::Status {
    let s = tauri::async_runtime::spawn_blocking(perms::status)
        .await
        .unwrap_or_else(|_| perms::status());
    if perms::note_change(&s) {
        crate::voice::config_changed(&app);
    }
    s
}

#[tauri::command]
pub async fn permission_request(kind: String) -> Result<perms::Status, String> {
    tauri::async_runtime::spawn_blocking(move || perms::request(&kind))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn permission_open_settings(kind: String, register: Option<bool>) -> Result<(), String> {
    perms::open_settings_and_register(&kind, register.unwrap_or(false))
}

#[tauri::command]
pub fn permission_reveal_app_bundle() -> Result<String, String> {
    perms::reveal_app_bundle()
}

#[tauri::command]
pub fn permission_drag_app_bundle(app: AppHandle) -> Result<bool, String> {
    perms::start_app_bundle_drag(&app)
}

#[tauri::command]
pub async fn reset_mac_permission(app: AppHandle, kind: String) -> Result<perms::Status, String> {
    let app_for_task = app.clone();
    let s = tauri::async_runtime::spawn_blocking(move || {
        perms::reset_mac_permission(&app_for_task, &kind)
    })
    .await
    .map_err(|e| e.to_string())??;
    if perms::note_change(&s) {
        crate::voice::config_changed(&app);
    }
    Ok(s)
}

#[tauri::command]
pub fn relaunch_app(app: AppHandle) {
    crate::prepare_relaunch(&app);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(60));
        app.restart();
    });
}

#[tauri::command]
pub async fn resource_usage(app: AppHandle) -> resources::Usage {
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || resources::usage(&a))
        .await
        .unwrap_or_else(|_| resources::usage(&app))
}

/// Empties this app's cache folder and the browser panel's data; returns the bytes freed.
#[tauri::command]
pub async fn clear_caches(app: AppHandle) -> Result<u64, String> {
    let mut freed = 0u64;
    if let Ok(cache) = app.path().app_cache_dir() {
        freed += resources::dir_size(&cache, 50_000);
        if cache.exists() {
            for entry in fs::read_dir(&cache).map_err(|e| e.to_string())?.flatten() {
                let p = entry.path();
                let _ = if p.is_dir() {
                    fs::remove_dir_all(&p)
                } else {
                    fs::remove_file(&p)
                };
            }
        }
    }
    freed += crate::browser::clear_data(&app).await?;
    logging::info(
        "app.cache",
        "caches cleared",
        serde_json::json!({ "bytes": freed }),
    );
    Ok(freed)
}

// ---------------------------------------------------------------------------
// Update checks: the region override and the source race the CLI and daemon share
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEnv {
    /// HERDR_POCKET_MIRROR as the app was started with (decideRegion reads it).
    #[serde(skip_serializing_if = "Option::is_none")]
    mirror: Option<String>,
}

#[tauri::command]
pub fn update_env() -> UpdateEnv {
    UpdateEnv {
        mirror: std::env::var("HERDR_POCKET_MIRROR")
            .ok()
            .filter(|v| !v.trim().is_empty()),
    }
}

/// `sources.json` in the state folder (packages/update/src/paths.ts `stateDir`).
fn source_cache_path() -> Option<std::path::PathBuf> {
    if let Some(dir) = std::env::var_os("HERDR_POCKET_STATE").filter(|v| !v.is_empty()) {
        return Some(std::path::PathBuf::from(dir).join("sources.json"));
    }
    #[cfg(windows)]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .map(|h| std::path::PathBuf::from(h).join("AppData").join("Local"))
            })?;
        Some(base.join("herdr-pocket").join("sources.json"))
    }
    #[cfg(not(windows))]
    {
        let home = std::env::var_os("HOME").filter(|v| !v.is_empty())?;
        Some(
            std::path::PathBuf::from(home)
                .join(".local/state/herdr-pocket")
                .join("sources.json"),
        )
    }
}

/// What `update_fetch_sums` may fetch: the latest or tagged release's SHA256SUMS or RELEASE-NOTES.md
/// on github.com, directly or through a mirror prefix (https, or plain http on this machine).
fn is_sums_url(url: &str) -> bool {
    const LATEST_SUFFIXES: [&str; 3] = [
        "/releases/latest/download/SHA256SUMS",
        "/releases/latest/download/RELEASE-NOTES.md",
        "/releases/latest/download/RELEASE-MANIFEST.json",
    ];
    const TAGGED_MARKER: &str = "/releases/download/v";
    const TAGGED_SUFFIXES: [&str; 3] = [
        "/SHA256SUMS",
        "/RELEASE-NOTES.md",
        "/RELEASE-MANIFEST.json",
    ];
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1"));
    let scheme_ok = u.scheme() == "https" || (u.scheme() == "http" && local);
    let path_ok = LATEST_SUFFIXES.iter().any(|s| url.ends_with(s))
        || (url.contains(TAGGED_MARKER) && TAGGED_SUFFIXES.iter().any(|s| url.ends_with(s)));
    scheme_ok
        && path_ok
        && url.contains("https://github.com/")
        && u.query().is_none()
        && u.fragment().is_none()
}

/// The release listing, fetched natively: github.com's redirect has no CORS headers,
/// so the webview's fetch() can never read it. Uses the system proxy.
#[tauri::command]
pub async fn update_fetch_sums(url: String, timeout_ms: Option<u64>) -> Result<String, String> {
    if !is_sums_url(&url) {
        return Err("not a release listing URL".into());
    }
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(8000).clamp(500, 30_000));
    let res = crate::net::client()
        .get(&url)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("no answer within {} ms", timeout.as_millis())
            } else {
                "connection failed".to_string()
            }
        })?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let body = res
        .bytes()
        .await
        .map_err(|_| "connection failed".to_string())?;
    if body.len() > 256 * 1024 {
        return Err("listing too large".into());
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

#[tauri::command]
pub fn update_source_cache_read() -> Option<Value> {
    let raw = fs::read_to_string(source_cache_path()?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// The race's winner and probes (`SourceCache` in the protocol), for the CLI and daemon too.
#[tauri::command]
pub fn update_source_cache_write(cache: Value) -> Result<(), String> {
    if !cache.is_object() {
        return Err("bad source cache".into());
    }
    let p = source_cache_path().ok_or_else(|| "no state folder".to_string())?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut data = serde_json::to_vec(&cache).map_err(|e| e.to_string())?;
    data.push(b'\n');
    config::write_atomic(&p, &data).map_err(|e| e.to_string())
}

fn expand_initial_folder(raw: Option<String>) -> Option<std::path::PathBuf> {
    let trimmed = raw.as_deref()?.trim();
    if trimmed.is_empty() {
        return crate::home_dir();
    }
    let expanded = if trimmed == "~" {
        crate::home_dir()?
    } else if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        crate::home_dir()?.join(rest)
    } else {
        std::path::PathBuf::from(trimmed)
    };
    if expanded.is_dir() {
        Some(expanded)
    } else {
        expanded
            .parent()
            .filter(|p| p.is_dir())
            .map(|p| p.to_path_buf())
            .or_else(crate::home_dir)
    }
}

fn format_picked_folder(path: &std::path::Path) -> String {
    #[cfg(not(windows))]
    if let Some(home) = crate::home_dir() {
        if path == home {
            return "~".to_string();
        }
        if let Ok(rel) = path.strip_prefix(&home) {
            return format!("~/{}", rel.display());
        }
    }
    path.display().to_string()
}

/// Opens the OS-native folder or file selection dialog cleanly without duplicating platform code.
async fn pick_os_path(
    app: AppHandle,
    initial_dir: Option<String>,
    choose_dirs: bool,
) -> Result<Option<String>, String> {
    let start_dir = expand_initial_folder(initial_dir);

    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let res = (|| -> Result<Option<String>, String> {
                let Some(mtm) = objc2::MainThreadMarker::new() else {
                    return Err("不在主线程上，无法打开选择器".into());
                };
                use objc2_app_kit::NSOpenPanel;
                use objc2_foundation::{NSString, NSURL};

                let panel = NSOpenPanel::openPanel(mtm);
                panel.setCanChooseDirectories(choose_dirs);
                panel.setCanChooseFiles(!choose_dirs);
                panel.setCanCreateDirectories(choose_dirs);
                if let Some(dir) = &start_dir {
                    let s = NSString::from_str(&dir.to_string_lossy());
                    let url = NSURL::fileURLWithPath(&s);
                    panel.setDirectoryURL(Some(&url));
                }
                let resp = panel.runModal();
                if resp != 1 {
                    return Ok(None);
                }
                let picked = panel.URL().and_then(|u| u.path()).map(|ns| {
                    let s = ns.to_string();
                    if choose_dirs {
                        format_picked_folder(std::path::Path::new(&s))
                    } else {
                        s
                    }
                });
                Ok(picked)
            })();
            let _ = tx.send(res);
        })
        .map_err(|e| format!("无法弹出选择框：{e}"))?;

        return tauri::async_runtime::spawn_blocking(move || {
            rx.recv().map_err(|_| "选择框已关闭".to_string())?
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    #[cfg(windows)]
    {
        let _ = app;
        return tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
            use std::ffi::c_void;
            use std::os::windows::ffi::OsStrExt;
            use std::ptr::{null, null_mut};
            use windows_sys::core::{GUID, HRESULT, PCWSTR, PWSTR};
            use windows_sys::Win32::System::Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
            };
            use windows_sys::Win32::UI::Shell::{
                FileOpenDialog, SHCreateItemFromParsingName, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS,
                SIGDN_FILESYSPATH,
            };

            const IID_IFILEOPENDIALOG: GUID = GUID::from_u128(0xd57c7288_d4ad_4768_be02_9d969532d960);
            const IID_ISHELLITEM: GUID = GUID::from_u128(0x43826d1e_e718_42ee_bc55_a1e261c37bfe);
            const HRESULT_CANCELLED: HRESULT = 0x800704C7u32 as i32;

            unsafe {
                let hr_init = CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32);
                let uninit = hr_init >= 0;
                struct Uninit(bool);
                impl Drop for Uninit {
                    fn drop(&mut self) {
                        if self.0 {
                            unsafe { CoUninitialize() };
                        }
                    }
                }
                let _guard = Uninit(uninit);

                let mut dlg: *mut c_void = null_mut();
                let hr = CoCreateInstance(
                    &FileOpenDialog,
                    null_mut(),
                    CLSCTX_INPROC_SERVER,
                    &IID_IFILEOPENDIALOG,
                    &mut dlg,
                );
                if hr < 0 || dlg.is_null() {
                    return Err(format!("打不开选择框 (0x{hr:08x})"));
                }
                let vtbl = *(dlg as *const *const *const c_void);
                let release: unsafe extern "system" fn(*mut c_void) -> u32 =
                    std::mem::transmute(*vtbl.add(2));
                let show: unsafe extern "system" fn(*mut c_void, *mut c_void) -> HRESULT =
                    std::mem::transmute(*vtbl.add(3));
                let set_options: unsafe extern "system" fn(*mut c_void, u32) -> HRESULT =
                    std::mem::transmute(*vtbl.add(9));
                let get_options: unsafe extern "system" fn(*mut c_void, *mut u32) -> HRESULT =
                    std::mem::transmute(*vtbl.add(10));
                let set_folder: unsafe extern "system" fn(*mut c_void, *mut c_void) -> HRESULT =
                    std::mem::transmute(*vtbl.add(12));
                let get_result: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> HRESULT =
                    std::mem::transmute(*vtbl.add(20));

                let mut opts: u32 = 0;
                if get_options(dlg, &mut opts) >= 0 {
                    let flags = if choose_dirs {
                        opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
                    } else {
                        (opts & !FOS_PICKFOLDERS) | FOS_FORCEFILESYSTEM
                    };
                    let _ = set_options(dlg, flags);
                }

                if let Some(dir) = start_dir {
                    let wide: Vec<u16> = dir
                        .as_os_str()
                        .encode_wide()
                        .chain(std::iter::once(0))
                        .collect();
                    let mut folder_item: *mut c_void = null_mut();
                    if SHCreateItemFromParsingName(
                        wide.as_ptr(),
                        null_mut(),
                        &IID_ISHELLITEM,
                        &mut folder_item,
                    ) >= 0
                        && !folder_item.is_null()
                    {
                        let _ = set_folder(dlg, folder_item);
                        let ivtbl = *(folder_item as *const *const *const c_void);
                        let irel: unsafe extern "system" fn(*mut c_void) -> u32 =
                            std::mem::transmute(*ivtbl.add(2));
                        irel(folder_item);
                    }
                }

                let hr_show = show(dlg, null_mut());
                if hr_show == HRESULT_CANCELLED || hr_show < 0 {
                    release(dlg);
                    return Ok(None);
                }

                let mut item: *mut c_void = null_mut();
                let hr_res = get_result(dlg, &mut item);
                release(dlg);
                if hr_res < 0 || item.is_null() {
                    return Ok(None);
                }

                let ivtbl = *(item as *const *const *const c_void);
                let irel: unsafe extern "system" fn(*mut c_void) -> u32 =
                    std::mem::transmute(*ivtbl.add(2));
                let get_display_name: unsafe extern "system" fn(
                    *mut c_void,
                    i32,
                    *mut PWSTR,
                ) -> HRESULT = std::mem::transmute(*ivtbl.add(5));
                let mut psz: PWSTR = null_mut();
                let hr_name = get_display_name(item, SIGDN_FILESYSPATH, &mut psz);
                irel(item);
                if hr_name < 0 || psz.is_null() {
                    return Ok(None);
                }
                let mut len = 0usize;
                while *psz.add(len) != 0 {
                    len += 1;
                }
                let picked = String::from_utf16_lossy(std::slice::from_raw_parts(psz, len));
                CoTaskMemFree(psz as *const c_void);
                let _ = PCWSTR::default();
                Ok(Some(if choose_dirs {
                    format_picked_folder(std::path::Path::new(&picked))
                } else {
                    picked
                }))
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        let _ = app;
        return tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
            let start = start_dir
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "/".to_string());
            let mut z_args = vec!["--file-selection"];
            if choose_dirs {
                z_args.push("--directory");
            }
            let filename_arg = format!("{}/", start.trim_end_matches('/'));
            z_args.extend(["--filename", &filename_arg]);
            if let Ok(out) = std::process::Command::new("zenity").args(&z_args).output() {
                if out.status.success() {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !s.is_empty() {
                        return Ok(Some(if choose_dirs {
                            format_picked_folder(std::path::Path::new(&s))
                        } else {
                            s
                        }));
                    }
                }
                return Ok(None);
            }
            let k_flag = if choose_dirs { "--getexistingdirectory" } else { "--getopenfilename" };
            if let Ok(out) = std::process::Command::new("kdialog").args([k_flag, &start]).output() {
                if out.status.success() {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !s.is_empty() {
                        return Ok(Some(if choose_dirs {
                            format_picked_folder(std::path::Path::new(&s))
                        } else {
                            s
                        }));
                    }
                }
                return Ok(None);
            }
            Err("当前 Linux 环境未安装 zenity / kdialog".into())
        })
        .await
        .map_err(|e| e.to_string())?;
    }
}

/// Opens the OS-native folder selection dialog (Finder sheet on macOS, Explorer on Windows).
#[tauri::command]
pub async fn pick_folder(
    app: AppHandle,
    initial_dir: Option<String>,
) -> Result<Option<String>, String> {
    pick_os_path(app, initial_dir, true).await
}

/// Opens the OS-native file selection dialog for previewing files in tabs or the built-in browser.
#[tauri::command]
pub async fn pick_file(
    app: AppHandle,
    initial_dir: Option<String>,
) -> Result<Option<String>, String> {
    pick_os_path(app, initial_dir, false).await
}

const MAX_LOCAL_IMAGE_READ_BYTES: u64 = 128 * 1024 * 1024;
const MAX_LOCAL_MEDIA_READ_BYTES: u64 = 128 * 1024 * 1024;
const MAX_LOCAL_OFFICE_READ_BYTES: u64 = 32 * 1024 * 1024;
const DEFAULT_LOCAL_READ_BYTES: usize = 512 * 1024;
const MAX_LOCAL_READ_BYTES: usize = 2 * 1024 * 1024;
const SNIFF_LOCAL_BYTES: usize = 8192;

pub(crate) struct ResolvedLocalFile {
    pub canon: std::path::PathBuf,
    pub display_path: String,
    pub size: u64,
    pub mtime: i64,
    pub ext: String,
    pub language: Option<String>,
}

fn is_ignored_workspace_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".hg"
            | ".svn"
            | "node_modules"
            | ".pnpm-store"
            | "bower_components"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".mypy_cache"
            | ".pytest_cache"
            | ".ruff_cache"
            | ".tox"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | ".nuxt"
            | ".svelte-kit"
            | ".turbo"
            | ".parcel-cache"
            | ".cache"
            | "coverage"
            | "out"
            | ".output"
            | "vendor"
            | "Pods"
            | ".gradle"
            | ".idea"
            | "DerivedData"
    )
}

fn find_workspace_file_by_suffix(
    real_cwd: &std::path::Path,
    raw_suffix: &str,
    cfg_dir: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    use std::collections::VecDeque;

    if raw_suffix.is_empty() || raw_suffix.contains('\0') {
        return None;
    }
    let normalized = raw_suffix.replace('\\', "/");
    let parts: Vec<&str> = normalized
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    if parts.is_empty() || parts.iter().any(|s| *s == ".." || is_private_local_component(s)) {
        return None;
    }
    let clean_suffix = parts.join("/");
    let lower_suffix = clean_suffix.to_ascii_lowercase();
    let allow_hidden_dirs = parts[0].starts_with('.');
    let real_cfg = cfg_dir.map(|d| fs::canonicalize(d).unwrap_or_else(|_| d.to_path_buf()));

    let mut exact_best: Option<(usize, String, std::path::PathBuf)> = None;
    let mut ci_best: Option<(usize, String, std::path::PathBuf)> = None;
    let mut queue: VecDeque<(std::path::PathBuf, usize)> = VecDeque::new();
    queue.push_back((real_cwd.to_path_buf(), 0));

    let max_depth = 8usize;
    let mut visited = 0usize;
    let max_entries = 12_000usize;

    while let Some((dir, depth)) = queue.pop_front() {
        if visited >= max_entries {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > max_entries {
                break;
            }
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();
            if is_private_local_component(&name) {
                continue;
            }
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            let full = entry.path();
            if ft.is_dir() {
                if depth + 1 >= max_depth {
                    continue;
                }
                if is_ignored_workspace_dir(&name) {
                    continue;
                }
                if !allow_hidden_dirs && name.starts_with('.') {
                    continue;
                }
                queue.push_back((full, depth + 1));
                continue;
            }
            if !ft.is_file() {
                continue;
            }
            let Ok(rel) = full.strip_prefix(real_cwd) else {
                continue;
            };
            let rel_str = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            let rel_lower = rel_str.to_ascii_lowercase();
            let is_exact = rel_str == clean_suffix
                || (rel_str.len() > clean_suffix.len()
                    && rel_str.ends_with(&clean_suffix)
                    && rel_str.as_bytes()[rel_str.len() - clean_suffix.len() - 1] == b'/');
            let is_ci = is_exact
                || (rel_lower == lower_suffix
                    || (rel_lower.len() > lower_suffix.len()
                        && rel_lower.ends_with(&lower_suffix)
                        && rel_lower.as_bytes()[rel_lower.len() - lower_suffix.len() - 1] == b'/'));
            if !is_exact && !is_ci {
                continue;
            }
            let Ok(canon) = fs::canonicalize(&full) else {
                continue;
            };
            if !canon.starts_with(real_cwd) {
                continue;
            }
            if let Some(ref cfg) = real_cfg {
                if canon.starts_with(cfg) {
                    continue;
                }
            }
            let comp_depth = rel_str.matches('/').count();
            if is_exact {
                let better = match &exact_best {
                    None => true,
                    Some((bd, br, _)) => comp_depth < *bd || (comp_depth == *bd && &rel_str < br),
                };
                if better {
                    exact_best = Some((comp_depth, rel_str, canon));
                }
            } else {
                let better = match &ci_best {
                    None => true,
                    Some((bd, br, _)) => comp_depth < *bd || (comp_depth == *bd && &rel_str < br),
                };
                if better {
                    ci_best = Some((comp_depth, rel_str, canon));
                }
            }
        }
    }

    exact_best.or(ci_best).map(|(_, _, p)| p)
}

fn resolve_safe_local_target_inner(
    cwd: Option<&str>,
    path: &str,
    cfg_dir: Option<&std::path::Path>,
) -> Result<(std::path::PathBuf, Option<std::path::PathBuf>, fs::Metadata), String> {
    let raw_target = expand_home_path(path)?;
    let cwd_expanded = cwd
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(expand_home_path)
        .transpose()?;

    let candidate = if raw_target.is_absolute() {
        raw_target.clone()
    } else if let Some(ref base) = cwd_expanded {
        base.join(&raw_target)
    } else if let Some(home) = crate::home_dir() {
        home.join(&raw_target)
    } else {
        raw_target.clone()
    };

    let canon = match fs::canonicalize(&candidate) {
        Ok(c) => c,
        Err(_) => {
            if let Some(ref base_dir) = cwd_expanded {
                let real_cwd = fs::canonicalize(base_dir)
                    .map_err(|_| "没有这个文件或目录".to_string())?;
                let suffix = if !raw_target.is_absolute() {
                    raw_target.to_string_lossy().into_owned()
                } else if let Ok(rel) = raw_target.strip_prefix(base_dir) {
                    rel.to_string_lossy().into_owned()
                } else if let Ok(rel) = raw_target.strip_prefix(&real_cwd) {
                    rel.to_string_lossy().into_owned()
                } else {
                    return Err("没有这个文件或目录".to_string());
                };
                find_workspace_file_by_suffix(&real_cwd, &suffix, cfg_dir)
                    .ok_or_else(|| "没有这个文件或目录".to_string())?
            } else {
                return Err("没有这个文件或目录".to_string());
            }
        }
    };
    for comp in canon.components() {
        if let std::path::Component::Normal(s) = comp {
            if is_private_local_component(&s.to_string_lossy()) {
                return Err("这个文件可能存有密钥，不在这里显示".into());
            }
        }
    }
    if let Some(cfg_dir) = cfg_dir {
        let real_cfg = fs::canonicalize(cfg_dir).unwrap_or_else(|_| cfg_dir.to_path_buf());
        if canon.starts_with(&real_cfg) {
            return Err("这是 herdr-pocket 自己的设置目录，不在这里显示".into());
        }
    }

    let meta = fs::metadata(&canon).map_err(|e| format!("无法读取文件信息：{e}"))?;
    Ok((canon, cwd_expanded, meta))
}

fn resolve_safe_local_reveal_target_with_cfg_dir(
    cwd: Option<&str>,
    path: &str,
    cfg_dir: Option<&std::path::Path>,
) -> Result<std::path::PathBuf, String> {
    let (canon, _, meta) = resolve_safe_local_target_inner(cwd, path, cfg_dir)?;
    if !meta.is_file() && !meta.is_dir() {
        return Err("这不是普通文件或目录".into());
    }
    Ok(canon)
}

pub(crate) fn resolve_safe_local_reveal_target(
    cwd: Option<&str>,
    path: &str,
) -> Result<std::path::PathBuf, String> {
    let cfg_dir = crate::hostd_config_dir();
    resolve_safe_local_reveal_target_with_cfg_dir(cwd, path, cfg_dir.as_deref())
}

pub(crate) fn resolve_safe_local_file(
    cwd: Option<&str>,
    path: &str,
) -> Result<ResolvedLocalFile, String> {
    let cfg_dir = crate::hostd_config_dir();
    let (canon, cwd_expanded, meta) =
        resolve_safe_local_target_inner(cwd, path, cfg_dir.as_deref())?;
    if meta.is_dir() {
        return Err("这是一个目录，无法当文件打开".into());
    }
    if !meta.is_file() {
        return Err("这不是普通文件".into());
    }

    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let name = canon
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = canon
        .extension()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let language = local_language(&name, &ext).map(ToString::to_string);

    let display_path = cwd_expanded
        .as_deref()
        .and_then(|base| fs::canonicalize(base).ok())
        .and_then(|real_cwd| {
            canon.strip_prefix(&real_cwd).ok().map(|rel| {
                rel.components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/")
            })
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| canon.to_string_lossy().into_owned());

    Ok(ResolvedLocalFile {
        canon,
        display_path,
        size,
        mtime,
        ext,
        language,
    })
}

pub(crate) fn local_stream_mime(ext: &str) -> &'static str {
    if ext == "svg" {
        return "image/svg+xml";
    }
    if let Some(m) = local_image_mime(ext) {
        return m;
    }
    if let Some((m, _)) = local_media_mime(ext) {
        return m;
    }
    if let Some((m, _)) = local_office_mime(ext) {
        return m;
    }
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "csv" => "text/csv; charset=utf-8",
        "tsv" => "text/tab-separated-values; charset=utf-8",
        "psv" | "txt" | "log" | "md" | "markdown" | "mdx" | "ts" | "tsx" | "jsx" | "rs" | "py" | "toml" | "yaml" | "yml" | "sh" => "text/plain; charset=utf-8",
        "json" | "jsonl" | "ndjson" | "map" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

struct CapPreviewRegistry {
    order: VecDeque<String>,
    entries: HashMap<String, (PathBuf, PathBuf)>,
}

static CAP_PREVIEWS: OnceLock<Mutex<CapPreviewRegistry>> = OnceLock::new();
static CAP_SEQ: AtomicU64 = AtomicU64::new(1);

fn cap_registry() -> &'static Mutex<CapPreviewRegistry> {
    CAP_PREVIEWS.get_or_init(|| {
        Mutex::new(CapPreviewRegistry {
            order: VecDeque::new(),
            entries: HashMap::new(),
        })
    })
}

fn next_cap_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let seq = CAP_SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let r1 = RandomState::new().build_hasher().finish();
    let r2 = RandomState::new().build_hasher().finish();
    let mut hasher = Sha256::new();
    hasher.update(seq.to_le_bytes());
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(r1.to_le_bytes());
    hasher.update(r2.to_le_bytes());
    let digest = hasher.finalize();
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

fn encode_uri_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for b in seg.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn decode_uri_segment(seg: &str) -> Result<String, u16> {
    let bytes = seg.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(400);
            }
            let hi = (bytes[i + 1] as char).to_digit(16).ok_or(400u16)?;
            let lo = (bytes[i + 2] as char).to_digit(16).ok_or(400u16)?;
            out.push(((hi << 4) | lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| 400)
}

fn build_resolved_local_file(canon: PathBuf) -> Result<ResolvedLocalFile, u16> {
    let meta = fs::metadata(&canon).map_err(|_| 404u16)?;
    if !meta.is_file() {
        return Err(404);
    }
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let name = canon
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = canon
        .extension()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let language = local_language(&name, &ext).map(ToString::to_string);
    let display_path = canon.to_string_lossy().into_owned();
    Ok(ResolvedLocalFile {
        canon,
        display_path,
        size,
        mtime,
        ext,
        language,
    })
}

pub(crate) fn resolve_cap_preview_file(token: &str, rel_path: &str) -> Result<ResolvedLocalFile, u16> {
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(404);
    }
    let (root_dir, default_file) = {
        let guard = cap_registry().lock().map_err(|_| 500u16)?;
        guard.entries.get(token).cloned().ok_or(404u16)?
    };
    let trimmed = rel_path.trim_matches('/');
    let target = if trimmed.is_empty() {
        default_file
    } else {
        let mut joined = root_dir.clone();
        for seg in trimmed.split('/') {
            if seg.is_empty() {
                continue;
            }
            let decoded = decode_uri_segment(seg)?;
            if decoded.contains('\0') || decoded.contains('\\') || decoded.contains('/') {
                return Err(403);
            }
            if decoded == "." || decoded == ".." {
                return Err(403);
            }
            if is_private_local_component(&decoded) {
                return Err(403);
            }
            joined.push(decoded);
        }
        joined
    };
    let canon = fs::canonicalize(&target).map_err(|_| 404u16)?;
    if !canon.starts_with(&root_dir) {
        return Err(403);
    }
    for comp in canon.components() {
        if let Component::Normal(part) = comp {
            if is_private_local_component(&part.to_string_lossy()) {
                return Err(403);
            }
        }
    }
    if let Some(cfg_dir) = crate::hostd_config_dir() {
        if let Ok(cfg_canon) = fs::canonicalize(&cfg_dir) {
            if canon.starts_with(&cfg_canon) {
                return Err(403);
            }
        }
    }
    let _ = Path::new(&canon);
    build_resolved_local_file(canon)
}

pub(crate) fn issue_local_preview_url(cwd: Option<&str>, path: &str) -> Result<String, String> {
    let resolved = resolve_safe_local_file(cwd, path)?;
    let parent = resolved
        .canon
        .parent()
        .ok_or_else(|| "无法定位文件所在目录".to_string())?;
    let root_dir = fs::canonicalize(parent).map_err(|e| format!("无法访问文件目录：{e}"))?;
    let file_name = resolved
        .canon
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "文件名无效".to_string())?;
    let token = {
        let mut guard = cap_registry().lock().map_err(|_| "注册表锁定失败".to_string())?;
        if let Some((existing, _)) = guard
            .entries
            .iter()
            .find(|(_, (r, c))| r == &root_dir && c == &resolved.canon)
        {
            existing.clone()
        } else {
            let tok = next_cap_token();
            if guard.order.len() >= 512 {
                if let Some(old) = guard.order.pop_front() {
                    guard.entries.remove(&old);
                }
            }
            guard.order.push_back(tok.clone());
            guard
                .entries
                .insert(tok.clone(), (root_dir, resolved.canon));
            tok
        }
    };
    let origin = if cfg!(target_os = "windows") {
        "http://pocket-local.localhost"
    } else {
        "pocket-local://localhost"
    };
    Ok(format!("{origin}/cap/{token}/{}", encode_uri_segment(&file_name)))
}

#[tauri::command]
pub fn register_local_preview_token(cwd: Option<String>, path: String) -> Result<String, String> {
    issue_local_preview_url(cwd.as_deref(), &path)
}

const MEM_HTML_CAP_MAX: usize = 32;
const MEM_HTML_MAX_BYTES: usize = 8 * 1024 * 1024;

struct MemHtmlPreviewRegistry {
    order: VecDeque<String>,
    entries: HashMap<String, (String, Vec<u8>)>,
}

static MEM_HTML_PREVIEWS: OnceLock<Mutex<MemHtmlPreviewRegistry>> = OnceLock::new();

fn mem_html_registry() -> &'static Mutex<MemHtmlPreviewRegistry> {
    MEM_HTML_PREVIEWS.get_or_init(|| {
        Mutex::new(MemHtmlPreviewRegistry {
            order: VecDeque::new(),
            entries: HashMap::new(),
        })
    })
}

pub(crate) fn issue_mem_html_preview_url(file_name: &str, html: &str) -> Result<String, String> {
    let raw_bytes = html.as_bytes();
    if raw_bytes.len() > MEM_HTML_MAX_BYTES {
        return Err("HTML 预览内容超过 8 MB 上限".into());
    }
    let trimmed = file_name.trim().replace('\\', "/");
    let base_name = Path::new(&trimmed)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty() && s != "." && s != ".." && !s.contains('\0'))
        .unwrap_or_else(|| "preview.html".to_string());
    let bytes = raw_bytes.to_vec();
    let token = {
        let mut guard = mem_html_registry()
            .lock()
            .map_err(|_| "内存预览注册表锁定失败".to_string())?;
        if let Some((existing, _)) = guard
            .entries
            .iter()
            .find(|(_, (n, b))| n == &base_name && b == &bytes)
        {
            existing.clone()
        } else {
            let tok = format!("mem-{}", next_cap_token());
            if guard.order.len() >= MEM_HTML_CAP_MAX {
                if let Some(old) = guard.order.pop_front() {
                    guard.entries.remove(&old);
                }
            }
            guard.order.push_back(tok.clone());
            guard.entries.insert(tok.clone(), (base_name.clone(), bytes));
            tok
        }
    };
    let origin = if cfg!(target_os = "windows") {
        "http://pocket-local.localhost"
    } else {
        "pocket-local://localhost"
    };
    Ok(format!("{origin}/cap/{token}/{}", encode_uri_segment(&base_name)))
}

pub(crate) fn get_mem_html_preview(token: &str, rel_path: &str) -> Option<Vec<u8>> {
    let hex = token.strip_prefix("mem-")?;
    if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let guard = mem_html_registry().lock().ok()?;
    let (stored_name, bytes) = guard.entries.get(token)?;
    let trimmed = rel_path.trim_matches('/');
    if !trimmed.is_empty() {
        let decoded = decode_uri_segment(trimmed).ok()?;
        if &decoded != stored_name {
            return None;
        }
    }
    Some(bytes.clone())
}

#[tauri::command]
pub fn register_mem_html_preview(file_name: String, html: String) -> Result<String, String> {
    issue_mem_html_preview_url(&file_name, &html)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileSlice {
    pub path: String,
    pub size: u64,
    pub mtime: i64,
    pub binary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub truncated: bool,
    pub offset: u64,
    pub bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

fn is_private_local_component(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        ".ssh"
            | ".gnupg"
            | ".aws"
            | ".azure"
            | ".kube"
            | ".docker"
            | ".password-store"
            | ".netrc"
            | ".pgpass"
            | ".git-credentials"
            | ".npmrc"
            | ".pypirc"
            | "keychains"
            | "id_rsa"
            | "id_rsa.pub"
            | "id_dsa"
            | "id_dsa.pub"
            | "id_ecdsa"
            | "id_ecdsa.pub"
            | "id_ed25519"
            | "id_ed25519.pub"
    ) {
        return true;
    }
    if lower == ".env"
        || (lower.starts_with(".env.")
            && !matches!(
                lower.as_str(),
                ".env.example" | ".env.sample" | ".env.template" | ".env.dist"
            ))
    {
        return true;
    }
    matches!(
        std::path::Path::new(&lower)
            .extension()
            .and_then(|s| s.to_str()),
        Some("pem" | "key" | "p12" | "pfx" | "keystore" | "jks" | "kdbx")
    )
}

fn expand_home_path(raw: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = raw.trim().strip_prefix("file://").unwrap_or(raw.trim());
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("路径不对".into());
    }
    if trimmed == "~" {
        return crate::home_dir().ok_or_else(|| "无法确定主目录".into());
    }
    if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| {
        if cfg!(windows) {
            trimmed.strip_prefix("~\\")
        } else {
            None
        }
    }) {
        let home = crate::home_dir().ok_or_else(|| "无法确定主目录".to_string())?;
        return Ok(home.join(rest));
    }
    Ok(std::path::PathBuf::from(trimmed))
}

fn local_image_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

fn local_media_mime(ext: &str) -> Option<(&'static str, &'static str)> {
    match ext {
        "pdf" => Some(("application/pdf", "pdf")),
        "mp3" => Some(("audio/mpeg", "audio")),
        "wav" => Some(("audio/wav", "audio")),
        "ogg" => Some(("audio/ogg", "audio")),
        "flac" => Some(("audio/flac", "audio")),
        "m4a" => Some(("audio/mp4", "audio")),
        "aac" => Some(("audio/aac", "audio")),
        "opus" => Some(("audio/opus", "audio")),
        "weba" => Some(("audio/webm", "audio")),
        "aiff" | "aif" => Some(("audio/aiff", "audio")),
        "caf" => Some(("audio/x-caf", "audio")),
        "mp4" => Some(("video/mp4", "video")),
        "webm" => Some(("video/webm", "video")),
        "mov" => Some(("video/quicktime", "video")),
        "m4v" => Some(("video/x-m4v", "video")),
        "mkv" => Some(("video/x-matroska", "video")),
        "avi" => Some(("video/x-msvideo", "video")),
        "ogv" => Some(("video/ogg", "video")),
        "mpg" | "mpeg" => Some(("video/mpeg", "video")),
        _ => None,
    }
}

fn local_office_mime(ext: &str) -> Option<(&'static str, &'static str)> {
    match ext {
        "docx" => Some((
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "document",
        )),
        "doc" => Some(("application/msword", "document")),
        "rtf" => Some(("application/rtf", "document")),
        "odt" => Some(("application/vnd.oasis.opendocument.text", "document")),
        "xlsx" => Some((
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "spreadsheet",
        )),
        "xls" => Some(("application/vnd.ms-excel", "spreadsheet")),
        "ods" => Some((
            "application/vnd.oasis.opendocument.spreadsheet",
            "spreadsheet",
        )),
        "pptx" => Some((
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "presentation",
        )),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn convert_doc_with_textutil(path: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/textutil")
        .args(["-convert", "html", "-stdout"])
        .arg(path)
        .output()
        .ok()?;
    if !out.status.success() || out.stdout.is_empty() {
        return None;
    }
    let html = String::from_utf8_lossy(&out.stdout).into_owned();
    (!html.trim().is_empty()).then_some(html)
}

#[cfg(not(target_os = "macos"))]
fn convert_doc_with_textutil(_path: &std::path::Path) -> Option<String> {
    None
}

fn local_language(name: &str, ext: &str) -> Option<&'static str> {
    match ext {
        "ts" | "mts" | "cts" | "ets" => Some("ts"),
        "tsx" => Some("tsx"),
        "js" | "mjs" | "cjs" => Some("js"),
        "jsx" => Some("jsx"),
        "py" => Some("py"),
        "rs" => Some("rs"),
        "go" => Some("go"),
        "java" => Some("java"),
        "kt" | "kts" => Some("kt"),
        "swift" => Some("swift"),
        "c" | "h" => Some("c"),
        "cc" | "cpp" | "cxx" | "hpp" => Some("cpp"),
        "cs" => Some("cs"),
        "rb" => Some("rb"),
        "php" => Some("php"),
        "lua" => Some("lua"),
        "sh" | "bash" | "zsh" | "fish" => Some("sh"),
        "ps1" => Some("ps1"),
        "bat" | "cmd" => Some("bat"),
        "md" | "markdown" => Some("md"),
        "json" | "jsonc" | "json5" | "jsonl" | "ndjson" => Some("json"),
        "csv" | "tsv" | "psv" => Some("csv"),
        "yaml" | "yml" => Some("yaml"),
        "toml" => Some("toml"),
        "ini" => Some("ini"),
        "xml" | "svg" => Some("xml"),
        "html" | "htm" => Some("html"),
        "css" => Some("css"),
        "scss" => Some("scss"),
        "less" => Some("less"),
        "sql" => Some("sql"),
        "vue" => Some("vue"),
        "svelte" => Some("svelte"),
        "dart" => Some("dart"),
        "gradle" => Some("gradle"),
        "txt" | "log" => Some("text"),
        _ => match name.to_ascii_lowercase().as_str() {
            "dockerfile" => Some("dockerfile"),
            "makefile" => Some("makefile"),
            "cmakelists.txt" => Some("cmake"),
            _ => None,
        },
    }
}

fn looks_binary_local(head: &[u8]) -> bool {
    if head.contains(&0) {
        return true;
    }
    match std::str::from_utf8(head) {
        Ok(_) => false,
        Err(e) => {
            // Trailing partial multi-byte UTF-8 sequence at sniff boundary is still valid UTF-8.
            e.error_len().is_some()
        }
    }
}

fn utf8_prefix_len(buf: &[u8]) -> usize {
    match std::str::from_utf8(buf) {
        Ok(_) => buf.len(),
        Err(e) => e.valid_up_to(),
    }
}

pub(crate) fn read_local_file_sync(
    cwd: Option<&str>,
    path: &str,
    max_bytes: Option<usize>,
) -> Result<LocalFileSlice, String> {
    use std::io::Read;

    let resolved = resolve_safe_local_file(cwd, path)?;
    let canon = resolved.canon;
    let display_path = resolved.display_path;
    let size = resolved.size;
    let mtime = resolved.mtime;
    let ext = resolved.ext;
    let language = resolved.language;

    if let Some(mime) = local_image_mime(&ext) {
        if size > MAX_LOCAL_IMAGE_READ_BYTES {
            return Ok(LocalFileSlice {
                path: display_path,
                size,
                mtime,
                binary: true,
                kind: Some("image".into()),
                truncated: true,
                offset: 0,
                bytes: 0,
                text: None,
                base64: None,
                mime: Some(mime.into()),
                preview_html: None,
                language,
            });
        }
        let bytes = fs::read(&canon).map_err(|e| format!("读取图片失败：{e}"))?;
        let len = bytes.len();
        return Ok(LocalFileSlice {
            path: display_path,
            size,
            mtime,
            binary: true,
            kind: Some("image".into()),
            truncated: false,
            offset: 0,
            bytes: len,
            text: None,
            base64: Some(crate::local_term::base64_encode(&bytes)),
            mime: Some(mime.into()),
            preview_html: None,
            language,
        });
    }

    if let Some((mime, kind)) = local_media_mime(&ext) {
        if size > MAX_LOCAL_MEDIA_READ_BYTES {
            return Ok(LocalFileSlice {
                path: display_path,
                size,
                mtime,
                binary: true,
                kind: Some(kind.into()),
                truncated: true,
                offset: 0,
                bytes: 0,
                text: None,
                base64: None,
                mime: Some(mime.into()),
                preview_html: None,
                language,
            });
        }
        let bytes = fs::read(&canon).map_err(|e| format!("读取媒体文件失败：{e}"))?;
        let len = bytes.len();
        return Ok(LocalFileSlice {
            path: display_path,
            size,
            mtime,
            binary: true,
            kind: Some(kind.into()),
            truncated: false,
            offset: 0,
            bytes: len,
            text: None,
            base64: Some(crate::local_term::base64_encode(&bytes)),
            mime: Some(mime.into()),
            preview_html: None,
            language,
        });
    }

    if let Some((mime, kind)) = local_office_mime(&ext) {
        if size > MAX_LOCAL_OFFICE_READ_BYTES {
            return Ok(LocalFileSlice {
                path: display_path,
                size,
                mtime,
                binary: true,
                kind: Some(kind.into()),
                truncated: true,
                offset: 0,
                bytes: 0,
                text: None,
                base64: None,
                mime: Some(mime.into()),
                preview_html: None,
                language,
            });
        }
        let bytes = fs::read(&canon).map_err(|e| format!("读取文档失败：{e}"))?;
        let len = bytes.len();
        let sniff_len = len.min(SNIFF_LOCAL_BYTES);
        let text = if ext == "rtf" && !looks_binary_local(&bytes[..sniff_len]) {
            let cap = len.min(MAX_LOCAL_READ_BYTES);
            let valid = utf8_prefix_len(&bytes[..cap]);
            Some(String::from_utf8_lossy(&bytes[..valid]).into_owned())
        } else {
            None
        };
        let preview_html = if matches!(ext.as_str(), "doc" | "rtf" | "odt") {
            convert_doc_with_textutil(&canon)
        } else {
            None
        };
        return Ok(LocalFileSlice {
            path: display_path,
            size,
            mtime,
            binary: ext != "rtf" || text.is_none(),
            kind: Some(kind.into()),
            truncated: false,
            offset: 0,
            bytes: len,
            text,
            base64: Some(crate::local_term::base64_encode(&bytes)),
            mime: Some(mime.into()),
            preview_html,
            language,
        });
    }

    let mut file = fs::File::open(&canon).map_err(|e| format!("打不开文件：{e}"))?;
    let want_sniff = (size as usize).min(SNIFF_LOCAL_BYTES);
    let mut sniff_buf = vec![0u8; want_sniff];
    if want_sniff > 0 {
        let mut read_total = 0;
        while read_total < want_sniff {
            let n = file
                .read(&mut sniff_buf[read_total..])
                .map_err(|e| format!("读取文件失败：{e}"))?;
            if n == 0 {
                break;
            }
            read_total += n;
        }
        sniff_buf.truncate(read_total);
        if looks_binary_local(&sniff_buf) {
            return Ok(LocalFileSlice {
                path: display_path,
                size,
                mtime,
                binary: true,
                kind: Some("binary".into()),
                truncated: false,
                offset: 0,
                bytes: 0,
                text: None,
                base64: None,
                mime: None,
                preview_html: None,
                language,
            });
        }
    }

    let limit = max_bytes
        .unwrap_or(DEFAULT_LOCAL_READ_BYTES)
        .clamp(4, MAX_LOCAL_READ_BYTES);
    let want = ((size as usize).min(limit.saturating_add(4))).max(sniff_buf.len());
    let mut buf = Vec::with_capacity(want);
    buf.extend_from_slice(&sniff_buf);
    while buf.len() < want {
        let prev = buf.len();
        let remaining = want - prev;
        buf.resize(prev + remaining.min(64 * 1024), 0);
        let n = file
            .read(&mut buf[prev..])
            .map_err(|e| format!("读取文件失败：{e}"))?;
        buf.truncate(prev + n);
        if n == 0 {
            break;
        }
    }

    let capped = buf.len().min(limit);
    let valid_len = if (buf.len() as u64) < size || capped < buf.len() {
        utf8_prefix_len(&buf[..capped])
    } else {
        capped
    };
    let text = String::from_utf8_lossy(&buf[..valid_len]).into_owned();
    let truncated = (valid_len as u64) < size;

    Ok(LocalFileSlice {
        path: display_path,
        size,
        mtime,
        binary: false,
        kind: Some("text".into()),
        truncated,
        offset: 0,
        bytes: valid_len,
        text: Some(text),
        base64: None,
        mime: None,
        preview_html: None,
        language,
    })
}

#[tauri::command]
pub async fn local_read_file(
    cwd: Option<String>,
    path: String,
    max_bytes: Option<usize>,
) -> Result<LocalFileSlice, String> {
    tauri::async_runtime::spawn_blocking(move || read_local_file_sync(cwd.as_deref(), &path, max_bytes))
        .await
        .map_err(|e| e.to_string())?
}

fn opener_path_string(path: &std::path::Path) -> String {
    let raw = path.display().to_string();
    #[cfg(windows)]
    {
        if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    raw
}

#[tauri::command]
pub async fn local_reveal_in_folder(cwd: Option<String>, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let canon = resolve_safe_local_reveal_target(cwd.as_deref(), &path)?;
        if canon.is_dir() {
            return tauri_plugin_opener::open_path(opener_path_string(&canon), None::<&str>)
                .map_err(|e| format!("无法打开所在目录：{e}"));
        }
        if let Err(reveal_err) = tauri_plugin_opener::reveal_item_in_dir(&canon) {
            if let Some(parent) = canon.parent() {
                return tauri_plugin_opener::open_path(opener_path_string(parent), None::<&str>)
                    .map_err(|open_err| format!("无法打开所在目录：{open_err}"));
            }
            return Err(format!("无法在目录中显示文件：{reveal_err}"));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("无法打开所在目录：{e}"))?
}

#[tauri::command]
pub async fn local_open_file(cwd: Option<String>, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let canon = resolve_safe_local_reveal_target(cwd.as_deref(), &path)?;
        tauri_plugin_opener::open_path(opener_path_string(&canon), None::<&str>)
            .map_err(|e| format!("无法用系统默认应用打开：{e}"))
    })
    .await
    .map_err(|e| format!("无法用系统默认应用打开：{e}"))?
}

#[tauri::command]
pub async fn local_agent_btw(
    req: crate::local_btw::LocalBtwRequest,
) -> Result<crate::local_btw::LocalBtwResponse, String> {
    crate::local_btw::run_local_agent_btw(req).await
}

#[tauri::command]
pub fn voice_ai_state() -> crate::voice_ai::VoiceAiState {
    crate::voice_ai::current_state()
}

#[tauri::command]
pub fn voice_ai_set_config(
    changes: crate::voice_ai::VoiceAiConfigPatch,
) -> Result<crate::voice_ai::VoiceAiState, String> {
    crate::voice_ai::set_config(changes)
}

#[tauri::command]
pub async fn voice_ai_download(
    app: AppHandle,
    tier: String,
) -> Result<crate::voice_ai::VoiceAiState, String> {
    crate::voice_ai::download_tier(&app, &tier).await
}

#[tauri::command]
pub fn voice_ai_cancel_download() -> bool {
    crate::voice_ai::cancel_download()
}

#[tauri::command]
pub async fn voice_ai_benchmark() -> Result<crate::voice_ai::VoiceAiBenchmarkResult, String> {
    tauri::async_runtime::spawn_blocking(crate::voice_ai::benchmark_device)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn voice_ai_start_enroll(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::voice_ai::start_enroll(app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn voice_ai_finish_enroll() -> Result<crate::voice_ai::VoiceAiEnrollResult, String> {
    tauri::async_runtime::spawn_blocking(crate::voice_ai::finish_enroll)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn voice_ai_cancel_enroll() -> bool {
    crate::voice_ai::cancel_enroll()
}

#[tauri::command]
pub fn voice_ai_clear_voiceprint() -> Result<crate::voice_ai::VoiceAiState, String> {
    crate::voice_ai::clear_voiceprint()
}

#[tauri::command]
pub fn voice_ai_export_voiceprint() -> Result<Option<serde_json::Value>, String> {
    crate::voice_ai::export_voiceprint()
}

#[tauri::command]
pub fn voice_ai_import_voiceprint(
    payload: serde_json::Value,
) -> Result<crate::voice_ai::VoiceAiState, String> {
    crate::voice_ai::import_voiceprint(payload)
}

#[tauri::command]
pub async fn voice_ai_enroll_from_pcm(
    pcm_base64: String,
) -> Result<crate::voice_ai::VoiceAiEnrollResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = crate::local_term::base64_decode(pcm_base64.as_bytes())
            .ok_or_else(|| "音频数据编码无效".to_string())?;
        crate::voice_ai::enroll_from_pcm_bytes(&bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn voice_ai_start_test(
    app: AppHandle,
    threshold: Option<f32>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::voice_ai::start_test(app, threshold))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn voice_ai_stop_test() -> bool {
    crate::voice_ai::stop_test()
}

#[tauri::command]
pub async fn voice_call_mic_start(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::voice::start_live_call_mic(&app))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn voice_call_mic_stop(app: AppHandle) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        crate::voice::stop_live_call_mic();
        if !crate::voice::is_call_active() {
            crate::mainwin::set_voice_call_active(&app, false);
        }
    })
    .await;
}

#[tauri::command]
pub fn voice_call_mic_set_muted(app: AppHandle, muted: bool) {
    crate::voice::set_live_call_mic_muted(&app, muted);
}

#[tauri::command]
pub fn voice_hud_sync(app: AppHandle, state: Value) {
    crate::voice::sync_call_hud(&app, state);
}

#[tauri::command]
pub fn voice_hud_hide(app: AppHandle) {
    crate::voice::hide_call_hud(&app);
}

#[tauri::command]
pub fn notch_sync(app: AppHandle, state: Value) {
    crate::notch::sync(&app, state);
}

#[tauri::command]
pub fn notch_focus_main(app: AppHandle) {
    crate::mainwin::show_main(&app, "notch.focus");
}

#[tauri::command]
pub fn window_start_dragging(app: AppHandle) {
    crate::mainwin::start_dragging(&app);
}

#[tauri::command]
pub fn window_toggle_maximize(app: AppHandle) {
    crate::mainwin::toggle_maximize(&app);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCallDspInfo {
    pub active: bool,
    pub badge: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCallDspChunk {
    pub pcm_base64: String,
    pub level: f32,
}

const MAX_DSP_INPUT_BYTES: usize = 320_000;

static CALL_DSP_PROC: std::sync::OnceLock<
    std::sync::Mutex<Option<crate::voice_ai::LiveCallProcessor>>,
> = std::sync::OnceLock::new();
static CALL_DSP_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn call_dsp_cell() -> &'static std::sync::Mutex<Option<crate::voice_ai::LiveCallProcessor>> {
    CALL_DSP_PROC.get_or_init(|| std::sync::Mutex::new(None))
}

pub(crate) fn close_voice_call_dsp_sync() {
    CALL_DSP_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let prev = call_dsp_cell().lock().ok().and_then(|mut g| g.take());
    drop(prev);
}

pub(crate) fn close_voice_call_dsp_bg() {
    CALL_DSP_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let prev = call_dsp_cell().lock().ok().and_then(|mut g| g.take());
    if let Some(p) = prev {
        std::thread::spawn(move || drop(p));
    }
}

fn process_pcm_bytes_with_processor(
    proc: Option<&mut crate::voice_ai::LiveCallProcessor>,
    bytes: &[u8],
) -> VoiceCallDspChunk {
    let usable_bytes = bytes.len().min(MAX_DSP_INPUT_BYTES) & !1;
    if usable_bytes == 0 {
        return VoiceCallDspChunk {
            pcm_base64: String::new(),
            level: 0.0,
        };
    }
    let samples: Vec<i16> = bytes[..usable_bytes]
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();

    let out_samples: Vec<i16> = if let Some(p) = proc {
        let mut out = Vec::with_capacity(samples.len());
        let mut idx = 0usize;
        while idx + 320 <= samples.len() {
            let (frame, _lvl) = p.process_frame_320(&samples[idx..idx + 320]);
            out.extend_from_slice(&frame);
            idx += 320;
        }
        if idx < samples.len() {
            let rem = samples.len() - idx;
            let mut padded = [0i16; 320];
            padded[..rem].copy_from_slice(&samples[idx..]);
            let (frame, _lvl) = p.process_frame_320(&padded);
            out.extend_from_slice(&frame[..rem]);
        }
        out
    } else {
        samples
    };

    let mut sq_sum = 0.0f64;
    let mut out_bytes = Vec::with_capacity(out_samples.len() * 2);
    for &s in &out_samples {
        let f = f64::from(s) / 32768.0;
        sq_sum += f * f;
        out_bytes.extend_from_slice(&s.to_le_bytes());
    }
    let raw_lvl = if out_samples.is_empty() {
        0.0
    } else {
        ((sq_sum / (out_samples.len() as f64)).sqrt() as f32) * 4.0
    };
    let level = if raw_lvl.is_finite() {
        raw_lvl.clamp(0.0, 1.0)
    } else {
        0.0
    };
    VoiceCallDspChunk {
        pcm_base64: crate::local_term::base64_encode(&out_bytes),
        level,
    }
}

#[tauri::command]
pub async fn voice_call_dsp_open() -> VoiceCallDspInfo {
    let gen = CALL_DSP_GEN
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        .wrapping_add(1);
    let prev = call_dsp_cell().lock().ok().and_then(|mut g| g.take());
    let (active, proc_opt, badge) = tauri::async_runtime::spawn_blocking(move || {
        drop(prev);
        crate::voice_ai::voice_call_dsp_open_processor()
    })
    .await
    .unwrap_or((false, None, None));

    if CALL_DSP_GEN.load(std::sync::atomic::Ordering::SeqCst) != gen {
        if let Some(p) = proc_opt {
            std::thread::spawn(move || drop(p));
        }
        return VoiceCallDspInfo {
            active: false,
            badge: None,
        };
    }

    if let Ok(mut guard) = call_dsp_cell().lock() {
        *guard = proc_opt;
    } else if let Some(p) = proc_opt {
        std::thread::spawn(move || drop(p));
    }
    VoiceCallDspInfo { active, badge }
}

#[tauri::command]
pub async fn voice_call_dsp_process(pcm_base64: String) -> Result<VoiceCallDspChunk, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = crate::local_term::base64_decode(pcm_base64.as_bytes())
            .ok_or_else(|| "音频数据编码无效".to_string())?;
        let mut guard = call_dsp_cell()
            .lock()
            .map_err(|_| "语音 DSP 处理器忙".to_string())?;
        Ok(process_pcm_bytes_with_processor(guard.as_mut(), &bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn voice_call_dsp_close() {
    CALL_DSP_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let prev = call_dsp_cell().lock().ok().and_then(|mut g| g.take());
    if let Some(p) = prev {
        let _ = tauri::async_runtime::spawn_blocking(move || drop(p)).await;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsModifierState {
    pub supported: bool,
    pub meta: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

#[tauri::command]
pub fn query_traffic_light_metrics(app: AppHandle) -> crate::mainwin::TrafficLightMetrics {
    crate::mainwin::query_traffic_light_metrics(&app)
}

#[tauri::command]
pub fn query_os_modifiers() -> OsModifierState {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSEvent, NSEventModifierFlags};
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventSourceKeyState(state_id: i32, key: u16) -> bool;
        }
        const COMBINED_SESSION_STATE: i32 = 0; // kCGEventSourceStateCombinedSessionState
        let ns_flags = NSEvent::modifierFlags_class();
        let down = |k: u16| unsafe { CGEventSourceKeyState(COMBINED_SESSION_STATE, k) };
        let meta = ns_flags.contains(NSEventModifierFlags::Command) && (down(55) || down(54));
        let ctrl = ns_flags.contains(NSEventModifierFlags::Control) && (down(59) || down(62));
        let alt = ns_flags.contains(NSEventModifierFlags::Option) && (down(58) || down(61));
        let shift = ns_flags.contains(NSEventModifierFlags::Shift) && (down(56) || down(60));
        return OsModifierState {
            supported: true,
            meta,
            ctrl,
            alt,
            shift,
        };
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
        };
        let down = |vk: u16| (unsafe { GetAsyncKeyState(i32::from(vk)) } as u16 & 0x8000) != 0;
        return OsModifierState {
            supported: true,
            meta: down(VK_LWIN) || down(VK_RWIN),
            ctrl: down(VK_CONTROL),
            alt: down(VK_MENU),
            shift: down(VK_SHIFT),
        };
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        OsModifierState {
            supported: false,
            meta: false,
            ctrl: false,
            alt: false,
            shift: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectTunnelInfo {
    pub local_port: u16,
    pub remote_addr: String,
}

type TunnelSlot = std::sync::Arc<Mutex<Option<std::net::TcpStream>>>;
type TunnelEntry = (u16, TunnelSlot);

fn direct_tunnels() -> &'static Mutex<HashMap<(std::net::IpAddr, u16), TunnelEntry>> {
    static MAP: OnceLock<Mutex<HashMap<(std::net::IpAddr, u16), TunnelEntry>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pipe_bidirectional(client: std::net::TcpStream, upstream: std::net::TcpStream) {
    use std::net::Shutdown;
    let Ok(mut c_in) = client.try_clone() else {
        return;
    };
    let Ok(mut u_out) = upstream.try_clone() else {
        return;
    };
    let mut u_in = upstream;
    let mut c_out = client;
    let t1 = std::thread::spawn(move || {
        let _ = std::io::copy(&mut c_in, &mut u_out);
        let _ = u_out.shutdown(Shutdown::Write);
    });
    let _ = std::io::copy(&mut u_in, &mut c_out);
    let _ = c_out.shutdown(Shutdown::Write);
    let _ = t1.join();
}

fn ensure_tunnel_listener(
    ip: std::net::IpAddr,
    port: u16,
    prewarmed: std::net::TcpStream,
) -> Result<u16, String> {
    use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
    use std::sync::Arc;
    use std::time::Duration;

    let mut map = direct_tunnels()
        .lock()
        .map_err(|_| "direct tunnel map poisoned".to_string())?;
    if let Some((local_port, slot)) = map.get(&(ip, port)) {
        if let Ok(mut guard) = slot.lock() {
            *guard = Some(prewarmed);
        }
        return Ok(*local_port);
    }

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("bind local tunnel failed: {e}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("read tunnel port failed: {e}"))?
        .port();
    let slot: TunnelSlot = Arc::new(Mutex::new(Some(prewarmed)));
    let slot_bg = Arc::clone(&slot);
    let remote = SocketAddr::new(ip, port);

    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(client) = conn else { continue };
            let _ = client.set_nodelay(true);
            let ready = slot_bg.lock().ok().and_then(|mut g| g.take());
            std::thread::spawn(move || {
                let upstream = match ready {
                    Some(s) => s,
                    None => match TcpStream::connect_timeout(&remote, Duration::from_millis(2500)) {
                        Ok(s) => {
                            let _ = s.set_nodelay(true);
                            s
                        }
                        Err(_) => {
                            let _ = client.shutdown(Shutdown::Both);
                            return;
                        }
                    },
                };
                pipe_bidirectional(client, upstream);
            });
        }
    });

    map.insert((ip, port), (local_port, slot));
    Ok(local_port)
}

fn probe_direct_http_host(
    sa: &std::net::SocketAddr,
    expected_host_id: Option<&str>,
) -> Result<(), String> {
    use std::io::{ErrorKind, Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let mut probe =
        TcpStream::connect_timeout(sa, Duration::from_millis(1800)).map_err(|e| format!("{sa}: {e}"))?;
    let _ = probe.set_nodelay(true);
    let _ = probe.set_read_timeout(Some(Duration::from_millis(1200)));
    let _ = probe.set_write_timeout(Some(Duration::from_millis(1200)));
    probe
        .write_all(b"GET /v1/direct-ping HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|e| format!("{sa} probe write: {e}"))?;

    let mut buf = [0u8; 512];
    let mut len = 0usize;
    loop {
        match probe.read(&mut buf[len..]) {
            Ok(0) => break,
            Ok(n) => {
                len += n;
                if len == buf.len() || buf[..len].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => break,
            Err(e) => return Err(format!("{sa} probe read: {e}")),
        }
    }

    let text = String::from_utf8_lossy(&buf[..len]);
    if !text.starts_with("HTTP/1.") {
        return Err(format!("{sa}: not a direct HTTP responder"));
    }
    if let Some(want) = expected_host_id.map(str::trim).filter(|s| !s.is_empty()) {
        for line in text.lines().skip(1) {
            let trimmed = line.trim_end_matches('\r');
            if trimmed.is_empty() {
                break;
            }
            if let Some((k, v)) = trimmed.split_once(':') {
                if k.trim().eq_ignore_ascii_case("x-pocket-host") {
                    let got = v.trim();
                    if got != want {
                        return Err(format!("{sa}: host mismatch (expected {want}, got {got})"));
                    }
                    break;
                }
            }
        }
    }
    Ok(())
}

pub fn open_direct_tunnel_blocking(
    addrs: Vec<String>,
    port: u16,
    expected_host_id: Option<String>,
) -> Result<DirectTunnelInfo, String> {
    use std::net::{IpAddr, SocketAddr, TcpStream};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    if port == 0 {
        return Err("invalid direct port".into());
    }
    let mut ips: Vec<IpAddr> = Vec::new();
    for raw in addrs {
        if let Ok(ip) = raw.trim().parse::<IpAddr>() {
            if !ips.contains(&ip) {
                ips.push(ip);
                if ips.len() >= 8 {
                    break;
                }
            }
        }
    }
    if ips.is_empty() {
        return Err("no valid direct IP candidates".into());
    }

    let (tx, rx) = mpsc::channel::<Result<(IpAddr, TcpStream), String>>();
    let total = ips.len();
    for ip in ips {
        let tx_i = tx.clone();
        let want_host = expected_host_id.clone();
        std::thread::spawn(move || {
            let sa = SocketAddr::new(ip, port);
            let res = probe_direct_http_host(&sa, want_host.as_deref()).and_then(|()| {
                TcpStream::connect_timeout(&sa, Duration::from_millis(1500))
                    .map(|s| {
                        let _ = s.set_nodelay(true);
                        (ip, s)
                    })
                    .map_err(|e| format!("{ip}: {e}"))
            });
            let _ = tx_i.send(res);
        });
    }
    drop(tx);

    let deadline = Instant::now() + Duration::from_millis(3200);
    let mut last_err = String::from("direct HTTP probe timed out");
    for _ in 0..total {
        let rem = deadline.saturating_duration_since(Instant::now());
        if rem.is_zero() {
            break;
        }
        match rx.recv_timeout(rem) {
            Ok(Ok((ip, stream))) => {
                let local_port = ensure_tunnel_listener(ip, port, stream)?;
                return Ok(DirectTunnelInfo {
                    local_port,
                    remote_addr: ip.to_string(),
                });
            }
            Ok(Err(e)) => {
                last_err = e;
            }
            Err(_) => break,
        }
    }
    Err(last_err)
}

#[tauri::command]
pub async fn open_direct_tunnel(
    addrs: Vec<String>,
    port: u16,
    expected_host_id: Option<String>,
) -> Result<DirectTunnelInfo, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = tx.send(open_direct_tunnel_blocking(addrs, port, expected_host_id));
    });
    rx.await
        .map_err(|_| "direct tunnel worker aborted".to_string())?
}

#[cfg(test)]
mod tests {
    use super::{
        is_sums_url, issue_local_preview_url, open_direct_tunnel_blocking,
        process_pcm_bytes_with_processor, query_os_modifiers, read_local_file_sync,
        resolve_safe_local_file, resolve_safe_local_reveal_target,
        resolve_safe_local_reveal_target_with_cfg_dir,
    };

    #[test]
    fn query_os_modifiers_reports_platform_support() {
        let st = query_os_modifiers();
        #[cfg(any(target_os = "macos", windows))]
        assert!(st.supported);
        #[cfg(not(any(target_os = "macos", windows)))]
        assert!(!st.supported);
    }

    #[test]
    fn resolve_safe_local_reveal_target_accepts_files_and_dirs_and_blocks_private_paths() {
        let base = std::env::temp_dir().join(format!("hp-cmd-reveal-{}", std::process::id()));
        let cfg_dir =
            std::env::temp_dir().join(format!("hp-cmd-reveal-cfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&cfg_dir);
        std::fs::create_dir_all(base.join("dist")).unwrap();
        std::fs::create_dir_all(base.join("src")).unwrap();
        std::fs::create_dir_all(base.join(".ssh")).unwrap();
        std::fs::create_dir_all(&cfg_dir).unwrap();

        std::fs::write(base.join("dist/app.ipa"), b"PK\x03\x04").unwrap();
        std::fs::write(base.join("dist/installer.dmg"), b"koly").unwrap();
        std::fs::write(base.join("src/hello.ts"), "export const ok = true;\n").unwrap();
        std::fs::write(base.join(".env"), "SECRET=1\n").unwrap();
        std::fs::write(base.join(".env.local"), "SECRET=2\n").unwrap();
        std::fs::write(base.join(".ssh/id_rsa"), "PRIVATE").unwrap();
        std::fs::write(base.join(".ssh/config"), "Host *").unwrap();
        std::fs::write(cfg_dir.join("hostd.json"), "{}").unwrap();

        let cwd = base.to_string_lossy().into_owned();

        let ipa = resolve_safe_local_reveal_target(Some(&cwd), "dist/app.ipa").unwrap();
        assert_eq!(ipa, std::fs::canonicalize(base.join("dist/app.ipa")).unwrap());

        let dmg = resolve_safe_local_reveal_target(Some(&cwd), "dist/installer.dmg").unwrap();
        assert_eq!(
            dmg,
            std::fs::canonicalize(base.join("dist/installer.dmg")).unwrap()
        );

        let ts = resolve_safe_local_reveal_target(Some(&cwd), "src/hello.ts").unwrap();
        assert_eq!(ts, std::fs::canonicalize(base.join("src/hello.ts")).unwrap());

        let dir = resolve_safe_local_reveal_target(Some(&cwd), "dist").unwrap();
        assert_eq!(dir, std::fs::canonicalize(base.join("dist")).unwrap());
        assert!(resolve_safe_local_file(Some(&cwd), "dist").is_err());

        let abs_ipa =
            resolve_safe_local_reveal_target(None, &base.join("dist/app.ipa").to_string_lossy())
                .unwrap();
        assert_eq!(abs_ipa, ipa);

        assert!(resolve_safe_local_reveal_target(Some(&cwd), ".env").is_err());
        assert!(resolve_safe_local_reveal_target(Some(&cwd), ".env.local").is_err());
        assert!(resolve_safe_local_reveal_target(Some(&cwd), ".ssh/id_rsa").is_err());
        assert!(resolve_safe_local_reveal_target(Some(&cwd), ".ssh/config").is_err());
        assert!(resolve_safe_local_reveal_target(Some(&cwd), ".ssh").is_err());
        assert!(resolve_safe_local_reveal_target(Some(&cwd), "dist/missing.ipa").is_err());

        let cfg_dir_err = resolve_safe_local_reveal_target_with_cfg_dir(
            None,
            &cfg_dir.to_string_lossy(),
            Some(&cfg_dir),
        )
        .unwrap_err();
        assert!(cfg_dir_err.contains("设置目录"), "{cfg_dir_err}");

        let cfg_file_err = resolve_safe_local_reveal_target_with_cfg_dir(
            None,
            &cfg_dir.join("hostd.json").to_string_lossy(),
            Some(&cfg_dir),
        )
        .unwrap_err();
        assert!(cfg_file_err.contains("设置目录"), "{cfg_file_err}");

        if let Some(real_cfg) = crate::hostd_config_dir().filter(|p| p.exists()) {
            let err =
                resolve_safe_local_reveal_target(None, &real_cfg.to_string_lossy()).unwrap_err();
            assert!(err.contains("设置目录"), "{err}");
        }

        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&cfg_dir);
    }

    #[test]
    fn reads_local_text_image_and_blocks_private_files() {
        let dir = std::env::temp_dir().join(format!("hp-cmd-read-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/hello.ts"), "export const n = 1;\n").unwrap();
        std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
        std::fs::write(
            dir.join("pic.png"),
            [0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        )
        .unwrap();

        let txt = read_local_file_sync(Some(&dir.to_string_lossy()), "src/hello.ts", None).unwrap();
        assert_eq!(txt.path, "src/hello.ts");
        assert_eq!(txt.language.as_deref(), Some("ts"));
        assert_eq!(txt.text.as_deref(), Some("export const n = 1;\n"));
        assert!(!txt.binary);

        let img = read_local_file_sync(None, &dir.join("pic.png").to_string_lossy(), None).unwrap();
        assert_eq!(img.mime.as_deref(), Some("image/png"));
        assert!(img.binary);
        assert!(img.base64.is_some());

        assert!(read_local_file_sync(Some(&dir.to_string_lossy()), ".env", None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolves_bare_filename_into_workspace_subdirectory_and_excludes_ignored_and_private() {
        let dir = std::env::temp_dir().join(format!("hp-cmd-bare-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(dir.join("secrets")).unwrap();

        std::fs::write(
            dir.join("docs/external-delivery-sequence.html"),
            "<!doctype html><html><body>ok</body></html>",
        )
        .unwrap();
        std::fs::write(dir.join("node_modules/pkg/secret.html"), "<html>ignore</html>").unwrap();
        std::fs::write(dir.join("secrets/.env"), "KEY=123").unwrap();

        let cwd = dir.to_string_lossy().into_owned();
        let rel_hit = read_local_file_sync(Some(&cwd), "external-delivery-sequence.html", None).unwrap();
        assert_eq!(rel_hit.path, "docs/external-delivery-sequence.html");
        assert!(rel_hit.text.as_deref().unwrap_or("").contains("ok"));

        let synth_abs = dir
            .join("external-delivery-sequence.html")
            .to_string_lossy()
            .into_owned();
        let abs_hit = read_local_file_sync(Some(&cwd), &synth_abs, None).unwrap();
        assert_eq!(abs_hit.path, "docs/external-delivery-sequence.html");

        assert!(read_local_file_sync(Some(&cwd), "secret.html", None).is_err());
        assert!(read_local_file_sync(Some(&cwd), ".env", None).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_release_listing_is_fetched() {
        let gh = "https://github.com/owner/repo/releases/latest/download/SHA256SUMS";
        let tagged = "https://github.com/owner/repo/releases/download/v0.2.4/SHA256SUMS";
        let notes_latest = "https://github.com/owner/repo/releases/latest/download/RELEASE-NOTES.md";
        let notes_tagged = "https://github.com/owner/repo/releases/download/v0.2.8/RELEASE-NOTES.md";
        let manifest_latest =
            "https://github.com/owner/repo/releases/latest/download/RELEASE-MANIFEST.json";
        let manifest_tagged =
            "https://github.com/owner/repo/releases/download/v0.2.28/RELEASE-MANIFEST.json";
        assert!(is_sums_url(gh));
        assert!(is_sums_url(tagged));
        assert!(is_sums_url(notes_latest));
        assert!(is_sums_url(notes_tagged));
        assert!(is_sums_url(manifest_latest));
        assert!(is_sums_url(manifest_tagged));
        assert!(is_sums_url(&format!("https://mirror.example.com/{gh}")));
        assert!(is_sums_url(&format!("https://mirror.example.com/{tagged}")));
        assert!(is_sums_url(&format!("https://mirror.example.com/{notes_latest}")));
        assert!(is_sums_url(&format!("https://mirror.example.com/{notes_tagged}")));
        assert!(is_sums_url(&format!("https://mirror.example.com/{manifest_latest}")));
        assert!(is_sums_url(&format!("https://mirror.example.com/{manifest_tagged}")));
        assert!(is_sums_url(&format!("http://localhost:8080/{gh}")));
        assert!(
            !is_sums_url(&format!("http://mirror.example.com/{gh}")),
            "plain http only on this machine"
        );
        assert!(!is_sums_url(
            "https://example.com/releases/latest/download/SHA256SUMS"
        ));
        assert!(!is_sums_url(
            "https://github.com/owner/repo/releases/latest/download/app.dmg"
        ));
        assert!(!is_sums_url(&format!("{gh}?x=1")));
        assert!(!is_sums_url(
            "file:///etc/releases/latest/download/SHA256SUMS"
        ));
    }

    #[test]
    fn voice_call_dsp_process_handles_multiples_and_remainders_cleanly() {
        let empty = process_pcm_bytes_with_processor(None, &[]);
        assert!(empty.pcm_base64.is_empty());
        assert_eq!(empty.level, 0.0);

        let mut samples = Vec::with_capacity(960 + 80);
        for i in 0..1040 {
            let s = ((0.25 * (2.0 * std::f64::consts::PI * 600.0 * (i as f64) / 16000.0).sin())
                * 32767.0) as i16;
            samples.push(s);
        }
        let mut raw_bytes = Vec::with_capacity(samples.len() * 2 + 1);
        for s in &samples {
            raw_bytes.extend_from_slice(&s.to_le_bytes());
        }
        // Trailing odd byte should be cleanly ignored without panicking.
        raw_bytes.push(0x7f);

        let mut proc = crate::voice_ai::LiveCallProcessor::with_config(
            crate::voice_ai::VoiceAiConfig {
                denoise: true,
                enhance_vocal: false,
                filter: false,
                first_speaker: false,
                ..Default::default()
            },
        );
        let chunk = process_pcm_bytes_with_processor(Some(&mut proc), &raw_bytes);
        let decoded = crate::local_term::base64_decode(chunk.pcm_base64.as_bytes()).unwrap();
        assert_eq!(decoded.len(), samples.len() * 2);
        assert!(chunk.level > 0.0 && chunk.level <= 1.0);
    }

    #[test]
    fn issue_local_preview_url_reuses_token_for_same_html_file() {
        let dir = std::env::temp_dir().join(format!("hp-cap-reuse-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let html_file = dir.join("preview.html");
        std::fs::write(&html_file, "<h1>hi</h1>").unwrap();
        let u1 = issue_local_preview_url(
            Some(dir.to_str().unwrap()),
            "preview.html",
        )
        .unwrap();
        let u2 = issue_local_preview_url(
            None,
            html_file.to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(u1, u2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_direct_tunnel_blocking_verifies_http_probe_ignores_silent_syn_and_bridges_streams() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        // Bind a silent TCP acceptor on IPv6 loopback (simulates TUN fake SYN-ACK that accepts TCP and never speaks HTTP).
        let silent_v6 = TcpListener::bind("[::1]:0").ok();
        let port = if let Some(ref s6) = silent_v6 {
            s6.local_addr().unwrap().port()
        } else {
            0
        };
        let real_srv = TcpListener::bind(("127.0.0.1", port)).unwrap();
        let port = real_srv.local_addr().unwrap().port();

        if let Some(s6) = silent_v6 {
            std::thread::spawn(move || {
                for conn in s6.incoming().take(4) {
                    if let Ok(sock) = conn {
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(2000));
                            drop(sock);
                        });
                    }
                }
            });
        }

        std::thread::spawn(move || {
            for conn in real_srv.incoming().take(4) {
                if let Ok(mut sock) = conn {
                    std::thread::spawn(move || {
                        let mut buf = [0u8; 256];
                        if let Ok(n) = sock.read(&mut buf) {
                            let req = String::from_utf8_lossy(&buf[..n]);
                            if req.starts_with("GET /v1/direct-ping") {
                                let _ = sock.write_all(
                                    b"HTTP/1.1 200 OK\r\nX-Pocket-Host: host-expected\r\nContent-Length: 2\r\n\r\nok",
                                );
                            } else {
                                let _ = sock.write_all(&buf[..n]);
                            }
                        }
                    });
                }
            }
        });

        // Wrong expected host ID must be rejected cleanly.
        assert!(open_direct_tunnel_blocking(
            vec!["127.0.0.1".to_string()],
            port,
            Some("other-host".to_string()),
        )
        .is_err());

        // Matching host ID must beat silent [::1] SYN acceptor and bridge streams.
        let info = open_direct_tunnel_blocking(
            vec!["::1".to_string(), "127.0.0.1".to_string()],
            port,
            Some("host-expected".to_string()),
        )
        .unwrap();
        assert_eq!(info.remote_addr, "127.0.0.1");

        for payload in [b"hello-1".as_slice(), b"hello-2".as_slice()] {
            let mut cli = std::net::TcpStream::connect(("127.0.0.1", info.local_port)).unwrap();
            cli.write_all(payload).unwrap();
            let mut got = [0u8; 7];
            cli.read_exact(&mut got).unwrap();
            assert_eq!(&got, payload);
        }
    }
}
