//! Cookie import from the person's installed Chromium browsers into the
//! built-in browser panel, so sites they are signed in to stay signed in.
//!
//! Only on request, per browser profile and per domain. The Cookies database
//! is copied to a private temp folder and read there; values are decrypted in
//! memory and handed straight to the panel's webview (`set_cookie`). Names and
//! values are never logged, stored elsewhere or sent anywhere; logs carry
//! counts only.
//!
//! macOS: AES-128-CBC with a key derived from the browser's Keychain item
//! ("Chrome Safe Storage" etc.); macOS asks the person to allow that access.
//! Windows: AES-256-GCM with the DPAPI-protected key in "Local State" (v10/v11).
//! Values with Chrome's app-bound encryption ("v20", Chrome 127+ on Windows) can
//! only be unwrapped by the browser's own SYSTEM service; they are skipped and
//! counted.

#[cfg(any(target_os = "macos", windows))]
mod sqlite;

use crate::logging;
use serde::Serialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Folder name (`Default`, `Profile 1`): what `cookie_domains` / `cookie_import` take.
    pub id: String,
    /// The name the browser shows.
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: &'static str,
    pub name: &'static str,
    pub profiles: Vec<Profile>,
    /// Import can work at all for this browser here.
    pub importable: bool,
    /// Chinese, shown next to the browser (prompts, limits).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainCount {
    pub domain: String,
    pub count: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: usize,
    pub expired: usize,
    /// Session cookies (no expiry), skipped unless asked for.
    pub session: usize,
    /// Windows app-bound encryption (v20): cannot be read by other programs.
    pub app_bound: usize,
    pub failed: usize,
    pub domains: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

struct Browser {
    id: &'static str,
    name: &'static str,
    /// User-data folder, relative to ~/Library/Application Support (macOS) or %LOCALAPPDATA% (Windows).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    mac_dir: &'static str,
    #[cfg_attr(not(windows), allow(dead_code))]
    win_dir: &'static str,
    /// Keychain service and account (macOS).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    keychain: (&'static str, &'static str),
}

const BROWSERS: &[Browser] = &[
    Browser {
        id: "chrome",
        name: "Google Chrome",
        mac_dir: "Google/Chrome",
        win_dir: r"Google\Chrome\User Data",
        keychain: ("Chrome Safe Storage", "Chrome"),
    },
    Browser {
        id: "edge",
        name: "Microsoft Edge",
        mac_dir: "Microsoft Edge",
        win_dir: r"Microsoft\Edge\User Data",
        keychain: ("Microsoft Edge Safe Storage", "Microsoft Edge"),
    },
    Browser {
        id: "brave",
        name: "Brave",
        mac_dir: "BraveSoftware/Brave-Browser",
        win_dir: r"BraveSoftware\Brave-Browser\User Data",
        keychain: ("Brave Safe Storage", "Brave"),
    },
    Browser {
        id: "arc",
        name: "Arc",
        mac_dir: "Arc/User Data",
        win_dir: "",
        keychain: ("Arc Safe Storage", "Arc"),
    },
    Browser {
        id: "chromium",
        name: "Chromium",
        mac_dir: "Chromium",
        win_dir: r"Chromium\User Data",
        keychain: ("Chromium Safe Storage", "Chromium"),
    },
    Browser {
        id: "vivaldi",
        name: "Vivaldi",
        mac_dir: "Vivaldi",
        win_dir: r"Vivaldi\User Data",
        keychain: ("Vivaldi Safe Storage", "Vivaldi"),
    },
];

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn user_data_dir(b: &Browser) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return home()
            .map(|h| h.join("Library/Application Support").join(b.mac_dir))
            .filter(|p| p.is_dir());
    }
    #[cfg(windows)]
    {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
        if b.id == "arc" {
            // Arc for Windows is an MSIX package: %LOCALAPPDATA%\Packages\TheBrowserCompany.Arc_<hash>\LocalCache\Local\Arc\User Data
            let packages = local.join("Packages");
            return std::fs::read_dir(packages).ok()?.flatten().find_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let p = e.path().join(r"LocalCache\Local\Arc\User Data");
                (name.starts_with("TheBrowserCompany.Arc") && p.is_dir()).then_some(p)
            });
        }
        return Some(local.join(b.win_dir)).filter(|p| p.is_dir());
    }
    #[allow(unreachable_code)]
    {
        let _ = (b, home());
        None
    }
}

