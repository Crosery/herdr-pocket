//! The built-in browser: web pages shown inside the main window as child
//! webviews (`Window::add_child`, tauri feature `unstable`), one per panel id
//! the UI picks. A panel is created on the first `browser_open` for its id,
//! only shown and moved on later ones (the UI remounts its view), and destroyed
//! on `browser_close`. Bounds are CSS pixels relative to the window's content.
//!
//! Pages get their own cookie store, apart from the app's: macOS 14+ a
//! persistent `WKWebsiteDataStore` of their own (WebKit keeps it under
//! ~/Library/WebKit/<bundle id>/), macOS 11–13 a non-persistent one (cookies
//! last until the last panel closes), Windows/Linux a WebView2/WebKit data
//! folder under the app's data folder (WebView2 starts a second browser
//! process group for it, only while a panel is open).
//!
//! Remote pages cannot call the app's commands (Tauri only lets local origins
//! do that), so a panel must never load the app's own origin: only http(s)
//! to other origins and about:blank load; window.open goes to the system browser.
//!
//! Native views draw above the React UI: the UI hides panels while a dialog or
//! menu covers them (`browser_set_visible`).

use crate::logging;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder,
    WebviewUrl,
};

/// To the main window: `{ id, kind: "url" | "title" | "loading" | "loaded" | "error" | "download", url?, title?, error?, ok?, path? }`.
pub const EVENT: &str = "browser://event";
const PREFIX: &str = "browser-";
const MAX_PANELS: usize = 8;
/// The panels' own WKWebsiteDataStore (macOS 14+); any fixed UUID works, it only has to stay the same.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const DATA_STORE_ID: [u8; 16] = [
    0x6b, 0x2f, 0x0e, 0x4d, 0x93, 0x1a, 0x4c, 0x2b, 0x9e, 0x51, 0x7d, 0x30, 0xa4, 0x18, 0xc6, 0x57,
];
/// Written when browsing data should go but no panel is open to clear it; done when the next one opens.
const CLEAR_PENDING: &str = "browser-clear-pending";
const REFUSED: &str = "内置浏览器只能打开 http 和 https 网页";

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct NavOp {
    pub url: Option<String>,
    pub back: Option<bool>,
    pub forward: Option<bool>,
    pub reload: Option<bool>,
    pub stop: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PanelInfo {
    pub id: String,
    pub url: String,
}

/// The page's id for a panel ("panel-web", "w:k3x9") becomes the webview label `browser-<id>`.
/// Letters, digits, `-`, `_` and `:` only: all allowed in Tauri labels, no path characters.
fn label_for(id: &str) -> Result<String, String> {
    let ok = !id.is_empty()
        && id.len() <= 32
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'));
    if ok {
        Ok(format!("{PREFIX}{id}"))
    } else {
        Err("浏览器页面的编号不对".into())
    }
}

fn panels(app: &AppHandle) -> Vec<Webview> {
    app.webviews()
        .into_iter()
        .filter(|(label, _)| label.starts_with(PREFIX))
        .map(|(_, w)| w)
        .collect()
}

fn panel(app: &AppHandle, id: &str) -> Result<Webview, String> {
    let label = label_for(id)?;
    app.get_webview(&label)
        .ok_or_else(|| "这个浏览器页面已经关闭".to_string())
}

/// Any open panel: they all share one cookie store, so cookies set on one reach all.
pub fn webview(app: &AppHandle) -> Option<Webview> {
    panels(app).into_iter().next()
}

fn emit(app: &AppHandle, id: &str, kind: &str, extra: Value) {
    let mut payload = json!({ "id": id, "kind": kind });
    if let (Some(p), Value::Object(m)) = (payload.as_object_mut(), extra) {
        p.extend(m);
    }
    let _ = app.emit_to("main", EVENT, payload);
}

/// http(s) to anywhere except the app's own origins, and about:blank.
pub fn allowed(url: &Url, app_dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
            // tauri.localhost: the app itself on Windows/Linux; ipc./asset.localhost: its protocols.
            if matches!(
                host.as_str(),
                "tauri.localhost" | "ipc.localhost" | "asset.localhost"
            ) {
                return false;
            }
            match app_dev_url {
                Some(dev) => url.origin() != dev.origin(),
                None => true,
            }
        }
        "about" => url.as_str() == "about:blank",
        _ => false,
    }
}

fn dev_url(app: &AppHandle) -> Option<Url> {
    if cfg!(debug_assertions) {
        app.config().build.dev_url.clone()
    } else {
        None
    }
}

