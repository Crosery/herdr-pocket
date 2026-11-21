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
const KIND_FACTS: u8 = 5;
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
}

struct PreattachedChannel {
    channel: u32,
    cols: u16,
    rows: u16,
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

    let state = Arc::new(Mutex::new(SharedState {
        stdin,
        child,
        next_id: 1,
        replies: HashMap::new(),
        by_channel: HashMap::new(),
        by_id: HashMap::new(),
        preattached: HashMap::new(),
        early: HashMap::new(),
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
                if let Ok(mut s) = client.state.lock() {
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

            let early_frames = {
                let mut s = client
                    .state
                    .lock()
                    .map_err(|_| "hc state lock poisoned".to_string())?;
                s.by_channel.insert(channel, id.clone());
                s.by_id.insert(
                    id.clone(),
                    Attachment {
                        channel,
                        consumed: 0,
                    },
                );
                let drained = s
                    .early
                    .remove(&channel)
                    .map(|b| b.frames)
                    .unwrap_or_default();
                s.write_frame(channel, KIND_CREDIT, &INITIAL_CREDIT_BYTES.to_le_bytes())?;
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

fn is_allowed_image_bytes(bytes: &[u8], file_name: &str) -> bool {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return true;
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return true;
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return true;
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return true;
    }
    file_name.contains("tty-graphics-protocol")
}

fn read_local_image_bytes(path: &str) -> Result<Vec<u8>, String> {
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

#[cfg(test)]
mod tests {
    use super::{
        base64_encode, decode_header, encode_frame, encode_resize_payload, read_local_image_bytes,
        sanitize_display,
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
}
