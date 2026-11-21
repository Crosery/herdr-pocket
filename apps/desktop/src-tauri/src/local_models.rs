//! Native desktop fallback for discovering local agent models, catalogs, and live thinking levels
//! when a host daemon is older or lacks `agent.models` RPC support.

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

const CATALOG_CACHE_TTL: Duration = Duration::from_secs(300);
const MAX_MODELS: usize = 500;
const SESSION_TAIL_BYTES: u64 = 128 * 1024;
const CLI_TIMEOUT: Duration = Duration::from_secs(4);
static OMP_CLI_REFRESHING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_levels: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort_model_map: Option<BTreeMap<String, String>>,
    pub source: &'static str,
}

#[derive(Clone)]
struct CachedCatalog {
    at: Instant,
    models: Vec<ModelOption>,
}

static CLI_CATALOG_CACHE: OnceLock<Mutex<HashMap<String, CachedCatalog>>> = OnceLock::new();

fn cache_map() -> &'static Mutex<HashMap<String, CachedCatalog>> {
    CLI_CATALOG_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn normalize_harness(raw: &str) -> String {
    let h = raw.trim().to_ascii_lowercase();
    if h.is_empty() {
        return "generic".into();
    }
    if h.contains("claude")
        || h == "crosery"
        || h == "prime"
        || h == "commandcode"
        || h == "reasonix"
    {
        return "claude".into();
    }
    if h == "omp" || h.contains("oh-my-pi") {
        return "omp".into();
    }
    if h == "pi" || h.contains("pi-mono") {
        return "pi".into();
    }
    if h.contains("codex") {
        return "codex".into();
    }
    if h.contains("antigravity") || h == "agy" {
        return "antigravity".into();
    }
    if h.contains("gemini") {
        return "gemini".into();
    }
    if h.contains("deepseek") || h == "dsh" {
        return "dsh".into();
    }
    if h.contains("opencode") || h.contains("kilo") || h.contains("crush") {
        return "opencode".into();
    }
    if h.contains("hermes") {
        return "hermes".into();
    }
    if h.contains("grok") {
        return "grok".into();
    }
    if h.contains("aider") {
        return "aider".into();
    }
    if h.contains("factory") || h == "droid" {
        return "factory".into();
    }
    if h.contains("cursor") {
        return "cursor".into();
    }
    if h.contains("kimi") {
        return "kimi".into();
    }
    if h.contains("qwen") {
        return "qwen".into();
    }
    if h.contains("qoder") {
        return "qoder".into();
    }
    if h.contains("codebuddy") {
        return "codebuddy".into();
    }
    if h.contains("goose") {
        return "goose".into();
    }
    if h == "amp" {
        return "amp".into();
    }
    h
}

pub fn default_thinking_levels(h_norm: &str) -> Option<&'static [&'static str]> {
    match h_norm {
        "omp" => Some(&["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]),
        "pi" => Some(&["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
        "claude" => Some(&["low", "medium", "high", "xhigh", "max", "auto"]),
        "codex" | "grok" => Some(&["low", "medium", "high", "xhigh"]),
        "antigravity" => Some(&["low", "medium", "high", "xhigh", "max"]),
        "opencode" => Some(&["low", "medium", "high", "max"]),
        "hermes" => Some(&["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
        "factory" => Some(&["normal", "fast"]),
        "amp" => Some(&["smart", "rush"]),
        "gemini" | "dsh" | "aider" | "cursor" | "kimi" | "qwen" | "qoder" | "codebuddy"
        | "goose" => Some(&["low", "medium", "high"]),
        _ => None,
    }
}

pub fn strip_model_effort_suffix(raw: &str) -> (String, Option<String>) {
    let trimmed = raw.trim();
    if let Some(pos) = trimmed.rfind(':') {
        let suffix = trimmed[pos + 1..].to_ascii_lowercase();
        let is_effort = matches!(
            suffix.as_str(),
            "off"
                | "none"
                | "minimal"
                | "min"
                | "low"
                | "medium"
                | "med"
                | "high"
                | "xhigh"
                | "max"
                | "ultra"
                | "auto"
                | "default"
        );
        if is_effort && pos > 0 {
            return (trimmed[..pos].to_string(), Some(suffix));
        }
    }
    (trimmed.to_string(), None)
}

fn has_boundary_after(s: &str, prefix_len: usize, allow_dot: bool) -> bool {
    match s.as_bytes().get(prefix_len).copied() {
        None => true,
        Some(b'-' | b'_' | b'@' | b':') => true,
        Some(b'.') if allow_dot => true,
        _ => false,
    }
}

fn starts_with_bound(s: &str, prefix: &str, allow_dot: bool) -> bool {
    s.starts_with(prefix) && has_boundary_after(s, prefix.len(), allow_dot)
}

fn is_non_reasoning_model_name(model_id: &str) -> bool {
    let (base, _) = strip_model_effort_suffix(model_id);
    let leaf = base.trim().rsplit('/').next().unwrap_or("").to_ascii_lowercase();
    if leaf.is_empty() {
        return false;
    }
    if leaf.starts_with("gemini-1.5-")
        || leaf.starts_with("gemini-1.0-")
        || leaf == "gemini-pro"
        || (leaf.starts_with("gemini-2.0-") && !leaf.starts_with("gemini-2.0-flash-thinking"))
        || leaf == "gemma-3"
        || leaf.starts_with("gemma-3-")
        || leaf.starts_with("gemma-2-")
        || leaf == "gpt-4o"
        || leaf.starts_with("gpt-4o-")
        || leaf == "gpt-4.1"
        || leaf.starts_with("gpt-4.1-")
        || leaf == "gpt-4.5"
        || leaf.starts_with("gpt-4.5-")
        || leaf == "gpt-4"
        || leaf.starts_with("gpt-4-")
        || leaf == "gpt-3.5"
        || leaf.starts_with("gpt-3.5-")
        || leaf.starts_with("claude-3-5-")
        || leaf.starts_with("claude-3.5-")
        || starts_with_bound(&leaf, "claude-3-opus", false)
        || starts_with_bound(&leaf, "claude-3-sonnet", false)
        || starts_with_bound(&leaf, "claude-3-haiku", false)
    {
        return true;
    }
    const EXACT_OR_PREFIX: &[&str] = &[
        "mimo-v2.5-asr",
        "codex-auto-review",
        "gpt-reserve",
        "kimi-for-coding-highspeed",
    ];
    EXACT_OR_PREFIX.iter().any(|pat| starts_with_bound(&leaf, pat, false))
}

fn contains_claude_ver(leaf: &str, a: char, b: char) -> bool {
    if !leaf.starts_with("claude-") {
        return false;
    }
    for sep in ['-', '.'] {
        let needle = format!("-{a}{sep}{b}");
        if let Some(pos) = leaf.find(&needle) {
            if has_boundary_after(leaf, pos + needle.len(), false) {
                return true;
            }
        }
    }
    false
}

fn match_explicit_model_family_levels(base_model: &str) -> Option<Vec<String>> {
    let leaf = base_model.trim().rsplit('/').next().unwrap_or("").to_ascii_lowercase();
    if leaf.is_empty() || leaf.starts_with('@') {
        return None;
    }
    let to_vec = |arr: &[&str]| arr.iter().map(|s| (*s).to_string()).collect::<Vec<String>>();

    if leaf.starts_with("gpt-oss-") {
        for suffix in ["-minimal", "-xhigh", "-medium", "-high", "-low", "-max"] {
            if leaf.ends_with(suffix) {
                return Some(vec![suffix[1..].to_string()]);
            }
        }
    }

    if starts_with_bound(&leaf, "gemini-4-neon", false)
        || starts_with_bound(&leaf, "gemini-4-hydrogen", false)
    {
        return Some(to_vec(&["low", "medium", "high", "xhigh"]));
    }
    if starts_with_bound(&leaf, "gemini-4-carbon", false)
        || starts_with_bound(&leaf, "gemini-4-argon", false)
        || starts_with_bound(&leaf, "gemini-3.7", false)
        || starts_with_bound(&leaf, "gemini-3.8", false)
    {
        return Some(to_vec(&["low", "medium", "high"]));
    }
    if starts_with_bound(&leaf, "gemini-2.5", false)
        || starts_with_bound(&leaf, "gemini-live-2.5", false)
    {
        return Some(to_vec(&["minimal", "low", "medium", "high"]));
    }
    if starts_with_bound(&leaf, "gemini-3-flash", false)
        || starts_with_bound(&leaf, "gemini-3.1-flash", false)
        || starts_with_bound(&leaf, "gemini-3.5-flash", false)
        || starts_with_bound(&leaf, "gemini-3.6-flash", false)
    {
        return Some(to_vec(&["minimal", "low", "medium", "high"]));
    }
    if starts_with_bound(&leaf, "gemini-3", true) {
        return Some(to_vec(&["low", "high"]));
    }
    if starts_with_bound(&leaf, "gemma-4", true) {
        return Some(to_vec(&["high"]));
    }
    if starts_with_bound(&leaf, "k3", true)
        || starts_with_bound(&leaf, "kimi-k2-thinking", false)
        || starts_with_bound(&leaf, "kimi-for-coding", false)
    {
        return Some(to_vec(&["low", "high", "max"]));
    }
    if contains_claude_ver(&leaf, '4', '6') {
        return Some(to_vec(&["low", "medium", "high", "max"]));
    }
    if contains_claude_ver(&leaf, '4', '5')
        || contains_claude_ver(&leaf, '5', '5')
        || starts_with_bound(&leaf, "claude-3-7", false)
        || starts_with_bound(&leaf, "claude-3.7", false)
    {
        return Some(to_vec(&["low", "medium", "high"]));
    }
    let is_gpt_5_2_plus = (leaf.starts_with("gpt-5.")
        && leaf.as_bytes().get(6).map(|b| matches!(b, b'2'..=b'9')).unwrap_or(false)
        && has_boundary_after(&leaf, 7, true))
        || starts_with_bound(&leaf, "gpt-6", true)
        || starts_with_bound(&leaf, "codex", true)
        || leaf.contains("-codex")
        || starts_with_bound(&leaf, "mimo-v2.6", true);
    if is_gpt_5_2_plus {
        return Some(to_vec(&["low", "medium", "high", "xhigh"]));
    }
    if starts_with_bound(&leaf, "o1", false)
        || starts_with_bound(&leaf, "o3", false)
        || starts_with_bound(&leaf, "o4-mini", false)
        || starts_with_bound(&leaf, "gpt-5", false)
        || starts_with_bound(&leaf, "gpt-5.0", false)
        || starts_with_bound(&leaf, "gpt-5.1", false)
        || starts_with_bound(&leaf, "gpt-5-mini", false)
        || starts_with_bound(&leaf, "gpt-5-nano", false)
    {
        return Some(to_vec(&["low", "medium", "high"]));
    }

    None
}

pub fn infer_model_thinking_levels(
    harness: &str,
    model_id: Option<&str>,
    reasoning: Option<bool>,
    has_reasoning_events: bool,
) -> Vec<String> {
    let h_norm = normalize_harness(harness);
    let fallback: Vec<String> = if let Some(defaults) = default_thinking_levels(&h_norm) {
        defaults.iter().map(|s| (*s).to_string()).collect()
    } else if has_reasoning_events || reasoning == Some(true) {
        vec!["low".into(), "medium".into(), "high".into()]
    } else {
        Vec::new()
    };

    if reasoning == Some(false) {
        return Vec::new();
    }

    let raw = model_id.map(str::trim).unwrap_or("");
    if raw.is_empty() {
        return fallback;
    }
    let (base, _) = strip_model_effort_suffix(raw);
    if base.is_empty() || base.starts_with('@') {
        return fallback;
    }
    if is_non_reasoning_model_name(&base) {
        return Vec::new();
    }
    if let Some(levels) = match_explicit_model_family_levels(&base) {
        return levels;
    }
    fallback
}

fn effort_rank(level: &str) -> Option<i32> {
    match level {
        "off" | "none" => Some(0),
        "minimal" | "min" => Some(1),
        "low" => Some(2),
        "medium" | "med" | "normal" | "smart" => Some(3),
        "high" | "fast" => Some(4),
        "xhigh" | "rush" => Some(5),
        "max" => Some(6),
        "ultra" => Some(7),
        _ => None,
    }
}

pub fn clamp_thinking_level(levels: &[String], candidate: Option<&str>) -> Option<String> {
    if levels.is_empty() {
        return None;
    }
    let clean = candidate.map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty());
    let Some(c) = clean else {
        return if levels.len() == 1 {
            Some(levels[0].clone())
        } else {
            None
        };
    };
    if let Some(exact) = levels.iter().find(|l| l.eq_ignore_ascii_case(&c)) {
        return Some(exact.clone());
    }
    let Some(target_rank) = effort_rank(&c) else {
        for pref in ["medium", "high", "low"] {
            if let Some(hit) = levels.iter().find(|l| l.eq_ignore_ascii_case(pref)) {
                return Some(hit.clone());
            }
        }
        return Some(levels[0].clone());
    };
    let mut best_idx = 0usize;
    let mut best_dist = i32::MAX;
    let mut best_rank = -1i32;
    for (i, lvl) in levels.iter().enumerate() {
        let Some(r) = effort_rank(&lvl.to_ascii_lowercase()) else {
            continue;
        };
        let dist = (r - target_rank).abs();
        if dist < best_dist || (dist == best_dist && r > best_rank) {
            best_dist = dist;
            best_idx = i;
            best_rank = r;
        }
    }
    Some(levels[best_idx].clone())
}

fn infer_hyphen_effort(model_id: &str) -> Option<String> {
    let low = model_id.trim().to_ascii_lowercase();
    for suffix in ["-minimal", "-xhigh", "-medium", "-high", "-low"] {
        if low.ends_with(suffix) {
            return Some(suffix[1..].to_string());
        }
    }
    None
}

fn find_program_with_extra_dirs(name: &str, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = crate::find_program_path(name) {
        return Some(p);
    }
    #[cfg(not(windows))]
    if let Some(h) = home {
        for sub in [".bun/bin", ".pi/agent/bin", ".npm-global/bin"] {
            let cand = h.join(sub).join(name);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    let _ = home;
    None
}

enum CliOutput {
    Ok(String),
    Failed,
    TimedOut,
}

fn run_cli_stdout_status(bin: &Path, args: &[&str], timeout: Duration) -> CliOutput {
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut child) = cmd.spawn() else {
        return CliOutput::Failed;
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return CliOutput::Failed;
    };
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.by_ref().take(6 * 1024 * 1024).read_to_end(&mut buf);
        buf
    });
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                let _ = child.kill();
                break None;
            }
        }
    };
    let bytes = reader.join().unwrap_or_default();
    if timed_out {
        CliOutput::TimedOut
    } else if status.map(|s| s.success()).unwrap_or(false) {
        CliOutput::Ok(String::from_utf8_lossy(&bytes).into_owned())
    } else {
        CliOutput::Failed
    }
}

fn run_cli_stdout(bin: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    match run_cli_stdout_status(bin, args, timeout) {
        CliOutput::Ok(s) => Some(s),
        _ => None,
    }
}

fn cached_cli_catalog<F>(key: &str, loader: F) -> Vec<ModelOption>
where
    F: FnOnce() -> Vec<ModelOption>,
{
    if let Ok(guard) = cache_map().lock() {
        if let Some(hit) = guard.get(key) {
            if hit.at.elapsed() < CATALOG_CACHE_TTL {
                return hit.models.clone();
            }
        }
    }
    let models: Vec<ModelOption> = loader().into_iter().take(MAX_MODELS).collect();
    if !models.is_empty() {
        if let Ok(mut guard) = cache_map().lock() {
            guard.insert(
                key.to_string(),
                CachedCatalog {
                    at: Instant::now(),
                    models: models.clone(),
                },
            );
        }
        return models;
    }
    if let Ok(guard) = cache_map().lock() {
        if let Some(hit) = guard.get(key) {
            return hit.models.clone();
        }
    }
    Vec::new()
}

fn extract_thinking_array(val: Option<&Value>) -> Option<Vec<String>> {
    let v = val?;
    let arr = if let Some(a) = v.as_array() {
        a
    } else if let Some(a) = v.get("efforts").and_then(Value::as_array) {
        a
    } else {
        return None;
    };
    let list: Vec<String> = arr
        .iter()
        .filter_map(|x| x.as_str())
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if list.is_empty() {
        None
    } else {
        Some(list)
    }
}

pub fn parse_omp_models_json(raw: &str) -> Vec<ModelOption> {
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let rows = if let Some(a) = parsed.get("models").and_then(Value::as_array) {
        a
    } else if let Some(a) = parsed.as_array() {
        a
    } else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for item in rows {
        if out.len() >= MAX_MODELS {
            break;
        }
        let Some(obj) = item.as_object() else {
            continue;
        };
        if let Some(kind) = obj.get("kind").and_then(Value::as_str) {
            if kind != "chat" {
                continue;
            }
        }
        let id = obj
            .get("selector")
            .and_then(Value::as_str)
            .or_else(|| obj.get("id").and_then(Value::as_str))
            .map(str::trim)
            .unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let label = obj
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| obj.get("id").and_then(Value::as_str))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id)
            .to_string();
        let provider = obj
            .get("provider")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let context_window = obj
            .get("contextWindow")
            .and_then(Value::as_u64)
            .filter(|&n| n > 0);
        let reasoning = obj.get("reasoning").and_then(Value::as_bool);
        let thinking_levels = if reasoning == Some(false) {
            None
        } else {
            extract_thinking_array(obj.get("thinking"))
        };
        out.push(ModelOption {
            id: id.to_string(),
            label,
            provider,
            context_window,
            reasoning,
            thinking_levels,
            effort_model_map: None,
            source: "catalog",
        });
    }
    out
}

