//! Local macOS portal execution bridge (`~/.local/state/herdr-pocket/desktop-portal.sock`).
//!
//! Spawns `hp-mac-portal-v3` directly from the signed `Herdr Pocket.app` bundle instead of the
//! background `node` LaunchAgent so macOS TCC attributes Screen Recording to `Herdr Pocket.app`.

use tauri::AppHandle;

#[cfg(target_os = "macos")]
mod mac {
    use crate::local_term::base64_encode;
    use crate::logging;
    use crate::perms::{self, State};
    use serde::{Deserialize, Serialize};
    use serde_json::json;
    use std::fs::{self, Permissions};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    const SOCKET_NAME: &str = "desktop-portal.sock";
    const MAX_REQ_BYTES: usize = 64 * 1024;
    const MAX_ARGS: usize = 10;
    const MAX_TIMEOUT_MS: u64 = 8000;
    const DEFAULT_TIMEOUT_MS: u64 = 4800;

    static RUNNING: AtomicBool = AtomicBool::new(false);
    static SOCK_PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BridgeRequest {
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        timeout_ms: Option<u64>,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct BridgeResponse {
        code: i32,
        stdout_base64: String,
        stderr: String,
    }

    pub(super) fn hostd_state_dir() -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("HERDR_POCKET_STATE").filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(dir));
        }
        let home = std::env::var_os("HOME").filter(|v| !v.is_empty())?;
        Some(PathBuf::from(home).join(".local/state/herdr-pocket"))
    }

    fn default_helper_path() -> Option<PathBuf> {
        Some(hostd_state_dir()?.join("bin").join("hp-mac-portal-v3"))
    }

    pub(super) fn is_allowed_subcommand(cmd: &str) -> bool {
        matches!(
            cmd,
            "check" | "list" | "capture" | "click" | "scroll" | "text" | "key"
        )
    }

    fn verify_owned_helper(path: &Path) -> Result<(), String> {
        let meta = fs::symlink_metadata(path).map_err(|e| format!("helper_missing:{e}"))?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err("helper_invalid_type".into());
        }
        let current_uid = unsafe { libc::geteuid() } as u32;
        if meta.uid() != current_uid {
            return Err("helper_uid_mismatch".into());
        }
        Ok(())
    }

    fn run_helper_with_timeout(
        helper: &Path,
        args: &[String],
        timeout: Duration,
    ) -> Result<BridgeResponse, String> {
        verify_owned_helper(helper)?;
        let mut child = Command::new(helper)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn_failed:{e}"))?;

        let mut stdout_pipe = child.stdout.take();
        let mut stderr_pipe = child.stderr.take();
        let out_handle = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(ref mut r) = stdout_pipe {
                let _ = r.read_to_end(&mut buf);
            }
            buf
        });
        let err_handle = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(ref mut r) = stderr_pipe {
                let _ = r.read_to_end(&mut buf);
            }
            String::from_utf8_lossy(&buf).into_owned()
        });

        let deadline = Instant::now() + timeout;
        let code = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.code().unwrap_or(-1),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        let _ = out_handle.join();
                        let _ = err_handle.join();
                        return Ok(BridgeResponse {
                            code: -1,
                            stdout_base64: String::new(),
                            stderr: "helper_timeout".into(),
                        });
                    }
                    std::thread::sleep(Duration::from_millis(12));
                }
                Err(e) => {
                    let _ = child.kill();
                    let _ = out_handle.join();
                    let _ = err_handle.join();
                    return Err(format!("wait_failed:{e}"));
                }
            }
        };
        let stdout = out_handle.join().unwrap_or_default();
        let stderr = err_handle.join().unwrap_or_default();
        Ok(BridgeResponse {
            code,
            stdout_base64: base64_encode(&stdout),
            stderr,
        })
    }

    pub(super) fn handle_request_line(line: &str, helper_override: Option<&Path>) -> String {
        let respond = |res: BridgeResponse| {
            serde_json::to_string(&res).unwrap_or_else(|_| {
                "{\"code\":-1,\"stdoutBase64\":\"\",\"stderr\":\"encode_error\"}".into()
            })
        };

        let Ok(req) = serde_json::from_str::<BridgeRequest>(line) else {
            return respond(BridgeResponse {
                code: -1,
                stdout_base64: String::new(),
                stderr: "invalid_request".into(),
            });
        };
        if req.args.is_empty() || req.args.len() > MAX_ARGS {
            return respond(BridgeResponse {
                code: -1,
                stdout_base64: String::new(),
                stderr: "invalid_args".into(),
            });
        }
        let cmd = req.args[0].as_str();
        if !is_allowed_subcommand(cmd) {
            return respond(BridgeResponse {
                code: -1,
                stdout_base64: String::new(),
                stderr: "disallowed_command".into(),
            });
        }

        if cmd == "check" {
            let allowed = perms::status().screen_recording == State::Granted;
            let payload = format!(
                "{{\"screenCapture\":{}}}",
                if allowed { "true" } else { "false" }
            );
            return respond(BridgeResponse {
                code: 0,
                stdout_base64: base64_encode(payload.as_bytes()),
                stderr: String::new(),
            });
        }

        let Some(helper) = helper_override
            .map(PathBuf::from)
            .or_else(default_helper_path)
        else {
            return respond(BridgeResponse {
                code: -1,
                stdout_base64: String::new(),
                stderr: "helper_path_unavailable".into(),
            });
        };

        let timeout_ms = req
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(400, MAX_TIMEOUT_MS);
        match run_helper_with_timeout(&helper, &req.args, Duration::from_millis(timeout_ms)) {
            Ok(resp) => respond(resp),
            Err(err) => respond(BridgeResponse {
                code: -1,
                stdout_base64: String::new(),
                stderr: err,
            }),
        }
    }

    fn handle_connection(stream: UnixStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let Ok(mut writer) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(stream);
        let mut raw = Vec::new();
        let mut limited = (&mut reader).take((MAX_REQ_BYTES + 1) as u64);
        if limited.read_until(b'\n', &mut raw).is_err() || raw.len() > MAX_REQ_BYTES {
            return;
        }
        let line = String::from_utf8_lossy(&raw);
        let resp = handle_request_line(line.trim(), None);
        let _ = writer.write_all(resp.as_bytes());
        let _ = writer.write_all(b"\n");
    }

    pub fn start() {
        if RUNNING.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(dir) = hostd_state_dir() else {
            RUNNING.store(false, Ordering::SeqCst);
            return;
        };
        if let Err(e) = fs::create_dir_all(&dir) {
            logging::warn("portal_bridge", "failed to create state dir", json!({ "error": e.to_string() }));
            RUNNING.store(false, Ordering::SeqCst);
            return;
        }
        let _ = fs::set_permissions(&dir, Permissions::from_mode(0o700));
        let sock_path = dir.join(SOCKET_NAME);
        let _ = fs::remove_file(&sock_path);
        let listener = match UnixListener::bind(&sock_path) {
            Ok(l) => l,
            Err(e) => {
                logging::warn(
                    "portal_bridge",
                    "failed to bind portal bridge socket",
                    json!({ "error": e.to_string() }),
                );
                RUNNING.store(false, Ordering::SeqCst);
                return;
            }
        };
        let _ = fs::set_permissions(&sock_path, Permissions::from_mode(0o600));
        if let Ok(mut slot) = SOCK_PATH.get_or_init(|| Mutex::new(None)).lock() {
            *slot = Some(sock_path.clone());
        }
        logging::info(
            "portal_bridge",
            "portal bridge started",
            json!({ "socket": sock_path.to_string_lossy() }),
        );

        let _ = std::thread::Builder::new()
            .name("pocket-portal-bridge".into())
            .spawn(move || {
                for conn in listener.incoming() {
                    if !RUNNING.load(Ordering::SeqCst) {
                        break;
                    }
                    match conn {
                        Ok(stream) => {
                            let _ = std::thread::Builder::new()
                                .name("pocket-portal-req".into())
                                .spawn(move || handle_connection(stream));
                        }
                        Err(_) => {
                            if !RUNNING.load(Ordering::SeqCst) {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(50));
                        }
                    }
                }
            });
    }

    pub fn shutdown() {
        if !RUNNING.swap(false, Ordering::SeqCst) {
            return;
        }
        if let Some(cell) = SOCK_PATH.get() {
            if let Ok(mut slot) = cell.lock() {
                if let Some(path) = slot.take() {
                    // Poke listener once so accept() wakes up immediately, then remove socket file.
                    let _ = UnixStream::connect(&path);
                    let _ = fs::remove_file(path);
                }
            }
        }
    }
}

