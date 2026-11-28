//! Desktop local open-source SOTA audio DSP, VAD, target-speaker extraction,
//! and owner voiceprint verification.
//!
//! Pipeline parity with mobile (`apps/mobile/THIRD_PARTY_NOTICES.md`):
//! - DPDFNet (`dpdfnet_baseline.onnx`, Apache-2.0): streaming 16 kHz speech enhancement
//! - Silero VAD v4 (`silero_vad.onnx`, MIT): speech activity detection
//! - 3D-Speaker ERes2NetV2-zh (`3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx`, Apache-2.0):
//!   multi-prototype 192-dim speaker verification on Kaldi 80-bin fbank
//! - VoxLock v2 (`voxlock_enroll.onnx` + `voxlock_chunk_int8.onnx`, Apache-2.0):
//!   target speaker extraction
//! - Pure-Rust real-time fallback DSP (80 Hz HPF + adaptive spectral noise gate +
//!   1.5-3.8 kHz vocal harmonic presence filter + soft peak normalization <= 0.92)
//!   that always works even offline before ONNX Runtime / model packs are downloaded.

use crate::{config, logging};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::ffi::{CStr, CString};
use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::os::raw::{c_char, c_int, c_void};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub const VOICE_RATE: usize = 16_000;
pub const VOICEPRINT_MODEL_VERSION: &str = "eres2netv2-voxlock-v2";
pub const EVENT_PROGRESS: &str = "voice-ai://progress";
pub const EVENT_ENROLL: &str = "voice-ai://enroll";
pub const EVENT_TEST: &str = "voice-ai://test";

const MAX_MODEL_BYTES: u64 = 150 * 1024 * 1024;
const DEFAULT_THRESHOLD: f32 = 0.38;
const OWNER_SAMPLE_LEN: usize = 48_000;

const DPDF_SIZE: u64 = 8_791_035;
const DPDF_SHA256: &str = "debaf0e8893479fca91b8b4c1eae8db195aa8980ccc9012f5809fde2b738151a";
const VAD_SIZE: u64 = 643_854;
const VAD_SHA256: &str = "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6";

pub const SV_SIZE: u64 = 71_441_527;
pub const SV_SHA256: &str = "eda0bf86422a9725a3523d5a1d3d75dedf340664e0ba65cfc1c7b2a78b6cf0b5";
pub const VOXLOCK_ENROLL_SIZE: u64 = 21_023_799;
pub const VOXLOCK_ENROLL_SHA256: &str =
    "81f305c9b7a32f13d1401f53bb4c6301826a607c9e807e60912f36ef1b9fae29";
pub const VOXLOCK_CHUNK_SIZE: u64 = 56_560_589;
pub const VOXLOCK_CHUNK_SHA256: &str =
    "c50ffdc8d723fd4f91cb08889f3d0143491f95967b705f35c444a0b4afe88172";

const SV_SIZE_MB: u64 = 68;
const TSE_SIZE_MB: u64 = 142;

const DPDF_FILE: &str = "dpdfnet_baseline.onnx";
const VAD_FILE: &str = "silero_vad.onnx";
const SV_FILE: &str = "3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx";
const VOXLOCK_ENROLL_FILE: &str = "voxlock_enroll.onnx";
const VOXLOCK_CHUNK_FILE: &str = "voxlock_chunk_int8.onnx";

#[derive(Clone, Copy)]
struct ModelSpec {
    file_name: &'static str,
    stamp_name: &'static str,
    size: u64,
    sha256: &'static str,
    urls: &'static [&'static str],
}

const DPDF_SPEC: ModelSpec = ModelSpec {
    file_name: DPDF_FILE,
    stamp_name: "dpdfnet_baseline.ok",
    size: DPDF_SIZE,
    sha256: DPDF_SHA256,
    urls: &[
        "https://github.com/Crosery/herdr-pocket/raw/main/apps/mobile/modules/pocket-native/ios/Resources/voice/dpdfnet_baseline.onnx",
        "https://cdn.jsdelivr.net/gh/Crosery/herdr-pocket@main/apps/mobile/modules/pocket-native/ios/Resources/voice/dpdfnet_baseline.onnx",
    ],
};

const VAD_SPEC: ModelSpec = ModelSpec {
    file_name: VAD_FILE,
    stamp_name: "silero_vad.ok",
    size: VAD_SIZE,
    sha256: VAD_SHA256,
    urls: &[
        "https://github.com/Crosery/herdr-pocket/raw/main/apps/mobile/modules/pocket-native/ios/Resources/voice/silero_vad.onnx",
        "https://cdn.jsdelivr.net/gh/Crosery/herdr-pocket@main/apps/mobile/modules/pocket-native/ios/Resources/voice/silero_vad.onnx",
    ],
};

const SV_SPEC: ModelSpec = ModelSpec {
    file_name: SV_FILE,
    stamp_name: "eres2netv2.ok",
    size: SV_SIZE,
    sha256: SV_SHA256,
    urls: &[
        "https://hf-mirror.com/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
        "https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
        "https://ghfast.top/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
        "https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
        "https://cdn.gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx",
    ],
};

const VOXLOCK_ENROLL_SPEC: ModelSpec = ModelSpec {
    file_name: VOXLOCK_ENROLL_FILE,
    stamp_name: "voxlock_enroll.ok",
    size: VOXLOCK_ENROLL_SIZE,
    sha256: VOXLOCK_ENROLL_SHA256,
    urls: &[
        "https://hf-mirror.com/arbazsiddiqui/voxlock/resolve/main/onnx/v2/enroll.onnx",
        "https://huggingface.co/arbazsiddiqui/voxlock/resolve/main/onnx/v2/enroll.onnx",
    ],
};

const VOXLOCK_CHUNK_SPEC: ModelSpec = ModelSpec {
    file_name: VOXLOCK_CHUNK_FILE,
    stamp_name: "voxlock_chunk_int8.ok",
    size: VOXLOCK_CHUNK_SIZE,
    sha256: VOXLOCK_CHUNK_SHA256,
    urls: &[
        "https://hf-mirror.com/arbazsiddiqui/voxlock/resolve/main/onnx/v2/chunk_int8.onnx",
        "https://huggingface.co/arbazsiddiqui/voxlock/resolve/main/onnx/v2/chunk_int8.onnx",
    ],
};

#[cfg(test)]
const ALL_MODEL_SPECS: &[ModelSpec] = &[
    DPDF_SPEC,
    VAD_SPEC,
    SV_SPEC,
    VOXLOCK_ENROLL_SPEC,
    VOXLOCK_CHUNK_SPEC,
];

// ---------------------------------------------------------------------------
// Public state & configuration types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceprintRecord {
    pub embedding: Vec<f32>,
    #[serde(default)]
    pub prototypes: Vec<Vec<f32>>,
    pub model_version: String,
    #[serde(default)]
    pub has_sample: bool,
    #[serde(default)]
    pub route: Option<String>,
    #[serde(default)]
    pub snr_db: Option<f32>,
    #[serde(default)]
    pub seconds: f32,
    #[serde(default)]
    pub consistency: f32,
    #[serde(default)]
    pub lowest: f32,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAiConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default = "default_true")]
    pub denoise: bool,
    #[serde(default = "default_true")]
    pub enhance_vocal: bool,
    #[serde(default = "default_tier")]
    pub tier: String,
    #[serde(default)]
    pub filter: bool,
    #[serde(default = "default_threshold")]
    pub threshold: f32,
    #[serde(default = "default_true")]
    pub first_speaker: bool,
    #[serde(default)]
    pub recommended_tier: Option<String>,
    #[serde(default)]
    pub recommend_reason: Option<String>,
    #[serde(default)]
    pub bench_dpdf_us: Option<f64>,
    #[serde(default)]
    pub bench_tse_rtf: Option<f64>,
    #[serde(default)]
    pub bench_at: Option<i64>,
    #[serde(default)]
    pub voiceprint: Option<VoiceprintRecord>,
}

fn default_version() -> u32 {
    1
}
fn default_true() -> bool {
    true
}
fn default_tier() -> String {
    "auto".into()
}
fn default_threshold() -> f32 {
    DEFAULT_THRESHOLD
}

