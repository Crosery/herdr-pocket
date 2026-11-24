//! The main window: where it opens, its title bar theme, closing to the tray, launching at
//! login, and "wake" events telling the page to re-check its relay link right away.
//!
//! Wake events matter because the page reconnects with timers: when the window is hidden or
//! covered, WebKit/WebView2 slow those timers down, and a changed network often kills the
//! WebSocket without the page noticing for a long time.

use crate::{config, logging, resources};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Theme};

/// To the main window: `{ reason: "focus" | "shown" | "network" }`. The page should check
/// its relay link now (reconnect at once if it is down) instead of waiting for its backoff.
pub const WAKE_EVENT: &str = "app://wake";
pub const TRAFFIC_LIGHTS_EVENT: &str = "app://traffic-lights";
const TRAY_ID: &str = "pocket-tray";
const WINDOW_STATE_FILE: &str = "window-state.json";
/// tauri.conf.json's minimum; lowered on screens where it does not fit.
const MIN_W: f64 = 420.0;
const MIN_H: f64 = 640.0;
/// Smallest height the UI is ever given (1366x768 at 125% with a taskbar leaves about 530).
const FLOOR_H: f64 = 480.0;
const MARGIN: f64 = 12.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedWindowState {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default)]
    pub fullscreen: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonitorWorkArea {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub deco_w: f64,
    pub deco_h: f64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrafficLightMetrics {
    pub supported: bool,
    pub fullscreen: bool,
    pub safe_left: f64,
    pub safe_top: f64,
}

pub fn compute_traffic_light_safe_zone(
    fullscreen: bool,
    zoom_right_x: f64,
    zoom_bottom_y: f64,
) -> (f64, f64) {
    if fullscreen {
        return (14.0, 0.0);
    }
    let safe_left = if zoom_right_x.is_finite() && zoom_right_x > 0.0 {
        (zoom_right_x + 12.0).ceil().clamp(80.0, 128.0)
    } else {
        88.0
    };
    let safe_top = if zoom_bottom_y.is_finite() && zoom_bottom_y > 0.0 {
        (zoom_bottom_y + 10.0).ceil().clamp(36.0, 52.0)
    } else {
        38.0
    };
    (safe_left, safe_top)
}

#[cfg(target_os = "macos")]
fn measure_main_traffic_lights_on_main(app: &AppHandle) -> TrafficLightMetrics {
    use objc2::msg_send;
    use objc2_app_kit::{NSView, NSWindow};

    let Some(w) = app.get_webview_window("main") else {
        return TrafficLightMetrics {
            supported: true,
            fullscreen: false,
            safe_left: 88.0,
            safe_top: 38.0,
        };
    };
    let fullscreen = w.is_fullscreen().unwrap_or(false);
    if fullscreen {
        let (safe_left, safe_top) = compute_traffic_light_safe_zone(true, 0.0, 0.0);
        return TrafficLightMetrics {
            supported: true,
            fullscreen: true,
            safe_left,
            safe_top,
        };
    }
    let Ok(ptr) = w.ns_window() else {
        return TrafficLightMetrics {
            supported: true,
            fullscreen: false,
            safe_left: 88.0,
            safe_top: 38.0,
        };
    };
    if ptr.is_null() {
        return TrafficLightMetrics {
            supported: true,
            fullscreen: false,
            safe_left: 88.0,
            safe_top: 38.0,
        };
    }
    let ns_win = unsafe { &*(ptr as *const NSWindow) };
    let zoom_ptr: *mut NSView = unsafe { msg_send![ns_win, standardWindowButton: 2usize] };
    if zoom_ptr.is_null() {
        return TrafficLightMetrics {
            supported: true,
            fullscreen: false,
            safe_left: 88.0,
            safe_top: 38.0,
        };
    }
    let zoom_view = unsafe { &*zoom_ptr };
    let bounds = zoom_view.bounds();
    let rect = zoom_view.convertRect_toView(bounds, None);
    let win_h = ns_win.frame().size.height;
    let zoom_right_x = rect.origin.x + rect.size.width;
    let zoom_bottom_y = (win_h - rect.origin.y).max(26.0);
    let (safe_left, safe_top) = compute_traffic_light_safe_zone(false, zoom_right_x, zoom_bottom_y);
    TrafficLightMetrics {
        supported: true,
        fullscreen: false,
        safe_left,
        safe_top,
    }
}

pub fn query_traffic_light_metrics(app: &AppHandle) -> TrafficLightMetrics {
    #[cfg(target_os = "macos")]
    {
        if objc2_foundation::MainThreadMarker::new().is_some() {
            return measure_main_traffic_lights_on_main(app);
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let app2 = app.clone();
        if app
            .run_on_main_thread(move || {
                let _ = tx.send(measure_main_traffic_lights_on_main(&app2));
            })
            .is_ok()
        {
            if let Ok(m) = rx.recv_timeout(Duration::from_millis(200)) {
                return m;
            }
        }
        TrafficLightMetrics {
            supported: true,
            fullscreen: false,
            safe_left: 88.0,
            safe_top: 38.0,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        TrafficLightMetrics {
            supported: false,
            fullscreen: false,
            safe_left: 0.0,
            safe_top: 0.0,
        }
    }
}

pub fn sync_traffic_light_metrics(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        static LAST_METRICS: Mutex<Option<TrafficLightMetrics>> = Mutex::new(None);
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            let metrics = measure_main_traffic_lights_on_main(&app2);
            let changed = LAST_METRICS
                .lock()
                .ok()
                .map(|mut guard| {
                    if guard.as_ref() == Some(&metrics) {
                        false
                    } else {
                        *guard = Some(metrics);
                        true
                    }
                })
                .unwrap_or(true);
            if changed {
                let _ = app2.emit_to("main", TRAFFIC_LIGHTS_EVENT, metrics);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

static PLACEMENT_READY: AtomicBool = AtomicBool::new(false);
static STATE_DIRTY: AtomicBool = AtomicBool::new(false);
static SAVE_PENDING: AtomicBool = AtomicBool::new(false);
static LAST_NORMAL_BOUNDS: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);
static LAST_STATE_CACHE: Mutex<Option<SavedWindowState>> = Mutex::new(None);

fn window_state_path() -> Option<PathBuf> {
    crate::hostd_config_dir().map(|d| d.join(WINDOW_STATE_FILE))
}

fn load_window_state() -> Option<SavedWindowState> {
    let p = window_state_path()?;
    let raw = fs::read_to_string(p).ok()?;
    serde_json::from_str::<SavedWindowState>(&raw).ok()
}

fn write_window_state(state: &SavedWindowState) {
    let Some(p) = window_state_path() else {
        return;
    };
    let Ok(mut bytes) = serde_json::to_vec_pretty(state) else {
        return;
    };
    bytes.push(b'\n');
    if let Err(e) = config::write_atomic(&p, &bytes) {
        logging::warn(
            "app.window",
            "window state write failed",
            json!({ "error": e.to_string() }),
        );
    }
}

/// Validates saved bounds against connected monitors and returns the restored placement only if
/// enough of the window still overlaps an active monitor (`>= 120 x 80` logical px); otherwise
/// returns `None` so startup falls back to centered placement on the active screen.
pub fn resolve_restored_window_state(
    saved: &SavedWindowState,
    monitors: &[MonitorWorkArea],
) -> Option<SavedWindowState> {
    if !saved.x.is_finite()
        || !saved.y.is_finite()
        || !saved.width.is_finite()
        || !saved.height.is_finite()
        || saved.width < 240.0
        || saved.height < 240.0
        || monitors.is_empty()
    {
        return None;
    }

    let mut best: Option<(f64, &MonitorWorkArea)> = None;
    for m in monitors {
        let outer_w = saved.width + m.deco_w.max(0.0);
        let outer_h = saved.height + m.deco_h.max(0.0);
        let ix0 = saved.x.max(m.x);
        let iy0 = saved.y.max(m.y);
        let ix1 = (saved.x + outer_w).min(m.x + m.width);
        let iy1 = (saved.y + outer_h).min(m.y + m.height);
        let iw = (ix1 - ix0).max(0.0);
        let ih = (iy1 - iy0).max(0.0);
        if iw >= 120.0 && ih >= 80.0 {
            let area = iw * ih;
            if best.is_none_or(|(best_area, _)| area > best_area) {
                best = Some((area, m));
            }
        }
    }

    let (_, m) = best?;
    let deco_w = m.deco_w.max(0.0);
    let deco_h = m.deco_h.max(0.0);
    let max_inner_w = (m.width - deco_w).max(MIN_W.min(m.width));
    let max_inner_h = (m.height - deco_h).max(FLOOR_H.min(m.height));
    let min_inner_w = MIN_W.min(max_inner_w);
    let min_inner_h = FLOOR_H.min(max_inner_h);

    let width = saved.width.clamp(min_inner_w, max_inner_w);
    let height = saved.height.clamp(min_inner_h, max_inner_h);
    let outer_w = width + deco_w;
    let min_x = m.x - outer_w + 120.0;
    let max_x = m.x + m.width - 120.0;
    let x = saved.x.clamp(min_x.min(max_x), max_x.max(min_x));
    let min_y = m.y;
    let max_y = (m.y + m.height - 44.0).max(m.y);
    let y = saved.y.clamp(min_y, max_y);

    Some(SavedWindowState {
        x,
        y,
        width,
        height,
        maximized: saved.maximized,
        fullscreen: saved.fullscreen,
    })
}

fn app_cell() -> &'static OnceLock<AppHandle> {
    static APP: OnceLock<AppHandle> = OnceLock::new();
    &APP
}

// ---------------------------------------------------------------------------
// Size and place
// ---------------------------------------------------------------------------

/// Inner size and minimum height for a window that wants `want` (logical px, inner) on a work
/// area of `area`, with `deco` taken by the frame and title bar.
pub fn fit(want: (f64, f64), area: (f64, f64), deco: (f64, f64)) -> ((f64, f64), (f64, f64)) {
    let max_w = (area.0 - deco.0 - 2.0 * MARGIN).max(MIN_W.min(area.0 - deco.0));
    let max_h = (area.1 - deco.1 - MARGIN).max(FLOOR_H.min(area.1 - deco.1));
    let size = (want.0.min(max_w), want.1.min(max_h));
    let min = (
        MIN_W.min(size.0),
        MIN_H.min(size.1).max(FLOOR_H.min(size.1)),
    );
    (size, min)
}

fn window_deco(w: &tauri::Window, scale: f64) -> (f64, f64) {
    let (Ok(inner), Ok(outer)) = (w.inner_size(), w.outer_size()) else {
        return (0.0, 0.0);
    };
    let inner = inner.to_logical::<f64>(scale);
    let outer = outer.to_logical::<f64>(scale);
    (
        (outer.width - inner.width).max(0.0),
        (outer.height - inner.height).max(0.0),
    )
}

fn snapshot_window_state(w: &tauri::Window) -> Option<SavedWindowState> {
    let scale = w.scale_factor().unwrap_or(1.0).max(1.0);
    let fullscreen = w.is_fullscreen().unwrap_or(false);
    let maximized = !fullscreen && w.is_maximized().unwrap_or(false);
    let outer_pos = w.outer_position().ok()?.to_logical::<f64>(scale);
    let inner = w.inner_size().ok()?.to_logical::<f64>(scale);
    let (x, y, width, height) = if !fullscreen {
        if let Ok(mut g) = LAST_NORMAL_BOUNDS.lock() {
            *g = Some((outer_pos.x, outer_pos.y, inner.width, inner.height));
        }
        (outer_pos.x, outer_pos.y, inner.width, inner.height)
    } else if let Ok(g) = LAST_NORMAL_BOUNDS.lock() {
        (*g)?
    } else {
        (outer_pos.x, outer_pos.y, inner.width, inner.height)
    };
    if width < 240.0 || height < 240.0 {
        return None;
    }
    Some(SavedWindowState {
        x,
        y,
        width,
        height,
        maximized,
        fullscreen,
    })
}

pub fn record_window_geometry_change(app: &AppHandle) {
    if !PLACEMENT_READY.load(Ordering::Relaxed) {
        return;
    }
    let Some(w) = app.get_window("main") else {
        return;
    };
    if w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true) {
        return;
    }
    let Some(state) = snapshot_window_state(&w) else {
        return;
    };
    if let Ok(mut cache) = LAST_STATE_CACHE.lock() {
        if cache.as_ref() == Some(&state) {
            return;
        }
        *cache = Some(state);
    }
    STATE_DIRTY.store(true, Ordering::SeqCst);
    if SAVE_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        SAVE_PENDING.store(false, Ordering::SeqCst);
        if !STATE_DIRTY.swap(false, Ordering::SeqCst) {
            return;
        }
        let snapshot = LAST_STATE_CACHE.lock().ok().and_then(|g| g.clone());
        if let Some(st) = snapshot {
            write_window_state(&st);
        }
    });
}

