//! macOS Dynamic Island / top menu-bar notch HUD for Ovis attention queue & quick jump.
//!
//! Renders `public/notch-hud.html` inside a borderless, transparent, non-activating
//! floating window anchored over the top hardware camera notch (or top-center pill on
//! external/non-notch displays). Falls back to clean no-ops on non-macOS platforms.

use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "notch-hud";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotchViewMode {
    Compact,
    Peek,
    Expanded,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NotchFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub notch_width: f64,
    pub notch_height: f64,
    pub top_inset: f64,
    pub has_notch: bool,
}

static LATEST_STATE: Mutex<Option<Value>> = Mutex::new(None);
static EXPANDED: AtomicBool = AtomicBool::new(false);

/// Pure cross-platform frame calculator for hardware-notch and standard displays.
pub fn compute_notch_frame(
    mon_x: f64,
    mon_y: f64,
    mon_w: f64,
    menu_bar_h: f64,
    aux_left_w: f64,
    aux_right_w: f64,
    has_aux: bool,
    mode: NotchViewMode,
) -> NotchFrame {
    let bar_h = menu_bar_h.clamp(24.0, 46.0);
    let mon_w = mon_w.max(320.0);
    let has_notch =
        has_aux && aux_left_w > 0.0 && aux_right_w > 0.0 && aux_left_w + aux_right_w < mon_w - 60.0;
    let notch_width = if has_notch {
        (mon_w - aux_left_w - aux_right_w).clamp(150.0, 260.0)
    } else {
        0.0
    };
    let top_inset = if has_notch { bar_h } else { 4.0 };
    let y = mon_y + if has_notch { 0.0 } else { 4.0 };

    let (width, height) = match mode {
        NotchViewMode::Compact => {
            if has_notch {
                (notch_width + 136.0, bar_h.max(34.0))
            } else {
                (236.0, 30.0)
            }
        }
        NotchViewMode::Peek => (
            396.0,
            if has_notch {
                (bar_h + 58.0).max(94.0)
            } else {
                86.0
            },
        ),
        NotchViewMode::Expanded => (
            420.0,
            if has_notch {
                (bar_h + 252.0).max(288.0)
            } else {
                280.0
            },
        ),
    };
    let width = width.min(mon_w - 24.0);
    let x = mon_x + ((mon_w - width) / 2.0).max(0.0);

    NotchFrame {
        x,
        y,
        width,
        height,
        notch_width,
        notch_height: bar_h,
        top_inset,
        has_notch,
    }
}

fn current_mode(state: &Value) -> NotchViewMode {
    if EXPANDED.load(Ordering::Relaxed) {
        return NotchViewMode::Expanded;
    }
    if state.get("peek").is_some_and(|v| !v.is_null()) {
        return NotchViewMode::Peek;
    }
    NotchViewMode::Compact
}

