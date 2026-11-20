//! Removes anything shaped like a credential before a line is written to disk,
//! uploaded to the relay or put into a diagnostics bundle. Same patterns as the
//! relay's `redact()` (apps/relay/src/eventlog.ts), plus cookies, pair codes,
//! join/pair links and the user's home folder.

use regex::{Captures, Regex};
use serde_json::Value;
use std::borrow::Cow;
use std::sync::OnceLock;

struct Rules {
    list: Vec<(Regex, &'static str)>,
    home: Option<String>,
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        // `\b` here is `(?-u:\b)`, an ASCII word boundary: Unicode `\b` sees none between
        // Chinese text and a secret written right next to it (配对码MEOW-4821已发).
        let r = |p: &str| {
            Regex::new(&p.replace(r"\b", r"(?-u:\b)")).expect("valid redaction pattern")
        };
        let list = vec![
            (r(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}"), "$1 ***"),
            (r(r"\bhp_[A-Za-z0-9_-]{8,}"), "hp_***"),
            (r(r"\bsk-[A-Za-z0-9_-]{8,}"), "sk-***"),
            // Cookie headers keep only their name.
            (r(r"(?im)\b((?:set-)?cookie\s*:\s*)[^\r\n]+"), "$1***"),
            (
                r(r#"(?i)([?&#](?:token|key|api_key|apikey|secret|password|code|sig|signature|auth)=)[^&\s"']+"#),
                "$1***",
            ),
            (
                r(r#"(?i)("?\b(?:token|deviceToken|accessToken|refreshToken|apiKey|api_key|secret|password|passwd|authorization|adminToken|cookie|cookies|pairCode|encrypted_value)"?\s*[:=]\s*"?)[^"\s,}&]{4,}"#),
                "$1***",
            ),
            // Invite and join links carry the one-time secret in the path.
            (r(r"(/[pj]/)[A-Za-z0-9_-]{4,}"), "$1***"),
            // Pair codes such as MEOW-4821.
            (r(r"\b[A-Z]{4}-\d{4}\b"), "****-****"),
        ];
        let home = std::env::var("HOME")
            .ok()
            .or_else(|| std::env::var("USERPROFILE").ok())
            .filter(|h| h.len() > 3);
        Rules { list, home }
    })
}

/// A copy of `s` with credentials replaced by `***` and the home folder by `~`.
pub fn text(s: &str) -> Cow<'_, str> {
    let rules = rules();
    let mut out: Cow<'_, str> = Cow::Borrowed(s);
    for (re, rep) in &rules.list {
        if re.is_match(&out) {
            out = Cow::Owned(re.replace_all(&out, *rep).into_owned());
        }
    }
    if let Some(home) = &rules.home {
        if out.contains(home.as_str()) {
            out = Cow::Owned(out.replace(home.as_str(), "~"));
        }
    }
    out
}

/// Key names whose value is never kept, whatever it looks like.
pub fn is_secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    const PARTS: [&str; 9] = [
        "token",
        "secret",
        "password",
        "passwd",
        "cookie",
        "authorization",
        "apikey",
        "api_key",
        "paircode",
    ];
    PARTS.iter().any(|p| k.contains(p)) || matches!(k.as_str(), "code" | "auth" | "pin")
}

/// Redacts every string in place, drops secret-named keys' values, and clips strings to `max_chars`.
pub fn value(v: &mut Value, max_chars: usize) {
    match v {
        Value::String(s) => {
            let red = text(s);
            let clipped = clip(&red, max_chars);
            if clipped != *s {
                *s = clipped;
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                value(item, max_chars);
            }
        }
        Value::Object(map) => {
            for (k, item) in map.iter_mut() {
                if is_secret_key(k)
                    && !matches!(item, Value::Bool(_) | Value::Null | Value::Number(_))
                {
                    *item = Value::String("***".into());
                } else {
                    value(item, max_chars);
                }
            }
        }
        _ => {}
    }
}

