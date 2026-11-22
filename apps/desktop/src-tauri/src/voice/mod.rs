//! Global wake hotkey, floating Xiaoyang HUD, and live call microphone capture
//! on macOS and Windows.
//!
//! Pressing the configured hotkey (an accelerator such as `⌘⇧Space` or a clean
//! tap of a single modifier key such as `RightOption` within 650 ms) toggles a
//! Xiaoyang realtime voice call (`voice://call-command`), opens the floating
//! glass capsule (`voice-hud`) without stealing keyboard focus, and switches the
//! main macOS WebView scheduling policy so WebSocket and WebAudio stay live even
//! when the main window is hidden or occluded.

pub mod hotkey;

#[cfg(any(target_os = "macos", windows))]
pub(crate) mod audio;
#[cfg(target_os = "macos")]
mod hook_mac;
#[cfg(windows)]
mod hook_win;
#[cfg(any(target_os = "macos", windows))]
mod hud;

use crate::logging;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::Shortcut;

/// To the main window: the controller's state (same shape as `voice_status`).
pub const STATE_EVENT: &str = "voice://state";
/// To the main window, once per hotkey/permission error: `{ message }` (Chinese).
pub const ERROR_EVENT: &str = "voice://error";
/// To the main window: `{ action: "start" | "hangup" | "toggle-mute", showHud?, seq? }`.
pub const CALL_COMMAND_EVENT: &str = "voice://call-command";
/// To the main window while native call mic is active (~50 Hz): `{ pcmBase64, level }`.
pub const CALL_MIC_EVENT: &str = "voice-call://mic";

/// A clean single-modifier tap is press + release within this duration with no other key pressed.
const TAP_MS: u64 = 650;

static CALL_ACTIVE: AtomicBool = AtomicBool::new(false);
static NEXT_CALL_SEQ: AtomicU64 = AtomicU64::new(0);
static ACTIVE_CALL_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn is_call_active() -> bool {
    CALL_ACTIVE.load(Ordering::SeqCst)
}

enum Msg {
    Shortcut {
        shortcut: Shortcut,
        pressed: bool,
    },
    #[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
    Key(hotkey::KeyEvent),
    SetPhase(&'static str),
    ScheduleHide {
        ms: u64,
    },
    CancelHide,
    Reconfigure,
    Shutdown,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    /// This build supports the global wake hotkey (macOS and Windows).
    pub supported: bool,
    pub enabled: bool,
    pub hotkey: String,
    /// `accelerator` or `modifier`.
    pub kind: Option<&'static str>,
    /// The hotkey is live.
    pub registered: bool,
    /// Why it is not live (syntax, taken by another app, permission).
    pub error: Option<String>,
    pub warning: Option<String>,
    /// Permission to grant before the hotkey works (`inputMonitoring`).
    pub needs_permission: Option<&'static str>,
    /// `idle`, `connecting`, or `active`.
    pub phase: &'static str,
    /// Last error, in Chinese.
    pub last_error: Option<String>,
}

fn sender() -> &'static Mutex<Option<Sender<Msg>>> {
    static S: OnceLock<Mutex<Option<Sender<Msg>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

fn send(msg: Msg) -> bool {
    sender()
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|tx| tx.send(msg).is_ok()))
        .unwrap_or(false)
}

fn status_cell() -> &'static Mutex<VoiceStatus> {
    static S: OnceLock<Mutex<VoiceStatus>> = OnceLock::new();
    S.get_or_init(|| {
        Mutex::new(VoiceStatus {
            phase: "idle",
            ..Default::default()
        })
    })
}

pub fn status() -> VoiceStatus {
    status_cell().lock().map(|s| s.clone()).unwrap_or_default()
}

pub(crate) fn on_shortcut(shortcut: Shortcut, pressed: bool) {
    send(Msg::Shortcut { shortcut, pressed });
}

/// config.json changed: re-read the voice keys.
pub fn config_changed(_app: &AppHandle) {
    send(Msg::Reconfigure);
}

