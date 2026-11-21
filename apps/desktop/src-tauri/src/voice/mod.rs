//! Quick voice input (dictation) on macOS and Windows.
//!
//! Hold the hotkey (or press it once in toggle mode) and talk; on release the
//! recording goes to the relay's speech-to-text (POST /v1/transcribe) and the
//! text lands where you were typing: in another app by paste (or typed key by
//! key, or only copied, per `voiceInput.insert`), or in Herdr Pocket's own
//! message box when its window had the focus. Esc cancels while recording.
//!
//! One controller thread owns the state; hotkeys, hooks, the UI and finished
//! transcriptions talk to it through a channel. When idle it blocks on that
//! channel and uses no CPU; the microphone is open only while recording.

pub mod hotkey;

#[cfg(any(target_os = "macos", windows))]
pub(crate) mod audio;
#[cfg(target_os = "macos")]
mod hook_mac;
#[cfg(windows)]
mod hook_win;
#[cfg(any(target_os = "macos", windows))]
mod hud;
#[cfg(any(target_os = "macos", windows))]
mod insert;

use crate::logging;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_global_shortcut::Shortcut;

/// To the main window: the controller's state (same shape as `voice_status`).
pub const STATE_EVENT: &str = "voice://state";
/// To the main window: a finished dictation `{ text, target: "app" | "focused", method }`.
pub const TRANSCRIPT_EVENT: &str = "voice://transcript";
/// To the main window while recording, about 15 times a second: `{ level: 0..1, elapsedMs }`.
pub const LEVEL_EVENT: &str = "voice://level";
/// To the main window, once per failed dictation: `{ message }` (Chinese).
pub const ERROR_EVENT: &str = "voice://error";

