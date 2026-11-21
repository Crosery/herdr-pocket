//! Direct framed `hc connect` bridge for terminals running on this computer.
//!
//! When the user views a local `hc` terminal on the desktop app, going straight
//! through `hc connect` (same binary frame wire protocol as `apps/hostd/src/hcscreen.ts`)
//! eliminates the round-trip through the remote relay and keeps keystrokes & PTY paints local.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const KIND_DATA: u8 = 0;
const KIND_CREDIT: u8 = 1;
const KIND_CLOSE: u8 = 2;
const KIND_RESIZE: u8 = 3;
const KIND_FOCUS: u8 = 4;
const KIND_FACTS: u8 = 5;
const KIND_AUTOMATIC_INPUT: u8 = 6;
const HEADER_LEN: usize = 9;

const INITIAL_CREDIT_BYTES: u32 = 16 * 1024 * 1024;
const CREDIT_ACK_STEP: usize = 4 * 1024 * 1024;
const MAX_EARLY_FRAMES: usize = 4096;
const MAX_EARLY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAttachResult {
    pub channel: u32,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCreateShellResult {
    pub terminal: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataEvent {
    id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseEvent {
    id: String,
}

pub fn encode_frame(channel: u32, kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len());
    out.extend_from_slice(&channel.to_le_bytes());
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn decode_header(buf: &[u8; HEADER_LEN]) -> (u32, u8, usize) {
    let channel = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
    let kind = buf[4];
    let len = u32::from_le_bytes([buf[5], buf[6], buf[7], buf[8]]) as usize;
    (channel, kind, len)
}

pub fn encode_resize_payload(cols: u16, rows: u16) -> [u8; 4] {
    let mut buf = [0u8; 4];
    buf[0..2].copy_from_slice(&cols.to_le_bytes());
    buf[2..4].copy_from_slice(&rows.to_le_bytes());
    buf
}

fn clamp_cols(v: u16) -> u16 {
    v.clamp(20, 500)
}

fn clamp_rows(v: u16) -> u16 {
    v.clamp(5, 200)
}

fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

fn sanitize_display(d: Option<&Value>) -> Option<Value> {
    let obj = d?.as_object()?;
    let mut out = serde_json::Map::new();
    for key in ["fg", "bg", "cursor"] {
        if let Some(v) = obj.get(key).and_then(Value::as_str) {
            if is_hex_color(v) {
                out.insert(key.into(), json!(v));
            }
        }
    }
    if let Some(cell) = obj.get("cell").and_then(Value::as_array) {
        if cell.len() == 2 {
            if let (Some(w), Some(h)) = (cell[0].as_u64(), cell[1].as_u64()) {
                let cw = w.clamp(1, 200);
                let ch = h.clamp(1, 200);
                out.insert("cell".into(), json!([cw, ch]));
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

pub fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= input.len() {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(TABLE[((n >> 6) & 63) as usize] as char);
        out.push(TABLE[(n & 63) as usize] as char);
        i += 3;
    }
    match input.len() - i {
        1 => {
            let n = (input[i] as u32) << 16;
            out.push(TABLE[((n >> 18) & 63) as usize] as char);
            out.push(TABLE[((n >> 12) & 63) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
            out.push(TABLE[((n >> 18) & 63) as usize] as char);
            out.push(TABLE[((n >> 12) & 63) as usize] as char);
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

enum ReplyTarget {
    Channel0(std::sync::mpsc::Sender<Result<Value, String>>),
}

struct Attachment {
    channel: u32,
    consumed: usize,
    automatic_input: bool,
}

struct PreattachedChannel {
    channel: u32,
    cols: u16,
    rows: u16,
    automatic_input: bool,
    created_at: Instant,
}

#[derive(Default)]
struct EarlyBuffer {
    bytes: usize,
    frames: Vec<(u8, Vec<u8>)>,
}

struct SharedState {
    stdin: ChildStdin,
    child: Child,
    next_id: u64,
    replies: HashMap<u64, ReplyTarget>,
    by_channel: HashMap<u32, String>,
    by_id: HashMap<String, Attachment>,
    preattached: HashMap<String, PreattachedChannel>,
    early: HashMap<u32, EarlyBuffer>,
    supports_automatic_input: bool,
    alive: bool,
}

impl SharedState {
    fn write_frame(&mut self, channel: u32, kind: u8, payload: &[u8]) -> Result<(), String> {
        let bytes = encode_frame(channel, kind, payload);
        self.stdin
            .write_all(&bytes)
            .map_err(|e| format!("hc stdin write failed: {e}"))?;
        self.stdin
            .flush()
            .map_err(|e| format!("hc stdin flush failed: {e}"))
    }
}

struct ClientHandle {
    state: Arc<Mutex<SharedState>>,
    app: AppHandle,
}

fn global_client() -> &'static Mutex<Option<Arc<ClientHandle>>> {
    static CLIENT: OnceLock<Mutex<Option<Arc<ClientHandle>>>> = OnceLock::new();
    CLIENT.get_or_init(|| Mutex::new(None))
}

fn spawn_client(app: &AppHandle) -> Result<Arc<ClientHandle>, String> {
    let hc_bin = crate::find_program_path("hc")
        .ok_or_else(|| "这台电脑没有安装 hc（herdr-core）".to_string())?;
    let mut cmd = Command::new(&hc_bin);
    cmd.arg("connect")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 {} connect: {e}", hc_bin.display()))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "hc connect 没有 stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "hc connect 没有 stdout".to_string())?;

    let hello = "{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"hello\",\"params\":{\"framed\":true}}\n";
    stdin
        .write_all(hello.as_bytes())
        .map_err(|e| format!("hc hello 写入失败: {e}"))?;
    stdin.flush().map_err(|e| format!("hc hello flush 失败: {e}"))?;

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("hc hello 读取失败: {e}"))?;
    let parsed: Value =
        serde_json::from_str(&line).map_err(|e| format!("hc hello 返回无效 JSON: {e}"))?;
    if let Some(err_msg) = parsed.pointer("/error/message").and_then(Value::as_str) {
        let _ = child.kill();
        return Err(err_msg.to_string());
    }
    let supports_automatic_input = parsed
        .pointer("/result/features")
        .and_then(Value::as_array)
        .is_some_and(|features| {
            features
                .iter()
                .any(|f| f.as_str() == Some("automatic_input"))
        });

    let state = Arc::new(Mutex::new(SharedState {
        stdin,
        child,
        next_id: 1,
        replies: HashMap::new(),
        by_channel: HashMap::new(),
        by_id: HashMap::new(),
        preattached: HashMap::new(),
        early: HashMap::new(),
        supports_automatic_input,
        alive: true,
    }));
    let handle = Arc::new(ClientHandle {
        state: Arc::clone(&state),
        app: app.clone(),
    });

    let app_clone = app.clone();
    let weak_handle = Arc::downgrade(&handle);
    thread::Builder::new()
        .name("hc-framed-reader".into())
        .spawn(move || {
            let mut hdr = [0u8; HEADER_LEN];
            loop {
                if reader.read_exact(&mut hdr).is_err() {
                    break;
                }
                let (channel, kind, len) = decode_header(&hdr);
                if len > 64 * 1024 * 1024 {
                    break;
                }
                let mut payload = vec![0u8; len];
                if len > 0 && reader.read_exact(&mut payload).is_err() {
                    break;
                }
                if channel == 0 {
                    if kind == KIND_DATA {
                        if let Ok(msg) = serde_json::from_slice::<Value>(&payload) {
                            if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                                let target = state.lock().ok().and_then(|mut s| s.replies.remove(&id));
                                if let Some(ReplyTarget::Channel0(tx)) = target {
                                    if let Some(err) = msg.pointer("/error/message").and_then(Value::as_str) {
                                        let _ = tx.send(Err(err.to_string()));
                                    } else {
                                        let _ = tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
                                    }
                                }
                            }
                        }
                    }
                    continue;
                }

                enum Action {
                    EmitData(String, Vec<u8>, Option<usize>),
                    EmitClose(String),
                    None,
                }
                let action = {
                    let Ok(mut s) = state.lock() else { break };
                    if let Some(att_id) = s.by_channel.get(&channel).cloned() {
                        match kind {
                            KIND_DATA => {
                                let credit_ack = s.by_id.get_mut(&att_id).and_then(|att| {
                                    att.consumed += payload.len();
                                    if att.consumed >= CREDIT_ACK_STEP {
                                        let ack = att.consumed;
                                        att.consumed = 0;
                                        Some(ack)
                                    } else {
                                        None
                                    }
                                });
                                Action::EmitData(att_id, payload, credit_ack)
                            }
                            KIND_CLOSE => {
                                s.by_channel.remove(&channel);
                                s.by_id.remove(&att_id);
                                Action::EmitClose(att_id)
                            }
                            _ => Action::None,
                        }
                    } else {
                        let buf = s.early.entry(channel).or_default();
                        if buf.frames.len() < MAX_EARLY_FRAMES
                            && buf.bytes.saturating_add(payload.len()) <= MAX_EARLY_BYTES
                        {
                            buf.bytes += payload.len();
                            buf.frames.push((kind, payload));
                        }
                        Action::None
                    }
                };

                match action {
                    Action::EmitData(id, bytes, credit_ack) => {
                        if let Some(ack) = credit_ack {
                            if let Ok(mut s) = state.lock() {
                                let _ = s.write_frame(channel, KIND_CREDIT, &(ack as u32).to_le_bytes());
                            }
                        }
                        if !bytes.is_empty() {
                            let _ = app_clone.emit(
                                "local-term://data",
                                DataEvent {
                                    id,
                                    data: base64_encode(&bytes),
                                },
                            );
                        }
                    }
                    Action::EmitClose(id) => {
                        let _ = app_clone.emit("local-term://close", CloseEvent { id });
                    }
                    Action::None => {}
                }
            }

            let closed_ids: Vec<String> = {
                if let Ok(mut s) = state.lock() {
                    s.alive = false;
                    for (_, target) in s.replies.drain() {
                        let ReplyTarget::Channel0(tx) = target;
                        let _ = tx.send(Err("hc connect 已断开".into()));
                    }
                    s.by_channel.clear();
                    s.preattached.clear();
                    s.early.clear();
                    s.by_id.drain().map(|(id, _)| id).collect()
                } else {
                    Vec::new()
                }
            };
            for id in closed_ids {
                let _ = app_clone.emit("local-term://close", CloseEvent { id });
            }
            if let Some(strong) = weak_handle.upgrade() {
                if let Ok(mut slot) = global_client().lock() {
                    if slot.as_ref().is_some_and(|c| Arc::ptr_eq(c, &strong)) {
                        *slot = None;
                    }
                }
            }
            let _ = state.lock().map(|mut s| s.child.kill());
        })
        .map_err(|e| format!("无法创建 hc 读取线程: {e}"))?;

    Ok(handle)
}

fn ensure_client(app: &AppHandle) -> Result<Arc<ClientHandle>, String> {
    let mut guard = global_client()
        .lock()
        .map_err(|_| "local_term lock poisoned".to_string())?;
    if let Some(existing) = guard.as_ref() {
        let alive = existing.state.lock().map(|s| s.alive).unwrap_or(false);
        if alive {
            return Ok(Arc::clone(existing));
        }
        *guard = None;
    }
    let created = spawn_client(app)?;
    *guard = Some(Arc::clone(&created));
    Ok(created)
}

pub fn warmup(app: &AppHandle) {
    let app = app.clone();
    let _ = thread::Builder::new()
        .name("hc-warmup".into())
        .spawn(move || {
            let _ = ensure_client(&app);
        });
}

fn expand_local_cwd(raw: Option<&str>) -> Result<String, String> {
    let trimmed = raw.map(str::trim).unwrap_or("");
    let path = if trimmed.is_empty() {
        crate::home_dir().ok_or_else(|| "无法确定本机主目录".to_string())?
    } else if trimmed == "~" {
        crate::home_dir().ok_or_else(|| "无法确定本机主目录".to_string())?
    } else if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| {
        if cfg!(windows) {
            trimmed.strip_prefix("~\\")
        } else {
            None
        }
    }) {
        crate::home_dir()
            .ok_or_else(|| "无法确定本机主目录".to_string())?
            .join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    let canon = std::fs::canonicalize(&path).map_err(|_| format!("本地文件夹不存在: {}", path.display()))?;
    if !canon.is_dir() {
        return Err(format!("目标不是文件夹: {}", canon.display()));
    }
    Ok(canon.to_string_lossy().into_owned())
}

fn call_channel0(client: &ClientHandle, method: &str, params: Value) -> Result<Value, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let req_bytes = {
        let mut s = client
            .state
            .lock()
            .map_err(|_| "hc state lock poisoned".to_string())?;
        if !s.alive {
            return Err("hc connect 已退出".into());
        }
        let id = s.next_id;
        s.next_id += 1;
        s.replies.insert(id, ReplyTarget::Channel0(tx));
        let payload = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .map_err(|e| e.to_string())?;
        if let Err(err) = s.write_frame(0, KIND_DATA, &payload) {
            s.replies.remove(&id);
            return Err(err);
        }
        id
    };
    match rx.recv_timeout(std::time::Duration::from_secs(8)) {
        Ok(res) => res,
        Err(_) => {
            if let Ok(mut s) = client.state.lock() {
                s.replies.remove(&req_bytes);
            }
            Err(format!("{method}: 等待 hc 响应超时"))
        }
    }
}

#[tauri::command]
pub async fn local_term_create_shell(
    app: AppHandle,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    display: Option<Value>,
    space_name: Option<String>,
) -> Result<LocalCreateShellResult, String> {
    let c = clamp_cols(cols);
    let r = clamp_rows(rows);
    let sanitized_display = sanitize_display(display.as_ref());
    tauri::async_runtime::spawn_blocking(move || {
        let resolved_cwd = expand_local_cwd(cwd.as_deref())?;
        let client = ensure_client(&app)?;

        let mut params = serde_json::Map::new();
        params.insert("cwd".into(), json!(resolved_cwd));
        params.insert("size".into(), json!({ "cols": c, "rows": r }));
        params.insert("keep".into(), json!(true));
        params.insert("no_parent".into(), json!(true));
        if let Some(sp) = space_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            params.insert("labels".into(), json!({ "where": sp }));
        }
        if let Some(ref d) = sanitized_display {
            params.insert("display".into(), d.clone());
        }

        let res = call_channel0(&client, "terminal.run", Value::Object(params))?;
        let terminal = res
            .get("address")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "hc terminal.run 缺少 address".to_string())?
            .to_string();
        let ret_cwd = res
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .unwrap_or(resolved_cwd);
        let ret_cols = res
            .get("cols")
            .and_then(Value::as_u64)
            .and_then(|v| u16::try_from(v).ok())
            .unwrap_or(c);
        let ret_rows = res
            .get("rows")
            .and_then(Value::as_u64)
            .and_then(|v| u16::try_from(v).ok())
            .unwrap_or(r);

        // Immediately attach before startup shells/fastfetch emit Kitty APC sequences or prompt bytes.
        let mut attach_params = serde_json::Map::new();
        attach_params.insert("terminal".into(), json!(terminal));
        attach_params.insert("cols".into(), json!(ret_cols));
        attach_params.insert("rows".into(), json!(ret_rows));
        attach_params.insert("history".into(), json!(4000));
        attach_params.insert("observe".into(), json!(false));
        if let Some(d) = sanitized_display {
            attach_params.insert("display".into(), d);
        }
        if let Ok(att_res) = call_channel0(&client, "terminal.attach", Value::Object(attach_params)) {
            if let Some(ch) = att_res
                .get("channel")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
            {
                let att_cols = att_res
                    .pointer("/terminal/cols")
                    .and_then(Value::as_u64)
                    .and_then(|v| u16::try_from(v).ok())
                    .unwrap_or(ret_cols);
                let att_rows = att_res
                    .pointer("/terminal/rows")
                    .and_then(Value::as_u64)
                    .and_then(|v| u16::try_from(v).ok())
                    .unwrap_or(ret_rows);
                let att_auto_input = att_res
                    .get("automatic_input")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if let Ok(mut s) = client.state.lock() {
                    let automatic_input = s.supports_automatic_input && att_auto_input;
                    let stale_keys: Vec<String> = s
                        .preattached
                        .iter()
                        .filter(|(_, p)| p.created_at.elapsed() >= Duration::from_secs(30))
                        .map(|(k, _)| k.clone())
                        .collect();
                    for k in stale_keys {
                        if let Some(old) = s.preattached.remove(&k) {
                            s.early.remove(&old.channel);
                            let _ = s.write_frame(old.channel, KIND_CLOSE, &[]);
                        }
                    }
                    if let Some(old) = s.preattached.insert(
                        terminal.clone(),
                        PreattachedChannel {
                            channel: ch,
                            cols: att_cols,
                            rows: att_rows,
                            automatic_input,
                            created_at: Instant::now(),
                        },
                    ) {
                        s.early.remove(&old.channel);
                        let _ = s.write_frame(old.channel, KIND_CLOSE, &[]);
                    }
                    let _ = s.write_frame(ch, KIND_CREDIT, &INITIAL_CREDIT_BYTES.to_le_bytes());
                }
            }
        }

        Ok(LocalCreateShellResult {
            terminal,
            cwd: ret_cwd,
            cols: ret_cols,
            rows: ret_rows,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_term_attach(
    app: AppHandle,
    id: String,
    terminal: String,
    cols: u16,
    rows: u16,
    history: u32,
    display: Option<Value>,
) -> Result<LocalAttachResult, String> {
    let c = clamp_cols(cols);
    let r = clamp_rows(rows);
    let sanitized_display = sanitize_display(display.as_ref());
    tauri::async_runtime::spawn_blocking(move || {
        let client = ensure_client(&app)?;

        let adopted = {
            let mut s = client
                .state
                .lock()
                .map_err(|_| "hc state lock poisoned".to_string())?;
            if let Some(pre) = s.preattached.remove(&terminal) {
                if pre.created_at.elapsed() < Duration::from_secs(30) {
                    s.by_channel.insert(pre.channel, id.clone());
                    let drained = s
                        .early
                        .remove(&pre.channel)
                        .map(|b| b.frames)
                        .unwrap_or_default();
                    let early_bytes: usize = drained
                        .iter()
                        .filter(|(k, _)| *k == KIND_DATA)
                        .map(|(_, p)| p.len())
                        .sum();
                    s.by_id.insert(
                        id.clone(),
                        Attachment {
                            channel: pre.channel,
                            consumed: early_bytes,
                            automatic_input: pre.automatic_input,
                        },
                    );
                    if let Some(ref d) = sanitized_display {
                        if let Ok(bytes) = serde_json::to_vec(d) {
                            let _ = s.write_frame(pre.channel, KIND_FACTS, &bytes);
                        }
                    }
                    let (ret_cols, ret_rows) = if (c, r) != (pre.cols, pre.rows) {
                        let size = encode_resize_payload(c, r);
                        let _ = s.write_frame(pre.channel, KIND_RESIZE, &size);
                        (c, r)
                    } else {
                        (pre.cols, pre.rows)
                    };
                    let _ = s.write_frame(pre.channel, KIND_FOCUS, &[1]);
                    Some((pre.channel, ret_cols, ret_rows, drained))
                } else {
                    s.early.remove(&pre.channel);
                    let _ = s.write_frame(pre.channel, KIND_CLOSE, &[]);
                    None
                }
            } else {
                None
            }
        };

        let (channel, ret_cols, ret_rows, early_frames) = if let Some(hit) = adopted {
            hit
        } else {
            let mut params = serde_json::Map::new();
            params.insert("terminal".into(), json!(terminal));
            params.insert("cols".into(), json!(c));
            params.insert("rows".into(), json!(r));
            params.insert("history".into(), json!(history.min(10_000)));
            params.insert("observe".into(), json!(false));
            if let Some(d) = sanitized_display {
                params.insert("display".into(), d);
            }

            let res = call_channel0(&client, "terminal.attach", Value::Object(params))?;
            let channel = res
                .get("channel")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
                .ok_or_else(|| "hc terminal.attach 缺少 channel".to_string())?;
            let ret_cols = res
                .pointer("/terminal/cols")
                .and_then(Value::as_u64)
                .and_then(|v| u16::try_from(v).ok())
                .unwrap_or(c);
            let ret_rows = res
                .pointer("/terminal/rows")
                .and_then(Value::as_u64)
                .and_then(|v| u16::try_from(v).ok())
                .unwrap_or(r);
            let att_auto_input = res
                .get("automatic_input")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            let early_frames = {
                let mut s = client
                    .state
                    .lock()
                    .map_err(|_| "hc state lock poisoned".to_string())?;
                let automatic_input = s.supports_automatic_input && att_auto_input;
                s.by_channel.insert(channel, id.clone());
                s.by_id.insert(
                    id.clone(),
                    Attachment {
                        channel,
                        consumed: 0,
                        automatic_input,
                    },
                );
                let drained = s
                    .early
                    .remove(&channel)
                    .map(|b| b.frames)
                    .unwrap_or_default();
                s.write_frame(channel, KIND_CREDIT, &INITIAL_CREDIT_BYTES.to_le_bytes())?;
                let _ = s.write_frame(channel, KIND_FOCUS, &[1]);
                drained
            };
            (channel, ret_cols, ret_rows, early_frames)
        };

        let mut closed = false;
        for (kind, payload) in early_frames {
            match kind {
                KIND_DATA if !payload.is_empty() => {
                    let _ = client.app.emit(
                        "local-term://data",
                        DataEvent {
                            id: id.clone(),
                            data: base64_encode(&payload),
                        },
                    );
                }
                KIND_CLOSE => {
                    closed = true;
                }
                _ => {}
            }
        }
        if closed {
            if let Ok(mut s) = client.state.lock() {
                s.by_channel.remove(&channel);
                s.by_id.remove(&id);
            }
            let _ = client.app.emit("local-term://close", CloseEvent { id });
        }

        Ok(LocalAttachResult {
            channel,
            cols: ret_cols,
            rows: ret_rows,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_term_input(id: String, data: String) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let client = {
            let guard = global_client()
                .lock()
                .map_err(|_| "local_term lock poisoned".to_string())?;
            guard
                .as_ref()
                .cloned()
                .ok_or_else(|| "本地终端未连接".to_string())?
        };
        let mut s = client
            .state
            .lock()
            .map_err(|_| "hc state lock poisoned".to_string())?;
        let ch = s
            .by_id
            .get(&id)
            .map(|a| a.channel)
            .ok_or_else(|| "本地终端通道已关闭".to_string())?;
        s.write_frame(ch, KIND_DATA, data.as_bytes())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_term_resize(
    id: String,
    cols: u16,
    rows: u16,
    display: Option<Value>,
) -> Result<(), String> {
    let c = clamp_cols(cols);
    let r = clamp_rows(rows);
    let sanitized_display = sanitize_display(display.as_ref());
    tauri::async_runtime::spawn_blocking(move || {
        let client = {
            let guard = global_client()
                .lock()
                .map_err(|_| "local_term lock poisoned".to_string())?;
            guard
                .as_ref()
                .cloned()
                .ok_or_else(|| "本地终端未连接".to_string())?
        };
        let mut s = client
            .state
            .lock()
            .map_err(|_| "hc state lock poisoned".to_string())?;
        let Some(ch) = s.by_id.get(&id).map(|a| a.channel) else {
            return Ok(());
        };
        if let Some(d) = sanitized_display {
            if let Ok(bytes) = serde_json::to_vec(&d) {
                s.write_frame(ch, KIND_FACTS, &bytes)?;
            }
        }
        let size = encode_resize_payload(c, r);
        s.write_frame(ch, KIND_RESIZE, &size)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_term_focus(id: String, focused: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = {
            let Ok(guard) = global_client().lock() else {
                return Ok(());
            };
            match guard.as_ref().cloned() {
                Some(c) => c,
                None => return Ok(()),
            }
        };
        let mut s = client
            .state
            .lock()
            .map_err(|_| "hc state lock poisoned".to_string())?;
        let Some(ch) = s.by_id.get(&id).map(|a| a.channel) else {
            return Ok(());
        };
        s.write_frame(ch, KIND_FOCUS, &[u8::from(focused)])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_term_auto_input(id: String, data: String) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let client = {
            let guard = global_client()
                .lock()
                .map_err(|_| "local_term lock poisoned".to_string())?;
            guard
                .as_ref()
                .cloned()
                .ok_or_else(|| "本地终端未连接".to_string())?
        };
        let mut s = client
            .state
            .lock()
            .map_err(|_| "hc state lock poisoned".to_string())?;
        let att = s
            .by_id
            .get(&id)
            .ok_or_else(|| "本地终端通道已关闭".to_string())?;
        let ch = att.channel;
        let kind = if att.automatic_input {
            KIND_AUTOMATIC_INPUT
        } else {
            KIND_DATA
        };
        s.write_frame(ch, kind, data.as_bytes())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_term_detach(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = {
            let Ok(guard) = global_client().lock() else {
                return;
            };
            guard.as_ref().cloned()
        };
        let Some(client) = client else { return };
        if let Ok(mut s) = client.state.lock() {
            if let Some(att) = s.by_id.remove(&id) {
                s.by_channel.remove(&att.channel);
                let _ = s.write_frame(att.channel, KIND_CLOSE, &[]);
            }
        };
    })
    .await
    .map_err(|e| e.to_string())
}

pub fn shutdown() {
    let client = global_client()
        .lock()
        .ok()
        .and_then(|mut g| g.take());
    if let Some(client) = client {
        if let Ok(mut s) = client.state.lock() {
            s.alive = false;
            let _ = s.child.kill();
        }
    }
}

const BLOCKED_IMAGE_COMPONENTS: [&str; 5] = [".ssh", ".gnupg", ".aws", ".kube", "keychains"];
const MAX_LOCAL_IMAGE_BYTES: u64 = 128 * 1024 * 1024;
const IMAGE_STAGE_DIR_NAME: &str = "herdr-pocket-term-img";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalImageStat {
    pub url_path: String,
    pub width: u32,
    pub height: u32,
    pub mime: String,
}

fn validate_local_image_path(path: &str) -> Result<(PathBuf, std::fs::Metadata), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("图片路径为空".into());
    }
    let canon = std::fs::canonicalize(trimmed).map_err(|e| format!("无法访问图片路径: {e}"))?;
    for comp in canon.components() {
        let name = comp.as_os_str().to_string_lossy().to_lowercase();
        if BLOCKED_IMAGE_COMPONENTS.contains(&name.as_str()) {
            return Err("拒绝读取受保护目录".into());
        }
    }
    let meta = std::fs::metadata(&canon).map_err(|e| format!("无法读取图片信息: {e}"))?;
    if !meta.is_file() {
        return Err("目标不是常规文件".into());
    }
    if meta.len() == 0 || meta.len() > MAX_LOCAL_IMAGE_BYTES {
        return Err("图片大小超出限制".into());
    }
    Ok((canon, meta))
}

fn sniff_jpeg_dimensions_64(head: &[u8]) -> (u32, u32) {
    let mut i = 2;
    while i + 1 < head.len() {
        if head[i] != 0xff {
            i += 1;
            continue;
        }
        while i < head.len() && head[i] == 0xff {
            i += 1;
        }
        if i >= head.len() {
            break;
        }
        let marker = head[i];
        i += 1;
        // Standalone markers (TEM, RST0..RST7, SOI, EOI) carry no length field.
        if matches!(marker, 0x00 | 0x01 | 0xd0..=0xd9) {
            continue;
        }
        if matches!(
            marker,
            0xc0 | 0xc1 | 0xc2 | 0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf
        ) {
            if i + 7 <= head.len() {
                let h = u16::from_be_bytes([head[i + 3], head[i + 4]]) as u32;
                let w = u16::from_be_bytes([head[i + 5], head[i + 6]]) as u32;
                return (w, h);
            }
            break;
        }
        if i + 2 <= head.len() {
            let seg_len = u16::from_be_bytes([head[i], head[i + 1]]) as usize;
            if seg_len < 2 {
                break;
            }
            i += seg_len;
        } else {
            break;
        }
    }
    (0, 0)
}

fn sniff_image_header_64(
    head: &[u8],
    file_name: &str,
) -> Option<(&'static str, &'static str, u32, u32)> {
    if head.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        let (w, h) = if head.len() >= 24 && &head[12..16] == b"IHDR" {
            (
                u32::from_be_bytes([head[16], head[17], head[18], head[19]]),
                u32::from_be_bytes([head[20], head[21], head[22], head[23]]),
            )
        } else {
            (0, 0)
        };
        return Some(("image/png", "png", w, h));
    }
    if head.starts_with(&[0xff, 0xd8, 0xff]) {
        let (w, h) = sniff_jpeg_dimensions_64(head);
        return Some(("image/jpeg", "jpg", w, h));
    }
    if head.len() >= 10 && (head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a")) {
        let w = u16::from_le_bytes([head[6], head[7]]) as u32;
        let h = u16::from_le_bytes([head[8], head[9]]) as u32;
        return Some(("image/gif", "gif", w, h));
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        let (w, h) = if head.len() >= 30
            && &head[12..16] == b"VP8 "
            && head[23] == 0x9d
            && head[24] == 0x01
            && head[25] == 0x2a
        {
            (
                (u16::from_le_bytes([head[26], head[27]]) & 0x3fff) as u32,
                (u16::from_le_bytes([head[28], head[29]]) & 0x3fff) as u32,
            )
        } else if head.len() >= 25 && &head[12..16] == b"VP8L" && head[20] == 0x2f {
            let bits = u32::from_le_bytes([head[21], head[22], head[23], head[24]]);
            ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
        } else if head.len() >= 30 && &head[12..16] == b"VP8X" {
            let w = 1 + (head[24] as u32 | ((head[25] as u32) << 8) | ((head[26] as u32) << 16));
            let h = 1 + (head[27] as u32 | ((head[28] as u32) << 8) | ((head[29] as u32) << 16));
            (w, h)
        } else {
            (0, 0)
        };
        return Some(("image/webp", "webp", w, h));
    }
    if file_name.contains("tty-graphics-protocol") {
        return Some(("image/png", "png", 0, 0));
    }
    None
}

fn is_allowed_image_bytes(bytes: &[u8], file_name: &str) -> bool {
    sniff_image_header_64(bytes, file_name).is_some()
}

fn stage_temp_image(file: &mut std::fs::File, ext: &str) -> Result<PathBuf, String> {
    use std::io::{Seek, SeekFrom};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_STAGE_ID: AtomicU64 = AtomicU64::new(1);

    let stage_dir = std::env::temp_dir().join(IMAGE_STAGE_DIR_NAME);
    std::fs::create_dir_all(&stage_dir).map_err(|e| format!("无法创建临时图片目录: {e}"))?;

    let seq = NEXT_STAGE_ID.fetch_add(1, Ordering::Relaxed);
    if seq % 32 == 0 {
        if let Ok(entries) = std::fs::read_dir(&stage_dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified.elapsed().is_ok_and(|age| age > Duration::from_secs(3600)) {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
    }

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let staged_path = stage_dir.join(format!("img-{}-{ts}-{seq}.{ext}", std::process::id()));
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("无法重置图片读取偏移: {e}"))?;
    let mut dst = std::fs::File::create(&staged_path)
        .map_err(|e| format!("无法创建缓存图片: {e}"))?;
    std::io::copy(file, &mut dst).map_err(|e| format!("缓存临时图片失败: {e}"))?;
    Ok(staged_path)
}

fn read_local_image_bytes(path: &str) -> Result<Vec<u8>, String> {
    let (canon, _) = validate_local_image_path(path)?;
    let bytes = std::fs::read(&canon).map_err(|e| format!("读取图片失败: {e}"))?;
    let file_name = canon
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !is_allowed_image_bytes(&bytes, &file_name) {
        return Err("不支持的图片格式".into());
    }
    Ok(bytes)
}

#[tauri::command]
pub fn local_term_read_image(path: String) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(read_local_image_bytes(&path)?))
}

#[tauri::command]
pub fn local_term_stat_image(
    path: String,
    delete_after: Option<bool>,
) -> Result<LocalImageStat, String> {
    let (canon, _) = validate_local_image_path(&path)?;
    let mut file = std::fs::File::open(&canon).map_err(|e| format!("无法打开图片: {e}"))?;
    let mut head = [0u8; 64];
    let mut read_total = 0;
    while read_total < head.len() {
        let n = file
            .read(&mut head[read_total..])
            .map_err(|e| format!("读取图片头失败: {e}"))?;
        if n == 0 {
            break;
        }
        read_total += n;
    }
    let file_name = canon
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (mime, ext, width, height) = sniff_image_header_64(&head[..read_total], &file_name)
        .ok_or_else(|| "不支持的图片格式".to_string())?;

    let url_path = if delete_after == Some(true) {
        stage_temp_image(&mut file, ext)?
            .to_string_lossy()
            .into_owned()
    } else {
        canon.to_string_lossy().into_owned()
    };

    Ok(LocalImageStat {
        url_path,
        width,
        height,
        mime: mime.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        base64_encode, decode_header, encode_frame, encode_resize_payload, local_term_stat_image,
        read_local_image_bytes, sanitize_display, IMAGE_STAGE_DIR_NAME,
    };
    use serde_json::json;

    #[test]
    fn frame_round_trip() {
        let frame = encode_frame(7, 3, b"abcd");
        assert_eq!(frame.len(), 13);
        let hdr: [u8; 9] = frame[0..9].try_into().unwrap();
        let (ch, kind, len) = decode_header(&hdr);
        assert_eq!((ch, kind, len), (7, 3, 4));
        assert_eq!(&frame[9..], b"abcd");
    }

    #[test]
    fn resize_payload_is_little_endian() {
        assert_eq!(encode_resize_payload(120, 40), [120, 0, 40, 0]);
    }

    #[test]
    fn sanitize_display_keeps_valid_fields() {
        let v = json!({ "fg": "#f4eef8", "bg": "bad", "cell": [500, 0] });
        let out = sanitize_display(Some(&v)).unwrap();
        assert_eq!(out["fg"], "#f4eef8");
        assert!(out.get("bg").is_none());
        assert_eq!(out["cell"], json!([200, 1]));
    }

    #[test]
    fn base64_encode_matches_standard() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"hello world"), "aGVsbG8gd29ybGQ=");
    }

    #[test]
    fn local_image_reader_validates_format_and_blocked_dirs() {
        let dir = std::env::temp_dir().join(format!("herdr-pocket-img-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".ssh")).unwrap();

        let png = dir.join("avatar.png");
        let mut png_bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        png_bytes.extend_from_slice(b"\x00\x00\x00\x0dIHDR");
        std::fs::write(&png, &png_bytes).unwrap();
        assert_eq!(read_local_image_bytes(&png.to_string_lossy()).unwrap(), png_bytes);

        let txt = dir.join("note.txt");
        std::fs::write(&txt, b"hello plain text").unwrap();
        assert!(read_local_image_bytes(&txt.to_string_lossy()).is_err());

        let blocked = dir.join(".ssh").join("secret.png");
        std::fs::write(&blocked, &png_bytes).unwrap();
        assert!(read_local_image_bytes(&blocked.to_string_lossy()).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_term_stat_image_sniffs_headers_and_stages_temp_files() {
        let dir = std::env::temp_dir().join(format!("herdr-pocket-stat-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".ssh")).unwrap();

        // PNG 320x240
        let png_path = dir.join("shot.png");
        let mut png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&320u32.to_be_bytes());
        png.extend_from_slice(&240u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        std::fs::write(&png_path, &png).unwrap();

        let stat_png = local_term_stat_image(png_path.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!(stat_png.width, 320);
        assert_eq!(stat_png.height, 240);
        assert_eq!(stat_png.mime, "image/png");
        assert_eq!(
            std::path::Path::new(&stat_png.url_path),
            std::fs::canonicalize(&png_path).unwrap()
        );

        // Staging delete_after = Some(true)
        let stat_staged =
            local_term_stat_image(png_path.to_string_lossy().into_owned(), Some(true)).unwrap();
        assert_eq!(stat_staged.width, 320);
        assert_eq!(stat_staged.height, 240);
        assert_eq!(stat_staged.mime, "image/png");
        assert!(stat_staged.url_path.contains(IMAGE_STAGE_DIR_NAME));
        assert!(stat_staged.url_path.ends_with(".png"));
        assert_eq!(std::fs::read(&stat_staged.url_path).unwrap(), png);
        let _ = std::fs::remove_file(&stat_staged.url_path);

        // GIF 640x480
        let gif_path = dir.join("anim.gif");
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&640u16.to_le_bytes());
        gif.extend_from_slice(&480u16.to_le_bytes());
        gif.extend_from_slice(&[0u8; 6]);
        std::fs::write(&gif_path, &gif).unwrap();
        let stat_gif = local_term_stat_image(gif_path.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!((stat_gif.width, stat_gif.height, stat_gif.mime.as_str()), (640, 480, "image/gif"));

        // JPEG SOF0 1024x768 within 64 bytes
        let jpg_path = dir.join("photo.jpg");
        let mut jpg = vec![0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08];
        jpg.extend_from_slice(&768u16.to_be_bytes());
        jpg.extend_from_slice(&1024u16.to_be_bytes());
        jpg.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
        std::fs::write(&jpg_path, &jpg).unwrap();
        let stat_jpg = local_term_stat_image(jpg_path.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!((stat_jpg.width, stat_jpg.height, stat_jpg.mime.as_str()), (1024, 768, "image/jpeg"));

        // WebP VP8 lossy 800x600
        let webp_path = dir.join("pic.webp");
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&26u32.to_le_bytes());
        webp.extend_from_slice(b"WEBPVP8 ");
        webp.extend_from_slice(&14u32.to_le_bytes());
        webp.extend_from_slice(&[0, 0, 0, 0x9d, 0x01, 0x2a]);
        webp.extend_from_slice(&800u16.to_le_bytes());
        webp.extend_from_slice(&600u16.to_le_bytes());
        std::fs::write(&webp_path, &webp).unwrap();
        let stat_webp = local_term_stat_image(webp_path.to_string_lossy().into_owned(), None).unwrap();
        assert_eq!((stat_webp.width, stat_webp.height, stat_webp.mime.as_str()), (800, 600, "image/webp"));

        // Rejects blocked dirs and non-images
        let blocked = dir.join(".ssh").join("secret.png");
        std::fs::write(&blocked, &png).unwrap();
        assert!(local_term_stat_image(blocked.to_string_lossy().into_owned(), None).is_err());

        let txt = dir.join("plain.txt");
        std::fs::write(&txt, b"not an image").unwrap();
        assert!(local_term_stat_image(txt.to_string_lossy().into_owned(), None).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
