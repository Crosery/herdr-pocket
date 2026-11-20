//! The main window: where it opens, its title bar theme, closing to the tray, launching at
//! login, and "wake" events telling the page to re-check its relay link right away.
//!
//! Wake events matter because the page reconnects with timers: when the window is hidden or
//! covered, WebKit/WebView2 slow those timers down, and a changed network often kills the
//! WebSocket without the page noticing for a long time.

use crate::{config, logging, resources};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Theme};

/// To the main window: `{ reason: "focus" | "shown" | "network" }`. The page should check
/// its relay link now (reconnect at once if it is down) instead of waiting for its backoff.
pub const WAKE_EVENT: &str = "app://wake";
const TRAY_ID: &str = "pocket-tray";
/// tauri.conf.json's minimum; lowered on screens where it does not fit.
const MIN_W: f64 = 420.0;
const MIN_H: f64 = 640.0;
/// Smallest height the UI is ever given (1366x768 at 125% with a taskbar leaves about 530).
const FLOOR_H: f64 = 480.0;
const MARGIN: f64 = 12.0;

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

/// First thing at start: the window fits the work area of its screen (taskbar and Dock
/// excluded) and sits in its middle.
pub fn fit_on_start(app: &AppHandle) {
    let Some(w) = app.get_window("main") else {
        return;
    };
    let Some(m) = w
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| w.primary_monitor().ok().flatten())
    else {
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
    let (Ok(inner), Ok(outer)) = (w.inner_size(), w.outer_size()) else {
        return;
    };
    let inner = inner.to_logical::<f64>(scale);
    let outer = outer.to_logical::<f64>(scale);
    let deco = (
        (outer.width - inner.width).max(0.0),
        (outer.height - inner.height).max(0.0),
    );
    let (size, min) = fit((inner.width, inner.height), (aw, ah), deco);
    let _ = w.set_min_size(Some(LogicalSize::new(min.0, min.1)));
    if size.0 < inner.width - 0.5 || size.1 < inner.height - 0.5 {
        let _ = w.set_size(LogicalSize::new(size.0, size.1));
    }
    let x = ax + ((aw - size.0 - deco.0) / 2.0).max(0.0);
    let y = ay + ((ah - size.1 - deco.1) / 2.0).max(0.0);
    let _ = w.set_position(LogicalPosition::new(x, y));
    logging::info(
        "app.window",
        "window placed",
        json!({ "workArea": [aw.round(), ah.round()], "scale": scale, "size": [size.0.round(), size.1.round()], "minHeight": min.1.round() }),
    );
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
    for label in ["main", "voice-hud"] {
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
fn keep_page_running_when_hidden(app: &AppHandle) {
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
    let _ = webview.with_webview(|pw| {
        let p = pw.inner();
        if p.is_null() {
            return;
        }
        // SAFETY: wry's WKWebView, on the main thread (with_webview runs there).
        let wk = unsafe { &*(p as *const objc2_web_kit::WKWebView) };
        let prefs = unsafe { wk.configuration().preferences() };
        unsafe {
            prefs.setInactiveSchedulingPolicy(objc2_web_kit::WKInactiveSchedulingPolicy::Throttle)
        };
        let now = unsafe { prefs.inactiveSchedulingPolicy() }.0;
        logging::info(
            "app.window",
            "hidden page scheduling set",
            json!({ "policy": if now == 1 { "throttle" } else { "unchanged" } }),
        );
    });
}

pub fn init(app: &AppHandle) {
    let _ = app_cell().set(app.clone());
    #[cfg(target_os = "macos")]
    keep_page_running_when_hidden(app);
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
        NSWindowDidMiniaturizeNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSOperationQueue};
    use std::ptr::NonNull;
    let app = app.clone();
    let block = block2::RcBlock::new(move |_n: NonNull<NSNotification>| visibility_changed(&app));
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
}

/// config.json changed.
pub fn config_changed(app: &AppHandle) {
    apply_theme(app);
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
    use super::fit;

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
}
