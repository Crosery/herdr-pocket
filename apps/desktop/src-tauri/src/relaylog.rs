//! Uploads queued log lines to the relay (POST /v1/logs with the device token),
//! every minute and when the app quits, like apps/mobile/src/lib/applog.ts.

use crate::logging;
use crate::net;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::{Mutex, Notify};

const EVERY: Duration = Duration::from_secs(60);
const BATCH: usize = 200;

/// An older relay without /v1/logs: stop until the app restarts.
static UNSUPPORTED: AtomicBool = AtomicBool::new(false);

fn wake() -> &'static Notify {
    static N: OnceLock<Notify> = OnceLock::new();
    N.get_or_init(Notify::new)
}

fn busy() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// Asks the background task to upload now.
pub fn upload_soon() {
    wake().notify_one();
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(EVERY) => {}
                _ = wake().notified() => {}
            }
            upload(&app).await;
        }
    });
}

/// Sends everything queued; returns how many lines the relay kept.
pub async fn upload(app: &AppHandle) -> usize {
    if UNSUPPORTED.load(Ordering::Relaxed)
        || !logging::upload_enabled()
        || logging::relay_queue_len() == 0
    {
        return 0;
    }
    let _guard = busy().lock().await;
    let Some(session) = crate::read_session(app) else {
        return 0;
    };
    if session.server == net::DEMO_SERVER || session.token.is_empty() {
        // The demo has no relay to keep lines: the newest are enough.
        logging::trim_relay_queue(BATCH);
        return 0;
    }
    let url = format!("{}/v1/logs", net::server_base(&session.server));
    let mut stored = 0usize;
    loop {
        let batch = logging::take_relay_batch(BATCH);
        if batch.is_empty() {
            break;
        }
        let res = net::client()
            .post(&url)
            .bearer_auth(&session.token)
            .timeout(Duration::from_secs(15))
            .json(&serde_json::json!({ "entries": batch }))
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => {
                stored += r
                    .json::<serde_json::Value>()
                    .await
                    .ok()
                    .and_then(|v| v.get("stored").and_then(|s| s.as_u64()))
                    .unwrap_or(0) as usize;
            }
            Ok(r) if r.status().as_u16() == 404 => {
                UNSUPPORTED.store(true, Ordering::Relaxed);
                break;
            }
            // 5xx and network trouble: try again later. Other 4xx: the relay will not take these lines.
            Ok(r) if r.status().is_server_error() => {
                logging::requeue(batch);
                break;
            }
            Ok(_) => break,
            Err(_) => {
                logging::requeue(batch);
                break;
            }
        }
    }
    stored
}

/// Last upload on quit, bounded so quitting never hangs.
pub fn upload_blocking(app: &AppHandle, limit: Duration) {
    let app = app.clone();
    let _ =
        tauri::async_runtime::block_on(
            async move { tokio::time::timeout(limit, upload(&app)).await },
        );
}
