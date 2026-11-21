//! Permission states for voice input and the system pages that change them.
//!
//! macOS: Microphone (recording), Accessibility (pasting into other apps),
//! Input Monitoring (watching a modifier-only hotkey such as right Option).
//! Windows: the microphone privacy switches; there is nothing to grant for
//! keyboard hooks or SendInput, but neither reaches apps running as
//! administrator while this app is not.

use crate::logging;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
// Each OS produces only some of these (the UI handles all of them).
#[allow(dead_code)]
pub enum State {
    Granted,
    Denied,
    /// Never asked: requesting shows the system prompt.
    NotDetermined,
    /// Blocked by policy (MDM, parental controls, or the device-wide switch on Windows).
    Restricted,
    /// This OS has no such permission.
    NotApplicable,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub platform: &'static str,
    pub microphone: State,
    pub accessibility: State,
    pub input_monitoring: State,
    pub full_disk_access: State,
    /// macOS: what the fn (globe) key does: `none`, `inputSource`, `emoji` or `dictation`
    /// (absent when the system never stored a choice, and on other systems).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fn_key_action: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_bundle_path: Option<String>,
    /// Chinese hints for the settings screen.
    pub notes: Vec<String>,
}

pub const KINDS: [&str; 3] = ["microphone", "accessibility", "inputMonitoring"];

/// Walks `exe` ancestors for the enclosing `.app` bundle (preferring the outermost `.app` in dev/helper layouts).
pub fn app_bundle_from_exe(exe: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut found: Option<std::path::PathBuf> = None;
    for p in exe.ancestors() {
        let is_app = p
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("app"));
        if is_app {
            found = Some(p.to_path_buf());
        }
    }
    found
}