/// What was typed in the address bar: a URL, a host name, or words to search for.
pub fn normalize_input(input: &str, engine: &str) -> Option<String> {
    let t = input.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(u) = Url::parse(t) {
        if matches!(u.scheme(), "http" | "https" | "about") {
            return Some(u.to_string());
        }
    }
    let looks_like_host = !t.contains(char::is_whitespace)
        && (t.contains('.') || t.starts_with("localhost"))
        && !t.starts_with('.')
        && !t.ends_with('.');
    if looks_like_host {
        let scheme = if t.starts_with("localhost") || t.starts_with("127.") {
            "http"
        } else {
            "https"
        };
        if let Ok(u) = Url::parse(&format!("{scheme}://{t}")) {
            return Some(u.to_string());
        }
    }
    let base = match engine {
        "google" => "https://www.google.com/search?q=",
        "baidu" => "https://www.baidu.com/s?wd=",
        "duckduckgo" => "https://duckduckgo.com/?q=",
        _ => "https://www.bing.com/search?q=",
    };
    let q: String = url::form_urlencoded::byte_serialize(t.as_bytes()).collect();
    Some(format!("{base}{q}"))
}

fn config_str(pointer: &str) -> Option<String> {
    crate::config::read()
        .raw
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Modern Chrome User-Agent so sites don't block embedded WKWebView/WebKit with "浏览器版本过低".
fn modern_chrome_user_agent() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
    }
    #[cfg(windows)]
    {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
    }
}

/// Reloads open browser panels whose current host matches any imported cookie domain.
pub fn reload_matching_panels(app: &AppHandle, wanted: &[String]) {
    let all = wanted.iter().any(|w| w == "*");
    for w in panels(app) {
        let should_reload = if all {
            true
        } else if let Ok(u) = w.url() {
            u.host_str()
                .is_some_and(|host| crate::cookies::domain_matches(host, wanted))
        } else {
            false
        };
        if should_reload {
            let _ = w.eval("window.location.reload()");
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_major() -> isize {
    objc2_foundation::NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
}

/// `persistent`, or `session` where imported cookies only last until the last panel closes (macOS 11–13).
pub fn store_kind() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        if macos_major() >= 14 {
            "persistent"
        } else {
            "session"
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        "persistent"
    }
}

/// Where the panels keep cookies and cache on disk (for sizes and clearing).
pub fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        // WebKit keeps identified stores under ~/Library/WebKit/<bundle id>/WebsiteDataStore/<UUID>.
        let uuid = DATA_STORE_ID
            .iter()
            .enumerate()
            .map(|(i, b)| {
                if matches!(i, 4 | 6 | 8 | 10) {
                    format!("-{b:02X}")
                } else {
                    format!("{b:02X}")
                }
            })
            .collect::<String>();
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        let p = home
            .join("Library/WebKit")
            .join(&app.config().identifier)
            .join("WebsiteDataStore")
            .join(uuid);
        p.exists().then_some(p)
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.path()
            .app_local_data_dir()
            .ok()
            .map(|d| d.join("browser-data"))
    }
}

fn pending_marker(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_local_data_dir()
        .ok()
        .map(|d| d.join(CLEAR_PENDING))
}

