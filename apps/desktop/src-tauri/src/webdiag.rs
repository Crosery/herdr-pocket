//! Page diagnostics for the app's own pages: Content Security Policy violations and a page
//! that loaded without rendering anything go to the log file (`app.csp` / `app.render`), so a
//! too-strict CSP or a broken bundle shows up in exported diagnostics instead of a silent
//! blank window. Never runs in the browser panel's remote pages.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// The dev server origin (`build.devUrl` in tauri.conf.json); only trusted in debug builds.
const DEV_ORIGIN: &str = "http://localhost:1420";

/// `version`: the app's own version (tauri.conf.json, what `getVersion()` returns), given to the
/// app's pages as `window.__POCKET_APP_VERSION__` before their scripts run.
/// `local_host_id`: this computer's `hostd.json` deviceId when already present at startup, given
/// as `window.__POCKET_LOCAL_HOST_ID__` so frame-0 renders know this machine synchronously.
fn script(version: &str, local_host_id: Option<&str>) -> String {
    let dev = if cfg!(debug_assertions) {
        DEV_ORIGIN
    } else {
        ""
    };
    let version = serde_json::to_string(version).unwrap_or_else(|_| "\"\"".into());
    let local_host_id_json = serde_json::to_string(&local_host_id).unwrap_or_else(|_| "null".into());
    format!(
        r#"(function () {{
  var own = location.protocol === "tauri:" || location.hostname === "tauri.localhost" || ("{dev}" !== "" && location.origin === "{dev}");
  if (!own) return;
  window.__POCKET_APP_VERSION__ = {version};
  window.__POCKET_LOCAL_HOST_ID__ = {local_host_id_json};
  var budget = 30;
  function log(level, kind, msg, data) {{
    var ipc = window.__TAURI_INTERNALS__;
    if (!ipc || budget-- <= 0) return;
    try {{ ipc.invoke("log_write", {{ level: level, kind: kind, msg: msg, data: data || null }}); }} catch (e) {{}}
  }}
  function origin(u) {{
    try {{ return new URL(u).origin; }} catch (e) {{ return String(u || "").slice(0, 20); }}
  }}
  document.addEventListener("securitypolicyviolation", function (e) {{
    log("error", "app.csp", "content security policy blocked " + e.effectiveDirective, {{
      directive: e.effectiveDirective,
      blocked: origin(e.blockedURI),
      source: String(e.sourceFile || "").split("/").pop(),
      line: e.lineNumber
    }});
  }});
  window.addEventListener("load", function () {{
    setTimeout(function () {{
      var root = document.getElementById("root");
      if (!root) return;
      if (root.childElementCount) log("debug", "app.render", "page rendered", {{ path: location.pathname, version: window.__POCKET_APP_VERSION__ || null }});
      else log("error", "app.render", "page loaded but nothing rendered", {{ path: location.pathname }});
    }}, 5000);
  }});
}})();"#
    )
}

pub fn plugin<R: Runtime>(version: &str, local_host_id: Option<&str>) -> TauriPlugin<R> {
    Builder::new("pocket-diag")
        .js_init_script(script(version, local_host_id))
        .build()
}
