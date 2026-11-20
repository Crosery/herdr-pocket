//! Puts dictated text into the app the person is typing in.
//!
//! `paste` (default): the clipboard is saved, the text is put on it, a paste
//! keystroke is sent, and the old clipboard comes back a moment later (unless
//! something else changed the clipboard meanwhile). `type`: the text is typed
//! as Unicode key events, the clipboard is not touched. `clipboard`: the text
//! is only copied. Without the needed permission (macOS Accessibility) or when
//! the target cannot receive input (Windows: an elevated window), the text is
//! left on the clipboard and the outcome says why.

use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// What actually happened: paste, type or clipboard.
    pub method: &'static str,
    /// Chinese, for the HUD, when the method differs from what was asked.
    pub note: Option<String>,
}

const RESTORE_AFTER: Duration = Duration::from_millis(450);

pub fn insert(text: &str, method: &str) -> Outcome {
    match method {
        "clipboard" => {
            if platform::set_text(text).is_some() {
                Outcome {
                    method: "clipboard",
                    note: None,
                }
            } else {
                Outcome {
                    method: "clipboard",
                    note: Some("无法写入剪贴板".into()),
                }
            }
        }
        "type" => match platform::can_send_input() {
            Ok(()) => {
                platform::type_text(text);
                Outcome {
                    method: "type",
                    note: None,
                }
            }
            Err(why) => fallback(text, why),
        },
        _ => match platform::can_send_input() {
            Ok(()) => paste(text),
            Err(why) => fallback(text, why),
        },
    }
}

fn fallback(text: &str, why: String) -> Outcome {
    let copied = platform::set_text(text).is_some();
    let note = if copied {
        format!("{why}，文字已复制到剪贴板")
    } else {
        why
    };
    Outcome {
        method: "clipboard",
        note: Some(note),
    }
}