fn should_be_visible(state: &Value) -> bool {
    let enabled = state
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !enabled {
        return false;
    }
    let has_items = state
        .get("items")
        .and_then(Value::as_array)
        .is_some_and(|arr| !arr.is_empty());
    let has_peek = state.get("peek").is_some_and(|v| !v.is_null());
    has_items || has_peek
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{compute_notch_frame, NotchFrame, NotchViewMode};
    use objc2::declare::ClassBuilder;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
    use objc2::{msg_send, sel};
    use objc2_app_kit::{NSColor, NSScreen, NSWindow, NSWindowCollectionBehavior};
    use objc2_foundation::{MainThreadMarker, NSObjectProtocol, NSRect};
    use std::ffi::CStr;
    use std::sync::OnceLock;

    const SUBCLASS_NAME: &CStr = c"PocketNotchWindow";
    static SUBCLASS_ADDR: OnceLock<usize> = OnceLock::new();

    unsafe extern "C-unwind" fn constrain_frame_rect(
        _this: *mut AnyObject,
        _cmd: Sel,
        frame_rect: NSRect,
        _screen: *mut AnyObject,
    ) -> NSRect {
        frame_rect
    }

    pub fn configure_window(w: &tauri::WebviewWindow) {
        let Ok(ptr) = w.ns_window() else {
            return;
        };
        if ptr.is_null() {
            return;
        }
        let ns_obj = ptr as *mut AnyObject;
        // SAFETY: Always invoked on main thread via `app.run_on_main_thread`.
        unsafe {
            let base_cls = (&*ns_obj).class();
            let sub_addr = *SUBCLASS_ADDR.get_or_init(|| {
                if let Some(existing) = AnyClass::get(SUBCLASS_NAME) {
                    return existing as *const AnyClass as usize;
                }
                if let Some(mut builder) = ClassBuilder::new(SUBCLASS_NAME, base_cls) {
                    builder.add_method(
                        sel!(constrainFrameRect:toScreen:),
                        constrain_frame_rect
                            as unsafe extern "C-unwind" fn(
                                *mut AnyObject,
                                Sel,
                                NSRect,
                                *mut AnyObject,
                            ) -> NSRect,
                    );
                    let cls = builder.register();
                    cls as *const AnyClass as usize
                } else {
                    base_cls as *const AnyClass as usize
                }
            });
            let sub_cls = sub_addr as *const AnyClass;
            if !std::ptr::eq(base_cls, sub_cls) {
                objc2::ffi::object_setClass(ns_obj.cast(), sub_cls.cast());
            }

            let ns_win = &*(ptr as *const NSWindow);
            ns_win.setLevel(26);
            ns_win.setHasShadow(false);
            ns_win.setOpaque(false);
            ns_win.setBackgroundColor(Some(&NSColor::clearColor()));
            ns_win.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::Stationary
                    | NSWindowCollectionBehavior::FullScreenAuxiliary
                    | NSWindowCollectionBehavior::IgnoresCycle,
            );
            if ns_win.respondsToSelector(sel!(_setPreventsActivation:)) {
                let _: () = msg_send![ns_win, _setPreventsActivation: Bool::YES];
            }
        }
    }

    pub fn order_front_non_activating(w: &tauri::WebviewWindow) {
        let Ok(ptr) = w.ns_window() else {
            return;
        };
        if ptr.is_null() {
            return;
        }
        unsafe {
            let ns_win = &*(ptr as *const NSWindow);
            ns_win.orderFrontRegardless();
        }
    }

    pub fn measure_frame(app: &tauri::AppHandle, mode: NotchViewMode) -> NotchFrame {
        let monitor = app
            .cursor_position()
            .ok()
            .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
            .or_else(|| app.primary_monitor().ok().flatten());
        let (mon_x, mon_y, mon_w, mon_bar_h) = if let Some(ref m) = monitor {
            let scale = m.scale_factor().max(1.0);
            let pos = m.position();
            let sz = m.size();
            let wa = m.work_area();
            let bar_h = ((f64::from(wa.position.y) - f64::from(pos.y)) / scale).max(0.0);
            (
                f64::from(pos.x) / scale,
                f64::from(pos.y) / scale,
                f64::from(sz.width) / scale,
                if bar_h > 10.0 { bar_h } else { 32.0 },
            )
        } else {
            (0.0, 0.0, 1440.0, 32.0)
        };

        let mut aux_left = 0.0f64;
        let mut aux_right = 0.0f64;
        let mut has_aux = false;
        let mut cocoa_bar_h = mon_bar_h;

        if let Some(mtm) = MainThreadMarker::new() {
            let screens = NSScreen::screens(mtm);
            let target_screen = screens
                .iter()
                .find(|s| {
                    let f = s.frame();
                    (f.size.width - mon_w).abs() < 2.0
                })
                .or_else(|| NSScreen::mainScreen(mtm));

            if let Some(screen) = target_screen {
                let f = screen.frame();
                let v = screen.visibleFrame();
                let top_inset = ((f.origin.y + f.size.height) - (v.origin.y + v.size.height)).max(0.0);
                if top_inset > 16.0 {
                    cocoa_bar_h = top_inset;
                }
                if screen.respondsToSelector(sel!(auxiliaryTopLeftArea))
                    && screen.respondsToSelector(sel!(auxiliaryTopRightArea))
                {
                    let left: NSRect = unsafe { msg_send![&*screen, auxiliaryTopLeftArea] };
                    let right: NSRect = unsafe { msg_send![&*screen, auxiliaryTopRightArea] };
                    aux_left = left.size.width;
                    aux_right = right.size.width;
                    has_aux = true;
                }
            }
        }

        compute_notch_frame(
            mon_x,
            mon_y,
            mon_w,
            cocoa_bar_h,
            aux_left,
            aux_right,
            has_aux,
            mode,
        )
    }
}