pub fn start(_app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::start();
}

pub fn shutdown() {
    #[cfg(target_os = "macos")]
    mac::shutdown();
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::mac::{handle_request_line, is_allowed_subcommand};
    use crate::local_term::base64_decode;
    use serde_json::Value;

    #[test]
    fn subcommand_allowlist_blocks_arbitrary_binaries() {
        for ok in ["check", "list", "capture", "click", "scroll", "text", "key"] {
            assert!(is_allowed_subcommand(ok), "{ok} should be allowed");
        }
        for bad in ["", "rm", "/bin/sh", "eval", "../check", "CHECK"] {
            assert!(!is_allowed_subcommand(bad), "{bad} must be rejected");
        }
    }

    #[test]
    fn bridge_handles_check_and_rejects_disallowed_commands() {
        let bad: Value =
            serde_json::from_str(&handle_request_line(r#"{"args":["rm","-rf","/"]}"#, None))
                .unwrap();
        assert_eq!(bad["code"], -1);
        assert_eq!(bad["stderr"], "disallowed_command");

        let empty: Value =
            serde_json::from_str(&handle_request_line(r#"{"args":[]}"#, None)).unwrap();
        assert_eq!(empty["code"], -1);
        assert_eq!(empty["stderr"], "invalid_args");

        let chk: Value =
            serde_json::from_str(&handle_request_line(r#"{"args":["check"]}"#, None)).unwrap();
        assert_eq!(chk["code"], 0);
        let decoded = base64_decode(chk["stdoutBase64"].as_str().unwrap().as_bytes()).unwrap();
        let parsed: Value = serde_json::from_slice(&decoded).unwrap();
        assert!(parsed["screenCapture"].is_boolean());
    }
}