const AGY_EFFORT_ORDER: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];

fn split_agy_effort_stem(id: &str) -> Option<(String, String)> {
    let low = id.to_ascii_lowercase();
    for lvl in AGY_EFFORT_ORDER {
        let suffix = format!("-{lvl}");
        if low.ends_with(&suffix) && id.len() > suffix.len() {
            let stem = &id[..id.len() - suffix.len()];
            return Some((stem.to_string(), (*lvl).to_string()));
        }
    }
    None
}

pub fn parse_agy_models_text(raw: &str) -> Vec<ModelOption> {
    struct Entry {
        id: String,
        label: String,
        stem: Option<String>,
    }
    let mut entries = Vec::new();
    let mut groups: HashMap<String, HashMap<String, String>> = HashMap::new();

    for line in raw.lines() {
        if entries.len() >= MAX_MODELS {
            break;
        }
        let clean = line.trim();
        if clean.is_empty() {
            continue;
        }
        if clean.to_ascii_lowercase().starts_with("model") && !clean.contains('\t') {
            continue;
        }
        let mut parts = clean.splitn(2, '\t');
        let id = parts.next().unwrap_or("").trim();
        if id.is_empty() || id.chars().any(char::is_whitespace) {
            continue;
        }
        let label = parts
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id);
        if let Some((stem, effort)) = split_agy_effort_stem(id) {
            let stem_key = stem.to_ascii_lowercase();
            groups
                .entry(stem_key)
                .or_default()
                .entry(effort)
                .or_insert_with(|| id.to_string());
            entries.push(Entry {
                id: id.to_string(),
                label: label.to_string(),
                stem: Some(stem),
            });
        } else {
            entries.push(Entry {
                id: id.to_string(),
                label: label.to_string(),
                stem: None,
            });
        }
    }

    entries
        .into_iter()
        .map(|e| {
            let stem_key = e
                .stem
                .as_deref()
                .unwrap_or(&e.id)
                .to_ascii_lowercase();
            if let Some(sibling_map) = groups.get(&stem_key) {
                let mut thinking_levels = Vec::new();
                let mut effort_model_map = BTreeMap::new();
                for &lvl in AGY_EFFORT_ORDER {
                    if let Some(target_id) = sibling_map.get(lvl) {
                        thinking_levels.push(lvl.to_string());
                        effort_model_map.insert(lvl.to_string(), target_id.clone());
                    }
                }
                let has_levels = !thinking_levels.is_empty();
                return ModelOption {
                    id: e.id,
                    label: e.label,
                    provider: Some("antigravity".into()),
                    context_window: None,
                    reasoning: Some(has_levels),
                    thinking_levels: if has_levels { Some(thinking_levels) } else { None },
                    effort_model_map: if has_levels { Some(effort_model_map) } else { None },
                    source: "catalog",
                };
            }

            let inferred = infer_model_thinking_levels("antigravity", Some(&e.id), None, false);
            let has_levels = !inferred.is_empty();
            ModelOption {
                id: e.id,
                label: e.label,
                provider: Some("antigravity".into()),
                context_window: None,
                reasoning: Some(has_levels),
                thinking_levels: if has_levels { Some(inferred) } else { None },
                effort_model_map: None,
                source: "catalog",
            }
        })
        .collect()
}

pub fn parse_opencode_models_text(raw: &str) -> Vec<ModelOption> {
    let mut out = Vec::new();
    for line in raw.lines() {
        if out.len() >= MAX_MODELS {
            break;
        }
        let id = line.trim();
        if id.is_empty() || id.starts_with('#') || id.chars().any(char::is_whitespace) {
            continue;
        }
        let (provider, label) = match id.split_once('/') {
            Some((p, m)) if !p.is_empty() => (p, m),
            _ => ("opencode", id),
        };
        out.push(ModelOption {
            id: id.to_string(),
            label: label.to_string(),
            provider: Some(provider.to_string()),
            context_window: None,
            reasoning: None,
            thinking_levels: None,
            effort_model_map: None,
            source: "catalog",
        });
    }
    out
}

fn parse_context_unit(raw: &str) -> Option<u64> {
    let s = raw.trim().to_ascii_lowercase();
    let (num_str, mult) = if let Some(n) = s.strip_suffix('m') {
        (n, 1_000_000.0)
    } else if let Some(n) = s.strip_suffix('k') {
        (n, 1_000.0)
    } else {
        return None;
    };
    let n: f64 = num_str.parse().ok()?;
    if n.is_finite() && n > 0.0 {
        Some((n * mult).round() as u64)
    } else {
        None
    }
}

pub fn parse_pi_models_text(raw: &str) -> Vec<ModelOption> {
    let mut out = Vec::new();
    for line in raw.lines() {
        if out.len() >= MAX_MODELS {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.to_ascii_lowercase().starts_with("provider")
            || trimmed.chars().all(|c| c == '-' || c == '─')
        {
            continue;
        }
        let cols: Vec<&str> = trimmed.split_whitespace().collect();
        if cols.len() < 2 {
            continue;
        }
        let provider = cols[0];
        let model = cols[1];
        let id = if model.contains('/') {
            model.to_string()
        } else {
            format!("{provider}/{model}")
        };
        let context_window = cols.get(2).and_then(|c| parse_context_unit(c));
        let reasoning = cols.get(4).map(|c| c.eq_ignore_ascii_case("yes"));
        out.push(ModelOption {
            id,
            label: model.to_string(),
            provider: Some(provider.to_string()),
            context_window,
            reasoning,
            thinking_levels: None,
            effort_model_map: None,
            source: "catalog",
        });
    }
    out
}

fn strip_yaml_scalar(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return String::new();
    }
    if (s.starts_with('"') || s.starts_with('\'')) && s.len() >= 2 {
        let q = s.chars().next().unwrap();
        if let Some(end) = s[1..].find(q) {
            return s[1..1 + end].trim().to_string();
        }
    }
    if let Some(idx) = s.find(" #") {
        s[..idx].trim().to_string()
    } else {
        s.to_string()
    }
}