pub fn flush_window_state(app: &AppHandle) {
    if !PLACEMENT_READY.load(Ordering::Relaxed) {
        return;
    }
    if let Some(w) = app.get_window("main") {
        if !w.is_minimized().unwrap_or(false) && w.is_visible().unwrap_or(true) {
            if let Some(st) = snapshot_window_state(&w) {
                if let Ok(mut cache) = LAST_STATE_CACHE.lock() {
                    *cache = Some(st);
                }
                STATE_DIRTY.store(true, Ordering::SeqCst);
            }
        }
    }
    if STATE_DIRTY.swap(false, Ordering::SeqCst) {
        let snapshot = LAST_STATE_CACHE.lock().ok().and_then(|g| g.clone());
        if let Some(st) = snapshot {
            write_window_state(&st);
        }
    }
}

/// Restores the window's prior screen & size/state when still on a connected display, otherwise
/// fits and centers it cleanly on the active monitor.
pub fn fit_on_start(app: &AppHandle) {
    let Some(w) = app.get_window("main") else {
        return;
    };

    let base_scale = w.scale_factor().unwrap_or(1.0).max(1.0);
    let deco = window_deco(&w, base_scale);
    let avail: Vec<MonitorWorkArea> = w
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let s = m.scale_factor().max(1.0);
            let wa = m.work_area();
            MonitorWorkArea {
                x: f64::from(wa.position.x) / s,
                y: f64::from(wa.position.y) / s,
                width: f64::from(wa.size.width) / s,
                height: f64::from(wa.size.height) / s,
                deco_w: deco.0,
                deco_h: deco.1,
            }
        })
        .collect();

    if let Some(saved) = load_window_state().and_then(|s| resolve_restored_window_state(&s, &avail))
    {
        let min_w = MIN_W.min(saved.width);
        let min_h = FLOOR_H.min(MIN_H.min(saved.height));
        let _ = w.set_min_size(Some(LogicalSize::new(min_w, min_h)));
        let _ = w.set_position(LogicalPosition::new(saved.x, saved.y));
        let _ = w.set_size(LogicalSize::new(saved.width, saved.height));
        let _ = w.set_position(LogicalPosition::new(saved.x, saved.y));
        if let Ok(mut g) = LAST_NORMAL_BOUNDS.lock() {
            *g = Some((saved.x, saved.y, saved.width, saved.height));
        }
        if let Ok(mut cache) = LAST_STATE_CACHE.lock() {
            *cache = Some(saved.clone());
        }
        if saved.fullscreen {
            let _ = w.set_fullscreen(true);
        } else {
            #[cfg(not(target_os = "macos"))]
            if saved.maximized {
                let _ = w.maximize();
            }
        }
        PLACEMENT_READY.store(true, Ordering::SeqCst);
        sync_traffic_light_metrics(app);
        logging::info(
            "app.window",
            "window restored",
            json!({
                "x": saved.x.round(),
                "y": saved.y.round(),
                "size": [saved.width.round(), saved.height.round()],
                "fullscreen": saved.fullscreen,
                "maximized": saved.maximized,
            }),
        );
        return;
    }

    let Some(m) = w
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| w.primary_monitor().ok().flatten())
    else {
        PLACEMENT_READY.store(true, Ordering::SeqCst);
        return;
    };
    let scale = m.scale_factor();
    let area = m.work_area();
    let (ax, ay) = (
        f64::from(area.position.x) / scale,
        f64::from(area.position.y) / scale,
    );
    let (aw, ah) = (
        f64::from(area.size.width) / scale,
        f64::from(area.size.height) / scale,
    );
    let Ok(inner) = w.inner_size() else {
        PLACEMENT_READY.store(true, Ordering::SeqCst);
        return;
    };
    let inner = inner.to_logical::<f64>(scale);
    let deco = window_deco(&w, scale);
    let (size, min) = fit((inner.width, inner.height), (aw, ah), deco);
    let _ = w.set_min_size(Some(LogicalSize::new(min.0, min.1)));
    if size.0 < inner.width - 0.5 || size.1 < inner.height - 0.5 {
        let _ = w.set_size(LogicalSize::new(size.0, size.1));
    }
    let x = ax + ((aw - size.0 - deco.0) / 2.0).max(0.0);
    let y = ay + ((ah - size.1 - deco.1) / 2.0).max(0.0);
    let _ = w.set_position(LogicalPosition::new(x, y));
    if let Ok(mut g) = LAST_NORMAL_BOUNDS.lock() {
        *g = Some((x, y, size.0, size.1));
    }
    PLACEMENT_READY.store(true, Ordering::SeqCst);
    sync_traffic_light_metrics(app);
    logging::info(
        "app.window",
        "window placed",
        json!({ "workArea": [aw.round(), ah.round()], "scale": scale, "size": [size.0.round(), size.1.round()], "minHeight": min.1.round() }),
    );
}

