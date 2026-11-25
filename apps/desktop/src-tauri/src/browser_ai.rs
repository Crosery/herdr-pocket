//! Optional zero-dependency AI Browser plugin (`plugins.aiBrowser`, OFF by default).
//!
//! When disabled (default):
//! - Zero background TCP sockets or `browser-bridge.json` files are created.
//! - Zero JavaScript overlays or automation listeners are injected into panels.
//! - Zero impact on memory or prompt context.
//!
//! When enabled by the user:
//! - Starts a loopback-only HTTP bridge (`127.0.0.1:0`) with a per-session bearer token in
//!   `~/.config/herdr-pocket/browser-bridge.json` (0600 on Unix) so `herdr-pocket browser` /
//!   `hostd` / Xiaoyang can inspect `@ref` accessibility snapshots and drive the visible
//!   built-in browser with a pastel pink/lavender virtual cursor + live human handoff bar.

use crate::browser;
use crate::logging;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub const EVENT_AI_STATE: &str = "browser://ai-state";
pub const EVENT_AI_CMD: &str = "browser://ai-command";
pub const RPC_TITLE_PREFIX: &str = "\u{200B}__HP_RPC__:";

const BRIDGE_FILE: &str = "browser-bridge.json";
const MAX_HTTP_REQ_BYTES: usize = 256 * 1024;
const DEFAULT_EVAL_TIMEOUT_MS: u64 = 12_000;

static NEXT_CALL_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_AI_SPACE_NUM: AtomicU64 = AtomicU64::new(1);
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static RPC_SECRET: OnceLock<String> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageInfo {
    pub label: String,
    pub panel_id: String,
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSpaceInfo {
    pub id: String,
    pub name: String,
    /// `"user"` or `"ai"`
    pub kind: String,
    /// `"user"` | `"agentWorking"` | `"agentHandoff"`
    pub ownership: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_page: Option<String>,
    pub pages: Vec<BrowserPageInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiBrowserSnapshot {
    pub enabled: bool,
    pub backend: &'static str,
    pub spaces: Vec<BrowserSpaceInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_space_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActRequest {
    pub space_id: Option<String>,
    pub page: Option<String>,
    pub op: String,
    pub url: Option<String>,
    pub target: Option<String>,
    pub value: Option<String>,
    pub key: Option<String>,
    pub delta_y: Option<f64>,
    pub label: Option<String>,
    pub reason: Option<String>,
    pub keep: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActResponse {
    pub ok: bool,
    pub space_id: String,
    pub page: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub ownership: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug)]
struct PendingEval {
    panel_id: String,
    secret: String,
    prev_title: Option<String>,
    chunks: HashMap<usize, String>,
    total: Option<usize>,
    tx: Option<tokio::sync::oneshot::Sender<Result<Value, String>>>,
}

#[derive(Default)]
struct State {
    spaces: Vec<BrowserSpaceInfo>,
    active_space_id: Option<String>,
    pending_evals: HashMap<u64, PendingEval>,
}

fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(|| {
        Mutex::new(State {
            spaces: vec![BrowserSpaceInfo {
                id: "default".into(),
                name: "默认浏览".into(),
                kind: "user".into(),
                ownership: "user".into(),
                status_text: None,
                handoff_reason: None,
                active_page: None,
                pages: Vec::new(),
            }],
            active_space_id: Some("default".into()),
            pending_evals: HashMap::new(),
        })
    })
}

struct BridgeRuntime {
    stop: Arc<AtomicBool>,
    addr: String,
    #[allow(dead_code)]
    token: String,
    handle: Option<std::thread::JoinHandle<()>>,
}

fn bridge_slot() -> &'static Mutex<Option<BridgeRuntime>> {
    static B: OnceLock<Mutex<Option<BridgeRuntime>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(None))
}

fn random_hex_token() -> String {
    let mut seed = Vec::with_capacity(64);
    #[cfg(unix)]
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        let mut buf = [0u8; 32];
        if f.read_exact(&mut buf).is_ok() {
            seed.extend_from_slice(&buf);
        }
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    seed.extend_from_slice(&nanos.to_le_bytes());
    seed.extend_from_slice(&std::process::id().to_le_bytes());
    let c = NEXT_CALL_ID.fetch_add(1, Ordering::Relaxed);
    seed.extend_from_slice(&c.to_le_bytes());
    let digest = Sha256::digest(&seed);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn rpc_secret() -> &'static str {
    RPC_SECRET.get_or_init(|| random_hex_token()[..24].to_string())
}

fn bridge_file_path() -> Option<PathBuf> {
    crate::hostd_config_dir().map(|d| d.join(BRIDGE_FILE))
}

fn write_bridge_file(port: u16, token: &str) {
    let Some(path) = bridge_file_path() else {
        return;
    };
    let payload = json!({
        "port": port,
        "token": token,
        "pid": std::process::id(),
        "updatedAt": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    });
    let text = format!("{}\n", serde_json::to_string_pretty(&payload).unwrap_or_default());
    let _ = write_private_file(&path, text.as_bytes());
}

fn remove_bridge_file() {
    if let Some(path) = bridge_file_path() {
        let _ = fs::remove_file(path);
    }
}