fn parse_yaml_inline_array(raw: &str) -> Option<Vec<String>> {
    let s = strip_yaml_scalar(raw);
    if !s.starts_with('[') || !s.ends_with(']') {
        return None;
    }
    let inner = s[1..s.len() - 1].trim();
    if inner.is_empty() {
        return None;
    }
    let items: Vec<String> = inner
        .split(',')
        .map(|p| strip_yaml_scalar(p).to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    if items.is_empty() {
        None
    } else {
        Some(items)
    }
}

#[derive(Default)]
struct YmlModelDraft {
    id: Option<String>,
    name: Option<String>,
    kind: Option<String>,
    context_window: Option<u64>,
    reasoning: Option<bool>,
    thinking_levels: Option<Vec<String>>,
}

/// Parses non-secret model entries (`provider`, `id`, `name`, `contextWindow`, `reasoning`,
/// `thinking` / `thinking.efforts`) from `~/.omp/agent/models.yml`. Never reads or emits
/// `auth`, `apiKey`, `token`, `secret`, `headers`, or `baseUrl`.
pub fn parse_omp_models_yml(raw: &str) -> Vec<ModelOption> {
    let mut out = Vec::new();
    let mut in_providers = false;
    let mut provider_indent: Option<usize> = None;
    let mut current_provider = String::new();
    let mut in_models = false;
    let mut models_indent: usize = 0;
    let mut item_indent: Option<usize> = None;
    let mut draft: Option<YmlModelDraft> = None;
    let mut in_thinking = false;
    let mut thinking_indent: usize = 0;
    let mut in_efforts = false;
    let mut efforts_indent: usize = 0;
    let mut ignored_indent: Option<usize> = None;

    let flush = |draft_opt: &mut Option<YmlModelDraft>,
                 provider: &str,
                 out: &mut Vec<ModelOption>| {
        let Some(d) = draft_opt.take() else {
            return;
        };
        if provider.is_empty() || out.len() >= MAX_MODELS {
            return;
        }
        if let Some(kind) = d.kind.as_deref() {
            if kind != "chat" {
                return;
            }
        }
        let Some(raw_id) = d.id.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
            return;
        };
        let prefix = format!("{provider}/");
        let id = if raw_id.starts_with(&prefix) {
            raw_id.clone()
        } else {
            format!("{prefix}{raw_id}")
        };
        let label = d
            .name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or(raw_id);
        let thinking_levels = if d.reasoning == Some(false) {
            None
        } else {
            d.thinking_levels
        };
        out.push(ModelOption {
            id,
            label,
            provider: Some(provider.to_string()),
            context_window: d.context_window,
            reasoning: d.reasoning,
            thinking_levels,
            effort_model_map: None,
            source: "catalog",
        });
    };

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();

        if indent == 0 {
            flush(&mut draft, &current_provider, &mut out);
            in_models = false;
            in_thinking = false;
            in_efforts = false;
            ignored_indent = None;
            current_provider.clear();
            provider_indent = None;
            let key = trimmed.split(':').next().unwrap_or("").trim();
            in_providers = key == "providers"
                && trimmed.contains(':')
                && strip_yaml_scalar(trimmed.split_once(':').map(|x| x.1).unwrap_or("")).is_empty();
            continue;
        }

        if !in_providers {
            continue;
        }

        let p_indent = *provider_indent.get_or_insert(indent);
        if indent == p_indent {
            flush(&mut draft, &current_provider, &mut out);
            in_models = false;
            in_thinking = false;
            in_efforts = false;
            ignored_indent = None;
            current_provider = if let Some((k, rest)) = trimmed.split_once(':') {
                if strip_yaml_scalar(rest).is_empty() {
                    strip_yaml_scalar(k)
                } else {
                    String::new()
                }
            } else {
                String::new()
            };
            continue;
        }

        if current_provider.is_empty() {
            continue;
        }

        if in_models && indent <= models_indent && !trimmed.starts_with('-') {
            flush(&mut draft, &current_provider, &mut out);
            in_models = false;
            in_thinking = false;
            in_efforts = false;
            ignored_indent = None;
        }

        if !in_models {
            if let Some((k, rest)) = trimmed.split_once(':') {
                if k.trim() == "models" && strip_yaml_scalar(rest).is_empty() {
                    in_models = true;
                    models_indent = indent;
                    item_indent = None;
                }
            }
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix('-') {
            let rest = rest.trim_start();
            if item_indent.is_none() || item_indent == Some(indent) {
                flush(&mut draft, &current_provider, &mut out);
                item_indent = Some(indent);
                draft = Some(YmlModelDraft::default());
                in_thinking = false;
                in_efforts = false;
                ignored_indent = None;
                if !rest.is_empty() && !rest.starts_with('#') {
                    if let Some((k, v)) = rest.split_once(':') {
                        apply_yml_draft_prop(
                            draft.as_mut().unwrap(),
                            k.trim(),
                            v,
                            indent + 2,
                            &mut in_thinking,
                            &mut thinking_indent,
                            &mut in_efforts,
                            &mut efforts_indent,
                            &mut ignored_indent,
                        );
                    }
                }
                continue;
            }
        }

        let Some(ref mut d) = draft else {
            continue;
        };

        if in_thinking && indent <= thinking_indent {
            in_thinking = false;
            in_efforts = false;
        }
        if in_efforts && indent <= efforts_indent && !trimmed.starts_with('-') {
            in_efforts = false;
        }
        if let Some(ign) = ignored_indent {
            if indent <= ign {
                ignored_indent = None;
            }
        }

        if in_thinking {
            if let Some(item_raw) = trimmed.strip_prefix('-') {
                let item = strip_yaml_scalar(item_raw).to_ascii_lowercase();
                if !item.is_empty() {
                    let list = d.thinking_levels.get_or_insert_with(Vec::new);
                    if !list.contains(&item) {
                        list.push(item);
                    }
                }
                continue;
            }
            if let Some((k, v)) = trimmed.split_once(':') {
                if k.trim() == "efforts" {
                    if let Some(arr) = parse_yaml_inline_array(v) {
                        d.thinking_levels = Some(arr);
                    } else if strip_yaml_scalar(v).is_empty() {
                        in_efforts = true;
                        efforts_indent = indent;
                    }
                }
            }
            continue;
        }

        if ignored_indent.is_some() {
            continue;
        }

        if let Some((k, v)) = trimmed.split_once(':') {
            apply_yml_draft_prop(
                d,
                k.trim(),
                v,
                indent,
                &mut in_thinking,
                &mut thinking_indent,
                &mut in_efforts,
                &mut efforts_indent,
                &mut ignored_indent,
            );
        }
    }

    flush(&mut draft, &current_provider, &mut out);
    out
}

#[allow(clippy::too_many_arguments)]
fn apply_yml_draft_prop(
    d: &mut YmlModelDraft,
    key: &str,
    val_raw: &str,
    indent: usize,
    in_thinking: &mut bool,
    thinking_indent: &mut usize,
    in_efforts: &mut bool,
    efforts_indent: &mut usize,
    ignored_indent: &mut Option<usize>,
) {
    let val = strip_yaml_scalar(val_raw);
    match key {
        "id" => {
            if !val.is_empty() {
                d.id = Some(val);
            }
        }
        "name" => {
            if !val.is_empty() {
                d.name = Some(val);
            }
        }
        "kind" => {
            if !val.is_empty() {
                d.kind = Some(val.to_ascii_lowercase());
            }
        }
        "contextWindow" => {
            if let Ok(n) = val.parse::<u64>() {
                if n > 0 {
                    d.context_window = Some(n);
                }
            }
        }
        "reasoning" => {
            if val.eq_ignore_ascii_case("true") {
                d.reasoning = Some(true);
            } else if val.eq_ignore_ascii_case("false") {
                d.reasoning = Some(false);
            }
        }
        "thinking" => {
            if let Some(arr) = parse_yaml_inline_array(val_raw) {
                d.thinking_levels = Some(arr);
            } else if val.is_empty() {
                *in_thinking = true;
                *thinking_indent = indent;
                *in_efforts = false;
                *efforts_indent = 0;
            } else {
                d.thinking_levels = None;
            }
        }
        _ => {
            if val.is_empty() {
                *ignored_indent = Some(indent);
            }
        }
    }
}

struct ParsedSpeedMeta {
    clean: String,
    base_leaf: String,
    tier: &'static str,
    provider_base: String,
    provider_segments: Vec<String>,
}

fn strip_speed_tier_from_provider(seg: &str) -> String {
    if let Some(s) = seg.strip_suffix("-ultrafast") {
        s.to_string()
    } else if let Some(s) = seg.strip_suffix("-fast") {
        s.to_string()
    } else {
        seg.to_string()
    }
}

fn parse_speed_meta(raw: &str) -> ParsedSpeedMeta {
    let (clean_orig, _) = strip_model_effort_suffix(raw);
    let clean = clean_orig.trim().to_ascii_lowercase();
    let segments: Vec<&str> = clean.split('/').filter(|s| !s.is_empty()).collect();
    let leaf = segments.last().copied().unwrap_or("");
    let parent = if segments.len() >= 2 {
        segments[segments.len() - 2]
    } else {
        ""
    };
    let provider_segments = segments[..segments.len().saturating_sub(1)]
        .iter()
        .map(|s| strip_speed_tier_from_provider(s))
        .collect();

    let (tier, base_leaf) = if let Some(b) = leaf.strip_suffix("-ultrafast") {
        ("ultrafast", b.to_string())
    } else if let Some(b) = leaf.strip_suffix("-fast") {
        ("fast", b.to_string())
    } else if parent.ends_with("-ultrafast") {
        ("ultrafast", leaf.to_string())
    } else if parent.ends_with("-fast") {
        ("fast", leaf.to_string())
    } else {
        ("", leaf.to_string())
    };

    let provider_base = strip_speed_tier_from_provider(parent);
    ParsedSpeedMeta {
        clean,
        base_leaf,
        tier,
        provider_base,
        provider_segments,
    }
}

pub fn find_catalog_match<'a>(
    raw_id: &str,
    catalog: &'a [ModelOption],
) -> Option<&'a ModelOption> {
    let q_meta = parse_speed_meta(raw_id);
    if q_meta.clean.is_empty() {
        return None;
    }
    if let Some(exact) = catalog
        .iter()
        .find(|c| c.id.eq_ignore_ascii_case(&q_meta.clean))
    {
        return Some(exact);
    }
    let suffix = format!("/{}", q_meta.clean);
    if let Some(hit) = catalog
        .iter()
        .find(|c| c.id.to_ascii_lowercase().ends_with(&suffix))
    {
        return Some(hit);
    }

    let parsed: Vec<(&ModelOption, ParsedSpeedMeta)> = catalog
        .iter()
        .map(|c| (c, parse_speed_meta(&c.id)))
        .collect();

    if !q_meta.provider_base.is_empty() {
        if let Some((c, _)) = parsed.iter().find(|(_, m)| {
            m.base_leaf == q_meta.base_leaf
                && m.tier == q_meta.tier
                && m.provider_segments.contains(&q_meta.provider_base)
        }) {
            return Some(*c);
        }
    }

    if let Some((c, _)) = parsed
        .iter()
        .find(|(_, m)| m.base_leaf == q_meta.base_leaf && m.tier == q_meta.tier)
    {
        return Some(*c);
    }

    if !q_meta.tier.is_empty() {
        if !q_meta.provider_base.is_empty() {
            if let Some((c, _)) = parsed.iter().find(|(_, m)| {
                m.base_leaf == q_meta.base_leaf
                    && m.provider_segments.contains(&q_meta.provider_base)
            }) {
                return Some(*c);
            }
        }
        if let Some((c, _)) = parsed.iter().find(|(_, m)| m.base_leaf == q_meta.base_leaf) {
            return Some(*c);
        }
    }

    None
}

#[derive(Default)]
struct OmpConfigInfo {
    models: Vec<ModelOption>,
    roles: BTreeMap<String, String>,
    default_model: Option<String>,
    default_thinking: Option<String>,
}

fn parse_omp_config_yml_str(raw: &str) -> OmpConfigInfo {
    let mut info = OmpConfigInfo::default();
    let mut in_roles = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent == 0 {
            in_roles = false;
            if let Some((k, v)) = trimmed.split_once(':') {
                let key = k.trim();
                let val = strip_yaml_scalar(v);
                if key == "defaultThinkingLevel" && !val.is_empty() {
                    info.default_thinking = Some(val.to_ascii_lowercase());
                } else if key == "modelRoles" && val.is_empty() {
                    in_roles = true;
                }
            }
            continue;
        }
        if in_roles {
            if let Some((k, v)) = trimmed.split_once(':') {
                let role = k.trim();
                let val = strip_yaml_scalar(v);
                if val.is_empty() {
                    continue;
                }
                info.roles.insert(role.to_string(), val.clone());
                let (id, effort) = strip_model_effort_suffix(&val);
                if id.is_empty() {
                    continue;
                }
                let provider = id
                    .split_once('/')
                    .map(|(p, _)| p.to_string())
                    .unwrap_or_else(|| "omp".into());
                if role == "default" && info.default_model.is_none() {
                    info.default_model = Some(id.clone());
                    if info.default_thinking.is_none() {
                        info.default_thinking = effort;
                    }
                }
                info.models.push(ModelOption {
                    id: id.clone(),
                    label: id,
                    provider: Some(provider),
                    context_window: None,
                    reasoning: None,
                    thinking_levels: None,
                    effort_model_map: None,
                    source: "recent",
                });
            }
        }
    }
    info
}

fn read_omp_config_yml(home: &Path) -> OmpConfigInfo {
    let path = home.join(".omp").join("agent").join("config.yml");
    let Ok(raw) = fs::read_to_string(path) else {
        return OmpConfigInfo::default();
    };
    parse_omp_config_yml_str(&raw)
}

#[allow(dead_code)]
const OMP_MODEL_ROLES: &[&str] = &["default", "smol", "slow", "plan", "commit"];

#[allow(dead_code)]
fn format_yaml_scalar(val: &str) -> String {
    let needs_quotes = val.contains(": ")
        || val.contains('#')
        || val.contains('"')
        || val.contains('\'')
        || val.contains('[')
        || val.contains(']')
        || val.contains('{')
        || val.contains('}')
        || val.starts_with(['-', '*', '&', '!', '%', '@', '?'])
        || val.starts_with(char::is_whitespace)
        || val.ends_with(char::is_whitespace);
    if needs_quotes {
        serde_json::to_string(val).unwrap_or_else(|_| format!("\"{val}\""))
    } else {
        val.to_string()
    }
}