fn unique_download_path(dir: &Path, name: &str) -> PathBuf {
    let clean: String = name
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let clean = if clean.trim().is_empty() || clean.starts_with('.') {
        format!("download{clean}")
    } else {
        clean
    };
    let first = dir.join(&clean);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match clean.rfind('.') {
        Some(i) if i > 0 => (&clean[..i], &clean[i..]),
        _ => (clean.as_str(), ""),
    };
    (1..1000)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

fn builder(app: &AppHandle, id: &str, label: &str, url: Url) -> WebviewBuilder<tauri::Wry> {
    let dev = dev_url(app);
    let (a1, a2, a3, a4, a5) = (
        app.clone(),
        app.clone(),
        app.clone(),
        app.clone(),
        app.clone(),
    );
    let (i1, i2, i3, i4, i5) = (
        id.to_string(),
        id.to_string(),
        id.to_string(),
        id.to_string(),
        id.to_string(),
    );
    let (dev1, dev2) = (dev.clone(), dev);
    let mut b = WebviewBuilder::new(label, WebviewUrl::External(url))
        .on_navigation(move |u| {
            let ok = allowed(u, dev1.as_ref());
            if !ok {
                logging::info(
                    "browser",
                    "navigation refused",
                    json!({ "scheme": u.scheme() }),
                );
                emit(&a1, &i1, "error", json!({ "error": REFUSED }));
            }
            ok
        })
        .on_page_load(move |_w, p| {
            let url = p.url().as_str();
            match p.event() {
                PageLoadEvent::Started => {
                    emit(&a2, &i2, "loading", json!({ "url": url }));
                    emit(&a2, &i2, "url", json!({ "url": url }));
                }
                PageLoadEvent::Finished => emit(&a2, &i2, "loaded", json!({ "url": url })),
            }
        })
        .on_document_title_changed(move |_w, title| {
            emit(&a3, &i3, "title", json!({ "title": title }));
        })
        .on_new_window(move |u, _features| {
            // target=_blank and window.open: the system browser, never a second app window.
            if matches!(u.scheme(), "http" | "https") && allowed(&u, dev2.as_ref()) {
                logging::info(
                    "browser",
                    "popup opened in system browser",
                    json!({ "origin": crate::net::origin(u.as_str()) }),
                );
                let _ = tauri_plugin_opener::open_url(u.as_str(), None::<&str>);
            } else {
                emit(&a4, &i4, "error", json!({ "error": REFUSED }));
            }
            NewWindowResponse::Deny
        })
        .on_download(move |_w, ev| match ev {
            DownloadEvent::Requested { url, destination } => {
                let Some(dir) = a5.path().download_dir().ok().filter(|d| d.is_dir()) else {
                    return false;
                };
                let name = destination
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .filter(|n| !n.is_empty())
                    .or_else(|| {
                        url.path_segments()
                            .and_then(|mut s| s.next_back().map(str::to_string))
                    })
                    .unwrap_or_else(|| "download".into());
                *destination = unique_download_path(&dir, &name);
                logging::info(
                    "browser",
                    "download started",
                    json!({ "origin": crate::net::origin(url.as_str()) }),
                );
                true
            }
            DownloadEvent::Finished { url, path, success } => {
                logging::info(
                    "browser",
                    "download finished",
                    json!({ "origin": crate::net::origin(url.as_str()), "ok": success }),
                );
                emit(
                    &a5,
                    &i5,
                    "download",
                    json!({ "ok": success, "path": path.map(|p| p.display().to_string()) }),
                );
                true
            }
            _ => true,
        })
        .user_agent(modern_chrome_user_agent())
        .initialization_script("if(!window.chrome){window.chrome={runtime:{}};}")
        .devtools(cfg!(debug_assertions));
    #[cfg(target_os = "macos")]
    {
        b = if macos_major() >= 14 {
            b.data_store_identifier(DATA_STORE_ID)
        } else {
            b.incognito(true)
        };
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(dir) = data_dir(app) {
            b = b.data_directory(dir);
        }
    }
    b
}

fn clamp(rect: Rect) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let fin = |v: f64| if v.is_finite() { v } else { 0.0 };
    (
        LogicalPosition::new(fin(rect.x).max(0.0), fin(rect.y).max(0.0)),
        LogicalSize::new(fin(rect.width).max(1.0), fin(rect.height).max(1.0)),
    )
}

fn parse_target(app: &AppHandle, input: &str) -> Result<Url, String> {
    let engine = config_str("/browser/searchEngine").unwrap_or_else(|| "bing".into());
    let target = normalize_input(input, &engine).ok_or_else(|| "地址不能为空".to_string())?;
    let target = Url::parse(&target).map_err(|_| "地址不对".to_string())?;
    if allowed(&target, dev_url(app).as_ref()) {
        Ok(target)
    } else {
        Err(REFUSED.into())
    }
}