impl Default for VoiceAiConfig {
    fn default() -> Self {
        Self {
            version: 1,
            denoise: true,
            enhance_vocal: true,
            tier: "auto".into(),
            filter: false,
            threshold: DEFAULT_THRESHOLD,
            first_speaker: true,
            recommended_tier: None,
            recommend_reason: None,
            bench_dpdf_us: None,
            bench_tse_rtf: None,
            bench_at: None,
            voiceprint: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAiConfigPatch {
    pub denoise: Option<bool>,
    pub enhance_vocal: Option<bool>,
    pub filter: Option<bool>,
    pub tier: Option<String>,
    pub threshold: Option<f32>,
    pub first_speaker: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAiState {
    pub supported: bool,
    pub active_engine: String,
    pub denoise: bool,
    pub enhance_vocal: bool,
    pub filter: bool,
    pub tier: String,
    pub recommended_tier: Option<String>,
    pub recommend_reason: Option<String>,
    pub threshold: f32,
    pub first_speaker: bool,
    pub dpdf_ready: bool,
    pub vad_ready: bool,
    pub sv_ready: bool,
    pub tse_ready: bool,
    pub sv_size_mb: u64,
    pub tse_size_mb: u64,
    pub downloading: bool,
    pub progress: f32,
    pub dl_label: Option<String>,
    pub dl_error: Option<String>,
    pub enrolled: bool,
    pub enroll_seconds: f32,
    pub ort_ready: bool,
    pub ort_version: Option<String>,
    pub prototypes_count: usize,
    pub consistency: f32,
    pub snr_db: Option<f32>,
    pub has_sample: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAiBenchmarkResult {
    pub recommended_tier: String,
    pub reason: String,
    pub dpdf_us: f64,
    pub tse_rtf: f64,
    pub cores: usize,
    pub ram_mb: u64,
    pub ort_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAiEnrollResult {
    pub seconds: f32,
    pub consistency: f32,
    pub lowest: f32,
    pub snr_db: f32,
    pub prototypes_count: usize,
    pub has_sample: bool,
    pub state: VoiceAiState,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub enum ProcessOutcome {
    Accept {
        samples: Vec<i16>,
        dsp_badge: Option<String>,
    },
    RejectNonOwner {
        reason: String,
        score: f32,
    },
}

#[derive(Debug, Clone)]
struct DownloadSnapshot {
    downloading: bool,
    progress: f32,
    dl_label: Option<String>,
    dl_error: Option<String>,
}

impl Default for DownloadSnapshot {
    fn default() -> Self {
        Self {
            downloading: false,
            progress: 0.0,
            dl_label: None,
            dl_error: None,
        }
    }
}

static CONFIG_CACHE: OnceLock<Mutex<Option<VoiceAiConfig>>> = OnceLock::new();
static HUD_BADGE_CACHE: OnceLock<Mutex<HudBadgeCache>> = OnceLock::new();
static HUD_BADGE_GEN: AtomicU64 = AtomicU64::new(0);
static DL_STATUS: OnceLock<Mutex<DownloadSnapshot>> = OnceLock::new();
static DL_CANCEL: AtomicBool = AtomicBool::new(false);
static DL_GEN: AtomicU64 = AtomicU64::new(0);
static ACTIVE_DOWNLOAD: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct HudBadgeCache {
    gen: u64,
    value: Option<Option<String>>,
}

impl HudBadgeCache {
    fn get_cached(&self, gen: u64) -> Option<Option<String>> {
        if self.gen == gen {
            self.value.clone()
        } else {
            None
        }
    }

    fn store(&mut self, gen: u64, value: Option<String>) {
        self.gen = gen;
        self.value = Some(value);
    }

    fn invalidate(&mut self) {
        self.value = None;
    }
}

fn hud_badge_cache() -> &'static Mutex<HudBadgeCache> {
    HUD_BADGE_CACHE.get_or_init(|| Mutex::new(HudBadgeCache::default()))
}

pub fn invalidate_hud_badge_cache() {
    HUD_BADGE_GEN.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = hud_badge_cache().lock() {
        guard.invalidate();
    }
}

fn config_lock() -> &'static Mutex<Option<VoiceAiConfig>> {
    CONFIG_CACHE.get_or_init(|| Mutex::new(None))
}

fn dl_lock() -> &'static Mutex<DownloadSnapshot> {
    DL_STATUS.get_or_init(|| Mutex::new(DownloadSnapshot::default()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn config_file_path() -> Option<PathBuf> {
    crate::hostd_config_dir().map(|d| d.join("voice-ai.json"))
}

fn models_dir() -> Option<PathBuf> {
    crate::hostd_config_dir().map(|d| d.join("voice-models"))
}

fn voiceprint_cache_path() -> Option<PathBuf> {
    if let Some(custom) = std::env::var_os("HERDR_POCKET_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(custom).join("voiceprint-cache.json"));
    }
    #[cfg(windows)]
    {
        let base = std::env::var_os("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| crate::home_dir().map(|h| h.join("AppData").join("Local")));
        return base.map(|d| d.join("herdr-pocket").join("voiceprint-cache.json"));
    }
    #[cfg(not(windows))]
    {
        crate::home_dir().map(|h| {
            h.join(".local")
                .join("state")
                .join("herdr-pocket")
                .join("voiceprint-cache.json")
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceprintBackup {
    voiceprint: VoiceprintRecord,
    #[serde(default)]
    sample_pcm16_b64: Option<String>,
}

fn read_owner_sample_base64() -> Option<String> {
    let p = owner_sample_path()?;
    let bytes = fs::read(p).ok()?;
    if bytes.len() < OWNER_SAMPLE_LEN * 2 {
        return None;
    }
    Some(crate::local_term::base64_encode(&bytes))
}

fn write_owner_sample_base64(b64: &str) -> bool {
    let Some(bytes) = crate::local_term::base64_decode(b64.as_bytes()) else {
        return false;
    };
    if bytes.len() < OWNER_SAMPLE_LEN * 2 {
        return false;
    }
    let Some(p) = owner_sample_path() else {
        return false;
    };
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    config::write_atomic(&p, &bytes).is_ok()
}

fn is_valid_voiceprint(vp: &VoiceprintRecord) -> bool {
    vp.embedding.len() >= 64
        && vp.embedding.len() <= 2048
        && vp.embedding.iter().all(|v| v.is_finite())
        && !vp.model_version.trim().is_empty()
}

fn write_voiceprint_backup(vp: &VoiceprintRecord) {
    if !is_valid_voiceprint(vp) {
        return;
    }
    let Some(path) = voiceprint_cache_path() else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let backup = VoiceprintBackup {
        voiceprint: vp.clone(),
        sample_pcm16_b64: read_owner_sample_base64(),
    };
    if let Ok(mut bytes) = serde_json::to_vec_pretty(&backup) {
        bytes.push(b'\n');
        let _ = config::write_atomic(&path, &bytes);
    }
}

fn delete_voiceprint_backup() {
    if let Some(path) = voiceprint_cache_path() {
        let _ = fs::remove_file(path);
    }
}

fn try_restore_voiceprint_from_cache(cfg: &mut VoiceAiConfig) -> bool {
    if cfg.voiceprint.is_some() {
        return false;
    }
    let Some(path) = voiceprint_cache_path() else {
        return false;
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(backup) = serde_json::from_str::<VoiceprintBackup>(&raw) else {
        return false;
    };
    if !is_valid_voiceprint(&backup.voiceprint) {
        return false;
    }
    if !has_owner_sample() {
        if let Some(b64) = backup.sample_pcm16_b64.as_deref() {
            let _ = write_owner_sample_base64(b64);
        }
    }
    let mut vp = backup.voiceprint;
    vp.has_sample = has_owner_sample();
    cfg.voiceprint = Some(vp);
    true
}

fn sanitize_tier(raw: &str) -> String {
    match raw.trim() {
        "denoise" | "sv" | "tse" | "auto" => raw.trim().to_string(),
        _ => "auto".to_string(),
    }
}

fn clamp_threshold(v: f32) -> f32 {
    if !v.is_finite() {
        return DEFAULT_THRESHOLD;
    }
    v.clamp(0.15, 0.80)
}

pub fn load_config() -> VoiceAiConfig {
    if let Ok(guard) = config_lock().lock() {
        if let Some(cfg) = guard.as_ref() {
            return cfg.clone();
        }
    }
    let mut loaded = config_file_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<VoiceAiConfig>(&raw).ok())
        .map(|mut c| {
            c.tier = sanitize_tier(&c.tier);
            c.threshold = clamp_threshold(c.threshold);
            c
        })
        .unwrap_or_default();
    if try_restore_voiceprint_from_cache(&mut loaded) {
        if let Some(path) = config_file_path() {
            if let Some(dir) = path.parent() {
                let _ = fs::create_dir_all(dir);
            }
            if let Ok(mut bytes) = serde_json::to_vec_pretty(&loaded) {
                bytes.push(b'\n');
                let _ = config::write_atomic(&path, &bytes);
            }
        }
    }
    if let Ok(mut guard) = config_lock().lock() {
        *guard = Some(loaded.clone());
    }
    loaded
}

pub fn save_config(cfg: &VoiceAiConfig) -> Result<(), String> {
    let mut clean = cfg.clone();
    clean.tier = sanitize_tier(&clean.tier);
    clean.threshold = clamp_threshold(clean.threshold);
    let path = config_file_path().ok_or_else(|| "找不到配置文件夹".to_string())?;
    let mut bytes = serde_json::to_vec_pretty(&clean).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    config::write_atomic(&path, &bytes).map_err(|e| format!("保存 voice-ai.json 失败：{e}"))?;
    if let Some(ref vp) = clean.voiceprint {
        write_voiceprint_backup(vp);
    }
    if let Ok(mut guard) = config_lock().lock() {
        *guard = Some(clean);
    }
    invalidate_hud_badge_cache();
    Ok(())
}

// ---------------------------------------------------------------------------
// Dynamic ONNX Runtime C API Loader (zero extra Cargo crates)
// ---------------------------------------------------------------------------

mod ort {
    use super::*;

    #[cfg(windows)]
    pub type OrtChar = u16;
    #[cfg(not(windows))]
    pub type OrtChar = c_char;

    #[repr(C)]
    pub struct OrtEnv {
        _private: [u8; 0],
    }
    #[repr(C)]
    pub struct OrtStatus {
        _private: [u8; 0],
    }
    #[repr(C)]
    pub struct OrtMemoryInfo {
        _private: [u8; 0],
    }
    #[repr(C)]
    pub struct OrtSession {
        _private: [u8; 0],
    }
    #[repr(C)]
    pub struct OrtValue {
        _private: [u8; 0],
    }
    #[repr(C)]
    pub struct OrtRunOptions {
        _private: [u8; 0],
    }
    #[repr(C)]
    pub struct OrtTensorTypeAndShapeInfo {
        _private: [u8; 0],
    }
    #[repr(C)]
    pub struct OrtSessionOptions {
        _private: [u8; 0],
    }
    #[repr(C)]
    pub struct OrtAllocator {
        _private: [u8; 0],
    }

    #[repr(C)]
    struct OrtApiBase {
        get_api: unsafe extern "system" fn(u32) -> *const *const c_void,
        get_version_string: unsafe extern "system" fn() -> *const c_char,
    }

    pub const ELEMENT_FLOAT: i32 = 1;
    pub const LOGGING_WARNING: i32 = 2;
    pub const GRAPH_OPT_ALL: i32 = 99;
    pub const ALLOCATOR_ARENA: i32 = 1;
    pub const MEM_DEFAULT: i32 = 0;

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum ExecutionProvider {
        /// Pure CPU execution provider (preferred for tiny 10 ms stateful recurrent models).
        Cpu,
        /// Prefer Apple CoreML Execution Provider (ANE-only) on macOS for heavy neural models,
        /// with guaranteed automatic fallback to CPU EP on non-macOS, Intel Macs without ANE,
        /// missing symbol, or `CreateSession` failure.
        CoreMlPreferred,
    }

    #[cfg(target_os = "macos")]
    #[allow(dead_code)]
    pub const COREML_FLAG_USE_NONE: u32 = 0x000;
    /// `COREML_FLAG_ONLY_ENABLE_DEVICE_WITH_ANE` from ONNX Runtime `coreml_provider_factory.h`:
    /// activates CoreML EP only on ANE-equipped Macs (Apple Silicon) while keeping Intel Macs on CPU.
    #[cfg(target_os = "macos")]
    pub const COREML_FLAG_ONLY_ENABLE_DEVICE_WITH_ANE: u32 = 0x004;

    // Exact slot indices from ONNX Runtime `onnxruntime_c_api.h` (stable since API v7/v10..v24).
    const IDX_GET_ERROR_CODE: usize = 1;
    const IDX_GET_ERROR_MESSAGE: usize = 2;
    const IDX_CREATE_ENV: usize = 3;
    const IDX_CREATE_SESSION: usize = 7;
    const IDX_RUN: usize = 9;
    const IDX_CREATE_SESSION_OPTIONS: usize = 10;
    const IDX_SET_GRAPH_OPT_LEVEL: usize = 23;
    const IDX_SET_INTRA_OP_THREADS: usize = 24;
    const IDX_SET_INTER_OP_THREADS: usize = 25;
    const IDX_SESSION_GET_INPUT_COUNT: usize = 30;
    const IDX_SESSION_GET_OUTPUT_COUNT: usize = 31;
    const IDX_SESSION_GET_INPUT_NAME: usize = 36;
    const IDX_SESSION_GET_OUTPUT_NAME: usize = 37;
    const IDX_CREATE_TENSOR_WITH_DATA: usize = 49;
    const IDX_GET_TENSOR_MUTABLE_DATA: usize = 51;
    const IDX_GET_TENSOR_ELEMENT_TYPE: usize = 60;
    const IDX_GET_TENSOR_SHAPE_COUNT: usize = 64;
    const IDX_GET_TENSOR_TYPE_AND_SHAPE: usize = 65;
    const IDX_CREATE_CPU_MEMORY_INFO: usize = 69;
    const IDX_ALLOCATOR_FREE: usize = 76;
    const IDX_GET_ALLOCATOR_DEFAULT: usize = 78;
    const IDX_RELEASE_ENV: usize = 92;
    const IDX_RELEASE_STATUS: usize = 93;
    const IDX_RELEASE_MEMORY_INFO: usize = 94;
    const IDX_RELEASE_SESSION: usize = 95;
    const IDX_RELEASE_VALUE: usize = 96;
    const IDX_RELEASE_TENSOR_INFO: usize = 99;
    const IDX_RELEASE_SESSION_OPTIONS: usize = 100;
    const IDX_ADD_SESSION_CONFIG_ENTRY: usize = 130;

    struct SharedLib {
        handle: *mut c_void,
    }

    unsafe impl Send for SharedLib {}
    unsafe impl Sync for SharedLib {}

    impl Drop for SharedLib {
        fn drop(&mut self) {
            if !self.handle.is_null() {
                #[cfg(unix)]
                unsafe {
                    libc::dlclose(self.handle);
                }
                #[cfg(windows)]
                unsafe {
                    windows_sys::Win32::Foundation::FreeLibrary(self.handle);
                }
            }
        }
    }

    impl SharedLib {
        fn open(path: &Path) -> Result<Self, String> {
            verify_downloaded_ort_before_open(path)?;
            #[cfg(target_os = "macos")]
            strip_macos_quarantine(path);
            #[cfg(unix)]
            {
                use std::os::unix::ffi::OsStrExt;
                let cpath = CString::new(path.as_os_str().as_bytes())
                    .map_err(|_| "无效的动态库路径".to_string())?;
                let h = unsafe { libc::dlopen(cpath.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL) };
                if h.is_null() {
                    let err = unsafe { libc::dlerror() };
                    let msg = if err.is_null() {
                        "dlopen failed".to_string()
                    } else {
                        unsafe { CStr::from_ptr(err) }.to_string_lossy().into_owned()
                    };
                    logging::warn(
                        "voice.ai",
                        "dlopen onnxruntime failed",
                        serde_json::json!({ "path": path.display().to_string(), "error": msg }),
                    );
                    if msg.contains("different Team IDs") || msg.contains("not valid for use in process") {
                        return Err("当前桌面端安装包签名授权未放行外置 ONNX 运行库（Team ID 受限），请升级至最新正式版桌面端后重试".into());
                    }
                    return Err(format!("加载 ONNX Runtime 失败 ({}): {msg}", path.display()));
                }
                Ok(Self { handle: h })
            }
            #[cfg(windows)]
            {
                use std::os::windows::ffi::OsStrExt;
                use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;
                let wide: Vec<u16> = path
                    .as_os_str()
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();
                let h = unsafe { LoadLibraryW(wide.as_ptr()) };
                if h.is_null() {
                    return Err(format!("LoadLibraryW 失败: {}", path.display()));
                }
                Ok(Self { handle: h })
            }
            #[cfg(not(any(unix, windows)))]
            {
                let _ = path;
                Err("不支持的平台".into())
            }
        }

        unsafe fn symbol(&self, name: &str) -> Option<*const c_void> {
            let cname = CString::new(name).ok()?;
            #[cfg(unix)]
            {
                let p = libc::dlsym(self.handle, cname.as_ptr());
                if p.is_null() {
                    None
                } else {
                    Some(p as *const c_void)
                }
            }
            #[cfg(windows)]
            {
                use windows_sys::Win32::System::LibraryLoader::GetProcAddress;
                GetProcAddress(self.handle, cname.as_ptr().cast()).map(|f| f as *const c_void)
            }
            #[cfg(not(any(unix, windows)))]
            {
                None
            }
        }
    }

    pub struct OrtRuntime {
        _lib: SharedLib,
        table: *const *const c_void,
        env: *mut OrtEnv,
        mem_info: *mut OrtMemoryInfo,
        allocator: *mut OrtAllocator,
        pub version: String,
    }

    unsafe impl Send for OrtRuntime {}
    unsafe impl Sync for OrtRuntime {}

    impl Drop for OrtRuntime {
        fn drop(&mut self) {
            unsafe {
                if !self.mem_info.is_null() {
                    let f: unsafe extern "system" fn(*mut OrtMemoryInfo) =
                        std::mem::transmute(self.slot(IDX_RELEASE_MEMORY_INFO));
                    f(self.mem_info);
                }
                if !self.env.is_null() {
                    let f: unsafe extern "system" fn(*mut OrtEnv) =
                        std::mem::transmute(self.slot(IDX_RELEASE_ENV));
                    f(self.env);
                }
            }
        }
    }

    impl OrtRuntime {
        #[inline]
        unsafe fn slot(&self, idx: usize) -> *const c_void {
            *self.table.add(idx)
        }

        pub fn load_from(path: &Path) -> Result<Arc<Self>, String> {
            let lib = SharedLib::open(path)?;
            let sym = unsafe { lib.symbol("OrtGetApiBase") }
                .ok_or_else(|| "动态库缺少 OrtGetApiBase 符号".to_string())?;
            let get_base: unsafe extern "system" fn() -> *const OrtApiBase =
                unsafe { std::mem::transmute(sym) };
            let base = unsafe { get_base() };
            if base.is_null() {
                return Err("OrtGetApiBase 返回空指针".into());
            }
            let version = unsafe {
                let s = ((*base).get_version_string)();
                if s.is_null() {
                    "unknown".to_string()
                } else {
                    CStr::from_ptr(s).to_string_lossy().into_owned()
                }
            };
            let mut table: *const *const c_void = std::ptr::null();
            for ver in [24u32, 23, 22, 21, 20, 18, 16, 14, 10] {
                let ptr = unsafe { ((*base).get_api)(ver) };
                if !ptr.is_null() {
                    table = ptr;
                    break;
                }
            }
            if table.is_null() {
                return Err(format!("ONNX Runtime 版本不受支持 ({version})"));
            }

            let mut rt = Self {
                _lib: lib,
                table,
                env: std::ptr::null_mut(),
                mem_info: std::ptr::null_mut(),
                allocator: std::ptr::null_mut(),
                version,
            };

            let log_id = CString::new("PocketVoice").unwrap();
            let create_env: unsafe extern "system" fn(
                i32,
                *const c_char,
                *mut *mut OrtEnv,
            ) -> *mut OrtStatus = unsafe { std::mem::transmute(rt.slot(IDX_CREATE_ENV)) };
            let st = unsafe { create_env(LOGGING_WARNING, log_id.as_ptr(), &mut rt.env) };
            rt.check_status(st)?;

            let create_mem: unsafe extern "system" fn(
                i32,
                i32,
                *mut *mut OrtMemoryInfo,
            ) -> *mut OrtStatus =
                unsafe { std::mem::transmute(rt.slot(IDX_CREATE_CPU_MEMORY_INFO)) };
            let st = unsafe { create_mem(ALLOCATOR_ARENA, MEM_DEFAULT, &mut rt.mem_info) };
            rt.check_status(st)?;

            let get_alloc: unsafe extern "system" fn(*mut *mut OrtAllocator) -> *mut OrtStatus =
                unsafe { std::mem::transmute(rt.slot(IDX_GET_ALLOCATOR_DEFAULT)) };
            let st = unsafe { get_alloc(&mut rt.allocator) };
            rt.check_status(st)?;

            Ok(Arc::new(rt))
        }

        fn check_status(&self, st: *mut OrtStatus) -> Result<(), String> {
            if st.is_null() {
                return Ok(());
            }
            unsafe {
                let get_code: unsafe extern "system" fn(*const OrtStatus) -> i32 =
                    std::mem::transmute(self.slot(IDX_GET_ERROR_CODE));
                let get_msg: unsafe extern "system" fn(*const OrtStatus) -> *const c_char =
                    std::mem::transmute(self.slot(IDX_GET_ERROR_MESSAGE));
                let release: unsafe extern "system" fn(*mut OrtStatus) =
                    std::mem::transmute(self.slot(IDX_RELEASE_STATUS));
                let code = get_code(st);
                let msg_ptr = get_msg(st);
                let msg = if msg_ptr.is_null() {
                    format!("ONNX Runtime error ({code})")
                } else {
                    CStr::from_ptr(msg_ptr).to_string_lossy().into_owned()
                };
                release(st);
                Err(msg)
            }
        }

        #[cfg(target_os = "macos")]
        fn append_coreml_ep(
            &self,
            opts: *mut OrtSessionOptions,
            flags: u32,
        ) -> Result<(), String> {
            let Some(sym) = (unsafe {
                self._lib
                    .symbol("OrtSessionOptionsAppendExecutionProvider_CoreML")
            }) else {
                return Err(
                    "OrtSessionOptionsAppendExecutionProvider_CoreML symbol not exported".into(),
                );
            };
            let append_fn: unsafe extern "C" fn(*mut OrtSessionOptions, u32) -> *mut OrtStatus =
                unsafe { std::mem::transmute(sym) };
            let st = unsafe { append_fn(opts, flags) };
            self.check_status(st)
        }
    }

    struct SessionInner {
        rt: Arc<OrtRuntime>,
        raw: *mut OrtSession,
    }

    unsafe impl Send for SessionInner {}
    unsafe impl Sync for SessionInner {}

    impl Drop for SessionInner {
        fn drop(&mut self) {
            if !self.raw.is_null() {
                unsafe {
                    let f: unsafe extern "system" fn(*mut OrtSession) =
                        std::mem::transmute(self.rt.slot(IDX_RELEASE_SESSION));
                    f(self.raw);
                }
            }
        }
    }

    #[derive(Clone)]
    pub struct Session {
        inner: Arc<SessionInner>,
        pub input_names: Vec<String>,
        pub output_names: Vec<String>,
    }

    struct OptionsGuard<'a> {
        rt: &'a OrtRuntime,
        raw: *mut OrtSessionOptions,
    }

    impl Drop for OptionsGuard<'_> {
        fn drop(&mut self) {
            if !self.raw.is_null() {
                unsafe {
                    let f: unsafe extern "system" fn(*mut OrtSessionOptions) =
                        std::mem::transmute(self.rt.slot(IDX_RELEASE_SESSION_OPTIONS));
                    f(self.raw);
                }
            }
        }
    }

    pub struct Value {
        rt: Arc<OrtRuntime>,
        pub raw: *mut OrtValue,
        _backing: Option<Vec<f32>>,
    }

    unsafe impl Send for Value {}
    unsafe impl Sync for Value {}

    impl Drop for Value {
        fn drop(&mut self) {
            if !self.raw.is_null() {
                unsafe {
                    let f: unsafe extern "system" fn(*mut OrtValue) =
                        std::mem::transmute(self.rt.slot(IDX_RELEASE_VALUE));
                    f(self.raw);
                }
                self.raw = std::ptr::null_mut();
            }
        }
    }

    impl Value {
        pub fn from_f32_vec(
            rt: &Arc<OrtRuntime>,
            mut data: Vec<f32>,
            shape: &[i64],
        ) -> Result<Self, String> {
            let mut val: *mut OrtValue = std::ptr::null_mut();
            let create: unsafe extern "system" fn(
                *const OrtMemoryInfo,
                *mut c_void,
                usize,
                *const i64,
                usize,
                i32,
                *mut *mut OrtValue,
            ) -> *mut OrtStatus =
                unsafe { std::mem::transmute(rt.slot(IDX_CREATE_TENSOR_WITH_DATA)) };
            let byte_len = data.len() * std::mem::size_of::<f32>();
            let st = unsafe {
                create(
                    rt.mem_info,
                    data.as_mut_ptr().cast(),
                    byte_len,
                    shape.as_ptr(),
                    shape.len(),
                    ELEMENT_FLOAT,
                    &mut val,
                )
            };
            rt.check_status(st)?;
            Ok(Self {
                rt: rt.clone(),
                raw: val,
                _backing: Some(data),
            })
        }

        pub fn copy_f32_into(&self, dst: &mut [f32]) -> Result<usize, String> {
            let slice = self.as_f32_slice()?;
            let n = dst.len().min(slice.len());
            dst[..n].copy_from_slice(&slice[..n]);
            Ok(n)
        }

        pub fn to_f32_vec(&self) -> Result<Vec<f32>, String> {
            Ok(self.as_f32_slice()?.to_vec())
        }

        fn as_f32_slice(&self) -> Result<&[f32], String> {
            let get_info: unsafe extern "system" fn(
                *const OrtValue,
                *mut *mut OrtTensorTypeAndShapeInfo,
            ) -> *mut OrtStatus =
                unsafe { std::mem::transmute(self.rt.slot(IDX_GET_TENSOR_TYPE_AND_SHAPE)) };
            let get_type: unsafe extern "system" fn(
                *const OrtTensorTypeAndShapeInfo,
                *mut i32,
            ) -> *mut OrtStatus =
                unsafe { std::mem::transmute(self.rt.slot(IDX_GET_TENSOR_ELEMENT_TYPE)) };
            let get_cnt: unsafe extern "system" fn(
                *const OrtTensorTypeAndShapeInfo,
                *mut usize,
            ) -> *mut OrtStatus =
                unsafe { std::mem::transmute(self.rt.slot(IDX_GET_TENSOR_SHAPE_COUNT)) };
            let rel_info: unsafe extern "system" fn(*mut OrtTensorTypeAndShapeInfo) =
                unsafe { std::mem::transmute(self.rt.slot(IDX_RELEASE_TENSOR_INFO)) };

            let mut info: *mut OrtTensorTypeAndShapeInfo = std::ptr::null_mut();
            self.rt
                .check_status(unsafe { get_info(self.raw, &mut info) })?;
            let mut elem_type: i32 = 0;
            let mut elem_count: usize = 0;
            let st1 = unsafe { get_type(info, &mut elem_type) };
            let st2 = if st1.is_null() {
                unsafe { get_cnt(info, &mut elem_count) }
            } else {
                std::ptr::null_mut()
            };
            unsafe { rel_info(info) };
            self.rt.check_status(st1)?;
            self.rt.check_status(st2)?;
            if elem_type != ELEMENT_FLOAT {
                return Err(format!("输出张量类型不是 float32 ({elem_type})"));
            }
            if elem_count == 0 {
                return Ok(&[]);
            }
            let get_data: unsafe extern "system" fn(*mut OrtValue, *mut *mut c_void) -> *mut OrtStatus =
                unsafe { std::mem::transmute(self.rt.slot(IDX_GET_TENSOR_MUTABLE_DATA)) };
            let mut ptr: *mut c_void = std::ptr::null_mut();
            self.rt
                .check_status(unsafe { get_data(self.raw, &mut ptr) })?;
            if ptr.is_null() {
                return Err("输出张量数据指针为空".into());
            }
            Ok(unsafe { std::slice::from_raw_parts(ptr.cast::<f32>(), elem_count) })
        }
    }

    impl Session {
        fn build_session_options<'a>(
            rt: &'a OrtRuntime,
            intra_threads: i32,
        ) -> Result<OptionsGuard<'a>, String> {
            let mut opts_raw: *mut OrtSessionOptions = std::ptr::null_mut();
            let create_opts: unsafe extern "system" fn(*mut *mut OrtSessionOptions) -> *mut OrtStatus =
                unsafe { std::mem::transmute(rt.slot(IDX_CREATE_SESSION_OPTIONS)) };
            rt.check_status(unsafe { create_opts(&mut opts_raw) })?;
            let opts = OptionsGuard { rt, raw: opts_raw };

            let set_intra: unsafe extern "system" fn(*mut OrtSessionOptions, c_int) -> *mut OrtStatus =
                unsafe { std::mem::transmute(rt.slot(IDX_SET_INTRA_OP_THREADS)) };
            rt.check_status(unsafe { set_intra(opts.raw, intra_threads) })?;

            let set_inter: unsafe extern "system" fn(*mut OrtSessionOptions, c_int) -> *mut OrtStatus =
                unsafe { std::mem::transmute(rt.slot(IDX_SET_INTER_OP_THREADS)) };
            rt.check_status(unsafe { set_inter(opts.raw, 1) })?;

            let set_opt: unsafe extern "system" fn(*mut OrtSessionOptions, i32) -> *mut OrtStatus =
                unsafe { std::mem::transmute(rt.slot(IDX_SET_GRAPH_OPT_LEVEL)) };
            rt.check_status(unsafe { set_opt(opts.raw, GRAPH_OPT_ALL) })?;

            let add_cfg: unsafe extern "system" fn(
                *mut OrtSessionOptions,
                *const c_char,
                *const c_char,
            ) -> *mut OrtStatus =
                unsafe { std::mem::transmute(rt.slot(IDX_ADD_SESSION_CONFIG_ENTRY)) };
            for (k, v) in [
                ("session.intra_op.allow_spinning", "0"),
                ("session.inter_op.allow_spinning", "0"),
            ] {
                let ck = CString::new(k).unwrap();
                let cv = CString::new(v).unwrap();
                let _ = rt.check_status(unsafe { add_cfg(opts.raw, ck.as_ptr(), cv.as_ptr()) });
            }
            Ok(opts)
        }

        fn create_raw_session(
            rt: &OrtRuntime,
            model_path: &Path,
            opts: &OptionsGuard<'_>,
        ) -> Result<*mut OrtSession, String> {
            let mut session_raw: *mut OrtSession = std::ptr::null_mut();
            let create_sess: unsafe extern "system" fn(
                *const OrtEnv,
                *const OrtChar,
                *const OrtSessionOptions,
                *mut *mut OrtSession,
            ) -> *mut OrtStatus = unsafe { std::mem::transmute(rt.slot(IDX_CREATE_SESSION)) };

            #[cfg(windows)]
            let st = {
                use std::os::windows::ffi::OsStrExt;
                let wide: Vec<u16> = model_path
                    .as_os_str()
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();
                unsafe { create_sess(rt.env, wide.as_ptr(), opts.raw, &mut session_raw) }
            };
            #[cfg(not(windows))]
            let st = {
                use std::os::unix::ffi::OsStrExt;
                let cpath = CString::new(model_path.as_os_str().as_bytes())
                    .map_err(|_| "模型路径包含空字节".to_string())?;
                unsafe { create_sess(rt.env, cpath.as_ptr(), opts.raw, &mut session_raw) }
            };
            rt.check_status(st)?;
            Ok(session_raw)
        }

        pub fn create(
            rt: &Arc<OrtRuntime>,
            model_path: &Path,
            intra_threads: i32,
        ) -> Result<Self, String> {
            Self::create_with_ep(rt, model_path, intra_threads, ExecutionProvider::Cpu)
        }

        pub fn create_with_ep(
            rt: &Arc<OrtRuntime>,
            model_path: &Path,
            intra_threads: i32,
            ep: ExecutionProvider,
        ) -> Result<Self, String> {
            #[cfg(target_os = "macos")]
            let session_raw = if ep == ExecutionProvider::CoreMlPreferred {
                let model_label = model_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("model.onnx");
                let coreml_session = match Self::build_session_options(rt, intra_threads) {
                    Ok(coreml_opts) => {
                        match rt.append_coreml_ep(
                            coreml_opts.raw,
                            COREML_FLAG_ONLY_ENABLE_DEVICE_WITH_ANE,
                        ) {
                            Ok(()) => match Self::create_raw_session(rt, model_path, &coreml_opts) {
                                Ok(raw) => {
                                    logging::info(
                                        "voice.ai",
                                        "ORT CoreML EP attached (ANE)",
                                        serde_json::json!({
                                            "model": model_label,
                                            "flags": COREML_FLAG_ONLY_ENABLE_DEVICE_WITH_ANE,
                                            "intraThreads": intra_threads,
                                        }),
                                    );
                                    Some(raw)
                                }
                                Err(err) => {
                                    logging::warn(
                                        "voice.ai",
                                        "ORT CoreML EP CreateSession failed; falling back to CPU EP",
                                        serde_json::json!({
                                            "model": model_label,
                                            "error": err,
                                        }),
                                    );
                                    None
                                }
                            },
                            Err(err) => {
                                logging::info(
                                    "voice.ai",
                                    "ORT CoreML EP unavailable; using CPU EP",
                                    serde_json::json!({
                                        "model": model_label,
                                        "reason": err,
                                    }),
                                );
                                None
                            }
                        }
                    }
                    Err(err) => {
                        logging::warn(
                            "voice.ai",
                            "ORT CoreML SessionOptions init failed; falling back to CPU EP",
                            serde_json::json!({
                                "model": model_label,
                                "error": err,
                            }),
                        );
                        None
                    }
                };
                match coreml_session {
                    Some(raw) => raw,
                    None => {
                        let cpu_opts = Self::build_session_options(rt, intra_threads)?;
                        Self::create_raw_session(rt, model_path, &cpu_opts)?
                    }
                }
            } else {
                let cpu_opts = Self::build_session_options(rt, intra_threads)?;
                Self::create_raw_session(rt, model_path, &cpu_opts)?
            };

            #[cfg(not(target_os = "macos"))]
            let session_raw = {
                let _ = ep;
                let cpu_opts = Self::build_session_options(rt, intra_threads)?;
                Self::create_raw_session(rt, model_path, &cpu_opts)?
            };

            let mut sess = Self {
                inner: Arc::new(SessionInner {
                    rt: rt.clone(),
                    raw: session_raw,
                }),
                input_names: Vec::new(),
                output_names: Vec::new(),
            };
            sess.input_names = sess.query_names(true)?;
            sess.output_names = sess.query_names(false)?;
            Ok(sess)
        }

        fn query_names(&self, is_input: bool) -> Result<Vec<String>, String> {
            let count_idx = if is_input {
                IDX_SESSION_GET_INPUT_COUNT
            } else {
                IDX_SESSION_GET_OUTPUT_COUNT
            };
            let name_idx = if is_input {
                IDX_SESSION_GET_INPUT_NAME
            } else {
                IDX_SESSION_GET_OUTPUT_NAME
            };
            let get_count: unsafe extern "system" fn(*const OrtSession, *mut usize) -> *mut OrtStatus =
                unsafe { std::mem::transmute(self.inner.rt.slot(count_idx)) };
            let get_name: unsafe extern "system" fn(
                *const OrtSession,
                usize,
                *mut OrtAllocator,
                *mut *mut c_char,
            ) -> *mut OrtStatus = unsafe { std::mem::transmute(self.inner.rt.slot(name_idx)) };
            let free_fn: unsafe extern "system" fn(*mut OrtAllocator, *mut c_void) -> *mut OrtStatus =
                unsafe { std::mem::transmute(self.inner.rt.slot(IDX_ALLOCATOR_FREE)) };

            let mut n: usize = 0;
            self.inner
                .rt
                .check_status(unsafe { get_count(self.inner.raw, &mut n) })?;
            let mut out = Vec::with_capacity(n);
            for i in 0..n {
                let mut ptr: *mut c_char = std::ptr::null_mut();
                self.inner.rt.check_status(unsafe {
                    get_name(self.inner.raw, i, self.inner.rt.allocator, &mut ptr)
                })?;
                if !ptr.is_null() {
                    let s = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
                    let _ = unsafe { free_fn(self.inner.rt.allocator, ptr.cast()) };
                    out.push(s);
                } else {
                    out.push(String::new());
                }
            }
            Ok(out)
        }

        pub fn run(
            &self,
            inputs: &[(&str, &Value)],
            output_names: &[&str],
        ) -> Result<Vec<Value>, String> {
            let c_in_names: Vec<CString> = inputs
                .iter()
                .map(|(n, _)| CString::new(*n).map_err(|_| "无效输入张量名".to_string()))
                .collect::<Result<_, _>>()?;
            let in_ptrs: Vec<*const c_char> = c_in_names.iter().map(|c| c.as_ptr()).collect();
            let in_vals: Vec<*const OrtValue> = inputs.iter().map(|(_, v)| v.raw as *const _).collect();

            let c_out_names: Vec<CString> = output_names
                .iter()
                .map(|n| CString::new(*n).map_err(|_| "无效输出张量名".to_string()))
                .collect::<Result<_, _>>()?;
            let out_ptrs: Vec<*const c_char> = c_out_names.iter().map(|c| c.as_ptr()).collect();
            let mut out_vals: Vec<*mut OrtValue> = vec![std::ptr::null_mut(); output_names.len()];

            let run_fn: unsafe extern "system" fn(
                *mut OrtSession,
                *const OrtRunOptions,
                *const *const c_char,
                *const *const OrtValue,
                usize,
                *const *const c_char,
                usize,
                *mut *mut OrtValue,
            ) -> *mut OrtStatus = unsafe { std::mem::transmute(self.inner.rt.slot(IDX_RUN)) };

            let st = unsafe {
                run_fn(
                    self.inner.raw,
                    std::ptr::null(),
                    in_ptrs.as_ptr(),
                    in_vals.as_ptr(),
                    in_ptrs.len(),
                    out_ptrs.as_ptr(),
                    out_ptrs.len(),
                    out_vals.as_mut_ptr(),
                )
            };
            if let Err(e) = self.inner.rt.check_status(st) {
                let rel_val: unsafe extern "system" fn(*mut OrtValue) =
                    unsafe { std::mem::transmute(self.inner.rt.slot(IDX_RELEASE_VALUE)) };
                for v in out_vals {
                    if !v.is_null() {
                        unsafe { rel_val(v) };
                    }
                }
                return Err(e);
            }
            Ok(out_vals
                .into_iter()
                .map(|raw| Value {
                    rt: self.inner.rt.clone(),
                    raw,
                    _backing: None,
                })
                .collect())
        }
    }

    pub fn parse_onnx_custom_metadata(data: &[u8]) -> std::collections::HashMap<String, String> {
        let mut out = std::collections::HashMap::new();
        fn read_varint(buf: &[u8], idx: &mut usize, limit: usize) -> Option<u64> {
            let mut val: u64 = 0;
            let mut shift: u32 = 0;
            while *idx < limit && shift < 64 {
                let b = buf[*idx];
                *idx += 1;
                val |= u64::from(b & 0x7f) << shift;
                if (b & 0x80) == 0 {
                    return Some(val);
                }
                shift += 7;
            }
            None
        }

        let mut i = 0;
        let end = data.len();
        while i < end {
            let Some(tag) = read_varint(data, &mut i, end) else {
                break;
            };
            let field = tag >> 3;
            let wire = tag & 0x07;
            match wire {
                0 => {
                    if read_varint(data, &mut i, end).is_none() {
                        break;
                    }
                }
                1 => {
                    if i + 8 > end {
                        break;
                    }
                    i += 8;
                }
                5 => {
                    if i + 4 > end {
                        break;
                    }
                    i += 4;
                }
                2 => {
                    let Some(len_u) = read_varint(data, &mut i, end) else {
                        break;
                    };
                    let len = len_u as usize;
                    if i.saturating_add(len) > end {
                        break;
                    }
                    if field == 14 {
                        let sub_end = i + len;
                        let mut j = i;
                        let mut key = String::new();
                        let mut val = String::new();
                        while j < sub_end {
                            let Some(s_tag) = read_varint(data, &mut j, sub_end) else {
                                break;
                            };
                            let s_field = s_tag >> 3;
                            let s_wire = s_tag & 0x07;
                            match s_wire {
                                2 => {
                                    let Some(s_len_u) = read_varint(data, &mut j, sub_end) else {
                                        break;
                                    };
                                    let s_len = s_len_u as usize;
                                    if j.saturating_add(s_len) > sub_end {
                                        break;
                                    }
                                    let s = String::from_utf8_lossy(&data[j..j + s_len]).into_owned();
                                    if s_field == 1 {
                                        key = s;
                                    } else if s_field == 2 {
                                        val = s;
                                    }
                                    j += s_len;
                                }
                                0 => {
                                    if read_varint(data, &mut j, sub_end).is_none() {
                                        break;
                                    }
                                }
                                1 => {
                                    if j + 8 > sub_end {
                                        break;
                                    }
                                    j += 8;
                                }
                                5 => {
                                    if j + 4 > sub_end {
                                        break;
                                    }
                                    j += 4;
                                }
                                _ => break,
                            }
                        }
                        if !key.is_empty() {
                            out.insert(key, val);
                        }
                    }
                    i += len;
                }
                _ => break,
            }
        }
        out
    }

    #[derive(Clone)]
    pub struct DpdfConfig {
        pub state_size: usize,
        pub init_state: Vec<f32>,
    }

    impl DpdfConfig {
        pub fn from_model(path: &Path) -> Self {
            let meta = fs::read(path)
                .map(|b| parse_onnx_custom_metadata(&b))
                .unwrap_or_default();
            let state_size = meta
                .get("state_size")
                .and_then(|s| s.parse::<usize>().ok())
                .filter(|&n| n > 0)
                .unwrap_or(38_256);
            let erb_sz = meta
                .get("erb_norm_state_size")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(32);
            let spec_sz = meta
                .get("spec_norm_state_size")
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(96);

            let mut init_state = vec![0.0f32; state_size];
            let erb_vals: Vec<f32> = meta
                .get("erb_norm_init")
                .map(|s| {
                    s.split(',')
                        .filter_map(|p| p.trim().parse::<f32>().ok())
                        .collect()
                })
                .unwrap_or_default();
            if erb_vals.len() == erb_sz && erb_sz <= state_size {
                init_state[..erb_sz].copy_from_slice(&erb_vals);
            } else if erb_sz <= state_size {
                let denom = (erb_sz.saturating_sub(1)).max(1) as f32;
                for i in 0..erb_sz {
                    init_state[i] = -60.0 + (-30.0) * (i as f32) / denom;
                }
            }

            let spec_vals: Vec<f32> = meta
                .get("spec_norm_init")
                .map(|s| {
                    s.split(',')
                        .filter_map(|p| p.trim().parse::<f32>().ok())
                        .collect()
                })
                .unwrap_or_default();
            if spec_vals.len() == spec_sz && erb_sz + spec_sz <= state_size {
                init_state[erb_sz..erb_sz + spec_sz].copy_from_slice(&spec_vals);
            } else if erb_sz + spec_sz <= state_size {
                let denom = (spec_sz.saturating_sub(1)).max(1) as f32;
                for i in 0..spec_sz {
                    init_state[erb_sz + i] = 0.001 + (-0.0009) * (i as f32) / denom;
                }
            }
            Self {
                state_size,
                init_state,
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Pure-Rust DSP: Filters, FFT (320 & 512), Kaldi Fbank, Spectral Noise Gate
// ---------------------------------------------------------------------------

pub mod dsp {
    use super::VOICE_RATE;
    use std::f64::consts::PI;

    /// 1-pole ~64 Hz high-pass filter for the clean VAD + speaker verification path.
    pub struct HighPass64 {
        x1: f32,
        y1: f32,
    }

    impl Default for HighPass64 {
        fn default() -> Self {
            Self { x1: 0.0, y1: 0.0 }
        }
    }

    impl HighPass64 {
        pub fn process_slice(&mut self, src: &[f32], dst: &mut [f32]) {
            let mut px = self.x1;
            let mut py = self.y1;
            for (s, d) in src.iter().zip(dst.iter_mut()) {
                let x = *s;
                let y = 0.975 * (py + x - px);
                px = x;
                py = y;
                *d = y;
            }
            self.x1 = px;
            self.y1 = py;
        }
    }

    /// 2nd-order Butterworth 80 Hz high-pass biquad removing DC, wind, and desk rumble.
    pub struct HighPass80 {
        b0: f64,
        b1: f64,
        b2: f64,
        a1: f64,
        a2: f64,
        z1: f64,
        z2: f64,
    }

    impl Default for HighPass80 {
        fn default() -> Self {
            Self::new(80.0, VOICE_RATE as f64)
        }
    }

    impl HighPass80 {
        pub fn new(fc: f64, fs: f64) -> Self {
            let w0 = 2.0 * PI * fc / fs;
            let cos_w = w0.cos();
            let sin_w = w0.sin();
            let alpha = sin_w / (2.0 * std::f64::consts::SQRT_2);
            let a0 = 1.0 + alpha;
            Self {
                b0: ((1.0 + cos_w) * 0.5) / a0,
                b1: -(1.0 + cos_w) / a0,
                b2: ((1.0 + cos_w) * 0.5) / a0,
                a1: (-2.0 * cos_w) / a0,
                a2: (1.0 - alpha) / a0,
                z1: 0.0,
                z2: 0.0,
            }
        }

        pub fn process_in_place(&mut self, buf: &mut [f32]) {
            for s in buf.iter_mut() {
                let x = f64::from(*s);
                let y = self.b0 * x + self.z1;
                self.z1 = self.b1 * x - self.a1 * y + self.z2;
                self.z2 = self.b2 * x - self.a2 * y;
                *s = y as f32;
            }
        }
    }

    /// 2nd-order peaking EQ centered at 2.5 kHz (covering 1.5-3.8 kHz vocal harmonic presence).
    pub struct PresencePeakFilter {
        b0: f64,
        b1: f64,
        b2: f64,
        a1: f64,
        a2: f64,
        z1: f64,
        z2: f64,
    }

    impl Default for PresencePeakFilter {
        fn default() -> Self {
            Self::new(2500.0, 1.1, 2.6, VOICE_RATE as f64)
        }
    }

    impl PresencePeakFilter {
        pub fn new(f0: f64, q: f64, gain_db: f64, fs: f64) -> Self {
            let a = 10f64.powf(gain_db / 40.0);
            let w0 = 2.0 * PI * f0 / fs;
            let cos_w = w0.cos();
            let alpha = w0.sin() / (2.0 * q);
            let a0 = 1.0 + alpha / a;
            Self {
                b0: (1.0 + alpha * a) / a0,
                b1: (-2.0 * cos_w) / a0,
                b2: (1.0 - alpha * a) / a0,
                a1: (-2.0 * cos_w) / a0,
                a2: (1.0 - alpha / a) / a0,
                z1: 0.0,
                z2: 0.0,
            }
        }

        pub fn process_in_place(&mut self, buf: &mut [f32]) {
            for s in buf.iter_mut() {
                let x = f64::from(*s);
                let y = self.b0 * x + self.z1;
                self.z1 = self.b1 * x - self.a1 * y + self.z2;
                self.z2 = self.b2 * x - self.a2 * y;
                *s = y as f32;
            }
        }
    }

    /// Mixed-radix 5 * 64 complex FFT of size 320 for 20 ms Vorbis-windowed STFT/iSTFT.
    pub struct Fft320 {
        sub_re: [f64; 320],
        sub_im: [f64; 320],
        rev64: [usize; 64],
        cos64: [f64; 32],
        sin64: [f64; 32],
        tw_cos: [f64; 320],
        tw_sin: [f64; 320],
    }

    impl Default for Fft320 {
        fn default() -> Self {
            let mut rev64 = [0usize; 64];
            let mut j = 0usize;
            for i in 0..64 {
                rev64[i] = j;
                let mut bit = 32usize;
                while (j & bit) != 0 {
                    j ^= bit;
                    bit >>= 1;
                }
                j |= bit;
            }
            let mut cos64 = [0.0f64; 32];
            let mut sin64 = [0.0f64; 32];
            for k in 0..32 {
                let ang = 2.0 * PI * (k as f64) / 64.0;
                cos64[k] = ang.cos();
                sin64[k] = -ang.sin();
            }
            let mut tw_cos = [1.0f64; 320];
            let mut tw_sin = [0.0f64; 320];
            for r in 1..5 {
                for p in 1..64 {
                    let ang = 2.0 * PI * ((r * p) as f64) / 320.0;
                    tw_cos[r * 64 + p] = ang.cos();
                    tw_sin[r * 64 + p] = -ang.sin();
                }
            }
            Self {
                sub_re: [0.0; 320],
                sub_im: [0.0; 320],
                rev64,
                cos64,
                sin64,
                tw_cos,
                tw_sin,
            }
        }
    }

    impl Fft320 {
        #[allow(dead_code)]
        pub const N: usize = 320;
        #[allow(dead_code)]
        pub const BINS: usize = 161;

        fn run64(&mut self, base: usize) {
            for i in 0..64 {
                let j = self.rev64[i];
                if j > i {
                    self.sub_re.swap(base + i, base + j);
                    self.sub_im.swap(base + i, base + j);
                }
            }
            let mut size = 2usize;
            while size <= 64 {
                let half = size >> 1;
                let step = 64 / size;
                let mut s = 0usize;
                while s < 64 {
                    for k in 0..half {
                        let wr = self.cos64[k * step];
                        let wi = self.sin64[k * step];
                        let a = base + s + k;
                        let b = a + half;
                        let xr = self.sub_re[b] * wr - self.sub_im[b] * wi;
                        let xi = self.sub_re[b] * wi + self.sub_im[b] * wr;
                        self.sub_re[b] = self.sub_re[a] - xr;
                        self.sub_im[b] = self.sub_im[a] - xi;
                        self.sub_re[a] += xr;
                        self.sub_im[a] += xi;
                    }
                    s += size;
                }
                size <<= 1;
            }
        }

        pub fn run(&mut self, re: &mut [f64; 320], im: &mut [f64; 320]) {
            let c1 = (2.0 * PI / 5.0).cos();
            let s1 = (2.0 * PI / 5.0).sin();
            let c2 = (4.0 * PI / 5.0).cos();
            let s2 = (4.0 * PI / 5.0).sin();

            for r in 0..5 {
                let base = r * 64;
                for k in 0..64 {
                    let idx = 5 * k + r;
                    self.sub_re[base + k] = re[idx];
                    self.sub_im[base + k] = im[idx];
                }
                self.run64(base);
                if r > 0 {
                    for p in 1..64 {
                        let ti = base + p;
                        let wr = self.tw_cos[ti];
                        let wi = self.tw_sin[ti];
                        let zr = self.sub_re[ti] * wr - self.sub_im[ti] * wi;
                        let zi = self.sub_re[ti] * wi + self.sub_im[ti] * wr;
                        self.sub_re[ti] = zr;
                        self.sub_im[ti] = zi;
                    }
                }
            }

            for p in 0..64 {
                let r0 = self.sub_re[p];
                let i0 = self.sub_im[p];
                let r1 = self.sub_re[64 + p];
                let i1 = self.sub_im[64 + p];
                let r2 = self.sub_re[128 + p];
                let i2 = self.sub_im[128 + p];
                let r3 = self.sub_re[192 + p];
                let i3 = self.sub_im[192 + p];
                let r4 = self.sub_re[256 + p];
                let i4 = self.sub_im[256 + p];

                let sr14 = r1 + r4;
                let si14 = i1 + i4;
                let dr14 = r1 - r4;
                let di14 = i1 - i4;
                let sr23 = r2 + r3;
                let si23 = i2 + i3;
                let dr23 = r2 - r3;
                let di23 = i2 - i3;

                re[p] = r0 + sr14 + sr23;
                im[p] = i0 + si14 + si23;

                let tr1 = r0 + c1 * sr14 + c2 * sr23;
                let ti1 = i0 + c1 * si14 + c2 * si23;
                let ur1 = s1 * di14 + s2 * di23;
                let ui1 = -s1 * dr14 - s2 * dr23;
                re[p + 64] = tr1 + ur1;
                im[p + 64] = ti1 + ui1;
                re[p + 256] = tr1 - ur1;
                im[p + 256] = ti1 - ui1;

                let tr2 = r0 + c2 * sr14 + c1 * sr23;
                let ti2 = i0 + c2 * si14 + c1 * si23;
                let ur2 = s2 * di14 - s1 * di23;
                let ui2 = -s2 * dr14 + s1 * dr23;
                re[p + 128] = tr2 + ur2;
                im[p + 128] = ti2 + ui2;
                re[p + 192] = tr2 - ur2;
                im[p + 192] = ti2 - ui2;
            }
        }
    }

    pub fn vorbis_window_320() -> [f64; 320] {
        let mut w = [0.0f64; 320];
        for (idx, dst) in w.iter_mut().enumerate() {
            let s = (0.5 * PI * ((idx as f64) + 0.5) / 160.0).sin();
            *dst = (0.5 * PI * s * s).sin();
        }
        w
    }

    /// Iterative radix-2 complex FFT of size 512 for Kaldi 80-bin fbank.
    pub struct Fft512 {
        rev: [usize; 512],
        cos_t: [f64; 256],
        sin_t: [f64; 256],
    }

    impl Default for Fft512 {
        fn default() -> Self {
            let mut rev = [0usize; 512];
            let mut j = 0usize;
            for i in 0..512 {
                rev[i] = j;
                let mut bit = 256usize;
                while (j & bit) != 0 {
                    j ^= bit;
                    bit >>= 1;
                }
                j |= bit;
            }
            let mut cos_t = [0.0f64; 256];
            let mut sin_t = [0.0f64; 256];
            for k in 0..256 {
                let ang = 2.0 * PI * (k as f64) / 512.0;
                cos_t[k] = ang.cos();
                sin_t[k] = -ang.sin();
            }
            Self { rev, cos_t, sin_t }
        }
    }

    impl Fft512 {
        pub fn run(&self, re: &mut [f64; 512], im: &mut [f64; 512]) {
            for i in 0..512 {
                let j = self.rev[i];
                if j > i {
                    re.swap(i, j);
                    im.swap(i, j);
                }
            }
            let mut size = 2usize;
            while size <= 512 {
                let half = size >> 1;
                let step = 512 / size;
                let mut s = 0usize;
                while s < 512 {
                    for k in 0..half {
                        let wr = self.cos_t[k * step];
                        let wi = self.sin_t[k * step];
                        let a = s + k;
                        let b = a + half;
                        let xr = re[b] * wr - im[b] * wi;
                        let xi = re[b] * wi + im[b] * wr;
                        re[b] = re[a] - xr;
                        im[b] = im[a] - xi;
                        re[a] += xr;
                        im[a] += xi;
                    }
                    s += size;
                }
                size <<= 1;
            }
        }
    }

    /// Kaldi-compatible 80-bin log-mel filterbank matching mobile `Fbank` (`VoiceDsp.swift`).
    pub struct Fbank {
        fft: Fft512,
        povey: [f64; 400],
        bank: Vec<(usize, Vec<f64>)>,
    }

    impl Default for Fbank {
        fn default() -> Self {
            let mut povey = [0.0f64; 400];
            for (i, v) in povey.iter_mut().enumerate() {
                *v = (0.5 - 0.5 * (2.0 * PI * (i as f64) / 399.0).cos()).powf(0.85);
            }
            let mel = |f: f64| 1127.0 * (1.0 + f / 700.0).ln();
            let width = (VOICE_RATE as f64) / 512.0;
            let lo = mel(20.0);
            let hi = mel((VOICE_RATE as f64) / 2.0 - 400.0);
            let delta = (hi - lo) / ((Self::BINS + 1) as f64);
            let mut bank = Vec::with_capacity(Self::BINS);
            for b in 0..Self::BINS {
                let l = lo + (b as f64) * delta;
                let c = lo + ((b + 1) as f64) * delta;
                let r = lo + ((b + 2) as f64) * delta;
                let mut first: Option<usize> = None;
                let mut w = Vec::new();
                for i in 0..256 {
                    let m = mel(width * (i as f64));
                    if m > l && m < r {
                        if first.is_none() {
                            first = Some(i);
                        }
                        w.push(if m <= c {
                            (m - l) / (c - l)
                        } else {
                            (r - m) / (r - c)
                        });
                    }
                }
                bank.push((first.unwrap_or(0), w));
            }
            Self {
                fft: Fft512::default(),
                povey,
                bank,
            }
        }
    }

    impl Fbank {
        pub const BINS: usize = 80;
        const FLEN: usize = 400;
        const SHIFT: usize = 160;
        const FLT_EPS: f64 = 1.192_092_895_507_812_5e-7;
        const PCM16_SCALE: f64 = 32768.0;

        pub fn frames(len: usize) -> usize {
            (len + Self::SHIFT / 2) / Self::SHIFT
        }

        pub fn compute(&self, wave: &[f32]) -> (usize, Vec<f32>) {
            let n_samples = wave.len();
            if n_samples == 0 {
                return (1, vec![0.0f32; Self::BINS]);
            }
            let n_frames = Self::frames(n_samples).max(1);
            let mut feats = vec![0.0f32; n_frames * Self::BINS];
            let mut win = [0.0f64; Self::FLEN];
            let mut re = [0.0f64; 512];
            let mut im = [0.0f64; 512];

            for f in 0..n_frames {
                let start = (f as isize) * (Self::SHIFT as isize)
                    + (Self::SHIFT as isize) / 2
                    - (Self::FLEN as isize) / 2;
                let mut mean = 0.0f64;
                for (i, w) in win.iter_mut().enumerate() {
                    let mut s = start + (i as isize);
                    while s < 0 || s >= n_samples as isize {
                        s = if s < 0 {
                            -s - 1
                        } else {
                            2 * (n_samples as isize) - 1 - s
                        };
                    }
                    let val = f64::from(wave[s as usize]) * Self::PCM16_SCALE;
                    *w = val;
                    mean += val;
                }
                mean /= Self::FLEN as f64;
                for w in &mut win {
                    *w -= mean;
                }
                for i in (1..Self::FLEN).rev() {
                    win[i] -= 0.97 * win[i - 1];
                }
                win[0] -= 0.97 * win[0];

                for i in 0..Self::FLEN {
                    re[i] = win[i] * self.povey[i];
                }
                re[Self::FLEN..].fill(0.0);
                im.fill(0.0);

                self.fft.run(&mut re, &mut im);
                for b in 0..Self::BINS {
                    let (first, ref weights) = self.bank[b];
                    let mut e = 0.0f64;
                    for (k, &wk) in weights.iter().enumerate() {
                        let idx = first + k;
                        e += wk * (re[idx] * re[idx] + im[idx] * im[idx]);
                    }
                    feats[f * Self::BINS + b] = e.max(Self::FLT_EPS).ln() as f32;
                }
            }

            for b in 0..Self::BINS {
                let mut m = 0.0f64;
                for f in 0..n_frames {
                    m += f64::from(feats[f * Self::BINS + b]);
                }
                m /= n_frames as f64;
                for f in 0..n_frames {
                    let idx = f * Self::BINS + b;
                    feats[idx] = (f64::from(feats[idx]) - m) as f32;
                }
            }
            (n_frames, feats)
        }
    }

    /// Pure-Rust real-time adaptive spectral noise gate (320-pt Vorbis STFT/iSTFT, 10 ms hop).
    pub struct SpectralNoiseGate {
        fft: Fft320,
        win: [f64; 320],
        ana: [f32; 320],
        ola: [f64; 320],
        noise_psd: [f64; 161],
        prev_gain: [f64; 161],
        frames: usize,
        last_speech_active: bool,
    }

    impl Default for SpectralNoiseGate {
        fn default() -> Self {
            Self {
                fft: Fft320::default(),
                win: vorbis_window_320(),
                ana: [0.0; 320],
                ola: [0.0; 320],
                noise_psd: [1e-5; 161],
                prev_gain: [1.0; 161],
                frames: 0,
                last_speech_active: false,
            }
        }
    }

    impl SpectralNoiseGate {
        pub const HOP: usize = 160;
        const N: usize = 320;
        const BINS: usize = 161;

        pub fn last_speech_active(&self) -> bool {
            self.last_speech_active
        }

        pub fn process_hop(&mut self, x: &[f32], out: &mut [f32]) {
            let keep = Self::N - Self::HOP;
            self.ana.copy_within(Self::HOP..Self::N, 0);
            self.ana[keep..Self::N].copy_from_slice(&x[..Self::HOP]);

            let mut re = [0.0f64; 320];
            let mut im = [0.0f64; 320];
            for i in 0..Self::N {
                re[i] = f64::from(self.ana[i]) * self.win[i];
            }
            self.fft.run(&mut re, &mut im);

            let mut psd = [0.0f64; Self::BINS];
            for k in 0..Self::BINS {
                psd[k] = re[k] * re[k] + im[k] * im[k];
            }

            // Detect strong tonal/harmonic speech energy in 200..3200 Hz (bins 4..64) so
            // immediate speech on frame 0 is never absorbed into the stationary noise floor.
            self.frames += 1;
            let mut speech_energy = 0.0f64;
            let mut speech_peak = 0.0f64;
            let mut noise_energy = 0.0f64;
            for k in 4..64 {
                speech_energy += psd[k];
                if psd[k] > speech_peak {
                    speech_peak = psd[k];
                }
            }
            let mean_speech_bin = speech_energy / 60.0;
            let tonality = speech_peak / mean_speech_bin.max(1e-9);
            let strong_tonal_speech = speech_energy > 25.0 && tonality >= 9.0;

            for k in 1..Self::BINS {
                let p = psd[k];
                if self.frames <= 4 {
                    let capped = if strong_tonal_speech { p.min(0.5) } else { p };
                    self.noise_psd[k] = if self.frames == 1 {
                        capped.max(1e-7)
                    } else {
                        0.5 * self.noise_psd[k] + 0.5 * capped.max(1e-7)
                    };
                } else if p < self.noise_psd[k] {
                    self.noise_psd[k] = 0.90 * self.noise_psd[k] + 0.10 * p.max(1e-8);
                } else if !strong_tonal_speech && p < self.noise_psd[k] * 4.5 {
                    self.noise_psd[k] = 0.92 * self.noise_psd[k] + 0.08 * p;
                }
                if (4..64).contains(&k) {
                    noise_energy += self.noise_psd[k];
                }
            }

            let frame_snr = speech_energy / noise_energy.max(1e-8);
            self.last_speech_active = frame_snr >= 2.1 || strong_tonal_speech;
            let gate_scale = if self.last_speech_active { 1.0 } else { 0.22 };
            let oversub = if self.last_speech_active { 1.5 } else { 2.0 };

            let mut raw_gain = [1.0f64; Self::BINS];
            raw_gain[0] = 0.0; // Suppress DC bin
            for k in 1..Self::BINS {
                let n = self.noise_psd[k] * oversub;
                let post = (psd[k] - n).max(0.0) / (psd[k] + 1e-9);
                let g = (post.sqrt() * gate_scale).clamp(0.06, 1.0);
                raw_gain[k] = 0.55 * self.prev_gain[k] + 0.45 * g;
                self.prev_gain[k] = raw_gain[k];
            }

            // Smooth gain slightly across adjacent frequency bins to prevent musical noise.
            re[0] = 0.0;
            for k in 1..(Self::BINS - 1) {
                let g = if k > 1 {
                    0.2 * raw_gain[k - 1] + 0.6 * raw_gain[k] + 0.2 * raw_gain[k + 1]
                } else {
                    raw_gain[k]
                };
                re[k] *= g;
                im[k] *= g;
                let conj_idx = Self::N - k;
                re[conj_idx] = re[k];
                im[conj_idx] = im[k];
                im[k] = -im[k];
            }
            im[0] = 0.0;
            re[Self::N / 2] *= raw_gain[Self::BINS - 1];
            im[Self::N / 2] = 0.0;

            self.fft.run(&mut re, &mut im);
            self.ola.copy_within(Self::HOP..Self::N, 0);
            self.ola[keep..Self::N].fill(0.0);
            let inv_n = 1.0 / (Self::N as f64);
            for i in 0..Self::N {
                self.ola[i] += (re[i] * inv_n) * self.win[i];
            }
            for i in 0..Self::HOP {
                out[i] = self.ola[i] as f32;
            }
        }

        #[cfg_attr(not(test), allow(dead_code))]
        pub fn process_buffer(&mut self, samples: &[f32]) -> Vec<f32> {
            let mut out = vec![0.0f32; samples.len()];
            let mut in_hop = [0.0f32; Self::HOP];
            let mut out_hop = [0.0f32; Self::HOP];
            let mut pos = 0usize;
            while pos < samples.len() {
                let take = (samples.len() - pos).min(Self::HOP);
                in_hop.fill(0.0);
                in_hop[..take].copy_from_slice(&samples[pos..pos + take]);
                self.process_hop(&in_hop, &mut out_hop);
                out[pos..pos + take].copy_from_slice(&out_hop[..take]);
                pos += take;
            }
            out
        }
    }

    /// Adaptive vocal leveler + soft peak normalization clamped strictly <= 0.92.
    pub struct VocalEnhancer {
        noise_rms: f32,
        last_gain: f32,
        presence: PresencePeakFilter,
    }

    impl Default for VocalEnhancer {
        fn default() -> Self {
            Self {
                noise_rms: 0.002,
                last_gain: 1.0,
                presence: PresencePeakFilter::default(),
            }
        }
    }

    impl VocalEnhancer {
        pub const MAX_PEAK: f32 = 0.92;

        pub fn process_in_place(&mut self, buf: &mut [f32]) {
            self.process_in_place_gated(buf, true);
        }

        /// Enhances vocal clarity & levels quiet speech while NEVER boosting noise-only frames
        /// when `allow_boost` is false (so post-denoise residual noise stays attenuated).
        pub fn process_in_place_gated(&mut self, buf: &mut [f32], allow_boost: bool) {
            if buf.is_empty() {
                return;
            }
            if allow_boost {
                self.presence.process_in_place(buf);
            }

            for chunk in buf.chunks_mut(160) {
                let mut sq = 0.0f64;
                let mut peak = 0.0f32;
                for &v in chunk.iter() {
                    sq += f64::from(v) * f64::from(v);
                    peak = peak.max(v.abs());
                }
                let rms = (sq / (chunk.len().max(1) as f64)).sqrt() as f32;
                if !allow_boost {
                    if rms < 0.025 {
                        self.noise_rms = 0.92 * self.noise_rms + 0.08 * rms;
                    }
                } else if rms < self.noise_rms {
                    self.noise_rms = 0.88 * self.noise_rms + 0.12 * rms;
                } else if rms < self.noise_rms * 1.8 {
                    self.noise_rms = 0.992 * self.noise_rms + 0.008 * rms;
                }
                self.noise_rms = self.noise_rms.clamp(0.0004, 0.08);

                let active = allow_boost && rms > (self.noise_rms * 2.5).max(0.008);
                let mut want = if active {
                    (0.11 / rms.max(0.008)).clamp(1.0, 2.2)
                } else {
                    1.0
                };
                if peak > 1e-4 {
                    want = want.min((0.84 / peak).max(1.0));
                }

                if want < self.last_gain {
                    self.last_gain = 0.45 * self.last_gain + 0.55 * want;
                } else if want > self.last_gain && want > 1.05 {
                    self.last_gain = 0.72 * self.last_gain + 0.28 * want;
                } else {
                    self.last_gain = 0.94 * self.last_gain + 0.06 * want;
                }

                let g = self.last_gain;
                for s in chunk.iter_mut() {
                    *s = soft_limit(*s * g);
                }
            }
        }
    }

    #[inline]
    pub fn soft_limit(x: f32) -> f32 {
        let ax = x.abs();
        if ax <= 0.80 {
            x
        } else {
            let knee = 0.80f64;
            let headroom = f64::from(VocalEnhancer::MAX_PEAK) - knee; // 0.12
            let sign = if x >= 0.0 { 1.0f64 } else { -1.0f64 };
            let shaped = knee + headroom * ((f64::from(ax) - knee) / headroom).tanh();
            (sign * shaped) as f32
        }
    }

    pub struct QuietVadBoost {
        noise_rms: f32,
    }

    impl Default for QuietVadBoost {
        fn default() -> Self {
            Self { noise_rms: 0.002 }
        }
    }

    impl QuietVadBoost {
        pub fn prepare(&mut self, src: &[f32], dst: &mut [f32]) {
            let mut sum = 0.0f64;
            for &v in src {
                sum += f64::from(v) * f64::from(v);
            }
            let rms = (sum / (src.len().max(1) as f64)).sqrt() as f32;
            if rms < self.noise_rms {
                self.noise_rms = 0.88 * self.noise_rms + 0.12 * rms;
            } else if rms < self.noise_rms * 1.8 {
                self.noise_rms = 0.992 * self.noise_rms + 0.008 * rms;
            }
            self.noise_rms = self.noise_rms.clamp(0.0003, 0.012);
            let gain = if rms > (self.noise_rms * 2.5).max(0.0015) && rms < 0.03 {
                (0.04 / rms).min(4.0)
            } else {
                1.0
            };
            for (s, d) in src.iter().zip(dst.iter_mut()) {
                *d = *s * gain;
            }
        }
    }

    pub fn pcm16_to_f32(pcm: &[i16]) -> Vec<f32> {
        pcm.iter().map(|&s| f32::from(s) / 32768.0).collect()
    }

    pub fn f32_to_pcm16(samples: &[f32]) -> Vec<i16> {
        samples
            .iter()
            .map(|&s| (s * 32768.0).round().clamp(-32768.0, 32767.0) as i16)
            .collect()
    }

    pub fn rms(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        let sum: f64 = samples.iter().map(|&v| f64::from(v) * f64::from(v)).sum();
        (sum / (samples.len() as f64)).sqrt() as f32
    }

    pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
        let n = a.len().min(b.len());
        if n == 0 {
            return 0.0;
        }
        let mut dot = 0.0f64;
        let mut na = 0.0f64;
        let mut nb = 0.0f64;
        for i in 0..n {
            let x = f64::from(a[i]);
            let y = f64::from(b[i]);
            dot += x * y;
            na += x * x;
            nb += y * y;
        }
        if na == 0.0 || nb == 0.0 {
            0.0
        } else {
            (dot / (na.sqrt() * nb.sqrt())) as f32
        }
    }

    pub fn normalize_embedding(e: &[f32]) -> Vec<f32> {
        let norm: f64 = e.iter().map(|&v| f64::from(v) * f64::from(v)).sum::<f64>().sqrt();
        if norm == 0.0 {
            return e.to_vec();
        }
        e.iter().map(|&v| (f64::from(v) / norm) as f32).collect()
    }

    pub fn mean_embedding(list: &[Vec<f32>]) -> Vec<f32> {
        let Some(first) = list.first() else {
            return Vec::new();
        };
        let mut out = vec![0.0f32; first.len()];
        let count = list.len() as f64;
        for emb in list {
            let norm: f64 = emb.iter().map(|&v| f64::from(v) * f64::from(v)).sum::<f64>().sqrt();
            if norm == 0.0 {
                continue;
            }
            for (o, &v) in out.iter_mut().zip(emb.iter()) {
                *o += (f64::from(v) / norm / count) as f32;
            }
        }
        normalize_embedding(&out)
    }

    pub fn select_prototypes(kept: &[Vec<f32>], centroid: &[f32], max_count: usize) -> Vec<Vec<f32>> {
        if kept.is_empty() {
            return Vec::new();
        }
        let normed: Vec<Vec<f32>> = kept.iter().map(|e| normalize_embedding(e)).collect();
        if normed.len() <= max_count {
            return normed;
        }
        let mut chosen = Vec::with_capacity(max_count);
        let mut best_first = 0usize;
        let mut best_cos = -2.0f32;
        for (i, e) in normed.iter().enumerate() {
            let c = cosine(e, centroid);
            if c > best_cos {
                best_cos = c;
                best_first = i;
            }
        }
        chosen.push(best_first);
        while chosen.len() < max_count {
            let mut next_idx: Option<usize> = None;
            let mut lowest_max_sim = 2.0f32;
            for (i, e) in normed.iter().enumerate() {
                if chosen.contains(&i) {
                    continue;
                }
                let mut max_sim = -2.0f32;
                for &c_idx in &chosen {
                    max_sim = max_sim.max(cosine(e, &normed[c_idx]));
                }
                if max_sim < lowest_max_sim {
                    lowest_max_sim = max_sim;
                    next_idx = Some(i);
                }
            }
            let Some(idx) = next_idx else { break };
            chosen.push(idx);
        }
        chosen.into_iter().map(|i| normed[i].clone()).collect()
    }

    #[derive(Debug, Clone, Copy)]
    pub struct SvScore {
        pub raw: f32,
        pub proto: f32,
        pub blended: f32,
    }

    pub fn score_voiceprint(
        norm_emb: &[f32],
        centroid: &[f32],
        prototypes: &[Vec<f32>],
    ) -> SvScore {
        let raw = cosine(norm_emb, centroid);
        if prototypes.is_empty() {
            return SvScore {
                raw,
                proto: raw,
                blended: raw,
            };
        }
        let mut best = -1.0f32;
        for p in prototypes {
            best = best.max(cosine(norm_emb, p));
        }
        SvScore {
            raw,
            proto: best,
            blended: 0.65 * raw + 0.35 * best,
        }
    }

    pub fn pick_cleanest_sample(speech: &[f32], target_len: usize) -> Vec<f32> {
        if speech.is_empty() {
            return vec![0.0; target_len];
        }
        if speech.len() <= target_len {
            let mut out = vec![0.0; target_len];
            for (i, o) in out.iter_mut().enumerate() {
                *o = speech[i % speech.len()];
            }
            return out;
        }
        let step = 1_600usize;
        let mut best_off = 0usize;
        let mut best_score = -1.0f64;
        let mut off = 0usize;
        while off + target_len <= speech.len() {
            let mut sq = 0.0f64;
            let mut clipped = 0usize;
            for &v in &speech[off..off + target_len] {
                if v.abs() > 0.97 {
                    clipped += 1;
                }
                sq += f64::from(v) * f64::from(v);
            }
            let rms = (sq / (target_len as f64)).sqrt();
            let clip_penalty = if clipped > 0 {
                (1.0 - (clipped as f64) / 200.0).max(0.1)
            } else {
                1.0
            };
            let q = rms * clip_penalty;
            if q > best_score {
                best_score = q;
                best_off = off;
            }
            off += step;
        }
        speech[best_off..best_off + target_len].to_vec()
    }
}

// ---------------------------------------------------------------------------
// ONNX Runtime Model Sessions (DPDFNet, Silero VAD, ERes2NetV2, VoxLock v2)
// ---------------------------------------------------------------------------

mod models {
    use super::dsp::{vorbis_window_320, Fbank, Fft320};
    use super::ort::{DpdfConfig, ExecutionProvider, OrtRuntime, Session, Value};
    use super::*;

    pub struct LoadedModels {
        pub rt: Arc<OrtRuntime>,
        pub dpdf: Option<Session>,
        pub dpdf_cfg: Option<DpdfConfig>,
        pub vad: Option<Session>,
        pub speaker: Option<Session>,
        pub tse_enroll: Option<Session>,
        pub tse_chunk: Option<Session>,
    }

    pub fn open_models(
        need_dpdf: bool,
        need_vad: bool,
        need_speaker: bool,
        need_tse: bool,
    ) -> Result<LoadedModels, String> {
        let ort_path = discover_ort_library()
            .ok_or_else(|| "尚未安装 ONNX Runtime 运行库，请先准备语音模型".to_string())?;
        let rt = OrtRuntime::load_from(&ort_path)?;

        let dpdf_path = if need_dpdf {
            discover_model_path(&DPDF_SPEC)
        } else {
            None
        };
        let vad_path = if need_vad {
            discover_model_path(&VAD_SPEC)
        } else {
            None
        };
        let sv_path = if need_speaker {
            discover_model_path(&SV_SPEC)
        } else {
            None
        };
        let te_path = if need_tse {
            discover_model_path(&VOXLOCK_ENROLL_SPEC)
        } else {
            None
        };
        let tc_path = if need_tse && te_path.is_some() {
            discover_model_path(&VOXLOCK_CHUNK_SPEC)
        } else {
            None
        };

        // Keep tiny 10 ms recurrent stateful streaming models (DPDFNet & Silero VAD) on CPU EP
        // to avoid CoreML/ANE per-frame dispatch overhead and dynamic state issues.
        let dpdf = dpdf_path
            .as_deref()
            .map(|p| Session::create(&rt, p, 1))
            .transpose()?;
        let dpdf_cfg = dpdf_path.as_deref().map(DpdfConfig::from_model);
        let vad = vad_path
            .as_deref()
            .map(|p| Session::create(&rt, p, 1))
            .transpose()?;
        let workers = std::thread::available_parallelism()
            .map(|n| n.get().min(2) as i32)
            .unwrap_or(1)
            .max(1);
        // Accelerate heavy neural models (ERes2NetV2 SV & VoxLock TSE) via macOS CoreML EP (ANE)
        // with automatic fallback to CPU EP.
        let speaker = sv_path
            .as_deref()
            .map(|p| Session::create_with_ep(&rt, p, workers, ExecutionProvider::CoreMlPreferred))
            .transpose()?;
        let tse_enroll = if te_path.is_some() && tc_path.is_some() {
            te_path
                .as_deref()
                .map(|p| {
                    Session::create_with_ep(&rt, p, workers, ExecutionProvider::CoreMlPreferred)
                })
                .transpose()?
        } else {
            None
        };
        let tse_chunk = if tse_enroll.is_some() {
            tc_path
                .as_deref()
                .map(|p| {
                    Session::create_with_ep(&rt, p, workers, ExecutionProvider::CoreMlPreferred)
                })
                .transpose()?
        } else {
            None
        };

        Ok(LoadedModels {
            rt,
            dpdf,
            dpdf_cfg,
            vad,
            speaker,
            tse_enroll,
            tse_chunk,
        })
    }

    /// Streaming DPDFNet-baseline (`dpdfnet_baseline.onnx`) 320-pt Vorbis STFT + 4% 5-hop dry blend.
    pub struct Denoiser {
        rt: Arc<OrtRuntime>,
        sess: Session,
        spec_in_name: String,
        state_in_name: String,
        spec_out_name: String,
        state_out_name: String,
        state: Vec<f32>,
        state_shape: [i64; 1],
        fft: Fft320,
        win: [f64; 320],
        ana: [f32; 320],
        ola: [f64; 320],
        dry_ring: [f32; 800],
        dry_cursor: usize,
        dry_gain: f32,
    }

    impl Denoiser {
        pub const HOP: usize = 160;
        const N: usize = 320;
        const BINS: usize = 161;
        const MAX_DRY_BLEND: f32 = 0.04;

        pub fn new(rt: &Arc<OrtRuntime>, sess: &Session, cfg: &DpdfConfig) -> Self {
            let spec_in_name = sess
                .input_names
                .first()
                .cloned()
                .unwrap_or_else(|| "spec".into());
            let state_in_name = sess
                .input_names
                .get(1)
                .cloned()
                .unwrap_or_else(|| "state_in".into());
            let spec_out_name = sess
                .output_names
                .first()
                .cloned()
                .unwrap_or_else(|| "spec_e".into());
            let state_out_name = sess
                .output_names
                .get(1)
                .cloned()
                .unwrap_or_else(|| "state_out".into());
            Self {
                rt: rt.clone(),
                sess: sess.clone(),
                spec_in_name,
                state_in_name,
                spec_out_name,
                state_out_name,
                state: cfg.init_state.clone(),
                state_shape: [cfg.state_size as i64],
                fft: Fft320::default(),
                win: vorbis_window_320(),
                ana: [0.0; 320],
                ola: [0.0; 320],
                dry_ring: [0.0; 800],
                dry_cursor: 0,
                dry_gain: 0.0,
            }
        }

        pub fn hop(&mut self, x: &[f32], out: &mut [f32]) -> Result<(), String> {
            let mut dry_delayed = [0.0f32; Self::HOP];
            for i in 0..Self::HOP {
                dry_delayed[i] = self.dry_ring[self.dry_cursor + i];
                self.dry_ring[self.dry_cursor + i] = x[i];
            }
            self.dry_cursor += Self::HOP;
            if self.dry_cursor >= self.dry_ring.len() {
                self.dry_cursor = 0;
            }

            let keep = Self::N - Self::HOP;
            self.ana.copy_within(Self::HOP..Self::N, 0);
            self.ana[keep..Self::N].copy_from_slice(&x[..Self::HOP]);

            let mut re = [0.0f64; 320];
            let mut im = [0.0f64; 320];
            for i in 0..Self::N {
                re[i] = f64::from(self.ana[i]) * self.win[i];
            }
            self.fft.run(&mut re, &mut im);

            let mut spec = vec![0.0f32; Self::BINS * 2];
            for k in 0..Self::BINS {
                spec[2 * k] = re[k] as f32;
                spec[2 * k + 1] = im[k] as f32;
            }

            let t_spec = Value::from_f32_vec(&self.rt, spec, &[1, 1, Self::BINS as i64, 2])?;
            let t_state =
                Value::from_f32_vec(&self.rt, self.state.clone(), &self.state_shape)?;
            let outs = self.sess.run(
                &[
                    (&self.spec_in_name, &t_spec),
                    (&self.state_in_name, &t_state),
                ],
                &[&self.spec_out_name, &self.state_out_name],
            )?;

            let enh = outs[0].to_f32_vec()?;
            outs[1].copy_f32_into(&mut self.state)?;

            if enh.len() >= Self::BINS * 2 {
                re[0] = f64::from(enh[0]);
                im[0] = 0.0;
                re[Self::N / 2] = f64::from(enh[2 * (Self::BINS - 1)]);
                im[Self::N / 2] = 0.0;
                for k in 1..(Self::BINS - 1) {
                    let a = f64::from(enh[2 * k]);
                    let b = f64::from(enh[2 * k + 1]);
                    re[k] = a;
                    im[k] = -b;
                    re[Self::N - k] = a;
                    im[Self::N - k] = b;
                }
            }
            self.fft.run(&mut re, &mut im);

            self.ola.copy_within(Self::HOP..Self::N, 0);
            self.ola[keep..Self::N].fill(0.0);
            let inv_n = 1.0 / (Self::N as f64);
            for i in 0..Self::N {
                self.ola[i] += (re[i] * inv_n) * self.win[i];
            }

            let mut enh_sq = 0.0f64;
            for i in 0..Self::HOP {
                enh_sq += self.ola[i] * self.ola[i];
            }
            let enh_rms = (enh_sq / (Self::HOP as f64)).sqrt() as f32;
            let want_dry = if enh_rms > 0.0025 {
                Self::MAX_DRY_BLEND
            } else {
                0.0
            };
            self.dry_gain = if want_dry > self.dry_gain {
                0.65 * self.dry_gain + 0.35 * want_dry
            } else {
                0.85 * self.dry_gain + 0.15 * want_dry
            };
            let wet = 1.0 - self.dry_gain;
            for i in 0..Self::HOP {
                out[i] = wet * (self.ola[i] as f32) + self.dry_gain * dry_delayed[i];
            }
            Ok(())
        }

        #[cfg_attr(not(test), allow(dead_code))]
        pub fn process_buffer(&mut self, input: &[f32]) -> Result<Vec<f32>, String> {
            let mut out = vec![0.0f32; input.len()];
            let mut in_hop = [0.0f32; Self::HOP];
            let mut out_hop = [0.0f32; Self::HOP];
            let mut pos = 0usize;
            while pos < input.len() {
                let take = (input.len() - pos).min(Self::HOP);
                in_hop.fill(0.0);
                in_hop[..take].copy_from_slice(&input[pos..pos + take]);
                self.hop(&in_hop, &mut out_hop)?;
                out[pos..pos + take].copy_from_slice(&out_hop[..take]);
                pos += take;
            }
            Ok(out)
        }
    }

    pub struct Vad {
        rt: Arc<OrtRuntime>,
        sess: Session,
        h: Vec<f32>,
        c: Vec<f32>,
    }

    impl Vad {
        pub const WINDOW: usize = 512;

        pub fn new(rt: &Arc<OrtRuntime>, sess: &Session) -> Self {
            Self {
                rt: rt.clone(),
                sess: sess.clone(),
                h: vec![0.0; 128],
                c: vec![0.0; 128],
            }
        }

        pub fn prob(&mut self, w: &[f32]) -> Result<f32, String> {
            let mut x = vec![0.0f32; Self::WINDOW];
            let n = w.len().min(Self::WINDOW);
            x[..n].copy_from_slice(&w[..n]);
            let tx = Value::from_f32_vec(&self.rt, x, &[1, Self::WINDOW as i64])?;
            let th = Value::from_f32_vec(&self.rt, self.h.clone(), &[2, 1, 64])?;
            let tc = Value::from_f32_vec(&self.rt, self.c.clone(), &[2, 1, 64])?;
            let outs = self.sess.run(
                &[("x", &tx), ("h", &th), ("c", &tc)],
                &["prob", "new_h", "new_c"],
            )?;
            let p_vec = outs[0].to_f32_vec()?;
            outs[1].copy_f32_into(&mut self.h)?;
            outs[2].copy_f32_into(&mut self.c)?;
            Ok(p_vec.first().copied().unwrap_or(0.0))
        }
    }

    pub struct Speaker {
        rt: Arc<OrtRuntime>,
        sess: Session,
        fbank: Fbank,
        in_name: String,
        out_name: String,
    }

    impl Speaker {
        pub fn new(rt: &Arc<OrtRuntime>, sess: &Session) -> Self {
            let in_name = sess
                .input_names
                .first()
                .cloned()
                .unwrap_or_else(|| "x".into());
            let out_name = sess
                .output_names
                .first()
                .cloned()
                .unwrap_or_else(|| "embedding".into());
            Self {
                rt: rt.clone(),
                sess: sess.clone(),
                fbank: Fbank::default(),
                in_name,
                out_name,
            }
        }

        pub fn embed(&self, samples: &[f32]) -> Result<Vec<f32>, String> {
            let (frames, feats) = self.fbank.compute(samples);
            let tx =
                Value::from_f32_vec(&self.rt, feats, &[1, frames as i64, Fbank::BINS as i64])?;
            let outs = self.sess.run(&[(&self.in_name, &tx)], &[&self.out_name])?;
            outs[0].to_f32_vec()
        }
    }

    pub struct VoxLockEnrollment {
        pub enroll_n: Value,
        pub k: Value,
        pub v: Value,
    }

    impl VoxLockEnrollment {
        pub fn compute(
            rt: &Arc<OrtRuntime>,
            sess: &Session,
            owner_samples: &[f32],
        ) -> Result<(Self, f64), String> {
            let mut buf = vec![0.0f32; OWNER_SAMPLE_LEN];
            if !owner_samples.is_empty() {
                for (i, dst) in buf.iter_mut().enumerate() {
                    *dst = owner_samples[i % owner_samples.len()];
                }
            }
            let in_name = sess
                .input_names
                .first()
                .map(String::as_str)
                .unwrap_or("enroll");
            let t0 = Instant::now();
            let t_in = Value::from_f32_vec(rt, buf, &[1, OWNER_SAMPLE_LEN as i64])?;
            let mut outs = sess.run(&[(in_name, &t_in)], &["enroll_n", "k", "v"])?;
            let v = outs.pop().ok_or_else(|| "VoxLock 缺少 v 输出".to_string())?;
            let k = outs.pop().ok_or_else(|| "VoxLock 缺少 k 输出".to_string())?;
            let enroll_n = outs
                .pop()
                .ok_or_else(|| "VoxLock 缺少 enroll_n 输出".to_string())?;
            Ok((Self { enroll_n, k, v }, t0.elapsed().as_secs_f64() * 1000.0))
        }
    }

    pub struct TargetExtractor {
        rt: Arc<OrtRuntime>,
        sess: Session,
        enr: Arc<VoxLockEnrollment>,
        h: Value,
        c: Value,
        pub k_frames: usize,
        is_first: bool,
        wav_buf: Vec<f32>,
        overlap: Vec<f32>,
        ola: Vec<f32>,
        wsum: Vec<f32>,
        win_sq: [f32; 512],
    }

    impl TargetExtractor {
        pub const NFFT: usize = 512;
        pub const HOP: usize = 128;
        pub const OVERLAP_LEN: usize = 384;
        const REFLECT_PAD: usize = 256;
        const STATE_SHAPE: [i64; 3] = [6, 32, 256];
        const STATE_COUNT: usize = 6 * 32 * 256;

        pub fn new(
            rt: &Arc<OrtRuntime>,
            sess: &Session,
            enr: &Arc<VoxLockEnrollment>,
        ) -> Result<Self, String> {
            let h = Value::from_f32_vec(rt, vec![0.0; Self::STATE_COUNT], &Self::STATE_SHAPE)?;
            let c = Value::from_f32_vec(rt, vec![0.0; Self::STATE_COUNT], &Self::STATE_SHAPE)?;
            let mut win_sq = [0.0f32; 512];
            for (i, dst) in win_sq.iter_mut().enumerate() {
                let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * (i as f64) / 512.0).cos();
                *dst = (w * w) as f32;
            }
            Ok(Self {
                rt: rt.clone(),
                sess: sess.clone(),
                enr: enr.clone(),
                h,
                c,
                k_frames: 5,
                is_first: true,
                wav_buf: vec![0.0; 8 * Self::HOP + Self::OVERLAP_LEN],
                overlap: vec![0.0; Self::OVERLAP_LEN],
                ola: vec![0.0; 8 * Self::HOP + Self::NFFT],
                wsum: vec![0.0; 8 * Self::HOP + Self::NFFT],
                win_sq,
            })
        }

        pub fn required_input_samples(&self) -> usize {
            let step = self.k_frames * Self::HOP;
            if self.is_first {
                step + Self::HOP
            } else {
                step
            }
        }

        pub fn set_k_frames(&mut self, k: usize) {
            self.k_frames = k.clamp(4, 8);
        }

        pub fn step(&mut self, input: &[f32]) -> Result<(Vec<f32>, f64), String> {
            let (tse, _raw, ms) = self.step_aligned(input)?;
            Ok((tse, ms))
        }

        pub fn step_aligned(&mut self, input: &[f32]) -> Result<(Vec<f32>, Vec<f32>, f64), String> {
            let kf = self.k_frames;
            let step_samples = kf * Self::HOP;
            let ns = step_samples + Self::OVERLAP_LEN;

            if self.is_first {
                let max_idx = input.len().saturating_sub(1);
                for i in 0..Self::REFLECT_PAD {
                    let r_idx = (Self::REFLECT_PAD - i).min(max_idx);
                    self.wav_buf[i] = input.get(r_idx).copied().unwrap_or(0.0);
                }
                let copy_count = input.len().min(step_samples + Self::HOP);
                self.wav_buf[Self::REFLECT_PAD..Self::REFLECT_PAD + copy_count]
                    .copy_from_slice(&input[..copy_count]);
                if copy_count < step_samples + Self::HOP {
                    self.wav_buf[Self::REFLECT_PAD + copy_count..ns].fill(0.0);
                }
            } else {
                self.wav_buf[..Self::OVERLAP_LEN].copy_from_slice(&self.overlap);
                let copy_count = input.len().min(step_samples);
                self.wav_buf[Self::OVERLAP_LEN..Self::OVERLAP_LEN + copy_count]
                    .copy_from_slice(&input[..copy_count]);
                if copy_count < step_samples {
                    self.wav_buf[Self::OVERLAP_LEN + copy_count..ns].fill(0.0);
                }
            }

            self.overlap
                .copy_from_slice(&self.wav_buf[step_samples..step_samples + Self::OVERLAP_LEN]);

            let t0 = Instant::now();
            let t_wav =
                Value::from_f32_vec(&self.rt, self.wav_buf[..ns].to_vec(), &[1, ns as i64])?;
            let mut outs = self.sess.run(
                &[
                    ("wav", &t_wav),
                    ("enroll_n", &self.enr.enroll_n),
                    ("k", &self.enr.k),
                    ("v", &self.enr.v),
                    ("h", &self.h),
                    ("c", &self.c),
                ],
                &["frames", "h_out", "c_out"],
            )?;
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            let c_out = outs.pop().ok_or_else(|| "VoxLock 缺少 c_out".to_string())?;
            let h_out = outs.pop().ok_or_else(|| "VoxLock 缺少 h_out".to_string())?;
            let frames_val = outs.pop().ok_or_else(|| "VoxLock 缺少 frames".to_string())?;
            self.h = h_out;
            self.c = c_out;

            let frames = frames_val.to_f32_vec()?;
            for fi in 0..kf {
                let pos = fi * Self::HOP;
                let f_base = fi * Self::NFFT;
                if f_base + Self::NFFT > frames.len() {
                    break;
                }
                for j in 0..Self::NFFT {
                    self.ola[pos + j] += frames[f_base + j];
                    self.wsum[pos + j] += self.win_sq[j];
                }
            }

            let start_idx = if self.is_first { Self::REFLECT_PAD } else { 0 };
            let out_count = step_samples - start_idx;
            let mut tse_out = vec![0.0f32; out_count];
            let mut raw_out = vec![0.0f32; out_count];
            for idx in 0..out_count {
                let p = start_idx + idx;
                tse_out[idx] = self.ola[p] / self.wsum[p].max(1e-8);
                raw_out[idx] = self.wav_buf[p];
            }

            self.ola.copy_within(step_samples..step_samples + Self::OVERLAP_LEN, 0);
            self.wsum
                .copy_within(step_samples..step_samples + Self::OVERLAP_LEN, 0);
            let clear_end = (step_samples + Self::NFFT).min(self.ola.len());
            self.ola[Self::OVERLAP_LEN..clear_end].fill(0.0);
            self.wsum[Self::OVERLAP_LEN..clear_end].fill(0.0);

            self.is_first = false;
            Ok((tse_out, raw_out, ms))
        }

        #[cfg_attr(not(test), allow(dead_code))]
        pub fn process_buffer(&mut self, clean_hpf: &[f32]) -> Result<Vec<f32>, String> {
            if clean_hpf.is_empty() {
                return Ok(Vec::new());
            }
            let mut out = Vec::with_capacity(clean_hpf.len());
            let mut pos = 0usize;
            while pos < clean_hpf.len() {
                let need = self.required_input_samples();
                let end = (pos + need).min(clean_hpf.len());
                let mut slice = clean_hpf[pos..end].to_vec();
                if slice.len() < need {
                    slice.resize(need, 0.0);
                }
                let (chunk, _) = self.step(&slice)?;
                out.extend_from_slice(&chunk);
                pos += need;
            }
            out.truncate(clean_hpf.len());
            Ok(out)
        }
    }
}

// ---------------------------------------------------------------------------
// Model discovery, region-aware mirrors, SHA-256 verification & downloader
// ---------------------------------------------------------------------------

const CHINA_MIRROR_PREFIXES: &[&str] = &[
    "https://ghfast.top/",
    "https://gh-proxy.com/",
    "https://cdn.gh-proxy.com/",
];

const CHINA_DIRECT_MIRROR_HOSTS: &[&str] = &[
    "hf-mirror.com",
    "mirrors.aliyun.com",
    "pypi.tuna.tsinghua.edu.cn",
    "registry.npmmirror.com",
];

const CHINA_PROXY_HOSTS: &[&str] = &[
    "ghfast.top",
    "gh-proxy.com",
    "cdn.gh-proxy.com",
    "edgeone.gh-proxy.com",
];

const ORIGIN_HOSTS: &[&str] = &[
    "github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "huggingface.co",
    "files.pythonhosted.org",
    "registry.npmjs.org",
];

const DEAD_MIRROR_HOSTS: &[&str] = &["ghproxy.net"];

pub fn is_mainland_china() -> bool {
    if let Ok(v) = std::env::var("HERDR_POCKET_MIRROR") {
        let lower = v.trim().to_ascii_lowercase();
        if lower == "cn" || lower == "china" {
            return true;
        }
        if lower == "global" || lower == "direct" {
            return false;
        }
    }
    if let Some(region) = config::read()
        .raw
        .pointer("/update/region")
        .and_then(|v| v.as_str())
    {
        if region == "cn" {
            return true;
        }
        if region == "global" {
            return false;
        }
    }
    if let Ok(tz) = std::env::var("TZ") {
        if is_china_tz(&tz) {
            return true;
        }
    }
    #[cfg(unix)]
    if let Ok(link) = fs::read_link("/etc/localtime") {
        if is_china_tz(&link.to_string_lossy()) {
            return true;
        }
    }
    let offset_sec = chrono::Local::now().offset().local_minus_utc();
    if offset_sec == 8 * 3600 {
        if let Ok(lang) = std::env::var("LANG") {
            if lang.to_ascii_lowercase().contains("zh_cn") {
                return true;
            }
        }
        return true;
    }
    false
}

fn is_china_tz(tz: &str) -> bool {
    let lower = tz.to_ascii_lowercase();
    [
        "asia/shanghai",
        "asia/beijing",
        "asia/chongqing",
        "asia/harbin",
        "asia/urumqi",
        "asia/kashgar",
        "prc",
    ]
    .iter()
    .any(|k| lower.contains(k))
}

fn host_of(raw: &str) -> Option<String> {
    url::Url::parse(raw)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_ascii_lowercase()))
}

pub fn order_urls_by_region(urls: &[&str], china: bool) -> Vec<String> {
    let mut domestic_direct = Vec::new();
    let mut domestic_proxies = Vec::new();
    let mut neutral = Vec::new();
    let mut global = Vec::new();
    let mut seen = HashSet::new();
    for &raw in urls {
        if !seen.insert(raw.to_string()) {
            continue;
        }
        let Some(host) = host_of(raw) else { continue };
        if DEAD_MIRROR_HOSTS.contains(&host.as_str()) {
            continue;
        }
        if CHINA_DIRECT_MIRROR_HOSTS.contains(&host.as_str()) {
            domestic_direct.push(raw.to_string());
        } else if CHINA_PROXY_HOSTS.contains(&host.as_str()) {
            domestic_proxies.push(raw.to_string());
        } else if ORIGIN_HOSTS.contains(&host.as_str()) {
            global.push(raw.to_string());
        } else {
            neutral.push(raw.to_string());
        }
    }
    if china {
        [domestic_direct, domestic_proxies, neutral, global].concat()
    } else {
        [global, neutral, domestic_direct, domestic_proxies].concat()
    }
}

pub fn expand_github_mirrors(urls: &[&str], china: bool) -> Vec<String> {
    let mut clean: Vec<String> = Vec::new();
    let mut github_url: Option<&str> = None;
    for &raw in urls {
        let Some(host) = host_of(raw) else { continue };
        if DEAD_MIRROR_HOSTS.contains(&host.as_str()) {
            continue;
        }
        if (host == "github.com" || host == "raw.githubusercontent.com") && github_url.is_none() {
            github_url = Some(raw);
        }
        if !clean.iter().any(|x| x == raw) {
            clean.push(raw.to_string());
        }
    }
    if let Some(gh) = github_url {
        for prefix in CHINA_MIRROR_PREFIXES {
            let candidate = format!("{prefix}{gh}");
            if !clean.contains(&candidate) {
                clean.push(candidate);
            }
        }
    }
    let refs: Vec<&str> = clean.iter().map(String::as_str).collect();
    order_urls_by_region(&refs, china)
}

pub fn file_sha256(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_encode(&hasher.finalize()))
}

fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

fn is_spec_ready_at(dir: &Path, spec: &ModelSpec) -> bool {
    let file = dir.join(spec.file_name);
    let Ok(meta) = fs::metadata(&file) else {
        return false;
    };
    if meta.len() != spec.size {
        return false;
    }
    let expected_stamp = format!("{}:{}", spec.size, spec.sha256);
    let stamp = dir.join(spec.stamp_name);
    if fs::read_to_string(&stamp).is_ok_and(|s| s == expected_stamp) {
        return true;
    }
    if file_sha256(&file).is_ok_and(|h| h == spec.sha256) {
        let _ = fs::write(&stamp, expected_stamp);
        return true;
    }
    false
}

fn resource_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(d) = models_dir() {
        dirs.push(d);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.to_path_buf());
            dirs.push(parent.join("voice"));
            dirs.push(parent.join("resources").join("voice"));
            dirs.push(parent.join("Resources").join("voice"));
            if let Some(contents) = parent.parent() {
                dirs.push(contents.join("Resources").join("voice"));
                dirs.push(contents.join("Resources"));
                dirs.push(contents.join("Frameworks"));
            }
        }
        for anc in exe.ancestors() {
            let mobile_voice = anc
                .join("apps")
                .join("mobile")
                .join("modules")
                .join("pocket-native")
                .join("ios")
                .join("Resources")
                .join("voice");
            if mobile_voice.is_dir() {
                dirs.push(mobile_voice);
                break;
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for anc in cwd.ancestors() {
            let mobile_voice = anc
                .join("apps")
                .join("mobile")
                .join("modules")
                .join("pocket-native")
                .join("ios")
                .join("Resources")
                .join("voice");
            if mobile_voice.is_dir() {
                dirs.push(mobile_voice);
                break;
            }
        }
    }
    dirs
}

fn discover_model_path(spec: &ModelSpec) -> Option<PathBuf> {
    if let Some(mdir) = models_dir() {
        if is_spec_ready_at(&mdir, spec) {
            return Some(mdir.join(spec.file_name));
        }
    }
    for dir in resource_search_dirs() {
        let candidate = dir.join(spec.file_name);
        if candidate.is_file() {
            if let Ok(meta) = fs::metadata(&candidate) {
                if meta.len() == spec.size {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn ort_library_names() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &[
            "libonnxruntime.dylib",
            "libonnxruntime.1.24.4.dylib",
            "libonnxruntime.1.21.0.dylib",
            "libonnxruntime.1.20.1.dylib",
        ]
    }
    #[cfg(windows)]
    {
        &["onnxruntime.dll"]
    }
    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        &[
            "libonnxruntime.so",
            "libonnxruntime.so.1",
            "libonnxruntime.so.1.24.4",
            "libonnxruntime.so.1.21.0",
        ]
    }
}

pub fn discover_ort_library() -> Option<PathBuf> {
    if let Some(override_path) = std::env::var_os("HERDR_POCKET_ORT_PATH") {
        let p = PathBuf::from(override_path);
        if p.is_file() {
            return Some(p);
        }
    }
    let mut search_dirs = resource_search_dirs();
    #[cfg(target_os = "macos")]
    {
        search_dirs.extend([
            PathBuf::from("/opt/homebrew/opt/onnxruntime/lib"),
            PathBuf::from("/opt/homebrew/lib"),
            PathBuf::from("/usr/local/opt/onnxruntime/lib"),
            PathBuf::from("/usr/local/lib"),
        ]);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        search_dirs.extend([
            PathBuf::from("/usr/local/lib"),
            PathBuf::from("/usr/lib"),
            PathBuf::from("/usr/lib/x86_64-linux-gnu"),
            PathBuf::from("/usr/lib/aarch64-linux-gnu"),
        ]);
    }
    #[cfg(windows)]
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        search_dirs.push(PathBuf::from(pf).join("onnxruntime").join("lib"));
    }

    for dir in search_dirs {
        for name in ort_library_names() {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn owner_sample_path() -> Option<PathBuf> {
    models_dir().map(|d| d.join("owner_sample.pcm"))
}

fn has_owner_sample() -> bool {
    let Some(p) = owner_sample_path() else {
        return false;
    };
    fs::metadata(p).is_ok_and(|m| m.len() >= (OWNER_SAMPLE_LEN * 2) as u64)
}

fn save_owner_sample(samples: &[f32]) -> bool {
    let Some(p) = owner_sample_path() else {
        return false;
    };
    if samples.is_empty() {
        return false;
    }
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let mut exact = vec![0.0f32; OWNER_SAMPLE_LEN];
    for (i, dst) in exact.iter_mut().enumerate() {
        *dst = samples[i % samples.len()];
    }
    let pcm = dsp::f32_to_pcm16(&exact);
    let mut bytes = Vec::with_capacity(pcm.len() * 2);
    for s in pcm {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    config::write_atomic(&p, &bytes).is_ok()
}

fn load_owner_sample() -> Option<Vec<f32>> {
    if !has_owner_sample() {
        return None;
    }
    let p = owner_sample_path()?;
    let bytes = fs::read(p).ok()?;
    if bytes.len() < OWNER_SAMPLE_LEN * 2 {
        return None;
    }
    let mut out = Vec::with_capacity(OWNER_SAMPLE_LEN);
    for chunk in bytes[..OWNER_SAMPLE_LEN * 2].chunks_exact(2) {
        let s = i16::from_le_bytes([chunk[0], chunk[1]]);
        out.push(f32::from(s) / 32768.0);
    }
    Some(out)
}

fn delete_owner_sample() {
    if let Some(p) = owner_sample_path() {
        let _ = fs::remove_file(p);
    }
}

#[derive(Clone, Copy)]
struct OrtWheelSpec {
    size: u64,
    sha256: &'static str,
    inner_lib: &'static str,
    inner_extra: Option<&'static str>,
    target_name: &'static str,
    urls: &'static [&'static str],
}

#[allow(dead_code)]
const ORT_WHEEL_MACOS: OrtWheelSpec = OrtWheelSpec {
    size: 33_658_780,
    sha256: "893d67c68ca9e7a58202fa8d96061ed86a5815b0925b5a97aef27b8ba246a20b",
    inner_lib: "onnxruntime/capi/libonnxruntime.1.21.0.dylib",
    inner_extra: None,
    target_name: "libonnxruntime.dylib",
    urls: &[
        "https://mirrors.aliyun.com/pypi/packages/ff/21/593c9bc56002a6d1ea7c2236f4a648e081ec37c8d51db2383a9e83a63325/onnxruntime-1.21.0-cp312-cp312-macosx_13_0_universal2.whl",
        "https://pypi.tuna.tsinghua.edu.cn/packages/ff/21/593c9bc56002a6d1ea7c2236f4a648e081ec37c8d51db2383a9e83a63325/onnxruntime-1.21.0-cp312-cp312-macosx_13_0_universal2.whl",
        "https://files.pythonhosted.org/packages/ff/21/593c9bc56002a6d1ea7c2236f4a648e081ec37c8d51db2383a9e83a63325/onnxruntime-1.21.0-cp312-cp312-macosx_13_0_universal2.whl",
    ],
};

#[allow(dead_code)]
const ORT_WHEEL_WIN_X64: OrtWheelSpec = OrtWheelSpec {
    size: 11_760_975,
    sha256: "7f801318476cd7003d636a5b392f7a37c08b6c8d2f829773f3c3887029e03f32",
    inner_lib: "onnxruntime/capi/onnxruntime.dll",
    inner_extra: Some("onnxruntime/capi/onnxruntime_providers_shared.dll"),
    target_name: "onnxruntime.dll",
    urls: &[
        "https://mirrors.aliyun.com/pypi/packages/77/39/e83d56e3c215713b5263cb4d4f0c69e3964bba11634233d8ae04fc7e6bf3/onnxruntime-1.21.0-cp312-cp312-win_amd64.whl",
        "https://pypi.tuna.tsinghua.edu.cn/packages/77/39/e83d56e3c215713b5263cb4d4f0c69e3964bba11634233d8ae04fc7e6bf3/onnxruntime-1.21.0-cp312-cp312-win_amd64.whl",
        "https://files.pythonhosted.org/packages/77/39/e83d56e3c215713b5263cb4d4f0c69e3964bba11634233d8ae04fc7e6bf3/onnxruntime-1.21.0-cp312-cp312-win_amd64.whl",
    ],
};

#[allow(dead_code)]
const ORT_WHEEL_WIN_ARM64: OrtWheelSpec = OrtWheelSpec {
    size: 12_270_275,
    sha256: "e6214096e14b7b52e3bee1903dc12dc7ca09cb65e26664668a4620cc5e6f9a90",
    inner_lib: "onnxruntime/capi/onnxruntime.dll",
    inner_extra: Some("onnxruntime/capi/onnxruntime_providers_shared.dll"),
    target_name: "onnxruntime.dll",
    urls: &[
        "https://mirrors.aliyun.com/pypi/packages/43/06/8b8ec6e9e6a474fcd5d772453f627ad4549dfe3ab8c0bf70af5afcde551b/onnxruntime-1.24.4-cp312-cp312-win_arm64.whl",
        "https://pypi.tuna.tsinghua.edu.cn/packages/43/06/8b8ec6e9e6a474fcd5d772453f627ad4549dfe3ab8c0bf70af5afcde551b/onnxruntime-1.24.4-cp312-cp312-win_arm64.whl",
        "https://files.pythonhosted.org/packages/43/06/8b8ec6e9e6a474fcd5d772453f627ad4549dfe3ab8c0bf70af5afcde551b/onnxruntime-1.24.4-cp312-cp312-win_arm64.whl",
    ],
};

#[allow(dead_code)]
const ORT_WHEEL_LINUX_X64: OrtWheelSpec = OrtWheelSpec {
    size: 16_019_285,
    sha256: "9a04aafb802c1e5573ba4552f8babcb5021b041eb4cfa802c9b7644ca3510eca",
    inner_lib: "onnxruntime/capi/libonnxruntime.so.1.21.0",
    inner_extra: Some("onnxruntime/capi/libonnxruntime_providers_shared.so"),
    target_name: "libonnxruntime.so",
    urls: &[
        "https://mirrors.aliyun.com/pypi/packages/8b/08/eead6895ed83b56711ca6c0d31d82f109401b9937558b425509e497d6fb4/onnxruntime-1.21.0-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl",
        "https://pypi.tuna.tsinghua.edu.cn/packages/8b/08/eead6895ed83b56711ca6c0d31d82f109401b9937558b425509e497d6fb4/onnxruntime-1.21.0-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl",
        "https://files.pythonhosted.org/packages/8b/08/eead6895ed83b56711ca6c0d31d82f109401b9937558b425509e497d6fb4/onnxruntime-1.21.0-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl",
    ],
};

#[allow(dead_code)]
const ORT_WHEEL_LINUX_ARM64: OrtWheelSpec = OrtWheelSpec {
    size: 14_159_975,
    sha256: "37b7445c920a96271a8dfa16855e258dc5599235b41c7bbde0d262d55bcc105f",
    inner_lib: "onnxruntime/capi/libonnxruntime.so.1.21.0",
    inner_extra: Some("onnxruntime/capi/libonnxruntime_providers_shared.so"),
    target_name: "libonnxruntime.so",
    urls: &[
        "https://mirrors.aliyun.com/pypi/packages/4a/b4/33ec675a8ac150478091262824413e5d4acc359e029af87f9152e7c1c092/onnxruntime-1.21.0-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl",
        "https://pypi.tuna.tsinghua.edu.cn/packages/4a/b4/33ec675a8ac150478091262824413e5d4acc359e029af87f9152e7c1c092/onnxruntime-1.21.0-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl",
        "https://files.pythonhosted.org/packages/4a/b4/33ec675a8ac150478091262824413e5d4acc359e029af87f9152e7c1c092/onnxruntime-1.21.0-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl",
    ],
};

#[cfg(test)]
const ALL_ORT_WHEELS: &[OrtWheelSpec] = &[
    ORT_WHEEL_MACOS,
    ORT_WHEEL_WIN_X64,
    ORT_WHEEL_WIN_ARM64,
    ORT_WHEEL_LINUX_X64,
    ORT_WHEEL_LINUX_ARM64,
];

fn ort_wheel_spec() -> Option<OrtWheelSpec> {
    #[cfg(target_os = "macos")]
    {
        Some(ORT_WHEEL_MACOS)
    }
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        Some(ORT_WHEEL_WIN_X64)
    }
    #[cfg(all(windows, target_arch = "aarch64"))]
    {
        Some(ORT_WHEEL_WIN_ARM64)
    }
    #[cfg(all(unix, not(target_os = "macos"), target_arch = "x86_64"))]
    {
        Some(ORT_WHEEL_LINUX_X64)
    }
    #[cfg(all(unix, not(target_os = "macos"), target_arch = "aarch64"))]
    {
        Some(ORT_WHEEL_LINUX_ARM64)
    }
    #[cfg(not(any(
        target_os = "macos",
        all(windows, any(target_arch = "x86_64", target_arch = "aarch64")),
        all(
            unix,
            not(target_os = "macos"),
            any(target_arch = "x86_64", target_arch = "aarch64")
        )
    )))]
    {
        None
    }
}

fn emit_progress(app: &AppHandle, snap: &DownloadSnapshot, received: u64, total: u64, done: bool) {
    if let Ok(mut g) = dl_lock().lock() {
        *g = snap.clone();
    }
    let _ = app.emit(
        EVENT_PROGRESS,
        serde_json::json!({
            "downloading": snap.downloading,
            "progress": snap.progress,
            "received": received,
            "total": total,
            "dlLabel": snap.dl_label,
            "dlError": snap.dl_error,
            "done": done,
        }),
    );
}

fn is_html_content_type(ct: &str) -> bool {
    let lower = ct.to_ascii_lowercase();
    lower.contains("text/html") || lower.contains("application/xhtml")
}

fn looks_like_html_prefix(chunk: &[u8]) -> bool {
    let trimmed = chunk
        .iter()
        .copied()
        .skip_while(|b| b.is_ascii_whitespace())
        .take(32)
        .collect::<Vec<u8>>();
    let s = String::from_utf8_lossy(&trimmed).to_ascii_lowercase();
    s.starts_with("<!doctype html") || s.starts_with("<html")
}

async fn download_verified_file<F>(
    urls: &[String],
    part_path: &Path,
    expected_size: u64,
    expected_sha256: &str,
    gen_id: u64,
    mut on_bytes: F,
) -> Result<(), String>
where
    F: FnMut(u64),
{
    let mut last_err = "下载失败".to_string();
    for url in urls {
        if DL_CANCEL.load(Ordering::SeqCst) || DL_GEN.load(Ordering::SeqCst) != gen_id {
            return Err("已取消下载".into());
        }
        let _ = fs::remove_file(part_path);
        let resp = match crate::net::client()
            .get(url)
            .timeout(Duration::from_secs(600))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                last_err = format!("HTTP {}", r.status().as_u16());
                continue;
            }
            Err(e) => {
                last_err = e.to_string();
                continue;
            }
        };

        if let Some(ct) = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
        {
            if is_html_content_type(ct) {
                last_err = format!("镜像返回网页错误 ({ct})");
                continue;
            }
        }

        let file = File::create(part_path).map_err(|e| format!("创建临时文件失败：{e}"))?;
        let mut writer = BufWriter::new(file);
        let mut hasher = Sha256::new();
        let mut got: u64 = 0;
        let mut last_tick = Instant::now();
        let mut resp = resp;
        let mut stream_err: Option<String> = None;

        loop {
            if DL_CANCEL.load(Ordering::SeqCst) || DL_GEN.load(Ordering::SeqCst) != gen_id {
                stream_err = Some("已取消下载".into());
                break;
            }
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    if got == 0 && expected_size > 4096 && looks_like_html_prefix(&chunk) {
                        stream_err = Some("镜像返回网页错误".into());
                        break;
                    }
                    got = got.saturating_add(chunk.len() as u64);
                    if got > MAX_MODEL_BYTES {
                        stream_err = Some("文件大小超出限制".into());
                        break;
                    }
                    if let Err(e) = writer.write_all(&chunk) {
                        stream_err = Some(format!("写入文件失败：{e}"));
                        break;
                    }
                    hasher.update(&chunk);
                    if last_tick.elapsed() >= Duration::from_millis(80) {
                        last_tick = Instant::now();
                        on_bytes(got);
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    stream_err = Some(format!("下载中断：{e}"));
                    break;
                }
            }
        }
        let _ = writer.flush();
        drop(writer);

        if let Some(err) = stream_err {
            let _ = fs::remove_file(part_path);
            if err == "已取消下载" {
                return Err(err);
            }
            last_err = err;
            continue;
        }
        on_bytes(got);

        if expected_size > 0 && got != expected_size {
            let _ = fs::remove_file(part_path);
            last_err = format!("文件大小不完整 ({got} != {expected_size})");
            continue;
        }
        let digest = hex_encode(&hasher.finalize());
        if digest != expected_sha256 {
            let _ = fs::remove_file(part_path);
            last_err = "SHA-256 校验未通过".to_string();
            continue;
        }
        return Ok(());
    }
    Err(last_err)
}

const ORT_SHA_SIDECAR: &str = ".libonnxruntime.sha256";

fn file_sha256_hex(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| format!("读取运行库失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("校验运行库失败：{e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_encode(&hasher.finalize()))
}

#[cfg(target_os = "macos")]
fn strip_macos_quarantine(path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    if let Ok(cpath) = CString::new(path.as_os_str().as_bytes()) {
        unsafe {
            libc::removexattr(cpath.as_ptr(), c"com.apple.quarantine".as_ptr(), 0);
        }
    }
}

fn verify_downloaded_ort_at(dir: &Path, path: &Path) -> Result<(), String> {
    if path.parent() != Some(dir) {
        return Ok(());
    }
    let sidecar = dir.join(ORT_SHA_SIDECAR);
    if !sidecar.is_file() {
        return Ok(());
    }
    let expected = fs::read_to_string(&sidecar)
        .map_err(|e| format!("读取 ONNX Runtime 校验文件失败：{e}"))?;
    let expected = expected.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("ONNX Runtime 校验摘要格式无效，请重新下载语音模型".into());
    }
    let actual = file_sha256_hex(path)?;
    if actual != expected {
        return Err("ONNX Runtime 动态库完整性校验未通过，请重新下载语音模型".into());
    }
    Ok(())
}

fn verify_downloaded_ort_before_open(path: &Path) -> Result<(), String> {
    let Some(dir) = models_dir() else {
        return Ok(());
    };
    verify_downloaded_ort_at(&dir, path)
}

fn extract_ort_from_wheel(whl_path: &Path, dir: &Path, spec: &OrtWheelSpec) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    let tmp_dir = dir.join(".ort-extract");
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).map_err(|e| format!("创建解压目录失败：{e}"))?;

