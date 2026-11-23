//! The shared client config file (`config.json` next to hostd.json), desktop side.
//!
//! Schema and validation live in packages/protocol (`CLIENT_CONFIG_KEYS`,
//! `parseClientConfig`, `withConfigValue`); docs/config.md documents every key.
//! This module only reads and writes the file safely: one key at a time is
//! changed on a fresh read, unknown keys and sections are kept, `version` is
//! always written, the write is atomic (temp file + rename) and the file is
//! 0600 on Unix. A file that is not valid JSON is never overwritten.
//!
//! The native side also keeps a typed copy of the keys it acts on (logging,
//! voice input, browser, resources) and notices edits made by the CLI or by
//! hand within a few seconds.

use crate::logging::{self, Level};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub const FILE_NAME: &str = "config.json";
pub const VERSION: u64 = 1;
pub const CHANGED_EVENT: &str = "config://changed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub path: String,
    pub exists: bool,
    /// The file's object as it is (unknown keys included); `{}` when missing or unreadable.
    pub raw: Value,
    /// Last change, epoch ms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<i64>,
    /// Why the file could not be read (not valid JSON, not an object, permission).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The keys the native side acts on, with the protocol's defaults.
#[derive(Debug, Clone, PartialEq)]
pub struct Native {
    pub log_level: Level,
    pub log_upload: bool,
    pub log_keep_days: u32,
    pub voice_enabled: bool,
    pub voice_hotkey: String,
    pub voice_mode: String,
    pub voice_language: String,
    pub voice_insert: String,
    pub voice_max_seconds: u32,
    pub voice_sounds: bool,
    pub browser_cookie_import: String,
    pub browser_clear_on_exit: bool,
    pub low_power: String,
    pub memory_warn_mb: u64,
    pub disk_warn_gb: u64,
    /// `general.theme`: system, light or dark (the title bar follows it).
    pub theme: String,
    pub close_to_tray: bool,
    pub launch_at_login: bool,
    /// `general.launchAtLogin` is in the file: only then is the OS login item made to match.
    pub launch_at_login_set: bool,
    pub dynamic_island: bool,
}

impl Default for Native {
    fn default() -> Self {
        Native {
            log_level: Level::Info,
            log_upload: true,
            log_keep_days: 7,
            voice_enabled: true,
            voice_hotkey: "CommandOrControl+Shift+Space".into(),
            voice_mode: "hold".into(),
            voice_language: "auto".into(),
            voice_insert: "paste".into(),
            voice_max_seconds: 60,
            voice_sounds: true,
            browser_cookie_import: "ask".into(),
            browser_clear_on_exit: false,
            low_power: "auto".into(),
            memory_warn_mb: 1024,
            disk_warn_gb: 5,
            theme: "system".into(),
            // Approved 2026-11-20: both off unless the person turns them on.
            close_to_tray: false,
            launch_at_login: false,
            launch_at_login_set: false,
            dynamic_island: true,
        }
    }
}

fn get<'a>(raw: &'a Value, key: &str) -> Option<&'a Value> {
    let (section, name) = key.split_once('.')?;
    raw.get(section)?.get(name)
}

fn get_bool(raw: &Value, key: &str, default: bool) -> bool {
    get(raw, key).and_then(Value::as_bool).unwrap_or(default)
}

fn get_int(raw: &Value, key: &str, min: u64, max: u64, default: u64) -> u64 {
    get(raw, key)
        .and_then(Value::as_u64)
        .filter(|v| (min..=max).contains(v))
        .unwrap_or(default)
}

fn get_enum(raw: &Value, key: &str, values: &[&str], default: &str) -> String {
    get(raw, key)
        .and_then(Value::as_str)
        .filter(|v| values.contains(v))
        .unwrap_or(default)
        .to_string()
}

fn get_str(raw: &Value, key: &str, default: &str) -> String {
    get(raw, key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty() && v.len() <= 100)
        .unwrap_or(default)
        .to_string()
}

