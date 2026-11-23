//! Direct framed `hc connect` bridge for terminals running on this computer.
//!
//! When the user views a local `hc` terminal on the desktop app, going straight
//! through `hc connect` (same binary frame wire protocol as `apps/hostd/src/hcscreen.ts`)
//! eliminates the round-trip through the remote relay and keeps keystrokes & PTY paints local.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SizeEvent {
    terminal: String,
    cols: u16,
    rows: u16,
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

struct RpcErr {
    kind: Option<String>,
    message: String,
}

enum ReplyTarget {
    Channel0(mpsc::Sender<Result<Value, RpcErr>>),
}

struct Attachment {
    channel: u32,
    consumed: usize,
    automatic_input: bool,
    sink: Option<Channel<InvokeResponseBody>>,
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
    raw_bytes: usize,
    frames: Vec<(u8, Vec<u8>)>,
}

struct SharedState {
    writer: mpsc::Sender<Vec<u8>>,
    child: Child,
    next_id: u64,
    replies: HashMap<u64, ReplyTarget>,
    events_channel: Option<u32>,
    by_channel: HashMap<u32, String>,
    by_id: HashMap<String, Attachment>,
    preattached: HashMap<String, PreattachedChannel>,
    early: HashMap<u32, EarlyBuffer>,
    supports_automatic_input: bool,
    alive: bool,
}

impl SharedState {
    fn write_frame(&self, channel: u32, kind: u8, payload: &[u8]) -> Result<(), String> {
        if !self.alive {
            return Err("hc connect 已退出".into());
        }
        let bytes = encode_frame(channel, kind, payload);
        self.writer
            .send(bytes)
            .map_err(|_| "hc 写入线程已关闭".to_string())
    }
}

fn parse_size_event(msg: &Value) -> Option<SizeEvent> {
    if msg.get("method").and_then(Value::as_str) != Some("event") {
        return None;
    }
    if msg.pointer("/params/type").and_then(Value::as_str) != Some("size") {
        return None;
    }
    let terminal = msg
        .pointer("/params/terminal")
        .and_then(Value::as_str)?
        .trim();
    if terminal.is_empty() {
        return None;
    }
    let cols = msg
        .pointer("/params/data/cols")
        .and_then(Value::as_u64)
        .and_then(|v| u16::try_from(v).ok())
        .filter(|&c| c > 0)?;
    let rows = msg
        .pointer("/params/data/rows")
        .and_then(Value::as_u64)
        .and_then(|v| u16::try_from(v).ok())
        .filter(|&r| r > 0)?;
    Some(SizeEvent {
        terminal: terminal.to_string(),
        cols,
        rows,
    })
}