#[cfg(target_os = "macos")]
fn push_state(app: &AppHandle, state: &Value, frame: NotchFrame, mode: NotchViewMode) {
    let Some(w) = app.get_webview_window(LABEL) else {
        return;
    };
    let mut enriched = state.clone();
    if let Some(obj) = enriched.as_object_mut() {
        obj.insert(
            "mode".into(),
            Value::String(
                match mode {
                    NotchViewMode::Compact => "compact",
                    NotchViewMode::Peek => "peek",
                    NotchViewMode::Expanded => "expanded",
                }
                .into(),
            ),
        );
        obj.insert("notchWidth".into(), Value::from(frame.notch_width.round()));
        obj.insert("notchHeight".into(), Value::from(frame.notch_height.round()));
        obj.insert("topInset".into(), Value::from(frame.top_inset.round()));
        obj.insert("hasNotch".into(), Value::Bool(frame.has_notch));
    }
    let js = format!("window.__notch && window.__notch({enriched})");
    let _ = w.eval(&js);
}

#[cfg(target_os = "macos")]
fn apply_layout_and_push(app: &AppHandle, state: &Value) {
    if !should_be_visible(state) {
        EXPANDED.store(false, Ordering::Relaxed);
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.set_ignore_cursor_events(true);
            let _ = w.hide();
        }
        return;
    }

    let Some(w) = ensure(app) else {
        return;
    };
    macos::configure_window(&w);
    let mode = current_mode(state);
    let frame = macos::measure_frame(app, mode);
    let _ = w.set_size(LogicalSize::new(frame.width, frame.height));
    let _ = w.set_position(LogicalPosition::new(frame.x, frame.y));
    let _ = w.set_ignore_cursor_events(false);
    let _ = w.show();
    macos::order_front_non_activating(&w);
    push_state(app, state, frame, mode);
}

#[cfg(target_os = "macos")]
fn decode_query_value(raw_query: &str, key: &str) -> Option<String> {
    for pair in raw_query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return url::form_urlencoded::parse(v.as_bytes())
                    .map(|(dk, _)| dk.into_owned())
                    .next()
                    .or_else(|| Some(v.to_string()));
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn handle_notch_url(app: &AppHandle, raw_url: &str) {
    let Ok(parsed) = url::Url::parse(raw_url) else {
        return;
    };
    if parsed.scheme() != "pocket-notch" {
        return;
    }
    let host = parsed.host_str().unwrap_or("");
    let query = parsed.query().unwrap_or("");
    let val_param = |k: &str| {
        url::form_urlencoded::parse(query.as_bytes())
            .find(|(pk, _)| pk == k)
            .map(|(_, pv)| pv.into_owned())
            .or_else(|| decode_query_value(query, k))
    };

    match host {
        "expand" => {
            EXPANDED.store(true, Ordering::Relaxed);
            if let Ok(g) = LATEST_STATE.lock() {
                if let Some(st) = g.as_ref() {
                    let app2 = app.clone();
                    let st2 = st.clone();
                    let _ = app.run_on_main_thread(move || apply_layout_and_push(&app2, &st2));
                }
            }
        }
        "collapse" => {
            EXPANDED.store(false, Ordering::Relaxed);
            if let Ok(g) = LATEST_STATE.lock() {
                if let Some(st) = g.as_ref() {
                    let app2 = app.clone();
                    let st2 = st.clone();
                    let _ = app.run_on_main_thread(move || apply_layout_and_push(&app2, &st2));
                }
            }
        }
        "jump" => {
            EXPANDED.store(false, Ordering::Relaxed);
            if let Some(agent_key) = val_param("key") {
                crate::mainwin::show_main(app, "notch.jump");
                let _ = app.emit_to(
                    "main",
                    "notch://action",
                    serde_json::json!({ "action": "jump", "agentKey": agent_key }),
                );
            }
        }
        "dismiss" => {
            if let Some(id) = val_param("id") {
                let _ = app.emit_to(
                    "main",
                    "notch://action",
                    serde_json::json!({ "action": "dismiss", "id": id }),
                );
            }
        }
        "clear-all" => {
            EXPANDED.store(false, Ordering::Relaxed);
            let _ = app.emit_to(
                "main",
                "notch://action",
                serde_json::json!({ "action": "clear-all" }),
            );
        }
        "open-main" => {
            crate::mainwin::show_main(app, "notch.open");
            let _ = app.emit_to(
                "main",
                "notch://action",
                serde_json::json!({ "action": "open-main" }),
            );
        }
        _ => {}
    }
}

#[cfg(target_os = "macos")]
fn ensure(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let app_nav = app.clone();
    let builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("notch-hud.html".into()))
        .title("Herdr Pocket · 灵动岛提醒")
        .inner_size(240.0, 34.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(false)
        .focusable(false)
        .visible(false)
        .transparent(true)
        .on_navigation(move |url| {
            let raw = url.as_str();
            if raw.starts_with("pocket-notch://") {
                handle_notch_url(&app_nav, raw);
                return false;
            }
            true
        })
        .on_page_load(|w, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let app2 = w.app_handle().clone();
                if let Ok(g) = LATEST_STATE.lock() {
                    if let Some(st) = g.as_ref().cloned() {
                        let app3 = app2.clone();
                        let _ = app2.run_on_main_thread(move || apply_layout_and_push(&app3, &st));
                    }
                }
            }
        });
    match builder.build() {
        Ok(w) => {
            macos::configure_window(&w);
            let _ = w.set_ignore_cursor_events(true);
            crate::logging::debug("notch.hud", "notch HUD window created", Value::Null);
            Some(w)
        }
        Err(e) => {
            crate::logging::warn(
                "notch.hud",
                "notch HUD creation failed",
                serde_json::json!({ "error": e.to_string() }),
            );
            None
        }
    }
}

