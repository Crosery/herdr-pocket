//! Native GitHub Release metadata lookup, streamed asset download with SHA-256
//! verification, OS installer staging, and detached restart-to-apply helper.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const GITHUB_LATEST_API: &str = "https://api.github.com/repos/Crosery/herdr-pocket/releases/latest";
const MAX_ASSET_BYTES: u64 = 450 * 1024 * 1024;
const ALLOWED_REPO_DOWNLOAD_SEGMENT: &str = "https://github.com/Crosery/herdr-pocket/releases/download/v";
#[cfg(target_os = "macos")]
const LOCAL_SIGNER_CN: &str = "Herdr Pocket Local Signer";
const PROBE_TIMEOUT_MS: u64 = 2_500;
const PARALLEL_THRESHOLD_BYTES: u64 = 2 * 1024 * 1024;
const PARALLEL_WORKERS: usize = 4;
const STALL_ABORT_SECS: u64 = 5;
const SLOW_SPEED_CHECK_SECS: u64 = 4;
const SLOW_SPEED_MIN_BPS: f64 = 150.0 * 1024.0;

fn updater_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .tcp_nodelay(true)
                .pool_max_idle_per_host(8)
                .user_agent("herdr-pocket-desktop-updater")
                .build()
                .map_err(|e| format!("无法创建更新网络客户端: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

static DOWNLOADING: AtomicBool = AtomicBool::new(false);

struct DownloadGuard;
impl Drop for DownloadGuard {
    fn drop(&mut self) {
        DOWNLOADING.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubReleaseAsset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubLatestRelease {
    pub version: String,
    pub tag_name: String,
    pub html_url: String,
    pub published_at: String,
    pub body: String,
    pub assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressEvent {
    pub phase: &'static str,
    pub version: String,
    pub downloaded_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedUpdateResult {
    pub version: String,
    pub ready: bool,
}

#[derive(Debug, Clone)]
struct StagedUpdate {
    version: String,
    staged_path: PathBuf,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    installer_path: Option<PathBuf>,
}

fn staged_slot() -> &'static Mutex<Option<StagedUpdate>> {
    static SLOT: OnceLock<Mutex<Option<StagedUpdate>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Deserialize)]
struct ApiRelease {
    tag_name: Option<String>,
    html_url: Option<String>,
    published_at: Option<String>,
    body: Option<String>,
    assets: Option<Vec<ApiAsset>>,
}

#[derive(Debug, Deserialize)]
struct ApiAsset {
    name: Option<String>,
    size: Option<u64>,
    browser_download_url: Option<String>,
    digest: Option<String>,
}

fn is_valid_semver_tag(v: &str) -> bool {
    let mut parts = v.splitn(2, '-');
    let main = parts.next().unwrap_or("");
    let nums: Vec<&str> = main.split('.').collect();
    if nums.len() != 3 || nums.iter().any(|n| n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    if let Some(pre) = parts.next() {
        !pre.is_empty()
            && pre
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    } else {
        true
    }
}

fn is_hex_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

pub fn is_valid_asset_name(asset_name: &str) -> bool {
    if asset_name.is_empty()
        || asset_name.contains('/')
        || asset_name.contains('\\')
        || asset_name.contains("..")
    {
        return false;
    }
    let Some(rest) = asset_name.strip_prefix("herdr-pocket-") else {
        return false;
    };
    let valid_ext = rest.ends_with(".dmg")
        || rest.ends_with("-setup.exe")
        || rest.ends_with(".AppImage");
    valid_ext
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

pub fn is_allowed_release_asset_url(url: &str, asset_name: &str) -> bool {
    if !is_valid_asset_name(asset_name) {
        return false;
    }
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    let local = matches!(u.host_str(), Some("localhost" | "127.0.0.1"));
    let scheme_ok = u.scheme() == "https" || (u.scheme() == "http" && local);
    if !scheme_ok
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return false;
    }
    if url.contains(ALLOWED_REPO_DOWNLOAD_SEGMENT) && url.ends_with(&format!("/{asset_name}")) {
        return true;
    }
    let path = u.path();
    let suffix = format!("/{asset_name}");
    if !path.contains("..") {
        if let Some(idx) = path.find("/v1/releases/download/v") {
            let rest = &path[idx + "/v1/releases/download/v".len()..];
            if let Some(ver) = rest.strip_suffix(&suffix) {
                return !ver.is_empty()
                    && !ver.contains('/')
                    && ver
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-');
            }
        }
    }
    false
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn macos_current_app_bundle(exe: &Path) -> Option<PathBuf> {
    for anc in exe.ancestors() {
        if anc.extension().and_then(|e| e.to_str()) == Some("app") {
            return Some(anc.to_path_buf());
        }
    }
    None
}

fn updates_dir() -> Result<PathBuf, String> {
    let base = if let Some(dir) = std::env::var_os("HERDR_POCKET_STATE").filter(|v| !v.is_empty()) {
        PathBuf::from(dir)
    } else {
        #[cfg(windows)]
        {
            std::env::var_os("LOCALAPPDATA")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("USERPROFILE")
                        .map(|h| PathBuf::from(h).join("AppData").join("Local"))
                })
                .ok_or_else(|| "无法定位本地更新目录".to_string())?
                .join("herdr-pocket")
        }
        #[cfg(not(windows))]
        {
            crate::home_dir()
                .ok_or_else(|| "无法定位主目录".to_string())?
                .join(".local/state/herdr-pocket")
        }
    };
    Ok(base.join("updates"))
}

fn source_host_label(raw_url: &str) -> String {
    if raw_url.starts_with("https://github.com/") {
        return "github.com".into();
    }
    url::Url::parse(raw_url)
        .ok()
        .and_then(|u| u.host_str().map(ToString::to_string))
        .unwrap_or_else(|| "mirror".into())
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut f, &mut hasher).map_err(|e| e.to_string())?;
    Ok(hex_encode(&hasher.finalize()))
}

fn emit_progress(app: &AppHandle, ev: UpdateProgressEvent) {
    let _ = app.emit("update://progress", ev);
}

#[tauri::command]
pub async fn update_fetch_github_latest(
    timeout_ms: Option<u64>,
) -> Result<GithubLatestRelease, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(4500).clamp(1000, 15_000));
    let res = crate::net::client()
        .get(GITHUB_LATEST_API)
        .header("Accept", "application/vnd.github+json")
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "GitHub Release 查询超时".to_string()
            } else {
                format!("GitHub Release 查询失败: {e}")
            }
        })?;
    if !res.status().is_success() {
        return Err(format!("GitHub API HTTP {}", res.status().as_u16()));
    }
    let body_bytes = res.bytes().await.map_err(|_| "读取 GitHub 响应失败".to_string())?;
    if body_bytes.len() > 2 * 1024 * 1024 {
        return Err("GitHub Release 响应过大".into());
    }
    let parsed: ApiRelease =
        serde_json::from_slice(&body_bytes).map_err(|e| format!("解析 GitHub JSON 失败: {e}"))?;
    let tag_name = parsed.tag_name.unwrap_or_default().trim().to_string();
    let version = tag_name.trim_start_matches(['v', 'V']).to_string();
    if !is_valid_semver_tag(&version) {
        return Err("GitHub Release 版本号无效".into());
    }
    let assets = parsed
        .assets
        .unwrap_or_default()
        .into_iter()
        .filter_map(|a| {
            let name = a.name?;
            let url = a.browser_download_url?;
            let sha256 = a
                .digest
                .as_deref()
                .and_then(|d| d.strip_prefix("sha256:"))
                .map(|h| h.trim().to_ascii_lowercase())
                .filter(|h| is_hex_sha256(h));
            Some(GithubReleaseAsset {
                name,
                size: a.size.unwrap_or(0),
                browser_download_url: url,
                sha256,
            })
        })
        .collect();
    Ok(GithubLatestRelease {
        version,
        tag_name,
        html_url: parsed.html_url.unwrap_or_default(),
        published_at: parsed.published_at.unwrap_or_default(),
        body: parsed.body.unwrap_or_default(),
        assets,
    })
}

