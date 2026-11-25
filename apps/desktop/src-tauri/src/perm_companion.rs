//! Floating macOS companion window for side-by-side permission authorization.
//!
//! Automatically docks next to macOS System Settings -> Privacy & Security so the user can
//! flip the toggle or drag `Herdr Pocket.app` straight across in one short motion, watches
//! live grant state without blocking dialogs, and closes automatically once granted.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

pub const LABEL: &str = "perm-companion";
pub const WIDTH: f64 = 308.0;
pub const HEIGHT: f64 = 188.0;
const EDGE_GAP: f64 = 12.0;
const SCREEN_MARGIN: f64 = 12.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WindowRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionPlacement {
    pub x: f64,
    pub y: f64,
    /// Direction pointing toward System Settings ("left" means System Settings is on the left).
    pub arrow_dir: &'static str,
}

pub fn supports_companion(kind: &str) -> bool {
    matches!(
        kind,
        "screenRecording" | "microphone" | "inputMonitoring" | "accessibility" | "fullDiskAccess"
    )
}

/// Computes non-overlapping side-by-side placement relative to `System Settings` inside `work`.
pub fn compute_companion_placement(
    sys: Option<WindowRect>,
    work: WindowRect,
    width: f64,
    height: f64,
) -> CompanionPlacement {
    let min_x = work.x + SCREEN_MARGIN;
    let max_x = (work.x + work.w - width - SCREEN_MARGIN).max(min_x);
    let min_y = work.y + SCREEN_MARGIN;
    let max_y = (work.y + work.h - height - SCREEN_MARGIN).max(min_y);

    let Some(sys_rect) = sys else {
        return CompanionPlacement {
            x: max_x,
            y: (work.y + 84.0).clamp(min_y, max_y),
            arrow_dir: "left",
        };
    };

    let desired_y = (sys_rect.y + 68.0).clamp(min_y, max_y);
    let right_x = sys_rect.x + sys_rect.w + EDGE_GAP;
    if right_x + width <= work.x + work.w - 8.0 {
        return CompanionPlacement {
            x: right_x.round(),
            y: desired_y.round(),
            arrow_dir: "left",
        };
    }

    let left_x = sys_rect.x - width - EDGE_GAP;
    if left_x >= work.x + 8.0 {
        return CompanionPlacement {
            x: left_x.round(),
            y: desired_y.round(),
            arrow_dir: "right",
        };
    }

    // Fallback when System Settings fills the screen width: dock cleanly over its left sidebar edge
    // so the right-hand permission list stays clear for toggling or dropping.
    CompanionPlacement {
        x: sys_rect.x.clamp(min_x, max_x).round(),
        y: (sys_rect.y + sys_rect.h - height - 24.0)
            .clamp(min_y, max_y)
            .round(),
        arrow_dir: "right",
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{
        compute_companion_placement, supports_companion, CompanionPlacement, WindowRect, HEIGHT,
        LABEL, WIDTH,
    };
    use crate::perms::{self, State};
    use crate::{config, logging};
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::{CFString, CFStringRef};
    use objc2_app_kit::NSWindow;
    use serde::Serialize;
    use serde_json::{json, Value};
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

    const K_CG_WINDOW_LIST_ON_SCREEN_ONLY: u32 = 1 << 0;
    const K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct RawCGRect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> *const c_void;
        fn CGRectMakeWithDictionaryRepresentation(
            dict: *const c_void,
            rect: *mut RawCGRect,
        ) -> bool;
        static kCGWindowOwnerName: CFStringRef;
        static kCGWindowLayer: CFStringRef;
        static kCGWindowBounds: CFStringRef;
    }

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CompanionState {
        kind: String,
        title: &'static str,
        arrow_dir: &'static str,
        granted: bool,
        can_reset: bool,
        needs_relaunch: bool,
        bundle_path: String,
        theme: String,
    }

    static ACTIVE_KIND: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    static LATEST_STATE: OnceLock<Mutex<Option<Value>>> = OnceLock::new();
    static SESSION_GEN: AtomicU64 = AtomicU64::new(0);

    fn active_kind_cell() -> &'static Mutex<Option<String>> {
        ACTIVE_KIND.get_or_init(|| Mutex::new(None))
    }

    fn latest_state_cell() -> &'static Mutex<Option<Value>> {
        LATEST_STATE.get_or_init(|| Mutex::new(None))
    }

    fn meta_for(kind: &str) -> (&'static str, bool, bool) {
        match kind {
            "screenRecording" => ("屏幕录制", true, false),
            "microphone" => ("麦克风", true, false),
            "inputMonitoring" => ("输入监控", true, true),
            "accessibility" => ("辅助功能", true, false),
            "fullDiskAccess" => ("完全磁盘访问", false, true),
            _ => ("系统权限", false, false),
        }
    }

    fn is_system_settings_owner(owner: &str) -> bool {
        matches!(
            owner,
            "System Settings" | "系统设置" | "System Preferences" | "系统偏好设置"
        )
    }

    fn find_system_settings_window() -> Option<WindowRect> {
        let arr_ref = unsafe {
            CGWindowListCopyWindowInfo(
                K_CG_WINDOW_LIST_ON_SCREEN_ONLY | K_CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
                0,
            )
        };
        if arr_ref.is_null() {
            return None;
        }
        let arr: CFArray<*const c_void> = unsafe { CFArray::wrap_under_create_rule(arr_ref as _) };
        let key_owner = unsafe { kCGWindowOwnerName as *const c_void };
        let key_layer = unsafe { kCGWindowLayer as *const c_void };
        let key_bounds = unsafe { kCGWindowBounds as *const c_void };

        for ptr in arr.iter() {
            let dict_ptr = *ptr;
            if dict_ptr.is_null() {
                continue;
            }
            let dict: CFDictionary<*const c_void, *const c_void> =
                unsafe { CFDictionary::wrap_under_get_rule(dict_ptr as _) };

            let Some(layer_ptr) = dict.find(key_layer) else {
                continue;
            };
            let layer_val = unsafe { CFType::wrap_under_get_rule(*layer_ptr as _) };
            let Some(layer_num) = layer_val.downcast::<CFNumber>().and_then(|n| n.to_i64()) else {
                continue;
            };
            if layer_num != 0 {
                continue;
            }

            let Some(owner_ptr) = dict.find(key_owner) else {
                continue;
            };
            let owner_val = unsafe { CFType::wrap_under_get_rule(*owner_ptr as _) };
            let Some(owner_str) = owner_val.downcast::<CFString>().map(|s| s.to_string()) else {
                continue;
            };
            if !is_system_settings_owner(owner_str.trim()) {
                continue;
            }

            let Some(bounds_ptr) = dict.find(key_bounds) else {
                continue;
            };
            let mut cg_rect = RawCGRect::default();
            if !unsafe { CGRectMakeWithDictionaryRepresentation(*bounds_ptr, &mut cg_rect) } {
                continue;
            }
            if cg_rect.w >= 380.0 && cg_rect.h >= 280.0 {
                return Some(WindowRect {
                    x: cg_rect.x,
                    y: cg_rect.y,
                    w: cg_rect.w,
                    h: cg_rect.h,
                });
            }
        }
        None
    }

    fn monitor_work_rect(app: &AppHandle, sys: Option<WindowRect>) -> WindowRect {
        let monitors = app.available_monitors().unwrap_or_default();
        let chosen = if let Some(s) = sys {
            let cx = s.x + s.w / 2.0;
            let cy = s.y + s.h / 2.0;
            monitors.into_iter().find(|m| {
                let scale = if m.scale_factor() > 0.0 {
                    m.scale_factor()
                } else {
                    1.0
                };
                let area = m.work_area();
                let mx = f64::from(area.position.x) / scale;
                let my = f64::from(area.position.y) / scale;
                let mw = f64::from(area.size.width) / scale;
                let mh = f64::from(area.size.height) / scale;
                cx >= mx && cx <= mx + mw && cy >= my && cy <= my + mh
            })
        } else {
            None
        }
        .or_else(|| app.primary_monitor().ok().flatten());

        if let Some(m) = chosen {
            let scale = if m.scale_factor() > 0.0 {
                m.scale_factor()
            } else {
                1.0
            };
            let area = m.work_area();
            return WindowRect {
                x: f64::from(area.position.x) / scale,
                y: f64::from(area.position.y) / scale,
                w: f64::from(area.size.width) / scale,
                h: f64::from(area.size.height) / scale,
            };
        }
        WindowRect {
            x: 0.0,
            y: 25.0,
            w: 1440.0,
            h: 875.0,
        }
    }

    fn placement_for(app: &AppHandle, sys: Option<WindowRect>) -> CompanionPlacement {
        let work = monitor_work_rect(app, sys);
        compute_companion_placement(sys, work, WIDTH, HEIGHT)
    }

    fn build_state(kind: &str, arrow_dir: &'static str, granted: bool) -> Value {
        let (title, can_reset, needs_relaunch) = meta_for(kind);
        let bundle_path = perms::current_app_bundle()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "/Applications/Herdr Pocket.app".to_string());
        serde_json::to_value(CompanionState {
            kind: kind.to_string(),
            title,
            arrow_dir,
            granted,
            can_reset,
            needs_relaunch,
            bundle_path,
            theme: config::native().theme,
        })
        .unwrap_or(Value::Null)
    }

    fn push_state(app: &AppHandle, state: &Value) {
        if let Ok(mut g) = latest_state_cell().lock() {
            *g = Some(state.clone());
        }
        if let Some(w) = app.get_webview_window(LABEL) {
            let js = format!("window.__permCompanion && window.__permCompanion({state})");
            let _ = w.eval(&js);
        }
    }

    fn configure_ns_window(w: &tauri::WebviewWindow) {
        let Ok(ptr) = w.ns_window() else {
            return;
        };
        if ptr.is_null() {
            return;
        }
        unsafe {
            let ns_win = &*(ptr as *const NSWindow);
            ns_win.setHidesOnDeactivate(false);
        }
    }

    fn current_kind() -> Option<String> {
        active_kind_cell().lock().ok().and_then(|g| g.clone())
    }

    fn ensure_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
        if let Some(w) = app.get_webview_window(LABEL) {
            return Some(w);
        }
        let app_nav = app.clone();
        let builder =
            WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("perm-companion.html".into()))
                .title("Herdr Pocket · 授权拖拽")
                .inner_size(WIDTH, HEIGHT)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .visible_on_all_workspaces(true)
                .skip_taskbar(true)
                .shadow(false)
                .focused(false)
                .focusable(true)
                .visible(false)
                .disable_drag_drop_handler()
                .on_navigation(move |url| {
                    let raw = url.as_str().trim_end_matches('/');
                    if !raw.starts_with("pocket-perm://") {
                        return true;
                    }
                    let action = raw.trim_start_matches("pocket-perm://");
                    match action {
                        "start-drag" => {
                            let h = app_nav.clone();
                            let _ = app_nav.run_on_main_thread(move || {
                                let _ = perms::start_app_bundle_drag_from(&h, Some(LABEL));
                            });
                        }
                        "reveal-finder" => {
                            std::thread::spawn(|| {
                                let _ = perms::reveal_app_bundle();
                            });
                        }
                        "reopen-settings" => {
                            if let Some(k) = current_kind() {
                                std::thread::spawn(move || {
                                    let _ = perms::open_settings(&k);
                                });
                            }
                        }
                        "reset-cache" => {
                            if let Some(k) = current_kind() {
                                let h = app_nav.clone();
                                std::thread::spawn(move || {
                                    if let Ok(next) = perms::reset_mac_permission(&h, &k) {
                                        let _ = h.emit_to("main", "app://permissions", &next);
                                    }
                                });
                            }
                        }
                        "relaunch" => {
                            crate::commands::relaunch_app(app_nav.clone());
                        }
                        "close" => {
                            hide(&app_nav);
                        }
                        _ => {}
                    }
                    false
                })
                .on_page_load(|w, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        if let Some(state) = latest_state_cell().lock().ok().and_then(|g| g.clone())
                        {
                            push_state(w.app_handle(), &state);
                        }
                    }
                });

        match builder.build() {
            Ok(w) => {
                configure_ns_window(&w);
                crate::mainwin::apply_theme(app);
                Some(w)
            }
            Err(e) => {
                logging::warn(
                    "perm.companion",
                    "failed to build perm companion window",
                    json!({ "error": e.to_string() }),
                );
                None
            }
        }
    }

    pub fn show(app: &AppHandle, kind: &str) {
        if !supports_companion(kind) {
            return;
        }
        let gen = SESSION_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        if let Ok(mut g) = active_kind_cell().lock() {
            *g = Some(kind.to_string());
        }
        let kind_owned = kind.to_string();
        let initial_sys = find_system_settings_window();
        let initial_place = placement_for(app, initial_sys);
        let state = build_state(&kind_owned, initial_place.arrow_dir, false);
        if let Ok(mut g) = latest_state_cell().lock() {
            *g = Some(state.clone());
        }

        let app_ui = app.clone();
        let state_ui = state.clone();
        let _ = app.run_on_main_thread(move || {
            if SESSION_GEN.load(Ordering::SeqCst) != gen {
                return;
            }
            if let Some(w) = ensure_window(&app_ui) {
                let _ = w.set_position(LogicalPosition::new(initial_place.x, initial_place.y));
                let _ = w.show();
                configure_ns_window(&w);
                if let Ok(ptr) = w.ns_window() {
                    if !ptr.is_null() {
                        unsafe {
                            let ns_win = &*(ptr as *const NSWindow);
                            ns_win.orderFrontRegardless();
                        }
                    }
                }
                push_state(&app_ui, &state_ui);
            }
        });

        let app_watch = app.clone();
        std::thread::Builder::new()
            .name("pocket-perm-companion".into())
            .spawn(move || {
                let started = Instant::now();
                let mut saw_settings = initial_sys.is_some();
                let mut last_sys = initial_sys;
                let mut last_arrow = initial_place.arrow_dir;
                let mut missing_settings_polls = 0u32;

                loop {
                    let step_ms = if !saw_settings && started.elapsed() < Duration::from_secs(3) {
                        160
                    } else {
                        420
                    };
                    std::thread::sleep(Duration::from_millis(step_ms));
                    if SESSION_GEN.load(Ordering::SeqCst) != gen {
                        return;
                    }

                    let st = perms::status();
                    if perms::note_change(&st) {
                        let _ = app_watch.emit_to("main", "app://permissions", &st);
                        crate::voice::config_changed(&app_watch);
                    }
                    if perms::state_of(&st, &kind_owned) == State::Granted {
                        let done_state = build_state(&kind_owned, last_arrow, true);
                        let _ = app_watch.emit_to("main", "app://permissions", &st);
                        let app_done = app_watch.clone();
                        let _ = app_watch.run_on_main_thread(move || {
                            push_state(&app_done, &done_state);
                        });
                        std::thread::sleep(Duration::from_millis(900));
                        if SESSION_GEN.load(Ordering::SeqCst) == gen {
                            hide(&app_watch);
                        }
                        return;
                    }

                    let sys_now = find_system_settings_window();
                    if let Some(sys_rect) = sys_now {
                        saw_settings = true;
                        missing_settings_polls = 0;
                        if last_sys != Some(sys_rect) {
                            last_sys = Some(sys_rect);
                            let place = placement_for(&app_watch, Some(sys_rect));
                            last_arrow = place.arrow_dir;
                            let next_state = build_state(&kind_owned, place.arrow_dir, false);
                            let app_pos = app_watch.clone();
                            let _ = app_watch.run_on_main_thread(move || {
                                if SESSION_GEN.load(Ordering::SeqCst) != gen {
                                    return;
                                }
                                if let Some(w) = app_pos.get_webview_window(LABEL) {
                                    let _ = w.set_position(LogicalPosition::new(place.x, place.y));
                                }
                                push_state(&app_pos, &next_state);
                            });
                        }
                    } else if saw_settings {
                        missing_settings_polls += 1;
                        if missing_settings_polls >= 3 {
                            hide(&app_watch);
                            return;
                        }
                    } else if started.elapsed() > Duration::from_secs(120) {
                        hide(&app_watch);
                        return;
                    }
                }
            })
            .ok();
    }

    pub fn hide(app: &AppHandle) {
        SESSION_GEN.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut g) = active_kind_cell().lock() {
            *g = None;
        }
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app2.get_webview_window(LABEL) {
                let _ = w.hide();
            }
        });
    }

    pub fn close(app: &AppHandle) {
        SESSION_GEN.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut g) = active_kind_cell().lock() {
            *g = None;
        }
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(w) = app2.get_webview_window(LABEL) {
                let _ = w.destroy();
            }
        });
    }
}