/// Starts a native OS window drag on the main window. On macOS, synthesizes a valid
/// `LeftMouseDown` NSEvent in the main window's coordinate space whenever `NSApp.currentEvent`
/// was superseded by async WKWebView IPC, cursor movement, or HUD/accessory windows.
pub fn start_dragging(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            use objc2_app_kit::{
                NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSWindow,
            };
            use objc2_foundation::{MainThreadMarker, NSProcessInfo};

            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let Some(w) = app2.get_webview_window("main") else {
                return;
            };
            let Ok(ptr) = w.ns_window() else {
                return;
            };
            if ptr.is_null() {
                return;
            }
            if NSEvent::pressedMouseButtons() & 1 == 0 {
                return;
            }
            let ns_win = unsafe { &*(ptr as *const NSWindow) };
            ns_win.setMovable(true);
            let win_num = ns_win.windowNumber();
            let ns_app = NSApplication::sharedApplication(mtm);
            let cur_ev = ns_app.currentEvent();
            if let Some(ref ev) = cur_ev {
                if ev.r#type() == NSEventType::LeftMouseDown && ev.windowNumber() == win_num {
                    ns_win.performWindowDragWithEvent(ev);
                    return;
                }
            }
            let screen_pt = NSEvent::mouseLocation();
            let win_pt = ns_win.convertPointFromScreen(screen_pt);
            let flags = cur_ev
                .as_ref()
                .map(|e| e.modifierFlags())
                .unwrap_or(NSEventModifierFlags::empty());
            let uptime = NSProcessInfo::processInfo().systemUptime();
            if let Some(synth) = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                NSEventType::LeftMouseDown,
                win_pt,
                flags,
                uptime,
                win_num,
                None,
                0,
                1,
                1.0,
            ) {
                ns_win.performWindowDragWithEvent(&synth);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(w) = app.get_window("main") {
            let _ = w.start_dragging();
        }
    }
}

