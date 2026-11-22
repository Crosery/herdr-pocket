//! Commands for logging, the config file, permissions and resource use.
//! Voice input and the browser panel have theirs in `voice` and `browser`.

use crate::logging::{self, Level};
use crate::{config, diagnostics, perms, relaylog, resources};
use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn log_write(level: String, kind: String, msg: String, data: Option<Value>) {
    let level = Level::parse(&level).unwrap_or(Level::Info);
    logging::write(level, "web", &kind, &msg, data.unwrap_or(Value::Null));
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
    config::set(Some(&app), changes)
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
    const LATEST_SUFFIXES: [&str; 2] = [
        "/releases/latest/download/SHA256SUMS",
        "/releases/latest/download/RELEASE-NOTES.md",
    ];
    const TAGGED_MARKER: &str = "/releases/download/v";
    const TAGGED_SUFFIXES: [&str; 2] = ["/SHA256SUMS", "/RELEASE-NOTES.md"];
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

pub(crate) fn resolve_safe_local_file(
    cwd: Option<&str>,
    path: &str,
) -> Result<ResolvedLocalFile, String> {
    let raw_target = expand_home_path(path)?;
    let cwd_expanded = cwd
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(expand_home_path)
        .transpose()?;

    let candidate = if raw_target.is_absolute() {
        raw_target
    } else if let Some(ref base) = cwd_expanded {
        base.join(&raw_target)
    } else if let Some(home) = crate::home_dir() {
        home.join(&raw_target)
    } else {
        raw_target
    };

    let canon = fs::canonicalize(&candidate).map_err(|_| "没有这个文件或目录".to_string())?;
    for comp in canon.components() {
        if let std::path::Component::Normal(s) = comp {
            if is_private_local_component(&s.to_string_lossy()) {
                return Err("这个文件可能存有密钥，不在这里显示".into());
            }
        }
    }
    if let Some(cfg_dir) = crate::hostd_config_dir() {
        let real_cfg = fs::canonicalize(&cfg_dir).unwrap_or(cfg_dir);
        if canon.starts_with(&real_cfg) {
            return Err("这是 herdr-pocket 自己的设置目录，不在这里显示".into());
        }
    }

    let meta = fs::metadata(&canon).map_err(|e| format!("无法读取文件信息：{e}"))?;
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
    "application/octet-stream"
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
        "mp4" => Some(("video/mp4", "video")),
        "webm" => Some(("video/webm", "video")),
        "mov" => Some(("video/quicktime", "video")),
        "m4v" => Some(("video/x-m4v", "video")),
        _ => None,
    }
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
        "json" | "jsonc" | "json5" => Some("json"),
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
pub fn voice_call_mic_set_muted(muted: bool) {
    crate::voice::set_live_call_mic_muted(muted);
}

#[tauri::command]
pub fn voice_hud_sync(app: AppHandle, state: Value) {
    crate::voice::sync_call_hud(&app, state);
}

#[tauri::command]
pub fn voice_hud_hide(app: AppHandle) {
    crate::voice::hide_call_hud(&app);
}

#[cfg(test)]
mod tests {
    use super::{is_sums_url, read_local_file_sync};

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
    fn only_the_release_listing_is_fetched() {
        let gh = "https://github.com/owner/repo/releases/latest/download/SHA256SUMS";
        let tagged = "https://github.com/owner/repo/releases/download/v0.2.4/SHA256SUMS";
        let notes_latest = "https://github.com/owner/repo/releases/latest/download/RELEASE-NOTES.md";
        let notes_tagged = "https://github.com/owner/repo/releases/download/v0.2.8/RELEASE-NOTES.md";
        assert!(is_sums_url(gh));
        assert!(is_sums_url(tagged));
        assert!(is_sums_url(notes_latest));
        assert!(is_sums_url(notes_tagged));
        assert!(is_sums_url(&format!("https://mirror.example.com/{gh}")));
        assert!(is_sums_url(&format!("https://mirror.example.com/{tagged}")));
        assert!(is_sums_url(&format!("https://mirror.example.com/{notes_latest}")));
        assert!(is_sums_url(&format!("https://mirror.example.com/{notes_tagged}")));
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
}