enum Msg {
    Shortcut {
        shortcut: Shortcut,
        pressed: bool,
    },
    #[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
    Key(hotkey::KeyEvent),
    Start,
    Stop,
    Cancel,
    #[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
    Transcribed {
        session: u64,
        result: Result<Transcript, String>,
    },
    Reconfigure,
    Shutdown,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct Transcript {
    text: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    ms: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStatus {
    /// This build can do dictation (macOS and Windows).
    pub supported: bool,
    pub enabled: bool,
    pub hotkey: String,
    pub mode: String,
    pub insert: String,
    pub language: String,
    /// `accelerator` or `modifier`.
    pub kind: Option<&'static str>,
    /// The hotkey is live.
    pub registered: bool,
    /// Why it is not live (syntax, taken by another app, permission).
    pub error: Option<String>,
    pub warning: Option<String>,
    /// Permission to grant before the hotkey works (`inputMonitoring`).
    pub needs_permission: Option<&'static str>,
    /// `idle`, `recording` or `transcribing`.
    pub phase: &'static str,
    /// Last failed dictation, in Chinese.
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
    send(Msg::Shutdown);
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Target {
    /// Another app had the focus: insert there.
    Focused,
    /// Herdr Pocket's own window had it: its message box gets the text.
    App,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Via {
    Hold,
    Toggle,
    Button,
}

enum Phase {
    Idle,
    #[cfg(any(target_os = "macos", windows))]
    Recording {
        rec: audio::Recording,
        started: Instant,
        target: Target,
        via: Via,
    },
    Transcribing {
        session: u64,
        started: Instant,
        target: Target,
        audio_ms: u64,
    },
}

/// A modifier held this long alone starts a hold-to-talk recording (shorter: a chord or a tap).
const HOLD_MS: u64 = 180;
/// A toggle tap is a press and release within this long.
const TAP_MS: u64 = 450;
const MIN_AUDIO_MS: u64 = 350;
const ESCAPE: &str = "Escape";

struct Controller {
    app: AppHandle,
    rx: Receiver<Msg>,
    cfg: crate::config::Native,
    spec: Option<hotkey::Spec>,
    registered: Option<Shortcut>,
    escape: Option<Shortcut>,
    #[cfg(target_os = "macos")]
    hook: Option<hook_mac::Hook>,
    #[cfg(windows)]
    hook: Option<hook_win::Hook>,
    phase: Phase,
    /// Modifier key: when it went down and whether it stayed alone.
    mod_down: Option<Instant>,
    mod_clean: bool,
    session: u64,
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
            escape: None,
            #[cfg(any(target_os = "macos", windows))]
            hook: None,
            phase: Phase::Idle,
            mod_down: None,
            mod_clean: false,
            session: 0,
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
                    self.cancel("app quitting");
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
        match &self.phase {
            #[cfg(any(target_os = "macos", windows))]
            Phase::Recording { .. } => Some(Duration::from_millis(66)),
            Phase::Transcribing { .. } => Some(Duration::from_millis(500)),
            Phase::Idle => {
                if let Some(down) = self.mod_down {
                    let left = Duration::from_millis(HOLD_MS).saturating_sub(down.elapsed());
                    return Some(left.max(Duration::from_millis(5)));
                }
                if let Some(at) = self.hide_at {
                    return Some(
                        at.saturating_duration_since(Instant::now())
                            .max(Duration::from_millis(5)),
                    );
                }
                if self.app_has_hud() {
                    return Some(Duration::from_secs(30));
                }
                None
            }
        }
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
        let phase = match self.phase {
            Phase::Idle => "idle",
            #[cfg(any(target_os = "macos", windows))]
            Phase::Recording { .. } => "recording",
            Phase::Transcribing { .. } => "transcribing",
        };
        let snapshot = {
            let Ok(mut s) = status_cell().lock() else {
                return;
            };
            s.phase = phase;
            if let Some(e) = last_error {
                s.last_error = e;
            }
            s.clone()
        };
        use tauri::Emitter;
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
            s.mode = self.cfg.voice_mode.clone();
            s.insert = self.cfg.voice_insert.clone();
            s.language = self.cfg.voice_language.clone();
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
        self.drop_escape();
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
            // Only mode, language or insert changed: the hotkey stays as it is.
            let s = status();
            self.set_registration(s.kind, s.registered, s.error, s.warning, s.needs_permission);
            return;
        }
        self.unregister();
        self.spec = None;
        if !cfg!(any(target_os = "macos", windows)) {
            self.set_registration(
                None,
                false,
                Some("这个系统暂不支持语音输入".into()),
                None,
                None,
            );
            return;
        }
        if !self.cfg.voice_enabled {
            logging::info("hotkey", "voice input off", Value::Null);
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
                        json!({ "hotkey": hk, "kind": "accelerator", "mode": self.cfg.voice_mode }),
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
                    json!({ "hotkey": hk, "kind": "modifier", "mode": self.cfg.voice_mode }),
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
                // `spec` stays None, so the next reconfigure (voice_reload, or permissions_status
                // noticing the grant) tries the hook again.
                self.set_registration(Some("modifier"), false, Some(e), warning, needs);
            }
        }
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn start_hook(&mut self, _m: hotkey::ModKey, _hk: &str, _warning: Option<String>) {}

    fn hold_mode(&self) -> bool {
        self.cfg.voice_mode != "toggle"
    }

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Shortcut { shortcut, pressed } => {
                if Some(shortcut) == self.escape {
                    if pressed {
                        self.cancel("escape");
                    }
                    return;
                }
                if Some(shortcut) != self.registered {
                    return;
                }
                if self.hold_mode() {
                    if pressed {
                        if self.recording_via().is_some() {
                            self.stop();
                        } else {
                            self.start(Via::Hold);
                        }
                    } else if self.recording_via() == Some(Via::Hold) {
                        if self
                            .recording_elapsed()
                            .is_some_and(|d| d < Duration::from_millis(380))
                        {
                            self.promote_hold_to_toggle();
                        } else {
                            self.stop();
                        }
                    }
                } else if pressed {
                    if self.recording_via().is_some() {
                        self.stop();
                    } else {
                        self.start(Via::Toggle);
                    }
                }
            }
            Msg::Key(ev) => self.on_modifier(ev),
            Msg::Start => {
                if self.recording_via().is_none() {
                    self.start(Via::Button);
                }
            }
            Msg::Stop => {
                if self.recording_via().is_some() {
                    self.stop();
                }
            }
            Msg::Cancel => self.cancel("cancelled"),
            Msg::Transcribed { session, result } => self.finish(session, result),
            Msg::Reconfigure => self.reconfigure(),
            Msg::Shutdown => {}
        }
    }