impl Native {
    pub fn from_raw(raw: &Value) -> Native {
        let d = Native::default();
        Native {
            log_level: get(raw, "logging.level")
                .and_then(Value::as_str)
                .and_then(Level::parse)
                .unwrap_or(d.log_level),
            log_upload: get_bool(raw, "logging.upload", d.log_upload),
            log_keep_days: get_int(raw, "logging.keepDays", 1, 90, 7) as u32,
            voice_enabled: get_bool(raw, "voiceInput.enabled", d.voice_enabled),
            voice_hotkey: get_str(raw, "voiceInput.hotkey", &d.voice_hotkey),
            voice_mode: get_enum(raw, "voiceInput.mode", &["hold", "toggle"], &d.voice_mode),
            voice_language: get_str(raw, "voiceInput.language", &d.voice_language),
            voice_insert: get_enum(
                raw,
                "voiceInput.insert",
                &["paste", "type", "clipboard"],
                &d.voice_insert,
            ),
            voice_max_seconds: get_int(raw, "voiceInput.maxSeconds", 5, 300, 60) as u32,
            voice_sounds: get_bool(raw, "voiceInput.sounds", d.voice_sounds),
            browser_cookie_import: get_enum(
                raw,
                "browser.cookieImport",
                &["ask", "off"],
                &d.browser_cookie_import,
            ),
            browser_clear_on_exit: get_bool(raw, "browser.clearOnExit", d.browser_clear_on_exit),
            low_power: get_enum(
                raw,
                "resources.lowPower",
                &["auto", "on", "off"],
                &d.low_power,
            ),
            memory_warn_mb: get_int(raw, "resources.memoryWarnMb", 256, 16384, 1024),
            disk_warn_gb: get_int(raw, "resources.diskWarnGb", 1, 1000, 5),
            theme: get_enum(raw, "general.theme", &["system", "light", "dark"], &d.theme),
            close_to_tray: get_bool(raw, "general.closeToTray", d.close_to_tray),
            launch_at_login: get_bool(raw, "general.launchAtLogin", d.launch_at_login),
            launch_at_login_set: get(raw, "general.launchAtLogin").is_some_and(Value::is_boolean),
            dynamic_island: get_bool(raw, "general.dynamicIsland", d.dynamic_island),
        }
    }
}

struct State {
    native: RwLock<Native>,
    /// Serialises read-modify-write within this process.
    write: Mutex<()>,
    /// mtime + size of the file as last seen, to notice outside edits.
    seen: Mutex<Option<(i64, u64)>>,
}

fn state() -> &'static State {
    static S: OnceLock<State> = OnceLock::new();
    S.get_or_init(|| State {
        native: RwLock::new(Native::default()),
        write: Mutex::new(()),
        seen: Mutex::new(None),
    })
}

pub fn native() -> Native {
    state().native.read().map(|n| n.clone()).unwrap_or_default()
}

pub fn path() -> Option<PathBuf> {
    crate::hostd_config_dir().map(|d| d.join(FILE_NAME))
}

fn mtime_ms(meta: &fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

fn stamp(p: &Path) -> Option<(i64, u64)> {
    let meta = fs::metadata(p).ok()?;
    Some((mtime_ms(&meta).unwrap_or(0), meta.len()))
}

/// The file now. Never fails: problems are in `error`.
pub fn read() -> ConfigFile {
    let Some(p) = path() else {
        return ConfigFile {
            path: String::new(),
            exists: false,
            raw: json!({}),
            mtime: None,
            error: Some("找不到配置文件夹（没有 HOME / APPDATA）".into()),
        };
    };
    read_at(&p)
}

pub fn read_at(p: &Path) -> ConfigFile {
    let display = p.display().to_string();
    let meta = match fs::metadata(p) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return ConfigFile {
                path: display,
                exists: false,
                raw: json!({}),
                mtime: None,
                error: None,
            }
        }
        Err(e) => {
            return ConfigFile {
                path: display,
                exists: true,
                raw: json!({}),
                mtime: None,
                error: Some(format!("无法读取：{e}")),
            }
        }
    };
    let mtime = mtime_ms(&meta);
    let text = match fs::read_to_string(p) {
        Ok(t) => t,
        Err(e) => {
            return ConfigFile {
                path: display,
                exists: true,
                raw: json!({}),
                mtime,
                error: Some(format!("无法读取：{e}")),
            }
        }
    };
    if text.trim().is_empty() {
        return ConfigFile {
            path: display,
            exists: true,
            raw: json!({}),
            mtime,
            error: None,
        };
    }
    match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
        Ok(v @ Value::Object(_)) => ConfigFile {
            path: display,
            exists: true,
            raw: v,
            mtime,
            error: None,
        },
        Ok(_) => ConfigFile {
            path: display,
            exists: true,
            raw: json!({}),
            mtime,
            error: Some("config.json 不是一个 JSON 对象，暂用默认设置".into()),
        },
        Err(e) => ConfigFile {
            path: display,
            exists: true,
            raw: json!({}),
            mtime,
            error: Some(format!(
                "config.json 不是有效的 JSON（第 {} 行），暂用默认设置",
                e.line()
            )),
        },
    }
}