#[cfg(target_os = "macos")]
fn stage_macos_dmg(dmg_path: &Path, stage_root: &Path) -> Result<PathBuf, String> {
    struct MountGuard(PathBuf);
    impl Drop for MountGuard {
        fn drop(&mut self) {
            let _ = Command::new("hdiutil")
                .args(["detach", &self.0.to_string_lossy(), "-force"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = fs::remove_dir(&self.0);
        }
    }

    let mnt = stage_root.join(format!("mnt-{}", std::process::id()));
    let _ = fs::remove_dir_all(&mnt);
    fs::create_dir_all(&mnt).map_err(|e| format!("创建挂载目录失败: {e}"))?;

    let attach = Command::new("hdiutil")
        .args([
            "attach",
            "-nobrowse",
            "-readonly",
            "-noverify",
            "-mountpoint",
            &mnt.to_string_lossy(),
            &dmg_path.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("启动 hdiutil 失败: {e}"))?;
    if !attach.status.success() {
        let stderr = String::from_utf8_lossy(&attach.stderr).trim().to_string();
        let _ = fs::remove_dir(&mnt);
        return Err(format!("挂载更新镜像失败: {stderr}"));
    }
    let _guard = MountGuard(mnt.clone());

    let preferred = mnt.join("Herdr Pocket.app");
    let src_app = if preferred.is_dir() {
        preferred
    } else {
        fs::read_dir(&mnt)
            .ok()
            .and_then(|rd| {
                rd.flatten()
                    .map(|e| e.path())
                    .find(|p| p.is_dir() && p.extension().and_then(|x| x.to_str()) == Some("app"))
            })
            .ok_or_else(|| "安装包内未找到 Herdr Pocket.app".to_string())?
    };

    let staged_dir = stage_root.join("staged");
    let staged_app = staged_dir.join("Herdr Pocket.app");
    let _ = fs::remove_dir_all(&staged_app);
    fs::create_dir_all(&staged_dir).map_err(|e| format!("创建暂存目录失败: {e}"))?;

    let ditto = Command::new("ditto")
        .arg(&src_app)
        .arg(&staged_app)
        .output()
        .map_err(|e| format!("复制更新包失败: {e}"))?;
    if !ditto.status.success() {
        let stderr = String::from_utf8_lossy(&ditto.stderr).trim().to_string();
        return Err(format!("解压新版本失败: {stderr}"));
    }

    let _ = Command::new("xattr")
        .args(["-dr", "com.apple.quarantine", &staged_app.to_string_lossy()])
        .output();

    maybe_resign_adhoc_macos_app(&staged_app);

    let sign_check = Command::new("codesign")
        .args(["--verify", "--deep", "--strict", &staged_app.to_string_lossy()])
        .output()
        .map_err(|e| format!("执行签名校验失败: {e}"))?;
    if !sign_check.status.success() {
        let stderr = String::from_utf8_lossy(&sign_check.stderr).trim().to_string();
        let _ = fs::remove_dir_all(&staged_app);
        return Err(format!("新版本应用签名校验未通过: {stderr}"));
    }

    Ok(staged_app)
}

#[cfg(target_os = "macos")]
fn ensure_local_codesign_identity() -> Option<String> {
    let list_out = Command::new("security")
        .args(["find-identity", "-v", "-p", "codesigning"])
        .output()
        .ok()?;
    let list_stdout = String::from_utf8_lossy(&list_out.stdout);
    if list_stdout.contains(LOCAL_SIGNER_CN) {
        return Some(LOCAL_SIGNER_CN.to_string());
    }

    let home = std::env::var_os("HOME")?;
    let keychain = PathBuf::from(&home).join("Library/Keychains/login.keychain-db");
    if !keychain.exists() {
        return None;
    }

    let tmp_dir = std::env::temp_dir().join(format!("herdr-signer-{}", std::process::id()));
    let _ = fs::create_dir_all(&tmp_dir);
    let key_path = tmp_dir.join("signer.key");
    let cert_path = tmp_dir.join("signer.crt");
    let p12_path = tmp_dir.join("signer.p12");

    let gen = Command::new("openssl")
        .args([
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "3650",
            "-subj",
            &format!("/CN={LOCAL_SIGNER_CN}"),
            "-addext",
            "keyUsage=critical,digitalSignature",
            "-addext",
            "extendedKeyUsage=critical,codeSigning",
            "-keyout",
            &key_path.to_string_lossy(),
            "-out",
            &cert_path.to_string_lossy(),
        ])
        .output();

    let ok = match gen {
        Ok(o) if o.status.success() => {
            let p12 = Command::new("openssl")
                .args([
                    "pkcs12",
                    "-export",
                    "-out",
                    &p12_path.to_string_lossy(),
                    "-inkey",
                    &key_path.to_string_lossy(),
                    "-in",
                    &cert_path.to_string_lossy(),
                    "-passout",
                    "pass:",
                ])
                .output();
            match p12 {
                Ok(po) if po.status.success() => {
                    let imp = Command::new("security")
                        .args([
                            "import",
                            &p12_path.to_string_lossy(),
                            "-k",
                            &keychain.to_string_lossy(),
                            "-P",
                            "",
                            "-T",
                            "/usr/bin/codesign",
                        ])
                        .output();
                    matches!(imp, Ok(io) if io.status.success())
                }
                _ => false,
            }
        }
        _ => false,
    };
    let _ = fs::remove_dir_all(&tmp_dir);
    if ok {
        Some(LOCAL_SIGNER_CN.to_string())
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn maybe_resign_adhoc_macos_app(staged_app: &Path) {
    let info = match Command::new("codesign")
        .args(["-dv", &staged_app.to_string_lossy()])
        .output()
    {
        Ok(o) => o,
        Err(_) => return,
    };
    let stderr = String::from_utf8_lossy(&info.stderr);
    // Preserve Apple Developer ID / notarized bundles untouched; only upgrade ad-hoc CI builds.
    if !stderr.contains("Signature=adhoc") {
        return;
    }
    let Some(identity) = ensure_local_codesign_identity() else {
        return;
    };
    let _ = Command::new("codesign")
        .args([
            "--force",
            "--deep",
            "--sign",
            &identity,
            &staged_app.to_string_lossy(),
        ])
        .output();
}

#[tauri::command]
pub async fn update_download_and_stage(
    app: AppHandle,
    version: String,
    asset_name: String,
    urls: Vec<String>,
    expected_sha256: String,
) -> Result<StagedUpdateResult, String> {
    let clean_ver = version.trim().trim_start_matches(['v', 'V']).to_string();
    if !is_valid_semver_tag(&clean_ver) {
        return Err("更新版本号格式无效".into());
    }
    let sha_expected = expected_sha256.trim().to_ascii_lowercase();
    if !is_hex_sha256(&sha_expected) {
        return Err("缺少有效的 SHA-256 校验值".into());
    }
    let valid_urls: Vec<String> = urls
        .into_iter()
        .filter(|u| is_allowed_release_asset_url(u, &asset_name))
        .collect();
    if valid_urls.is_empty() {
        return Err("没有可用的合法下载地址".into());
    }
    if DOWNLOADING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("已有更新正在下载中".into());
    }
    let _dl_guard = DownloadGuard;

    let dir = updates_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败: {e}"))?;
    let final_path = dir.join(&asset_name);
    let part_path = dir.join(format!("{asset_name}.part"));

    let mut already_verified = false;
    if final_path.is_file() {
        if let Ok(existing_sha) = file_sha256(&final_path) {
            if existing_sha == sha_expected {
                already_verified = true;
                emit_progress(
                    &app,
                    UpdateProgressEvent {
                        phase: "verifying",
                        version: clean_ver.clone(),
                        downloaded_bytes: fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0),
                        total_bytes: fs::metadata(&final_path).ok().map(|m| m.len()),
                        percent: Some(100),
                        source: None,
                        message: Some("已找到校验通过的安装包".into()),
                    },
                );
            } else {
                let _ = fs::remove_file(&final_path);
            }
        }
    }

    if !already_verified {
        let mut last_err = String::from("下载失败");
        let mut succeeded = false;
        let candidates = probe_release_sources(client_for_updater()?, &valid_urls).await;
        let candidate_count = candidates.len();

        for (cand_idx, cand) in candidates.into_iter().enumerate() {
            let has_fallback = cand_idx + 1 < candidate_count;
            let url = cand.url;
            let source = source_host_label(&url);
            let _ = fs::remove_file(&part_path);
            emit_progress(
                &app,
                UpdateProgressEvent {
                    phase: "downloading",
                    version: clean_ver.clone(),
                    downloaded_bytes: 0,
                    total_bytes: cand.total_bytes,
                    percent: Some(0),
                    source: Some(source.clone()),
                    message: Some(format!("正在连接 {source}…")),
                },
            );

            let dl_res = if cand.supports_range
                && cand
                    .total_bytes
                    .is_some_and(|n| n >= PARALLEL_THRESHOLD_BYTES && n <= MAX_ASSET_BYTES)
            {
                let total = cand.total_bytes.unwrap_or(0);
                download_parallel_range(
                    &app,
                    &clean_ver,
                    &source,
                    &url,
                    total,
                    &part_path,
                    has_fallback,
                )
                .await
            } else {
                download_single_stream(
                    &app,
                    &clean_ver,
                    &source,
                    &url,
                    &part_path,
                    has_fallback,
                )
                .await
            };

            let downloaded = match dl_res {
                Ok(n) => n,
                Err(e) => {
                    let _ = fs::remove_file(&part_path);
                    last_err = e;
                    continue;
                }
            };

            emit_progress(
                &app,
                UpdateProgressEvent {
                    phase: "verifying",
                    version: clean_ver.clone(),
                    downloaded_bytes: downloaded,
                    total_bytes: Some(downloaded),
                    percent: Some(100),
                    source: Some(source.clone()),
                    message: Some("正在校验 SHA-256…".into()),
                },
            );

            let digest_hex = match file_sha256(&part_path) {
                Ok(h) => h,
                Err(e) => {
                    let _ = fs::remove_file(&part_path);
                    last_err = format!("计算安装包校验和失败: {e}");
                    continue;
                }
            };
            if digest_hex != sha_expected {
                let _ = fs::remove_file(&part_path);
                last_err = format!("{source} SHA-256 校验失败");
                continue;
            }

            #[cfg(windows)]
            let _ = fs::remove_file(&final_path);
            fs::rename(&part_path, &final_path)
                .map_err(|e| format!("保存安装包失败: {e}"))?;
            succeeded = true;
            break;
        }

        if !succeeded {
            emit_progress(
                &app,
                UpdateProgressEvent {
                    phase: "error",
                    version: clean_ver.clone(),
                    downloaded_bytes: 0,
                    total_bytes: None,
                    percent: None,
                    source: None,
                    message: Some(last_err.clone()),
                },
            );
            return Err(last_err);
        }
    }

    emit_progress(
        &app,
        UpdateProgressEvent {
            phase: "staging",
            version: clean_ver.clone(),
            downloaded_bytes: fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0),
            total_bytes: fs::metadata(&final_path).ok().map(|m| m.len()),
            percent: Some(100),
            source: None,
            message: Some("正在校验安装环境并准备重启更新…".into()),
        },
    );

    let staged_res: Result<(PathBuf, Option<PathBuf>), String> = {
        #[cfg(target_os = "macos")]
        {
            let dmg_copy = final_path.clone();
            let dir_copy = dir.clone();
            let staged_app = tauri::async_runtime::spawn_blocking(move || stage_macos_dmg(&dmg_copy, &dir_copy))
                .await
                .map_err(|e| e.to_string())??;
            Ok((staged_app, Some(final_path)))
        }
        #[cfg(windows)]
        {
            let mut hdr = [0u8; 2];
            let mut f = File::open(&final_path).map_err(|e| format!("打开安装程序失败: {e}"))?;
            std::io::Read::read_exact(&mut f, &mut hdr)
                .map_err(|_| "Windows 安装程序不完整".to_string())?;
            if &hdr != b"MZ" {
                return Err("下载的文件不是有效的 Windows 安装程序".into());
            }
            Ok((final_path, None))
        }
        #[cfg(all(not(target_os = "macos"), not(windows)))]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&final_path, fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("设置更新包执行权限失败: {e}"))?;
            Ok((final_path, None))
        }
    };

    let (staged_path, installer_path) = match staged_res {
        Ok(v) => v,
        Err(err) => {
            emit_progress(
                &app,
                UpdateProgressEvent {
                    phase: "error",
                    version: clean_ver.clone(),
                    downloaded_bytes: 0,
                    total_bytes: None,
                    percent: None,
                    source: None,
                    message: Some(err.clone()),
                },
            );
            return Err(err);
        }
    };

    if let Ok(mut guard) = staged_slot().lock() {
        *guard = Some(StagedUpdate {
            version: clean_ver.clone(),
            staged_path,
            installer_path,
        });
    }

    emit_progress(
        &app,
        UpdateProgressEvent {
            phase: "ready",
            version: clean_ver.clone(),
            downloaded_bytes: 0,
            total_bytes: None,
            percent: Some(100),
            source: None,
            message: Some("更新已准备就绪".into()),
        },
    );

    Ok(StagedUpdateResult {
        version: clean_ver,
        ready: true,
    })
}

#[tauri::command]
pub fn update_restart_and_apply(app: AppHandle) -> Result<(), String> {
    let staged = staged_slot()
        .lock()
        .map_err(|_| "updater lock poisoned".to_string())?
        .take()
        .ok_or_else(|| "还没有下载并校验好的更新".to_string())?;

    if !staged.staged_path.exists() {
        return Err("已暂存的更新文件已不存在，请重新下载".into());
    }

    emit_progress(
        &app,
        UpdateProgressEvent {
            phase: "restarting",
            version: staged.version.clone(),
            downloaded_bytes: 0,
            total_bytes: None,
            percent: Some(100),
            source: None,
            message: Some("正在重启应用并安装新版本…".into()),
        },
    );

    crate::local_term::shutdown();

    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;
        let dir = updates_dir()?;
        let script_path = dir.join("apply-update.sh");
        let target_app = std::env::current_exe()
            .ok()
            .and_then(|p| macos_current_app_bundle(&p))
            .unwrap_or_else(|| PathBuf::from("/Applications/Herdr Pocket.app"));
        let script = r#"#!/bin/sh
OLD_PID="$1"
STAGED_APP="$2"
TARGET_APP="$3"
DMG_PATH="$4"
i=0
while kill -0 "$OLD_PID" 2>/dev/null && [ "$i" -lt 120 ]; do
  sleep 0.1
  i=$((i + 1))
done
if command -v rsync >/dev/null 2>&1 && [ -d "$TARGET_APP/Contents" ]; then
  if rsync -a --delete "$STAGED_APP/Contents/" "$TARGET_APP/Contents/" 2>/dev/null; then
    touch "$TARGET_APP" 2>/dev/null || true
  else
    osascript - "$STAGED_APP" "$TARGET_APP" <<'APPLESCRIPT'
on run argv
  set srcApp to item 1 of argv
  set dstApp to item 2 of argv
  do shell script "rsync -a --delete " & quoted form of (srcApp & "/Contents/") & " " & quoted form of (dstApp & "/Contents/") & " && touch " & quoted form of dstApp with administrator privileges
end run
APPLESCRIPT
  fi
elif rm -rf "$TARGET_APP" 2>/dev/null && ditto "$STAGED_APP" "$TARGET_APP" 2>/dev/null; then
  :
else
  osascript - "$STAGED_APP" "$TARGET_APP" <<'APPLESCRIPT'
on run argv
  set srcApp to item 1 of argv
  set dstApp to item 2 of argv
  do shell script "rm -rf " & quoted form of dstApp & " && ditto " & quoted form of srcApp & " " & quoted form of dstApp with administrator privileges
end run
APPLESCRIPT
fi
rm -rf "$STAGED_APP" 2>/dev/null || true
if [ -n "$DMG_PATH" ]; then
  rm -f "$DMG_PATH" 2>/dev/null || true
fi
open -n "$TARGET_APP"
"#;
        fs::write(&script_path, script).map_err(|e| format!("写入更新脚本失败: {e}"))?;
        fs::set_permissions(&script_path, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("设置更新脚本权限失败: {e}"))?;
        let dmg_arg = staged
            .installer_path
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        Command::new("/bin/sh")
            .arg(&script_path)
            .arg(std::process::id().to_string())
            .arg(&staged.staged_path)
            .arg(&target_app)
            .arg(&dmg_arg)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动更新助手失败: {e}"))?;
    }

    #[cfg(windows)]
    {
        Command::new(&staged.staged_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("启动新版本安装程序失败: {e}"))?;
    }

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Some(current_appimage) = std::env::var_os("APPIMAGE").filter(|v| !v.is_empty()) {
            let dir = updates_dir()?;
            let script_path = dir.join("apply-update-linux.sh");
            let script = r#"#!/bin/sh
OLD_PID="$1"
NEW_IMG="$2"
DST_IMG="$3"
i=0
while kill -0 "$OLD_PID" 2>/dev/null && [ "$i" -lt 120 ]; do
  sleep 0.1
  i=$((i + 1))
done
if mv -f "$NEW_IMG" "$DST_IMG" 2>/dev/null; then
  chmod +x "$DST_IMG" 2>/dev/null || true
  exec "$DST_IMG"
fi
exec "$NEW_IMG"
"#;
            fs::write(&script_path, script).map_err(|e| format!("写入更新脚本失败: {e}"))?;
            fs::set_permissions(&script_path, fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("设置更新脚本权限失败: {e}"))?;
            Command::new("/bin/sh")
                .arg(&script_path)
                .arg(std::process::id().to_string())
                .arg(&staged.staged_path)
                .arg(PathBuf::from(current_appimage))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("启动更新脚本失败: {e}"))?;
        } else {
            Command::new(&staged.staged_path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| format!("启动新版本 AppImage 失败: {e}"))?;
        }
    }

    app.exit(0);
    Ok(())
}