/// Resolves the running macOS `.app` bundle, falling back to `/Applications/Herdr Pocket.app` when running unpackaged in dev.
pub fn current_app_bundle() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(app) = app_bundle_from_exe(&exe) {
                return Some(app);
            }
            if let Ok(canon) = std::fs::canonicalize(&exe) {
                if let Some(app) = app_bundle_from_exe(&canon) {
                    return Some(app);
                }
            }
        }
        let installed = std::path::PathBuf::from("/Applications/Herdr Pocket.app");
        if installed.exists() {
            return Some(installed);
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::State;
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::{CFString, CFStringRef};
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, Bool};
    use objc2_foundation::NSString;
    use std::time::Duration;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(
            options: core_foundation::dictionary::CFDictionaryRef,
        ) -> bool;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOHIDCheckAccess(request: u32) -> u32;
        fn IOHIDRequestAccess(request: u32) -> bool;
    }

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVMediaTypeAudio: &'static NSString;
    }

    const LISTEN_EVENT: u32 = 1; // kIOHIDRequestTypeListenEvent

    fn capture_class() -> Option<&'static AnyClass> {
        AnyClass::get(c"AVCaptureDevice")
    }

    pub fn microphone() -> State {
        let Some(cls) = capture_class() else {
            return State::Unknown;
        };
        // AVAuthorizationStatus: 0 not determined, 1 restricted, 2 denied, 3 authorized.
        let status: isize =
            unsafe { msg_send![cls, authorizationStatusForMediaType: AVMediaTypeAudio] };
        match status {
            0 => State::NotDetermined,
            1 => State::Restricted,
            2 => State::Denied,
            3 => State::Granted,
            _ => State::Unknown,
        }
    }

    /// Shows the system prompt the first time; afterwards answers at once.
    pub fn request_microphone() -> State {
        if microphone() != State::NotDetermined {
            return microphone();
        }
        let Some(cls) = capture_class() else {
            return State::Unknown;
        };
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let block = block2::RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        unsafe {
            let _: () = msg_send![cls, requestAccessForMediaType: AVMediaTypeAudio, completionHandler: &*block];
        }
        // The person may take a while to answer the prompt.
        match rx.recv_timeout(Duration::from_secs(120)) {
            Ok(true) => State::Granted,
            Ok(false) => State::Denied,
            Err(_) => microphone(),
        }
    }

    pub fn accessibility() -> State {
        if unsafe { AXIsProcessTrusted() } {
            State::Granted
        } else {
            // macOS does not tell "never asked" from "turned off".
            State::Denied
        }
    }

    /// Shows the system dialog that leads to Settings → Accessibility.
    pub fn request_accessibility() -> State {
        let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let dict = CFDictionary::from_CFType_pairs(&[(
            key.as_CFType(),
            CFBoolean::true_value().as_CFType(),
        )]);
        if unsafe { AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef()) } {
            State::Granted
        } else {
            State::Denied
        }
    }

    pub fn input_monitoring() -> State {
        // IOHIDAccessType: 0 granted, 1 denied, 2 unknown (never asked).
        match unsafe { IOHIDCheckAccess(LISTEN_EVENT) } {
            0 => State::Granted,
            1 => State::Denied,
            2 => State::NotDetermined,
            _ => State::Unknown,
        }
    }

    pub fn request_input_monitoring() -> State {
        if unsafe { IOHIDRequestAccess(LISTEN_EVENT) } {
            State::Granted
        } else {
            input_monitoring()
        }
    }

    pub fn full_disk_access() -> State {
        let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) else {
            return State::Unknown;
        };
        let home = std::path::PathBuf::from(home);
        let probes = [
            home.join("Library/Safari"),
            home.join("Library/Application Support/com.apple.TCC"),
        ];
        let mut saw_denied = false;
        for p in &probes {
            match std::fs::read_dir(p) {
                Ok(_) => return State::Granted,
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    saw_denied = true;
                }
                Err(_) => {}
            }
        }
        if saw_denied {
            State::Denied
        } else {
            State::Unknown
        }
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFPreferencesCopyAppValue(
            key: CFStringRef,
            application: CFStringRef,
        ) -> core_foundation::base::CFTypeRef;
    }

    /// Settings → Keyboard → "Press globe key to", stored as `AppleFnUsageType` in com.apple.HIToolbox.
    pub fn fn_key_action() -> Option<&'static str> {
        use core_foundation::base::CFType;
        use core_foundation::number::CFNumber;
        let key = CFString::from_static_string("AppleFnUsageType");
        let domain = CFString::from_static_string("com.apple.HIToolbox");
        let raw = unsafe {
            CFPreferencesCopyAppValue(key.as_concrete_TypeRef(), domain.as_concrete_TypeRef())
        };
        if raw.is_null() {
            return None;
        }
        let value = unsafe { CFType::wrap_under_create_rule(raw) };
        match value.downcast::<CFNumber>()?.to_i64()? {
            0 => Some("none"),
            1 => Some("inputSource"),
            2 => Some("emoji"),
            3 => Some("dictation"),
            _ => None,
        }
    }
}

/// What the fn (globe) key does on macOS; None elsewhere or when unknown.
pub fn fn_key_action() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        mac::fn_key_action()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[cfg(windows)]
mod win {
    use super::State;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    };

    const BASE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn read(root: HKEY, sub: &str) -> Option<String> {
        let sub = wide(sub);
        let name = wide("Value");
        let mut buf = [0u16; 32];
        let mut len = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegGetValueW(
                root,
                sub.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut len,
            )
        };
        if rc != 0 {
            return None;
        }
        let n = (len as usize / 2).saturating_sub(1).min(buf.len());
        Some(String::from_utf16_lossy(&buf[..n]))
    }

    /// The device switch (HKLM), "let apps use the microphone" (HKCU) and "let desktop apps" (NonPackaged).
    pub fn microphone() -> State {
        if read(HKEY_LOCAL_MACHINE, BASE).as_deref() == Some("Deny") {
            return State::Restricted;
        }
        if read(HKEY_CURRENT_USER, BASE).as_deref() == Some("Deny") {
            return State::Denied;
        }
        if read(HKEY_CURRENT_USER, &format!(r"{BASE}\NonPackaged")).as_deref() == Some("Deny") {
            return State::Denied;
        }
        State::Granted
    }
}