    let mut args = vec![
        "-xf".to_string(),
        whl_path.to_string_lossy().into_owned(),
        "-C".to_string(),
        tmp_dir.to_string_lossy().into_owned(),
        spec.inner_lib.to_string(),
    ];
    if let Some(extra) = spec.inner_extra {
        args.push(extra.to_string());
    }

    let tar_cmd = if cfg!(windows) { "tar.exe" } else { "/usr/bin/tar" };
    let run_tar = |bin: &str| {
        let mut cmd = std::process::Command::new(bin);
        cmd.args(&args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd.status()
    };
    let status = run_tar(tar_cmd)
        .or_else(|_| run_tar("tar"))
        .map_err(|e| format!("无法解压 ONNX Runtime：{e}"))?;

    if !status.success() {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err("解压 ONNX Runtime 失败".into());
    }

    let extracted_main = tmp_dir.join(spec.inner_lib);
    if !extracted_main.is_file() {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err("解压后缺少 ONNX Runtime 动态库".into());
    }
    let dst_main = dir.join(spec.target_name);
    let _ = fs::remove_file(&dst_main);
    fs::rename(&extracted_main, &dst_main).map_err(|e| format!("移动运行库失败：{e}"))?;
    #[cfg(target_os = "macos")]
    strip_macos_quarantine(&dst_main);
    let sha = file_sha256_hex(&dst_main)?;
    config::write_atomic(&dir.join(ORT_SHA_SIDECAR), format!("{sha}\n").as_bytes())
        .map_err(|e| format!("写入运行库校验摘要失败：{e}"))?;

    if let Some(extra) = spec.inner_extra {
        let extracted_extra = tmp_dir.join(extra);
        if extracted_extra.is_file() {
            if let Some(fname) = Path::new(extra).file_name() {
                let dst_extra = dir.join(fname);
                let _ = fs::remove_file(&dst_extra);
                let _ = fs::rename(&extracted_extra, &dst_extra);
                #[cfg(target_os = "macos")]
                strip_macos_quarantine(&dst_extra);
            }
        }
    }
    let _ = fs::remove_dir_all(&tmp_dir);
    Ok(())
}

pub async fn download_tier(app: &AppHandle, tier: &str) -> Result<VoiceAiState, String> {
    if ACTIVE_DOWNLOAD
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("正在下载语音模型".into());
    }
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            ACTIVE_DOWNLOAD.store(false, Ordering::SeqCst);
            invalidate_hud_badge_cache();
        }
    }
    let _guard = Guard;

    let gen_id = DL_GEN.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    DL_CANCEL.store(false, Ordering::SeqCst);

    let dir = models_dir().ok_or_else(|| "找不到模型目录".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建模型目录失败：{e}"))?;

    let mut specs: Vec<ModelSpec> = Vec::new();
    if discover_model_path(&DPDF_SPEC).is_none() {
        specs.push(DPDF_SPEC);
    }
    if discover_model_path(&VAD_SPEC).is_none() {
        specs.push(VAD_SPEC);
    }
    match tier.trim() {
        "base" | "denoise" => {}
        "sv" => {
            if !is_spec_ready_at(&dir, &SV_SPEC) {
                specs.push(SV_SPEC);
            }
        }
        _ => {
            for s in [SV_SPEC, VOXLOCK_ENROLL_SPEC, VOXLOCK_CHUNK_SPEC] {
                if !is_spec_ready_at(&dir, &s) {
                    specs.push(s);
                }
            }
        }
    }

    let need_ort = discover_ort_library().is_none();
    let ort_spec = if need_ort { ort_wheel_spec() } else { None };
    let total_bytes: u64 = specs.iter().map(|s| s.size).sum::<u64>()
        + ort_spec.as_ref().map(|o| o.size).unwrap_or(0);

    let label = match tier.trim() {
        "base" | "denoise" => "基础降噪引擎 (DPDFNet + VAD)".to_string(),
        "sv" => format!("灵巧声纹模型（约 {SV_SIZE_MB} MB）"),
        _ => format!("旗舰声纹分离包（约 {TSE_SIZE_MB} MB）"),
    };

    if total_bytes == 0 {
        let done_snap = DownloadSnapshot {
            downloading: false,
            progress: 1.0,
            dl_label: None,
            dl_error: None,
        };
        emit_progress(app, &done_snap, 1, 1, true);
        return Ok(current_state());
    }

    let china = is_mainland_china();
    let mut completed_bytes: u64 = 0;

    emit_progress(
        app,
        &DownloadSnapshot {
            downloading: true,
            progress: 0.0,
            dl_label: Some(label.clone()),
            dl_error: None,
        },
        0,
        total_bytes,
        false,
    );

    if let Some(ref ort) = ort_spec {
        let whl_part = dir.join("onnxruntime.whl.part");
        let urls = order_urls_by_region(ort.urls, china);
        let res = download_verified_file(&urls, &whl_part, ort.size, ort.sha256, gen_id, |got| {
            let cur = (completed_bytes + got.min(ort.size)).min(total_bytes);
            let prog = (cur as f32) / (total_bytes.max(1) as f32);
            emit_progress(
                app,
                &DownloadSnapshot {
                    downloading: true,
                    progress: prog,
                    dl_label: Some("ONNX Runtime 推理引擎".into()),
                    dl_error: None,
                },
                cur,
                total_bytes,
                false,
            );
        })
        .await;
        if let Err(e) = res {
            let err_msg = if e == "已取消下载" { None } else { Some(e.clone()) };
            emit_progress(
                app,
                &DownloadSnapshot {
                    downloading: false,
                    progress: 0.0,
                    dl_label: None,
                    dl_error: err_msg,
                },
                completed_bytes,
                total_bytes,
                false,
            );
            return Err(e);
        }
        if let Err(e) = extract_ort_from_wheel(&whl_part, &dir, ort) {
            let _ = fs::remove_file(&whl_part);
            emit_progress(
                app,
                &DownloadSnapshot {
                    downloading: false,
                    progress: 0.0,
                    dl_label: None,
                    dl_error: Some(e.clone()),
                },
                completed_bytes,
                total_bytes,
                false,
            );
            return Err(e);
        }
        let _ = fs::remove_file(&whl_part);
        completed_bytes += ort.size;
    }

    for spec in specs {
        let target = dir.join(spec.file_name);
        let stamp = dir.join(spec.stamp_name);
        let part = dir.join(format!("{}.part", spec.file_name));
        let urls = expand_github_mirrors(spec.urls, china);

        let res = download_verified_file(&urls, &part, spec.size, spec.sha256, gen_id, |got| {
            let cur = (completed_bytes + got.min(spec.size)).min(total_bytes);
            let prog = (cur as f32) / (total_bytes.max(1) as f32);
            emit_progress(
                app,
                &DownloadSnapshot {
                    downloading: true,
                    progress: prog,
                    dl_label: Some(label.clone()),
                    dl_error: None,
                },
                cur,
                total_bytes,
                false,
            );
        })
        .await;

        if let Err(e) = res {
            let err_msg = if e == "已取消下载" { None } else { Some(e.clone()) };
            emit_progress(
                app,
                &DownloadSnapshot {
                    downloading: false,
                    progress: 0.0,
                    dl_label: None,
                    dl_error: err_msg,
                },
                completed_bytes,
                total_bytes,
                false,
            );
            return Err(e);
        }

        let _ = fs::remove_file(&stamp);
        let _ = fs::remove_file(&target);
        fs::rename(&part, &target).map_err(|e| format!("保存模型失败：{e}"))?;
        let _ = fs::write(&stamp, format!("{}:{}", spec.size, spec.sha256));
        completed_bytes += spec.size;
    }

    invalidate_live_model_cache();
    invalidate_hud_badge_cache();
    emit_progress(
        app,
        &DownloadSnapshot {
            downloading: false,
            progress: 1.0,
            dl_label: None,
            dl_error: None,
        },
        total_bytes,
        total_bytes,
        true,
    );
    logging::info(
        "voice.ai",
        "voice models ready",
        serde_json::json!({ "tier": tier }),
    );
    Ok(current_state())
}