    fn on_modifier(&mut self, ev: hotkey::KeyEvent) {
        use hotkey::KeyEvent::*;
        match ev {
            ModDown => {
                self.mod_down = Some(Instant::now());
                self.mod_clean = true;
            }
            Other => {
                self.mod_clean = false;
                if self.mod_down.is_some() && self.recording_via() == Some(Via::Hold) {
                    // The modifier was part of a chord (Option+E and the like): not dictation.
                    self.cancel("chord");
                }
                if self.recording_via().is_none() {
                    self.mod_down = None;
                }
            }
            ModUp => {
                let held = self.mod_down.take().map(|d| d.elapsed());
                if self.hold_mode() {
                    if self.recording_via() == Some(Via::Hold) {
                        self.stop();
                    }
                } else if self.mod_clean && held.is_some_and(|h| h <= Duration::from_millis(TAP_MS))
                {
                    if self.recording_via().is_some() {
                        self.stop();
                    } else {
                        self.start(Via::Toggle);
                    }
                }
                self.mod_clean = false;
            }
        }
    }

    fn tick(&mut self) {
        // A modifier held alone long enough: hold-to-talk starts.
        if let Some(down) = self.mod_down {
            if self.hold_mode()
                && self.mod_clean
                && self.recording_via().is_none()
                && matches!(self.phase, Phase::Idle)
                && down.elapsed() >= Duration::from_millis(HOLD_MS)
            {
                self.start(Via::Hold);
            }
        }
        #[cfg(any(target_os = "macos", windows))]
        if let Phase::Recording { rec, started, .. } = &self.phase {
            let elapsed = started.elapsed();
            if rec.failed() {
                self.fail("麦克风中断了", "mic stream error");
                return;
            }
            if elapsed >= Duration::from_secs(u64::from(self.cfg.voice_max_seconds)) {
                logging::info(
                    "voice",
                    "max length reached",
                    json!({ "maxSeconds": self.cfg.voice_max_seconds }),
                );
                self.stop();
                return;
            }
            let level = rec.level();
            let elapsed_ms = elapsed.as_millis() as u64;
            hud::update(
                &self.app,
                json!({ "state": "recording", "level": level, "elapsedMs": elapsed_ms }),
            );
            use tauri::Emitter;
            let _ = self.app.emit_to(
                "main",
                LEVEL_EVENT,
                json!({ "level": level, "elapsedMs": elapsed_ms }),
            );
        }
        if let Phase::Transcribing {
            started, session, ..
        } = self.phase
        {
            if started.elapsed() > Duration::from_secs(70) {
                // The request has its own timeout; this only guards against a lost reply.
                self.finish(session, Err("识别超时，请再试一次".into()));
            }
        }
        if let Some(at) = self.hide_at {
            if Instant::now() >= at {
                self.hide_at = None;
                #[cfg(any(target_os = "macos", windows))]
                hud::hide(&self.app);
            }
        }
        #[cfg(any(target_os = "macos", windows))]
        if matches!(self.phase, Phase::Idle) && self.mod_down.is_none() && self.hide_at.is_none() {
            hud::close_if_idle(&self.app);
        }
    }

    fn recording_via(&self) -> Option<Via> {
        match &self.phase {
            #[cfg(any(target_os = "macos", windows))]
            Phase::Recording { via, .. } => Some(*via),
            _ => None,
        }
    }

    fn recording_elapsed(&self) -> Option<Duration> {
        match &self.phase {
            #[cfg(any(target_os = "macos", windows))]
            Phase::Recording { started, .. } => Some(started.elapsed()),
            _ => None,
        }
    }