pub fn toggle_maximize(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            use objc2_app_kit::NSWindow;
            use objc2_foundation::MainThreadMarker;

            let Some(_mtm) = MainThreadMarker::new() else {
                return;
            };
            let Some(w) = app2.get_webview_window("main") else {
                return;
            };
            let Ok(ptr) = w.ns_window() else {
                return;
            };
            if ptr.is_null() {
                return;
            }
            let ns_win = unsafe { &*(ptr as *const NSWindow) };
            ns_win.setMovable(true);
            ns_win.zoom(None);
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(w) = app.get_window("main") {
            let maxed = w.is_maximized().unwrap_or(false);
            let _ = if maxed { w.unmaximize() } else { w.maximize() };
        }
    }
}

// ---------------------------------------------------------------------------
// Theme, tray, launch at login (config.json `general.*`)
// ---------------------------------------------------------------------------

/// macOS menu bar. Tauri's default one has Close Window on ⌘W, which would close the window
/// before the page sees the key. The page handles ⌘W (close tab), ⌘T, ⌘P / ⌘K, ⌘,, ⌘B, ⌘J,
/// ⌘⇧[ / ⌘⇧] and ⌘⇧A itself, so this menu binds none of them. It keeps the system's own
/// items: About, Services, Hide (⌘H), Quit (⌘Q), the Edit items text boxes need (⌘Z ⌘X ⌘C
/// ⌘V ⌘A), minimise (⌘M), zoom and full screen.
#[cfg(target_os = "macos")]
pub fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem as P, Submenu};
    let pkg = app.package_info();
    let name = pkg.name.clone();
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(pkg.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };
    let app_items = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &P::about(app, Some(&format!("关于 {name}")), Some(about))?,
            &P::separator(app)?,
            &P::services(app, Some("服务"))?,
            &P::separator(app)?,
            &P::hide(app, Some(&format!("隐藏 {name}")))?,
            &P::hide_others(app, Some("隐藏其他"))?,
            &P::show_all(app, Some("全部显示"))?,
            &P::separator(app)?,
            &P::quit(app, Some(&format!("退出 {name}")))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &P::undo(app, Some("撤销"))?,
            &P::redo(app, Some("重做"))?,
            &P::separator(app)?,
            &P::cut(app, Some("剪切"))?,
            &P::copy(app, Some("拷贝"))?,
            &P::paste(app, Some("粘贴"))?,
            &P::select_all(app, Some("全选"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &P::minimize(app, Some("最小化"))?,
            &P::maximize(app, Some("缩放"))?,
            &P::separator(app)?,
            &P::fullscreen(app, Some("进入全屏幕"))?,
        ],
    )?;
    Menu::with_items(app, &[&app_items, &edit, &window])
}