pub fn status() -> Status {
    #[cfg(target_os = "macos")]
    {
        Status {
            platform: "macos",
            microphone: mac::microphone(),
            accessibility: mac::accessibility(),
            input_monitoring: mac::input_monitoring(),
            full_disk_access: mac::full_disk_access(),
            fn_key_action: mac::fn_key_action(),
            app_bundle_path: current_app_bundle().map(|p| p.to_string_lossy().into_owned()),
            notes: vec![
                "麦克风：录音时需要。".into(),
                "辅助功能：把识别出的文字粘贴到正在使用的应用时需要。".into(),
                "输入监控：只用一个修饰键（如右 Option、Fn）做快捷键时需要。".into(),
                "若在系统设置里找不到开关，或开启后仍未生效，可直接把引导弹窗内的应用图标拖入系统设置列表。".into(),
            ],
        }
    }
    #[cfg(windows)]
    {
        Status {
            platform: "windows",
            microphone: win::microphone(),
            accessibility: State::NotApplicable,
            input_monitoring: State::NotApplicable,
            full_disk_access: State::NotApplicable,
            fn_key_action: None,
            app_bundle_path: None,
            notes: vec![
                "麦克风：在 设置 → 隐私和安全性 → 麦克风 里打开「允许应用访问麦克风」和「允许桌面应用访问麦克风」。".into(),
                "以管理员身份运行的窗口（例如管理员终端）收不到快捷键和粘贴，这是 Windows 的安全限制；识别结果会留在剪贴板里。".into(),
            ],
        }
    }
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        Status {
            platform: "linux",
            microphone: State::Unknown,
            accessibility: State::NotApplicable,
            input_monitoring: State::NotApplicable,
            full_disk_access: State::NotApplicable,
            fn_key_action: None,
            app_bundle_path: None,
            notes: vec!["Linux 版暂不支持全局语音输入。".into()],
        }
    }
}

/// Asks for `kind` (showing the system prompt where there is one) and returns the new status.
/// Blocking: call from an async command.
pub fn request(kind: &str) -> Result<Status, String> {
    let before = status();
    match kind {
        #[cfg(target_os = "macos")]
        "microphone" => {
            mac::request_microphone();
        }
        #[cfg(target_os = "macos")]
        "accessibility" => {
            mac::request_accessibility();
        }
        #[cfg(target_os = "macos")]
        "inputMonitoring" => {
            mac::request_input_monitoring();
        }
        k if KINDS.contains(&k) => {
            // Nothing to ask on this OS: the settings page is the only way.
            open_settings(k)?;
        }
        _ => return Err(format!("未知的权限：{kind}")),
    }
    let after = status();
    logging::info(
        "perm",
        format!("permission {kind} requested"),
        json!({ "before": state_of(&before, kind), "after": state_of(&after, kind) }),
    );
    Ok(after)
}

fn state_of(s: &Status, kind: &str) -> State {
    match kind {
        "microphone" => s.microphone,
        "accessibility" => s.accessibility,
        _ => s.input_monitoring,
    }
}

/// The exact system settings page for `kind`.
pub fn settings_url(kind: &str) -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        match kind {
            "microphone" => {
                Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            }
            "accessibility" => Some(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            ),
            "inputMonitoring" => {
                Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
            }
            "keyboard" => Some("x-apple.systempreferences:com.apple.Keyboard-Settings.extension"),
            // Safari keeps its cookies where only Full Disk Access reaches.
            "fullDiskAccess" => {
                Some("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
            }
            _ => None,
        }
    } else if cfg!(windows) {
        match kind {
            "microphone" => Some("ms-settings:privacy-microphone"),
            "keyboard" => Some("ms-settings:typing"),
            _ => None,
        }
    } else {
        None
    }
}

pub fn open_settings(kind: &str) -> Result<(), String> {
    open_settings_and_register(kind, false)
}