#[derive(Clone)]
struct ProbedSource {
    url: String,
    ok: bool,
    supports_range: bool,
    total_bytes: Option<u64>,
    latency_ms: u64,
    orig_idx: usize,
}

fn client_for_updater() -> Result<&'static reqwest::Client, String> {
    updater_client()
}

fn parse_content_range_total(header_val: &str) -> Option<u64> {
    let (_, rest) = header_val.split_once('/')?;
    let total = rest.trim().parse::<u64>().ok()?;
    if total > 0 && total <= MAX_ASSET_BYTES {
        Some(total)
    } else {
        None
    }
}

fn format_speed(bps: f64) -> String {
    if !bps.is_finite() || bps <= 0.0 {
        return String::new();
    }
    if bps >= 1024.0 * 1024.0 {
        format!("{:.1} MB/s", bps / (1024.0 * 1024.0))
    } else if bps >= 1024.0 {
        format!("{:.0} KB/s", bps / 1024.0)
    } else {
        format!("{:.0} B/s", bps)
    }
}

async fn probe_release_sources(client: &reqwest::Client, urls: &[String]) -> Vec<ProbedSource> {
    let mut handles = Vec::with_capacity(urls.len());
    for (idx, url) in urls.iter().enumerate() {
        let client = client.clone();
        let url = url.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let started = Instant::now();
            let res = tokio::time::timeout(Duration::from_millis(PROBE_TIMEOUT_MS), async {
                let mut resp = client
                    .get(&url)
                    .header(reqwest::header::RANGE, "bytes=0-65535")
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;
                let status = resp.status();
                if status == reqwest::StatusCode::PARTIAL_CONTENT {
                    let total_bytes = resp
                        .headers()
                        .get(reqwest::header::CONTENT_RANGE)
                        .and_then(|v| v.to_str().ok())
                        .and_then(parse_content_range_total);
                    let _ = resp.chunk().await.map_err(|e| e.to_string())?;
                    Ok::<(bool, Option<u64>), String>((total_bytes.is_some(), total_bytes))
                } else if status.is_success() {
                    let total_bytes = resp
                        .content_length()
                        .filter(|&n| n > 0 && n <= MAX_ASSET_BYTES);
                    let _ = resp.chunk().await.map_err(|e| e.to_string())?;
                    Ok::<(bool, Option<u64>), String>((false, total_bytes))
                } else {
                    Err(format!("HTTP {}", status.as_u16()))
                }
            })
            .await;

            let latency_ms = started.elapsed().as_millis() as u64;
            match res {
                Ok(Ok((supports_range, total_bytes))) => ProbedSource {
                    url,
                    ok: true,
                    supports_range,
                    total_bytes,
                    latency_ms,
                    orig_idx: idx,
                },
                _ => ProbedSource {
                    url,
                    ok: false,
                    supports_range: false,
                    total_bytes: None,
                    latency_ms,
                    orig_idx: idx,
                },
            }
        }));
    }

    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        if let Ok(item) = h.await {
            out.push(item);
        }
    }
    out.sort_by_key(|item| {
        let score = if item.supports_range {
            item.latency_ms.saturating_sub(120)
        } else {
            item.latency_ms
        };
        (!item.ok, score, item.orig_idx)
    });
    out
}