#[allow(dead_code)]
fn extract_yaml_trailing_comment(val_raw: &str) -> &str {
    let trimmed = val_raw.trim_start();
    if trimmed.is_empty() {
        return "";
    }
    if trimmed.starts_with('"') || trimmed.starts_with('\'') {
        let q = trimmed.chars().next().unwrap();
        if let Some(end) = trimmed[1..].find(q) {
            let rest = &trimmed[1 + end + 1..];
            if let Some(idx) = rest.find('#') {
                if rest[..idx].chars().all(char::is_whitespace) && idx > 0 {
                    return rest;
                }
            }
            return "";
        }
    }
    if let Some(idx) = trimmed.find(" #") {
        &trimmed[idx..]
    } else {
        ""
    }
}

/// Safely updates `modelRoles.<slot>` in `~/.omp/agent/config.yml` while preserving comments,
/// blank lines, indentation, and other top-level sections.
#[allow(dead_code)]
pub fn update_omp_role_model_in_home(
    home: &Path,
    role_slot: &str,
    model_id: &str,
) -> Result<BTreeMap<String, String>, String> {
    if !OMP_MODEL_ROLES.contains(&role_slot) {
        return Err(format!("不支持的 OMP 角色槽位：{role_slot}"));
    }
    let clean_model = model_id.trim();
    if clean_model.is_empty() || clean_model.contains('\n') || clean_model.contains('\r') {
        return Err("角色模型 ID 无效".into());
    }

    let yml_path = home.join(".omp").join("agent").join("config.yml");
    if let Some(parent) = yml_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建 OMP 配置目录：{e}"))?;
    }
    let formatted = format_yaml_scalar(clean_model);

    if !yml_path.exists() {
        let content = format!("modelRoles:\n  {role_slot}: {formatted}\n");
        fs::write(&yml_path, content).map_err(|e| format!("写入 config.yml 失败：{e}"))?;
        let mut map = BTreeMap::new();
        map.insert(role_slot.to_string(), clean_model.to_string());
        return Ok(map);
    }

    let raw = fs::read_to_string(&yml_path).map_err(|e| format!("读取 config.yml 失败：{e}"))?;
    let eol = if raw.contains("\r\n") { "\r\n" } else { "\n" };
    if raw.trim().is_empty() {
        let content = format!("modelRoles:{eol}  {role_slot}: {formatted}{eol}");
        fs::write(&yml_path, content).map_err(|e| format!("写入 config.yml 失败：{e}"))?;
        let mut map = BTreeMap::new();
        map.insert(role_slot.to_string(), clean_model.to_string());
        return Ok(map);
    }

    let had_trailing_newline = raw.ends_with('\n');
    let mut lines: Vec<String> = raw.split('\n').map(|s| s.strip_suffix('\r').unwrap_or(s).to_string()).collect();
    if had_trailing_newline && lines.last().map(|s| s.is_empty()).unwrap_or(false) {
        lines.pop();
    }

    let mut roles_header_idx: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        let indent = line.len() - line.trim_start().len();
        if indent != 0 {
            continue;
        }
        if let Some((k, rest)) = line.split_once(':') {
            if k.trim() == "modelRoles" {
                let r_clean = strip_yaml_scalar(rest);
                if r_clean.is_empty() || r_clean == "{}" {
                    roles_header_idx = Some(i);
                    break;
                }
            }
        }
    }

    if let Some(header_idx) = roles_header_idx {
        if let Some((_, rest)) = lines[header_idx].split_once(':') {
            if strip_yaml_scalar(rest) == "{}" {
                let comment = rest.find('#').map(|idx| format!(" {}", &rest[idx..])).unwrap_or_default();
                lines[header_idx] = format!("modelRoles:{comment}");
            }
        }

        let mut child_indent = "  ".to_string();
        let mut saw_child_indent = false;
        let mut last_entry_idx = header_idx;
        let mut replaced = false;

        for i in (header_idx + 1)..lines.len() {
            let line = lines[i].clone();
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let indent_len = line.len() - line.trim_start().len();
            if indent_len == 0 {
                break;
            }
            if !saw_child_indent {
                child_indent = line[..indent_len].to_string();
                saw_child_indent = true;
            }
            last_entry_idx = i;

            if let Some((k, val_raw)) = trimmed.split_once(':') {
                if k.trim() == role_slot {
                    let trailing = extract_yaml_trailing_comment(val_raw);
                    lines[i] = format!("{}{role_slot}: {formatted}{trailing}", &line[..indent_len]);
                    replaced = true;
                    break;
                }
            }
        }

        if !replaced {
            lines.insert(last_entry_idx + 1, format!("{child_indent}{role_slot}: {formatted}"));
        }
    } else {
        if lines.last().map(|s| !s.trim().is_empty()).unwrap_or(false) {
            lines.push(String::new());
        }
        lines.push("modelRoles:".into());
        lines.push(format!("  {role_slot}: {formatted}"));
    }

    let mut next = lines.join(eol);
    if had_trailing_newline {
        next.push_str(eol);
    }
    fs::write(&yml_path, &next).map_err(|e| format!("写入 config.yml 失败：{e}"))?;
    Ok(parse_omp_config_yml_str(&next).roles)
}

#[cfg(any(target_os = "macos", windows))]
mod omp_sqlite {
    use std::ffi::{c_char, c_int, c_void, CStr, CString};
    use std::path::Path;

    const SQLITE_OK: c_int = 0;
    const SQLITE_ROW: c_int = 100;
    const SQLITE_OPEN_READONLY: c_int = 0x01;

    #[cfg_attr(target_os = "macos", link(name = "sqlite3"))]
    #[cfg_attr(windows, link(name = "winsqlite3"))]
    extern "system" {
        fn sqlite3_open_v2(
            filename: *const c_char,
            db: *mut *mut c_void,
            flags: c_int,
            vfs: *const c_char,
        ) -> c_int;
        fn sqlite3_close(db: *mut c_void) -> c_int;
        fn sqlite3_busy_timeout(db: *mut c_void, ms: c_int) -> c_int;
        fn sqlite3_prepare_v2(
            db: *mut c_void,
            sql: *const c_char,
            n: c_int,
            stmt: *mut *mut c_void,
            tail: *mut *const c_char,
        ) -> c_int;
        fn sqlite3_step(stmt: *mut c_void) -> c_int;
        fn sqlite3_finalize(stmt: *mut c_void) -> c_int;
        fn sqlite3_column_text(stmt: *mut c_void, i: c_int) -> *const u8;
        fn sqlite3_column_bytes(stmt: *mut c_void, i: c_int) -> c_int;
        #[cfg(test)]
        fn sqlite3_exec(
            db: *mut c_void,
            sql: *const c_char,
            callback: *const c_void,
            arg: *mut c_void,
            errmsg: *mut *mut c_char,
        ) -> c_int;
    }

