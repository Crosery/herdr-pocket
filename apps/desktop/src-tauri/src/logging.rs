//! The desktop client's log.
//!
//! Every line is one JSON object in `herdr-pocket-desktop.log` inside the OS log
//! folder (macOS `~/Library/Logs/<bundle id>/`, Windows
//! `%LOCALAPPDATA%\<bundle id>\logs`). The file rotates at 2 MB and five files
//! are kept (about 10 MB). A writer thread does the disk work so callers never
//! block on I/O. Lines are redacted before they are queued (see `redact`).
//!
//! Warnings, errors and lifecycle lines (startup, pairing, relay link, updates,
//! voice input, browser, permissions) also go into a small queue that `relaylog`
//! uploads to the relay's log table, the way the phone app does.

use crate::redact;
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const FILE_STEM: &str = "herdr-pocket-desktop";
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// The current file plus four rotated ones.
pub const KEEP_FILES: usize = 5;
const MSG_MAX: usize = 500;
/// Strings inside `data` in the local file (stacks need room).
const FILE_VALUE_MAX: usize = 2000;
/// Strings inside `data` sent to the relay (it clips to 300 as well).
const RELAY_VALUE_MAX: usize = 300;
const RELAY_QUEUE_MAX: usize = 500;
const PENDING_MAX: usize = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Debug = 0,
    Info = 1,
    Warn = 2,
    Error = 3,
}

impl Level {
    pub fn parse(s: &str) -> Option<Level> {
        match s.trim().to_ascii_lowercase().as_str() {
            "debug" | "trace" => Some(Level::Debug),
            "info" | "log" => Some(Level::Info),
            "warn" | "warning" => Some(Level::Warn),
            "error" | "fatal" => Some(Level::Error),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }

    fn from_u8(v: u8) -> Level {
        match v {
            0 => Level::Debug,
            1 => Level::Info,
            2 => Level::Warn,
            _ => Level::Error,
        }
    }
}

/// What the relay's POST /v1/logs takes (`ClientLogEntry` in packages/protocol).
#[derive(Clone, Debug, Serialize)]
pub struct RelayEntry {
    pub ts: i64,
    pub level: Level,
    pub kind: String,
    pub msg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Serialize)]
struct FileLine<'a> {
    ts: i64,
    t: String,
    level: Level,
    /// `native` (Rust) or `web` (the app's JavaScript).
    src: &'a str,
    kind: &'a str,
    msg: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<&'a Value>,
}

enum Cmd {
    Line(String),
    Flush(Sender<()>),
}

struct Logger {
    tx: Mutex<Option<Sender<Cmd>>>,
    /// Lines logged before `init` (or when the folder could not be opened).
    pending: Mutex<Vec<String>>,
    relay: Mutex<VecDeque<RelayEntry>>,
    min_level: AtomicU8,
    upload: AtomicBool,
    dir: OnceLock<PathBuf>,
}

fn logger() -> &'static Logger {
    static LOGGER: OnceLock<Logger> = OnceLock::new();
    LOGGER.get_or_init(|| Logger {
        tx: Mutex::new(None),
        pending: Mutex::new(Vec::new()),
        relay: Mutex::new(VecDeque::new()),
        min_level: AtomicU8::new(if cfg!(debug_assertions) { 0 } else { 1 }),
        upload: AtomicBool::new(true),
        dir: OnceLock::new(),
    })
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Areas whose `info` lines the relay keeps too (warn and error always go).
fn relay_worthy(level: Level, kind: &str) -> bool {
    if level >= Level::Warn {
        return kind != "dep" || level == Level::Error;
    }
    if level != Level::Info {
        return false;
    }
    let area = kind.split('.').next().unwrap_or(kind);
    matches!(
        area,
        "app"
            | "config"
            | "pair"
            | "link"
            | "update"
            | "voice"
            | "hotkey"
            | "browser"
            | "cookie"
            | "perm"
            | "ui"
            | "chat"
            | "model"
            | "term"
            | "agent"
            | "files"
            | "relay"
            | "startup"
            | "onboarding"
    )
}