pub fn init(app: &AppHandle) {
    let (tx, rx) = mpsc::channel();
    if let Ok(mut g) = sender().lock() {
        *g = Some(tx);
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("pocket-voice".into())
        .spawn(move || {
            let mut ctl = Controller::new(app, rx);
            ctl.reconfigure();
            ctl.run();
        });
    if let Err(e) = spawned {
        logging::error(
            "voice",
            "voice controller did not start",
            json!({ "error": e.to_string() }),
        );
    }
}

pub fn shutdown(_app: &AppHandle) {
    stop_live_call_mic();
    send(Msg::Shutdown);
}

// ---------------------------------------------------------------------------
// Live call microphone streaming adapter
// ---------------------------------------------------------------------------

fn mic_muted_flag() -> &'static Arc<AtomicBool> {
    static FLAG: OnceLock<Arc<AtomicBool>> = OnceLock::new();
    FLAG.get_or_init(|| Arc::new(AtomicBool::new(false)))
}

#[cfg(any(target_os = "macos", windows))]
struct LiveCallMicHandle {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(any(target_os = "macos", windows))]
impl LiveCallMicHandle {
    fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
impl Drop for LiveCallMicHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(any(target_os = "macos", windows))]
fn mic_handle_cell() -> &'static Mutex<Option<LiveCallMicHandle>> {
    static CELL: OnceLock<Mutex<Option<LiveCallMicHandle>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