pub fn cancel_download() -> bool {
    DL_CANCEL.store(true, Ordering::SeqCst);
    DL_GEN.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut g) = dl_lock().lock() {
        g.downloading = false;
        g.dl_label = None;
    }
    true
}

// ---------------------------------------------------------------------------
// Benchmark, Enroll, Test & Processing Pipeline
// ---------------------------------------------------------------------------

pub fn current_state() -> VoiceAiState {
    let cfg = load_config();
    let ort_path = discover_ort_library();
    let ort_ready = ort_path.is_some();
    let ort_version = ort_path
        .as_deref()
        .and_then(|p| ort::OrtRuntime::load_from(p).ok().map(|r| r.version.clone()));
    let dpdf_ready = discover_model_path(&DPDF_SPEC).is_some();
    let vad_ready = discover_model_path(&VAD_SPEC).is_some();
    let sv_ready = discover_model_path(&SV_SPEC).is_some();
    let tse_ready = discover_model_path(&VOXLOCK_ENROLL_SPEC).is_some()
        && discover_model_path(&VOXLOCK_CHUNK_SPEC).is_some();

    let enrolled = cfg
        .voiceprint
        .as_ref()
        .is_some_and(|v| !v.embedding.is_empty() && v.model_version == VOICEPRINT_MODEL_VERSION);
    let dl = dl_lock().lock().map(|g| g.clone()).unwrap_or_default();

    let effective_tier = if cfg.tier == "auto" {
        cfg.recommended_tier
            .as_deref()
            .unwrap_or(if tse_ready && ort_ready {
                "tse"
            } else if sv_ready && ort_ready {
                "sv"
            } else {
                "denoise"
            })
    } else {
        cfg.tier.as_str()
    };

    let active_engine = if !cfg.denoise && !cfg.enhance_vocal && !(cfg.filter && enrolled) {
        "off".to_string()
    } else if ort_ready && dpdf_ready {
        if effective_tier == "tse" && tse_ready && enrolled && has_owner_sample() {
            "onnx-voxlock".to_string()
        } else {
            "onnx-dpdfnet".to_string()
        }
    } else {
        "rust-dsp".to_string()
    };

    VoiceAiState {
        supported: cfg!(any(target_os = "macos", windows)),
        active_engine,
        denoise: cfg.denoise,
        enhance_vocal: cfg.enhance_vocal,
        filter: cfg.filter,
        tier: cfg.tier,
        recommended_tier: cfg.recommended_tier,
        recommend_reason: cfg.recommend_reason,
        threshold: cfg.threshold,
        first_speaker: cfg.first_speaker,
        dpdf_ready,
        vad_ready,
        sv_ready,
        tse_ready,
        sv_size_mb: SV_SIZE_MB,
        tse_size_mb: TSE_SIZE_MB,
        downloading: dl.downloading,
        progress: dl.progress,
        dl_label: dl.dl_label,
        dl_error: dl.dl_error,
        enrolled,
        enroll_seconds: cfg
            .voiceprint
            .as_ref()
            .filter(|_| enrolled)
            .map(|v| v.seconds)
            .unwrap_or(0.0),
        ort_ready,
        ort_version,
        prototypes_count: cfg
            .voiceprint
            .as_ref()
            .filter(|_| enrolled)
            .map(|v| v.prototypes.len())
            .unwrap_or(0),
        consistency: cfg
            .voiceprint
            .as_ref()
            .filter(|_| enrolled)
            .map(|v| v.consistency)
            .unwrap_or(0.0),
        snr_db: cfg.voiceprint.as_ref().filter(|_| enrolled).and_then(|v| v.snr_db),
        has_sample: enrolled && has_owner_sample(),
    }
}