async fn download_parallel_range(
    app: &AppHandle,
    version: &str,
    source: &str,
    url: &str,
    total_bytes: u64,
    part_path: &Path,
    has_fallback: bool,
) -> Result<u64, String> {
    let client = client_for_updater()?.clone();
    let file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .read(true)
        .write(true)
        .open(part_path)
        .map_err(|e| format!("创建临时安装包失败: {e}"))?;
    file.set_len(total_bytes)
        .map_err(|e| format!("预分配安装包空间失败: {e}"))?;
    let shared_file = Arc::new(Mutex::new(file));

    let step = (total_bytes / 16).clamp(1024 * 1024, 4 * 1024 * 1024);
    let mut slices = std::collections::VecDeque::new();
    let mut offset = 0u64;
    while offset < total_bytes {
        let end = offset.saturating_add(step - 1).min(total_bytes - 1);
        slices.push_back((offset, end));
        offset = end + 1;
    }
    let worker_count = PARALLEL_WORKERS.min(slices.len().max(1));
    let queue = Arc::new(tokio::sync::Mutex::new(slices));
    let downloaded = Arc::new(AtomicU64::new(0));
    let started = Instant::now();
    let last_byte_ms = Arc::new(AtomicU64::new(0));
    let abort_flag = Arc::new(AtomicBool::new(false));
    let first_err = Arc::new(Mutex::new(None::<String>));
    let active_workers = Arc::new(AtomicU64::new(worker_count as u64));

    let mut handles = Vec::with_capacity(worker_count);
    for _ in 0..worker_count {
        let client = client.clone();
        let url = url.to_string();
        let source = source.to_string();
        let queue = Arc::clone(&queue);
        let shared_file = Arc::clone(&shared_file);
        let downloaded = Arc::clone(&downloaded);
        let last_byte_ms = Arc::clone(&last_byte_ms);
        let abort_flag = Arc::clone(&abort_flag);
        let first_err = Arc::clone(&first_err);
        let active_workers = Arc::clone(&active_workers);

        handles.push(tauri::async_runtime::spawn(async move {
            loop {
                if abort_flag.load(Ordering::Relaxed) {
                    break;
                }
                let next = {
                    let mut q = queue.lock().await;
                    q.pop_front()
                };
                let Some((start, end)) = next else {
                    break;
                };
                let range_hdr = format!("bytes={start}-{end}");
                let resp_res = tokio::time::timeout(
                    Duration::from_secs(10),
                    client
                        .get(&url)
                        .header(reqwest::header::RANGE, range_hdr)
                        .send(),
                )
                .await;

                let mut resp = match resp_res {
                    Ok(Ok(r)) if r.status() == reqwest::StatusCode::PARTIAL_CONTENT => r,
                    Ok(Ok(r)) => {
                        if let Ok(mut e) = first_err.lock() {
                            if e.is_none() {
                                *e = Some(format!("{source}: 分片返回 HTTP {}", r.status().as_u16()));
                            }
                        }
                        abort_flag.store(true, Ordering::Relaxed);
                        break;
                    }
                    Ok(Err(err)) => {
                        if let Ok(mut e) = first_err.lock() {
                            if e.is_none() {
                                *e = Some(format!("{source}: {err}"));
                            }
                        }
                        abort_flag.store(true, Ordering::Relaxed);
                        break;
                    }
                    Err(_) => {
                        if let Ok(mut e) = first_err.lock() {
                            if e.is_none() {
                                *e = Some(format!("{source}: 分片请求超时"));
                            }
                        }
                        abort_flag.store(true, Ordering::Relaxed);
                        break;
                    }
                };

                let mut cursor = start;
                while !abort_flag.load(Ordering::Relaxed) {
                    match tokio::time::timeout(Duration::from_secs(10), resp.chunk()).await {
                        Ok(Ok(Some(chunk))) => {
                            let len = chunk.len() as u64;
                            if cursor.saturating_add(len) > end.saturating_add(1) {
                                if let Ok(mut e) = first_err.lock() {
                                    if e.is_none() {
                                        *e = Some(format!("{source}: 服务端分片范围越界"));
                                    }
                                }
                                abort_flag.store(true, Ordering::Relaxed);
                                break;
                            }
                            let write_res = {
                                let mut f = match shared_file.lock() {
                                    Ok(guard) => guard,
                                    Err(_) => {
                                        abort_flag.store(true, Ordering::Relaxed);
                                        break;
                                    }
                                };
                                f.seek(SeekFrom::Start(cursor))
                                    .and_then(|_| f.write_all(&chunk))
                            };
                            if let Err(err) = write_res {
                                if let Ok(mut e) = first_err.lock() {
                                    if e.is_none() {
                                        *e = Some(format!("写入临时文件失败: {err}"));
                                    }
                                }
                                abort_flag.store(true, Ordering::Relaxed);
                                break;
                            }
                            cursor += len;
                            downloaded.fetch_add(len, Ordering::Relaxed);
                            last_byte_ms
                                .store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
                        }
                        Ok(Ok(None)) => break,
                        Ok(Err(err)) => {
                            if let Ok(mut e) = first_err.lock() {
                                if e.is_none() {
                                    *e = Some(format!("{source} 下载中断: {err}"));
                                }
                            }
                            abort_flag.store(true, Ordering::Relaxed);
                            break;
                        }
                        Err(_) => {
                            if let Ok(mut e) = first_err.lock() {
                                if e.is_none() {
                                    *e = Some(format!("{source} 分片接收超时"));
                                }
                            }
                            abort_flag.store(true, Ordering::Relaxed);
                            break;
                        }
                    }
                }

                if !abort_flag.load(Ordering::Relaxed)
                    && cursor != end + 1
                {
                    if let Ok(mut e) = first_err.lock() {
                        if e.is_none() {
                            *e = Some(format!("{source} 分片提前结束"));
                        }
                    }
                    abort_flag.store(true, Ordering::Relaxed);
                    break;
                }
            }
            active_workers.fetch_sub(1, Ordering::Relaxed);
        }));
    }

    while active_workers.load(Ordering::Relaxed) > 0 {
        tokio::time::sleep(Duration::from_millis(120)).await;
        let cur_dl = downloaded.load(Ordering::Relaxed);
        let elapsed_ms = started.elapsed().as_millis() as u64;
        if has_fallback && !abort_flag.load(Ordering::Relaxed) {
            let idle_ms = elapsed_ms.saturating_sub(last_byte_ms.load(Ordering::Relaxed));
            if idle_ms >= STALL_ABORT_SECS * 1000 {
                if let Ok(mut e) = first_err.lock() {
                    if e.is_none() {
                        *e = Some(format!("{source} 下载停滞，切换备用源"));
                    }
                }
                abort_flag.store(true, Ordering::Relaxed);
                break;
            }
            if elapsed_ms >= SLOW_SPEED_CHECK_SECS * 1000 {
                let bps = (cur_dl as f64) / ((elapsed_ms as f64) / 1000.0);
                if bps < SLOW_SPEED_MIN_BPS {
                    if let Ok(mut e) = first_err.lock() {
                        if e.is_none() {
                            *e = Some(format!("{source} 下载过慢，切换更快镜像"));
                        }
                    }
                    abort_flag.store(true, Ordering::Relaxed);
                    break;
                }
            }
        }
        let bps = if elapsed_ms > 200 {
            (cur_dl as f64) / ((elapsed_ms as f64) / 1000.0)
        } else {
            0.0
        };
        let speed = format_speed(bps);
        let pct = ((cur_dl.saturating_mul(100)) / total_bytes.max(1)).min(99) as u8;
        emit_progress(
            app,
            UpdateProgressEvent {
                phase: "downloading",
                version: version.to_string(),
                downloaded_bytes: cur_dl,
                total_bytes: Some(total_bytes),
                percent: Some(pct),
                source: Some(source.to_string()),
                message: Some(if speed.is_empty() {
                    format!("正在从 {source} 并发下载…")
                } else {
                    format!("正在高速下载更新… {speed}")
                }),
            },
        );
    }

    for h in handles {
        let _ = h.await;
    }

    if let Ok(guard) = first_err.lock() {
        if let Some(err) = guard.as_ref() {
            return Err(err.clone());
        }
    }
    if abort_flag.load(Ordering::Relaxed) {
        return Err(format!("{source} 下载已中止"));
    }

    {
        let mut f = shared_file
            .lock()
            .map_err(|_| "文件锁异常".to_string())?;
        f.flush().map_err(|e| format!("刷新文件失败: {e}"))?;
    }
    drop(shared_file);

    let got = downloaded.load(Ordering::Relaxed);
    if got != total_bytes {
        return Err(format!("{source} 下载大小不一致 ({got}/{total_bytes})"));
    }
    Ok(got)
}