fn write_private_file(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(data)?;
        f.sync_all()?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, data)
    }
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    if ab.len() != bb.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in ab.iter().zip(bb.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn is_enabled() -> bool {
    crate::config::native().plugin_ai_browser
}

pub fn init(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    config_changed(app);
}

pub fn config_changed(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    if is_enabled() {
        start_bridge();
    } else {
        stop_bridge();
        browser::eval_all_panels(app, "window.__hpAi?.cleanup?.();");
    }
    emit_ai_state(app);
}

pub fn on_exit() {
    stop_bridge();
}

fn emit_ai_state(app: &AppHandle) {
    let snap = current_snapshot();
    let _ = app.emit_to("main", EVENT_AI_STATE, snap);
}

pub fn current_snapshot() -> AiBrowserSnapshot {
    let guard = state().lock().unwrap_or_else(|e| e.into_inner());
    AiBrowserSnapshot {
        enabled: is_enabled(),
        backend: "desktop",
        spaces: guard.spaces.clone(),
        active_space_id: guard.active_space_id.clone(),
    }
}

fn start_bridge() {
    let mut slot = bridge_slot().lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some() {
        return;
    }
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else {
        logging::warn("browser", "failed to bind AI browser loopback bridge", Value::Null);
        return;
    };
    let Ok(local_addr) = listener.local_addr() else {
        return;
    };
    let port = local_addr.port();
    let addr = local_addr.to_string();
    let token = random_hex_token();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let expected_token = token.clone();
    write_bridge_file(port, &token);

    let handle = std::thread::spawn(move || {
        for stream in listener.incoming() {
            if stop_flag.load(Ordering::Acquire) {
                break;
            }
            if let Ok(stream) = stream {
                if stop_flag.load(Ordering::Acquire) {
                    break;
                }
                let tok = expected_token.clone();
                std::thread::spawn(move || {
                    handle_http_client(stream, &tok);
                });
            }
        }
    });

    logging::info("browser", "AI browser loopback bridge started", json!({ "port": port }));
    *slot = Some(BridgeRuntime {
        stop,
        addr,
        token,
        handle: Some(handle),
    });
}

fn stop_bridge() {
    let runtime = {
        let mut slot = bridge_slot().lock().unwrap_or_else(|e| e.into_inner());
        slot.take()
    };
    remove_bridge_file();
    if let Some(mut rt) = runtime {
        rt.stop.store(true, Ordering::Release);
        // Unblock accept() cleanly by poking localhost listener once.
        let _ = TcpStream::connect(&rt.addr).and_then(|s| s.shutdown(Shutdown::Both));
        if let Some(h) = rt.handle.take() {
            let _ = h.join();
        }
        logging::info("browser", "AI browser loopback bridge stopped", Value::Null);
    }
}

fn send_http_json(mut stream: TcpStream, status: u16, reason: &str, body: Value) {
    let bytes = serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec());
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(&bytes);
    let _ = stream.flush();
}

fn handle_http_client(mut stream: TcpStream, expected_token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];
    let mut header_end: Option<usize> = None;
    let mut content_length = 0usize;

    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() + n > MAX_HTTP_REQ_BYTES {
                    send_http_json(stream, 413, "Payload Too Large", json!({ "error": "request too large" }));
                    return;
                }
                buf.extend_from_slice(&tmp[..n]);
                if header_end.is_none() {
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        header_end = Some(pos + 4);
                        let hdr_text = String::from_utf8_lossy(&buf[..pos]);
                        for line in hdr_text.lines().skip(1) {
                            if let Some((k, v)) = line.split_once(':') {
                                if k.trim().eq_ignore_ascii_case("content-length") {
                                    content_length = v.trim().parse::<usize>().unwrap_or(0);
                                }
                            }
                        }
                    }
                }
                if let Some(he) = header_end {
                    if buf.len() >= he + content_length {
                        break;
                    }
                }
            }
            Err(_) => return,
        }
    }

    let Some(he) = header_end else {
        send_http_json(stream, 400, "Bad Request", json!({ "error": "invalid http request" }));
        return;
    };
    let hdr_text = String::from_utf8_lossy(&buf[..he - 4]);
    let mut lines = hdr_text.lines();
    let req_line = lines.next().unwrap_or("");
    let mut parts = req_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    let mut auth_header = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("authorization") {
                auth_header = Some(v.trim().to_string());
            }
        }
    }
    let bearer = auth_header
        .as_deref()
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .unwrap_or("");
    if !constant_time_eq(bearer.trim(), expected_token) {
        send_http_json(stream, 401, "Unauthorized", json!({ "error": "invalid token" }));
        return;
    }

    if !is_enabled() {
        send_http_json(stream, 403, "Forbidden", json!({ "error": "plugins.aiBrowser is disabled" }));
        return;
    }

    let Some(app) = APP_HANDLE.get().cloned() else {
        send_http_json(stream, 503, "Service Unavailable", json!({ "error": "desktop app not ready" }));
        return;
    };

    if method == "GET" && path == "/v1/browser/status" {
        send_http_json(stream, 200, "OK", json!(current_snapshot()));
        return;
    }

    if method == "POST" && path == "/v1/browser/act" {
        let body_slice = &buf[he..buf.len().min(he + content_length)];
        let req: BrowserActRequest = match serde_json::from_slice(body_slice) {
            Ok(r) => r,
            Err(e) => {
                send_http_json(stream, 400, "Bad Request", json!({ "error": format!("invalid json: {e}") }));
                return;
            }
        };
        match tauri::async_runtime::block_on(execute_browser_act(&app, req)) {
            Ok(res) => send_http_json(stream, 200, "OK", json!(res)),
            Err(e) => send_http_json(stream, 400, "Bad Request", json!({ "error": e })),
        }
        return;
    }

    send_http_json(stream, 404, "Not Found", json!({ "error": "not found" }));
}

// ---------------------------------------------------------------------------
// Title-channel RPC & base64 decode (no extra Cargo crates needed)
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub struct RpcTitleChunk {
    pub secret: String,
    pub call_id: u64,
    pub index: usize,
    pub total: usize,
    pub data: String,
}

pub fn parse_rpc_title(title: &str) -> Option<RpcTitleChunk> {
    let rest = title.strip_prefix(RPC_TITLE_PREFIX)?;
    let mut parts = rest.splitn(4, ':');
    let secret = parts.next()?.to_string();
    let call_id = parts.next()?.parse::<u64>().ok()?;
    let chunk_spec = parts.next()?;
    let (idx_s, tot_s) = chunk_spec.split_once('/')?;
    let index = idx_s.parse::<usize>().ok()?;
    let total = tot_s.parse::<usize>().ok()?;
    let data = parts.next()?.to_string();
    if total == 0 || total > 64 || index >= total {
        return None;
    }
    Some(RpcTitleChunk {
        secret,
        call_id,
        index,
        total,
        data,
    })
}