fn open(app: &AppHandle, id: &str, url: &str, rect: Rect) -> Result<(), String> {
    let label = label_for(id)?;
    let (pos, size) = clamp(rect);
    // A second open for the same id: the UI came back to the page. Show it where it is now, no reload.
    if let Some(w) = app.get_webview(&label) {
        w.set_position(pos).map_err(|e| e.to_string())?;
        w.set_size(size).map_err(|e| e.to_string())?;
        return w.show().map_err(|e| e.to_string());
    }
    // A new tab (empty or about:blank) starts on `browser.homePage` when one is set.
    let input = if url.trim().is_empty() || url.trim() == "about:blank" {
        config_str("/browser/homePage").unwrap_or_else(|| "about:blank".into())
    } else {
        url.to_string()
    };
    let target = parse_target(app, &input)?;
    if panels(app).len() >= MAX_PANELS {
        return Err(format!("内置浏览器最多同时打开 {MAX_PANELS} 个页面"));
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    let clear_first = pending_marker(app).is_some_and(|p| p.exists());
    let first_url = if clear_first {
        Url::parse("about:blank").expect("valid url")
    } else {
        target.clone()
    };
    let w = window
        .add_child(builder(app, id, &label, first_url), pos, size)
        .map_err(|e| {
            logging::warn("browser", "panel failed", json!({ "error": e.to_string() }));
            format!("无法打开内置浏览器：{e}")
        })?;
    if clear_first {
        let _ = w.clear_all_browsing_data();
        if let Some(p) = pending_marker(app) {
            let _ = std::fs::remove_file(p);
        }
        logging::info("browser", "pending browsing data cleared", Value::Null);
        let _ = w.navigate(target.clone());
    }
    logging::info(
        "browser",
        "panel opened",
        json!({ "id": id, "origin": crate::net::origin(target.as_str()), "panels": panels(app).len(), "store": store_kind() }),
    );
    Ok(())
}

/// The main window went to the background: nothing to do (WebKit and WebView2 throttle hidden pages).
pub fn on_main_hidden(_app: &AppHandle) {}

/// `browser.clearOnExit`: browsing data goes now (open panels) or when the next panel opens.
pub fn on_exit(app: &AppHandle) {
    if !crate::config::native().browser_clear_on_exit {
        return;
    }
    let open = panels(app);
    for w in &open {
        let _ = w.clear_all_browsing_data();
    }
    if open.is_empty() {
        mark_pending(app);
    }
    logging::info(
        "browser",
        "browsing data cleared on exit",
        json!({ "panels": open.len() }),
    );
}

fn mark_pending(app: &AppHandle) {
    if let Some(p) = pending_marker(app) {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(p, b"1");
    }
}

/// The panels' cookies, cache and storage. Returns the bytes they took.
pub async fn clear_data(app: &AppHandle) -> Result<u64, String> {
    let dir = data_dir(app);
    let bytes = dir
        .as_deref()
        .map(|d| crate::resources::dir_size(d, 50_000))
        .unwrap_or(0);
    let open = panels(app);
    for w in &open {
        w.clear_all_browsing_data().map_err(|e| e.to_string())?;
    }
    if open.is_empty() {
        #[cfg(not(target_os = "macos"))]
        if let Some(d) = &dir {
            let _ = std::fs::remove_dir_all(d);
        }
        #[cfg(target_os = "macos")]
        if dir.is_some() {
            // macOS 14+: the store under ~/Library/WebKit/<bundle id>/ goes through WebKit itself.
            match remove_mac_store(app).await {
                Ok(()) => {
                    logging::info(
                        "browser",
                        "browser data store removed",
                        json!({ "bytes": bytes }),
                    );
                    return Ok(bytes);
                }
                Err(e) => logging::info(
                    "browser",
                    "browser data store busy, cleared on next open",
                    json!({ "error": e }),
                ),
            }
        }
        // Still there (or busy): cleared before the next panel loads anything.
        mark_pending(app);
    }
    Ok(bytes)
}

/// Deletes the panels' WKWebsiteDataStore (macOS 14+). WebKit refuses while a webview still
/// uses it.
#[cfg(target_os = "macos")]
async fn remove_mac_store(app: &AppHandle) -> Result<(), String> {
    if macos_major() < 14 {
        return Err("no persistent store before macOS 14".into());
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    app.run_on_main_thread(move || {
        let Some(mtm) = objc2::MainThreadMarker::new() else {
            let _ = tx.send(Err("not on the main thread".into()));
            return;
        };
        let id = objc2_foundation::NSUUID::from_bytes(DATA_STORE_ID);
        let tx = std::sync::Mutex::new(Some(tx));
        let done = block2::RcBlock::new(move |err: *mut objc2_foundation::NSError| {
            let r = if err.is_null() {
                Ok(())
            } else {
                Err(format!("WebKit error {}", unsafe { (*err).code() }))
            };
            if let Some(tx) = tx.lock().ok().and_then(|mut g| g.take()) {
                let _ = tx.send(r);
            }
        });
        unsafe {
            objc2_web_kit::WKWebsiteDataStore::removeDataStoreForIdentifier_completionHandler(
                &id, &done, mtm,
            );
        }
    })
    .map_err(|e| e.to_string())?;
    match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(r)) => r,
        _ => Err("WebKit did not answer".into()),
    }
}

// ---------------------------------------------------------------------------
// Commands (async: webview calls from a synchronous command can deadlock on Windows)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    id: String,
    url: String,
    rect: Rect,
) -> Result<(), String> {
    open(&app, &id, &url, rect)
}