/// Writes one line. `data` may be `Value::Null` for none. Never panics, never blocks on disk.
pub fn write(level: Level, src: &str, kind: &str, msg: &str, data: Value) {
    let lg = logger();
    if (level as u8) < lg.min_level.load(Ordering::Relaxed) {
        return;
    }
    let kind = redact::clip(kind.trim(), 40);
    let kind = if kind.is_empty() {
        "app".to_string()
    } else {
        kind
    };
    let msg = redact::line(msg, MSG_MAX);
    let ts = now_ms();
    let mut file_data = match data {
        Value::Null => None,
        Value::Object(ref m) if m.is_empty() => None,
        other => Some(other),
    };
    let relay_data = file_data.as_ref().map(|d| {
        let mut d = d.clone();
        redact::value(&mut d, RELAY_VALUE_MAX);
        d
    });
    if let Some(d) = file_data.as_mut() {
        redact::value(d, FILE_VALUE_MAX);
    }
    let line = FileLine {
        ts,
        t: local_time(ts),
        level,
        src,
        kind: &kind,
        msg: &msg,
        data: file_data.as_ref(),
    };
    let Ok(json) = serde_json::to_string(&line) else {
        return;
    };
    if cfg!(debug_assertions) {
        eprintln!("[{}] {} {}: {}", level.as_str(), src, kind, msg);
    }
    send_line(json);
    if lg.upload.load(Ordering::Relaxed) && relay_worthy(level, &kind) {
        if let Ok(mut q) = lg.relay.lock() {
            q.push_back(RelayEntry {
                ts,
                level,
                kind,
                msg,
                data: relay_data,
            });
            while q.len() > RELAY_QUEUE_MAX {
                q.pop_front();
            }
        }
    }
}

fn send_line(json: String) {
    let lg = logger();
    let tx = lg.tx.lock().ok().and_then(|g| g.clone());
    match tx {
        Some(tx) => {
            if let Err(mpsc::SendError(Cmd::Line(json))) = tx.send(Cmd::Line(json)) {
                push_pending(json);
            }
        }
        None => push_pending(json),
    }
}

fn push_pending(json: String) {
    if let Ok(mut p) = logger().pending.lock() {
        if p.len() >= PENDING_MAX {
            p.remove(0);
        }
        p.push(json);
    }
}

pub fn debug(kind: &str, msg: impl AsRef<str>, data: Value) {
    write(Level::Debug, "native", kind, msg.as_ref(), data);
}
pub fn info(kind: &str, msg: impl AsRef<str>, data: Value) {
    write(Level::Info, "native", kind, msg.as_ref(), data);
}
pub fn warn(kind: &str, msg: impl AsRef<str>, data: Value) {
    write(Level::Warn, "native", kind, msg.as_ref(), data);
}
pub fn error(kind: &str, msg: impl AsRef<str>, data: Value) {
    write(Level::Error, "native", kind, msg.as_ref(), data);
}

pub fn set_min_level(level: Level) {
    logger().min_level.store(level as u8, Ordering::Relaxed);
}

pub fn min_level() -> Level {
    Level::from_u8(logger().min_level.load(Ordering::Relaxed))
}

/// `logging.upload` in config.json. Turning it off also drops what is waiting.
pub fn set_upload(on: bool) {
    let lg = logger();
    lg.upload.store(on, Ordering::Relaxed);
    if !on {
        if let Ok(mut q) = lg.relay.lock() {
            q.clear();
        }
    }
}

pub fn upload_enabled() -> bool {
    logger().upload.load(Ordering::Relaxed)
}

/// Up to `max` queued relay lines, oldest first.
pub fn take_relay_batch(max: usize) -> Vec<RelayEntry> {
    let Ok(mut q) = logger().relay.lock() else {
        return Vec::new();
    };
    let n = max.min(q.len());
    q.drain(..n).collect()
}

/// Puts lines that could not be sent back in front of the queue.
pub fn requeue(batch: Vec<RelayEntry>) {
    let Ok(mut q) = logger().relay.lock() else {
        return;
    };
    for e in batch.into_iter().rev() {
        q.push_front(e);
    }
    while q.len() > RELAY_QUEUE_MAX {
        q.pop_back();
    }
}

pub fn relay_queue_len() -> usize {
    logger().relay.lock().map(|q| q.len()).unwrap_or(0)
}