    struct DbGuard(*mut c_void);
    impl Drop for DbGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    sqlite3_close(self.0);
                }
            }
        }
    }

    struct StmtGuard(*mut c_void);
    impl Drop for StmtGuard {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    sqlite3_finalize(self.0);
                }
            }
        }
    }

    pub fn read_recent_model_keys(db_path: &Path) -> Vec<String> {
        let Ok(c_path) = CString::new(db_path.to_string_lossy().as_bytes()) else {
            return Vec::new();
        };
        let mut raw_db = std::ptr::null_mut();
        let rc = unsafe {
            sqlite3_open_v2(
                c_path.as_ptr(),
                &mut raw_db,
                SQLITE_OPEN_READONLY,
                std::ptr::null(),
            )
        };
        let db = DbGuard(raw_db);
        if rc != SQLITE_OK || db.0.is_null() {
            return Vec::new();
        }
        unsafe {
            sqlite3_busy_timeout(db.0, 50);
        }
        let Ok(sql) = CString::new(
            "SELECT model_key FROM model_usage ORDER BY last_used_at DESC LIMIT 60",
        ) else {
            return Vec::new();
        };
        let mut raw_stmt = std::ptr::null_mut();
        let prep_rc = unsafe {
            sqlite3_prepare_v2(db.0, sql.as_ptr(), -1, &mut raw_stmt, std::ptr::null_mut())
        };
        let stmt = StmtGuard(raw_stmt);
        if prep_rc != SQLITE_OK || stmt.0.is_null() {
            return Vec::new();
        }
        let mut out = Vec::new();
        loop {
            let step_rc = unsafe { sqlite3_step(stmt.0) };
            if step_rc != SQLITE_ROW {
                break;
            }
            let ptr = unsafe { sqlite3_column_text(stmt.0, 0) };
            let len = unsafe { sqlite3_column_bytes(stmt.0, 0) };
            if ptr.is_null() || len <= 0 {
                continue;
            }
            let slice = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
            if let Ok(s) = std::str::from_utf8(slice) {
                let clean = s.trim();
                if !clean.is_empty() {
                    out.push(clean.to_string());
                }
            } else {
                let s = CStr::from_bytes_until_nul(slice)
                    .ok()
                    .map(|c| c.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if !s.trim().is_empty() {
                    out.push(s.trim().to_string());
                }
            }
        }
        out
    }

    #[cfg(test)]
    pub fn create_db(db_path: &Path, sql: &str) -> Result<(), String> {
        let c_path = CString::new(db_path.to_string_lossy().as_bytes()).map_err(|_| "bad path")?;
        let mut raw_db = std::ptr::null_mut();
        let rc = unsafe { sqlite3_open_v2(c_path.as_ptr(), &mut raw_db, 0x02 | 0x04, std::ptr::null()) };
        let db = DbGuard(raw_db);
        if rc != SQLITE_OK {
            return Err(format!("open failed: {rc}"));
        }
        let c_sql = CString::new(sql).map_err(|_| "bad sql")?;
        let rc2 = unsafe {
            sqlite3_exec(
                db.0,
                c_sql.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if rc2 != SQLITE_OK {
            return Err(format!("exec failed: {rc2}"));
        }
        Ok(())
    }
}

fn read_omp_agent_db_models(home: &Path) -> Vec<ModelOption> {
    let db_path = home.join(".omp").join("agent").join("agent.db");
    if !db_path.is_file() {
        return Vec::new();
    }

    #[cfg(any(target_os = "macos", windows))]
    let keys = omp_sqlite::read_recent_model_keys(&db_path);

    #[cfg(not(any(target_os = "macos", windows)))]
    let keys: Vec<String> = {
        let Some(sqlite_bin) = find_program_with_extra_dirs("sqlite3", Some(home)) else {
            return Vec::new();
        };
        let path_str = db_path.to_string_lossy().into_owned();
        run_cli_stdout(
            &sqlite_bin,
            &[
                "-readonly",
                "-noheader",
                &path_str,
                "SELECT model_key FROM model_usage ORDER BY last_used_at DESC LIMIT 60;",
            ],
            Duration::from_millis(800),
        )
        .map(|s| s.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
    };

    keys.into_iter()
        .filter_map(|raw_key| {
            let (id, _) = strip_model_effort_suffix(&raw_key);
            if id.is_empty() {
                return None;
            }
            let provider = id
                .split_once('/')
                .map(|(p, _)| p.to_string())
                .unwrap_or_else(|| "omp".into());
            Some(ModelOption {
                id: id.clone(),
                label: id,
                provider: Some(provider),
                context_window: None,
                reasoning: None,
                thinking_levels: None,
                effort_model_map: None,
                source: "recent",
            })
        })
        .collect()
}

fn read_omp_models_yml(home: &Path) -> Vec<ModelOption> {
    let path = home.join(".omp").join("agent").join("models.yml");
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    parse_omp_models_yml(&raw)
}

fn find_session_jsonl(home: &Path, h_norm: &str, session_key: &str) -> Option<PathBuf> {
    let id = match session_key.split_once(':') {
        Some((_, rest)) => rest.trim(),
        None => session_key.trim(),
    };
    if id.len() < 4 {
        return None;
    }
    let lower_id = id.to_ascii_lowercase();
    let roots: Vec<PathBuf> = match h_norm {
        "omp" => vec![home.join(".omp").join("agent").join("sessions")],
        "pi" => vec![home.join(".pi").join("agent").join("sessions")],
        "claude" => vec![home.join(".claude").join("projects")],
        "codex" => vec![home.join(".codex").join("sessions")],
        _ => vec![
            home.join(".omp").join("agent").join("sessions"),
            home.join(".pi").join("agent").join("sessions"),
            home.join(".claude").join("projects"),
            home.join(".codex").join("sessions"),
        ],
    };

    let mut exact: Vec<(PathBuf, SystemTime)> = Vec::new();
    let mut prefix: Vec<(PathBuf, SystemTime)> = Vec::new();

    fn walk(
        dir: &Path,
        depth: usize,
        lower_id: &str,
        exact: &mut Vec<(PathBuf, SystemTime)>,
        prefix: &mut Vec<(PathBuf, SystemTime)>,
    ) {
        if depth > 4 || !dir.is_dir() {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for ent in entries.flatten() {
            let name = ent.file_name();
            let name_s = name.to_string_lossy();
            if name_s == ".git" || name_s == "node_modules" {
                continue;
            }
            let path = ent.path();
            if path.is_dir() {
                walk(&path, depth + 1, lower_id, exact, prefix);
                continue;
            }
            if !name_s.ends_with(".jsonl") || name_s == "changes.jsonl" {
                continue;
            }
            let lower_name = name_s.to_ascii_lowercase();
            let is_exact = lower_name == format!("{lower_id}.jsonl")
                || lower_name.ends_with(&format!("_{lower_id}.jsonl"))
                || lower_name.ends_with(&format!("-{lower_id}.jsonl"));
            let is_prefix = !is_exact
                && lower_id.len() >= 6
                && (lower_name.starts_with(lower_id)
                    || lower_name.contains(&format!("_{lower_id}"))
                    || lower_name.contains(&format!("-{lower_id}")));
            if !is_exact && !is_prefix {
                continue;
            }
            let mtime = ent
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            if is_exact {
                exact.push((path, mtime));
            } else {
                prefix.push((path, mtime));
            }
        }
    }

    for root in roots {
        walk(&root, 0, &lower_id, &mut exact, &mut prefix);
    }
    let pool = if !exact.is_empty() {
        &mut exact
    } else {
        &mut prefix
    };
    pool.sort_by(|a, b| b.1.cmp(&a.1));
    pool.first().map(|x| x.0.clone())
}

pub fn read_session_tail_model_and_thinking(
    home: &Path,
    h_norm: &str,
    session_key: &str,
) -> (Option<String>, Option<String>) {
    let Some(path) = find_session_jsonl(home, h_norm, session_key) else {
        return (None, None);
    };
    read_jsonl_tail(&path)
}

fn read_jsonl_tail(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(mut file) = File::open(path) else {
        return (None, None);
    };
    let Ok(meta) = file.metadata() else {
        return (None, None);
    };
    let size = meta.len();
    if size == 0 {
        return (None, None);
    }
    let start = size.saturating_sub(SESSION_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return (None, None);
    }
    let mut buf = Vec::with_capacity((size - start) as usize);
    if file.read_to_end(&mut buf).is_err() {
        return (None, None);
    }
    let slice = if start > 0 {
        match buf.iter().position(|&b| b == b'\n') {
            Some(nl) => &buf[nl + 1..],
            None => return (None, None),
        }
    } else {
        &buf[..]
    };
    let text = String::from_utf8_lossy(slice);
    let mut model: Option<String> = None;
    let mut thinking: Option<String> = None;

    for raw_line in text.lines().rev() {
        let line = raw_line.trim();
        if !line.starts_with('{') {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ev_type = obj.get("type").and_then(Value::as_str).unwrap_or("");

        if thinking.is_none() {
            let t = if ev_type == "thinking_level_change" {
                obj.get("thinkingLevel")
                    .or_else(|| obj.get("level"))
                    .and_then(Value::as_str)
            } else if let Some(tm) = obj.get("thinkingMetadata").and_then(Value::as_object) {
                if tm.get("disabled").and_then(Value::as_bool) == Some(true) {
                    Some("off")
                } else {
                    tm.get("level")
                        .or_else(|| tm.get("effort"))
                        .and_then(Value::as_str)
                }
            } else if let Some(s) = obj
                .get("perTurnEffort")
                .or_else(|| obj.get("effort"))
                .and_then(Value::as_str)
            {
                Some(s)
            } else if ev_type == "turn_context" {
                obj.get("payload")
                    .and_then(|p| {
                        p.get("reasoning_effort")
                            .or_else(|| p.get("effort"))
                            .or_else(|| p.pointer("/collaboration_mode/settings/reasoning_effort"))
                    })
                    .and_then(Value::as_str)
            } else {
                obj.get("reasoning_effort")
                    .or_else(|| obj.pointer("/payload/reasoning_effort"))
                    .and_then(Value::as_str)
            };
            if let Some(tv) = t.map(str::trim).filter(|s| !s.is_empty()) {
                thinking = Some(tv.to_ascii_lowercase());
            }
        }

        if model.is_none() {
            let m_raw: Option<String> = if ev_type == "model_change" {
                if let Some(m) = obj
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    Some(m.to_string())
                } else if let Some(mid) = obj
                    .get("modelId")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let prov = obj
                        .get("provider")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("");
                    if !prov.is_empty() && !mid.starts_with(&format!("{prov}/")) {
                        Some(format!("{prov}/{mid}"))
                    } else {
                        Some(mid.to_string())
                    }
                } else {
                    None
                }
            } else if let Some(rm) = obj
                .get("requestedModel")
                .or_else(|| obj.pointer("/message/model"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty() && *s != "<synthetic>")
            {
                Some(rm.to_string())
            } else if ev_type == "turn_context" {
                obj.get("payload")
                    .and_then(|p| {
                        p.get("model")
                            .or_else(|| p.pointer("/collaboration_mode/settings/model"))
                    })
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            } else {
                None
            };

            if let Some(m_str) = m_raw {
                let (base, effort) = strip_model_effort_suffix(&m_str);
                if !base.is_empty() {
                    model = Some(base);
                    if thinking.is_none() {
                        thinking = effort;
                    }
                }
            }
        }

        if model.is_some() && thinking.is_some() {
            break;
        }
    }

    (model, thinking)
}

fn read_toml_quoted_value(raw: &str, key: &str) -> Option<String> {
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('[') {
            continue;
        }
        let Some((k, v)) = trimmed.split_once('=') else {
            continue;
        };
        if k.trim() != key {
            continue;
        }
        let cleaned = strip_yaml_scalar(v);
        if !cleaned.is_empty() {
            return Some(cleaned);
        }
    }
    None
}

fn read_simple_yaml_key(raw: &str, key: &str) -> Option<String> {
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((k, v)) = trimmed.split_once(':') else {
            continue;
        };
        if k.trim() != key {
            continue;
        }
        let cleaned = strip_yaml_scalar(v);
        if !cleaned.is_empty() {
            return Some(cleaned);
        }
    }
    None
}

struct LocalConfigured {
    models: Vec<ModelOption>,
    thinking_by_harness: HashMap<String, String>,
}

fn read_local_configured(home: &Path) -> LocalConfigured {
    let mut out = Vec::new();
    let mut thinking_by_harness = HashMap::new();

    if let Ok(raw) = fs::read_to_string(home.join(".claude").join("settings.json")) {
        if let Ok(json) = serde_json::from_str::<Value>(&raw) {
            if let Some(eff) = json
                .get("effortLevel")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                thinking_by_harness.insert("claude".into(), eff.to_ascii_lowercase());
            }
            let candidates = [
                json.get("model"),
                json.pointer("/env/ANTHROPIC_MODEL"),
                json.pointer("/env/ANTHROPIC_DEFAULT_OPUS_MODEL"),
                json.pointer("/env/ANTHROPIC_DEFAULT_SONNET_MODEL"),
                json.pointer("/env/ANTHROPIC_DEFAULT_HAIKU_MODEL"),
            ];
            for cand in candidates.into_iter().flatten() {
                if let Some(s) = cand.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    let low = s.to_ascii_lowercase();
                    if !low.starts_with("sk-")
                        && !low.starts_with("http://")
                        && !low.starts_with("https://")
                    {
                        out.push(ModelOption {
                            id: s.to_string(),
                            label: s.to_string(),
                            provider: Some("claude".into()),
                            context_window: None,
                            reasoning: None,
                            thinking_levels: None,
                            effort_model_map: None,
                            source: "catalog",
                        });
                    }
                }
            }
        }
    }

    if let Ok(raw) = fs::read_to_string(home.join(".codex").join("config.toml")) {
        if let Some(m) = read_toml_quoted_value(&raw, "model") {
            out.push(ModelOption {
                id: m.clone(),
                label: m,
                provider: Some("codex".into()),
                context_window: None,
                reasoning: None,
                thinking_levels: None,
                effort_model_map: None,
                source: "catalog",
            });
        }
        if let Some(e) = read_toml_quoted_value(&raw, "model_reasoning_effort") {
            thinking_by_harness.insert("codex".into(), e.to_ascii_lowercase());
        }
    }

    if let Ok(raw) = fs::read_to_string(
        home.join(".config")
            .join("opencode")
            .join("opencode.json"),
    ) {
        if let Ok(json) = serde_json::from_str::<Value>(&raw) {
            if let Some(m) = json
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                out.push(ModelOption {
                    id: m.to_string(),
                    label: m.to_string(),
                    provider: Some("opencode".into()),
                    context_window: None,
                    reasoning: None,
                    thinking_levels: None,
                    effort_model_map: None,
                    source: "catalog",
                });
            }
        }
    }

    if let Ok(raw) = fs::read_to_string(home.join(".gemini").join("settings.json")) {
        if let Ok(json) = serde_json::from_str::<Value>(&raw) {
            let model_name = json
                .pointer("/model/name")
                .or_else(|| json.get("model"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            if let Some(m) = model_name {
                out.push(ModelOption {
                    id: m.to_string(),
                    label: m.to_string(),
                    provider: Some("gemini".into()),
                    context_window: None,
                    reasoning: None,
                    thinking_levels: None,
                    effort_model_map: None,
                    source: "catalog",
                });
            }
            if let Some(think) = json
                .pointer("/thinkingConfig/thinkingLevel")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                thinking_by_harness.insert("gemini".into(), think.to_ascii_lowercase());
            }
        }
    }

    if let Ok(raw) = fs::read_to_string(home.join(".pi").join("agent").join("settings.json")) {
        if let Ok(json) = serde_json::from_str::<Value>(&raw) {
            if let Some(dm) = json
                .get("defaultModel")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let dp = json
                    .get("defaultProvider")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("");
                let id = if !dp.is_empty() && !dm.contains('/') {
                    format!("{dp}/{dm}")
                } else {
                    dm.to_string()
                };
                out.push(ModelOption {
                    id: id.clone(),
                    label: id,
                    provider: Some("pi".into()),
                    context_window: None,
                    reasoning: None,
                    thinking_levels: None,
                    effort_model_map: None,
                    source: "catalog",
                });
            }
            if let Some(think) = json
                .get("defaultThinkingLevel")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                thinking_by_harness.insert("pi".into(), think.to_ascii_lowercase());
            }
        }
    }

    if let Ok(raw) = fs::read_to_string(home.join(".hermes").join("config.yaml")) {
        if let Some(m) = read_simple_yaml_key(&raw, "default") {
            out.push(ModelOption {
                id: m.clone(),
                label: m,
                provider: Some("hermes".into()),
                context_window: None,
                reasoning: None,
                thinking_levels: None,
                effort_model_map: None,
                source: "catalog",
            });
        }
        if let Some(e) = read_simple_yaml_key(&raw, "reasoning_effort") {
            thinking_by_harness.insert("hermes".into(), e.to_ascii_lowercase());
        }
    }

    if let Ok(raw) = fs::read_to_string(home.join(".aider.conf.yml")) {
        if let Some(m) = read_simple_yaml_key(&raw, "model") {
            out.push(ModelOption {
                id: m.clone(),
                label: m,
                provider: Some("aider".into()),
                context_window: None,
                reasoning: None,
                thinking_levels: None,
                effort_model_map: None,
                source: "catalog",
            });
        }
        if let Some(e) = read_simple_yaml_key(&raw, "reasoning-effort") {
            thinking_by_harness.insert("aider".into(), e.to_ascii_lowercase());
        }
    }

    LocalConfigured {
        models: out,
        thinking_by_harness,
    }
}

fn fallback_presets(h_norm: &str) -> Vec<ModelOption> {
    let mk = |id: &str, label: &str, provider: &str, reasoning: Option<bool>| ModelOption {
        id: id.into(),
        label: label.into(),
        provider: Some(provider.into()),
        context_window: None,
        reasoning,
        thinking_levels: None,
        effort_model_map: None,
        source: "catalog",
    };
    match h_norm {
        "claude" => vec![
            mk("default", "Default", "anthropic", None),
            mk("opus", "Opus", "anthropic", None),
            mk("sonnet", "Sonnet", "anthropic", None),
            mk("haiku", "Haiku", "anthropic", None),
            mk("opusplan", "Opus Plan", "anthropic", None),
            mk("claude-opus-5-5", "Claude Opus 5.5", "anthropic", None),
            mk("claude-sonnet-5", "Claude Sonnet 5", "anthropic", None),
            mk("claude-haiku-5-5", "Claude Haiku 5.5", "anthropic", None),
        ],
        "codex" => vec![
            mk("gpt-6.2-astra", "GPT-6.2 Astra", "openai", None),
            mk("gpt-6.2-sol", "GPT-6.2 Sol", "openai", None),
            mk("gpt-6-astra", "GPT-6 Astra", "openai", None),
        ],
        "gemini" => vec![
            mk("gemini-3.5-pro", "Gemini 3.5 Pro", "google", None),
            mk("gemini-3.8-flash-high", "Gemini 3.8 Flash High", "google", None),
        ],
        "antigravity" => vec![
            mk("gemini-4-neon-high", "Gemini 4 Neon (High)", "google", None),
            mk("gemini-4-carbon-high", "Gemini 4 Carbon (High)", "google", None),
            mk("gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)", "google", None),
        ],
        "dsh" => vec![
            mk("deepseek-chat", "DeepSeek Chat", "deepseek", None),
            mk("deepseek-reasoner", "DeepSeek Reasoner", "deepseek", Some(true)),
        ],
        _ => Vec::new(),
    }
}

