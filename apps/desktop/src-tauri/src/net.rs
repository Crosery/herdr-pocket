//! One HTTP client for the native side (log upload, dictation). It uses the OS
//! TLS stack (Security.framework / SChannel) and the system proxy settings.

use std::sync::OnceLock;
use std::time::Duration;

pub const DEMO_SERVER: &str = "demo://local";

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("herdr-pocket-desktop/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(1)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// `https://relay.example.com/` -> `https://relay.example.com`, the form the app stores.
pub fn server_base(server: &str) -> String {
    server.trim().trim_end_matches('/').to_string()
}

/// What the app stores as a relay address, the same rule as `normalizeServer` in
/// src/lib/relay.ts: no trailing slash, https:// when no scheme was given.
pub fn normalize_server(input: &str) -> String {
    let s = server_base(input);
    if s.is_empty() || s == DEMO_SERVER {
        return s;
    }
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        s
    } else {
        format!("https://{s}")
    }
}

/// A server base URL without user info, query or fragment (a pasted pair link or a
/// `?token=` must never travel on to a request URL or the screen).
pub fn clean_base(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut u) if u.has_host() => {
            let _ = u.set_username("");
            let _ = u.set_password(None);
            u.set_query(None);
            u.set_fragment(None);
            u.as_str().trim_end_matches('/').to_string()
        }
        _ => url.to_string(),
    }
}

/// A relay address from a file someone may have edited (hostd.json): scheme added if missing,
/// user info, query and fragment dropped; host, port and path kept (a relay can live under a
/// path). What the page gets to show and pre-fill.
pub fn safe_server(raw: &str) -> String {
    clean_base(&normalize_server(raw))
}

/// `host[:port]` of a URL, for messages shown to the user.
pub fn host_port(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    let h = u.host_str()?;
    Some(match u.port() {
        Some(p) => format!("{h}:{p}"),
        None => h.to_string(),
    })
}

/// The origin of a URL, for logs: no path, query or user info.
pub fn origin(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => match u.host_str() {
            Some(h) => match u.port() {
                Some(p) => format!("{}://{}:{}", u.scheme(), h, p),
                None => format!("{}://{}", u.scheme(), h),
            },
            None => u.scheme().to_string(),
        },
        Err(_) => "invalid".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_base_and_host_port_drop_secrets() {
        let raw = "https://user:pw@127.0.0.1:7499/p/ABCD-2345?token=s3cr3t&pc=ABCD-2345#x";
        assert_eq!(clean_base(raw), "https://127.0.0.1:7499/p/ABCD-2345");
        assert_eq!(
            clean_base("https://pocket.example.com/"),
            "https://pocket.example.com"
        );
        assert_eq!(clean_base("demo://local"), "demo://local");
        assert_eq!(host_port(raw).as_deref(), Some("127.0.0.1:7499"));
        assert_eq!(
            host_port("https://pocket.example.com/relay?token=x").as_deref(),
            Some("pocket.example.com")
        );
        assert_eq!(host_port("not a url"), None);
    }

    #[test]
    fn safe_server_keeps_the_path_only() {
        assert_eq!(
            safe_server(
                "https://user:pw@pocket.example.com:8443/pocket/?token=s3cr3t&pc=ABCD-2345#frag"
            ),
            "https://pocket.example.com:8443/pocket"
        );
        assert_eq!(
            safe_server("pocket.example.com/pocket?token=s3cr3t"),
            "https://pocket.example.com/pocket"
        );
        assert_eq!(
            safe_server("http://127.0.0.1:7461"),
            "http://127.0.0.1:7461"
        );
        assert_eq!(safe_server("demo://local"), "demo://local");
    }

    #[test]
    fn origin_drops_path_and_query() {
        assert_eq!(
            origin("https://user:pw@pocket.example.com:8443/v1/ws?token=x"),
            "https://pocket.example.com:8443"
        );
        assert_eq!(origin("demo://local"), "demo://local");
        assert_eq!(
            server_base(" https://pocket.example.com/ "),
            "https://pocket.example.com"
        );
        assert_eq!(
            normalize_server("pocket.example.com//"),
            "https://pocket.example.com"
        );
        assert_eq!(
            normalize_server("HTTP://127.0.0.1:7461/"),
            "HTTP://127.0.0.1:7461"
        );
        assert_eq!(normalize_server("demo://local"), "demo://local");
    }
}