fn decode_base64_str(input: &str) -> Result<String, String> {
    fn val(b: u8) -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let clean: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
        .collect();
    let mut out = Vec::with_capacity((clean.len() * 3) / 4);
    let mut i = 0;
    while i + 1 < clean.len() {
        let b0 = val(clean[i]).ok_or_else(|| "invalid base64 char".to_string())?;
        let b1 = val(clean[i + 1]).ok_or_else(|| "invalid base64 char".to_string())?;
        out.push((b0 << 2) | (b1 >> 4));
        if i + 2 < clean.len() {
            let b2 = val(clean[i + 2]).ok_or_else(|| "invalid base64 char".to_string())?;
            out.push((b1 << 4) | (b2 >> 2));
            if i + 3 < clean.len() {
                let b3 = val(clean[i + 3]).ok_or_else(|| "invalid base64 char".to_string())?;
                out.push((b2 << 6) | b3);
            }
        }
        i += 4;
    }
    String::from_utf8(out).map_err(|e| format!("invalid utf8 payload: {e}"))
}

/// Intercepts `\u{200B}__HP_RPC__:` title notifications from child browser webviews.
/// Returns `true` if the title belonged to the internal RPC channel (never emitted to UI).
pub fn on_rpc_title(app: &AppHandle, panel_id: &str, title: &str) -> bool {
    if !title.starts_with(RPC_TITLE_PREFIX) {
        return false;
    }
    let Some(chunk) = parse_rpc_title(title) else {
        return true;
    };
    let mut finished: Option<(tokio::sync::oneshot::Sender<Result<Value, String>>, Result<Value, String>, Option<String>)> = None;
    {
        let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = guard.pending_evals.get_mut(&chunk.call_id) {
            if entry.panel_id == panel_id && constant_time_eq(&entry.secret, &chunk.secret) {
                entry.total = Some(chunk.total);
                entry.chunks.insert(chunk.index, chunk.data);
                if entry.chunks.len() >= chunk.total {
                    let prev_title = entry.prev_title.clone();
                    let mut assembled = String::new();
                    let mut ok = true;
                    for idx in 0..chunk.total {
                        match entry.chunks.get(&idx) {
                            Some(part) => assembled.push_str(part),
                            None => {
                                ok = false;
                                break;
                            }
                        }
                    }
                    let tx = entry.tx.take();
                    guard.pending_evals.remove(&chunk.call_id);
                    if let Some(tx) = tx {
                        let res = if ok {
                            decode_base64_str(&assembled)
                                .and_then(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()))
                        } else {
                            Err("incomplete rpc chunks".into())
                        };
                        finished = Some((tx, res, prev_title));
                    }
                }
            }
        }
    }
    if let Some((tx, res, prev_title)) = finished {
        if let Some(prev) = prev_title {
            let restore = format!("document.title={};", serde_json::to_string(&prev).unwrap_or_else(|_| "\"\"".into()));
            let _ = browser::eval_panel_js(app, panel_id, &restore);
        }
        let _ = tx.send(res);
    }
    true
}

pub async fn eval_panel_rpc(
    app: &AppHandle,
    panel_id: &str,
    async_body_js: &str,
    timeout_ms: u64,
) -> Result<Value, String> {
    if !is_enabled() {
        return Err("AI 浏览器插件未启用".into());
    }
    let call_id = NEXT_CALL_ID.fetch_add(1, Ordering::Relaxed);
    let secret = rpc_secret().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
        guard.pending_evals.insert(
            call_id,
            PendingEval {
                panel_id: panel_id.to_string(),
                secret: secret.clone(),
                prev_title: None,
                chunks: HashMap::new(),
                total: None,
                tx: Some(tx),
            },
        );
    }

    let wrapped = format!(
        r#"(function(){{
  var __prev=document.title||'';
  var __prefix={prefix};
  var __secret={secret};
  var __id={call_id};
  function __send(obj){{
    try{{
      var s=JSON.stringify(obj);
      var b64=btoa(unescape(encodeURIComponent(s)));
      var size=8000;
      var total=Math.max(1,Math.ceil(b64.length/size));
      if(total===1){{
        document.title=__prefix+__secret+':'+__id+':0/1:'+b64;
        setTimeout(function(){{if(document.title.indexOf(__prefix)===0)document.title=__prev;}},24);
      }}else{{
        var idx=0;
        var step=function(){{
          if(idx>=total){{
            setTimeout(function(){{if(document.title.indexOf(__prefix)===0)document.title=__prev;}},24);
            return;
          }}
          var part=b64.slice(idx*size,(idx+1)*size);
          document.title=__prefix+__secret+':'+__id+':'+idx+'/'+total+':'+part;
          idx++;
          setTimeout(step,14);
        }};
        step();
      }}
    }}catch(err){{
      try{{
        var eb=btoa(unescape(encodeURIComponent(JSON.stringify({{ok:false,error:String(err)}}))));
        document.title=__prefix+__secret+':'+__id+':0/1:'+eb;
        setTimeout(function(){{if(document.title.indexOf(__prefix)===0)document.title=__prev;}},24);
      }}catch(_e){{}}
    }}
  }}
  Promise.resolve().then(function(){{ return ({async_body_js})(); }}).then(
    function(res){{ __send({{ok:true,data:res===undefined?null:res}}); }},
    function(err){{ __send({{ok:false,error:String(err&&err.message||err||'eval failed')}}); }}
  );
}})();"#,
        prefix = serde_json::to_string(RPC_TITLE_PREFIX).unwrap_or_else(|_| "\"\"".into()),
        secret = serde_json::to_string(&secret).unwrap_or_else(|_| "\"\"".into()),
    );

    if let Err(e) = browser::eval_panel_js(app, panel_id, &wrapped) {
        let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
        guard.pending_evals.remove(&call_id);
        return Err(e);
    }

    match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
        Ok(Ok(Ok(val))) => {
            if val.get("ok").and_then(Value::as_bool) == Some(true) {
                Ok(val.get("data").cloned().unwrap_or(Value::Null))
            } else {
                Err(val
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("browser script failed")
                    .to_string())
            }
        }
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(_)) => Err("browser eval channel dropped".into()),
        Err(_) => {
            let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
            guard.pending_evals.remove(&call_id);
            Err("浏览器页面脚本响应超时".into())
        }
    }
}

