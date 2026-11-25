//! Permission states for voice input, screen capture, and the system pages that change them.
//!
//! macOS: Screen Recording (window portal capture), Microphone (recording),
//! Accessibility (pasting into other apps), Input Monitoring (watching a
//! modifier-only hotkey such as right Option).
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
    pub screen_recording: State,
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

pub const KINDS: [&str; 4] = [
    "microphone",
    "accessibility",
    "inputMonitoring",
    "screenRecording",
];

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
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
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
        if unsafe { AXIsProcessTrusted() } {
            return State::Granted;
        }
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
        // On macOS 14/15, CGPreflightListenEventAccess() can report true even when
        // IOHIDCheckAccess(LISTEN_EVENT) lags or disagrees, so accept either as Granted.
        let hid = unsafe { IOHIDCheckAccess(LISTEN_EVENT) };
        let cg = unsafe { CGPreflightListenEventAccess() };
        super::resolve_input_monitoring(hid, cg)
    }

    /// Registers the app in macOS System Settings → Privacy & Security → Input Monitoring
    /// using CoreGraphics (`CGRequestListenEventAccess`).
    pub fn request_input_monitoring() -> State {
        if input_monitoring() == State::Granted {
            return State::Granted;
        }
        if unsafe { CGRequestListenEventAccess() } {
            State::Granted
        } else {
            input_monitoring()
        }
    }

    pub fn screen_recording() -> State {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            State::Granted
        } else {
            State::Denied
        }
    }

    /// Registers the app in macOS System Settings → Privacy & Security → Screen Recording
    /// (`CGRequestScreenCaptureAccess`) without prompting if already granted.
    pub fn request_screen_recording() -> State {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            return State::Granted;
        }
        if unsafe { CGRequestScreenCaptureAccess() } {
            State::Granted
        } else {
            screen_recording()
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
            screen_recording: mac::screen_recording(),
            full_disk_access: mac::full_disk_access(),
            fn_key_action: mac::fn_key_action(),
            app_bundle_path: current_app_bundle().map(|p| p.to_string_lossy().into_owned()),
            notes: vec![
                "屏幕录制：跨端窗口回传与本机浮窗预览时需要。".into(),
                "麦克风：与小羊实时语音通话和录制声纹时需要。".into(),
                "输入监控：只用一个修饰键（如右 Option、Fn）做小羊唤醒快捷键时需要。".into(),
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
            screen_recording: State::NotApplicable,
            full_disk_access: State::NotApplicable,
            fn_key_action: None,
            app_bundle_path: None,
            notes: vec![
                "麦克风：在 设置 → 隐私和安全性 → 麦克风 里打开「允许应用访问麦克风」和「允许桌面应用访问麦克风」。".into(),
                "以管理员身份运行的窗口（例如管理员终端）在失焦状态下可能收不到全局唤醒快捷键，这是 Windows 的安全限制。".into(),
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
            screen_recording: State::NotApplicable,
            full_disk_access: State::NotApplicable,
            fn_key_action: None,
            app_bundle_path: None,
            notes: vec!["Linux 版暂不支持全局小羊唤醒快捷键。".into()],
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
        #[cfg(target_os = "macos")]
        "screenRecording" => {
            mac::request_screen_recording();
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

pub(crate) fn state_of(s: &Status, kind: &str) -> State {
    match kind {
        "microphone" => s.microphone,
        "accessibility" => s.accessibility,
        "inputMonitoring" => s.input_monitoring,
        "screenRecording" => s.screen_recording,
        "fullDiskAccess" => s.full_disk_access,
        _ => State::Unknown,
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
            "screenRecording" => {
                Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
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

#[cfg(target_os = "macos")]
static PROMPTED_AX: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(target_os = "macos")]
static PROMPTED_IM: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(target_os = "macos")]
static PROMPTED_SC: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Maps supported permission kinds to macOS `tccutil` service names (strict allowlist).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn mac_tcc_service(kind: &str) -> Option<&'static str> {
    match kind {
        "accessibility" => Some("Accessibility"),
        "inputMonitoring" => Some("ListenEvent"),
        "microphone" => Some("Microphone"),
        "screenRecording" => Some("ScreenCapture"),
        _ => None,
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn format_tccutil_error(
    service: &str,
    bundle_id: &str,
    code: Option<i32>,
    stderr: &str,
) -> String {
    let trimmed = stderr.trim();
    if trimmed.contains("-10814") || trimmed.contains("No such bundle identifier") {
        return format!(
            "系统尚未登记应用标识（{bundle_id}），无法自动重置 {service} 缓存；请从“应用程序”打开 Herdr Pocket.app 后重试，或点引导中的「在 Finder 中定位应用」手动移除后重新拖入"
        );
    }
    if trimmed.is_empty() {
        format!(
            "重置 {service} 权限缓存失败（退出码 {}）",
            code.map_or_else(|| "未知".into(), |c| c.to_string())
        )
    } else {
        format!("重置 {service} 权限缓存失败：{trimmed}")
    }
}

pub fn open_settings(kind: &str) -> Result<(), String> {
    open_settings_and_register(kind, false)
}

pub fn open_settings_and_register(kind: &str, register: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::sync::atomic::Ordering;

        if register {
            match kind {
                "accessibility" => {
                    if mac::accessibility() == State::Granted {
                        return Ok(());
                    }
                    if !PROMPTED_AX.swap(true, Ordering::Relaxed)
                        && mac::request_accessibility() == State::Granted
                    {
                        return Ok(());
                    }
                }
                "inputMonitoring" => {
                    if mac::input_monitoring() == State::Granted {
                        return Ok(());
                    }
                    if !PROMPTED_IM.swap(true, Ordering::Relaxed)
                        && mac::request_input_monitoring() == State::Granted
                    {
                        return Ok(());
                    }
                }
                "microphone" => {
                    if mac::microphone() == State::NotDetermined
                        && mac::request_microphone() == State::Granted
                    {
                        return Ok(());
                    }
                }
                "screenRecording" => {
                    if mac::screen_recording() == State::Granted {
                        return Ok(());
                    }
                    if !PROMPTED_SC.swap(true, Ordering::Relaxed)
                        && mac::request_screen_recording() == State::Granted
                    {
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

/// Resets this app's macOS TCC entry for `kind` via `/usr/bin/tccutil reset <Service> <bundle_id>`,
/// clears the per-session prompt guard, re-requests so macOS records the current binary signature,
/// and opens the corresponding System Settings pane if still ungranted.
pub fn reset_mac_permission(app: &tauri::AppHandle, kind: &str) -> Result<Status, String> {
    #[cfg(target_os = "macos")]
    {
        use std::sync::atomic::Ordering;
        let service = mac_tcc_service(kind)
            .ok_or_else(|| format!("不支持重置该权限缓存：{kind}"))?;
        let bundle_id = app.config().identifier.trim();
        if bundle_id.is_empty() {
            return Err("未找到应用标识符（bundle identifier）".into());
        }
        logging::info(
            "perm",
            format!("resetting macOS TCC permission for {kind}"),
            json!({ "service": service, "bundleId": bundle_id }),
        );
        let output = std::process::Command::new("/usr/bin/tccutil")
            .args(["reset", service, bundle_id])
            .output()
            .map_err(|e| format!("无法执行 tccutil 重置权限：{e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let msg = format_tccutil_error(service, bundle_id, output.status.code(), &stderr);
            logging::warn(
                "perm",
                format!("tccutil reset failed for {kind}"),
                json!({ "service": service, "code": output.status.code(), "error": msg }),
            );
            return Err(msg);
        }

        match kind {
            "accessibility" => PROMPTED_AX.store(false, Ordering::Relaxed),
            "inputMonitoring" => PROMPTED_IM.store(false, Ordering::Relaxed),
            "screenRecording" => PROMPTED_SC.store(false, Ordering::Relaxed),
            _ => {}
        }

        let after = request(kind)?;
        if state_of(&after, kind) != State::Granted {
            open_settings(kind)?;
        }
        Ok(after)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, kind);
        Err("仅 macOS 支持重置系统权限缓存".into())
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
        NSApplication, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession,
        NSDraggingSource, NSEvent, NSEventModifierFlags, NSEventType, NSPasteboardItem,
        NSPasteboardTypeFileURL, NSWindow, NSWorkspace,
    };
    use objc2_foundation::{
        NSArray, NSObject, NSObjectProtocol, NSPoint, NSProcessInfo, NSRect, NSSize, NSString,
        NSURL,
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

    fn run_drag_on_main(
        mtm: MainThreadMarker,
        handle: &tauri::AppHandle,
        bundle_str: &str,
        preferred: Option<&str>,
    ) -> Result<bool, String> {
        if (NSEvent::pressedMouseButtons() & 1) == 0 {
            return Ok(false);
        }
        let win = preferred
            .and_then(|label| handle.get_webview_window(label))
            .or_else(|| {
                handle
                    .get_webview_window("perm-companion")
                    .filter(|w| w.is_visible().unwrap_or(false))
            })
            .or_else(|| handle.get_webview_window("main"))
            .ok_or("未找到拖拽来源窗口")?;
        let ns_ptr = win
            .ns_window()
            .map_err(|e| format!("获取窗口句柄失败：{e}"))?;
        if ns_ptr.is_null() {
            return Err("窗口尚未就绪".into());
        }
        let ns_win = unsafe { &*(ns_ptr as *const NSWindow) };
        let content_view = ns_win.contentView().ok_or("窗口视图尚未就绪")?;
        let ns_path = NSString::from_str(bundle_str);
        let file_url = NSURL::fileURLWithPath(&ns_path);
        let drag_item = if let Some(abs_url) = file_url.absoluteString() {
            let pb_item = NSPasteboardItem::new();
            let file_url_uti = NSString::from_str("public.file-url");
            if !pb_item.setString_forType(&abs_url, &file_url_uti) {
                let _ = unsafe { pb_item.setString_forType(&abs_url, NSPasteboardTypeFileURL) };
            }
            NSDraggingItem::initWithPasteboardWriter(
                mtm.alloc(),
                ProtocolObject::from_ref(&*pb_item),
            )
        } else {
            NSDraggingItem::initWithPasteboardWriter(
                mtm.alloc(),
                ProtocolObject::from_ref(&*file_url),
            )
        };
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
        let win_num = ns_win.windowNumber();
        let current_mouse = NSApplication::sharedApplication(mtm)
            .currentEvent()
            .filter(|ev| {
                ev.windowNumber() == win_num
                    && matches!(
                        ev.r#type(),
                        NSEventType::LeftMouseDown | NSEventType::LeftMouseDragged
                    )
            });
        let drag_event = match current_mouse {
            Some(ev) => ev,
            None => NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                NSEventType::LeftMouseDragged,
                win_loc,
                NSEventModifierFlags::empty(),
                NSProcessInfo::processInfo().systemUptime(),
                win_num,
                None,
                0,
                1,
                1.0,
            )
            .ok_or("无法构造拖拽鼠标事件")?,
        };
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
    }

    pub fn start_app_bundle_drag_from(
        app: &tauri::AppHandle,
        preferred_window_label: Option<&str>,
    ) -> Result<bool, String> {
        let bundle =
            current_app_bundle().ok_or_else(|| "未找到 Herdr Pocket.app 应用包".to_string())?;
        let bundle_str = bundle.to_string_lossy().into_owned();
        if let Some(mtm) = MainThreadMarker::new() {
            return run_drag_on_main(mtm, app, &bundle_str, preferred_window_label);
        }
        let preferred = preferred_window_label.map(str::to_string);
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<bool, String>>(1);
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let res = MainThreadMarker::new()
                .ok_or_else(|| "必须在主线程发起拖拽".to_string())
                .and_then(|mtm| run_drag_on_main(mtm, &handle, &bundle_str, preferred.as_deref()));
            let _ = tx.send(res);
        })
        .map_err(|e| format!("调度主线程拖拽失败：{e}"))?;

        rx.recv_timeout(Duration::from_secs(2))
            .map_err(|_| "启动拖拽超时".to_string())?
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn resolve_input_monitoring(hid_access: u32, cg_preflight: bool) -> State {
    if hid_access == 0 || cg_preflight {
        return State::Granted;
    }
    match hid_access {
        1 => State::Denied,
        2 => State::NotDetermined,
        _ => State::Unknown,
    }
}

pub fn start_app_bundle_drag(app: &tauri::AppHandle) -> Result<bool, String> {
    start_app_bundle_drag_from(app, None)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn start_app_bundle_drag_from(
    app: &tauri::AppHandle,
    preferred_window_label: Option<&str>,
) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        mac_drag::start_app_bundle_drag_from(app, preferred_window_label)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, preferred_window_label);
        Ok(false)
    }
}

pub fn snapshot_value() -> Value {
    serde_json::to_value(status()).unwrap_or(Value::Null)
}

fn states_value(s: &Status) -> Value {
    json!({
        "microphone": s.microphone,
        "accessibility": s.accessibility,
        "inputMonitoring": s.input_monitoring,
        "screenRecording": s.screen_recording,
        "fullDiskAccess": s.full_disk_access,
        "fnKey": s.fn_key_action,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        app_bundle_from_exe, format_tccutil_error, mac_tcc_service, resolve_input_monitoring,
        settings_url, State,
    };
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
            for k in [
                "microphone",
                "accessibility",
                "inputMonitoring",
                "screenRecording",
                "keyboard",
                "fullDiskAccess",
            ] {
                assert!(settings_url(k).is_some(), "missing macOS URL for {k}");
            }
        }
        assert!(settings_url("nonexistent").is_none());
    }

    #[test]
    fn input_monitoring_accepts_either_iokit_or_cg_preflight() {
        assert_eq!(resolve_input_monitoring(0, false), State::Granted);
        assert_eq!(resolve_input_monitoring(1, true), State::Granted);
        assert_eq!(resolve_input_monitoring(2, true), State::Granted);
        assert_eq!(resolve_input_monitoring(1, false), State::Denied);
        assert_eq!(resolve_input_monitoring(2, false), State::NotDetermined);
        assert_eq!(resolve_input_monitoring(99, false), State::Unknown);
    }

    #[test]
    fn mac_tcc_service_maps_only_allowlisted_kinds() {
        assert_eq!(mac_tcc_service("accessibility"), Some("Accessibility"));
        assert_eq!(mac_tcc_service("inputMonitoring"), Some("ListenEvent"));
        assert_eq!(mac_tcc_service("microphone"), Some("Microphone"));
        assert_eq!(mac_tcc_service("screenRecording"), Some("ScreenCapture"));
        assert_eq!(mac_tcc_service("fullDiskAccess"), None);
        assert_eq!(mac_tcc_service("keyboard"), None);
        assert_eq!(mac_tcc_service("all"), None);
        assert_eq!(mac_tcc_service(""), None);
    }

    #[test]
    fn format_tccutil_error_explains_unregistered_bundle_and_exit_codes() {
        let missing = format_tccutil_error(
            "ListenEvent",
            "dev.crosery.herdrpocket.desktop",
            Some(64),
            "tccutil: No such bundle identifier \"dev.crosery.herdrpocket.desktop\": (OSStatus error -10814.)",
        );
        assert!(missing.contains("dev.crosery.herdrpocket.desktop"));
        assert!(missing.contains("ListenEvent"));
        assert!(missing.contains("在 Finder 中定位应用"));

        let empty = format_tccutil_error("Accessibility", "dev.example.app", Some(1), "");
        assert!(empty.contains("退出码 1"));
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