async fn download_single_stream(
    app: &AppHandle,
    version: &str,
    source: &str,
    url: &str,
    part_path: &Path,
    has_fallback: bool,
) -> Result<u64, String> {
    let client = client_for_updater()?;
    let resp = match tokio::time::timeout(Duration::from_secs(12), client.get(url).send()).await {
        Ok(Ok(r)) if r.status().is_success() => r,
        Ok(Ok(r)) => return Err(format!("{source}: HTTP {}", r.status().as_u16())),
        Ok(Err(e)) => return Err(format!("{source}: {e}")),
        Err(_) => return Err(format!("{source}: 连接超时")),
    };

    let total_bytes = resp
        .content_length()
        .filter(|&n| n > 0 && n <= MAX_ASSET_BYTES);
    let file = File::create(part_path).map_err(|e| format!("创建临时安装包失败: {e}"))?;
    let mut writer = BufWriter::new(file);
    let mut downloaded: u64 = 0;
    let started = Instant::now();
    let mut last_emit = Instant::now();
    let mut resp = resp;

    loop {
        let chunk_timeout = Duration::from_secs(if has_fallback { STALL_ABORT_SECS } else { 20 });
        match tokio::time::timeout(chunk_timeout, resp.chunk()).await {
            Ok(Ok(Some(chunk))) => {
                downloaded = downloaded.saturating_add(chunk.len() as u64);
                if downloaded > MAX_ASSET_BYTES {
                    return Err("安装包超出大小限制".into());
                }
                writer
                    .write_all(&chunk)
                    .map_err(|e| format!("写入临时文件失败: {e}"))?;

                let elapsed_ms = started.elapsed().as_millis() as u64;
                if has_fallback && elapsed_ms >= SLOW_SPEED_CHECK_SECS * 1000 {
                    let bps = (downloaded as f64) / ((elapsed_ms as f64) / 1000.0);
                    if bps < SLOW_SPEED_MIN_BPS {
                        return Err(format!("{source} 下载过慢，切换更快镜像"));
                    }
                }
                if last_emit.elapsed() >= Duration::from_millis(100) {
                    last_emit = Instant::now();
                    let bps = if elapsed_ms > 200 {
                        (downloaded as f64) / ((elapsed_ms as f64) / 1000.0)
                    } else {
                        0.0
                    };
                    let speed = format_speed(bps);
                    let pct = total_bytes
                        .map(|tot| ((downloaded.saturating_mul(100)) / tot.max(1)).min(99) as u8);
                    emit_progress(
                        app,
                        UpdateProgressEvent {
                            phase: "downloading",
                            version: version.to_string(),
                            downloaded_bytes: downloaded,
                            total_bytes,
                            percent: pct,
                            source: Some(source.to_string()),
                            message: (!speed.is_empty()).then(|| format!("正在下载更新… {speed}")),
                        },
                    );
                }
            }
            Ok(Ok(None)) => break,
            Ok(Err(e)) => return Err(format!("{source} 下载中断: {e}")),
            Err(_) => return Err(format!("{source} 下载超时停滞")),
        }
    }

    writer
        .flush()
        .map_err(|e| format!("刷新文件失败: {e}"))?;
    if let Some(expected_len) = total_bytes {
        if downloaded != expected_len {
            return Err(format!("{source} 下载大小不一致 ({downloaded}/{expected_len})"));
        }
    }
    Ok(downloaded)
}