#[tauri::command]
pub async fn browser_set_bounds(app: AppHandle, id: String, rect: Rect) -> Result<(), String> {
    let w = panel(&app, &id)?;
    let (pos, size) = clamp(rect);
    w.set_position(pos).map_err(|e| e.to_string())?;
    w.set_size(size).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, id: String, op: NavOp) -> Result<(), String> {
    let w = panel(&app, &id)?;
    if let Some(input) = op.url.as_deref() {
        let target = parse_target(&app, input)?;
        return w.navigate(target).map_err(|e| e.to_string());
    }
    let js = if op.back == Some(true) {
        "history.back()"
    } else if op.forward == Some(true) {
        "history.forward()"
    } else if op.stop == Some(true) {
        "window.stop()"
    } else if op.reload == Some(true) {
        return w.reload().map_err(|e| e.to_string());
    } else {
        return Ok(());
    };
    w.eval(js).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_set_visible(app: AppHandle, id: String, visible: bool) -> Result<(), String> {
    let w = panel(&app, &id)?;
    if visible { w.show() } else { w.hide() }.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, id: String) -> Result<(), String> {
    let Ok(w) = panel(&app, &id) else {
        return Ok(());
    };
    w.close().map_err(|e| e.to_string())?;
    logging::info("browser", "panel closed", json!({ "id": id }));
    Ok(())
}

#[tauri::command]
pub async fn browser_list(app: AppHandle) -> Vec<PanelInfo> {
    panels(&app)
        .into_iter()
        .map(|w| PanelInfo {
            id: w.label().trim_start_matches(PREFIX).to_string(),
            url: w.url().map(|u| u.to_string()).unwrap_or_default(),
        })
        .collect()
}

#[tauri::command]
pub async fn browser_clear_data(app: AppHandle) -> Result<u64, String> {
    let bytes = clear_data(&app).await?;
    logging::info(
        "browser",
        "browsing data cleared",
        json!({ "bytes": bytes }),
    );
    Ok(bytes)
}

#[tauri::command]
pub fn browser_store_kind() -> &'static str {
    store_kind()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_http_and_never_the_apps_own_origins() {
        let dev = u("http://localhost:1420/");
        assert!(allowed(&u("https://example.com/a"), Some(&dev)));
        assert!(allowed(&u("http://localhost:3000/"), Some(&dev)));
        assert!(!allowed(&u("http://localhost:1420/index.html"), Some(&dev)));
        assert!(!allowed(&u("https://tauri.localhost/"), None));
        assert!(!allowed(&u("http://ipc.localhost/cmd"), None));
        assert!(!allowed(&u("tauri://localhost/"), None));
        assert!(!allowed(&u("file:///etc/hosts"), None));
        assert!(!allowed(&u("javascript:alert(1)"), None));
        assert!(!allowed(&u("data:text/html,hi"), None));
        assert!(!allowed(&u("about:srcdoc"), None));
        assert!(allowed(&u("about:blank"), None));
    }

    #[test]
    fn address_bar_input() {
        assert_eq!(
            normalize_input("example.com", "bing").unwrap(),
            "https://example.com/"
        );
        assert_eq!(
            normalize_input("localhost:5173", "bing").unwrap(),
            "http://localhost:5173/"
        );
        assert_eq!(
            normalize_input("https://a.example.com/x?y=1", "bing").unwrap(),
            "https://a.example.com/x?y=1"
        );
        assert_eq!(
            normalize_input("rust 异步", "baidu").unwrap(),
            "https://www.baidu.com/s?wd=rust+%E5%BC%82%E6%AD%A5"
        );
        assert!(normalize_input("  ", "bing").is_none());
    }

    #[test]
    fn panel_ids() {
        assert_eq!(label_for("tab-1").unwrap(), "browser-tab-1");
        // The v3 shell's ids.
        assert_eq!(label_for("panel-web").unwrap(), "browser-panel-web");
        assert_eq!(label_for("w:k3x9z").unwrap(), "browser-w:k3x9z");
        assert!(label_for("../x").is_err());
        assert!(label_for("w/x").is_err());
        assert!(label_for("").is_err());
    }

    #[test]
    fn download_names() {
        let dir = std::env::temp_dir().join(format!("hp-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            unique_download_path(&dir, "a/b.txt").file_name().unwrap(),
            "a_b.txt"
        );
        std::fs::write(dir.join("r.zip"), b"x").unwrap();
        assert_eq!(
            unique_download_path(&dir, "r.zip").file_name().unwrap(),
            "r (1).zip"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