// ---------------------------------------------------------------------------
// In-page Zero-Dep Helper + Visible Virtual Cursor (injected only on demand)
// ---------------------------------------------------------------------------

const AI_HELPER_JS: &str = r###"
(function(){
  if (window.__hpAi && window.__hpAi.__v === 1) return window.__hpAi;
  var refs = new Map();
  var nextRef = 1;
  var cursorEl = null;
  var pillEl = null;
  var spotEl = null;
  var ringEl = null;
  var rootHost = null;
  var fadeTimer = null;

  function ensureOverlay() {
    if (rootHost && document.documentElement.contains(rootHost)) return true;
    if (!document.documentElement) return false;
    var old = document.getElementById('__hp_ai_cursor_root__');
    if (old) old.remove();
    rootHost = document.createElement('div');
    rootHost.id = '__hp_ai_cursor_root__';
    rootHost.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;';
    var shadow = rootHost.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = [
      '.hp-spot{position:fixed;border:2px solid #F27BA6;border-radius:8px;background:rgba(242,123,166,0.10);box-shadow:0 0 0 3px rgba(180,140,240,0.22);transition:all 220ms cubic-bezier(.22,1,.36,1);opacity:0;}',
      '.hp-cursor{position:fixed;left:0;top:0;transform:translate(-100px,-100px);transition:transform 260ms cubic-bezier(.22,1,.36,1),opacity 200ms ease;opacity:0;display:flex;align-items:flex-start;gap:6px;will-change:transform;}',
      '.hp-cursor.on{opacity:1;}',
      '.hp-pill{background:#2A2231;color:#FFF6F9;border:1px solid rgba(242,123,166,0.55);border-radius:999px;padding:4px 10px;font:600 11.5px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;white-space:nowrap;box-shadow:0 6px 18px rgba(42,34,49,0.28);margin-top:14px;}',
      '.hp-ring{position:fixed;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;border:2px solid #F27BA6;opacity:0;transform:scale(0.3);}',
      '@keyframes hpRipple{0%{opacity:.95;transform:scale(.35)}100%{opacity:0;transform:scale(1.85)}}',
      '.hp-ring.pop{animation:hpRipple 420ms ease-out forwards;}'
    ].join('\n');
    shadow.appendChild(style);
    spotEl = document.createElement('div');
    spotEl.className = 'hp-spot';
    shadow.appendChild(spotEl);
    ringEl = document.createElement('div');
    ringEl.className = 'hp-ring';
    shadow.appendChild(ringEl);
    cursorEl = document.createElement('div');
    cursorEl.className = 'hp-cursor';
    cursorEl.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="filter:drop-shadow(0 3px 6px rgba(42,34,49,0.35))"><path d="M4.2 3.2L19.4 10.6L12.6 13.1L10.1 19.8L4.2 3.2Z" fill="#F27BA6" stroke="#FFFFFF" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    pillEl = document.createElement('div');
    pillEl.className = 'hp-pill';
    pillEl.textContent = 'AI';
    cursorEl.appendChild(pillEl);
    shadow.appendChild(cursorEl);
    document.documentElement.appendChild(rootHost);
    return true;
  }

  function showCursor(x, y, label, rect) {
    if (!ensureOverlay()) return;
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    cursorEl.classList.add('on');
    cursorEl.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    pillEl.textContent = (label || 'AI 协作').slice(0, 32);
    if (rect && rect.width > 0 && rect.height > 0) {
      spotEl.style.left = Math.round(rect.left - 2) + 'px';
      spotEl.style.top = Math.round(rect.top - 2) + 'px';
      spotEl.style.width = Math.round(rect.width + 4) + 'px';
      spotEl.style.height = Math.round(rect.height + 4) + 'px';
      spotEl.style.opacity = '1';
    } else {
      spotEl.style.opacity = '0';
    }
    ringEl.style.left = Math.round(x) + 'px';
    ringEl.style.top = Math.round(y) + 'px';
    ringEl.classList.remove('pop');
    void ringEl.offsetWidth;
    ringEl.classList.add('pop');
    fadeTimer = setTimeout(function(){
      if (spotEl) spotEl.style.opacity = '0';
      if (cursorEl) cursorEl.style.opacity = '0.55';
    }, 4500);
  }

  function cleanup() {
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    if (rootHost) { rootHost.remove(); rootHost = null; }
    cursorEl = pillEl = spotEl = ringEl = null;
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    var r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4 && r.bottom >= 0 && r.top <= (window.innerHeight + 60);
  }

  function detectAuthGate() {
    var pw = document.querySelector('input[type="password"]');
    if (pw && isVisible(pw)) return '检测到密码输入框，请由用户手动输入登录凭证';
    var otp = document.querySelector('input[autocomplete="one-time-code"],input[name*="otp" i],input[name*="2fa" i],input[id*="captcha" i],input[name*="captcha" i]');
    if (otp && isVisible(otp)) return '检测到验证码或二次验证输入框，请由用户手动完成';
    var iframes = document.querySelectorAll('iframe[src]');
    for (var i = 0; i < iframes.length; i++) {
      var src = (iframes[i].getAttribute('src') || '').toLowerCase();
      if ((src.indexOf('captcha') >= 0 || src.indexOf('turnstile') >= 0 || src.indexOf('recaptcha') >= 0 || src.indexOf('hcaptcha') >= 0) && isVisible(iframes[i])) {
        return '检测到人机验证组件，请由用户手动完成';
      }
    }
    return null;
  }

  function isSensitiveTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input') {
      var tp = (el.getAttribute('type') || '').toLowerCase();
      var nm = ((el.getAttribute('name') || '') + ' ' + (el.getAttribute('autocomplete') || '') + ' ' + (el.getAttribute('id') || '')).toLowerCase();
      if (tp === 'password') return '检测到密码框，禁止自动填写，请手动登录';
      if (nm.indexOf('one-time-code') >= 0 || nm.indexOf('captcha') >= 0 || nm.indexOf('otp') >= 0 || nm.indexOf('2fa') >= 0) {
        return '检测到验证码或二次验证字段，请手动填写';
      }
    }
    var txt = ((el.innerText || el.getAttribute('aria-label') || '') + '').toLowerCase();
    if (txt.indexOf('verify you are human') >= 0 || txt.indexOf('i am not a robot') >= 0) {
      return '检测到人机校验控件，请手动完成';
    }
    return false;
  }

  function elemLabel(el) {
    var s = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || el.innerText || el.value || '';
    return String(s).replace(/\s+/g, ' ').trim().slice(0, 72);
  }

  function elemRole(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'textarea' || (t === 'input' && !/^(button|submit|reset|checkbox|radio)$/i.test(el.type || ''))) return 'textbox';
    if (t === 'input') return el.type || 'button';
    return t;
  }

  function snapshot() {
    refs.clear();
    nextRef = 1;
    var sel = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="switch"],[role="menuitem"],[role="textbox"],[contenteditable="true"],h1,h2,h3';
    var list = document.querySelectorAll(sel);
    var lines = ['Title: ' + (document.title || '(untitled)'), 'URL: ' + location.href];
    var gate = detectAuthGate();
    if (gate) lines.push('Notice: [HANDOFF_RECOMMENDED] ' + gate);
    var maxItems = 100;
    for (var i = 0; i < list.length && nextRef <= maxItems; i++) {
      var el = list[i];
      if (!isVisible(el)) continue;
      var r = el.getBoundingClientRect();
      var lbl = elemLabel(el);
      var tag = el.tagName.toLowerCase();
      if (!lbl && tag !== 'input' && tag !== 'textarea' && tag !== 'select') continue;
      var id = '@' + (nextRef++);
      refs.set(id, new WeakRef(el));
      var extra = '';
      if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'password') extra = ' [password]';
      else if (typeof el.value === 'string' && el.value && tag !== 'button') extra = ' value=' + JSON.stringify(el.value.slice(0, 40));
      if (el.disabled) extra += ' [disabled]';
      lines.push(id + ' ' + elemRole(el) + ' ' + JSON.stringify(lbl) + extra + ' [' + Math.round(r.left + r.width/2) + ',' + Math.round(r.top + r.height/2) + ']');
    }
    var out = lines.join('\n');
    if (out.length > 7600) out = out.slice(0, 7600) + '\n...(truncated)';
    return { url: location.href, title: document.title || '', authGate: gate, text: out };
  }

  function resolveTarget(target) {
    if (!target) return null;
    var t = String(target).trim();
    if (t.startsWith('@') || /^ref=\d+$/i.test(t)) {
      var key = t.startsWith('@') ? t : '@' + t.slice(4);
      var wr = refs.get(key);
      var el = wr && wr.deref();
      if (el && document.documentElement.contains(el)) return el;
    }
    if (t.startsWith('text=') || t.startsWith('text"')) {
      var want = t.replace(/^text=/, '').replace(/^["']|["']$/g, '').trim().toLowerCase();
      var candidates = document.querySelectorAll('a,button,[role="button"],[role="tab"],label,span,div');
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (!isVisible(c)) continue;
        if (elemLabel(c).toLowerCase().indexOf(want) >= 0) return c;
      }
    }
    try {
      return document.querySelector(t);
    } catch (_) {
      return null;
    }
  }

  function act(op, opts) {
    opts = opts || {};
    if (op === 'snapshot') return snapshot();
    if (op === 'cleanup' || op === 'handoff') {
      cleanup();
      return { url: location.href, title: document.title || '' };
    }
    if (op === 'scroll') {
      var dy = typeof opts.deltaY === 'number' ? opts.deltaY : 480;
      window.scrollBy({ top: dy, behavior: 'smooth' });
      showCursor(window.innerWidth / 2, window.innerHeight / 2, opts.label || (dy >= 0 ? '向下滚动页面' : '向上滚动页面'), null);
      return { url: location.href, title: document.title || '' };
    }
    var el = resolveTarget(opts.target);
    if (!el) throw new Error('未找到目标元素：' + (opts.target || '') + '，请先运行 snapshot 刷新 @ref');
    var gateMsg = isSensitiveTarget(el);
    if (gateMsg) {
      cleanup();
      return { handoff: true, reason: gateMsg, url: location.href, title: document.title || '' };
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    var label = opts.label || (op + ' ' + elemLabel(el)).trim();
    showCursor(cx, cy, label, r);

    if (op === 'hover') {
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: cx, clientY: cy }));
    } else if (op === 'click' || op === 'dblclick') {
      el.focus && el.focus({ preventScroll: true });
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: cx, clientY: cy }));
      el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: cx, clientY: cy }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy }));
      if (typeof el.click === 'function') el.click();
      if (op === 'dblclick') el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: cx, clientY: cy }));
    } else if (op === 'fill') {
      var val = opts.value == null ? '' : String(opts.value);
      el.focus && el.focus({ preventScroll: true });
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, val);
      else if (el.isContentEditable) el.textContent = val;
      else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (op === 'select') {
      var sv = opts.value == null ? '' : String(opts.value);
      el.focus && el.focus({ preventScroll: true });
      for (var j = 0; j < (el.options || []).length; j++) {
        var o = el.options[j];
        if (o.value === sv || o.text.trim() === sv) { el.value = o.value; break; }
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (op === 'press') {
      var key = opts.key || 'Enter';
      el.focus && el.focus({ preventScroll: true });
      el.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: key, bubbles: true }));
      if (key === 'Enter' && el.form && typeof el.form.requestSubmit === 'function') {
        try { el.form.requestSubmit(); } catch (_) {}
      }
    }
    return { url: location.href, title: document.title || '' };
  }

  window.__hpAi = { __v: 1, snapshot: snapshot, act: act, cleanup: cleanup };
  return window.__hpAi;
})()
"###;