#[cfg(test)]
mod tests {
    use super::{
        file_sha256, is_allowed_release_asset_url, macos_current_app_bundle,
    };
    use sha2::{Digest, Sha256};
    use std::path::PathBuf;

    #[test]
    fn allowed_release_asset_urls_accept_github_and_mirrors_and_reject_arbitrary() {
        let asset = "herdr-pocket-0.2.4-macos-arm64.dmg";
        let raw = format!(
            "https://github.com/Crosery/herdr-pocket/releases/download/v0.2.4/{asset}"
        );
        assert!(is_allowed_release_asset_url(&raw, asset));
        assert!(is_allowed_release_asset_url(
            &format!("https://ghfast.top/{raw}"),
            asset
        ));
        assert!(is_allowed_release_asset_url(
            &format!("http://127.0.0.1:8080/{raw}"),
            asset
        ));
        assert!(!is_allowed_release_asset_url(
            &format!("http://evil.example.com/{raw}"),
            asset
        ));
        assert!(!is_allowed_release_asset_url(
            "https://evil.example.com/herdr-pocket-0.2.4-macos-arm64.dmg",
            asset
        ));
        assert!(!is_allowed_release_asset_url(&raw, "../evil.dmg"));
        assert!(!is_allowed_release_asset_url(&format!("{raw}?foo=1"), asset));
        assert!(is_allowed_release_asset_url(
            &format!("https://pocket.example.com/v1/releases/download/v0.2.33/{asset}"),
            asset
        ));
        assert!(is_allowed_release_asset_url(
            &format!("https://pocket.example.com/pocket/v1/releases/download/v0.2.33/{asset}"),
            asset
        ));
        assert!(!is_allowed_release_asset_url(
            &format!("https://pocket.example.com/v1/releases/download/v0.2.33/../{asset}"),
            asset
        ));
        assert!(!is_allowed_release_asset_url(
            &format!("http://pocket.example.com/v1/releases/download/v0.2.33/{asset}"),
            asset
        ));
    }

    #[test]
    fn sha256_file_digest_matches_known_bytes() {
        let path = std::env::temp_dir().join(format!(
            "herdr-pocket-sha-test-{}.bin",
            std::process::id()
        ));
        let data = b"herdr-pocket-updater-test-payload";
        std::fs::write(&path, data).unwrap();
        let expected = super::hex_encode(&Sha256::digest(data));
        assert_eq!(file_sha256(&path).unwrap(), expected);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn resolves_macos_app_bundle_from_executable_path() {
        let exe = PathBuf::from("/Applications/Herdr Pocket.app/Contents/MacOS/herdr-pocket-desktop");
        assert_eq!(
            macos_current_app_bundle(&exe).as_deref(),
            Some(PathBuf::from("/Applications/Herdr Pocket.app").as_path())
        );
        assert_eq!(
            macos_current_app_bundle(PathBuf::from("/usr/local/bin/herdr").as_path()),
            None
        );
    }
}
