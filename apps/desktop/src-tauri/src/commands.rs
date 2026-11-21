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
pub fn permission_open_settings(kind: String) -> Result<(), String> {
    perms::open_settings(&kind)
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

/// What `update_fetch_sums` may fetch: the latest or tagged release's SHA256SUMS on github.com,
/// directly or through a mirror prefix (https, or plain http on this machine).
fn is_sums_url(url: &str) -> bool {
    const LATEST_SUFFIX: &str = "/releases/latest/download/SHA256SUMS";
    const TAGGED_MARKER: &str = "/releases/download/v";
    const TAGGED_SUFFIX: &str = "/SHA256SUMS";
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1"));
    let scheme_ok = u.scheme() == "https" || (u.scheme() == "http" && local);
    let path_ok = url.ends_with(LATEST_SUFFIX)
        || (url.contains(TAGGED_MARKER) && url.ends_with(TAGGED_SUFFIX));
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

/// Opens the OS-native folder selection dialog (Finder sheet on macOS, Explorer on Windows).
#[tauri::command]
pub async fn pick_folder(
    app: AppHandle,
    initial_dir: Option<String>,
) -> Result<Option<String>, String> {
    let start_dir = expand_initial_folder(initial_dir);

    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let res = (|| -> Result<Option<String>, String> {
                let Some(mtm) = objc2::MainThreadMarker::new() else {
                    return Err("不在主线程上，无法打开目录选择器".into());
                };
                use objc2_app_kit::NSOpenPanel;
                use objc2_foundation::{NSString, NSURL};

                let panel = NSOpenPanel::openPanel(mtm);
                panel.setCanChooseDirectories(true);
                panel.setCanChooseFiles(false);
                panel.setCanCreateDirectories(true);
                if let Some(dir) = &start_dir {
                    let s = NSString::from_str(&dir.to_string_lossy());
                    let url = NSURL::fileURLWithPath(&s);
                    panel.setDirectoryURL(Some(&url));
                }
                let resp = panel.runModal();
                if resp != 1 {
                    return Ok(None);
                }
                let picked = panel
                    .URL()
                    .and_then(|u| u.path())
                    .map(|ns| format_picked_folder(std::path::Path::new(&ns.to_string())));
                Ok(picked)
            })();
            let _ = tx.send(res);
        })
        .map_err(|e| format!("无法弹出目录选择框：{e}"))?;

        return tauri::async_runtime::spawn_blocking(move || {
            rx.recv().map_err(|_| "目录选择框已关闭".to_string())?
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
                    return Err(format!("打不开文件夹选择框 (0x{hr:08x})"));
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
                    let _ = set_options(dlg, opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
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
                    return if hr_show == HRESULT_CANCELLED {
                        Ok(None)
                    } else {
                        Ok(None)
                    };
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
                Ok(Some(format_picked_folder(std::path::Path::new(&picked))))
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
            if let Ok(out) = std::process::Command::new("zenity")
                .args(["--file-selection", "--directory", "--filename", &format!("{}/", start.trim_end_matches('/'))])
                .output()
            {
                if out.status.success() {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !s.is_empty() {
                        return Ok(Some(format_picked_folder(std::path::Path::new(&s))));
                    }
                }
                return Ok(None);
            }
            if let Ok(out) = std::process::Command::new("kdialog")
                .args(["--getexistingdirectory", &start])
                .output()
            {
                if out.status.success() {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !s.is_empty() {
                        return Ok(Some(format_picked_folder(std::path::Path::new(&s))));
                    }
                }
                return Ok(None);
            }
            Err("当前 Linux 环境未安装 zenity / kdialog，请改用右侧「浏览目录」".into())
        })
        .await
        .map_err(|e| e.to_string())?;
    }
}

#[cfg(test)]
mod tests {
    use super::is_sums_url;

    #[test]
    fn only_the_release_listing_is_fetched() {
        let gh = "https://github.com/owner/repo/releases/latest/download/SHA256SUMS";
        let tagged = "https://github.com/owner/repo/releases/download/v0.2.4/SHA256SUMS";
        assert!(is_sums_url(gh));
        assert!(is_sums_url(tagged));
        assert!(is_sums_url(&format!("https://mirror.example.com/{gh}")));
        assert!(is_sums_url(&format!("https://mirror.example.com/{tagged}")));
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