/// The title bar (and the system parts of the page) follow `general.theme`.
pub fn apply_theme(app: &AppHandle) {
    let theme = match config::native().theme.as_str() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    };
    for label in ["main", "voice-hud", "notch-hud"] {
        if let Some(w) = app.get_window(label) {
            let _ = w.set_theme(theme);
        }
    }
}

/// macOS 14+: WebKit's default for a page nobody can see is to suspend its process within
/// seconds to minutes; measured here, a hidden window's page then ran no timer and saw no
/// socket close for 7 min, so it could not reconnect to a restarted relay until shown.
/// "Throttle" keeps it running, slowed down (timers about every 2 s), for the main window
/// only. Browser panels keep WebKit's default.
#[cfg(target_os = "macos")]
fn set_main_inactive_policy(
    app: &AppHandle,
    policy: objc2_web_kit::WKInactiveSchedulingPolicy,
    label: &'static str,
) {
    if objc2_foundation::NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
        < 14
    {
        return;
    }
    let Some(webview) = app.get_webview("main") else {
        return;
    };
    let _ = webview.with_webview(move |pw| {
        let p = pw.inner();
        if p.is_null() {
            return;
        }
        // SAFETY: wry's WKWebView, on the main thread (with_webview runs there).
        let wk = unsafe { &*(p as *const objc2_web_kit::WKWebView) };
        let prefs = unsafe { wk.configuration().preferences() };
        unsafe { prefs.setInactiveSchedulingPolicy(policy) };
        let now = unsafe { prefs.inactiveSchedulingPolicy() }.0;
        logging::info(
            "app.window",
            "hidden page scheduling set",
            json!({ "policy": label, "raw": now }),
        );
    });
}

#[cfg(target_os = "macos")]
pub fn apply_frame_rate_policy(app: &AppHandle) {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{msg_send, sel, ClassType};
    use objc2_foundation::{NSArray, NSObjectProtocol, NSProcessInfo, NSString};

    let is_low_power = match config::native().low_power.as_str() {
        "on" => true,
        "off" => false,
        _ => NSProcessInfo::processInfo().isLowPowerModeEnabled(),
    };
    let Some(webview) = app.get_webview("main") else {
        return;
    };
    let _ = webview.with_webview(move |pw| {
        let p = pw.inner();
        if p.is_null() {
            return;
        }
        // SAFETY: wry's WKWebView on the main thread (with_webview dispatches there).
        let wk = unsafe { &*(p as *const objc2_web_kit::WKWebView) };
        let prefs = unsafe { wk.configuration().preferences() };
        let prefs_cls = objc2_web_kit::WKPreferences::class();
        let has_features: Bool =
            unsafe { msg_send![prefs_cls, respondsToSelector: sel!(_features)] };
        if !has_features.as_bool() {
            return;
        }
        let features: Option<objc2::rc::Retained<NSArray<AnyObject>>> =
            unsafe { msg_send![prefs_cls, _features] };
        let Some(features) = features else {
            return;
        };
        if !prefs.respondsToSelector(sel!(_setEnabled:forFeature:)) {
            return;
        }
        let target_key = "PreferPageRenderingUpdatesNear60FPSEnabled";
        let mut applied = false;
        for feat in features.iter() {
            let has_key: Bool = unsafe { msg_send![&*feat, respondsToSelector: sel!(key)] };
            if !has_key.as_bool() {
                continue;
            }
            let key: Option<objc2::rc::Retained<NSString>> = unsafe { msg_send![&*feat, key] };
            if key.as_ref().is_some_and(|k| k.to_string() == target_key) {
                let enable_60 = Bool::new(is_low_power);
                let _: () = unsafe { msg_send![&*prefs, _setEnabled: enable_60, forFeature: &*feat] };
                applied = true;
                break;
            }
        }
        logging::info(
            "app.window",
            "frame rate policy set",
            json!({
                "lowPower": is_low_power,
                "capNear60Fps": applied && is_low_power,
                "featureFound": applied
            }),
        );
    });
}