pub fn sync(app: &AppHandle, state: Value) {
    if let Ok(mut g) = LATEST_STATE.lock() {
        *g = Some(state.clone());
    }
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            apply_layout_and_push(&app2, &state);
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state);
    }
}

#[allow(dead_code)]
pub fn hide(app: &AppHandle) {
    EXPANDED.store(false, Ordering::Relaxed);
    if let Ok(mut g) = LATEST_STATE.lock() {
        *g = None;
    }
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app2.get_webview_window(LABEL) {
                let _ = w.set_ignore_cursor_events(true);
                let _ = w.hide();
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn shutdown(app: &AppHandle) {
    EXPANDED.store(false, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.close();
    }
}

#[cfg(test)]
mod tests {
    use super::{compute_notch_frame, NotchViewMode};

    #[test]
    fn compute_notch_frame_handles_notched_macbook_and_standard_monitor() {
        // Hardware-notch 1512pt MacBook Pro display with 38pt menu bar.
        let compact_notch =
            compute_notch_frame(0.0, 0.0, 1512.0, 38.0, 656.0, 656.0, true, NotchViewMode::Compact);
        assert!(compact_notch.has_notch);
        assert_eq!(compact_notch.notch_width, 200.0);
        assert_eq!(compact_notch.y, 0.0);
        assert_eq!(compact_notch.top_inset, 38.0);
        assert_eq!(compact_notch.width, 336.0);
        assert_eq!(compact_notch.x, (1512.0 - 336.0) / 2.0);

        let expanded_notch =
            compute_notch_frame(0.0, 0.0, 1512.0, 38.0, 656.0, 656.0, true, NotchViewMode::Expanded);
        assert_eq!(expanded_notch.y, 0.0);
        assert!(expanded_notch.height >= 288.0);
        assert_eq!(expanded_notch.top_inset, 38.0);

        // External display without hardware notch (`aux_left_w == 0`).
        let compact_flat =
            compute_notch_frame(0.0, 0.0, 1920.0, 28.0, 0.0, 0.0, true, NotchViewMode::Compact);
        assert!(!compact_flat.has_notch);
        assert_eq!(compact_flat.notch_width, 0.0);
        assert_eq!(compact_flat.y, 4.0);
        assert_eq!(compact_flat.top_inset, 4.0);
        assert_eq!(compact_flat.width, 236.0);
        assert_eq!(compact_flat.height, 30.0);

        let peek_flat =
            compute_notch_frame(0.0, 0.0, 1920.0, 28.0, 0.0, 0.0, false, NotchViewMode::Peek);
        assert_eq!(peek_flat.width, 396.0);
        assert_eq!(peek_flat.y, 4.0);
    }
}
