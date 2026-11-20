//! The dictation hotkey: either an accelerator such as `CommandOrControl+Shift+Space`
//! (registered with the OS through tauri-plugin-global-shortcut: no permission,
//! and Windows reports when another app already owns it), or one modifier key
//! held alone (`RightOption`, `RightControl`, `RightCommand`, `RightShift`, `Fn`),
//! which the OS hotkey APIs cannot express, so a key hook watches it
//! (CGEventTap on macOS, needs Input Monitoring; WH_KEYBOARD_LL on Windows).

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ModKey {
    RightOption,
    RightControl,
    RightCommand,
    RightShift,
    Fn,
}

/// What a modifier hook reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEvent {
    ModDown,
    ModUp,
    /// Any other key pressed (or another modifier changed): the modifier is part of a chord, not ours.
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Spec {
    Accelerator(Shortcut),
    Modifier(ModKey),
}

pub fn parse_modifier(s: &str) -> Option<ModKey> {
    match s.trim().to_ascii_lowercase().as_str() {
        "rightoption" | "rightalt" | "ralt" | "roption" => Some(ModKey::RightOption),
        "rightcontrol" | "rightctrl" | "rctrl" => Some(ModKey::RightControl),
        "rightcommand" | "rightcmd" | "rightsuper" | "rightmeta" | "rightwin" => {
            Some(ModKey::RightCommand)
        }
        "rightshift" | "rshift" => Some(ModKey::RightShift),
        "fn" | "globe" => Some(ModKey::Fn),
        _ => None,
    }
}

pub fn parse(s: &str) -> Result<Spec, String> {
    if let Some(m) = parse_modifier(s) {
        if cfg!(windows) && m == ModKey::Fn {
            return Err("Windows 收不到 Fn 键，请换成右 Alt、右 Ctrl 或组合键".into());
        }
        return Ok(Spec::Modifier(m));
    }
    let shortcut: Shortcut = s
        .trim()
        .parse()
        .map_err(|e| format!("快捷键写法不对（{e}），例如 CommandOrControl+Shift+Space"))?;
    if shortcut.mods.is_empty() {
        return Err("组合键至少要有一个修饰键（Ctrl、Alt、Shift 或 Command）".into());
    }
    Ok(Spec::Accelerator(shortcut))
}