#[cfg(any(target_os = "macos", windows))]
fn pcm16_to_le_bytes_and_level(frame: &[i16]) -> (Vec<u8>, f32) {
    if frame.is_empty() {
        return (Vec::new(), 0.0);
    }
    let mut sq = 0.0f64;
    let mut bytes = Vec::with_capacity(frame.len() * 2);
    for &s in frame {
        let f = f64::from(s) / 32768.0;
        sq += f * f;
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    let rms = (sq / frame.len() as f64).sqrt() as f32;
    let level = (rms * 4.2).min(1.0);
    (bytes, level)
}

#[cfg(any(target_os = "macos", windows))]
fn spawn_live_call_mic_adapter(
    app: AppHandle,
    muted: Arc<AtomicBool>,
) -> Result<LiveCallMicHandle, String> {
    // MERGE-NOTE(@verifier-code-r3): When `voice-sha-stream` merges `audio::start_live_call_mic`,
    // replace `audio::start(3600)` + polling loop below with:
    //   let stream = audio::start_live_call_mic(muted.clone(), move |frame, level| {
    //       if muted.load(Ordering::Relaxed) { return; }
    //       let mut bytes = Vec::with_capacity(640);
    //       for &s in frame { bytes.extend_from_slice(&s.to_le_bytes()); }
    //       let b64 = crate::local_term::base64_encode(&bytes);
    //       let _ = app.emit_to("main", CALL_MIC_EVENT, json!({ "pcmBase64": b64, "level": level }));
    //   })?;
    let rec = audio::start(3600)?;
    let device = rec.device.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let thread = std::thread::Builder::new()
        .name("pocket-call-mic".into())
        .spawn(move || {
            let mut offset = 0usize;
            let mut pending: Vec<i16> = Vec::with_capacity(640);
            let mut was_muted = false;
            while !stop_flag.load(Ordering::Relaxed) {
                if rec.failed() {
                    logging::warn("voice.call", "live call mic stream failed", Value::Null);
                    break;
                }
                let chunk = rec.snapshot_from(offset);
                if !chunk.is_empty() {
                    offset += chunk.len();
                    pending.extend_from_slice(&chunk);
                }
                let is_muted = muted.load(Ordering::Relaxed);
                if is_muted {
                    pending.clear();
                    if !was_muted {
                        was_muted = true;
                        let _ = app.emit_to(
                            "main",
                            CALL_MIC_EVENT,
                            json!({ "pcmBase64": "", "level": 0.0f32 }),
                        );
                    }
                } else {
                    was_muted = false;
                    while pending.len() >= 320 {
                        let frame: Vec<i16> = pending.drain(..320).collect();
                        let (bytes, level) = pcm16_to_le_bytes_and_level(&frame);
                        let b64 = crate::local_term::base64_encode(&bytes);
                        let _ = app.emit_to(
                            "main",
                            CALL_MIC_EVENT,
                            json!({ "pcmBase64": b64, "level": level }),
                        );
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            drop(rec);
        })
        .map_err(|e| e.to_string())?;
    logging::info(
        "voice.call",
        "native call mic started",
        json!({ "device": device }),
    );
    Ok(LiveCallMicHandle {
        stop,
        thread: Some(thread),
    })
}

pub fn start_live_call_mic(app: &AppHandle) -> Result<(), String> {
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = app;
        Err("当前系统暂不支持原生音频采集".into())
    }
    #[cfg(any(target_os = "macos", windows))]
    {
        stop_live_call_mic();
        #[cfg(target_os = "macos")]
        {
            use crate::perms::State;
            match crate::perms::status().microphone {
                State::Denied | State::Restricted => {
                    return Err("请在 系统设置 → 隐私与安全性 → 麦克风 里允许 Herdr Pocket".into());
                }
                State::NotDetermined => {
                    let after = crate::perms::request("microphone")?;
                    if after.microphone != State::Granted {
                        return Err("请在弹出的窗口里允许使用麦克风，然后再试一次".into());
                    }
                }
                _ => {}
            }
        }
        #[cfg(windows)]
        {
            use crate::perms::State;
            if matches!(
                crate::perms::status().microphone,
                State::Denied | State::Restricted
            ) {
                return Err(
                    "请在 设置 → 隐私和安全性 → 麦克风 里允许桌面应用使用麦克风".into(),
                );
            }
        }
        let muted = mic_muted_flag().clone();
        muted.store(false, Ordering::Relaxed);
        crate::mainwin::set_voice_call_active(app, true);
        let handle = spawn_live_call_mic_adapter(app.clone(), muted)?;
        if let Ok(mut g) = mic_handle_cell().lock() {
            *g = Some(handle);
        }
        Ok(())
    }
}

pub fn stop_live_call_mic() {
    #[cfg(any(target_os = "macos", windows))]
    if let Ok(mut g) = mic_handle_cell().lock() {
        if let Some(h) = g.take() {
            h.stop();
        }
    }
}

pub fn set_live_call_mic_muted(muted: bool) {
    mic_muted_flag().store(muted, Ordering::Relaxed);
}

// ---------------------------------------------------------------------------
// HUD <-> Frontend Coordination
// ---------------------------------------------------------------------------

pub fn hangup_from_hud(app: &AppHandle) {
    CALL_ACTIVE.store(false, Ordering::SeqCst);
    ACTIVE_CALL_SEQ.store(0, Ordering::SeqCst);
    #[cfg(any(target_os = "macos", windows))]
    hud::hide(app);
    stop_live_call_mic();
    crate::mainwin::set_voice_call_active(app, false);
    let _ = app.emit_to("main", CALL_COMMAND_EVENT, json!({ "action": "hangup" }));
    send(Msg::CancelHide);
    send(Msg::SetPhase("idle"));
    logging::info("voice.call", "hung up from hud", Value::Null);
}

pub fn toggle_mute_from_hud(app: &AppHandle) {
    let _ = app.emit_to(
        "main",
        CALL_COMMAND_EVENT,
        json!({ "action": "toggle-mute" }),
    );
}

pub fn sync_call_hud(app: &AppHandle, mut state: Value) {
    let kind = state
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let open = state.get("open").and_then(Value::as_bool).unwrap_or(false);
    let seq = state.get("seq").and_then(Value::as_u64);

    if kind == "error" {
        if let Some(s) = seq {
            if !open && s != 0 && ACTIVE_CALL_SEQ.load(Ordering::SeqCst) != s {
                return;
            }
        }
        CALL_ACTIVE.store(false, Ordering::SeqCst);
        ACTIVE_CALL_SEQ.store(0, Ordering::SeqCst);
        stop_live_call_mic();
        crate::mainwin::set_voice_call_active(app, false);
        if let Some(obj) = state.as_object_mut() {
            if !obj.contains_key("sounds") {
                obj.insert(
                    "sounds".into(),
                    Value::Bool(crate::config::native().voice_sounds),
                );
            }
        }
        #[cfg(any(target_os = "macos", windows))]
        hud::show(app, state);
        send(Msg::SetPhase("idle"));
        send(Msg::ScheduleHide { ms: 2800 });
        return;
    }

    if kind != "connecting" && kind != "active" {
        return;
    }

    if open {
        if let Some(s) = seq {
            if !CALL_ACTIVE.load(Ordering::SeqCst) || ACTIVE_CALL_SEQ.load(Ordering::SeqCst) != s {
                return;
            }
        } else {
            let new_seq = NEXT_CALL_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
            ACTIVE_CALL_SEQ.store(new_seq, Ordering::SeqCst);
            CALL_ACTIVE.store(true, Ordering::SeqCst);
            crate::mainwin::set_voice_call_active(app, true);
        }
    } else {
        if !CALL_ACTIVE.load(Ordering::SeqCst) {
            return;
        }
        if let Some(s) = seq {
            if ACTIVE_CALL_SEQ.load(Ordering::SeqCst) != s {
                return;
            }
        }
    }

    if let Some(obj) = state.as_object_mut() {
        if obj.get("dspBadge").is_none_or(Value::is_null) {
            if let Some(badge) = crate::voice_ai::active_hud_badge() {
                obj.insert("dspBadge".into(), Value::String(badge));
            }
        }
        if !obj.contains_key("sounds") {
            obj.insert(
                "sounds".into(),
                Value::Bool(crate::config::native().voice_sounds),
            );
        }
    }

    send(Msg::CancelHide);
    send(Msg::SetPhase(if kind == "connecting" {
        "connecting"
    } else {
        "active"
    }));
    #[cfg(any(target_os = "macos", windows))]
    {
        if open {
            hud::show(app, state);
        } else {
            hud::update(app, state);
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = state;
}

pub fn hide_call_hud(app: &AppHandle) {
    CALL_ACTIVE.store(false, Ordering::SeqCst);
    ACTIVE_CALL_SEQ.store(0, Ordering::SeqCst);
    #[cfg(any(target_os = "macos", windows))]
    hud::hide(app);
    stop_live_call_mic();
    crate::mainwin::set_voice_call_active(app, false);
    send(Msg::CancelHide);
    send(Msg::SetPhase("idle"));
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ModifierTapState {
    down_at: Option<Instant>,
    clean: bool,
}

impl ModifierTapState {
    fn on_event(&mut self, ev: hotkey::KeyEvent, now: Instant) -> bool {
        match ev {
            hotkey::KeyEvent::ModDown => {
                self.down_at = Some(now);
                self.clean = true;
                false
            }
            hotkey::KeyEvent::Other => {
                self.clean = false;
                self.down_at = None;
                false
            }
            hotkey::KeyEvent::ModUp => {
                let held = self.down_at.take().map(|d| now.saturating_duration_since(d));
                let clean = std::mem::replace(&mut self.clean, false);
                clean && held.is_some_and(|h| h <= Duration::from_millis(TAP_MS))
            }
        }
    }

    fn reset(&mut self) {
        self.down_at = None;
        self.clean = false;
    }
}

struct Controller {
    app: AppHandle,
    rx: Receiver<Msg>,
    cfg: crate::config::Native,
    spec: Option<hotkey::Spec>,
    registered: Option<Shortcut>,
    #[cfg(target_os = "macos")]
    hook: Option<hook_mac::Hook>,
    #[cfg(windows)]
    hook: Option<hook_win::Hook>,
    phase: &'static str,
    tap: ModifierTapState,
    hide_at: Option<Instant>,
}

impl Controller {
    fn new(app: AppHandle, rx: Receiver<Msg>) -> Controller {
        Controller {
            app,
            rx,
            cfg: crate::config::native(),
            spec: None,
            registered: None,
            #[cfg(any(target_os = "macos", windows))]
            hook: None,
            phase: "idle",
            tap: ModifierTapState::default(),
            hide_at: None,
        }
    }

    fn run(&mut self) {
        loop {
            let msg = match self.next_timeout() {
                Some(t) => match self.rx.recv_timeout(t) {
                    Ok(m) => Some(m),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => break,
                },
                None => match self.rx.recv() {
                    Ok(m) => Some(m),
                    Err(_) => break,
                },
            };
            match msg {
                Some(Msg::Shutdown) => {
                    CALL_ACTIVE.store(false, Ordering::SeqCst);
                    ACTIVE_CALL_SEQ.store(0, Ordering::SeqCst);
                    stop_live_call_mic();
                    #[cfg(any(target_os = "macos", windows))]
                    hud::hide(&self.app);
                    crate::mainwin::set_voice_call_active(&self.app, false);
                    self.unregister();
                    break;
                }
                Some(m) => self.handle(m),
                None => self.tick(),
            }
        }
    }

    /// How long to wait for a message before `tick`; None: until one comes (idle, no CPU).
    fn next_timeout(&self) -> Option<Duration> {
        if let Some(at) = self.hide_at {
            return Some(
                at.saturating_duration_since(Instant::now())
                    .max(Duration::from_millis(5)),
            );
        }
        if !is_call_active() && self.app_has_hud() {
            return Some(Duration::from_secs(30));
        }
        None
    }

    fn app_has_hud(&self) -> bool {
        #[cfg(any(target_os = "macos", windows))]
        {
            use tauri::Manager;
            self.app.get_webview_window(hud::LABEL).is_some()
        }
        #[cfg(not(any(target_os = "macos", windows)))]
        {
            false
        }
    }

    fn publish(&self, last_error: Option<Option<String>>) {
        let snapshot = {
            let Ok(mut s) = status_cell().lock() else {
                return;
            };
            s.phase = self.phase;
            if let Some(e) = last_error {
                s.last_error = e;
            }
            s.clone()
        };
        let _ = self.app.emit_to("main", STATE_EVENT, &snapshot);
    }

    fn set_registration(
        &self,
        kind: Option<&'static str>,
        registered: bool,
        error: Option<String>,
        warning: Option<String>,
        needs: Option<&'static str>,
    ) {
        if let Ok(mut s) = status_cell().lock() {
            s.supported = cfg!(any(target_os = "macos", windows));
            s.enabled = self.cfg.voice_enabled;
            s.hotkey = self.cfg.voice_hotkey.clone();
            s.kind = kind;
            s.registered = registered;
            s.error = error;
            s.warning = warning;
            s.needs_permission = needs;
        }
        self.publish(None);
    }

    fn unregister(&mut self) {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        if let Some(sc) = self.registered.take() {
            let _ = self.app.global_shortcut().unregister(sc);
        }
        #[cfg(any(target_os = "macos", windows))]
        if let Some(h) = self.hook.take() {
            h.stop();
            logging::info("hotkey", "modifier hotkey watch removed", Value::Null);
        }
    }

    fn reconfigure(&mut self) {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        let cfg = crate::config::native();
        let same = self.spec.is_some()
            && cfg.voice_enabled == self.cfg.voice_enabled
            && cfg.voice_hotkey == self.cfg.voice_hotkey;
        self.cfg = cfg;
        if same {
            let s = status();
            self.set_registration(s.kind, s.registered, s.error, s.warning, s.needs_permission);
            return;
        }
        self.unregister();
        self.spec = None;
        self.tap.reset();
        if !cfg!(any(target_os = "macos", windows)) {
            self.set_registration(
                None,
                false,
                Some("这个系统暂不支持全局唤醒快捷键".into()),
                None,
                None,
            );
            return;
        }
        if !self.cfg.voice_enabled {
            logging::info("hotkey", "xiaoyang wake hotkey off", Value::Null);
            self.set_registration(None, false, None, None, None);
            return;
        }
        let hk = self.cfg.voice_hotkey.clone();
        let warning = hotkey::known_conflict(&hk);
        match hotkey::parse(&hk) {
            Err(e) => {
                logging::warn(
                    "hotkey",
                    "hotkey invalid",
                    json!({ "hotkey": hk, "error": e }),
                );
                self.set_registration(None, false, Some(e), None, None);
            }
            Ok(hotkey::Spec::Accelerator(sc)) => match self.app.global_shortcut().register(sc) {
                Ok(()) => {
                    self.registered = Some(sc);
                    self.spec = Some(hotkey::Spec::Accelerator(sc));
                    logging::info(
                        "hotkey",
                        "hotkey registered",
                        json!({ "hotkey": hk, "kind": "accelerator" }),
                    );
                    self.set_registration(Some("accelerator"), true, None, warning, None);
                }
                Err(e) => {
                    let msg = format!("快捷键 {hk} 无法注册，可能已被其他程序占用（{e}）");
                    logging::warn(
                        "hotkey",
                        "hotkey taken",
                        json!({ "hotkey": hk, "error": e.to_string() }),
                    );
                    self.set_registration(Some("accelerator"), false, Some(msg), None, None);
                }
            },
            Ok(hotkey::Spec::Modifier(m)) => self.start_hook(m, &hk, warning),
        }
    }

    #[cfg(any(target_os = "macos", windows))]
    fn start_hook(&mut self, m: hotkey::ModKey, hk: &str, warning: Option<String>) {
        let tx = sender().lock().ok().and_then(|g| g.clone());
        let Some(tx) = tx else { return };
        let sink = move |ev| {
            let _ = tx.send(Msg::Key(ev));
        };
        #[cfg(target_os = "macos")]
        let started = hook_mac::start(m, sink);
        #[cfg(windows)]
        let started = hook_win::start(m, sink);
        match started {
            Ok(h) => {
                self.hook = Some(h);
                self.spec = Some(hotkey::Spec::Modifier(m));
                logging::info(
                    "hotkey",
                    "modifier hotkey watching",
                    json!({ "hotkey": hk, "kind": "modifier" }),
                );
                self.set_registration(Some("modifier"), true, None, warning, None);
            }
            Err(e) => {
                let needs = hotkey::needs_input_monitoring().then_some("inputMonitoring");
                logging::warn(
                    "hotkey",
                    "modifier hotkey unavailable",
                    json!({ "hotkey": hk, "error": e, "needsPermission": needs }),
                );
                self.set_registration(Some("modifier"), false, Some(e), warning, needs);
            }
        }
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn start_hook(&mut self, _m: hotkey::ModKey, _hk: &str, _warning: Option<String>) {}

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Shortcut { shortcut, pressed } => {
                if !self.cfg.voice_enabled || Some(shortcut) != self.registered {
                    return;
                }
                if pressed {
                    self.toggle_call("accelerator");
                }
            }
            Msg::Key(ev) => {
                if !self.cfg.voice_enabled {
                    return;
                }
                if self.tap.on_event(ev, Instant::now()) {
                    self.toggle_call("modifier");
                }
            }
            Msg::SetPhase(phase) => {
                self.phase = phase;
                self.publish(None);
            }
            Msg::ScheduleHide { ms } => {
                self.hide_at = Some(Instant::now() + Duration::from_millis(ms));
            }
            Msg::CancelHide => {
                self.hide_at = None;
            }
            Msg::Reconfigure => self.reconfigure(),
            Msg::Shutdown => {}
        }
    }

    fn tick(&mut self) {
        if let Some(at) = self.hide_at {
            if Instant::now() >= at {
                self.hide_at = None;
                #[cfg(any(target_os = "macos", windows))]
                if !is_call_active() {
                    hud::hide(&self.app);
                }
            }
        }
        #[cfg(any(target_os = "macos", windows))]
        if !is_call_active() && self.hide_at.is_none() {
            hud::close_if_idle(&self.app);
        }
    }

    fn toggle_call(&mut self, via: &str) {
        if CALL_ACTIVE.load(Ordering::SeqCst) {
            self.end_call_from_hotkey(via);
        } else {
            self.begin_call_from_hotkey(via);
        }
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn begin_call_from_hotkey(&mut self, _via: &str) {}

    #[cfg(any(target_os = "macos", windows))]
    fn begin_call_from_hotkey(&mut self, via: &str) {
        if !self.cfg.voice_enabled {
            return;
        }
        self.tap.reset();
        self.hide_at = None;

        #[cfg(target_os = "macos")]
        {
            use crate::perms::State;
            match crate::perms::status().microphone {
                State::Denied | State::Restricted => {
                    self.show_error(
                        "请在 系统设置 → 隐私与安全性 → 麦克风 里允许 Herdr Pocket",
                        "microphone denied",
                        3000,
                    );
                    return;
                }
                State::NotDetermined => {
                    std::thread::spawn(|| {
                        let _ = crate::perms::request("microphone");
                    });
                    self.show_error(
                        "请在弹出的窗口里允许使用麦克风，然后再按一次",
                        "microphone not determined",
                        2500,
                    );
                    return;
                }
                _ => {}
            }
        }
        #[cfg(windows)]
        {
            use crate::perms::State;
            if matches!(
                crate::perms::status().microphone,
                State::Denied | State::Restricted
            ) {
                self.show_error(
                    "请在 设置 → 隐私和安全性 → 麦克风 里允许桌面应用使用麦克风",
                    "microphone denied",
                    3000,
                );
                return;
            }
        }

        let seq = NEXT_CALL_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
        ACTIVE_CALL_SEQ.store(seq, Ordering::SeqCst);
        CALL_ACTIVE.store(true, Ordering::SeqCst);
        self.phase = "connecting";

        let dsp_badge = crate::voice_ai::active_hud_badge();
        hud::show(
            &self.app,
            json!({
                "state": "connecting",
                "dspBadge": dsp_badge,
                "muted": false,
                "sounds": self.cfg.voice_sounds,
            }),
        );
        crate::mainwin::set_voice_call_active(&self.app, true);
        let _ = self.app.emit_to(
            "main",
            CALL_COMMAND_EVENT,
            json!({ "action": "start", "showHud": true, "seq": seq }),
        );
        logging::info(
            "voice.call",
            "xiaoyang call toggled on",
            json!({ "via": via, "seq": seq }),
        );
        self.publish(Some(None));
    }

    fn end_call_from_hotkey(&mut self, via: &str) {
        CALL_ACTIVE.store(false, Ordering::SeqCst);
        ACTIVE_CALL_SEQ.store(0, Ordering::SeqCst);
        self.tap.reset();
        self.hide_at = None;
        self.phase = "idle";
        #[cfg(any(target_os = "macos", windows))]
        hud::hide(&self.app);
        stop_live_call_mic();
        crate::mainwin::set_voice_call_active(&self.app, false);
        let _ = self
            .app
            .emit_to("main", CALL_COMMAND_EVENT, json!({ "action": "hangup" }));
        logging::info(
            "voice.call",
            "xiaoyang call toggled off",
            json!({ "via": via }),
        );
        self.publish(None);
    }

    fn show_error(&mut self, msg: &str, log_msg: &str, hide_after_ms: u64) {
        if !log_msg.is_empty() {
            logging::warn("voice", log_msg, json!({ "shown": msg }));
        }
        CALL_ACTIVE.store(false, Ordering::SeqCst);
        ACTIVE_CALL_SEQ.store(0, Ordering::SeqCst);
        self.phase = "idle";
        #[cfg(any(target_os = "macos", windows))]
        hud::show(
            &self.app,
            json!({
                "state": "error",
                "message": msg,
                "sounds": self.cfg.voice_sounds,
            }),
        );
        self.hide_at = Some(Instant::now() + Duration::from_millis(hide_after_ms));
        self.publish(Some(Some(msg.to_string())));
        let _ = self
            .app
            .emit_to("main", ERROR_EVENT, json!({ "message": msg }));
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn voice_status() -> VoiceStatus {
    status()
}

#[tauri::command]
pub async fn voice_check_hotkey(app: AppHandle, hotkey: String) -> hotkey::Check {
    let current = hotkey::parse(&crate::config::native().voice_hotkey).ok();
    hotkey::check(&app, &hotkey, current.as_ref())
}

/// Re-reads config.json and retries the hotkey (after a permission was granted).
#[tauri::command]
pub fn voice_reload() -> bool {
    send(Msg::Reconfigure)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_modifier_tap_toggles_while_chords_and_long_holds_do_not() {
        let mut tap = ModifierTapState::default();
        let t0 = Instant::now();

        // Clean press & release within 650ms triggers toggle.
        assert!(!tap.on_event(hotkey::KeyEvent::ModDown, t0));
        assert!(tap.on_event(
            hotkey::KeyEvent::ModUp,
            t0 + Duration::from_millis(180)
        ));

        // Option + E chord sets clean=false so ModUp never misfires.
        assert!(!tap.on_event(hotkey::KeyEvent::ModDown, t0));
        assert!(!tap.on_event(hotkey::KeyEvent::Other, t0 + Duration::from_millis(40)));
        assert!(!tap.on_event(
            hotkey::KeyEvent::ModUp,
            t0 + Duration::from_millis(120)
        ));

        // Holding longer than 650ms without pressing another key does not trigger toggle.
        assert!(!tap.on_event(hotkey::KeyEvent::ModDown, t0));
        assert!(!tap.on_event(
            hotkey::KeyEvent::ModUp,
            t0 + Duration::from_millis(TAP_MS + 50)
        ));
    }

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn pcm16_frame_packs_little_endian_and_computes_level() {
        let frame = [0i16; 320];
        let (bytes, level) = pcm16_to_le_bytes_and_level(&frame);
        assert_eq!(bytes.len(), 640);
        assert_eq!(level, 0.0);

        let loud = [16_384i16; 320];
        let (bytes2, level2) = pcm16_to_le_bytes_and_level(&loud);
        assert_eq!(bytes2.len(), 640);
        assert_eq!(&bytes2[0..2], &16_384i16.to_le_bytes());
        assert!(level2 > 0.9 && level2 <= 1.0, "got {level2}");
    }
}
