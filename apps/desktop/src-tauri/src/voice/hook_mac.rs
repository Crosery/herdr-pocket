//! Watches one modifier key held alone (right Option, Fn, ...) with a listen-only
//! CGEventTap on its own thread. Needs Input Monitoring; it never changes or
//! swallows events.

use super::hotkey::{KeyEvent, ModKey};
use core_graphics::event::{
    CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
    CallbackResult, EventField,
};
use std::ffi::c_void;
use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::mpsc;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRunLoopGetCurrent() -> *mut c_void;
    fn CFRunLoopStop(rl: *mut c_void);
    fn CFRunLoopRun();
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
    fn CGPreflightListenEventAccess() -> bool;
}

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOHIDCheckAccess(request: u32) -> u32;
}

const LISTEN_EVENT: u32 = 1; // kIOHIDRequestTypeListenEvent

/// The tap's mach port, to switch it back on when macOS disables it after a slow callback.
static PORT: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

fn code_and_mask(key: ModKey) -> Option<(i64, u64)> {
    // Virtual key codes (Events.h) and device-dependent flag bits (IOLLEvent.h).
    match key {
        ModKey::RightOption => Some((61, 0x40)),
        ModKey::RightControl => Some((62, 0x2000)),
        ModKey::RightCommand => Some((54, 0x10)),
        ModKey::RightShift => Some((60, 0x04)),
        ModKey::Fn => Some((63, 0x0080_0000)),
    }
}

pub struct Hook {
    runloop: usize,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Hook {
    pub fn stop(mut self) {
        self.halt();
    }

    fn halt(&mut self) {
        if self.runloop != 0 {
            unsafe { CFRunLoopStop(self.runloop as *mut c_void) };
            self.runloop = 0;
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Hook {
    fn drop(&mut self) {
        self.halt();
    }
}

pub fn start(key: ModKey, sink: impl Fn(KeyEvent) + Send + 'static) -> Result<Hook, String> {
    let (code, mask) =
        code_and_mask(key).ok_or_else(|| "这个按键在 macOS 上不能单独做快捷键".to_string())?;
    let permitted =
        unsafe { CGPreflightListenEventAccess() || IOHIDCheckAccess(LISTEN_EVENT) == 0 };
    if !permitted {
        return Err("需要「输入监控」权限才能用单个修饰键做快捷键".into());
    }
    let (ready_tx, ready_rx) = mpsc::channel::<Result<usize, String>>();
    let thread = std::thread::Builder::new()
        .name("pocket-hotkey".into())
        .spawn(move || {
            let callback = move |_proxy,
                                 etype: CGEventType,
                                 event: &core_graphics::event::CGEvent| {
                match etype {
                    CGEventType::FlagsChanged => {
                        let kc = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
                        if kc == code {
                            let down = event.get_flags().bits() & mask != 0;
                            sink(if down {
                                KeyEvent::ModDown
                            } else {
                                KeyEvent::ModUp
                            });
                        } else if kc == 63 && code != 63 {
                            // Ignore spurious Apple Silicon Fn (63) events around other hotkeys.
                        } else {
                            sink(KeyEvent::Other);
                        }
                    }
                    CGEventType::KeyDown => sink(KeyEvent::Other),
                    CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput => {
                        let port = PORT.load(Ordering::Relaxed);
                        if !port.is_null() {
                            unsafe { CGEventTapEnable(port, true) };
                        }
                    }
                    _ => {}
                }
                CallbackResult::Keep
            };
            let tap = match CGEventTap::new(
                CGEventTapLocation::Session,
                CGEventTapPlacement::TailAppendEventTap,
                CGEventTapOptions::ListenOnly,
                vec![CGEventType::FlagsChanged, CGEventType::KeyDown],
                callback,
            ) {
                Ok(t) => t,
                Err(()) => {
                    let _ = ready_tx.send(Err("无法监听键盘（请检查「输入监控」权限）".into()));
                    return;
                }
            };
            let Ok(source) = tap.mach_port().create_runloop_source(0) else {
                let _ = ready_tx.send(Err("无法监听键盘".into()));
                return;
            };
            let rl = core_foundation::runloop::CFRunLoop::get_current();
            rl.add_source(&source, unsafe {
                core_foundation::runloop::kCFRunLoopCommonModes
            });
            {
                use core_foundation::base::TCFType;
                PORT.store(
                    tap.mach_port().as_concrete_TypeRef() as *mut c_void,
                    Ordering::Relaxed,
                );
            }
            tap.enable();
            let _ = ready_tx.send(Ok(unsafe { CFRunLoopGetCurrent() } as usize));
            unsafe { CFRunLoopRun() };
            PORT.store(std::ptr::null_mut(), Ordering::Relaxed);
            drop(tap);
        })
        .map_err(|e| e.to_string())?;
    match ready_rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(Ok(runloop)) => Ok(Hook {
            runloop,
            thread: Some(thread),
        }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => Err("监听键盘超时".into()),
    }
}