fn sanitize_panel_id(space_id: &str, page_label: &str) -> String {
    let sp: String = space_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(16)
        .collect();
    let pg: String = page_label
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(8)
        .collect();
    format!("ai-{}-{}", if sp.is_empty() { "s" } else { &sp }, if pg.is_empty() { "p1" } else { &pg })
}

fn find_space_and_page(
    req_space_id: Option<&str>,
    req_page: Option<&str>,
    create_if_missing: bool,
    status_text: Option<&str>,
) -> Result<(String, String, String), String> {
    let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
    let sid = req_space_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            guard
                .spaces
                .iter()
                .find(|s| s.kind == "ai")
                .map(|s| s.id.clone())
        });

    let space_id = match sid {
        Some(id) => id,
        None if create_if_missing => format!("ai-{}", NEXT_AI_SPACE_NUM.fetch_add(1, Ordering::Relaxed)),
        None => return Err("当前没有进行中的 AI 浏览空间，请先调用 op=open".into()),
    };

    if !guard.spaces.iter().any(|s| s.id == space_id) {
        if !create_if_missing {
            return Err(format!("找不到浏览空间 {space_id}，请先调用 op=open"));
        }
        guard.spaces.push(BrowserSpaceInfo {
            id: space_id.clone(),
            name: if space_id == "default" {
                "默认浏览".into()
            } else {
                format!("AI 任务 · {}", space_id.strip_prefix("ai-").unwrap_or(&space_id))
            },
            kind: if space_id == "default" { "user".into() } else { "ai".into() },
            ownership: "agentWorking".into(),
            status_text: status_text.map(str::to_string),
            handoff_reason: None,
            active_page: Some("p1".into()),
            pages: vec![BrowserPageInfo {
                label: "p1".into(),
                panel_id: sanitize_panel_id(&space_id, "p1"),
                title: "新标签页".into(),
                url: "about:blank".into(),
                active: true,
            }],
        });
    }

    let sp = guard.spaces.iter_mut().find(|s| s.id == space_id).unwrap();
    let page_label = req_page
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| sp.active_page.clone())
        .or_else(|| sp.pages.first().map(|p| p.label.clone()))
        .unwrap_or_else(|| "p1".into());

    if !sp.pages.iter().any(|p| p.label == page_label) {
        for p in &mut sp.pages {
            p.active = false;
        }
        sp.pages.push(BrowserPageInfo {
            label: page_label.clone(),
            panel_id: sanitize_panel_id(&space_id, &page_label),
            title: "新标签页".into(),
            url: "about:blank".into(),
            active: true,
        });
    } else {
        for p in &mut sp.pages {
            p.active = p.label == page_label;
        }
    }
    sp.active_page = Some(page_label.clone());
    let panel_id = sp
        .pages
        .iter()
        .find(|p| p.label == page_label)
        .map(|p| p.panel_id.clone())
        .unwrap_or_else(|| sanitize_panel_id(&space_id, &page_label));
    guard.active_space_id = Some(space_id.clone());
    Ok((space_id, page_label, panel_id))
}