#[cfg(target_os = "macos")]
fn keep_page_running_when_hidden(app: &AppHandle) {
    set_main_inactive_policy(
        app,
        objc2_web_kit::WKInactiveSchedulingPolicy::Throttle,
        "throttle",
    );
}

/// Keeps the main WebView unthrottled during a Xiaoyang realtime voice call even when hidden or
/// occluded, then restores Throttle once the call ends.
pub fn set_voice_call_active(app: &AppHandle, active: bool) {
    static ACTIVE: AtomicBool = AtomicBool::new(false);
    if ACTIVE.swap(active, Ordering::SeqCst) == active {
        return;
    }
    #[cfg(target_os = "macos")]
    {
        let (policy, label) = if active {
            (objc2_web_kit::WKInactiveSchedulingPolicy::None, "none")
        } else {
            (
                objc2_web_kit::WKInactiveSchedulingPolicy::Throttle,
                "throttle",
            )
        };
        set_main_inactive_policy(app, policy, label);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn init(app: &AppHandle) {
    let _ = app_cell().set(app.clone());
    #[cfg(target_os = "macos")]
    {
        keep_page_running_when_hidden(app);
        apply_frame_rate_policy(app);
    }
    fit_on_start(app);
    apply_theme(app);
    sync_tray(app);
    sync_autostart(app);
    network::start(app);
    #[cfg(target_os = "macos")]
    watch_occlusion(app);
}

/// The main window may have been shown or hidden (window events; on macOS also every change
/// of what can be seen of it, which covers Cmd+H, the Dock, other windows and Spaces with or
/// without focus). Hidden: queued log lines go to the relay now (the upload task coalesces
/// repeated calls) and the browser panel rests. Shown: the page re-checks its relay link.
pub fn visibility_changed(app: &AppHandle) {
    let before = resources::window_visible();
    resources::refresh_visibility(app);
    let after = resources::window_visible();
    if before == after {
        return;
    }
    logging::debug(
        "app.window",
        if after {
            "window shown"
        } else {
            "window hidden"
        },
        Value::Null,
    );
    if after {
        wake(app, "shown");
    } else {
        crate::relaylog::upload_soon();
        crate::browser::on_main_hidden(app);
    }
}

/// macOS: AppKit's notifications for what can be seen of a window (occlusion), the app being
/// hidden or shown (Cmd+H, another app hiding it) and minimising, none of which needs focus.
/// On the main queue, for the app's life.
#[cfg(target_os = "macos")]
fn watch_occlusion(app: &AppHandle) {
    use objc2_app_kit::{
        NSApplicationDidHideNotification, NSApplicationDidUnhideNotification,
        NSWindowDidChangeOcclusionStateNotification, NSWindowDidDeminiaturizeNotification,
        NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification,
        NSWindowDidMiniaturizeNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue};
    use std::ptr::NonNull;
    let app = app.clone();
    let app_fs = app.clone();
    let block = block2::RcBlock::new(move |_n: NonNull<NSNotification>| visibility_changed(&app));
    let fs_block =
        block2::RcBlock::new(move |_n: NonNull<NSNotification>| sync_traffic_light_metrics(&app_fs));
    let center = NSNotificationCenter::defaultCenter();
    let queue = NSOperationQueue::mainQueue();
    // SAFETY: AppKit's constants; the block runs on the main queue it is given.
    let names = unsafe {
        [
            NSWindowDidChangeOcclusionStateNotification,
            NSApplicationDidHideNotification,
            NSApplicationDidUnhideNotification,
            NSWindowDidMiniaturizeNotification,
            NSWindowDidDeminiaturizeNotification,
        ]
    };
    for name in names {
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                None,
                Some(&queue),
                &block,
            )
        };
        // Never removed: the observers live as long as the app.
        std::mem::forget(observer);
    }
    let fs_names = unsafe {
        [
            NSWindowDidEnterFullScreenNotification,
            NSWindowDidExitFullScreenNotification,
        ]
    };
    for name in fs_names {
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                None,
                Some(&queue),
                &fs_block,
            )
        };
        std::mem::forget(observer);
    }
}

/// config.json changed.
pub fn config_changed(app: &AppHandle) {
    apply_theme(app);
    #[cfg(target_os = "macos")]
    apply_frame_rate_policy(app);
    sync_tray(app);
    sync_autostart(app);
}

pub fn close_to_tray() -> bool {
    config::native().close_to_tray
}