/// Keeps only the newest `keep` relay lines (the demo has no relay to take them).
pub fn trim_relay_queue(keep: usize) {
    if let Ok(mut q) = logger().relay.lock() {
        while q.len() > keep {
            q.pop_front();
        }
    }
}

pub fn log_dir() -> Option<PathBuf> {
    logger().dir.get().cloned()
}

pub fn file_name(index: usize) -> String {
    if index == 0 {
        format!("{FILE_STEM}.log")
    } else {
        format!("{FILE_STEM}.{index}.log")
    }
}

/// Log files, oldest first.
pub fn files(dir: &Path) -> Vec<PathBuf> {
    (0..KEEP_FILES)
        .rev()
        .map(|i| dir.join(file_name(i)))
        .filter(|p| p.is_file())
        .collect()
}

/// Opens the folder, starts the writer thread and writes what was logged before.
pub fn init(dir: PathBuf, keep_days: u32) {
    let lg = logger();
    if lg.dir.get().is_some() {
        return;
    }
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("[log] cannot create {}: {e}", dir.display());
        return;
    }
    prune_old(&dir, keep_days);
    let _ = lg.dir.set(dir.clone());
    let (tx, rx) = mpsc::channel::<Cmd>();
    let spawned = std::thread::Builder::new()
        .name("pocket-log".into())
        .spawn(move || writer_loop(dir, rx));
    if spawned.is_err() {
        return;
    }
    let pending = lg
        .pending
        .lock()
        .map(|mut p| std::mem::take(&mut *p))
        .unwrap_or_default();
    for line in pending {
        let _ = tx.send(Cmd::Line(line));
    }
    if let Ok(mut g) = lg.tx.lock() {
        *g = Some(tx);
    }
    install_panic_hook();
    install_dep_logger();
}

/// Waits (up to `timeout`) until everything sent so far is on disk.
pub fn flush(timeout: Duration) {
    let tx = logger().tx.lock().ok().and_then(|g| g.clone());
    if let Some(tx) = tx {
        let (ack_tx, ack_rx) = mpsc::channel();
        if tx.send(Cmd::Flush(ack_tx)).is_ok() {
            let _ = ack_rx.recv_timeout(timeout);
        }
    }
}

fn open_append(path: &Path) -> Option<BufWriter<File>> {
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
        .ok()
        .map(|f| BufWriter::with_capacity(16 * 1024, f))
}

/// `x.log` -> `x.1.log` -> ... -> `x.4.log` (dropped).
pub fn rotate(dir: &Path) {
    let _ = fs::remove_file(dir.join(file_name(KEEP_FILES - 1)));
    for i in (0..KEEP_FILES - 1).rev() {
        let from = dir.join(file_name(i));
        if from.exists() {
            let _ = fs::rename(&from, dir.join(file_name(i + 1)));
        }
    }
}

fn writer_loop(dir: PathBuf, rx: Receiver<Cmd>) {
    let path = dir.join(file_name(0));
    let mut size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut out = open_append(&path);
    while let Ok(first) = rx.recv() {
        let mut acks = Vec::new();
        let mut next = Some(first);
        while let Some(cmd) = next.take() {
            match cmd {
                Cmd::Line(line) => {
                    let len = line.len() as u64 + 1;
                    if size > 0 && size + len > MAX_FILE_BYTES {
                        if let Some(mut w) = out.take() {
                            let _ = w.flush();
                        }
                        rotate(&dir);
                        out = open_append(&path);
                        size = 0;
                    }
                    if let Some(w) = out.as_mut() {
                        if w.write_all(line.as_bytes())
                            .and_then(|_| w.write_all(b"\n"))
                            .is_ok()
                        {
                            size += len;
                        }
                    } else {
                        // The folder went away (cleaned by hand): try again on the next line.
                        out = open_append(&path);
                    }
                }
                Cmd::Flush(ack) => acks.push(ack),
            }
            next = rx.try_recv().ok();
        }
        if let Some(w) = out.as_mut() {
            let _ = w.flush();
        }
        for ack in acks {
            let _ = ack.send(());
        }
    }
}

