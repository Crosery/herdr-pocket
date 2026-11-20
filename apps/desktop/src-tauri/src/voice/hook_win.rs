//! Watches one modifier key held alone (right Alt, right Ctrl, ...) with a
//! low-level keyboard hook on its own message-loop thread. The hook only
//! observes: every event is passed on. Windows does not deliver keys typed
//! into elevated windows to a hook of a non-elevated process.

use super::hotkey::{KeyEvent, ModKey};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{mpsc, Mutex};
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, WH_KEYBOARD_LL,
    WM_KEYDOWN, WM_QUIT, WM_SYSKEYDOWN,
};

type Sink = Box<dyn Fn(KeyEvent) + Send>;

static SINK: Mutex<Option<Sink>> = Mutex::new(None);
static TARGET: AtomicU16 = AtomicU16::new(0);
static HELD: AtomicBool = AtomicBool::new(false);

fn vk_of(key: ModKey) -> Option<u16> {
    match key {
        ModKey::RightOption => Some(0xA5),  // VK_RMENU
        ModKey::RightControl => Some(0xA3), // VK_RCONTROL
        ModKey::RightShift => Some(0xA1),   // VK_RSHIFT
        ModKey::RightCommand => Some(0x5C), // VK_RWIN
        ModKey::Fn => None,                 // handled by the keyboard itself, never reaches Windows
    }
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && lparam != 0 {
        let kb = &*(lparam as *const KBDLLHOOKSTRUCT);
        // Our own synthetic keys (paste, the menu mask) are not the person's.
        if kb.flags & LLKHF_INJECTED == 0 {
            let msg = wparam as u32;
            let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let vk = kb.vkCode as u16;
            let ev = if vk == TARGET.load(Ordering::Relaxed) {
                if down {
                    // Key repeat sends more downs while held.
                    (!HELD.swap(true, Ordering::Relaxed)).then_some(KeyEvent::ModDown)
                } else {
                    HELD.swap(false, Ordering::Relaxed)
                        .then_some(KeyEvent::ModUp)
                }
            } else if down {
                Some(KeyEvent::Other)
            } else {
                None
            };
            if let Some(ev) = ev {
                if let Ok(guard) = SINK.lock() {
                    if let Some(sink) = guard.as_ref() {
                        sink(ev);
                    }
                }
            }
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

pub struct Hook {
    thread_id: u32,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Hook {
    pub fn stop(mut self) {
        self.halt();
    }

    fn halt(&mut self) {
        if self.thread_id != 0 {
            unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) };
            self.thread_id = 0;
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        if let Ok(mut s) = SINK.lock() {
            *s = None;
        }
    }
}

impl Drop for Hook {
    fn drop(&mut self) {
        self.halt();
    }
}

pub fn start(key: ModKey, sink: impl Fn(KeyEvent) + Send + 'static) -> Result<Hook, String> {
    let vk = vk_of(key).ok_or_else(|| "Windows 收不到 Fn 键，请换一个按键".to_string())?;
    TARGET.store(vk, Ordering::Relaxed);
    HELD.store(false, Ordering::Relaxed);
    if let Ok(mut s) = SINK.lock() {
        *s = Some(Box::new(sink));
    }
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    let thread = std::thread::Builder::new()
        .name("pocket-hotkey".into())
        .spawn(move || unsafe {
            let hook = SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(hook_proc),
                GetModuleHandleW(std::ptr::null()),
                0,
            );
            if hook.is_null() {
                let _ = ready_tx.send(Err("无法监听键盘".into()));
                return;
            }
            let _ = ready_tx.send(Ok(GetCurrentThreadId()));
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            UnhookWindowsHookEx(hook);
        })
        .map_err(|e| e.to_string())?;
    match ready_rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(thread_id)) => Ok(Hook {
            thread_id,
            thread: Some(thread),
        }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => Err("监听键盘超时".into()),
    }
}