pub fn set_config(patch: VoiceAiConfigPatch) -> Result<VoiceAiState, String> {
    let mut cfg = load_config();
    if let Some(v) = patch.denoise {
        cfg.denoise = v;
    }
    if let Some(v) = patch.enhance_vocal {
        cfg.enhance_vocal = v;
    }
    if let Some(v) = patch.filter {
        cfg.filter = v;
    }
    if let Some(v) = patch.tier {
        cfg.tier = sanitize_tier(&v);
    }
    if let Some(v) = patch.threshold {
        cfg.threshold = clamp_threshold(v);
    }
    if let Some(v) = patch.first_speaker {
        cfg.first_speaker = v;
    }
    save_config(&cfg)?;
    Ok(current_state())
}

#[derive(Clone, Copy)]
struct NeuralCapability {
    ort_ready: bool,
    dpdf_ready: bool,
    sv_ready: bool,
    tse_ready: bool,
    owner_sample: bool,
    has_dpdf: bool,
    has_sv: bool,
    want_tse: bool,
}

fn evaluate_neural_capability(cfg: &VoiceAiConfig, use_ort: bool) -> NeuralCapability {
    if !use_ort {
        return NeuralCapability {
            ort_ready: false,
            dpdf_ready: false,
            sv_ready: false,
            tse_ready: false,
            owner_sample: false,
            has_dpdf: false,
            has_sv: false,
            want_tse: false,
        };
    }
    let ort_ready = discover_ort_library().is_some();
    if !ort_ready {
        return NeuralCapability {
            ort_ready: false,
            dpdf_ready: false,
            sv_ready: false,
            tse_ready: false,
            owner_sample: false,
            has_dpdf: false,
            has_sv: false,
            want_tse: false,
        };
    }
    let dpdf_ready = discover_model_path(&DPDF_SPEC).is_some();
    let sv_ready = discover_model_path(&SV_SPEC).is_some();
    let tse_ready = discover_model_path(&VOXLOCK_ENROLL_SPEC).is_some()
        && discover_model_path(&VOXLOCK_CHUNK_SPEC).is_some();
    let owner_sample = has_owner_sample();

    let tier = sanitize_tier(&cfg.tier);
    let enrolled = cfg.voiceprint.as_ref().is_some_and(|v| {
        cfg.filter && !v.embedding.is_empty() && v.model_version == VOICEPRINT_MODEL_VERSION
    });

    let effective_tier = match tier.as_str() {
        "denoise" => "denoise",
        "tse" => "tse",
        "sv" => "sv",
        _ => {
            if enrolled
                && tse_ready
                && owner_sample
                && cfg
                    .recommended_tier
                    .as_deref()
                    .is_none_or(|r| r == "tse")
            {
                "tse"
            } else {
                "sv"
            }
        }
    };

    let first_lock_mode = effective_tier != "denoise" && !enrolled && cfg.first_speaker;
    let want_identity = effective_tier != "denoise" && (enrolled || first_lock_mode);
    let want_tse = effective_tier == "tse" && enrolled && tse_ready && owner_sample;
    let has_sv = want_identity && sv_ready;
    let has_dpdf = cfg.denoise && dpdf_ready;

    NeuralCapability {
        ort_ready,
        dpdf_ready,
        sv_ready,
        tse_ready,
        owner_sample,
        has_dpdf,
        has_sv,
        want_tse,
    }
}

pub fn active_hud_badge() -> Option<String> {
    let gen = HUD_BADGE_GEN.load(Ordering::SeqCst);
    if let Ok(guard) = hud_badge_cache().lock() {
        if let Some(cached) = guard.get_cached(gen) {
            return cached;
        }
    }
    let cfg = load_config();
    let cap = evaluate_neural_capability(&cfg, true);
    let computed = active_hud_badge_for_state(
        &cfg,
        cap.ort_ready,
        cap.dpdf_ready,
        cap.sv_ready,
        cap.tse_ready,
        cap.owner_sample,
    );
    if HUD_BADGE_GEN.load(Ordering::SeqCst) == gen {
        if let Ok(mut guard) = hud_badge_cache().lock() {
            if HUD_BADGE_GEN.load(Ordering::SeqCst) == gen {
                guard.store(gen, computed.clone());
            }
        }
    }
    computed
}

pub fn voice_call_dsp_open_processor() -> (bool, Option<LiveCallProcessor>, Option<String>) {
    voice_call_dsp_open_processor_with(load_config(), true)
}

pub(crate) fn voice_call_dsp_open_processor_with(
    mut cfg: VoiceAiConfig,
    use_ort: bool,
) -> (bool, Option<LiveCallProcessor>, Option<String>) {
    let cap = evaluate_neural_capability(&cfg, use_ort);
    let has_neural = cap.has_dpdf || cap.has_sv || cap.want_tse;
    if !has_neural {
        return (false, None, cfg.denoise.then(|| "回声消除 · 降噪".into()));
    }
    // Post-AEC safety: never boost speaker residual via VocalEnhancer behind WebRTC AEC.
    cfg.enhance_vocal = false;
    let proc = LiveCallProcessor::with_config_and_ort(cfg.clone(), use_ort);
    if proc.denoiser.is_none() && !proc.has_sv && proc.tse.is_none() {
        return (false, None, cfg.denoise.then(|| "回声消除 · 降噪".into()));
    }
    let badge = active_hud_badge_for_state(
        &cfg,
        cap.ort_ready,
        cap.dpdf_ready,
        cap.sv_ready,
        cap.tse_ready,
        cap.owner_sample,
    );
    (true, Some(proc), badge)
}

fn active_hud_badge_for_state(
    cfg: &VoiceAiConfig,
    ort_ready: bool,
    dpdf_ready: bool,
    sv_ready: bool,
    tse_ready: bool,
    owner_sample: bool,
) -> Option<String> {
    let enrolled = cfg
        .voiceprint
        .as_ref()
        .is_some_and(|v| cfg.filter && !v.embedding.is_empty() && v.model_version == VOICEPRINT_MODEL_VERSION);

    let effective_tier = match cfg.tier.as_str() {
        "denoise" => "denoise",
        "tse" => "tse",
        "sv" => "sv",
        _ => {
            if enrolled
                && ort_ready
                && tse_ready
                && owner_sample
                && cfg
                    .recommended_tier
                    .as_deref()
                    .is_none_or(|r| r == "tse")
            {
                "tse"
            } else {
                "sv"
            }
        }
    };

    let first_lock_mode = effective_tier != "denoise" && !enrolled && cfg.first_speaker;
    let want_identity = effective_tier != "denoise" && (enrolled || first_lock_mode);
    let want_tse = effective_tier == "tse" && enrolled && ort_ready && tse_ready && owner_sample;
    let has_sv = want_identity && ort_ready && sv_ready;
    let has_dpdf = cfg.denoise && ort_ready && dpdf_ready;

    if !cfg.denoise && !cfg.enhance_vocal && !has_sv && !want_tse {
        return None;
    }

    if has_dpdf {
        if want_tse {
            return Some("VoxLock + DPDFNet".into());
        }
        if has_sv {
            return Some("DPDFNet + 声纹".into());
        }
        return Some("DPDFNet 降噪".into());
    }
    if want_tse {
        return Some(if cfg.denoise || cfg.enhance_vocal {
            "VoxLock + DSP".into()
        } else {
            "VoxLock 声纹".into()
        });
    }
    if has_sv {
        return Some(if cfg.denoise || cfg.enhance_vocal {
            "DSP + 声纹".into()
        } else {
            "声纹锁定".into()
        });
    }
    if cfg.denoise || cfg.enhance_vocal {
        return Some("本地 DSP 降噪".into());
    }
    None
}

pub fn benchmark_device() -> Result<VoiceAiBenchmarkResult, String> {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let ram_mb = system_ram_mb();
    let ort_ready = discover_ort_library().is_some();
    let mut dpdf_us = 0.0f64;
    let mut tse_rtf = -1.0f64;

    if ort_ready {
        if let Ok(loaded) = models::open_models(true, true, false, true) {
            if let (Some(dpdf_sess), Some(dpdf_cfg)) =
                (loaded.dpdf.as_ref(), loaded.dpdf_cfg.as_ref())
            {
                let mut denoiser = models::Denoiser::new(&loaded.rt, dpdf_sess, dpdf_cfg);
                let hop_in = [0.01f32; 160];
                let mut hop_out = [0.0f32; 160];
                for _ in 0..5 {
                    let _ = denoiser.hop(&hop_in, &mut hop_out);
                }
                let t0 = Instant::now();
                for _ in 0..25 {
                    let _ = denoiser.hop(&hop_in, &mut hop_out);
                }
                dpdf_us = t0.elapsed().as_secs_f64() * 1_000_000.0 / 25.0;
            }
            if let (Some(te), Some(tc)) = (loaded.tse_enroll.as_ref(), loaded.tse_chunk.as_ref()) {
                let dummy = vec![0.01f32; OWNER_SAMPLE_LEN];
                if let Ok((enr, _)) = models::VoxLockEnrollment::compute(&loaded.rt, te, &dummy) {
                    let enr = Arc::new(enr);
                    if let Ok(mut ext) = models::TargetExtractor::new(&loaded.rt, tc, &enr) {
                        let first = vec![0.01f32; ext.required_input_samples()];
                        let _ = ext.step(&first);
                        let step_in = vec![0.01f32; ext.required_input_samples()];
                        let t0 = Instant::now();
                        for _ in 0..3 {
                            let _ = ext.step(&step_in);
                        }
                        let tse_ms_avg = t0.elapsed().as_secs_f64() * 1000.0 / 3.0;
                        tse_rtf = tse_ms_avg / 40.0;
                    }
                }
            }
        }
    }

    if dpdf_us <= 0.0 {
        let mut gate = dsp::SpectralNoiseGate::default();
        let hop_in = [0.01f32; 160];
        let mut hop_out = [0.0f32; 160];
        for _ in 0..5 {
            gate.process_hop(&hop_in, &mut hop_out);
        }
        let t0 = Instant::now();
        for _ in 0..25 {
            gate.process_hop(&hop_in, &mut hop_out);
        }
        dpdf_us = t0.elapsed().as_secs_f64() * 1_000_000.0 / 25.0;
    }

    let (recommended_tier, reason) = if tse_rtf > 0.0 {
        if tse_rtf <= 0.80 {
            (
                "tse".to_string(),
                format!(
                    "实测分离负载 {:.0}%（单帧降噪 {:.2} ms），可流畅运行旗舰分离模型",
                    tse_rtf * 100.0,
                    dpdf_us / 1000.0
                ),
            )
        } else if (dpdf_us / 10_000.0) <= 0.75 {
            (
                "sv".to_string(),
                format!("实测人声分离负载 {tse_rtf:.2}x 超出实时上限，推荐 68 MB 灵巧声纹门控"),
            )
        } else {
            (
                "denoise".to_string(),
                format!("设备当前负载较高（降噪单帧 {:.2} ms），推荐仅开本地降噪", dpdf_us / 1000.0),
            )
        }
    } else if dpdf_us <= 1650.0 && cores >= 6 && ram_mb >= 5500 {
        (
            "tse".to_string(),
            format!(
                "芯片算力充裕（降噪 {:.2} ms/帧 · {cores}核），支持 {TSE_SIZE_MB} MB 旗舰人声分离",
                dpdf_us / 1000.0
            ),
        )
    } else if dpdf_us <= 6800.0 {
        (
            "sv".to_string(),
            format!(
                "实测降噪 {:.2} ms/帧（{cores}核），推荐 {SV_SIZE_MB} MB 灵巧声纹门控",
                dpdf_us / 1000.0
            ),
        )
    } else {
        (
            "denoise".to_string(),
            format!("实测降噪 {:.2} ms/帧，推荐轻量本地降噪保证零卡顿", dpdf_us / 1000.0),
        )
    };

    let mut cfg = load_config();
    cfg.recommended_tier = Some(recommended_tier.clone());
    cfg.recommend_reason = Some(reason.clone());
    cfg.bench_dpdf_us = Some(dpdf_us);
    if tse_rtf > 0.0 {
        cfg.bench_tse_rtf = Some(tse_rtf);
    }
    cfg.bench_at = Some(now_ms());
    save_config(&cfg)?;

    Ok(VoiceAiBenchmarkResult {
        recommended_tier,
        reason,
        dpdf_us,
        tse_rtf,
        cores,
        ram_mb,
        ort_ready,
    })
}