fn key_shape() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"^[a-z][A-Za-z]{0,30}\.[a-z][A-Za-z0-9]{0,40}$").expect("valid key pattern")
    })
}

fn secret_name() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)token|secret|password|passwd|api[-_]?key|private[-_]?key|credential")
            .expect("valid pattern")
    })
}

/// Shape checks only; the protocol's `configValueError` checks each key's type and range.
pub fn check_change(key: &str, value: &Value) -> Result<(), String> {
    if !key_shape().is_match(key) {
        return Err(format!("配置项名称不对：{key}"));
    }
    if secret_name().is_match(key) {
        return Err("令牌和密钥不能写进 config.json".into());
    }
    let ok = match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
        Value::String(s) => s.len() <= 500,
        Value::Array(items) => {
            items.len() <= 20
                && items
                    .iter()
                    .all(|i| i.as_str().is_some_and(|s| s.len() <= 500))
        }
        Value::Object(_) => false,
    };
    if ok {
        Ok(())
    } else {
        Err(format!("{key} 的值类型不对"))
    }
}

/// `raw` with each change applied (null removes the key); same rules as the protocol's `withConfigValue`.
pub fn apply(raw: &Value, changes: &Map<String, Value>) -> Value {
    let file = raw.as_object().cloned().unwrap_or_default();
    let version = file
        .get("version")
        .and_then(Value::as_u64)
        .filter(|v| *v > VERSION)
        .unwrap_or(VERSION);
    let mut out = Map::new();
    out.insert("version".into(), json!(version));
    for (k, v) in file {
        if k != "version" {
            out.insert(k, v);
        }
    }
    for (key, value) in changes {
        let Some((section, name)) = key.split_once('.') else {
            continue;
        };
        let mut sec = out
            .get(section)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if value.is_null() {
            sec.remove(name);
        } else {
            sec.insert(name.to_string(), value.clone());
        }
        if sec.is_empty() {
            out.remove(section);
        } else {
            out.insert(section.to_string(), Value::Object(sec));
        }
    }
    Value::Object(out)
}

/// Temp file in the same folder, flushed, then renamed over the old file.
pub fn write_atomic(p: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = p
        .parent()
        .ok_or_else(|| std::io::Error::other("no parent folder"))?;
    if !dir.exists() {
        fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".{}.{}-{nanos}.tmp", FILE_NAME, std::process::id()));
    let result = (|| {
        use std::io::Write;
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, p)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Changes keys in the file (null: back to the default) and returns the file as written.
pub fn set(app: Option<&AppHandle>, changes: Map<String, Value>) -> Result<ConfigFile, String> {
    for (k, v) in &changes {
        check_change(k, v)?;
    }
    let p = path().ok_or_else(|| "找不到配置文件夹".to_string())?;
    let st = state();
    let _guard = st.write.lock().map_err(|_| "配置写入被占用".to_string())?;
    let current = read_at(&p);
    if current.exists && current.error.is_some() {
        return Err(format!(
            "{}。为了不覆盖你的内容，请先修好或删除 {}",
            current.error.unwrap_or_default(),
            current.path
        ));
    }
    let next = apply(&current.raw, &changes);
    let mut text = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
    text.push('\n');
    write_atomic(&p, text.as_bytes()).map_err(|e| format!("无法保存 config.json：{e}"))?;
    let keys: Vec<&String> = changes.keys().collect();
    logging::info("config", "config.json updated", json!({ "keys": keys }));
    let written = read_at(&p);
    if let Ok(mut seen) = st.seen.lock() {
        *seen = stamp(&p);
    }
    adopt(app, &written, false);
    Ok(written)
}

/// Takes the native keys from `file`; `notify` tells the UI the file changed outside the app.
fn adopt(app: Option<&AppHandle>, file: &ConfigFile, notify: bool) {
    let next = Native::from_raw(&file.raw);
    let changed = {
        let mut cur = match state().native.write() {
            Ok(g) => g,
            Err(_) => return,
        };
        let changed = *cur != next;
        *cur = next.clone();
        changed
    };
    logging::set_min_level(if cfg!(debug_assertions) {
        Level::Debug.min(next.log_level)
    } else {
        next.log_level
    });
    logging::set_upload(next.log_upload);
    if let Some(app) = app {
        if changed {
            crate::voice::config_changed(app);
            crate::mainwin::config_changed(app);
        }
        if notify {
            let _ = app.emit(CHANGED_EVENT, file);
        }
    }
}

/// Reads the file at startup and applies it.
pub fn load_at_startup() -> ConfigFile {
    let file = read();
    if let Some(p) = path() {
        if let Ok(mut seen) = state().seen.lock() {
            *seen = stamp(&p);
        }
    }
    if let Some(err) = &file.error {
        logging::warn(
            "config",
            "config.json unreadable, using defaults",
            json!({ "error": err }),
        );
    }
    adopt(None, &file, false);
    file
}

/// Notices edits by the CLI or by hand: every 5 s while the window is visible, every 30 s otherwise.
pub fn start_watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let every = if crate::resources::window_visible() {
                5
            } else {
                30
            };
            tokio::time::sleep(Duration::from_secs(every)).await;
            let Some(p) = path() else { continue };
            let now = stamp(&p);
            let changed = match state().seen.lock() {
                Ok(mut seen) if *seen != now => {
                    *seen = now;
                    true
                }
                _ => false,
            };
            if changed {
                let file = read_at(&p);
                logging::info(
                    "config",
                    "config.json changed outside the app",
                    json!({ "exists": file.exists }),
                );
                adopt(Some(&app), &file, true);
            }
        }
    });
}