/// Where a profile keeps its cookies (Chrome 96+ moved them under Network/).
fn cookies_file(profile_dir: &Path) -> Option<PathBuf> {
    [
        profile_dir.join("Network").join("Cookies"),
        profile_dir.join("Cookies"),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

fn profiles(user_data: &Path) -> Vec<Profile> {
    let names: BTreeMap<String, String> = std::fs::read_to_string(user_data.join("Local State"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.pointer("/profile/info_cache")
                .and_then(|c| c.as_object())
                .cloned()
        })
        .map(|m| {
            m.into_iter()
                .filter_map(|(dir, info)| {
                    info.get("name")
                        .and_then(|n| n.as_str())
                        .map(|n| (dir, n.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut out: Vec<Profile> = std::fs::read_dir(user_data)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let id = e.file_name().to_string_lossy().into_owned();
                    let is_profile = id == "Default" || id.starts_with("Profile ");
                    (is_profile && cookies_file(&e.path()).is_some()).then(|| Profile {
                        name: names.get(&id).cloned().unwrap_or_else(|| id.clone()),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| (a.id != "Default", &a.id).cmp(&(b.id != "Default", &b.id)));
    out
}

pub fn sources() -> Vec<Source> {
    let mut out = Vec::new();
    for b in BROWSERS {
        let Some(dir) = user_data_dir(b) else {
            continue;
        };
        let profiles = profiles(&dir);
        if profiles.is_empty() {
            continue;
        }
        let note = if cfg!(target_os = "macos") {
            Some(format!(
                "导入时 macOS 会询问是否允许访问「{}」钥匙串项目，请点「允许」",
                b.keychain.0
            ))
        } else if matches!(b.id, "chrome" | "brave" | "edge") {
            Some("导入前请先完全退出这个浏览器。新版 Chrome 等在 Windows 上使用「应用绑定加密」，这类 Cookie 无法导入，请在内置浏览器里直接登录".into())
        } else {
            Some("导入前请先完全退出这个浏览器".into())
        };
        out.push(Source {
            id: b.id,
            name: b.name,
            profiles,
            importable: cfg!(any(target_os = "macos", windows)),
            note,
        });
    }
    #[cfg(target_os = "macos")]
    if home().is_some_and(|h| h.join("Library/Containers/com.apple.Safari").exists()) {
        out.push(Source {
            id: "safari",
            name: "Safari",
            profiles: Vec::new(),
            importable: false,
            note: Some(
                "Safari 的 Cookie 只有获得「完全磁盘访问权限」才能读取，暂不支持导入".into(),
            ),
        });
    }
    out
}

fn browser(id: &str) -> Result<&'static Browser, String> {
    BROWSERS
        .iter()
        .find(|b| b.id == id)
        .ok_or_else(|| format!("不支持从 {id} 导入"))
}

/// `.github.com` and `github.com` count as the same site.
pub fn base_domain(host_key: &str) -> String {
    host_key.trim_start_matches('.').to_ascii_lowercase()
}

/// The cookie belongs to one of the `wanted` sites: the same host, a host below it
/// (`api.github.com` for `github.com`), or a domain cookie the site receives
/// (`.github.com` for `www.github.com`). `*` takes every cookie.
pub fn domain_matches(host_key: &str, wanted: &[String]) -> bool {
    let h = base_domain(host_key);
    let domain_cookie = host_key.starts_with('.');
    wanted.iter().any(|w| {
        if w == "*" {
            return true;
        }
        let w = base_domain(w);
        !w.is_empty()
            && (h == w
                || h.ends_with(&format!(".{w}"))
                || (domain_cookie && h.contains('.') && w.ends_with(&format!(".{h}"))))
    })
}

/// Chromium's `expires_utc`: microseconds since 1601-01-01; 0 means a session cookie.
pub fn chrome_time_to_unix(us: i64) -> Option<i64> {
    if us <= 0 {
        return None;
    }
    Some(us / 1_000_000 - 11_644_473_600)
}

/// Removes the SHA-256(host) prefix Chromium adds to plaintexts since cookie DB version 24.
pub fn strip_host_hash(plain: Vec<u8>, host_key: &str, db_version: i64) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    if db_version >= 24
        && plain.len() >= 32
        && plain[..32] == Sha256::digest(host_key.as_bytes())[..]
    {
        plain[32..].to_vec()
    } else {
        plain
    }
}

/// macOS: AES-128-CBC, IV of 16 spaces, key = PBKDF2-HMAC-SHA1(password, "saltysalt", 1003).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_key(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1003, &mut key);
    key
}

pub fn decrypt_cbc(key: &[u8; 16], value: &[u8]) -> Option<Vec<u8>> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let body = value.strip_prefix(b"v10")?;
    let iv = [b' '; 16];
    cbc::Decryptor::<aes::Aes128>::new(key.into(), &iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(body)
        .ok()
}

/// Windows v10/v11: 12-byte nonce, then ciphertext and the 16-byte tag.
pub fn decrypt_gcm(key: &[u8; 32], value: &[u8]) -> Option<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit};
    let body = value
        .strip_prefix(b"v10")
        .or_else(|| value.strip_prefix(b"v11"))?;
    if body.len() < 12 + 16 {
        return None;
    }
    let (nonce, ct) = body.split_at(12);
    let cipher = aes_gcm::Aes256Gcm::new(key.into());
    cipher.decrypt(aes_gcm::Nonce::from_slice(nonce), ct).ok()
}

/// Standard base64 (for "Local State"); small enough not to need a crate.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b'\r' | b'\n' | b' ' => continue,
            _ => return None,
        };
        buf = (buf << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// One decrypted cookie, ready for the webview.
pub struct Plain {
    pub host_key: String,
    pub name: String,
    pub value: String,
    pub path: String,
    pub expires: Option<i64>,
    pub secure: bool,
    pub http_only: bool,
    /// -1 unspecified, 0 none, 1 lax, 2 strict (Chromium's values).
    pub same_site: i64,
}

#[cfg(any(target_os = "macos", windows))]
mod read {
    use super::*;

    /// Copies Cookies (+ -wal / -journal) into a fresh temp folder that is removed on drop.
    pub struct Copy {
        pub dir: PathBuf,
        pub db: PathBuf,
    }

    impl Drop for Copy {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    pub fn copy_db(src: &Path, browser_name: &str) -> Result<Copy, String> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "herdr-pocket-cookies-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        let copy = Copy {
            db: dir.join("Cookies"),
            dir,
        };
        if let Err(e) = std::fs::copy(src, &copy.db) {
            // Windows: ERROR_SHARING_VIOLATION while the browser has the file open.
            return Err(if e.raw_os_error() == Some(32) {
                format!("{browser_name} 正在运行，请先完全退出它（包括后台），再导入")
            } else {
                format!("无法读取 {browser_name} 的 Cookie：{e}")
            });
        }
        for ext in ["-wal", "-journal"] {
            let side = PathBuf::from(format!("{}{ext}", src.display()));
            if side.is_file() {
                let _ = std::fs::copy(&side, copy.dir.join(format!("Cookies{ext}")));
            }
        }
        Ok(copy)
    }

    pub fn open(
        browser_id: &str,
        profile: &str,
    ) -> Result<(&'static Browser, PathBuf, Copy), String> {
        let b = browser(browser_id)?;
        let ud = user_data_dir(b).ok_or_else(|| format!("没有找到 {}", b.name))?;
        if profile.contains(['/', '\\']) || profile.contains("..") {
            return Err("配置文件名称不对".into());
        }
        let file = cookies_file(&ud.join(profile))
            .ok_or_else(|| format!("{} 的「{profile}」里没有 Cookie", b.name))?;
        let copy = copy_db(&file, b.name)?;
        Ok((b, ud, copy))
    }

    pub fn domains(browser_id: &str, profile: &str) -> Result<Vec<DomainCount>, String> {
        let (_, _, copy) = open(browser_id, profile)?;
        let db = sqlite::Db::open(&copy.db)?;
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        db.prepare("SELECT host_key FROM cookies")?.each(|r| {
            *counts.entry(base_domain(&r.text(0))).or_default() += 1;
        })?;
        let mut out: Vec<DomainCount> = counts
            .into_iter()
            .map(|(domain, count)| DomainCount { domain, count })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.domain.cmp(&b.domain)));
        out.truncate(1000);
        Ok(out)
    }

    fn db_version(db: &sqlite::Db) -> i64 {
        let mut v = 0;
        if let Ok(mut st) = db.prepare("SELECT value FROM meta WHERE key = 'version'") {
            let _ = st.each(|r| v = r.text(0).parse().unwrap_or(0));
        }
        v
    }

    #[cfg(target_os = "macos")]
    fn key_for(b: &Browser, _user_data: &Path) -> Result<Key, String> {
        match security_framework::passwords::get_generic_password(b.keychain.0, b.keychain.1) {
            Ok(pw) => Ok(Key::Cbc(mac_key(&pw))),
            Err(e) => Err(match e.code() {
                -128 | -25293 => "你在钥匙串弹窗里没有允许访问，导入已取消".to_string(),
                -25300 => format!(
                    "钥匙串里没有「{}」，请先打开一次 {} 再试",
                    b.keychain.0, b.name
                ),
                code => format!("无法读取钥匙串（{code}）"),
            }),
        }
    }

    #[cfg(windows)]
    fn key_for(b: &Browser, user_data: &Path) -> Result<Key, String> {
        let state = std::fs::read_to_string(user_data.join("Local State"))
            .map_err(|e| format!("无法读取 {} 的 Local State：{e}", b.name))?;
        let v: serde_json::Value =
            serde_json::from_str(&state).map_err(|_| "Local State 格式不对".to_string())?;
        let enc = v
            .pointer("/os_crypt/encrypted_key")
            .and_then(|k| k.as_str())
            .ok_or_else(|| "Local State 里没有密钥".to_string())?;
        let raw = base64_decode(enc).ok_or_else(|| "密钥格式不对".to_string())?;
        let body = raw
            .strip_prefix(b"DPAPI")
            .ok_or_else(|| "密钥格式不对".to_string())?;
        let key = dpapi_unprotect(body).ok_or_else(|| "Windows 无法解开浏览器密钥".to_string())?;
        let key: [u8; 32] = key.try_into().map_err(|_| "密钥长度不对".to_string())?;
        Ok(Key::Gcm(key))
    }

    #[cfg(windows)]
    pub fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
        unsafe {
            let input = CRYPT_INTEGER_BLOB {
                cbData: data.len() as u32,
                pbData: data.as_ptr() as *mut u8,
            };
            let mut output = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: std::ptr::null_mut(),
            };
            let ok = CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut output,
            );
            if ok == 0 || output.pbData.is_null() {
                return None;
            }
            let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            LocalFree(output.pbData as _);
            Some(out)
        }
    }

    pub enum Key {
        #[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
        Cbc([u8; 16]),
        #[cfg_attr(not(any(windows, test)), allow(dead_code))]
        Gcm([u8; 32]),
    }

    /// One row of Chromium's `cookies` table, still encrypted.
    pub struct Raw {
        host: String,
        name: String,
        value: String,
        enc: Vec<u8>,
        path: String,
        expires_utc: i64,
        secure: bool,
        http_only: bool,
        same_site: i64,
    }

    /// The rows of a (copied) Cookies database for `wanted`, and its schema version.
    pub fn query(db_path: &Path, wanted: &[String]) -> Result<(i64, Vec<Raw>), String> {
        let db = sqlite::Db::open(db_path)?;
        let version = db_version(&db);
        let mut rows = Vec::new();
        db.prepare("SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies")?
            .each(|r| {
                let host = r.text(0);
                if domain_matches(&host, wanted) {
                    rows.push(Raw {
                        host,
                        name: r.text(1),
                        value: r.text(2),
                        enc: r.blob(3),
                        path: r.text(4),
                        expires_utc: r.int(5),
                        secure: r.int(6) != 0,
                        http_only: r.int(7) != 0,
                        same_site: r.int(8),
                    });
                }
            })?;
        Ok((version, rows))
    }

    /// Reads and decrypts the profile's cookies for `wanted` domains.
    pub fn read(
        browser_id: &str,
        profile: &str,
        wanted: &[String],
        include_session: bool,
        result: &mut ImportResult,
    ) -> Result<Vec<Plain>, String> {
        let (b, user_data, copy) = open(browser_id, profile)?;
        let (version, rows) = query(&copy.db, wanted)?;
        // The copy goes before the Keychain prompt, which can wait on the person.
        drop(copy);
        let now = chrono::Utc::now().timestamp();
        decrypt(
            rows,
            version,
            include_session,
            now,
            || key_for(b, &user_data),
            result,
        )
    }

    /// Skips expired (and, unless asked, session) cookies, then decrypts the rest.
    /// `key` is only called when some value is encrypted.
    pub fn decrypt(
        rows: Vec<Raw>,
        version: i64,
        include_session: bool,
        now: i64,
        key: impl FnOnce() -> Result<Key, String>,
        result: &mut ImportResult,
    ) -> Result<Vec<Plain>, String> {
        let mut keep = Vec::new();
        for r in rows {
            match chrome_time_to_unix(r.expires_utc) {
                Some(t) if t <= now => result.expired += 1,
                None if !include_session => result.session += 1,
                _ => keep.push(r),
            }
        }
        if keep.is_empty() {
            return Ok(Vec::new());
        }
        let needs_key = keep
            .iter()
            .any(|r| r.value.is_empty() && !r.enc.is_empty() && !r.enc.starts_with(b"v20"));
        let key = if needs_key { Some(key()?) } else { None };
        let mut out = Vec::new();
        for r in keep {
            let Raw {
                host,
                name,
                value,
                enc,
                path,
                expires_utc,
                secure,
                http_only,
                same_site,
            } = r;
            let expires = chrome_time_to_unix(expires_utc);
            let value = if !value.is_empty() || enc.is_empty() {
                value
            } else if enc.starts_with(b"v20") {
                result.app_bound += 1;
                continue;
            } else {
                let plain = match &key {
                    Some(Key::Cbc(k)) => decrypt_cbc(k, &enc),
                    Some(Key::Gcm(k)) => decrypt_gcm(k, &enc),
                    None => None,
                };
                #[cfg(windows)]
                let plain = plain.or_else(|| {
                    (!enc.starts_with(b"v1"))
                        .then(|| dpapi_unprotect(&enc))
                        .flatten()
                });
                match plain
                    .map(|p| strip_host_hash(p, &host, version))
                    .and_then(|p| String::from_utf8(p).ok())
                {
                    Some(v) => v,
                    None => {
                        result.failed += 1;
                        continue;
                    }
                }
            };
            out.push(Plain {
                host_key: host,
                name,
                value,
                path,
                expires,
                secure,
                http_only,
                same_site,
            });
        }
        Ok(out)
    }
}