pub fn show(app: &AppHandle, kind: &str) {
    #[cfg(target_os = "macos")]
    mac::show(app, kind);
    #[cfg(not(target_os = "macos"))]
    let _ = (app, kind);
}

#[allow(dead_code)]
pub fn hide(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::hide(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn close(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::close(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::{compute_companion_placement, supports_companion, WindowRect};

    #[test]
    fn companion_placement_docks_beside_system_settings_without_overlap() {
        let work = WindowRect {
            x: 0.0,
            y: 25.0,
            w: 1440.0,
            h: 875.0,
        };
        let sys_left = WindowRect {
            x: 120.0,
            y: 110.0,
            w: 715.0,
            h: 640.0,
        };
        let right = compute_companion_placement(Some(sys_left), work, 308.0, 188.0);
        assert_eq!(right.arrow_dir, "left");
        assert!(right.x >= sys_left.x + sys_left.w + 12.0);
        assert!(right.x + 308.0 <= work.x + work.w);

        let sys_right = WindowRect {
            x: 680.0,
            y: 110.0,
            w: 715.0,
            h: 640.0,
        };
        let left = compute_companion_placement(Some(sys_right), work, 308.0, 188.0);
        assert_eq!(left.arrow_dir, "right");
        assert!(left.x + 308.0 <= sys_right.x - 12.0);
        assert!(left.x >= work.x);

        let sys_full = WindowRect {
            x: 10.0,
            y: 40.0,
            w: 1410.0,
            h: 840.0,
        };
        let fallback = compute_companion_placement(Some(sys_full), work, 308.0, 188.0);
        assert_eq!(fallback.arrow_dir, "right");
        assert!(fallback.x >= work.x + 12.0);
        assert!(fallback.x + 308.0 <= sys_full.x + 340.0);
    }

    #[test]
    fn supports_companion_matches_drag_privacy_panes_only() {
        for ok in [
            "screenRecording",
            "microphone",
            "inputMonitoring",
            "accessibility",
            "fullDiskAccess",
        ] {
            assert!(supports_companion(ok));
        }
        assert!(!supports_companion("keyboard"));
        assert!(!supports_companion("unknown"));
    }
}