fn load_omp_cli_catalog_once(home: Option<&Path>) -> Vec<ModelOption> {
    let Some(bin) = find_program_with_extra_dirs("omp", home) else {
        return Vec::new();
    };
    match run_cli_stdout_status(&bin, &["models", "--json"], CLI_TIMEOUT) {
        CliOutput::Ok(out) => {
            let parsed = parse_omp_models_json(&out);
            if !parsed.is_empty() {
                return parsed;
            }
        }
        CliOutput::TimedOut => return Vec::new(),
        CliOutput::Failed => {}
    }
    if let Some(out) = run_cli_stdout(&bin, &["models", "--json", "--no-extensions"], CLI_TIMEOUT) {
        return parse_omp_models_json(&out);
    }
    Vec::new()
}

fn get_omp_cli_catalog(home: Option<&Path>) -> Vec<ModelOption> {
    cached_cli_catalog("omp", || load_omp_cli_catalog_once(home))
}

fn get_omp_cached_and_trigger_bg(home: Option<&Path>) -> Vec<ModelOption> {
    let (cached_models, is_fresh) = if let Ok(guard) = cache_map().lock() {
        if let Some(hit) = guard.get("omp") {
            (hit.models.clone(), hit.at.elapsed() < CATALOG_CACHE_TTL)
        } else {
            (Vec::new(), false)
        }
    } else {
        (Vec::new(), false)
    };

    if !is_fresh
        && OMP_CLI_REFRESHING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    {
        let home_owned = home.map(Path::to_path_buf);
        std::thread::spawn(move || {
            let models: Vec<ModelOption> = load_omp_cli_catalog_once(home_owned.as_deref())
                .into_iter()
                .take(MAX_MODELS)
                .collect();
            if !models.is_empty() {
                if let Ok(mut guard) = cache_map().lock() {
                    guard.insert(
                        "omp".to_string(),
                        CachedCatalog {
                            at: Instant::now(),
                            models,
                        },
                    );
                }
            }
            OMP_CLI_REFRESHING.store(false, Ordering::SeqCst);
        });
    }

    cached_models
}

fn get_pi_cli_catalog(home: Option<&Path>) -> Vec<ModelOption> {
    let pi = cached_cli_catalog("pi", || {
        let Some(bin) = find_program_with_extra_dirs("pi", home) else {
            return Vec::new();
        };
        run_cli_stdout(&bin, &["--list-models"], CLI_TIMEOUT)
            .map(|out| parse_pi_models_text(&out))
            .unwrap_or_default()
    });
    if pi.is_empty() {
        get_omp_cli_catalog(home)
    } else {
        pi
    }
}

fn get_agy_cli_catalog(home: Option<&Path>) -> Vec<ModelOption> {
    cached_cli_catalog("antigravity", || {
        let Some(bin) = find_program_with_extra_dirs("agy", home) else {
            return Vec::new();
        };
        run_cli_stdout(&bin, &["models"], CLI_TIMEOUT)
            .map(|out| parse_agy_models_text(&out))
            .unwrap_or_default()
    })
}

fn get_opencode_cli_catalog(home: Option<&Path>) -> Vec<ModelOption> {
    cached_cli_catalog("opencode", || {
        let Some(bin) = find_program_with_extra_dirs("opencode", home)
            .or_else(|| find_program_with_extra_dirs("kilo", home))
        else {
            return Vec::new();
        };
        run_cli_stdout(&bin, &["models"], CLI_TIMEOUT)
            .map(|out| parse_opencode_models_text(&out))
            .unwrap_or_default()
    })
}

fn push_model_opt(
    opt: ModelOption,
    prefer_upgrade: bool,
    combined_catalog: &[ModelOption],
    merged: &mut Vec<ModelOption>,
    seen: &mut HashSet<String>,
    aliases: &mut HashSet<String>,
) {
    if merged.len() >= MAX_MODELS {
        return;
    }
    let clean = opt.id.trim().to_string();
    let k = clean.to_ascii_lowercase();
    if k.is_empty() || seen.contains(&k) || aliases.contains(&k) {
        return;
    }
    if prefer_upgrade {
        if let Some(cat_hit) = find_catalog_match(&clean, combined_catalog) {
            let mk = cat_hit.id.to_ascii_lowercase();
            if seen.contains(&mk) {
                return;
            }
            seen.insert(mk);
            aliases.insert(k);
            let mut upgraded = cat_hit.clone();
            upgraded.source = opt.source;
            merged.push(upgraded);
            return;
        }
    }
    seen.insert(k);
    let mut next = opt;
    next.id = clean;
    merged.push(next);
}

fn prepend_omp_off(mut levels: Vec<String>) -> Vec<String> {
    if !levels.iter().any(|l| l.eq_ignore_ascii_case("off")) {
        levels.insert(0, "off".into());
    }
    levels
}

fn enrich_omp_yml_entry(mut y_item: ModelOption, cached_omp: &[ModelOption]) -> ModelOption {
    if y_item.reasoning == Some(false)
        || y_item
            .thinking_levels
            .as_ref()
            .map(|v| !v.is_empty())
            .unwrap_or(false)
    {
        return y_item;
    }
    let cached_match = cached_omp
        .iter()
        .find(|c| c.id.eq_ignore_ascii_case(&y_item.id))
        .or_else(|| {
            if cached_omp.is_empty() {
                None
            } else {
                find_catalog_match(&y_item.id, cached_omp)
            }
        });
    if let Some(m) = cached_match {
        if m.reasoning == Some(false) {
            y_item.reasoning = Some(false);
            return y_item;
        }
        if let Some(ref lvls) = m.thinking_levels {
            if !lvls.is_empty() {
                y_item.reasoning = y_item.reasoning.or(Some(true));
                y_item.thinking_levels = Some(prepend_omp_off(lvls.clone()));
                return y_item;
            }
        }
    }
    let inferred = infer_model_thinking_levels("oh-my-pi", Some(&y_item.id), y_item.reasoning, false);
    if inferred.is_empty() {
        y_item.reasoning = Some(false);
    } else {
        y_item.reasoning = y_item.reasoning.or(Some(true));
        y_item.thinking_levels = Some(prepend_omp_off(inferred));
    }
    y_item
}

pub fn build_local_agent_models_with(
    harness: &str,
    current_model: Option<&str>,
    session_key: Option<&str>,
    home: Option<&Path>,
    use_cli: bool,
) -> Value {
    build_local_agent_models_with_catalog(harness, current_model, session_key, home, use_cli, None)
}

pub fn build_local_agent_models_with_catalog(
    harness: &str,
    current_model: Option<&str>,
    session_key: Option<&str>,
    home: Option<&Path>,
    use_cli: bool,
    cli_override: Option<Vec<ModelOption>>,
) -> Value {
    let h_norm = normalize_harness(harness);
    let local_cfg = home.map(read_local_configured).unwrap_or(LocalConfigured {
        models: Vec::new(),
        thinking_by_harness: HashMap::new(),
    });
    let omp_cfg = if h_norm == "omp" {
        home.map(read_omp_config_yml).unwrap_or_default()
    } else {
        OmpConfigInfo::default()
    };
    let yml_catalog = if h_norm == "omp" {
        home.map(read_omp_models_yml).unwrap_or_default()
    } else {
        Vec::new()
    };
    let db_models = if h_norm == "omp" {
        home.map(read_omp_agent_db_models).unwrap_or_default()
    } else {
        Vec::new()
    };
    let cli_catalog = if let Some(over) = cli_override {
        over
    } else if use_cli {
        match h_norm.as_str() {
            "omp" => {
                if !yml_catalog.is_empty() || !omp_cfg.models.is_empty() || !db_models.is_empty() {
                    get_omp_cached_and_trigger_bg(home)
                } else {
                    get_omp_cli_catalog(home)
                }
            }
            "pi" => get_pi_cli_catalog(home),
            "antigravity" => get_agy_cli_catalog(home),
            "opencode" => get_opencode_cli_catalog(home),
            _ => Vec::new(),
        }
    } else {
        Vec::new()
    };

    let (live_model, live_thinking) = match (home, session_key) {
        (Some(h), Some(sk)) if !sk.trim().is_empty() => {
            read_session_tail_model_and_thinking(h, &h_norm, sk.trim())
        }
        _ => (None, None),
    };

    let mut raw_model = {
        let arg_m = current_model.map(str::trim).unwrap_or("");
        if let Some(ref lm) = live_model {
            if !arg_m.is_empty()
                && !lm.contains('/')
                && arg_m
                    .to_ascii_lowercase()
                    .ends_with(&format!("/{}", lm.to_ascii_lowercase()))
            {
                arg_m.to_string()
            } else {
                lm.clone()
            }
        } else {
            arg_m.to_string()
        }
    };
    if h_norm == "omp" && raw_model.starts_with('@') {
        let role_key = raw_model[1..].to_ascii_lowercase();
        if let Some(target) = omp_cfg.roles.get(&role_key) {
            raw_model = target.clone();
        }
    }

    let (parsed_id, parsed_effort) = if raw_model.is_empty() {
        (String::new(), None)
    } else {
        strip_model_effort_suffix(&raw_model)
    };
    let effective_model = if !parsed_id.is_empty() {
        Some(parsed_id)
    } else if h_norm == "omp" {
        omp_cfg.default_model.clone()
    } else {
        None
    };

    let mut effective_thinking = parsed_effort
        .or(live_thinking)
        .or_else(|| {
            if h_norm == "omp" {
                omp_cfg.default_thinking.clone()
            } else {
                None
            }
        })
        .or_else(|| local_cfg.thinking_by_harness.get(&h_norm).cloned())
        .or_else(|| effective_model.as_deref().and_then(infer_hyphen_effort));

    let raw_had_explicit_thinking: HashSet<String> = yml_catalog
        .iter()
        .filter(|y| {
            y.thinking_levels
                .as_ref()
                .map(|v| !v.is_empty())
                .unwrap_or(false)
        })
        .map(|y| y.id.to_ascii_lowercase())
        .collect();
    let enriched_yml: Vec<ModelOption> = if h_norm == "omp" {
        yml_catalog
            .into_iter()
            .map(|y| enrich_omp_yml_entry(y, &cli_catalog))
            .collect()
    } else {
        yml_catalog
    };

    let mut combined_catalog = cli_catalog;
    let mut cat_idx: HashMap<String, usize> = combined_catalog
        .iter()
        .enumerate()
        .map(|(i, c)| (c.id.to_ascii_lowercase(), i))
        .collect();
    for y_item in enriched_yml {
        let k = y_item.id.to_ascii_lowercase();
        if let Some(&idx) = cat_idx.get(&k) {
            let cur = &mut combined_catalog[idx];
            if cur.provider.is_none() {
                cur.provider = y_item.provider;
            }
            if cur.context_window.is_none() {
                cur.context_window = y_item.context_window;
            }
            if cur.reasoning.is_none() {
                cur.reasoning = y_item.reasoning;
            }
            if cur.reasoning != Some(false) {
                if let Some(ref y_lvls) = y_item.thinking_levels {
                    if !y_lvls.is_empty()
                        && (cur
                            .thinking_levels
                            .as_ref()
                            .map(|v| v.is_empty())
                            .unwrap_or(true)
                            || !raw_had_explicit_thinking.contains(&k))
                    {
                        cur.thinking_levels = Some(y_lvls.clone());
                    }
                }
            }
        } else {
            cat_idx.insert(k, combined_catalog.len());
            combined_catalog.push(y_item);
        }
    }

    let mut merged: Vec<ModelOption> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut aliases: HashSet<String> = HashSet::new();

    if let Some(ref cur_m) = effective_model {
        if let Some(cat_hit) = find_catalog_match(cur_m, &combined_catalog) {
            seen.insert(cat_hit.id.to_ascii_lowercase());
            aliases.insert(cur_m.to_ascii_lowercase());
            let mut cur = cat_hit.clone();
            cur.source = "current";
            merged.push(cur);
        } else {
            push_model_opt(
                ModelOption {
                    id: cur_m.clone(),
                    label: cur_m.clone(),
                    provider: None,
                    context_window: None,
                    reasoning: None,
                    thinking_levels: None,
                    effort_model_map: None,
                    source: "current",
                },
                false,
                &combined_catalog,
                &mut merged,
                &mut seen,
                &mut aliases,
            );
        }
    }

    if h_norm == "omp" {
        for item in omp_cfg.models {
            push_model_opt(
                item,
                true,
                &combined_catalog,
                &mut merged,
                &mut seen,
                &mut aliases,
            );
        }
        for item in db_models {
            push_model_opt(
                item,
                true,
                &combined_catalog,
                &mut merged,
                &mut seen,
                &mut aliases,
            );
        }
    }

    for item in local_cfg.models {
        if item.provider.as_deref().map(|p| p == h_norm).unwrap_or(true) {
            push_model_opt(
                item,
                true,
                &combined_catalog,
                &mut merged,
                &mut seen,
                &mut aliases,
            );
        }
    }

    for item in &combined_catalog {
        push_model_opt(
            item.clone(),
            false,
            &combined_catalog,
            &mut merged,
            &mut seen,
            &mut aliases,
        );
    }

    if merged.len() < 5 {
        let mut presets = fallback_presets(&h_norm);
        if presets.is_empty() && merged.is_empty() {
            presets = fallback_presets("claude");
        }
        for preset in presets {
            push_model_opt(
                preset,
                false,
                &combined_catalog,
                &mut merged,
                &mut seen,
                &mut aliases,
            );
        }
    }

    for item in &mut merged {
        if item.thinking_levels.is_none() && item.reasoning != Some(false) {
            let lvls = infer_model_thinking_levels(harness, Some(&item.id), item.reasoning, false);
            if !lvls.is_empty() {
                item.reasoning = item.reasoning.or(Some(true));
                item.thinking_levels = Some(lvls);
            } else if is_non_reasoning_model_name(&item.id) {
                item.reasoning = Some(false);
            }
        }
    }

    let current_opt = merged.first().filter(|m| m.source == "current");
    let final_model = current_opt
        .map(|m| m.id.clone())
        .or_else(|| effective_model.clone());
    let is_non_reasoning = current_opt.and_then(|m| m.reasoning) == Some(false)
        || (current_opt.and_then(|m| m.reasoning).is_none()
            && final_model
                .as_deref()
                .map(is_non_reasoning_model_name)
                .unwrap_or(false));

    let thinking_levels: Option<Vec<String>> = if is_non_reasoning {
        None
    } else if let Some(levels) = current_opt.and_then(|m| m.thinking_levels.clone()) {
        if levels.is_empty() {
            None
        } else {
            Some(levels)
        }
    } else {
        let lvls = infer_model_thinking_levels(
            harness,
            final_model.as_deref(),
            current_opt.and_then(|m| m.reasoning),
            false,
        );
        if lvls.is_empty() {
            None
        } else {
            Some(lvls)
        }
    };

    if is_non_reasoning {
        effective_thinking = None;
    } else if let Some(ref lvls) = thinking_levels {
        effective_thinking = clamp_thinking_level(lvls, effective_thinking.as_deref());
    }

    let mut result = serde_json::Map::new();
    result.insert("harness".into(), Value::String(harness.to_string()));
    if let Some(cm) = final_model {
        result.insert("currentModel".into(), Value::String(cm));
    }
    if let Some(ct) = effective_thinking {
        result.insert("currentThinking".into(), Value::String(ct));
    }
    if let Some(ref lvls) = thinking_levels {
        if !lvls.is_empty() {
            result.insert(
                "thinkingLevels".into(),
                Value::Array(lvls.iter().cloned().map(Value::String).collect()),
            );
            result.insert("canSwitchThinking".into(), Value::Bool(true));
            result.insert("thinkingLabel".into(), Value::String("思考等级".into()));
        } else {
            result.insert("canSwitchThinking".into(), Value::Bool(false));
        }
    } else {
        result.insert("canSwitchThinking".into(), Value::Bool(false));
    }
    result.insert("canSwitch".into(), Value::Bool(true));
    if h_norm == "omp" && !omp_cfg.roles.is_empty() {
        let mut roles_obj = serde_json::Map::new();
        for (k, v) in omp_cfg.roles {
            roles_obj.insert(k, Value::String(v));
        }
        result.insert("modelRoles".into(), Value::Object(roles_obj));
    }
    result.insert(
        "models".into(),
        serde_json::to_value(&merged).unwrap_or_else(|_| Value::Array(Vec::new())),
    );
    Value::Object(result)
}