fn process_event_lines(buf: &mut Vec<u8>, bytes: &[u8], app: &AppHandle) {
    buf.extend_from_slice(bytes);
    let mut consumed = 0usize;
    let mut emit_doc = false;
    let mut emit_terms = false;
    let mut size_events: Vec<SizeEvent> = Vec::new();
    for (i, b) in buf.iter().enumerate() {
        if *b != b'\n' {
            continue;
        }
        if let Ok(msg) = serde_json::from_slice::<Value>(&buf[consumed..i]) {
            match msg.get("method").and_then(Value::as_str) {
                Some("missed") => {
                    emit_doc = true;
                    emit_terms = true;
                }
                Some("event") => {
                    match msg.pointer("/params/type").and_then(Value::as_str) {
                        Some("doc") => emit_doc = true,
                        Some("size") => {
                            if let Some(ev) = parse_size_event(&msg) {
                                size_events.push(ev);
                            }
                        }
                        Some("created" | "restarted" | "finished" | "lost" | "removed" | "status" | "turn" | "labels") => {
                            emit_terms = true;
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        consumed = i + 1;
    }
    if consumed > 0 {
        buf.drain(..consumed);
    }
    if buf.len() > 2 * 1024 * 1024 {
        buf.clear();
    }
    if emit_doc {
        let _ = app.emit("local-term://doc-changed", json!({}));
    }
    if emit_terms {
        let _ = app.emit("local-term://terminals-changed", json!({}));
    }
    for ev in size_events {
        let _ = app.emit("local-term://size", ev);
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

    let (writer_tx, writer_rx) = mpsc::channel::<Vec<u8>>();
    thread::Builder::new()
        .name("hc-framed-writer".into())
        .spawn(move || {
            let mut stdin = stdin;
            while let Ok(first) = writer_rx.recv() {
                if stdin.write_all(&first).is_err() {
                    break;
                }
                while let Ok(more) = writer_rx.try_recv() {
                    if stdin.write_all(&more).is_err() {
                        return;
                    }
                }
                if stdin.flush().is_err() {
                    break;
                }
            }
        })
        .map_err(|e| format!("无法创建 hc 写入线程: {e}"))?;

    let state = Arc::new(Mutex::new(SharedState {
        writer: writer_tx,
        child,
        next_id: 1,
        replies: HashMap::new(),
        events_channel: None,
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
            let mut apc_parsers: HashMap<u32, ChannelApcStream> = HashMap::new();
            let mut events_buf: Vec<u8> = Vec::new();
            let mut events_consumed: usize = 0;
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
                if kind == KIND_DATA && channel != 0 {
                    // Coalesce consecutive complete DATA frames already sitting in BufReader
                    // on the same channel without blocking, reducing Tauri IPC & base64 chatter.
                    while payload.len() < 256 * 1024 {
                        let buf = reader.buffer();
                        if buf.len() < HEADER_LEN {
                            break;
                        }
                        let next_hdr: [u8; HEADER_LEN] = buf[..HEADER_LEN].try_into().unwrap();
                        let (next_ch, next_kind, next_len) = decode_header(&next_hdr);
                        if next_ch != channel
                            || next_kind != KIND_DATA
                            || next_len > 256 * 1024
                            || payload.len() + next_len > 256 * 1024
                            || buf.len() < HEADER_LEN + next_len
                        {
                            break;
                        }
                        payload.extend_from_slice(&buf[HEADER_LEN..HEADER_LEN + next_len]);
                        reader.consume(HEADER_LEN + next_len);
                    }
                }
                if channel == 0 {
                    if kind == KIND_DATA {
                        if let Ok(msg) = serde_json::from_slice::<Value>(&payload) {
                            if let Some(id) = msg.get("id").and_then(Value::as_u64) {
                                let target = state.lock().ok().and_then(|mut s| s.replies.remove(&id));
                                if let Some(ReplyTarget::Channel0(tx)) = target {
                                    if let Some(err_obj) = msg.get("error").filter(|v| !v.is_null()) {
                                        let message = err_obj
                                            .get("message")
                                            .and_then(Value::as_str)
                                            .unwrap_or("core call failed")
                                            .to_string();
                                        let kind = err_obj
                                            .pointer("/data/kind")
                                            .and_then(Value::as_str)
                                            .map(ToString::to_string);
                                        let _ = tx.send(Err(RpcErr { kind, message }));
                                    } else {
                                        let _ = tx.send(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
                                    }
                                }
                            }
                        }
                    }
                    continue;
                }

                let is_events = state
                    .lock()
                    .ok()
                    .is_some_and(|s| s.events_channel == Some(channel));
                if is_events {
                    if kind == KIND_DATA {
                        events_consumed += payload.len();
                        if events_consumed >= 256 * 1024 {
                            let ack = events_consumed as u32;
                            events_consumed = 0;
                            if let Ok(s) = state.lock() {
                                let _ = s.write_frame(channel, KIND_CREDIT, &ack.to_le_bytes());
                            }
                        }
                        process_event_lines(&mut events_buf, &payload, &app_clone);
                    }
                    continue;
                }

                let raw_len = payload.len();
                let (out_payload, auto_replies) = if kind == KIND_DATA {
                    let parser = apc_parsers.entry(channel).or_default();
                    let res = parser.push(&payload);
                    (res.out_bytes, res.auto_replies)
                } else {
                    if kind == KIND_CLOSE {
                        apc_parsers.remove(&channel);
                    }
                    (payload, Vec::new())
                };

                enum Action {
                    EmitData(String, Vec<u8>, Option<usize>, Option<Channel<InvokeResponseBody>>),
                    EmitClose(String, Option<Channel<InvokeResponseBody>>),
                    None,
                }
                let action = {
                    let Ok(mut s) = state.lock() else { break };
                    if !auto_replies.is_empty() {
                        let use_auto = s
                            .by_channel
                            .get(&channel)
                            .and_then(|id| s.by_id.get(id))
                            .map(|a| a.automatic_input)
                            .unwrap_or_else(|| {
                                s.preattached
                                    .values()
                                    .find(|p| p.channel == channel)
                                    .is_some_and(|p| p.automatic_input)
                            });
                        let reply_kind = if use_auto {
                            KIND_AUTOMATIC_INPUT
                        } else {
                            KIND_DATA
                        };
                        for reply in &auto_replies {
                            let _ = s.write_frame(channel, reply_kind, reply);
                        }
                    }
                    if let Some(att_id) = s.by_channel.get(&channel).cloned() {
                        match kind {
                            KIND_DATA => {
                                let (credit_ack, sink) = s
                                    .by_id
                                    .get_mut(&att_id)
                                    .map(|att| {
                                        att.consumed += raw_len;
                                        let ack = if att.consumed >= CREDIT_ACK_STEP {
                                            let a = att.consumed;
                                            att.consumed = 0;
                                            Some(a)
                                        } else {
                                            None
                                        };
                                        (ack, att.sink.clone())
                                    })
                                    .unwrap_or((None, None));
                                Action::EmitData(att_id, out_payload, credit_ack, sink)
                            }
                            KIND_CLOSE => {
                                s.by_channel.remove(&channel);
                                let sink = s.by_id.remove(&att_id).and_then(|att| att.sink);
                                Action::EmitClose(att_id, sink)
                            }
                            _ => Action::None,
                        }
                    } else {
                        let buf = s.early.entry(channel).or_default();
                        if kind == KIND_DATA {
                            buf.raw_bytes += raw_len;
                        }
                        if buf.frames.len() < MAX_EARLY_FRAMES
                            && buf.bytes.saturating_add(out_payload.len()) <= MAX_EARLY_BYTES
                        {
                            buf.bytes += out_payload.len();
                            buf.frames.push((kind, out_payload));
                        }
                        Action::None
                    }
                };

                match action {
                    Action::EmitData(id, bytes, credit_ack, sink) => {
                        if let Some(ack) = credit_ack {
                            if let Ok(s) = state.lock() {
                                let _ = s.write_frame(channel, KIND_CREDIT, &(ack as u32).to_le_bytes());
                            }
                        }
                        if !bytes.is_empty() {
                            if let Some(ch) = sink {
                                let _ = ch.send(InvokeResponseBody::Raw(bytes));
                            } else {
                                let _ = app_clone.emit(
                                    "local-term://data",
                                    DataEvent {
                                        id,
                                        data: base64_encode(&bytes),
                                    },
                                );
                            }
                        }
                    }
                    Action::EmitClose(id, sink) => {
                        if let Some(ch) = sink {
                            let _ = ch.send(InvokeResponseBody::Raw(Vec::new()));
                        }
                        let _ = app_clone.emit("local-term://close", CloseEvent { id });
                    }
                    Action::None => {}
                }
            }

            let closed_entries: Vec<(String, Option<Channel<InvokeResponseBody>>)> = {
                if let Ok(mut s) = state.lock() {
                    s.alive = false;
                    for (_, target) in s.replies.drain() {
                        let ReplyTarget::Channel0(tx) = target;
                        let _ = tx.send(Err(RpcErr {
                            kind: None,
                            message: "hc connect 已断开".into(),
                        }));
                    }
                    s.events_channel = None;
                    s.by_channel.clear();
                    s.preattached.clear();
                    s.early.clear();
                    s.by_id.drain().map(|(id, att)| (id, att.sink)).collect()
                } else {
                    Vec::new()
                }
            };
            for (id, sink) in closed_entries {
                if let Some(ch) = sink {
                    let _ = ch.send(InvokeResponseBody::Raw(Vec::new()));
                }
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

    let sub_handle = Arc::clone(&handle);
    let _ = thread::Builder::new()
        .name("hc-events-sub".into())
        .spawn(move || {
            let Ok(res) = call_channel0(&sub_handle, "events.subscribe", json!({})) else {
                return;
            };
            let Some(ch) = res
                .get("channel")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok())
            else {
                return;
            };
            let early = if let Ok(mut s) = sub_handle.state.lock() {
                s.events_channel = Some(ch);
                let drained = s.early.remove(&ch).map(|b| b.frames).unwrap_or_default();
                let _ = s.write_frame(ch, KIND_CREDIT, &(1024u32 * 1024u32).to_le_bytes());
                drained
            } else {
                Vec::new()
            };
            if !early.is_empty() {
                let mut early_buf = Vec::new();
                for (k, bytes) in early {
                    if k == KIND_DATA {
                        process_event_lines(&mut early_buf, &bytes, &sub_handle.app);
                    }
                }
            }
        });

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

fn call_channel0_rpc(client: &ClientHandle, method: &str, params: Value) -> Result<Value, RpcErr> {
    let (tx, rx) = mpsc::channel();
    let req_id = {
        let mut s = client
            .state
            .lock()
            .map_err(|_| RpcErr {
                kind: None,
                message: "hc state lock poisoned".to_string(),
            })?;
        if !s.alive {
            return Err(RpcErr {
                kind: None,
                message: "hc connect 已退出".into(),
            });
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
        .map_err(|e| RpcErr {
            kind: None,
            message: e.to_string(),
        })?;
        if let Err(err) = s.write_frame(0, KIND_DATA, &payload) {
            s.replies.remove(&id);
            return Err(RpcErr {
                kind: None,
                message: err,
            });
        }
        id
    };
    match rx.recv_timeout(std::time::Duration::from_secs(8)) {
        Ok(res) => res,
        Err(_) => {
            if let Ok(mut s) = client.state.lock() {
                s.replies.remove(&req_id);
            }
            Err(RpcErr {
                kind: None,
                message: format!("{method}: 等待 hc 响应超时"),
            })
        }
    }
}

fn call_channel0(client: &ClientHandle, method: &str, params: Value) -> Result<Value, String> {
    call_channel0_rpc(client, method, params).map_err(|e| e.message)
}

#[tauri::command]
pub async fn local_term_create_shell(
    app: AppHandle,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    display: Option<Value>,
    space_name: Option<String>,
    space_id: Option<String>,
    tab_id: Option<String>,
    argv: Option<Vec<String>>,
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
        if let Some(args) = argv.filter(|v| !v.is_empty()) {
            params.insert("argv".into(), json!(args));
        }
        let mut labels = serde_json::Map::new();
        if let Some(sp) = space_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            labels.insert("where".into(), json!(sp));
        }
        if let Some(sid) = space_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            labels.insert("herdr.space".into(), json!(sid));
        }
        if let Some(tid) = tab_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            labels.insert("herdr.tab".into(), json!(tid));
        }
        if !labels.is_empty() {
            params.insert("labels".into(), Value::Object(labels));
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
    on_data: Channel<InvokeResponseBody>,
) -> Result<LocalAttachResult, String> {
    let c = clamp_cols(cols);
    let r = clamp_rows(rows);
    let sanitized_display = sanitize_display(display.as_ref());
    let sink_for_live = Some(on_data.clone());
    let sink_for_early = Some(on_data);
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
                    let early = s.early.remove(&pre.channel);
                    let (drained, early_raw_bytes) = early
                        .map(|b| (b.frames, b.raw_bytes))
                        .unwrap_or_default();
                    let consumed = if early_raw_bytes >= CREDIT_ACK_STEP {
                        let _ = s.write_frame(
                            pre.channel,
                            KIND_CREDIT,
                            &(early_raw_bytes as u32).to_le_bytes(),
                        );
                        0
                    } else {
                        early_raw_bytes
                    };
                    s.by_id.insert(
                        id.clone(),
                        Attachment {
                            channel: pre.channel,
                            consumed,
                            automatic_input: pre.automatic_input,
                            sink: sink_for_live.clone(),
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
                        sink: sink_for_live,
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
                    if let Some(ref ch) = sink_for_early {
                        let _ = ch.send(InvokeResponseBody::Raw(payload));
                    } else {
                        let _ = client.app.emit(
                            "local-term://data",
                            DataEvent {
                                id: id.clone(),
                                data: base64_encode(&payload),
                            },
                        );
                    }
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
            if let Some(ref ch) = sink_for_early {
                let _ = ch.send(InvokeResponseBody::Raw(Vec::new()));
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
    let client = {
        let guard = global_client()
            .lock()
            .map_err(|_| "local_term lock poisoned".to_string())?;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| "本地终端未连接".to_string())?
    };
    let s = client
        .state
        .lock()
        .map_err(|_| "hc state lock poisoned".to_string())?;
    let ch = s
        .by_id
        .get(&id)
        .map(|a| a.channel)
        .ok_or_else(|| "本地终端通道已关闭".to_string())?;
    s.write_frame(ch, KIND_DATA, data.as_bytes())
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
    let client = {
        let guard = global_client()
            .lock()
            .map_err(|_| "local_term lock poisoned".to_string())?;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| "本地终端未连接".to_string())?
    };
    let s = client
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
}

#[tauri::command]
pub async fn local_term_focus(id: String, focused: bool) -> Result<(), String> {
    let client = {
        let Ok(guard) = global_client().lock() else {
            return Ok(());
        };
        match guard.as_ref().cloned() {
            Some(c) => c,
            None => return Ok(()),
        }
    };
    let s = client
        .state
        .lock()
        .map_err(|_| "hc state lock poisoned".to_string())?;
    let Some(ch) = s.by_id.get(&id).map(|a| a.channel) else {
        return Ok(());
    };
    s.write_frame(ch, KIND_FOCUS, &[u8::from(focused)])
}

#[tauri::command]
pub async fn local_term_auto_input(id: String, data: String) -> Result<(), String> {
    if data.is_empty() {
        return Ok(());
    }
    let client = {
        let guard = global_client()
            .lock()
            .map_err(|_| "local_term lock poisoned".to_string())?;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| "本地终端未连接".to_string())?
    };
    let s = client
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
}

#[tauri::command]
pub async fn local_term_kill(app: AppHandle, terminal: String) -> Result<(), String> {
    let target = terminal.trim().to_string();
    if target.is_empty() {
        return Err("terminal 不能为空".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let client = ensure_client(&app)?;
        call_channel0(&client, "terminal.kill", json!({ "terminal": target }))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_herdr_doc_get(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = ensure_client(&app)?;
        let res = call_channel0(&client, "doc.get", json!({ "name": "herdr-app" }))?;
        Ok(json!({
            "value": res.get("value").cloned().unwrap_or(Value::Null),
            "version": res.get("version").and_then(Value::as_u64).unwrap_or(0),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_herdr_doc_set(app: AppHandle, value: Value, version: u64) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let client = ensure_client(&app)?;
        match call_channel0_rpc(
            &client,
            "doc.set",
            json!({ "name": "herdr-app", "value": value, "version": version }),
        ) {
            Ok(res) => Ok(json!({
                "ok": true,
                "version": res.get("version").and_then(Value::as_u64).unwrap_or(version + 1),
            })),
            Err(err)
                if err.kind.as_deref() == Some("conflict")
                    || err.message.to_ascii_lowercase().contains("conflict") =>
            {
                let fresh = call_channel0(&client, "doc.get", json!({ "name": "herdr-app" }))
                    .unwrap_or_else(|_| json!({ "value": Value::Null, "version": 0 }));
                Ok(json!({
                    "ok": false,
                    "conflict": true,
                    "value": fresh.get("value").cloned().unwrap_or(Value::Null),
                    "version": fresh.get("version").and_then(Value::as_u64).unwrap_or(0),
                }))
            }
            Err(err) => Err(err.message),
        }
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
const MAX_MEM_TERM_IMAGES: usize = 64;
const MAX_MEM_TERM_BYTES: usize = 128 * 1024 * 1024;
const MAX_SINGLE_APC_BYTES: usize = 96 * 1024 * 1024;

struct MemTermImage {
    mime: &'static str,
    data: Arc<Vec<u8>>,
    last_used: u64,
}

#[derive(Default)]
struct MemTermImageCache {
    entries: HashMap<u64, MemTermImage>,
    total_bytes: usize,
    tick: u64,
}

fn mem_image_cache() -> &'static Mutex<MemTermImageCache> {
    static CACHE: OnceLock<Mutex<MemTermImageCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(MemTermImageCache::default()))
}

static NEXT_MEM_IMAGE_ID: AtomicU64 = AtomicU64::new(1);

pub fn insert_mem_image(mime: &'static str, data: Vec<u8>) -> Option<u64> {
    if data.is_empty() || data.len() > MAX_MEM_TERM_BYTES {
        return None;
    }
    let len = data.len();
    let mut cache = mem_image_cache().lock().ok()?;
    while cache.entries.len() >= MAX_MEM_TERM_IMAGES || cache.total_bytes + len > MAX_MEM_TERM_BYTES {
        let Some((&lru_id, _)) = cache.entries.iter().min_by_key(|(_, v)| v.last_used) else {
            break;
        };
        if let Some(removed) = cache.entries.remove(&lru_id) {
            cache.total_bytes = cache.total_bytes.saturating_sub(removed.data.len());
        }
    }
    cache.tick = cache.tick.wrapping_add(1);
    let last_used = cache.tick;
    let id = NEXT_MEM_IMAGE_ID.fetch_add(1, Ordering::Relaxed);
    cache.total_bytes += len;
    cache.entries.insert(
        id,
        MemTermImage {
            mime,
            data: Arc::new(data),
            last_used,
        },
    );
    Some(id)
}

pub fn get_mem_image(id: u64) -> Option<(&'static str, Arc<Vec<u8>>)> {
    let mut cache = mem_image_cache().lock().ok()?;
    cache.tick = cache.tick.wrapping_add(1);
    let tick = cache.tick;
    let entry = cache.entries.get_mut(&id)?;
    entry.last_used = tick;
    Some((entry.mime, Arc::clone(&entry.data)))
}

const fn make_b64_decode_table() -> [u8; 256] {
    let mut t = [0xffu8; 256];
    let mut i = b'A';
    while i <= b'Z' {
        t[i as usize] = i - b'A';
        i += 1;
    }
    let mut i = b'a';
    while i <= b'z' {
        t[i as usize] = 26 + (i - b'a');
        i += 1;
    }
    let mut i = b'0';
    while i <= b'9' {
        t[i as usize] = 52 + (i - b'0');
        i += 1;
    }
    t[b'+' as usize] = 62;
    t[b'/' as usize] = 63;
    t[b'=' as usize] = 0xfd;
    t[b' ' as usize] = 0xfe;
    t[b'\t' as usize] = 0xfe;
    t[b'\r' as usize] = 0xfe;
    t[b'\n' as usize] = 0xfe;
    t
}

static B64_DECODE_TABLE: [u8; 256] = make_b64_decode_table();

pub fn base64_decode(input: &[u8]) -> Option<Vec<u8>> {
    if input.is_empty() {
        return Some(Vec::new());
    }
    let mut out = Vec::with_capacity((input.len() / 4) * 3 + 3);
    let mut i = 0usize;
    while i + 4 <= input.len() {
        let a = B64_DECODE_TABLE[input[i] as usize];
        let b = B64_DECODE_TABLE[input[i + 1] as usize];
        let c = B64_DECODE_TABLE[input[i + 2] as usize];
        let d = B64_DECODE_TABLE[input[i + 3] as usize];
        if (a | b | c | d) < 64 {
            let v = ((a as u32) << 18) | ((b as u32) << 12) | ((c as u32) << 6) | (d as u32);
            out.push((v >> 16) as u8);
            out.push((v >> 8) as u8);
            out.push(v as u8);
            i += 4;
        } else {
            break;
        }
    }
    let mut buf = [0u8; 4];
    let mut count = 0usize;
    let mut saw_pad = false;
    while i < input.len() {
        let code = B64_DECODE_TABLE[input[i] as usize];
        i += 1;
        if code == 0xfe {
            continue;
        }
        if code == 0xff {
            return None;
        }
        if code == 0xfd {
            saw_pad = true;
            if count == 0 || count == 1 {
                return None;
            }
            if count == 2 {
                let mut rest_pads = 1usize;
                while i < input.len() {
                    let c = B64_DECODE_TABLE[input[i] as usize];
                    i += 1;
                    if c == 0xfe {
                        continue;
                    }
                    if c == 0xfd && rest_pads < 2 {
                        rest_pads += 1;
                    } else {
                        return None;
                    }
                }
                if rest_pads != 2 {
                    return None;
                }
                out.push((buf[0] << 2) | (buf[1] >> 4));
                return Some(out);
            }
            if count == 3 {
                while i < input.len() {
                    let c = B64_DECODE_TABLE[input[i] as usize];
                    i += 1;
                    if c != 0xfe {
                        return None;
                    }
                }
                out.push((buf[0] << 2) | (buf[1] >> 4));
                out.push((buf[1] << 4) | (buf[2] >> 2));
                return Some(out);
            }
            continue;
        }
        if saw_pad {
            return None;
        }
        buf[count] = code;
        count += 1;
        if count == 4 {
            let v = ((buf[0] as u32) << 18)
                | ((buf[1] as u32) << 12)
                | ((buf[2] as u32) << 6)
                | (buf[3] as u32);
            out.push((v >> 16) as u8);
            out.push((v >> 8) as u8);
            out.push(v as u8);
            count = 0;
        }
    }
    match count {
        0 => Some(out),
        1 => None,
        2 => {
            out.push((buf[0] << 2) | (buf[1] >> 4));
            Some(out)
        }
        3 => {
            out.push((buf[0] << 2) | (buf[1] >> 4));
            out.push((buf[1] << 4) | (buf[2] >> 2));
            Some(out)
        }
        _ => unreachable!(),
    }
}

/// Wraps raw Kitty `f=32` (RGBA) or `f=24` (RGB) pixels into a 122-byte
/// `BITMAPV4HEADER` top-down 32-bit `BI_BITFIELDS` RGBA BMP with zero compression cost.
pub fn build_bmp_v4_from_pixels(
    width: u32,
    height: u32,
    format: u32,
    pixels: &[u8],
) -> Option<Vec<u8>> {
    if width == 0 || height == 0 || width > 16384 || height > 16384 {
        return None;
    }
    let pixel_count = (width as usize).checked_mul(height as usize)?;
    let bmp_data_len = pixel_count.checked_mul(4)?;
    let total_len = 122usize.checked_add(bmp_data_len)?;
    if total_len > MAX_MEM_TERM_BYTES {
        return None;
    }
    let total_u32 = u32::try_from(total_len).ok()?;
    let data_u32 = u32::try_from(bmp_data_len).ok()?;
    let width_i32 = i32::try_from(width).ok()?;
    let neg_height_i32 = i32::try_from(height).ok()?.checked_neg()?;

    match format {
        32 => {
            if pixels.len() < bmp_data_len {
                return None;
            }
        }
        24 => {
            let rgb_len = pixel_count.checked_mul(3)?;
            if pixels.len() < rgb_len {
                return None;
            }
        }
        _ => return None,
    }

    let mut out = vec![0u8; 122];
    out[0] = b'B';
    out[1] = b'M';
    out[2..6].copy_from_slice(&total_u32.to_le_bytes());
    out[10..14].copy_from_slice(&122u32.to_le_bytes());
    out[14..18].copy_from_slice(&108u32.to_le_bytes());
    out[18..22].copy_from_slice(&width_i32.to_le_bytes());
    out[22..26].copy_from_slice(&neg_height_i32.to_le_bytes());
    out[26..28].copy_from_slice(&1u16.to_le_bytes());
    out[28..30].copy_from_slice(&32u16.to_le_bytes());
    out[30..34].copy_from_slice(&3u32.to_le_bytes());
    out[34..38].copy_from_slice(&data_u32.to_le_bytes());
    out[38..42].copy_from_slice(&2835i32.to_le_bytes());
    out[42..46].copy_from_slice(&2835i32.to_le_bytes());
    out[54..58].copy_from_slice(&0x0000_00ffu32.to_le_bytes());
    out[58..62].copy_from_slice(&0x0000_ff00u32.to_le_bytes());
    out[62..66].copy_from_slice(&0x00ff_0000u32.to_le_bytes());
    out[66..70].copy_from_slice(&0xff00_0000u32.to_le_bytes());
    // Bytes 70..122 stay 0 (LCS_CALIBRATED_RGB = 0) so macOS ImageIO, WebKit, and Chromium all preserve alpha.

    out.reserve(bmp_data_len);
    if format == 32 {
        out.extend_from_slice(&pixels[..bmp_data_len]);
    } else {
        let rgb_len = pixel_count * 3;
        for px in pixels[..rgb_len].chunks_exact(3) {
            out.extend_from_slice(&[px[0], px[1], px[2], 255]);
        }
    }
    Some(out)
}

fn has_blocked_component(path: &Path) -> bool {
    path.components().any(|comp| {
        let name = comp.as_os_str().to_string_lossy().to_lowercase();
        BLOCKED_IMAGE_COMPONENTS.contains(&name.as_str())
    })
}

fn is_temp_path(path: &Path) -> bool {
    if has_blocked_component(path) {
        return false;
    }
    let env_tmp = std::env::temp_dir();
    let env_tmp_canon = std::fs::canonicalize(&env_tmp).ok();
    let mut roots: Vec<PathBuf> = vec![env_tmp];
    if let Some(c) = env_tmp_canon {
        roots.push(c);
    }
    #[cfg(unix)]
    {
        roots.push(PathBuf::from("/tmp"));
        roots.push(PathBuf::from("/private/tmp"));
        roots.push(PathBuf::from("/var/folders"));
        roots.push(PathBuf::from("/private/var/folders"));
    }
    if roots.iter().any(|r| path.starts_with(r)) {
        return true;
    }
    if let Ok(canon) = std::fs::canonicalize(path) {
        if has_blocked_component(&canon) {
            return false;
        }
        return roots.iter().any(|r| canon.starts_with(r));
    }
    false
}

#[derive(Debug, Default)]
pub struct ApcProcessResult {
    pub out_bytes: Vec<u8>,
    pub auto_replies: Vec<Vec<u8>>,
}

struct ParsedKittyHeader<'a> {
    action: Option<&'a str>,
    format: Option<u32>,
    medium: Option<&'a str>,
    compression: Option<&'a str>,
    more: bool,
    width: Option<u32>,
    height: Option<u32>,
    id: Option<u32>,
    image_number: Option<u32>,
    quiet: u8,
}

fn parse_kitty_header(raw_header: &[u8]) -> ParsedKittyHeader<'_> {
    let mut parsed = ParsedKittyHeader {
        action: None,
        format: None,
        medium: None,
        compression: None,
        more: false,
        width: None,
        height: None,
        id: None,
        image_number: None,
        quiet: 0,
    };
    let Ok(header_str) = std::str::from_utf8(raw_header) else {
        return parsed;
    };
    for part in header_str.split(',') {
        if part.is_empty() {
            continue;
        }
        let Some((k, v)) = part.split_once('=') else {
            continue;
        };
        match k {
            "a" => parsed.action = Some(v),
            "f" => parsed.format = v.parse::<u32>().ok(),
            "t" => parsed.medium = Some(v),
            "o" => parsed.compression = Some(v),
            "m" => parsed.more = v == "1",
            "s" => parsed.width = v.parse::<u32>().ok(),
            "v" => parsed.height = v.parse::<u32>().ok(),
            "i" => parsed.id = v.parse::<u32>().ok(),
            "I" => parsed.image_number = v.parse::<u32>().ok(),
            "q" => parsed.quiet = match v { "1" => 1, "2" => 2, _ => 0 },
            _ => {}
        }
    }
    parsed
}

struct ActiveChunkUpload {
    action: String,
    id: Option<u32>,
    first_header: Vec<u8>,
    format: Option<u32>,
    medium: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    passthrough: bool,
    raw_chunks: Vec<Vec<u8>>,
    payload_parts: Vec<Vec<u8>>,
    total_raw_bytes: usize,
}

#[derive(Default)]
pub struct ChannelApcStream {
    pending_prefix: Vec<u8>,
    utf8_rem: u8,
    in_apc: bool,
    apc_prefix: Vec<u8>,
    apc_buf: Vec<u8>,
    apc_passthrough: bool,
    chunked: Option<ActiveChunkUpload>,
}

fn trailing_utf8_remaining(bytes: &[u8]) -> u8 {
    let n = bytes.len();
    let mut back = 0usize;
    while back < 3 && back < n {
        let b = bytes[n - 1 - back];
        if b < 0x80 {
            return 0;
        }
        if (0xc2..=0xf4).contains(&b) {
            let expected_cont = if b < 0xe0 {
                1
            } else if b < 0xf0 {
                2
            } else {
                3
            };
            return (expected_cont as usize).saturating_sub(back) as u8;
        }
        if !(0x80..=0xbf).contains(&b) {
            return 0;
        }
        back += 1;
    }
    0
}

fn is_utf8_continuation_before(slice: &[u8], min_idx: usize, pos: usize, prior_emitted: &[u8]) -> bool {
    let get_back = |offset: usize| -> Option<u8> {
        if pos >= min_idx + offset {
            Some(slice[pos - offset])
        } else {
            let rem = offset - (pos - min_idx);
            if rem <= prior_emitted.len() {
                Some(prior_emitted[prior_emitted.len() - rem])
            } else {
                None
            }
        }
    };
    match get_back(1) {
        Some(0xc3..=0xf4) => return true,
        Some(0xc2) => return false, // 0xc2 0x9f is U+009F C1 APC!
        Some(0x80..=0xbf) => {}
        _ => return false,
    }
    match get_back(2) {
        Some(0xe0..=0xf4) => return true,
        Some(0x80..=0xbf) => {}
        _ => return false,
    }
    matches!(get_back(3), Some(0xf0..=0xf4))
}

fn build_synthetic_apc(
    orig_header: &[u8],
    default_action: &str,
    mem_id: u64,
    width: u32,
    height: u32,
) -> Vec<u8> {
    let mut hdr = String::with_capacity(orig_header.len() + 32);
    let mut has_action = false;
    if let Ok(s) = std::str::from_utf8(orig_header) {
        for part in s.split(',') {
            if part.is_empty() {
                continue;
            }
            let Some((k, _)) = part.split_once('=') else {
                continue;
            };
            if k == "a" {
                has_action = true;
            }
            if matches!(
                k,
                "a" | "i"
                    | "I"
                    | "p"
                    | "c"
                    | "r"
                    | "x"
                    | "y"
                    | "w"
                    | "h"
                    | "X"
                    | "Y"
                    | "C"
                    | "U"
                    | "z"
                    | "q"
                    | "f"
            ) {
                if !hdr.is_empty() {
                    hdr.push(',');
                }
                hdr.push_str(part);
            }
        }
    }
    if !has_action {
        if !hdr.is_empty() {
            hdr = format!("a={default_action},{hdr}");
        } else {
            hdr = format!("a={default_action}");
        }
    }
    if !hdr.is_empty() {
        hdr.push(',');
    }
    hdr.push_str("t=d,m=0");
    if width > 0 && height > 0 {
        use std::fmt::Write as _;
        let _ = write!(hdr, ",s={width},v={height}");
    }
    format!("\x1b_G{hdr};pocket-mem:{mem_id}/{width}x{height}\x1b\\").into_bytes()
}

fn decode_chunk_payloads(parts: &[Vec<u8>]) -> Option<Vec<u8>> {
    if parts.len() == 1 {
        return base64_decode(&parts[0]);
    }
    let has_mid_pad = parts
        .iter()
        .take(parts.len().saturating_sub(1))
        .any(|p| p.contains(&b'='));
    if !has_mid_pad {
        let total: usize = parts.iter().map(|p| p.len()).sum();
        let mut combined = Vec::with_capacity(total);
        for p in parts {
            combined.extend_from_slice(p);
        }
        return base64_decode(&combined);
    }
    let mut out = Vec::new();
    for p in parts {
        out.extend_from_slice(&base64_decode(p)?);
    }
    Some(out)
}

fn try_ingest_kitty_image(
    hdr_bytes: &[u8],
    default_action: &str,
    format: Option<u32>,
    medium: Option<&str>,
    hdr_width: Option<u32>,
    hdr_height: Option<u32>,
    payload_parts: &[Vec<u8>],
) -> Option<Vec<u8>> {
    let med = medium.unwrap_or("d");
    let mut unlink_after: Option<PathBuf> = None;
    let mut file_name = String::new();
    let raw_bytes = match med {
        "d" => {
            let bytes = decode_chunk_payloads(payload_parts)?;
            if bytes.is_empty() || bytes.len() > MAX_MEM_TERM_BYTES {
                return None;
            }
            bytes
        }
        "f" | "t" => {
            let path_bytes = decode_chunk_payloads(payload_parts)?;
            let path_str = std::str::from_utf8(&path_bytes)
                .ok()?
                .trim_end_matches('\0')
                .trim();
            if path_str.is_empty() {
                return None;
            }
            let raw_path = PathBuf::from(path_str);
            let (canon, _) = validate_local_image_path(path_str).ok()?;
            file_name = canon
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let bytes = std::fs::read(&canon).ok()?;
            if bytes.is_empty() || bytes.len() > MAX_MEM_TERM_BYTES {
                return None;
            }
            if med == "t" && is_temp_path(&raw_path) && is_temp_path(&canon) {
                if let Ok(meta) = std::fs::symlink_metadata(&raw_path) {
                    if !meta.file_type().is_symlink() && meta.is_file() {
                        unlink_after = Some(raw_path);
                    }
                } else {
                    unlink_after = Some(canon);
                }
            }
            bytes
        }
        _ => return None,
    };

    let (mime, final_bytes, w, h) = match format {
        Some(100) => {
            let sniff_slice = &raw_bytes[..raw_bytes.len().min(65536)];
            let (mime, _, sw, sh) = sniff_image_header_64(sniff_slice, &file_name)?;
            let w = if sw > 0 { sw } else { hdr_width.unwrap_or(0) };
            let h = if sh > 0 { sh } else { hdr_height.unwrap_or(0) };
            (mime, raw_bytes, w, h)
        }
        Some(32) => {
            let w = hdr_width.filter(|&x| x > 0)?;
            let h = hdr_height.filter(|&y| y > 0)?;
            let bmp = build_bmp_v4_from_pixels(w, h, 32, &raw_bytes)?;
            ("image/bmp", bmp, w, h)
        }
        Some(24) => {
            let w = hdr_width.filter(|&x| x > 0)?;
            let h = hdr_height.filter(|&y| y > 0)?;
            let bmp = build_bmp_v4_from_pixels(w, h, 24, &raw_bytes)?;
            ("image/bmp", bmp, w, h)
        }
        None => {
            let sniff_slice = &raw_bytes[..raw_bytes.len().min(65536)];
            if let Some((mime, _, sw, sh)) = sniff_image_header_64(sniff_slice, &file_name) {
                let w = if sw > 0 { sw } else { hdr_width.unwrap_or(0) };
                let h = if sh > 0 { sh } else { hdr_height.unwrap_or(0) };
                (mime, raw_bytes, w, h)
            } else if let (Some(w), Some(h)) = (hdr_width.filter(|&x| x > 0), hdr_height.filter(|&y| y > 0)) {
                let bmp = build_bmp_v4_from_pixels(w, h, 32, &raw_bytes)?;
                ("image/bmp", bmp, w, h)
            } else {
                return None;
            }
        }
        _ => return None,
    };

    let mem_id = insert_mem_image(mime, final_bytes)?;
    if let Some(temp_path) = unlink_after {
        let _ = std::fs::remove_file(temp_path);
    }
    Some(build_synthetic_apc(hdr_bytes, default_action, mem_id, w, h))
}

impl ChannelApcStream {
    pub fn push(&mut self, bytes: &[u8]) -> ApcProcessResult {
        let mut res = ApcProcessResult {
            out_bytes: Vec::with_capacity(bytes.len()),
            auto_replies: Vec::new(),
        };
        if bytes.is_empty() {
            return res;
        }

        let mut i = 0usize;
        if !self.in_apc && !self.pending_prefix.is_empty() {
            let mut joined = Vec::with_capacity(self.pending_prefix.len() + 3);
            joined.extend_from_slice(&self.pending_prefix);
            let take = bytes.len().min(3);
            joined.extend_from_slice(&bytes[..take]);
            if joined.starts_with(b"\x1b_G") {
                let need = 3 - self.pending_prefix.len();
                self.pending_prefix.clear();
                self.in_apc = true;
                self.apc_prefix.clear();
                self.apc_prefix.extend_from_slice(b"\x1b_G");
                self.apc_buf.clear();
                self.apc_passthrough = false;
                i = need;
            } else if joined.starts_with(b"\x9fG") {
                let need = 2 - self.pending_prefix.len();
                self.pending_prefix.clear();
                self.in_apc = true;
                self.apc_prefix.clear();
                self.apc_prefix.extend_from_slice(b"\x9fG");
                self.apc_buf.clear();
                self.apc_passthrough = false;
                i = need;
            } else if joined.starts_with(b"\xc2\x9fG") {
                let need = 3 - self.pending_prefix.len();
                self.pending_prefix.clear();
                self.in_apc = true;
                self.apc_prefix.clear();
                self.apc_prefix.extend_from_slice(b"\xc2\x9fG");
                self.apc_buf.clear();
                self.apc_passthrough = false;
                i = need;
            } else if joined == b"\x1b_" || joined == b"\xc2\x9f" {
                self.pending_prefix = joined;
                return res;
            } else {
                res.out_bytes.extend_from_slice(&self.pending_prefix);
                self.utf8_rem = trailing_utf8_remaining(&self.pending_prefix);
                self.pending_prefix.clear();
            }
        }

        while i < bytes.len() {
            if self.in_apc {
                if self.apc_passthrough {
                    if self.apc_buf.last() == Some(&b'\x1b') && bytes[i] == b'\\' {
                        res.out_bytes.extend_from_slice(b"\x1b\\");
                        self.apc_buf.clear();
                        self.in_apc = false;
                        self.apc_passthrough = false;
                        i += 1;
                        continue;
                    }
                    if self.apc_buf.last() == Some(&0xc2) && bytes[i] == 0x9c {
                        res.out_bytes.extend_from_slice(&[0xc2, 0x9c]);
                        self.apc_buf.clear();
                        self.in_apc = false;
                        self.apc_passthrough = false;
                        i += 1;
                        continue;
                    }
                    if !self.apc_buf.is_empty() {
                        res.out_bytes.extend_from_slice(&self.apc_buf);
                        self.apc_buf.clear();
                    }
                    if let Some(rel) = bytes[i..].iter().position(|&b| b == 0x07 || b == 0x1b || b == 0x9c) {
                        let pos = i + rel;
                        let b = bytes[pos];
                        if b == 0x07 || b == 0x9c {
                            res.out_bytes.extend_from_slice(&bytes[i..=pos]);
                            self.in_apc = false;
                            self.apc_passthrough = false;
                            i = pos + 1;
                        } else if pos + 1 < bytes.len() && bytes[pos + 1] == b'\\' {
                            res.out_bytes.extend_from_slice(&bytes[i..=pos + 1]);
                            self.in_apc = false;
                            self.apc_passthrough = false;
                            i = pos + 2;
                        } else if pos + 1 == bytes.len() {
                            res.out_bytes.extend_from_slice(&bytes[i..pos]);
                            self.apc_buf.push(0x1b);
                            i = bytes.len();
                        } else {
                            res.out_bytes.extend_from_slice(&bytes[i..=pos]);
                            i = pos + 1;
                        }
                    } else if bytes.ends_with(&[0xc2]) {
                        res.out_bytes.extend_from_slice(&bytes[i..bytes.len() - 1]);
                        self.apc_buf.push(0xc2);
                        i = bytes.len();
                    } else {
                        res.out_bytes.extend_from_slice(&bytes[i..]);
                        i = bytes.len();
                    }
                    continue;
                }

                // Check split terminator across frame boundary.
                if self.apc_buf.last() == Some(&b'\x1b') && bytes[i] == b'\\' {
                    self.apc_buf.pop();
                    let content = std::mem::take(&mut self.apc_buf);
                    let prefix = std::mem::take(&mut self.apc_prefix);
                    self.in_apc = false;
                    self.finish_apc(&prefix, &content, b"\x1b\\", &mut res);
                    i += 1;
                    continue;
                }
                if self.apc_buf.last() == Some(&0xc2) && bytes[i] == 0x9c {
                    self.apc_buf.pop();
                    let content = std::mem::take(&mut self.apc_buf);
                    let prefix = std::mem::take(&mut self.apc_prefix);
                    self.in_apc = false;
                    self.finish_apc(&prefix, &content, &[0xc2, 0x9c], &mut res);
                    i += 1;
                    continue;
                }

                if let Some(rel) = bytes[i..].iter().position(|&b| b == 0x07 || b == 0x1b || b == 0x9c) {
                    let pos = i + rel;
                    let b = bytes[pos];
                    if b == 0x07 {
                        self.apc_buf.extend_from_slice(&bytes[i..pos]);
                        let content = std::mem::take(&mut self.apc_buf);
                        let prefix = std::mem::take(&mut self.apc_prefix);
                        self.in_apc = false;
                        self.finish_apc(&prefix, &content, b"\x07", &mut res);
                        i = pos + 1;
                    } else if b == 0x9c {
                        self.apc_buf.extend_from_slice(&bytes[i..pos]);
                        let suffix: &[u8] = if self.apc_buf.last() == Some(&0xc2) {
                            self.apc_buf.pop();
                            &[0xc2, 0x9c]
                        } else {
                            &[0x9c]
                        };
                        let content = std::mem::take(&mut self.apc_buf);
                        let prefix = std::mem::take(&mut self.apc_prefix);
                        self.in_apc = false;
                        self.finish_apc(&prefix, &content, suffix, &mut res);
                        i = pos + 1;
                    } else if pos + 1 < bytes.len() && bytes[pos + 1] == b'\\' {
                        self.apc_buf.extend_from_slice(&bytes[i..pos]);
                        let content = std::mem::take(&mut self.apc_buf);
                        let prefix = std::mem::take(&mut self.apc_prefix);
                        self.in_apc = false;
                        self.finish_apc(&prefix, &content, b"\x1b\\", &mut res);
                        i = pos + 2;
                    } else {
                        self.apc_buf.extend_from_slice(&bytes[i..=pos]);
                        i = pos + 1;
                    }
                } else {
                    self.apc_buf.extend_from_slice(&bytes[i..]);
                    i = bytes.len();
                }

                if self.in_apc && self.apc_buf.len() > MAX_SINGLE_APC_BYTES {
                    self.flush_active_chunked(&mut res);
                    res.out_bytes.extend_from_slice(&self.apc_prefix);
                    res.out_bytes.extend_from_slice(&self.apc_buf);
                    self.apc_prefix.clear();
                    self.apc_buf.clear();
                    self.apc_passthrough = true;
                }
                continue;
            }

            // Ground state: pass non-APC VT bytes straight through with zero buffering lag.
            while i < bytes.len() && self.utf8_rem > 0 && (0x80..=0xbf).contains(&bytes[i]) {
                res.out_bytes.push(bytes[i]);
                i += 1;
                self.utf8_rem -= 1;
            }
            if i < bytes.len() && self.utf8_rem > 0 {
                self.utf8_rem = 0;
            }
            if i >= bytes.len() {
                break;
            }

            let Some(rel) = bytes[i..]
                .iter()
                .position(|&b| b == 0x1b || b == 0x9f || b == 0xc2)
            else {
                res.out_bytes.extend_from_slice(&bytes[i..]);
                self.utf8_rem = trailing_utf8_remaining(&bytes[i..]);
                break;
            };
            let pos = i + rel;
            let b = bytes[pos];
            if b == 0x1b {
                if pos + 1 == bytes.len() {
                    res.out_bytes.extend_from_slice(&bytes[i..pos]);
                    self.pending_prefix.push(0x1b);
                    break;
                }
                if bytes[pos + 1] == b'_' {
                    if pos + 2 == bytes.len() {
                        res.out_bytes.extend_from_slice(&bytes[i..pos]);
                        self.pending_prefix.extend_from_slice(b"\x1b_");
                        break;
                    }
                    if bytes[pos + 2] == b'G' {
                        res.out_bytes.extend_from_slice(&bytes[i..pos]);
                        self.in_apc = true;
                        self.apc_prefix.clear();
                        self.apc_prefix.extend_from_slice(b"\x1b_G");
                        self.apc_buf.clear();
                        self.apc_passthrough = false;
                        i = pos + 3;
                        continue;
                    }
                    res.out_bytes.extend_from_slice(&bytes[i..=pos + 1]);
                    self.utf8_rem = 0;
                    i = pos + 2;
                    continue;
                }
                res.out_bytes.extend_from_slice(&bytes[i..=pos]);
                self.utf8_rem = 0;
                i = pos + 1;
            } else if b == 0xc2 {
                if pos + 1 == bytes.len() {
                    res.out_bytes.extend_from_slice(&bytes[i..pos]);
                    self.pending_prefix.push(0xc2);
                    break;
                }
                if bytes[pos + 1] == 0x9f {
                    if pos + 2 == bytes.len() {
                        res.out_bytes.extend_from_slice(&bytes[i..pos]);
                        self.pending_prefix.extend_from_slice(&[0xc2, 0x9f]);
                        break;
                    }
                    if bytes[pos + 2] == b'G' {
                        res.out_bytes.extend_from_slice(&bytes[i..pos]);
                        self.in_apc = true;
                        self.apc_prefix.clear();
                        self.apc_prefix.extend_from_slice(b"\xc2\x9fG");
                        self.apc_buf.clear();
                        self.apc_passthrough = false;
                        i = pos + 3;
                        continue;
                    }
                    res.out_bytes.extend_from_slice(&bytes[i..=pos + 1]);
                    self.utf8_rem = 0;
                    i = pos + 2;
                    continue;
                }
                res.out_bytes.extend_from_slice(&bytes[i..=pos + 1]);
                self.utf8_rem = 0;
                i = pos + 2;
            } else {
                // b == 0x9f
                if is_utf8_continuation_before(bytes, i, pos, &res.out_bytes) {
                    res.out_bytes.extend_from_slice(&bytes[i..=pos]);
                    self.utf8_rem = trailing_utf8_remaining(&bytes[i..=pos]);
                    i = pos + 1;
                    continue;
                }
                if pos + 1 == bytes.len() {
                    res.out_bytes.extend_from_slice(&bytes[i..pos]);
                    self.pending_prefix.push(0x9f);
                    break;
                }
                if bytes[pos + 1] == b'G' {
                    res.out_bytes.extend_from_slice(&bytes[i..pos]);
                    self.in_apc = true;
                    self.apc_prefix.clear();
                    self.apc_prefix.extend_from_slice(b"\x9fG");
                    self.apc_buf.clear();
                    self.apc_passthrough = false;
                    i = pos + 2;
                    continue;
                }
                res.out_bytes.extend_from_slice(&bytes[i..=pos]);
                self.utf8_rem = 0;
                i = pos + 1;
            }
        }

        res
    }

    fn flush_active_chunked(&mut self, res: &mut ApcProcessResult) {
        if let Some(active) = self.chunked.take() {
            if !active.passthrough {
                for chunk in active.raw_chunks {
                    res.out_bytes.extend_from_slice(&chunk);
                }
            }
        }
    }

    fn finish_apc(
        &mut self,
        prefix: &[u8],
        content: &[u8],
        suffix: &[u8],
        res: &mut ApcProcessResult,
    ) {
        let semi = content.iter().position(|&b| b == b';');
        let (hdr_bytes, payload_bytes) = match semi {
            Some(idx) => (&content[..idx], &content[idx + 1..]),
            None => (content, &[][..]),
        };
        let hdr = parse_kitty_header(hdr_bytes);

        let emit_raw = |out: &mut Vec<u8>| {
            out.extend_from_slice(prefix);
            out.extend_from_slice(content);
            out.extend_from_slice(suffix);
        };

        if let Some(mut active) = self.chunked.take() {
            let is_cont = hdr.action.is_none()
                || (hdr.action == Some(active.action.as_str())
                    && active.id.is_some()
                    && hdr.id == active.id);
            if is_cont {
                if active.passthrough {
                    emit_raw(&mut res.out_bytes);
                    if hdr.more {
                        self.chunked = Some(active);
                    }
                    return;
                }
                let chunk_raw_len = prefix.len() + content.len() + suffix.len();
                if active.total_raw_bytes + chunk_raw_len > MAX_SINGLE_APC_BYTES {
                    for chunk in active.raw_chunks.drain(..) {
                        res.out_bytes.extend_from_slice(&chunk);
                    }
                    emit_raw(&mut res.out_bytes);
                    if hdr.more {
                        active.passthrough = true;
                        active.payload_parts.clear();
                        self.chunked = Some(active);
                    }
                    return;
                }
                let mut raw = Vec::with_capacity(chunk_raw_len);
                raw.extend_from_slice(prefix);
                raw.extend_from_slice(content);
                raw.extend_from_slice(suffix);
                active.total_raw_bytes += raw.len();
                active.raw_chunks.push(raw);
                active.payload_parts.push(payload_bytes.to_vec());

                if hdr.more {
                    self.chunked = Some(active);
                    return;
                }

                if let Some(synthetic) = try_ingest_kitty_image(
                    &active.first_header,
                    &active.action,
                    active.format,
                    active.medium.as_deref(),
                    active.width,
                    active.height,
                    &active.payload_parts,
                ) {
                    res.out_bytes.extend_from_slice(&synthetic);
                } else {
                    for chunk in active.raw_chunks {
                        res.out_bytes.extend_from_slice(&chunk);
                    }
                }
                return;
            }
            if !active.passthrough {
                for chunk in active.raw_chunks {
                    res.out_bytes.extend_from_slice(&chunk);
                }
            }
        }

        // Probe unlink: `a=q` with `t=t`
        if hdr.action == Some("q") && hdr.medium == Some("t") && !hdr.more {
            if let Some(path_bytes) = base64_decode(payload_bytes) {
                if let Ok(path_str) = std::str::from_utf8(&path_bytes) {
                    let trimmed = path_str.trim_end_matches('\0').trim();
                    if !trimmed.is_empty() {
                        let raw_path = Path::new(trimmed);
                        if is_temp_path(raw_path) {
                            let unlinked = match std::fs::symlink_metadata(raw_path) {
                                Ok(meta) if !meta.file_type().is_symlink() && meta.is_file() => {
                                    std::fs::remove_file(raw_path).is_ok()
                                }
                                Ok(_) => false,
                                Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
                                Err(_) => false,
                            };
                            if unlinked {
                                if hdr.quiet == 0 {
                                    if let Some(id) = hdr.id {
                                        res.auto_replies
                                            .push(format!("\x1b_Gi={id};OK\x1b\\").into_bytes());
                                    } else if let Some(num) = hdr.image_number {
                                        res.auto_replies
                                            .push(format!("\x1b_GI={num};OK\x1b\\").into_bytes());
                                    }
                                }
                                return;
                            }
                        }
                    }
                }
            }
            emit_raw(&mut res.out_bytes);
            return;
        }

        let is_upload_action = match hdr.action {
            Some("t") | Some("T") => true,
            None => {
                !payload_bytes.is_empty()
                    && (hdr.format.is_some()
                        || hdr.medium.is_some()
                        || (hdr.width.is_some() && hdr.height.is_some()))
            }
            Some(_) => false,
        };
        let eligible_medium = matches!(hdr.medium, None | Some("d") | Some("f") | Some("t"));
        let eligible_format = matches!(hdr.format, None | Some(100) | Some(32) | Some(24));
        let eligible_comp = hdr.compression.is_none();

        if !is_upload_action || !eligible_medium || !eligible_format || !eligible_comp {
            emit_raw(&mut res.out_bytes);
            if hdr.more {
                self.chunked = Some(ActiveChunkUpload {
                    action: hdr.action.unwrap_or("t").to_string(),
                    id: hdr.id,
                    first_header: Vec::new(),
                    format: hdr.format,
                    medium: hdr.medium.map(str::to_string),
                    width: hdr.width,
                    height: hdr.height,
                    passthrough: true,
                    raw_chunks: Vec::new(),
                    payload_parts: Vec::new(),
                    total_raw_bytes: 0,
                });
            }
            return;
        }

        let action_str = hdr.action.unwrap_or("t");
        if hdr.more {
            let dim_too_big = matches!(hdr.format, Some(24) | Some(32))
                && hdr
                    .width
                    .zip(hdr.height)
                    .and_then(|(w, h)| (w as usize).checked_mul(h as usize)?.checked_mul(4))
                    .is_some_and(|n| n + 122 > MAX_MEM_TERM_BYTES);
            if dim_too_big {
                emit_raw(&mut res.out_bytes);
                self.chunked = Some(ActiveChunkUpload {
                    action: action_str.to_string(),
                    id: hdr.id,
                    first_header: Vec::new(),
                    format: hdr.format,
                    medium: hdr.medium.map(str::to_string),
                    width: hdr.width,
                    height: hdr.height,
                    passthrough: true,
                    raw_chunks: Vec::new(),
                    payload_parts: Vec::new(),
                    total_raw_bytes: 0,
                });
                return;
            }
            let raw_len = prefix.len() + content.len() + suffix.len();
            let mut raw = Vec::with_capacity(raw_len);
            raw.extend_from_slice(prefix);
            raw.extend_from_slice(content);
            raw.extend_from_slice(suffix);
            self.chunked = Some(ActiveChunkUpload {
                action: action_str.to_string(),
                id: hdr.id,
                first_header: hdr_bytes.to_vec(),
                format: hdr.format,
                medium: hdr.medium.map(str::to_string),
                width: hdr.width,
                height: hdr.height,
                passthrough: false,
                raw_chunks: vec![raw],
                payload_parts: vec![payload_bytes.to_vec()],
                total_raw_bytes: raw_len,
            });
            return;
        }

        let single_part = [payload_bytes.to_vec()];
        if let Some(synthetic) = try_ingest_kitty_image(
            hdr_bytes,
            action_str,
            hdr.format,
            hdr.medium,
            hdr.width,
            hdr.height,
            &single_part,
        ) {
            res.out_bytes.extend_from_slice(&synthetic);
        } else {
            emit_raw(&mut res.out_bytes);
        }
    }
}

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

    #[test]
    fn base64_decode_handles_fast_path_padding_and_whitespace() {
        use super::base64_decode;
        assert_eq!(base64_decode(b"").unwrap(), b"");
        assert_eq!(base64_decode(b"Zg==").unwrap(), b"f");
        assert_eq!(base64_decode(b"Zm8=").unwrap(), b"fo");
        assert_eq!(base64_decode(b"aGVsbG8gd29ybGQ=").unwrap(), b"hello world");
        assert_eq!(base64_decode(b"aGVs\nbG8g\r\nd29y\tbGQ=").unwrap(), b"hello world");
        let raw: Vec<u8> = (0u8..=255).cycle().take(1000).collect();
        let enc = base64_encode(&raw);
        assert_eq!(base64_decode(enc.as_bytes()).unwrap(), raw);
        assert!(base64_decode(b"!!!").is_none());
        assert!(base64_decode(b"A").is_none());
    }

    #[test]
    fn bmp_v4_encoder_writes_122_byte_header_and_top_down_rgba_pixels() {
        use super::build_bmp_v4_from_pixels;

        let rgba = [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 10, 20, 30, 0];
        let bmp = build_bmp_v4_from_pixels(2, 2, 32, &rgba).unwrap();
        assert_eq!(bmp.len(), 122 + 16);
        assert_eq!(&bmp[0..2], b"BM");
        assert_eq!(u32::from_le_bytes(bmp[2..6].try_into().unwrap()), 138);
        assert_eq!(u32::from_le_bytes(bmp[10..14].try_into().unwrap()), 122);
        assert_eq!(u32::from_le_bytes(bmp[14..18].try_into().unwrap()), 108);
        assert_eq!(i32::from_le_bytes(bmp[18..22].try_into().unwrap()), 2);
        assert_eq!(i32::from_le_bytes(bmp[22..26].try_into().unwrap()), -2);
        assert_eq!(u16::from_le_bytes(bmp[28..30].try_into().unwrap()), 32);
        assert_eq!(u32::from_le_bytes(bmp[30..34].try_into().unwrap()), 3);
        assert_eq!(u32::from_le_bytes(bmp[54..58].try_into().unwrap()), 0x0000_00ff);
        assert_eq!(u32::from_le_bytes(bmp[58..62].try_into().unwrap()), 0x0000_ff00);
        assert_eq!(u32::from_le_bytes(bmp[62..66].try_into().unwrap()), 0x00ff_0000);
        assert_eq!(u32::from_le_bytes(bmp[66..70].try_into().unwrap()), 0xff00_0000);
        assert_eq!(&bmp[122..], &rgba);

        let rgb = [10, 20, 30, 40, 50, 60];
        let bmp24 = build_bmp_v4_from_pixels(2, 1, 24, &rgb).unwrap();
        assert_eq!(bmp24.len(), 122 + 8);
        assert_eq!(i32::from_le_bytes(bmp24[22..26].try_into().unwrap()), -1);
        assert_eq!(&bmp24[122..], &[10, 20, 30, 255, 40, 50, 60, 255]);
    }

    #[test]
    fn apc_stream_intercepts_chunked_f32_and_f100_across_frame_boundaries() {
        use super::{get_mem_image, ChannelApcStream};

        let rgba = vec![
            255, 10, 20, 255, 30, 40, 50, 200,
            60, 70, 80, 100, 90, 100, 110, 0,
        ];
        let b64 = base64_encode(&rgba);
        let split_at = b64.len() / 2;
        let stream_bytes = format!(
            "hello \x1b_Ga=T,f=32,s=2,v=2,i=42,p=7,c=2,r=1,x=1,y=1,w=2,h=2,X=2,Y=3,C=1,U=0,z=-1,q=2,m=1;{}\x1b\\\
             \x1b_Gm=0;{}\x1b\\ world",
            &b64[..split_at],
            &b64[split_at..],
        );

        // Feed 1 byte at a time to exercise every prefix, suffix, and frame split.
        let mut parser = ChannelApcStream::default();
        let mut out = Vec::new();
        for b in stream_bytes.as_bytes().chunks(1) {
            let res = parser.push(b);
            assert!(res.auto_replies.is_empty());
            out.extend_from_slice(&res.out_bytes);
        }
        let out_str = String::from_utf8(out).unwrap();
        assert!(out_str.starts_with("hello \x1b_G"), "{out_str}");
        assert!(out_str.ends_with(" world"), "{out_str}");
        assert!(out_str.contains(";pocket-mem:"), "{out_str}");
        assert!(out_str.contains("/2x2\x1b\\"), "{out_str}");
        assert!(out_str.contains("a=T"));
        assert!(out_str.contains("i=42"));
        assert!(out_str.contains("p=7"));
        assert!(out_str.contains("c=2,r=1"));
        assert!(out_str.contains("X=2,Y=3"));
        assert!(out_str.contains("C=1,U=0,z=-1,q=2"));
        assert!(out_str.contains("t=d,m=0,s=2,v=2"));

        let mem_part = out_str.split(";pocket-mem:").nth(1).unwrap();
        let mem_id: u64 = mem_part.split('/').next().unwrap().parse().unwrap();
        let (mime, cached) = get_mem_image(mem_id).unwrap();
        assert_eq!(mime, "image/bmp");
        assert_eq!(&cached[122..], rgba.as_slice());

        // f=100 PNG via C1 \x9fG...\x9c and BEL \x1b_G...\x07
        let mut png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&64u32.to_be_bytes());
        png.extend_from_slice(&32u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        let png_b64 = base64_encode(&png);
        let mut c1_stream = Vec::new();
        c1_stream.extend_from_slice(b"pre");
        c1_stream.extend_from_slice(format!("\x1b_Ga=t,f=100,i=8;{png_b64}\x07").as_bytes());
        c1_stream.extend_from_slice(&[0x9f, b'G']);
        c1_stream.extend_from_slice(format!("a=T,f=100,i=9;{png_b64}").as_bytes());
        c1_stream.push(0x9c);
        c1_stream.extend_from_slice(b"post");

        let mut parser2 = ChannelApcStream::default();
        let mut out2 = Vec::new();
        for chunk in c1_stream.chunks(3) {
            out2.extend_from_slice(&parser2.push(chunk).out_bytes);
        }
        let out2_str = String::from_utf8(out2).unwrap();
        assert!(out2_str.starts_with("pre\x1b_G"));
        assert!(out2_str.contains("/64x32\x1b\\"));
        assert!(out2_str.ends_with("post"));
        let ids: Vec<u64> = out2_str
            .split(";pocket-mem:")
            .skip(1)
            .map(|s| s.split('/').next().unwrap().parse::<u64>().unwrap())
            .collect();
        assert_eq!(ids.len(), 2);
        for id in ids {
            let (m, bytes) = get_mem_image(id).unwrap();
            assert_eq!(m, "image/png");
            assert_eq!(bytes.as_slice(), png.as_slice());
        }
    }

    #[test]
    fn apc_stream_unlinks_probes_and_t_files_safely_and_preserves_utf8() {
        use super::{get_mem_image, ChannelApcStream};

        let dir = std::env::temp_dir().join(format!("herdr-apc-probe-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // 1. Probe with q=2 (herdr FileTransport style): unlink + strip + no reply
        let probe_q2 = dir.join("tty-graphics-protocol-probe-q2");
        std::fs::write(&probe_q2, [0, 0, 0, 0]).unwrap();
        let probe_q2_b64 = base64_encode(probe_q2.to_string_lossy().as_bytes());
        let mut parser = ChannelApcStream::default();
        let r1 = parser.push(format!("A\x1b_Ga=q,t=t,f=32,s=1,v=1,i=1,q=2;{probe_q2_b64}\x1b\\B").as_bytes());
        assert_eq!(r1.out_bytes, b"AB");
        assert!(r1.auto_replies.is_empty());
        assert!(!probe_q2.exists());

        // 2. Probe with q=0: unlink + strip + OK reply
        let probe_q0 = dir.join("tty-graphics-protocol-probe-q0");
        std::fs::write(&probe_q0, [0, 0, 0, 0]).unwrap();
        let probe_q0_b64 = base64_encode(probe_q0.to_string_lossy().as_bytes());
        let r2 = parser.push(format!("\x1b_Ga=q,t=t,f=32,s=1,v=1,i=55,q=0;{probe_q0_b64}\x1b\\").as_bytes());
        assert!(r2.out_bytes.is_empty());
        assert_eq!(r2.auto_replies, vec![b"\x1b_Gi=55;OK\x1b\\".to_vec()]);
        assert!(!probe_q0.exists());

        // 3. t=t temp image read into memory THEN unlinked; t=f kept on disk
        let temp_rgba = dir.join("tty-graphics-protocol-1");
        std::fs::write(&temp_rgba, [1, 2, 3, 255]).unwrap();
        let temp_b64 = base64_encode(temp_rgba.to_string_lossy().as_bytes());
        let r3 = parser.push(format!("\x1b_Ga=T,t=t,f=32,s=1,v=1,i=77,q=2;{temp_b64}\x1b\\").as_bytes());
        assert!(!temp_rgba.exists(), "t=t file must be unlinked after ingest");
        let r3_str = String::from_utf8(r3.out_bytes).unwrap();
        let id3: u64 = r3_str.split(";pocket-mem:").nth(1).unwrap().split('/').next().unwrap().parse().unwrap();
        assert_eq!(&get_mem_image(id3).unwrap().1[122..], &[1, 2, 3, 255]);

        let perm_png = dir.join("keep.png");
        let mut png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&12u32.to_be_bytes());
        png.extend_from_slice(&16u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        std::fs::write(&perm_png, &png).unwrap();
        let perm_b64 = base64_encode(perm_png.to_string_lossy().as_bytes());
        let r4 = parser.push(format!("\x1b_Ga=T,t=f,f=100,i=78;{perm_b64}\x1b\\").as_bytes());
        assert!(perm_png.exists(), "t=f file must stay on disk");
        assert!(String::from_utf8(r4.out_bytes).unwrap().contains("/12x16\x1b\\"));

        // 4. UTF-8 multi-byte sequences containing 0x9f (e.g. `ßG`, `🚀G`) and o=z / a=p / a=d pass untouched
        let passthrough = "ßG 🚀G \x1b_Ga=T,o=z,f=32,s=1,v=1;eJw=\x1b\\ \x1b_Ga=p,i=77\x1b\\ \x1b_Ga=d,d=a\x1b\\";
        let mut out_pt = Vec::new();
        for ch in passthrough.as_bytes().chunks(1) {
            out_pt.extend_from_slice(&parser.push(ch).out_bytes);
        }
        assert_eq!(out_pt, passthrough.as_bytes());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mem_image_cache_enforces_64_entry_lru_bound() {
        use super::{get_mem_image, insert_mem_image};

        let first = insert_mem_image("image/png", vec![1, 2, 3]).unwrap();
        let mut ids = vec![first];
        for i in 1..64 {
            ids.push(insert_mem_image("image/png", vec![i as u8; 4]).unwrap());
        }
        // Touch `first` so it becomes MRU and `ids[1]` becomes LRU.
        assert!(get_mem_image(first).is_some());
        let extra = insert_mem_image("image/png", vec![99; 4]).unwrap();
        assert!(get_mem_image(extra).is_some());
        assert!(get_mem_image(first).is_some(), "MRU entry must survive eviction");
        assert!(get_mem_image(ids[1]).is_none(), "LRU entry must be evicted at cap");
    }

    #[test]
    fn parse_size_event_extracts_valid_terminal_dimensions() {
        use super::parse_size_event;
        use serde_json::json;

        let valid = json!({
            "jsonrpc": "2.0",
            "method": "event",
            "params": { "type": "size", "terminal": "t1bf", "data": { "cols": 120, "rows": 40 } }
        });
        let parsed = parse_size_event(&valid).expect("valid size event should parse");
        assert_eq!(parsed.terminal, "t1bf");
        assert_eq!(parsed.cols, 120);
        assert_eq!(parsed.rows, 40);

        let zero_rows = json!({
            "method": "event",
            "params": { "type": "size", "terminal": "t1bf", "data": { "cols": 120, "rows": 0 } }
        });
        assert!(parse_size_event(&zero_rows).is_none());

        let other_type = json!({
            "method": "event",
            "params": { "type": "doc", "terminal": "t1bf", "data": { "cols": 120, "rows": 40 } }
        });
        assert!(parse_size_event(&other_type).is_none());
    }
}