/// For the diagnostics bundle: where the file is and what it holds (it never holds secrets).
pub fn diagnostics() -> Value {
    let f = read();
    json!({ "path": f.path, "exists": f.exists, "error": f.error, "content": f.raw })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_keeps_unknown_and_sets_version() {
        let raw = json!({ "version": 1, "future": { "x": 1 }, "general": { "theme": "dark", "zzz": true } });
        let mut ch = Map::new();
        ch.insert("general.theme".into(), json!("light"));
        ch.insert("voiceInput.mode".into(), json!("toggle"));
        let out = apply(&raw, &ch);
        assert_eq!(out["future"]["x"], 1);
        assert_eq!(out["general"]["zzz"], true);
        assert_eq!(out["general"]["theme"], "light");
        assert_eq!(out["voiceInput"]["mode"], "toggle");
        assert_eq!(out["version"], 1);
    }

    #[test]
    fn apply_null_removes_and_drops_empty_sections() {
        let raw = json!({ "version": 3, "voiceInput": { "mode": "toggle" } });
        let mut ch = Map::new();
        ch.insert("voiceInput.mode".into(), Value::Null);
        let out = apply(&raw, &ch);
        assert!(out.get("voiceInput").is_none());
        assert_eq!(out["version"], 3, "a newer version number is kept");
    }

    #[test]
    fn rejects_secrets_and_bad_shapes() {
        assert!(check_change("general.apiKey", &json!("x")).is_err());
        assert!(check_change("logging.token", &json!("x")).is_err());
        assert!(check_change("general", &json!(true)).is_err());
        assert!(check_change("general.theme", &json!({ "a": 1 })).is_err());
        assert!(check_change("update.mirrors", &json!(["https://m.example.com/"])).is_ok());
    }

    #[test]
    fn native_defaults_and_ranges() {
        let n = Native::from_raw(
            &json!({ "voiceInput": { "maxSeconds": 9999, "mode": "toggle", "hotkey": "RightOption" }, "logging": { "level": "warn" } }),
        );
        assert_eq!(n.voice_max_seconds, 60);
        assert_eq!(n.voice_mode, "toggle");
        assert_eq!(n.voice_hotkey, "RightOption");
        assert_eq!(n.log_level, Level::Warn);
        assert_eq!(Native::from_raw(&json!({})), Native::default());
    }

    #[test]
    fn atomic_write_replaces_and_is_private() {
        let dir = std::env::temp_dir().join(format!("hp-config-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let p = dir.join("sub").join(FILE_NAME);
        write_atomic(&p, b"{\"version\":1}\n").unwrap();
        write_atomic(&p, b"{\"version\":1,\"general\":{}}\n").unwrap();
        assert_eq!(
            fs::read_to_string(&p).unwrap(),
            "{\"version\":1,\"general\":{}}\n"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&p).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let leftovers = fs::read_dir(p.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 1, "no temp files left behind");
        let f = read_at(&p);
        assert!(f.exists && f.error.is_none());
        fs::write(&p, "{ not json").unwrap();
        assert!(read_at(&p).error.is_some());
        let _ = fs::remove_dir_all(&dir);
    }
}