    fn promote_hold_to_toggle(&mut self) {
        #[cfg(any(target_os = "macos", windows))]
        if let Phase::Recording { via, started, .. } = &mut self.phase {
            *via = Via::Toggle;
            let elapsed_ms = started.elapsed().as_millis() as u64;
            hud::update(
                &self.app,
                json!({
                    "state": "recording",
                    "level": 0,
                    "elapsedMs": elapsed_ms,
                    "hint": "再按快捷键或点 ✓ 完成",
                }),
            );
        }
    }

    fn main_focused(&self) -> bool {
        use tauri::Manager;
        // get_window: see resources::refresh_visibility (the browser panel makes "main" multi-webview).
        self.app
            .get_window("main")
            .and_then(|w| w.is_focused().ok())
            .unwrap_or(false)
    }

    fn take_escape(&mut self) {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        if self.escape.is_some() {
            return;
        }
        if let Ok(sc) = ESCAPE.parse::<Shortcut>() {
            if self.app.global_shortcut().register(sc).is_ok() {
                self.escape = Some(sc);
            }
        }
    }

    fn drop_escape(&mut self) {
        use tauri_plugin_global_shortcut::GlobalShortcutExt;
        if let Some(sc) = self.escape.take() {
            let _ = self.app.global_shortcut().unregister(sc);
        }
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn start(&mut self, _via: Via) {}

    #[cfg(any(target_os = "macos", windows))]
    fn start(&mut self, via: Via) {
        if !matches!(self.phase, Phase::Idle) {
            return;
        }
        if via != Via::Button && !self.cfg.voice_enabled {
            return;
        }
        self.mod_down = None;
        self.hide_at = None;
        #[cfg(target_os = "macos")]
        {
            use crate::perms::State;
            match crate::perms::status().microphone {
                State::Denied | State::Restricted => {
                    self.show_error(
                        "请在 系统设置 → 隐私与安全性 → 麦克风 里允许 Herdr Pocket",
                        "microphone denied",
                    );
                    return;
                }
                State::NotDetermined => {
                    // The system prompt is modal-free; ask on the side and let the next press record.
                    std::thread::spawn(|| {
                        let _ = crate::perms::request("microphone");
                    });
                    self.show_error(
                        "请在弹出的窗口里允许使用麦克风，然后再按一次",
                        "microphone not determined",
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
                );
                return;
            }
        }
        let target = if self.main_focused() {
            Target::App
        } else {
            Target::Focused
        };
        let rec = match audio::start(self.cfg.voice_max_seconds) {
            Ok(r) => r,
            Err(e) => {
                self.show_error(&e, "mic open failed");
                return;
            }
        };
        #[cfg(windows)]
        if matches!(
            self.spec,
            Some(hotkey::Spec::Modifier(
                hotkey::ModKey::RightOption | hotkey::ModKey::RightCommand
            ))
        ) {
            insert::mask_modifier_release();
        }
        self.take_escape();
        self.session += 1;
        let hint = match via {
            Via::Hold => "松开结束，Esc 取消",
            _ => "再按一次结束，Esc 取消",
        };
        logging::info(
            "voice.session",
            "dictation started",
            json!({ "session": self.session, "via": format!("{via:?}"), "target": format!("{target:?}"), "device": rec.device, "mode": self.cfg.voice_mode }),
        );
        self.phase = Phase::Recording {
            rec,
            started: Instant::now(),
            target,
            via,
        };
        let dsp_badge = crate::voice_ai::active_hud_badge();
        hud::show(
            &self.app,
            json!({ "state": "recording", "level": 0, "elapsedMs": 0, "hint": hint, "sounds": self.cfg.voice_sounds, "maxSeconds": self.cfg.voice_max_seconds, "dspBadge": dsp_badge }),
        );
        self.publish(None);
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn stop(&mut self) {}

    #[cfg(any(target_os = "macos", windows))]
    fn stop(&mut self) {
        let Phase::Recording {
            rec,
            started,
            target,
            via,
        } = std::mem::replace(&mut self.phase, Phase::Idle)
        else {
            return;
        };
        self.drop_escape();
        let held_ms = started.elapsed().as_millis() as u64;
        let samples = rec.finish();
        let audio_ms = samples.len() as u64 * 1000 / u64::from(audio::RATE);
        let peak = audio::peak(&samples);
        if audio_ms < MIN_AUDIO_MS {
            logging::info(
                "voice.session",
                "dictation too short",
                json!({ "session": self.session, "audioMs": audio_ms, "heldMs": held_ms }),
            );
            hud::hide(&self.app);
            self.publish(None);
            return;
        }
        if peak < 0.004 {
            self.show_error("没有听到声音，请检查麦克风", "silent recording");
            return;
        }
        let (samples, dsp_badge) = match crate::voice_ai::process_recording(&samples) {
            crate::voice_ai::ProcessOutcome::Accept { samples, dsp_badge } => (samples, dsp_badge),
            crate::voice_ai::ProcessOutcome::RejectNonOwner { reason, score } => {
                logging::info(
                    "voice.session",
                    "recording rejected by voiceprint filter",
                    json!({ "session": self.session, "score": score }),
                );
                self.show_error(&reason, "voiceprint rejected");
                return;
            }
        };
        let wav = audio::wav(&samples);
        let session = self.session;
        logging::info(
            "voice.session",
            "dictation recorded",
            json!({ "session": session, "audioMs": audio_ms, "bytes": wav.len(), "peak": (peak * 100.0).round() / 100.0, "via": format!("{via:?}"), "dspBadge": dsp_badge }),
        );
        self.phase = Phase::Transcribing {
            session,
            started: Instant::now(),
            target,
            audio_ms,
        };
        hud::update(
            &self.app,
            json!({ "state": "transcribing", "sounds": self.cfg.voice_sounds, "dspBadge": dsp_badge }),
        );
        self.publish(None);
        let app = self.app.clone();
        let language = self.cfg.voice_language.clone();
        tauri::async_runtime::spawn(async move {
            let result = transcribe(&app, wav, &language, audio_ms).await;
            send(Msg::Transcribed { session, result });
        });
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    fn finish(&mut self, _session: u64, _result: Result<Transcript, String>) {}

    #[cfg(any(target_os = "macos", windows))]
    fn finish(&mut self, session: u64, result: Result<Transcript, String>) {
        let Phase::Transcribing {
            session: current,
            started,
            target,
            audio_ms,
        } = self.phase
        else {
            return;
        };
        if current != session {
            return;
        }
        self.phase = Phase::Idle;
        let wait_ms = started.elapsed().as_millis() as u64;
        match result {
            Err(e) => {
                logging::warn(
                    "voice.session",
                    "transcription failed",
                    json!({ "session": session, "error": e, "waitMs": wait_ms }),
                );
                self.show_error(&e, "");
            }
            Ok(t) => {
                let text = t.text.trim().to_string();
                if text.is_empty() {
                    logging::info(
                        "voice.session",
                        "nothing recognised",
                        json!({ "session": session, "audioMs": audio_ms }),
                    );
                    self.show_error("没有识别出文字，请再说一次", "");
                    return;
                }
                // INTEGRATION(voice-hud-perms): at merge time, when `hud::current_mode() == "assistant"`,
                // spawn `hud::ask_assistant_from_hud(&app, &text)` and return early without pasting into target.
                let chars = text.chars().count();
                use tauri::Emitter;
                let (method, note) = if target == Target::App {
                    let _ = self.app.emit_to(
                        "main",
                        TRANSCRIPT_EVENT,
                        json!({ "text": text, "target": "app", "method": "app" }),
                    );
                    ("app", None)
                } else {
                    let out = insert::insert(&text, &self.cfg.voice_insert);
                    let _ = self.app.emit_to(
                        "main",
                        TRANSCRIPT_EVENT,
                        json!({ "text": text, "target": "focused", "method": out.method }),
                    );
                    (out.method, out.note)
                };
                // Never the text itself: only how long it was.
                logging::info(
                    "voice.session",
                    "dictation done",
                    json!({ "session": session, "chars": chars, "method": method, "note": note, "audioMs": audio_ms, "waitMs": wait_ms, "serviceMs": t.ms, "model": t.model }),
                );
                let label = match method {
                    "app" => "已填入输入框",
                    "paste" | "type" => "已输入",
                    _ => "已复制到剪贴板",
                };
                hud::update(
                    &self.app,
                    json!({ "state": "done", "label": label, "note": note, "chars": chars }),
                );
                self.hide_at = Some(
                    Instant::now()
                        + Duration::from_millis(if note.is_some() { 2400 } else { 680 }),
                );
                self.publish(Some(None));
            }
        }
    }

    fn cancel(&mut self, why: &str) {
        self.mod_down = None;
        self.drop_escape();
        let was = std::mem::replace(&mut self.phase, Phase::Idle);
        match was {
            Phase::Idle => return,
            #[cfg(any(target_os = "macos", windows))]
            Phase::Recording { rec, .. } => drop(rec),
            Phase::Transcribing { .. } => {}
        }
        logging::info(
            "voice.session",
            "dictation cancelled",
            json!({ "session": self.session, "why": why }),
        );
        #[cfg(any(target_os = "macos", windows))]
        {
            hud::update(&self.app, json!({ "state": "cancelled" }));
            self.hide_at = Some(Instant::now() + Duration::from_millis(500));
        }
        self.publish(None);
    }

    fn fail(&mut self, msg: &str, log_msg: &str) {
        self.cancel(log_msg);
        self.show_error(msg, log_msg);
    }

    fn show_error(&mut self, msg: &str, log_msg: &str) {
        if !log_msg.is_empty() {
            logging::warn("voice", log_msg, json!({ "shown": msg }));
        }
        self.phase = Phase::Idle;
        #[cfg(any(target_os = "macos", windows))]
        hud::show(&self.app, json!({ "state": "error", "message": msg }));
        self.hide_at = Some(Instant::now() + Duration::from_millis(3000));
        self.publish(Some(Some(msg.to_string())));
        use tauri::Emitter;
        let _ = self
            .app
            .emit_to("main", ERROR_EVENT, json!({ "message": msg }));
    }
}

// ---------------------------------------------------------------------------
// Relay speech-to-text
// ---------------------------------------------------------------------------

/// What the user reads when the relay refuses speech-to-text. The relay's detailed words go
/// to the log; on screen they are only used where a user can act on them.
fn relay_error(status: u16, body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let field = |k: &str| {
        parsed
            .as_ref()
            .and_then(|v| v.pointer(&format!("/error/{k}")))
            .and_then(|m| m.as_str())
            .map(str::to_string)
    };
    let (code, relay_msg) = (field("code"), field("message"));
    logging::warn(
        "voice.relay",
        "relay refused speech-to-text",
        json!({ "status": status, "code": code, "relayMessage": relay_msg }),
    );
    // "unsupported": the relay has no speech-to-text configured. Its message names server
    // settings (env vars) the person dictating cannot change.
    if code.as_deref() == Some("unsupported") {
        return "这个中转服务还没开启语音转文字，需要管理中转服务的人先配置。".into();
    }
    let fallback = match status {
        401 => "这台电脑的登录已失效，请重新配对",
        403 => "这台设备不能使用语音识别",
        404 => "中转服务版本太旧，还不支持语音输入，请升级中转服务",
        413 => "录音太长了，请分段说",
        429 => "说得太频繁了，请稍等一下",
        503 => "中转服务还没有配置语音识别",
        502 | 504 => "语音识别服务暂时不可用，请稍后再试",
        _ => "语音识别失败",
    };
    match relay_msg {
        Some(m) if !m.is_empty() && status != 404 => m,
        _ => format!("{fallback}（{status}）"),
    }
}

#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
async fn transcribe(
    app: &AppHandle,
    wav: Vec<u8>,
    language: &str,
    audio_ms: u64,
) -> Result<Transcript, String> {
    let session = crate::read_session(app)
        .ok_or_else(|| "还没有连接中转服务，请先在 Herdr Pocket 里完成配对".to_string())?;
    if session.server == crate::net::DEMO_SERVER {
        tokio::time::sleep(Duration::from_millis(500)).await;
        return Ok(Transcript {
            text: "（演示模式）这是语音输入的示例结果。".into(),
            model: "demo".into(),
            ms: 500,
        });
    }
    let mut url = url::Url::parse(&format!(
        "{}/v1/transcribe",
        crate::net::server_base(&session.server)
    ))
    .map_err(|_| "中转服务地址不对".to_string())?;
    {
        let mut q = url.query_pairs_mut();
        if !language.is_empty() && language != "auto" {
            q.append_pair("language", language);
        }
        q.append_pair("durationMs", &audio_ms.to_string());
    }
    let res = crate::net::client()
        .post(url)
        .bearer_auth(&session.token)
        .header(reqwest::header::CONTENT_TYPE, "audio/wav")
        .timeout(Duration::from_secs(60))
        .body(wav)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "识别超时，请检查网络".to_string()
            } else {
                "连不上中转服务，请检查网络".to_string()
            }
        })?;
    let status = res.status().as_u16();
    let body = res.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(relay_error(status, &body));
    }
    serde_json::from_str::<Transcript>(&body).map_err(|_| "中转服务的识别结果格式不对".to_string())
}

