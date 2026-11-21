//! Atomic persistence for desktop shell tabs, queued chat prompts, and composer draft attachments.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

pub const FILE_NAME: &str = "workspace-state.json";
/// Maximum serialized JSON payload accepted by native persistence (32 MB).
pub const MAX_BYTES: usize = 32 * 1024 * 1024;

static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(FILE_NAME))
}

/// Reads persisted workspace state JSON from `path`, returning `None` when missing, oversized, or invalid.
pub fn load_from_path(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_BYTES as u64 {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    if raw.len() > MAX_BYTES || raw.trim().is_empty() {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    Some(raw)
}

/// Atomically writes validated workspace state JSON (<= 32 MB, 0600 on Unix) to `path`.
pub fn save_to_path(path: &Path, raw: &str) -> Result<(), String> {
    if raw.len() > MAX_BYTES {
        return Err(format!(
            "workspace state exceeds {} MB limit",
            MAX_BYTES / (1024 * 1024)
        ));
    }
    if raw.trim().is_empty() {
        return Err("workspace state payload is empty".into());
    }
    serde_json::from_str::<serde_json::Value>(raw)
        .map_err(|e| format!("invalid workspace state JSON: {e}"))?;
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "workspace state write lock poisoned".to_string())?;
    crate::config::write_atomic(path, raw.as_bytes())
        .map_err(|e| format!("failed to write workspace-state.json: {e}"))
}

#[tauri::command]
pub fn workspace_state_load(app: tauri::AppHandle) -> Option<String> {
    let path = state_path(&app).ok()?;
    load_from_path(&path)
}

#[tauri::command]
pub fn workspace_state_save(app: tauri::AppHandle, raw: String) -> Result<(), String> {
    let path = state_path(&app)?;
    save_to_path(&path, &raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("hp-ws-{name}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn workspace_state_missing_returns_none() {
        let dir = temp_dir("missing");
        let path = dir.join(FILE_NAME);
        assert_eq!(load_from_path(&path), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_state_roundtrip_is_atomic_and_private() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("nested").join(FILE_NAME);

        let initial = r#"{"version":1,"updatedAt":100,"chatQueue":{"queuedByAgent":{"a":[{"id":"q-1","text":"hello"}]}}}"#;
        save_to_path(&path, initial).expect("initial save should succeed");
        assert_eq!(load_from_path(&path).as_deref(), Some(initial));

        let updated = r#"{"version":1,"updatedAt":200,"shellState":{"tabs":[{"id":"a:1","kind":"agent","agentKey":"a1"}]}}"#;
        save_to_path(&path, updated).expect("overwrite save should succeed");
        assert_eq!(load_from_path(&path).as_deref(), Some(updated));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        let file_count = fs::read_dir(path.parent().unwrap()).unwrap().count();
        assert_eq!(file_count, 1, "no temporary files left behind");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_state_rejects_oversized_and_invalid_without_clobbering() {
        let dir = temp_dir("limits");
        let path = dir.join(FILE_NAME);
        let valid = r#"{"version":1,"updatedAt":1}"#;
        save_to_path(&path, valid).unwrap();

        let huge = format!(r#"{{"blob":"{}"}}"#, "a".repeat(MAX_BYTES + 1));
        assert!(save_to_path(&path, &huge).is_err());
        assert_eq!(load_from_path(&path).as_deref(), Some(valid));

        assert!(save_to_path(&path, "{broken json").is_err());
        assert!(save_to_path(&path, "   ").is_err());
        assert_eq!(load_from_path(&path).as_deref(), Some(valid));

        fs::write(&path, "{corrupt").unwrap();
        assert_eq!(load_from_path(&path), None);

        let _ = fs::remove_dir_all(&dir);
    }
}
