//! The floating Xiaoyang realtime voice call capsule: always on top, transparent,
//! never focused (your current app keeps the keyboard), shown near the bottom of
//! the screen the pointer is on. Loads `voice-hud.html` and receives live call
//! state via `window.__hud(state)`; interactive buttons (Mute / Hangup) talk back
//! via `pocket-hud://` navigation hooks intercepted in `on_navigation`.
//! Created on first use and closed after a few idle minutes to free WebView memory.

use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "voice-hud";
const WIDTH: f64 = 540.0;
const HEIGHT: f64 = 84.0;
/// Closed after this long idle.
pub const IDLE_CLOSE: Duration = Duration::from_secs(180);

static LATEST: Mutex<Option<Value>> = Mutex::new(None);
static LAST_USE: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_INTERACTIVE: AtomicBool = AtomicBool::new(false);

fn is_interactive_state(state: &Value) -> bool {
    matches!(
        state.get("state").and_then(Value::as_str),
        Some("connecting" | "active")
    )
}

fn push(app: &AppHandle, state: &Value) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let js = format!("window.__hud && window.__hud({state})");
        let _ = w.eval(&js);
    }
}

fn centered_position(
    area_x: i32,
    area_y: i32,
    area_w: u32,
    area_h: u32,
    scale: f64,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let x = f64::from(area_x) / scale + (f64::from(area_w) / scale - width) / 2.0;
    let y = f64::from(area_y) / scale + f64::from(area_h) / scale - height - 96.0;
    (x, y)
}

fn place(app: &AppHandle, w: &tauri::WebviewWindow, height: f64) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let area = m.work_area();
        let (x, y) = centered_position(
            area.position.x,
            area.position.y,
            area.size.width,
            area.size.height,
            m.scale_factor(),
            WIDTH,
            height,
        );
        let _ = w.set_position(tauri::LogicalPosition::new(x, y));
    }
}

fn ensure(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let app_nav = app.clone();
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("voice-hud.html".into()))
        .title("Herdr Pocket · 小羊实时通话")
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
        .on_navigation(move |url| {
            let raw = url.as_str().trim_end_matches('/');
            match raw {
                "pocket-hud://toggle-mute" => {
                    super::toggle_mute_from_hud(&app_nav);
                    false
                }
                "pocket-hud://hangup" | "pocket-hud://dismiss" => {
                    super::hangup_from_hud(&app_nav);
                    false
                }
                _ => !raw.starts_with("pocket-hud://"),
            }
        })
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
    let interactive = is_interactive_state(&state);
    LAST_INTERACTIVE.store(interactive, Ordering::Relaxed);
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = ensure(&app2) {
            let _ = w.set_ignore_cursor_events(!interactive);
            let was_visible = w.is_visible().unwrap_or(false);
            if !was_visible {
                let _ = w.set_size(tauri::LogicalSize::new(WIDTH, HEIGHT));
                place(&app2, &w, HEIGHT);
                let _ = w.show();
            }
            push(&app2, &state);
        }
    });
}

/// Updates an already-visible HUD (audio meter, clock, captions, phase).
pub fn update(app: &AppHandle, state: Value) {
    if let Ok(mut l) = LAST_USE.lock() {
        *l = Some(Instant::now());
    }
    if let Ok(mut g) = LATEST.lock() {
        *g = Some(state.clone());
    }
    let interactive = is_interactive_state(&state);
    let inter_changed = LAST_INTERACTIVE.swap(interactive, Ordering::Relaxed) != interactive;
    if inter_changed {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app2.get_webview_window(LABEL) {
                let _ = w.set_ignore_cursor_events(!interactive);
                if w.is_visible().unwrap_or(false) {
                    push(&app2, &state);
                }
            }
        });
    } else if let Some(w) = app.get_webview_window(LABEL) {
        if w.is_visible().unwrap_or(false) {
            push(app, &state);
        }
    }
}

/// Hides the HUD immediately (`0ms`) and resets its rendered state.
pub fn hide(app: &AppHandle) {
    LAST_INTERACTIVE.store(false, Ordering::Relaxed);
    if let Ok(mut g) = LATEST.lock() {
        *g = None;
    }
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app2.get_webview_window(LABEL) {
            let _ = w.set_ignore_cursor_events(true);
            let _ = w.hide();
            let _ = w.eval("window.__hud && window.__hud({ state: 'hidden' })");
        }
    });
}

/// Closes the HUD window when it has been idle for `IDLE_CLOSE`.
pub fn close_if_idle(app: &AppHandle) {
    if super::is_call_active() {
        return;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn interactivity_matches_call_hud_states() {
        for interactive in ["connecting", "active"] {
            let v = json!({ "state": interactive });
            assert!(is_interactive_state(&v), "{interactive} should accept clicks");
        }
        for passive in ["error", "hidden"] {
            let v = json!({ "state": passive });
            assert!(!is_interactive_state(&v), "{passive} should pass through cursor");
        }
    }

    #[test]
    fn hud_dimensions_and_centered_position_fit_glass_capsule() {
        assert_eq!(WIDTH, 540.0);
        assert_eq!(HEIGHT, 84.0);
        let (x, y) = centered_position(0, 50, 3024, 1914, 2.0, WIDTH, HEIGHT);
        assert_eq!(x, (1512.0 - 540.0) / 2.0);
        assert_eq!(y, 25.0 + 957.0 - HEIGHT - 96.0);

        let (x2, y2) = centered_position(1920, 0, 1920, 1080, 1.0, WIDTH, HEIGHT);
        assert_eq!(x2, 1920.0 + (1920.0 - 540.0) / 2.0);
        assert_eq!(y2, 1080.0 - HEIGHT - 96.0);
    }
}