#[tauri::command]
pub async fn local_agent_models(
    harness: String,
    current_model: Option<String>,
    session_key: Option<String>,
) -> Result<Value, String> {
    let res = tauri::async_runtime::spawn_blocking(move || {
        let home = crate::home_dir();
        build_local_agent_models_with(
            &harness,
            current_model.as_deref(),
            session_key.as_deref(),
            home.as_deref(),
            true,
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(res)
}

// Registered in lib.rs generate_handler![] during coordinator merge.
#[allow(dead_code)]
#[tauri::command]
pub async fn local_set_omp_role_model(
    role_slot: String,
    model_id: String,
) -> Result<Value, String> {
    let roles = tauri::async_runtime::spawn_blocking(move || {
        let home = crate::home_dir().ok_or_else(|| "无法获取用户目录".to_string())?;
        update_omp_role_model_in_home(&home, &role_slot, &model_id)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(serde_json::json!({
        "ok": true,
        "modelRoles": roles,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

    fn make_temp_dir(prefix: &str) -> PathBuf {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "herdr-local-models-{prefix}-{}-{seq}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_omp_models_json_and_filters_non_chat() {
        let raw = r#"{
            "models": [
                {
                    "provider": "magpie",
                    "kind": "chat",
                    "id": "crosery/gpt-6.2-astra-fast",
                    "selector": "magpie/crosery/gpt-6.2-astra-fast",
                    "name": "GPT 6.2 Astra Fast",
                    "contextWindow": 922000,
                    "reasoning": true,
                    "thinking": ["low", "medium", "high", "xhigh", "max"]
                },
                {
                    "provider": "openai",
                    "kind": "embedding",
                    "id": "text-embedding-3"
                },
                {
                    "provider": "google",
                    "kind": "chat",
                    "id": "gemini-1.5-flash",
                    "selector": "google/gemini-1.5-flash",
                    "name": "Gemini 1.5 Flash",
                    "reasoning": false,
                    "thinking": null
                }
            ]
        }"#;
        let parsed = parse_omp_models_json(raw);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, "magpie/crosery/gpt-6.2-astra-fast");
        assert_eq!(parsed[0].context_window, Some(922000));
        assert_eq!(
            parsed[0].thinking_levels.as_deref(),
            Some(&["low".into(), "medium".into(), "high".into(), "xhigh".into(), "max".into()][..])
        );
        assert_eq!(parsed[1].reasoning, Some(false));
        assert_eq!(parsed[1].thinking_levels, None);
    }

    #[test]
    fn parses_omp_models_yml_without_leaking_secrets() {
        let yml = r#"
providers:
  magpie:
    api: openai-completions
    auth: sk-secret-must-not-leak
    apiKey: secret-api-key-999
    token: tok-secret-123
    baseUrl: http://127.0.0.1:3425/v1
    headers:
      Authorization: Bearer super-secret-header
    models:
      - contextWindow: 1000000
        cost:
          input: 4
          output: 20
        id: crosery/gpt-6.2-sol-ultrafast
        name: GPT 6.2 Sol Ultrafast
        reasoning: true
        thinking:
          efforts:
            - low
            - medium
            - high
            - max
      - id: crosery/mimo-v2.5-asr
        name: MiMo ASR
        reasoning: false
  crosery-ultrafast:
    secret: hidden-secret
    models:
      - id: gpt-6.2-sol
        name: Sol Ultrafast
        reasoning: true
        thinking: [low, high]
"#;
        let parsed = parse_omp_models_yml(yml);
        let serialized = serde_json::to_string(&parsed).unwrap();
        assert!(!serialized.contains("sk-secret"));
        assert!(!serialized.contains("secret-api-key-999"));
        assert!(!serialized.contains("tok-secret-123"));
        assert!(!serialized.contains("super-secret-header"));
        assert!(!serialized.contains("hidden-secret"));
        assert!(!serialized.contains("127.0.0.1"));

        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].id, "magpie/crosery/gpt-6.2-sol-ultrafast");
        assert_eq!(parsed[0].context_window, Some(1_000_000));
        assert_eq!(
            parsed[0].thinking_levels.as_deref(),
            Some(&["low".into(), "medium".into(), "high".into(), "max".into()][..])
        );
        assert_eq!(parsed[1].reasoning, Some(false));
        assert_eq!(parsed[1].thinking_levels, None);
        assert_eq!(parsed[2].id, "crosery-ultrafast/gpt-6.2-sol");
        assert_eq!(
            parsed[2].thinking_levels.as_deref(),
            Some(&["low".into(), "high".into()][..])
        );
    }

    #[test]
    fn matches_catalog_across_exact_suffix_and_fast_ultrafast_variants() {
        let catalog = parse_omp_models_json(
            r#"{
                "models": [
                    {
                        "provider": "crosery-ultrafast",
                        "kind": "chat",
                        "id": "gpt-6.2-sol",
                        "selector": "crosery-ultrafast/gpt-6.2-sol",
                        "reasoning": true
                    },
                    {
                        "provider": "magpie",
                        "kind": "chat",
                        "id": "crosery/gpt-6.2-astra-fast",
                        "selector": "magpie/crosery/gpt-6.2-astra-fast",
                        "reasoning": true
                    }
                ]
            }"#,
        );
        assert_eq!(
            find_catalog_match("magpie/crosery/gpt-6.2-astra-fast", &catalog).map(|m| m.id.as_str()),
            Some("magpie/crosery/gpt-6.2-astra-fast")
        );
        assert_eq!(
            find_catalog_match("crosery/gpt-6.2-astra-fast", &catalog).map(|m| m.id.as_str()),
            Some("magpie/crosery/gpt-6.2-astra-fast")
        );
        assert_eq!(
            find_catalog_match("crosery-fast/gpt-6.2-astra", &catalog).map(|m| m.id.as_str()),
            Some("magpie/crosery/gpt-6.2-astra-fast")
        );
        assert_eq!(
            find_catalog_match("gpt-6.2-sol-ultrafast", &catalog).map(|m| m.id.as_str()),
            Some("crosery-ultrafast/gpt-6.2-sol")
        );
    }

    #[test]
    fn reads_local_omp_sessions_config_models_and_non_reasoning() {
        let dir = make_temp_dir("omp-full");
        fs::create_dir_all(dir.join(".omp/agent/sessions/-tmp-app")).unwrap();
        fs::write(
            dir.join(".omp/agent/config.yml"),
            "defaultThinkingLevel: high\nmodelRoles:\n  default: magpie/crosery/gpt-6.2-astra-fast\n",
        )
        .unwrap();
        fs::write(
            dir.join(".omp/agent/models.yml"),
            r#"
providers:
  magpie:
    auth: sk-never-leak
    models:
      - id: crosery/gpt-6.2-astra-fast
        name: Astra Fast
        reasoning: true
        thinking:
          efforts: [low, medium, high, xhigh, max]
      - id: crosery/mimo-v2.5-asr
        name: MiMo ASR
        reasoning: false
"#,
        )
        .unwrap();

        let uuid = "01a1fe83-1f9a-73e1-92ca-7ff20d80c2be";
        let sess_file = dir
            .join(".omp/agent/sessions/-tmp-app")
            .join(format!("2026-11-21T14-29-28Z_{uuid}.jsonl"));
        let pad = serde_json::json!({ "type": "message", "text": "x".repeat(4000) }).to_string();
        let mut lines = vec![
            r#"{"type":"model_change","model":"magpie/crosery/claude-opus-5"}"#.to_string(),
            r#"{"type":"thinking_level_change","thinkingLevel":"low"}"#.to_string(),
        ];
        for _ in 0..40 {
            lines.push(pad.clone());
        }
        lines.push(r#"{"type":"model_change","model":"magpie/crosery/gpt-6.2-astra-fast"}"#.into());
        lines.push(r#"{"type":"thinking_level_change","thinkingLevel":"max"}"#.into());
        fs::write(&sess_file, lines.join("\n") + "\n").unwrap();

        let res = build_local_agent_models_with(
            "oh-my-pi",
            Some("gpt-6.2-astra-fast"),
            Some(&format!("omp:{uuid}")),
            Some(&dir),
            false,
        );
        assert_eq!(
            res.get("currentModel").and_then(Value::as_str),
            Some("magpie/crosery/gpt-6.2-astra-fast")
        );
        assert_eq!(
            res.get("currentThinking").and_then(Value::as_str),
            Some("max")
        );
        assert_eq!(
            res.get("canSwitchThinking").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            res.get("thinkingLevels")
                .and_then(Value::as_array)
                .map(|a| a.len()),
            Some(5)
        );
        assert!(!res.to_string().contains("sk-never-leak"));

        let non_reason = build_local_agent_models_with(
            "omp",
            Some("magpie/crosery/mimo-v2.5-asr"),
            None,
            Some(&dir),
            false,
        );
        assert_eq!(
            non_reason.get("canSwitchThinking").and_then(Value::as_bool),
            Some(false)
        );
        assert!(non_reason.get("thinkingLevels").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_claude_codex_and_gemini_local_settings() {
        let dir = make_temp_dir("multi-harness");
        fs::create_dir_all(dir.join(".claude")).unwrap();
        fs::create_dir_all(dir.join(".codex")).unwrap();
        fs::create_dir_all(dir.join(".gemini")).unwrap();

        fs::write(
            dir.join(".claude/settings.json"),
            r#"{"model":"claude-opus-5-5","effortLevel":"xhigh","env":{"ANTHROPIC_API_KEY":"sk-hidden"}}"#,
        )
        .unwrap();
        fs::write(
            dir.join(".codex/config.toml"),
            "model = \"gpt-6.2-sol\"\nmodel_reasoning_effort = \"high\"\n",
        )
        .unwrap();
        fs::write(
            dir.join(".gemini/settings.json"),
            r#"{"model":{"name":"gemini-3.8-flash-high"},"thinkingConfig":{"thinkingLevel":"high"}}"#,
        )
        .unwrap();

        let claude = build_local_agent_models_with("claude-code", None, None, Some(&dir), false);
        assert_eq!(claude.get("currentThinking").and_then(Value::as_str), Some("xhigh"));
        assert!(!claude.to_string().contains("sk-hidden"));

        let codex = build_local_agent_models_with("codex", None, None, Some(&dir), false);
        assert_eq!(codex.get("currentThinking").and_then(Value::as_str), Some("high"));
        assert!(codex
            .get("models")
            .and_then(Value::as_array)
            .map(|a| a.iter().any(|m| m.get("id").and_then(Value::as_str) == Some("gpt-6.2-sol")))
            .unwrap_or(false));

        let gemini = build_local_agent_models_with("gemini", None, None, Some(&dir), false);
        assert_eq!(gemini.get("currentThinking").and_then(Value::as_str), Some("high"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_mimo_v26_pro_auto_thinking_agent_db_and_updates_omp_roles_safely() {
        let dir = make_temp_dir("omp-roles-db");
        let omp_dir = dir.join(".omp/agent");
        fs::create_dir_all(&omp_dir).unwrap();

        let cfg_path = omp_dir.join("config.yml");
        fs::write(
            &cfg_path,
            "# keep header comment\nsymbolPreset: minimal\nmodelRoles:\n  # role comment\n  default: magpie/crosery/gpt-6.2-astra-fast # keep inline\n  smol: magpie/crosery/gpt-6.2-sol-ultrafast\ntheme:\n  light: rose\n",
        )
        .unwrap();
        fs::write(
            omp_dir.join("models.yml"),
            "providers:\n  magpie:\n    models:\n      - id: crosery/mimo-v2.6-pro\n        name: MiMo V2.6 Pro\n",
        )
        .unwrap();

        #[cfg(any(target_os = "macos", windows))]
        {
            omp_sqlite::create_db(
                &omp_dir.join("agent.db"),
                "CREATE TABLE model_usage (model_key TEXT PRIMARY KEY, last_used_at INTEGER NOT NULL); INSERT INTO model_usage (model_key, last_used_at) VALUES ('magpie/crosery/claude-opus-5', 1700000000);",
            )
            .unwrap();
        }

        let res = build_local_agent_models_with(
            "omp",
            Some("magpie/crosery/mimo-v2.6-pro"),
            None,
            Some(&dir),
            false,
        );
        assert_eq!(
            res.get("canSwitchThinking").and_then(Value::as_bool),
            Some(true)
        );
        let levels: Vec<&str> = res
            .get("thinkingLevels")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(levels, vec!["off", "low", "medium", "high", "xhigh"]);

        let unknown_res = build_local_agent_models_with(
            "omp",
            Some("magpie/unknown-custom"),
            None,
            Some(&dir),
            false,
        );
        let unknown_levels: Vec<&str> = unknown_res
            .get("thinkingLevels")
            .and_then(Value::as_array)
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(unknown_levels.contains(&"auto"));
        assert!(unknown_levels.contains(&"xhigh"));
        assert_eq!(
            res.pointer("/modelRoles/default").and_then(Value::as_str),
            Some("magpie/crosery/gpt-6.2-astra-fast")
        );
        #[cfg(any(target_os = "macos", windows))]
        assert!(res
            .get("models")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().any(|m| m.get("id").and_then(Value::as_str) == Some("magpie/crosery/claude-opus-5")))
            .unwrap_or(false));

        let updated = update_omp_role_model_in_home(&dir, "default", "magpie/crosery/mimo-v2.6-pro").unwrap();
        assert_eq!(updated.get("default").map(String::as_str), Some("magpie/crosery/mimo-v2.6-pro"));
        let updated2 = update_omp_role_model_in_home(&dir, "plan", "magpie/crosery/claude-opus-5").unwrap();
        assert_eq!(updated2.get("plan").map(String::as_str), Some("magpie/crosery/claude-opus-5"));

        let saved_raw = fs::read_to_string(&cfg_path).unwrap();
        assert!(saved_raw.contains("# keep header comment"));
        assert!(saved_raw.contains("# role comment"));
        assert!(saved_raw.contains("  default: magpie/crosery/mimo-v2.6-pro # keep inline"));
        assert!(saved_raw.contains("  plan: magpie/crosery/claude-opus-5"));
        assert!(saved_raw.contains("theme:\n  light: rose"));

        assert!(update_omp_role_model_in_home(&dir, "unknown_slot", "m1").is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_agy_models_with_sibling_effort_groups_and_effort_model_map() {
        let raw = "\
gemini-4-neon-high\tGemini 4 Neon (High)\n\
gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)\n\
gemini-4-neon-medium\tGemini 4 Neon (Medium)\n\
gemini-4-neon-low\tGemini 4 Neon (Low)\n\
gemini-4-carbon-medium\tGemini 4 Carbon (Medium)\n\
gemini-4-carbon-high\tGemini 4 Carbon (High)\n\
gemini-4-carbon-low\tGemini 4 Carbon (Low)\n\
claude-opus-5-5-low\tClaude Opus 5.5 (Low)\n\
claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)\n\
claude-opus-5-5-high\tClaude Opus 5.5 (High)\n\
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n\
gemini-pro-orchestrator\tOrchestrator (Carbon)\n\
claude-3-5-sonnet\tClaude 3.5 Sonnet\n";

        let parsed = parse_agy_models_text(raw);
        let by_id: HashMap<&str, &ModelOption> =
            parsed.iter().map(|m| (m.id.as_str(), m)).collect();

        let neon = by_id.get("gemini-4-neon-high").unwrap();
        assert_eq!(
            neon.thinking_levels.as_deref(),
            Some(&["low".into(), "medium".into(), "high".into(), "xhigh".into()][..])
        );
        let map = neon.effort_model_map.as_ref().unwrap();
        assert_eq!(map.get("low").map(String::as_str), Some("gemini-4-neon-low"));
        assert_eq!(map.get("medium").map(String::as_str), Some("gemini-4-neon-medium"));
        assert_eq!(map.get("high").map(String::as_str), Some("gemini-4-neon-high"));
        assert_eq!(map.get("xhigh").map(String::as_str), Some("gemini-4-neon-xhigh"));
        assert_eq!(neon.reasoning, Some(true));

        assert_eq!(
            by_id.get("gemini-4-carbon-low").unwrap().thinking_levels.as_deref(),
            Some(&["low".into(), "medium".into(), "high".into()][..])
        );
        assert_eq!(
            by_id.get("claude-opus-5-5-high").unwrap().thinking_levels.as_deref(),
            Some(&["low".into(), "medium".into(), "high".into()][..])
        );
        assert_eq!(
            by_id.get("gpt-oss-120b-medium").unwrap().thinking_levels.as_deref(),
            Some(&["medium".into()][..])
        );
        assert_eq!(
            by_id.get("gemini-pro-orchestrator").unwrap().thinking_levels.as_deref(),
            Some(&["low".into(), "medium".into(), "high".into(), "xhigh".into(), "max".into()][..])
        );
        assert_eq!(by_id.get("claude-3-5-sonnet").unwrap().reasoning, Some(false));
        assert_eq!(by_id.get("claude-3-5-sonnet").unwrap().thinking_levels, None);

        let json_str = serde_json::to_string(neon).unwrap();
        assert!(json_str.contains("\"effortModelMap\""));
    }

    #[test]
    fn infers_per_model_thinking_levels_and_enriches_omp_models_yml() {
        assert_eq!(
            infer_model_thinking_levels("claude", Some("claude-opus-4-6"), None, false),
            vec!["low", "medium", "high", "max"]
        );
        assert_eq!(
            infer_model_thinking_levels("claude", Some("claude-opus-4-5"), None, false),
            vec!["low", "medium", "high"]
        );
        assert_eq!(
            infer_model_thinking_levels("gemini", Some("gemini-2.5-flash"), None, false),
            vec!["minimal", "low", "medium", "high"]
        );
        assert_eq!(
            infer_model_thinking_levels("gemini", Some("gemini-3.1-pro-preview"), None, false),
            vec!["low", "high"]
        );
        assert_eq!(
            infer_model_thinking_levels("omp", Some("google/gemma-4-26b-it"), None, false),
            vec!["high"]
        );
        assert_eq!(
            infer_model_thinking_levels("omp", Some("crosery/k3"), None, false),
            vec!["low", "high", "max"]
        );
        assert_eq!(
            infer_model_thinking_levels("codex", Some("gpt-5"), None, false),
            vec!["low", "medium", "high"]
        );
        assert_eq!(
            infer_model_thinking_levels("codex", Some("gpt-5.4"), None, false),
            vec!["low", "medium", "high", "xhigh"]
        );
        assert!(infer_model_thinking_levels("claude", Some("gpt-4o"), None, false).is_empty());
        assert!(infer_model_thinking_levels("gemini", Some("gemini-2.0-flash"), None, false).is_empty());
        assert_eq!(
            infer_model_thinking_levels("gemini", Some("gemini-2.0-flash-thinking-exp"), None, false),
            vec!["low", "medium", "high"]
        );

        let dir = make_temp_dir("omp-yml-enrich");
        let omp_dir = dir.join(".omp/agent");
        fs::create_dir_all(&omp_dir).unwrap();
        fs::write(
            omp_dir.join("models.yml"),
            "providers:\n  google:\n    models:\n      - id: gemini-2.5-flash\n        name: Gemini 2.5 Flash\n  magpie:\n    models:\n      - id: crosery/claude-opus-4-6\n        name: Claude Opus 4.6\n      - id: crosery/gpt-4o\n        name: GPT-4o\n",
        )
        .unwrap();

        let cached_cli = vec![ModelOption {
            id: "google/gemini-2.5-flash".into(),
            label: "Gemini 2.5 Flash".into(),
            provider: Some("google".into()),
            context_window: None,
            reasoning: Some(true),
            thinking_levels: Some(vec!["minimal".into(), "low".into(), "medium".into(), "high".into()]),
            effort_model_map: None,
            source: "catalog",
        }];

        let flash_res = build_local_agent_models_with_catalog(
            "omp",
            Some("google/gemini-2.5-flash"),
            None,
            Some(&dir),
            false,
            Some(cached_cli),
        );
        let flash_lvls: Vec<&str> = flash_res["thinkingLevels"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(flash_lvls, vec!["off", "minimal", "low", "medium", "high"]);

        let claude_res = build_local_agent_models_with(
            "omp",
            Some("magpie/crosery/claude-opus-4-6"),
            None,
            Some(&dir),
            false,
        );
        let claude_lvls: Vec<&str> = claude_res["thinkingLevels"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(claude_lvls, vec!["off", "low", "medium", "high", "max"]);

        let gpt4o_res = build_local_agent_models_with(
            "omp",
            Some("magpie/crosery/gpt-4o"),
            None,
            Some(&dir),
            false,
        );
        assert_eq!(gpt4o_res.get("canSwitchThinking").and_then(Value::as_bool), Some(false));
        assert!(gpt4o_res.get("thinkingLevels").is_none());

        assert!(infer_model_thinking_levels("omp", Some("demo/gemini-1.5-pro"), None, true).is_empty());
        assert!(infer_model_thinking_levels("omp", Some("custom-no-reason"), Some(false), true).is_empty());
        assert_eq!(
            infer_model_thinking_levels("custom-cli", Some("custom-private-model"), None, true),
            vec!["low".to_string(), "medium".to_string(), "high".to_string()],
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