pub async fn execute_browser_act(app: &AppHandle, req: BrowserActRequest) -> Result<BrowserActResponse, String> {
    if !is_enabled() {
        return Err("AI 浏览器协作插件默认关闭，请在 设置 › 插件中心 按需启用".into());
    }
    let op = req.op.trim().to_string();
    let is_open = op == "open";
    let (space_id, page_label, panel_id) = find_space_and_page(
        req.space_id.as_deref(),
        req.page.as_deref(),
        is_open,
        req.label.as_deref(),
    )?;

    if op == "finish" {
        let doomed_panels: Vec<String> = {
            let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
            let mut close_ids = Vec::new();
            let keep_set: Vec<String> = req.keep.clone().unwrap_or_default();
            if let Some(pos) = guard.spaces.iter().position(|s| s.id == space_id) {
                let sp = &guard.spaces[pos];
                for pg in &sp.pages {
                    if !keep_set.contains(&pg.label) {
                        close_ids.push(pg.panel_id.clone());
                    }
                }
                if sp.kind == "ai" && keep_set.is_empty() {
                    guard.spaces.remove(pos);
                    if guard.active_space_id.as_deref() == Some(&space_id) {
                        guard.active_space_id = Some("default".into());
                    }
                } else if let Some(sp_mut) = guard.spaces.get_mut(pos) {
                    sp_mut.ownership = "user".into();
                    sp_mut.status_text = None;
                    sp_mut.handoff_reason = None;
                    sp_mut.pages.retain(|pg| keep_set.contains(&pg.label));
                }
            }
            close_ids
        };
        for pid in doomed_panels {
            let _ = browser::eval_panel_js(app, &pid, "window.__hpAi?.cleanup?.();");
            let _ = browser::close_panel_sync(app, &pid);
        }
        let _ = app.emit_to("main", EVENT_AI_CMD, json!({ "kind": "finish_space", "spaceId": space_id, "keep": req.keep.unwrap_or_default() }));
        emit_ai_state(app);
        return Ok(BrowserActResponse {
            ok: true,
            space_id,
            page: page_label,
            url: None,
            title: None,
            ownership: "user".into(),
            handoff_reason: None,
            snapshot: None,
            note: Some("已结束本次 AI 浏览会话".into()),
        });
    }

    if op == "handoff" {
        let reason = req.reason.clone().unwrap_or_else(|| "需要你手动完成这一步".into());
        {
            let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(sp) = guard.spaces.iter_mut().find(|s| s.id == space_id) {
                sp.ownership = "agentHandoff".into();
                sp.status_text = Some("等待你的操作".into());
                sp.handoff_reason = Some(reason.clone());
            }
        }
        let _ = browser::eval_panel_js(app, &panel_id, "window.__hpAi?.cleanup?.();");
        emit_ai_state(app);
        return Ok(BrowserActResponse {
            ok: true,
            space_id,
            page: page_label,
            url: browser::panel_url(app, &panel_id),
            title: None,
            ownership: "agentHandoff".into(),
            handoff_reason: Some(reason.clone()),
            snapshot: None,
            note: Some(reason),
        });
    }

    if op == "resume" {
        {
            let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(sp) = guard.spaces.iter_mut().find(|s| s.id == space_id) {
                sp.ownership = "agentWorking".into();
                sp.handoff_reason = None;
                sp.status_text = Some(req.label.clone().unwrap_or_else(|| "已交还 AI 继续".into()));
            }
        }
        emit_ai_state(app);
        return Ok(BrowserActResponse {
            ok: true,
            space_id,
            page: page_label,
            url: browser::panel_url(app, &panel_id),
            title: None,
            ownership: "agentWorking".into(),
            handoff_reason: None,
            snapshot: None,
            note: Some("AI 已恢复对该浏览空间的操作权".into()),
        });
    }

    // Check user takeover lock for interactive ops (except explicit open)
    if !is_open {
        let cur_owner = {
            let guard = state().lock().unwrap_or_else(|e| e.into_inner());
            guard
                .spaces
                .iter()
                .find(|s| s.id == space_id)
                .map(|s| s.ownership.clone())
                .unwrap_or_else(|| "user".into())
        };
        if cur_owner == "user" && op != "snapshot" {
            return Ok(BrowserActResponse {
                ok: false,
                space_id,
                page: page_label,
                url: browser::panel_url(app, &panel_id),
                title: None,
                ownership: "user".into(),
                handoff_reason: None,
                snapshot: None,
                note: Some("你已接管该空间，AI 已暂停操作（可点击“已完成，交还 AI”或调用 resume 恢复）".into()),
            });
        }
        if cur_owner == "agentHandoff" && op != "snapshot" {
            return Ok(BrowserActResponse {
                ok: false,
                space_id,
                page: page_label,
                url: browser::panel_url(app, &panel_id),
                title: None,
                ownership: "agentHandoff".into(),
                handoff_reason: None,
                snapshot: None,
                note: Some("正在等待用户完成当前步骤，请先由用户点击“已完成，交还 AI”".into()),
            });
        }
    }

    let action_label = req.label.clone().unwrap_or_else(|| match op.as_str() {
        "open" => "正在打开网页".into(),
        "snapshot" => "正在读取页面结构".into(),
        "click" => format!("点击 {}", req.target.as_deref().unwrap_or("元素")),
        "dblclick" => format!("双击 {}", req.target.as_deref().unwrap_or("元素")),
        "hover" => format!("悬停 {}", req.target.as_deref().unwrap_or("元素")),
        "fill" => format!("输入 {}", req.target.as_deref().unwrap_or("文本框")),
        "select" => format!("选择 {}", req.target.as_deref().unwrap_or("选项")),
        "press" => format!("按键 {}", req.key.as_deref().unwrap_or("Enter")),
        "scroll" => "滚动页面".into(),
        _ => op.clone(),
    });

    if is_open {
        let target_url = req.url.clone().unwrap_or_else(|| "about:blank".into());
        {
            let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
            if let Some(sp) = guard.spaces.iter_mut().find(|s| s.id == space_id) {
                sp.ownership = "agentWorking".into();
                sp.handoff_reason = None;
                sp.status_text = Some(action_label.clone());
                if let Some(pg) = sp.pages.iter_mut().find(|p| p.label == page_label) {
                    pg.url = target_url.clone();
                }
            }
        }
        let _ = app.emit_to(
            "main",
            EVENT_AI_CMD,
            json!({
                "kind": "open_space",
                "spaceId": space_id,
                "pageLabel": page_label,
                "panelId": panel_id,
                "url": target_url,
                "statusText": action_label,
            }),
        );
        emit_ai_state(app);

        // Wait up to 1.8s for React WebPane to mount the panel at its measured bounds, otherwise create offscreen panel cleanly.
        let deadline = Instant::now() + Duration::from_millis(1800);
        while !browser::panel_exists(app, &panel_id) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        if !browser::panel_exists(app, &panel_id) {
            browser::open_headless_panel(app, &panel_id, &target_url)?;
        } else if target_url != "about:blank" {
            let cur = browser::panel_url(app, &panel_id).unwrap_or_default();
            if cur != target_url {
                let _ = browser::navigate_panel_sync(app, &panel_id, &target_url);
            }
        }
        // Brief settle for initial DOM commit before returning URL & status
        tokio::time::sleep(Duration::from_millis(450)).await;
        let final_url = browser::panel_url(app, &panel_id).or(Some(target_url));
        {
            let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
            if let (Some(u), Some(sp)) = (&final_url, guard.spaces.iter_mut().find(|s| s.id == space_id)) {
                if let Some(pg) = sp.pages.iter_mut().find(|p| p.label == page_label) {
                    pg.url = u.clone();
                }
            }
        }
        emit_ai_state(app);
        return Ok(BrowserActResponse {
            ok: true,
            space_id,
            page: page_label,
            url: final_url,
            title: None,
            ownership: "agentWorking".into(),
            handoff_reason: None,
            snapshot: None,
            note: None,
        });
    }

    if !browser::panel_exists(app, &panel_id) {
        return Err(format!("页面 {space_id}/{page_label} 尚未打开，请先调用 op=open"));
    }

    {
        let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sp) = guard.spaces.iter_mut().find(|s| s.id == space_id) {
            if sp.ownership == "agentWorking" {
                sp.status_text = Some(action_label.clone());
            }
        }
    }
    emit_ai_state(app);

    let opts = json!({
        "target": req.target,
        "value": req.value,
        "key": req.key,
        "deltaY": req.delta_y,
        "label": action_label,
    });
    let op_lit = serde_json::to_string(&op).unwrap_or_else(|_| "\"snapshot\"".into());
    let opts_lit = serde_json::to_string(&opts).unwrap_or_else(|_| "{}".into());
    let script = format!(
        "function(){{ var h = {AI_HELPER_JS}; return h.act({op_lit}, {opts_lit}); }}"
    );

    let data = eval_panel_rpc(app, &panel_id, &script, DEFAULT_EVAL_TIMEOUT_MS).await?;
    let hit_handoff = data.get("handoff").and_then(Value::as_bool) == Some(true);
    let url = data.get("url").and_then(Value::as_str).map(str::to_string);
    let title = data.get("title").and_then(Value::as_str).map(str::to_string);
    let snapshot = data.get("text").and_then(Value::as_str).map(str::to_string);
    let reason = data.get("reason").and_then(Value::as_str).map(str::to_string);

    let mut ownership = "agentWorking".to_string();
    {
        let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(sp) = guard.spaces.iter_mut().find(|s| s.id == space_id) {
            if hit_handoff {
                sp.ownership = "agentHandoff".into();
                sp.handoff_reason = reason.clone();
                sp.status_text = Some("需要你协助完成验证/登录".into());
            } else if op == "snapshot" && sp.ownership == "user" {
                // Keep user ownership intact on read-only snapshot.
            }
            ownership = sp.ownership.clone();
            if let Some(pg) = sp.pages.iter_mut().find(|p| p.label == page_label) {
                if let Some(u) = &url {
                    pg.url = u.clone();
                }
                if let Some(t) = &title {
                    if !t.is_empty() {
                        pg.title = t.clone();
                    }
                }
            }
        }
    }
    emit_ai_state(app);

    Ok(BrowserActResponse {
        ok: !hit_handoff,
        space_id,
        page: page_label,
        url,
        title,
        ownership,
        handoff_reason: reason.clone(),
        snapshot,
        note: reason,
    })
}

