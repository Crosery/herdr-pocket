//! The small floating dictation window: always on top, transparent, never
//! focused (the app you dictate into keeps the keyboard), shown near the
//! bottom of the screen the pointer is on. It loads `voice-hud.html` and gets
//! its state pushed with `window.__hud(state)`; interactive controls talk back
//! via `pocket-hud://` navigation hooks intercepted in `on_navigation`.
//! Created on first use and closed after a few idle minutes to give its
//! WebView's memory back.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "voice-hud";
const WIDTH: f64 = 560.0;
const HEIGHT_COMPACT: f64 = 82.0;
const HEIGHT_EXPANDED: f64 = 188.0;
/// Closed after this long without a dictation.
pub const IDLE_CLOSE: Duration = Duration::from_secs(180);

static LATEST: Mutex<Option<Value>> = Mutex::new(None);
static LAST_USE: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_INTERACTIVE: AtomicBool = AtomicBool::new(false);
static LAST_HEIGHT_BITS: AtomicU64 = AtomicU64::new(HEIGHT_COMPACT.to_bits());
/// 0 = "dictate" (语音输入), 1 = "assistant" (问小羊).
static MODE: AtomicU8 = AtomicU8::new(0);
static ASK_GEN: AtomicU64 = AtomicU64::new(0);

#[allow(dead_code)]
pub fn current_mode() -> &'static str {
    if MODE.load(Ordering::Relaxed) == 1 {
        "assistant"
    } else {
        "dictate"
    }
}

#[allow(dead_code)]
pub fn set_mode(mode: &str) {
    let next = if mode.trim().eq_ignore_ascii_case("assistant") {
        1
    } else {
        0
    };
    MODE.store(next, Ordering::Relaxed);
}

fn is_interactive_state(state: &Value) -> bool {
    matches!(
        state.get("state").and_then(Value::as_str),
        Some("recording" | "assistant_reply")
    )
}

fn target_height(state: &Value) -> f64 {
    if state.get("state").and_then(Value::as_str) == Some("assistant_reply") {
        HEIGHT_EXPANDED
    } else {
        HEIGHT_COMPACT
    }
}

fn with_mode(mut state: Value) -> Value {
    if let Some(obj) = state.as_object_mut() {
        if !obj.contains_key("mode") {
            let mode = if obj.get("state").and_then(Value::as_str) == Some("assistant_reply") {
                "assistant"
            } else {
                current_mode()
            };
            obj.insert("mode".into(), json!(mode));
        }
    }
    state
}

fn refresh_mode_on_hud(app: &AppHandle) {
    let mode = current_mode();
    let updated = {
        let Ok(mut g) = LATEST.lock() else {
            return;
        };
        let Some(ref mut v) = *g else {
            return;
        };
        if let Some(obj) = v.as_object_mut() {
            obj.insert("mode".into(), json!(mode));
        }
        v.clone()
    };
    push(app, &updated);
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
        .title("Herdr Pocket 语音输入")
        .inner_size(WIDTH, HEIGHT_COMPACT)
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
                "pocket-hud://mode/dictate" => {
                    set_mode("dictate");
                    refresh_mode_on_hud(&app_nav);
                    false
                }
                "pocket-hud://mode/assistant" => {
                    set_mode("assistant");
                    refresh_mode_on_hud(&app_nav);
                    false
                }
                "pocket-hud://stop" => {
                    super::voice_stop();
                    false
                }
                "pocket-hud://cancel" => {
                    super::voice_cancel();
                    false
                }
                "pocket-hud://dismiss" => {
                    hide(&app_nav);
                    false
                }
                "pocket-hud://open-assistant" => {
                    use tauri::Emitter;
                    let _ = app_nav.emit_to("main", "voice://open-assistant", Value::Null);
                    if let Some(mw) = app_nav.get_window("main") {
                        let _ = mw.show();
                        let _ = mw.unminimize();
                        let _ = mw.set_focus();
                    }
                    hide(&app_nav);
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
                json!({ "error": e.to_string() }),
            );
            None
        }
    }
}

/// Shows the HUD with `state` (creates it if needed).
pub fn show(app: &AppHandle, state: Value) {
    let state = with_mode(state);
    if state.get("state").and_then(Value::as_str) == Some("recording") {
        ASK_GEN.fetch_add(1, Ordering::Relaxed);
    }
    if let Ok(mut l) = LAST_USE.lock() {
        *l = Some(Instant::now());
    }
    if let Ok(mut g) = LATEST.lock() {
        *g = Some(state.clone());
    }
    let interactive = is_interactive_state(&state);
    let height = target_height(&state);
    LAST_INTERACTIVE.store(interactive, Ordering::Relaxed);
    let height_changed =
        LAST_HEIGHT_BITS.swap(height.to_bits(), Ordering::Relaxed) != height.to_bits();
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = ensure(&app2) {
            let _ = w.set_ignore_cursor_events(!interactive);
            let was_visible = w.is_visible().unwrap_or(false);
            if !was_visible || height_changed {
                let _ = w.set_size(tauri::LogicalSize::new(WIDTH, height));
                place(&app2, &w, height);
            }
            if !was_visible {
                let _ = w.show();
            }
            push(&app2, &state);
        }
    });
}