/// What the relay says about dictation (GET /v1/transcribe), for Settings.
pub async fn transcribe_info(app: &AppHandle) -> Value {
    let Some(session) = crate::read_session(app) else {
        return json!({ "available": false, "reason": "还没有连接中转服务" });
    };
    if session.server == crate::net::DEMO_SERVER {
        return json!({ "available": true, "provider": "demo", "reason": "演示模式：不会真的识别" });
    }
    let url = format!("{}/v1/transcribe", crate::net::server_base(&session.server));
    match crate::net::client()
        .get(url)
        .bearer_auth(&session.token)
        .timeout(Duration::from_secs(10))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r
            .json::<Value>()
            .await
            .unwrap_or_else(|_| json!({ "available": false, "reason": "中转服务的回答格式不对" })),
        Ok(r) => {
            let status = r.status().as_u16();
            let body = r.text().await.unwrap_or_default();
            json!({ "available": false, "reason": relay_error(status, &body) })
        }
        Err(_) => json!({ "available": false, "reason": "连不上中转服务" }),
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

/// The microphone button in the app: start, stop, or cancel a dictation without the hotkey.
#[tauri::command]
pub fn voice_start() -> bool {
    send(Msg::Start)
}

#[tauri::command]
pub fn voice_stop() -> bool {
    send(Msg::Stop)
}

#[tauri::command]
pub fn voice_cancel() -> bool {
    send(Msg::Cancel)
}

/// Re-reads config.json and retries the hotkey (after a permission was granted).
#[tauri::command]
pub fn voice_reload() -> bool {
    send(Msg::Reconfigure)
}

#[tauri::command]
pub async fn voice_transcribe_info(app: AppHandle) -> Value {
    transcribe_info(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_errors_prefer_the_relays_words() {
        // No speech-to-text on the relay: our own words, never the relay's env var names.
        let shown = relay_error(
            503,
            r#"{"error":{"code":"unsupported","message":"set POCKET_TRANSCRIBE_URL and POCKET_TRANSCRIBE_KEY"}}"#,
        );
        assert_eq!(
            shown,
            "这个中转服务还没开启语音转文字，需要管理中转服务的人先配置。"
        );
        assert!(!shown.contains("POCKET_"));
        // Other refusals: the relay's words when it has any.
        assert_eq!(
            relay_error(
                403,
                r#"{"error":{"code":"forbidden","message":"这台设备没有语音权限"}}"#
            ),
            "这台设备没有语音权限"
        );
        assert_eq!(
            relay_error(429, "not json"),
            "说得太频繁了，请稍等一下（429）"
        );
        assert!(relay_error(
            404,
            r#"{"error":{"code":"not_found","message":"not found"}}"#
        )
        .contains("太旧"));
    }
}