fn paste(text: &str) -> Outcome {
    let saved = platform::snapshot();
    let Some(ours) = platform::set_text(text) else {
        return Outcome {
            method: "clipboard",
            note: Some("无法写入剪贴板".into()),
        };
    };
    // Give the pasteboard server a moment before the keystroke reads it.
    std::thread::sleep(Duration::from_millis(30));
    platform::paste_keystroke();
    std::thread::spawn(move || {
        std::thread::sleep(RESTORE_AFTER);
        // Someone copied something else meanwhile: leave theirs.
        if platform::change_count() == Some(ours) {
            platform::restore(saved);
        }
    });
    Outcome {
        method: "paste",
        note: None,
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardItem, NSPasteboardTypeString, NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSData, NSString};

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    /// kVK_ANSI_V: the V key on a US layout (Command+V follows the physical key on most layouts).
    const KEY_V: u16 = 9;

    /// Every item with every type it offers, as bytes.
    pub type Snapshot = Vec<Vec<(String, Vec<u8>)>>;

    pub fn can_send_input() -> Result<(), String> {
        if unsafe { AXIsProcessTrusted() } {
            Ok(())
        } else {
            Err("需要在 系统设置 → 隐私与安全性 → 辅助功能 里允许 Herdr Pocket".into())
        }
    }

    pub fn change_count() -> Option<isize> {
        Some(NSPasteboard::generalPasteboard().changeCount())
    }

    pub fn snapshot() -> Snapshot {
        let pb = NSPasteboard::generalPasteboard();
        let mut out = Vec::new();
        let mut total = 0usize;
        if let Some(items) = pb.pasteboardItems() {
            for item in items.iter() {
                let mut entry = Vec::new();
                for t in item.types().iter() {
                    if let Some(data) = item.dataForType(&t) {
                        let bytes = data.to_vec();
                        total += bytes.len();
                        // Very large clipboards (videos, huge images) are not worth holding twice.
                        if total > 64 * 1024 * 1024 {
                            return Vec::new();
                        }
                        entry.push((t.to_string(), bytes));
                    }
                }
                if !entry.is_empty() {
                    out.push(entry);
                }
            }
        }
        out
    }

    pub fn restore(saved: Snapshot) {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        if saved.is_empty() {
            return;
        }
        let mut items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = Vec::new();
        for entry in saved {
            let item = NSPasteboardItem::new();
            for (t, bytes) in entry {
                let data = NSData::with_bytes(&bytes);
                let ty = NSString::from_str(&t);
                item.setData_forType(&data, &ty);
            }
            items.push(ProtocolObject::from_retained(item));
        }
        let array = NSArray::from_retained_slice(&items);
        pb.writeObjects(&array);
    }

    /// Puts `text` on the clipboard; returns the clipboard's change count afterwards.
    pub fn set_text(text: &str) -> Option<isize> {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        let s = NSString::from_str(text);
        let ok = unsafe { pb.setString_forType(&s, NSPasteboardTypeString) };
        ok.then(|| pb.changeCount())
    }

    fn key(code: u16, down: bool, flags: CGEventFlags) {
        let Ok(src) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
            return;
        };
        if let Ok(ev) = CGEvent::new_keyboard_event(src, code, down) {
            ev.set_flags(flags);
            ev.post(CGEventTapLocation::HID);
        }
    }

    pub fn paste_keystroke() {
        key(KEY_V, true, CGEventFlags::CGEventFlagCommand);
        key(KEY_V, false, CGEventFlags::CGEventFlagCommand);
    }

    pub fn type_text(text: &str) {
        let units: Vec<u16> = text.encode_utf16().collect();
        // CGEventKeyboardSetUnicodeString takes at most 20 UTF-16 units per event.
        for chunk in units.chunks(20) {
            for down in [true, false] {
                let Ok(src) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
                    return;
                };
                if let Ok(ev) = CGEvent::new_keyboard_event(src, 0, down) {
                    ev.set_flags(CGEventFlags::CGEventFlagNull);
                    ev.set_string_from_utf16_unchecked(chunk);
                    ev.post(CGEventTapLocation::HID);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(4));
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HGLOBAL};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
        GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        VK_CONTROL,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };

    const CF_UNICODETEXT: u32 = 13;
    /// Formats whose handle is a GDI object, not memory: they cannot be copied as bytes.
    const GDI_FORMATS: [u32; 8] = [2, 3, 9, 14, 0x80, 0x82, 0x83, 0x8E];

    pub type Snapshot = Vec<(u32, Vec<u8>)>;

    struct Clip;
    impl Clip {
        fn open() -> Option<Clip> {
            for _ in 0..10 {
                if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                    return Some(Clip);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            None
        }
    }
    impl Drop for Clip {
        fn drop(&mut self) {
            unsafe { CloseClipboard() };
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn token_elevated(process: HANDLE) -> Option<bool> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
                return None;
            }
            let mut elev: TOKEN_ELEVATION = std::mem::zeroed();
            let mut len = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut elev as *mut _ as *mut _,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            );
            CloseHandle(token);
            (ok != 0).then_some(elev.TokenIsElevated != 0)
        }
    }

    /// Windows drops synthetic input aimed at a window of a higher integrity level (UIPI) without saying so.
    pub fn can_send_input() -> Result<(), String> {
        unsafe {
            if token_elevated(GetCurrentProcess()) == Some(true) {
                return Ok(());
            }
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return Ok(());
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return Ok(());
            }
            // Access denied to the token usually means the window runs as administrator.
            let elevated = token_elevated(h).unwrap_or(true);
            CloseHandle(h);
            if elevated {
                Err("当前窗口以管理员身份运行，Windows 不允许其他程序向它输入".into())
            } else {
                Ok(())
            }
        }
    }

    pub fn change_count() -> Option<u32> {
        Some(unsafe { GetClipboardSequenceNumber() })
    }

    pub fn snapshot() -> Snapshot {
        let mut out = Vec::new();
        let Some(_clip) = Clip::open() else {
            return out;
        };
        let mut total = 0usize;
        let mut fmt = 0u32;
        loop {
            fmt = unsafe { EnumClipboardFormats(fmt) };
            if fmt == 0 {
                break;
            }
            if GDI_FORMATS.contains(&fmt) {
                continue;
            }
            unsafe {
                let h = GetClipboardData(fmt) as HGLOBAL;
                if h.is_null() {
                    continue;
                }
                let size = GlobalSize(h);
                let p = GlobalLock(h) as *const u8;
                if p.is_null() || size == 0 {
                    continue;
                }
                total += size;
                if total > 64 * 1024 * 1024 {
                    GlobalUnlock(h);
                    return Vec::new();
                }
                out.push((fmt, std::slice::from_raw_parts(p, size).to_vec()));
                GlobalUnlock(h);
            }
        }
        out
    }

    fn put(fmt: u32, bytes: &[u8]) -> bool {
        unsafe {
            let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1));
            if h.is_null() {
                return false;
            }
            let p = GlobalLock(h) as *mut u8;
            if p.is_null() {
                return false;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            GlobalUnlock(h);
            // On success the clipboard owns the memory.
            !SetClipboardData(fmt, h).is_null()
        }
    }

    pub fn restore(saved: Snapshot) {
        let Some(_clip) = Clip::open() else { return };
        unsafe { EmptyClipboard() };
        for (fmt, bytes) in saved {
            put(fmt, &bytes);
        }
    }

    /// Puts `text` on the clipboard, kept out of clipboard history and cloud sync; returns the sequence number.
    pub fn set_text(text: &str) -> Option<u32> {
        {
            let _clip = Clip::open()?;
            unsafe { EmptyClipboard() };
            let units = wide(text);
            let bytes: Vec<u8> = units.iter().flat_map(|u| u.to_le_bytes()).collect();
            if !put(CF_UNICODETEXT, &bytes) {
                return None;
            }
            let zero = 0u32.to_le_bytes();
            for name in ["CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"] {
                let id = unsafe { RegisterClipboardFormatW(wide(name).as_ptr()) };
                if id != 0 {
                    put(id, &zero);
                }
            }
        }
        change_count()
    }

    fn key_input(vk: u16, scan: u16, flags: u32) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn send(inputs: &[INPUT]) {
        unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            );
        }
    }

    pub fn paste_keystroke() {
        let v = u16::from(b'V');
        send(&[
            key_input(VK_CONTROL, 0, 0),
            key_input(v, 0, 0),
            key_input(v, 0, KEYEVENTF_KEYUP),
            key_input(VK_CONTROL, 0, KEYEVENTF_KEYUP),
        ]);
    }

    pub fn type_text(text: &str) {
        for chunk in text.encode_utf16().collect::<Vec<u16>>().chunks(32) {
            let mut inputs = Vec::with_capacity(chunk.len() * 2);
            for u in chunk {
                inputs.push(key_input(0, *u, KEYEVENTF_UNICODE));
                inputs.push(key_input(0, *u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
            send(&inputs);
            std::thread::sleep(Duration::from_millis(4));
        }
    }

    /// An unassigned key, tapped while Alt or Win is held for dictation, so releasing it
    /// does not open the target app's menu bar or the Start menu.
    pub fn mask_modifier_release() {
        const VK_NONE: u16 = 0xE8;
        send(&[
            key_input(VK_NONE, 0, 0),
            key_input(VK_NONE, 0, KEYEVENTF_KEYUP),
        ]);
    }
}

#[cfg(windows)]
pub use platform::mask_modifier_release;

#[cfg(all(not(target_os = "macos"), not(windows)))]
mod platform {
    pub type Snapshot = ();
    pub fn can_send_input() -> Result<(), String> {
        Err("这个系统暂不支持".into())
    }
    pub fn change_count() -> Option<u32> {
        None
    }
    pub fn snapshot() -> Snapshot {}
    pub fn restore(_: Snapshot) {}
    pub fn set_text(_: &str) -> Option<u32> {
        None
    }
    pub fn paste_keystroke() {}
    pub fn type_text(_: &str) {}
}