/// Rotated files older than `keep_days` (`logging.keepDays`) go; the current file stays.
fn prune_old(dir: &Path, keep_days: u32) {
    let max_age = Duration::from_secs(u64::from(keep_days.max(1)) * 86_400);
    for i in 1..=KEEP_FILES + 4 {
        let p = dir.join(file_name(i));
        let Ok(meta) = fs::metadata(&p) else { continue };
        let old = meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age > max_age);
        if i >= KEEP_FILES || old {
            let _ = fs::remove_file(&p);
        }
    }
}

pub fn local_time(ts: i64) -> String {
    use chrono::TimeZone;
    match chrono::Local.timestamp_millis_opt(ts) {
        chrono::LocalResult::Single(t) => t.format("%Y-%m-%dT%H:%M:%S%.3f%:z").to_string(),
        _ => ts.to_string(),
    }
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        let at = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let thread = std::thread::current().name().unwrap_or("?").to_string();
        error(
            "app.panic",
            format!("panic: {msg}"),
            serde_json::json!({ "at": at, "thread": thread }),
        );
        if thread != "pocket-log" {
            flush(Duration::from_millis(500));
        }
        previous(info);
    }));
}

/// Warnings and errors from Tauri, wry and other crates that use the `log` facade.
struct DepLogger;

impl log::Log for DepLogger {
    fn enabled(&self, meta: &log::Metadata) -> bool {
        meta.level() <= log::Level::Warn
    }
    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let level = if record.level() == log::Level::Error {
            Level::Error
        } else {
            Level::Warn
        };
        write(
            level,
            "native",
            "dep",
            &format!("{}: {}", record.target(), record.args()),
            Value::Null,
        );
    }
    fn flush(&self) {}
}

fn install_dep_logger() {
    static DEP: DepLogger = DepLogger;
    if log::set_logger(&DEP).is_ok() {
        log::set_max_level(log::LevelFilter::Warn);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hp-log-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rotation_keeps_five_files() {
        let dir = scratch("rotate");
        for round in 0..7 {
            fs::write(dir.join(file_name(0)), format!("round {round}")).unwrap();
            rotate(&dir);
        }
        fs::write(dir.join(file_name(0)), "current").unwrap();
        let names: Vec<String> = files(&dir)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), KEEP_FILES);
        assert_eq!(names.last().unwrap(), &file_name(0));
        assert_eq!(
            fs::read_to_string(dir.join(file_name(1))).unwrap(),
            "round 6"
        );
        assert_eq!(
            fs::read_to_string(dir.join(file_name(4))).unwrap(),
            "round 3"
        );
        assert!(!dir.join(file_name(5)).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn writer_rotates_at_the_size_cap() {
        let dir = scratch("writer");
        let (tx, rx) = mpsc::channel();
        let d = dir.clone();
        let t = std::thread::spawn(move || writer_loop(d, rx));
        let line = "x".repeat(100_000);
        for _ in 0..45 {
            tx.send(Cmd::Line(line.clone())).unwrap();
        }
        let (ack_tx, ack_rx) = mpsc::channel();
        tx.send(Cmd::Flush(ack_tx)).unwrap();
        ack_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        drop(tx);
        t.join().unwrap();
        let current = fs::metadata(dir.join(file_name(0))).unwrap().len();
        let first = fs::metadata(dir.join(file_name(1))).unwrap().len();
        assert!(first <= MAX_FILE_BYTES, "rotated file {first} over cap");
        assert!(current <= MAX_FILE_BYTES);
        assert_eq!(files(&dir).len(), 3, "45 x 100 kB = 4.5 MB -> three files");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn relay_gets_warnings_and_lifecycle_only() {
        assert!(relay_worthy(Level::Warn, "rpc"));
        assert!(relay_worthy(Level::Info, "pair"));
        assert!(relay_worthy(Level::Info, "voice.session"));
        assert!(!relay_worthy(Level::Info, "rpc"));
        assert!(!relay_worthy(Level::Debug, "pair"));
        assert!(!relay_worthy(Level::Warn, "dep"));
        assert!(relay_worthy(Level::Error, "dep"));
    }

    #[test]
    fn level_parse() {
        assert_eq!(Level::parse("WARNING"), Some(Level::Warn));
        assert_eq!(Level::parse("nope"), None);
        assert!(Level::Error > Level::Info);
    }
}