/// New state for a HUD that is already up (level meter, timer).
pub fn update(app: &AppHandle, state: Value) {
    let state = with_mode(state);
    if let Ok(mut g) = LATEST.lock() {
        *g = Some(state.clone());
    }
    let interactive = is_interactive_state(&state);
    let height = target_height(&state);
    let inter_changed = LAST_INTERACTIVE.swap(interactive, Ordering::Relaxed) != interactive;
    let height_changed =
        LAST_HEIGHT_BITS.swap(height.to_bits(), Ordering::Relaxed) != height.to_bits();
    if inter_changed || height_changed {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app2.get_webview_window(LABEL) {
                if inter_changed {
                    let _ = w.set_ignore_cursor_events(!interactive);
                }
                if height_changed {
                    let _ = w.set_size(tauri::LogicalSize::new(WIDTH, height));
                    place(&app2, &w, height);
                }
                push(&app2, &state);
            }
        });
    } else {
        push(app, &state);
    }
}

pub fn hide(app: &AppHandle) {
    ASK_GEN.fetch_add(1, Ordering::Relaxed);
    LAST_INTERACTIVE.store(false, Ordering::Relaxed);
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = app2.get_webview_window(LABEL) {
            let _ = w.set_ignore_cursor_events(true);
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

fn extract_assistant_reply(
    state: &Value,
    user_item_id: Option<&str>,
    user_ts: i64,
) -> Option<(String, bool)> {
    let items = state.get("items")?.as_array()?;
    let busy = state.get("busy").and_then(Value::as_bool).unwrap_or(false);
    let tail: &[Value] = if let Some(uid) = user_item_id {
        if let Some(pos) = items
            .iter()
            .position(|it| it.get("id").and_then(Value::as_str) == Some(uid))
        {
            &items[pos + 1..]
        } else {
            items.as_slice()
        }
    } else {
        items.as_slice()
    };
    let reply = tail
        .iter()
        .rev()
        .find(|it| {
            let role_ok = it.get("role").and_then(Value::as_str) == Some("assistant");
            let ts_ok = user_item_id.is_some()
                || it.get("ts").and_then(Value::as_i64).unwrap_or(0) >= user_ts;
            let text_ok = !it
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .is_empty();
            role_ok && ts_ok && text_ok
        })
        .and_then(|it| it.get("text").and_then(Value::as_str))
        .map(|s| s.trim().to_string())?;
    Some((reply, !busy))
}

/// Sends a transcribed voice question directly to Xiaoyang on the relay and shows the
/// expanded `assistant_reply` card inside the floating HUD without stealing focus.
#[allow(dead_code)]
pub async fn ask_assistant_from_hud(app: &AppHandle, text: &str) {
    let clean = text.trim().to_string();
    if clean.is_empty() {
        return;
    }
    let gen = ASK_GEN.fetch_add(1, Ordering::Relaxed) + 1;
    show(
        app,
        json!({ "state": "transcribing", "mode": "assistant", "hint": "正在问小羊…" }),
    );

    let Some(session) = crate::read_session(app) else {
        if ASK_GEN.load(Ordering::Relaxed) == gen {
            show(
                app,
                json!({ "state": "error", "mode": "assistant", "message": "还没有连接中转服务，无法向小羊提问" }),
            );
        }
        return;
    };

    if session.server == crate::net::DEMO_SERVER {
        tokio::time::sleep(Duration::from_millis(400)).await;
        if ASK_GEN.load(Ordering::Relaxed) == gen {
            show(
                app,
                json!({
                    "state": "assistant_reply",
                    "mode": "assistant",
                    "question": clean,
                    "answer": "（演示模式）已收到你的语音提问，连接真实中转服务后即可获得小羊实时回复。"
                }),
            );
        }
        return;
    }

    let base = crate::net::server_base(&session.server);
    let post_url = format!("{base}/v1/assistant/messages");
    let post_res = crate::net::client()
        .post(&post_url)
        .bearer_auth(&session.token)
        .timeout(Duration::from_secs(15))
        .json(&json!({ "text": clean }))
        .send()
        .await;

    let (user_item_id, user_ts) = match post_res {
        Ok(r) if r.status().is_success() => {
            let v = r.json::<Value>().await.unwrap_or(Value::Null);
            let uid = v
                .pointer("/item/id")
                .and_then(Value::as_str)
                .map(str::to_string);
            let uts = v.pointer("/item/ts").and_then(Value::as_i64).unwrap_or(0);
            (uid, uts)
        }
        Ok(r) => {
            let status = r.status().as_u16();
            if ASK_GEN.load(Ordering::Relaxed) == gen {
                show(
                    app,
                    json!({
                        "state": "error",
                        "mode": "assistant",
                        "message": format!("向小羊提问失败（{status}）")
                    }),
                );
            }
            return;
        }
        Err(_) => {
            if ASK_GEN.load(Ordering::Relaxed) == gen {
                show(
                    app,
                    json!({
                        "state": "error",
                        "mode": "assistant",
                        "message": "连不上中转服务，无法向小羊提问"
                    }),
                );
            }
            return;
        }
    };

    let state_url = format!("{base}/v1/assistant");
    let mut latest_draft: Option<String> = None;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(450)).await;
        if ASK_GEN.load(Ordering::Relaxed) != gen {
            return;
        }
        let Ok(resp) = crate::net::client()
            .get(&state_url)
            .bearer_auth(&session.token)
            .timeout(Duration::from_secs(10))
            .send()
            .await
        else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(state_json) = resp.json::<Value>().await else {
            continue;
        };
        if let Some((reply, done)) =
            extract_assistant_reply(&state_json, user_item_id.as_deref(), user_ts)
        {
            latest_draft = Some(reply.clone());
            if done {
                if ASK_GEN.load(Ordering::Relaxed) == gen {
                    show(
                        app,
                        json!({
                            "state": "assistant_reply",
                            "mode": "assistant",
                            "question": clean,
                            "answer": reply
                        }),
                    );
                }
                return;
            }
        }
    }

    if ASK_GEN.load(Ordering::Relaxed) != gen {
        return;
    }
    if let Some(draft) = latest_draft {
        show(
            app,
            json!({
                "state": "assistant_reply",
                "mode": "assistant",
                "question": clean,
                "answer": draft
            }),
        );
    } else {
        show(
            app,
            json!({
                "state": "error",
                "mode": "assistant",
                "message": "小羊回复超时，请打开小羊面板查看"
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_defaults_to_dictate_and_switches_cleanly() {
        set_mode("dictate");
        assert_eq!(current_mode(), "dictate");
        set_mode("assistant");
        assert_eq!(current_mode(), "assistant");
        set_mode("unknown");
        assert_eq!(current_mode(), "dictate");

        let injected = with_mode(json!({ "state": "recording" }));
        assert_eq!(injected["mode"], "dictate");
        let reply = with_mode(json!({ "state": "assistant_reply", "answer": "hi" }));
        assert_eq!(reply["mode"], "assistant");
    }

    #[test]
    fn target_height_and_interactivity_match_hud_states() {
        let rec = json!({ "state": "recording" });
        assert!(is_interactive_state(&rec));
        assert_eq!(target_height(&rec), HEIGHT_COMPACT);

        let reply = json!({ "state": "assistant_reply", "answer": "ok" });
        assert!(is_interactive_state(&reply));
        assert_eq!(target_height(&reply), HEIGHT_EXPANDED);

        for passive in ["transcribing", "done", "error", "cancelled"] {
            let v = json!({ "state": passive });
            assert!(!is_interactive_state(&v), "{passive} should pass through cursor");
            assert_eq!(target_height(&v), HEIGHT_COMPACT);
        }
    }

    #[test]
    fn extract_assistant_reply_tracks_streaming_and_completion() {
        let streaming = json!({
            "busy": true,
            "items": [
                { "id": "u1", "ts": 100, "role": "user", "text": "old q" },
                { "id": "a1", "ts": 101, "role": "assistant", "text": "old answer" },
                { "id": "u2", "ts": 200, "role": "user", "text": "new q" },
                { "id": "a2", "ts": 201, "role": "assistant", "text": "partial..." }
            ]
        });
        assert_eq!(
            extract_assistant_reply(&streaming, Some("u2"), 200),
            Some(("partial...".to_string(), false))
        );

        let done = json!({
            "busy": false,
            "items": [
                { "id": "u1", "ts": 100, "role": "user", "text": "old q" },
                { "id": "a1", "ts": 101, "role": "assistant", "text": "old answer" },
                { "id": "u2", "ts": 200, "role": "user", "text": "new q" },
                { "id": "a2", "ts": 202, "role": "assistant", "text": "final answer" }
            ]
        });
        assert_eq!(
            extract_assistant_reply(&done, Some("u2"), 200),
            Some(("final answer".to_string(), true))
        );

        let waiting = json!({
            "busy": true,
            "items": [
                { "id": "u1", "ts": 100, "role": "user", "text": "old q" },
                { "id": "a1", "ts": 101, "role": "assistant", "text": "old answer" },
                { "id": "u2", "ts": 200, "role": "user", "text": "new q" }
            ]
        });
        assert_eq!(extract_assistant_reply(&waiting, Some("u2"), 200), None);
    }

    #[test]
    fn hud_width_and_centered_position_accommodate_recording_and_reply() {
        assert_eq!(WIDTH, 560.0);
        let (x, y) = centered_position(0, 50, 3024, 1914, 2.0, WIDTH, HEIGHT_COMPACT);
        assert_eq!(x, (1512.0 - 560.0) / 2.0);
        assert_eq!(y, 25.0 + 957.0 - HEIGHT_COMPACT - 96.0);

        let (x2, y2) = centered_position(1920, 0, 1920, 1080, 1.0, WIDTH, HEIGHT_EXPANDED);
        assert_eq!(x2, 1920.0 + (1920.0 - 560.0) / 2.0);
        assert_eq!(y2, 1080.0 - HEIGHT_EXPANDED - 96.0);
    }
}