pub fn domains(browser_id: &str, profile: &str) -> Result<Vec<DomainCount>, String> {
    #[cfg(any(target_os = "macos", windows))]
    {
        read::domains(browser_id, profile)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (browser_id, profile);
        Err("这个系统暂不支持导入 Cookie".into())
    }
}

fn to_cookie(p: Plain) -> tauri::webview::Cookie<'static> {
    let mut b = cookie::Cookie::build((p.name, p.value))
        .domain(p.host_key)
        .path(if p.path.is_empty() {
            "/".to_string()
        } else {
            p.path
        })
        .secure(p.secure)
        .http_only(p.http_only);
    b = match p.same_site {
        0 => b.same_site(cookie::SameSite::None),
        1 => b.same_site(cookie::SameSite::Lax),
        2 => b.same_site(cookie::SameSite::Strict),
        _ => b,
    };
    if let Some(t) = p
        .expires
        .and_then(|t| cookie::time::OffsetDateTime::from_unix_timestamp(t).ok())
    {
        b = b.expires(t);
    }
    b.build()
}

/// Reads, decrypts and puts the cookies into the browser panel. Blocking: run off the main thread.
pub fn import(
    app: &tauri::AppHandle,
    browser_id: &str,
    profile: &str,
    wanted: Vec<String>,
    include_session: bool,
) -> Result<ImportResult, String> {
    if crate::config::native().browser_cookie_import == "off" {
        return Err("设置里关闭了从其他浏览器导入 Cookie".into());
    }
    let wanted: Vec<String> = wanted
        .into_iter()
        .map(|w| {
            if w.trim() == "*" {
                "*".to_string()
            } else {
                base_domain(w.trim())
            }
        })
        .filter(|w| !w.is_empty())
        .collect();
    if wanted.is_empty() {
        return Err("请至少选择一个网站".into());
    }
    let webview = crate::browser::webview(app).ok_or_else(|| "请先打开内置浏览器".to_string())?;
    let mut result = ImportResult {
        domains: wanted.len(),
        ..Default::default()
    };
    logging::info(
        "cookie",
        "cookie import started",
        json!({ "browser": browser_id, "domains": wanted.len(), "all": wanted.iter().any(|w| w == "*"), "includeSession": include_session }),
    );
    #[cfg(any(target_os = "macos", windows))]
    let plains = read::read(browser_id, profile, &wanted, include_session, &mut result);
    #[cfg(not(any(target_os = "macos", windows)))]
    let plains: Result<Vec<Plain>, String> = {
        let _ = (profile, include_session);
        Err("这个系统暂不支持导入 Cookie".into())
    };
    let plains = match plains {
        Ok(p) => p,
        Err(e) => {
            logging::warn(
                "cookie",
                "cookie import failed",
                json!({ "browser": browser_id, "error": e }),
            );
            return Err(e);
        }
    };
    for p in plains {
        match webview.set_cookie(to_cookie(p)) {
            Ok(()) => result.imported += 1,
            Err(_) => result.failed += 1,
        }
    }
    if result.app_bound > 0 {
        result.note = Some(format!("有 {} 个 Cookie 使用了浏览器的应用绑定加密，无法导入；这些网站请在内置浏览器里重新登录", result.app_bound));
    } else if result.imported == 0 && result.failed == 0 {
        result.note = Some("所选网站在这个浏览器里没有有效的 Cookie".into());
    }
    logging::info(
        "cookie",
        "cookie import done",
        json!({ "browser": browser_id, "imported": result.imported, "expired": result.expired, "session": result.session, "appBound": result.app_bound, "failed": result.failed, "domains": result.domains }),
    );
    Ok(result)
}