// ---------------------------------------------------------------------------
// Tauri Commands called by React UI
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn browser_ai_state() -> AiBrowserSnapshot {
    current_snapshot()
}

#[tauri::command]
pub fn browser_sync_spaces(app: AppHandle, spaces: Vec<BrowserSpaceInfo>, active_space_id: Option<String>) {
    {
        let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
        // Preserve authoritative AI ownership/status for active AI spaces while accepting React user spaces.
        let ai_prev: HashMap<String, BrowserSpaceInfo> = guard
            .spaces
            .iter()
            .filter(|s| s.kind == "ai")
            .map(|s| (s.id.clone(), s.clone()))
            .collect();
        let mut merged = Vec::with_capacity(spaces.len());
        for mut sp in spaces {
            if sp.kind == "ai" {
                if let Some(prev) = ai_prev.get(&sp.id) {
                    sp.ownership = prev.ownership.clone();
                    sp.status_text = prev.status_text.clone();
                    sp.handoff_reason = prev.handoff_reason.clone();
                }
            }
            merged.push(sp);
        }
        if !merged.is_empty() {
            guard.spaces = merged;
        }
        if let Some(id) = active_space_id {
            guard.active_space_id = Some(id);
        }
    }
    emit_ai_state(&app);
}

#[tauri::command]
pub fn browser_ai_control(
    app: AppHandle,
    space_id: String,
    action: String,
    reason: Option<String>,
) -> AiBrowserSnapshot {
    let cleanup_panels: Vec<String> = {
        let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
        let mut to_clean = Vec::new();
        if action == "close_space" {
            if let Some(pos) = guard.spaces.iter().position(|s| s.id == space_id) {
                to_clean.extend(guard.spaces[pos].pages.iter().map(|p| p.panel_id.clone()));
                guard.spaces.remove(pos);
            }
            if guard.active_space_id.as_deref() == Some(space_id.as_str()) {
                guard.active_space_id = Some("default".into());
            }
        } else if let Some(sp) = guard.spaces.iter_mut().find(|s| s.id == space_id) {
            match action.as_str() {
                "takeover" => {
                    sp.ownership = "user".into();
                    sp.status_text = Some("已由你接管".into());
                    sp.handoff_reason = None;
                    to_clean.extend(sp.pages.iter().map(|p| p.panel_id.clone()));
                }
                "resume" => {
                    sp.ownership = "agentWorking".into();
                    sp.handoff_reason = None;
                    sp.status_text = Some("已交还 AI，等待下一步指令".into());
                }
                "handoff" => {
                    sp.ownership = "agentHandoff".into();
                    sp.handoff_reason = reason.or_else(|| Some("需要你确认或手动操作".into()));
                    sp.status_text = Some("等待你的操作".into());
                    to_clean.extend(sp.pages.iter().map(|p| p.panel_id.clone()));
                }
                _ => {}
            }
        }
        to_clean
    };
    for pid in cleanup_panels {
        let _ = browser::eval_panel_js(&app, &pid, "window.__hpAi?.cleanup?.();");
    }
    emit_ai_state(&app);
    current_snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rpc_title_chunks_and_decodes_base64_utf8() {
        let secret = "abc123def456";
        let payload = "{\"ok\":true,\"data\":{\"text\":\"登录 测试\"}}";
        // btoa equivalent for UTF-8
        let encoded = "eyJvayI6dHJ1ZSwiZGF0YSI6eyJ0ZXh0Ijoi55m75b2VIOa1i+ivlSJ9fQ==";
        let full = format!("{RPC_TITLE_PREFIX}{secret}:42:0/1:{encoded}");
        let parsed = parse_rpc_title(&full).expect("valid chunk");
        assert_eq!(parsed.secret, secret);
        assert_eq!(parsed.call_id, 42);
        assert_eq!(parsed.index, 0);
        assert_eq!(parsed.total, 1);
        assert_eq!(decode_base64_str(&parsed.data).unwrap(), payload);
    }

    #[test]
    fn rejects_malformed_or_overflow_chunk_specs() {
        assert!(parse_rpc_title("Normal Page Title").is_none());
        assert!(parse_rpc_title(&format!("{RPC_TITLE_PREFIX}sec:1:2/2:AA==")).is_none());
        assert!(parse_rpc_title(&format!("{RPC_TITLE_PREFIX}sec:1:0/0:AA==")).is_none());
        assert!(parse_rpc_title(&format!("{RPC_TITLE_PREFIX}sec:1:0/99:AA==")).is_none());
    }

    #[test]
    fn sanitizes_panel_ids_safely() {
        assert_eq!(sanitize_panel_id("ai-1", "p1"), "ai-ai-1-p1");
        assert_eq!(sanitize_panel_id("../evil/id", "p/2"), "ai-evilid-p2");
    }
}