/// At most `n` characters, with an ellipsis when cut.
pub fn clip(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// One line: whitespace runs collapsed, redacted, clipped.
pub fn line(s: &str, n: usize) -> String {
    static WS: OnceLock<Regex> = OnceLock::new();
    let ws = WS.get_or_init(|| Regex::new(r"\s+").expect("valid whitespace pattern"));
    let one = ws.replace_all(s.trim(), |_: &Captures| " ");
    clip(&text(&one), n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn removes_tokens_and_keys() {
        let s = "auth Bearer abcdefghijklmnop and hp_0123456789abcdef plus sk-abcdefghijkl";
        let r = text(s);
        assert!(!r.contains("abcdefghijklmnop"));
        assert!(r.contains("Bearer ***"));
        assert!(r.contains("hp_***"));
        assert!(r.contains("sk-***"));
    }

    #[test]
    fn removes_query_and_json_secrets() {
        let r = text(
            r#"wss://relay.example.com/v1/ws?token=hp_secret123456&x=1 {"token":"abcdef123456","name":"ok"}"#,
        );
        assert!(!r.contains("secret123456"));
        assert!(!r.contains("abcdef123456"));
        assert!(r.contains("x=1"));
        assert!(r.contains(r#""name":"ok""#));
    }

    #[test]
    fn removes_cookies_pair_codes_and_links() {
        let r = text("Cookie: SID=abc; HSID=def\nnext line");
        assert_eq!(r, "Cookie: ***\nnext line");
        assert_eq!(text("code MEOW-4821 expires"), "code ****-**** expires");
        assert_eq!(
            text("open https://pocket.example.com/p/MEOW-4821"),
            "open https://pocket.example.com/p/***"
        );
        assert_eq!(
            text("join https://pocket.example.com/j/abcdEFGH1234"),
            "join https://pocket.example.com/j/***"
        );
    }

    #[test]
    fn secrets_glued_to_chinese_are_masked() {
        // One case per rule that needs a word boundary; synthetic values only.
        let cases = [
            (
                "认证Bearer abcdefghijklmnop失败",
                "abcdefghijklmnop",
                "Bearer ***",
            ),
            (
                "认证Basic dXNlcjpwYXNzd29yZA==失败",
                "dXNlcjpwYXNzd29yZA",
                "Basic ***",
            ),
            (
                "令牌hp_TestOnly0123456789已失效",
                "TestOnly0123456789",
                "hp_***",
            ),
            ("密钥sk-abcdefghijkl无效", "abcdefghijkl", "sk-***"),
            (
                "请求头cookie: SID=abc123def456",
                "SID=abc123def456",
                "cookie: ***",
            ),
            ("token=TestOnlyValue42的值", "TestOnlyValue42", "token=***"),
            (
                "设备deviceToken:TestOnlyValue42已存",
                "TestOnlyValue42",
                "deviceToken:***",
            ),
            ("配对码MEOW-4821已发", "MEOW-4821", "****-****"),
        ];
        for (input, secret, marker) in cases {
            let out = text(input);
            assert!(!out.contains(secret), "{secret} left in {out}");
            assert!(out.contains(marker), "{marker} missing in {out}");
        }
        // The Chinese around a pair code stays readable.
        assert_eq!(text("配对码MEOW-4821已发"), "配对码****-****已发");
        // Still no match inside longer ASCII words.
        assert!(matches!(text("ABCDMEOW-48210"), Cow::Borrowed(_)));
        assert!(matches!(text("ask-abcdefghijkl"), Cow::Borrowed(_)));
    }

    #[test]
    fn leaves_ordinary_text() {
        let s = "relay link online after 3 attempts (1200 ms)";
        assert!(matches!(text(s), Cow::Borrowed(_)));
    }

    #[test]
    fn redacts_values_by_key_and_clips() {
        let mut v = json!({
            "token": "plain-looking",
            "cookies": ["a", "b"],
            "count": 3,
            "nested": { "pairCode": "ABCD-1234", "note": "x".repeat(50) },
            "hotkey": "RightAlt",
        });
        value(&mut v, 10);
        assert_eq!(v["token"], "***");
        assert_eq!(v["cookies"], "***");
        assert_eq!(v["count"], 3);
        assert_eq!(v["nested"]["pairCode"], "***");
        assert_eq!(v["nested"]["note"], format!("{}…", "x".repeat(10)));
        assert_eq!(v["hotkey"], "RightAlt", "ordinary keys keep their value");
    }

    #[test]
    fn line_collapses_whitespace() {
        assert_eq!(line("  a\n\tb   c ", 100), "a b c");
        assert_eq!(line("abcdef", 3), "abc…");
    }
}