fn sync_tray(app: &AppHandle) {
    let want = close_to_tray();
    let have = app.tray_by_id(TRAY_ID).is_some();
    if want && !have {
        match build_tray(app) {
            Ok(()) => logging::info("app.tray", "tray icon added", Value::Null),
            Err(e) => logging::warn(
                "app.tray",
                "tray icon failed",
                json!({ "error": e.to_string() }),
            ),
        }
    } else if !want && have {
        let _ = app.remove_tray_by_id(TRAY_ID);
        logging::info("app.tray", "tray icon removed", Value::Null);
        // Nothing left to bring the window back from: show it.
        if app
            .get_window("main")
            .is_some_and(|w| !w.is_visible().unwrap_or(true))
        {
            show_main(app, "tray off");
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let show = MenuItem::with_id(app, "tray-show", "显示 Herdr Pocket", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出 Herdr Pocket", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut b = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Herdr Pocket")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "tray-show" => show_main(app, "tray menu"),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                show_main(tray.app_handle(), "tray click");
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

/// The window's close button with `general.closeToTray`: hide instead of quitting. Hidden, the
/// app keeps the same energy rules as a minimised window (resources::window_visible is false).
pub fn hide_to_tray(app: &AppHandle) {
    flush_window_state(app);
    if let Some(w) = app.get_window("main") {
        let _ = w.hide();
    }
    resources::refresh_visibility(app);
    crate::relaylog::upload_soon();
    logging::info("app.window", "window closed to the tray", Value::Null);
}

pub fn show_main(app: &AppHandle, why: &str) {
    if let Some(w) = app.get_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    resources::refresh_visibility(app);
    sync_traffic_light_metrics(app);
    logging::debug("app.window", "window shown", json!({ "why": why }));
    wake(app, "shown");
}

fn sync_autostart(app: &AppHandle) {
    let n = config::native();
    // Only a value in the file counts: a login item someone made in System Settings stays.
    if !n.launch_at_login_set {
        return;
    }
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    match al.is_enabled() {
        Ok(on) if on == n.launch_at_login => {}
        Ok(_) => {
            let r = if n.launch_at_login {
                al.enable()
            } else {
                al.disable()
            };
            match r {
                Ok(()) => logging::info(
                    "app.autostart",
                    "launch at login changed",
                    json!({ "on": n.launch_at_login }),
                ),
                Err(e) => logging::warn(
                    "app.autostart",
                    "launch at login failed",
                    json!({ "on": n.launch_at_login, "error": e.to_string() }),
                ),
            }
        }
        Err(e) => logging::warn(
            "app.autostart",
            "launch at login unknown",
            json!({ "error": e.to_string() }),
        ),
    }
}

// ---------------------------------------------------------------------------
// Wake
// ---------------------------------------------------------------------------

/// Tells the page to check its relay link now. Focus wakes at most every 2 s.
pub fn wake(app: &AppHandle, reason: &str) {
    static LAST_FOCUS: Mutex<Option<Instant>> = Mutex::new(None);
    if reason == "focus" {
        let Ok(mut last) = LAST_FOCUS.lock() else {
            return;
        };
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(2)) {
            return;
        }
        *last = Some(Instant::now());
    }
    let _ = app.emit_to("main", WAKE_EVENT, json!({ "reason": reason }));
}

/// A network change: wakes once the changes settle (they come in bursts).
fn network_changed(online: Option<bool>) {
    static PENDING: AtomicBool = AtomicBool::new(false);
    static ONLINE: Mutex<Option<bool>> = Mutex::new(None);
    if let Ok(mut o) = ONLINE.lock() {
        *o = online;
    }
    if PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(app) = app_cell().get().cloned() else {
        PENDING.store(false, Ordering::SeqCst);
        return;
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        PENDING.store(false, Ordering::SeqCst);
        let online = ONLINE.lock().ok().and_then(|o| *o);
        logging::debug(
            "app.network",
            "network changed",
            json!({ "online": online }),
        );
        let _ = app.emit_to(
            "main",
            WAKE_EVENT,
            json!({ "reason": "network", "online": online }),
        );
    });
}

mod network {
    use tauri::AppHandle;

    /// macOS: Network.framework's path monitor (no polling; called on any interface change).
    #[cfg(target_os = "macos")]
    pub fn start(_app: &AppHandle) {
        use std::ffi::c_void;
        use std::sync::atomic::{AtomicBool, Ordering};

        #[link(name = "Network", kind = "framework")]
        extern "C" {
            fn nw_path_monitor_create() -> *mut c_void;
            fn nw_path_monitor_set_update_handler(
                monitor: *mut c_void,
                handler: &block2::Block<dyn Fn(*mut c_void)>,
            );
            fn nw_path_monitor_set_queue(monitor: *mut c_void, queue: *mut c_void);
            fn nw_path_monitor_start(monitor: *mut c_void);
            fn nw_path_get_status(path: *mut c_void) -> i32;
        }
        extern "C" {
            fn dispatch_queue_create(
                label: *const std::ffi::c_char,
                attr: *const c_void,
            ) -> *mut c_void;
        }
        static STARTED: AtomicBool = AtomicBool::new(false);
        if STARTED.swap(true, Ordering::SeqCst) {
            return;
        }
        let first = AtomicBool::new(true);
        let handler = block2::RcBlock::new(move |path: *mut c_void| {
            // The first call reports the network as it is at start: not a change.
            if first.swap(false, Ordering::SeqCst) {
                return;
            }
            // nw_path_status_satisfied = 1.
            let online = (!path.is_null()).then(|| unsafe { nw_path_get_status(path) } == 1);
            super::network_changed(online);
        });
        unsafe {
            let monitor = nw_path_monitor_create();
            if monitor.is_null() {
                return;
            }
            let queue = dispatch_queue_create(c"pocket-network".as_ptr(), std::ptr::null());
            // The monitor copies the block; it and the queue live as long as the app.
            nw_path_monitor_set_update_handler(monitor, &handler);
            nw_path_monitor_set_queue(monitor, queue);
            nw_path_monitor_start(monitor);
        }
    }

    /// Windows: IP Helper's interface change notification (a thread-pool callback).
    #[cfg(windows)]
    pub fn start(_app: &AppHandle) {
        use std::ffi::c_void;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::NetworkManagement::IpHelper::{
            NotifyIpInterfaceChange, MIB_IPINTERFACE_ROW, MIB_NOTIFICATION_TYPE,
        };
        use windows_sys::Win32::Networking::WinSock::AF_UNSPEC;

        unsafe extern "system" fn changed(
            _ctx: *const c_void,
            _row: *const MIB_IPINTERFACE_ROW,
            _kind: MIB_NOTIFICATION_TYPE,
        ) {
            super::network_changed(None);
        }
        let mut handle: HANDLE = std::ptr::null_mut();
        // The handle is kept for the life of the app (never cancelled).
        let rc = unsafe {
            NotifyIpInterfaceChange(
                AF_UNSPEC,
                Some(changed),
                std::ptr::null(),
                false,
                &mut handle,
            )
        };
        if rc != 0 {
            crate::logging::warn(
                "app.network",
                "network change watch failed",
                serde_json::json!({ "error": rc }),
            );
        }
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    pub fn start(_app: &AppHandle) {}
}

#[cfg(test)]
mod tests {
    use super::{
        compute_traffic_light_safe_zone, fit, resolve_restored_window_state, MonitorWorkArea,
        SavedWindowState,
    };

    #[test]
    fn computes_traffic_light_safe_zone_for_macos_versions_and_fullscreen() {
        // macOS Sequoia: zoom right ~64pt -> 76 -> clamped >= 80pt
        assert_eq!(compute_traffic_light_safe_zone(false, 64.0, 26.0), (80.0, 36.0));
        // macOS Tahoe Liquid Glass: zoom right ~74.5pt -> ceil(86.5) = 87pt
        assert_eq!(compute_traffic_light_safe_zone(false, 74.5, 27.5), (87.0, 38.0));
        // Even wider buttons stay padded by 12pt up to 128pt cap
        assert_eq!(compute_traffic_light_safe_zone(false, 90.0, 29.0), (102.0, 39.0));
        // Fullscreen hides traffic lights so title bar reclaims left inset and top safe area
        assert_eq!(compute_traffic_light_safe_zone(true, 74.5, 27.5), (14.0, 0.0));
    }

    #[test]
    fn fits_small_windows_screens() {
        // 1366x768 at 125% with a 48 px taskbar: about 1093 x 566 logical, title bar ~32.
        let ((w, h), (_, min_h)) = fit((1180.0, 780.0), (1093.0, 566.0), (0.0, 32.0));
        assert!(w <= 1093.0 - 2.0 * 12.0 && h <= 566.0 - 32.0 - 12.0);
        assert!(min_h <= h, "the minimum never exceeds what fits");
        assert!(h >= 480.0 || h == 566.0 - 32.0);
    }

    #[test]
    fn leaves_large_screens_alone() {
        let ((w, h), (min_w, min_h)) = fit((1180.0, 780.0), (1728.0, 1080.0), (0.0, 28.0));
        assert_eq!((w, h), (1180.0, 780.0));
        assert_eq!((min_w, min_h), (420.0, 640.0));
    }

    #[test]
    fn tiny_screens_still_get_the_whole_area() {
        let ((_, h), (_, min_h)) = fit((1180.0, 780.0), (800.0, 450.0), (0.0, 30.0));
        assert_eq!(h, 420.0);
        assert_eq!(min_h, 420.0);
    }

    #[test]
    fn resolve_restored_preserves_secondary_monitor_and_rejects_unplugged() {
        let laptop = MonitorWorkArea {
            x: 0.0,
            y: 38.0,
            width: 1728.0,
            height: 1079.0,
            deco_w: 0.0,
            deco_h: 0.0,
        };
        let external = MonitorWorkArea {
            x: 1728.0,
            y: -320.0,
            width: 3440.0,
            height: 1415.0,
            deco_w: 0.0,
            deco_h: 0.0,
        };
        let saved = SavedWindowState {
            x: 1800.0,
            y: -280.0,
            width: 2400.0,
            height: 1200.0,
            maximized: true,
            fullscreen: false,
        };
        let restored = resolve_restored_window_state(&saved, &[laptop, external]).unwrap();
        assert_eq!(restored, saved);

        // External unplugged: should return None so fit_on_start centers on laptop.
        assert_eq!(resolve_restored_window_state(&saved, &[laptop]), None);
    }

    #[test]
    fn resolve_restored_keeps_titlebar_below_menu_bar() {
        let laptop = MonitorWorkArea {
            x: 0.0,
            y: 25.0,
            width: 1728.0,
            height: 1092.0,
            deco_w: 0.0,
            deco_h: 0.0,
        };
        let saved = SavedWindowState {
            x: 100.0,
            y: -12.0,
            width: 1200.0,
            height: 800.0,
            maximized: false,
            fullscreen: false,
        };
        let restored = resolve_restored_window_state(&saved, &[laptop]).unwrap();
        assert_eq!(restored.y, 25.0);
        assert_eq!(restored.x, 100.0);
    }
}