pub fn open_settings_and_register(kind: &str, register: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::sync::atomic::{AtomicBool, Ordering};
        static PROMPTED_AX: AtomicBool = AtomicBool::new(false);

        if register {
            match kind {
                "accessibility" => {
                    if mac::accessibility() != State::Granted && !PROMPTED_AX.swap(true, Ordering::Relaxed) {
                        mac::request_accessibility();
                    }
                }
                "inputMonitoring" => {
                    if mac::input_monitoring() == State::NotDetermined {
                        mac::request_input_monitoring();
                    }
                }
                "microphone" => {
                    if mac::microphone() == State::NotDetermined && mac::request_microphone() == State::Granted {
                        return Ok(());
                    }
                }
                _ => {}
            }
        }

        let url = settings_url(kind).ok_or_else(|| "这台电脑的系统没有对应的设置页".to_string())?;
        logging::info(
            "perm",
            format!("open settings for {kind}"),
            json!({ "register": register }),
        );
        let status = std::process::Command::new("/usr/bin/open")
            .arg(url)
            .status()
            .map_err(|e| format!("无法打开系统设置：{e}"))?;
        if status.success() {
            return Ok(());
        }
        if kind == "keyboard" {
            let fallback = "x-apple.systempreferences:com.apple.preference.keyboard";
            if std::process::Command::new("/usr/bin/open")
                .arg(fallback)
                .status()
                .is_ok_and(|s| s.success())
            {
                return Ok(());
            }
        }
        return Err("无法跳转到系统设置页面，请手动打开「系统设置」检查".into());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = register;
        let url = settings_url(kind).ok_or_else(|| "这台电脑的系统没有对应的设置页".to_string())?;
        logging::info("perm", format!("open settings for {kind}"), Value::Null);
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| format!("无法打开系统设置：{e}"))
    }
}

/// Reveals the current `.app` bundle in Finder (macOS) or Explorer (Windows) so the user can also drag it manually.
pub fn reveal_app_bundle() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let bundle = current_app_bundle().ok_or_else(|| "未找到 Herdr Pocket.app 应用包".to_string())?;
        let status = std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(&bundle)
            .status()
            .map_err(|e| format!("无法打开 Finder：{e}"))?;
        if !status.success() {
            return Err("无法在 Finder 中显示 Herdr Pocket.app".into());
        }
        return Ok(bundle.to_string_lossy().into_owned());
    }
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| format!("定位程序失败：{e}"))?;
        let arg = format!("/select,{}", exe.to_string_lossy());
        let _ = std::process::Command::new("explorer.exe").arg(arg).spawn();
        return Ok(exe.to_string_lossy().into_owned());
    }
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        Err("当前系统不支持定位应用包".into())
    }
}

#[cfg(target_os = "macos")]
mod mac_drag {
    use super::current_app_bundle;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource,
        NSEvent, NSEventModifierFlags, NSEventType, NSWindow, NSWorkspace,
    };
    use objc2_foundation::{
        NSArray, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL,
    };
    use std::cell::RefCell;
    use std::time::Duration;
    use tauri::Manager;

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        struct PocketAppDragSource;

        unsafe impl NSObjectProtocol for PocketAppDragSource {}

        unsafe impl NSDraggingSource for PocketAppDragSource {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn __source_operation_mask(
                &self,
                _session: &NSDraggingSession,
                context: NSDraggingContext,
            ) -> NSDragOperation {
                if context == NSDraggingContext::OutsideApplication {
                    NSDragOperation::Copy | NSDragOperation::Link | NSDragOperation::Generic
                } else {
                    NSDragOperation::None
                }
            }
        }
    );

    impl PocketAppDragSource {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = mtm.alloc::<Self>().set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    thread_local! {
        static ACTIVE_DRAG: RefCell<Option<(Retained<PocketAppDragSource>, Retained<NSDraggingSession>)>> = const { RefCell::new(None) };
    }

    pub fn start_app_bundle_drag(app: &tauri::AppHandle) -> Result<bool, String> {
        let bundle = current_app_bundle().ok_or_else(|| "未找到 Herdr Pocket.app 应用包".to_string())?;
        let bundle_str = bundle.to_string_lossy().into_owned();
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<bool, String>>(1);
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let res = (|| -> Result<bool, String> {
                if (NSEvent::pressedMouseButtons() & 1) == 0 {
                    return Ok(false);
                }
                let mtm = MainThreadMarker::new().ok_or("必须在主线程发起拖拽")?;
                let win = handle
                    .get_webview_window("main")
                    .ok_or("未找到主窗口")?;
                let ns_ptr = win
                    .ns_window()
                    .map_err(|e| format!("获取窗口句柄失败：{e}"))?;
                if ns_ptr.is_null() {
                    return Err("主窗口尚未就绪".into());
                }
                let ns_win = unsafe { &*(ns_ptr as *const NSWindow) };
                let content_view = ns_win.contentView().ok_or("窗口视图尚未就绪")?;
                let ns_path = NSString::from_str(&bundle_str);
                let file_url = NSURL::fileURLWithPath(&ns_path);
                let drag_item = NSDraggingItem::initWithPasteboardWriter(
                    mtm.alloc(),
                    ProtocolObject::from_ref(&*file_url),
                );
                let icon = NSWorkspace::sharedWorkspace().iconForFile(&ns_path);
                icon.setSize(NSSize::new(56.0, 56.0));
                let win_loc = ns_win.mouseLocationOutsideOfEventStream();
                let view_loc = content_view.convertPoint_fromView(win_loc, None);
                let frame = NSRect::new(
                    NSPoint::new(view_loc.x - 28.0, view_loc.y - 28.0),
                    NSSize::new(56.0, 56.0),
                );
                unsafe {
                    drag_item.setDraggingFrame_contents(frame, Some(icon.as_ref()));
                }
                let drag_event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                    NSEventType::LeftMouseDragged,
                    win_loc,
                    NSEventModifierFlags::empty(),
                    0.0,
                    ns_win.windowNumber(),
                    None,
                    0,
                    1,
                    1.0,
                )
                .ok_or("无法构造拖拽鼠标事件")?;
                let source = PocketAppDragSource::new(mtm);
                let items = NSArray::from_retained_slice(&[drag_item]);
                let session = content_view.beginDraggingSessionWithItems_event_source(
                    &items,
                    &drag_event,
                    ProtocolObject::from_ref(&*source),
                );
                ACTIVE_DRAG.with(|slot| {
                    *slot.borrow_mut() = Some((source, session));
                });
                Ok(true)
            })();
            let _ = tx.send(res);
        })
        .map_err(|e| format!("调度主线程拖拽失败：{e}"))?;

        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|_| "启动拖拽超时".to_string())?
    }
}