#[tauri::command]
pub async fn cookie_sources() -> Vec<Source> {
    tauri::async_runtime::spawn_blocking(sources)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub async fn cookie_domains(browser: String, profile: String) -> Result<Vec<DomainCount>, String> {
    tauri::async_runtime::spawn_blocking(move || domains(&browser, &profile))
        .await
        .map_err(|e| e.to_string())?
}

/// Must stay async: set_cookie deadlocks in a synchronous command on Windows (wry#583).
/// `domains`: the sites to bring over (`*` for all); session cookies only with `includeSession`.
#[tauri::command]
pub async fn cookie_import(
    app: tauri::AppHandle,
    browser: String,
    profile: String,
    domains: Vec<String>,
    include_session: Option<bool>,
) -> Result<ImportResult, String> {
    let include_session = include_session.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        import(&app, &browser, &profile, domains, include_session)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_cbc_round_trip_with_host_hash() {
        use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        use sha2::{Digest, Sha256};
        let key = mac_key(b"peanuts");
        let host = ".example.com";
        let mut plain = Sha256::digest(host.as_bytes()).to_vec();
        plain.extend_from_slice(b"session-value");
        let ct = cbc::Encryptor::<aes::Aes128>::new((&key).into(), &[b' '; 16].into())
            .encrypt_padded_vec_mut::<Pkcs7>(&plain);
        let mut enc = b"v10".to_vec();
        enc.extend_from_slice(&ct);
        let out = decrypt_cbc(&key, &enc).unwrap();
        assert_eq!(strip_host_hash(out.clone(), host, 24), b"session-value");
        // Older databases have no prefix: nothing is stripped.
        assert_eq!(strip_host_hash(out, host, 23).len(), 32 + 13);
        assert!(decrypt_cbc(&key, b"v11abc").is_none());
    }

    #[test]
    fn known_pbkdf2_key() {
        // Reference: Python hashlib.pbkdf2_hmac("sha1", b"peanuts", b"saltysalt", 1003, 16).
        // (Chromium on Linux uses 1 iteration, giving the better-known fd621fe5…; macOS uses 1003.)
        assert_eq!(
            mac_key(b"peanuts"),
            [
                0xd9, 0xa0, 0x9d, 0x49, 0x9b, 0x4e, 0x1b, 0x74, 0x61, 0xf2, 0x8e, 0x67, 0x97, 0x2c,
                0x6d, 0xbd
            ]
        );
    }

    #[test]
    fn windows_gcm_round_trip() {
        use aes_gcm::aead::{Aead, KeyInit};
        let key = [7u8; 32];
        let nonce = [9u8; 12];
        let ct = aes_gcm::Aes256Gcm::new((&key).into())
            .encrypt(aes_gcm::Nonce::from_slice(&nonce), b"abc".as_ref())
            .unwrap();
        let mut enc = b"v10".to_vec();
        enc.extend_from_slice(&nonce);
        enc.extend_from_slice(&ct);
        assert_eq!(decrypt_gcm(&key, &enc).unwrap(), b"abc");
        enc[20] ^= 1;
        assert!(
            decrypt_gcm(&key, &enc).is_none(),
            "tampered data fails the tag"
        );
        assert!(decrypt_gcm(&key, b"v20xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").is_none());
    }

    #[test]
    fn domain_rules() {
        let w = vec!["github.com".to_string()];
        assert!(domain_matches(".github.com", &w));
        assert!(domain_matches("api.github.com", &w));
        assert!(!domain_matches("notgithub.com", &w));
        assert!(!domain_matches("github.com.evil.io", &w));
        assert_eq!(base_domain(".GitHub.com"), "github.com");
        // The site open in the panel is often www.: domain cookies of its parent apply to it.
        let www = vec!["www.github.com".to_string()];
        assert!(domain_matches(".github.com", &www));
        assert!(
            !domain_matches("github.com", &www),
            "a host-only cookie is not sent to www."
        );
        assert!(!domain_matches(".com", &www));
        assert!(domain_matches("anything.example", &["*".to_string()]));
    }

    #[cfg(any(target_os = "macos", windows))]
    mod fixtures {
        use super::super::read::{self, Key};
        use super::super::*;

        fn hex(b: &[u8]) -> String {
            b.iter().map(|x| format!("{x:02x}")).collect()
        }

        fn chrome_time(unix: i64) -> i64 {
            (unix + 11_644_473_600) * 1_000_000
        }

        fn temp(name: &str) -> PathBuf {
            let d = std::env::temp_dir().join(format!("hp-cookies-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            d
        }

        /// A Cookies database shaped like Chromium's (only the columns the reader uses).
        fn make_db(path: &Path, version: i64, rows: &[(&str, &str, &str, Vec<u8>, i64)]) {
            let mut sql = format!(
                "CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES('version','{version}');
                 CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
                   expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER);"
            );
            for (host, name, value, enc, exp) in rows {
                sql.push_str(&format!(
                    "INSERT INTO cookies VALUES('{host}','{name}','{value}',x'{}','/',{exp},1,1,1);",
                    hex(enc)
                ));
            }
            super::super::sqlite::Db::create(path, &sql).unwrap();
        }

        fn cbc(key: &[u8; 16], plain: &[u8]) -> Vec<u8> {
            use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
            let mut out = b"v10".to_vec();
            out.extend(
                cbc::Encryptor::<aes::Aes128>::new(key.into(), &[b' '; 16].into())
                    .encrypt_padded_vec_mut::<Pkcs7>(plain),
            );
            out
        }

        fn gcm(prefix: &[u8], key: &[u8; 32], nonce: [u8; 12], plain: &[u8]) -> Vec<u8> {
            use aes_gcm::aead::{Aead, KeyInit};
            let mut out = prefix.to_vec();
            out.extend_from_slice(&nonce);
            out.extend(
                aes_gcm::Aes256Gcm::new(key.into())
                    .encrypt(aes_gcm::Nonce::from_slice(&nonce), plain)
                    .unwrap(),
            );
            out
        }

        fn hashed(host: &str, value: &[u8]) -> Vec<u8> {
            use sha2::{Digest, Sha256};
            let mut p = Sha256::digest(host.as_bytes()).to_vec();
            p.extend_from_slice(value);
            p
        }

        #[test]
        fn mac_style_database() {
            let dir = temp("cbc");
            let db = dir.join("Cookies");
            let now = 1_800_000_000;
            let later = chrome_time(now + 86_400);
            let key = mac_key(b"fixture-password");
            make_db(
                &db,
                24,
                &[
                    (
                        ".example.com",
                        "sid",
                        "",
                        cbc(&key, &hashed(".example.com", b"one")),
                        later,
                    ),
                    ("www.example.com", "plain", "two", Vec::new(), later),
                    (
                        ".example.com",
                        "old",
                        "",
                        cbc(&key, b"x"),
                        chrome_time(now - 10),
                    ),
                    (
                        ".example.com",
                        "sess",
                        "",
                        cbc(&key, &hashed(".example.com", b"three")),
                        0,
                    ),
                    (".other.test", "no", "", cbc(&key, b"x"), later),
                ],
            );
            let wanted = vec!["example.com".to_string()];
            let (version, rows) = read::query(&db, &wanted).unwrap();
            assert_eq!((version, rows.len()), (24, 4));
            let mut r = ImportResult::default();
            let out =
                read::decrypt(rows, version, false, now, || Ok(Key::Cbc(key)), &mut r).unwrap();
            let mut got: Vec<(String, String)> =
                out.into_iter().map(|p| (p.name, p.value)).collect();
            got.sort();
            assert_eq!(
                got,
                vec![("plain".into(), "two".into()), ("sid".into(), "one".into())]
            );
            assert_eq!((r.expired, r.session, r.failed), (1, 1, 0));

            // Session cookies only on request.
            let (version, rows) = read::query(&db, &wanted).unwrap();
            let mut r = ImportResult::default();
            let out =
                read::decrypt(rows, version, true, now, || Ok(Key::Cbc(key)), &mut r).unwrap();
            assert!(out
                .iter()
                .any(|p| p.name == "sess" && p.value == "three" && p.expires.is_none()));
            assert_eq!(r.session, 0);

            // Plaintext values never ask for the key (no Keychain prompt).
            let plain_db = dir.join("Plain");
            make_db(
                &plain_db,
                24,
                &[("www.example.com", "plain", "two", Vec::new(), later)],
            );
            let (version, rows) = read::query(&plain_db, &wanted).unwrap();
            let mut r = ImportResult::default();
            let out = read::decrypt(
                rows,
                version,
                false,
                now,
                || Err("key asked".into()),
                &mut r,
            )
            .unwrap();
            assert_eq!(out.len(), 1);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn windows_style_database() {
            let dir = temp("gcm");
            let db = dir.join("Cookies");
            let now = 1_800_000_000;
            let later = chrome_time(now + 86_400);
            let key = [3u8; 32];
            make_db(
                &db,
                23,
                &[
                    (
                        "a.example.com",
                        "v10",
                        "",
                        gcm(b"v10", &key, [1; 12], b"ten"),
                        later,
                    ),
                    (
                        "a.example.com",
                        "v11",
                        "",
                        gcm(b"v11", &key, [2; 12], b"eleven"),
                        later,
                    ),
                    (
                        "a.example.com",
                        "bound",
                        "",
                        gcm(b"v20", &key, [3; 12], b"locked"),
                        later,
                    ),
                    ("a.example.com", "bad", "", b"v10short".to_vec(), later),
                ],
            );
            let (version, rows) = read::query(&db, &["example.com".to_string()]).unwrap();
            let mut r = ImportResult::default();
            let out =
                read::decrypt(rows, version, false, now, || Ok(Key::Gcm(key)), &mut r).unwrap();
            let mut got: Vec<(String, String)> =
                out.into_iter().map(|p| (p.name, p.value)).collect();
            got.sort();
            assert_eq!(
                got,
                vec![
                    ("v10".into(), "ten".into()),
                    ("v11".into(), "eleven".into())
                ]
            );
            assert_eq!((r.app_bound, r.failed), (1, 1));

            // Only app-bound values: nothing to decrypt, so no key is asked for.
            let only_v20 = dir.join("Only");
            make_db(
                &only_v20,
                23,
                &[(
                    "a.example.com",
                    "bound",
                    "",
                    gcm(b"v20", &key, [3; 12], b"x"),
                    later,
                )],
            );
            let (version, rows) = read::query(&only_v20, &["example.com".to_string()]).unwrap();
            let mut r = ImportResult::default();
            let out = read::decrypt(
                rows,
                version,
                false,
                now,
                || Err("key asked".into()),
                &mut r,
            )
            .unwrap();
            assert!(out.is_empty());
            assert_eq!(r.app_bound, 1);
            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn copies_the_database_with_its_wal() {
            let dir = temp("copy");
            let src = dir.join("Cookies");
            std::fs::write(&src, b"db").unwrap();
            std::fs::write(dir.join("Cookies-wal"), b"wal").unwrap();
            let copy = read::copy_db(&src, "Fixture").unwrap();
            assert_eq!(std::fs::read(&copy.db).unwrap(), b"db");
            assert_eq!(std::fs::read(copy.dir.join("Cookies-wal")).unwrap(), b"wal");
            assert!(!copy.dir.join("Cookies-journal").exists());
            let tmp = copy.dir.clone();
            drop(copy);
            assert!(!tmp.exists(), "the private copy is removed");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn chrome_epoch() {
        assert_eq!(chrome_time_to_unix(0), None);
        // 2024-01-01T00:00:00Z
        assert_eq!(
            chrome_time_to_unix(13_348_540_800_000_000),
            Some(1_704_067_200)
        );
    }

    #[test]
    fn base64() {
        assert_eq!(base64_decode("RFBBUEk=").unwrap(), b"DPAPI");
        assert_eq!(base64_decode("aGVsbG8gd29ybGQ").unwrap(), b"hello world");
        assert!(base64_decode("!!").is_none());
    }
}
