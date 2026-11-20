use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostdLocalStatus {
    pub installed: bool,
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
}

fn auth_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
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
    fs::write(&path, data).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
fn clear_auth(app: tauri::AppHandle) -> Result<(), String> {
    let path = auth_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn resolve_hostd_config_path() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("HERDR_POCKET_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(custom).join("hostd.json"));
    }
    #[cfg(windows)]
    {
        let base = std::env::var_os("APPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .or_else(|| std::env::var_os("HOME"))
                    .map(|h| PathBuf::from(h).join("AppData").join("Roaming"))
            });
        return base.map(|dir| dir.join("herdr-pocket").join("hostd.json"));
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .filter(|v| !v.is_empty())
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(|h| PathBuf::from(h).join(".config").join("herdr-pocket").join("hostd.json"))
    }
}

#[tauri::command]
fn runtime_arch() -> &'static str {
    std::env::consts::ARCH
}

#[tauri::command]
fn hostd_status() -> HostdLocalStatus {
    let Some(cfg_path) = resolve_hostd_config_path() else {
        return HostdLocalStatus {
            installed: false,
            configured: false,
            server: None,
            device_name: None,
        };
    };
    if !cfg_path.exists() {
        return HostdLocalStatus {
            installed: false,
            configured: false,
            server: None,
            device_name: None,
        };
    }
    let parsed: Option<serde_json::Value> = fs::read_to_string(&cfg_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    let server = parsed
        .as_ref()
        .and_then(|v| v.get("server"))
        .and_then(|v| v.as_str())
        .map(ToString::to_string);
    let device_name = parsed
        .as_ref()
        .and_then(|v| v.get("name").or_else(|| v.get("deviceName")))
        .and_then(|v| v.as_str())
        .map(ToString::to_string);
    HostdLocalStatus {
        installed: true,
        configured: server.is_some(),
        server,
        device_name,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_auth,
            save_auth,
            clear_auth,
            hostd_status,
            runtime_arch
        ])
        .run(tauri::generate_context!())
        .expect("error while running Herdr Pocket desktop application");
}
