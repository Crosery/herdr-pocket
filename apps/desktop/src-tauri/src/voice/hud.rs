//! The small floating dictation window: always on top, transparent, never
//! focused (the app you dictate into keeps the keyboard), shown near the
//! bottom of the screen the pointer is on. It loads `voice-hud.html` and gets
//! its state pushed with `window.__hud(state)`; it calls nothing back.
//! Created on first use and closed after a few idle minutes to give its
//! WebView's memory back.

use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "voice-hud";
const WIDTH: f64 = 260.0;
const HEIGHT: f64 = 64.0;
/// Closed after this long without a dictation.
pub const IDLE_CLOSE: Duration = Duration::from_secs(180);

static LATEST: Mutex<Option<Value>> = Mutex::new(None);
static LAST_USE: Mutex<Option<Instant>> = Mutex::new(None);

fn push(app: &AppHandle, state: &Value) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let js = format!("window.__hud && window.__hud({state})");
        let _ = w.eval(&js);
    }
}

fn place(app: &AppHandle, w: &tauri::WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let area = m.work_area();
        let scale = m.scale_factor();
        let x =
            f64::from(area.position.x) / scale + (f64::from(area.size.width) / scale - WIDTH) / 2.0;
        let y = f64::from(area.position.y) / scale + f64::from(area.size.height) / scale
            - HEIGHT
            - 96.0;
        let _ = w.set_position(tauri::LogicalPosition::new(x, y));
    }
}

fn ensure(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("voice-hud.html".into()))
        .title("Herdr Pocket 语音输入")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(false)
        .focusable(false)
        .visible(false)
        .on_page_load(|w, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if let Some(state) = LATEST.lock().ok().and_then(|g| g.clone()) {
                    push(w.app_handle(), &state);
                }
            }
        });
    // macOS: needs tauri's `macos-private-api` feature and `app.macOSPrivateApi` in tauri.conf.json.
    let builder = builder.transparent(true);
    match builder.build() {
        Ok(w) => {
            let _ = w.set_ignore_cursor_events(true);
            crate::logging::debug("voice.hud", "hud window created", Value::Null);
            Some(w)
        }
        Err(e) => {
            crate::logging::warn(
                "voice.hud",
                "hud window failed",
                serde_json::json!({ "error": e.to_string() }),
            );
            None
        }
    }
}

/// Shows the HUD with `state` (creates it if needed).
pub fn show(app: &AppHandle, state: Value) {
    if let Ok(mut l) = LAST_USE.lock() {
        *l = Some(Instant::now());
    }
    if let Ok(mut g) = LATEST.lock() {
        *g = Some(state.clone());
    }
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = ensure(&app2) {
            if !w.is_visible().unwrap_or(false) {
                place(&app2, &w);
                let _ = w.show();
            }
            push(&app2, &state);
        }
    });
}

/// New state for a HUD that is already up (level meter, timer).
pub fn update(app: &AppHandle, state: Value) {
    if let Ok(mut g) = LATEST.lock() {
        *g = Some(state.clone());
    }
    push(app, &state);
}

pub fn hide(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app2.get_webview_window(LABEL) {
            let _ = w.hide();
        }
    });
}

/// Closes the HUD window when it has not been used for a while.
pub fn close_if_idle(app: &AppHandle) {
    let idle = LAST_USE
        .lock()
        .ok()
        .and_then(|l| *l)
        .is_none_or(|t| t.elapsed() >= IDLE_CLOSE);
    if idle {
        close(app);
    }
}

pub fn close(app: &AppHandle) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app2.get_webview_window(LABEL) {
            let _ = w.destroy();
            crate::logging::debug("voice.hud", "hud window closed", Value::Null);
        }
    });
}