/// Shortcuts the OS (or a very common app) already uses, which a registration would not report.
pub fn known_conflict(s: &str) -> Option<String> {
    let norm: String = s
        .split('+')
        .map(|p| match p.trim().to_ascii_lowercase().as_str() {
            "commandorcontrol" | "cmdorctrl" | "cmdorcontrol" => {
                if cfg!(target_os = "macos") {
                    "cmd".to_string()
                } else {
                    "ctrl".to_string()
                }
            }
            "command" | "cmd" | "super" | "meta" => "cmd".into(),
            "control" | "ctrl" => "ctrl".into(),
            "option" | "alt" => "alt".into(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join("+");
    let mac: &[(&str, &str)] = &[
        ("cmd+space", "聚焦搜索（Spotlight）"),
        ("ctrl+space", "切换输入法"),
        ("ctrl+alt+space", "切换输入法"),
        ("cmd+alt+space", "访达搜索"),
        ("cmd+tab", "切换应用"),
        ("cmd+shift+3", "截屏"),
        ("cmd+shift+4", "截屏"),
        ("cmd+shift+5", "截屏"),
        ("cmd+q", "退出应用"),
        ("cmd+w", "关闭窗口"),
        ("cmd+v", "粘贴"),
        ("cmd+c", "复制"),
    ];
    let win: &[(&str, &str)] = &[
        ("ctrl+space", "切换中英文输入法"),
        ("ctrl+shift+space", "部分输入法的全/半角切换"),
        ("alt+space", "窗口菜单"),
        ("alt+tab", "切换窗口"),
        ("ctrl+alt+delete", "系统安全选项"),
        ("ctrl+shift+esc", "任务管理器"),
        ("ctrl+v", "粘贴"),
        ("ctrl+c", "复制"),
    ];
    let list = if cfg!(target_os = "macos") { mac } else { win };
    let hit = list
        .iter()
        .find(|(k, _)| *k == norm)
        .map(|(_, what)| format!("这个组合键通常被「{what}」占用"));
    if hit.is_some() {
        return hit;
    }
    match parse_modifier(s) {
        Some(ModKey::Fn) => fn_conflict(crate::perms::fn_key_action()),
        Some(ModKey::RightOption) if cfg!(target_os = "macos") => None,
        Some(ModKey::RightOption) => {
            Some("部分键盘布局把右 Alt 当作 AltGr 用来输入特殊字符".into())
        }
        Some(ModKey::RightControl) if cfg!(target_os = "macos") => None,
        _ => None,
    }
}

/// The fn (globe) key as a hotkey, given what macOS does with it (`perms::fn_key_action`).
pub fn fn_conflict(action: Option<&str>) -> Option<String> {
    const FIX: &str = "请在 系统设置 → 键盘 里把「按下地球仪键时」设为「不执行任何操作」";
    let what = match action {
        Some("none") => return None,
        Some("inputSource") => "切换输入法",
        Some("emoji") => "显示表情与符号",
        Some("dictation") => "开始系统听写",
        _ => return Some(format!("如果按 fn 键时会弹出表情或系统听写，{FIX}")),
    };
    Some(format!(
        "系统正把 fn（地球仪）键用于「{what}」，按下时会一起触发。{FIX}"
    ))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub ok: bool,
    /// `accelerator` or `modifier`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    /// Why it cannot be used (bad syntax, taken by another app).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// It works, but something may get in the way.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    /// Permission the person still has to grant (`inputMonitoring`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_permission: Option<&'static str>,
}

/// Can `s` be used? For accelerators this tries a registration (when it is not the current hotkey).
pub fn check<R: Runtime>(app: &AppHandle<R>, s: &str, current: Option<&Spec>) -> Check {
    match parse(s) {
        Err(e) => Check {
            ok: false,
            kind: None,
            error: Some(e),
            warning: None,
            needs_permission: None,
        },
        Ok(Spec::Modifier(_)) => {
            let needs = needs_input_monitoring().then_some("inputMonitoring");
            Check {
                ok: true,
                kind: Some("modifier"),
                error: None,
                warning: known_conflict(s),
                needs_permission: needs,
            }
        }
        Ok(Spec::Accelerator(sc)) => {
            if current == Some(&Spec::Accelerator(sc)) {
                return Check {
                    ok: true,
                    kind: Some("accelerator"),
                    error: None,
                    warning: known_conflict(s),
                    needs_permission: None,
                };
            }
            let gs = app.global_shortcut();
            match gs.register(sc) {
                Ok(()) => {
                    let _ = gs.unregister(sc);
                    Check {
                        ok: true,
                        kind: Some("accelerator"),
                        error: None,
                        warning: known_conflict(s),
                        needs_permission: None,
                    }
                }
                Err(e) => Check {
                    ok: false,
                    kind: Some("accelerator"),
                    error: Some(format!("这个快捷键已被其他程序占用（{e}）")),
                    warning: None,
                    needs_permission: None,
                },
            }
        }
    }
}

pub fn needs_input_monitoring() -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::perms::status().input_monitoring != crate::perms::State::Granted
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// The plugin, with every shortcut event going to the dictation controller.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|_app, shortcut, event| {
            super::on_shortcut(*shortcut, event.state == ShortcutState::Pressed);
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modifiers_and_accelerators() {
        assert_eq!(
            parse("RightOption").unwrap(),
            Spec::Modifier(ModKey::RightOption)
        );
        assert_eq!(
            parse("rightalt").unwrap(),
            Spec::Modifier(ModKey::RightOption)
        );
        assert_eq!(
            parse("RightCtrl").unwrap(),
            Spec::Modifier(ModKey::RightControl)
        );
        assert!(matches!(
            parse("CommandOrControl+Shift+Space").unwrap(),
            Spec::Accelerator(_)
        ));
        assert!(parse("Space").is_err(), "a bare key would swallow typing");
        assert!(parse("Ctrl+Nope").is_err());
    }

    #[test]
    fn flags_common_conflicts() {
        if cfg!(target_os = "macos") {
            assert!(known_conflict("Command+Space").is_some());
            assert!(known_conflict("CommandOrControl+Space").is_some());
        } else {
            assert!(known_conflict("Control+Space").is_some());
        }
        assert!(known_conflict("CommandOrControl+Shift+Semicolon").is_none());
    }

    #[test]
    fn fn_key_warning_follows_the_system_setting() {
        assert!(fn_conflict(Some("none")).is_none());
        assert!(fn_conflict(Some("emoji"))
            .unwrap()
            .contains("显示表情与符号"));
        assert!(fn_conflict(None).unwrap().contains("不执行任何操作"));
    }
}