fn system_ram_mb() -> u64 {
    #[cfg(target_os = "macos")]
    {
        let mut mem: u64 = 0;
        let mut size = std::mem::size_of::<u64>();
        let name = CString::new("hw.memsize").unwrap();
        let rc = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (&mut mem as *mut u64).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc == 0 && mem > 0 {
            return mem / (1024 * 1024);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        8192
    }
    #[cfg(target_os = "macos")]
    {
        8192
    }
}

// ---------------------------------------------------------------------------
// Enrollment & live verification sessions
// ---------------------------------------------------------------------------

#[cfg(any(target_os = "macos", windows))]
mod lab {
    use super::*;
    use crate::voice::audio;

    struct EnrollSession {
        stop: Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<EnrollCollected>>,
    }

    struct EnrollCollected {
        speech: Vec<f32>,
        noise_rms: f32,
        speech_sq_sum: f64,
        speech_samples: usize,
        models: Arc<models::LoadedModels>,
    }

    struct TestSession {
        stop: Arc<AtomicBool>,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    static ENROLL_SLOT: OnceLock<Mutex<Option<EnrollSession>>> = OnceLock::new();
    static TEST_SLOT: OnceLock<Mutex<Option<TestSession>>> = OnceLock::new();

    fn enroll_slot() -> &'static Mutex<Option<EnrollSession>> {
        ENROLL_SLOT.get_or_init(|| Mutex::new(None))
    }

    fn test_slot() -> &'static Mutex<Option<TestSession>> {
        TEST_SLOT.get_or_init(|| Mutex::new(None))
    }

    fn check_mic_permission() -> Result<(), String> {
        use crate::perms::State;
        match crate::perms::status().microphone {
            State::Denied | State::Restricted => Err(
                "没有麦克风权限，请在系统设置 › 隐私与安全性 › 麦克风里允许 Herdr Pocket".into(),
            ),
            State::NotDetermined => {
                let st = crate::perms::request("microphone")?;
                if st.microphone == State::Granted {
                    Ok(())
                } else {
                    Err("请先允许麦克风权限再录制声纹".into())
                }
            }
            _ => Ok(()),
        }
    }

    pub fn stop_all() {
        cancel_enroll();
        stop_test();
    }

    pub fn start_enroll(app: AppHandle) -> Result<(), String> {
        stop_all();
        check_mic_permission()?;
        let loaded = Arc::new(models::open_models(false, true, true, false)?);
        if loaded.speaker.is_none() || loaded.vad.is_none() {
            return Err("声纹或 VAD 模型还没准备好，请先下载模型".into());
        }
        let rec = audio::start(25)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();
        let models_ref = loaded.clone();

        let handle = std::thread::Builder::new()
            .name("pocket-vp-enroll".into())
            .spawn(move || {
                let mut cursor = 0usize;
                let mut hpf = dsp::HighPass64::default();
                let mut vad = models::Vad::new(
                    &models_ref.rt,
                    models_ref.vad.as_ref().expect("vad checked"),
                );
                let mut vad_boost = dsp::QuietVadBoost::default();
                let mut pending = Vec::<f32>::new();
                let mut speech = Vec::<f32>::with_capacity(VOICE_RATE * 20);
                let mut noise_rms = 0.0015f32;
                let mut noise_windows = 0usize;
                let mut speech_sq_sum = 0.0f64;
                let mut speech_samples = 0usize;
                let mut level = 0.0f32;

                while !stop_flag.load(Ordering::Relaxed) && !rec.failed() {
                    let chunk_i16 = rec.snapshot_from(cursor);
                    if !chunk_i16.is_empty() {
                        cursor += chunk_i16.len();
                        let raw_f32 = dsp::pcm16_to_f32(&chunk_i16);
                        let mut hpf_f32 = vec![0.0f32; raw_f32.len()];
                        hpf.process_slice(&raw_f32, &mut hpf_f32);
                        pending.extend_from_slice(&hpf_f32);

                        while pending.len() >= models::Vad::WINDOW {
                            let win: Vec<f32> = pending.drain(..models::Vad::WINDOW).collect();
                            let mut e = 0.0f64;
                            for &v in &win {
                                e += f64::from(v) * f64::from(v);
                            }
                            let win_rms = (e / (models::Vad::WINDOW as f64)).sqrt() as f32;
                            level = (win_rms * 4.0).min(1.0);

                            let mut boosted = [0.0f32; models::Vad::WINDOW];
                            vad_boost.prepare(&win, &mut boosted);
                            let p = vad.prob(&boosted).unwrap_or(0.0);
                            if p < 0.25 {
                                noise_rms = if noise_windows == 0 {
                                    win_rms.max(0.0002)
                                } else {
                                    0.90 * noise_rms + 0.10 * win_rms.max(0.0002)
                                };
                                noise_windows += 1;
                                continue;
                            }
                            if p < 0.42 {
                                continue;
                            }
                            if speech.len() < VOICE_RATE * 20 {
                                speech_sq_sum += e;
                                speech_samples += models::Vad::WINDOW;
                                speech.extend_from_slice(&win);
                            }
                        }
                    } else {
                        level *= 0.82;
                    }

                    let seconds = (speech.len() as f32) / (VOICE_RATE as f32);
                    let _ = app.emit(
                        EVENT_ENROLL,
                        serde_json::json!({
                            "level": level,
                            "seconds": (seconds * 100.0).round() / 100.0,
                            "full": seconds >= 18.0,
                        }),
                    );
                    std::thread::sleep(Duration::from_millis(85));
                }
                let _ = rec.finish();
                EnrollCollected {
                    speech,
                    noise_rms,
                    speech_sq_sum,
                    speech_samples,
                    models: models_ref,
                }
            })
            .map_err(|e| format!("启动录音线程失败：{e}"))?;

        if let Ok(mut slot) = enroll_slot().lock() {
            *slot = Some(EnrollSession {
                stop,
                handle: Some(handle),
            });
        }
        Ok(())
    }

    pub fn finish_enroll() -> Result<VoiceAiEnrollResult, String> {
        let mut sess = enroll_slot()
            .lock()
            .map_err(|_| "声纹会话忙".to_string())?
            .take()
            .ok_or_else(|| "没有正在进行的声纹录入".to_string())?;
        sess.stop.store(true, Ordering::SeqCst);
        let collected = sess
            .handle
            .take()
            .ok_or_else(|| "声纹线程已结束".to_string())?
            .join()
            .map_err(|_| "声纹线程异常".to_string())?;

        let seconds = (collected.speech.len() as f32) / (VOICE_RATE as f32);
        if seconds < 3.5 {
            return Err(format!(
                "录到的有效说话只有 {seconds:.1} 秒，请对着麦克风再多说几句"
            ));
        }

        super::enroll_collected_speech(
            &collected.models,
            &collected.speech,
            collected.speech_sq_sum,
            collected.speech_samples,
            collected.noise_rms,
            "desktop-mic",
        )
    }

    pub fn cancel_enroll() {
        if let Ok(mut slot) = enroll_slot().lock() {
            if let Some(mut sess) = slot.take() {
                sess.stop.store(true, Ordering::SeqCst);
                if let Some(h) = sess.handle.take() {
                    let _ = h.join();
                }
            }
        }
    }

    pub fn start_test(app: AppHandle, threshold: Option<f32>) -> Result<(), String> {
        stop_all();
        check_mic_permission()?;
        let cfg = load_config();
        let vp = cfg
            .voiceprint
            .as_ref()
            .filter(|v| !v.embedding.is_empty() && v.model_version == VOICEPRINT_MODEL_VERSION)
            .ok_or_else(|| "还没有录入声纹，请先录入本人声纹".to_string())?;

        let enrolled = dsp::normalize_embedding(&vp.embedding);
        let prototypes: Vec<Vec<f32>> = vp
            .prototypes
            .iter()
            .map(|p| dsp::normalize_embedding(p))
            .collect();
        let thr = clamp_threshold(threshold.unwrap_or(cfg.threshold));

        let loaded = Arc::new(models::open_models(false, true, true, false)?);
        if loaded.speaker.is_none() || loaded.vad.is_none() {
            return Err("声纹或 VAD 模型还没准备好".into());
        }

        let rec = audio::start(120)?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();

        let handle = std::thread::Builder::new()
            .name("pocket-vp-test".into())
            .spawn(move || {
                let mut cursor = 0usize;
                let mut hpf = dsp::HighPass64::default();
                let mut vad = models::Vad::new(
                    &loaded.rt,
                    loaded.vad.as_ref().expect("vad checked"),
                );
                let speaker =
                    models::Speaker::new(&loaded.rt, loaded.speaker.as_ref().expect("sv checked"));
                let mut vad_boost = dsp::QuietVadBoost::default();
                let mut pending = Vec::<f32>::new();
                let mut speech_buf = Vec::<f32>::with_capacity(VOICE_RATE * 2);
                let mut speaking = false;
                let mut sil_run = 0usize;
                let mut level = 0.0f32;
                let mut last_eval = Instant::now() - Duration::from_secs(1);

                while !stop_flag.load(Ordering::Relaxed) && !rec.failed() {
                    let chunk_i16 = rec.snapshot_from(cursor);
                    if !chunk_i16.is_empty() {
                        cursor += chunk_i16.len();
                        let raw_f32 = dsp::pcm16_to_f32(&chunk_i16);
                        let mut hpf_f32 = vec![0.0f32; raw_f32.len()];
                        hpf.process_slice(&raw_f32, &mut hpf_f32);
                        pending.extend_from_slice(&hpf_f32);

                        while pending.len() >= models::Vad::WINDOW {
                            let win: Vec<f32> = pending.drain(..models::Vad::WINDOW).collect();
                            let win_rms = dsp::rms(&win);
                            level = (win_rms * 4.0).min(1.0);

                            let mut boosted = [0.0f32; models::Vad::WINDOW];
                            vad_boost.prepare(&win, &mut boosted);
                            let p = vad.prob(&boosted).unwrap_or(0.0);
                            if p >= 0.35 {
                                speaking = true;
                                sil_run = 0;
                                speech_buf.extend_from_slice(&win);
                                if speech_buf.len() > VOICE_RATE * 2 {
                                    let drop_n = speech_buf.len() - VOICE_RATE * 2;
                                    speech_buf.drain(..drop_n);
                                }
                            } else if speaking {
                                sil_run += 1;
                                if sil_run >= 15 {
                                    speaking = false;
                                    sil_run = 0;
                                }
                            }
                        }
                    } else {
                        level *= 0.82;
                    }

                    if speech_buf.len() >= VOICE_RATE * 2 / 5
                        && last_eval.elapsed() >= Duration::from_millis(450)
                    {
                        last_eval = Instant::now();
                        let t0 = Instant::now();
                        if let Ok(raw_emb) = speaker.embed(&speech_buf) {
                            let infer_ms = (t0.elapsed().as_secs_f64() * 1000.0 * 10.0).round() / 10.0;
                            let norm = dsp::normalize_embedding(&raw_emb);
                            let sv = dsp::score_voiceprint(&norm, &enrolled, &prototypes);
                            let _ = app.emit(
                                EVENT_TEST,
                                serde_json::json!({
                                    "level": level,
                                    "speaking": speaking,
                                    "score": (sv.blended * 1000.0).round() / 1000.0,
                                    "rawScore": (sv.raw * 1000.0).round() / 1000.0,
                                    "protoScore": (sv.proto * 1000.0).round() / 1000.0,
                                    "pass": sv.blended >= thr,
                                    "inferMs": infer_ms,
                                }),
                            );
                        }
                        if !speaking {
                            speech_buf.clear();
                        }
                    } else {
                        let _ = app.emit(
                            EVENT_TEST,
                            serde_json::json!({
                                "level": level,
                                "speaking": speaking,
                            }),
                        );
                    }
                    std::thread::sleep(Duration::from_millis(90));
                }
                let _ = rec.finish();
            })
            .map_err(|e| format!("启动测试线程失败：{e}"))?;

        if let Ok(mut slot) = test_slot().lock() {
            *slot = Some(TestSession {
                stop,
                handle: Some(handle),
            });
        }
        Ok(())
    }

    pub fn stop_test() {
        if let Ok(mut slot) = test_slot().lock() {
            if let Some(mut sess) = slot.take() {
                sess.stop.store(true, Ordering::SeqCst);
                if let Some(h) = sess.handle.take() {
                    let _ = h.join();
                }
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod lab {
    use super::*;
    pub fn stop_all() {}
    pub fn start_enroll(_app: AppHandle) -> Result<(), String> {
        Err("当前系统暂不支持语音录制".into())
    }
    pub fn finish_enroll() -> Result<VoiceAiEnrollResult, String> {
        Err("当前系统暂不支持语音录制".into())
    }
    pub fn cancel_enroll() {}
    pub fn start_test(_app: AppHandle, _threshold: Option<f32>) -> Result<(), String> {
        Err("当前系统暂不支持语音录制".into())
    }
    pub fn stop_test() {}
}

pub fn start_enroll(app: AppHandle) -> Result<(), String> {
    lab::start_enroll(app)
}

pub fn finish_enroll() -> Result<VoiceAiEnrollResult, String> {
    lab::finish_enroll()
}

pub fn cancel_enroll() -> bool {
    lab::cancel_enroll();
    true
}

pub fn clear_voiceprint() -> Result<VoiceAiState, String> {
    lab::stop_all();
    delete_owner_sample();
    delete_voiceprint_backup();
    invalidate_hud_badge_cache();
    let mut cfg = load_config();
    cfg.voiceprint = None;
    cfg.filter = false;
    save_config(&cfg)?;
    Ok(current_state())
}

pub fn export_voiceprint() -> Result<Option<serde_json::Value>, String> {
    let cfg = load_config();
    let Some(mut vp) = cfg.voiceprint else {
        return Ok(None);
    };
    let sample_b64 = read_owner_sample_base64();
    vp.has_sample = sample_b64.is_some();
    Ok(Some(serde_json::json!({
        "voiceprint": vp,
        "sampleBase64": sample_b64,
    })))
}

pub fn import_voiceprint(payload: serde_json::Value) -> Result<VoiceAiState, String> {
    let vp_val = payload
        .get("voiceprint")
        .cloned()
        .unwrap_or_else(|| payload.clone());
    let mut vp: VoiceprintRecord =
        serde_json::from_value(vp_val).map_err(|e| format!("声纹数据格式无效：{e}"))?;
    if vp.model_version.trim().is_empty() {
        vp.model_version = VOICEPRINT_MODEL_VERSION.into();
    }
    if !is_valid_voiceprint(&vp) {
        return Err("声纹特征向量不完整或版本不支持".into());
    }
    vp.prototypes
        .retain(|p| p.len() == vp.embedding.len() && p.iter().all(|v| v.is_finite()));
    let sample_ok = payload
        .get("sampleBase64")
        .and_then(|v| v.as_str())
        .is_some_and(write_owner_sample_base64);
    vp.has_sample = sample_ok || has_owner_sample();

    let mut cfg = load_config();
    cfg.voiceprint = Some(vp);
    cfg.filter = true;
    save_config(&cfg)?;
    Ok(current_state())
}

pub fn enroll_from_pcm_bytes(pcm_le_i16: &[u8]) -> Result<VoiceAiEnrollResult, String> {
    if pcm_le_i16.len() < VOICE_RATE * 2 * 2 {
        return Err("音频文件太短，请使用至少 2 秒清晰人声录音".into());
    }
    let max_bytes = VOICE_RATE * 60 * 2;
    let slice = &pcm_le_i16[..pcm_le_i16.len().min(max_bytes)];
    let mut samples = Vec::with_capacity(slice.len() / 2);
    for ch in slice.chunks_exact(2) {
        samples.push(f32::from(i16::from_le_bytes([ch[0], ch[1]])) / 32768.0);
    }

    let loaded = models::open_models(false, true, true, false)?;
    if loaded.speaker.is_none() || loaded.vad.is_none() {
        return Err("声纹或 VAD 模型还没准备好，请先下载模型".into());
    }

    let mut hpf = dsp::HighPass64::default();
    let mut hpf_f32 = vec![0.0f32; samples.len()];
    hpf.process_slice(&samples, &mut hpf_f32);

    let mut vad = models::Vad::new(&loaded.rt, loaded.vad.as_ref().expect("vad checked"));
    let mut vad_boost = dsp::QuietVadBoost::default();
    let mut vad_speech = Vec::<f32>::with_capacity(VOICE_RATE * 20);
    let mut rms_speech = Vec::<f32>::with_capacity(VOICE_RATE * 20);
    let mut noise_rms = 0.0015f32;
    let mut noise_windows = 0usize;
    let mut vad_sq_sum = 0.0f64;
    let mut vad_samples = 0usize;
    let mut rms_sq_sum = 0.0f64;
    let mut rms_samples = 0usize;

    for win in hpf_f32.chunks_exact(models::Vad::WINDOW) {
        let mut e = 0.0f64;
        for &v in win {
            e += f64::from(v) * f64::from(v);
        }
        let win_rms = (e / (models::Vad::WINDOW as f64)).sqrt() as f32;
        if win_rms >= 0.008 && rms_speech.len() < VOICE_RATE * 20 {
            rms_sq_sum += e;
            rms_samples += models::Vad::WINDOW;
            rms_speech.extend_from_slice(win);
        }
        let mut boosted = [0.0f32; models::Vad::WINDOW];
        vad_boost.prepare(win, &mut boosted);
        let p = vad.prob(&boosted).unwrap_or(0.0);
        if p < 0.25 {
            noise_rms = if noise_windows == 0 {
                win_rms.max(0.0002)
            } else {
                0.90 * noise_rms + 0.10 * win_rms.max(0.0002)
            };
            noise_windows += 1;
            continue;
        }
        if p >= 0.42 && vad_speech.len() < VOICE_RATE * 20 {
            vad_sq_sum += e;
            vad_samples += models::Vad::WINDOW;
            vad_speech.extend_from_slice(win);
        }
    }

    let (speech, sq_sum, sp_count) = if vad_speech.len() >= VOICE_RATE * 2 {
        (vad_speech, vad_sq_sum, vad_samples)
    } else if rms_speech.len() >= VOICE_RATE * 2 {
        (rms_speech, rms_sq_sum, rms_samples)
    } else {
        let secs = (vad_speech.len() as f32) / (VOICE_RATE as f32);
        return Err(format!(
            "音频中检测到的有效人声只有 {secs:.1} 秒，请换一段更清晰、至少 2 秒的说话录音"
        ));
    };

    enroll_collected_speech(&loaded, &speech, sq_sum, sp_count, noise_rms, "audio-file")
}

pub(crate) fn enroll_collected_speech(
    models: &models::LoadedModels,
    speech: &[f32],
    speech_sq_sum: f64,
    speech_samples: usize,
    noise_rms: f32,
    route: &str,
) -> Result<VoiceAiEnrollResult, String> {
    let seconds = (speech.len() as f32) / (VOICE_RATE as f32);
    let sp_sess = models
        .speaker
        .as_ref()
        .ok_or_else(|| "声纹模型未加载".to_string())?;
    let speaker = models::Speaker::new(&models.rt, sp_sess);

    let piece = VOICE_RATE * 3 / 2;
    let hop = VOICE_RATE * 3 / 4;
    let mut pieces = Vec::new();
    let mut off = 0usize;
    while off + piece <= speech.len() {
        if let Ok(raw) = speaker.embed(&speech[off..off + piece]) {
            let norm = dsp::normalize_embedding(&raw);
            if !norm.is_empty() {
                pieces.push(norm);
            }
        }
        off += hop;
    }
    if pieces.is_empty() {
        let raw = speaker.embed(speech)?;
        let norm = dsp::normalize_embedding(&raw);
        if !norm.is_empty() {
            pieces.push(norm);
        }
    }
    if pieces.is_empty() {
        return Err("未能提取到有效声纹特征，请重试".into());
    }

    let mut kept = pieces.clone();
    let mut centroid = dsp::mean_embedding(&kept);
    let mut scores: Vec<f32> = kept.iter().map(|p| dsp::cosine(p, &centroid)).collect();
    if pieces.len() >= 4 {
        let mut sorted = scores.clone();
        sorted.sort_by(|a, b| a.total_cmp(b));
        let median = sorted[sorted.len() / 2];
        let floor = (median - 0.22).max(0.35);
        let filtered: Vec<Vec<f32>> = pieces
            .iter()
            .zip(scores.iter())
            .filter(|(_, &sc)| sc >= floor)
            .map(|(p, _)| p.clone())
            .collect();
        if filtered.len() >= 3 && filtered.len() < pieces.len() {
            kept = filtered;
            centroid = dsp::mean_embedding(&kept);
            scores = kept.iter().map(|p| dsp::cosine(p, &centroid)).collect();
        }
    }

    let prototypes = dsp::select_prototypes(&kept, &centroid, 6);
    let owner_sample = dsp::pick_cleanest_sample(speech, OWNER_SAMPLE_LEN);
    let has_sample = save_owner_sample(&owner_sample);

    let speech_rms = if speech_samples > 0 {
        (speech_sq_sum / (speech_samples as f64)).sqrt() as f32
    } else {
        0.02
    };
    let raw_snr = 20.0
        * (f64::from(speech_rms.max(1e-4)) / f64::from(noise_rms.max(1e-4))).log10();
    let snr_db = raw_snr.clamp(0.0, 60.0) as f32;
    let consistency = scores.iter().sum::<f32>() / (scores.len().max(1) as f32);
    let lowest = scores.iter().copied().fold(1.0f32, f32::min);

    let mut cfg = load_config();
    cfg.filter = true;
    cfg.voiceprint = Some(VoiceprintRecord {
        embedding: centroid,
        prototypes: prototypes.clone(),
        model_version: VOICEPRINT_MODEL_VERSION.into(),
        has_sample,
        route: Some(route.into()),
        snr_db: Some(snr_db),
        seconds,
        consistency,
        lowest,
        created_at: now_ms(),
    });
    save_config(&cfg)?;

    Ok(VoiceAiEnrollResult {
        seconds,
        consistency,
        lowest,
        snr_db,
        prototypes_count: prototypes.len(),
        has_sample,
        state: current_state(),
    })
}

pub fn start_test(app: AppHandle, threshold: Option<f32>) -> Result<(), String> {
    lab::start_test(app, threshold)
}

pub fn stop_test() -> bool {
    lab::stop_test();
    true
}

pub fn shutdown() {
    cancel_download();
    lab::stop_all();
    invalidate_live_model_cache();
}

/// Processes a complete 16 kHz mono recording before WAV encoding & transcription.
#[allow(dead_code)]
pub fn process_recording(samples: &[i16]) -> ProcessOutcome {
    let cfg = load_config();
    process_recording_with_config(samples, &cfg)
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn process_recording_with_config(samples: &[i16], cfg: &VoiceAiConfig) -> ProcessOutcome {
    if samples.is_empty() {
        return ProcessOutcome::Accept {
            samples: Vec::new(),
            dsp_badge: None,
        };
    }

    let enrolled_vp = cfg
        .voiceprint
        .as_ref()
        .filter(|v| !v.embedding.is_empty() && v.model_version == VOICEPRINT_MODEL_VERSION);
    let want_sv = cfg.filter && enrolled_vp.is_some();

    if !cfg.denoise && !cfg.enhance_vocal && !want_sv {
        return ProcessOutcome::Accept {
            samples: samples.to_vec(),
            dsp_badge: None,
        };
    }

    let raw_f32 = dsp::pcm16_to_f32(samples);
    let mut clean_hpf = vec![0.0f32; raw_f32.len()];
    dsp::HighPass64::default().process_slice(&raw_f32, &mut clean_hpf);

    let effective_tier = if cfg.tier == "auto" {
        cfg.recommended_tier.as_deref().unwrap_or("sv")
    } else {
        cfg.tier.as_str()
    };
    let want_tse = want_sv && effective_tier == "tse" && has_owner_sample();

    let ort_ok = discover_ort_library().is_some();
    let loaded = if ort_ok {
        models::open_models(cfg.denoise, want_sv, want_sv, want_tse).ok()
    } else {
        None
    };

    // Path A: Run DPDFNet denoise + VoxLock TSE target extraction FIRST so SV evaluates
    // the separated target stream (or denoised stream when TSE is off) instead of raw overlap.
    let mut audio_buf = clean_hpf.clone();
    dsp::HighPass80::default().process_in_place(&mut audio_buf);

    let mut used_dpdf = false;
    if cfg.denoise {
        if let Some(ref m) = loaded {
            if let (Some(dpdf_sess), Some(dpdf_cfg)) = (m.dpdf.as_ref(), m.dpdf_cfg.as_ref()) {
                let mut denoiser = models::Denoiser::new(&m.rt, dpdf_sess, dpdf_cfg);
                if let Ok(enhanced) = denoiser.process_buffer(&audio_buf) {
                    audio_buf = enhanced;
                    used_dpdf = true;
                }
            }
        }
    }

    let mut used_tse = false;
    let mut tse_atten_db = 0.0f64;
    let mut tse_out_rms = 0.0f32;
    if want_tse {
        if let (Some(ref m), Some(owner_sample)) = (&loaded, load_owner_sample()) {
            if let (Some(te), Some(tc)) = (m.tse_enroll.as_ref(), m.tse_chunk.as_ref()) {
                if let Ok((enr, _)) = models::VoxLockEnrollment::compute(&m.rt, te, &owner_sample)
                {
                    let enr = Arc::new(enr);
                    if let Ok(mut ext) = models::TargetExtractor::new(&m.rt, tc, &enr) {
                        if let Ok(extracted) = ext.process_buffer(&audio_buf) {
                            let in_rms = dsp::rms(&audio_buf).max(1e-5);
                            let out_rms = dsp::rms(&extracted).max(1e-5);
                            tse_atten_db =
                                20.0 * (f64::from(out_rms) / f64::from(in_rms)).log10();
                            tse_out_rms = out_rms;
                            audio_buf = extracted;
                            used_tse = true;
                        }
                    }
                }
            }
        }
    }

    // Path B: Verify owner voiceprint on the TSE-separated (or DPDFNet-denoised) stream,
    // falling back to clean HPF when neither neural stage ran.
    let mut sv_passed = true;
    let mut sv_score = 1.0f32;
    if want_sv {
        if let (Some(ref m), Some(vp)) = (&loaded, enrolled_vp) {
            if let Some(sp_sess) = m.speaker.as_ref() {
                let speaker = models::Speaker::new(&m.rt, sp_sess);
                let sv_source: &[f32] = if used_tse || used_dpdf {
                    &audio_buf
                } else {
                    &clean_hpf
                };
                let speech_slice = extract_voiced_speech(sv_source, m);
                if speech_slice.len() >= VOICE_RATE / 4 {
                    if let Ok(raw_emb) = speaker.embed(&speech_slice) {
                        let norm = dsp::normalize_embedding(&raw_emb);
                        let centroid = dsp::normalize_embedding(&vp.embedding);
                        let protos: Vec<Vec<f32>> = vp
                            .prototypes
                            .iter()
                            .map(|p| dsp::normalize_embedding(p))
                            .collect();
                        let res = dsp::score_voiceprint(&norm, &centroid, &protos);
                        sv_score = res.blended;
                        if sv_score < cfg.threshold {
                            sv_passed = false;
                        }
                    }
                }
            }
        }
    }

    if want_sv && !sv_passed {
        let should_reject = !used_tse
            || tse_atten_db < LiveCallProcessor::TSE_GATE_CLOSE_DB
            || sv_score < cfg.threshold - SvTracker::STRONG_NON_OWNER_MARGIN
            || tse_out_rms < 0.004;
        if should_reject {
            return ProcessOutcome::RejectNonOwner {
                reason: "未检测到本人声纹，已忽略环境人声".into(),
                score: sv_score,
            };
        }
    }

    if cfg.denoise && !used_dpdf {
        audio_buf = dsp::SpectralNoiseGate::default().process_buffer(&audio_buf);
    }

    if cfg.enhance_vocal {
        dsp::VocalEnhancer::default().process_in_place(&mut audio_buf);
    }

    let badge = if used_tse && used_dpdf {
        Some("VoxLock + DPDFNet".into())
    } else if used_dpdf && want_sv {
        Some("DPDFNet + 声纹".into())
    } else if used_dpdf {
        Some("DPDFNet 降噪".into())
    } else if cfg.denoise || cfg.enhance_vocal {
        Some("本地 DSP 降噪".into())
    } else {
        None
    };

    ProcessOutcome::Accept {
        samples: dsp::f32_to_pcm16(&audio_buf),
        dsp_badge: badge,
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn extract_voiced_speech(clean_hpf: &[f32], m: &models::LoadedModels) -> Vec<f32> {
    let Some(vad_sess) = m.vad.as_ref() else {
        return clean_hpf.to_vec();
    };
    let mut vad = models::Vad::new(&m.rt, vad_sess);
    let mut boost = dsp::QuietVadBoost::default();
    let mut voiced = Vec::new();
    let mut probe = [0.0f32; models::Vad::WINDOW];
    for win in clean_hpf.chunks_exact(models::Vad::WINDOW) {
        boost.prepare(win, &mut probe);
        if vad.prob(&probe).unwrap_or(0.0) >= 0.35 {
            voiced.extend_from_slice(win);
        }
    }
    if voiced.len() >= VOICE_RATE / 4 {
        voiced
    } else {
        clean_hpf.to_vec()
    }
}

// ---------------------------------------------------------------------------
// Cached ORT sessions & real-time 16 kHz / 320-sample call processor
// ---------------------------------------------------------------------------

struct CachedLiveModels {
    models: Arc<models::LoadedModels>,
    dpdf_ready: bool,
    vad_ready: bool,
    sv_ready: bool,
    tse_ready: bool,
}

static LIVE_MODEL_CACHE: OnceLock<Mutex<Option<CachedLiveModels>>> = OnceLock::new();

fn live_model_cache() -> &'static Mutex<Option<CachedLiveModels>> {
    LIVE_MODEL_CACHE.get_or_init(|| Mutex::new(None))
}

fn invalidate_live_model_cache() {
    if let Ok(mut guard) = live_model_cache().lock() {
        *guard = None;
    }
    invalidate_hud_badge_cache();
}

fn cached_live_models(
    need_dpdf: bool,
    need_vad: bool,
    need_sv: bool,
    need_tse: bool,
) -> Option<Arc<models::LoadedModels>> {
    discover_ort_library()?;
    let want_dpdf = need_dpdf && discover_model_path(&DPDF_SPEC).is_some();
    let want_vad = need_vad && discover_model_path(&VAD_SPEC).is_some();
    let want_sv = need_sv && discover_model_path(&SV_SPEC).is_some();
    let want_tse = need_tse
        && discover_model_path(&VOXLOCK_ENROLL_SPEC).is_some()
        && discover_model_path(&VOXLOCK_CHUNK_SPEC).is_some();
    if !want_dpdf && !want_vad && !want_sv && !want_tse {
        return None;
    }

    let mut guard = live_model_cache().lock().ok()?;
    if let Some(ref c) = *guard {
        let satisfied = (!want_dpdf || c.dpdf_ready)
            && (!want_vad || c.vad_ready)
            && (!want_sv || c.sv_ready)
            && (!want_tse || c.tse_ready);
        if satisfied {
            return Some(c.models.clone());
        }
    }

    let prev_dpdf = guard.as_ref().is_some_and(|c| c.dpdf_ready);
    let prev_vad = guard.as_ref().is_some_and(|c| c.vad_ready);
    let prev_sv = guard.as_ref().is_some_and(|c| c.sv_ready);
    let prev_tse = guard.as_ref().is_some_and(|c| c.tse_ready);
    let loaded = Arc::new(
        models::open_models(
            want_dpdf || prev_dpdf,
            want_vad || prev_vad,
            want_sv || prev_sv,
            want_tse || prev_tse,
        )
        .ok()?,
    );
    *guard = Some(CachedLiveModels {
        models: loaded.clone(),
        dpdf_ready: loaded.dpdf.is_some(),
        vad_ready: loaded.vad.is_some(),
        sv_ready: loaded.speaker.is_some(),
        tse_ready: loaded.tse_enroll.is_some() && loaded.tse_chunk.is_some(),
    });
    Some(loaded)
}

#[inline]
fn rms_level(samples: &[f32]) -> f32 {
    let lvl = dsp::rms(samples) * 4.0;
    if lvl.is_finite() {
        lvl.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

struct SvJob {
    slice: Vec<f32>,
    is_end: bool,
}

struct SvResult {
    emb: Vec<f32>,
    used_samples: usize,
    is_end: bool,
}

struct SvTracker {
    enrolled: Option<Vec<f32>>,
    prototypes: Vec<Vec<f32>>,
    first_lock_mode: bool,
    threshold: f32,
    session_emb: Option<Vec<f32>>,
    sv_confirmed_non_owner: bool,
    sv_confirmed_owner: bool,
    last_score: Option<f32>,
    non_owner_streak: usize,
}

impl SvTracker {
    const STRONG_NON_OWNER_MARGIN: f32 = 0.06;

    fn new(
        enrolled: Option<&VoiceprintRecord>,
        first_lock_mode: bool,
        threshold: f32,
    ) -> Self {
        let centroid = enrolled.map(|v| dsp::normalize_embedding(&v.embedding));
        let prototypes = enrolled
            .map(|v| {
                v.prototypes
                    .iter()
                    .map(|p| dsp::normalize_embedding(p))
                    .collect()
            })
            .unwrap_or_default();
        Self {
            enrolled: centroid,
            prototypes,
            first_lock_mode,
            threshold: clamp_threshold(threshold),
            session_emb: None,
            sv_confirmed_non_owner: false,
            sv_confirmed_owner: false,
            last_score: None,
            non_owner_streak: 0,
        }
    }

    fn reset_utterance(&mut self) {
        self.sv_confirmed_non_owner = false;
        self.sv_confirmed_owner = false;
        self.last_score = None;
        self.non_owner_streak = 0;
    }

    fn has_identity_reference(&self) -> bool {
        self.enrolled.is_some() || self.session_emb.is_some()
    }

    fn has_strong_non_owner_margin(&self) -> bool {
        self.sv_confirmed_non_owner
            && (self
                .last_score
                .is_some_and(|s| s < self.threshold - Self::STRONG_NON_OWNER_MARGIN)
                || self.non_owner_streak >= 2)
    }

    fn apply_result(
        &mut self,
        raw_emb: &[f32],
        used_samples: usize,
        is_end: bool,
        speaking: bool,
        tse_active: bool,
        smoothed_tse_atten_db: f64,
    ) {
        let norm = dsp::normalize_embedding(raw_emb);
        if norm.is_empty() {
            return;
        }
        let req = if is_end {
            self.threshold - 0.03
        } else {
            self.threshold - 0.01
        };

        if let Some(ref enrolled) = self.enrolled {
            let sv = dsp::score_voiceprint(&norm, enrolled, &self.prototypes);
            let effective_score = if let Some(ref sess) = self.session_emb {
                let sess_cos = dsp::cosine(&norm, sess);
                if sv.blended >= self.threshold - 0.12 {
                    sv.blended.max(0.65 * sv.blended + 0.35 * sess_cos)
                } else {
                    sv.blended
                }
            } else {
                sv.blended
            };
            self.last_score = Some(effective_score);
            if effective_score >= req {
                self.sv_confirmed_non_owner = false;
                self.sv_confirmed_owner = true;
                self.non_owner_streak = 0;
                if used_samples >= VOICE_RATE * 3 / 5
                    && sv.blended >= (self.threshold + 0.08).max(0.46)
                    && !(tse_active && smoothed_tse_atten_db < -6.0)
                {
                    self.update_session_ema(&norm);
                }
            } else if speaking {
                self.sv_confirmed_non_owner = true;
                self.sv_confirmed_owner = false;
                self.non_owner_streak = self.non_owner_streak.saturating_add(1);
            }
            return;
        }

        if self.first_lock_mode {
            if let Some(ref sess) = self.session_emb {
                let sc = dsp::cosine(&norm, sess);
                self.last_score = Some(sc);
                if sc >= req {
                    self.sv_confirmed_non_owner = false;
                    self.sv_confirmed_owner = true;
                    self.non_owner_streak = 0;
                    if used_samples >= VOICE_RATE * 3 / 5
                        && sc >= (self.threshold + 0.08).max(0.46)
                        && !(tse_active && smoothed_tse_atten_db < -6.0)
                    {
                        self.update_session_ema(&norm);
                    }
                } else if speaking {
                    self.sv_confirmed_non_owner = true;
                    self.sv_confirmed_owner = false;
                    self.non_owner_streak = self.non_owner_streak.saturating_add(1);
                }
            } else {
                self.sv_confirmed_non_owner = false;
                self.sv_confirmed_owner = true;
                self.last_score = Some(1.0);
                self.non_owner_streak = 0;
                if used_samples >= VOICE_RATE * 3 / 5 || is_end {
                    self.session_emb = Some(norm);
                }
            }
        }
    }

    fn update_session_ema(&mut self, emb: &[f32]) {
        if let Some(ref cur) = self.session_emb {
            if cur.len() == emb.len() {
                let blended: Vec<f32> = cur
                    .iter()
                    .zip(emb.iter())
                    .map(|(&c, &e)| 0.80 * c + 0.20 * e)
                    .collect();
                self.session_emb = Some(dsp::normalize_embedding(&blended));
                return;
            }
        }
        self.session_emb = Some(emb.to_vec());
    }
}

struct TseRingBuffers {
    in_ring: Vec<f32>,
    in_read: usize,
    out_tse: Vec<f32>,
    out_raw: Vec<f32>,
    out_read: usize,
    bypassed: bool,
    stopped: bool,
    slow_steps: usize,
    need_samples: usize,
    busy: bool,
}

struct TseRing {
    shared: Arc<Mutex<TseRingBuffers>>,
    wake: Arc<std::sync::Condvar>,
    done_wake: Arc<std::sync::Condvar>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl TseRing {
    const PREBUFFER_SAMPLES: usize = 896;

    fn start_with_mode(mut ext: models::TargetExtractor, sync_offline: bool) -> Self {
        let init_need = ext.required_input_samples();
        let shared = Arc::new(Mutex::new(TseRingBuffers {
            in_ring: Vec::with_capacity(4096),
            in_read: 0,
            out_tse: vec![0.0; Self::PREBUFFER_SAMPLES],
            out_raw: vec![0.0; Self::PREBUFFER_SAMPLES],
            out_read: 0,
            bypassed: false,
            stopped: false,
            slow_steps: 0,
            need_samples: init_need,
            busy: false,
        }));
        let wake = Arc::new(std::sync::Condvar::new());
        let done_wake = Arc::new(std::sync::Condvar::new());
        let sh = shared.clone();
        let wk = wake.clone();
        let dwk = done_wake.clone();

        let worker = std::thread::Builder::new()
            .name("pocket-live-tse".into())
            .spawn(move || loop {
                let input_slice = {
                    let mut guard = match sh.lock() {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                    loop {
                        if guard.stopped || guard.bypassed {
                            guard.busy = false;
                            dwk.notify_all();
                            return;
                        }
                        let need = ext.required_input_samples();
                        guard.need_samples = need;
                        if guard.in_ring.len() - guard.in_read >= need {
                            let start = guard.in_read;
                            let slice = guard.in_ring[start..start + need].to_vec();
                            guard.in_read += need;
                            if guard.in_read >= 4096 && guard.in_read * 2 >= guard.in_ring.len() {
                                let drain_n = guard.in_read;
                                guard.in_ring.drain(..drain_n);
                                guard.in_read = 0;
                            }
                            guard.busy = true;
                            break slice;
                        }
                        guard.busy = false;
                        dwk.notify_all();
                        guard = match wk.wait(guard) {
                            Ok(g) => g,
                            Err(_) => return,
                        };
                    }
                };

                let cur_k = ext.k_frames;
                let step_res = ext.step_aligned(&input_slice);

                let mut guard = match sh.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                guard.busy = false;
                if guard.stopped {
                    dwk.notify_all();
                    return;
                }
                match step_res {
                    Ok((tse_audio, raw_audio, ms)) => {
                        if !sync_offline {
                            let budget_ms = if cur_k <= 5 { 38.0 } else { 60.0 };
                            if ms > budget_ms {
                                guard.slow_steps += 1;
                                if guard.slow_steps >= 3 {
                                    guard.slow_steps = 0;
                                    if cur_k <= 5 {
                                        ext.set_k_frames(8);
                                    } else {
                                        guard.bypassed = true;
                                        dwk.notify_all();
                                        return;
                                    }
                                }
                            } else {
                                guard.slow_steps = 0;
                            }
                        }
                        guard.need_samples = ext.required_input_samples();
                        guard.out_tse.extend_from_slice(&tse_audio);
                        guard.out_raw.extend_from_slice(&raw_audio);
                        dwk.notify_all();
                    }
                    Err(_) => {
                        guard.bypassed = true;
                        dwk.notify_all();
                        return;
                    }
                }
            })
            .ok();

        Self {
            shared,
            wake,
            done_wake,
            worker,
        }
    }

    fn push_and_pop_320(
        &self,
        hpf_320: &[f32; 320],
        out_tse: &mut [f32; 320],
        out_raw: &mut [f32; 320],
        blocking: bool,
    ) -> bool {
        let mut guard = match self.shared.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        if guard.bypassed {
            return false;
        }
        guard.in_ring.extend_from_slice(hpf_320);
        self.wake.notify_one();

        if blocking {
            while !guard.bypassed
                && !guard.stopped
                && (guard.out_tse.len() - guard.out_read) < 320
                && (guard.busy || (guard.in_ring.len() - guard.in_read) >= guard.need_samples)
            {
                guard = match self.done_wake.wait(guard) {
                    Ok(g) => g,
                    Err(_) => return false,
                };
            }
            if guard.bypassed {
                return false;
            }
        }

        let avail = guard.out_tse.len() - guard.out_read;
        if avail < 320 {
            return false;
        }
        let start = guard.out_read;
        out_tse.copy_from_slice(&guard.out_tse[start..start + 320]);
        out_raw.copy_from_slice(&guard.out_raw[start..start + 320]);
        guard.out_read += 320;
        if guard.out_read >= 4096 && guard.out_read * 2 >= guard.out_tse.len() {
            let r = guard.out_read;
            guard.out_tse.drain(..r);
            guard.out_raw.drain(..r);
            guard.out_read = 0;
        }
        true
    }
}

impl Drop for TseRing {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.shared.lock() {
            guard.stopped = true;
            self.wake.notify_all();
            self.done_wake.notify_all();
        }
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
    }
}

#[allow(dead_code)]
pub struct LiveCallProcessor {
    cfg: VoiceAiConfig,
    hpf80: dsp::HighPass80,
    denoiser: Option<models::Denoiser>,
    noise_gate: dsp::SpectralNoiseGate,
    enhancer: dsp::VocalEnhancer,
    hpf64: dsp::HighPass64,
    vad: Option<models::Vad>,
    vad_boost: dsp::QuietVadBoost,
    vad_accum: Vec<f32>,
    clean_speech_buf: Vec<f32>,
    has_sv: bool,
    sv_tracker: SvTracker,
    sv_tx: Option<std::sync::mpsc::Sender<SvJob>>,
    sv_rx: Option<std::sync::mpsc::Receiver<SvResult>>,
    sv_worker: Option<std::thread::JoinHandle<()>>,
    sv_in_flight: bool,
    speaking: bool,
    start_run: usize,
    sil_run: usize,
    utt_voiced_w: usize,
    since_check_w: usize,
    early_tried: bool,
    full_tried: bool,
    last_vad_prob: f32,
    tse: Option<TseRing>,
    smoothed_tse_atten_db: f64,
    suppressing_residual: bool,
    gate_phase: usize,
    gate_release_hold: usize,
    onset_gain: f32,
    sync_offline: bool,
}

#[allow(dead_code)]
impl LiveCallProcessor {
    const START_PROB: f32 = 0.45;
    const SPEECH_PROB: f32 = 0.35;
    const START_WINDOWS: usize = 3;
    const END_WINDOWS: usize = 12;
    const EARLY_VOICED_W: usize = 8;
    const FULL_VOICED_W: usize = 22;
    const RECHECK_STEP_W: usize = 16;
    const MIN_END_VOICED_W: usize = 8;
    const MAX_CLEAN_SPEECH_SAMPLES: usize = VOICE_RATE * 3 / 2;
    const RAMP_SAMPLES: usize = 256;
    const TSE_GATE_CLOSE_DB: f64 = -2.5;
    const TSE_GATE_OPEN_DB: f64 = -1.2;
    const GATE_RELEASE_HOLD_FRAMES: usize = 2;
    const ONSET_SV_UNCERTAIN_GAIN: f32 = 0.45;
    const ONSET_TSE_UNCERTAIN_GAIN: f32 = 0.78;
    const ONSET_TSE_ATTEN_GAIN: f32 = 0.25;
    const ONSET_ATTACK_SAMPLES: f32 = 96.0;
    const ONSET_RELEASE_SAMPLES: f32 = 256.0;

    pub fn new() -> Self {
        Self::with_config(load_config())
    }

    pub fn new_offline_preview() -> Self {
        Self::with_config_and_mode(load_config(), true, true)
    }

    pub fn with_config(cfg: VoiceAiConfig) -> Self {
        Self::with_config_and_mode(cfg, true, false)
    }

    fn with_config_and_ort(cfg: VoiceAiConfig, use_ort: bool) -> Self {
        Self::with_config_and_mode(cfg, use_ort, false)
    }

    fn with_config_and_mode(mut cfg: VoiceAiConfig, use_ort: bool, sync_offline: bool) -> Self {
        cfg.tier = sanitize_tier(&cfg.tier);
        cfg.threshold = clamp_threshold(cfg.threshold);

        let raw_enrolled = cfg
            .voiceprint
            .as_ref()
            .filter(|v| {
                cfg.filter && !v.embedding.is_empty() && v.model_version == VOICEPRINT_MODEL_VERSION
            })
            .cloned();

        let tse_files_ready = use_ort
            && discover_model_path(&VOXLOCK_ENROLL_SPEC).is_some()
            && discover_model_path(&VOXLOCK_CHUNK_SPEC).is_some()
            && has_owner_sample();
        let effective_tier = if cfg.tier == "denoise" {
            "denoise"
        } else if cfg.tier == "tse" {
            "tse"
        } else if cfg.tier == "sv" {
            "sv"
        } else if raw_enrolled.is_some()
            && tse_files_ready
            && cfg
                .recommended_tier
                .as_deref()
                .is_none_or(|r| r == "tse")
        {
            "tse"
        } else {
            "sv"
        };

        let enrolled = if effective_tier != "denoise" {
            raw_enrolled
        } else {
            None
        };
        let first_lock_mode =
            effective_tier != "denoise" && enrolled.is_none() && cfg.first_speaker;
        let want_identity = enrolled.is_some() || first_lock_mode;
        let want_tse = effective_tier == "tse" && enrolled.is_some() && tse_files_ready;

        let want_vad = want_identity || want_tse || (cfg.denoise && cfg.enhance_vocal);
        let loaded = if use_ort && (cfg.denoise || want_identity || want_tse) {
            cached_live_models(cfg.denoise, want_vad, want_identity, want_tse)
        } else {
            None
        };

        let denoiser = if cfg.denoise {
            loaded.as_ref().and_then(|m| {
                m.dpdf
                    .as_ref()
                    .zip(m.dpdf_cfg.as_ref())
                    .map(|(sess, dcfg)| models::Denoiser::new(&m.rt, sess, dcfg))
            })
        } else {
            None
        };

        let vad = if want_vad {
            loaded
                .as_ref()
                .and_then(|m| m.vad.as_ref().map(|sess| models::Vad::new(&m.rt, sess)))
        } else {
            None
        };

        let tse = if want_tse {
            loaded.as_ref().and_then(|m| {
                let te = m.tse_enroll.as_ref()?;
                let tc = m.tse_chunk.as_ref()?;
                let sample = load_owner_sample()?;
                let (enr, _) = models::VoxLockEnrollment::compute(&m.rt, te, &sample).ok()?;
                let ext = models::TargetExtractor::new(&m.rt, tc, &Arc::new(enr)).ok()?;
                Some(TseRing::start_with_mode(ext, sync_offline))
            })
        } else {
            None
        };

        let mut has_sv = false;
        let mut sv_tx = None;
        let mut sv_rx = None;
        let mut sv_worker = None;
        if want_identity {
            if let Some(ref m) = loaded {
                if let Some(sp_sess) = m.speaker.as_ref() {
                    let speaker = models::Speaker::new(&m.rt, sp_sess);
                    let (job_tx, job_rx) = std::sync::mpsc::channel::<SvJob>();
                    let (res_tx, res_rx) = std::sync::mpsc::channel::<SvResult>();
                    if let Ok(handle) = std::thread::Builder::new()
                        .name("pocket-live-sv".into())
                        .spawn(move || {
                            while let Ok(job) = job_rx.recv() {
                                let used_samples = job.slice.len();
                                if let Ok(emb) = speaker.embed(&job.slice) {
                                    let _ = res_tx.send(SvResult {
                                        emb,
                                        used_samples,
                                        is_end: job.is_end,
                                    });
                                } else {
                                    let _ = res_tx.send(SvResult {
                                        emb: Vec::new(),
                                        used_samples,
                                        is_end: job.is_end,
                                    });
                                }
                            }
                        })
                    {
                        has_sv = true;
                        sv_tx = Some(job_tx);
                        sv_rx = Some(res_rx);
                        sv_worker = Some(handle);
                    }
                }
            }
        }

        let sv_tracker = SvTracker::new(enrolled.as_ref(), first_lock_mode, cfg.threshold);

        Self {
            cfg,
            hpf80: dsp::HighPass80::default(),
            denoiser,
            noise_gate: dsp::SpectralNoiseGate::default(),
            enhancer: dsp::VocalEnhancer::default(),
            hpf64: dsp::HighPass64::default(),
            vad,
            vad_boost: dsp::QuietVadBoost::default(),
            vad_accum: Vec::with_capacity(models::Vad::WINDOW + 320),
            clean_speech_buf: Vec::with_capacity(Self::MAX_CLEAN_SPEECH_SAMPLES + models::Vad::WINDOW),
            has_sv,
            sv_tracker,
            sv_tx,
            sv_rx,
            sv_worker,
            sv_in_flight: false,
            speaking: false,
            start_run: 0,
            sil_run: 0,
            utt_voiced_w: 0,
            since_check_w: 0,
            early_tried: false,
            full_tried: false,
            last_vad_prob: 0.0,
            tse,
            smoothed_tse_atten_db: 0.0,
            suppressing_residual: false,
            gate_phase: Self::RAMP_SAMPLES,
            gate_release_hold: 0,
            onset_gain: 1.0,
            sync_offline,
        }
    }

    pub fn used_dpdf(&self) -> bool {
        self.denoiser.is_some()
    }

    pub fn used_tse(&self) -> bool {
        self.tse.is_some()
    }

    pub fn sv_active(&self) -> bool {
        self.has_sv
    }

    pub fn is_suppressing(&self) -> bool {
        self.suppressing_residual
    }

    fn allow_vocal_boost(&self) -> bool {
        if !self.has_sv {
            return true;
        }
        if self.suppressing_residual || self.sv_tracker.sv_confirmed_non_owner {
            return false;
        }
        // Only boost speech confirmed as the owner (or while acquiring the very first
        // speaker in first-speaker lock mode before any identity reference exists).
        self.sv_tracker.sv_confirmed_owner || !self.sv_tracker.has_identity_reference()
    }

    fn target_onset_gain(&self, used_tse: bool) -> f32 {
        if !self.has_sv || !self.sv_tracker.has_identity_reference() {
            return 1.0;
        }
        if self.suppressing_residual {
            // Residual gate owns the smooth raised-cosine fade to 0.0; hold onset_gain
            // steady so sample 0 of suppression stays continuous with the previous frame.
            return self.onset_gain;
        }
        if self.sv_tracker.sv_confirmed_owner {
            return 1.0;
        }
        // Unverified onset / pre-roll before SV confirms owner: apply gentle attenuation
        // (stronger if VoxLock TSE already reports non-target attenuation) and snap back
        // with fast attack as soon as owner is confirmed.
        if used_tse {
            if self.smoothed_tse_atten_db < Self::TSE_GATE_CLOSE_DB {
                Self::ONSET_TSE_ATTEN_GAIN
            } else {
                Self::ONSET_TSE_UNCERTAIN_GAIN
            }
        } else {
            Self::ONSET_SV_UNCERTAIN_GAIN
        }
    }

    pub fn engine_label(&self) -> String {
        if !self.cfg.denoise && !self.cfg.enhance_vocal && !self.has_sv && self.tse.is_none() {
            return "直通（增强已全部关闭）".into();
        }
        let mut parts: Vec<&str> = Vec::new();
        if self.denoiser.is_some() {
            parts.push("DPDFNet 神经降噪");
        } else if self.cfg.denoise {
            parts.push("纯 Rust 基础降噪");
        }
        if self.tse.is_some() {
            parts.push("VoxLock 声纹分离");
        } else if self.has_sv {
            parts.push("ERes2NetV2 声纹门控");
        }
        if self.cfg.enhance_vocal {
            parts.push("人声增强");
        }
        if parts.is_empty() {
            "纯 Rust 基础降噪".into()
        } else {
            parts.join(" + ")
        }
    }

    pub fn process_frame_320(&mut self, pcm320: &[i16]) -> ([i16; 320], f32) {
        let mut in_f32 = [0.0f32; 320];
        let n = pcm320.len().min(320);
        for i in 0..n {
            in_f32[i] = f32::from(pcm320[i]) / 32768.0;
        }

        if !self.cfg.denoise && !self.cfg.enhance_vocal && !self.has_sv && self.tse.is_none() {
            let mut out_pcm = [0i16; 320];
            out_pcm[..n].copy_from_slice(&pcm320[..n]);
            return (out_pcm, rms_level(&in_f32));
        }

        self.poll_sv_results();

        // Keep clean HPF64 as fallback SV/VAD path when both neural denoise and TSE are off/unready.
        let mut clean_hpf = [0.0f32; 320];
        self.hpf64.process_slice(&in_f32, &mut clean_hpf);

        let mut audio_buf = in_f32;
        self.hpf80.process_in_place(&mut audio_buf);

        // Stage 1: Run DPDFNet denoise (or pure-Rust noise gate fallback) FIRST so background
        // noise is stripped before VoxLock TSE and speaker verification.
        let mut used_dpdf = false;
        if self.cfg.denoise {
            let mut denoised = [0.0f32; 320];
            if let Some(ref mut d) = self.denoiser {
                if d.hop(&audio_buf[..160], &mut denoised[..160]).is_ok()
                    && d.hop(&audio_buf[160..320], &mut denoised[160..320]).is_ok()
                {
                    used_dpdf = true;
                }
            }
            if !used_dpdf {
                self.noise_gate
                    .process_hop(&audio_buf[..160], &mut denoised[..160]);
                self.noise_gate
                    .process_hop(&audio_buf[160..320], &mut denoised[160..320]);
            }
            audio_buf = denoised;
        }

        // Stage 2: Run VoxLock TSE target extraction BEFORE VAD + ERes2NetV2 SV so overlapping
        // speech is separated into the target stream before speaker verification scores it.
        let mut raw_aligned = audio_buf;
        let tse_in = audio_buf;
        let used_tse = if let Some(ref tse) = self.tse {
            tse.push_and_pop_320(&tse_in, &mut audio_buf, &mut raw_aligned, self.sync_offline)
        } else {
            false
        };

        // Stage 3: Feed the TSE-separated stream (or DPDFNet-denoised stream when TSE is off,
        // falling back to clean HPF64 when neither ran) into Silero VAD + ERes2NetV2 SV.
        if self.vad.is_some() || self.has_sv || self.tse.is_some() {
            let sv_input = if used_tse || used_dpdf {
                audio_buf
            } else {
                clean_hpf
            };
            self.feed_clean_vad(&sv_input);
        }

        if used_tse {
            let raw_rms = dsp::rms(&raw_aligned);
            let tse_rms = dsp::rms(&audio_buf);
            if raw_rms > 0.012
                && (self.last_vad_prob >= Self::SPEECH_PROB
                    || (raw_rms > 0.025 && tse_rms < raw_rms * 0.5))
            {
                let hop_atten = 20.0
                    * (f64::from(tse_rms.max(1e-5)) / f64::from(raw_rms.max(1e-5))).log10();
                self.smoothed_tse_atten_db =
                    0.78 * self.smoothed_tse_atten_db + 0.22 * hop_atten;
            }
        } else {
            self.smoothed_tse_atten_db = 0.0;
        }

        // Stage 4: Update residual suppression gate BEFORE vocal enhancement so unverified or
        // confirmed non-owner frames are never boosted by the 1.5-3.8 kHz presence enhancer.
        self.update_residual_gate(used_tse);

        if self.cfg.enhance_vocal {
            let speech_active = if self.vad.is_some() {
                self.last_vad_prob >= Self::SPEECH_PROB
            } else if self.cfg.denoise {
                self.noise_gate.last_speech_active()
            } else {
                true
            };
            let allow_boost = speech_active && self.allow_vocal_boost();
            self.enhancer.process_in_place_gated(&mut audio_buf, allow_boost);
        } else if self.cfg.denoise {
            for s in &mut audio_buf {
                *s = dsp::soft_limit(*s);
            }
        }

        self.apply_residual_gate(&mut audio_buf, used_tse);

        let mut out_pcm = [0i16; 320];
        for (dst, &s) in out_pcm.iter_mut().zip(audio_buf.iter()) {
            let clamped = if s.is_finite() { s } else { 0.0 };
            *dst = (clamped * 32768.0).round().clamp(-32768.0, 32767.0) as i16;
        }
        (out_pcm, rms_level(&audio_buf))
    }

    fn feed_clean_vad(&mut self, sv_frame: &[f32; 320]) {
        self.vad_accum.extend_from_slice(sv_frame);
        while self.vad_accum.len() >= models::Vad::WINDOW {
            let win: Vec<f32> = self.vad_accum.drain(..models::Vad::WINDOW).collect();
            let mut boosted = [0.0f32; models::Vad::WINDOW];
            self.vad_boost.prepare(&win, &mut boosted);
            let p = if let Some(ref mut vad) = self.vad {
                vad.prob(&boosted).unwrap_or(0.0)
            } else if dsp::rms(&win) > 0.012 {
                0.8
            } else {
                0.1
            };
            self.last_vad_prob = p;
            let is_voiced = p >= Self::SPEECH_PROB;
            if is_voiced {
                self.clean_speech_buf.extend_from_slice(&win);
                if self.clean_speech_buf.len() > Self::MAX_CLEAN_SPEECH_SAMPLES {
                    let drop_n = self.clean_speech_buf.len() - Self::MAX_CLEAN_SPEECH_SAMPLES;
                    self.clean_speech_buf.drain(..drop_n);
                }
            }

            let mut just_ended = false;
            if !self.speaking {
                self.start_run = if p >= Self::START_PROB {
                    self.start_run + 1
                } else {
                    0
                };
                if self.start_run >= Self::START_WINDOWS {
                    self.speaking = true;
                    self.sil_run = 0;
                    self.utt_voiced_w = usize::from(is_voiced);
                    self.since_check_w = 0;
                    self.early_tried = false;
                    self.full_tried = false;
                    self.gate_release_hold = 0;
                    self.sv_tracker.reset_utterance();
                }
            } else if is_voiced {
                self.sil_run = 0;
                self.utt_voiced_w += 1;
                self.since_check_w += 1;
            } else {
                self.sil_run += 1;
                if self.sil_run >= Self::END_WINDOWS {
                    self.speaking = false;
                    self.start_run = 0;
                    just_ended = true;
                }
            }

            if !self.has_sv {
                if just_ended {
                    self.clean_speech_buf.clear();
                }
                continue;
            }

            if self.speaking && !self.sv_in_flight {
                if !self.early_tried && self.utt_voiced_w >= Self::EARLY_VOICED_W {
                    self.early_tried = true;
                    self.launch_sv_check(VOICE_RATE * 3 / 5, false);
                } else if !self.full_tried && self.utt_voiced_w >= Self::FULL_VOICED_W {
                    self.full_tried = true;
                    self.launch_sv_check(VOICE_RATE, false);
                } else if self.full_tried && self.since_check_w >= Self::RECHECK_STEP_W {
                    self.launch_sv_check(VOICE_RATE, false);
                }
            } else if just_ended {
                if !self.sv_in_flight && !self.full_tried && self.utt_voiced_w >= Self::MIN_END_VOICED_W
                {
                    self.launch_sv_check(VOICE_RATE, true);
                }
                self.suppressing_residual = false;
                self.gate_release_hold = 0;
                self.smoothed_tse_atten_db = 0.0;
                self.sv_tracker.reset_utterance();
                self.clean_speech_buf.clear();
            }
        }
    }

    fn launch_sv_check(&mut self, max_samples: usize, is_end: bool) {
        let Some(ref tx) = self.sv_tx else {
            return;
        };
        let take_len = self.clean_speech_buf.len().min(max_samples);
        if take_len < VOICE_RATE / 5 {
            return;
        }
        let start = self.clean_speech_buf.len() - take_len;
        let slice = self.clean_speech_buf[start..].to_vec();
        if tx.send(SvJob { slice, is_end }).is_ok() {
            self.sv_in_flight = true;
            self.since_check_w = 0;
            if self.sync_offline {
                if let Some(ref rx) = self.sv_rx {
                    if let Ok(res) = rx.recv() {
                        self.sv_in_flight = false;
                        if !res.emb.is_empty() {
                            self.sv_tracker.apply_result(
                                &res.emb,
                                res.used_samples,
                                res.is_end,
                                self.speaking,
                                self.tse.is_some(),
                                self.smoothed_tse_atten_db,
                            );
                        }
                    }
                }
            }
        }
    }

    fn poll_sv_results(&mut self) {
        let Some(ref rx) = self.sv_rx else {
            return;
        };
        while let Ok(res) = rx.try_recv() {
            self.sv_in_flight = false;
            if res.emb.is_empty() {
                continue;
            }
            self.sv_tracker.apply_result(
                &res.emb,
                res.used_samples,
                res.is_end,
                self.speaking,
                self.tse.is_some(),
                self.smoothed_tse_atten_db,
            );
        }
    }

    fn update_residual_gate(&mut self, used_tse: bool) {
        if !self.has_sv {
            self.suppressing_residual = false;
            self.gate_release_hold = 0;
            return;
        }
        if !self.speaking || !self.sv_tracker.sv_confirmed_non_owner {
            self.suppressing_residual = false;
            self.gate_release_hold = 0;
            return;
        }
        if used_tse {
            // Decouple the old `-9.0 dB` AND deadlock:
            // SV now scores the TSE-separated target stream, so confirmed non-owner closes
            // the residual gate on moderate TSE attenuation (`< -2.5 dB`) OR a clear low-cosine
            // / consecutive non-owner SV verdict, while keeping hysteresis + release hold to
            // avoid chatter and a dual-talk safety margin for single borderline scores when
            // TSE is not attenuating.
            let strong_sv_reject = self.sv_tracker.has_strong_non_owner_margin();
            if self.suppressing_residual {
                let want_open = !strong_sv_reject
                    && self.smoothed_tse_atten_db >= Self::TSE_GATE_OPEN_DB;
                if want_open {
                    self.gate_release_hold += 1;
                    if self.gate_release_hold >= Self::GATE_RELEASE_HOLD_FRAMES {
                        self.suppressing_residual = false;
                        self.gate_release_hold = 0;
                    }
                } else {
                    self.gate_release_hold = 0;
                }
            } else if strong_sv_reject || self.smoothed_tse_atten_db < Self::TSE_GATE_CLOSE_DB {
                self.suppressing_residual = true;
                self.gate_release_hold = 0;
            }
        } else {
            self.suppressing_residual = true;
            self.gate_release_hold = 0;
        }
    }

    fn apply_residual_gate(&mut self, audio_buf: &mut [f32; 320], used_tse: bool) {
        let target_onset = self.target_onset_gain(used_tse);
        let onset_active =
            (self.onset_gain - 1.0).abs() > 1e-4 || (target_onset - 1.0).abs() > 1e-4;
        if !self.suppressing_residual && self.gate_phase >= Self::RAMP_SAMPLES && !onset_active {
            self.onset_gain = 1.0;
            return;
        }
        let attack_step = 1.0 / Self::ONSET_ATTACK_SAMPLES;
        let release_step = 1.0 / Self::ONSET_RELEASE_SAMPLES;
        for sample in audio_buf.iter_mut() {
            if self.suppressing_residual {
                if self.gate_phase > 0 {
                    self.gate_phase -= 1;
                }
            } else if self.gate_phase < Self::RAMP_SAMPLES {
                self.gate_phase += 1;
            }
            let residual_gain = if self.gate_phase >= Self::RAMP_SAMPLES {
                1.0
            } else if self.gate_phase == 0 {
                0.0
            } else {
                0.5 - 0.5
                    * (std::f32::consts::PI * (self.gate_phase as f32)
                        / (Self::RAMP_SAMPLES as f32))
                        .cos()
            };

            if self.onset_gain < target_onset {
                self.onset_gain = (self.onset_gain + attack_step).min(target_onset);
            } else if self.onset_gain > target_onset {
                self.onset_gain = (self.onset_gain - release_step).max(target_onset);
            }

            *sample *= residual_gain * self.onset_gain;
        }
    }
}

impl Default for LiveCallProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for LiveCallProcessor {
    fn drop(&mut self) {
        drop(self.sv_tx.take());
        if let Some(handle) = self.sv_worker.take() {
            let _ = handle.join();
        }
        self.tse.take();
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAiPreviewResult {
    pub pcm_base64: String,
    pub sample_rate: u32,
    pub duration_ms: u32,
    pub process_ms: f64,
    pub in_rms_db: f32,
    pub out_rms_db: f32,
    pub suppressed_ratio: f32,
    pub used_dpdf: bool,
    pub used_tse: bool,
    pub sv_active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAiPreviewLiveInfo {
    pub active: bool,
    pub used_dpdf: bool,
    pub used_tse: bool,
    pub sv_active: bool,
    pub engine_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAiPreviewLiveChunk {
    pub pcm_base64: String,
    pub level: f32,
    pub suppressed: bool,
}

/// Opens a dedicated real-time `LiveCallProcessor` for the Settings "戴耳机实时耳返" preview
/// studio, always honoring the user's current denoise / enhance / voiceprint settings.
pub fn preview_live_open_processor() -> (LiveCallProcessor, VoiceAiPreviewLiveInfo) {
    let proc = LiveCallProcessor::new();
    let info = VoiceAiPreviewLiveInfo {
        active: true,
        used_dpdf: proc.used_dpdf(),
        used_tse: proc.used_tse(),
        sv_active: proc.sv_active(),
        engine_label: proc.engine_label(),
    };
    (proc, info)
}

/// Runs an offline PCM16 mono 16kHz clip through the exact same `LiveCallProcessor`
/// DSP/DPDFNet/VoxLock/Voiceprint chain used during real voice calls so users can
/// hear real A/B before-and-after results immediately when toggling settings.
pub fn preview_process_pcm_bytes(pcm_bytes: &[u8]) -> Result<VoiceAiPreviewResult, String> {
    const MAX_BYTES: usize = VOICE_RATE * 2 * 12; // up to 12 seconds mono 16kHz PCM16
    if pcm_bytes.len() < 640 {
        return Err("音频样本太短，请至少录制 1 秒语音".into());
    }
    if pcm_bytes.len() > MAX_BYTES {
        return Err("试听样本超过 12 秒上限".into());
    }
    let sample_count = pcm_bytes.len() / 2;
    let mut samples = Vec::with_capacity(sample_count);
    for chunk in pcm_bytes.chunks_exact(2) {
        samples.push(i16::from_le_bytes([chunk[0], chunk[1]]));
    }

    let t0 = Instant::now();
    let mut proc = LiveCallProcessor::new_offline_preview();
    let used_dpdf = proc.used_dpdf();
    let used_tse = proc.used_tse();
    let sv_active = proc.sv_active();

    let mut out_bytes = Vec::with_capacity(sample_count * 2);
    let mut in_sq = 0.0f64;
    let mut out_sq = 0.0f64;
    let mut total_frames = 0u32;
    let mut suppressed_frames = 0u32;

    for frame in samples.chunks(320) {
        total_frames += 1;
        let mut padded = [0i16; 320];
        padded[..frame.len()].copy_from_slice(frame);
        for &s in frame {
            let f = f64::from(s) / 32768.0;
            in_sq += f * f;
        }
        let (out_frame, _) = proc.process_frame_320(&padded);
        if proc.suppressing_residual {
            suppressed_frames += 1;
        }
        for &s in &out_frame[..frame.len()] {
            let f = f64::from(s) / 32768.0;
            out_sq += f * f;
            out_bytes.extend_from_slice(&s.to_le_bytes());
        }
    }

    let n = (sample_count as f64).max(1.0);
    let in_rms = (in_sq / n).sqrt().max(1e-6);
    let out_rms = (out_sq / n).sqrt().max(1e-6);
    let in_rms_db = ((20.0 * in_rms.log10()) as f32 * 10.0).round() / 10.0;
    let out_rms_db = ((20.0 * out_rms.log10()) as f32 * 10.0).round() / 10.0;
    let suppressed_ratio = if total_frames > 0 {
        ((suppressed_frames as f32 / total_frames as f32) * 1000.0).round() / 1000.0
    } else {
        0.0
    };
    let process_ms = (t0.elapsed().as_secs_f64() * 1000.0 * 10.0).round() / 10.0;

    Ok(VoiceAiPreviewResult {
        pcm_base64: crate::local_term::base64_encode(&out_bytes),
        sample_rate: VOICE_RATE as u32,
        duration_ms: ((sample_count as u64 * 1000) / (VOICE_RATE as u64)) as u32,
        process_ms,
        in_rms_db,
        out_rms_db,
        suppressed_ratio,
        used_dpdf,
        used_tse,
        sv_active,
    })
}

// ---------------------------------------------------------------------------
// Comprehensive unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::dsp::*;
    use super::ort::parse_onnx_custom_metadata;
    use super::*;
    use std::f64::consts::PI;

    #[test]
    fn high_pass_80_attenuates_dc_and_low_rumble_while_passing_speech() {
        let mut hpf_dc = HighPass80::default();
        let mut dc_and_30hz: Vec<f32> = (0..3200)
            .map(|i| 0.45 + 0.35 * (2.0 * PI * 30.0 * (i as f64) / 16000.0).sin() as f32)
            .collect();
        hpf_dc.process_in_place(&mut dc_and_30hz);
        let tail_rms = rms(&dc_and_30hz[1600..]);
        assert!(tail_rms < 0.04, "expected DC/30Hz attenuation, got {tail_rms}");

        let mut hpf_1k = HighPass80::default();
        let mut speech_1k: Vec<f32> = (0..3200)
            .map(|i| 0.5 * (2.0 * PI * 1000.0 * (i as f64) / 16000.0).sin() as f32)
            .collect();
        let in_rms = rms(&speech_1k);
        hpf_1k.process_in_place(&mut speech_1k);
        let out_rms = rms(&speech_1k[800..]);
        assert!(
            out_rms > in_rms * 0.95,
            "expected 1kHz speech preserved: in={in_rms}, out={out_rms}"
        );
    }

    #[test]
    fn presence_filter_boosts_vocal_harmonics_and_enhancer_clamps_peak() {
        let mut pf = PresencePeakFilter::default();
        let mut tone_2k5: Vec<f32> = (0..1600)
            .map(|i| 0.25 * (2.0 * PI * 2500.0 * (i as f64) / 16000.0).sin() as f32)
            .collect();
        let in_rms = rms(&tone_2k5[400..]);
        pf.process_in_place(&mut tone_2k5);
        let out_rms = rms(&tone_2k5[400..]);
        assert!(
            out_rms > in_rms * 1.15,
            "expected 2.5 kHz presence boost, in={in_rms}, out={out_rms}"
        );

        let mut enh = VocalEnhancer::default();
        let mut hot: Vec<f32> = (0..3200)
            .map(|i| 1.8 * (2.0 * PI * 600.0 * (i as f64) / 16000.0).sin() as f32)
            .collect();
        enh.process_in_place(&mut hot);
        let peak = hot.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
        assert!(peak <= 0.92 + 1e-5, "peak {peak} exceeded 0.92 limiter");
    }

    #[test]
    fn fft_320_and_512_preserve_parseval_energy() {
        let mut fft320 = Fft320::default();
        let mut re = [0.0f64; 320];
        let mut im = [0.0f64; 320];
        let mut energy_in = 0.0f64;
        for (i, r) in re.iter_mut().enumerate() {
            let v = (2.0 * PI * 400.0 * (i as f64) / 16000.0).sin()
                + 0.4 * (2.0 * PI * 1900.0 * (i as f64) / 16000.0).cos();
            *r = v;
            energy_in += v * v;
        }
        fft320.run(&mut re, &mut im);
        let energy_freq: f64 = re.iter().zip(im.iter()).map(|(a, b)| a * a + b * b).sum();
        assert!((energy_freq / 320.0 - energy_in).abs() < 1e-6);

        let fft512 = Fft512::default();
        let mut re5 = [0.0f64; 512];
        let mut im5 = [0.0f64; 512];
        let mut e5_in = 0.0f64;
        for (i, r) in re5.iter_mut().enumerate() {
            let v = (2.0 * PI * 1000.0 * (i as f64) / 16000.0).sin();
            *r = v;
            e5_in += v * v;
        }
        fft512.run(&mut re5, &mut im5);
        let e5_freq: f64 = re5.iter().zip(im5.iter()).map(|(a, b)| a * a + b * b).sum();
        assert!((e5_freq / 512.0 - e5_in).abs() < 1e-6);
    }

    #[test]
    fn kaldi_fbank_produces_80_bins_cmvn_normalized() {
        let fb = Fbank::default();
        let wave: Vec<f32> = (0..16000)
            .map(|i| 0.25 * (2.0 * PI * 500.0 * (i as f64) / 16000.0).sin() as f32)
            .collect();
        let (frames, feats) = fb.compute(&wave);
        assert_eq!(frames, Fbank::frames(wave.len()));
        assert_eq!(feats.len(), frames * Fbank::BINS);
        assert!(feats.iter().all(|v| v.is_finite()));

        for b in 0..Fbank::BINS {
            let mean: f64 = (0..frames)
                .map(|f| f64::from(feats[f * Fbank::BINS + b]))
                .sum::<f64>()
                / (frames as f64);
            assert!(mean.abs() < 1e-4, "bin {b} CMVN mean {mean} != 0");
        }
    }

    #[test]
    fn spectral_noise_gate_improves_snr_and_process_fallback_works() {
        let mut gate = SpectralNoiseGate::default();
        let mut noisy = vec![0.0f32; 8000];
        for (i, s) in noisy.iter_mut().enumerate() {
            let noise = if i % 2 == 0 { 0.02 } else { -0.02 };
            let speech = if i >= 3200 {
                0.25 * (2.0 * PI * 700.0 * (i as f64) / 16000.0).sin() as f32
            } else {
                0.0
            };
            *s = noise + speech;
        }
        let cleaned = gate.process_buffer(&noisy);
        let noise_before = rms(&noisy[320..2400]);
        let noise_after = rms(&cleaned[320..2400]);
        assert!(
            noise_after < noise_before * 0.65,
            "expected noise reduction: before={noise_before}, after={noise_after}"
        );

        let pcm = f32_to_pcm16(&noisy);
        let cfg = VoiceAiConfig::default();
        match process_recording_with_config(&pcm, &cfg) {
            ProcessOutcome::Accept { samples, dsp_badge } => {
                assert_eq!(samples.len(), pcm.len());
                assert!(dsp_badge.is_some());
            }
            ProcessOutcome::RejectNonOwner { .. } => panic!("unexpected rejection without voiceprint"),
        }
    }

    #[test]
    fn voiceprint_cosine_and_prototype_scoring_match_expected_math() {
        let a = normalize_embedding(&[1.0, 2.0, 3.0, 4.0]);
        let b = normalize_embedding(&[1.0, 2.0, 3.0, 4.0]);
        let orth = normalize_embedding(&[-2.0, 1.0, 0.0, 0.0]);
        assert!((cosine(&a, &b) - 1.0).abs() < 1e-5);
        assert!(cosine(&a, &orth).abs() < 1e-5);

        let centroid = normalize_embedding(&[1.0, 0.0, 0.0]);
        let protos = vec![
            normalize_embedding(&[0.9, 0.4, 0.0]),
            normalize_embedding(&[0.8, 0.6, 0.0]),
        ];
        let query = normalize_embedding(&[0.8, 0.6, 0.0]);
        let sc = score_voiceprint(&query, &centroid, &protos);
        assert!((sc.proto - 1.0).abs() < 1e-5);
        assert!((sc.raw - 0.8).abs() < 1e-5);
        assert!((sc.blended - (0.65 * 0.8 + 0.35 * 1.0)).abs() < 1e-5);
    }

    #[test]
    fn mirror_ordering_prioritizes_china_mirrors_and_drops_dead_hosts() {
        let urls = &[
            "https://ghproxy.net/https://github.com/foo/bar.onnx",
            "https://huggingface.co/foo/bar.onnx",
            "https://hf-mirror.com/foo/bar.onnx",
            "https://github.com/foo/bar.onnx",
        ];
        let cn = expand_github_mirrors(urls, true);
        assert!(!cn.iter().any(|u| u.contains("ghproxy.net")));
        assert!(cn[0].contains("hf-mirror.com") || cn[0].contains("ghfast.top"));
        assert!(cn.last().unwrap().contains("github.com") || cn.last().unwrap().contains("huggingface.co"));

        let gl = expand_github_mirrors(urls, false);
        assert!(gl[0].contains("huggingface.co") || gl[0].contains("github.com"));
        assert!(!gl.iter().any(|u| u.contains("ghproxy.net")));
    }

    #[test]
    fn onnx_custom_metadata_parser_reads_field_14_entries() {
        // Construct minimal protobuf ModelProto with field 14 (key="state_size", val="38256")
        let key = b"state_size";
        let val = b"38256";
        let mut entry = Vec::new();
        entry.push((1 << 3) | 2);
        entry.push(key.len() as u8);
        entry.extend_from_slice(key);
        entry.push((2 << 3) | 2);
        entry.push(val.len() as u8);
        entry.extend_from_slice(val);

        let mut model = Vec::new();
        model.push((1 << 3) | 0); // ir_version varint
        model.push(8);
        model.push((14 << 3) | 2);
        model.push(entry.len() as u8);
        model.extend_from_slice(&entry);

        let meta = parse_onnx_custom_metadata(&model);
        assert_eq!(meta.get("state_size").map(String::as_str), Some("38256"));
    }

    #[test]
    fn config_roundtrip_and_prototype_diversity_work() {
        let raw = r#"{"version":1,"denoise":true,"enhanceVocal":false,"tier":"bogus","filter":true,"threshold":9.9,"firstSpeaker":false}"#;
        let parsed: VoiceAiConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(sanitize_tier(&parsed.tier), "auto");
        assert!((clamp_threshold(parsed.threshold) - 0.80).abs() < 1e-6);
        assert!((clamp_threshold(-1.0) - 0.15).abs() < 1e-6);

        let centroid = normalize_embedding(&[1.0, 0.0, 0.0]);
        let kept = vec![
            normalize_embedding(&[0.99, 0.1, 0.0]),
            normalize_embedding(&[0.98, 0.12, 0.0]),
            normalize_embedding(&[0.85, 0.52, 0.0]),
            normalize_embedding(&[0.82, 0.0, 0.57]),
        ];
        let protos = select_prototypes(&kept, &centroid, 3);
        assert_eq!(protos.len(), 3);
        assert!(protos.iter().all(|p| (cosine(p, p) - 1.0).abs() < 1e-5));
    }

    #[test]
    fn real_ort_dpdfnet_and_vad_run_when_runtime_and_models_are_present() {
        let Some(ort_path) = discover_ort_library() else {
            return;
        };
        let Some(dpdf_path) = discover_model_path(&DPDF_SPEC) else {
            return;
        };
        let Some(vad_path) = discover_model_path(&VAD_SPEC) else {
            return;
        };
        let rt = ort::OrtRuntime::load_from(&ort_path).expect("load ORT dynamic library");
        assert!(!rt.version.is_empty());

        let dpdf_sess = ort::Session::create(&rt, &dpdf_path, 1).expect("create DPDFNet session");
        let dpdf_cfg = ort::DpdfConfig::from_model(&dpdf_path);
        let mut denoiser = models::Denoiser::new(&rt, &dpdf_sess, &dpdf_cfg);
        let hop_in: Vec<f32> = (0..160)
            .map(|i| 0.08 * (2.0 * PI * 440.0 * (i as f64) / 16000.0).sin() as f32)
            .collect();
        let mut hop_out = [0.0f32; 160];
        denoiser.hop(&hop_in, &mut hop_out).expect("run DPDFNet hop");
        assert!(hop_out.iter().all(|v| v.is_finite()));

        let vad_sess = ort::Session::create(&rt, &vad_path, 1).expect("create Silero VAD session");
        let mut vad = models::Vad::new(&rt, &vad_sess);
        let silence = [0.0f32; 512];
        let p = vad.prob(&silence).expect("run Silero VAD");
        assert!((0.0..=1.0).contains(&p));
    }

    fn is_valid_sha256_hex(s: &str) -> bool {
        s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    }

    #[test]
    fn model_specs_and_ort_wheels_have_valid_64_char_lowercase_sha256() {
        for spec in ALL_MODEL_SPECS {
            assert!(spec.size > 0, "empty size for {}", spec.file_name);
            assert!(
                is_valid_sha256_hex(spec.sha256),
                "invalid sha256 for {}: {}",
                spec.file_name,
                spec.sha256
            );
            assert!(!spec.urls.is_empty(), "empty urls for {}", spec.file_name);
        }

        for wheel in ALL_ORT_WHEELS {
            assert!(wheel.size > 0, "empty wheel size for {}", wheel.target_name);
            assert!(
                is_valid_sha256_hex(wheel.sha256),
                "invalid wheel sha256 for {}: {}",
                wheel.target_name,
                wheel.sha256
            );
            assert!(!wheel.urls.is_empty(), "empty wheel urls for {}", wheel.target_name);
        }
        if let Some(cur) = ort_wheel_spec() {
            assert!(is_valid_sha256_hex(cur.sha256));
        }

        let sv_hf_mirror = SV_SPEC
            .urls
            .iter()
            .position(|u| u.contains("hf-mirror.com"))
            .expect("SV_SPEC missing hf-mirror");
        let sv_hf_origin = SV_SPEC
            .urls
            .iter()
            .position(|u| u.contains("huggingface.co"))
            .expect("SV_SPEC missing huggingface");
        let sv_ghfast = SV_SPEC
            .urls
            .iter()
            .position(|u| u.contains("ghfast.top"))
            .expect("SV_SPEC missing ghfast.top");
        assert!(sv_hf_mirror < sv_ghfast);
        assert!(sv_hf_origin < sv_ghfast);

        let mixed = &[
            "https://ghfast.top/https://github.com/foo/bar.onnx",
            "https://gh-proxy.com/https://github.com/foo/bar.onnx",
            "https://hf-mirror.com/foo/bar.onnx",
            "https://github.com/foo/bar.onnx",
        ];
        let cn = expand_github_mirrors(mixed, true);
        let cn_hf = cn.iter().position(|u| u.contains("hf-mirror.com")).unwrap();
        let cn_proxy = cn.iter().position(|u| u.contains("ghfast.top")).unwrap();
        assert!(cn_hf < cn_proxy, "expected hf-mirror before ghfast in cn: {cn:?}");

        assert!(is_html_content_type("text/html; charset=utf-8"));
        assert!(is_html_content_type("Application/XHTML+XML"));
        assert!(!is_html_content_type("application/octet-stream"));
        assert!(looks_like_html_prefix(b"  <!DOCTYPE html><html>"));
        assert!(!looks_like_html_prefix(b"\x08\x08\x12\x02pt"));
    }

    #[test]
    fn bundled_dpdf_and_vad_models_match_file_sha256_and_size() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../mobile/modules/pocket-native/ios/Resources/voice");
        for spec in [DPDF_SPEC, VAD_SPEC] {
            let path = dir.join(spec.file_name);
            let meta = fs::metadata(&path).expect("bundled model file missing");
            assert_eq!(meta.len(), spec.size, "size mismatch for {}", spec.file_name);
            let digest = file_sha256(&path).expect("sha256 failed");
            assert_eq!(digest, spec.sha256, "sha256 mismatch for {}", spec.file_name);
        }
    }

    #[test]
    fn live_call_processor_pure_rust_dsp_filters_rumble_enhances_speech_and_clamps_peak() {
        let mut proc = LiveCallProcessor::with_config_and_ort(VoiceAiConfig::default(), false);
        let silence = [0i16; 320];
        for _ in 0..8 {
            let (out, lvl) = proc.process_frame_320(&silence);
            assert_eq!(out.len(), 320);
            assert!(lvl < 0.01, "expected near-zero level on silence, got {lvl}");
        }

        // Low-frequency 30 Hz rumble should be strongly attenuated by HighPass80 + noise gate.
        let mut no_agc_cfg = VoiceAiConfig::default();
        no_agc_cfg.enhance_vocal = false;
        let mut proc_hpf = LiveCallProcessor::with_config_and_ort(no_agc_cfg, false);
        let mut rumble = [0i16; 320];
        let mut last_rumble_lvl = 1.0f32;
        for f in 0..20 {
            for (i, s) in rumble.iter_mut().enumerate() {
                let idx = f * 320 + i;
                let v = 0.35 * (2.0 * PI * 30.0 * (idx as f64) / 16000.0).sin();
                *s = (v * 32767.0) as i16;
            }
            let (_out, lvl) = proc_hpf.process_frame_320(&rumble);
            last_rumble_lvl = lvl;
        }
        assert!(
            last_rumble_lvl < 0.15,
            "expected 30Hz rumble attenuation (HPF80 + noise gate), got level {last_rumble_lvl}"
        );

        let mut last_full_rumble_lvl = 1.0f32;
        for f in 0..20 {
            for (i, s) in rumble.iter_mut().enumerate() {
                let idx = f * 320 + i;
                let v = 0.35 * (2.0 * PI * 30.0 * (idx as f64) / 16000.0).sin();
                *s = (v * 32767.0) as i16;
            }
            let (_out, lvl) = proc.process_frame_320(&rumble);
            last_full_rumble_lvl = lvl;
        }
        assert!(
            last_full_rumble_lvl < 0.50,
            "expected 30Hz rumble attenuated well below raw 0.99 level, got {last_full_rumble_lvl}"
        );

        // Hot speech-band signal should stay preserved and peak-limited <= 0.92.
        let mut proc_hot = LiveCallProcessor::with_config_and_ort(VoiceAiConfig::default(), false);
        let mut hot = [0i16; 320];
        let mut peak_i16 = 0i16;
        let mut speech_lvl = 0.0f32;
        for f in 0..15 {
            for (i, s) in hot.iter_mut().enumerate() {
                let idx = f * 320 + i;
                let v = (2.0 * PI * 900.0 * (idx as f64) / 16000.0).sin();
                *s = (v * 32767.0) as i16;
            }
            let (out, lvl) = proc_hot.process_frame_320(&hot);
            speech_lvl = lvl;
            for &x in &out {
                peak_i16 = peak_i16.max(x.saturating_abs());
            }
        }
        assert!(speech_lvl > 0.2 && speech_lvl <= 1.0, "level={speech_lvl}");
        assert!(
            f32::from(peak_i16) / 32768.0 <= 0.93,
            "expected soft-limited peak <= 0.92, got {}",
            f32::from(peak_i16) / 32768.0
        );
    }

    #[test]
    fn live_call_processor_smoothly_attenuates_non_owner_and_supports_first_speaker_lock() {
        let mut cfg = VoiceAiConfig::default();
        cfg.denoise = false;
        cfg.enhance_vocal = false;
        cfg.filter = true;
        cfg.threshold = 0.40;
        cfg.voiceprint = Some(VoiceprintRecord {
            embedding: vec![1.0, 0.0, 0.0, 0.0],
            prototypes: vec![vec![1.0, 0.0, 0.0, 0.0]],
            model_version: VOICEPRINT_MODEL_VERSION.into(),
            has_sample: false,
            route: None,
            snr_db: None,
            seconds: 5.0,
            consistency: 0.9,
            lowest: 0.85,
            created_at: 0,
        });

        let mut proc = LiveCallProcessor::with_config_and_ort(cfg, false);
        proc.has_sv = true;
        proc.speaking = true;

        let mut tone = [0i16; 320];
        for (i, s) in tone.iter_mut().enumerate() {
            *s = (0.45 * (2.0 * PI * 600.0 * (i as f64) / 16000.0).sin() * 32767.0) as i16;
        }

        // Owner passes -> unattenuated (warm up HPF80 for one frame first, then check steady phase).
        proc.sv_tracker
            .apply_result(&[0.98, 0.1, 0.0, 0.0], 16_000, false, true, false, 0.0);
        let _ = proc.process_frame_320(&tone);
        let (owner_out, owner_lvl) = proc.process_frame_320(&tone);
        assert!(owner_lvl > 0.3, "expected owner level > 0.3, got {owner_lvl}");

        // Non-owner rejected -> smooth ramp down across first frame, then muted on next frame.
        proc.sv_tracker
            .apply_result(&[0.0, 1.0, 0.0, 0.0], 16_000, false, true, false, 0.0);
        let (ramp_out, _) = proc.process_frame_320(&tone);
        // First sample should stay continuous with steady-state HPF80 owner_out[0] (~1.0 gain, no click).
        assert!(
            (ramp_out[0] - owner_out[0]).abs() < 250,
            "expected smooth start of attenuation: got {}, expected ~{}",
            ramp_out[0],
            owner_out[0]
        );
        assert_eq!(ramp_out[300], 0, "expected tail of 320-sample frame fully attenuated");

        let (muted_out, muted_lvl) = proc.process_frame_320(&tone);
        assert!(muted_out.iter().all(|&s| s == 0));
        assert_eq!(muted_lvl, 0.0);

        // Owner returns -> smooth ramp back up.
        proc.sv_tracker
            .apply_result(&[1.0, 0.0, 0.0, 0.0], 16_000, false, true, false, 0.0);
        let _ = proc.process_frame_320(&tone);
        let (_, recovered_lvl) = proc.process_frame_320(&tone);
        assert!(recovered_lvl > 0.3, "expected recovered owner level, got {recovered_lvl}");

        // First-speaker lock mode: locks onto initial speaker, rejects second speaker.
        let mut tracker = SvTracker::new(None, true, 0.40);
        tracker.apply_result(&[0.0, 1.0, 0.0, 0.0], 9_600, false, true, false, 0.0);
        assert!(tracker.session_emb.is_some());
        assert!(!tracker.sv_confirmed_non_owner);

        tracker.apply_result(&[0.0, 0.99, 0.1, 0.0], 16_000, false, true, false, 0.0);
        assert!(!tracker.sv_confirmed_non_owner);

        tracker.apply_result(&[1.0, 0.0, 0.0, 0.0], 16_000, false, true, false, 0.0);
        assert!(tracker.sv_confirmed_non_owner);
    }

    #[test]
    fn live_call_processor_streams_with_real_ort_when_available() {
        let Some(_) = discover_ort_library() else {
            return;
        };
        let Some(_) = discover_model_path(&DPDF_SPEC) else {
            return;
        };
        let mut proc = LiveCallProcessor::with_config(VoiceAiConfig::default());
        let mut frame = [0i16; 320];
        let mut last_lvl = 0.0f32;
        for f in 0..10 {
            for (i, s) in frame.iter_mut().enumerate() {
                let idx = f * 320 + i;
                let v = 0.18 * (2.0 * PI * 440.0 * (idx as f64) / 16000.0).sin();
                *s = (v * 32767.0) as i16;
            }
            let (out, lvl) = proc.process_frame_320(&frame);
            assert_eq!(out.len(), 320);
            last_lvl = lvl;
        }
        assert!(last_lvl > 0.0 && last_lvl <= 1.0, "unexpected ORT level {last_lvl}");
    }

    #[test]
    fn active_hud_badge_matches_configured_engine_and_tier() {
        let mut cfg = VoiceAiConfig::default();
        cfg.denoise = true;
        cfg.enhance_vocal = true;
        assert_eq!(
            active_hud_badge_for_state(&cfg, false, false, false, false, false).as_deref(),
            Some("本地 DSP 降噪")
        );
        assert_eq!(
            active_hud_badge_for_state(&cfg, true, true, false, false, false).as_deref(),
            Some("DPDFNet 降噪")
        );

        cfg.first_speaker = true;
        assert_eq!(
            active_hud_badge_for_state(&cfg, true, true, true, false, false).as_deref(),
            Some("DPDFNet + 声纹")
        );

        cfg.tier = "denoise".into();
        assert_eq!(
            active_hud_badge_for_state(&cfg, true, true, true, false, false).as_deref(),
            Some("DPDFNet 降噪")
        );

        cfg.tier = "auto".into();
        cfg.filter = true;
        cfg.voiceprint = Some(VoiceprintRecord {
            embedding: vec![1.0, 0.0, 0.0, 0.0],
            prototypes: vec![vec![1.0, 0.0, 0.0, 0.0]],
            model_version: VOICEPRINT_MODEL_VERSION.into(),
            has_sample: true,
            route: None,
            snr_db: None,
            seconds: 4.0,
            consistency: 0.9,
            lowest: 0.85,
            created_at: 0,
        });
        assert_eq!(
            active_hud_badge_for_state(&cfg, true, true, true, true, true).as_deref(),
            Some("VoxLock + DPDFNet")
        );

        cfg.denoise = false;
        cfg.enhance_vocal = false;
        cfg.first_speaker = false;
        cfg.filter = false;
        assert_eq!(
            active_hud_badge_for_state(&cfg, true, true, true, true, true),
            None
        );
    }

    #[test]
    fn hud_badge_cache_caches_results_and_invalidates_cleanly() {
        let mut cache = HudBadgeCache::default();
        let mut scans = 0usize;
        let first = {
            if let Some(v) = cache.get_cached(1) {
                v
            } else {
                scans += 1;
                let v = Some("DPDFNet 降噪".to_string());
                cache.store(1, v.clone());
                v
            }
        };
        let second = {
            if let Some(v) = cache.get_cached(1) {
                v
            } else {
                scans += 1;
                let v = Some("SHOULD_NOT_COMPUTE".to_string());
                cache.store(1, v.clone());
                v
            }
        };
        assert_eq!(first.as_deref(), Some("DPDFNet 降噪"));
        assert_eq!(second.as_deref(), Some("DPDFNet 降噪"));
        assert_eq!(scans, 1);

        cache.invalidate();
        assert!(cache.get_cached(1).is_none());
        let third = {
            if let Some(v) = cache.get_cached(2) {
                v
            } else {
                scans += 1;
                let v = Some("VoxLock + DPDFNet".to_string());
                cache.store(2, v.clone());
                v
            }
        };
        assert_eq!(third.as_deref(), Some("VoxLock + DPDFNet"));
        assert_eq!(scans, 2);

        // Also exercise the global active_hud_badge + invalidation path.
        let b1 = active_hud_badge();
        let b2 = active_hud_badge();
        assert_eq!(b1, b2);
        invalidate_hud_badge_cache();
        let b3 = active_hud_badge();
        assert_eq!(b1, b3);
    }

    #[test]
    fn voice_call_dsp_open_processor_without_onnx_returns_aec_badge_only_when_denoise_enabled() {
        let mut cfg = VoiceAiConfig::default();
        cfg.denoise = true;
        cfg.enhance_vocal = true;
        let (active, proc_opt, badge) = voice_call_dsp_open_processor_with(cfg.clone(), false);
        assert!(!active);
        assert!(proc_opt.is_none());
        assert_eq!(badge.as_deref(), Some("回声消除 · 降噪"));

        cfg.denoise = false;
        let (active2, proc_opt2, badge2) = voice_call_dsp_open_processor_with(cfg, false);
        assert!(!active2);
        assert!(proc_opt2.is_none());
        assert_eq!(badge2, None);
    }

    #[test]
    fn entitlements_allow_verified_external_onnxruntime_and_sidecar_check_blocks_tampering() {
        let plist = include_str!("../entitlements.plist");
        assert!(plist.contains("com.apple.security.cs.disable-library-validation"));
        assert!(plist.contains("<true/>"));

        let tmp = std::env::temp_dir().join(format!("hp-ort-check-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let lib = tmp.join("libonnxruntime.dylib");
        fs::write(&lib, b"valid-ort-binary").unwrap();
        let sha = file_sha256_hex(&lib).unwrap();
        fs::write(tmp.join(ORT_SHA_SIDECAR), format!("{sha}\n")).unwrap();
        assert!(verify_downloaded_ort_at(&tmp, &lib).is_ok());

        fs::write(&lib, b"tampered-ort-binary").unwrap();
        assert!(verify_downloaded_ort_at(&tmp, &lib).is_err());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn voiceprint_backup_cache_and_export_import_round_trip() {
        let tmp = std::env::temp_dir().join(format!("hp-vp-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let prev = std::env::var_os("HERDR_POCKET_HOME");
        std::env::set_var("HERDR_POCKET_HOME", &tmp);
        if let Ok(mut guard) = config_lock().lock() {
            *guard = None;
        }

        let emb = vec![0.0721f32; 192];
        let payload = serde_json::json!({
            "voiceprint": {
                "embedding": emb,
                "prototypes": [vec![0.0721f32; 192]],
                "modelVersion": VOICEPRINT_MODEL_VERSION,
                "hasSample": false,
                "route": "desktop-mic",
                "seconds": 4.2,
                "consistency": 0.91,
                "lowest": 0.85,
                "createdAt": 1234567890
            }
        });
        let imported = import_voiceprint(payload).unwrap();
        assert!(imported.enrolled);
        assert!(voiceprint_cache_path().unwrap().exists());

        // Simulate clearing main voice-ai.json voiceprint without calling clear_voiceprint:
        // cache should restore automatically on cold load_config().
        let mut wiped = load_config();
        wiped.voiceprint = None;
        let cfg_bytes = serde_json::to_vec_pretty(&wiped).unwrap();
        fs::write(config_file_path().unwrap(), &cfg_bytes).unwrap();
        if let Ok(mut guard) = config_lock().lock() {
            *guard = None;
        }
        let restored = load_config();
        assert!(restored.voiceprint.is_some());
        assert_eq!(restored.voiceprint.as_ref().unwrap().embedding.len(), 192);

        let exported = export_voiceprint().unwrap().expect("should export");
        assert!(exported.get("voiceprint").is_some());

        // Explicit clear deletes backup cache too.
        let cleared = clear_voiceprint().unwrap();
        assert!(!cleared.enrolled);
        assert!(!voiceprint_cache_path().unwrap().exists());

        if let Some(old) = prev {
            std::env::set_var("HERDR_POCKET_HOME", old);
        } else {
            std::env::remove_var("HERDR_POCKET_HOME");
        }
        if let Ok(mut guard) = config_lock().lock() {
            *guard = None;
        }
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn preview_process_pcm_bytes_returns_equal_length_pcm_and_metrics() {
        // Reject too-short inputs cleanly.
        assert!(preview_process_pcm_bytes(&[0u8; 100]).is_err());

        // 0.2s mono 16kHz sine wave (3200 samples = 6400 bytes).
        let sample_count = 3200usize;
        let mut pcm = Vec::with_capacity(sample_count * 2);
        for i in 0..sample_count {
            let v = 0.25 * (2.0 * PI * 300.0 * (i as f64) / 16000.0).sin();
            let s = (v * 32767.0) as i16;
            pcm.extend_from_slice(&s.to_le_bytes());
        }
        let res = preview_process_pcm_bytes(&pcm).expect("preview processing should succeed");
        let decoded = crate::local_term::base64_decode(res.pcm_base64.as_bytes())
            .expect("valid base64 output");
        assert_eq!(decoded.len(), pcm.len());
        assert_eq!(res.sample_rate, 16_000);
        assert_eq!(res.duration_ms, 200);
        assert!(res.in_rms_db > -25.0 && res.in_rms_db <= 0.0);
        assert!(res.out_rms_db.is_finite());
        assert!(res.suppressed_ratio >= 0.0 && res.suppressed_ratio <= 1.0);
    }

    #[test]
    fn preview_live_open_processor_runs_real_pipeline_and_reports_honest_engine_label() {
        let mut cfg = VoiceAiConfig::default();
        cfg.denoise = true;
        cfg.enhance_vocal = true;
        let mut proc = LiveCallProcessor::with_config_and_mode(cfg, false, false);
        assert!(!proc.used_dpdf());
        assert!(!proc.used_tse());
        assert!(!proc.sv_active());
        assert!(proc.engine_label().contains("纯 Rust 基础降噪"));

        // Feed 15 frames (300ms) of stationary broadband noise and verify real attenuation.
        let mut seed: u32 = 0x1234_5678;
        let mut in_energy = 0.0f64;
        let mut out_energy = 0.0f64;
        for f in 0..20 {
            let mut frame = [0i16; 320];
            for s in &mut frame {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let n = (((seed >> 16) as i16) as f32) / 32768.0 * 0.08;
                *s = (n * 32767.0) as i16;
            }
            let (out, _lvl) = proc.process_frame_320(&frame);
            if f >= 8 {
                for &x in &frame {
                    in_energy += (f64::from(x) / 32768.0).powi(2);
                }
                for &y in &out {
                    out_energy += (f64::from(y) / 32768.0).powi(2);
                }
            }
        }
        assert!(
            out_energy < in_energy,
            "LiveCallProcessor must actually process and attenuate stationary noise (in={in_energy}, out={out_energy})"
        );
    }

    fn enrolled_test_config(enhance_vocal: bool) -> VoiceAiConfig {
        let mut cfg = VoiceAiConfig::default();
        cfg.denoise = false;
        cfg.enhance_vocal = enhance_vocal;
        cfg.filter = true;
        cfg.threshold = 0.40;
        cfg.voiceprint = Some(VoiceprintRecord {
            embedding: vec![1.0, 0.0, 0.0, 0.0],
            prototypes: vec![vec![1.0, 0.0, 0.0, 0.0]],
            model_version: VOICEPRINT_MODEL_VERSION.into(),
            has_sample: false,
            route: None,
            snr_db: None,
            seconds: 5.0,
            consistency: 0.9,
            lowest: 0.85,
            created_at: 0,
        });
        cfg
    }

    #[test]
    fn residual_gate_closes_on_non_owner_at_moderate_tse_attenuation_and_strong_sv() {
        let mut proc = LiveCallProcessor::with_config_and_ort(enrolled_test_config(false), false);
        proc.has_sv = true;
        proc.speaking = true;

        // 1) Borderline non-owner score (~0.35 < 0.39) + moderate TSE attenuation (-4.0 dB,
        //    strictly above the old -9.0 dB deadlock) MUST close the residual gate.
        proc.smoothed_tse_atten_db = -4.0;
        proc.sv_tracker
            .apply_result(&[0.35, 0.9367, 0.0, 0.0], 16_000, false, true, true, -4.0);
        assert!(proc.sv_tracker.sv_confirmed_non_owner);
        proc.update_residual_gate(true);
        assert!(
            proc.is_suppressing(),
            "expected residual gate to close at -4.0 dB TSE attenuation (above old -9.0 dB deadlock)"
        );

        // Hysteresis + release hold: rising slightly to -1.8 dB (below -1.2 dB open threshold)
        // must keep the gate closed without chattering.
        proc.smoothed_tse_atten_db = -1.8;
        proc.update_residual_gate(true);
        assert!(proc.is_suppressing(), "expected hysteresis to prevent chatter at -1.8 dB");

        // Rising above -1.2 dB opens smoothly only after release-hold frames when SV score is borderline.
        proc.smoothed_tse_atten_db = -0.8;
        proc.update_residual_gate(true);
        assert!(proc.is_suppressing(), "expected 1st release frame to hold against chatter");
        proc.update_residual_gate(true);
        assert!(!proc.is_suppressing(), "expected gate to release after hold when non-strong & >= -1.2 dB");

        // 2) Dual-talk safety margin: a single borderline SV miss (~0.36) with minimal TSE
        //    attenuation (-1.0 dB) stays open to avoid chopping owner during dual-talk.
        proc.sv_tracker.reset_utterance();
        proc.smoothed_tse_atten_db = -1.0;
        proc.sv_tracker
            .apply_result(&[0.36, 0.933, 0.0, 0.0], 16_000, false, true, true, -1.0);
        proc.update_residual_gate(true);
        assert!(
            !proc.is_suppressing(),
            "single borderline SV miss with -1.0 dB TSE attenuation should keep dual-talk safety margin open"
        );

        // Second consecutive non-owner SV verdict confirms non-owner and closes the gate even at -1.0 dB.
        proc.sv_tracker
            .apply_result(&[0.36, 0.933, 0.0, 0.0], 16_000, false, true, true, -1.0);
        proc.update_residual_gate(true);
        assert!(
            proc.is_suppressing(),
            "consecutive non-owner SV verdicts must close residual gate even with mild TSE attenuation"
        );

        // 3) Clear low cosine similarity (orthogonal stranger ~0.0 << 0.40 - 0.06) closes the gate
        //    immediately even if VoxLock barely attenuated (-0.5 dB).
        proc.sv_tracker.reset_utterance();
        proc.suppressing_residual = false;
        proc.smoothed_tse_atten_db = -0.5;
        proc.sv_tracker
            .apply_result(&[0.0, 1.0, 0.0, 0.0], 16_000, false, true, true, -0.5);
        proc.update_residual_gate(true);
        assert!(
            proc.is_suppressing(),
            "clear non-owner SV score must close residual gate even at -0.5 dB TSE attenuation"
        );
    }

    #[test]
    fn owner_speech_stays_open_without_false_suppression_under_tse_attenuation() {
        let mut proc = LiveCallProcessor::with_config_and_ort(enrolled_test_config(false), false);
        proc.has_sv = true;
        proc.speaking = true;

        let mut tone = [0i16; 320];
        for (i, s) in tone.iter_mut().enumerate() {
            *s = (0.40 * (2.0 * PI * 700.0 * (i as f64) / 16000.0).sin() * 32767.0) as i16;
        }

        // Unverified onset before SV verdict applies gentle attenuation (not full 1.0 blast).
        let _ = proc.process_frame_320(&tone);
        let (_, onset_lvl) = proc.process_frame_320(&tone);
        assert!(
            proc.onset_gain < 0.70,
            "expected unverified onset attenuation before owner confirmation, got onset_gain={}",
            proc.onset_gain
        );

        // Once SV confirms owner (even when TSE attenuated an overlapping interferer by -4 dB or -10 dB),
        // gate stays completely open and onset_gain attacks rapidly back to 1.0.
        proc.smoothed_tse_atten_db = -4.0;
        proc.sv_tracker
            .apply_result(&[0.98, 0.1, 0.0, 0.0], 16_000, false, true, true, -4.0);
        proc.update_residual_gate(true);
        assert!(!proc.is_suppressing(), "owner must never be suppressed at -4.0 dB TSE attenuation");

        proc.smoothed_tse_atten_db = -10.0;
        proc.update_residual_gate(true);
        assert!(!proc.is_suppressing(), "owner must never be suppressed at -10.0 dB TSE attenuation");

        let (_, owner_lvl) = proc.process_frame_320(&tone);
        assert!(
            (proc.onset_gain - 1.0).abs() < 1e-4,
            "expected fast attack to 1.0 once owner confirmed, got {}",
            proc.onset_gain
        );
        assert!(
            owner_lvl > onset_lvl * 1.4 && owner_lvl > 0.35,
            "expected full unattenuated owner level > onset (owner={owner_lvl}, onset={onset_lvl})"
        );
    }

    #[test]
    fn vocal_enhancer_does_not_boost_confirmed_non_owner_or_unverified_frames() {
        // Quiet 2.5 kHz tone squarely inside the 1.5-3.8 kHz presence boost band & AGC boost range.
        let make_tone = |frame_idx: usize| -> [i16; 320] {
            let mut buf = [0i16; 320];
            for (i, s) in buf.iter_mut().enumerate() {
                let idx = frame_idx * 320 + i;
                let v = 0.06 * (2.0 * PI * 2500.0 * (idx as f64) / 16000.0).sin();
                *s = (v * 32767.0) as i16;
            }
            buf
        };
        let ref_frame = make_tone(0);
        let in_f32: Vec<f32> = ref_frame.iter().map(|&s| f32::from(s) / 32768.0).collect();
        let in_rms = rms(&in_f32);

        // 1) Confirmed owner: VocalEnhancer boosts presence & quiet level.
        let mut proc_owner =
            LiveCallProcessor::with_config_and_ort(enrolled_test_config(true), false);
        proc_owner.has_sv = true;
        proc_owner.speaking = true;
        proc_owner
            .sv_tracker
            .apply_result(&[0.99, 0.05, 0.0, 0.0], 16_000, false, true, false, 0.0);
        assert!(proc_owner.allow_vocal_boost());
        let mut owner_out = [0i16; 320];
        for f in 0..8 {
            owner_out = proc_owner.process_frame_320(&make_tone(f)).0;
        }
        let owner_f32: Vec<f32> = owner_out.iter().map(|&s| f32::from(s) / 32768.0).collect();
        let owner_rms = rms(&owner_f32);
        assert!(
            owner_rms > in_rms * 1.15,
            "expected confirmed owner 2.5kHz speech boosted (in={in_rms}, owner={owner_rms})"
        );

        // 2) Confirmed non-owner: allow_vocal_boost() MUST be false, VocalEnhancer MUST NOT boost,
        //    and the residual gate mutes output.
        let mut proc_stranger =
            LiveCallProcessor::with_config_and_ort(enrolled_test_config(true), false);
        proc_stranger.has_sv = true;
        proc_stranger.speaking = true;
        proc_stranger
            .sv_tracker
            .apply_result(&[0.0, 1.0, 0.0, 0.0], 16_000, false, true, false, 0.0);
        proc_stranger.update_residual_gate(false);
        assert!(
            !proc_stranger.allow_vocal_boost(),
            "vocal enhancer boost must be blocked for confirmed non-owner"
        );
        // Verify directly that passing allow_boost=false into enhancer does not amplify the tone.
        let mut unboosted = [0.0f32; 320];
        unboosted.copy_from_slice(&in_f32);
        proc_stranger
            .enhancer
            .process_in_place_gated(&mut unboosted, proc_stranger.allow_vocal_boost());
        let unboosted_rms = rms(&unboosted);
        assert!(
            unboosted_rms <= in_rms * 1.01,
            "confirmed non-owner frame must never be boosted by VocalEnhancer (in={in_rms}, out={unboosted_rms})"
        );
        let _ = proc_stranger.process_frame_320(&make_tone(0));
        let (muted, muted_lvl) = proc_stranger.process_frame_320(&make_tone(1));
        assert!(muted.iter().all(|&s| s == 0) && muted_lvl == 0.0);

        // 3) Unverified speech onset (before SV confirms owner): NEVER boosted.
        let mut proc_onset =
            LiveCallProcessor::with_config_and_ort(enrolled_test_config(true), false);
        proc_onset.has_sv = true;
        proc_onset.speaking = true;
        assert!(
            !proc_onset.allow_vocal_boost(),
            "vocal enhancer boost must be blocked during unverified speech onset"
        );
        let mut onset_out = [0i16; 320];
        for f in 0..4 {
            onset_out = proc_onset.process_frame_320(&make_tone(f)).0;
        }
        let onset_f32: Vec<f32> = onset_out.iter().map(|&s| f32::from(s) / 32768.0).collect();
        let onset_rms = rms(&onset_f32);
        assert!(
            onset_rms < in_rms,
            "unverified onset must be gently attenuated and never boosted (in={in_rms}, onset={onset_rms})"
        );
    }

    #[test]
    fn early_sv_window_is_tightened_and_utterance_end_resets_sv_and_tse_state() {
        assert!(
            LiveCallProcessor::EARLY_VOICED_W <= 10,
            "EARLY_VOICED_W should be tightened from 13 to reduce initial unverified speech leak"
        );
        let mut proc = LiveCallProcessor::with_config_and_ort(enrolled_test_config(false), false);
        proc.has_sv = true;
        proc.speaking = true;
        proc.smoothed_tse_atten_db = -8.0;
        proc.sv_tracker
            .apply_result(&[0.0, 1.0, 0.0, 0.0], 16_000, false, true, true, -8.0);
        proc.update_residual_gate(true);
        assert!(proc.is_suppressing());

        // Feed silence frames until END_WINDOWS (12 * 512 = 6144 samples -> ~20 frames of 320).
        let silence = [0i16; 320];
        for _ in 0..22 {
            let _ = proc.process_frame_320(&silence);
        }
        assert!(!proc.speaking, "silence must end active utterance");
        assert!(!proc.is_suppressing(), "utterance end must clear residual suppression");
        assert!(
            !proc.sv_tracker.sv_confirmed_non_owner && !proc.sv_tracker.sv_confirmed_owner,
            "utterance end must reset per-utterance SV state"
        );
        assert!(
            proc.smoothed_tse_atten_db.abs() < 1e-6,
            "utterance end must clear stale smoothed_tse_atten_db"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_coreml_ep_flags_and_optional_session_creation_work() {
        assert_eq!(ort::COREML_FLAG_USE_NONE, 0x000);
        assert_eq!(ort::COREML_FLAG_ONLY_ENABLE_DEVICE_WITH_ANE, 0x004);
        assert_ne!(
            ort::ExecutionProvider::Cpu,
            ort::ExecutionProvider::CoreMlPreferred
        );

        // If ONNX Runtime and a heavy model (ERes2NetV2 / VoxLock) are present locally,
        // verify CoreML EP attaches cleanly or falls back seamlessly to CPU EP without error.
        let Some(ort_path) = discover_ort_library() else {
            return;
        };
        let rt = ort::OrtRuntime::load_from(&ort_path).expect("load ORT dynamic library");
        for spec in [SV_SPEC, VOXLOCK_ENROLL_SPEC, VOXLOCK_CHUNK_SPEC] {
            if let Some(model_path) = discover_model_path(&spec) {
                let sess = ort::Session::create_with_ep(
                    &rt,
                    &model_path,
                    1,
                    ort::ExecutionProvider::CoreMlPreferred,
                )
                .unwrap_or_else(|e| {
                    panic!("create_with_ep(CoreMlPreferred) failed for {}: {e}", spec.file_name)
                });
                assert!(!sess.input_names.is_empty());
                assert!(!sess.output_names.is_empty());
            }
        }
    }
}
