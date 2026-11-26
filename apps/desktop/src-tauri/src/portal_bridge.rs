//! Local macOS portal execution bridge (`~/.local/state/herdr-pocket/desktop-portal.sock`).
//!
//! Spawns `hp-mac-portal-v3` directly from the signed `Herdr Pocket.app` bundle instead of the
//! background `node` LaunchAgent so macOS TCC attributes Screen Recording and Accessibility to
//! `Herdr Pocket.app`. Also keeps persistent warm `serve` helpers and keep-alive Unix connections
//! for low-latency 60 FPS capture and real-time pointer/keyboard injection.

use tauri::AppHandle;

#[cfg(target_os = "macos")]
mod mac {
    use crate::local_term::{base64_decode, base64_encode};
    use crate::logging;
    use crate::perm_companion;
    use crate::perms::{self, State};
    use serde::{Deserialize, Serialize};
    use serde_json::json;
    use std::fs::{self, Permissions};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Path, PathBuf};
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant, SystemTime};
    use tauri::AppHandle;

    const SOCKET_NAME: &str = "desktop-portal.sock";
    const MAX_REQ_BYTES: usize = 256 * 1024;
    const MAX_ARGS: usize = 12;
    const MAX_TIMEOUT_MS: u64 = 8000;
    const DEFAULT_TIMEOUT_MS: u64 = 4800;

    static RUNNING: AtomicBool = AtomicBool::new(false);
    static SOCK_PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
    static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
    static CAPTURE_WORKER: OnceLock<Mutex<WorkerSlot>> = OnceLock::new();
    static INPUT_WORKER: OnceLock<Mutex<WorkerSlot>> = OnceLock::new();

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BridgeRequest {
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        timeout_ms: Option<u64>,
    }

    #[derive(Debug, Default, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BridgeResponse {
        code: i32,
        stdout_base64: String,
        stderr: String,
        #[serde(default)]
        keep_alive: bool,
    }

    type HelperSignature = (PathBuf, Option<SystemTime>, u64);

    struct PersistentWorker {
        sig: HelperSignature,
        bin_mode: bool,
        child: Child,
        stdin: ChildStdin,
        stdout: BufReader<ChildStdout>,
    }

    impl PersistentWorker {
        fn stop(mut self) {
            drop(self.stdin);
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[derive(Default)]
    struct WorkerSlot {
        worker: Option<PersistentWorker>,
        serve_unsupported_for: Option<HelperSignature>,
        bin_serve_unsupported_for: Option<HelperSignature>,
    }

    pub fn set_app_handle(app: &AppHandle) {
        let _ = APP_HANDLE.set(app.clone());
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
            "check"
                | "list"
                | "capture"
                | "click"
                | "scroll"
                | "text"
                | "key"
                | "clipboard"
                | "open_accessibility"
                | "open_screen_recording"
        )
    }

    fn verify_owned_helper(path: &Path) -> Result<HelperSignature, String> {
        let meta = fs::symlink_metadata(path).map_err(|e| format!("helper_missing:{e}"))?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err("helper_invalid_type".into());
        }
        let current_uid = unsafe { libc::geteuid() } as u32;
        if meta.uid() != current_uid {
            return Err("helper_uid_mismatch".into());
        }
        Ok((path.to_path_buf(), meta.modified().ok(), meta.len()))
    }

    fn spawn_worker(
        helper: &Path,
        sig: HelperSignature,
        bin_mode: bool,
    ) -> Result<PersistentWorker, String> {
        let mut child = Command::new(helper)
            .arg(if bin_mode { "serve-bin" } else { "serve" })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn_failed:{e}"))?;
        let stdin = child.stdin.take().ok_or("worker_stdin_missing")?;
        let stdout = child.stdout.take().ok_or("worker_stdout_missing")?;
        Ok(PersistentWorker {
            sig,
            bin_mode,
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    fn read_bin_packet(stdout: &mut BufReader<ChildStdout>) -> Option<(i32, Vec<u8>, String)> {
        let mut hdr = [0u8; 16];
        stdout.read_exact(&mut hdr).ok()?;
        if &hdr[..4] != b"HPB1" {
            return None;
        }
        let code = i32::from_be_bytes([hdr[4], hdr[5], hdr[6], hdr[7]]);
        let meta_len = u32::from_be_bytes([hdr[8], hdr[9], hdr[10], hdr[11]]) as usize;
        let out_len = u32::from_be_bytes([hdr[12], hdr[13], hdr[14], hdr[15]]) as usize;
        if meta_len > 1024 * 1024 || out_len > 64 * 1024 * 1024 {
            return None;
        }
        let mut meta_bytes = vec![0u8; meta_len];
        if meta_len > 0 && stdout.read_exact(&mut meta_bytes).is_err() {
            return None;
        }
        let mut out_bytes = vec![0u8; out_len];
        if out_len > 0 && stdout.read_exact(&mut out_bytes).is_err() {
            return None;
        }
        let meta = String::from_utf8_lossy(&meta_bytes).into_owned();
        Some((code, out_bytes, meta))
    }

    fn try_persistent_raw(
        slot_cell: &OnceLock<Mutex<WorkerSlot>>,
        helper: &Path,
        args: &[String],
        prefer_bin: bool,
    ) -> Result<Option<(i32, Vec<u8>, String)>, String> {
        let sig = verify_owned_helper(helper)?;
        let cell = slot_cell.get_or_init(|| Mutex::new(WorkerSlot::default()));
        let Ok(mut slot) = cell.lock() else {
            return Ok(None);
        };
        if slot.serve_unsupported_for.as_ref() == Some(&sig) {
            return Ok(None);
        }

        let try_modes: &[bool] =
            if prefer_bin && slot.bin_serve_unsupported_for.as_ref() != Some(&sig) {
                &[true, false]
            } else {
                &[false]
            };

        for &want_bin in try_modes {
            let need_respawn = match slot.worker.as_mut() {
                Some(w) if w.sig == sig && w.bin_mode == want_bin => {
                    matches!(w.child.try_wait(), Ok(Some(_)) | Err(_))
                }
                _ => true,
            };
            if need_respawn {
                if let Some(old) = slot.worker.take() {
                    old.stop();
                }
                match spawn_worker(helper, sig.clone(), want_bin) {
                    Ok(w) => slot.worker = Some(w),
                    Err(_) => {
                        if want_bin {
                            slot.bin_serve_unsupported_for = Some(sig.clone());
                            continue;
                        }
                        return Ok(None);
                    }
                }
            }

            let Some(w) = slot.worker.as_mut() else {
                return Ok(None);
            };
            let req_line = match serde_json::to_string(&json!({ "args": args })) {
                Ok(s) => s,
                Err(_) => return Ok(None),
            };
            if w.stdin.write_all(req_line.as_bytes()).is_err()
                || w.stdin.write_all(b"\n").is_err()
                || w.stdin.flush().is_err()
            {
                if let Some(old) = slot.worker.take() {
                    old.stop();
                }
                continue;
            }

            if w.bin_mode {
                if let Some((code, out_bytes, stderr)) = read_bin_packet(&mut w.stdout) {
                    if stderr != "unsupported_serve" {
                        return Ok(Some((code, out_bytes, stderr)));
                    }
                }
                if let Some(old) = slot.worker.take() {
                    old.stop();
                }
                slot.bin_serve_unsupported_for = Some(sig.clone());
                continue;
            }

            let mut resp_line = String::new();
            match w.stdout.read_line(&mut resp_line) {
                Ok(0) | Err(_) => {
                    if let Some(old) = slot.worker.take() {
                        old.stop();
                    }
                    slot.serve_unsupported_for = Some(sig);
                    return Ok(None);
                }
                Ok(_) => match serde_json::from_str::<BridgeResponse>(resp_line.trim()) {
                    Ok(resp) if resp.stderr != "unsupported_serve" => {
                        let raw = base64_decode(resp.stdout_base64.as_bytes()).unwrap_or_default();
                        return Ok(Some((resp.code, raw, resp.stderr)));
                    }
                    _ => {
                        if let Some(old) = slot.worker.take() {
                            old.stop();
                        }
                        slot.serve_unsupported_for = Some(sig);
                        return Ok(None);
                    }
                },
            }
        }
        Ok(None)
    }

    fn try_persistent_worker(
        slot_cell: &OnceLock<Mutex<WorkerSlot>>,
        helper: &Path,
        args: &[String],
    ) -> Result<Option<BridgeResponse>, String> {
        let prefer_bin = args.first().map(|s| s.as_str()) == Some("capture");
        match try_persistent_raw(slot_cell, helper, args, prefer_bin)? {
            Some((code, raw, stderr)) => Ok(Some(BridgeResponse {
                code,
                stdout_base64: base64_encode(&raw),
                stderr,
                keep_alive: false,
            })),
            None => Ok(None),
        }
    }

    fn run_helper_raw_with_timeout(
        helper: &Path,
        args: &[String],
        timeout: Duration,
    ) -> Result<(i32, Vec<u8>, String), String> {
        let _ = verify_owned_helper(helper)?;
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
                        return Ok((-1, Vec::new(), "helper_timeout".into()));
                    }
                    std::thread::sleep(Duration::from_millis(8));
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
        Ok((code, stdout, stderr))
    }

    fn run_helper_with_timeout(
        helper: &Path,
        args: &[String],
        timeout: Duration,
    ) -> Result<BridgeResponse, String> {
        let (code, stdout, stderr) = run_helper_raw_with_timeout(helper, args, timeout)?;
        Ok(BridgeResponse {
            code,
            stdout_base64: base64_encode(&stdout),
            stderr,
            keep_alive: false,
        })
    }

    pub(super) fn is_valid_window_target(target: &str) -> bool {
        if let Some(idx) = target.strip_prefix("screen:") {
            return !idx.is_empty() && idx.bytes().all(|b| b.is_ascii_digit());
        }
        !target.is_empty() && target.bytes().all(|b| b.is_ascii_digit())
    }

    pub(super) fn pack_local_capture_packet(code: i32, raw_out: &[u8], stderr: &str) -> Vec<u8> {
        let status: u8 = if code == 2 {
            2
        } else if code != 0 {
            3
        } else if raw_out.is_empty() {
            1
        } else {
            0
        };
        let meta = stderr.as_bytes();
        let meta_len = (meta.len().min(u32::MAX as usize)) as u32;
        let mut pkt = Vec::with_capacity(5 + meta_len as usize + raw_out.len());
        pkt.push(status);
        pkt.extend_from_slice(&meta_len.to_be_bytes());
        pkt.extend_from_slice(&meta[..meta_len as usize]);
        pkt.extend_from_slice(raw_out);
        pkt
    }

    pub fn capture_local_binary_packet(
        window_id: &str,
        max_width: u32,
        quality: u32,
        show_cursor: bool,
        fps: u32,
        since_seq: Option<&str>,
    ) -> Result<Vec<u8>, String> {
        if !is_valid_window_target(window_id) {
            return Err("invalid_window_target".into());
        }
        let helper = default_helper_path().ok_or_else(|| "helper_path_unavailable".to_string())?;
        let mut args = vec![
            "capture".to_string(),
            window_id.to_string(),
            max_width.clamp(480, 2560).to_string(),
            quality.clamp(35, 95).to_string(),
            if show_cursor { "1" } else { "0" }.to_string(),
            fps.clamp(1, 60).to_string(),
        ];
        if let Some(seq) = since_seq.filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())) {
            args.push(seq.to_string());
        }
        if let Ok(Some((code, out, stderr))) = try_persistent_raw(&CAPTURE_WORKER, &helper, &args, true) {
            return Ok(pack_local_capture_packet(code, &out, &stderr));
        }
        let (code, out, stderr) =
            run_helper_raw_with_timeout(&helper, &args, Duration::from_millis(DEFAULT_TIMEOUT_MS))?;
        Ok(pack_local_capture_packet(code, &out, &stderr))
    }

    pub(super) fn handle_request_line(line: &str, helper_override: Option<&Path>) -> String {
        let respond = |mut res: BridgeResponse| {
            res.keep_alive = true;
            serde_json::to_string(&res).unwrap_or_else(|_| {
                "{\"code\":-1,\"stdoutBase64\":\"\",\"stderr\":\"encode_error\",\"keepAlive\":true}".into()
            })
        };

        let Ok(req) = serde_json::from_str::<BridgeRequest>(line) else {
            return respond(BridgeResponse {
                code: -1,
                stderr: "invalid_request".into(),
                ..Default::default()
            });
        };
        if req.args.is_empty() || req.args.len() > MAX_ARGS {
            return respond(BridgeResponse {
                code: -1,
                stderr: "invalid_args".into(),
                ..Default::default()
            });
        }
        let cmd = req.args[0].as_str();
        if !is_allowed_subcommand(cmd) {
            return respond(BridgeResponse {
                code: -1,
                stderr: "disallowed_command".into(),
                ..Default::default()
            });
        }

        if cmd == "check" {
            let st = perms::status();
            let payload = serde_json::to_string(&json!({
                "screenCapture": st.screen_recording == State::Granted,
                "accessibility": st.accessibility == State::Granted,
                "bridgeVersion": 3
            }))
            .unwrap_or_else(|_| "{\"screenCapture\":false,\"accessibility\":false,\"bridgeVersion\":3}".into());
            return respond(BridgeResponse {
                code: 0,
                stdout_base64: base64_encode(payload.as_bytes()),
                ..Default::default()
            });
        }

        if cmd == "open_accessibility" || cmd == "open_screen_recording" {
            let kind = if cmd == "open_accessibility" {
                "accessibility"
            } else {
                "screenRecording"
            };
            let _ = perms::request(kind);
            let _ = perms::open_settings(kind);
            if let Some(app) = APP_HANDLE.get() {
                perm_companion::show(app, kind);
            }
            let payload = format!("{{\"opened\":true,\"kind\":\"{kind}\"}}");
            return respond(BridgeResponse {
                code: 0,
                stdout_base64: base64_encode(payload.as_bytes()),
                ..Default::default()
            });
        }

        let Some(helper) = helper_override
            .map(PathBuf::from)
            .or_else(default_helper_path)
        else {
            return respond(BridgeResponse {
                code: -1,
                stderr: "helper_path_unavailable".into(),
                ..Default::default()
            });
        };

        // Bypass shared persistent worker slots when running unit tests with a custom override
        // unless using normal helper lifecycle; wait: using worker slots works with helper_override
        // too because sig includes helper PathBuf! Still keep dedicated capture vs input slots so
        // frame capture never stalls mouse/keyboard injection.
        let slot = if cmd == "capture" {
            &CAPTURE_WORKER
        } else {
            &INPUT_WORKER
        };
        if let Ok(Some(resp)) = try_persistent_worker(slot, &helper, &req.args) {
            return respond(resp);
        }

        let timeout_ms = req
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(400, MAX_TIMEOUT_MS);
        match run_helper_with_timeout(&helper, &req.args, Duration::from_millis(timeout_ms)) {
            Ok(resp) => respond(resp),
            Err(err) => respond(BridgeResponse {
                code: -1,
                stderr: err,
                ..Default::default()
            }),
        }
    }

    fn handle_connection(stream: UnixStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let Ok(mut writer) = stream.try_clone() else {
            return;
        };
        let mut reader = BufReader::new(stream);
        while RUNNING.load(Ordering::SeqCst) {
            let mut raw = Vec::new();
            let mut limited = (&mut reader).take((MAX_REQ_BYTES + 1) as u64);
            match limited.read_until(b'\n', &mut raw) {
                Ok(0) => break,
                Ok(_) if raw.len() > MAX_REQ_BYTES => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&raw);
                    if line.trim().is_empty() {
                        continue;
                    }
                    let resp = handle_request_line(line.trim(), None);
                    if writer.write_all(resp.as_bytes()).is_err()
                        || writer.write_all(b"\n").is_err()
                        || writer.flush().is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    }

    pub fn start(app: &AppHandle) {
        set_app_handle(app);
        if RUNNING.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(dir) = hostd_state_dir() else {
            RUNNING.store(false, Ordering::SeqCst);
            return;
        };
        if let Err(e) = fs::create_dir_all(&dir) {
            logging::warn(
                "portal_bridge",
                "failed to create state dir",
                json!({ "error": e.to_string() }),
            );
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
        for cell in [&CAPTURE_WORKER, &INPUT_WORKER] {
            if let Some(m) = cell.get() {
                if let Ok(mut slot) = m.lock() {
                    if let Some(w) = slot.worker.take() {
                        w.stop();
                    }
                }
            }
        }
        if let Some(cell) = SOCK_PATH.get() {
            if let Ok(mut slot) = cell.lock() {
                if let Some(path) = slot.take() {
                    let _ = UnixStream::connect(&path);
                    let _ = fs::remove_file(path);
                }
            }
        }
    }
}

pub fn start(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::start(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn shutdown() {
    #[cfg(target_os = "macos")]
    mac::shutdown();
}

#[tauri::command]
pub async fn local_portal_capture_frame(
    window_id: String,
    max_width: Option<u32>,
    quality: Option<u32>,
    show_cursor: Option<bool>,
    fps: Option<u32>,
    since_seq: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    #[cfg(target_os = "macos")]
    {
        let pkt = tauri::async_runtime::spawn_blocking(move || {
            mac::capture_local_binary_packet(
                &window_id,
                max_width.unwrap_or(1600),
                quality.unwrap_or(68),
                show_cursor.unwrap_or(true),
                fps.unwrap_or(30),
                since_seq.as_deref(),
            )
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(tauri::ipc::Response::new(pkt))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window_id, max_width, quality, show_cursor, fps, since_seq);
        Err("local binary capture is only supported on macOS".into())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::mac::{
        handle_request_line, is_allowed_subcommand, is_valid_window_target,
        pack_local_capture_packet,
    };
    use crate::local_term::base64_decode;
    use serde_json::Value;
    use std::fs::{self, Permissions};
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn subcommand_allowlist_blocks_arbitrary_binaries() {
        for ok in [
            "check",
            "list",
            "capture",
            "click",
            "scroll",
            "text",
            "key",
            "clipboard",
            "open_accessibility",
            "open_screen_recording",
        ] {
            assert!(is_allowed_subcommand(ok), "{ok} should be allowed");
        }
        for bad in ["", "rm", "/bin/sh", "eval", "../check", "CHECK", "serve"] {
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
        assert!(parsed["accessibility"].is_boolean());
        assert_eq!(parsed["bridgeVersion"], 3);
    }

    #[test]
    fn local_capture_packet_encodes_status_meta_and_payload() {
        assert!(is_valid_window_target("screen:0"));
        assert!(is_valid_window_target("12345"));
        assert!(!is_valid_window_target("../bad"));
        assert!(!is_valid_window_target(""));

        let frame_pkt = pack_local_capture_packet(0, b"JPEGDATA", "dims:800x600\nseq:7\n");
        assert_eq!(frame_pkt[0], 0);
        let meta_len = u32::from_be_bytes([frame_pkt[1], frame_pkt[2], frame_pkt[3], frame_pkt[4]]) as usize;
        assert_eq!(&frame_pkt[5..5 + meta_len], b"dims:800x600\nseq:7\n");
        assert_eq!(&frame_pkt[5 + meta_len..], b"JPEGDATA");

        let idle_pkt = pack_local_capture_packet(0, b"", "unchanged\nseq:7\n");
        assert_eq!(idle_pkt[0], 1);

        let denied_pkt = pack_local_capture_packet(2, b"", "screen_recording_denied\n");
        assert_eq!(denied_pkt[0], 2);
    }

    #[test]
    fn bridge_supports_persistent_serve_worker_and_fallback() {
        let dir = std::env::temp_dir().join(format!("hp-bridge-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let serve_script = dir.join("mock-serve-helper.sh");
        fs::write(
            &serve_script,
            "#!/bin/sh\nif [ \"$1\" = \"serve\" ]; then\n  while IFS= read -r line; do\n    echo '{\"code\":0,\"stdoutBase64\":\"W10=\",\"stderr\":\"warm\"}'\n  done\n  exit 0\nfi\necho '[]'\n",
        )
        .unwrap();
        fs::set_permissions(&serve_script, Permissions::from_mode(0o755)).unwrap();

        let r1: Value = serde_json::from_str(&handle_request_line(
            r#"{"args":["list"]}"#,
            Some(&serve_script),
        ))
        .unwrap();
        assert_eq!(r1["code"], 0);
        assert_eq!(r1["stderr"], "warm");

        let one_shot = dir.join("mock-oneshot-helper.sh");
        fs::write(
            &one_shot,
            "#!/bin/sh\nif [ \"$1\" = \"serve\" ]; then\n  exit 0\nfi\nprintf '[]'\n",
        )
        .unwrap();
        fs::set_permissions(&one_shot, Permissions::from_mode(0o755)).unwrap();

        let r2: Value = serde_json::from_str(&handle_request_line(
            r#"{"args":["list"]}"#,
            Some(&one_shot),
        ))
        .unwrap();
        assert_eq!(r2["code"], 0);
        let decoded = base64_decode(r2["stdoutBase64"].as_str().unwrap().as_bytes()).unwrap();
        assert_eq!(String::from_utf8_lossy(&decoded), "[]");

        let _ = fs::remove_dir_all(&dir);
    }
}