pub fn start_app_bundle_drag(app: &tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        mac_drag::start_app_bundle_drag(app)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(false)
    }
}

pub fn snapshot_value() -> Value {
    serde_json::to_value(status()).unwrap_or(Value::Null)
}

fn states_value(s: &Status) -> Value {
    json!({ "microphone": s.microphone, "accessibility": s.accessibility, "inputMonitoring": s.input_monitoring, "fullDiskAccess": s.full_disk_access, "fnKey": s.fn_key_action })
}

#[cfg(test)]
mod tests {
    use super::{app_bundle_from_exe, settings_url};
    use std::path::{Path, PathBuf};

    #[test]
    fn app_bundle_resolution_prefers_outermost_app_bundle() {
        assert_eq!(
            app_bundle_from_exe(Path::new(
                "/Applications/Herdr Pocket.app/Contents/MacOS/herdr-pocket-desktop"
            )),
            Some(PathBuf::from("/Applications/Herdr Pocket.app"))
        );
        assert_eq!(
            app_bundle_from_exe(Path::new("/usr/local/bin/herdr-pocket-desktop")),
            None
        );
    }

    #[test]
    fn settings_url_covers_all_supported_permission_kinds() {
        if cfg!(target_os = "macos") {
            for k in ["microphone", "accessibility", "inputMonitoring", "keyboard", "fullDiskAccess"] {
                assert!(settings_url(k).is_some(), "missing macOS URL for {k}");
            }
        }
        assert!(settings_url("nonexistent").is_none());
    }
}

fn last_states() -> &'static std::sync::Mutex<Option<Value>> {
    static LAST: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);
    &LAST
}

/// Logs permission states at startup.
pub fn log_states(reason: &str) {
    let now = states_value(&status());
    logging::info("perm", format!("permissions ({reason})"), now.clone());
    if let Ok(mut last) = last_states().lock() {
        *last = Some(now);
    }
}

/// After a status poll: logs what changed since the last look. True when something did.
pub fn note_change(s: &Status) -> bool {
    let now = states_value(s);
    let Ok(mut last) = last_states().lock() else {
        return false;
    };
    if last.as_ref() == Some(&now) {
        return false;
    }
    logging::info(
        "perm",
        "permissions changed",
        json!({ "before": last.clone(), "after": now.clone() }),
    );
    *last = Some(now);
    true
}
